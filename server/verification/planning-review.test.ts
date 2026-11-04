import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyPlanningReview } from './planning-review.js'
import type { AcceptanceAssessment } from '../../shared/task.js'

const assessment: AcceptanceAssessment = { status: 'qualified', issues: [], checkedAt: '', coveredIds: [], missingIds: [], caseReviews: [{ caseId: 'TC-29', status: 'unreviewed' }] }

test('planning review retains concrete rejection even when summary is omitted', () => {
  const reviewed = applyPlanningReview(assessment, JSON.stringify({ qualified: false, issues: [], caseIssues: [{ caseId: 'TC-29', message: 'Assertion conflicts with blur validation' }] }), ['TC-29'])
  assert.equal(reviewed.assessment.status, 'rejected')
  assert.equal(reviewed.assessment.caseReviews?.[0].status, 'rejected')
  assert.deepEqual(reviewed.result.issues, ['TC-29：Assertion conflicts with blur validation'])
  assert.deepEqual(assessment.issues, [])
})

test('planning review rejects invalid contracts and out of scope details, not valid success', () => {
  for (const content of ['not json', '{"qualified":false,"issues":[]}', '{"qualified":true,"issues":["contradiction"]}', '{"qualified":false,"issues":["TC-03 unselected failure"],"caseIssues":[]}', '{"qualified":false,"issues":[],"caseIssues":[{"caseId":"TC-03","message":"Unselected"}]}']) {
    assert.throws(() => applyPlanningReview(assessment, content, ['TC-29']))
  }
  assert.equal(applyPlanningReview(assessment, '{"qualified":true,"issues":[],"caseIssues":[]}', ['TC-29']).assessment.status, 'qualified')
})