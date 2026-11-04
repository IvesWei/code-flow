import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AutomationRun, CodingTask, SelfTestCase } from '../../../shared/task.js'
import type { TestExecutionResult } from '../../../shared/test-execution.js'
import { createExecutionPlan } from '../../../shared/test-policy.js'
import { TestExecutionResults } from '../../../src/features/testing/execution/TestExecutionResults.js'
import { AutomationDashboard } from '../../../src/features/automation/AutomationDashboard.js'
import { AutomationExecutionRecord, AutomationTaskDetail } from '../../../src/features/automation/AutomationTaskDetail.js'
import type { TaskSummary } from '../../../shared/task-summary.js'

const now = '2026-10-20T10:00:00.000Z'

function result(status: TestExecutionResult['status'] = 'passed'): TestExecutionResult {
  return { version: 1, runner: 'playwright-test', caseId: 'TC-1', caseFingerprint: 'fingerprint', status, reason: status === 'passed' ? 'All checks executed' : 'Required check missing', startedAt: now, finishedAt: now, assertions: [{ id: 'TC-1:A001', status: 'passed', expectCount: 2 }, { id: 'TC-1:A002', status: status === 'passed' ? 'passed' : 'missing', expectCount: status === 'passed' ? 1 : 0 }] }
}

function fixture(executionResult?: TestExecutionResult): CodingTask {
  const item: SelfTestCase & { executionResult?: TestExecutionResult } = { id: 'TC-1', title: 'Save', source: 'PRD', steps: 'Save', expected: 'Saved', status: 'passed', requirementIds: ['REQ-1'], executionResult }
  const task = { id: 'task', repository: 'repo', status: 'SUCCESS', createdAt: now, updatedAt: now, instruction: 'Verify', prdName: 'prd.md', designNames: [], entries: [], selfTests: [item], acceptanceBaseline: [{ id: 'REQ-1', source: 'PRD', criterion: 'Saved', required: true, scenarios: ['normal'] }] } as CodingTask
  task.testExecutionPlan = createExecutionPlan(task.acceptanceBaseline!, task.selfTests!)
  return task
}

function render(task: CodingTask) {
  return renderToStaticMarkup(createElement(TestExecutionResults, { task, onLocate: () => {} }))
}

test('structured all-check results show Playwright engine and count assertion IDs, not expect calls', () => {
  const html = render(fixture(result()))
  assert.match(html, /执行引擎：Playwright Test/)
  assert.match(html, /必验断言 2\/2/)
  assert.match(html, /TC-1:A001 · 通过 · expect 2/)
  assert.match(html, /All checks executed/)
  assert.match(html, /必验通过 1\/1/)
  assert.match(html, /class="case-status case-passed"/)
  assert.match(html, /aria-label="执行状态"/)
  assert.match(html, /定位设计用例 TC-1/)
  assert.doesNotMatch(html, /<summary>执行脚本<\/summary>|执行截图/)
})

test('incomplete structured evidence overrides old passed case and browser run without claiming success', () => {
  const task = fixture(result('incomplete'))
  task.automationRuns = [{ caseId: 'TC-1', status: 'passed', script: 'stale script', screenshot: 'stale.png' }]
  const html = render(task)
  assert.match(html, /class="case-status case-incomplete">验证未完成/)
  assert.match(html, /必验断言 1\/2/)
  assert.match(html, /TC-1:A002 · 未执行 · expect 0/)
  assert.match(html, /Required check missing/)
  assert.match(html, /必验通过 0\/1/)
  assert.doesNotMatch(html, /class="case-status case-passed"|stale script|执行截图/)
})

test('legacy browser record retains status, script, screenshot and navigation', () => {
  const task = fixture()
  task.automationRuns = [{ caseId: 'TC-1', status: 'passed', script: 'legacy script', screenshot: 'legacy.png' }]
  const html = render(task)
  assert.match(html, /执行引擎：legacy/)
  assert.match(html, /class="case-status case-passed"/)
  assert.match(html, /legacy script/)
  assert.match(html, /执行截图 TC-1/)
  assert.match(html, /查看自动化任务 TC-1/)
  assert.doesNotMatch(html, /必验断言/)
})

test('structured run evidence is used when no case result exists', () => {
  const task = fixture()
  const run: AutomationRun & { executionResult: TestExecutionResult } = { caseId: 'TC-1', status: 'passed', executionResult: result('blocked') }
  task.automationRuns = [run]
  const html = render(task)
  assert.match(html, /class="case-status case-preparation_blocked"/)
  assert.match(html, /Required check missing/)
  assert.match(html, /必验通过 0\/1/)
})

test('detail consumes case evidence before synthetic run status and does not invent browser artifacts', () => {
  const task = fixture(result('incomplete'))
  const html = renderToStaticMarkup(createElement(AutomationExecutionRecord, { taskId: task.id, caseId: 'TC-1', testCase: task.selfTests![0], run: { caseId: 'TC-1', status: 'passed', script: 'stale script', screenshot: 'stale.png' } }))
  assert.match(html, /验证未完成/)
  assert.match(html, /执行引擎：Playwright Test/)
  assert.match(html, /必验断言 1\/2/)
  assert.match(html, /Required check missing/)
  assert.match(html, /TC-1:A002 · 未执行 · expect 0/)
  assert.doesNotMatch(html, /Copilot 自动化脚本|页面截图|stale script|<img/)
})

test('detail preserves DSL and unknown browser scripts and screenshot links', () => {
  for (const runner of [undefined, 'browser-dsl'] as const) {
    const task = fixture()
    const html = renderToStaticMarkup(createElement(AutomationExecutionRecord, { taskId: task.id, caseId: 'TC-1', testCase: task.selfTests![0], run: { caseId: 'TC-1', status: 'passed', script: 'browser script', screenshot: 'browser.png', runner } }))
    assert.match(html, runner ? /执行引擎：DSL/ : /执行引擎：legacy/)
    assert.match(html, /Copilot 自动化脚本/)
    assert.match(html, /browser script/)
    assert.match(html, /\/api\/tasks\/task\/automation\/TC-1\/screenshot/)
    assert.match(html, /页面截图/)
    assert.doesNotMatch(html, /必验断言/)
  }
})

test('dashboard reads optional summary evidence while preserving legacy row status and navigation controls', () => {
  const structuredRun = { caseId: 'TC-1', title: 'Save', status: 'passed' as const, executionResult: result('incomplete') }
  const task: TaskSummary = { id: 'task', repository: 'repo', status: 'SUCCESS', createdAt: now, updatedAt: now, hasWorkspace: true, caseCount: 2, automationCount: 2, runnable: false, runs: [structuredRun, { caseId: 'TC-2', title: 'Old browser', status: 'passed' }] }
  const html = renderToStaticMarkup(createElement(AutomationDashboard, { tasks: [task], onStart: () => {}, onOpenRun: () => {}, startingId: null, busy: false, authenticated: true }))
  assert.equal((html.match(/class="automation-run-row"/g) || []).length, 2)
  assert.match(html, /执行引擎：Playwright Test/)
  assert.match(html, /必验断言 1\/2/)
  assert.match(html, /Required check missing/)
  assert.match(html, /<strong>验证未完成<\/strong>/)
  assert.match(html, /执行引擎：legacy/)
  assert.match(html, /<strong>passed<\/strong>/)
})

test('detail navigation uses optional run result and retains the existing URLs and selected class', () => {
  const run: AutomationRun & { executionResult: TestExecutionResult } = { caseId: 'TC-1', status: 'passed', executionResult: result('incomplete') }
  const html = renderToStaticMarkup(createElement(AutomationTaskDetail, { taskId: 'task', caseId: 'TC-1', runs: [run], onBack: () => {} }))
  assert.match(html, /aria-label="自动化执行用例"/)
  assert.match(html, /class="selected"[^>]*href="\/\?task=task&amp;automation=TC-1"/)
  assert.match(html, /<strong>验证未完成<\/strong>/)
  assert.match(html, /返回任务详情/)
})

test('structured evidence remains visible without a plan even if the old case status is pending', () => {
  const task = fixture(result('failed'))
  task.testExecutionPlan = undefined
  task.selfTests![0].status = 'pending'
  const html = render(task)
  assert.match(html, /历史执行记录（非完整已提交范围）/)
  assert.match(html, /class="case-status case-failed"/)
  assert.match(html, /执行失败（断言原因待核对）/)
  assert.match(html, /查看自动化任务 TC-1/)
  assert.match(html, /Required check missing/)
})

test('explicit Playwright runner without results never renders stale browser scripts or screenshots', () => {
  const task = fixture()
  const run: AutomationRun & { runner: 'playwright-test' } = { caseId: 'TC-1', status: 'running', runner: 'playwright-test', script: 'stale script', screenshot: 'stale.png' }
  task.automationRuns = [run]
  const html = renderToStaticMarkup(createElement(AutomationExecutionRecord, { taskId: task.id, caseId: run.caseId, testCase: task.selfTests![0], run }))
  assert.match(html, /执行引擎：Playwright Test/)
  assert.doesNotMatch(html, /Copilot 自动化脚本|页面截图|stale script|必验断言/)
  const execution = render(task)
  assert.match(execution, /执行引擎：Playwright Test/)
  assert.doesNotMatch(execution, /<summary>执行脚本<\/summary>|执行截图|stale script|必验断言/)
})