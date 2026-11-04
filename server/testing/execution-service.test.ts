import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import type { CaseDefinition, CasePackage, ExecutionInput, TestingRecordKind, TestingRecordMap, TestingRepository } from '../../shared/testing.js'
import { assessAcceptance } from '../verification/acceptance.js'
import { planningDigest, planningRulesVersion } from './planning-model.js'
import { TestExecutionService, type ExecutionRunnerOptions, type PreparedExecutionRun, type TestExecutionDependencies } from './execution-service.js'
import type { ExecutionModelResult } from './execution-model.js'
import { packageInputFingerprint } from './scoped-package.js'

class MemoryRepository implements TestingRepository {
  records = new Map<string, { owner: number; value: TestingRecordMap[TestingRecordKind] }>()
  async list<Kind extends TestingRecordKind>(kind: Kind, owner: number): Promise<TestingRecordMap[Kind][]> {
    return [...this.records.entries()].filter(([key, item]) => key.startsWith(`${kind}:`) && item.owner === owner).map(([, item]) => structuredClone(item.value) as TestingRecordMap[Kind])
  }
  async get<Kind extends TestingRecordKind>(kind: Kind, id: string, owner: number): Promise<TestingRecordMap[Kind] | undefined> {
    const item = this.records.get(`${kind}:${id}`)
    return item?.owner === owner ? structuredClone(item.value) as TestingRecordMap[Kind] : undefined
  }
  async create<Kind extends TestingRecordKind>(kind: Kind, value: TestingRecordMap[Kind], owner: number): Promise<void> {
    assert.ok(!this.records.has(`${kind}:${value.id}`))
    this.records.set(`${kind}:${value.id}`, { owner, value: structuredClone(value) })
  }
  async replace<Kind extends 'project' | 'execution'>(kind: Kind, value: TestingRecordMap[Kind], expected: number, owner: number): Promise<void> {
    const current = await this.get(kind, value.id, owner)
    if (!current || current.version !== expected) throw new Error('CAS')
    this.records.set(`${kind}:${value.id}`, { owner, value: structuredClone(value) })
  }
  async recover(): Promise<void> {}
}

const execute = promisify(execFile)
const passed = async (options: ExecutionRunnerOptions) => ({ version: 1 as const, runner: 'playwright-test' as const, caseId: options.testCase.id,
  caseFingerprint: options.binding.caseFingerprint, status: 'passed' as const, reason: 'verified', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
  assertions: options.binding.assertionIds.map(id => ({ id, status: 'passed' as const, expectCount: 1 })) })

async function fixture(dependencies: TestExecutionDependencies = {}, installed = true, existingSpecs = true, config = 'export default { webServer: { command: "NEVER" } }\n') {
  const root = await mkdtemp(join(tmpdir(), 'testing-execution-'))
  const repo = new MemoryRepository()
  const projectId = randomUUID(), packageId = randomUUID()
  const cases: CaseDefinition[] = [1, 2, 3].map(index => ({ id: `TC-${index}`, title: `Case ${index}`, source: 'requirements', steps: 'Observe state', expected: 'Expected state',
    requirementIds: [`REQ-00${index === 1 ? 1 : 2}`], scenario: 'normal', preconditions: 'None', testData: 'None', cleanup: 'None', assertions: ['State is correct'],
    classification: { testType: 'functional', tags: [], priority: 'P1', riskReason: 'State correctness', executionPolicy: index === 2 ? 'always' : 'on_demand' } }))
  const baseline = [{ id: 'REQ-001', source: 'requirements', criterion: 'Required state', required: true, scenarios: ['normal' as const] },
    { id: 'REQ-002', source: 'requirements', criterion: 'Optional state', required: false, scenarios: ['normal' as const] }]
  const definitionFingerprint = planningDigest({ baseline, cases })
  const sourceFingerprint = planningDigest('source')
  const assessment = assessAcceptance(baseline, cases.map(item => ({ ...item, status: 'pending' })))
  assessment.caseReviews = cases.map(item => ({ caseId: item.id, status: 'qualified' }))
  assessment.inputFingerprint = planningDigest({ sourceFingerprint, definitionFingerprint, rulesVersion: planningRulesVersion })
  const value: CasePackage = { schemaVersion: 1, id: packageId, projectId, revision: 1, createdAt: new Date().toISOString(), sourceFingerprint, definitionFingerprint,
    rulesVersion: planningRulesVersion, modelId: 'test', baseline, cases, assessment }
  await repo.create('project', { id: projectId, ownerId: 1, version: 1, createdAt: value.createdAt, updatedAt: value.createdAt,
    input: { title: 'Project', requirements: 'Requirements', instruction: '', modelId: 'test', sources: [] }, status: 'completed', events: [], caseSetIds: [packageId] }, 1)
  await repo.create('package', value, 1)
  const clone: NonNullable<TestExecutionDependencies['clone']> = async (repository, workspace, branch, signal) => {
    assert.equal(repository, 'https://github.com/example/project')
    assert.equal(branch, undefined)
    assert.equal(signal.aborted, false)
    assert.ok(workspace.startsWith(join(root, 'testing', 'executions')))
    await mkdir(workspace)
    await execute('git', ['init', workspace])
    await writeFile(join(workspace, '.gitignore'), 'node_modules/\nfixtures/\n')
    if (existingSpecs) await writeFile(join(workspace, 'sample.spec.ts'), 'export {}\n')
    await writeFile(join(workspace, 'playwright.config.ts'), config)
    await mkdir(join(workspace, 'fixtures'))
    await writeFile(join(workspace, 'fixtures', 'input.json'), '{}')
    if (installed) {
      const local = join(workspace, 'node_modules', '@playwright', 'test')
      await mkdir(local, { recursive: true })
      await writeFile(join(local, 'package.json'), JSON.stringify({ name: '@playwright/test', version: '1.63.0', exports: { './cli': './cli.js' } }))
      await writeFile(join(local, 'cli.js'), 'throw new Error("Mock runner only")')
    }
  }
  const service = new TestExecutionService(repo, root, { clone, runner: passed, ...dependencies })
  const input: ExecutionInput = { title: 'Execution', caseSetId: packageId, repository: 'https://github.com/example/project', scope: { mode: 'default', caseIds: [], reason: '' } }
  const approval = (caseId: string) => ({ confirm: true, testFile: 'sample.spec.ts', testTitle: 'State', project: '', assertionIds: [`${caseId}:A001`] })
  const prepare = async () => {
    const run = await service.create(1, input)
    await service.prepare(1, run.id)
    for (const item of run.cases.filter(entry => entry.selected)) await service.approve(1, run.id, item.caseId, approval(item.caseId))
    return run.id
  }
  return { root, repo, value, service, input, approval, prepare, cleanup: () => rm(root, { recursive: true, force: true }) }
}

test('scoped packages require explicit exact custom execution and preserve full failure and package scope', async () => {
  const setup = await fixture()
  try {
    const value = structuredClone(setup.value)
    value.cases = value.cases.slice(0, 1)
    value.baseline = value.baseline.slice(0, 1).map(item => ({ ...item, required: false }))
    value.scope = { mode: 'custom', caseIds: ['TC-1'], reason: 'Selected only', originalDefinitionFingerprint: setup.value.definitionFingerprint }
    value.definitionFingerprint = planningDigest({ baseline: value.baseline, cases: value.cases })
    value.assessment = assessAcceptance(value.baseline, value.cases.map(item => ({ ...item, status: 'pending' })))
    value.assessment.caseReviews = [{ caseId: 'TC-1', status: 'qualified' }]
    value.assessment.inputFingerprint = packageInputFingerprint(value)
    setup.repo.records.set(`package:${value.id}`, { owner: 1, value })
    const project = (await setup.repo.get('project', value.projectId, 1))!
    await setup.repo.replace('project', { ...project, status: 'failed', version: project.version + 1 }, project.version, 1)
    for (const scope of [{ mode: 'default' as const, caseIds: [], reason: '' }, { mode: 'default' as const, caseIds: ['TC-1'], reason: 'Selected only' }, { mode: 'custom' as const, caseIds: ['TC-999'], reason: 'Selected only' }, { mode: 'custom' as const, caseIds: [], reason: 'Selected only' }, { mode: 'custom' as const, caseIds: ['TC-1'], reason: 'Changed' }]) {
      await assert.rejects(setup.service.create(1, { ...setup.input, scope }), { code: 'INVALID_INPUT' })
    }
    const run = await setup.service.create(1, { ...setup.input, scope: { mode: 'custom', caseIds: ['TC-1'], reason: 'Selected only' } })
    assert.deepEqual(run.cases.filter(item => item.selected).map(item => item.caseId), ['TC-1'])
    await setup.service.prepare(1, run.id)
    await setup.service.approve(1, run.id, 'TC-1', setup.approval('TC-1'))
    await setup.service.start(1, run.id)
    const report = await setup.service.report(1, run.id)
    assert.equal(report.run.status, 'passed')
    assert.equal(report.scope.mode, 'custom')
    assert.deepEqual(report.casePackage.scope, value.scope)
    assert.equal((await setup.repo.get('project', value.projectId, 1))!.status, 'failed')
    assert.deepEqual(await setup.repo.get('package', value.id, 1), value)
    const invalid = structuredClone(value)
    invalid.scope!.caseIds.push('TC-2')
    invalid.assessment.inputFingerprint = packageInputFingerprint(invalid)
    setup.repo.records.set(`package:${value.id}`, { owner: 1, value: invalid })
    await assert.rejects(setup.service.create(1, { ...setup.input, scope: run.input.scope }), { code: 'UNQUALIFIED' })
  } finally { await setup.cleanup() }
})

test('independent execution requires snapshot-bound approval and preserves the immutable package', async () => {
  const setup = await fixture()
  try {
    const before = structuredClone(setup.value)
    const run = await setup.service.create(1, setup.input)
    assert.deepEqual(run.input.scope.caseIds, ['TC-1', 'TC-2'])
    await setup.service.prepare(1, run.id, 'never-persist-this-token')
    assert.equal((await setup.service.report(1, run.id)).run.status, 'blocked')
    assert.equal((await setup.service.binding(1, run.id, 'TC-1')).binding, null)
    await setup.service.start(1, run.id)
    assert.equal((await setup.service.report(1, run.id)).run.status, 'blocked')
    for (const id of ['TC-1', 'TC-2']) await setup.service.approve(1, run.id, id, setup.approval(id))
    assert.equal((await setup.service.binding(1, run.id, 'TC-1')).source, 'export {}\n')
    assert.equal((await setup.service.report(1, run.id)).run.status, 'ready')
    await setup.service.start(1, run.id)
    const report = await setup.service.report(1, run.id)
    assert.equal(report.run.status, 'passed')
    assert.equal(report.run.cases[2].status, 'skipped')
    assert.equal(report.run.cases[0].binding?.approvedBy, '1')
    assert.deepEqual(report.casePackage, before)
    assert.ok(!JSON.stringify(report).includes('never-persist-this-token'))
    await assert.rejects(setup.service.start(1, run.id), { code: 'CONFLICT' })
    await assert.rejects(setup.service.prepare(1, run.id), { code: 'CONFLICT' })
  } finally { await setup.cleanup() }
})

test('ownership applies to execution, package and publishing project, even with a leaking repository', async () => {
  const setup = await fixture()
  try {
    const run = await setup.service.create(1, setup.input)
    for (const operation of [() => setup.service.create(2, setup.input), () => setup.service.prepare(2, run.id),
      () => setup.service.implement(2, run.id, 'ephemeral-token'), () => setup.service.install(2, run.id),
      () => setup.service.binding(2, run.id, 'TC-1'), () => setup.service.approve(2, run.id, 'TC-1', setup.approval('TC-1')),
      () => setup.service.start(2, run.id), () => setup.service.cancel(2, run.id), () => setup.service.report(2, run.id)]) {
      await assert.rejects(operation(), { code: 'NOT_FOUND' })
    }
    const original = setup.repo.get.bind(setup.repo)
    setup.repo.get = async (kind, id, _owner) => original(kind, id, 1)
    await assert.rejects(setup.service.report(2, run.id), { code: 'NOT_FOUND' })
    await assert.rejects(setup.service.create(2, setup.input), { code: 'NOT_FOUND' })
    const project = setup.repo.records.get(`project:${setup.value.projectId}`)!
    if ('ownerId' in project.value) project.value.ownerId = 2
    await assert.rejects(setup.service.report(1, run.id), { code: 'NOT_FOUND' })
  } finally { await setup.cleanup() }
})

test('default scope preserves required and always cases; custom scope is exact and justified', async () => {
  const setup = await fixture()
  try {
    for (const caseIds of [['TC-2'], ['TC-1'], ['TC-1', 'TC-1'], ['UNKNOWN']]) {
      await assert.rejects(setup.service.create(1, { ...setup.input, scope: { mode: 'default', caseIds, reason: '' } }), { code: 'INVALID_INPUT' })
    }
    await assert.rejects(setup.service.create(1, { ...setup.input, scope: { mode: 'custom', caseIds: ['TC-3'], reason: ' ' } }), { code: 'INVALID_INPUT' })
    await assert.rejects(setup.service.create(1, { ...setup.input, scope: { mode: 'custom', caseIds: [], reason: 'Narrow scope' } }), { code: 'INVALID_INPUT' })
    const run = await setup.service.create(1, { ...setup.input, scope: { mode: 'custom', caseIds: ['TC-3'], reason: 'Narrow scope' } })
    assert.deepEqual(run.cases.filter(item => item.selected).map(item => [item.caseId, item.blocking]), [['TC-3', true]])
    assert.equal(run.readiness?.readiness, 'ready')
    await setup.service.prepare(1, run.id)
    await assert.rejects(setup.service.binding(1, run.id, 'TC-1'), { code: 'NOT_FOUND' })
    await setup.service.approve(1, run.id, 'TC-3', setup.approval('TC-3'))
    await setup.service.start(1, run.id)
    assert.equal((await setup.service.report(1, run.id)).run.status, 'passed')
  } finally { await setup.cleanup() }
})

test('unqualified reviews and tampered definitions cannot be published execution inputs', async () => {
  const setup = await fixture()
  try {
    const entry = setup.repo.records.get(`package:${setup.value.id}`)!
    const mutations = [
      (value: CasePackage) => { value.cases[0].steps = 'Changed' },
      (value: CasePackage) => { value.assessment.caseReviews![0].status = 'unreviewed' },
      (value: CasePackage) => { value.assessment.caseReviews = [] },
      (value: CasePackage) => { value.assessment.inputFingerprint = 'forged' },
      (value: CasePackage) => { value.schemaVersion = 2 as 1 },
      (value: CasePackage) => { value.cases[0].assertions = []; value.definitionFingerprint = planningDigest({ baseline: value.baseline, cases: value.cases }) },
    ]
    for (const mutate of mutations) {
      const value = structuredClone(setup.value)
      mutate(value)
      entry.value = value
      await assert.rejects(setup.service.create(1, setup.input), { code: 'UNQUALIFIED' })
    }
  } finally { await setup.cleanup() }
})

test('repository, branch and preview validation never starts network or production services', async () => {
  let clones = 0
  const setup = await fixture({ clone: async () => { clones++; throw new Error('Must not clone') } })
  try {
    for (const patch of [ { repository: 'file:///tmp/repo' }, { repository: 'https://user:secret@github.com/a/b' },
      { repository: 'https://example.org/a/b' }, { branch: '--upload-pack=evil' }, { branch: 'a/../b' }, { branch: 'main.lock' },
      { previewUrl: 'https://production.example.org' }, { previewUrl: 'http://localhost@evil.test' }, { previewUrl: 'file:///tmp/site' }, { previewUrl: 'http://localhost:3000/?token=secret' },
      { previewUrl: 'https://localhost:4321/app' }, { previewUrl: 'https://127.0.0.1:4321/app' }, { previewUrl: 'https://[::1]:4321/app' },
      { previewUrl: 'http://localhost:4321/#fragment' }, { previewUrl: 'http://localhost:4321/\napp' }, { previewUrl: 123 as unknown as string } ]) {
      await assert.rejects(setup.service.create(1, { ...setup.input, ...patch }), { code: 'INVALID_INPUT' })
    }
    assert.equal(clones, 0)
    assert.equal((await setup.repo.list('execution', 1)).length, 0)
    await assert.rejects(setup.service.create(1, { ...setup.input, previewUrl: 'https://localhost:4321/app' }), {
      code: 'INVALID_INPUT', message: /local HTTP.*HTTPS is not supported/,
    })
    for (const previewUrl of ['http://localhost:4321/app/deep/', 'http://127.0.0.1:4321/a%20b/', 'http://[::1]:4321/app']) {
      assert.equal((await setup.service.create(1, { ...setup.input, previewUrl })).input.previewUrl, previewUrl)
    }
  } finally { await setup.cleanup() }
})

test('missing local Playwright blocks approval and start without silently installing', async () => {
  let calls = 0
  const setup = await fixture({ runner: async options => { calls++; return passed(options) } }, false)
  try {
    const created = await setup.service.create(1, setup.input)
    const id = created.id
    await setup.service.prepare(1, id)
    const report = await setup.service.report(1, id)
    assert.equal(report.run.status, 'blocked')
    assert.ok(report.run.workspaceFingerprint)
    assert.equal((await setup.service.binding(1, id, 'TC-1')).binding, null)
    await assert.rejects(setup.service.approve(1, id, 'TC-1', setup.approval('TC-1')), { code: 'PREPARATION_FAILED' })
    await setup.service.start(1, id)
    assert.equal(calls, 0)
  } finally { await setup.cleanup() }
})

test('approval rejects authority injection, missing assertions, unsafe and oversized sources', async () => {
  const setup = await fixture()
  try {
    const run = await setup.service.create(1, setup.input)
    await assert.rejects(setup.service.binding(1, run.id, 'TC-1'))
    await setup.service.prepare(1, run.id)
    for (const patch of [{ confirm: false }, { assertionIds: [] }, { assertionIds: ['TC-1:A002'] }, { approvedBy: 'forged' },
      { designFingerprint: 'forged' }, { testFile: '../sample.spec.ts' }, { testFile: 'missing.spec.ts' }]) {
      await assert.rejects(setup.service.approve(1, run.id, 'TC-1', { ...setup.approval('TC-1'), ...patch }), { code: 'INVALID_INPUT' })
    }
    const workspace = join(setup.root, 'testing', 'executions', run.id, 'workspace')
    await writeFile(join(workspace, 'sample.spec.ts'), 'x'.repeat(128 * 1024 + 1))
    await assert.rejects(setup.service.approve(1, run.id, 'TC-1', setup.approval('TC-1')), { code: 'SOURCE_CHANGED' })
  } finally { await setup.cleanup() }
})

test('source, ignored fixture and configuration drift block before execution', async () => {
  for (const target of ['sample.spec.ts', 'playwright.config.ts', 'fixtures/input.json']) {
    let calls = 0
    const setup = await fixture({ runner: async options => { calls++; return passed(options) } })
    try {
      const id = await setup.prepare()
      await writeFile(join(setup.root, 'testing', 'executions', id, 'workspace', target), 'changed')
      await setup.service.start(1, id)
      assert.equal((await setup.service.report(1, id)).run.status, 'blocked')
      assert.equal(calls, 0)
    } finally { await setup.cleanup() }
  }
})

test('runner mutations invalidate returned passes and prevent later cases from running', async () => {
  let calls = 0
  const setup = await fixture({ runner: async options => {
    calls++
    await writeFile(join(options.workspace, 'sample.spec.ts'), 'mutated during test')
    return passed(options)
  } })
  try {
    const id = await setup.prepare()
    await setup.service.start(1, id)
    const run = (await setup.service.report(1, id)).run
    assert.equal(run.status, 'blocked')
    assert.ok(run.cases.every(item => item.status !== 'passed'))
    assert.equal(calls, 1)
    await assert.rejects(setup.service.start(1, id), { code: 'CONFLICT' })
  } finally { await setup.cleanup() }
})

test('incomplete required evidence never passes, while optional failures remain visible', async () => {
  for (const requiredStatus of ['passed', 'incomplete', 'failed', 'blocked'] as const) {
    const setup = await fixture({ runner: async options => ({ ...await passed(options), status: options.testCase.id === 'TC-1' ? requiredStatus : 'failed', reason: 'token=DO_NOT_STORE' }) })
    try {
      const id = await setup.prepare()
      await setup.service.start(1, id)
      const report = await setup.service.report(1, id)
      assert.equal(report.run.status, requiredStatus)
      assert.equal(report.run.cases[1].status, 'failed')
      assert.ok(!JSON.stringify(report).includes('DO_NOT_STORE'))
    } finally { await setup.cleanup() }
  }
})

test('zero blocking cases and forged empty assertion passes cannot yield passed execution', async () => {
  let incomplete = true
  const setup = await fixture({ runner: async options => ({ ...await passed(options), ...(incomplete ? { assertions: [] } : {}) }) })
  try {
    const id = await setup.prepare()
    await setup.service.start(1, id)
    assert.equal((await setup.service.report(1, id)).run.status, 'incomplete')
    incomplete = false
    const value = structuredClone(setup.value)
    value.baseline[0].required = false
    value.definitionFingerprint = planningDigest({ baseline: value.baseline, cases: value.cases })
    value.assessment.inputFingerprint = planningDigest({ sourceFingerprint: value.sourceFingerprint, definitionFingerprint: value.definitionFingerprint, rulesVersion: value.rulesVersion })
    setup.repo.records.get(`package:${value.id}`)!.value = value
    const run = await setup.service.create(1, setup.input)
    await setup.service.prepare(1, run.id)
    for (const item of run.cases.filter(entry => entry.selected)) await setup.service.approve(1, run.id, item.caseId, setup.approval(item.caseId))
    await setup.service.start(1, run.id)
    const report = await setup.service.report(1, run.id)
    assert.equal(report.run.status, 'incomplete')
    assert.ok(report.run.cases.filter(item => item.selected).every(item => item.status === 'passed'))
  } finally { await setup.cleanup() }
})

test('cancellation persists immediately, aborts runner and rejects all late evidence', async () => {
  let release!: () => void
  let entered!: () => void
  let signal: AbortSignal | undefined
  const entering = new Promise<void>(resolve => { entered = resolve })
  const waiting = new Promise<void>(resolve => { release = resolve })
  const setup = await fixture({ runner: async options => { signal = options.signal; entered(); await waiting; return passed(options) } })
  try {
    const id = await setup.prepare()
    const starting = setup.service.start(1, id)
    await entering
    await assert.rejects(setup.service.start(1, id), { code: 'CONFLICT' })
    await assert.rejects(setup.service.approve(1, id, 'TC-1', setup.approval('TC-1')), { code: 'CONFLICT' })
    const cancelled = await new TestExecutionService(setup.repo, setup.root).cancel(1, id)
    assert.equal(cancelled.status, 'cancelled')
    assert.equal(signal?.aborted, true)
    release()
    await starting
    const final = (await setup.service.report(1, id)).run
    assert.equal(final.version, cancelled.version)
    assert.ok(final.cases.every(item => !item.result))
  } finally { release(); await setup.cleanup() }
})

test('concurrent approvals use CAS and never silently overwrite an approved mapping', async () => {
  const setup = await fixture()
  try {
    const run = await setup.service.create(1, setup.input)
    await setup.service.prepare(1, run.id)
    const results = await Promise.allSettled(['TC-1', 'TC-2'].map(id => setup.service.approve(1, run.id, id, setup.approval(id))))
    assert.equal(results.filter(item => item.status === 'fulfilled').length, 1)
    const rejected = results.find(item => item.status === 'rejected') as PromiseRejectedResult
    assert.equal(rejected.reason.code, 'CONFLICT')
    assert.equal((await setup.service.report(1, run.id)).run.cases.filter(item => item.binding).length, 1)
  } finally { await setup.cleanup() }
})

test('runner receives explicit local preview environment and safe errors never expose credentials', async () => {
  let url: string | undefined
  const setup = await fixture({ runner: async options => {
    assert.deepEqual(options.env, { CODEFLOW_BASE_URL: 'http://localhost:4321/app/deep%20path/' })
    url = options.env.CODEFLOW_BASE_URL
    throw new Error('github_pat_SECRET token=SECRET')
  } })
  try {
    setup.input.previewUrl = 'http://localhost:4321/app/deep%20path/'
    const id = await setup.prepare()
    await setup.service.start(1, id)
    const report = await setup.service.report(1, id)
    assert.equal(url, setup.input.previewUrl)
    assert.equal(report.run.status, 'blocked')
    assert.ok(!JSON.stringify(report).includes('SECRET'))
  } finally { await setup.cleanup() }
})

test('cancellation during clone cannot publish a workspace snapshot or overwrite cancelled state', async () => {
  let release!: () => void
  let entered!: () => void
  let signal: AbortSignal | undefined
  const entering = new Promise<void>(resolve => { entered = resolve })
  const waiting = new Promise<void>(resolve => { release = resolve })
  const setup = await fixture({ clone: async (_repository, workspace, _branch, abort) => {
    signal = abort
    await mkdir(workspace)
    entered()
    await waiting
  } })
  try {
    const run = await setup.service.create(1, setup.input)
    const preparation = setup.service.prepare(1, run.id)
    await entering
    const cancelled = await setup.service.cancel(1, run.id)
    assert.equal(signal?.aborted, true)
    release()
    await preparation
    const final = (await setup.service.report(1, run.id)).run
    assert.equal(final.version, cancelled.version)
    assert.equal(final.workspaceFingerprint, undefined)
  } finally { release(); await setup.cleanup() }
})

test('package replacement after run creation is rejected even if the replacement remains qualified', async () => {
  const setup = await fixture()
  try {
    const id = await setup.prepare()
    const replacement = structuredClone(setup.value)
    replacement.modelId = 'changed-model'
    setup.repo.records.get(`package:${replacement.id}`)!.value = replacement
    await assert.rejects(setup.service.binding(1, id, 'TC-1'), { code: 'SOURCE_CHANGED' })
    await assert.rejects(setup.service.start(1, id), { code: 'SOURCE_CHANGED' })
  } finally { await setup.cleanup() }
})

test('symlink workspace ancestors are rejected without touching their target', async () => {
  const setup = await fixture()
  const outside = await mkdtemp(join(tmpdir(), 'execution-outside-'))
  try {
    const run = await setup.service.create(1, setup.input)
    await symlink(outside, join(setup.root, 'testing'), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(setup.service.prepare(1, run.id), { code: 'SOURCE_CHANGED' })
    const { readdir } = await import('node:fs/promises')
    assert.deepEqual(await readdir(outside), [])
  } finally { await setup.cleanup(); await rm(outside, { recursive: true, force: true }) }
})

const generated = (ids = ['TC-1', 'TC-2']): ExecutionModelResult => ({
  files: ids.map(caseId => ({ path: `.codeflow-tests/${caseId.toLowerCase()}.spec.ts`, content: `import { test, expect } from '@playwright/test'\ntest('${caseId}', async ({ page }) => { await test.step('[assertion:${caseId}:A001]', async () => { await expect(page.getByRole('status')).toHaveText('Expected state') }) })\n` })),
  mappings: ids.map(caseId => ({ caseId, testFile: `.codeflow-tests/${caseId.toLowerCase()}.spec.ts`, testTitle: caseId, project: '' })),
})

async function fakeInstall(workspace: string, version = '1.63.0') {
  const local = join(workspace, 'node_modules', '@playwright', 'test')
  await mkdir(local, { recursive: true })
  await writeFile(join(local, 'package.json'), JSON.stringify({ name: '@playwright/test', version, exports: { './cli': './cli.js' } }))
  await writeFile(join(local, 'cli.js'), 'throw new Error("Mock runner only")')
}

test('partial clone failure removes only the uncommitted owned workspace and explicit prepare retries', async () => {
  let clones = 0
  const setup = await fixture({ clone: async (_repository, workspace) => {
    clones++
    await mkdir(workspace)
    await writeFile(join(workspace, 'partial.txt'), 'partial clone')
    if (clones === 1) throw new Error('token=SECRET')
    await execute('git', ['init', workspace])
  } })
  try {
    const created = await setup.service.create(1, setup.input)
    await assert.rejects(setup.service.prepare(1, created.id), { code: 'PREPARATION_FAILED' })
    const failed = (await setup.service.report(1, created.id)).run as PreparedExecutionRun
    assert.equal(failed.status, 'blocked')
    assert.equal(failed.phase, 'awaiting_implementation')
    assert.equal(failed.workspaceFingerprint, undefined)
    assert.ok(!JSON.stringify(failed).includes('SECRET'))
    const workspace = join(setup.root, 'testing', 'executions', created.id, 'workspace')
    await assert.rejects(lstat(workspace), { code: 'ENOENT' })
    await setup.service.prepare(1, created.id)
    const retried = (await setup.service.report(1, created.id)).run as PreparedExecutionRun
    assert.equal(clones, 2)
    assert.ok(retried.workspaceFingerprint)
    assert.match(retried.sourceFingerprint!, /^[a-f0-9]{64}$/)
  } finally { await setup.cleanup() }
})

test('partial clone cleanup refuses symlinks and preserves outside files', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'execution-partial-outside-'))
  const setup = await fixture({ clone: async (_repository, workspace) => {
    await mkdir(workspace)
    await symlink(outside, join(workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    throw new Error('clone failed')
  } })
  try {
    await writeFile(join(outside, 'keep.txt'), 'keep')
    const run = await setup.service.create(1, setup.input)
    await assert.rejects(setup.service.prepare(1, run.id), { code: 'SOURCE_CHANGED' })
    assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'keep')
    assert.ok((await lstat(join(setup.root, 'testing', 'executions', run.id, 'workspace', 'linked'))).isSymbolicLink())
    await assert.rejects(setup.service.prepare(1, run.id), { code: 'CONFLICT' })
  } finally { await setup.cleanup(); await rm(outside, { recursive: true, force: true }) }
})

test('model exception resets implementing to awaiting implementation and permits explicit retry', async () => {
  let models = 0
  const setup = await fixture({ implement: async () => {
    if (++models === 1) throw new Error('token=SECRET')
    return generated()
  } })
  try {
    const run = await setup.service.create(1, setup.input)
    await setup.service.prepare(1, run.id)
    await assert.rejects(setup.service.implement(1, run.id, 'token'), { code: 'PREPARATION_FAILED' })
    const failed = (await setup.service.report(1, run.id)).run as PreparedExecutionRun
    assert.equal(failed.status, 'blocked')
    assert.equal(failed.phase, 'awaiting_implementation')
    assert.ok(!JSON.stringify(failed).includes('SECRET'))
    await setup.service.implement(1, run.id, 'token')
    assert.equal(((await setup.service.report(1, run.id)).run as PreparedExecutionRun).phase, 'awaiting_approval')
  } finally { await setup.cleanup() }
})

test('partial dependency writes are never approved and explicit install retries with unchanged source', async () => {
  let installs = 0
  const setup = await fixture({ install: async workspace => {
    installs++
    if (installs === 2) await assert.rejects(lstat(join(workspace, 'node_modules')), { code: 'ENOENT' })
    await fakeInstall(workspace)
    if (installs === 1) throw new Error('token=SECRET')
  } })
  try {
    const id = await setup.prepare()
    const entry = setup.repo.records.get(`execution:${id}`)!
    const original = entry.value as PreparedExecutionRun
    original.cases[2].binding = structuredClone(original.cases[0].binding)
    original.cases.forEach(item => { item.result = { version: 1, runner: 'playwright-test', caseId: item.caseId, caseFingerprint: 'old', status: 'passed', reason: 'old', assertions: [], startedAt: '', finishedAt: '' } })
    const source = original.sourceFingerprint
    await assert.rejects(setup.service.install(1, id), { code: 'PREPARATION_FAILED' })
    const failed = (await setup.service.report(1, id)).run as PreparedExecutionRun
    assert.equal(failed.phase, 'awaiting_installation')
    assert.equal(failed.installComplete, false)
    assert.equal(failed.sourceFingerprint, source)
    assert.ok(failed.cases.every(item => !item.binding && !item.result))
    assert.equal(failed.cases[2].status, 'skipped')
    const workspace = join(setup.root, 'testing', 'executions', id, 'workspace')
    await assert.rejects(lstat(join(workspace, 'node_modules')), { code: 'ENOENT' })
    await assert.rejects(setup.service.approve(1, id, 'TC-1', setup.approval('TC-1')), { code: 'PREPARATION_FAILED' })
    await setup.service.prepare(1, id)
    await setup.service.start(1, id)
    assert.equal((await setup.service.report(1, id)).run.status, 'blocked')
    await setup.service.install(1, id)
    const retried = (await setup.service.report(1, id)).run as PreparedExecutionRun
    assert.equal(installs, 2)
    assert.equal(retried.installComplete, true)
    assert.ok(retried.cases.every(item => !item.binding && !item.result))
    await setup.service.approve(1, id, 'TC-1', setup.approval('TC-1'))
  } finally { await setup.cleanup() }
})

test('failed install cannot bless mutated source including manifests and ignored fixtures', async () => {
  for (const target of ['package.json', 'package-lock.json', 'fixtures/input.json', 'sample.spec.ts']) {
    let installs = 0
    const setup = await fixture({ install: async workspace => {
      installs++
      await fakeInstall(workspace)
      await writeFile(join(workspace, target), 'mutated source')
      throw new Error('install failed')
    } }, false)
    try {
      const run = await setup.service.create(1, setup.input)
      await setup.service.prepare(1, run.id)
      const before = (await setup.service.report(1, run.id)).run as PreparedExecutionRun
      await assert.rejects(setup.service.install(1, run.id), { code: 'SOURCE_CHANGED' })
      const failed = (await setup.service.report(1, run.id)).run as PreparedExecutionRun
      assert.equal(failed.phase, 'awaiting_installation')
      assert.equal(failed.installComplete, false)
      assert.equal(failed.sourceFingerprint, before.sourceFingerprint)
      assert.equal(failed.workspaceFingerprint, before.workspaceFingerprint)
      await assert.rejects(setup.service.install(1, run.id), { code: 'SOURCE_CHANGED' })
      await assert.rejects(setup.service.approve(1, run.id, 'TC-1', setup.approval('TC-1')), { code: 'SOURCE_CHANGED' })
      assert.equal(installs, 1)
    } finally { await setup.cleanup() }
  }
})

test('install failure cleanup refuses tracked dependencies and symlinks', async () => {
  for (const kind of ['tracked', 'symlink']) {
    const outside = await mkdtemp(join(tmpdir(), 'execution-dependency-outside-'))
    let installs = 0
    const setup = await fixture({ install: async workspace => {
      installs++
      await mkdir(join(workspace, 'node_modules'))
      if (kind === 'tracked') {
        await writeFile(join(workspace, 'node_modules', 'keep.txt'), 'tracked dependency')
        await execute('git', ['add', '-f', 'node_modules/keep.txt'], { cwd: workspace })
      } else await symlink(outside, join(workspace, 'node_modules', 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
      throw new Error('install failed')
    } }, false)
    try {
      await writeFile(join(outside, 'keep.txt'), 'outside')
      const run = await setup.service.create(1, setup.input)
      await setup.service.prepare(1, run.id)
      await assert.rejects(setup.service.install(1, run.id), { code: 'SOURCE_CHANGED' })
      await assert.rejects(setup.service.install(1, run.id), { code: 'SOURCE_CHANGED' })
      const workspace = join(setup.root, 'testing', 'executions', run.id, 'workspace')
      assert.ok((await lstat(join(workspace, 'node_modules'))).isDirectory())
      assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'outside')
      if (kind === 'tracked') assert.equal(await readFile(join(workspace, 'node_modules', 'keep.txt'), 'utf8'), 'tracked dependency')
      assert.equal(installs, 1)
    } finally { await setup.cleanup(); await rm(outside, { recursive: true, force: true }) }
  }
})

test('source edits after failed installation block retry before invoking npm again', async () => {
  let installs = 0
  const setup = await fixture({ install: async workspace => {
    installs++
    await fakeInstall(workspace)
    throw new Error('install failed')
  } }, false)
  try {
    const run = await setup.service.create(1, setup.input)
    await setup.service.prepare(1, run.id)
    await assert.rejects(setup.service.install(1, run.id), { code: 'PREPARATION_FAILED' })
    await writeFile(join(setup.root, 'testing', 'executions', run.id, 'workspace', 'fixtures', 'input.json'), 'changed later')
    await assert.rejects(setup.service.install(1, run.id), { code: 'SOURCE_CHANGED' })
    assert.equal(installs, 1)
  } finally { await setup.cleanup() }
})

test('tracked clone dependencies are not removed or accepted as a completed installation after failure', async () => {
  let installs = 0
  const setup = await fixture({ clone: async (_repository, workspace) => {
    await mkdir(workspace)
    await execute('git', ['init', workspace])
    await writeFile(join(workspace, 'sample.spec.ts'), 'export {}\n')
    await fakeInstall(workspace)
    await execute('git', ['add', 'node_modules'], { cwd: workspace })
  }, install: async () => { installs++ } })
  try {
    const id = await setup.prepare()
    await assert.rejects(setup.service.install(1, id), { code: 'SOURCE_CHANGED' })
    const run = (await setup.service.report(1, id)).run as PreparedExecutionRun
    assert.equal(run.installComplete, false)
    assert.equal(run.phase, 'awaiting_installation')
    assert.ok(run.cases.every(item => !item.binding && !item.result))
    assert.equal(installs, 0)
    const workspace = join(setup.root, 'testing', 'executions', id, 'workspace')
    assert.equal(JSON.parse(await readFile(join(workspace, 'node_modules', '@playwright', 'test', 'package.json'), 'utf8')).version, '1.63.0')
    await assert.rejects(setup.service.approve(1, id, 'TC-1', setup.approval('TC-1')), { code: 'PREPARATION_FAILED' })
    await setup.service.prepare(1, id)
    await setup.service.start(1, id)
    const blocked = (await setup.service.report(1, id)).run as PreparedExecutionRun
    assert.equal(blocked.status, 'blocked')
    assert.equal(blocked.phase, 'awaiting_installation')
    await assert.rejects(setup.service.install(1, id), { code: 'SOURCE_CHANGED' })
    assert.equal(installs, 0)
  } finally { await setup.cleanup() }
})

test('explicit generation before install persists exact review source and hints without approval', async () => {
  let installs = 0, runs = 0, models = 0
  const setup = await fixture({ implement: async (input, context) => {
    models++
    assert.deepEqual(input.cases.map(item => item.id), ['TC-1', 'TC-2'])
    assert.equal(context.token, 'ephemeral-token')
    await context.onProgress('token=DO_NOT_STORE')
    return generated()
  }, install: async (workspace, signal) => { installs++; assert.equal(signal.aborted, false); await fakeInstall(workspace) },
  runner: async options => { runs++; assert.match(options.toolchainFingerprint!, /^[a-f0-9]{64}$/); return passed(options) } }, false, false)
  try {
    const run = await setup.service.create(1, setup.input)
    await setup.service.prepare(1, run.id)
    assert.equal(models, 0)
    assert.equal((await setup.service.binding(1, run.id, 'TC-1')).source, undefined)
    await assert.rejects(lstat(join(setup.root, 'testing', 'executions', run.id, 'workspace', 'sample.spec.ts')), { code: 'ENOENT' })
    await setup.service.implement(1, run.id, 'ephemeral-token')
    const binding = await setup.service.binding(1, run.id, 'TC-1')
    assert.equal(binding.binding, null)
    assert.deepEqual(binding.implementation, { testFile: generated().mappings[0].testFile, testTitle: 'TC-1', project: '' })
    assert.equal(binding.source, generated().files[0].content)
    let report = await setup.service.report(1, run.id)
    assert.equal(report.run.status, 'blocked')
    assert.equal((report.run as PreparedExecutionRun).phase, 'awaiting_installation')
    assert.ok(!JSON.stringify(report).includes('approvedBy'))
    assert.ok(!JSON.stringify(report).includes('ephemeral-token'))
    assert.ok(!JSON.stringify(report).includes('DO_NOT_STORE'))
    assert.equal(installs, 0)
    assert.equal(runs, 0)
    const generatedSnapshot = report.run.workspaceFingerprint
    await setup.service.install(1, run.id)
    report = await setup.service.report(1, run.id)
    assert.notEqual(report.run.workspaceFingerprint, generatedSnapshot)
    assert.equal((report.run as PreparedExecutionRun).phase, 'awaiting_approval')
    assert.equal(installs, 1)
    assert.equal((await setup.service.binding(1, run.id, 'TC-1')).source, binding.source)
    for (const mapping of generated().mappings) await setup.service.approve(1, run.id, mapping.caseId, {
      confirm: true, testFile: mapping.testFile, testTitle: mapping.testTitle, project: mapping.project, assertionIds: [`${mapping.caseId}:A001`],
    })
    assert.equal(((await setup.service.report(1, run.id)).run as PreparedExecutionRun).phase, 'ready')
    await setup.service.start(1, run.id)
    assert.equal((await setup.service.report(1, run.id)).run.status, 'passed')
    assert.equal(runs, 2)
  } finally { await setup.cleanup() }
})

test('script writes reset ALL previous approvals and results including unselected cases', async () => {
  const setup = await fixture({ implement: async () => generated() })
  try {
    const id = await setup.prepare()
    const entry = setup.repo.records.get(`execution:${id}`)!
    if ('cases' in entry.value && 'input' in entry.value) {
      const run = entry.value as import('../../shared/testing.js').ExecutionRun
      run.cases[2].binding = structuredClone(run.cases[0].binding)
      run.cases.forEach(item => { item.result = { version: 1, runner: 'playwright-test', caseId: item.caseId, caseFingerprint: 'old', status: 'passed', reason: 'old', assertions: [], startedAt: '', finishedAt: '' } })
    }
    await setup.service.implement(1, id, 'token')
    const report = await setup.service.report(1, id)
    assert.ok(report.run.cases.every(item => !item.binding && !item.result))
    assert.equal(report.run.cases[2].status, 'skipped')
    assert.equal(report.run.status, 'blocked')
    await assert.rejects(setup.service.implement(1, id, 'token'), { code: 'INVALID_INPUT' })
    assert.equal((await setup.service.binding(1, id, 'TC-1')).source, generated().files[0].content)
  } finally { await setup.cleanup() }
})

test('unsafe outputs, missing mappings and oversized files are rejected before any script writes', async () => {
  const outputs: ExecutionModelResult[] = [
    { ...generated(), mappings: generated().mappings.slice(0, 1) },
    { ...generated(), mappings: [...generated().mappings, { ...generated().mappings[0], caseId: 'UNKNOWN' }] },
    ...['../escape.spec.ts', 'sample.spec.ts', '.codeflow-tests/../business.spec.ts', '.codeflow-tests/package.json'].map(path => ({ files: [{ path, content: 'bad' }], mappings: [{ ...generated().mappings[0], testFile: path }] })),
    { ...generated(), files: [{ ...generated().files[0], content: 'x'.repeat(128 * 1024 + 1) }, generated().files[1]] },
  ]
  for (const output of outputs) {
    const setup = await fixture({ implement: async () => output })
    try {
      const id = await setup.prepare()
      await assert.rejects(setup.service.implement(1, id, 'token'))
      const workspace = join(setup.root, 'testing', 'executions', id, 'workspace')
      await assert.rejects(lstat(join(workspace, '.codeflow-tests')), { code: 'ENOENT' })
      assert.equal(await readFile(join(workspace, 'sample.spec.ts'), 'utf8'), 'export {}\n')
    } finally { await setup.cleanup() }
  }
})

test('tracked deleted targets and symlink generation directories cannot be written', async () => {
  for (const kind of ['tracked', 'symlink']) {
    const setup = await fixture({ implement: async () => generated() })
    const outside = await mkdtemp(join(tmpdir(), 'execution-generation-outside-'))
    try {
      const run = await setup.service.create(1, setup.input)
      await setup.service.prepare(1, run.id)
      const workspace = join(setup.root, 'testing', 'executions', run.id, 'workspace')
      if (kind === 'tracked') {
        await mkdir(join(workspace, '.codeflow-tests'))
        await writeFile(join(workspace, generated().files[0].path), 'tracked')
        await execute('git', ['add', '.codeflow-tests'], { cwd: workspace })
        await rm(join(workspace, generated().files[0].path))
      } else await symlink(outside, join(workspace, '.codeflow-tests'), process.platform === 'win32' ? 'junction' : 'dir')
      await assert.rejects(setup.service.implement(1, run.id, 'token'))
      assert.deepEqual(await readdir(outside), [])
    } finally { await setup.cleanup(); await rm(outside, { recursive: true, force: true }) }
  }
})

test('explicit install rejects source mutation and wrong installed versions with sanitized errors', async () => {
  for (const kind of ['source', 'version', 'error']) {
    const setup = await fixture({ install: async workspace => {
      if (kind === 'error') throw new Error('github_pat_SECRET')
      await fakeInstall(workspace, kind === 'version' ? '1.62.0' : '1.63.0')
      if (kind === 'source') await writeFile(join(workspace, 'package.json'), '{"changed":true}')
    } }, false)
    try {
      const run = await setup.service.create(1, setup.input)
      await setup.service.prepare(1, run.id)
      await assert.rejects(setup.service.install(1, run.id))
      const report = await setup.service.report(1, run.id)
      assert.equal(report.run.status, 'blocked')
      assert.ok(!JSON.stringify(report).includes('SECRET'))
      assert.ok(report.run.cases.every(item => !item.binding && !item.result))
    } finally { await setup.cleanup() }
  }
})

test('dependency manifest or CLI drift invalidates approval and startup', async () => {
  for (const target of ['package.json', 'cli.js']) {
    let calls = 0
    const setup = await fixture({ runner: async options => { calls++; return passed(options) } })
    try {
      const id = await setup.prepare()
      await writeFile(join(setup.root, 'testing', 'executions', id, 'workspace', 'node_modules', '@playwright', 'test', target), 'changed')
      await assert.rejects(setup.service.approve(1, id, 'TC-1', setup.approval('TC-1')), { code: 'SOURCE_CHANGED' })
      await setup.service.start(1, id)
      assert.equal(calls, 0)
      assert.equal((await setup.service.report(1, id)).run.status, 'blocked')
    } finally { await setup.cleanup() }
  }
})

test('generation and installation cancellation abort callbacks and reject late persistence', async () => {
  for (const operation of ['implement', 'install'] as const) {
    let release!: () => void, entered!: () => void
    let signal: AbortSignal | undefined
    let lateProgressRejected = false
    const entering = new Promise<void>(resolve => { entered = resolve })
    const waiting = new Promise<void>(resolve => { release = resolve })
    const setup = await fixture({ implement: async (_input, context) => {
      signal = context.signal
      entered()
      await waiting
      await assert.rejects(context.onProgress('late untrusted token=SECRET'), { name: 'AbortError' })
      lateProgressRejected = true
      return generated()
    },
      install: async (_workspace, abort) => { signal = abort; entered(); await waiting } })
    try {
      const id = await setup.prepare()
      const pending = operation === 'implement' ? setup.service.implement(1, id, 'token') : setup.service.install(1, id)
      await entering
      await assert.rejects(setup.service.implement(1, id, 'token'), { code: 'CONFLICT' })
      await assert.rejects(setup.service.install(1, id), { code: 'CONFLICT' })
      const cancelled = await setup.service.cancel(1, id)
      assert.equal(signal?.aborted, true)
      release()
      await pending
      if (operation === 'implement') assert.equal(lateProgressRejected, true)
      const report = await setup.service.report(1, id)
      assert.deepEqual(report.run, cancelled)
      const workspace = join(setup.root, 'testing', 'executions', id, 'workspace')
      await assert.rejects(lstat(join(workspace, '.codeflow-tests')), { code: 'ENOENT' })
      assert.equal(await readFile(join(workspace, 'sample.spec.ts'), 'utf8'), 'export {}\n')
      assert.ok(!JSON.stringify(report).includes('SECRET'))
    } finally { release(); await setup.cleanup() }
  }
})

test('generation cannot publish scripts when progress CAS fails or read-only model mutates business files', async () => {
  for (const kind of ['progress', 'mutation']) {
    const setup = await fixture({ implement: async (_input, context) => {
      if (kind === 'progress') await context.onProgress('untrusted raw token=SECRET')
      else await writeFile(join(context.workspace, 'business.ts'), 'changed')
      return generated()
    } })
    try {
      const run = await setup.service.create(1, setup.input)
      await setup.service.prepare(1, run.id)
      if (kind === 'progress') {
        const replace = setup.repo.replace.bind(setup.repo)
        setup.repo.replace = async (record, value, expected, owner) => {
          if (record === 'execution' && 'events' in value && value.events.at(-1)?.text === 'Implementation model progress; read-only session active.') throw new Error('storage token=SECRET')
          await replace(record, value, expected, owner)
        }
      }
      await assert.rejects(setup.service.implement(1, run.id, 'token'))
      const report = await setup.service.report(1, run.id)
      assert.equal(report.run.status, 'blocked')
      assert.ok(!JSON.stringify(report).includes('SECRET'))
      await assert.rejects(lstat(join(setup.root, 'testing', 'executions', run.id, 'workspace', '.codeflow-tests')), { code: 'ENOENT' })
    } finally { await setup.cleanup() }
  }
})

test('explicit reinstall resets approved bindings and results while preserving implementation review source', async () => {
  const setup = await fixture({ implement: async () => generated(), install: async workspace => { await fakeInstall(workspace) } })
  try {
    const id = await setup.prepare()
    await setup.service.implement(1, id, 'token')
    for (const mapping of generated().mappings) await setup.service.approve(1, id, mapping.caseId, {
      confirm: true, testFile: mapping.testFile, testTitle: mapping.testTitle, project: mapping.project, assertionIds: [`${mapping.caseId}:A001`],
    })
    assert.equal((await setup.service.report(1, id)).run.status, 'ready')
    const source = (await setup.service.binding(1, id, 'TC-1')).source
    await setup.service.install(1, id)
    const run = (await setup.service.report(1, id)).run as PreparedExecutionRun
    assert.equal(run.status, 'blocked')
    assert.equal(run.phase, 'awaiting_approval')
    assert.ok(run.cases.every(item => !item.binding && !item.result))
    assert.equal((await setup.service.binding(1, id, 'TC-1')).source, source)
  } finally { await setup.cleanup() }
})

test('repeated exact-source approvals accept manifest IDs and invalid approvals leave records unchanged', async () => {
  const setup = await fixture()
  try {
    const run = await setup.service.create(1, setup.input)
    await setup.service.prepare(1, run.id)
    for (let attempt = 0; attempt < 6; attempt++) {
      for (const caseId of ['TC-1', 'TC-2']) {
        const review = await setup.service.binding(1, run.id, caseId)
        const source = await readFile(join(setup.root, 'testing', 'executions', run.id, 'workspace', 'sample.spec.ts'), 'utf8')
        const body = { ...setup.approval(caseId), assertionIds: review.manifest.assertions.map(item => item.id) }
        const binding = await setup.service.approve(1, run.id, caseId, body)
        assert.equal(binding.testSourceFingerprint, createHash('sha256').update(source).digest('hex'), `attempt ${attempt}, ${caseId}`)
        assert.deepEqual(binding.assertionIds, [`${caseId}:A001`])
        assert.equal((await setup.service.binding(1, run.id, caseId)).source, source)
        const before = await setup.service.report(1, run.id)
        await assert.rejects(setup.service.approve(1, run.id, caseId, { ...body, assertionIds: ['TC-1:A999'] }), { code: 'INVALID_INPUT' })
        assert.deepEqual(await setup.service.report(1, run.id), before)
      }
    }
    assert.equal((await setup.service.report(1, run.id)).run.status, 'ready')
  } finally { await setup.cleanup() }
})

test('custom scope makes every selected case blocking, including optional and on-demand cases', async () => {
  const called: string[] = []
  const setup = await fixture({ runner: async options => {
    called.push(options.testCase.id)
    return { ...await passed(options), status: options.testCase.id === 'TC-3' ? 'failed' as const : 'passed' as const }
  } })
  try {
    const run = await setup.service.create(1, { ...setup.input, scope: { mode: 'custom', caseIds: ['TC-1', 'TC-2', 'TC-3'], reason: 'Explicit full gate' } })
    assert.ok(run.cases.every(item => item.selected && item.blocking))
    await setup.service.prepare(1, run.id)
    for (const item of run.cases) await setup.service.approve(1, run.id, item.caseId, setup.approval(item.caseId))
    await setup.service.start(1, run.id)
    const report = await setup.service.report(1, run.id)
    assert.equal(report.run.status, 'failed')
    assert.deepEqual(called, ['TC-1', 'TC-2', 'TC-3'])
    assert.deepEqual(report.run.cases.map(item => item.status), ['passed', 'passed', 'failed'])
    assert.deepEqual(report.casePackage, setup.value)
  } finally { await setup.cleanup() }
})

test('standalone real Playwright and Chrome preserve immutable inputs and retain nonblocking optional failures', { timeout: 180_000 }, async () => {
  const require = createRequire(import.meta.url)
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(request.url ?? '')
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><title>Execution fixture</title><div role="status">Expected state</div><button onclick="document.querySelector(\'[role=status]\').textContent=\'Updated state\'">Update</button>')
  })
  let models = 0, installs = 0
  const output = generated()
  output.files = output.files.map((file, index) => ({ ...file, content: `import { test, expect } from '@playwright/test'
test('${output.mappings[index].testTitle}', async ({ page, baseURL }) => {
  await page.goto(baseURL!)
  await test.step('[assertion:${output.mappings[index].caseId}:A001]', async () => {
    await expect(page.getByRole('status')).toHaveText('Expected state')
    await page.getByRole('button', { name: 'Update', exact: true }).click()
    await expect(page.getByRole('status')).toHaveText('${index === 0 ? 'Updated state' : 'Unexpected state'}', { timeout: 1000 })
  })
})
` }))
  const config = `export default { projects: [{ name: 'local-chrome' }], use: { channel: 'chrome', headless: true, baseURL: process.env.CODEFLOW_BASE_URL }, webServer: { command: 'node -e "process.exit(97)"', port: 9 } }\n`
  output.mappings.forEach(mapping => { mapping.project = 'local-chrome' })
  const setup = await fixture({ runner: undefined, implement: async (input, context) => {
    models++
    assert.equal(context.signal.aborted, false)
    assert.deepEqual(input.cases.map(item => item.id), ['TC-1', 'TC-2'])
    await context.onProgress('Untrusted progress token=DO_NOT_STORE')
    return JSON.parse(JSON.stringify(output)) as ExecutionModelResult
  }, install: async (workspace, signal) => {
    installs++
    assert.equal(signal.aborted, false)
    for (const name of ['@playwright/test', 'playwright', 'playwright-core']) {
      const metadataPath = require.resolve(`${name}/package.json`)
      assert.equal(JSON.parse(await readFile(metadataPath, 'utf8')).version, '1.63.0')
      await cp(dirname(metadataPath), join(workspace, 'node_modules', name), { recursive: true, dereference: true })
      assert.equal((await lstat(join(workspace, 'node_modules', name))).isSymbolicLink(), false)
    }
  } }, false, false, config)
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    setup.input.previewUrl = `http://127.0.0.1:${address.port}`
    const published = JSON.stringify(setup.value)
    const created = await setup.service.create(1, setup.input)
    await setup.service.prepare(1, created.id)
    assert.equal(models, 0)
    assert.equal(installs, 0)
    const workspace = join(setup.root, 'testing', 'executions', created.id, 'workspace')
    await setup.service.implement(1, created.id, 'ephemeral-token')
    await setup.service.install(1, created.id)
    for (const mapping of output.mappings) {
      const review = await setup.service.binding(1, created.id, mapping.caseId)
      const expected = output.files.find(file => file.path === mapping.testFile)!.content
      assert.equal(review.source, expected)
      assert.equal(review.binding, null)
      const binding = await setup.service.approve(1, created.id, mapping.caseId, {
        confirm: true, testFile: mapping.testFile, testTitle: mapping.testTitle, project: mapping.project,
        assertionIds: review.manifest.assertions.map(item => item.id),
      })
      assert.equal(binding.testSourceFingerprint, createHash('sha256').update(expected).digest('hex'))
    }
    const ready = await setup.service.report(1, created.id)
    assert.equal(ready.run.status, 'ready')
    await setup.service.start(1, created.id)
    const report = await setup.service.report(1, created.id)
    assert.equal(report.run.status, 'passed', JSON.stringify(report.run))
    assert.equal((report.run as PreparedExecutionRun).phase, 'finished')
    assert.equal(models, 1)
    assert.equal(installs, 1)
    for (const item of report.run.cases.filter(item => item.selected)) {
      const status = item.caseId === 'TC-1' ? 'passed' : 'failed'
      assert.equal(item.status, status)
      assert.equal(item.blocking, item.caseId === 'TC-1')
      assert.equal(item.result?.runner, 'playwright-test')
      assert.deepEqual(item.result?.assertions, [{ id: `${item.caseId}:A001`, status, expectCount: 2 }])
      assert.equal(item.binding?.designFingerprint, ready.run.workspaceFingerprint)
    }
    assert.equal(report.run.cases[2].status, 'skipped')
    assert.ok(requests.filter(url => url === '/').length >= 2)
    assert.equal(JSON.stringify(report.casePackage), published)
    assert.deepEqual(await setup.repo.get('package', setup.value.id, 1), setup.value)
    for (const file of output.files) assert.equal(await readFile(join(workspace, file.path), 'utf8'), file.content)
    assert.equal(await readFile(join(workspace, 'playwright.config.ts'), 'utf8'), config)
    assert.equal((await readdir(workspace)).some(name => name.startsWith('.codeflow-playwright-')), false)
    assert.ok(!JSON.stringify(report).includes('ephemeral-token'))
    assert.ok(!JSON.stringify(report).includes('DO_NOT_STORE'))
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await setup.cleanup()
  }
})