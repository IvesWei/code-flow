import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { CopilotClient, type SessionEvent } from '@github/copilot-sdk'
import { CodingWorker } from '../../execution/worker.js'
import { TaskStore } from '../../tasks/store.js'
import type { AcceptanceRequirement } from '../../../shared/task.js'

for (const outcome of ['qualified', 'late-rejected', 'interrupted', 'optional-performance'] as const) {
  test(`batched worker planning: ${outcome}`, async (context) => {
    const root = mkdtempSync(join(tmpdir(), 'batched-worker-'))
    context.after(() => rmSync(root, { recursive: true, force: true }))
    const workspace = join(root, 'workspaces', 'task')
    mkdirSync(workspace, { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: workspace })
    const store = new TaskStore(join(root, 'tasks.json'))
    const prd = join(root, 'prd.md')
    writeFileSync(prd, 'Save and verify stored data')
    const now = new Date().toISOString()
    const baseline: AcceptanceRequirement[] = Array.from({ length: 15 }, (_, index) => ({ id: `REQ-${String(index + 1).padStart(3, '0')}`, source: 'PRD', criterion: `保存 ${index}`, required: true, scenarios: ['normal'] }))
    const optional = outcome === 'optional-performance'
    if (optional) baseline.push({ id: 'REQ-016', source: '补充建议', criterion: '探索容量', required: false, scenarios: ['normal'] })
    store.create({ id: 'task', repository: 'repo', instruction: '保存数据', prdName: 'prd.md', designNames: [], status: 'SELF_TEST', workspace, createdBranch: 'task', createdAt: now, updatedAt: now, entries: [], acceptanceBaseline: baseline })
    if (optional) store.update('task', { selfTests: baseline.slice(0, 15).map((item, index) => ({ id: `TC-${String(index + 1).padStart(2, '0')}`, title: item.id, source: 'PRD', steps: '保存后查询', expected: '查询一致', requirementIds: [item.id], scenario: 'normal', preconditions: '服务已启动', testData: '独立数据', assertions: ['业务数据一致'], cleanup: '删除数据', status: 'passed', output: 'preserved proof' })) })
    const handlers = new Set<(event: SessionEvent) => void>()
    let generations = 0, reviews = 0, interrupted = false
    const session = {
      sessionId: 'batch-session',
      on(typeOrHandler: unknown, handler?: (event: SessionEvent) => void) {
        const callback = typeof typeOrHandler === 'function' ? typeOrHandler as (event: SessionEvent) => void : handler!
        const listener = (event: SessionEvent) => { if (typeof typeOrHandler === 'function' || event.type === typeOrHandler) callback(event) }
        handlers.add(listener)
        return () => { handlers.delete(listener) }
      },
      setModel: async () => {}, abort: async () => {}, disconnect: async () => {},
      send: async ({ prompt }: { prompt: string }) => {
        let content: string
        if (prompt.includes('当前批次必须覆盖的需求场景：')) {
          generations++
          if (outcome === 'interrupted' && generations === 2) { interrupted = true; throw new Error('simulated interruption') }
          const line = prompt.split('\n').find((line) => line.startsWith('当前批次必须覆盖的需求场景：'))!
          const targets = JSON.parse(line.split('：')[1].split('。只为本批')[0]) as { requirementId: string; scenario: string }[]
          assert.ok(targets.length <= 8)
          content = JSON.stringify(targets.map(({ requirementId, scenario }) => ({ title: requirementId, source: 'PRD', steps: '保存后查询', expected: '查询一致', requirementIds: [requirementId], scenario, preconditions: '需人工提供服务', testData: '独立数据', assertions: ['业务数据一致'], cleanup: '删除数据', ...(optional ? { classification: { testType: 'performance', tags: ['load'], priority: 'P2', riskReason: '补充容量探索', executionPolicy: 'on_demand' } } : {}) })))
        } else {
          reviews++
          assert.ok(store.get('task')!.selfTests!.length === (optional ? 16 : 15))
          const rejected = outcome === 'late-rejected' && reviews === 2
          content = JSON.stringify({ qualified: !rejected, issues: rejected ? ['后批断言不充分'] : [] })
        }
        for (const event of [{ type: 'assistant.message', data: { content } }, { type: 'session.idle', data: {} }]) {
          for (const handler of handlers) handler(event as SessionEvent)
        }
        return 'message'
      },
    }
    context.mock.method(CopilotClient.prototype, 'createSession', async () => session)
    context.mock.method(CopilotClient.prototype, 'resumeSession', async () => session)
    context.mock.method(CopilotClient.prototype, 'stop', async () => [])
    const worker = new CodingWorker(store, root)
    await worker.execute(store.get('task')!, prd, [], 'test-token', undefined, true, true)
    if (outcome === 'interrupted') {
      assert.equal(interrupted, true)
      assert.equal(store.get('task')!.selfTests!.length, 8)
      assert.equal(store.get('task')!.selfTestPlanningStatus, 'generating')
      const first = structuredClone(store.get('task')!.selfTests![0])
      await worker.execute(store.get('task')!, prd, [], 'test-token', undefined, true)
      assert.deepEqual(store.get('task')!.selfTests![0], first)
    }
    const task = store.get('task')!
    assert.equal(task.selfTests?.length, optional ? 16 : 15)
    assert.equal(new Set(task.selfTests!.map((item) => item.id)).size, optional ? 16 : 15)
    assert.equal(task.acceptanceAssessment?.status, outcome === 'late-rejected' ? 'rejected' : 'qualified')
    assert.equal(task.entries.some((entry) => entry.stage === 'TEST_EXECUTION'), outcome !== 'late-rejected')
    assert.equal(generations, outcome === 'interrupted' ? 3 : optional ? 1 : 2)
    assert.equal(reviews, 2)
    if (optional) {
      assert.equal(task.status, 'SUCCESS')
      assert.equal(task.testExecutionPlan?.cases[15].selected, false)
      assert.equal(task.testExecutionPlan?.cases[15].gatePolicy, 'advisory')
      assert.equal(task.selfTests![15].startedAt, undefined)
      assert.equal(task.selfTests![15].output, undefined)
      assert.equal(task.selfTests![0].output, 'preserved proof')
      await worker.execute(task, prd, [], 'test-token', undefined, true, false, ['TC-16'])
      const selected = store.get('task')!
      assert.equal(selected.testExecutionPlan?.cases[15].selected, true)
      assert.match(selected.testExecutionPlan!.cases[15].reason, /用户显式/)
      assert.equal(selected.selfTests![15].status, 'manual')
      assert.match(selected.selfTests![15].output!, /需人工验证/)
      assert.equal(selected.status, 'SUCCESS')
      assert.equal(generations, 1)
      assert.equal(reviews, 2)
    }
  })
}