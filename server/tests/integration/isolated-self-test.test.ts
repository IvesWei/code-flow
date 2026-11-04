import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { CopilotClient, type SessionConfig, type SessionEvent } from '@github/copilot-sdk'
import { CodingWorker } from '../../execution/worker.js'
import { TaskStore } from '../../tasks/store.js'
import { fingerprint } from '../../verification/self-test-artifacts.js'
import type { SelfTestCase } from '../../../shared/task.js'

for (const mode of ['default', 'custom', 'partial-warning', 'partial-rejection', 'mid-review-change', 'evidence-change'] as const) {
  test(`isolated ${mode} review resumes completed batches after reload and invalidates changed inputs`, async (context) => {
    const root = mkdtempSync(join(tmpdir(), 'isolated-review-'))
    context.after(() => rmSync(root, { recursive: true, force: true }))
    const workspace = join(root, 'workspaces', 'task')
    mkdirSync(workspace, { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: workspace })
    const prd = join(root, 'prd.md')
    writeFileSync(prd, 'Save then query stored data')
    const file = join(root, 'tasks.json')
    let store = new TaskStore(file)
    const now = new Date().toISOString()
    const custom = mode === 'custom' || mode === 'partial-warning' || mode === 'partial-rejection'
    const cases: SelfTestCase[] = Array.from({ length: 9 }, (_, index) => ({ id: `TC-${index + 1}`, title: `Save ${index}`, source: 'PRD', steps: 'Save then query', expected: 'Stored data matches', status: 'pending', requirementIds: ['REQ-001'], scenario: 'normal', preconditions: 'Service ready', testData: 'Independent data', assertions: ['Stored data matches'], cleanup: 'Delete data' }))
    if (custom) {
      for (const item of cases) item.testFile = 'save.test.cjs'
      writeFileSync(join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
      writeFileSync(join(workspace, 'save.test.cjs'), 'module.exports = {}\n')
    }
    if (mode === 'evidence-change') cases[0] = { ...cases[0], status: 'passed', evidenceInputFingerprint: fingerprint({ version: 'old' }), output: 'Old proof' }
    store.create({ id: 'task', repository: 'repo', instruction: 'Save', prdName: 'prd.md', designNames: [], status: 'REVIEW', entries: [], createdAt: now, updatedAt: now, workspace, createdBranch: 'task', copilotSession: { id: 'original-coding', directory: join(root, 'sessions', 'task') }, acceptanceBaseline: [{ id: 'REQ-001', source: 'PRD', criterion: 'Stored data matches', required: true, scenarios: ['normal'] }], selfTests: cases, acceptanceAssessment: { status: 'rejected', issues: ['Incomplete review'], checkedAt: now, coveredIds: ['REQ-001'], missingIds: [] }, selfTestPlanningStatus: 'reviewing', ...(custom ? { acceptanceSelection: { mode: 'custom', caseIds: cases.map((item) => item.id), reason: 'Functional verification', confirmedAt: now } } : {}) })
    const sessions: { id: string; disconnected: boolean; sent: number }[] = []
    let calls = 0
    context.mock.method(CopilotClient.prototype, 'resumeSession', async () => { throw new Error('must never resume coding') })
    context.mock.method(CopilotClient.prototype, 'stop', async () => [])
    context.mock.method(CopilotClient.prototype, 'createSession', async (config: SessionConfig) => {
      const state = { id: `phase-${sessions.length}`, disconnected: false, sent: 0 }
      sessions.push(state)
      const handlers = new Set<(event: SessionEvent) => void>()
      assert.equal((await config.onPermissionRequest!({ kind: 'write', fileName: join(workspace, 'business.ts'), canOfferSessionApproval: false, diff: '', intention: 'change' }, { sessionId: state.id })).kind, 'reject')
      return {
        sessionId: state.id, setModel: async () => {}, abort: async () => {},
        disconnect: async () => { state.disconnected = true },
        on(typeOrHandler: unknown, callback?: (event: SessionEvent) => void) {
          const handler = typeof typeOrHandler === 'function' ? typeOrHandler as (event: SessionEvent) => void : (event: SessionEvent) => { if (event.type === typeOrHandler) callback!(event) }
          handlers.add(handler)
          return () => { handlers.delete(handler) }
        },
        send: async ({ prompt }: { prompt: string }) => {
          state.sent++
          calls++
          assert.match(prompt, /独立用例质量评审者/)
          assert.match(prompt, /原始需求/)
          assert.equal(store.get('task')!.selfTestPlanningStatus, 'reviewing')
          if (custom) {
            const assessment = store.get('task')!.executionAssessment!
            assert.equal(assessment.readiness, 'checking')
            assert.match(store.get('task')!.modelTurn!.label, /第 [12]\/2 批/)
            assert.ok(assessment.caseReviews?.some(review => review.status === 'reviewing'))
          }
          if (calls === 2) throw new Error('simulated second batch timeout')
          if (mode === 'mid-review-change' && calls === 1) writeFileSync(join(workspace, 'business.ts'), 'changed during review')
          const rejected = mode === 'partial-rejection' && calls === 1
          const content = JSON.stringify(custom ? { findings: rejected ? [{ code: 'requirement_conflict', category: 'conflict', message: 'Contradicts requirement', caseIds: ['TC-1'] }] : mode === 'partial-warning' && calls === 1 ? [{ code: 'weak_assertion', category: 'quality', message: 'Weak assertion warning', caseIds: ['TC-1'] }] : [] } : { qualified: !rejected, issues: rejected ? ['TC-1 weak assertion'] : [], caseIssues: rejected ? [{ caseId: 'TC-1', message: 'Weak assertion' }] : [] })
          for (const event of [{ type: 'assistant.message', data: { content } }, { type: 'session.idle', data: {} }]) for (const handler of handlers) handler(event as SessionEvent)
          return 'message'
        },
      }
    })
    const execute = () => new CodingWorker(store, root).execute(store.get('task')!, prd, [], 'test-token', undefined, true, false, [], custom ? 'execute' : 'repair')
    await execute()
    assert.equal(store.get('task')!.status, 'REVIEW')
    if (mode === 'mid-review-change') {
      assert.match(store.get('task')!.selfTestError!, /评审期间代码变化/)
      assert.equal(store.get('task')!.testExecutionPlan, undefined)
      assert.equal(calls, 1)
      return
    }
    if (mode === 'evidence-change') assert.equal(store.get('task')!.selfTests![0].status, 'pending', 'old version passed evidence cannot be reused')
    assert.equal(store.get('task')!.selfTestArtifacts!.filter((item) => item.phase === 'review' && item.status === 'complete').length, 1)
    assert.equal(store.get('task')!.selfTestArtifacts!.filter((item) => item.status === 'failed').length, 1)
    assert.match(store.get('task')!.selfTestError!, /second batch/)
    if (custom) {
      assert.equal(store.get('task')!.executionAssessment?.readiness, 'unknown')
      assert.equal(store.get('task')!.executionAssessment?.caseReviews?.find(review => review.caseId === 'TC-9')?.status, 'unknown')
      assert.equal(store.get('task')!.executionAssessment?.caseReviews?.find(review => review.caseId === 'TC-1')?.status, mode === 'partial-rejection' ? 'rejected' : 'warning')
      assert.equal(store.get('task')!.selfTestPlanningStatus, 'reviewing')
    } else {
      assert.equal(store.get('task')!.acceptanceAssessment?.caseReviews?.find(review => review.caseId === 'TC-1')?.status, 'qualified')
      assert.equal(store.get('task')!.acceptanceAssessment?.caseReviews?.find(review => review.caseId === 'TC-9')?.status, 'unknown')
    }
    store = new TaskStore(file)
    await execute()
    assert.equal(calls, 3, 'only unfinished second batch is sent after reload')
    assert.equal(store.get('task')!.copilotSession!.id, 'original-coding')
    if (mode === 'partial-rejection') {
      assert.equal(store.get('task')!.executionAssessment?.status, 'rejected')
      assert.equal(store.get('task')!.executionAssessment?.readiness, 'blocked')
      assert.ok(store.get('task')!.executionAssessment?.findings?.some((item) => item.caseIds.includes('TC-1') && item.category === 'conflict'))
      assert.equal(store.get('task')!.testExecutionPlan, undefined)
      return
    }
    assert.equal(store.get('task')!.testExecutionPlan?.artifactRefs?.length, 2)
    if (mode === 'partial-warning') {
      assert.equal(store.get('task')!.executionAssessment?.readiness, 'ready')
      assert.equal(store.get('task')!.executionAssessment?.status, 'rejected')
      assert.ok(store.get('task')!.executionAssessment?.findings?.some(finding => finding.code === 'weak_assertion'))
      assert.equal(store.get('task')!.selfTests![0].status, 'skipped', 'readiness alone cannot pass a file without test declarations or assertions')
      assert.equal(store.get('task')!.status, 'REVIEW')
    }
    assert.ok(store.get('task')!.entries.some((entry) => entry.text.includes('复用已完成评审批次')))
    assert.ok(sessions.every((item) => item.sent === 1 && item.disconnected))
    writeFileSync(join(workspace, 'business.ts'), 'changed code')
    await execute()
    assert.equal(calls, 5, 'changed workspace invalidates both completed batches')
    if (mode === 'custom') {
      store.update('task', { acceptanceSelection: { ...store.get('task')!.acceptanceSelection!, caseIds: ['TC-1'] } })
      await execute()
      assert.equal(calls, 6, 'changed selected scope requires a new review')
    }
    writeFileSync(prd, 'Changed acceptance requirements')
    await new CodingWorker(store, root).execute(store.get('task')!, prd, [], 'test-token', undefined, true, false, [], 'execute')
    assert.match(store.get('task')!.selfTestError!, /旧基线失效/)
    assert.equal(calls, mode === 'custom' ? 6 : 5, 'changed requirements block execution without silently regenerating')
  })
}