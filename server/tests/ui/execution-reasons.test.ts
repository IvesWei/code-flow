import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AutomationRun, CodingTask } from '../../../shared/task.js'
import { TestExecutionResults } from '../../../src/features/testing/execution/TestExecutionResults.js'

function fixture(runs: AutomationRun[], unselected: string[] = []): CodingTask {
  const now = '2026-10-19T00:00:00.000Z'
  return {
    id: 'execution-reasons', repository: 'repo', instruction: 'Verify execution', prdName: 'prd.md', designNames: [],
    status: 'TEST_EXECUTION', createdAt: now, updatedAt: now, entries: [], automationRuns: runs,
    selfTests: runs.map(run => ({ id: run.caseId, title: `Case ${run.caseId}`, source: '', steps: '', expected: '', status: 'pending' })),
    testExecutionPlan: { version: 1, mode: 'default', createdAt: now, cases: runs.map(run => ({ caseId: run.caseId, selected: !unselected.includes(run.caseId), gatePolicy: 'blocking', reason: 'Submitted scope' })) },
  }
}

function render(task: CodingTask) {
  return renderToStaticMarkup(createElement(TestExecutionResults, { task, onLocate: () => {} }))
}

function row(html: string, caseId: string) {
  const result = html.split('<details class="execution-row">').find(part => part.startsWith(`<summary><strong>${caseId} ·`))
  assert.ok(result, `missing execution row ${caseId}`)
  return result
}

test('blocked reasons use structured codes while preserving status labels and selectors', () => {
  const reasons = [
    ['capability', '缺少执行能力'], ['environment', '执行环境未就绪'], ['authorization', '缺少安全授权'],
    ['manual', '需人工验证'], ['unknown', '执行受阻（原因待核对）'],
  ] as const
  const runs: AutomationRun[] = reasons.map(([reasonCode]) => ({ caseId: reasonCode, status: 'blocked', reasonCode }))
  runs.push({ caseId: 'legacy', status: 'blocked', output: 'missing browser capability authorization account manual assertion failed' })
  runs[0].requiredCapabilities = ['browser.<unsafe>', 'very-long-capability-'.repeat(30)]
  runs[0].protocolVersion = 'execution-v1'
  const html = render(fixture(runs))
  assert.match(html, /aria-label="已选中受阻原因统计"/)
  assert.match(html, /执行准备受阻 6/)
  assert.match(html, /执行受阻（原因待核对） 2/)
  assert.equal((html.match(/class="case-status case-preparation_blocked">执行准备受阻<\/span>/g) || []).length, 6)
  for (const [code, label] of reasons) {
    assert.ok(row(html, code).includes(`受阻原因：${label}`))
    if (code !== 'unknown') assert.ok(html.includes(`${label} 1`))
  }
  assert.ok(row(html, 'legacy').includes('受阻原因：执行受阻（原因待核对）'))
  for (const [, label] of reasons.slice(0, 4)) assert.ok(!row(html, 'legacy').includes(label))
  assert.match(row(html, 'capability'), /所需执行能力：browser\.&lt;unsafe&gt; \/ very-long-capability-/)
  assert.ok(row(html, 'capability').includes('very-long-capability-'.repeat(30)))
  assert.match(row(html, 'capability'), /执行协议版本：execution-v1/)
  assert.match(html, /aria-label="执行状态"/)
  assert.match(html, /class="execution-row-body"/)
})

test('reason counts and rows exclude unselected runs and nonblocked structured reasons', () => {
  const html = render(fixture([
    { caseId: 'selected', status: 'blocked', reasonCode: 'environment' },
    { caseId: 'excluded', status: 'blocked', reasonCode: 'authorization', requiredCapabilities: ['excluded-secret-marker'] },
    { caseId: 'passed', status: 'passed', reasonCode: 'capability' },
  ], ['excluded']))
  assert.match(html, /执行环境未就绪 1/)
  assert.match(html, /缺少安全授权 0/)
  assert.match(html, /缺少执行能力 0/)
  assert.match(html, /执行准备受阻 1/)
  assert.match(html, /本次未选中 1 条/)
  assert.doesNotMatch(html, /excluded-secret-marker|excluded · Case/)
  assert.doesNotMatch(row(html, 'passed'), /受阻原因：| · 缺少执行能力/)
  const noSelectedBlock = render(fixture([{ caseId: 'excluded', status: 'blocked', reasonCode: 'manual' }], ['excluded']))
  assert.doesNotMatch(noSelectedBlock, /已选中受阻原因|需人工验证/)
})

test('failure detail distinguishes explicit categories without guessing from legacy keywords or failureKind', () => {
  const categories = [
    ['action', '操作执行失败'], ['assertion', '断言失败'], ['navigation', '页面导航失败'],
    ['browser', '浏览器执行失败'], ['policy', '执行策略受限'],
  ] as const
  const runs: AutomationRun[] = categories.map(([failureCategory]) => ({ caseId: failureCategory, status: 'failed', failureCategory, output: 'assertion navigation browser policy authorization critical P0' }))
  runs.push({ caseId: 'legacy', status: 'failed', failureKind: 'navigation', output: 'assertion failed browser navigation policy critical P0' })
  const html = render(fixture(runs))
  for (const [code, label] of categories) assert.ok(row(html, code).includes(`失败分类：${label}`))
  assert.equal((html.match(/class="case-status case-failed">执行失败（断言原因待核对）<\/span>/g) || []).length, 6)
  assert.match(row(html, 'legacy'), /失败分类：未记录（原因待核对）/)
  for (const [, label] of categories) assert.ok(!row(html, 'legacy').includes(`失败分类：${label}`))
  assert.doesNotMatch(html, /受阻原因：|严重失败|高危|实际断言失败/)
})

test('legacy history without structured reason or failure category remains unknown', () => {
  const task = fixture([{ caseId: 'legacy-blocked', status: 'blocked', output: '缺少执行能力，执行环境未就绪，缺少安全授权，需人工验证' }])
  delete task.testExecutionPlan
  const html = render(task)
  assert.match(html, /历史执行记录/)
  assert.match(html, /受阻原因：执行受阻（原因待核对）/)
  assert.doesNotMatch(html, /已选中受阻原因统计|受阻原因：缺少执行能力|受阻原因：执行环境未就绪|受阻原因：缺少安全授权|受阻原因：需人工验证/)
})