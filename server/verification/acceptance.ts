import { isBlockingFinding, reviewFindingCategories } from '../../shared/case-review.js'
import type { AcceptanceAssessment, AcceptanceRequirement, CaseReviewStatus, ReviewFinding, SelfTestCase } from '../../shared/task.js'

const scenarios = ['normal', 'boundary', 'negative', 'permission', 'state'] as const
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 2000
const json = (content: string): unknown => JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''))

export function parseAcceptanceBaseline(content: string): AcceptanceRequirement[] {
  const parsed = json(content)
  if (!Array.isArray(parsed) || !parsed.length || parsed.length > 50) throw new Error('验收基线必须包含 1 至 50 项需求')
  const ids = new Set<string>()
  return parsed.map((item) => {
    if (!item || !/^REQ-\d{3}$/.test(item.id) || ids.has(item.id) || !nonempty(item.source) || !nonempty(item.criterion) || typeof item.required !== 'boolean' || !Array.isArray(item.scenarios) || !item.scenarios.length || item.scenarios.some((scenario: unknown) => !scenarios.includes(scenario as typeof scenarios[number]))) throw new Error('验收基线字段、需求 ID 或场景不合法')
    ids.add(item.id)
    if (item.feature !== undefined && !nonempty(item.feature)) throw new Error('需求功能点名称不合法')
    return { id: item.id, ...(item.feature ? { feature: item.feature } : {}), source: item.source, criterion: item.criterion, required: item.required, scenarios: [...new Set(item.scenarios)] as AcceptanceRequirement['scenarios'] }
  })
}

export function assessAcceptance(baseline: AcceptanceRequirement[], cases: SelfTestCase[]): AcceptanceAssessment {
  const issues: string[] = []
  const caseIssues: NonNullable<AcceptanceAssessment['caseIssues']> = []
  const findings: ReviewFinding[] = []
  if (!baseline.length) {
    issues.push('缺少需求验收基线')
    findings.push({ code: 'missing_baseline', category: 'coverage', message: '缺少需求验收基线', caseIds: [] })
  }
  if (!cases.length) {
    issues.push('缺少验收用例')
    findings.push({ code: 'missing_cases', category: 'coverage', message: '缺少验收用例', caseIds: [] })
  }
  const known = new Set(baseline.map((item) => item.id))
  const valid = cases.filter((item) => {
    const errors: string[] = []
    if (!item.requirementIds?.length || item.requirementIds.some((id) => !known.has(id))) errors.push('需求映射缺失或引用未知需求')
    if (!item.scenario || !scenarios.includes(item.scenario)) errors.push('缺少有效场景类型')
    if (![item.title, item.source, item.steps, item.expected].every(nonempty)) errors.push('标题、出处、步骤或预期缺失')
    for (const [field, label] of [['preconditions', '前置条件'], ['testData', '测试数据'], ['cleanup', '清理方式']] as const) {
      const value = item[field]
      if (value === undefined || value === null) errors.push(`${label}（${field}）缺失；须填写非空字符串，不适用时说明原因`)
      else if (typeof value !== 'string') errors.push(`${label}（${field}）类型错误；须为字符串，实际为 ${Array.isArray(value) ? 'array' : typeof value}`)
      else if (!value.trim()) errors.push(`${label}（${field}）为空；不适用时须说明原因`)
      else if (value.length > 2000) errors.push(`${label}（${field}）长度 ${value.length} 超过 2000 字符`)
    }
    if (!item.assertions?.length || !item.assertions.every(nonempty)) errors.push('缺少可观察断言')
    if (item.status === 'invalid') errors.push('用例格式无效')
    issues.push(...errors.map((error) => `${item.id}：${error}`))
    caseIssues.push(...errors.map((message) => ({ caseId: item.id, message })))
    findings.push(...errors.map(message => ({ code: 'structural_case', category: 'quality' as const, message, caseIds: [item.id] })))
    return !errors.length
  })
  const coveredIds: string[] = [], missingIds: string[] = []
  for (const requirement of baseline) {
    const missing = requirement.scenarios.filter((scenario) => !valid.some((item) => item.requirementIds?.includes(requirement.id) && item.scenario === scenario))
    if (missing.length) {
      missingIds.push(requirement.id)
      if (requirement.required) {
        const message = `${requirement.id} 必验场景未覆盖：${missing.join('、')}`
        issues.push(message)
        findings.push({ code: 'missing_scenario', category: 'coverage', message, caseIds: [] })
      }
    } else coveredIds.push(requirement.id)
  }
  const invalidIds = new Set(caseIssues.map(issue => issue.caseId))
  return { status: issues.length ? 'rejected' : 'qualified', checkedAt: new Date().toISOString(), issues, coveredIds, missingIds, caseIssues, findings, caseReviews: cases.map(item => ({ caseId: item.id, status: invalidIds.has(item.id) ? 'rejected' : 'unreviewed' })) }
}

const present = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
const reviewId = (value: unknown): value is string => typeof value === 'string' && /^[\x21-\x7e]{1,64}$/.test(value)

export function assessExecutionReadiness(baseline: AcceptanceRequirement[], cases: SelfTestCase[]): AcceptanceAssessment {
  const assessment = assessAcceptance(baseline, cases)
  const findings = [...assessment.findings!]
  const add = (code: string, category: ReviewFinding['category'], message: string, caseIds: string[]) => findings.push({ code, category, message, caseIds })
  if (!cases.length) add('empty_selection', 'executability', 'No cases selected for execution', [])
  for (const item of cases) {
    for (const field of ['title', 'steps', 'expected', 'preconditions', 'testData', 'cleanup'] as const) {
      if (!present(item[field])) add(`missing_${field}`, 'executability', `Missing executable case field: ${field}`, [item.id])
    }
    if (!Array.isArray(item.assertions) || !item.assertions.some(present)) add('missing_assertions', 'executability', 'No observable assertions; the result is non-determinable', [item.id])
    if (item.status === 'invalid') add('invalid_case', 'executability', 'Invalid case definition', [item.id])
    const classification = item.classification
    if (!classification || !['functional', 'performance', 'security', 'compatibility', 'reliability'].includes(classification.testType) || !['P0', 'P1', 'P2', 'P3'].includes(classification.priority) || !['always', 'on_demand'].includes(classification.executionPolicy) || !Array.isArray(classification.tags) || !classification.tags.every(present) || !present(classification.riskReason)) {
      add('invalid_classification', 'quality', 'Missing or invalid case classification', [item.id])
    }
  }
  return executionResult(assessment, findings, cases.map(item => item.id), false)
}

function executionResult(assessment: AcceptanceAssessment, findings: ReviewFinding[], scope: string[], reviewed: boolean): AcceptanceAssessment {
  const caseReviews = new Map((assessment.caseReviews ?? []).map(review => [review.caseId, review.status]))
  for (const caseId of scope) {
    const relevant = findings.filter(finding => !finding.caseIds.length || finding.caseIds.includes(caseId))
    const status: CaseReviewStatus = relevant.some(isBlockingFinding) ? 'rejected' : reviewed ? relevant.length ? 'warning' : 'qualified' : 'unreviewed'
    caseReviews.set(caseId, status)
  }
  const issues = [...new Set([...assessment.issues, ...findings.map(finding => finding.message)])]
  return { ...assessment, checkedAt: new Date().toISOString(), status: issues.length || findings.length ? 'rejected' : assessment.status, issues, findings, readiness: findings.some(isBlockingFinding) ? 'blocked' : 'ready', caseReviews: [...caseReviews].map(([caseId, status]) => ({ caseId, status })) }
}

export function applyExecutionReview(assessment: AcceptanceAssessment, content: string, allowedIds: string[]): AcceptanceAssessment {
  if (!Array.isArray(allowedIds) || !allowedIds.length || allowedIds.length > 1000 || !allowedIds.every(reviewId) || new Set(allowedIds).size !== allowedIds.length) throw new Error('Invalid execution review scope')
  const parsed = json(content)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).some(key => key !== 'findings') || !('findings' in parsed) || !Array.isArray(parsed.findings) || parsed.findings.length > 1000) throw new Error('Invalid execution review')
  const findings: ReviewFinding[] = parsed.findings.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['code', 'category', 'message', 'caseIds'].includes(key)) || !('code' in item) || !reviewId(item.code) || !('category' in item) || !reviewFindingCategories.includes(item.category as ReviewFinding['category']) || !('message' in item) || !nonempty(item.message) || !('caseIds' in item) || !Array.isArray(item.caseIds) || item.caseIds.length > 1000 || !item.caseIds.every(id => reviewId(id) && allowedIds.includes(id)) || new Set(item.caseIds).size !== item.caseIds.length) throw new Error('Invalid execution review finding')
    return { code: item.code, category: item.category as ReviewFinding['category'], message: item.message, caseIds: [...item.caseIds] }
  })
  return executionResult(assessment, [...(assessment.findings ?? []), ...findings], allowedIds, true)
}

export function applyQualityReview(assessment: AcceptanceAssessment, content: string, allowedCaseIds?: string[]): AcceptanceAssessment {
  if (allowedCaseIds && (!Array.isArray(allowedCaseIds) || allowedCaseIds.length > 1000 || !allowedCaseIds.every(reviewId) || new Set(allowedCaseIds).size !== allowedCaseIds.length)) throw new Error('Invalid quality review scope')
  const parsed = json(content)
  if (!parsed || typeof parsed !== 'object' || !('qualified' in parsed) || typeof parsed.qualified !== 'boolean' || !('issues' in parsed) || !Array.isArray(parsed.issues) || !parsed.issues.every(nonempty) || (!parsed.qualified && !parsed.issues.length) || (parsed.qualified && parsed.issues.length)) throw new Error('用例质量评审结果不合法')
  const details = 'caseIssues' in parsed ? parsed.caseIssues : []
  if (!Array.isArray(details) || details.some((item) => !item || !reviewId(item.caseId) || !nonempty(item.message) || (allowedCaseIds && !allowedCaseIds.includes(item.caseId)))) throw new Error('质量评审的用例问题映射不合法')
  const issues = [...assessment.issues, ...parsed.issues, ...details.map(item => item.message)]
  const caseReviews = new Map((assessment.caseReviews ?? []).map(review => [review.caseId, review.status]))
  const structuralIds = new Set((assessment.caseIssues ?? []).map(item => item.caseId))
  const rejectedIds = new Set(details.map(item => item.caseId))
  const rejected = !parsed.qualified || !!details.length
  for (const caseId of allowedCaseIds ?? (rejected ? [...new Set([...caseReviews.keys(), ...rejectedIds])] : [])) {
    const previous = caseReviews.get(caseId)
    if (structuralIds.has(caseId) || rejectedIds.has(caseId)) caseReviews.set(caseId, 'rejected')
    else if (!allowedCaseIds && previous && ['qualified', 'warning', 'rejected'].includes(previous)) continue
    else caseReviews.set(caseId, rejected ? 'unknown' : 'qualified')
  }
  const findings: ReviewFinding[] = [
    ...(assessment.findings ?? []),
    ...parsed.issues.map(message => ({ code: 'quality_review', category: 'quality' as const, message, caseIds: [] })),
    ...details.map(item => ({ code: 'quality_review', category: 'quality' as const, message: item.message, caseIds: [item.caseId] })),
  ]
  return { ...assessment, checkedAt: new Date().toISOString(), status: issues.length || rejected ? 'rejected' : 'qualified', issues, findings, caseIssues: [...(assessment.caseIssues || []), ...details], caseReviews: [...caseReviews].map(([caseId, status]) => ({ caseId, status })) }
}

export function qualityRepairIds(assessment: AcceptanceAssessment | undefined, cases: SelfTestCase[]): string[] {
  const mentioned = new Set((assessment?.caseIssues || []).map((item) => item.caseId))
  for (const issue of assessment?.issues || []) {
    for (const match of issue.matchAll(/\bTC-\d+\b/g)) mentioned.add(match[0])
  }
  return cases.filter((item) => item.status !== 'passed' && mentioned.has(item.id)).map((item) => item.id)
}