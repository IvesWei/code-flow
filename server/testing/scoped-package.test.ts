import assert from 'node:assert/strict'
import test from 'node:test'
import type { PlanningDraft } from '../../shared/testing.js'
import { assessAcceptance, applyQualityReview } from '../verification/acceptance.js'
import { planningCases, planningDigest } from './planning-model.js'
import { scopedPlanning, validatePackageScope } from './scoped-package.js'

function scopedDraft(): PlanningDraft {
  const baseline = [{ id: 'REQ-001', feature: 'Profile', source: 'PRD', criterion: 'Persist name', required: true, scenarios: ['normal' as const, 'negative' as const] },
    { id: 'REQ-002', feature: 'Other', source: 'PRD', criterion: 'Other behavior', required: true, scenarios: ['normal' as const] }]
  const cases = [1, 2, 3].map(index => ({ id: `TC-${index}`, title: 'Persist name', source: 'PRD', steps: 'Save name and reload', expected: 'Saved name persists', requirementIds: [index === 3 ? 'REQ-002' : 'REQ-001'], scenario: 'normal' as const, preconditions: 'Account exists', testData: 'New name', assertions: ['Saved name visible after reload'], cleanup: 'Restore name' }))
  const definitionFingerprint = planningDigest({ baseline, cases })
  const assessment = applyQualityReview(assessAcceptance(baseline.map(item => ({ ...item, required: false })), planningCases(cases.slice(0, 2))), '{"qualified":true,"issues":[],"caseIssues":[]}', ['TC-1', 'TC-2'])
  return { baseline, cases, assessment: assessAcceptance(baseline, planningCases(cases)), definitionFingerprint, sourceFingerprint: planningDigest('source'),
    customReview: { caseIds: ['TC-1', 'TC-2'], reason: 'Selected behavior only', definitionFingerprint, assessment, batches: [{ caseIds: ['TC-1', 'TC-2'], result: { qualified: true, issues: [], caseIssues: [] } }] } }
}

test('scoped package qualifies only reviewed cases without claiming full coverage or changing the draft', () => {
  const draft = scopedDraft(), before = structuredClone(draft)
  const value = scopedPlanning(draft, ['TC-2', 'TC-1'], ' Selected behavior only ')
  assert.equal(draft.assessment!.status, 'rejected')
  assert.deepEqual(draft, before)
  assert.deepEqual(value.cases.map(item => item.id), ['TC-1', 'TC-2'])
  assert.deepEqual(value.baseline, [{ ...draft.baseline[0], required: false }])
  assert.deepEqual(value.scope, { mode: 'custom', caseIds: ['TC-1', 'TC-2'], reason: 'Selected behavior only', originalDefinitionFingerprint: draft.definitionFingerprint })
  assert.equal(value.assessment.status, 'qualified')
  assert.equal(value.assessment.caseReviews!.length, 2)
  validatePackageScope(value)
})

test('scoped gate rejects stale, mismatched, incomplete, warning and extra reviews', () => {
  for (const mutate of [
    (draft: PlanningDraft) => { draft.customReview!.definitionFingerprint = planningDigest('stale') },
    (draft: PlanningDraft) => { draft.customReview!.reason = 'Changed' },
    (draft: PlanningDraft) => { draft.customReview!.batches = [] },
    (draft: PlanningDraft) => { draft.customReview!.batches[0].result.qualified = false },
    (draft: PlanningDraft) => { draft.customReview!.batches.push(structuredClone(draft.customReview!.batches[0])) },
    (draft: PlanningDraft) => { draft.customReview!.batches[0].caseIds.push('TC-3') },
    (draft: PlanningDraft) => { draft.customReview!.assessment!.status = 'rejected' },
    (draft: PlanningDraft) => { draft.customReview!.assessment!.caseReviews![0].status = 'warning' },
    (draft: PlanningDraft) => { draft.customReview!.assessment!.caseReviews![0].status = 'unreviewed' },
    (draft: PlanningDraft) => { draft.customReview!.assessment!.caseReviews!.push({ caseId: 'TC-3', status: 'qualified' }) },
    (draft: PlanningDraft) => { draft.customReview!.assessment!.issues.push('Unresolved') },
    (draft: PlanningDraft) => { draft.customReview!.assessment!.caseIssues = [{ caseId: 'TC-1', message: 'Unresolved' }] },
    (draft: PlanningDraft) => { draft.customReview!.assessment!.findings = [{ code: 'unsafe', category: 'safety', message: 'Unsafe', caseIds: ['TC-1'] }] },
    (draft: PlanningDraft) => { draft.customReview!.assessment!.checkedAt = new Date(Date.now() + 60_000).toISOString() },
    (draft: PlanningDraft) => { draft.cases[0].expected = 'Changed after review' },
  ]) {
    const draft = scopedDraft()
    mutate(draft)
    assert.throws(() => scopedPlanning(draft, ['TC-1', 'TC-2'], 'Selected behavior only'))
  }
})