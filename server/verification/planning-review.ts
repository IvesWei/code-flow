import type { AcceptanceAssessment } from '../../shared/task.js'
import type { PlanningReviewBatch } from '../../shared/testing.js'
import { applyQualityReview } from './acceptance.js'

export function applyPlanningReview(assessment: AcceptanceAssessment, content: string, caseIds: string[]): { assessment: AcceptanceAssessment; result: PlanningReviewBatch['result'] } {
  const parsed = JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''))
  if (parsed?.qualified === false && Array.isArray(parsed.issues) && !parsed.issues.length && Array.isArray(parsed.caseIssues) && parsed.caseIssues.length) {
    parsed.issues = parsed.caseIssues.map((item: { caseId?: unknown; message?: unknown }) => `${item?.caseId}：${item?.message}`)
  }
  if (Array.isArray(parsed?.issues) && parsed.issues.some((issue: unknown) => typeof issue === 'string' && [...issue.matchAll(/\bTC-\d+\b/g)].some(match => !caseIds.includes(match[0])))) throw new Error('Review summary references cases outside the batch')
  const reviewed = applyQualityReview(assessment, JSON.stringify(parsed), caseIds)
  return { assessment: reviewed, result: { qualified: parsed.qualified, issues: parsed.issues, caseIssues: parsed.caseIssues || [] } }
}