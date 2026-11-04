import type { AcceptanceAssessment, AutomationRun, CodingTask, SelfTestCase } from '../../../../shared/task'
import { isBlockingFinding } from '../../../../shared/case-review'

export type ReviewProblem = { message: string; caseIds: string[]; sources: string[]; blocking: boolean }

export function sameCaseScope(left: string[], right: string[]) {
  return new Set(left).size === new Set(right).size && left.every(id => right.includes(id))
}

export function currentScopeAssessment(task: CodingTask, ids: string[], reason: string) {
  const selection = task.acceptanceSelection
  const checkedAt = Date.parse(task.executionAssessment?.checkedAt || '')
  const confirmedAt = Date.parse(selection?.confirmedAt || '')
  return selection && sameCaseScope(selection.caseIds, ids) && selection.reason.trim() === reason.trim()
    && task.executionAssessment && sameCaseScope(task.executionAssessment.caseIds, selection.caseIds)
    && Number.isFinite(checkedAt) && Number.isFinite(confirmedAt) && checkedAt >= confirmedAt
    ? task.executionAssessment : undefined
}

export function reviewProblems(assessment: AcceptanceAssessment | undefined, custom: boolean): ReviewProblem[] {
  const problems = new Map<string, ReviewProblem>()
  const add = (message: string, caseIds: string[], source: string, blocking: boolean) => {
    const key = message.trim()
    const existing = problems.get(key)
    if (existing) {
      existing.caseIds = [...new Set([...existing.caseIds, ...caseIds])]
      existing.sources = [...new Set([...existing.sources, source])]
      existing.blocking ||= blocking
    } else problems.set(key, { message, caseIds: [...new Set(caseIds)], sources: [source], blocking })
  }
  for (const finding of assessment?.findings || []) add(finding.message, finding.caseIds, `findings · ${finding.category} · ${finding.code}`, !custom || isBlockingFinding(finding))
  for (const issue of assessment?.caseIssues || []) {
    const finding = assessment?.findings?.find(entry => entry.message.trim() === issue.message.trim() && entry.caseIds.includes(issue.caseId))
    add(issue.message, [issue.caseId], 'caseIssues', !finding || !custom || isBlockingFinding(finding))
  }
  for (const issue of assessment?.issues || []) {
    const detail = assessment?.caseIssues?.find(entry => issue === `${entry.caseId}：${entry.message}`)
      || assessment?.findings?.flatMap(entry => entry.caseIds.map(caseId => ({ caseId, message: entry.message }))).find(entry => issue === `${entry.caseId}：${entry.message}`)
    if (detail) {
      const finding = assessment?.findings?.find(entry => entry.message === detail.message && entry.caseIds.includes(detail.caseId))
      add(detail.message, [detail.caseId], `issues 原文：${issue}`, !finding || !custom || isBlockingFinding(finding))
      continue
    }
    const finding = assessment?.findings?.find(entry => entry.message.trim() === issue.trim())
    const legacyIds = finding ? [] : [...issue.matchAll(/\bTC-\d+\b/g)].map(match => match[0])
    add(issue, legacyIds, 'issues', !finding || !custom || isBlockingFinding(finding))
  }
  return [...problems.values()]
}

export function defaultReviewProgress(task: CodingTask, planning: boolean): 'checking' | 'unknown' | undefined {
  if (!planning || task.acceptanceSelection || !['generating', 'reviewing'].includes(task.selfTestPlanningStatus || '')) return undefined
  if (task.selfTestError) return 'unknown'
  return task.status === 'SELF_TEST' ? 'checking' : undefined
}

export function designReviewState(assessment: AcceptanceAssessment | undefined, custom: boolean, progressState?: 'checking' | 'unknown') {
  if (!custom && progressState) return progressState
  if (!assessment) return 'unknown'
  if (custom) return assessment.readiness || 'unknown'
  if (assessment.status === 'rejected') return 'blocked'
  return 'ready'
}

export function executionCaseState(item: SelfTestCase, selected: boolean, run?: AutomationRun) {
  if (!selected) return { state: 'not_selected', label: '本次未选中' }
  if (run?.status === 'blocked' || item.output?.startsWith('执行准备受阻：')) return { state: 'preparation_blocked', label: '执行准备受阻' }
  const labels = { pending: '待运行', running: '运行中', passed: '通过', failed: '执行失败（断言原因待核对）', manual: '需人工确认', skipped: '未执行', invalid: '待修正' }
  return { state: item.status, label: labels[item.status] }
}

export function executionBlocks(state: string) {
  return ['preparation_blocked', 'manual', 'failed', 'skipped', 'invalid'].includes(state)
}