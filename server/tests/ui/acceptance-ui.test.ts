import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CodingTask } from '../../../shared/task.js'
import { SelfTestResults } from '../../../src/features/testing/execution/SelfTestResults.js'

test('generation stage shows acceptance information without view navigation', () => {
  const task: CodingTask = { id: 'task', repository: 'repo', instruction: '保存', prdName: 'prd.md', designNames: [], status: 'REVIEW', createdAt: '', updatedAt: '', entries: [], acceptanceBaseline: [{ id: 'REQ-001', source: 'PRD 保存', criterion: '查询一致', required: true, scenarios: ['normal'] }], acceptanceAssessment: { status: 'rejected', checkedAt: '', issues: ['REQ-001 必验场景未覆盖'], coveredIds: [], missingIds: ['REQ-001'] } }
  const html = renderToStaticMarkup(createElement(SelfTestResults, { task, onAccept: () => {}, accepting: false, onStart: () => {}, starting: false, previewUrl: '', onPreviewUrlChange: () => {} }))
  assert.match(html, /aria-label="生成用例"/)
  assert.doesNotMatch(html, /role="tab|role="tabpanel/)
  assert.match(html, /未通过，拒绝默认执行/)
  assert.match(html, /REQ-001 必验场景未覆盖/)
  assert.match(html, /需求验收基线/)
  assert.match(html, /aria-label="用例执行"/)
  assert.ok(html.indexOf('aria-label="生成用例"') < html.indexOf('aria-label="用例执行"'))
})

test('qualified design without a test file or URL does not claim runtime readiness', () => {
  const task: CodingTask = { id: 'design-only', repository: 'repo', instruction: '保存', prdName: 'prd.md', designNames: [], status: 'SELF_TEST', createdAt: '', updatedAt: '', entries: [], acceptanceBaseline: [], acceptanceAssessment: { status: 'qualified', checkedAt: '', issues: [], coveredIds: [], missingIds: [], caseReviews: [{ caseId: 'TC-01', status: 'qualified' }] }, selfTests: [{ id: 'TC-01', title: '保存后查询', source: 'PRD', steps: '保存后查询', expected: '查询一致', status: 'manual' }] }
  const render = () => renderToStaticMarkup(createElement(SelfTestResults, { task, onAccept: () => {}, accepting: false, onStart: () => {}, starting: false, previewUrl: '', onPreviewUrlChange: () => {} }))
  for (const status of ['manual', 'skipped'] as const) {
    task.selfTests![0].status = status
    const html = render()
    const boundary = html.indexOf('<section class="self-test-section test-execution-section"')
    assert.ok(boundary > 0)
    assert.ok(html.slice(0, boundary).endsWith('</section>'))
    const planning = html.slice(0, boundary)
    assert.match(planning, /默认质量门禁 · 设计审查完成/)
    assert.match(planning, /case-status case-review-qualified/)
    assert.doesNotMatch(planning, /可进入自动执行|role="tab|role="tabpanel|case-status case-manual|case-status case-skipped/)
    task.status = 'TEST_EXECUTION'
    const executing = render()
    const executionBoundary = executing.indexOf('<section class="self-test-section test-execution-section"')
    const generation = executing.slice(0, executionBoundary)
    const execution = executing.slice(executionBoundary)
    assert.match(generation, /默认质量门禁 · 设计审查完成/)
    assert.match(generation, /case-status case-review-qualified/)
    assert.doesNotMatch(generation, /case-status case-manual|case-status case-skipped/)
    assert.match(execution, /aria-label="用例执行"/)
    assert.match(execution, /历史执行记录（非完整已提交范围）/)
    assert.match(execution, new RegExp(`case-status case-${status}`))
    assert.doesNotMatch(execution, /case-status case-review-/)
    task.status = 'SELF_TEST'
  }
})