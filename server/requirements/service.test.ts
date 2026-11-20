import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { RequirementModel, RequirementModelResult, RequirementProject, RequirementRevision, StructuredPrd } from '../../shared/requirements.js'
import { exportRequirementRevision, validatePrototypeRevision, validationInputFingerprint, type ValidatedRequirementRevision } from './artifacts.js'
import { dualPrdFixture } from '../tests/fixtures/dual-prd.js'
import { JsonRequirementRepository } from './repository.js'
import { RequirementService, type RequirementServiceOptions } from './service.js'
import { requirementDiagnostic } from './diagnostics.js'
import { readSourceFile, storeSourceFile } from './sources.js'
import { RemoteCodeError } from './remote-code.js'
import { RequirementConversationAudit } from './conversation.js'
import { scopeFingerprint } from './capture-plan.js'

const question = (id: string) => ({ id, priority: 'P0' as const, text: 'Choose scope', impact: 'Scope', choices: ['A', 'B'], recommendation: 'A' })

test('scope checkpoint callbacks reject cancellation, stale input and invalid fingerprints without saving late classification', async () => {
  for (const ending of ['cancel', 'stale', 'invalid'] as const) {
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    const context = await fixture({ generate: async (stage, project, options) => {
      if (stage === 'analyze') return { evidence: [], questions: [] }
      entered()
      await gate
      await options.saveScopeCheckpoint!({ version: 1, fingerprint: ending === 'invalid' ? 'f'.repeat(64) : scopeFingerprint(project), prd, blocks: [{ blockId: 'B-1', kind: 'existing', reason: 'Existing editor' }] })
      return { prd }
    } })
    try {
      let project = await context.service.create(7, { title: 'Checkpoint', description: 'Existing editor', modelId: 'auto' }, 'fake')
      await context.service.launch(7, project.id, { expectedVersion: project.version, stage: 'analyze' }, 'fake'); await context.service.wait(project.id)
      project = await context.service.detail(7, project.id)
      await context.service.launch(7, project.id, { expectedVersion: project.version, stage: 'prd' }, 'fake')
      await started
      project = await context.service.detail(7, project.id)
      if (ending === 'cancel') await context.service.cancel(7, project.id, project.jobs.at(-1)!.id, { expectedVersion: project.version })
      if (ending === 'stale') {
        const expected = project.version
        project.description = 'Concurrent scope change'; project.version++
        await context.repository.replace(project, expected)
      }
      release()
      await context.service.wait(project.id)
      project = await context.service.detail(7, project.id)
      assert.equal(project.scopeCheckpoint, undefined)
      assert.equal(project.revisions.length, 0)
      assert.equal(project.jobs.at(-1)?.status, ending === 'cancel' ? 'cancelled' : 'failed')
    } finally { release(); await context.close() }
  }
})

test('PRD scope answers resume PRD without reanalysis, retain partial questions and carry the plan into design', async () => {
  let clarify = true
  let analyses = 0
  const context = await fixture({ generate: async (stage, project) => {
    if (stage === 'analyze') { analyses++; return { evidence: [], questions: [] } }
    if (stage === 'prd') {
      if (clarify) return { questions: [question('scope-question'), question('scope-entry')] }
      assert.equal(project.decisions.length, 2)
      return { prd, existingPages: [], capturePlan: { version: 1, fingerprint: 'a'.repeat(64), blocks: [{ blockId: 'B-1', kind: 'new', reason: 'Confirmed new editor' }] } }
    }
    return { screens: [{ id: 'screen', title: 'Editor', state: 'Default', html: '<!doctype html><html><body><main data-requirement-id="REQ-1" data-acceptance-id="AC-1">Editor</main></body></html>', requirementIds: ['REQ-1'], acceptanceIds: ['AC-1'] }], existingPages: project.revisions.at(-1)!.existingPages }
  } })
  try {
    let project = await context.service.create(7, { title: 'Scope', description: 'New editor', modelId: 'auto' }, 'fake')
    for (const stage of ['analyze', 'prd'] as const) {
      await context.service.launch(7, project.id, { expectedVersion: project.version, stage }, 'fake')
      await context.service.wait(project.id)
      project = await context.service.detail(7, project.id)
    }
    assert.equal(project.status, 'needs_input')
    assert.equal(project.jobs.at(-1)?.status, 'succeeded')
    assert.equal(project.revisions.length, 0)
    await assert.rejects(context.service.launch(7, project.id, { expectedVersion: project.version, stage: 'prd' }, 'fake'), { statusCode: 409 })
    project = await context.service.answers(7, project.id, { expectedVersion: project.version, answers: [{ questionId: project.questions[0].id, answer: 'Independent new editor' }] })
    assert.equal(project.status, 'needs_input')
    await assert.rejects(context.service.launch(7, project.id, { expectedVersion: project.version, stage: 'prd' }, 'fake'), { statusCode: 409 })
    project = await context.service.answers(7, project.id, { expectedVersion: project.version, answers: [{ questionId: project.questions[1].id, answer: 'Direct new URL, no existing menu changes' }] })
    assert.equal(project.status, 'draft')
    assert.equal(project.events.at(-1)?.text, 'prd:inputs_changed')
    clarify = false
    for (const stage of ['prd', 'design'] as const) {
      if (stage === 'design') project = await context.service.confirm(7, project.id, { expectedVersion: project.version, target: 'prd' })
      await context.service.launch(7, project.id, { expectedVersion: project.version, stage }, 'fake')
      await context.service.wait(project.id)
      project = await context.service.detail(7, project.id)
    }
    assert.equal(project.status, 'design_review')
    assert.equal(analyses, 1)
    assert.deepEqual(project.revisions[1].capturePlan, project.revisions[0].capturePlan)
    project = await context.service.editDesign(7, project.id, { expectedVersion: project.version, screens: project.revisions.at(-1)!.screens })
    assert.deepEqual(project.revisions[2].capturePlan, project.revisions[0].capturePlan)
  } finally { await context.close() }
})

test('legacy pending PRD clarification preserves analysis but new source changes still invalidate it', async () => {
  for (const changeSource of [false, true]) {
    const context = await fixture({ generate: async stage => stage === 'analyze' ? { evidence: [], questions: [] } : { questions: [question('scope')] } })
    try {
      let project = await context.service.create(7, { title: 'Legacy clarification', description: 'Report', modelId: 'auto' }, 'fake')
      for (const stage of ['analyze', 'prd'] as const) {
        await context.service.launch(7, project.id, { expectedVersion: project.version, stage }, 'fake')
        await context.service.wait(project.id)
        project = await context.service.detail(7, project.id)
      }
      const expectedVersion = project.version
      project.events = project.events.filter(event => !event.text.startsWith('clarification:prd:'))
      project.events.find(event => event.text.startsWith('PRD 范围待确认：'))!.text = 'PRD 范围待确认：请回答澄清问题，补充资料后重新分析；未生成或覆盖 PRD'
      project.version++
      await context.repository.replace(project, expectedVersion)
      const questionId = project.questions[0].id
      if (changeSource) {
        project = await context.service.addSources(7, project.id, { expectedVersion: project.version }, [{ name: 'new.md', buffer: Buffer.from('new requirement') }])
        await assert.rejects(context.service.answers(7, project.id, { expectedVersion: project.version, answers: [{ questionId, answer: 'New module' }] }), { statusCode: 400 })
        await assert.rejects(context.service.launch(7, project.id, { expectedVersion: project.version, stage: 'prd' }, 'fake'), { statusCode: 409 })
      } else {
        project = await context.service.answers(7, project.id, { expectedVersion: project.version, answers: [{ questionId, answer: 'New module' }] })
        assert.equal(project.events.at(-1)?.text, 'prd:inputs_changed')
      }
    } finally { await context.close() }
  }
})

test('login checkpoint persists before waiting, enforces owner/job/CAS/action and clears on resume/cancel/timeout', async () => {
  for (const ending of ['continue', 'cancel', 'timeout'] as const) {
    let opened = 0
    const context = await fixture({ generate: async (stage, project, options) => {
      if (stage === 'analyze') return { evidence: project.sources.map(source => ({ sourceId: source.id, summary: 'Code', limitations: 'Not executed' })), questions: [] }
      if (stage === 'prd') return { prd }
      await options.onLoginRequired!({ origin: project.preview!.origin, expiresAt: new Date(Date.now() + (ending === 'timeout' ? 1000 : 30000)).toISOString(), open: async () => { opened++ } })
      return { screens: [{ id: 'screen', title: 'Editor', state: 'Default', html: '<!doctype html><html><head><title>Editor</title></head><body><main data-requirement-id="REQ-1" data-acceptance-id="AC-1">Editor</main></body></html>', requirementIds: ['REQ-1'], acceptanceIds: ['AC-1'] }] }
    } })
    try {
      let project = await context.service.create(7, { title: 'Login', description: 'Orders', modelId: 'auto' }, 'fake')
      project = await context.service.addCodeSnapshot(7, project.id, { expectedVersion: project.version, files: [{ path: 'src/main.ts', content: 'export const route = "/orders"' }] })
      project = await context.service.configurePreview(7, project.id, { expectedVersion: project.version, origin: 'https://tmp.test.sunmi.com' }, 'fake')
      for (const stage of ['analyze', 'prd'] as const) {
        await context.service.launch(7, project.id, { expectedVersion: project.version, stage }, 'fake')
        await context.service.wait(project.id)
        project = await context.service.detail(7, project.id)
      }
      project = await context.service.confirm(7, project.id, { expectedVersion: project.version, target: 'prd' })
      project = await context.service.launch(7, project.id, { expectedVersion: project.version, stage: 'design' }, 'fake')
      for (let attempt = 0; attempt < 200 && !project.jobs.at(-1)?.interaction; attempt++) project = await context.service.detail(7, project.id)
      const job = project.jobs.at(-1)!
      assert.equal(job.status, 'running')
      assert.equal(job.interaction?.phase, 'ready')
      assert.equal(opened, 0)
      const body = { expectedVersion: project.version, action: 'open' }
      await assert.rejects(context.service.login(8, project.id, job.id, body), { statusCode: 404 })
      await assert.rejects(context.service.login(7, project.id, 'wrong-job', body), { statusCode: 409 })
      await assert.rejects(context.service.login(7, project.id, job.id, { ...body, expectedVersion: 1 }), { statusCode: 409 })
      await assert.rejects(context.service.login(7, project.id, job.id, { ...body, action: 'continue' }), { statusCode: 409 })
      if (ending === 'timeout') {
        await context.service.wait(project.id)
        project = await context.service.detail(7, project.id)
        assert.match(project.jobs.at(-1)!.error!, /PAGE_CAPTURE_LOGIN_TIMEOUT/)
      } else {
        const competing = await Promise.allSettled([context.service.login(7, project.id, job.id, body), context.service.login(7, project.id, job.id, body)])
        assert.equal(competing.filter(result => result.status === 'fulfilled').length, 1)
        assert.equal(opened, 1)
        project = await context.service.detail(7, project.id)
        assert.equal(project.jobs.at(-1)?.interaction?.phase, 'opened')
        await assert.rejects(context.service.login(7, project.id, job.id, { expectedVersion: project.version, action: 'open' }), { statusCode: 409 })
        if (ending === 'cancel') await context.service.cancel(7, project.id, job.id, { expectedVersion: project.version })
        else await context.service.login(7, project.id, job.id, { expectedVersion: project.version, action: 'continue' })
        await context.service.wait(project.id)
        project = await context.service.detail(7, project.id)
        assert.equal(project.jobs.at(-1)?.status, ending === 'cancel' ? 'cancelled' : 'succeeded')
      }
      assert.equal(project.jobs.at(-1)?.interaction, undefined)
      await assert.rejects(context.service.login(7, project.id, job.id, { expectedVersion: project.version, action: 'open' }), { statusCode: 409 })
    } finally { await context.close() }
  }
})

test('preview configuration preserves analysis and enforces owner, CAS and authorized origins', async () => {
  const context = await fixture({ generate: async () => ({ evidence: [], questions: [] }) })
  try {
    let project = await context.service.create(7, { title: 'Preview', description: 'Orders', modelId: 'auto' }, 'fake')
    await assert.rejects(context.service.configurePreview(8, project.id, { expectedVersion: 1, origin: 'http://localhost:5173' }, 'fake'), { statusCode: 404 })
    await assert.rejects(context.service.configurePreview(7, project.id, { expectedVersion: 2, origin: 'http://localhost:5173' }, 'fake'), { statusCode: 409 })
    await assert.rejects(context.service.configurePreview(7, project.id, { expectedVersion: 1, origin: 'https://example.com' }, 'fake'), { statusCode: 400 })
    project = await context.service.configurePreview(7, project.id, { expectedVersion: 1, origin: 'https://tmp.test.sunmi.com' }, 'fake')
    assert.equal(project.preview?.generation, 1)
    assert.equal(project.preview?.origin, 'https://tmp.test.sunmi.com')
    assert.equal(project.events.some(event => event.text === 'inputs:changed'), false)
    project = await context.service.configurePreview(7, project.id, { expectedVersion: project.version, origin: project.preview!.origin }, 'fake')
    assert.equal(project.preview?.generation, 2)
    project = await context.service.configurePreview(7, project.id, { expectedVersion: project.version, origin: '' }, 'fake')
    assert.equal(project.preview, undefined)
  } finally { await context.close() }
})

test('remote snapshots validate ownership and CAS before loading, preserve provenance and reject stale completion', async () => {
  let calls = 0
  let changed: (() => Promise<void>) | undefined
  const context = await fixture({ generate: async () => ({ evidence: [], questions: [] }) }, { loadRemoteCode: async input => {
    calls++
    await changed?.()
    return { ...input, commit: 'a'.repeat(40), excluded: 2, files: [{ path: 'src/orders.ts', content: 'export const orders = []' }] }
  } })
  try {
    let project = await context.service.create(7, { title: 'Remote', description: 'Improve orders', modelId: 'auto' }, 'fake')
    const body = { expectedVersion: 1, repository: 'https://code.sunmi.com/team/orders.git', branch: 'main', directory: 'src' }
    await assert.rejects(context.service.addRemoteCodeSnapshot(8, project.id, body), { statusCode: 404 })
    await assert.rejects(context.service.addRemoteCodeSnapshot(7, project.id, { ...body, expectedVersion: 2 }), { statusCode: 409 })
    await assert.rejects(context.service.addRemoteCodeSnapshot(7, project.id, { ...body, repository: 'file:///private' }), { statusCode: 400 })
    assert.equal(calls, 0)
    project = await context.service.addRemoteCodeSnapshot(7, project.id, body)
    assert.equal(project.version, 2)
    assert.equal(project.status, 'draft')
    const source = await readSourceFile(context.root, 7, project.id, project.sources[0])
    assert.match(source.buffer.toString(), /Repository: "https:\/\/code.sunmi.com\/team\/orders.git"/)
    assert.match(source.buffer.toString(), /Commit: a{40}/)
    assert.match(source.buffer.toString(), /src\/orders.ts/)
    const provenance = { repository: body.repository, branch: body.branch, directory: body.directory, commit: 'a'.repeat(40) }
    assert.deepEqual((await context.service.detail(7, project.id)).sources[0].remoteCode, provenance)
    const legacy = await context.service.create(7, { title: 'Legacy', description: 'Existing snapshot', modelId: 'auto' }, 'fake')
    await context.service.addSources(7, legacy.id, { expectedVersion: 1 }, [{ name: 'existing-project-code.md', buffer: source.buffer }])
    assert.deepEqual((await context.service.detailWithSourceProvenance(7, legacy.id)).sources[0].remoteCode, provenance)
    assert.equal((await context.service.detail(7, legacy.id)).sources[0].remoteCode, undefined)
    await assert.rejects(context.service.detailWithSourceProvenance(8, legacy.id), { statusCode: 404 })
    assert.equal(project.events.at(-1)?.text, 'inputs:changed')
    changed = async () => { await context.service.addSources(7, project.id, { expectedVersion: 2, url: 'https://example.com/spec' }) }
    await assert.rejects(context.service.addRemoteCodeSnapshot(7, project.id, { ...body, expectedVersion: 2 }), { statusCode: 409 })
    assert.equal((await context.service.detail(7, project.id)).sources.length, 2)
  } finally { await context.close() }
})

test('expanded remote snapshots store all files and exclusion provenance, while formatted oversize fails before writes', async () => {
  let files = Array.from({ length: 201 }, (_, index) => ({ path: `src/file-${index}.ts`, content: 'a'.repeat(index === 0 ? 200000 : 6000) }))
  const context = await fixture({ generate: async () => ({ evidence: [], questions: [] }) }, { loadRemoteCode: async input => ({
    ...input, commit: 'a'.repeat(40), files, excluded: 1, excludedFiles: ['src/auth.ts'],
  }) })
  try {
    let project = await context.service.create(7, { title: 'Large remote', description: 'Read project code', modelId: 'auto' }, 'fake')
    const body = { expectedVersion: 1, repository: 'https://code.sunmi.com/team/orders.git', branch: 'master' }
    project = await context.service.addRemoteCodeSnapshot(7, project.id, body)
    const source = await readSourceFile(context.root, 7, project.id, project.sources[0])
    const text = source.buffer.toString('utf8')
    assert.equal((text.match(/Path: /g) || []).length, files.length)
    assert.match(text, /Path: "src\/file-200.ts"/)
    assert.match(text, /Content safety exclusions .*\["src\/auth.ts"\]/)
    assert.match(text, /do not infer their implementation or behavior/)
    assert.ok(source.buffer.length > 1048576)
    files = Array.from({ length: 4 }, (_, index) => ({ path: `src/lines-${index}.ts`, content: '\n'.repeat(500000) }))
    await assert.rejects(context.service.addRemoteCodeSnapshot(7, project.id, { ...body, expectedVersion: project.version }), { statusCode: 400, message: '格式化代码快照超过 10 MiB，请填写更小的模块目录' })
    assert.deepEqual(await context.service.detail(7, project.id), project)
  } finally { await context.close() }
})

test('creation stores the validated repository selection before a failing snapshot', async () => {
  const context = await fixture({ generate: async () => ({ evidence: [], questions: [] }) }, { loadRemoteCode: async () => { throw new RemoteCodeError('所选范围没有可读取的代码') } })
  try {
    const remoteCodeConfig = { repository: 'https://code.sunmi.com/team/orders.git', branch: 'main', directory: 'src' }
    const body = { title: 'Remote', description: 'Improve orders', modelId: 'auto', remoteCodeConfig }
    await assert.rejects(context.service.create(7, { ...body, remoteCodeConfig: { ...remoteCodeConfig, repository: 'file:///private' } }, 'fake'), { statusCode: 400 })
    const project = await context.service.create(7, body, 'fake')
    await assert.rejects(context.service.addRemoteCodeSnapshot(7, project.id, { expectedVersion: 1, ...remoteCodeConfig }), { statusCode: 400 })
    const detail = await context.service.detailWithSourceProvenance(7, project.id)
    assert.deepEqual(detail.remoteCodeConfig, remoteCodeConfig)
    assert.deepEqual(detail.sources, [])
    assert.equal(detail.version, 1)
  } finally { await context.close() }
})

test('remote snapshot errors preserve safe remediation messages without exposing raw Git failures or changing project data', async () => {
  let failure: Error = new RemoteCodeError('代码快照超出限制，请填写更小的模块目录')
  const context = await fixture({ generate: async () => ({ evidence: [], questions: [] }) }, { loadRemoteCode: async () => { throw failure } })
  try {
    const project = await context.service.create(7, { title: 'Remote failure', description: 'Read supplied code', modelId: 'auto' }, 'fake')
    const body = { expectedVersion: 1, repository: 'https://code.sunmi.com/team/orders.git', branch: 'main' }
    await assert.rejects(context.service.addRemoteCodeSnapshot(7, project.id, body), { statusCode: 400, message: failure.message })
    failure = new Error('PRIVATE_SENTINEL stderr https://user:secret@example.com')
    await assert.rejects(context.service.addRemoteCodeSnapshot(7, project.id, body), error => {
      assert.equal((error as { statusCode: number }).statusCode, 400)
      assert.doesNotMatch((error as Error).message, /PRIVATE_SENTINEL|stderr|secret/)
      return true
    })
    assert.deepEqual(await context.service.detail(7, project.id), project)
  } finally { await context.close() }
})

test('code snapshots enforce owner/CAS/busy before payload validation and source quotas before writes', async () => {
  const context = await fixture({ generate: async () => ({ evidence: [], questions: [] }) })
  try {
    const project = await context.service.create(7, { title: 'Snapshot', description: 'Read supplied code', modelId: 'auto' }, 'fake')
    await assert.rejects(context.service.addCodeSnapshot(8, project.id, { expectedVersion: 1, files: null }), { statusCode: 404 })
    await assert.rejects(context.service.addCodeSnapshot(7, project.id, { expectedVersion: 2, files: null }), { statusCode: 409 })
    for (const change of [
      (value: RequirementProject) => { value.status = 'running' },
      (value: RequirementProject) => { value.jobs.push({ id: randomUUID(), stage: 'analyze', status: 'running', startedAt: value.createdAt }) },
    ]) {
      const busy = { ...structuredClone(project), id: randomUUID() }
      change(busy)
      await context.repository.create(busy)
      await assert.rejects(context.service.addCodeSnapshot(7, busy.id, { expectedVersion: 1, files: null }), { statusCode: 409 })
      assert.deepEqual(await context.service.detail(7, busy.id), busy)
    }
    const files = [{ path: 'src/main.ts', content: 'export const value = 1' }]
    for (const value of [null, [], {}, { expectedVersion: 1, files, extra: true }, { expectedVersion: '1', files }, { expectedVersion: 1, files: [{ ...files[0], content: '-----BEGIN PRIVATE KEY-----\nPRIVATE_SENTINEL' }] }]) await assert.rejects(context.service.addCodeSnapshot(7, project.id, value), { statusCode: 400 })
    for (const [count, sizeBytes] of [[100, 0], [3, 10 * 1024 * 1024]] as const) {
      const full = { ...structuredClone(project), id: randomUUID() }
      full.sources = Array.from({ length: count }, () => ({ id: randomUUID(), kind: 'file' as const, name: 'source.md', sha256: 'a'.repeat(64), sizeBytes, storageKey: 'unused.md' }))
      await context.repository.create(full)
      await assert.rejects(context.service.addCodeSnapshot(7, full.id, { expectedVersion: 1, files }), { statusCode: 400 })
      assert.deepEqual(await context.service.detail(7, full.id), full)
    }
    assert.deepEqual(await context.service.detail(7, project.id), project)
    await context.service.close()
    await assert.rejects(context.service.addCodeSnapshot(7, project.id, { expectedVersion: 1, files: null }), { statusCode: 409 })
  } finally { await context.close() }
})

test('code snapshot is one owned file source, invalidates analyzed inputs and admits only one competing CAS', async () => {
  const context = await fixture({ generate: async (stage, project) => stage === 'analyze' ? { evidence: project.sources.map(source => ({ sourceId: source.id, summary: 'Supplied code', limitations: 'Not executed' })), questions: [question('Q-1')] } : { prd } })
  try {
    let project = await context.service.create(7, { title: 'Snapshot', description: 'Read supplied code', modelId: 'auto' }, 'fake')
    project = await context.service.addSources(7, project.id, { expectedVersion: 1, url: 'https://example.com/spec' })
    await context.service.launch(7, project.id, { expectedVersion: project.version, stage: 'analyze' }, 'fake')
    await context.service.wait(project.id)
    project = await context.service.detail(7, project.id)
    assert.equal(project.evidence.length, 1)
    assert.equal(project.questions.length, 1)
    const files = [{ path: 'src/main.ts', content: 'export const value = 1\n' }]
    const results = await Promise.allSettled([context.service.addCodeSnapshot(7, project.id, { expectedVersion: project.version, files }), context.service.addCodeSnapshot(7, project.id, { expectedVersion: project.version, files })])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.statusCode, 409)
    const saved = await context.service.detail(7, project.id)
    assert.equal(saved.version, project.version + 1)
    assert.equal(saved.status, 'draft')
    assert.deepEqual(saved.evidence, [])
    assert.deepEqual(saved.questions, [])
    assert.deepEqual(saved.revisions, project.revisions)
    assert.equal(saved.events.at(-1)?.text, 'inputs:changed')
    assert.equal(saved.sources.length, 2)
    assert.deepEqual(saved.sources[0], project.sources[0])
    const source = saved.sources[1]
    assert.equal(source.kind, 'file')
    assert.equal(source.name, 'existing-project-code.md')
    const { buffer } = await readSourceFile(context.root, 7, project.id, source)
    assert.equal(source.sizeBytes, buffer.length)
    assert.match(buffer.toString('utf8'), /UNTRUSTED EXISTING PROJECT CODE SNAPSHOT/)
    assert.match(buffer.toString('utf8'), /1\texport const value = 1/)
    await assert.rejects(context.service.launch(7, saved.id, { expectedVersion: saved.version, stage: 'prd' }, 'fake'), { statusCode: 409 })
    await context.service.launch(7, saved.id, { expectedVersion: saved.version, stage: 'analyze' }, 'fake')
    await context.service.wait(saved.id)
    assert.equal((await context.service.detail(7, saved.id)).evidence.length, 2)
  } finally { await context.close() }
})
const prd: StructuredPrd = { title: 'Editor', summary: 'Save text', blocks: [{ id: 'B-1', title: 'Editor', content: 'Save text', requirementIds: ['REQ-1'], sourceIds: [] }], requirements: [{ id: 'REQ-1', title: 'Save', description: 'Persist text', acceptance: [{ id: 'AC-1', text: 'Saved' }], sourceIds: [] }] }
test('business review is supplementary: confirmed revision survives failure, cancellation, recovery and current-state remapping', async () => {
  let mode: 'unavailable' | 'valid' | 'stale' | 'rewrite' | 'delayed' = 'unavailable'
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  const dual = dualPrdFixture(prd), calls: string[] = []
  const context = await fixture({ generate: async (stage, project, options) => {
    calls.push(stage)
    if (stage === 'analyze') return { evidence: [], questions: [] }
    if (stage === 'prd') return { prd: dual }
    if (options.designAdjustment) return { prototypes: project.revisions.at(-1)!.prototypes!.map(item => ({ ...item, html: item.html.replace('padding:16px', 'padding:32px') })) }
    return { prototypes: [{ id: 'EDITOR', title: 'Editor', html: '<!doctype html><html><body><main style="padding:16px" data-requirement-id="REQ-1" data-acceptance-id="AC-1">Saved text</main></body></html>', states: ['Saved', 'Existing'].map(name => ({ id: name, name, requirementIds: ['REQ-1'], acceptanceIds: ['AC-1'], changes: [] })) }] }
  }, prepareBusinessReview: async (project, options) => {
    const revision = project.revisions.at(-1)!
    assert.ok(options.businessReviewOnly)
    if (mode === 'unavailable') throw new Error('Review unavailable')
    if (mode === 'delayed') { entered(); await gate }
    const screenId = revision.screens.find(screen => screen.state === 'Saved')?.id
    return { changes: [{ requirementId: 'REQ-1', kind: '新增', scope: 'ui', text: mode === 'rewrite' ? 'Other scope' : '显示保存结果', basis: 'Saved', screenIds: mode === 'stale' ? ['old-screen'] : screenId ? [screenId] : [] }], pending: [] }
  } })
  try {
    let project = await context.service.create(7, { title: 'Editor', description: 'Show save result', modelId: 'auto' }, 'fixture')
    const run = async (stage: 'analyze' | 'prd' | 'design' | 'validate' | 'business-review', extra: Record<string, unknown> = {}) => {
      await context.service.launch(7, project.id, { stage, expectedVersion: project.version, ...(stage === 'business-review' ? { revisionId: project.revisions.at(-1)!.id } : {}), ...extra }, 'fixture')
      await context.service.wait(project.id); project = await context.service.detail(7, project.id)
    }
    await run('analyze'); await run('prd')
    assert.equal(project.status, 'prd_review'); assert.equal(project.revisions[0].businessReview, undefined)
    project = await context.service.confirm(7, project.id, { expectedVersion: project.version, target: 'prd' })
    await run('design')
    project = await context.service.confirm(7, project.id, { expectedVersion: project.version, target: 'design' })
    const before = structuredClone(project.revisions), original = before.at(-1)!
    const request = { stage: 'business-review', expectedVersion: project.version, revisionId: original.id }
    await assert.rejects(context.service.launch(8, project.id, request, 'fixture'), { statusCode: 404 })
    await assert.rejects(context.service.launch(7, project.id, { ...request, expectedVersion: 1 }, 'fixture'), { statusCode: 409 })
    await assert.rejects(context.service.launch(7, project.id, { ...request, revisionId: before[0].id }, 'fixture'), { statusCode: 409 })
    mode = 'valid'; await run('business-review')
    let latest = project.revisions.at(-1)!
    const { businessReview, ...canonical } = latest
    assert.deepEqual(canonical, original); assert.deepEqual(project.revisions.slice(0, -1), before.slice(0, -1))
    assert.equal(businessReview?.revisionId, original.id); assert.deepEqual(businessReview.changes[0].screenIds, [original.screens[0].id])
    assert.equal(validationInputFingerprint(project, latest), validationInputFingerprint(project, original))
    assert.deepEqual(calls, ['analyze', 'prd', 'design']); assert.equal(project.status, 'completed')
    const reviewed = structuredClone(project.revisions)
    for (const invalid of ['stale', 'rewrite'] as const) {
      mode = invalid; await run('business-review'); assert.equal(project.jobs.at(-1)?.status, 'failed'); assert.equal(project.status, 'completed'); assert.deepEqual(project.revisions, reviewed)
    }
    mode = 'delayed'
    project = await context.service.launch(7, project.id, { ...request, expectedVersion: project.version }, 'fixture')
    await started
    await assert.rejects(context.service.launch(7, project.id, { ...request, expectedVersion: project.version }, 'fixture'), { statusCode: 409 })
    await context.service.cancel(7, project.id, project.jobs.at(-1)!.id, { expectedVersion: project.version }); release(); await context.service.wait(project.id)
    project = await context.service.detail(7, project.id)
    assert.equal(project.jobs.at(-1)?.status, 'cancelled'); assert.equal(project.status, 'completed'); assert.deepEqual(project.revisions, reviewed)
    mode = 'valid'; await run('design', { screenId: original.screens[0].id, instruction: 'Increase padding' })
    latest = project.revisions.at(-1)!
    assert.notEqual(latest.screens[0].id, original.screens[0].id)
    assert.deepEqual(latest.businessReview, { ...businessReview, revisionId: latest.id, changes: [{ ...businessReview.changes[0], screenIds: [latest.screens[0].id] }] })
    assert.deepEqual(project.revisions.slice(0, -1), reviewed)
    mode = 'unavailable'; await run('validate')
    const checked = project.revisions.at(-1)!
    assert.deepEqual(checked.businessReview, { ...latest.businessReview, revisionId: checked.id })
    await run('design'); latest = project.revisions.at(-1)!
    assert.equal(project.jobs.at(-1)?.status, 'succeeded'); assert.deepEqual(latest.businessReview?.changes, [{ ...businessReview.changes[0], screenIds: [] }]); assert.equal(latest.screenshots?.length, 2)
    const persisted = structuredClone(project.revisions), version = project.version
    project.jobs.push({ id: randomUUID(), stage: 'business-review', revisionId: latest.id, startedAt: project.updatedAt, status: 'running' }); project.version++
    await context.repository.replace(project, version); await context.repository.recover()
    project = await context.service.detail(7, project.id)
    assert.equal(project.jobs.at(-1)?.status, 'interrupted'); assert.equal(project.status, 'design_review'); assert.deepEqual(project.revisions, persisted)
  } finally { release(); await context.close() }
})
test('shared source survives storage and one dialog layout edit regenerates every state screenshot', async () => {
  let downgrade = false
  const context = await fixture({ generate: async (stage, project, options) => {
    if (stage === 'analyze') return { evidence: [], questions: [] }
    if (stage === 'prd') return { prd }
    const previous = project.revisions.at(-1)!
    if (options.designAdjustment) {
      if (downgrade) return { screens: previous.screens }
      return { prototypes: previous.prototypes!.map(prototype => prototype.id === 'PAGE-PLAN' ? { ...prototype, html: prototype.html.replace('padding:16px', 'padding:32px') } : { ...prototype, html: prototype.html.replace('Other', 'Unwanted change') }) }
    }
    const html = '<!doctype html><html><head><style>body{margin:0}.dialog{padding:16px;background:#d7e9dd;min-height:180px}main{min-height:400px}p{color:#163820}</style></head><body><main data-requirement-id="REQ-1" data-acceptance-id="AC-1"><section class="dialog" data-prototype-node="dialog"><p>New plan</p><p data-prototype-node="error" hidden>Required</p></section><p data-prototype-node="success" hidden>Created</p></main></body></html>'
    return { prototypes: [
      { id: 'PAGE-PLAN', title: 'Plan', html, states: [
        { id: 'NORMAL', name: 'Normal', requirementIds: ['REQ-1'], acceptanceIds: ['AC-1'], changes: [] },
        { id: 'INVALID', name: 'Invalid', requirementIds: ['REQ-1'], acceptanceIds: ['AC-1'], changes: [{ node: 'error', text: 'Name required', hidden: false }] },
        { id: 'SUCCESS', name: 'Success', requirementIds: ['REQ-1'], acceptanceIds: ['AC-1'], changes: [{ node: 'dialog', hidden: true }, { node: 'success', hidden: false }] },
      ] },
      { id: 'OTHER', title: 'Other', html: html.replace('New plan', 'Other'), states: [{ id: 'OTHER-STATE', name: 'Normal', requirementIds: ['REQ-1'], acceptanceIds: ['AC-1'], changes: [] }] },
    ] }
  } })
  try {
    let project = await context.service.create(7, { title: 'Shared', description: 'One page', modelId: 'auto' }, 'fixture')
    for (const stage of ['analyze', 'prd', 'design'] as const) {
      if (stage === 'design') project = await context.service.confirm(7, project.id, { expectedVersion: project.version, target: 'prd' })
      await context.service.launch(7, project.id, { expectedVersion: project.version, stage }, 'fixture')
      await context.service.wait(project.id)
      project = await context.service.detail(7, project.id)
      assert.equal(project.jobs.at(-1)?.status, 'succeeded')
    }
    const original = structuredClone(project.revisions.at(-1)!)
    assert.equal(original.prototypes!.length, 2)
    assert.equal(original.prototypes![0].states.length, 3)
    assert.ok(original.prototypes![0].states.every(state => original.screens.some(screen => screen.id === state.id && screen.prototypeId === 'PAGE-PLAN')))
    await context.service.launch(7, project.id, { expectedVersion: project.version, stage: 'design', screenId: original.screens[1].id, instruction: 'Widen dialog padding' }, 'fixture')
    await context.service.wait(project.id)
    project = await context.service.detail(7, project.id)
    assert.equal(project.jobs.at(-1)?.status, 'succeeded')
    const updated = project.revisions.at(-1)!
    assert.ok(updated.screens.filter(screen => screen.prototypeId === 'PAGE-PLAN').every(screen => screen.html.includes('padding:32px')))
    assert.deepEqual(updated.screens.find(screen => screen.prototypeId === 'OTHER'), original.screens.find(screen => screen.prototypeId === 'OTHER'))
    assert.deepEqual(updated.prototypes!.find(prototype => prototype.id === 'OTHER'), original.prototypes!.find(prototype => prototype.id === 'OTHER'))
    assert.equal(updated.screenshots!.length, 4)
    assert.deepEqual(updated.validation!.errors, [])
    assert.deepEqual(updated.prd, original.prd)
    assert.deepEqual(project.revisions.at(-2), original)
    assert.match(updated.screens[1].html, /Name required/)
    assert.match(updated.screens[2].html, /data-prototype-node="dialog" hidden/)
    await assert.rejects(context.service.editDesign(7, project.id, { expectedVersion: project.version, screens: updated.screens }), { statusCode: 409 })
    downgrade = true
    await context.service.launch(7, project.id, { expectedVersion: project.version, stage: 'design', screenId: updated.screens[0].id, instruction: 'Do not downgrade' }, 'fixture')
    await context.service.wait(project.id)
    project = await context.service.detail(7, project.id)
    assert.equal(project.jobs.at(-1)?.status, 'failed')
    assert.deepEqual(project.revisions.at(-1), updated)
  } finally { await context.close() }
})
test('prototype job updates all states and screenshots atomically while preserving other pages and PRD', async () => {
  let invalid = false
  let unchanged = false
  let brokenLayout = false
  const context = await fixture({ generate: async (stage, project, options) => {
    if (stage === 'analyze') return { evidence: [], questions: [] }
    if (stage === 'prd') return { prd }
    const screens = project.revisions.at(-1)!.screens
    assert.ok(options.designAdjustment)
    if (unchanged) return { prototypes: project.revisions.at(-1)!.prototypes }
    if (brokenLayout) return { prototypes: project.revisions.at(-1)!.prototypes!.map(prototype => ({ ...prototype, html: prototype.html.replace('Adjusted', '<div style="width:4000px">Overflow</div>') })) }
    return { prototypes: [{ id: 'EDITOR', title: 'Editor', html: '<!doctype html><html><head><title>Editor</title><style>body{margin:0}main{height:400px;background:#32865b;color:white;padding:40px}</style></head><body><main data-requirement-id="REQ-1" data-acceptance-id="AC-1">Adjusted<button>Save</button></main></body></html>', states: screens.filter(screen => screen.title === 'Editor').map(screen => ({ id: screen.id, name: screen.state, requirementIds: screen.requirementIds, acceptanceIds: invalid ? [] : screen.acceptanceIds, changes: [] })) }] }
  } })
  try {
    let project = await context.service.create(7, { title: 'Adjust', description: 'Keep scope', modelId: 'auto' }, 'fixture')
    for (const stage of ['analyze', 'prd'] as const) {
      await context.service.launch(7, project.id, { expectedVersion: project.version, stage }, 'fixture')
      await context.service.wait(project.id)
      project = await context.service.detail(7, project.id)
    }
    project = await context.service.confirm(7, project.id, { expectedVersion: project.version, target: 'prd' })
    project = await context.service.editDesign(7, project.id, { expectedVersion: project.version, screens: ['Default', 'Empty', 'Validation failure', 'Other'].map((state, index) => ({ id: `STATE-${index}`, title: state === 'Other' ? 'Other prototype' : 'Editor', state, requirementIds: ['REQ-1'], acceptanceIds: ['AC-1'], html: `<!doctype html><html><head><title>Editor</title><style>main{height:400px;background:#32865b;color:white}</style></head><body><main data-requirement-id="REQ-1">Original<span data-acceptance-id="AC-1"${index === 3 ? ' hidden' : ''}>Acceptance</span></main></body></html>` })) })
    const original = structuredClone(project.revisions.at(-1)!)
    const body = { expectedVersion: project.version, stage: 'design', screenId: original.screens[0].id, instruction: 'Improve spacing' }
    await assert.rejects(context.service.launch(8, project.id, body, 'fixture'), { statusCode: 404 })
    await assert.rejects(context.service.launch(7, project.id, { ...body, expectedVersion: 1 }, 'fixture'), { statusCode: 409 })
    await assert.rejects(context.service.launch(7, project.id, { ...body, screenId: 'unknown' }, 'fixture'), { statusCode: 400 })
    await context.service.launch(7, project.id, body, 'fixture')
    await context.service.wait(project.id)
    project = await context.service.detail(7, project.id)
    const adjusted = project.revisions.at(-1)!
    assert.equal(project.description, 'Keep scope')
    assert.deepEqual(adjusted.prd, original.prd)
    assert.equal(adjusted.confirmedAt, original.confirmedAt)
    assert.deepEqual(adjusted.screens[3], original.screens[3])
    assert.notEqual(adjusted.screens[1].id, original.screens[1].id)
    assert.notEqual(adjusted.screens[2].id, original.screens[2].id)
    assert.notEqual(adjusted.screens[0].id, original.screens[0].id)
    assert.match(adjusted.screens[0].html, /Adjusted/)
    assert.deepEqual(project.revisions.at(-2), original)
    assert.equal(project.jobs.at(-1)?.status, 'succeeded')
    assert.ok(adjusted.validation?.errors.some(error => error.includes('Missing visible mapping: AC-1')))
    assert.equal(adjusted.validation?.allScreensValidated, false)
    assert.equal(adjusted.validation?.interactionVerified, false)
    assert.equal(adjusted.validation?.screens.slice(0, 3).every(check => check.visual === 'passed'), true)
    assert.equal(adjusted.validation?.screens[3].visual, 'failed')
    await assert.rejects(context.service.confirm(7, project.id, { expectedVersion: project.version, target: 'design' }), { statusCode: 409 })
    assert.equal(adjusted.screenshots?.length, 4)
    assert.equal(adjusted.prototypes?.length, 1)
    assert.equal(adjusted.prototypes?.[0].states.length, 3)
    assert.ok(adjusted.screens.slice(0, 3).every(screen => screen.prototypeId === 'EDITOR'))
    assert.equal(adjusted.designConfirmedAt, undefined)
    unchanged = true
    await context.service.launch(7, project.id, { ...body, expectedVersion: project.version, screenId: adjusted.screens[0].id }, 'fixture')
    await context.service.wait(project.id)
    project = await context.service.detail(7, project.id)
    assert.equal(project.jobs.at(-1)?.status, 'failed')
    assert.match(project.jobs.at(-1)!.error!, /DESIGN_ADJUSTMENT_UNCHANGED/)
    assert.deepEqual(project.revisions.at(-1), adjusted)
    unchanged = false
    invalid = true
    const revisions = project.revisions.length
    await context.service.launch(7, project.id, { ...body, expectedVersion: project.version, screenId: adjusted.screens[0].id }, 'fixture')
    await context.service.wait(project.id)
    project = await context.service.detail(7, project.id)
    assert.equal(project.jobs.at(-1)?.status, 'failed')
    assert.equal(project.revisions.length, revisions)
    invalid = false
    brokenLayout = true
    await context.service.launch(7, project.id, { ...body, expectedVersion: project.version, screenId: adjusted.screens[0].id }, 'fixture')
    await context.service.wait(project.id)
    project = await context.service.detail(7, project.id)
    assert.equal(project.jobs.at(-1)?.status, 'failed')
    assert.match(project.jobs.at(-1)!.error!, /DESIGN_ADJUSTMENT_VALIDATION/)
    assert.match(project.jobs.at(-1)!.error!, /1600px：水平布局溢出/)
    assert.doesNotMatch(project.jobs.at(-1)!.error!, /390px/)
    assert.deepEqual(project.revisions.at(-1), adjusted)
    assert.equal(project.revisions.length, revisions)
  } finally { await context.close() }
})
test('prototype static validation retries once with the failed candidate and exact state feedback, saving only the passing revision', async () => {
  let calls = 0
  let validations = 0
  let original!: RequirementRevision
  const context = await fixture({ generate: async (stage, project, options) => {
    if (stage === 'analyze') return { evidence: [], questions: [] }
    if (stage === 'prd') return { prd }
    calls++
    assert.deepEqual(project.revisions.at(-1), original)
    assert.equal(options.designAdjustment?.instruction, 'Improve spacing')
    await options.recordConversation({
      conversationId: randomUUID(), sequence: 1, requestIndex: 1, createdAt: new Date().toISOString(), kind: 'request',
      body: { instruction: options.designAdjustment?.instruction, feedback: options.designAdjustment?.validationFeedback },
    })
    if (calls === 1) assert.equal(options.designAdjustment?.validationFeedback, undefined)
    else {
      const feedback = options.designAdjustment!.validationFeedback!
      assert.match(feedback.reason, /DESIGN_ADJUSTMENT_VALIDATION/)
      assert.equal(feedback.candidate.prototypes?.[0].states[1].changes[0].hidden, true)
      const failed = feedback.states.find(state => state.screenId === original.screens[1].id)!
      assert.equal(failed.state, original.screens[1].state)
      assert.deepEqual(failed.viewports, [{ width: 1600, height: 1000, errors: ['Missing visible mapping: AC-1'] }])
      const current = await context.service.detail(7, project.id)
      assert.equal(current.jobs.at(-1)?.status, 'running')
      assert.deepEqual(current.revisions.at(-1), original)
    }
    return retryPrototype(project, calls === 1)
  } }, { validatePrototype: async (...args) => { validations++; return validatePrototypeRevision(...args) } })
  try {
    let project = await adjustmentProject(context.service)
    original = structuredClone(project.revisions.at(-1)!)
    const revisionCount = project.revisions.length
    const jobCount = project.jobs.length
    await context.service.launch(7, project.id, { expectedVersion: project.version, stage: 'design', screenId: original.screens[0].id, instruction: 'Improve spacing' }, 'fixture')
    await context.service.wait(project.id)
    project = await context.service.detail(7, project.id)
    assert.equal(calls, 2)
    assert.equal(validations, 2)
    assert.equal(project.jobs.length, jobCount + 1)
    assert.equal(project.jobs.at(-1)?.status, 'succeeded')
    assert.equal(project.revisions.length, revisionCount + 1)
    assert.deepEqual(project.revisions.at(-2), original)
    assert.deepEqual(project.revisions.at(-1)!.prd, original.prd)
    assert.deepEqual(project.revisions.at(-1)!.screens[2], original.screens[2])
    assert.equal(project.revisions.at(-1)!.screenshots?.length, 3)
    assert.ok(project.events.some(event => /自动重试 1\/1/.test(event.text)))
    assert.ok(project.events.every(event => !event.text.includes('data-prototype-node')))
    assert.equal((await context.service.detail(7, project.id)).revisions.at(-1)!.id, project.revisions.at(-1)!.id)
    const directory = join(context.root, 'requirements', 'conversations', project.id, project.jobs.at(-1)!.id)
    const conversations = await readdir(directory)
    assert.equal(conversations.length, 2)
    const records = await Promise.all(conversations.map(file => readFile(join(directory, file), 'utf8').then(text => JSON.parse(text.trim()) as { body: { instruction: string; feedback?: unknown } })))
    assert.ok(records.every(record => record.body.instruction === 'Improve spacing'))
    assert.equal(records.filter(record => record.body.feedback).length, 1)
    assert.doesNotMatch(JSON.stringify(project), /"conversationId"|"feedback"/)
  } finally { await context.close() }
})

test('conversation write failures mark the task failed without saving generated output or retrying', async () => {
  let calls = 0
  const context = await fixture({ generate: async (_stage, _project, options) => {
    calls++
    const audit = new RequirementConversationAudit(options.recordConversation)
    await audit.start({ model: 'auto' }, { stage: 'analyze' })
    await audit.finish('succeeded')
    return { evidence: [], questions: [] }
  } })
  context.repository.appendConversation = async () => { throw new Error('private storage failure') }
  try {
    let project = await context.service.create(7, { title: 'Audit failure', description: 'Do not silently lose records', modelId: 'auto' }, 'fixture')
    await context.service.launch(7, project.id, { expectedVersion: project.version, stage: 'analyze' }, 'fixture')
    await context.service.wait(project.id)
    project = await context.service.detail(7, project.id)
    assert.equal(calls, 1)
    assert.equal(project.jobs.at(-1)?.status, 'failed')
    assert.match(project.jobs.at(-1)!.error!, /CONVERSATION_STORAGE/)
    assert.doesNotMatch(JSON.stringify(project), /private storage failure/)
    assert.equal(project.revisions.length, 0)
    assert.equal(project.events.filter(event => event.text.startsWith('analysis:')).length, 0)
  } finally { await context.close() }
})

test('prototype static retry stops after its second rejection or a retry model/contract failure, retaining the original', async () => {
  for (const mode of ['static', 'model', 'contract'] as const) {
    let calls = 0
    let validations = 0
    const context = await fixture({ generate: async (stage, project) => {
      if (stage === 'analyze') return { evidence: [], questions: [] }
      if (stage === 'prd') return { prd }
      calls++
      if (calls === 2 && mode === 'model') throw new Error('SECRET_TOKEN model failed')
      const result = retryPrototype(project, true)
      if (calls === 2 && mode === 'contract') result.prototypes![0].states[0].acceptanceIds = []
      return result
    } }, { validatePrototype: async (_project, revision) => { validations++; return rejectedAdjustment(revision) } })
    try {
      let project = await adjustmentProject(context.service)
      const original = structuredClone(project.revisions)
      await context.service.launch(7, project.id, { expectedVersion: project.version, stage: 'design', screenId: project.revisions.at(-1)!.screens[0].id, instruction: 'Improve spacing' }, 'fixture')
      await context.service.wait(project.id)
      project = await context.service.detail(7, project.id)
      assert.equal(calls, 2)
      assert.equal(validations, mode === 'static' ? 2 : 1)
      assert.equal(project.jobs.at(-1)?.status, 'failed')
      assert.deepEqual(project.revisions, original)
      assert.doesNotMatch(JSON.stringify(project), /SECRET_TOKEN/)
      if (mode === 'static') assert.match(project.jobs.at(-1)!.error!, /DESIGN_ADJUSTMENT_VALIDATION.*重试 1 次后仍未通过/)
      if (mode === 'model') assert.match(project.jobs.at(-1)!.error!, /\[MODEL\]/)
    } finally { await context.close() }
  }
})

test('static retry includes incomplete screenshot and browser failure reasons, sanitizing renderer diagnostics', async () => {
  for (const mode of ['screenshots', 'browser', 'renderer'] as const) {
    let calls = 0
    const context = await fixture({ generate: async (stage, project, options) => {
      if (stage === 'analyze') return { evidence: [], questions: [] }
      if (stage === 'prd') return { prd }
      calls++
      if (calls === 2) {
        const feedback = options.designAdjustment!.validationFeedback!
        assert.match(feedback.reason, mode === 'screenshots' ? /截图或状态检查不完整/ : mode === 'browser' ? /浏览器验证不可用/ : /页面渲染失败/)
        assert.doesNotMatch(JSON.stringify(feedback), /SECRET_TOKEN/)
        if (mode === 'renderer') assert.equal(feedback.states[0].viewports[0].errors[0], 'Prototype rendering failed')
      }
      return retryPrototype(project, false)
    } }, { validatePrototype: async (_project, revision) => {
      const report = rejectedAdjustment(revision)
      if (mode === 'browser') { report.validation.screens = []; report.validation.errors = ['Isolated Chromium validation unavailable or failed'] }
      else {
        report.validation.screens = report.validation.screens.map(check => ({ ...check, visual: mode === 'screenshots' ? 'passed' : 'failed', viewports: check.viewports.map(view => ({ ...view, errors: mode === 'screenshots' ? [] : ['Prototype rendering failed: SECRET_TOKEN private browser diagnostics'] })) }))
        report.validation.errors = report.validation.screens.flatMap(check => check.viewports.flatMap(view => view.errors.map(error => `${check.screenId} (${view.width}x${view.height}): ${error}`)))
      }
      return report
    } })
    try {
      let project = await adjustmentProject(context.service)
      const original = structuredClone(project.revisions)
      await context.service.launch(7, project.id, { expectedVersion: project.version, stage: 'design', screenId: project.revisions.at(-1)!.screens[0].id, instruction: 'Improve spacing' }, 'fixture')
      await context.service.wait(project.id)
      project = await context.service.detail(7, project.id)
      assert.equal(calls, 2)
      assert.equal(project.jobs.at(-1)?.status, 'failed')
      assert.deepEqual(project.revisions, original)
      assert.doesNotMatch(JSON.stringify(project), /SECRET_TOKEN/)
    } finally { await context.close() }
  }
})

test('cancellation during the retry discards a late corrected result and never validates or saves it', async () => {
  let calls = 0
  let validations = 0
  let finish!: (result: RequirementModelResult) => void
  let started!: () => void
  let retryProject!: RequirementProject
  const retrying = new Promise<void>(resolve => { started = resolve })
  const pending = new Promise<RequirementModelResult>(resolve => { finish = resolve })
  const context = await fixture({ generate: async (stage, project) => {
    if (stage === 'analyze') return { evidence: [], questions: [] }
    if (stage === 'prd') return { prd }
    calls++
    if (calls === 2) { retryProject = project; started(); return pending }
    return retryPrototype(project, true)
  } }, { validatePrototype: async (_project, revision) => { validations++; return rejectedAdjustment(revision) } })
  try {
    let project = await adjustmentProject(context.service)
    const original = structuredClone(project.revisions)
    await context.service.launch(7, project.id, { expectedVersion: project.version, stage: 'design', screenId: project.revisions.at(-1)!.screens[0].id, instruction: 'Improve spacing' }, 'fixture')
    await retrying
    project = await context.service.detail(7, project.id)
    const cancelled = await context.service.cancel(7, project.id, project.jobs.at(-1)!.id, { expectedVersion: project.version })
    finish(retryPrototype(retryProject, false))
    await context.service.wait(project.id)
    await new Promise<void>(resolve => setImmediate(resolve))
    project = await context.service.detail(7, project.id)
    assert.equal(calls, 2)
    assert.equal(validations, 1)
    assert.equal(project.jobs.at(-1)?.status, 'cancelled')
    assert.deepEqual(project.revisions, original)
    assert.deepEqual(project, cancelled)
  } finally { finish({}); await context.close() }
})

test('cancellation while static validation is pending never launches the automatic retry', async () => {
  let calls = 0
  let finish!: () => void
  let started!: () => void
  const validating = new Promise<void>(resolve => { started = resolve })
  const pending = new Promise<void>(resolve => { finish = resolve })
  const context = await fixture({ generate: async (stage, project) => {
    if (stage === 'analyze') return { evidence: [], questions: [] }
    if (stage === 'prd') return { prd }
    calls++
    return retryPrototype(project, true)
  } }, { validatePrototype: async (_project, revision) => { started(); await pending; return rejectedAdjustment(revision) } })
  try {
    let project = await adjustmentProject(context.service)
    const original = structuredClone(project.revisions)
    await context.service.launch(7, project.id, { expectedVersion: project.version, stage: 'design', screenId: project.revisions.at(-1)!.screens[0].id, instruction: 'Improve spacing' }, 'fixture')
    await validating
    project = await context.service.detail(7, project.id)
    await context.service.cancel(7, project.id, project.jobs.at(-1)!.id, { expectedVersion: project.version })
    finish()
    await context.service.wait(project.id)
    project = await context.service.detail(7, project.id)
    assert.equal(calls, 1)
    assert.equal(project.jobs.at(-1)?.status, 'cancelled')
    assert.deepEqual(project.revisions, original)
  } finally { finish(); await context.close() }
})

async function adjustmentProject(service: RequirementService) {
  let project = await service.create(7, { title: 'Retry editor', description: 'Keep confirmed scope', modelId: 'auto' }, 'fixture')
  for (const stage of ['analyze', 'prd'] as const) {
    await service.launch(7, project.id, { expectedVersion: project.version, stage }, 'fixture')
    await service.wait(project.id)
    project = await service.detail(7, project.id)
  }
  project = await service.confirm(7, project.id, { expectedVersion: project.version, target: 'prd' })
  return service.editDesign(7, project.id, { expectedVersion: project.version, screens: ['Default', 'All unclassified', 'Other'].map((state, index) => ({
    id: `RETRY-${index}`, title: index === 2 ? 'Other prototype' : 'Editor', state, requirementIds: ['REQ-1'], acceptanceIds: ['AC-1'],
    html: '<!doctype html><html><body><main data-requirement-id="REQ-1" data-acceptance-id="AC-1">Original</main></body></html>',
  })) })
}

function retryPrototype(project: RequirementProject, hidden: boolean): RequirementModelResult {
  return { prototypes: [{
    id: 'RETRY-EDITOR', title: 'Editor',
    html: '<!doctype html><html><head><style>main{height:240px;background:#32865b;color:white;padding:32px}</style></head><body><main data-requirement-id="REQ-1">Adjusted<p data-prototype-node="acceptance" data-acceptance-id="AC-1">Saved text</p></main></body></html>',
    states: project.revisions.at(-1)!.screens.filter(screen => screen.title === 'Editor').map((screen, index) => ({
      id: screen.id, name: screen.state, requirementIds: screen.requirementIds, acceptanceIds: screen.acceptanceIds, changes: [{ node: 'acceptance', hidden: hidden && index === 1 }],
    })),
  }] }
}

function rejectedAdjustment(revision: RequirementRevision): ValidatedRequirementRevision {
  const checks = revision.screens.map(screen => ({ screenId: screen.id, visual: 'failed' as const, interaction: 'not_verified' as const, interactionErrors: [], viewports: [{ width: 1600, height: 1000, errors: ['Missing visible mapping: AC-1'] }] }))
  return { ...revision, screenshots: [], validation: { at: new Date().toISOString(), errors: checks.map(check => `${check.screenId} (1600x1000): Missing visible mapping: AC-1`), artifactVersion: 1, inputSha256: 'a'.repeat(64), allScreensValidated: false, interactionVerified: false, mode: 'static-script-disabled', screens: checks, limitations: [] } }
}

async function fixture(model: RequirementModel, options: RequirementServiceOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'requirements-service-'))
  const repository = new JsonRequirementRepository(root)
  await repository.verify()
  const service = new RequirementService(repository, root, { ...options, model })
  return { root, repository, service, close: async () => { await service.close(); await rm(root, { recursive: true, force: true }) } }
}

test('job errors and timeline retain safe phase diagnostics, never arbitrary model exception text', async () => {
  for (const failure of [requirementDiagnostic(undefined, 'parse'), new Error('SECRET_TOKEN raw source and SDK output')]) {
    const context = await fixture({ generate: async () => { throw failure } })
    try {
      let project = await context.service.create(7, { title: 'Editor', description: 'Save text', modelId: 'auto' }, 'fake')
      await context.service.launch(7, project.id, { expectedVersion: project.version, stage: 'analyze' }, 'fake')
      await context.service.wait(project.id)
      project = await context.service.detail(7, project.id)
      const code = failure.message.startsWith('[PARSE]') ? 'PARSE' : 'MODEL'
      assert.equal(project.jobs.at(-1)?.status, 'failed')
      assert.ok(project.jobs.at(-1)?.error?.includes(`[${code}]`))
      assert.ok(project.events.at(-1)?.text.includes(`[${code}]`))
      assert.doesNotMatch(JSON.stringify(project), /SECRET_TOKEN|raw source|SDK output/)
    } finally { await context.close() }
  }
})

test('CAS, owner, partial answers and mandatory reanalysis before PRD', async () => {
  let analyses = 0
  const context = await fixture({ generate: async stage => stage === 'analyze' ? { evidence: [], questions: analyses++ ? [] : [question('Q-1'), question('Q-2')] } : { prd } })
  try {
    let project = await context.service.create(7, { title: 'Editor', description: 'Save text', modelId: 'auto' }, 'fake')
    const id = project.id
    await assert.rejects(context.service.detail(8, id), { statusCode: 404 })
    await assert.rejects(context.service.launch(7, id, { expectedVersion: 1, stage: 'prd' }, 'fake'), { statusCode: 409 })
    await context.service.launch(7, id, { expectedVersion: 1, stage: 'analyze' }, 'fake')
    await context.service.wait(id)
    project = await context.service.detail(7, id)
    assert.equal(project.status, 'needs_input')
    await assert.rejects(context.service.answers(7, id, { expectedVersion: 1, answers: [{ questionId: 'Q-1', answer: 'A' }] }), { statusCode: 409 })
    project = await context.service.answers(7, id, { expectedVersion: project.version, answers: [{ questionId: 'Q-1', answer: 'A' }] })
    assert.equal(project.status, 'needs_input')
    await assert.rejects(context.service.answers(7, id, { expectedVersion: project.version, answers: [{ questionId: 'Q-1', answer: 'A' }] }), { statusCode: 400 })
    project = await context.service.answers(7, id, { expectedVersion: project.version, answers: [{ questionId: 'Q-2', answer: 'Custom scope' }] })
    await assert.rejects(context.service.launch(7, id, { expectedVersion: project.version, stage: 'prd' }, 'fake'), { statusCode: 409 })
    await context.service.launch(7, id, { expectedVersion: project.version, stage: 'analyze' }, 'fake')
    await context.service.wait(id)
    project = await context.service.detail(7, id)
    await context.service.launch(7, id, { expectedVersion: project.version, stage: 'prd' }, 'fake')
    await context.service.wait(id)
    project = await context.service.detail(7, id)
    assert.equal(project.status, 'prd_review')
    assert.deepEqual(project.revisions[0].prd, { ...prd, requirements: prd.requirements, blocks: prd.blocks })
    await assert.rejects(context.service.launch(7, id, { expectedVersion: project.version, stage: 'design' }, 'fake'), { statusCode: 409 })
    project = await context.service.confirm(7, id, { expectedVersion: project.version, target: 'prd' })
    assert.ok(project.revisions.at(-1)?.confirmedAt)
  } finally { await context.close() }
})

test('cancel discards late model progress/results and recovery interrupts without replay', async () => {
  let finish!: (value: { evidence: []; questions: [] }) => void
  let progress!: (text: string) => Promise<void>
  const context = await fixture({ generate: async (_stage, _project, options) => { progress = options.onProgress; return new Promise(resolve => { finish = resolve }) } })
  try {
    let project = await context.service.create(7, { title: 'Editor', description: 'Save text', modelId: 'auto' }, 'fake')
    project = await context.service.launch(7, project.id, { expectedVersion: 1, stage: 'analyze' }, 'fake')
    await new Promise<void>(resolve => setImmediate(resolve))
    const cancelled = await context.service.cancel(7, project.id, project.jobs[0].id, { expectedVersion: project.version })
    finish({ evidence: [], questions: [] })
    await context.service.wait(project.id)
    await assert.rejects(progress('late'))
    assert.deepEqual(await context.service.detail(7, project.id), cancelled)
    const running = { ...cancelled, version: cancelled.version + 1, status: 'running' as const, jobs: [{ ...cancelled.jobs[0], status: 'running' as const }] }
    await context.repository.replace(running, cancelled.version)
    await context.repository.recover()
    assert.equal((await context.service.detail(7, project.id)).jobs[0].status, 'interrupted')
  } finally { await context.close() }
})

test('changed agent inputs discard a late result without overwriting the changed project', async () => {
  let finish!: (value: { evidence: []; questions: [] }) => void
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const context = await fixture({ generate: async () => { entered(); return new Promise(resolve => { finish = resolve }) } })
  try {
    let project = await context.service.create(7, { title: 'Original', description: 'Original requirements', modelId: 'auto' }, 'fake')
    await context.service.launch(7, project.id, { expectedVersion: project.version, stage: 'analyze' }, 'fake')
    await started
    project = await context.service.detail(7, project.id)
    const expectedVersion = project.version
    project.title = 'Changed outside this run'
    project.version++
    await context.repository.replace(project, expectedVersion)
    finish({ evidence: [], questions: [] })
    await context.service.wait(project.id)
    const current = await context.service.detail(7, project.id)
    assert.equal(current.title, 'Changed outside this run')
    assert.equal(current.jobs.at(-1)?.status, 'failed')
    assert.match(current.jobs.at(-1)?.error ?? '', /AGENT_STALE/)
    assert.equal(current.revisions.length, 0)
    assert.deepEqual(current.evidence, [])
  } finally { await context.close() }
})

test('design uses UUID revisions; static-only validation is explicit and changed sources revoke old confirmation', async () => {
  const screen = { id: 'SCREEN-1', title: 'Editor', state: 'normal', requirementIds: ['REQ-1'], acceptanceIds: ['AC-1'], html: '<!doctype html><html><body><main data-requirement-id="REQ-1" data-acceptance-id="AC-1">Saved text</main></body></html>' }
  let interactionVerified = true
  const context = await fixture({ generate: async (stage, project) => stage === 'analyze' ? { evidence: project.sources.map(source => ({ sourceId: source.id, summary: 'Supplied facts', limitations: 'Fake model only' })), questions: [] } : stage === 'prd' ? { prd } : { screens: [screen] } }, {
    validatePrototype: async (project, revision) => ({ ...revision, screenshots: revision.screens.map(item => ({ screenId: item.id, storageKey: 'fake-isolated-artifact', sha256: 'a'.repeat(64) })), validation: { at: new Date().toISOString(), errors: [], artifactVersion: 1, inputSha256: createHash('sha256').update(JSON.stringify({ projectId: project.id, revisionId: revision.id, prd: revision.prd, screens: revision.screens, sources: project.sources, decisions: project.decisions })).digest('hex'), allScreensValidated: true, interactionVerified: interactionVerified as false, mode: 'static-script-disabled', screens: revision.screens.map(item => ({ screenId: item.id, visual: 'passed', interaction: 'not_verified', interactionErrors: [], viewports: [{ width: 1600, height: 1000, errors: [] }, { width: 390, height: 1000, errors: [] }] })), limitations: ['Static only'] } }),
    exportRevision: async () => ({ buffer: Buffer.from('fake isolated export'), filename: 'requirements.md', contentType: 'text/markdown' }),
  })
  try {
    let project = await context.service.create(7, { title: 'Editor', description: 'Save text', modelId: 'auto' }, 'fake')
    const job = async (stage: 'analyze' | 'prd' | 'design' | 'validate') => {
      await context.service.launch(7, project.id, { expectedVersion: project.version, stage }, 'fake')
      await context.service.wait(project.id)
      project = await context.service.detail(7, project.id)
      assert.equal(project.jobs.at(-1)?.status, 'succeeded')
    }
    await job('analyze'); await job('prd')
    project = await context.service.confirm(7, project.id, { expectedVersion: project.version, target: 'prd' })
    await job('design')
    assert.match(project.revisions.at(-1)!.screens[0].id, /^[a-f0-9-]{36}$/)
    assert.equal(project.revisions[0].screens.length, 0)
    await assert.rejects(context.service.confirm(7, project.id, { expectedVersion: project.version, target: 'design' }), { statusCode: 409 })
    await job('validate')
    await assert.rejects(context.service.confirm(7, project.id, { expectedVersion: project.version, target: 'design' }), { statusCode: 409 })
    interactionVerified = false
    await job('validate')
    project = await context.service.confirm(7, project.id, { expectedVersion: project.version, target: 'design' })
    assert.equal(project.status, 'completed')
    assert.match(project.events.at(-1)!.text, /interactions are not verified/)
    const completed = structuredClone(project)
    const supplied = [{ ...project.revisions.at(-1)!.screens[0], title: 'Manually edited editor' }]
    project = await context.service.editDesign(7, project.id, { expectedVersion: project.version, screens: supplied })
    assert.equal(project.status, 'design_review')
    assert.equal(project.version, completed.version + 1)
    assert.deepEqual(project.revisions.slice(0, -1), completed.revisions)
    const edited = project.revisions.at(-1)!
    assert.match(edited.id, /^[a-f0-9-]{36}$/)
    assert.ok(!completed.revisions.some(revision => revision.id === edited.id))
    assert.match(edited.screens[0].id, /^[a-f0-9-]{36}$/)
    assert.notEqual(edited.screens[0].id, supplied[0].id)
    assert.deepEqual(edited.screens[0], { ...supplied[0], id: edited.screens[0].id })
    assert.deepEqual(edited.prd, completed.revisions.at(-1)!.prd)
    assert.equal(edited.confirmedAt, completed.revisions.at(-1)!.confirmedAt)
    for (const field of ['screenshots', 'validation', 'designConfirmedAt']) assert.equal(Object.hasOwn(edited, field), false)
    for (const field of ['sources', 'evidence', 'questions', 'decisions', 'jobs'] as const) assert.deepEqual(project[field], completed[field])
    assert.deepEqual(project.events.slice(0, -1), completed.events)
    assert.equal(project.events.at(-1)!.text, `prd:${edited.id}`)
    assert.deepEqual(await context.service.detail(7, project.id), project)
    await assert.rejects(context.service.confirm(7, project.id, { expectedVersion: project.version, target: 'design' }), { statusCode: 409 })
    const beforeSecondEdit = structuredClone(project)
    project = await context.service.editDesign(7, project.id, { expectedVersion: project.version, screens: supplied })
    assert.deepEqual(project.revisions.slice(0, -1), beforeSecondEdit.revisions)
    assert.notEqual(project.revisions.at(-1)!.screens[0].id, edited.screens[0].id)
    await job('validate')
    project = await context.service.confirm(7, project.id, { expectedVersion: project.version, target: 'design' })
    assert.equal(project.status, 'completed')
    const historical = structuredClone(project.revisions)
    project = await context.service.addSources(7, project.id, { expectedVersion: project.version, url: 'https://example.com/spec' })
    assert.deepEqual(project.revisions, historical)
    await assert.rejects(context.service.launch(7, project.id, { expectedVersion: project.version, stage: 'design' }, 'fake'), { statusCode: 409 })
    await context.service.launch(7, project.id, { expectedVersion: project.version, stage: 'analyze' }, 'fake')
    await context.service.wait(project.id)
    project = await context.service.detail(7, project.id)
    assert.equal(project.jobs.at(-1)?.status, 'succeeded')
    await assert.rejects(context.service.launch(7, project.id, { expectedVersion: project.version, stage: 'design' }, 'fake'), { statusCode: 409 })
    await assert.rejects(context.service.confirm(7, project.id, { expectedVersion: project.version, target: 'design' }), { statusCode: 409 })
  } finally { await context.close() }
})

test('manual design save enforces current confirmed PRD, analysis, questions, owner, busy and revision limits', async () => {
  const screen = { id: 'SCREEN-1', title: 'Editor', state: 'normal', requirementIds: ['REQ-1'], acceptanceIds: ['AC-1'], html: '<!doctype html><html><body><main data-requirement-id="REQ-1">Saved text</main></body></html>' }
  const context = await fixture({ generate: async stage => stage === 'analyze' ? { evidence: [], questions: [] } : { prd } })
  try {
    let project = await context.service.create(7, { title: 'Editor', description: 'Save text', modelId: 'auto' }, 'fake')
    for (const stage of ['analyze', 'prd'] as const) {
      await context.service.launch(7, project.id, { expectedVersion: project.version, stage }, 'fake')
      await context.service.wait(project.id)
      project = await context.service.detail(7, project.id)
    }
    project = await context.service.confirm(7, project.id, { expectedVersion: project.version, target: 'prd' })
    const gates: [string, (value: RequirementProject) => void][] = [
      ['no revision', value => { value.revisions = [] }],
      ['unconfirmed latest revision', value => {
        const latest = { ...value.revisions[0], id: randomUUID() }
        delete latest.confirmedAt
        value.revisions.push(latest)
        value.events.push({ id: randomUUID(), at: value.updatedAt, text: `prd:${latest.id}` })
      }],
      ['no successful analysis', value => { value.jobs = [] }],
      ['changed inputs', value => { value.events.push({ id: randomUUID(), at: value.updatedAt, text: 'inputs:changed' }) }],
      ['reanalyzed but stale PRD', value => {
        value.events.push({ id: randomUUID(), at: value.updatedAt, text: 'inputs:changed' }, { id: randomUUID(), at: value.updatedAt, text: `analysis:${value.jobs[0].id}` })
      }],
      ['missing current PRD marker', value => { value.events = value.events.filter(event => !event.text.startsWith('prd:')) }],
      ['unresolved question', value => { value.questions = [question('Q-1')] }],
      ['running status', value => { value.status = 'running' }],
      ['running job', value => { value.jobs.push({ id: randomUUID(), stage: 'design', status: 'running', startedAt: value.updatedAt }) }],
      ['revision limit', value => { value.revisions = [...Array.from({ length: 49 }, () => ({ ...value.revisions[0], id: randomUUID() })), value.revisions[0]] }],
      ['event limit', value => { value.events.push(...Array.from({ length: 10000 - value.events.length }, () => ({ id: randomUUID(), at: value.updatedAt, text: 'progress' }))) }],
    ]
    for (const [label, change] of gates) {
      const blocked = structuredClone(project)
      blocked.id = randomUUID()
      blocked.version = 1
      change(blocked)
      await context.repository.create(blocked)
      await assert.rejects(context.service.editDesign(7, blocked.id, { expectedVersion: blocked.version, screens: [screen] }), { statusCode: 409 }, label)
      assert.deepEqual(await context.service.detail(7, blocked.id), blocked, label)
    }
    await assert.rejects(context.service.editDesign(8, project.id, { expectedVersion: project.version, screens: [screen] }), { statusCode: 404 })
    await assert.rejects(context.service.editDesign(7, project.id, { expectedVersion: project.version - 1, screens: [screen] }), { statusCode: 409 })
    await context.service.close()
    await assert.rejects(context.service.editDesign(7, project.id, { expectedVersion: project.version, screens: [screen] }), { statusCode: 409 })
    assert.deepEqual(await context.service.detail(7, project.id), project)
  } finally { await context.close() }
})

test('manual design save validates strict safe inputs, accepts 40 screens and permits only one competing CAS', async () => {
  const screen = { id: 'SCREEN-1', title: 'Editor', state: 'normal', requirementIds: ['REQ-1'], acceptanceIds: ['AC-1'], html: '<!doctype html><html><body><main data-requirement-id="REQ-1">Saved text</main></body></html>' }
  const context = await fixture({ generate: async stage => stage === 'analyze' ? { evidence: [], questions: [] } : { prd } })
  try {
    let project = await context.service.create(7, { title: 'Editor', description: 'Save text', modelId: 'auto' }, 'fake')
    for (const stage of ['analyze', 'prd'] as const) {
      await context.service.launch(7, project.id, { expectedVersion: project.version, stage }, 'fake')
      await context.service.wait(project.id)
      project = await context.service.detail(7, project.id)
    }
    project = await context.service.confirm(7, project.id, { expectedVersion: project.version, target: 'prd' })
    const body = { expectedVersion: project.version, screens: [screen] }
    const invalid = [null, [], {}, { screens: [screen] }, ...[null, '1', 0, -1, 1.5, Number.MAX_SAFE_INTEGER].map(expectedVersion => ({ ...body, expectedVersion })), ...['version', 'ownerId', 'prd', 'confirmedAt', 'screenshots', 'validation', 'designConfirmedAt'].map(field => ({ ...body, [field]: 'SECRET_RAW_INPUT' }))]
    for (const value of invalid) await assert.rejects(context.service.editDesign(7, project.id, value), { statusCode: 400 })
    for (const screens of [undefined, null, {}, [], [screen, screen], [{ ...screen, requirementIds: ['REQ-MISSING'] }], [{ ...screen, acceptanceIds: ['AC-MISSING'] }], [{ ...screen, html: 'SECRET_RAW_INPUT' }], [{ ...screen, html: screen.html.replace('Saved text', '<img src="https://SECRET_RAW_INPUT">') }], [{ ...screen, screenshots: [] }], Array.from({ length: 41 }, (_value, index) => ({ ...screen, id: `SCREEN-${index}` }))]) {
      await assert.rejects(context.service.editDesign(7, project.id, { ...body, screens }), { statusCode: 400, message: 'Invalid structured design screens' })
      assert.deepEqual(await context.service.detail(7, project.id), project)
    }
    const screens = Array.from({ length: 40 }, (_value, index) => ({ ...screen, id: `SCREEN-${index}` }))
    const original = structuredClone(screens)
    const results = await Promise.allSettled([context.service.editDesign(7, project.id, { ...body, screens }), context.service.editDesign(7, project.id, { ...body, screens })])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult
    assert.equal(rejected.reason.statusCode, 409)
    const saved = await context.service.detail(7, project.id)
    assert.equal(saved.version, project.version + 1)
    assert.equal(saved.revisions.length, project.revisions.length + 1)
    assert.equal(saved.revisions.at(-1)!.screens.length, 40)
    assert.equal(new Set(saved.revisions.at(-1)!.screens.map(item => item.id)).size, 40)
    for (const item of saved.revisions.at(-1)!.screens) assert.match(item.id, /^[a-f0-9-]{36}$/)
    assert.deepEqual(screens, original)
  } finally { await context.close() }
})

test('strict request limits, model validation injection, competing CAS and shutdown discard late work', async () => {
  let calls = 0
  const context = await fixture({ generate: async () => new Promise(() => {}) }, { availableModels: async () => { calls++; return [] } })
  try {
    await assert.rejects(context.service.create(7, { title: 'Editor', description: 'Text', modelId: 'not-in-catalog' }, 'fake'), { statusCode: 400 })
    assert.equal(calls, 1)
    for (const patch of [{ title: 'a'.repeat(201) }, { description: 'x'.repeat(100001) }, { ownerId: 8 }]) await assert.rejects(context.service.create(7, { title: 'Editor', description: 'Text', modelId: 'auto', ...patch }, 'fake'), { statusCode: 400 })
    let project = await context.service.create(7, { title: 'Editor', description: 'Save text', modelId: 'auto' }, 'fake')
    await assert.rejects(context.service.addSources(7, project.id, { expectedVersion: 1 }, [{ name: 'invalid.exe', buffer: Buffer.from('bad') }]), { statusCode: 400 })
    const results = await Promise.allSettled([context.service.addSources(7, project.id, { expectedVersion: 1, url: 'https://example.com/a' }), context.service.addSources(7, project.id, { expectedVersion: 1, url: 'https://example.com/b' })])
    assert.equal(results.filter(item => item.status === 'fulfilled').length, 1)
    project = await context.service.detail(7, project.id)
    await context.service.launch(7, project.id, { expectedVersion: project.version, stage: 'analyze' }, 'fake')
    await context.service.close()
    project = await context.service.detail(7, project.id)
    assert.equal(project.status, 'cancelled')
    assert.equal(project.jobs.at(-1)?.status, 'cancelled')
    await assert.rejects(context.service.launch(7, project.id, { expectedVersion: project.version, stage: 'analyze' }, 'fake'), { statusCode: 409 })
  } finally { await context.close() }
})

test('invalid model evidence is rejected without replacing saved evidence or retaining raw failure data', async () => {
  const context = await fixture({ generate: async () => ({ evidence: [], questions: [] }) })
  try {
    let project = await context.service.create(7, { title: 'Editor', description: 'Save text', modelId: 'auto' }, 'fake')
    project = await context.service.addSources(7, project.id, { expectedVersion: project.version, url: 'https://example.com/spec' })
    await context.service.launch(7, project.id, { expectedVersion: project.version, stage: 'analyze' }, 'fake')
    await context.service.wait(project.id)
    project = await context.service.detail(7, project.id)
    assert.equal(project.status, 'failed')
    assert.equal(project.jobs.at(-1)?.status, 'failed')
    assert.deepEqual(project.evidence, [])
    await assert.rejects(context.service.launch(7, project.id, { expectedVersion: project.version, stage: 'prd' }, 'fake'), { statusCode: 409 })
  } finally { await context.close() }
})

test('PRD login checkpoint completes before captured baseline and PRD are saved together', async () => {
  let opened = 0
  let pages: NonNullable<RequirementProject['revisions'][number]['existingPages']> = []
  const context = await fixture({ generate: async (stage, project, options) => {
    if (stage === 'analyze') return { evidence: project.sources.map(source => ({ sourceId: source.id, summary: 'Code', limitations: '' })), questions: [] }
    await options.onLoginRequired!({ origin: project.preview!.origin, expiresAt: new Date(Date.now() + 30000).toISOString(), open: async () => { opened++ } })
    return { prd, existingPages: pages }
  } })
  try {
    let project = await context.service.create(7, { title: 'Capture first', description: 'Orders', modelId: 'auto' }, 'fake')
    project = await context.service.addCodeSnapshot(7, project.id, { expectedVersion: project.version, files: [{ path: 'src/main.ts', content: 'export const route = "/orders"' }] })
    project = await context.service.configurePreview(7, project.id, { expectedVersion: project.version, origin: 'https://tmp.test.sunmi.com' }, 'fake')
    const image = await storeSourceFile(context.root, 7, project.id, 'baseline.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0AAAAABJRU5ErkJggg==', 'base64'))
    pages = [{ blockId: prd.blocks[0].id, path: '/orders', image, capturedAt: new Date().toISOString(), fingerprint: 'a'.repeat(64), structure: JSON.stringify({ fields: ['Name'] }) }]
    await context.service.launch(7, project.id, { expectedVersion: project.version, stage: 'analyze' }, 'fake')
    await context.service.wait(project.id)
    project = await context.service.detail(7, project.id)
    await context.service.launch(7, project.id, { expectedVersion: project.version, stage: 'prd' }, 'fake')
    for (let attempt = 0; attempt < 200 && !project.jobs.at(-1)?.interaction; attempt++) project = await context.service.detail(7, project.id)
    assert.equal(project.revisions.length, 0)
    const job = project.jobs.at(-1)!
    assert.equal(job.stage, 'prd')
    assert.equal(job.interaction?.phase, 'ready')
    project = await context.service.login(7, project.id, job.id, { expectedVersion: project.version, action: 'open' })
    await context.service.login(7, project.id, job.id, { expectedVersion: project.version, action: 'continue' })
    await context.service.wait(project.id)
    project = await context.service.detail(7, project.id)
    assert.equal(opened, 1)
    assert.equal(project.jobs.at(-1)?.status, 'succeeded')
    assert.deepEqual(project.revisions.at(-1)?.existingPages, pages)
    assert.equal(project.status, 'prd_review')
    assert.equal(project.revisions.at(-1)?.confirmedAt, undefined)
  } finally { await context.close() }
})

test('full design generation auto-validates shared prototypes with one visual retry, unlocks desktop design confirmation and distills sourceAnchors', { timeout: 90_000 }, async () => {
  let designAttempts = 0
  let sawAnchors = false
  const context = await fixture({ generate: async (stage, project, options) => {
    if (stage === 'analyze') {
      return {
        evidence: project.sources.map(source => ({ sourceId: source.id, summary: 'Traced layout and page', limitations: '' })),
        sourceAnchors: [{ domain: '编辑器', sourceId: project.sources[0].id, route: '/editor', layout: 'src/layouts/AppLayout.tsx', pageFile: 'src/pages/Editor.tsx', position: 'viewport', summary: 'Sidebar 200px + editor main' }],
        questions: [],
      }
    }
    if (stage === 'prd') {
      sawAnchors = project.sourceAnchors?.[0]?.pageFile === 'src/pages/Editor.tsx'
      return { prd }
    }
    designAttempts++
    if (designAttempts === 1) {
      assert.equal(options.designValidationFeedback, undefined)
      return { prototypes: [{ id: 'PAGE-EDITOR', title: '编辑器页', mode: 'incremental', sourceAnchor: { route: '/editor', layout: 'src/layouts/AppLayout.tsx', pageFile: 'src/pages/Editor.tsx' }, html: '<!doctype html><html><body style="margin:0"><main data-requirement-id="REQ-1" data-acceptance-id="AC-1" style="width:2400px;height:300px;background:#1d5c3f;color:#fff">Overflow first try</main></body></html>', states: [{ id: 'S-1', name: '默认态', proves: '展示默认编辑界面', requirementIds: ['REQ-1'], acceptanceIds: ['AC-1'], changes: [] }] }] }
    }
    assert.match(options.designValidationFeedback?.reason ?? '', /水平布局溢出/)
    return { prototypes: [{
      id: 'PAGE-EDITOR', title: '编辑器页', mode: 'incremental', sourceAnchor: { route: '/editor', layout: 'src/layouts/AppLayout.tsx', pageFile: 'src/pages/Editor.tsx' },
      html: '<!doctype html><html><body style="margin:0"><main data-requirement-id="REQ-1" data-acceptance-id="AC-1" style="width:1200px;height:360px;background:#1d5c3f;color:#fff;padding:24px"><label>不打回说明<textarea data-prototype-node="reason"></textarea></label><button type="button">结束任务</button></main></body></html>',
      states: [
        { id: 'S-1', name: '默认态', proves: '展示默认编辑界面', requirementIds: ['REQ-1'], acceptanceIds: ['AC-1'], changes: [] },
        { id: 'S-2', name: '已填写说明', requirementIds: ['REQ-1'], acceptanceIds: ['AC-1'], changes: [{ node: 'reason', value: '已记录失败原因' }] },
      ],
    }] }
  } })
  try {
    let project = await context.service.create(7, { title: 'Auto validate design', description: 'Save text', modelId: 'auto' }, 'fake')
    project = await context.service.addCodeSnapshot(7, project.id, { expectedVersion: project.version, files: [{ path: 'src/pages/Editor.tsx', content: 'export const Editor = () => null\n' }] })
    for (const stage of ['analyze', 'prd'] as const) {
      await context.service.launch(7, project.id, { expectedVersion: project.version, stage }, 'fake')
      await context.service.wait(project.id)
      project = await context.service.detail(7, project.id)
    }
    assert.equal(sawAnchors, true)
    assert.equal(project.sourceAnchors?.length, 1)
    project = await context.service.confirm(7, project.id, { expectedVersion: project.version, target: 'prd' })
    await context.service.launch(7, project.id, { expectedVersion: project.version, stage: 'design' }, 'fake')
    await context.service.wait(project.id)
    project = await context.service.detail(7, project.id)
    assert.equal(project.jobs.at(-1)?.status, 'succeeded')
    const generated = project.revisions.at(-1)!
    assert.equal(generated.screenshots?.length, 2)
    assert.deepEqual(generated.validation?.errors, [])
    assert.equal(generated.validation?.allScreensValidated, true)
    await context.service.launch(7, project.id, { expectedVersion: project.version, stage: 'validate' }, 'fake')
    await context.service.wait(project.id)
    project = await context.service.detail(7, project.id)
    const rechecked = project.revisions.at(-1)!
    assert.equal(project.jobs.at(-1)?.status, 'succeeded')
    assert.equal(designAttempts, 2)
    assert.notEqual(rechecked.id, generated.id)
    assert.deepEqual(rechecked.screens, generated.screens)
    assert.deepEqual(rechecked.screenshots?.map(shot => shot.screenId), generated.screens.map(screen => screen.id))
    assert.equal(rechecked.validation?.interactionVerified, false)
    project = await context.service.confirm(7, project.id, { expectedVersion: project.version, target: 'design' })
    assert.equal(project.status, 'completed')
    const confirmed = project.revisions.at(-1)!
    assert.ok(confirmed.designConfirmedAt)
    const exported = await exportRequirementRevision(project, confirmed, 'md', context.root)
    assert.match(exported.buffer.toString(), /Complete delivery \(static visual validation only; interactions not verified\)/)
  } finally { await context.close() }
})