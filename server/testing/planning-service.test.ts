import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { CopilotClient, type SessionConfig, type SessionEvent } from '@github/copilot-sdk'
import type { AcceptanceRequirement } from '../../shared/task.js'
import type { CaseDefinition, PlanningInput, TestingRecordKind, TestingRecordMap, TestingRepository } from '../../shared/testing.js'
import { applyQualityReview, assessAcceptance } from '../verification/acceptance.js'
import { CopilotPlanningModel, planningCases, planningDigest, planningEnvironment, planningReadPath, type PlanningContext, type PlanningModel, type PlanningResult } from './planning-model.js'
import { CasePlanningService, PlanningError } from './planning-service.js'
import { createTestingRepository, MemoryTestingRepository } from './repository.js'

class FakeRepository implements TestingRepository {
  readonly rows = new Map<string, { ownerId: number; value: TestingRecordMap[TestingRecordKind] }>()
  packageCreates = 0
  failPackage = false
  history: TestingRecordMap['project'][] = []
  async list<Kind extends TestingRecordKind>(kind: Kind, ownerId: number): Promise<TestingRecordMap[Kind][]> {
    return [...this.rows.entries()].filter(([key, row]) => key.startsWith(`${kind}:`) && row.ownerId === ownerId).map(([, row]) => structuredClone(row.value) as TestingRecordMap[Kind])
  }
  async get<Kind extends TestingRecordKind>(kind: Kind, id: string, ownerId: number): Promise<TestingRecordMap[Kind] | undefined> {
    const row = this.rows.get(`${kind}:${id}`)
    return row?.ownerId === ownerId ? structuredClone(row.value) as TestingRecordMap[Kind] : undefined
  }
  async create<Kind extends TestingRecordKind>(kind: Kind, value: TestingRecordMap[Kind], ownerId: number): Promise<void> {
    if (kind === 'package' && this.failPackage) throw new Error('secret database password')
    if (this.rows.has(`${kind}:${value.id}`)) throw new Error('duplicate')
    if (kind === 'package') this.packageCreates++
    this.rows.set(`${kind}:${value.id}`, { ownerId, value: structuredClone(value) })
  }
  async replace<Kind extends 'project' | 'execution'>(kind: Kind, value: TestingRecordMap[Kind], version: number, ownerId: number): Promise<void> {
    const row = this.rows.get(`${kind}:${value.id}`)
    if (!row || row.ownerId !== ownerId || !('version' in row.value) || row.value.version !== version) throw new Error('CAS')
    this.rows.set(`${kind}:${value.id}`, { ownerId, value: structuredClone(value) })
    if (kind === 'project') this.history.push(structuredClone(value) as TestingRecordMap['project'])
  }
  async recover(): Promise<void> {}
}

const baseline: AcceptanceRequirement[] = [{ id: 'REQ-001', feature: 'Profile', source: 'PRD 1', criterion: 'Persist the saved name', required: true, scenarios: ['normal'] }]
const cases: CaseDefinition[] = [{ id: 'TC-1', title: 'Persist name', source: 'PRD 1', steps: 'Save a new name and reload', expected: 'Reloaded name is the saved name', requirementIds: ['REQ-001'], scenario: 'normal', preconditions: 'An existing account', testData: 'New name', assertions: ['Saved name is visible after reload'], cleanup: 'Restore original name' }]
const result = (): PlanningResult => ({ baseline: structuredClone(baseline), cases: structuredClone(cases), assessment: applyQualityReview(assessAcceptance(baseline, planningCases(cases)), '{"qualified":true,"issues":[],"caseIssues":[]}', ['TC-1']) })
const input = (): PlanningInput => ({ title: 'Profile planning', requirements: 'Persist the saved name.', instruction: 'Design cases only.', modelId: 'auto', sources: [] })
const code = (expected: string) => (error: unknown) => error instanceof PlanningError && error.code === expected

test('scoped publication reserves once under full rejection, is concurrent idempotent and leaves full draft unchanged', async context => {
  const { service, repository, project } = await fixture(context)
  await service.generate(1, project.id, 'fake')
  const full = await service.publish(1, project.id)
  let saved = await service.detail(1, project.id)
  const draft = structuredClone(saved.draft!)
  draft.cases.push({ ...draft.cases[0], id: 'TC-2' })
  draft.baseline[0].scenarios.push('negative')
  draft.definitionFingerprint = planningDigest({ baseline: draft.baseline, cases: draft.cases })
  draft.assessment = assessAcceptance(draft.baseline, planningCases(draft.cases))
  draft.customReview = { caseIds: ['TC-2', 'TC-1'], reason: 'Selected only', definitionFingerprint: draft.definitionFingerprint,
    assessment: applyQualityReview(assessAcceptance(draft.baseline.map(item => ({ ...item, required: false })), planningCases(draft.cases)), '{"qualified":true,"issues":[],"caseIssues":[]}', ['TC-1', 'TC-2']),
    batches: [{ caseIds: ['TC-2', 'TC-1'], result: { qualified: true, issues: [], caseIssues: [] } }] }
  saved = { ...saved, status: 'failed', draft, version: saved.version + 1 }
  await repository.replace('project', saved, saved.version - 1, 1)
  await assert.rejects(service.publish(1, project.id), code('UNQUALIFIED'))
  const [first, concurrent] = await Promise.all([service.publishScope(1, project.id, saved.version, ['TC-1', 'TC-2'], 'Selected only'), service.publishScope(1, project.id, saved.version, ['TC-2', 'TC-1'], 'Selected only')])
  assert.deepEqual(first, concurrent)
  assert.equal(first.revision, 2)
  assert.equal(first.scope!.originalDefinitionFingerprint, draft.definitionFingerprint)
  const after = await service.detail(1, project.id)
  assert.equal(after.status, 'failed')
  assert.deepEqual(after.draft, draft)
  assert.deepEqual(after.caseSetIds, [full.id, first.id])
  assert.deepEqual(await service.publishScope(1, project.id, after.version, ['TC-2', 'TC-1'], 'Selected only'), first)
  assert.deepEqual(await repository.get('package', full.id, 1), full)
  first.cases[0].title = 'Caller mutation'
  assert.notEqual((await repository.get('package', concurrent.id, 1))!.cases[0].title, 'Caller mutation')
  await assert.rejects(service.publishScope(2, project.id, after.version, ['TC-1', 'TC-2'], 'Selected only'), code('NOT_FOUND'))
  await assert.rejects(service.publishScope(1, project.id, saved.version - 1, ['TC-1', 'TC-2'], 'Selected only'), code('CONFLICT'))
  await assert.rejects(service.publishScope(1, project.id, after.version, ['TC-1', 'TC-2'], 'Changed reason'), code('CONFLICT'))
})

test('scoped publication recovers failed writes and rejects source drift, busy and pending questions', async context => {
  const { service, repository, project, root } = await fixture(context)
  await service.generate(1, project.id, 'fake')
  let saved = await service.detail(1, project.id)
  saved.draft!.customReview = { caseIds: ['TC-1'], reason: 'Selected only', definitionFingerprint: saved.draft!.definitionFingerprint!, assessment: saved.draft!.assessment,
    batches: [{ caseIds: ['TC-1'], result: { qualified: true, issues: [], caseIssues: [] } }] }
  saved = { ...saved, status: 'draft', version: saved.version + 1 }
  await repository.replace('project', saved, saved.version - 1, 1)
  for (const patch of [{ status: 'running' as const }, { question: { id: 'question', createdAt: new Date().toISOString(), text: 'Confirm?', choices: [], allowFreeform: true } }]) {
    repository.rows.set(`project:${project.id}`, { ownerId: 1, value: { ...saved, ...patch } })
    await assert.rejects(service.publishScope(1, project.id, saved.version, ['TC-1'], 'Selected only'), code('CONFLICT'))
  }
  repository.rows.set(`project:${project.id}`, { ownerId: 1, value: saved })
  repository.failPackage = true
  await assert.rejects(service.publishScope(1, project.id, saved.version, ['TC-1'], 'Selected only'), code('STORAGE_FAILED'))
  const reserved = await service.detail(1, project.id)
  await assert.rejects(service.editCase(1, project.id, 'TC-1', reserved.version, { ...cases[0], title: 'Changed' }), code('CONFLICT'))
  await assert.rejects(service.generate(1, project.id, 'fake'), code('CONFLICT'))
  repository.failPackage = false
  const recovered = await service.publishScope(1, project.id, reserved.version, ['TC-1'], 'Selected only')
  assert.equal(recovered.id, reserved.caseSetIds[0])
  assert.equal(recovered.revision, 1)
  assert.equal(repository.packageCreates, 1)
  await writeFile(join(root, 'testing', 'planning', project.id, 'workspace', 'requirements.txt'), 'Tampered')
  await assert.rejects(service.publishScope(1, project.id, reserved.version, ['TC-1'], 'Selected only'), code('SOURCE_CHANGED'))
})

test('scoped reservation rechecks source drift during CAS and survives JSON reopening without another revision', async context => {
  const root = await mkdtemp(join(tmpdir(), 'scope-publication-json-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const repository = await createTestingRepository('json', root)
  const service = new CasePlanningService(repository, root, { generate: async () => result() })
  const project = await service.create(1, input())
  await service.generate(1, project.id, 'fake')
  let saved = await service.detail(1, project.id)
  saved.draft!.customReview = { caseIds: ['TC-1'], reason: 'Selected only', definitionFingerprint: saved.draft!.definitionFingerprint!, assessment: saved.draft!.assessment,
    batches: [{ caseIds: ['TC-1'], result: { qualified: true, issues: [], caseIssues: [] } }] }
  saved = { ...saved, status: 'failed', version: saved.version + 1 }
  await repository.replace('project', saved, saved.version - 1, 1)
  const replace = repository.replace.bind(repository)
  const requirementsFile = join(root, 'testing', 'planning', project.id, 'workspace', 'requirements.txt')
  repository.replace = async (kind, value, version, owner) => {
    await replace(kind, value, version, owner)
    if (kind === 'project' && 'events' in value && value.events.at(-1)?.text.startsWith('planning:publish-scope:')) await writeFile(requirementsFile, 'Changed during CAS')
  }
  await assert.rejects(service.publishScope(1, project.id, saved.version, ['TC-1'], 'Selected only'), code('SOURCE_CHANGED'))
  assert.equal((await repository.list('package', 1)).length, 0)
  const reserved = await service.detail(1, project.id)
  assert.equal(reserved.caseSetIds.length, 1)
  await writeFile(requirementsFile, input().requirements)
  const reopened = await createTestingRepository('json', root)
  const resumed = new CasePlanningService(reopened, root)
  const [first, second] = await Promise.all([resumed.publishScope(1, project.id, reserved.version, ['TC-1'], 'Selected only'), resumed.publishScope(1, project.id, reserved.version, ['TC-1'], 'Selected only')])
  assert.deepEqual(first, second)
  assert.equal(first.id, reserved.caseSetIds[0])
  assert.equal(first.revision, 1)
  assert.equal((await resumed.detail(1, project.id)).status, 'failed')
  assert.deepEqual((await resumed.detail(1, project.id)).draft, saved.draft)
  assert.deepEqual(await reopened.list('package', 1), [first])
})

test('manual editing binds owner and version, preserves packages and siblings, invalidates all reviews', async context => {
  const pair = [cases[0], { ...cases[0], id: 'TC-2' }]
  const { service, repository, project } = await fixture(context, { generate: async (_input, planning) => {
    const definitions = planning.previous?.cases || pair
    return { baseline, cases: definitions, assessment: applyQualityReview(assessAcceptance(baseline, planningCases(definitions)), '{"qualified":true,"issues":[],"caseIssues":[]}', ['TC-1', 'TC-2']) }
  } })
  await service.generate(1, project.id, 'fake')
  const published = await service.publish(1, project.id)
  let saved = await service.detail(1, project.id)
  await service.generate(1, project.id, 'fake', { mode: 'review', version: saved.version, caseIds: ['TC-1'], reason: 'Selected' })
  saved = await service.detail(1, project.id)
  const changed = { ...saved.draft!.cases[0], title: 'Save and verify persisted name' }
  await assert.rejects(service.editCase(2, project.id, 'TC-1', saved.version, changed), code('NOT_FOUND'))
  await assert.rejects(service.editCase(1, project.id, 'TC-1', saved.version - 1, changed), code('CONFLICT'))
  for (const value of [{ ...changed, id: 'TC-99' }, { ...changed, status: 'passed' }, { ...changed, requirementIds: ['REQ-999'] }, { ...changed, assertions: [] }]) await assert.rejects(service.editCase(1, project.id, 'TC-1', saved.version, value), code('INVALID_INPUT'))
  const edited = await service.editCase(1, project.id, 'TC-1', saved.version, changed)
  assert.equal(edited.status, 'draft')
  assert.equal(edited.version, saved.version + 1)
  assert.deepEqual(edited.draft!.cases, [changed, pair[1]])
  assert.deepEqual(edited.draft!.baseline, saved.draft!.baseline)
  assert.deepEqual(edited.caseSetIds, saved.caseSetIds)
  assert.equal(edited.draft!.assessment, undefined)
  assert.equal(edited.draft!.customReview, undefined)
  assert.deepEqual(edited.draft!.reviewBatches, [])
  assert.notEqual(edited.draft!.definitionFingerprint, saved.draft!.definitionFingerprint)
  assert.deepEqual(await repository.get('package', published.id, 1), published)
  await assert.rejects(service.publish(1, project.id), code('UNQUALIFIED'))
  await assert.rejects(service.editCase(1, project.id, 'TC-1', saved.version, changed), code('CONFLICT'))
  await service.generate(1, project.id, 'fake', { mode: 'review', version: edited.version })
  const revised = await service.publish(1, project.id)
  assert.notEqual(revised.id, published.id)
  assert.equal(revised.revision, 2)
  assert.deepEqual(revised.cases, [changed, pair[1]])
  assert.deepEqual(await repository.get('package', published.id, 1), published)
})

test('manual edits and optimization reject busy, waiting, source drift and incomplete publication', async context => {
  const { service, repository, project, root } = await fixture(context)
  await service.generate(1, project.id, 'fake')
  const saved = await service.detail(1, project.id)
  const changed = { ...cases[0], title: 'Changed' }
  for (const patch of [{ status: 'running' as const }, { question: { id: 'question', createdAt: new Date().toISOString(), text: 'Confirm?', choices: [], allowFreeform: true } }, { events: [...saved.events, { at: new Date().toISOString(), kind: 'info' as const, text: `planning:publish:${randomUUID()}` }] }]) {
    repository.rows.set(`project:${project.id}`, { ownerId: 1, value: { ...saved, ...patch } })
    await assert.rejects(service.editCase(1, project.id, 'TC-1', saved.version, changed), code('CONFLICT'))
    await assert.rejects(service.generate(1, project.id, 'fake', { mode: 'optimize', version: saved.version, caseIds: ['TC-1'], reason: 'Fix' }), code('CONFLICT'))
  }
  repository.rows.set(`project:${project.id}`, { ownerId: 1, value: saved })
  await writeFile(join(root, 'testing', 'planning', project.id, 'workspace', 'requirements.txt'), 'Tampered')
  await assert.rejects(service.editCase(1, project.id, 'TC-1', saved.version, changed), code('SOURCE_CHANGED'))
  await assert.rejects(service.generate(1, project.id, 'fake', { mode: 'optimize', version: saved.version, caseIds: ['TC-1'], reason: 'Fix' }), code('SOURCE_CHANGED'))
  assert.deepEqual(await service.detail(1, project.id), saved)
})

test('targeted optimization and regeneration save only one case and never complete or review automatically', async context => {
  const pair = [cases[0], { ...cases[0], id: 'TC-2' }]
  let calls = 0
  const { service, project, repository } = await fixture(context, { generate: async (_input, planning) => {
    calls++
    if (!planning.operation) return { baseline, cases: pair, assessment: applyQualityReview(assessAcceptance(baseline, planningCases(pair)), '{"qualified":true,"issues":[],"caseIssues":[]}', ['TC-1', 'TC-2']) }
    assert.equal(planning.operation.mode, 'optimize')
    const draft = { ...planning.previous!, cases: planning.previous!.cases.map(item => item.id === 'TC-1' ? { ...item, title: planning.operation!.regenerate ? 'Regenerated' : 'Optimized' } : item) }
    await planning.onDraft(draft)
    assert.equal((await repository.get('project', project.id, 1))?.draft?.assessment, undefined)
    return draft
  } })
  await service.generate(1, project.id, 'fake')
  for (const regenerate of [false, true]) {
    const before = await service.detail(1, project.id)
    await service.generate(1, project.id, 'fake', { mode: 'optimize', version: before.version, caseIds: ['TC-1'], reason: 'Fix saved issue', regenerate })
    const after = await service.detail(1, project.id)
    assert.equal(after.status, 'draft')
    assert.equal(after.draft!.cases[0].id, 'TC-1')
    assert.equal(after.draft!.cases[0].title, regenerate ? 'Regenerated' : 'Optimized')
    assert.deepEqual(after.draft!.cases[1], pair[1])
    assert.equal(after.draft!.assessment, undefined)
    assert.equal(after.draft!.customReview, undefined)
    assert.deepEqual(after.draft!.reviewBatches, [])
    await assert.rejects(service.publish(1, project.id), code('UNQUALIFIED'))
  }
  assert.equal(calls, 3)
})

test('targeted optimization rejects invalid scope and model mutations outside the selected definition', async context => {
  let malicious = false
  const { service, project } = await fixture(context, { generate: async (_input, planning) => {
    if (!planning.operation) return result()
    const draft = { ...planning.previous!, baseline: [{ ...baseline[0], criterion: 'Weakened' }] }
    if (malicious) await planning.onDraft(draft)
    return draft
  } })
  await service.generate(1, project.id, 'fake')
  const saved = await service.detail(1, project.id)
  for (const patch of [{ caseIds: undefined }, { caseIds: [] }, { caseIds: ['TC-1', 'TC-1'] }, { caseIds: ['TC-999'] }, { reason: '' }, { regenerate: 'yes' }]) {
    await assert.rejects(service.generate(1, project.id, 'fake', { mode: 'optimize', version: saved.version, caseIds: ['TC-1'], reason: 'Fix', ...patch } as never), code('INVALID_INPUT'))
  }
  await assert.rejects(service.generate(2, project.id, 'fake', { mode: 'optimize', version: saved.version, caseIds: ['TC-1'], reason: 'Fix' }), code('NOT_FOUND'))
  await assert.rejects(service.generate(1, project.id, 'fake', { mode: 'optimize', version: saved.version - 1, caseIds: ['TC-1'], reason: 'Fix' }), code('CONFLICT'))
  for (const checkpoint of [false, true]) {
    malicious = checkpoint
    const before = await service.detail(1, project.id)
    await assert.rejects(service.generate(1, project.id, 'fake', { mode: 'optimize', version: before.version, caseIds: ['TC-1'], reason: 'Fix' }), code('INVALID_INPUT'))
    assert.deepEqual((await service.detail(1, project.id)).draft, saved.draft)
  }
})

test('targeted optimization rejects sibling edits, reordering and changed identity at checkpoints and final return', async context => {
  const pair = [cases[0], { ...cases[0], id: 'TC-2' }]
  let mutation: 'sibling' | 'order' | 'identity' = 'sibling'
  let checkpoint = false
  const { service, project } = await fixture(context, { generate: async (_input, planning) => {
    if (!planning.operation) return { baseline, cases: pair, assessment: applyQualityReview(assessAcceptance(baseline, planningCases(pair)), '{"qualified":true,"issues":[],"caseIssues":[]}', ['TC-1', 'TC-2']) }
    const changed = mutation === 'sibling' ? [pair[0], { ...pair[1], title: 'Unauthorized sibling edit' }] : mutation === 'order' ? [...pair].reverse() : [{ ...pair[0], id: 'TC-99' }, pair[1]]
    const draft = { ...planning.previous!, cases: changed }
    if (checkpoint) await planning.onDraft(draft)
    return draft
  } })
  await service.generate(1, project.id, 'fake')
  const initial = await service.detail(1, project.id)
  for (const value of ['sibling', 'order', 'identity'] as const) {
    mutation = value
    for (const onDraft of [false, true]) {
      checkpoint = onDraft
      const before = await service.detail(1, project.id)
      await assert.rejects(service.generate(1, project.id, 'fake', { mode: 'optimize', version: before.version, caseIds: ['TC-1'], reason: 'Fix only this case' }), code('INVALID_INPUT'))
      assert.deepEqual((await service.detail(1, project.id)).draft, initial.draft)
    }
  }
})

async function fixture(context: TestContext, model: PlanningModel = { generate: async () => result() }) {
  const root = await mkdtemp(join(tmpdir(), 'planning-service-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const repository = new FakeRepository()
  const service = new CasePlanningService(repository, root, model)
  const project = await service.create(1, input())
  return { root, repository, service, project }
}

test('planning accepts normal GitHub repository URLs and diagnoses invalid fields', async context => {
  const { service } = await fixture(context)
  for (const referenceRepository of ['https://github.com/owner/repo.name/', ' https://github.com/owner/repo.name.git ']) {
    const project = await service.create(1, { ...input(), referenceRepository, referenceBranch: ' main ' })
    assert.equal(project.input.referenceRepository, referenceRepository.trim().replace(/\/$/, ''))
    assert.equal(project.input.referenceBranch, 'main')
  }
  const blank = await service.create(1, { ...input(), referenceRepository: ' ', referenceBranch: ' ' })
  assert.equal(blank.input.referenceRepository, undefined)
  for (const referenceRepository of ['https://github.com/owner/repo/tree/main', 'https://token@github.com/owner/repo', 'https://github.com/owner/repo?token=secret', 'https://github.com/owner/../repo', 'https://127.0.0.1/owner/repo']) {
    await assert.rejects(service.create(1, { ...input(), referenceRepository }), (error: unknown) => error instanceof PlanningError && error.code === 'INVALID_INPUT' && error.field === 'referenceRepository')
  }
  await assert.rejects(service.create(1, { ...input(), title: '' }), (error: unknown) => error instanceof PlanningError && error.field === 'title')
})

test('planning clarification saves the real question and sanitized choices as waiting input', async context => {
  const { service, project, repository } = await fixture(context, { generate: async () => {
    throw new PlanningError('NEEDS_INPUT', undefined, { text: 'Clear password? token=raw-secret', choices: ['Clear password', 'Keep password raw-token'], allowFreeform: false })
  } })
  await assert.rejects(service.generate(1, project.id, 'raw-token'), code('NEEDS_INPUT'))
  const saved = await repository.get('project', project.id, 1)
  assert.equal(saved?.status, 'needs_input')
  assert.match(saved!.question!.text, /Clear password/)
  assert.deepEqual(saved!.question!.choices[0], 'Clear password')
  assert.equal(saved!.question!.allowFreeform, false)
  assert.doesNotMatch(JSON.stringify(saved), /raw-secret|raw-token/)
  await assert.rejects(service.publish(1, project.id), code('UNQUALIFIED'))
})

test('answers bind the current question and revision, clear old drafts and become fresh planning input', async context => {
  let attempt = 0
  const { service, project, repository } = await fixture(context, { generate: async received => {
    if (!attempt++) throw new PlanningError('NEEDS_INPUT', undefined, { text: 'Clear password?', choices: ['Clear', 'Keep'], allowFreeform: false })
    assert.match(received.instruction, /Clear password/)
    assert.match(received.instruction, /"answer":"Clear"/)
    return result()
  } })
  await assert.rejects(service.generate(1, project.id, 'fake'), code('NEEDS_INPUT'))
  const waiting = await service.detail(1, project.id)
  await assert.rejects(service.generate(1, project.id, 'fake'), code('CONFLICT'))
  await assert.rejects(service.answer(2, project.id, waiting.question!.id, 'Clear', waiting.version), code('NOT_FOUND'))
  await assert.rejects(service.answer(1, project.id, 'old-question', 'Clear', waiting.version), code('CONFLICT'))
  await assert.rejects(service.answer(1, project.id, waiting.question!.id, 'Clear', waiting.version - 1), code('CONFLICT'))
  await assert.rejects(service.answer(1, project.id, waiting.question!.id, 'Other', waiting.version), code('INVALID_INPUT'))
  const answered = await service.answer(1, project.id, waiting.question!.id, 'Clear', waiting.version)
  assert.equal(answered.status, 'draft')
  assert.equal(answered.question, undefined)
  assert.equal(answered.clarifications?.[0].answer, 'Clear')
  await assert.rejects(service.answer(1, project.id, waiting.question!.id, 'Clear', waiting.version), code('CONFLICT'))
  await service.generate(1, project.id, 'fake')
  assert.equal((await repository.get('project', project.id, 1))?.status, 'completed')
})

test('source-only planning checkpoints baseline and each batch without coding tasks or runtime fields', async context => {
  let observed = false
  const { root, repository, service, project } = await fixture(context, { generate: async (_input, planning) => {
    assert.equal((await repository.get('project', project.id, 1))?.status, 'running')
    assert.equal(planning.workspace, join(root, 'testing', 'planning', project.id, 'workspace'))
    assert.equal(await readFile(join(planning.workspace, 'requirements.txt'), 'utf8'), input().requirements)
    await planning.onDraft({ baseline, cases: [] })
    assert.equal((await repository.get('project', project.id, 1))?.draft?.baseline.length, 1)
    await planning.onDraft({ baseline, cases })
    assert.equal((await repository.get('project', project.id, 1))?.draft?.cases.length, 1)
    await planning.onProgress('token=do-not-store ghp_testsecret')
    observed = true
    return result()
  } })
  await service.generate(1, project.id, 'do-not-store')
  assert.equal(observed, true)
  const saved = await repository.get('project', project.id, 1)
  assert.equal(saved?.status, 'completed')
  assert.equal(repository.packageCreates, 0)
  assert.ok(!JSON.stringify(saved).includes('do-not-store'))
  assert.ok(!JSON.stringify(saved).includes('ghp_testsecret'))
  const published = await service.publish(1, project.id)
  assert.equal(published.revision, 1)
  assert.match(published.definitionFingerprint, /^[a-f0-9]{64}$/)
  assert.deepEqual(published.cases[0].assertions, cases[0].assertions)
  assert.ok(!('status' in published.cases[0]))
  assert.ok([...repository.rows.keys()].every(key => /^(project|package):/.test(key)))
})

test('same draft publication is idempotent and rerun creates a new immutable revision', async context => {
  const { repository, service, project } = await fixture(context)
  await service.generate(1, project.id, 'fake')
  const first = await service.publish(1, project.id)
  const repeated = await service.publish(1, project.id)
  assert.deepEqual(repeated, first)
  first.cases[0].assertions![0] = 'caller mutation'
  await service.generate(1, project.id, 'fake')
  const second = await service.publish(1, project.id)
  assert.notEqual(second.id, first.id)
  assert.equal(second.revision, 2)
  assert.equal(repository.packageCreates, 2)
  assert.deepEqual((await repository.get('package', first.id, 1))?.cases[0].assertions, cases[0].assertions)
})

test('failed generation retains partial draft and sanitizes errors', async context => {
  const { repository, service, project } = await fixture(context, { generate: async (_input, planning) => {
    await planning.onDraft({ baseline, cases })
    throw new Error('password=raw-secret token=raw-token')
  } })
  await assert.rejects(service.generate(1, project.id, 'raw-token'), code('MODEL_FAILED'))
  const saved = await repository.get('project', project.id, 1)
  assert.equal(saved?.status, 'failed')
  assert.equal(saved?.draft?.cases.length, 1)
  assert.ok(!JSON.stringify(saved).includes('raw-secret'))
  await assert.rejects(service.publish(1, project.id), code('UNQUALIFIED'))
  assert.equal(repository.packageCreates, 0)
})

test('qualified boolean without per-case completed reviews cannot publish', async context => {
  const { service, project, repository } = await fixture(context, { generate: async () => ({ ...result(), assessment: assessAcceptance(baseline, planningCases(cases)) }) })
  await assert.rejects(service.generate(1, project.id, 'fake'), code('UNQUALIFIED'))
  await assert.rejects(service.publish(1, project.id), code('UNQUALIFIED'))
  assert.equal(repository.packageCreates, 0)
})

test('duplicate cases and missing required scenario coverage are rejected', async context => {
  for (const invalid of [{ ...result(), cases: [...cases, ...cases] }, { ...result(), cases: [] }]) {
    const { service, project } = await fixture(context, { generate: async () => invalid })
    await assert.rejects(service.generate(1, project.id, 'fake'), code('UNQUALIFIED'))
    await assert.rejects(service.publish(1, project.id), code('UNQUALIFIED'))
  }
})

test('cross-instance generation CAS invokes only one model', async context => {
  let release!: () => void
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  const model: PlanningModel = { generate: async () => { calls++; started(); await gate; return result() } }
  const { root, repository, service, project } = await fixture(context, model)
  const other = new CasePlanningService(repository, root, model)
  const first = service.generate(1, project.id, 'fake')
  await ready
  await assert.rejects(other.generate(1, project.id, 'fake'), code('CONFLICT'))
  release()
  await first
  assert.equal(calls, 1)
})

test('parallel publishers reserve one package and converge on the same id', async context => {
  const { root, repository, service, project } = await fixture(context)
  await service.generate(1, project.id, 'fake')
  const other = new CasePlanningService(repository, root, { generate: async () => result() })
  const packages = await Promise.all([service.publish(1, project.id), other.publish(1, project.id)])
  assert.equal(packages[0].id, packages[1].id)
  assert.equal(repository.packageCreates, 1)
  assert.equal((await repository.get('project', project.id, 1))?.caseSetIds.length, 1)
})

test('failed package creation is retryable without consuming another revision', async context => {
  const { service, repository, project } = await fixture(context)
  await service.generate(1, project.id, 'fake')
  repository.failPackage = true
  await assert.rejects(service.publish(1, project.id), code('STORAGE_FAILED'))
  await assert.rejects(service.generate(1, project.id, 'fake'), code('CONFLICT'))
  repository.failPackage = false
  assert.equal((await service.publish(1, project.id)).revision, 1)
  assert.equal((await repository.get('project', project.id, 1))?.caseSetIds.length, 1)
})

test('cancel aborts the model signal and late callbacks cannot overwrite cancellation', async context => {
  let planning!: PlanningContext
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const { service, project, repository } = await fixture(context, { generate: async (_input, next) => {
    planning = next
    await next.onDraft({ baseline, cases })
    started()
    await new Promise<void>(resolve => next.signal.addEventListener('abort', () => resolve(), { once: true }))
    return result()
  } })
  const running = service.generate(1, project.id, 'fake')
  await ready
  assert.equal((await service.cancel(1, project.id)).status, 'cancelled')
  await assert.rejects(running, code('CANCELLED'))
  assert.equal(planning.signal.aborted, true)
  await assert.rejects(planning.onDraft({ baseline, cases: [] }))
  assert.equal((await repository.get('project', project.id, 1))?.draft?.cases.length, 1)
  assert.equal((await service.cancel(1, project.id)).status, 'cancelled')
})

test('owner isolation applies to every operation', async context => {
  const { service, project } = await fixture(context)
  await assert.rejects(service.generate(2, project.id, 'fake'), code('NOT_FOUND'))
  await assert.rejects(service.publish(2, project.id), code('NOT_FOUND'))
  await assert.rejects(service.cancel(2, project.id), code('NOT_FOUND'))
  await assert.rejects(service.cancel(1, '../escape'), code('NOT_FOUND'))
})

test('document hashes bind publication and attachments stay within storage root', async context => {
  const { service, root, repository } = await fixture(context)
  await mkdir(join(root, 'uploads'))
  await writeFile(join(root, 'uploads', 'requirements.md'), 'original')
  const source = { id: randomUUID(), name: 'requirements.md', kind: 'requirements' as const, sizeBytes: 8, sha256: createHash('sha256').update('original').digest('hex'), storageKey: 'uploads/requirements.md' }
  const project = await service.create(1, { ...input(), sources: [source] })
  await service.generate(1, project.id, 'fake')
  await writeFile(join(root, 'uploads', 'requirements.md'), 'modified')
  await assert.rejects(service.publish(1, project.id), code('SOURCE_CHANGED'))
  assert.equal(repository.packageCreates, 0)
  for (const storageKey of ['../outside', 'uploads/../outside', '.env', 'uploads\\requirements.md']) {
    await assert.rejects(service.create(1, { ...input(), sources: [{ ...source, storageKey }] }), code('INVALID_INPUT'))
  }
})

test('reference URLs reject credentials, shell syntax, local paths and unsafe branches before clone', async context => {
  const { service } = await fixture(context)
  for (const referenceRepository of ['https://token@github.com/owner/repo', 'file:///tmp/repo', 'https://127.0.0.1/repo', 'https://github.com/owner/repo;evil']) {
    await assert.rejects(service.create(1, { ...input(), referenceRepository }), code('INVALID_INPUT'))
  }
  await assert.rejects(service.create(1, { ...input(), referenceRepository: 'https://github.com/owner/repo', referenceBranch: '--upload-pack=evil' }), code('INVALID_INPUT'))
})

test('workspace document mutation invalidates generation and publication', async context => {
  const broken = await fixture(context, { generate: async (_input, planning) => {
    await writeFile(join(planning.workspace, 'requirements.txt'), 'different requirements')
    return result()
  } })
  await assert.rejects(broken.service.generate(1, broken.project.id, 'fake'), code('SOURCE_CHANGED'))
  const normal = await fixture(context)
  await normal.service.generate(1, normal.project.id, 'fake')
  await writeFile(join(normal.root, 'testing', 'planning', normal.project.id, 'workspace', 'instruction.txt'), 'changed')
  await assert.rejects(normal.service.publish(1, normal.project.id), code('SOURCE_CHANGED'))
})

test('package definitions strip every runtime field and preserve assertion order', async context => {
  const injected = { ...cases[0], status: 'passed', output: 'runtime output', startedAt: 'runtime time', executionBinding: { secret: 'binding' }, executionResult: { secret: 'runtime' }, testFile: 'runtime.spec.ts' }
  const { service, project } = await fixture(context, { generate: async () => ({ ...result(), cases: [injected] }) })
  await service.generate(1, project.id, 'fake')
  const published = await service.publish(1, project.id)
  for (const key of ['status', 'output', 'startedAt', 'finishedAt', 'evidenceInputFingerprint', 'executionBinding', 'executionResult', 'testFile']) assert.ok(!(key in published.cases[0]), key)
  assert.deepEqual(published.cases[0].assertions, cases[0].assertions)
})

function sdk(context: TestContext, reply: (config: SessionConfig, options: { prompt: string }, emit: (event: SessionEvent) => void) => Promise<string | undefined> | string | undefined) {
  const configs: SessionConfig[] = []
  const requests: { prompt: string; attachments?: unknown[] }[] = []
  let aborts = 0, disconnects = 0, stops = 0, listeners = 0
  context.mock.method(CopilotClient.prototype, 'start', async () => { assert.fail('real SDK startup is forbidden') })
  context.mock.method(CopilotClient.prototype, 'resumeSession', async () => { assert.fail('planning must never resume a session') })
  context.mock.method(CopilotClient.prototype, 'stop', async () => { stops++; return [] })
  context.mock.method(CopilotClient.prototype, 'createSession', async (config: SessionConfig) => {
    configs.push(config)
    const handlers = new Set<(event: SessionEvent) => void>()
    const emit = (event: SessionEvent) => { for (const handler of handlers) handler(event) }
    return {
      sessionId: `planning-session-${configs.length}`,
      on: (handler: (event: SessionEvent) => void) => { handlers.add(handler); listeners++; return () => { handlers.delete(handler); listeners-- } },
      send: async (options: { prompt: string; attachments?: unknown[] }) => {
        requests.push(options)
        const content = await reply(config, options, emit)
        if (content !== undefined) {
          emit({ type: 'assistant.message', data: { content } } as SessionEvent)
          emit({ type: 'session.idle', data: {} } as SessionEvent)
        }
        return 'fake-message'
      },
      abort: async () => { aborts++ }, disconnect: async () => { disconnects++ },
    }
  })
  return { configs, requests, get aborts() { return aborts }, get disconnects() { return disconnects }, get stops() { return stops }, get listeners() { return listeners } }
}

test('single-case production adapter makes one read-only request with full definition, requirements and saved issues', async context => {
  const { service, project, root, repository } = await fixture(context)
  await service.generate(1, project.id, 'fake')
  const saved = await service.detail(1, project.id)
  saved.draft!.assessment!.caseIssues = [{ caseId: 'TC-1', message: 'Verify database persistence' }, { caseId: 'TC-2', message: 'Unrelated sibling issue' }]
  saved.draft!.assessment!.issues = ['Unrelated sibling issue']
  repository.rows.set(`project:${project.id}`, { ownerId: 1, value: saved })
  const fake = sdk(context, (config, options) => {
    assert.deepEqual(config.availableTools, ['view', 'glob', 'grep', 'ask_user'])
    assert.match(options.prompt, /Requirements: Persist the saved name/)
    assert.match(options.prompt, /Saved case: /)
    assert.match(options.prompt, /Restore original name/)
    assert.match(options.prompt, /Verify database persistence/)
    assert.doesNotMatch(options.prompt, /Unrelated sibling issue/)
    assert.match(options.prompt, /Fix persistence/)
    assert.doesNotMatch(options.prompt, /independent design quality reviewer|Only PRD, design/)
    return JSON.stringify({ ...cases[0], title: 'Verify persisted database name' })
  })
  const adapter = new CasePlanningService(repository, root, new CopilotPlanningModel())
  for (const regenerate of [false, true]) {
    const before = await adapter.detail(1, project.id)
    await adapter.generate(1, project.id, 'fake', { mode: 'optimize', version: before.version, caseIds: ['TC-1'], reason: 'Fix persistence', regenerate })
    const after = await adapter.detail(1, project.id)
    assert.equal(after.status, 'draft')
    assert.equal(after.draft!.assessment, undefined)
    assert.equal(after.draft!.cases[0].id, 'TC-1')
    if (!regenerate) {
      after.draft!.assessment = saved.draft!.assessment
      repository.rows.set(`project:${project.id}`, { ownerId: 1, value: after })
    }
  }
  assert.match(fake.requests[0].prompt, /Optimize this single/)
  assert.match(fake.requests[1].prompt, /Regenerate this single/)
  assert.equal(fake.configs.length, 2)
  assert.equal(fake.stops, 2)
  assert.equal(fake.disconnects, 2)
  assert.equal(fake.listeners, 0)
})

test('single-case production adapter rejects invalid JSON and definitions without replacing the saved checkpoint', async context => {
  const { service, project, root, repository } = await fixture(context)
  await service.generate(1, project.id, 'fake')
  let output = ''
  const fake = sdk(context, () => output)
  const adapter = new CasePlanningService(repository, root, new CopilotPlanningModel())
  const invalid = ['not JSON', JSON.stringify(cases), JSON.stringify({ ...cases[0], id: 'TC-2' }), JSON.stringify({ ...cases[0], status: 'passed' }), JSON.stringify({ ...cases[0], assertions: [] })]
  for (const content of invalid) {
    output = content
    const before = await adapter.detail(1, project.id)
    await assert.rejects(adapter.generate(1, project.id, 'fake', { mode: 'optimize', version: before.version, caseIds: ['TC-1'], reason: 'Fix' }), code('INVALID_INPUT'))
    assert.deepEqual((await adapter.detail(1, project.id)).draft, before.draft)
  }
  assert.equal(fake.configs.length, invalid.length)
  assert.equal(fake.listeners, 0)
})

test('parallel single-case edits use CAS so only one replacement wins', async context => {
  const { service, project, root, repository } = await fixture(context)
  await service.generate(1, project.id, 'fake')
  const saved = await service.detail(1, project.id)
  const other = new CasePlanningService(repository, root)
  const results = await Promise.allSettled([
    service.editCase(1, project.id, 'TC-1', saved.version, { ...cases[0], title: 'First edit' }),
    other.editCase(1, project.id, 'TC-1', saved.version, { ...cases[0], title: 'Second edit' }),
  ])
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1)
  const rejected = results.find(item => item.status === 'rejected') as PromiseRejectedResult
  assert.ok(code('CONFLICT')(rejected.reason))
  assert.equal((await service.detail(1, project.id)).version, saved.version + 1)
})

test('production adapter corrects object-shaped baseline scenarios once before generating cases', async context => {
  let baselineCalls = 0
  const fake = sdk(context, (_config, options) => {
    if (options.prompt.includes('Only PRD, design')) {
      assert.match(options.prompt, /"scenarios":\["normal","negative"\]/)
      if (!baselineCalls++) return JSON.stringify(baseline.map(item => ({ ...item, scenarios: { normal: ['Persist the saved name'] } })))
      assert.match(options.prompt, /FORMAT CORRECTION ONLY/)
      assert.match(options.prompt, /Preserve every requirement/)
      assert.match(options.prompt, /"normal":\["Persist the saved name"\]/)
      return JSON.stringify(baseline)
    }
    if (options.prompt.includes('independent design quality reviewer')) return '{"qualified":true,"issues":[],"caseIssues":[]}'
    return JSON.stringify(cases.map(item => ({ ...item, classification: { testType: 'functional', tags: [], priority: 'P1', riskReason: 'Persistent account data', executionPolicy: 'always' } })))
  })
  const { service, project, repository } = await fixture(context, new CopilotPlanningModel())
  await service.generate(1, project.id, 'fake')
  const saved = await repository.get('project', project.id, 1)
  assert.equal(saved?.status, 'completed')
  assert.deepEqual(saved?.draft?.baseline, baseline)
  assert.equal(baselineCalls, 2)
  assert.equal(fake.configs.length, 4)
  assert.ok(saved?.events.some(event => /one format correction/.test(event.text)))
  assert.equal(fake.listeners, 0)
})

test('production adapter rejects repeatedly invalid baseline without generating cases or exposing raw output', async context => {
  const fake = sdk(context, (_config, options) => {
    assert.match(options.prompt, /Only PRD, design/)
    return JSON.stringify(baseline.map(item => ({ ...item, scenarios: { unknown: ['token=raw-baseline-secret'] } })))
  })
  const { service, project, repository } = await fixture(context, new CopilotPlanningModel())
  await assert.rejects(service.generate(1, project.id, 'fake'), code('BASELINE_INVALID'))
  const saved = await repository.get('project', project.id, 1)
  assert.equal(saved?.status, 'failed')
  assert.equal(saved?.draft, undefined)
  assert.equal(fake.configs.length, 2)
  assert.doesNotMatch(JSON.stringify(saved), /raw-baseline-secret|Planning model failed/)
  assert.match(saved!.error!, /baseline output is invalid/)
  assert.equal(fake.listeners, 0)
})

test('baseline format correction preserves clarification and model-call failure categories', async context => {
  let calls = 0
  sdk(context, async config => {
    if (!calls++) return '{"not":"an array"}'
    await config.onUserInputRequest!({ question: 'Confirm password policy?', choices: ['Clear', 'Keep'], allowFreeform: false } as never, {} as never)
    return undefined
  })
  const { service, project } = await fixture(context, new CopilotPlanningModel())
  await assert.rejects(service.generate(1, project.id, 'fake'), code('NEEDS_INPUT'))
  const waiting = await service.detail(1, project.id)
  assert.equal(waiting.status, 'needs_input')
  assert.equal(waiting.question?.text, 'Confirm password policy?')
  assert.equal(calls, 2)
})

test('production adapter uses fresh baseline/generation/review sessions and read-only permissions', async context => {
  const fake = sdk(context, (_config, options) => {
    if (options.prompt.includes('Only PRD, design')) return JSON.stringify(baseline)
    if (options.prompt.includes('independent design quality reviewer')) return '{"qualified":true,"issues":[],"caseIssues":[]}'
    return JSON.stringify(cases.map(item => ({ ...item, classification: { testType: 'functional', tags: ['regression'], priority: 'P1', riskReason: 'Persistent account data', executionPolicy: 'always' } })))
  })
  const { service, project, root, repository } = await fixture(context, new CopilotPlanningModel())
  await service.generate(1, project.id, 'fake')
  const published = await service.publish(1, project.id)
  assert.equal(published.assessment.status, 'qualified')
  assert.equal(fake.configs.length, 3)
  assert.equal(fake.disconnects, 3)
  assert.equal(fake.stops, 3)
  assert.equal(fake.listeners, 0)
  assert.ok(repository.history.some(item => item.draft?.baseline.length && !item.draft.cases.length))
  assert.ok(repository.history.some(item => item.draft?.assessment?.caseReviews?.some(review => review.status === 'unreviewed')))
  const saved = await service.detail(1, project.id)
  const activities = saved.events.filter(event => event.text.startsWith('Model progress: Planning activity: '))
  assert.ok(activities.length >= 3)
  assert.ok(activities.some(event => event.text.includes('正在发送请求')))
  assert.ok(activities.some(event => event.text.includes('模型已返回消息')))
  assert.ok(saved.events.some(event => /用例批次 1：/.test(event.text)))
  assert.ok(saved.events.some(event => /用例批次 1已保存/.test(event.text)))
  for (const config of fake.configs) {
    assert.deepEqual(config.availableTools, ['view', 'glob', 'grep', 'ask_user'])
    assert.equal(config.model, 'auto')
    const permission = config.onPermissionRequest!
    for (const kind of ['shell', 'write', 'url', 'custom-tool']) assert.notEqual((await permission({ kind } as never, {} as never)).kind, 'approve-once')
    assert.equal((await permission({ kind: 'read', path: join(root, 'testing', 'planning', project.id, 'workspace', 'requirements.txt') } as never, {} as never)).kind, 'approve-once')
    assert.notEqual((await permission({ kind: 'read', path: join(root, '.env') } as never, {} as never)).kind, 'approve-once')
    assert.notEqual((await permission({ kind: 'read', path: join(root, 'testing', 'planning', project.id, 'workspace', 'requirements.txt'), requestSandboxBypass: true } as never, {} as never)).kind, 'approve-once')
    assert.equal((await config.hooks!.onPreToolUse!({ toolName: 'bash', toolArgs: { command: 'echo bad' } } as never, {} as never))?.permissionDecision, 'deny')
  }
  assert.ok(fake.requests.every(request => Array.isArray(request.attachments)))
})

test('production adapter captures clarification in the pre-tool hook before user-input callbacks', async context => {
  const fake = sdk(context, async config => {
    const outcome = await config.hooks!.onPreToolUse!({ toolName: 'ask_user', toolArgs: { question: 'Which password policy?', choices: ['Clear', 'Keep'], allowFreeform: false } } as never, {} as never)
    assert.equal(outcome?.permissionDecision, 'deny')
    return undefined
  })
  const { service, project } = await fixture(context, new CopilotPlanningModel())
  await assert.rejects(service.generate(1, project.id, 'fake'), code('NEEDS_INPUT'))
  const waiting = await service.detail(1, project.id)
  assert.equal(waiting.status, 'needs_input')
  assert.equal(waiting.question!.text, 'Which password policy?')
  assert.deepEqual(waiting.question!.choices, ['Clear', 'Keep'])
  assert.equal(waiting.question!.allowFreeform, false)
  assert.equal(fake.listeners, 0)
})

test('production adapter clarification fails promptly and removes waiter listeners without idle', async context => {
  const fake = sdk(context, async config => {
    await assert.rejects(async () => config.onUserInputRequest!({ question: 'Ambiguous?', choices: [], allowFreeform: true } as never, {} as never), code('NEEDS_INPUT'))
    return undefined
  })
  const { service, project, repository } = await fixture(context, new CopilotPlanningModel())
  await assert.rejects(service.generate(1, project.id, 'fake'), code('NEEDS_INPUT'))
  assert.ok(fake.aborts > 0)
  assert.equal(fake.listeners, 0)
  assert.equal(fake.disconnects, 1)
  assert.equal((await repository.get('project', project.id, 1))?.status, 'needs_input')
  assert.equal((await repository.get('project', project.id, 1))?.question?.text, 'Ambiguous?')
})

test('cross-instance cancellation aborts SDK and removes waiter listeners without idle', async context => {
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const fake = sdk(context, () => { started(); return undefined })
  const { service, project, root, repository } = await fixture(context, new CopilotPlanningModel())
  const running = service.generate(1, project.id, 'fake')
  await ready
  await new CasePlanningService(repository, root).cancel(1, project.id)
  await assert.rejects(running, code('CANCELLED'))
  assert.ok(fake.aborts > 0)
  assert.equal(fake.listeners, 0)
  assert.equal(fake.disconnects, 1)
})

test('planning environment excludes secrets and reading paths cannot escape source workspace', async context => {
  const { root } = await fixture(context)
  await writeFile(join(root, 'requirements.txt'), 'safe')
  await writeFile(join(root, '.env'), 'secret')
  assert.equal(await planningReadPath(root, join(root, 'requirements.txt')), true)
  assert.equal(await planningReadPath(root, join(root, '.env')), false)
  assert.equal(await planningReadPath(root, join(root, '..')), false)
  assert.ok(Object.keys(planningEnvironment()).every(key => /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|HOME|USERPROFILE|LOCALAPPDATA|APPDATA|COMSPEC|LANG|LC_ALL)$/i.test(key)))
})

test('real memory repository accepts canonical project and immutable package snapshots', async context => {
  const { root } = await fixture(context)
  const repository = new MemoryTestingRepository()
  const service = new CasePlanningService(repository, root, { generate: async (_input, planning) => {
    await planning.onDraft({ baseline, cases })
    return result()
  } })
  const project = await service.create(1, input())
  await service.generate(1, project.id, 'fake')
  const first = await service.publish(1, project.id)
  assert.deepEqual(await service.publish(1, project.id), first)
  await service.generate(1, project.id, 'fake')
  assert.equal((await service.publish(1, project.id)).revision, 2)
  assert.equal((await repository.list('package', 1)).length, 2)
  assert.equal(await repository.get('package', first.id, 2), undefined)
})

test('production multi-batch review failure retains generated cases and completed review checkpoints', async context => {
  const requirements: AcceptanceRequirement[] = Array.from({ length: 17 }, (_item, index) => ({ ...baseline[0], id: `REQ-${String(index + 1).padStart(3, '0')}` }))
  let generated = 0, reviewed = 0
  const fake = sdk(context, (_config, options) => {
    if (options.prompt.includes('Only PRD, design')) return JSON.stringify(requirements)
    if (options.prompt.includes('independent design quality reviewer')) {
      if (++reviewed === 2) throw new Error('token=never-save-this')
      return '{"qualified":true,"issues":[],"caseIssues":[]}'
    }
    const batch = requirements.slice(generated, generated + 8)
    generated += batch.length
    return JSON.stringify(batch.map(requirement => ({
      ...cases[0], id: `TC-${requirement.id.slice(4)}`, requirementIds: [requirement.id],
      classification: { testType: 'functional', tags: [], priority: 'P1', riskReason: 'Account persistence', executionPolicy: 'always' },
    })))
  })
  const { service, project, repository } = await fixture(context, new CopilotPlanningModel())
  await assert.rejects(service.generate(1, project.id, 'fake'), code('MODEL_FAILED'))
  const saved = await repository.get('project', project.id, 1)
  assert.equal(saved?.draft?.cases.length, 17)
  assert.equal(saved?.draft?.assessment?.caseReviews?.filter(review => review.status === 'qualified').length, 8)
  assert.ok(repository.history.some(item => item.draft?.cases.length === 8))
  assert.ok(repository.history.some(item => item.draft?.cases.length === 16))
  assert.ok(!JSON.stringify(saved).includes('never-save-this'))
  assert.equal(fake.configs.length, 6)
  assert.equal(fake.disconnects, 6)
  assert.equal(fake.listeners, 0)
  await assert.rejects(service.publish(1, project.id), code('UNQUALIFIED'))
  const before = fake.configs.length
  await service.generate(1, project.id, 'fake', { mode: 'review', version: saved!.version })
  const resumed = await service.detail(1, project.id)
  assert.equal(resumed.status, 'completed')
  assert.equal(resumed.draft?.cases.length, 17)
  assert.equal(fake.configs.length - before, 2)
  assert.equal(resumed.draft?.reviewBatches?.length, 3)
  assert.equal((await service.publish(1, project.id)).cases.length, 17)
})

test('continue preserves generated cases and only requests missing coverage after a model failure', async context => {
  const requirements: AcceptanceRequirement[] = Array.from({ length: 9 }, (_item, index) => ({ ...baseline[0], id: `REQ-${String(index + 1).padStart(3, '0')}` }))
  let generated = 0, failed = false, baselineCalls = 0
  sdk(context, (_config, options) => {
    if (options.prompt.includes('Only PRD, design')) { baselineCalls++; return JSON.stringify(requirements) }
    if (options.prompt.includes('independent design quality reviewer')) return '{"qualified":true,"issues":[],"caseIssues":[]}'
    if (generated === 8 && !failed) { failed = true; throw new Error('temporary failure') }
    const batch = requirements.slice(generated, generated + 8)
    generated += batch.length
    return JSON.stringify(batch.map(requirement => ({ ...cases[0], id: `TC-${requirement.id.slice(4)}`, requirementIds: [requirement.id], classification: { testType: 'functional', tags: [], priority: 'P1', riskReason: 'Account persistence', executionPolicy: 'always' } })))
  })
  const { service, project } = await fixture(context, new CopilotPlanningModel())
  await assert.rejects(service.generate(1, project.id, 'fake'), code('MODEL_FAILED'))
  const partial = await service.detail(1, project.id)
  assert.equal(partial.draft?.cases.length, 8)
  await assert.rejects(service.generate(2, project.id, 'fake', { mode: 'continue', version: partial.version }), code('NOT_FOUND'))
  await assert.rejects(service.generate(1, project.id, 'fake', { mode: 'continue', version: partial.version - 1 }), code('CONFLICT'))
  await service.generate(1, project.id, 'fake', { mode: 'continue', version: partial.version })
  const resumed = await service.detail(1, project.id)
  assert.equal(resumed.status, 'completed')
  assert.deepEqual(resumed.draft!.cases.slice(0, 8), partial.draft!.cases)
  assert.equal(resumed.draft!.cases.length, 9)
  assert.equal(baselineCalls, 1)
})

test('scoped review leaves full assessment unchanged and rejected review can be retried without generation', async context => {
  let reject = true, generated = 0
  const fake = sdk(context, (_config, options) => {
    if (options.prompt.includes('Only PRD, design')) return JSON.stringify(baseline)
    if (options.prompt.includes('independent design quality reviewer')) return reject ? '{"qualified":false,"issues":["Missing assertion"],"caseIssues":[]}' : '{"qualified":true,"issues":[],"caseIssues":[]}'
    generated++
    return JSON.stringify(cases.map(item => ({ ...item, classification: { testType: 'functional', tags: [], priority: 'P1', riskReason: 'Account persistence', executionPolicy: 'always' } })))
  })
  const { service, project, root, repository } = await fixture(context, new CopilotPlanningModel())
  await assert.rejects(service.generate(1, project.id, 'fake'), code('UNQUALIFIED'))
  let saved = await service.detail(1, project.id)
  const originalAssessment = structuredClone(saved.draft!.assessment)
  reject = false
  await service.generate(1, project.id, 'fake', { mode: 'review', version: saved.version, caseIds: [saved.draft!.cases[0].id], reason: 'Review login scope' })
  saved = await service.detail(1, project.id)
  assert.deepEqual(saved.draft!.assessment, originalAssessment)
  assert.equal(saved.draft!.customReview?.assessment?.status, 'qualified')
  await assert.rejects(service.publish(1, project.id), code('UNQUALIFIED'))
  const scoped = await service.publishScope(1, project.id, saved.version, saved.draft!.customReview!.caseIds, saved.draft!.customReview!.reason)
  assert.equal(scoped.assessment.status, 'qualified')
  assert.deepEqual(scoped.scope!.caseIds, saved.draft!.customReview!.caseIds)
  assert.deepEqual((await service.detail(1, project.id)).draft!.assessment, originalAssessment)
  assert.equal((await service.detail(1, project.id)).status, 'draft')
  saved = await service.detail(1, project.id)
  const before = fake.configs.length
  await service.generate(1, project.id, 'fake', { mode: 'review', version: saved.version })
  saved = await service.detail(1, project.id)
  assert.equal(saved.status, 'completed')
  assert.equal(fake.configs.length - before, 1)
  assert.equal(generated, 1)
  assert.deepEqual(saved.draft?.assessment?.issues, [])
  const full = await service.publish(1, project.id)
  assert.equal(full.revision, scoped.revision + 1)
  assert.equal(full.scope, undefined)
  assert.deepEqual(await repository.get('package', scoped.id, 1), scoped)
  saved = await service.detail(1, project.id)
  await writeFile(join(root, 'testing', 'planning', project.id, 'workspace', 'requirements.txt'), 'changed')
  await assert.rejects(service.generate(1, project.id, 'fake', { mode: 'review', version: saved.version }), code('SOURCE_CHANGED'))
  assert.equal((await service.detail(1, project.id)).status, 'completed')
})

test('production scoped review normalizes detailed rejection and excludes unselected case index', async context => {
  const pair = [cases[0], { ...cases[0], id: 'TC-2', title: 'Unselected old design failure' }]
  const { service, root, repository, project } = await fixture(context, { generate: async () => ({ baseline, cases: pair, assessment: applyQualityReview(assessAcceptance(baseline, planningCases(pair)), '{"qualified":true,"issues":[],"caseIssues":[]}', ['TC-1', 'TC-2']) }) })
  await service.generate(1, project.id, 'fake')
  const saved = await service.detail(1, project.id)
  const original = structuredClone(saved.draft!.assessment)
  const fake = sdk(context, (_config, options) => {
    assert.match(options.prompt, /Only evaluate the selected cases/)
    assert.doesNotMatch(options.prompt, /Unselected old design failure|"id":"TC-2"/)
    return '{"qualified":false,"issues":[],"caseIssues":[{"caseId":"TC-1","message":"Fix the assertion"}]}'
  })
  const adapter = new CasePlanningService(repository, root, new CopilotPlanningModel())
  await adapter.generate(1, project.id, 'fake', { mode: 'review', version: saved.version, caseIds: ['TC-1'], reason: 'Only selected' })
  const reviewed = await adapter.detail(1, project.id)
  assert.equal(reviewed.status, 'completed')
  assert.deepEqual(reviewed.draft!.assessment, original)
  assert.deepEqual(reviewed.draft!.customReview!.assessment!.caseReviews, [{ caseId: 'TC-1', status: 'rejected' }])
  assert.deepEqual(reviewed.draft!.customReview!.batches[0].result.issues, ['TC-1：Fix the assertion'])
  assert.equal(fake.requests.length, 1)
})

test('production invalid review contract is saved as review format failure, never model call failure', async context => {
  const { service, root, repository, project } = await fixture(context)
  await service.generate(1, project.id, 'fake')
  const saved = await service.detail(1, project.id)
  sdk(context, () => '{"qualified":false,"issues":[],"caseIssues":[]}')
  const adapter = new CasePlanningService(repository, root, new CopilotPlanningModel())
  await assert.rejects(adapter.generate(1, project.id, 'fake', { mode: 'review', version: saved.version, caseIds: ['TC-1'], reason: 'Only selected' }), code('REVIEW_INVALID'))
  const rejected = await adapter.detail(1, project.id)
  assert.equal(rejected.status, 'failed')
  assert.match(rejected.error!, /review response format invalid/)
  assert.doesNotMatch(rejected.error!, /model failed/)
  assert.deepEqual(rejected.draft!.cases, saved.draft!.cases)
})

test('storage read failures expose only typed safe errors', async context => {
  const { service, project, repository } = await fixture(context)
  await service.generate(1, project.id, 'fake')
  const original = repository.get.bind(repository)
  context.mock.method(repository, 'get', async (kind: TestingRecordKind, id: string, ownerId: number) => {
    if (kind === 'package') throw new Error('mysql://user:raw-password@private-host')
    return original(kind, id, ownerId)
  })
  await assert.rejects(service.publish(1, project.id), error => code('STORAGE_FAILED')(error) && !String(error).includes('raw-password'))
})

test('legacy source-only drafts retain cases but never reuse unbound review batches', async context => {
  const fake = sdk(context, (_config, options) => {
    if (options.prompt.includes('Only PRD, design')) return JSON.stringify(baseline)
    if (options.prompt.includes('independent design quality reviewer')) return '{"qualified":true,"issues":[],"caseIssues":[]}'
    return JSON.stringify(cases.map(item => ({ ...item, classification: { testType: 'functional', tags: [], priority: 'P1', riskReason: 'Account persistence', executionPolicy: 'always' } })))
  })
  const { service, repository, project } = await fixture(context, new CopilotPlanningModel())
  await service.generate(1, project.id, 'fake')
  let saved = await service.detail(1, project.id)
  const original = structuredClone(saved.draft!.cases)
  delete saved.draft!.sourceFingerprint
  await repository.replace('project', { ...saved, version: saved.version + 1 }, saved.version, 1)
  await assert.rejects(service.generate(1, project.id, 'fake', { mode: 'review', version: saved.version + 1 }), code('SOURCE_CHANGED'))
  saved = await service.detail(1, project.id)
  delete saved.draft!.definitionFingerprint
  await repository.replace('project', { ...saved, version: saved.version + 1 }, saved.version, 1)
  const count = fake.configs.length
  await service.generate(1, project.id, 'fake', { mode: 'continue', version: saved.version + 1 })
  const resumed = await service.detail(1, project.id)
  assert.deepEqual(resumed.draft!.cases, original)
  assert.equal(fake.configs.length - count, 1)
  assert.ok(resumed.draft!.sourceFingerprint)
  assert.ok(resumed.draft!.definitionFingerprint)
})