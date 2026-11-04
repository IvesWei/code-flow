import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { CopilotClient, type SessionEvent } from '@github/copilot-sdk'
import { CodingWorker } from '../../execution/worker.js'
import { TaskStore } from '../../tasks/store.js'
import { assessAcceptance } from '../../verification/acceptance.js'
import { caseInputs, fileFingerprint, fingerprint, selfTestRulesVersion, workspaceFingerprint } from '../../verification/self-test-artifacts.js'
import type { AcceptanceRequirement, SelfTestCase } from '../../../shared/task.js'

for (const scenario of ['execute-rejected', 'targeted-repair', 'custom-success', 'custom-current-success', 'custom-rejected', 'custom-unsupported-script', 'custom-node-typescript', 'custom-unchanged-file', 'custom-stale-unchanged-file', 'custom-changed-file', 'execute-failed'] as const) {
  test(`acceptance intent: ${scenario}`, async (context) => {
    const root = mkdtempSync(join(tmpdir(), 'acceptance-intent-'))
    context.after(() => rmSync(root, { recursive: true, force: true }))
    const workspace = join(root, 'workspaces', 'task')
    const prd = join(root, 'prd.md')
    writeFileSync(prd, 'Save and verify stored data')
    mkdirSync(workspace, { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: workspace })
    const baseline: AcceptanceRequirement[] = [{ id: 'REQ-001', source: 'PRD', criterion: 'Saved data', required: true, scenarios: ['normal'] }]
    const cases: SelfTestCase[] = Array.from({ length: 130 }, (_, index) => ({ id: `TC-${String(index + 1).padStart(2, '0')}`, title: `Save ${index}`, source: 'PRD', steps: 'Save then query', expected: 'Matches', requirementIds: ['REQ-001'], scenario: 'normal', preconditions: 'Service ready', testData: 'Independent data', assertions: ['Stored data matches'], cleanup: 'Delete data', status: 'manual' }))
    if (scenario.startsWith('custom')) cases[0].testFile = 'save.test.cjs'
    if (scenario === 'custom-success' || scenario === 'custom-current-success') cases[0] = { ...cases[0], status: 'passed', output: 'retained execution proof' }
    if (scenario === 'custom-stale-unchanged-file') cases[0] = { ...cases[0], status: 'passed', evidenceInputFingerprint: '0'.repeat(64), output: 'outdated proof' }
    if (scenario === 'custom-node-typescript') cases[0].testFile = 'save.test.ts'
    if (scenario.startsWith('custom') && scenario !== 'custom-success' && scenario !== 'custom-current-success') {
      writeFileSync(join(workspace, 'package.json'), JSON.stringify({ scripts: { test: scenario === 'custom-unsupported-script' ? 'unsupported-runner' : 'node --test' } }))
      writeFileSync(join(workspace, cases[0].testFile!), "const { test } = require('node:test'); const assert = require('node:assert/strict'); test('saved data', () => assert.equal(1 + 1, 2))\n")
      if (scenario === 'custom-unchanged-file' || scenario === 'custom-stale-unchanged-file') {
        execFileSync('git', ['add', '.'], { cwd: workspace })
        execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'Existing test'], { cwd: workspace })
      }
    }
    if (scenario === 'custom-current-success') {
      const sourceIdentity = fingerprint({ files: await fileFingerprint([prd]), instruction: 'Save', decisions: [], rules: selfTestRulesVersion })
      cases[0].evidenceInputFingerprint = fingerprint({ sourceIdentity, baseline, case: caseInputs([cases[0]]), workspace: await workspaceFingerprint(workspace), url: undefined })
    }
    if (scenario === 'execute-failed') cases[0] = { ...cases[0], status: 'failed', output: 'previous failure' }
    const rejected = { ...assessAcceptance(baseline, cases), status: 'rejected' as const, issues: ['TC-29 mapping', 'TC-41 session', 'TC-99 identity'] }
    const store = new TaskStore(join(root, 'tasks.json'))
    const now = new Date().toISOString()
    store.create({ id: 'task', repository: 'repo', instruction: 'Save', prdName: 'prd.md', designNames: [], status: 'ACCEPTED', workspace, createdBranch: 'task', createdAt: now, updatedAt: now, entries: [], acceptanceBaseline: baseline, selfTests: cases, acceptanceAssessment: scenario === 'execute-failed' ? assessAcceptance(baseline, cases) : rejected, selfTestPlanningStatus: 'rejected', checks: [], ...(scenario.startsWith('custom') ? { acceptanceSelection: { mode: 'custom' as const, caseIds: ['TC-01'], reason: 'Functional scope only', confirmedAt: now } } : {}) })
    const handlers = new Set<(event: SessionEvent) => void>()
    const repairedIds: string[] = []
    let generations = 0, reviews = 0, sessions = 0
    const session = {
      sessionId: 'intent-session',
      on(typeOrHandler: unknown, handler?: (event: SessionEvent) => void) {
        const callback = typeof typeOrHandler === 'function' ? typeOrHandler as (event: SessionEvent) => void : handler!
        const listener = (event: SessionEvent) => { if (typeof typeOrHandler === 'function' || event.type === typeOrHandler) callback(event) }
        handlers.add(listener)
        return () => { handlers.delete(listener) }
      },
      setModel: async () => {}, abort: async () => {}, disconnect: async () => {},
      send: async ({ prompt }: { prompt: string }) => {
        let content: string
        if (prompt.includes('只修正下列用例，')) {
          generations++
          const line = prompt.split('\n').find((line) => line.startsWith('只修正下列用例，'))!
          const targets = JSON.parse(line.slice(line.indexOf('：') + 1)) as SelfTestCase[]
          repairedIds.push(...targets.map((item) => item.id))
          content = JSON.stringify(targets.map((item) => ({ ...item, title: `${item.title} repaired` })))
        } else {
          assert.ok(!prompt.includes('当前批次必须覆盖'), 'must never generate unrelated cases')
          reviews++
          if (scenario.startsWith('custom')) {
            assert.match(prompt, /只读评审本次选中用例/)
            assert.ok(!prompt.includes('TC-02'))
          }
          content = JSON.stringify(scenario.startsWith('custom') ? { findings: scenario === 'custom-rejected' ? [{ code: 'requirement_conflict', category: 'conflict', message: 'Contradicts requirement', caseIds: ['TC-01'] }] : [] } : { qualified: true, issues: [], caseIssues: [] })
        }
        for (const event of [{ type: 'assistant.message', data: { content } }, { type: 'session.idle', data: {} }]) for (const handler of handlers) handler(event as SessionEvent)
        return 'message'
      },
    }
    context.mock.method(CopilotClient.prototype, 'createSession', async () => { sessions++; return session })
    context.mock.method(CopilotClient.prototype, 'resumeSession', async () => session)
    context.mock.method(CopilotClient.prototype, 'stop', async () => [])
    await new CodingWorker(store, root).execute(store.get('task')!, prd, [], 'test-token', undefined, true, true, [], scenario === 'targeted-repair' ? 'repair' : 'execute')
    const result = store.get('task')!
    if (scenario === 'targeted-repair') {
      assert.equal(generations, 1)
      assert.deepEqual(repairedIds, ['TC-29', 'TC-41', 'TC-99'])
      assert.equal(result.selfTests?.length, 130)
      assert.deepEqual(result.selfTests![0], cases[0])
    } else {
      assert.equal(generations, 0)
      assert.equal(result.entries.some((entry) => entry.text.startsWith('用例批次') || entry.text.startsWith('按需求场景分批生成')), false)
      assert.deepEqual(caseInputs(result.selfTests || []), caseInputs(cases), 'execution never rewrites or generates definitions')
      if (scenario === 'execute-rejected' || scenario === 'custom-rejected') assert.deepEqual(result.selfTests, cases)
      assert.deepEqual(result.acceptanceAssessment, scenario === 'execute-failed' ? result.acceptanceAssessment : rejected)
      if (scenario === 'execute-failed') {
        assert.equal(result.acceptanceAssessment?.status, 'qualified', 'default design review is preserved when execution lacks resources')
        assert.ok(result.acceptanceAssessment?.caseReviews?.every(review => review.status === 'qualified'))
        assert.equal(result.selfTests?.[0].status, 'manual')
        assert.match(result.selfTests![0].output!, /执行准备受阻/)
      }
      const executed = ['custom-changed-file', 'custom-unchanged-file', 'custom-stale-unchanged-file'].includes(scenario)
      assert.equal(result.status, scenario === 'custom-success' || scenario === 'custom-current-success' || executed ? 'SUCCESS' : 'REVIEW')
      const preparationBlocked = ['custom-unsupported-script', 'custom-node-typescript'].includes(scenario)
      assert.equal(reviews, scenario.startsWith('custom') ? 1 : scenario === 'execute-failed' ? 17 : 0)
      if (preparationBlocked) {
        assert.equal(sessions, 1, 'design review runs independently of runner availability')
        assert.equal(result.executionAssessment?.readiness, 'ready')
        assert.equal(result.executionAssessment?.findings?.some(finding => finding.category === 'executability'), false)
        assert.deepEqual(result.executionAssessment?.caseReviews, [{ caseId: 'TC-01', status: 'warning' }])
        assert.ok(result.testExecutionPlan)
        assert.equal(result.selfTests?.[0].status, 'manual')
        assert.match(result.selfTests![0].output!, /执行准备受阻/)
      }
      if (executed) {
        assert.equal(sessions, 1)
        assert.equal(result.executionAssessment?.readiness, 'ready')
        assert.equal(result.selfTests?.[0].status, 'passed')
        assert.ok(result.selfTests?.[0].evidenceInputFingerprint)
        assert.match(result.selfTests![0].output!, /node --test save\.test\.cjs/)
        assert.equal(result.selfTestArtifacts?.some(artifact => artifact.scope.startsWith('generation-request:')), false, 'existing tests are not new generated files')
      }
      if (scenario === 'custom-success' || scenario === 'custom-current-success') {
        assert.equal(result.executionAssessment?.status, 'rejected', 'legacy classification remains a quality warning')
        assert.equal(result.executionAssessment?.readiness, 'ready')
        assert.equal(result.testExecutionPlan?.mode, 'custom')
        assert.equal(result.testExecutionPlan?.cases.filter((item) => item.selected).length, 1)
        assert.match(result.entries.at(-1)!.text, /用户选择范围/)
      }
    }
  })
}