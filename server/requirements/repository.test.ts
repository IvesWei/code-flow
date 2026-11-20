import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { PoolOptions } from 'mysql2/promise'
import type { RequirementProject } from '../../shared/requirements.js'
import { acquireTestingRuntimeLease } from '../testing/runtime.js'
import {
  createRequirementRepository, JsonRequirementRepository, MysqlRequirementRepository,
  REQUIREMENT_BODY_LIMIT, RequirementConflictError, RequirementContractError, RequirementStorageUnavailableError,
  type RequirementSqlPool,
} from './repository.js'
import { initializeRequirementsStorage, type RequirementsStorageDependencies } from './runtime.js'
import { validationInputFingerprint, validationInputMatches } from './artifacts.js'
import { validatePrototypeDesign } from './prototype-design.js'
import { validatePrd } from './validation.js'
import { captureFingerprint, scopeFingerprint, validateCapturePlan } from './capture-plan.js'
import { dualPrdFixture } from '../tests/fixtures/dual-prd.js'

function project(overrides: Partial<RequirementProject> = {}): RequirementProject {
  return {
    schemaVersion: 1, id: randomUUID(), ownerId: 7, version: 1, title: 'Requirement', description: '', modelId: 'test',
    createdAt: '2026-10-29T00:00:00.000Z', updatedAt: '2026-10-29T00:00:00.000Z', status: 'draft',
    sources: [], evidence: [], questions: [], decisions: [], revisions: [], jobs: [], events: [], ...overrides,
  }
}
async function temporary(action: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'requirements-'))
  try { await action(root) } finally { await rm(root, { recursive: true, force: true }) }
}
class MockSql implements RequirementSqlPool {
  readonly records = new Map<string, RequirementProject>()
  readonly calls: { sql: string; values: unknown[] }[] = []
  failure?: Error
  async query(options: { sql: string; timeout: number }, values: unknown[] = []): Promise<unknown[]> {
    const sql = options.sql
    this.calls.push({ sql, values })
    assert.equal(options.timeout, 15000)
    if (this.failure) throw this.failure
    if (sql.includes('LIMIT 0')) return [[], []]
    if (sql.startsWith('INSERT')) {
      const value = JSON.parse(String(values[6])) as RequirementProject
      if (this.records.has(value.id)) throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' })
      this.records.set(value.id, value)
      return [{ affectedRows: 1 }, []]
    }
    if (sql.startsWith('UPDATE')) {
      assert.match(sql, /WHERE id = \? AND owner_id = \? AND version = \? AND created_at = \? AND updated_at <= \?$/)
      assert.doesNotMatch(sql.split(' WHERE ')[0], /owner_id|created_at/)
      const old = this.records.get(String(values[4]))
      if (!old || old.ownerId !== values[5] || old.version !== values[6] || old.createdAt !== values[7] || old.updatedAt > String(values[8])) return [{ affectedRows: 0 }, []]
      this.records.set(old.id, JSON.parse(String(values[3])) as RequirementProject)
      return [{ affectedRows: 1 }, []]
    }
    let result = [...this.records.values()]
    if (sql.includes('WHERE id >')) result = result.filter(item => item.id > String(values[0]) && (item.status === 'running' || item.jobs.some(job => job.status === 'running'))).sort((left, right) => left.id.localeCompare(right.id)).slice(0, 100)
    else if (sql.includes('WHERE id =')) result = result.filter(item => item.id === values[0] && item.ownerId === values[1])
    else {
      assert.match(sql, /WHERE owner_id = \? ORDER BY created_at DESC, id DESC LIMIT 100$/)
      result = result.filter(item => item.ownerId === values[0]).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)).slice(0, 100)
    }
    return [result.map(item => ({ id: item.id, owner_id: String(item.ownerId), version: String(item.version), status: item.status, created_at: item.createdAt, updated_at: item.updatedAt, body: JSON.stringify(item, (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.length - right.length || left.localeCompare(right))) : value) })), []]
  }
}

for (const backend of ['json', 'mysql'] as const) {
  test(`${backend}: classified checkpoint, capture question identity and concrete entry context survive reload`, async () => temporary(async root => {
    const repository = await createRequirementRepository(backend, root, new MockSql())
    const prd = { title: 'Plans', summary: 'Plan scope', blocks: [{ id: 'B1', title: 'Plan', content: 'Change model selection', requirementIds: ['R1'], sourceIds: [] }], requirements: [{ id: 'R1', title: 'Model', description: 'Select model', sourceIds: [], acceptance: [{ id: 'A1', text: 'Model displayed' }] }] }
    const value = project({ sources: [{ id: 'S1', name: 'code.md', kind: 'file', sha256: 'a'.repeat(64), sizeBytes: 123 }], preview: { origin: 'https://tmp.test.sunmi.com', generation: 1, entryPaths: ['/plans?projectId=42&projectKey=P-1'] } })
    const fingerprint = scopeFingerprint(value)
    value.scopeCheckpoint = {
      version: 1, fingerprint, prd, blocks: [{ blockId: 'B1', kind: 'existing', reason: 'Existing plan' }],
      mapping: [{ blockId: 'B1', kind: 'existing', path: '/plans?projectId=42&projectKey=P-1', sourceId: 'S1', quote: 'const route = "/plans";', activate: [{ kind: 'dialog', name: 'Edit plan' }], expectedFields: ['Model', 'Owner', 'Model'] }],
    }
    value.questions = [{ id: 'capture-entry', text: 'Provide context', priority: 'P0', impact: 'Capture only', choices: ['URL', 'Source'], recommendation: 'URL', capture: { fingerprint, blockIds: ['B1'] } }]
    value.scopeCheckpoint.mapping![0].discover = [{
      fromPath: value.preview!.entryPaths![0], path: '/plans/detail', column: 'Plan name', sourceId: 'S1',
      quote: 'const goPlan = id => history.push("/plans/detail?projectId=" + projectId + "&projectKey=" + projectKey + "&planId=" + id);',
      columnQuote: 'title: "Plan name", render: row => <a onClick={() => goPlan(row.id)}>{row.name}</a>',
      handler: 'goPlan', queryKeys: ['projectId', 'projectKey', 'planId'],
    }]
    const captureHash = captureFingerprint(value, prd, value.scopeCheckpoint.blocks)
    const pages = ['B1-view-1', 'B1-view-2'].map((viewId, index) => ({
      blockId: 'B1', viewId, path: `/plans/detail?projectId=42&projectKey=P-1&planId=${index + 1}`,
      capturedAt: value.createdAt, fingerprint: captureHash, structure: '{}',
      image: { id: `IMAGE-${index}`, name: `plan-${index}.png`, kind: 'file' as const, sizeBytes: 123, sha256: 'b'.repeat(64), storageKey: `requirements/images/${index}.png` },
    }))
    value.revisions = [{ id: 'REV-1', createdAt: value.createdAt, prd, screens: [], existingPages: pages, capturePlan: { version: 1, fingerprint: captureHash, blocks: value.scopeCheckpoint.blocks, views: pages.map(page => ({ blockId: page.blockId, viewId: page.viewId })) } }]
    await repository.create(value)
    const restored = (await repository.get(value.id, 7))!
    assert.deepEqual(restored.scopeCheckpoint, value.scopeCheckpoint)
    assert.deepEqual(restored.questions, value.questions)
    assert.deepEqual(restored.preview, value.preview)
    assert.deepEqual(restored.revisions, value.revisions)
    assert.equal(scopeFingerprint(restored), fingerprint)
    const legacy = structuredClone(value); legacy.id = randomUUID(); delete legacy.scopeCheckpoint!.mapping
    await repository.create(legacy)
    assert.deepEqual((await repository.get(legacy.id, 7))!.scopeCheckpoint, legacy.scopeCheckpoint)
    for (const mutate of [
      (copy: RequirementProject) => { copy.preview!.entryPaths = ['/plans?apiKey=secret'] },
      (copy: RequirementProject) => { copy.scopeCheckpoint!.blocks[0].blockId = 'unknown' },
      (copy: RequirementProject) => { copy.questions[0].capture!.fingerprint = 'bad' },
      (copy: RequirementProject) => { copy.scopeCheckpoint!.mapping![0].sourceId = 'unknown' },
      (copy: RequirementProject) => { copy.scopeCheckpoint!.mapping![0].blockId = 'unknown' },
      (copy: RequirementProject) => { copy.scopeCheckpoint!.mapping![0].path = '/plans?token=secret' },
      (copy: RequirementProject) => { copy.scopeCheckpoint!.mapping![0].openDialog = 'Edit plan' },
      (copy: RequirementProject) => { copy.scopeCheckpoint!.mapping![0].activate![0].name = '' },
      (copy: RequirementProject) => { delete copy.scopeCheckpoint!.mapping![0].expectedFields },
      (copy: RequirementProject) => { copy.scopeCheckpoint!.mapping!.push(copy.scopeCheckpoint!.mapping![0]) },
      (copy: RequirementProject) => { copy.scopeCheckpoint!.mapping![0].discover![0].sourceId = 'unknown' },
      (copy: RequirementProject) => { copy.scopeCheckpoint!.mapping![0].discover![0].queryKeys = ['token'] },
      (copy: RequirementProject) => { copy.revisions[0].existingPages!.pop() },
      (copy: RequirementProject) => { delete copy.revisions[0].capturePlan!.views },
      (copy: RequirementProject) => { copy.revisions[0].existingPages![0].viewId = 'invalid:identity' },
    ]) {
      const invalid = structuredClone(value); invalid.id = randomUUID(); mutate(invalid)
      await assert.rejects(repository.create(invalid), RequirementContractError)
    }
  }))
  test(`${backend}: dual-template metadata round-trips with stable fingerprint and legacy revisions unchanged`, async () => temporary(async root => {
    const repository = await createRequirementRepository(backend, root, new MockSql())
    const legacy = { title: '订单需求', summary: '范围', blocks: [{ id: 'B1', title: '订单', content: '页面', requirementIds: ['R1'], sourceIds: [] }], requirements: [{ id: 'R1', title: '查询', description: '显示订单', sourceIds: [], acceptance: [{ id: 'A1', text: '返回订单' }] }] }
    const value = project({ revisions: [legacy, dualPrdFixture(legacy)].map(prd => ({ id: randomUUID(), createdAt: '2026-10-29T00:00:00.000Z', prd, screens: [] })) })
    const fingerprint = captureFingerprint(value, value.revisions[1].prd)
    await repository.create(value)
    const restored = (await repository.get(value.id, 7))!
    assert.deepEqual(restored.revisions, value.revisions)
    assert.equal(captureFingerprint(restored, restored.revisions[1].prd), fingerprint)
    assert.equal(Object.hasOwn(restored.revisions[0].prd, 'templateVersion'), false)
    value.id = randomUUID()
    value.revisions[1].prd.requirements[0].specification!.criteria[0].then = 'Changed outside acceptance mapping'
    await assert.rejects(repository.create(value), RequirementContractError)
  }))
  test(`${backend}: prototype conversation bindings survive reload and reject duplicate or unsafe metadata`, async () => temporary(async root => {
    const repository = await createRequirementRepository(backend, root, new MockSql())
    const binding = { prototypeId: 'PAGE-1', conversationId: randomUUID(), sdkSessionId: randomUUID(), modelId: 'auto', contextFingerprint: 'a'.repeat(64), prototypeFingerprint: 'b'.repeat(64), skillFingerprint: 'c'.repeat(64) }
    const value = project({ prototypeConversations: [binding] })
    await repository.create(value)
    assert.deepEqual((await repository.get(value.id, 7))!.prototypeConversations, [binding])
    for (const bindings of [[binding, binding], [{ ...binding, prototypeId: '../escape' }], [{ ...binding, sdkSessionId: 'invalid' }], [{ ...binding, contextFingerprint: 'bad' }], [{ ...binding, password: 'never persist' }]]) {
      await assert.rejects(repository.create(project({ prototypeConversations: bindings })), RequirementContractError)
    }
  }))
  test(`${backend}: element-capture prototypes, sourceFallback plans and validation fingerprints survive MySQL key reordering`, async () => temporary(async root => {
    const repository = await createRequirementRepository(backend, root, new MockSql())
    const prd = validatePrd(dualPrdFixture({ title: '提测详情', summary: '范围', blocks: [{ id: 'B-1', title: '测试失败弹窗', content: '弹窗', requirementIds: ['R1'], sourceIds: [] }], requirements: [{ id: 'R1', title: '不打回结束任务', description: '选择不打回并提交', fields: [{ name: '失败原因', description: '既有原因' }], sourceIds: [], acceptance: [{ id: 'A1', text: '任务以失败终态结束' }] }] }), [])
    const stateId = randomUUID()
    const design = validatePrototypeDesign([{
      id: 'PAGE-1', title: '提测详情页', mode: 'incremental',
      sourceAnchor: { route: '/requestTask', layout: 'src/layouts/ConfigLayout.tsx', pageFile: 'src/pages/RequirementTaskDetail/index.tsx' },
      html: '<!doctype html><html><body><div id="submit-modal-card" data-requirement-id="R1" data-acceptance-id="A1">失败原因</div></body></html>',
      states: [{ id: stateId, name: '失败弹窗-不打回态', proves: '弹窗特写', capture: { mode: 'element', selector: '#submit-modal-card', padding: 24 }, requirementIds: ['R1'], acceptanceIds: ['A1'], changes: [] }],
    }], prd)
    const blocks = [{ blockId: 'B-1', kind: 'existing' as const, reason: '现有测试失败弹窗增量改造' }]
    const value = project({ status: 'design_review' })
    const revision = {
      id: randomUUID(), createdAt: '2026-10-29T00:00:00.000Z', confirmedAt: '2026-10-29T00:00:00.000Z', prd,
      screens: design.screens, prototypes: design.prototypes,
      capturePlan: { version: 1 as const, fingerprint: captureFingerprint(value, prd, blocks), blocks, sourceFallback: { code: 'PAGE_CAPTURE_TARGET', blocks: [{ blockId: 'B-1', fields: ['失败原因'], content: [] }] } },
      validation: { at: '2026-10-29T00:00:00.000Z', errors: [] as string[] },
    }
    value.revisions = [revision]
    const legacyDigest = createHash('sha256').update(JSON.stringify({ projectId: value.id, revisionId: revision.id, prd: revision.prd, screens: revision.screens, prototypes: revision.prototypes, sources: value.sources, decisions: value.decisions })).digest('hex')
    const canonicalDigest = validationInputFingerprint(value, revision)
    await repository.create(value)
    let restored = (await repository.get(value.id, 7))!
    assert.equal((await repository.list(7)).length, 1)
    assert.deepEqual(restored.revisions[0].screens[0].capture, { mode: 'element', selector: '#submit-modal-card', padding: 24 })
    assert.equal(validationInputMatches(canonicalDigest, restored, restored.revisions[0]), true)
    assert.equal(validationInputMatches(legacyDigest, restored, restored.revisions[0]), true)
    restored.jobs.push({ id: randomUUID(), stage: 'reconstruct', revisionId: revision.id, startedAt: revision.createdAt, status: 'running' })
    restored.version++
    await repository.replace(restored, restored.version - 1)
    await repository.recover()
    restored = (await repository.get(value.id, 7))!
    assert.equal(restored.jobs.at(-1)?.status, 'interrupted')
    assert.equal(restored.status, 'design_review')
    assert.deepEqual(restored.revisions, [revision])
    const id = randomUUID()
    const image = { kind: 'file' as const, id, name: 'source-reconstruction-1.png', storageKey: `requirements/sources/7/${value.id}/${id}.png`, sizeBytes: 120, sha256: 'a'.repeat(64) }
    const fallback = restored.revisions[0].capturePlan!.sourceFallback!
    const entry = { blockId: 'B-1', createdAt: revision.createdAt, image }
    fallback.images = [entry]
    restored.version++
    await repository.replace(restored, restored.version - 1)
    const saved = (await repository.get(value.id, 7))!
    assert.deepEqual(saved.revisions[0].capturePlan?.sourceFallback?.images, [entry])
    assert.equal(validationInputMatches(canonicalDigest, saved, saved.revisions[0]), true)
    for (const invalid of [[], [entry, entry], [{ ...entry, blockId: 'absent' }], [{ ...entry, createdAt: 'bad' }], [{ ...entry, image: { ...image, storageKey: `requirements/sources/8/${value.id}/${id}.png` } }], [{ ...entry, image: { ...image, name: 'target.png' } }]]) {
      const bad = structuredClone(saved)
      bad.revisions[0].capturePlan!.sourceFallback!.images = invalid
      bad.version++
      await assert.rejects(repository.replace(bad, saved.version), RequirementContractError)
    }
    restored.revisions[0].screens[0].title = '篡改后的标题'
    assert.equal(validationInputMatches(canonicalDigest, restored, restored.revisions[0]), false)
    assert.equal(validationInputMatches(legacyDigest, restored, restored.revisions[0]), false)
  }))
  test(`${backend}: classified zero-capture plans round-trip and reject missing, duplicate or unproven coverage`, async () => temporary(async root => {
    const repository = await createRequirementRepository(backend, root, new MockSql())
    const prd = { title: 'Reports', summary: 'New', blocks: [{ id: 'B1', title: 'Reports', content: 'New report', requirementIds: ['R1'], sourceIds: [] }], requirements: [{ id: 'R1', title: 'Report', description: 'New report', sourceIds: [], acceptance: [{ id: 'A1', text: 'Visible' }] }] }
    const plan = { version: 1 as const, fingerprint: 'a'.repeat(64), blocks: [{ blockId: 'B1', kind: 'new' as const, reason: 'User confirmed an independent new report' }] }
    const value = project({ revisions: [{ id: randomUUID(), createdAt: '2026-10-29T00:00:00.000Z', prd, screens: [], existingPages: [], capturePlan: plan }] })
    plan.fingerprint = captureFingerprint(value, prd, plan.blocks)
    await repository.create(value)
    const restored = (await repository.get(value.id, 7))!
    const revision = restored.revisions[0]
    assert.deepEqual(revision.capturePlan, plan)
    const validated = validateCapturePlan(revision.capturePlan, revision.prd, revision.existingPages)
    assert.equal(captureFingerprint(restored, revision.prd, validated.blocks), plan.fingerprint)
    const invalids = [
      { ...plan, blocks: [] },
      { ...plan, blocks: [...plan.blocks, ...plan.blocks] },
      { ...plan, blocks: [{ ...plan.blocks[0], kind: 'existing' }] },
      { ...plan, blocks: [{ ...plan.blocks[0], kind: 'unresolved' }] },
      { ...plan, blocks: [{ ...plan.blocks[0], reason: '' }] },
      { ...plan, fingerprint: 'invalid' },
    ]
    for (const invalid of invalids) {
      const bad = structuredClone(value)
      Object.assign(bad.revisions[0], { capturePlan: invalid })
      await assert.rejects(repository.create({ ...bad, id: randomUUID() }), RequirementContractError)
    }
  }))
  test(`${backend}: shared source round-trips and rejects independent derived-screen changes`, async () => temporary(async root => {
    const repository = await createRequirementRepository(backend, root, new MockSql())
    const prd = { title: 'Plan', summary: 'Create', blocks: [{ id: 'B1', title: 'Plan', content: 'Create', requirementIds: ['R1'], sourceIds: [] }], requirements: [{ id: 'R1', title: 'Create', description: 'Create plan', sourceIds: [], acceptance: [{ id: 'A1', text: 'Created' }] }] }
    const source = { id: 'PAGE', title: 'Plan', html: '<!doctype html><html><body><main data-requirement-id="R1" data-acceptance-id="A1">Plan</main></body></html>', states: [{ id: 'STATE', name: 'Normal', requirementIds: ['R1'], acceptanceIds: ['A1'], changes: [] }] }
    const value = project({ revisions: [{ id: randomUUID(), createdAt: '2026-10-29T00:00:00.000Z', prd, ...validatePrototypeDesign([source], prd) }] })
    await repository.create(value)
    assert.deepEqual((await repository.get(value.id, 7))!.revisions, value.revisions)
    const drifted = structuredClone(value)
    drifted.version++
    drifted.revisions[0].screens[0].html += '<p>Independent layout</p>'
    await assert.rejects(repository.replace(drifted, value.version), RequirementContractError)
    assert.deepEqual((await repository.get(value.id, 7))!.revisions, value.revisions)
  }))
  test(`${backend}: optional browser login is exact, bound to active design/preview and removed on recovery`, async () => temporary(async root => {
    const repository = await createRequirementRepository(backend, root, new MockSql())
    const value = project({ status: 'running', preview: { origin: 'https://tmp.test.sunmi.com', generation: 1 }, jobs: [{ id: 'login', stage: 'design', status: 'running', startedAt: '2026-10-29T00:00:00.000Z', interaction: { kind: 'browser_login', phase: 'ready', origin: 'https://tmp.test.sunmi.com', expiresAt: '2026-10-29T00:05:00.000Z' } }] })
    await repository.create(value)
    for (const patch of [{ phase: 'bad' }, { origin: 'https://oa.sunmi.com' }, { expiresAt: '2026-10-29T00:05:00.001Z' }, { cookie: 'secret' }, { expiresAt: 'bad' }]) {
      const invalid = structuredClone(value)
      Object.assign(invalid.jobs[0].interaction!, patch)
      await assert.rejects(repository.create({ ...invalid, id: randomUUID() }), RequirementContractError)
    }
    const prdLogin = structuredClone(value)
    prdLogin.id = randomUUID()
    prdLogin.jobs[0].stage = 'prd'
    await repository.create(prdLogin)
    assert.equal((await repository.get(prdLogin.id, 7))!.jobs[0].interaction?.phase, 'ready')
    for (const patch of [{ status: 'failed' }, { stage: 'analyze' }, { endedAt: value.updatedAt }]) {
      const invalid = structuredClone(value)
      Object.assign(invalid.jobs[0], patch)
      await assert.rejects(repository.create({ ...invalid, id: randomUUID() }), RequirementContractError)
    }
    await repository.recover()
    const saved = (await repository.get(value.id, 7))!
    assert.equal(saved.jobs[0].status, 'interrupted')
    assert.equal(saved.jobs[0].interaction, undefined)
  }))

  test(`${backend}: owner isolation, immutable metadata, CAS and detached snapshots`, async () => temporary(async root => {
    const pool = new MockSql()
    const repository = await createRequirementRepository(backend, root, pool)
    const original = project()
    await repository.create(original)
    original.title = 'not saved'
    assert.equal((await repository.get(original.id, 7))?.title, 'Requirement')
    assert.equal(await repository.get(original.id, 8), undefined)
    assert.deepEqual(await repository.list(8), [])
    await assert.rejects(repository.create(original), RequirementConflictError)
    const saved = (await repository.get(original.id, 7))!
    saved.title = 'detached'
    assert.equal((await repository.get(original.id, 7))?.title, 'Requirement')
    await assert.rejects(repository.replace({ ...saved, ownerId: 8, version: 2 }, 1), RequirementConflictError)
    await assert.rejects(repository.replace({ ...saved, createdAt: '2026-10-28T00:00:00.000Z', version: 2 }, 1))
    await assert.rejects(repository.replace({ ...saved, version: 3 }, 1), RequirementContractError)
    const results = await Promise.allSettled([
      repository.replace({ ...saved, title: 'first', version: 2 }, 1),
      repository.replace({ ...saved, title: 'second', version: 2 }, 1),
    ])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult
    assert.ok(rejected.reason instanceof RequirementConflictError)
    assert.equal(rejected.reason.statusCode, 409)
    assert.equal((await repository.get(original.id, 7))?.version, 2)
  }))

  test(`${backend}: bounded complete lists and recovery of jobs in the same project body`, async () => temporary(async root => {
    const pool = new MockSql(), repository = await createRequirementRepository(backend, root, pool)
    for (let index = 0; index < 102; index++) await repository.create(project({ createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString(), updatedAt: '2026-10-29T00:00:00.000Z' }))
    const active = project({
      status: 'prd_review',
      jobs: [{ id: 'job', stage: 'prd', status: 'running', startedAt: '2026-10-29T00:00:00.000Z' }, { id: 'done', stage: 'analyze', status: 'succeeded', startedAt: '2026-10-29T00:00:00.000Z' }],
      events: [{ id: 'event', at: '2026-10-29T00:00:00.000Z', text: 'preserved' }],
    })
    await repository.create(active)
    await repository.create(project({ ownerId: 8 }))
    const listed = await repository.list(7)
    assert.equal(listed.length, 100)
    assert.deepEqual(listed[0], active)
    await repository.recover()
    const recovered = (await repository.get(active.id, 7))!
    assert.equal(recovered.version, 2)
    assert.equal(recovered.status, 'interrupted')
    assert.equal(recovered.jobs[0].status, 'interrupted')
    assert.ok(recovered.jobs[0].endedAt)
    assert.equal(recovered.jobs[1].status, 'succeeded')
    assert.deepEqual(recovered.events, active.events)
    await repository.recover()
    assert.deepEqual(await repository.get(active.id, 7), recovered)
    assert.equal((await repository.get(listed[1].id, 7))?.version, 1)
  }))

  test(`${backend}: rejects invalid identifiers, owners and unsafe serialization before IO`, async () => temporary(async root => {
    const repository = await createRequirementRepository(backend, root, new MockSql())
    await assert.rejects(repository.get('../escape', 7), RequirementContractError)
    await assert.rejects(repository.list(0), RequirementContractError)
    await assert.rejects(repository.create(project({ version: 2 })), RequirementContractError)
    await assert.rejects(repository.create(project({ description: 'x'.repeat(REQUIREMENT_BODY_LIMIT + 1) })), RequirementContractError)
    const cyclic = project(); (cyclic.events as unknown[]).push(cyclic)
    await assert.rejects(repository.create(cyclic), RequirementContractError)
    await assert.rejects(repository.create(project({ ownerId: Number.MAX_SAFE_INTEGER + 1 })), RequirementContractError)
    await assert.rejects(repository.create(project({ createdAt: 'yesterday' })), RequirementContractError)
    await assert.rejects(repository.create(project({ sources: [null as never] })), RequirementContractError)
  }))
}

test('JSON: repository instances share a root queue and create never overwrites', async () => temporary(async root => {
  const first = new JsonRequirementRepository(root), second = new JsonRequirementRepository(join(root, '.'))
  const value = project()
  const created = await Promise.allSettled([first.create(value), second.create({ ...value, title: 'other' })])
  assert.equal(created.filter(result => result.status === 'fulfilled').length, 1)
  const updated = await Promise.allSettled([first.replace({ ...value, version: 2 }, 1), second.replace({ ...value, version: 2 }, 1)])
  assert.equal(updated.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal((await second.get(value.id, 7))?.version, 2)
  assert.deepEqual(await readdir(join(root, 'requirements', 'projects')), [`${value.id}.json`])
  await writeFile(join(root, 'requirements', 'projects', `${value.id}.json`), '{broken')
  await assert.rejects(first.get(value.id, 7), RequirementStorageUnavailableError)
}))

test('MySQL: read-only schema probe, sanitized failures, no implicit JSON fallback', async () => temporary(async root => {
  const pool = new MockSql()
  await createRequirementRepository('mysql', root, pool)
  assert.equal(pool.calls.length, 2)
  assert.match(pool.calls[0].sql, /^SELECT id, owner_id, version, status, created_at, updated_at, body .*LIMIT 0$/)
  assert.match(pool.calls[1].sql, /^SELECT .* FROM codeflow_requirement_conversation_events LIMIT 0$/)
  assert.equal((await readdir(root)).length, 0)
  pool.failure = new Error('secret connection information')
  const repository = new MysqlRequirementRepository(pool)
  for (const operation of [() => repository.list(7), () => repository.get(randomUUID(), 7), () => repository.create(project()), () => repository.replace(project({ version: 2 }), 1), () => repository.recover()]) {
    await assert.rejects(operation(), error => error instanceof RequirementStorageUnavailableError && error.statusCode === 503 && !error.message.includes('secret'))
  }
  await assert.rejects(createRequirementRepository('mysql', root), RequirementStorageUnavailableError)
}))

test('MySQL: recovery traverses multiple bounded batches and all owners', async () => {
  const pool = new MockSql(), repository = new MysqlRequirementRepository(pool)
  for (let index = 0; index < 205; index++) {
    const active = project({ ownerId: index % 2 + 1, status: 'running' })
    pool.records.set(active.id, active)
  }
  await repository.recover()
  assert.equal(pool.records.size, 205)
  assert.ok([...pool.records.values()].every(item => item.status === 'interrupted' && item.version === 2))
  assert.equal(pool.calls.filter(call => call.sql.includes('WHERE id >')).length, 4)
})

test('MySQL: corrupt bodies or mismatched indexed metadata are storage failures', async () => {
  const value = project()
  for (const body of ['{broken', JSON.stringify({ ...value, ownerId: 8 }), JSON.stringify({ ...value, version: 2 })]) {
    const repository = new MysqlRequirementRepository({ query: async () => [[{
      id: value.id, owner_id: 7, version: 1, status: value.status, created_at: value.createdAt, updated_at: value.updatedAt, body,
    }], []] })
    await assert.rejects(repository.get(value.id, 7), RequirementStorageUnavailableError)
  }
})

function dependencies(pool: MockSql, overrides: Partial<RequirementsStorageDependencies> = {}): RequirementsStorageDependencies {
  return {
    config: () => ({ host: 'mock', port: 3306, user: 'test', password: 'secret', database: 'mock', connectionLimit: 2, connectTimeout: 1000, tls: true, caFile: 'mock-ca' }),
    createPool: () => Object.assign(pool, { end: async () => {} }), readCa: async () => 'CA', createRepository: createRequirementRepository,
    ...overrides,
  }
}

test('runtime: JSON lease is isolated from testing, exclusive, released and recovery is durable', async () => temporary(async root => {
  const testing = await acquireTestingRuntimeLease(root)
  const value = project({ status: 'running' })
  await new JsonRequirementRepository(root).create(value)
  const first = await initializeRequirementsStorage(root, 'json')
  try {
    assert.ok(first.repository)
    assert.equal((await first.repository.get(value.id, 7))?.status, 'interrupted')
    const second = await initializeRequirementsStorage(root, 'json')
    assert.equal(second.repository, undefined)
    assert.match(second.error!, /lease/)
    await second.close()
    await assert.rejects(acquireTestingRuntimeLease(root), /already active/)
  } finally { await first.close(); await first.close(); await testing.release() }
  const reopened = await initializeRequirementsStorage(root, 'json')
  try { assert.equal((await reopened.repository?.get(value.id, 7))?.version, 2) }
  finally { await reopened.close() }
}))

test('runtime: MySQL TLS options, readonly probe, recovery and idempotent close', async () => temporary(async root => {
  const pool = new MockSql(), active = project({ status: 'running' })
  pool.records.set(active.id, active)
  let options: PoolOptions | undefined, ended = 0
  const runtime = await initializeRequirementsStorage(root, 'mysql', dependencies(pool, {
    createPool: input => { options = input; return Object.assign(pool, { end: async () => { ended++ } }) },
  }))
  try {
    assert.ok(runtime.repository)
    assert.deepEqual(options?.ssl, { rejectUnauthorized: true, ca: 'CA' })
    assert.equal(options?.multipleStatements, false)
    assert.equal(options?.timezone, 'Z')
    assert.equal(options?.queueLimit, 100)
    assert.equal(pool.records.get(active.id)?.version, 2)
    assert.ok(pool.calls.every(call => !/CREATE|ALTER|DROP/.test(call.sql)))
  } finally { await Promise.all([runtime.close(), runtime.close()]) }
  assert.equal(ended, 1)
  assert.deepEqual(await readdir(join(root, 'requirements', 'runtime', 'testing')), [])
}))

test('runtime: failed schema verification closes pool and releases lease without connecting or fallback', async () => temporary(async root => {
  const pool = new MockSql(); pool.failure = new Error('private database details')
  let ended = 0
  const runtime = await initializeRequirementsStorage(root, 'mysql', dependencies(pool, {
    createPool: () => Object.assign(pool, { end: async () => { ended++ } }),
  }))
  assert.equal(runtime.repository, undefined)
  assert.match(runtime.error!, /no JSON fallback/)
  assert.doesNotMatch(runtime.error!, /private/)
  assert.equal(ended, 1)
  await runtime.close()
  assert.equal(ended, 1)
  const json = await initializeRequirementsStorage(root, 'json')
  try { assert.ok(json.repository) } finally { await json.close() }
}))

test('runtime: missing MySQL configuration never constructs a pool or falls back to JSON', async () => temporary(async root => {
  let constructed = false
  const runtime = await initializeRequirementsStorage(root, 'mysql', dependencies(new MockSql(), {
    config: () => undefined,
    createPool: () => { constructed = true; throw new Error('must not connect') },
  }))
  assert.equal(constructed, false)
  assert.equal(runtime.repository, undefined)
  assert.match(runtime.error!, /no JSON fallback/)
  await assert.rejects(readdir(join(root, 'requirements', 'projects')), { code: 'ENOENT' })
  await runtime.close()
}))