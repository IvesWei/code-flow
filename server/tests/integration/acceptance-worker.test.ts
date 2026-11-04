import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { CopilotClient } from '@github/copilot-sdk'
import { CodingWorker } from '../../execution/worker.js'
import { TaskStore } from '../../tasks/store.js'

for (const outcome of ['coverage-rejected', 'quality-rejected', 'qualified'] as const) {
  test(`worker acceptance gate: ${outcome}`, async (context) => {
    const root = mkdtempSync(join(tmpdir(), 'acceptance-worker-'))
    try {
      const workspace = join(root, 'workspaces', 'task')
      mkdirSync(workspace, { recursive: true })
      execFileSync('git', ['init', '-q'], { cwd: workspace })
      writeFileSync(join(workspace, 'package.json'), '{"scripts":{"test":"node --test"}}')
      const store = new TaskStore(join(root, 'tasks.json'))
      const prd = join(root, 'prd.md')
      writeFileSync(prd, 'Save and verify stored data')
      const now = new Date().toISOString()
      store.create({ id: 'task', repository: 'https://github.com/example/repo', instruction: '保存数据', prdName: 'prd.md', designNames: [], status: 'SELF_TEST', workspace, createdBranch: 'task', createdAt: now, updatedAt: now, entries: [] })
      store.update('task', { publication: { files: ['published-code.ts'], snapshot: 'test', baseCommit: 'a'.repeat(40), commit: 'b'.repeat(40), pushedAt: now } })
      const requirement = { id: 'REQ-001', source: 'PRD 保存', criterion: '保存后查询一致', required: true, scenarios: ['normal'] }
      const testCase = { title: '保存', source: 'PRD 保存', steps: '写入后查询', expected: '查询一致', testFile: 'save.test.cjs', requirementIds: outcome === 'coverage-rejected' ? ['REQ-999'] : ['REQ-001'], scenario: 'normal', preconditions: '无外部依赖', testData: '独立数据', assertions: ['实际结果一致'], cleanup: '数据自动释放' }
      let calls = 0
      const handlers = new Set<(event: import('@github/copilot-sdk').SessionEvent) => void>()
      const session = {
        sessionId: 'test-session',
        on: (typeOrHandler: unknown, handler?: (event: import('@github/copilot-sdk').SessionEvent) => void) => {
          const callback = typeof typeOrHandler === 'function' ? typeOrHandler as (event: import('@github/copilot-sdk').SessionEvent) => void : handler!
          const listener = (event: import('@github/copilot-sdk').SessionEvent) => { if (typeof typeOrHandler === 'function' || event.type === typeOrHandler) callback(event) }
          handlers.add(listener)
          return () => { handlers.delete(listener) }
        }, setModel: async () => {}, abort: async () => {}, disconnect: async () => {},
        send: async () => {
          calls++
          let content: string
          if (calls === 1) content = JSON.stringify([requirement])
          else if (calls === 2 || outcome === 'coverage-rejected') {
            writeFileSync(join(workspace, 'save.test.cjs'), "const {test}=require('node:test'); test('result',()=>require('node:assert/strict').equal(2,2))")
            content = JSON.stringify([testCase])
          }
          else content = JSON.stringify({ qualified: outcome === 'qualified', issues: outcome === 'qualified' ? [] : ['恒真断言没有验证业务行为'] })
          for (const event of [{ type: 'assistant.message', data: { content } }, { type: 'session.idle', data: {} }]) {
            for (const handler of handlers) handler(event as import('@github/copilot-sdk').SessionEvent)
          }
          return 'message'
        },
      }
      context.mock.method(CopilotClient.prototype, 'createSession', async () => session)
      context.mock.method(CopilotClient.prototype, 'stop', async () => [])
      await new CodingWorker(store, root).execute(store.get('task')!, prd, [], 'test-token', undefined, true, true)
      const task = store.get('task')!
      assert.ok(task.changes?.includes('published-code.ts'), 'self-test success and failure must retain committed coding files')
      assert.equal(task.acceptanceAssessment?.status, outcome === 'qualified' ? 'qualified' : 'rejected')
      assert.equal(task.status, outcome === 'qualified' ? 'SUCCESS' : 'REVIEW')
      assert.equal(task.entries.some((entry) => entry.stage === 'TEST_EXECUTION'), outcome === 'qualified')
      if (outcome === 'coverage-rejected') {
        assert.equal(task.selfTests?.length, 0)
        assert.ok(task.selfTestDraft)
        assert.match(task.selfTestError || '', /批次 1生成失败/)
      } else assert.equal(task.selfTests?.[0].status, outcome === 'qualified' ? 'passed' : 'pending')
      assert.equal(calls, outcome === 'coverage-rejected' ? 4 : 3)
      assert.equal(task.copilotSession, undefined, 'self-test must not replace the coding session')
      assert.ok(task.selfTestArtifacts?.some((item) => item.phase === 'baseline' && item.status === 'complete' && item.output?.baseline))
      if (outcome !== 'coverage-rejected') {
        assert.ok(task.selfTestArtifacts?.some((item) => item.phase === 'generation' && item.status === 'complete' && item.output?.cases))
        assert.ok(task.selfTestArtifacts?.some((item) => item.phase === 'review' && item.status === 'complete' && item.output?.assessment))
      }
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
}