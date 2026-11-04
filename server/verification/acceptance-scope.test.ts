import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AcceptanceAssessment, SelfTestCase } from '../../shared/task.js'
import { createExecutionPlan, executionSummary, parseAcceptanceSelection } from '../../shared/test-policy.js'
import { applyQualityReview, qualityRepairIds } from './acceptance.js'

const cases = Array.from({ length: 130 }, (_, index) => ({ id: `TC-${String(index + 1).padStart(2, '0')}`, status: 'manual' } as SelfTestCase))
const assessment: AcceptanceAssessment = { status: 'rejected', checkedAt: '', issues: ['TC-29 mapping', 'TC-41 session', 'TC-99 identity'], coveredIds: [], missingIds: [] }
test('legacy and structured review findings repair only affected cases', () => {
  assert.deepEqual(qualityRepairIds(assessment, cases), ['TC-29', 'TC-41', 'TC-99'])
  assert.deepEqual(qualityRepairIds({ ...assessment, issues: ['Global baseline problem'] }, cases), [])
  assert.deepEqual(qualityRepairIds({ ...assessment, issues: [], caseIssues: [{ caseId: 'TC-29', message: 'Mapping' }] }, cases), ['TC-29'])
  assert.throws(() => applyQualityReview(assessment, JSON.stringify({ qualified: false, issues: ['Mapping'], caseIssues: [{ caseId: 'TC-999', message: 'Mapping' }] }), ['TC-29']))
})
test('custom gate uses exactly the explicitly selected set and records its rationale', () => {
  assert.throws(() => parseAcceptanceSelection({ mode: 'custom', caseIds: [], reason: 'Scope' }, cases))
  assert.throws(() => parseAcceptanceSelection({ mode: 'custom', caseIds: ['TC-999'], reason: 'Scope' }, cases))
  assert.throws(() => parseAcceptanceSelection({ mode: 'custom', caseIds: ['TC-01'], reason: '' }, cases))
  const selection = parseAcceptanceSelection({ mode: 'custom', caseIds: ['TC-01'], reason: 'Functional release only' }, cases)
  const results = [{ ...cases[0], status: 'passed' as const }, { ...cases[1], status: 'failed' as const }]
  const plan = createExecutionPlan([], results, [], selection)
  assert.equal(plan.mode, 'custom')
  assert.equal(plan.cases[1].selected, false)
  assert.equal(executionSummary(results, plan).qualified, true)
  assert.match(plan.cases[0].reason, /Functional release/)
})