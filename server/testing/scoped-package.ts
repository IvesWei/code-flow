import type { CasePackage, PlanningDraft } from '../../shared/testing.js'
import { PlanningError, planningDigest, planningRulesVersion, qualifiedPlanning } from './planning-model.js'

export function canonicalScopeIds(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 1000 || value.some(id => typeof id !== 'string' || !/^TC-\d{1,6}$/.test(id)) || new Set(value).size !== value.length) throw new PlanningError('INVALID_INPUT')
  return [...value].sort()
}

export function validatePackageScope(value: Pick<CasePackage, 'scope' | 'baseline' | 'cases'>): void {
  const scope = value.scope
  if (scope === undefined) return
  if (!scope || scope.mode !== 'custom' || Object.keys(scope).some(key => !['mode', 'caseIds', 'reason', 'originalDefinitionFingerprint'].includes(key))
    || typeof scope.reason !== 'string' || !scope.reason.trim() || scope.reason !== scope.reason.trim() || scope.reason.length > 2000
    || !/^[a-f0-9]{64}$/.test(scope.originalDefinitionFingerprint)) throw new PlanningError('INVALID_INPUT')
  const ids = canonicalScopeIds(scope.caseIds)
  if (planningDigest(ids) !== planningDigest(scope.caseIds) || planningDigest(ids) !== planningDigest(canonicalScopeIds(value.cases.map(item => item.id)))) throw new PlanningError('INVALID_INPUT')
  const referenced = new Set(value.cases.flatMap(item => item.requirementIds || []))
  if (!value.baseline.length || value.baseline.some(item => item.required !== false || !referenced.has(item.id)) || [...referenced].some(id => !value.baseline.some(item => item.id === id))) throw new PlanningError('INVALID_INPUT')
}

export function packageInputFingerprint(value: Pick<CasePackage, 'sourceFingerprint' | 'definitionFingerprint' | 'rulesVersion' | 'scope'>): string {
  return planningDigest({ sourceFingerprint: value.sourceFingerprint, definitionFingerprint: value.definitionFingerprint, rulesVersion: value.rulesVersion, ...(value.scope ? { scope: value.scope } : {}) })
}

export function scopedPlanning(draft: PlanningDraft, caseIds: unknown, reason: unknown) {
  const ids = canonicalScopeIds(caseIds)
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 2000) throw new PlanningError('INVALID_INPUT')
  const review = draft.customReview
  const originalDefinitionFingerprint = planningDigest({ baseline: draft.baseline, cases: draft.cases })
  if (!draft.sourceFingerprint || draft.definitionFingerprint !== originalDefinitionFingerprint || !review || review.definitionFingerprint !== originalDefinitionFingerprint) throw new PlanningError('SOURCE_CHANGED')
  if (planningDigest(canonicalScopeIds(review.caseIds)) !== planningDigest(ids) || review.reason !== reason.trim()) throw new PlanningError('CONFLICT')
  const selected = draft.cases.filter(item => ids.includes(item.id))
  if (selected.length !== ids.length || !review.assessment || !Number.isFinite(Date.parse(review.assessment.checkedAt)) || Date.parse(review.assessment.checkedAt) > Date.now()) throw new PlanningError('UNQUALIFIED')
  const reviewedIds: string[] = []
  for (const batch of review.batches || []) {
    const batchIds = canonicalScopeIds(batch.caseIds)
    if (batch.result.qualified !== true || !Array.isArray(batch.result.issues) || batch.result.issues.length || !Array.isArray(batch.result.caseIssues) || batch.result.caseIssues.length || batchIds.some(id => !ids.includes(id) || reviewedIds.includes(id))) throw new PlanningError('UNQUALIFIED')
    reviewedIds.push(...batchIds)
  }
  if (planningDigest(reviewedIds.sort()) !== planningDigest(ids)) throw new PlanningError('UNQUALIFIED')
  const referenced = new Set(selected.flatMap(item => item.requirementIds || []))
  const baseline = draft.baseline.filter(item => referenced.has(item.id)).map(item => ({ ...structuredClone(item), required: false }))
  const qualified = qualifiedPlanning({ baseline, cases: selected, assessment: review.assessment })
  const scope: NonNullable<CasePackage['scope']> = { mode: 'custom', caseIds: ids, reason: reason.trim(), originalDefinitionFingerprint }
  validatePackageScope({ ...qualified, scope })
  const definitionFingerprint = planningDigest({ baseline: qualified.baseline, cases: qualified.cases })
  const sourceFingerprint = draft.sourceFingerprint
  qualified.assessment.checkedAt = review.assessment.checkedAt
  qualified.assessment.inputFingerprint = packageInputFingerprint({ sourceFingerprint, definitionFingerprint, rulesVersion: planningRulesVersion, scope })
  return { ...qualified, scope, sourceFingerprint, definitionFingerprint }
}