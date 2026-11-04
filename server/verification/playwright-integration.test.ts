import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { CopilotClient, type SessionEvent } from '@github/copilot-sdk'
import type { SelfTestCase } from '../../shared/task.js'
import type { TestExecutionResult } from '../../shared/test-execution.js'
import { CodingWorker } from '../execution/worker.js'
import { TaskStore } from '../tasks/store.js'
import { buildCaseExecutionFingerprint } from './playwright-test.js'
import { executeTestCase, mergeTestPlan, shouldRunBrowserCase } from './self-test.js'
import { caseInputs, fileFingerprint, fingerprint, selfTestRulesVersion, workspaceFingerprint } from './self-test-artifacts.js'

function fixture(context: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'playwright-integration-'))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspaces', 'task')
  mkdirSync(workspace, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: workspace })
  writeFileSync(join(workspace, '.gitignore'), 'node_modules/\n')
  return { root, workspace }
}

function testCase(): SelfTestCase {
  return { id: 'TC-01', title: 'Save data', source: 'PRD', steps: 'Save then query', expected: 'Stored data matches', requirementIds: ['REQ-001'], scenario: 'normal', preconditions: 'Service ready', testData: 'Independent data', assertions: ['Stored data matches'], cleanup: 'Delete data', status: 'pending' }
}

function oldResult(item: SelfTestCase): TestExecutionResult {
  return { version: 1, runner: 'playwright-test', caseId: item.id, caseFingerprint: buildCaseExecutionFingerprint(item), status: 'passed', reason: 'Historical result', assertions: [{ id: `${item.id}:A001`, status: 'passed', expectCount: 1 }], startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:01Z' }
}

async function bind(workspace: string, item: SelfTestCase, source: string) {
  item.executionBinding = { version: 1, caseFingerprint: buildCaseExecutionFingerprint(item), designFingerprint: await workspaceFingerprint(workspace), testSourceFingerprint: createHash('sha256').update(source).digest('hex'), testFile: 'save.spec.ts', testTitle: 'bound save', project: 'local', assertionIds: [`${item.id}:A001`], approvedBy: 'reviewer', approvedAt: '2026-01-01T00:00:00Z', reviewedAt: '2026-01-01T00:00:00Z' }
}

function mockReview(context: TestContext, browserPlan?: string) {
  let reviews = 0
  context.mock.method(CopilotClient.prototype, 'resumeSession', async () => { throw new Error('No coding session permitted') })
  context.mock.method(CopilotClient.prototype, 'stop', async () => [])
  context.mock.method(CopilotClient.prototype, 'createSession', async () => {
    const handlers = new Set<(event: SessionEvent) => void>()
    return {
      sessionId: `review-${reviews}`, setModel: async () => {}, abort: async () => {}, disconnect: async () => {},
      on(typeOrHandler: unknown, callback?: (event: SessionEvent) => void) {
        const handler = typeof typeOrHandler === 'function' ? typeOrHandler as (event: SessionEvent) => void : (event: SessionEvent) => { if (event.type === typeOrHandler) callback!(event) }
        handlers.add(handler)
        return () => { handlers.delete(handler) }
      },
      send: async ({ prompt }: { prompt: string }) => {
        const review = prompt.includes('独立用例质量评审者')
        if (review) reviews++
        else {
          assert.match(prompt, /先只读检查工作目录/)
          assert.ok(browserPlan, 'unexpected browser fallback')
        }
        const content = review ? JSON.stringify({ findings: [] }) : browserPlan!
        for (const event of [{ type: 'assistant.message', data: { content } }, { type: 'session.idle', data: {} }]) for (const handler of handlers) handler(event as SessionEvent)
        return 'message'
      },
    }
  })
  return () => reviews
}

test('legacy runner and generation repair discard stale structured results and evidence', async (context) => {
  const { workspace } = fixture(context)
  writeFileSync(join(workspace, 'save.test.cjs'), "const { test } = require('node:test'); const assert = require('node:assert/strict'); test('save', () => assert.equal(1, 1));\n")
  const item = { ...testCase(), testFile: 'save.test.cjs', executionResult: oldResult(testCase()), evidenceInputFingerprint: 'old', finishedAt: '2026-01-01T00:00:01Z' }
  for (const script of ['node --test', 'unsupported']) {
    const result = await executeTestCase(workspace, item, script)
    assert.equal(result.status, script === 'node --test' ? 'passed' : 'manual')
    assert.equal(result.executionResult, undefined)
    assert.equal(result.evidenceInputFingerprint, undefined)
    assert.notEqual(result.finishedAt, item.finishedAt)
  }
  await bind(workspace, item, '')
  assert.equal(shouldRunBrowserCase({ ...item, testFile: undefined }, 'http://127.0.0.1:3000'), false)
  const repaired = mergeTestPlan(JSON.stringify([{ ...item, title: 'Repaired definition' }]), [{ ...item, status: 'failed' }], [item.id])[0]
  assert.equal(repaired.executionBinding, undefined)
  assert.equal(repaired.executionResult, undefined)
  assert.equal(repaired.evidenceInputFingerprint, undefined)
})

test('bound execution independently checks definition, workspace snapshot and source hash without legacy fallback', async (context) => {
  const { workspace } = fixture(context)
  const source = "const { test } = require('node:test'); const assert = require('node:assert/strict'); test('legacy', () => assert.equal(1, 1));\n"
  writeFileSync(join(workspace, 'save.spec.ts'), source)
  const item = { ...testCase(), testFile: 'save.spec.ts' }
  await bind(workspace, item, source)
  for (const invalid of [
    { ...item, assertions: ['Changed definition'] },
    { ...item, executionBinding: { ...item.executionBinding!, designFingerprint: 'old-snapshot' } },
    { ...item, executionBinding: { ...item.executionBinding!, testSourceFingerprint: 'old-source' } },
  ]) {
    const result = await executeTestCase(workspace, { ...invalid, executionResult: oldResult(item) }, 'node --test')
    assert.equal(result.status, 'manual')
    assert.equal(result.executionResult?.status, 'blocked')
    assert.match(result.executionResult!.reason, /binding|source/)
    assert.equal(result.evidenceInputFingerprint, undefined)
  }
})

for (const historicalStatus of ['passed', 'failed', 'manual', 'skipped', 'pending', 'invalid', 'running'] as const) {
  test(`explicit worker execution rechecks ${historicalStatus} binding and persists blocked evidence`, async (context) => {
    const { root, workspace } = fixture(context)
    const reviews = mockReview(context)
    const prd = join(root, 'prd.md')
    writeFileSync(prd, 'Save then query stored data')
    const item = { ...testCase(), status: historicalStatus, executionResult: oldResult(testCase()) }
    await bind(workspace, item, '')
    item.executionBinding!.caseFingerprint = 'stale-definition'
    const store = new TaskStore(join(root, 'tasks.json'))
    const now = new Date().toISOString()
    store.create({ id: 'task', repository: 'repo', instruction: 'Save', prdName: 'prd.md', designNames: [], status: 'REVIEW', entries: [], createdAt: now, updatedAt: now, workspace, automationUrl: 'http://127.0.0.1:1', acceptanceBaseline: [{ id: 'REQ-001', source: 'PRD', criterion: 'Stored data matches', required: true, scenarios: ['normal'] }], selfTests: [item], acceptanceSelection: { mode: 'custom', caseIds: [item.id], reason: 'Binding scope', confirmedAt: now }, checks: [] })
    await new CodingWorker(store, root).execute(store.get('task')!, prd, [], 'test-token', undefined, true, false, [], 'execute')
    const result = store.get('task')!
    if (historicalStatus === 'invalid') {
      assert.equal(reviews(), 0)
      assert.equal(result.executionAssessment?.readiness, 'blocked')
      assert.equal(result.status, 'REVIEW')
      assert.equal(result.testExecutionPlan, undefined)
      assert.equal(result.automationRuns?.length || 0, 0)
      return
    }
    assert.equal(reviews(), 1, 'bound execution must never invoke DSL planning')
    assert.equal(result.selfTestError, undefined)
    assert.equal(result.executionAssessment?.readiness, 'ready')
    assert.equal(result.status, 'REVIEW')
    assert.equal(result.selfTests![0].status, 'manual')
    assert.equal(result.selfTests![0].executionResult?.status, 'blocked')
    assert.equal(result.selfTests![0].evidenceInputFingerprint, undefined)
    assert.equal(result.automationRuns?.length, 1)
    assert.equal(result.automationRuns![0].runner, 'playwright-test')
    assert.equal(result.automationRuns![0].status, 'blocked')
    assert.deepEqual(result.automationRuns![0].executionResult, result.selfTests![0].executionResult)
    assert.equal(new TaskStore(join(root, 'tasks.json')).get('task')!.automationRuns![0].status, 'blocked')
  })
}

for (const route of ['legacy', 'dsl', 'missing'] as const) {
  test(`worker clears stale Playwright result and run before ${route} execution`, async (context) => {
    const { root, workspace } = fixture(context)
    mockReview(context, route === 'dsl' ? JSON.stringify({ blocked: true, reason: 'No isolated application fixture', reasonCode: 'environment' }) : undefined)
    const item = { ...testCase(), executionResult: oldResult(testCase()), evidenceInputFingerprint: fingerprint({ version: 'old' }), startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:01Z' }
    if (route === 'legacy') {
      Object.assign(item, { testFile: 'save.test.cjs' })
      writeFileSync(join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
      writeFileSync(join(workspace, 'save.test.cjs'), "const { test } = require('node:test'); const assert = require('node:assert/strict'); test('save', () => assert.equal(1, 1));\n")
    }
    const prd = join(root, 'prd.md')
    writeFileSync(prd, 'Save then query stored data')
    const store = new TaskStore(join(root, 'tasks.json'))
    const now = new Date().toISOString()
    store.create({ id: 'task', repository: 'repo', instruction: 'Save', prdName: 'prd.md', designNames: [], status: 'REVIEW', entries: [], createdAt: now, updatedAt: now, workspace, automationUrl: route === 'dsl' ? 'http://127.0.0.1:1' : undefined, acceptanceBaseline: [{ id: 'REQ-001', source: 'PRD', criterion: 'Stored data matches', required: true, scenarios: ['normal'] }], selfTests: [item], acceptanceSelection: { mode: 'custom', caseIds: [item.id], reason: 'Fresh route', confirmedAt: now }, automationRuns: [{ caseId: item.id, runner: 'playwright-test', executionResult: item.executionResult, status: 'passed', startedAt: item.startedAt, finishedAt: item.finishedAt }], checks: [] })
    await new CodingWorker(store, root).execute(store.get('task')!, prd, [], 'test-token', undefined, true, false, [], 'execute')
    const result = store.get('task')!
    assert.equal(result.selfTestError, undefined)
    assert.equal(result.status, route === 'legacy' ? 'SUCCESS' : 'REVIEW')
    assert.equal(result.selfTests![0].executionResult, undefined)
    assert.notEqual(result.selfTests![0].evidenceInputFingerprint, item.evidenceInputFingerprint)
    assert.notEqual(result.selfTests![0].finishedAt, item.finishedAt)
    assert.equal(result.automationRuns?.some(run => run.runner === 'playwright-test' || run.executionResult), false)
    assert.equal(result.automationRuns?.length, route === 'dsl' ? 1 : 0)
    if (route === 'dsl') assert.equal(result.automationRuns![0].status, 'blocked')
  })
}

for (const complete of [true, false]) {
  test(`worker persists ${complete ? 'complete' : 'incomplete'} actual Playwright reports and reexecutes current passed bindings`, async (context) => {
    const { root, workspace } = fixture(context)
    mockReview(context)
    const require = createRequire(import.meta.url)
    mkdirSync(join(workspace, 'node_modules', '@playwright'), { recursive: true })
    symlinkSync(dirname(require.resolve('@playwright/test/package.json')), join(workspace, 'node_modules', '@playwright', 'test'), process.platform === 'win32' ? 'junction' : 'dir')
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
    writeFileSync(join(workspace, 'playwright.config.ts'), "export default { projects: [{ name: 'local' }] };\n")
    const source = `import { test, expect } from '@playwright/test';\ntest('bound save', async () => { ${complete ? "await test.step('[assertion:TC-01:A001]', async () => { expect(1).toBe(1); });" : 'expect(1).toBe(1);'} });\n`
    writeFileSync(join(workspace, 'save.spec.ts'), source)
    const item = testCase()
    await bind(workspace, item, source)
    const store = new TaskStore(join(root, 'tasks.json'))
    const now = new Date().toISOString()
    const prd = join(root, 'prd.md')
    writeFileSync(prd, 'Save then query stored data')
    const baseline = [{ id: 'REQ-001', source: 'PRD', criterion: 'Stored data matches', required: true, scenarios: ['normal' as const] }]
    store.create({ id: 'task', repository: 'repo', instruction: 'Save', prdName: 'prd.md', designNames: [], status: 'REVIEW', entries: [], createdAt: now, updatedAt: now, workspace, acceptanceBaseline: baseline, selfTests: [item], acceptanceSelection: { mode: 'custom', caseIds: [item.id], reason: 'Binding scope', confirmedAt: now }, checks: [] })
    const execute = () => new CodingWorker(store, root).execute(store.get('task')!, prd, [], 'test-token', undefined, true, false, [], 'execute')
    await execute()
    const result = store.get('task')!
    assert.equal(result.selfTestError, undefined)
    assert.equal(result.status, complete ? 'SUCCESS' : 'REVIEW')
    assert.equal(result.selfTests![0].executionResult?.status, complete ? 'passed' : 'incomplete')
    assert.equal(result.automationRuns![0].status, complete ? 'passed' : 'skipped')
    if (!complete) return
    const sourceIdentity = fingerprint({ files: await fileFingerprint([prd]), instruction: 'Save', decisions: [], rules: selfTestRulesVersion })
    const passed = result.selfTests![0]
    assert.equal(passed.evidenceInputFingerprint, fingerprint({ sourceIdentity, baseline, case: caseInputs([passed]), executionBinding: passed.executionBinding, workspace: await workspaceFingerprint(workspace), url: undefined }))
    await execute()
    const rerun = store.get('task')!.selfTests![0]
    assert.equal(rerun.executionResult?.status, 'passed')
    assert.notEqual(rerun.executionResult?.startedAt, passed.executionResult?.startedAt, 'matching historical pass must be executed again')
    assert.equal(store.get('task')!.automationRuns!.length, 1)
  })
}