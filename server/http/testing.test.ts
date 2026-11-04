import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { CasePackage, ExecutionRun, PlanningInput } from '../../shared/testing.js'
import { CasePlanningService, PlanningError, type PlanningModel } from '../testing/planning-service.js'
import { ExecutionError } from '../testing/execution-service.js'
import { MemoryTestingRepository, TestingStorageUnavailableError } from '../testing/repository.js'
import { registerTestingRoutes, type TestingRouteOptions } from './testing.js'

const input: PlanningInput = { title: '规划', requirements: '需求', instruction: '', modelId: 'auto', sources: [] }

test('scoped publication HTTP validates auth, Origin, exact fields, version and returns immutable scope metadata', async () => {
  const baseline = [{ id: 'REQ-001', source: 'PRD', criterion: 'Save name', required: true, scenarios: ['normal' as const, 'negative' as const] }]
  const cases = [{ id: 'TC-1', title: 'Save', source: 'PRD', steps: 'Save then reload', expected: 'Saved name', assertions: ['Name persists'], preconditions: 'Account', testData: 'Name', cleanup: 'Restore', requirementIds: ['REQ-001'], scenario: 'normal' as const }]
  const { planningDigest } = await import('../testing/planning-model.js')
  const { assessAcceptance, applyQualityReview } = await import('../verification/acceptance.js')
  const context = await fixture({}, false, { generate: async (_input, planning) => {
    const customReview = { caseIds: ['TC-1'], reason: 'Selected only', definitionFingerprint: planningDigest({ baseline, cases }),
      assessment: applyQualityReview(assessAcceptance(baseline.map(item => ({ ...item, required: false })), cases.map(item => ({ ...item, status: 'pending' as const }))), '{"qualified":true,"issues":[],"caseIssues":[]}', ['TC-1']),
      batches: [{ caseIds: ['TC-1'], result: { qualified: true, issues: [], caseIssues: [] } }] }
    const draft = { baseline, cases, customReview }
    await planning.onDraft(draft)
    return draft
  } })
  try {
    const created = await context.request('/projects', input)
    await assert.rejects(context.planning.generate(7, created.body.id, 'fake'), { code: 'UNQUALIFIED' })
    const saved = await context.planning.detail(7, created.body.id)
    const path = `/projects/${saved.id}/publish-scope`, body = { version: saved.version, caseIds: ['TC-1'], reason: 'Selected only' }
    assert.equal((await context.request(path, body, { 'x-owner': '0' })).status, 401)
    assert.equal((await context.request(path, body, { 'x-owner': '8' })).status, 404)
    assert.equal((await context.request(path, body, { origin: 'https://evil.example' })).status, 403)
    for (const patch of [{ extra: true }, { version: '1' }, { caseIds: [] }, { caseIds: ['TC-1', 'TC-1'] }, { reason: '' }]) assert.equal((await context.request(path, { ...body, ...patch })).status, 400)
    assert.equal((await context.request(path, { ...body, version: saved.version - 1 })).status, 409)
    assert.equal((await context.request(path, { ...body, reason: 'Changed' })).status, 409)
    const published = await context.request(path, body)
    assert.equal(published.status, 200)
    assert.deepEqual(published.body.scope, { mode: 'custom', caseIds: ['TC-1'], reason: body.reason, originalDefinitionFingerprint: saved.draft!.definitionFingerprint })
    assert.deepEqual((await context.request(path, body)).body, published.body)
    const after = await context.planning.detail(7, saved.id)
    assert.equal(after.status, 'failed')
    assert.deepEqual(after.draft, saved.draft)
    assert.equal((await context.request(`/projects/${saved.id}/publish`, {})).status, 409)
    assert.deepEqual((await context.request(`/packages/${published.body.id}/export`)).body, published.body)
    assert.deepEqual((await context.request('/packages/import', { package: published.body })).body, published.body)
  } finally { await context.close() }
})

test('manual case and targeted optimize HTTP contracts enforce auth, scope, version and new review requirement', async () => {
  const baseline = [{ id: 'REQ-001', source: 'PRD', criterion: 'Save name', required: true, scenarios: ['normal' as const] }]
  const definition = { id: 'TC-1', title: 'Save', source: 'PRD', steps: 'Save then reload', expected: 'Saved name', assertions: ['Name persists'], preconditions: 'Account', testData: 'Name', cleanup: 'Restore', requirementIds: ['REQ-001'], scenario: 'normal' as const }
  const operations: unknown[] = []
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { started = resolve })
  const context = await fixture({}, false, { generate: async (_input, planning) => {
    if (planning.operation) {
      operations.push(planning.operation)
      started()
      await gate
      return { baseline, cases: [{ ...definition, title: 'Regenerated' }] }
    }
    return { baseline, cases: [definition], assessment: { status: 'qualified', checkedAt: new Date().toISOString(), issues: [], coveredIds: ['REQ-001'], missingIds: [], caseReviews: [{ caseId: 'TC-1', status: 'qualified' }] } }
  } })
  try {
    const created = await context.request('/projects', input)
    await context.planning.generate(7, created.body.id, 'fake')
    let project = await context.planning.detail(7, created.body.id)
    const editPath = `/projects/${project.id}/cases/TC-1`, optimizePath = `/projects/${project.id}/optimize`
    const edited = { ...definition, title: 'Manually changed' }
    const body = { version: project.version, caseDefinition: edited }
    for (const path of [editPath, optimizePath]) {
      assert.equal((await context.request(path, body, { 'x-owner': '0' })).status, 401)
      assert.equal((await context.request(path, body, { 'x-owner': '8' })).status, 404)
      assert.equal((await context.request(path, body, { origin: 'https://evil.example' })).status, 403)
      assert.equal((await context.request(path, { ...body, version: project.version - 1 })).status, 409)
    }
    for (const caseDefinition of [{ ...edited, id: 'TC-2' }, { ...edited, output: 'passed' }, { ...edited, assertions: [] }, { ...edited, requirementIds: ['REQ-999'] }]) assert.equal((await context.request(editPath, { ...body, caseDefinition })).status, 400)
    const saved = await context.request(editPath, body)
    assert.equal(saved.status, 200)
    assert.equal(saved.body.status, 'draft')
    assert.equal(saved.body.draft.assessment, undefined)
    assert.equal(saved.body.draft.cases[0].title, edited.title)
    project = saved.body
    const optimize = { version: project.version, caseIds: ['TC-1'], reason: 'Fix persistence', regenerate: true }
    for (const patch of [{ caseIds: [] }, { caseIds: ['TC-1', 'TC-1'] }, { caseIds: ['TC-999'] }, { reason: '' }, { regenerate: 'yes' }, { extra: true }]) assert.equal((await context.request(optimizePath, { ...optimize, ...patch })).status, 400)
    assert.equal((await context.request(optimizePath, optimize)).status, 202)
    await ready
    const running = (await context.request(`/projects/${project.id}`)).body
    assert.equal((await context.request(editPath, { version: running.version, caseDefinition: edited })).status, 409)
    assert.equal((await context.request(optimizePath, { ...optimize, version: running.version })).status, 409)
    release()
    for (let tries = 0; tries < 200; tries++) { project = (await context.request(`/projects/${project.id}`)).body; if (project.status !== 'running') break }
    assert.equal(project.status, 'draft')
    assert.equal(project.draft.cases[0].title, 'Regenerated')
    assert.equal(project.draft.assessment, undefined)
    assert.deepEqual(operations, [{ mode: 'optimize', ...optimize }])
    assert.equal((await context.request(`/projects/${project.id}/publish`, {})).status, 409)
    const waiting = { ...project, version: project.version + 1, question: { id: 'question', createdAt: new Date().toISOString(), text: 'Confirm?', choices: [], allowFreeform: true } }
    await context.repository.replace('project', waiting, project.version, 7)
    assert.equal((await context.request(editPath, { version: waiting.version, caseDefinition: edited })).status, 409)
    assert.equal((await context.request(optimizePath, { ...optimize, version: waiting.version })).status, 409)
  } finally { release(); await context.close() }
})

test('invalid design review response has a localized non-model-failure HTTP message', async () => {
  const context = await fixture({ planning: {
    create: async () => { throw new PlanningError('REVIEW_INVALID') }, generate: async () => {},
    publish: async () => { throw new PlanningError('UNQUALIFIED') }, cancel: async () => { throw new PlanningError('NOT_FOUND') },
  } })
  try {
    const response = await context.request('/projects', input)
    assert.equal(response.status, 502)
    assert.match(response.body.error, /设计审查返回格式无效/)
    assert.doesNotMatch(response.body.error, /模型调用失败/)
  } finally { await context.close() }
})

async function fixture(overrides: Partial<TestingRouteOptions> = {}, unavailable = false, model?: PlanningModel) {
  const root = await mkdtemp(join(tmpdir(), 'testing-http-'))
  const repository = new MemoryTestingRepository()
  const planning = new CasePlanningService(repository, root, model)
  const app = express()
  app.use(express.json())
  registerTestingRoutes(app, unavailable ? undefined : repository, { root, planning, authenticate: async request => {
    const ownerId = Number(request.get('x-owner') || 7)
    return ownerId ? { ownerId, token: 'test-only-token' } : undefined
  }, availableModels: async () => { throw new Error('Unexpected model request') }, ...overrides })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(done => server.once('listening', done))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/testing`
  const request = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, headers: response.headers, body: await response.json() }
  }
  return { root, repository, planning, base, request, close: async () => { await new Promise<void>((done, reject) => { server.close(error => error ? reject(error) : done()); server.closeAllConnections() }); await rm(root, { recursive: true, force: true }) } }
}

test('testing HTTP enforces auth, Origin, ownership, no-store, list limit and unknown records', async () => {
  const context = await fixture()
  try {
    const created = await context.request('/projects', input)
    assert.equal(created.status, 201)
    assert.equal(created.body.status, 'draft')
    for (const [headers, expected] of [[{ 'x-owner': '0' }, 401], [{ origin: 'https://evil.example' }, 403]] as const) {
      const result = await context.request('/projects', undefined, headers)
      assert.equal(result.status, expected)
      assert.equal(result.headers.get('cache-control'), 'no-store')
    }
    assert.equal((await context.request('/projects', input, { origin: 'https://evil.example' })).status, 403)
    assert.equal((await context.request(`/projects/${created.body.id}`, undefined, { 'x-owner': '8' })).status, 404)
    assert.equal((await context.request(`/projects/${created.body.id}/generate`, {}, { 'x-owner': '8' })).status, 404)
    assert.equal((await context.request('/projects/missing')).status, 404)
    const list = await context.request('/projects')
    assert.equal(list.headers.get('x-result-limit'), '200')
    assert.equal(list.body.length, 1)
    assert.deepEqual((await context.request('/projects', undefined, { 'x-owner': '8' })).body, [])
  } finally { await context.close() }
})

test('planning creation accepts normal repository URLs and returns actionable safe field errors', async () => {
  const context = await fixture()
  try {
    const created = await context.request('/projects', { ...input, referenceRepository: ' https://github.com/owner/repo.name/ ', referenceBranch: ' main ' })
    assert.equal(created.status, 201)
    assert.equal(created.body.input.referenceRepository, 'https://github.com/owner/repo.name')
    assert.equal(created.body.input.referenceBranch, 'main')
    for (const [field, value, message] of [
      ['title', '', /200/],
      ['requirements', '', /需求正文/],
      ['instruction', 'x'.repeat(50_001), /50000/],
      ['referenceRepository', 'https://secret-token@github.com/owner/repo', /GitHub HTTPS/],
      ['referenceBranch', 'main', /参考分支/],
    ] as const) {
      const failed = await context.request('/projects', { ...input, [field]: value })
      assert.equal(failed.status, 400)
      assert.equal(failed.body.field, field)
      assert.match(failed.body.error, message)
      assert.doesNotMatch(JSON.stringify(failed.body), /secret-token/)
    }
    const sourceId = randomUUID()
    const missing = await context.request('/projects', { ...input, sources: [{ id: sourceId, name: 'prd.md', kind: 'requirements', sha256: '0'.repeat(64), sizeBytes: 1, storageKey: `testing/sources/7/${sourceId}.md` }] })
    assert.equal(missing.status, 400)
    assert.equal(missing.body.field, 'sources')
    assert.match(missing.body.error, /重新上传/)
    assert.doesNotMatch(JSON.stringify(missing.body), /testing\/sources/)
  } finally { await context.close() }
})

test('invalid baseline format has a specific safe HTTP response rather than model-call failure', async () => {
  const context = await fixture({ planning: {
    create: async () => { throw new PlanningError('BASELINE_INVALID') },
    generate: async () => {},
    publish: async () => { throw new PlanningError('UNQUALIFIED') },
    cancel: async () => { throw new PlanningError('NOT_FOUND') },
  } })
  try {
    const response = await context.request('/projects', input)
    assert.equal(response.status, 502)
    assert.match(response.body.error, /需求基线格式无效/)
    assert.doesNotMatch(response.body.error, /模型调用失败/)
  } finally { await context.close() }
})

test('planning continue and scoped review bind revision, ownership and explicit scope without enabling publication', async () => {
  const baseline = [{ id: 'REQ-001', source: 'PRD', criterion: 'Save name', required: true, scenarios: ['normal' as const] }]
  const cases = [{ id: 'TC-1', title: 'Save', source: 'PRD', steps: 'Save then reload', expected: 'Saved name', assertions: ['Name persists'], preconditions: 'Account', testData: 'Name', cleanup: 'Restore', requirementIds: ['REQ-001'], scenario: 'normal' as const }]
  const operations: unknown[] = []
  let beganReview!: () => void
  const reviewStarted = new Promise<void>(resolve => { beganReview = resolve })
  const context = await fixture({}, false, { generate: async (_input, planning) => {
    if (planning.operation) { operations.push(planning.operation); beganReview() }
    else { await planning.onDraft({ baseline, cases }); throw new PlanningError('MODEL_FAILED') }
    return { baseline, cases, assessment: { status: 'qualified', checkedAt: new Date().toISOString(), coveredIds: ['REQ-001'], missingIds: [], issues: [], caseReviews: [{ caseId: 'TC-1', status: 'qualified' }] } }
  } })
  try {
    const created = await context.request('/projects', input)
    await context.request(`/projects/${created.body.id}/generate`, {})
    let project = (await context.request(`/projects/${created.body.id}`)).body
    for (let tries = 0; project.status === 'running' && tries < 30; tries++) project = (await context.request(`/projects/${created.body.id}`)).body
    const endpoint = `/projects/${project.id}/review`
    assert.equal((await context.request(endpoint, { version: project.version - 1 })).status, 409)
    assert.equal((await context.request(endpoint, { version: project.version }, { 'x-owner': '8' })).status, 404)
    assert.equal((await context.request(endpoint, { version: project.version, caseIds: [], reason: 'Scope' })).status, 400)
    assert.equal((await context.request(endpoint, { version: project.version, caseIds: ['TC-1', 'TC-1'], reason: 'Scope' })).status, 400)
    assert.equal((await context.request(endpoint, { version: project.version, caseIds: ['TC-1'], reason: '' })).status, 400)
    assert.equal((await context.request(endpoint, { version: project.version, caseIds: ['TC-999'], reason: 'Scope' })).status, 400)
    const expectedVersion = project.version
    const started = await context.request(endpoint, { version: expectedVersion, caseIds: ['TC-1'], reason: 'Scope' })
    assert.equal(started.status, 202)
    await reviewStarted
    for (let tries = 0; tries < 200; tries++) { project = (await context.request(`/projects/${project.id}`)).body; if (project.status !== 'running') break }
    assert.deepEqual(operations, [{ mode: 'review', version: expectedVersion, caseIds: ['TC-1'], reason: 'Scope' }])
    assert.equal((await context.request(`/projects/${project.id}/publish`, {})).status, 409)
    assert.equal((await context.request(`/projects/${project.id}/continue`, { version: project.version })).status, 202)
    for (let tries = 0; tries < 200; tries++) { project = (await context.request(`/projects/${project.id}`)).body; if (project.status !== 'running') break }
  } finally { await context.close() }
})

test('planning answer is authenticated and revision-bound and continues into a fresh confirmation round', async () => {
  let calls = 0
  const context = await fixture({}, false, { generate: async received => {
    if (calls++) assert.match(received.instruction, /"answer":"Clear"/)
    throw new PlanningError('NEEDS_INPUT', undefined, { text: calls === 1 ? 'Clear password?' : 'Confirm focus behavior?', choices: ['Clear', 'Keep'], allowFreeform: false })
  } })
  try {
    const created = await context.request('/projects', input)
    const started = await context.request(`/projects/${created.body.id}/generate`, {})
    assert.equal(started.status, 202)
    let waiting = (await context.request(`/projects/${created.body.id}`)).body
    for (let tries = 0; waiting.status === 'running' && tries < 20; tries++) waiting = (await context.request(`/projects/${created.body.id}`)).body
    assert.equal(waiting.status, 'needs_input')
    assert.equal(waiting.question.text, 'Clear password?')
    const body = { questionId: waiting.question.id, version: waiting.version, answer: 'Clear' }
    const path = `/projects/${created.body.id}/answer`
    assert.equal((await context.request(path, body, { 'x-owner': '8' })).status, 404)
    assert.equal((await context.request(path, body, { origin: 'https://evil.example' })).status, 403)
    assert.equal((await context.request(path, { ...body, answer: '' })).status, 400)
    assert.equal((await context.request(path, { ...body, version: body.version - 1 })).status, 409)
    assert.equal((await context.request(path, body)).status, 202)
    let next = (await context.request(`/projects/${created.body.id}`)).body
    for (let tries = 0; next.status === 'running' && tries < 20; tries++) next = (await context.request(`/projects/${created.body.id}`)).body
    assert.equal(next.status, 'needs_input')
    assert.equal(next.question.text, 'Confirm focus behavior?')
    assert.notEqual(next.question.id, body.questionId)
    assert.equal(next.clarifications[0].answer, 'Clear')
    assert.equal((await context.request(path, body)).status, 409)
    assert.equal(calls, 2)
  } finally { await context.close() }
})

test('undefined module and storage failures return sanitized 503 without fallback', async () => {
  const context = await fixture({ unavailableReason: 'secret stack token=do-not-leak' }, true)
  try {
    for (const path of ['/projects', '/packages', '/executions', '/packages/missing', '/executions/missing/report']) {
      const result = await context.request(path)
      assert.equal(result.status, 503)
      assert.doesNotMatch(JSON.stringify(result.body), /do-not-leak|stack/)
    }
    assert.equal((await context.request('/sources', {})).status, 503)
  } finally { await context.close() }
  const broken = await fixture()
  try {
    broken.repository.list = async () => { throw new TestingStorageUnavailableError() }
    assert.equal((await broken.request('/projects')).status, 503)
  } finally { await broken.close() }
})

test('uploads restore names, hash exact bytes and reject foreign or arbitrary source paths', async () => {
  const context = await fixture()
  try {
    const data = new FormData()
    data.append('kind', 'requirements')
    data.append('files', new Blob(['source bytes']), '需求.md')
    const response = await fetch(`${context.base}/sources`, { method: 'POST', body: data })
    assert.equal(response.status, 201)
    const [source] = await response.json()
    assert.equal(source.name, '需求.md')
    assert.match(source.storageKey, /^testing\/sources\/7\//)
    assert.equal((await readFile(join(context.root, source.storageKey))).toString(), 'source bytes')
    assert.equal((await context.request('/projects', { ...input, sources: [source] })).status, 201)
    assert.equal((await context.request('/projects', { ...input, sources: [source] }, { 'x-owner': '8' })).status, 400)
    for (const storageKey of ['uploads/7/prd.md', `testing/sources/7/../7/${source.id}.md`, `testing/sources/7/${source.id}.md/other`, 'server/index.ts']) {
      assert.equal((await context.request('/projects', { ...input, sources: [{ ...source, storageKey }] })).status, 400)
    }
    assert.equal((await context.request('/projects', { ...input, sources: [{ ...source, sha256: '0'.repeat(64) }] })).status, 409)
    const unsupported = new FormData()
    unsupported.append('kind', 'design'); unsupported.append('files', new Blob(['bad']), 'unsafe.svg')
    assert.equal((await fetch(`${context.base}/sources`, { method: 'POST', body: unsupported })).status, 400)
  } finally { await context.close() }
})

test('native package reimport remains owner-scoped and exact; default external import validates schema', async () => {
  const context = await fixture()
  try {
    const value: CasePackage = { schemaVersion: 1, id: randomUUID(), projectId: randomUUID(), revision: 1, createdAt: new Date().toISOString(), sourceFingerprint: 'source', definitionFingerprint: 'definition', rulesVersion: 'rules', modelId: 'auto', baseline: [], cases: [], assessment: { status: 'qualified', checkedAt: new Date().toISOString(), issues: [], coveredIds: [], missingIds: [] } }
    await context.repository.create('package', value, 7)
    assert.deepEqual((await context.request(`/packages/${value.id}/export`)).body, value)
    assert.deepEqual((await context.request('/packages/import', { package: value })).body, value)
    for (const forged of [{ ...value, rulesVersion: 'forged' }, { ...value, id: randomUUID() }, { ...value, assessment: { ...value.assessment, inputFingerprint: 'forged' } }]) {
      const result = await context.request('/packages/import', { package: forged })
      assert.equal(result.status, 400)
    }
    assert.equal((await context.request('/packages/import', { package: value }, { 'x-owner': '8' })).status, 400)
    assert.equal((await context.repository.list('package', 7)).length, 1)
    assert.equal((await context.repository.list('project', 7)).length, 0)
  } finally { await context.close() }
})

test('background generation returns current record, rejects duplicates and preserves service failure', async () => {
  let release!: () => void
  const blocked = new Promise<void>(done => { release = done })
  let finished!: () => void
  const completed = new Promise<void>(done => { finished = done })
  let context: Awaited<ReturnType<typeof fixture>>
  context = await fixture({ planning: {
    create: (owner, value) => context.planning.create(owner, value),
    publish: (owner, id) => context.planning.publish(owner, id),
    cancel: (owner, id) => context.planning.cancel(owner, id),
    generate: async (owner, id, token) => {
      assert.equal(token, 'test-only-token')
      const project = (await context.repository.get('project', id, owner))!
      await context.repository.replace('project', { ...project, status: 'running', version: project.version + 1 }, project.version, owner)
      await blocked
      const current = (await context.repository.get('project', id, owner))!
      await context.repository.replace('project', { ...current, status: 'failed', error: '模型失败', version: current.version + 1 }, current.version, owner)
      finished()
      throw new PlanningError('MODEL_FAILED')
    },
  } })
  try {
    const project = (await context.request('/projects', input)).body
    const started = await context.request(`/projects/${project.id}/generate`, {})
    assert.equal(started.status, 202)
    assert.equal(started.body.status, 'running')
    assert.equal((await context.request(`/projects/${project.id}/generate`, {})).status, 409)
    release(); await completed
    assert.equal((await context.request(`/projects/${project.id}`)).body.status, 'failed')
  } finally { release(); await context.close() }
})

test('draft executions cannot start and binding authority is never accepted from clients', async () => {
  let started = false, approved = false
  const source = 'const token = "ghp_literal_in_trusted_test_source";\nexpect(token).toBeDefined();'
  const bindingDetail = { manifest: { version: 1 as const, caseId: 'TC-01', definitionKey: '', assertions: [{ id: 'TC-01:A001', definition: 'Visible' }] }, testCase: { id: 'TC-01', title: 'Visible', source: 'requirements', steps: 'Open', expected: 'Visible', status: 'pending' as const }, binding: null, source }
  const context = await fixture({ execution: {
    create: async () => { throw new Error('unused') }, prepare: async () => {}, start: async () => { started = true }, cancel: async () => { throw new ExecutionError('CONFLICT') },
    report: async () => { throw new Error('unused') },
    binding: async () => bindingDetail,
    approve: async (_owner, _id, _caseId, body) => { approved = true; return { ...body as { testFile: string; testTitle: string; project: string; assertionIds: string[] }, version: 1, caseFingerprint: 'case', designFingerprint: 'design', testSourceFingerprint: 'source', approvedBy: '7', approvedAt: new Date().toISOString(), reviewedAt: new Date().toISOString() } },
  } })
  try {
    const at = new Date().toISOString()
    const run: ExecutionRun = { id: randomUUID(), ownerId: 7, version: 1, createdAt: at, updatedAt: at, input: { title: '执行', caseSetId: randomUUID(), repository: 'https://github.com/org/repo', scope: { mode: 'default', caseIds: [], reason: '' } }, status: 'draft', packageFingerprint: 'hash', cases: [{ caseId: 'TC-01', selected: true, blocking: true, status: 'pending' }], events: [] }
    await context.repository.create('execution', run, 7)
    assert.equal((await context.request(`/executions/${run.id}/start`, {})).status, 409)
    assert.equal(started, false)
    assert.equal((await context.request(`/executions/${run.id}/cancel`, {})).status, 409)
    assert.equal((await context.request(`/executions/${run.id}/bindings/missing`)).status, 404)
    const detail = await context.request(`/executions/${run.id}/bindings/TC-01`)
    assert.equal(detail.body.caseId, 'TC-01')
    assert.match(detail.body.caseFingerprint, /^[a-f0-9]{64}$/)
    assert.equal(detail.body.source, source)
    const approval = { testFile: 'approved.spec.ts', testTitle: 'title', project: '', assertionIds: ['TC-01:A001'], confirm: true }
    assert.equal((await context.request(`/executions/${run.id}/bindings/TC-01`, { ...approval, approvedBy: 'attacker' })).status, 400)
    assert.equal(approved, false)
    const saved = await context.request(`/executions/${run.id}/bindings/TC-01`, approval)
    assert.equal(saved.status, 200)
    assert.equal(saved.body.caseId, 'TC-01')
    assert.equal(saved.body.binding.approvedBy, '7')
    assert.equal(approved, true)
  } finally { await context.close() }
})

test('model validation happens only on generation and uses the authenticated token', async () => {
  let catalogs = 0, generations = 0
  let context: Awaited<ReturnType<typeof fixture>>
  context = await fixture({
    availableModels: async token => { assert.equal(token, 'test-only-token'); catalogs++; return [] },
    planning: {
      create: (owner, value) => context.planning.create(owner, value),
      generate: async () => { generations++ },
      publish: async () => { throw new PlanningError('UNQUALIFIED') },
      cancel: (owner, id) => context.planning.cancel(owner, id),
    },
  })
  try {
    const project = (await context.request('/projects', { ...input, modelId: 'unavailable-model' })).body
    await context.request('/projects')
    assert.equal(catalogs, 0)
    assert.equal((await context.request(`/projects/${project.id}/generate`, {})).status, 400)
    assert.equal(catalogs, 1)
    assert.equal(generations, 0)
    assert.equal((await context.request(`/projects/${project.id}/publish`, {})).status, 409)
    assert.equal((await context.request(`/projects/${project.id}/cancel`, {})).body.status, 'cancelled')
  } finally { await context.close() }
})

test('execution preparation is asynchronous, owner-scoped, cancellable and reports saved status', async () => {
  let release!: () => void, finished!: () => void
  const pending = new Promise<void>(done => { release = done })
  const completed = new Promise<void>(done => { finished = done })
  let context: Awaited<ReturnType<typeof fixture>>
  context = await fixture({ execution: {
    create: async () => { throw new ExecutionError('INVALID_INPUT') },
    prepare: async (owner, id, token) => {
      assert.equal(token, 'test-only-token')
      const run = (await context.repository.get('execution', id, owner))!
      await context.repository.replace('execution', { ...run, version: run.version + 1, status: 'preparing' }, run.version, owner)
      await pending
      const current = (await context.repository.get('execution', id, owner))!
      assert.equal(current.status, 'cancelled')
      finished()
      throw new ExecutionError('PREPARATION_FAILED')
    },
    start: async () => { throw new Error('draft must not start') },
    cancel: async (owner, id) => {
      const run = (await context.repository.get('execution', id, owner))!
      const cancelled: ExecutionRun = { ...run, status: 'cancelled', version: run.version + 1 }
      await context.repository.replace('execution', cancelled, run.version, owner)
      return cancelled
    },
    binding: async () => { throw new ExecutionError('CONFLICT') },
    approve: async () => { throw new ExecutionError('CONFLICT') },
    report: async () => { throw new Error('secret stack token=do-not-leak') },
  } })
  try {
    const at = new Date().toISOString()
    const run: ExecutionRun = { id: randomUUID(), ownerId: 7, version: 1, createdAt: at, updatedAt: at, input: { title: '执行', caseSetId: randomUUID(), repository: 'https://github.com/org/repo', scope: { mode: 'default', caseIds: [], reason: '' } }, status: 'draft', packageFingerprint: 'hash', cases: [], events: [] }
    await context.repository.create('execution', run, 7)
    for (const action of ['prepare', 'start', 'cancel']) assert.equal((await context.request(`/executions/${run.id}/${action}`, {}, { 'x-owner': '8' })).status, 404)
    const started = await context.request(`/executions/${run.id}/prepare`, {})
    assert.equal(started.status, 202)
    assert.equal(started.body.status, 'preparing')
    assert.equal((await context.request(`/executions/${run.id}/prepare`, {})).status, 409)
    assert.equal((await context.request(`/executions/${run.id}/cancel`, {})).body.status, 'cancelled')
    release(); await completed
    assert.equal((await context.request(`/executions/${run.id}`)).body.status, 'cancelled')
    const report = await context.request(`/executions/${run.id}/report`)
    assert.equal(report.status, 503)
    assert.doesNotMatch(JSON.stringify(report.body), /do-not-leak|stack/)
  } finally { release(); await context.close() }
})

test('audited import hook is explicit and receives owner and token', async () => {
  let calls = 0
  const context = await fixture({ importPackage: async (owner, value, token) => {
    assert.equal(owner, 7)
    assert.equal(token, 'test-only-token')
    assert.deepEqual(value, { id: 'external' })
    calls++
    throw new PlanningError('UNQUALIFIED')
  } })
  try {
    assert.equal((await context.request('/packages/import', { package: { id: 'external' } })).status, 409)
    assert.equal(calls, 1)
    assert.equal((await context.repository.list('package', 7)).length, 0)
  } finally { await context.close() }
})

test('source kinds accept PDF requirements and image designs but reject mismatches before writing', async () => {
  const context = await fixture()
  try {
    for (const [kind, name, status] of [['requirements', 'requirements.pdf', 201], ['design', 'design.png', 201], ['design', 'requirements.pdf', 400], ['requirements', 'design.png', 400], ['design', 'notes.txt', 400]] as const) {
      const data = new FormData()
      data.append('kind', kind)
      data.append('files', new Blob(['isolated-upload-bytes']), name)
      const response = await fetch(`${context.base}/sources`, { method: 'POST', body: data })
      assert.equal(response.status, status)
      if (status === 201) {
        const [source] = await response.json()
        assert.equal(source.kind, kind)
        assert.equal((await context.request('/projects', { ...input, sources: [{ ...source, kind: kind === 'requirements' ? 'design' : 'requirements' }] })).status, 400)
      }
    }
  } finally { await context.close() }
})

test('implementation and install endpoints authenticate, require explicit install consent and serialize operations', async () => {
  let implementCalls = 0, installCalls = 0, release!: () => void, finished!: () => void
  const pending = new Promise<void>(done => { release = done })
  const completed = new Promise<void>(done => { finished = done })
  let context: Awaited<ReturnType<typeof fixture>>
  context = await fixture({ execution: {
    create: async () => { throw new Error('unused') }, prepare: async () => {}, start: async () => {},
    cancel: async () => { throw new ExecutionError('CONFLICT') }, report: async () => { throw new Error('unused') },
    binding: async () => { throw new ExecutionError('CONFLICT') }, approve: async () => { throw new ExecutionError('CONFLICT') },
    implement: async (owner, id, token) => {
      assert.equal(owner, 7)
      assert.equal(token, 'test-only-token')
      implementCalls++
      const current = (await context.repository.get('execution', id, owner))!
      await context.repository.replace('execution', { ...current, version: current.version + 1, status: 'preparing' }, current.version, owner)
      await pending
      const running = (await context.repository.get('execution', id, owner))!
      await context.repository.replace('execution', { ...running, version: running.version + 1, status: 'draft' }, running.version, owner)
      finished()
    },
    install: async owner => { assert.equal(owner, 7); installCalls++ },
  } })
  try {
    const at = new Date().toISOString()
    const run: ExecutionRun = { id: randomUUID(), ownerId: 7, version: 1, createdAt: at, updatedAt: at, input: { title: 'Execute', caseSetId: randomUUID(), repository: 'https://github.com/org/repo', scope: { mode: 'default', caseIds: [], reason: '' } }, status: 'draft', packageFingerprint: 'hash', cases: [], events: [] }
    await context.repository.create('execution', run, 7)
    for (const action of ['implement', 'install']) {
      assert.equal((await context.request(`/executions/${run.id}/${action}`, { confirm: true }, { 'x-owner': '8' })).status, 404)
      assert.equal((await context.request(`/executions/${run.id}/${action}`, { confirm: true }, { 'x-owner': '0' })).status, 401)
      assert.equal((await context.request(`/executions/${run.id}/${action}`, { confirm: true }, { origin: 'https://evil.example' })).status, 403)
    }
    for (const body of [{}, { confirm: false }, { confirm: 'true' }, { confirm: 1 }, []]) assert.equal((await context.request(`/executions/${run.id}/install`, body)).status, 400)
    assert.equal(installCalls, 0)
    assert.equal((await context.request(`/executions/${run.id}/install`, { confirm: true })).status, 202)
    assert.equal(installCalls, 1)
    const started = await context.request(`/executions/${run.id}/implement`, {})
    assert.equal(started.status, 202)
    assert.equal(started.body.status, 'preparing')
    for (const action of ['implement', 'install', 'prepare']) assert.equal((await context.request(`/executions/${run.id}/${action}`, { confirm: true })).status, 409)
    assert.equal(implementCalls, 1)
    assert.equal(installCalls, 1)
    release(); await completed
    assert.equal((await context.request(`/executions/${run.id}`)).body.status, 'draft')
  } finally { release(); await context.close() }
})

test('optional upcoming execution actions fail closed when a supplied service lacks them', async () => {
  const context = await fixture({ execution: {
    create: async () => { throw new Error('unused') }, prepare: async () => {}, start: async () => {}, cancel: async () => { throw new ExecutionError('CONFLICT') },
    report: async () => { throw new Error('unused') }, binding: async () => { throw new ExecutionError('CONFLICT') }, approve: async () => { throw new ExecutionError('CONFLICT') },
  } })
  try {
    const at = new Date().toISOString()
    const run: ExecutionRun = { id: randomUUID(), ownerId: 7, version: 1, createdAt: at, updatedAt: at, input: { title: 'Execute', caseSetId: randomUUID(), repository: 'https://github.com/org/repo', scope: { mode: 'default', caseIds: [], reason: '' } }, status: 'draft', packageFingerprint: 'hash', cases: [], events: [] }
    await context.repository.create('execution', run, 7)
    for (const action of ['implement', 'install']) assert.equal((await context.request(`/executions/${run.id}/${action}`, { confirm: true })).status, 503)
  } finally { await context.close() }
})