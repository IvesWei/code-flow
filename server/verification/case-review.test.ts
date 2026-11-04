import assert from 'node:assert/strict'
import { test } from 'node:test'
import { caseReviewStatuses, customReady, isBlockingFinding, reviewCaseState, reviewFindingCategories } from '../../shared/case-review.js'
import type { AcceptanceAssessment } from '../../shared/task.js'

const assessment: AcceptanceAssessment = { status: 'qualified', checkedAt: '2026-10-16T00:00:00.000Z', issues: [], coveredIds: [], missingIds: [] }

test('review helpers never infer a case pass or readiness from legacy quality', () => {
  for (const value of [undefined, assessment, { ...assessment, status: 'rejected' as const }]) {
    assert.equal(reviewCaseState(value, 'TC-1'), 'unknown')
    assert.equal(customReady(value), false)
  }
  for (const status of caseReviewStatuses) {
    assert.equal(reviewCaseState({ ...assessment, caseReviews: [{ caseId: 'TC-1', status }] }, 'TC-1'), status)
    assert.equal(reviewCaseState({ ...assessment, caseReviews: [{ caseId: 'TC-1', status }] }, 'TC-2'), 'unknown')
  }
  for (const readiness of ['checking', 'ready', 'blocked', 'unknown'] as const) {
    assert.equal(customReady({ ...assessment, status: 'rejected', readiness }), readiness === 'ready')
  }
})

test('finding categories alone decide blocking', () => {
  for (const category of reviewFindingCategories) {
    assert.equal(isBlockingFinding({ category }), ['executability', 'conflict', 'safety'].includes(category))
  }
})