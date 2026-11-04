import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { CopilotClient, type SessionConfig, type SessionEvent } from '@github/copilot-sdk'
import type { CasePackage, PlanningProject } from '../../shared/testing.js'
import { importCasePackage, materializeImportedPackage, type PackageImportReview } from './package-import.js'
import { PlanningError, planningDigest, planningRulesVersion } from './planning-model.js'
import { createTestingRepository, MemoryTestingRepository } from './repository.js'
import { TestExecutionService } from './execution-service.js'
import { CasePlanningService } from './planning-service.js'
import { packageInputFingerprint } from './scoped-package.js'

const accepted: PackageImportReview = async () => '{"qualified":true,"issues":[],"caseIssues":[]}'
const code = (expected: string) => (error: unknown) => error instanceof PlanningError && error.code === expected

test('scoped external import independently reviews, preserves canonical scope and cannot become default publication', async context => {
  const { root, repository } = await fixture(context)
  const original = value()
  original.baseline[0].required = false
  original.baseline[0].scenarios.push('negative')
  original.scope = { mode: 'custom', caseIds: ['TC-1'], reason: 'Selected behavior only', originalDefinitionFingerprint: planningDigest('original-full-definition') }
  let calls = 0
  const imported = await importCasePackage(repository, root, 7, original, '', async review => { calls++; return accepted(review) })
  assert.equal(calls, 1)
  assert.deepEqual(imported.scope, original.scope)
  assert.deepEqual(imported.baseline, original.baseline)
  assert.equal(imported.assessment.inputFingerprint, packageInputFingerprint(imported))
  const project = (await repository.get('project', imported.projectId, 7))!
  assert.equal(project.status, 'draft')
  const service = new TestExecutionService(repository, root)
  const executionInput = { title: 'Scoped execution', caseSetId: imported.id, repository: 'https://github.com/example/project' }
  await assert.rejects(service.create(7, { ...executionInput, scope: { mode: 'default', caseIds: [], reason: '' } }), { code: 'INVALID_INPUT' })
  const run = await service.create(7, { ...executionInput, scope: { mode: 'custom', caseIds: original.scope.caseIds, reason: original.scope.reason } })
  assert.deepEqual(run.input.scope.caseIds, ['TC-1'])
  await repository.replace('project', { ...project, status: 'completed', version: project.version + 1 }, project.version, 7)
  await assert.rejects(new CasePlanningService(repository, root).publish(7, project.id), code('UNQUALIFIED'))
  await assert.rejects(importCasePackage(repository, root, 8, original, '', async () => '{"qualified":false,"issues":["Ambiguous"],"caseIssues":[]}'), code('UNQUALIFIED'))
})

test('scoped imports reject metadata broadening and recover the same durable package reservation', async context => {
  const { root, repository } = await fixture(context)
  const original = value()
  original.baseline[0].required = false
  original.scope = { mode: 'custom', caseIds: ['TC-1'], reason: 'Selected only', originalDefinitionFingerprint: planningDigest('full') }
  for (const mutate of [
    (item: CasePackage) => { item.scope!.caseIds.push('TC-999') },
    (item: CasePackage) => { item.scope!.caseIds.push('TC-1') },
    (item: CasePackage) => { item.scope!.reason = ' ' },
    (item: CasePackage) => { item.scope!.originalDefinitionFingerprint = 'forged' },
    (item: CasePackage) => { item.baseline[0].required = true },
    (item: CasePackage) => { item.baseline.push({ ...item.baseline[0], id: 'REQ-002' }) },
    (item: CasePackage) => { (item.scope as any).mode = 'default' },
    (item: CasePackage) => { (item.scope as any).fullCoverage = true },
  ]) {
    const invalid = structuredClone(original)
    mutate(invalid)
    await assert.rejects(importCasePackage(repository, root, 7, invalid, '', async () => { assert.fail('No review for invalid scope') }), code('INVALID_INPUT'))
  }
  const create = repository.create.bind(repository)
  repository.create = async (kind, item, owner) => { if (kind === 'package') throw new Error('Injected failure'); return create(kind, item, owner) }
  await assert.rejects(importCasePackage(repository, root, 7, original, '', accepted), code('STORAGE_FAILED'))
  const [reserved] = await repository.list('project', 7)
  assert.equal(reserved.status, 'draft')
  const planner = new CasePlanningService(repository, root)
  await assert.rejects(planner.editCase(7, reserved.id, 'TC-1', reserved.version, { ...original.cases[0], title: 'Changed' }), code('CONFLICT'))
  await assert.rejects(planner.generate(7, reserved.id, 'fake'), code('CONFLICT'))
  await assert.rejects(planner.cancel(7, reserved.id), code('CONFLICT'))
  repository.create = create
  const recovered = await importCasePackage(repository, root, 7, original, '', async () => { assert.fail('Reuse completed scoped import review') })
  assert.equal(recovered.id, reserved.caseSetIds[0])
  assert.deepEqual(recovered.scope, original.scope)
  assert.equal((await repository.list('package', 7)).length, 1)
})
const value = (): CasePackage => ({
  schemaVersion: 1, id: randomUUID(), projectId: randomUUID(), revision: 19, createdAt: new Date().toISOString(), sourceFingerprint: 'external-source', definitionFingerprint: 'forged', rulesVersion: 'external', modelId: 'external-model',
  baseline: [{ id: 'REQ-001', source: '/external/requirements.pdf', criterion: 'Save name durably', required: true, scenarios: ['normal'] }],
  cases: [{ id: 'TC-1', title: 'Save name', source: '/external/requirements.pdf', steps: 'Save a new name and reload', expected: 'The saved name remains', requirementIds: ['REQ-001'], scenario: 'normal', preconditions: 'An existing account', testData: 'A new name', assertions: ['Saved name remains after reload'], cleanup: 'Restore original name' }],
  assessment: { status: 'qualified', checkedAt: new Date().toISOString(), issues: [], coveredIds: ['REQ-001'], missingIds: [], inputFingerprint: 'forged', caseReviews: [{ caseId: 'TC-1', status: 'qualified' }] },
})

async function fixture(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'package-import-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  return { root, repository: new MemoryTestingRepository() }
}

async function pendingImport(context: TestContext) {
  const { root, repository } = await fixture(context)
  const original = value()
  const create = repository.create.bind(repository)
  repository.create = async (kind, item, owner) => {
    if (kind === 'package') throw new Error('Injected publication failure')
    return create(kind, item, owner)
  }
  await assert.rejects(importCasePackage(repository, root, 7, original, '', accepted), code('STORAGE_FAILED'))
  repository.create = create
  const [project] = await repository.list('project', 7)
  return { root, repository, original, project }
}

test('import preserves definitions, creates owned lineage and independently fingerprints a fresh review', async context => {
  const { root, repository } = await fixture(context)
  const original = value(), snapshot = structuredClone(original)
  original.assessment.status = 'rejected'
  original.assessment.issues = ['External assessment must be discarded']
  let calls = 0
  const imported = await importCasePackage(repository, root, 7, original, 'private-token', async review => {
    calls++
    assert.equal(review.token, 'private-token')
    assert.equal(review.modelId, 'auto')
    assert.match(review.prompt, /Preserve every imported definition/)
    assert.match(review.prompt, /Missing runner\/test file\/URL\/actual environment is not a design failure/)
    assert.doesNotMatch(review.prompt, /External assessment must be discarded|external-model|private-token/)
    assert.ok(review.prompt.includes(JSON.stringify(original.cases)))
    assert.equal((await repository.list('project', 7))[0].status, 'running')
    assert.match(await readFile(join(review.workspace, 'requirements.txt'), 'utf8'), new RegExp(planningDigest(original)))
    return accepted(review)
  })
  assert.equal(calls, 1)
  assert.notEqual(imported.id, original.id)
  assert.notEqual(imported.projectId, original.projectId)
  assert.equal(imported.revision, 1)
  assert.deepEqual(imported.cases, snapshot.cases)
  assert.deepEqual(imported.baseline, snapshot.baseline)
  assert.equal(imported.rulesVersion, planningRulesVersion)
  assert.equal(imported.definitionFingerprint, planningDigest({ baseline: imported.baseline, cases: imported.cases }))
  assert.equal(imported.assessment.inputFingerprint, planningDigest({ sourceFingerprint: imported.sourceFingerprint, definitionFingerprint: imported.definitionFingerprint, rulesVersion: planningRulesVersion }))
  const project = (await repository.get('project', imported.projectId, 7))!
  assert.equal(project.status, 'completed')
  assert.deepEqual(project.caseSetIds, [imported.id])
  assert.deepEqual(project.draft?.assessment, imported.assessment)
  assert.deepEqual(project.input.sources, [])
  assert.equal(project.input.referenceRepository, undefined)
  assert.equal(await repository.get('package', imported.id, 8), undefined)
  const repeated = await importCasePackage(repository, root, 7, original, '', accepted)
  assert.notEqual(repeated.sourceFingerprint, imported.sourceFingerprint)
  assert.notEqual(repeated.id, imported.id)
  assert.deepEqual(original.cases, snapshot.cases)
})

test('external qualified claims never bypass rejection; failed draft retains review issues', async context => {
  const { root, repository } = await fixture(context)
  const original = value()
  await assert.rejects(importCasePackage(repository, root, 7, original, '', async () => JSON.stringify({ qualified: false, issues: ['Persistence expectation is ambiguous'], caseIssues: [{ caseId: 'TC-1', message: 'Specify durable storage observable behavior' }] })), code('UNQUALIFIED'))
  const [project] = await repository.list('project', 7)
  assert.equal(project.status, 'failed')
  assert.deepEqual(project.caseSetIds, [])
  assert.deepEqual(project.draft?.cases, original.cases)
  assert.equal(project.draft?.assessment?.status, 'rejected')
  assert.ok(project.draft?.assessment?.issues.includes('Persistence expectation is ambiguous'))
  assert.equal((await repository.list('package', 7)).length, 0)
})

test('strict runtime schema rejects malformed arrays and execution evidence without model or storage', async context => {
  const { root, repository } = await fixture(context)
  for (const mutate of [
    (item: Record<string, any>) => { item.schemaVersion = 2 },
    (item: Record<string, any>) => { item.baseline[0].required = 'yes' },
    (item: Record<string, any>) => { item.cases[0].requirementIds = 'REQ-001' },
    (item: Record<string, any>) => { item.cases[0].assertions = { length: 1 } },
    (item: Record<string, any>) => { item.cases[0].status = 'passed' },
    (item: Record<string, any>) => { item.cases[0].testFile = '../../secret.spec.ts' },
    (item: Record<string, any>) => { item.cases[0].executionBinding = { approvedBy: '7' } },
    (item: Record<string, any>) => { item.cases[0].classification = { testType: {}, priority: 'P0' } },
    (item: Record<string, any>) => { item.cases[0].classification = { testType: ['functional'], priority: 'P0', executionPolicy: 'always', tags: [], riskReason: 'Persistence' } },
    (item: Record<string, any>) => { item.cases[0].scenario = ['normal'] },
    (item: Record<string, any>) => { item.baseline[0].id = ['REQ-001'] },
  ]) {
    const original = value()
    mutate(original)
    await assert.rejects(importCasePackage(repository, root, 7, original, '', async () => { assert.fail('No model calls for invalid schema') }), code('INVALID_INPUT'))
  }
  assert.deepEqual(await repository.list('project', 7), [])
})

test('structural coverage and duplicate assertions cannot be waived by reviewer', async context => {
  const { root, repository } = await fixture(context)
  for (const duplicate of [false, true]) {
    const original = value()
    if (duplicate) original.cases[0].assertions!.push(original.cases[0].assertions![0])
    else original.baseline[0].scenarios.push('negative')
    await assert.rejects(importCasePackage(repository, root, 7, original, '', async () => { assert.fail('Structurally invalid definitions must not reach the model') }), code('UNQUALIFIED'))
  }
  assert.ok((await repository.list('project', 7)).every(project => project.status === 'failed' && project.draft?.assessment?.issues.length))
})

test('review failure keeps unreviewed draft and sanitizes model errors', async context => {
  const { root, repository } = await fixture(context)
  for (const review of [async () => { throw new Error('private-token stack') }, async () => '{"qualified":true,"issues":[],"caseIssues":[{"caseId":"TC-999","message":"private-token"}]}']) {
    await assert.rejects(importCasePackage(repository, root, 7, value(), 'private-token', review), code('MODEL_FAILED'))
  }
  for (const project of await repository.list('project', 7)) {
    assert.equal(project.status, 'failed')
    assert.equal(project.draft?.assessment?.caseReviews?.[0].status, 'unreviewed')
    assert.doesNotMatch(JSON.stringify(project), /private-token|stack/)
  }
})

test('package write failure retains durable completed project reservation, never a phantom package', async context => {
  const { root, repository } = await fixture(context)
  const create = repository.create.bind(repository)
  repository.create = async (kind, item, owner) => {
    if (kind === 'package') throw new Error('secret storage error')
    return create(kind, item, owner)
  }
  const original = value()
  await assert.rejects(importCasePackage(repository, root, 7, original, '', accepted), code('STORAGE_FAILED'))
  const [project] = await repository.list('project', 7)
  assert.equal(project.status, 'completed')
  assert.equal(project.caseSetIds.length, 1)
  assert.match(project.events.at(-1)!.text, /^planning:import:publish:/)
  assert.equal((await repository.list('package', 7)).length, 0)
  repository.create = create
  const imported = await importCasePackage(repository, root, 7, original, '', async () => { assert.fail('Recovery must not review again') })
  assert.equal(imported.id, project.caseSetIds[0])
  assert.equal(imported.projectId, project.id)
  assert.equal((await repository.list('project', 7)).length, 1)
  assert.equal((await repository.list('package', 7)).length, 1)
  assert.deepEqual(await materializeImportedPackage(repository, project, 7), imported)
})

test('JSON reservation survives reopening and retry returns the exact reserved package', async context => {
  const { root } = await fixture(context)
  const repository = await createTestingRepository('json', root)
  const original = value()
  const create = repository.create.bind(repository)
  repository.create = async (kind, item, owner) => {
    if (kind === 'package') throw new Error('Injected publication failure')
    return create(kind, item, owner)
  }
  await assert.rejects(importCasePackage(repository, root, 7, original, '', accepted), code('STORAGE_FAILED'))
  const [project] = await repository.list('project', 7)
  const reserved = (project.draft as NonNullable<PlanningProject['draft']> & { importedPackage: CasePackage }).importedPackage
  assert.ok(reserved.sourceFingerprint)
  assert.equal(project.events.at(-1)!.text, `planning:import:publish:${reserved.id} package-sha256:${planningDigest(reserved)}`)
  const reopened = await createTestingRepository('json', root)
  const imported = await importCasePackage(reopened, root, 7, original, '', async () => { assert.fail('Retry cannot rerun review') })
  assert.deepEqual(imported, reserved)
  assert.deepEqual(await reopened.get('package', reserved.id, 7), reserved)
  assert.equal((await reopened.list('project', 7)).length, 1)
})

test('concurrent retries materialize one package without extra projects or model reviews', async context => {
  const { root, repository, original, project } = await pendingImport(context)
  const imported = await Promise.all(Array.from({ length: 8 }, () => importCasePackage(repository, root, 7, original, '', async () => { assert.fail('No review on pending retry') })))
  assert.ok(imported.every(item => item.id === project.caseSetIds[0] && item.projectId === project.id))
  assert.ok(imported.every(item => planningDigest(item) === planningDigest(imported[0])))
  assert.equal((await repository.list('project', 7)).length, 1)
  assert.equal((await repository.list('package', 7)).length, 1)
})

test('committed package with a lost create response is reconciled rather than orphaned', async context => {
  const { root, repository } = await fixture(context)
  const create = repository.create.bind(repository)
  repository.create = async (kind, item, owner) => {
    await create(kind, item, owner)
    if (kind === 'package') throw new Error('Response lost after commit')
  }
  const imported = await importCasePackage(repository, root, 7, value(), '', accepted)
  assert.deepEqual(await repository.get('package', imported.id, 7), imported)
  assert.equal((await repository.list('project', 7)).length, 1)
})

test('lost reservation response remains recoverable on the same import request', async context => {
  const { root, repository } = await fixture(context)
  const original = value()
  const replace = repository.replace.bind(repository)
  repository.replace = async (kind, item, version, owner) => {
    await replace(kind, item, version, owner)
    if (kind === 'project' && 'status' in item && item.status === 'completed') throw new Error('Response lost after reservation commit')
  }
  await assert.rejects(importCasePackage(repository, root, 7, original, '', accepted), code('STORAGE_FAILED'))
  const [project] = await repository.list('project', 7)
  assert.equal(project.status, 'completed')
  repository.replace = replace
  const imported = await importCasePackage(repository, root, 7, original, '', async () => { assert.fail('Committed reservation must be reused') })
  assert.equal(imported.id, project.caseSetIds[0])
  assert.equal((await repository.list('project', 7)).length, 1)
})

test('reservation recovery rejects altered package, draft, fingerprints, metadata and owner', async context => {
  const { repository, project } = await pendingImport(context)
  type ReservedProject = PlanningProject & { draft: NonNullable<PlanningProject['draft']> & { importedPackage: CasePackage } }
  for (const mutate of [
    (item: ReservedProject) => { item.draft.importedPackage.sourceFingerprint = 'changed' },
    (item: ReservedProject) => { item.draft.importedPackage.createdAt = '2026-01-01T00:00:00.000Z' },
    (item: ReservedProject) => { item.draft.importedPackage.cases[0].expected = 'Changed expectation' },
    (item: ReservedProject) => { item.draft.cases[0].expected = 'Changed draft' },
    (item: ReservedProject) => { item.draft.assessment!.inputFingerprint = 'changed' },
    (item: ReservedProject) => { item.caseSetIds = ['different-id'] },
    (item: ReservedProject) => { item.events.at(-1)!.text = `planning:import:publish:${item.caseSetIds[0]}` },
    (item: ReservedProject) => { item.events[0].text += 'changed' },
    (item: ReservedProject) => { item.input.requirements = '{}' },
    (item: ReservedProject) => { Reflect.deleteProperty(item.draft, 'importedPackage') },
  ]) {
    const altered = structuredClone(project) as ReservedProject
    mutate(altered)
    await assert.rejects(materializeImportedPackage(repository, altered, 7), code('SOURCE_CHANGED'))
    assert.equal((await repository.list('package', 7)).length, 0)
  }
  await assert.rejects(materializeImportedPackage(repository, project, 8), code('SOURCE_CHANGED'))
})

test('retry only recovers the same original digest and owner', async context => {
  const { root, repository, original, project } = await pendingImport(context)
  const otherOwner = await importCasePackage(repository, root, 8, original, '', accepted)
  assert.notEqual(otherOwner.projectId, project.id)
  const changed = structuredClone(original)
  changed.cases[0].title = 'Different original package'
  const otherInput = await importCasePackage(repository, root, 7, changed, '', accepted)
  assert.notEqual(otherInput.projectId, project.id)
  const recovered = await importCasePackage(repository, root, 7, original, '', async () => { assert.fail('Exact original request must recover') })
  assert.equal(recovered.projectId, project.id)
  assert.equal(recovered.id, project.caseSetIds[0])
  assert.equal((await repository.list('project', 7)).length, 2)
})

test('default reviewer creates independent tool-free sessions and cleans up without any real SDK calls', async context => {
  const { root, repository } = await fixture(context)
  const configs: SessionConfig[] = []
  let disconnects = 0, stops = 0, listeners = 0
  context.mock.method(CopilotClient.prototype, 'start', async () => { assert.fail('No real SDK startup') })
  context.mock.method(CopilotClient.prototype, 'resumeSession', async () => { assert.fail('Import must never resume prior sessions') })
  context.mock.method(CopilotClient.prototype, 'stop', async () => { stops++; return [] })
  context.mock.method(CopilotClient.prototype, 'createSession', async (config: SessionConfig) => {
    configs.push(config)
    const handlers = new Set<(event: SessionEvent) => void>()
    return {
      on: (handler: (event: SessionEvent) => void) => { handlers.add(handler); listeners++; return () => { handlers.delete(handler); listeners-- } },
      send: async (options: { prompt: string }) => {
        assert.match(options.prompt, /independent design quality reviewer/)
        assert.doesNotMatch(options.prompt, /forged|external-model/)
        for (const handler of handlers) handler({ type: 'assistant.message', data: { content: '{"qualified":true,"issues":[],"caseIssues":[]}' } } as SessionEvent)
        for (const handler of handlers) handler({ type: 'session.idle', data: {} } as SessionEvent)
        return 'import-review-message'
      },
      abort: async () => {}, disconnect: async () => { disconnects++ },
    }
  })
  for (const owner of [7, 8]) await importCasePackage(repository, root, owner, value(), 'test-only-token')
  assert.equal(configs.length, 2)
  assert.notEqual(configs[0].workingDirectory, configs[1].workingDirectory)
  assert.equal(disconnects, 2)
  assert.equal(stops, 2)
  assert.equal(listeners, 0)
  for (const config of configs) {
    assert.deepEqual(config.availableTools, [])
    assert.equal(config.model, 'auto')
    assert.match(config.systemMessage!.content!, /untrusted data/)
    for (const kind of ['read', 'write', 'shell', 'url', 'custom-tool']) assert.equal((await config.onPermissionRequest!({ kind } as never, {} as never)).kind, 'reject')
    for (const toolName of ['view', 'bash', 'ask_user']) assert.equal((await config.hooks!.onPreToolUse!({ toolName, toolArgs: {} } as never, {} as never))?.permissionDecision, 'deny')
    await assert.rejects(config.onUserInputRequest!({} as never, {} as never), code('NEEDS_INPUT'))
  }
})

test('batch review checkpoints survive a later interruption and cannot publish partial approval', async context => {
  const { root, repository } = await fixture(context)
  const original = value()
  original.cases = Array.from({ length: 21 }, (_unused, index) => ({ ...original.cases[0], id: `TC-${index + 1}` }))
  let calls = 0
  await assert.rejects(importCasePackage(repository, root, 7, original, '', async () => {
    if (++calls > 1) throw new PlanningError('NEEDS_INPUT')
    return '{"qualified":true,"issues":[],"caseIssues":[]}'
  }), code('NEEDS_INPUT'))
  assert.equal(calls, 2)
  const [project] = await repository.list('project', 7)
  assert.equal(project.status, 'failed')
  assert.ok(project.draft?.assessment?.caseReviews?.some(review => review.status === 'qualified'))
  assert.ok(project.draft?.assessment?.caseReviews?.some(review => review.status === 'unreviewed'))
  assert.equal((await repository.list('package', 7)).length, 0)
})

test('audited imported package is accepted by the execution service without workspace publication', async context => {
  const { root, repository } = await fixture(context)
  const original = value()
  original.cases[0].classification = { testType: 'functional', tags: ['persistence'], priority: 'P1', riskReason: 'Saved account data', executionPolicy: 'always' }
  const imported = await importCasePackage(repository, root, 7, original, '', accepted)
  const execution = new TestExecutionService(repository, root, { clone: async () => { assert.fail('Creating an execution must not clone') } })
  const run = await execution.create(7, { title: 'Imported definitions', caseSetId: imported.id, repository: 'https://github.com/org/repo', scope: { mode: 'default', caseIds: [], reason: '' } })
  assert.equal(run.status, 'draft')
  assert.equal(run.packageFingerprint, planningDigest(imported))
  assert.deepEqual(run.cases.map(item => item.caseId), original.cases.map(item => item.id))
  assert.ok(run.cases.every(item => !item.binding && !item.result))
  assert.equal((await repository.get('project', imported.projectId, 7))?.status, 'completed')
})