import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { RequirementModel, RequirementProject, StructuredPrd } from '../../shared/requirements.js'
import { JsonRequirementRepository } from './repository.js'
import { RequirementService, type RequirementServiceOptions } from './service.js'
import { requirementDiagnostic } from './diagnostics.js'
import { readSourceFile, storeSourceFile } from './sources.js'
import { RemoteCodeError } from './remote-code.js'

const question = (id: string) => ({ id, priority: 'P0' as const, text: 'Choose scope', impact: 'Scope', choices: ['A', 'B'], recommendation: 'A' })

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
    for (const value of [null, [], {}, { expectedVersion: 1, files, extra: true }, { expectedVersion: '1', files }, { expectedVersion: 1, files: [{ ...files[0], content: 'password = "PRIVATE_SENTINEL"' }] }]) await assert.rejects(context.service.addCodeSnapshot(7, project.id, value), { statusCode: 400 })
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