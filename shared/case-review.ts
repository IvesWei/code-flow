import type { AcceptanceAssessment, CaseReviewStatus, ReviewFinding } from './task.js'

export const reviewFindingCategories = ['coverage', 'quality', 'executability', 'conflict', 'safety'] as const
export const caseReviewStatuses = ['unreviewed', 'reviewing', 'qualified', 'warning', 'rejected', 'unknown'] as const

export function isBlockingFinding(finding: Pick<ReviewFinding, 'category'>): boolean {
  return finding.category === 'executability' || finding.category === 'conflict' || finding.category === 'safety'
}

export function reviewCaseState(assessment: AcceptanceAssessment | undefined, id: string): CaseReviewStatus {
  return assessment?.caseReviews?.find(review => review.caseId === id)?.status ?? 'unknown'
}

export function customReady(assessment: AcceptanceAssessment | undefined): boolean {
  return assessment?.readiness === 'ready'
}