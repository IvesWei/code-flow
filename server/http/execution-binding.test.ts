import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { Express, Request, Response } from 'express'
import type { CodingTask } from '../../shared/task.js'
import { buildAssertionManifest, type TestExecutionResult } from '../../shared/test-execution.js'
import { defaultModel } from '../execution/models.js'
import { TaskStore } from '../tasks/store.js'
import { caseInputs, fileFingerprint, fingerprint, selfTestRulesVersion, workspaceFingerprint } from '../verification/self-test-artifacts.js'
import { buildCaseExecutionFingerprint } from '../verification/playwright-test.js'
import { parseExecutionBindingApproval, registerExecutionBindings } from './execution-binding.js'

const body = { testFile: 'approved.spec.ts', testTitle: 'checkout submits', project: '', assertionIds: ['TC-01:A001', 'TC-01:A002'], confirm: true }

test('approval parser requires explicit human confirmation and rejects authority fields and partial mappings', () => {
  const manifest = { version: 1 as const, caseId: 'TC-01', definitionKey: '', assertions: body.assertionIds.map(id => ({ id, definition: id })) }
  assert.deepEqual(parseExecutionBindingApproval(body, manifest), body)
  for (const value of [null, [], { ...body, confirm: false }, { ...body, confirm: 'true' }, { ...body, approvedBy: 'attacker' },
    { ...body, approvedAt: '2026-01-01' }, { ...body, reviewedAt: '2026-01-01' }, { ...body, testSourceFingerprint: 'forged' },
    { ...body, assertionIds: ['TC-01:A001'] }, { ...body, assertionIds: [...body.assertionIds].reverse() },
    { ...body, assertionIds: ['TC-01:A001', 'TC-01:A001'] }, { ...body, testTitle: ' ' }, { ...body, project: null },
    { ...body, testFile: '../outside.spec.ts' }, { ...body, testFile: '/outside.spec.ts' }, { ...body, testFile: 'C:\\outside.spec.ts' },
    { ...body, testFile: 'file.spec.ts:stream' }, { ...body, testFile: 'plain.ts' }]) {
    assert.throws(() => parseExecutionBindingApproval(value, manifest))
  }
  assert.throws(() => parseExecutionBindingApproval(body, { ...manifest, assertions: [] }))
  assert.throws(() => parseExecutionBindingApproval(body, { ...manifest, assertions: manifest.assertions.map(item => ({ ...item, definition: ' ' })) }))
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'codeflow-binding-'))
  const workspace = path.join(root, 'workspaces', 'task')
  await mkdir(workspace, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: workspace, windowsHide: true })
  await mkdir(path.join(root, 'uploads', 'task'), { recursive: true })
  await writeFile(path.join(root, 'uploads', 'task', 'prd.md'), 'Checkout requirements')
  const source = 'throw new Error("Approval must never execute this source")\n'
  await writeFile(path.join(workspace, body.testFile), source)
  const now = new Date(Date.now() - 1000).toISOString()
  const task: CodingTask = {
    id: 'task', ownerId: 7, repository: 'repo', instruction: 'Checkout goal', prdName: 'prd.md', designNames: [],
    workspace, status: 'REVIEW', createdAt: now, updatedAt: now, entries: [],
    acceptanceBaseline: [{ id: 'REQ-001', source: 'prd', criterion: 'submit', required: true, scenarios: ['normal'] }],
    selfTests: [{ id: 'TC-01', title: 'Checkout', source: 'prd', steps: 'submit', expected: 'saved', assertions: ['Saved', 'Visible'], testFile: 'generated.test.ts', status: 'pending' }],
  }
  const store = await TaskStore.fromPersistence({ load: async () => [], save: async () => {} })
  const flushChanges = store.flush.bind(store)
  store.create(task)
  let ownerId: number | undefined = 7
  let busy = false
  let onAuthenticate: (() => void) | undefined
  const routes = new Map<string, (request: Request, response: Response) => Promise<unknown>>()
  const app = Object.fromEntries(['get', 'post'].map(method => [method, (route: string, handler: typeof routes extends Map<string, infer Handler> ? Handler : never) => routes.set(`${method} ${route}`, handler)])) as unknown as Express
  registerExecutionBindings(app, store, {
    root,
    authenticate: async () => { onAuthenticate?.(); return ownerId === undefined ? undefined : { ownerId } },
    isBusy: () => busy,
  })
  async function review(custom = false) {
    const current = store.get('task')!
    const sourceIdentity = fingerprint({ files: await fileFingerprint([path.join(root, 'uploads', 'task', 'prd.md')]), instruction: current.instruction, decisions: current.confirmedDecisions || [], rules: selfTestRulesVersion })
    const assessment = {
      status: 'qualified' as const, checkedAt: new Date(Date.now() - 100).toISOString(), issues: [], coveredIds: ['REQ-001'], missingIds: [],
      inputFingerprint: fingerprint({ sourceIdentity, baseline: current.acceptanceBaseline, cases: caseInputs(current.selfTests!), workspace: await workspaceFingerprint(workspace), mode: custom ? 'custom' : 'default', reason: custom ? 'focused' : '', model: current.modelId || defaultModel(), rules: selfTestRulesVersion }),
    }
    store.update('task', custom ? {
      acceptanceSelection: { mode: 'custom', caseIds: ['TC-01'], reason: 'focused', confirmedAt: now },
      acceptanceAssessment: { ...assessment, status: 'rejected' },
      executionAssessment: { ...assessment, status: 'rejected', readiness: 'ready', caseIds: ['TC-01'] },
    } : { acceptanceAssessment: assessment })
  }
  async function request(method = 'post', payload: unknown = body, origin?: string, caseId = 'TC-01') {
    await flushChanges()
    let status = 200
    let result: any
    const response = { set: () => response, status: (code: number) => { status = code; return response }, json: (value: unknown) => { result = value; return response } } as unknown as Response
    const req = { body: payload, params: { id: 'task', caseId }, get: (name: string) => name === 'origin' ? origin : undefined } as unknown as Request
    await routes.get(`${method} /api/tasks/:id/execution-bindings/:caseId`)!(req, response)
    return { status, body: result }
  }
  await review()
  return { root, workspace, source, store, request, review, owner: (value: number | undefined) => { ownerId = value }, busy: (value: boolean) => { busy = value }, onAuthenticate: (callback: () => void) => { onAuthenticate = callback }, close: () => rm(root, { recursive: true, force: true }) }
}

test('owner approves complete mapping with server authority, current fingerprints and source hash without executing it', async () => {
  const context = await fixture()
  try {
    const before = context.store.get('task')!
    const result = await context.request()
    assert.equal(result.status, 200)
    const binding = result.body.binding
    assert.equal(binding.approvedBy, '7')
    assert.equal(binding.approvedAt, binding.reviewedAt)
    assert.ok(Date.parse(binding.approvedAt) >= Date.parse(before.acceptanceAssessment!.checkedAt))
    assert.equal(binding.caseFingerprint, buildCaseExecutionFingerprint(before.selfTests![0]))
    assert.equal(binding.designFingerprint, await workspaceFingerprint(context.workspace))
    assert.equal(binding.testSourceFingerprint, createHash('sha256').update(context.source).digest('hex'))
    assert.equal(binding.testFile, body.testFile)
    assert.deepEqual(binding.assertionIds, body.assertionIds)
    assert.deepEqual((context.store.committed('task')!.selfTests![0] as any).executionBinding, binding)
    assert.equal(context.store.get('task')!.selfTests![0].status, 'pending')
    assert.equal(context.store.get('task')!.status, 'REVIEW')
    const manifest = await context.request('get')
    assert.equal(manifest.status, 200)
    assert.deepEqual(manifest.body.manifest, buildAssertionManifest(before.selfTests![0]))
    assert.equal(manifest.body.caseFingerprint, binding.caseFingerprint)
    assert.equal(manifest.body.designFingerprint, binding.designFingerprint)
    assert.equal(manifest.body.binding.testSourceFingerprint, binding.testSourceFingerprint)
    assert.equal(JSON.stringify(manifest.body).includes(context.source), false)
  } finally { await context.close() }
})

test('authentication, ownership, Origin, busy states and missing cases cannot grant approval', async () => {
  const context = await fixture()
  try {
    context.owner(undefined)
    assert.equal((await context.request()).status, 401)
    assert.equal((await context.request('get')).status, 401)
    context.owner(8)
    assert.equal((await context.request()).status, 404)
    assert.equal((await context.request('get')).status, 404)
    context.owner(7)
    assert.equal((await context.request('post', body, 'https://evil.example')).status, 403)
    assert.equal((await context.request('post', body, undefined, 'missing')).status, 404)
    context.busy(true)
    assert.equal((await context.request()).status, 409)
    context.busy(false)
    for (const patch of [{ status: 'TEST_EXECUTION' as const }, { status: 'REVIEW' as const, modelInTurn: true }, { modelInTurn: false, modelTurn: { id: 'turn', label: 'busy', startedAt: '', lastActivityAt: '', summary: '', inactivityTimeoutMs: 1000, status: 'running' as const } }]) {
      context.store.update('task', patch)
      assert.equal((await context.request()).status, 409)
    }
    assert.equal((context.store.get('task')!.selfTests![0] as any).executionBinding, undefined)
  } finally { await context.close() }
})

test('approval rejects unreviewed, stale, future and changed definitions, attachments or workspace', async () => {
  const context = await fixture()
  try {
    const original = context.store.get('task')!
    assert.throws(() => context.store.update('task', { acceptanceAssessment: { ...original.acceptanceAssessment!, checkedAt: 'bad' } }), /Invalid timestamp/)
    for (const assessment of [undefined, { ...original.acceptanceAssessment!, status: 'rejected' as const }, { ...original.acceptanceAssessment!, inputFingerprint: '0'.repeat(64) }, { ...original.acceptanceAssessment!, checkedAt: '2999-01-01T00:00:00.000Z' }]) {
      context.store.update('task', { acceptanceAssessment: assessment })
      assert.equal((await context.request()).status, 409)
    }
    context.store.update('task', { acceptanceAssessment: original.acceptanceAssessment, selfTests: [{ ...original.selfTests![0], expected: 'changed' }] })
    assert.equal((await context.request()).status, 409)
    context.store.update('task', { selfTests: original.selfTests })
    await writeFile(path.join(context.workspace, body.testFile), 'changed source')
    assert.equal((await context.request()).status, 409)
    await context.review()
    await writeFile(path.join(context.root, 'uploads', 'task', 'prd.md'), 'Changed requirements')
    assert.equal((await context.request()).status, 409)
    assert.equal((context.store.get('task')!.selfTests![0] as any).executionBinding, undefined)
  } finally { await context.close() }
})

test('custom ready approval requires exact selected scope, reason and review after confirmation', async () => {
  const context = await fixture()
  try {
    await context.review(true)
    const current = context.store.get('task')!
    for (const patch of [
      { executionAssessment: { ...current.executionAssessment!, readiness: 'blocked' as const } },
      { executionAssessment: { ...current.executionAssessment!, caseIds: ['TC-02'] } },
      { executionAssessment: { ...current.executionAssessment!, checkedAt: current.createdAt } , acceptanceSelection: { ...current.acceptanceSelection!, confirmedAt: new Date().toISOString() } },
      { acceptanceSelection: { ...current.acceptanceSelection!, reason: 'changed' } },
      { acceptanceSelection: { ...current.acceptanceSelection!, caseIds: ['TC-02'] } },
    ]) {
      context.store.update('task', { executionAssessment: current.executionAssessment, acceptanceSelection: current.acceptanceSelection, ...patch })
      assert.equal((await context.request()).status, 409)
    }
    context.store.update('task', { executionAssessment: current.executionAssessment, acceptanceSelection: current.acceptanceSelection })
    assert.equal((await context.request()).status, 200)
  } finally { await context.close() }
})

test('source validation refuses missing, oversized and symlinked files; async task changes are rechecked', async () => {
  const context = await fixture()
  try {
    assert.equal((await context.request('post', { ...body, testFile: 'missing.spec.ts' })).status, 400)
    await writeFile(path.join(context.workspace, 'large.spec.ts'), Buffer.alloc(128 * 1024 + 1))
    await context.review()
    assert.equal((await context.request('post', { ...body, testFile: 'large.spec.ts' })).status, 400)
    await symlink(context.workspace, path.join(context.workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal((await context.request('post', { ...body, testFile: 'linked/approved.spec.ts' })).status, 400)
    await rm(path.join(context.workspace, 'linked'), { recursive: true, force: true })
    await context.review()
    let checks = 0
    context.busy(false)
    context.onAuthenticate(() => { checks = 0 })
    const originalGet = context.store.get.bind(context.store)
    context.store.get = (id) => {
      checks++
      if (checks === 1) context.busy(true)
      return originalGet(id)
    }
    assert.equal((await context.request()).status, 409)
    assert.equal((originalGet('task')!.selfTests![0] as any).executionBinding, undefined)
  } finally { await context.close() }
})

for (const status of ['SUCCESS', 'ACCEPTED'] as const) test(`${status}: changed approval invalidates evidence and green status; identical reapproval preserves them`, async () => {
  const context = await fixture()
  try {
    context.store.update('task', { status })
    assert.equal((await context.request()).status, 200)
    assert.equal(context.store.get('task')!.status, 'REVIEW')
    const current = context.store.get('task')!
    const result: TestExecutionResult = { version: 1, runner: 'playwright-test', caseId: 'TC-01', caseFingerprint: buildCaseExecutionFingerprint(current.selfTests![0]), status: 'passed', reason: 'old execution', assertions: body.assertionIds.map(id => ({ id, status: 'passed', expectCount: 1 })), startedAt: current.createdAt, finishedAt: current.updatedAt }
    const passed = { ...current.selfTests![0], status: 'passed' as const, executionResult: result, evidenceInputFingerprint: '0'.repeat(64) }
    const otherCase = { ...current.selfTests![0], id: 'TC-02' }
    const runs = [{ caseId: 'TC-01', status: 'passed' as const, executionResult: result }, { caseId: 'TC-02', status: 'passed' as const, output: 'unrelated evidence' }]
    context.store.update('task', { selfTests: [passed, otherCase], automationRuns: runs })
    await context.review()
    assert.equal((await context.request()).status, 200)
    context.store.update('task', { status, selfTests: [{ ...context.store.get('task')!.selfTests![0], ...passed }, otherCase], automationRuns: runs })
    assert.equal((await context.request()).status, 200)
    assert.equal(context.store.get('task')!.status, status)
    assert.equal(context.store.get('task')!.selfTests![0].status, 'passed')
    assert.deepEqual(context.store.get('task')!.selfTests![0].executionResult, result)
    assert.deepEqual(context.store.get('task')!.automationRuns, runs)
    assert.equal((await context.request('post', { ...body, testTitle: 'checkout alternate' })).status, 200)
    const saved = context.store.committed('task')!
    const updated = saved.selfTests![0]
    assert.equal(saved.status, 'REVIEW')
    assert.equal(updated.status, 'pending')
    assert.equal(updated.executionResult, undefined)
    assert.equal(updated.evidenceInputFingerprint, undefined)
    assert.deepEqual(saved.automationRuns, [runs[1]])
    assert.deepEqual(saved.selfTests![1], otherCase)
  } finally { await context.close() }
})

test('failed persistence never acknowledges approval', async () => {
  const context = await fixture()
  try {
    context.store.flush = async () => { throw new Error('private storage failure') }
    const response = await context.request()
    assert.equal(response.status, 503)
    assert.equal(response.body.binding, undefined)
    assert.doesNotMatch(JSON.stringify(response.body), /private storage failure/)
  } finally { await context.close() }
})