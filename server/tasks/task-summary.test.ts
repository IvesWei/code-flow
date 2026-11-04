import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CodingTask } from '../../shared/task.js'
import type { TaskListProjection } from '../../shared/task-summary.js'
import { displayEntry, taskDetail, taskSummary } from './task-summary.js'

test('summaries preserve optional execution metadata through hydrated and SQL paths without leaking run bodies', () => {
  const executionResult = {
    version: 1 as const, runner: 'playwright-test' as const, caseId: 'TC-1', caseFingerprint: 'fingerprint',
    status: 'passed' as const, reason: 'Assertions passed',
    assertions: [{ id: 'TC-1:A001', status: 'passed' as const, expectCount: 1 }],
    startedAt: '2026-10-20T00:00:00Z', finishedAt: '2026-10-20T00:00:01Z',
  }
  const run = { caseId: 'TC-1', title: 'Saved title', status: 'passed' as const, runner: 'playwright-test' as const, executionResult }
  const privateRun = { ...run, script: 'private script', output: 'private output', internalFutureField: 'private state' }
  const task: CodingTask = {
    id: 'summary', repository: 'repo', instruction: '', prdName: '', designNames: [], entries: [],
    status: 'REVIEW', createdAt: '', updatedAt: '',
    selfTests: [{ id: 'TC-1', title: run.title, source: '', steps: '', expected: '', status: 'passed' }],
    automationRuns: [privateRun, { caseId: 'legacy', status: 'blocked' }, { caseId: 'dsl', status: 'passed', runner: 'browser-dsl' }],
  }
  for (const source of [task, { ...task, runs: [privateRun, { caseId: 'legacy', title: '自动化用例', status: 'blocked' as const }, { caseId: 'dsl', title: '自动化用例', status: 'passed' as const, runner: 'browser-dsl' as const }] }]) {
    const summary = taskSummary(source)
    assert.deepEqual(summary.runs[0], run)
    assert.deepEqual(summary.runs[1], { caseId: 'legacy', title: '自动化用例', status: 'blocked' })
    assert.equal(summary.runs[2].runner, 'browser-dsl')
    assert.deepEqual(JSON.parse(JSON.stringify(summary)).runs, summary.runs)
    assert.doesNotMatch(JSON.stringify(summary), /private|script|output|internalFutureField/)
  }
})

test('task display removes old terminal controls without rewriting stored evidence', () => {
  const task: CodingTask = {
    id: 'demo', repository: 'https://github.com/owner/repo', instruction: 'Test',
    prdName: 'prd.md', designNames: [], status: 'REVIEW', createdAt: '', updatedAt: '',
    entries: [{ at: '', kind: 'warning', text: '\u001b[31m检查失败\u001b[0m', detail: '\u001b[31m中文错误\u001b[0m' }],
    checks: [{ name: 'npm run test', passed: false, output: '\u001b[31m断言失败\u001b[0m' }],
    automationRuns: [{ caseId: 'TC-01', status: 'failed', script: '{"steps":[]}' }],
  }
  Object.assign(task, {
    internalFutureField: 'private future state',
    selfTestArtifacts: [{ output: { content: 'private artifact body' } }],
    acceptanceHistory: [{ cases: [{ output: 'private past evidence' }] }],
    modelHistory: [{ at: '', from: 'auto', to: 'model', revision: 1 }],
  })
  const display = taskDetail(task)
  assert.equal(displayEntry(task.entries[0]).text, '检查失败')
  assert.equal(displayEntry(task.entries[0]).detail, '中文错误')
  assert.equal(display.checks?.[0].output, '断言失败')
  assert.equal(display.automationRuns?.[0].script, undefined)
  assert.equal(task.entries[0].detail, '\u001b[31m中文错误\u001b[0m')
  assert.deepEqual(display.entries, [])
  for (const field of ['internalFutureField', 'selfTestArtifacts', 'acceptanceHistory', 'modelHistory']) {
    assert.equal(Object.hasOwn(display, field), false, field)
  }
  const summary = taskSummary(task)
  assert.equal(summary.automationCount, 1)
  assert.equal(summary.runs[0].caseId, 'TC-01')
  for (const field of ['entries', 'checks', 'instruction', 'selfTests', 'selfTestArtifacts', 'automationRuns', 'acceptanceHistory', 'modelHistory']) {
    assert.equal(Object.hasOwn(summary, field), false, field)
  }
  assert.equal(JSON.stringify(summary).includes('steps'), false)
  assert.doesNotMatch(JSON.stringify(summary), /private/)
})

test('SQL list projections preserve aggregate counts without hydrated case histories', () => {
  const projection: TaskListProjection = {
    id: 'compact', ownerId: 7, repository: 'repo', instruction: '', prdName: '', designNames: [], entries: [],
    status: 'REVIEW', createdAt: '', updatedAt: '', hasWorkspace: true,
    caseCount: 125, automationCount: 120, runnable: false,
    runs: [{ caseId: 'TC-01', title: 'Saved title', status: 'passed' }],
  }
  const result = taskSummary(projection)
  assert.equal(result.hasWorkspace, true)
  assert.equal(result.caseCount, 125)
  assert.equal(result.automationCount, 120)
  assert.equal(result.runnable, false)
  assert.deepEqual(result.runs, projection.runs)
  assert.equal('selfTests' in result, false)
})