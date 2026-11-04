import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CodingTask, SelfTestCase } from '../../../shared/task.js'
import { createExecutionPlan } from '../../../shared/test-policy.js'
import { SelfTestResults, selfTestStageLabel } from '../../../src/features/testing/execution/SelfTestResults.js'
import { TestExecutionResults } from '../../../src/features/testing/execution/TestExecutionResults.js'
import { ActivitySection } from '../../../src/features/coding/ActivitySection.js'
import { currentScopeAssessment, defaultReviewProgress, designReviewState, executionBlocks, reviewProblems, executionCaseState } from '../../../src/features/testing/review/self-test-review.js'

test('review helpers bind submitted scope and conservatively merge legacy problems', () => {
  const task = fixture()
  task.acceptanceSelection = { mode: 'custom', caseIds: ['TC-1'], reason: 'Smoke', confirmedAt: task.createdAt }
  task.executionAssessment = { ...task.acceptanceAssessment!, readiness: 'ready', caseIds: ['TC-1'], issues: ['Note', 'Unclassified old issue'], findings: [{ category: 'quality', code: 'note', message: 'Note', caseIds: ['TC-1'] }] }
  assert.equal(currentScopeAssessment(task, ['TC-2'], 'Smoke'), undefined)
  assert.equal(currentScopeAssessment(task, ['TC-1'], 'Changed'), undefined)
  assert.equal(currentScopeAssessment(task, ['TC-1'], 'Smoke'), task.executionAssessment)
  task.acceptanceSelection.confirmedAt = new Date(Date.parse(task.createdAt) + 1000).toISOString()
  assert.equal(currentScopeAssessment(task, ['TC-1'], 'Smoke'), undefined)
  task.acceptanceSelection.confirmedAt = task.createdAt
  assert.equal(designReviewState(task.executionAssessment, true), 'ready')
  assert.equal(designReviewState(task.executionAssessment, false), 'blocked')
  const problems = reviewProblems(task.executionAssessment, true)
  assert.equal(problems.length, 2)
  assert.equal(problems[0].blocking, false)
  assert.equal(problems[0].sources.length, 2)
  assert.equal(problems[1].blocking, true)
  task.executionAssessment.issues = ['TC-1：Note']
  task.executionAssessment.caseIssues = [{ caseId: 'TC-1', message: 'Note' }]
  assert.equal(reviewProblems(task.executionAssessment, true).length, 1)
  assert.ok(reviewProblems(task.executionAssessment, true)[0].sources.includes('issues 原文：TC-1：Note'))
  const legacy = reviewProblems({ ...task.executionAssessment, issues: ['TC-10 与 TC-11 缺少前置条件'], findings: [], caseIssues: [] }, true)
  assert.deepEqual(legacy[0].caseIds, ['TC-10', 'TC-11'])
  assert.equal(legacy[0].blocking, true)
  const item = { ...task.selfTests![0], status: 'skipped' as const, output: 'browser account missing' }
  assert.equal(executionCaseState(item, true).state, 'skipped')
  assert.equal(executionCaseState({ ...item, output: '执行准备受阻：No runner' }, true).state, 'preparation_blocked')
})

test('results distinguish blocking progress, advisory failures and unselected performance cases', () => {
  const item: SelfTestCase = { id: 'TC-01', title: 'Save', source: 'PRD', steps: 'Save', expected: 'Saved', status: 'passed', requirementIds: ['REQ-001'] }
  const classification: NonNullable<SelfTestCase['classification']> = { testType: 'performance', tags: ['load'], priority: 'P2', riskReason: 'Capacity', executionPolicy: 'on_demand' }
  const task = { id: 'task', status: 'SUCCESS', selfTests: [item, { ...item, id: 'TC-02', status: 'pending', requirementIds: ['REQ-002'], classification }, { ...item, id: 'TC-03', status: 'failed', requirementIds: ['REQ-002'], classification: { ...classification, executionPolicy: 'always' } }], acceptanceBaseline: [{ id: 'REQ-001', source: 'PRD', criterion: 'Saved', required: true, scenarios: ['normal'] }, { id: 'REQ-002', source: 'Recommendation', criterion: 'Capacity', required: false, scenarios: ['normal'] }], acceptanceAssessment: { status: 'qualified', issues: [], coveredIds: ['REQ-001'], missingIds: [], checkedAt: '' } } as CodingTask
  task.testExecutionPlan = createExecutionPlan(task.acceptanceBaseline!, task.selfTests!)
  const html = render(task)
  const execution = renderExecution(task)
  assert.match(execution, /必验通过 1\/1/)
  assert.match(execution, /补充 1 条 · 失败 1 · 未验证 0/)
  assert.match(execution, /本次未选中 1 条/)
  assert.match(html, /性能效率 · P2 · load/)
  assert.match(html, /按需执行 · 非阻断/)
  assert.doesNotMatch(html, /3\/3 通过/)
  const now = new Date().toISOString()
  Object.assign(task, { createdAt: now, updatedAt: now, instruction: 'Verify policy', prdName: 'prd.md', designNames: [] })
  task.entries = [{ at: now, kind: 'info', stage: 'TEST_EXECUTION', text: '执行完成' }, { at: now, kind: 'info', stage: 'SUCCESS', text: '验收完成' }]
  const activity = renderToStaticMarkup(createElement(ActivitySection, { task }))
  assert.match(activity, /必验 1\/1 条通过 · 补充失败 1 条 · 未选中 1 条/)
  assert.match(activity, /必验及工程检查通过/)
  assert.doesNotMatch(activity, /全部通过/)
})

function fixture(): CodingTask {
  const now = new Date().toISOString()
  return { id: 'large-ui', repository: 'repo', instruction: 'Verify scope', prdName: 'prd.md', designNames: [], status: 'SUCCESS', createdAt: now, updatedAt: now, entries: [{ at: now, kind: 'info', stage: 'TEST_EXECUTION', text: 'Run' }, { at: now, kind: 'info', stage: 'SUCCESS', text: 'Done' }], acceptanceBaseline: [{ id: 'REQ-1', feature: 'Orders', source: 'PRD', criterion: 'Save order', required: true, scenarios: ['normal'] }, { id: 'REQ-2', feature: 'Payments', source: 'PRD', criterion: 'Pay order', required: true, scenarios: ['normal'] }, { id: 'REQ-3', source: '', criterion: 'Legacy criterion', required: false, scenarios: ['normal'] }], acceptanceAssessment: { status: 'rejected', checkedAt: now, coveredIds: ['REQ-1'], missingIds: ['REQ-2'], issues: ['Payment coverage missing'] }, selfTests: Array.from({ length: 125 }, (_, index) => ({ id: `TC-${index + 1}`, title: `Case ${index + 1}`, source: 'PRD', steps: 'Save', expected: 'Saved', status: index === 0 ? 'passed' : 'pending', requirementIds: index === 0 ? ['REQ-1', 'REQ-2', 'REQ-unknown'] : ['REQ-1'], classification: index === 0 ? undefined : { testType: index % 2 ? 'functional' : 'performance', priority: 'P1', executionPolicy: 'always', tags: [], riskReason: 'Coverage' } })) }
}

function render(task: CodingTask) {
  return renderSections(task).generation
}

function renderSections(task: CodingTask) {
  const html = renderToStaticMarkup(createElement(SelfTestResults, { task, onAccept: () => {}, accepting: false, onStart: () => {}, starting: false, previewUrl: '', onPreviewUrlChange: () => {} }))
  const boundary = html.indexOf('<section class="self-test-section test-execution-section"')
  assert.ok(boundary > 0, 'execution must follow the generation section as a sibling')
  assert.ok(html.slice(0, boundary).endsWith('</section>'))
  return { generation: html.slice(0, boundary), execution: html.slice(boundary) }
}

function renderExecution(task: CodingTask) {
  return renderToStaticMarkup(createElement(TestExecutionResults, { task, onLocate: () => {} }))
}

test('125 cases render once in a ten-row feature page with complete cross-requirement mappings', () => {
  const task = fixture()
  const html = render(task)
  assert.equal((html.match(/class="test-case-row"/g) || []).length, 10)
  assert.equal((html.match(/<strong>TC-1 · Case 1<\/strong>/g) || []).length, 1)
  assert.doesNotMatch(html, /TC-11 · Case 11/)
  assert.match(html, /第 1 \/ 13 页/)
  assert.match(html, /Orders/)
  assert.match(html, /REQ-2 · Payments · Pay order/)
  assert.match(html, /REQ-unknown · 未找到需求基线/)
  assert.match(html, /未分类 · 优先级未记录/)
  assert.match(html, /未通过，拒绝默认执行/)
  assert.match(renderSections(task).execution, /disabled=""[^>]*>[^<]*<svg[^]*?审查并执行所选用例/)
  assert.doesNotMatch(html, /automation-summary/)
  task.selfTests![0].requirementIds = ['REQ-3']
  assert.match(render(task), /<strong>REQ-3 · Legacy criterion · 非必验 · normal<\/strong>/)
})

test('custom success remains scoped while default rejection and accepted risks remain visible', () => {
  const task = fixture()
  task.acceptanceSelection = { mode: 'custom', caseIds: ['TC-1'], reason: 'Only order smoke coverage', confirmedAt: task.createdAt }
  task.executionAssessment = { status: 'qualified', readiness: 'ready', checkedAt: task.createdAt, coveredIds: ['REQ-1'], missingIds: [], issues: [], caseIds: ['TC-1'] }
  task.testExecutionPlan = createExecutionPlan(task.acceptanceBaseline!, task.selfTests!, [], task.acceptanceSelection)
  const html = render(task)
  assert.match(renderExecution(task), /必验通过 1\/1/)
  assert.match(renderExecution(task), /已提交范围（只读） · 1 条/)
  assert.doesNotMatch(html, /必验通过|case-status case-passed/)
  assert.match(html, /本次范围 · 设计审查完成/)
  assert.match(html, /未通过，拒绝默认执行/)
  assert.match(html, /Only order smoke coverage/)
  const activity = renderToStaticMarkup(createElement(ActivitySection, { task }))
  assert.match(activity, /本次必验 1\/1 条通过/)
  assert.match(activity, /自定义范围及工程检查通过，不代表全部需求通过/)
  task.status = 'ACCEPTED'
  assert.match(render(task), /已接受当前风险/)
  assert.match(renderToStaticMarkup(createElement(ActivitySection, { task })), /已接受风险/)
})

test('planning defaults to unknown for legacy and missing individual reviews, never aggregate qualification or runtime state', () => {
  const task = fixture()
  task.status = 'SELF_TEST'
  task.acceptanceAssessment!.status = 'qualified'
  task.selfTests![0].output = 'Runtime-only evidence'
  let html = render(task)
  assert.match(html, /aria-label="生成用例"/)
  assert.doesNotMatch(html, /role="tab|role="tabpanel/)
  assert.equal((html.match(/class="case-status case-review-unknown"/g) || []).length, 10)
  assert.doesNotMatch(html, /case-status case-passed|Runtime-only evidence|补充失败|必验 1\/|>待运行</)
  task.acceptanceAssessment!.caseReviews = [{ caseId: 'TC-1', status: 'qualified' }, { caseId: 'TC-3', status: 'reviewing' }, { caseId: 'TC-4', status: 'unreviewed' }, { caseId: 'TC-5', status: 'warning' }, { caseId: 'TC-6', status: 'rejected' }]
  html = render(task)
  assert.equal((html.match(/class="case-status case-review-qualified"/g) || []).length, 1)
  assert.equal((html.match(/class="case-status case-review-unknown"/g) || []).length, 5)
  for (const label of ['待审查', '审查中', '审查通过', '存在质量提示', '审查不通过', '审查未完成']) assert.ok(html.includes(label))
  task.status = 'TEST_EXECUTION'
  const generation = render(task)
  assert.match(generation, /case-status case-review-qualified/)
  assert.doesNotMatch(generation, /case-status case-passed|Runtime-only evidence/)
  const execution = renderExecution(task)
  assert.match(execution, /case-status case-passed/)
  assert.match(execution, /Runtime-only evidence/)
  assert.doesNotMatch(execution, /case-status case-review-/)
})

test('interrupted regeneration without loaded events does not reuse an old execution view', () => {
  const task = fixture()
  task.status = 'REVIEW'
  task.entries = []
  task.testExecutionPlan = createExecutionPlan(task.acceptanceBaseline!, task.selfTests!)
  task.selfTestPlanningStatus = 'reviewing'
  task.selfTestError = 'Review interrupted'
  assert.match(render(task), /aria-label="生成用例"/)
  assert.doesNotMatch(render(task), /case-status case-passed/)
  task.entries = [{ at: task.createdAt, kind: 'info', stage: 'TEST_EXECUTION', text: 'Execution failed' }]
  assert.match(render(task), /aria-label="生成用例"/)
  assert.doesNotMatch(render(task), /case-status case-passed/)
  assert.match(renderSections(task).execution, /aria-label="用例执行"/)
  assert.match(renderSections(task).execution, /case-status case-passed/)
  task.status = 'SELF_TEST'
  assert.match(render(task), /aria-label="生成用例"/)
})

test('custom scope design readiness is independent from quality rejection and runtime preparation', () => {
  const task = fixture()
  task.acceptanceSelection = { mode: 'custom', caseIds: ['TC-1'], reason: 'Scoped risk', confirmedAt: task.createdAt }
  task.executionAssessment = { status: 'rejected', readiness: 'ready', checkedAt: task.createdAt, coveredIds: [], missingIds: ['REQ-2'], issues: ['Legacy quality note'], caseIds: ['TC-1'], inputFingerprint: 'review-input', findings: [{ category: 'quality', code: 'quality-note', caseIds: ['TC-1'], message: 'Assertion needs detail' }, { category: 'coverage', code: 'gap', caseIds: [], message: 'Global coverage gap' }, { category: 'executability', code: 'design-note', caseIds: ['TC-1'], message: 'Observable result reviewed' }] }
  const html = render(task)
  assert.match(html, /本次范围 · 设计审查完成/)
  assert.match(html, /阻断 2 项 · 受影响 case 1 条 · 非阻断提示 2 项/)
  assert.match(html, /findings · executability · design-note/)
  assert.doesNotMatch(html, /已提交范围核对：可执行|执行就绪状态单独核对|<strong>可执行性<\/strong>/)
  assert.match(html, /确认本次范围并承担未选需求风险/)
  assert.match(html, /aria-label="定位用例 TC-1"/)
  assert.match(html, /Global coverage gap/)
  assert.match(html, /class="design-review-blocking" open=""/)
  assert.match(html, /class="design-review-advisory"><summary>/)
  assert.match(html, /findings · coverage · gap/)
  assert.doesNotMatch(html, /拒绝执行/)
  for (const runtimeStatus of ['manual', 'skipped'] as const) {
    task.selfTests![0].status = runtimeStatus
    assert.match(render(task), /本次范围 · 设计审查完成/)
    const execution = renderExecution(task)
    assert.match(execution, new RegExp(`case-status case-${runtimeStatus}`))
    assert.match(render(task), /未通过，拒绝默认执行/)
  }
  for (const [readiness, label] of [['checking', '设计审查未完成（核对中）'], ['blocked', '设计审查受阻'], ['unknown', '设计审查未完成']] as const) {
    task.executionAssessment.readiness = readiness
    assert.ok(render(task).includes(`本次范围 · ${label}`))
  }
  delete task.executionAssessment.readiness
  assert.match(render(task), /本次范围 · 设计审查未完成/)
})

test('planning stage labels distinguish generation, review, custom checks and unknown activity', () => {
  const task = fixture()
  task.status = 'SELF_TEST'
  task.selfTestPlanningStatus = 'generating'
  assert.equal(selfTestStageLabel(task), '正在生成用例')
  assert.match(render(task), /正在生成用例…/)
  task.selfTestPlanningStatus = 'reviewing'
  assert.equal(selfTestStageLabel(task), '正在审查用例')
  assert.match(render(task), /正在审查用例…/)
  task.acceptanceSelection = { mode: 'custom', caseIds: ['TC-1'], reason: 'Smoke', confirmedAt: task.createdAt }
  assert.match(render(task), /正在核对自定义范围…/)
  delete task.selfTestPlanningStatus
  delete task.acceptanceSelection
  assert.equal(selfTestStageLabel(task), '正在规划用例')
  task.modelTurn = { id: 'turn', label: '只读用例审查', startedAt: task.createdAt, lastActivityAt: task.createdAt, summary: '', inactivityTimeoutMs: 300000, status: 'running' }
  assert.equal(selfTestStageLabel(task), '正在审查用例')
  task.acceptanceSelection = { mode: 'custom', caseIds: ['TC-1'], reason: 'Smoke', confirmedAt: task.createdAt }
  task.modelTurn.label = '自定义必验集合核对'
  assert.equal(selfTestStageLabel(task), '正在核对自定义范围')
  task.entries = [{ at: task.createdAt, kind: 'info', stage: 'SELF_TEST', text: 'Review started' }]
  assert.match(renderToStaticMarkup(createElement(ActivitySection, { task })), /正在核对自定义范围 · 125 条用例/)
})

test('execution shows every runtime status while planning never substitutes runtime badges or progress', () => {
  const task = fixture()
  task.status = 'SELF_TEST'
  const statuses = ['pending', 'running', 'passed', 'failed', 'manual', 'skipped', 'invalid'] as const
  task.selfTests = statuses.map((status, index) => ({ ...task.selfTests![0], id: `runtime-${index}`, status }))
  const planning = render(task)
  for (const status of statuses) assert.ok(!planning.includes(`class="case-status case-${status}"`))
  assert.doesNotMatch(planning, />待运行<|>运行中<|>通过<|>失败<|>需人工确认<|>未执行<|>待修正<|补充未验证/)
  task.status = 'TEST_EXECUTION'
  task.testExecutionPlan = createExecutionPlan(task.acceptanceBaseline!, task.selfTests)
  assert.match(render(task), /case-status case-review-unknown/)
  assert.doesNotMatch(render(task), /case-status case-passed|case-status case-failed/)
  const execution = renderExecution(task)
  for (const label of ['待运行', '运行中', '通过', '执行失败（断言原因待核对）', '需人工确认', '未执行', '待修正']) assert.ok(execution.includes(`>${label}</span>`))
})

test('custom planning uses only matching execution reviews and leaves unselected cases out of scope', () => {
  const task = fixture()
  task.status = 'SELF_TEST'
  task.acceptanceAssessment!.caseReviews = [{ caseId: 'TC-1', status: 'rejected' }, { caseId: 'TC-2', status: 'qualified' }]
  task.acceptanceSelection = { mode: 'custom', caseIds: ['TC-1'], reason: 'Smoke', confirmedAt: task.createdAt }
  task.executionAssessment = { status: 'rejected', readiness: 'ready', checkedAt: task.createdAt, caseIds: ['TC-1'], coveredIds: [], missingIds: [], issues: ['One note'], findings: [{ category: 'quality', code: 'note', message: 'One note', caseIds: ['TC-1'] }], caseReviews: [{ caseId: 'TC-1', status: 'warning' }] }
  const html = render(task)
  assert.match(html, /本次范围 · 设计审查完成/)
  assert.match(html, /阻断 0 项 · 受影响 case 0 条 · 非阻断提示 1 项/)
  const reviewSummary = html.match(/<section class="design-review-summary"[^]*?<\/section>/)![0]
  assert.equal((reviewSummary.match(/One note/g) || []).length, 1)
  assert.equal((html.match(/<strong>关联审查问题<\/strong>One note/g) || []).length, 1)
  assert.equal((html.match(/case-review-warning/g) || []).length, 1)
  assert.equal((html.match(/case-review-out_of_scope/g) || []).length, 9)
  assert.doesNotMatch(html, /case-review-rejected/)
  assert.match(html, /仅看阻断/)
  task.executionAssessment.caseIds = ['TC-2']
  const stale = render(task)
  assert.match(stale, /本次范围 · 设计审查未完成/)
  assert.match(stale, /case-review-unknown/)
  assert.doesNotMatch(stale, /case-review-warning/)
})

test('environment errors preserve design results and expose preparation separately without keyword guessing', () => {
  const task = fixture()
  task.status = 'TEST_EXECUTION'
  task.acceptanceAssessment = { status: 'qualified', checkedAt: task.createdAt, coveredIds: [], missingIds: [], issues: [], caseReviews: [{ caseId: 'TC-1', status: 'qualified' }] }
  task.selfTests![0].status = 'skipped'
  task.selfTests![0].output = '执行准备受阻：缺少本地 runner'
  task.selfTests![1].status = 'manual'
  task.selfTests![1].output = 'browser account missing'
  task.selfTestError = 'Environment unavailable'
  const html = render(task)
  assert.match(html, /默认质量门禁 · 设计审查完成/)
  const execution = renderExecution(task)
  assert.match(execution, /case-preparation_blocked/)
  assert.match(execution, /case-manual/)
  assert.doesNotMatch(html, /case-preparation_blocked|case-manual/)
  assert.match(html, /Environment unavailable/)
  assert.match(html, /本次设计审查<\/strong>审查通过/)
  task.status = 'REVIEW'
  task.selfTestPlanningStatus = 'reviewing'
  assert.match(renderSections(task).execution, /继续审查所选用例/)
  assert.match(render(task), /修正用例设计/)
  assert.match(render(task), /不放行、不启动执行/)
})

test('default in-progress and interrupted reviews override stale rejection without hiding partial problems', () => {
  const task = fixture()
  task.entries = []
  task.status = 'SELF_TEST'
  for (const phase of ['generating', 'reviewing'] as const) {
    task.selfTestPlanningStatus = phase
    assert.equal(defaultReviewProgress(task, true), 'checking')
    const checking = render(task)
    assert.match(checking, /data-review-state="checking"/)
    assert.match(checking, /等待当前生成或审查完成/)
    assert.match(checking, /Payment coverage missing/)
    assert.doesNotMatch(checking, /设计审查受阻|未通过，拒绝默认执行/)
    task.status = 'REVIEW'
    task.selfTestError = 'Review interrupted'
    const interrupted = render(task)
    assert.match(interrupted, /data-review-state="unknown"/)
    assert.match(interrupted, /恢复或重新提交审查/)
    assert.match(interrupted, /Payment coverage missing/)
    assert.doesNotMatch(interrupted, /设计审查受阻|未通过，拒绝默认执行/)
    delete task.selfTestError
    task.status = 'SELF_TEST'
  }
  task.status = 'REVIEW'
  task.selfTestPlanningStatus = 'rejected'
  task.selfTestError = 'Completed with partial problems'
  assert.match(render(task), /data-review-state="blocked"/)
  assert.match(render(task), /先修正用例设计/)
  task.status = 'TEST_EXECUTION'
  task.selfTestPlanningStatus = 'reviewing'
  task.acceptanceAssessment!.status = 'qualified'
  task.selfTestError = 'Execution environment unavailable'
  assert.equal(defaultReviewProgress(task, false), undefined)
  assert.equal(defaultReviewProgress(task, true), 'unknown')
  assert.match(render(task), /默认质量门禁 · 设计审查未完成/)
  assert.match(render(task), /恢复或重新提交审查/)
  delete task.selfTestPlanningStatus
  assert.match(render(task), /默认质量门禁 · 设计审查完成/)
  assert.match(render(task), /设计完成不代表执行通过/)
  assert.equal(designReviewState({ ...task.acceptanceAssessment!, readiness: 'blocked' }, true, 'checking'), 'blocked')
})

test('execution summary and blocking predicate use selected actual runtime states rather than design rejection', () => {
  const task = fixture()
  task.status = 'TEST_EXECUTION'
  const statuses = ['skipped', 'manual', 'failed', 'passed', 'running', 'pending', 'skipped', 'invalid', 'failed'] as const
  const template = task.selfTests![0]
  task.selfTests = statuses.map((status, index) => ({ ...template, id: `TC-${index + 1}`, status, output: index === 0 ? '执行准备受阻：No runner' : undefined }))
  task.acceptanceSelection = { mode: 'custom', caseIds: task.selfTests.slice(0, -1).map(item => item.id), reason: 'Runtime scope', confirmedAt: task.createdAt }
  task.testExecutionPlan = createExecutionPlan(task.acceptanceBaseline!, task.selfTests, [], task.acceptanceSelection)
  task.acceptanceAssessment!.caseReviews = [{ caseId: 'TC-4', status: 'rejected' }]
  const html = renderExecution(task)
  const summary = html.match(/<div class="execution-summary"[^]*?<\/div>/)![0]
  for (const label of ['执行准备受阻', '需人工确认', '执行失败（断言原因待核对）', '通过', '运行中', '待运行', '未执行', '待修正']) assert.ok(summary.includes(`${label} 1</span>`), label)
  assert.match(summary, /已选中 8 条/)
  assert.match(summary, /本次未选中 1 条/)
  assert.doesNotMatch(html, /TC-9 ·|case-review-|design-review-summary/)
  assert.match(html, /仅看执行阻断/)
  for (const item of task.selfTests) {
    const selected = task.acceptanceSelection.caseIds.includes(item.id)
    const state = executionCaseState(item, selected).state
    assert.equal(executionBlocks(state), selected && ['skipped', 'manual', 'failed', 'invalid'].includes(item.status), item.id)
  }
  assert.equal(executionBlocks(executionCaseState({ ...template, status: 'passed' }, true, { status: 'blocked' } as NonNullable<CodingTask['automationRuns']>[number]).state), true)
})

test('execution uses only saved explicitly selected rows, not the current draft scope or legacy runs', () => {
  const task = fixture()
  task.selfTests = task.selfTests!.slice(0, 5)
  task.acceptanceSelection = { mode: 'custom', caseIds: ['TC-2'], reason: 'Unsaved scope change', confirmedAt: task.createdAt }
  task.testExecutionPlan = {
    version: 1, createdAt: task.createdAt, mode: 'custom', cases: [
      { caseId: 'TC-3', selected: true, gatePolicy: 'advisory', reason: 'Saved supplement' },
      { caseId: 'TC-1', selected: true, gatePolicy: 'blocking', reason: 'Saved required case' },
      { caseId: 'TC-2', selected: false, gatePolicy: 'advisory', reason: 'Not submitted' },
      { caseId: 'TC-4', selected: undefined as unknown as boolean, gatePolicy: 'blocking', reason: 'Legacy missing selection' },
      { caseId: 'TC-5', selected: 'true' as unknown as boolean, gatePolicy: 'blocking', reason: 'Malformed truthy selection' },
      { caseId: 'TC-3', selected: true, gatePolicy: 'advisory', reason: 'Duplicate saved entry' },
    ],
  }
  task.automationRuns = [{ caseId: 'TC-2', status: 'failed', output: 'Unselected runtime output' }, { caseId: 'orphan-run', status: 'passed' }]
  const html = renderExecution(task)
  assert.equal((html.match(/<details class="execution-row"/g) || []).length, 2)
  assert.match(html, /已提交范围（只读） · 2 条/)
  assert.match(html, /TC-3 \/ TC-1/)
  assert.match(html, /已选中 2 条/)
  assert.match(html, /必验通过 1\/1/)
  assert.match(html, /本次未选中 3 条/)
  assert.match(html, /本次已选中 · 补充 · Saved supplement/)
  assert.match(html, /本次已选中 · 必验 · Saved required case/)
  assert.ok(html.indexOf('<strong>TC-3 ·') < html.indexOf('<strong>TC-1 ·'))
  assert.doesNotMatch(html, /TC-2 ·|TC-4 ·|TC-5 ·|orphan-run|Unsaved scope change|Unselected runtime output|历史执行记录/)
  assert.match(render(task), /Unsaved scope change/)
})

test('no plan stays compact for pending designs but exposes explicitly labeled legacy evidence', () => {
  const task = fixture()
  task.selfTests = task.selfTests!.slice(0, 3).map(item => ({ ...item, status: 'pending' }))
  task.acceptanceSelection = { mode: 'custom', caseIds: ['TC-1'], reason: 'Draft only', confirmedAt: task.createdAt }
  for (const selfTests of [undefined, [], task.selfTests]) {
    const html = renderExecution({ ...task, selfTests })
    assert.match(html, /aria-label="用例执行"/)
    assert.match(html, /尚无已提交的执行计划/)
    assert.doesNotMatch(html, /execution-row|execution-filters|execution-pagination|execution-summary|历史执行记录|TC-1|Draft only/)
  }
  task.selfTests[1].status = 'manual'
  task.automationRuns = [{ caseId: 'TC-3', status: 'generating' }, { caseId: 'legacy-run', status: 'blocked' }]
  const legacy = renderExecution(task)
  assert.match(legacy, /历史执行记录（非完整已提交范围）/)
  assert.equal((legacy.match(/<details class="execution-row"/g) || []).length, 3)
  assert.match(legacy, /TC-2 · Case 2/)
  assert.match(legacy, /TC-3 · Case 3/)
  assert.match(legacy, /legacy-run · 设计定义不可用/)
  assert.match(legacy, /case-status case-running/)
  assert.match(legacy, /case-status case-preparation_blocked/)
  assert.doesNotMatch(legacy, /TC-1 ·|已提交执行统计|已提交范围（只读）|必验通过/)
  task.testExecutionPlan = { version: 1, createdAt: task.createdAt, cases: [] }
  const emptyPlan = renderExecution(task)
  assert.match(emptyPlan, /已选中 0 条/)
  assert.match(emptyPlan, /没有匹配的执行用例/)
  assert.doesNotMatch(emptyPlan, /尚无已提交|历史执行记录|<details class="execution-row"|legacy-run|TC-2 ·|TC-3 ·/)
})

test('saved plan preserves unknown case IDs with and without automation evidence', () => {
  const task = fixture()
  task.selfTests = []
  task.testExecutionPlan = { version: 1, createdAt: task.createdAt, cases: [
    { caseId: 'removed-design', selected: true, gatePolicy: 'blocking', reason: 'Retain saved ID' },
    { caseId: 'run-only', selected: true, gatePolicy: 'advisory', reason: 'Retain evidence' },
  ] }
  task.automationRuns = [{ caseId: 'run-only', status: 'passed', output: 'Retained runtime evidence' }]
  const html = renderExecution(task)
  assert.equal((html.match(/<details class="execution-row"/g) || []).length, 2)
  assert.equal((html.match(/设计定义不可用，保留执行记录与用例 ID。/g) || []).length, 2)
  assert.match(html, /removed-design · 设计定义不可用/)
  assert.match(html, /run-only · 设计定义不可用/)
  assert.match(html, /case-status case-unknown">执行状态未记录/)
  assert.match(html, /case-status case-passed">通过/)
  assert.match(html, /执行状态未记录 1/)
  assert.match(html, /必验通过 0\/1/)
  assert.match(html, /Retained runtime evidence/)
  assert.match(html, /定位设计用例 removed-design/)
  assert.match(html, /预期结果未记录/)
})

test('generation keeps design badges across task phases while the sibling uses saved runtime results', () => {
  const task = fixture()
  task.selfTests = task.selfTests!.slice(0, 2)
  task.acceptanceAssessment!.caseReviews = [{ caseId: 'TC-1', status: 'rejected' }, { caseId: 'TC-2', status: 'qualified' }]
  task.selfTests[1].status = 'failed'
  task.testExecutionPlan = createExecutionPlan(task.acceptanceBaseline!, task.selfTests)
  task.automationRuns = [{ caseId: 'TC-2', status: 'passed', output: 'Runtime evidence only' }]
  for (const status of ['SELF_TEST', 'TEST_EXECUTION', 'REVIEW', 'SUCCESS', 'ACCEPTED'] as const) {
    task.status = status
    const { generation, execution } = renderSections(task)
    assert.match(generation, /case-status case-review-rejected/)
    assert.match(generation, /case-status case-review-qualified/)
    assert.doesNotMatch(generation, /case-status case-passed|case-status case-failed|Runtime evidence only|execution-summary/)
    assert.equal((execution.match(/case-status case-passed/g) || []).length, 2)
    assert.match(execution, /必验通过 2\/2/)
    assert.match(execution, /Runtime evidence only/)
    assert.doesNotMatch(execution, /case-review-|design-review-summary|case-status case-failed|role="tab/)
  }
})

test('execution evidence uses closed native details with timestamps, script and automation links', () => {
  const task = fixture()
  task.id = 'task with space'
  task.selfTests = [{ ...task.selfTests![0], testFile: 'order.spec.ts', output: 'Saved case output' }]
  task.testExecutionPlan = createExecutionPlan(task.acceptanceBaseline!, task.selfTests)
  const startedAt = '2026-10-19T10:00:00.000Z'
  const finishedAt = '2026-10-19T10:00:05.000Z'
  task.automationRuns = [{ caseId: 'TC-1', status: 'failed', startedAt, finishedAt, script: 'await saveOrder()', output: 'Run assertion output', screenshot: 'result.png' }]
  const html = renderExecution(task)
  assert.match(html, /<details class="execution-row"><summary><strong>TC-1 · Case 1/)
  assert.doesNotMatch(html, /<details[^>]*\sopen(?:=|\s|>)/)
  for (const label of ['预期结果', '执行输出', '执行脚本']) assert.ok(html.includes(`<details><summary>${label}</summary>`), label)
  for (const evidence of ['Saved', 'Saved case output', 'Run assertion output', 'await saveOrder()', 'order.spec.ts']) assert.ok(html.includes(evidence), evidence)
  assert.ok(html.includes(`<time dateTime="${startedAt}">${startedAt}</time>`))
  assert.ok(html.includes(`<time dateTime="${finishedAt}">${finishedAt}</time>`))
  assert.match(html, /href="\/\?task=task%20with%20space&amp;automation=TC-1"/)
  assert.match(html, /href="\/api\/tasks\/task%20with%20space\/automation\/TC-1\/screenshot" target="_blank" rel="noreferrer"/)
  assert.match(html, /定位设计用例 TC-1/)
  assert.match(html, /查看自动化任务 TC-1/)
  assert.match(html, /执行截图 TC-1/)
  task.automationRuns[0].output = task.selfTests[0].output
  assert.equal((renderExecution(task).match(/<pre>Saved case output<\/pre>/g) || []).length, 1)
})

test('global design blockers explain scope-wide filtering and details keep concise original problems', () => {
  const task = fixture()
  task.status = 'REVIEW'
  task.entries = []
  task.selfTests = task.selfTests!.slice(0, 2)
  task.acceptanceAssessment!.issues = []
  task.acceptanceAssessment!.findings = [
    { category: 'safety', code: 'global', message: 'Global safety problem', caseIds: [] },
    { category: 'quality', code: 'local', message: 'Local assertion problem', caseIds: ['TC-1'] },
  ]
  const html = render(task)
  assert.match(html, /阻断 2 项 · 受影响 case 1 条/)
  assert.match(html, /仅看阻断会纳入当前范围全部用例，不表示每条用例都有独立问题/)
  const details = [...html.matchAll(/<details class="test-case-details"[^]*?<\/details>/g)].map(match => match[0])
  assert.equal(details.length, 2)
  for (const detail of details) {
    assert.match(detail, /<strong>全局审查问题<\/strong>Global safety problem/)
    assert.doesNotMatch(detail, /design-review-summary|来源：findings|阻断 2 项/)
  }
  assert.match(details[0], /<strong>关联审查问题<\/strong>Local assertion problem/)
  assert.doesNotMatch(details[1], /Local assertion problem/)
  task.acceptanceSelection = { mode: 'custom', caseIds: ['TC-1'], reason: 'Smoke', confirmedAt: task.createdAt }
  task.executionAssessment = { ...task.acceptanceAssessment!, readiness: 'blocked', caseIds: ['TC-1'] }
  const custom = render(task)
  assert.match(custom, /当前范围已知受阻：请先修正用例或调整范围与理由；仍可确认后重新提交审查/)
  delete task.executionAssessment
  const unsubmitted = render(task)
  assert.match(unsubmitted, /case-review-out_of_scope/)
  assert.match(unsubmitted, /case-review-unknown/)
  assert.doesNotMatch(unsubmitted, /当前范围已知受阻/)
})