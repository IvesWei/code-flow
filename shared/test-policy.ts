import type { AcceptanceRequirement, CodingTask, SelfTestCase } from './task.js'

export function casePolicy(baseline: AcceptanceRequirement[], item: SelfTestCase, requested = false) {
  const requirements = item.requirementIds?.map((id) => baseline.find((requirement) => requirement.id === id)) || []
  const blocking = !item.classification || !requirements.length || requirements.some((requirement) => !requirement || requirement.required)
  const selected = blocking || requested || item.classification?.executionPolicy === 'always'
  return {
    caseId: item.id,
    selected,
    gatePolicy: blocking ? 'blocking' as const : 'advisory' as const,
    reason: !item.classification ? '旧用例缺少分类，沿用全部必验策略' : blocking ? '关联必验需求或需求映射不完整，不允许降级' : requested ? '用户显式选中补充用例，结果不阻断验收' : selected ? '补充用例按常规执行，结果不阻断验收' : '补充用例按需执行，本次未选中，不计为通过',
  }
}

export function createExecutionPlan(baseline: AcceptanceRequirement[], cases: SelfTestCase[], selectedCaseIds: string[] = [], selection?: CodingTask['acceptanceSelection']): NonNullable<CodingTask['testExecutionPlan']> {
  return { version: 1, createdAt: new Date().toISOString(), mode: selection ? 'custom' : 'default', cases: cases.map((item) => selection ? {
    caseId: item.id, selected: selection.caseIds.includes(item.id), gatePolicy: selection.caseIds.includes(item.id) ? 'blocking' : 'advisory',
    reason: selection.caseIds.includes(item.id) ? `用户选择本次必验：${selection.reason}` : `用户未选入本次验收，不计为通过：${selection.reason}`,
  } : casePolicy(baseline, item, selectedCaseIds.includes(item.id))) }
}

export function parseAcceptanceSelection(value: unknown, cases: SelfTestCase[]): CodingTask['acceptanceSelection'] {
  if (value === undefined || value === null) return undefined
  if (!value || typeof value !== 'object') throw new Error('验收选择格式不合法')
  const data = value as Record<string, unknown>
  if (data.mode !== 'custom' || !Array.isArray(data.caseIds) || !data.caseIds.length || data.caseIds.length > 1000 || new Set(data.caseIds).size !== data.caseIds.length || data.caseIds.some((id) => typeof id !== 'string' || !cases.some((item) => item.id === id && item.status !== 'invalid')) || typeof data.reason !== 'string' || !data.reason.trim() || data.reason.length > 2000) throw new Error('自定义验收需至少选择一条有效用例并填写范围调整理由')
  return { mode: 'custom', caseIds: [...data.caseIds] as string[], reason: data.reason.trim(), confirmedAt: new Date().toISOString() }
}

export function requestedCaseIds(value: unknown, cases: SelfTestCase[]): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 1000 || new Set(value).size !== value.length || value.some((id) => typeof id !== 'string' || !cases.some((item) => item.id === id && ['pending', 'manual'].includes(item.status)))) throw new Error('只能选择已保存且尚未执行的用例，ID 不得重复')
  return value as string[]
}

export function executionSummary(cases: SelfTestCase[], plan: NonNullable<CodingTask['testExecutionPlan']>) {
  const blocking = cases.filter((item) => plan.cases.find((entry) => entry.caseId === item.id)?.gatePolicy !== 'advisory')
  const advisory = cases.filter((item) => plan.cases.find((entry) => entry.caseId === item.id)?.gatePolicy === 'advisory')
  return {
    blockingTotal: blocking.length,
    blockingPassed: blocking.filter((item) => item.status === 'passed').length,
    advisoryFailed: advisory.filter((item) => item.status === 'failed').length,
    advisoryUnverified: advisory.filter((item) => item.status !== 'passed' && item.status !== 'failed').length,
    notSelected: plan.cases.filter((entry) => !entry.selected).length,
    qualified: blocking.length > 0 && blocking.every((item) => item.status === 'passed'),
  }
}