import * as React from 'react'
import { ArrowRight, ChevronLeft, ChevronRight, ClipboardList, ListChecks, Search, X } from 'lucide-react'
import type { PlanningOperation, PlanningProject } from '../../../../shared/testing'
import { planningCaseGroups } from './PlanningCases'
import { PlanningCaseActions, type PlanningCaseEdit, type PlanningCaseOptimize } from './PlanningCaseEditor'
import { DesignReviewSummary } from '../review/DesignReviewSummary'
import { FilterSelect } from '../../../components/FilterSelect'

function ReviewCaseDetails({ status, ...props }: React.ComponentProps<typeof PlanningCaseActions> & { status: string }) {
  const [open, setOpen] = React.useState(false)
  const item = props.definition
  const label = { qualified: '审查通过', rejected: '审查不通过', warning: '质量提示', unreviewed: '待审查' }[status] || '审查未完成'
  return <details className="planning-review-details" onToggle={event => setOpen(event.currentTarget.open)}><summary><strong>{item.id} · {item.title}</strong><span className="planning-case-review" data-review={status}>{label}</span></summary>{open && <PlanningCaseActions {...props} />}<div className="planning-case-content"><dl>{Object.entries({ 来源: item.source, 需求映射: item.requirementIds?.map(id => { const requirement = props.project.draft?.baseline.find(entry => entry.id === id); return requirement ? `${id} · ${requirement.feature || requirement.criterion}` : `${id} · 未找到需求基线` }).join('\n'), 场景: item.scenario, 前置条件: item.preconditions, 测试数据: item.testData, 步骤: item.steps, 预期: item.expected, 清理: item.cleanup }).map(([label, value]) => <React.Fragment key={label}><dt>{label}</dt><dd>{value || '未提供'}</dd></React.Fragment>)}</dl><ol>{item.assertions?.map((assertion, index) => <li key={index}>{assertion}</li>)}</ol></div></details>
}

export function PlanningReviewWorkspace({ project, selection, reason, disabled, exactReview, reviews, locate, onLocate, onReason, onRemove, onClear, onReview, onEdit, onOptimize, onProceed }: {
  project: PlanningProject
  selection: string[]
  reason: string
  disabled: boolean
  exactReview: boolean
  reviews: Map<string, string>
  locate?: { caseId: string; request: number }
  onLocate: (id: string) => void
  onReason: (reason: string) => void
  onRemove: (id: string) => void
  onClear: () => void
  onReview: (operation: PlanningOperation) => void
  onEdit?: PlanningCaseEdit
  onOptimize?: PlanningCaseOptimize
  onProceed?: (scope: { caseIds: string[]; reason: string }) => Promise<void>
}) {
  const [query, setQuery] = React.useState('')
  const [page, setPage] = React.useState(1)
  const [pageSize, setPageSize] = React.useState(10)
  const [appliedLocate, setAppliedLocate] = React.useState(locate)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState('')
  const submitting = React.useRef(false)
  const cases = (project.draft?.cases || []).filter(item => selection.includes(item.id))
  const search = query.trim().toLocaleLowerCase()
  const filtered = cases.filter(item => !search || [item.id, item.title, item.source, item.steps, item.expected, item.preconditions, item.testData, item.cleanup, item.requirementIds?.map(id => { const requirement = project.draft?.baseline.find(entry => entry.id === id); return `${id} ${requirement?.feature || ''} ${requirement?.criterion || ''}` }).join(' ')].filter(Boolean).join(' ').toLocaleLowerCase().includes(search))
  const groups = planningCaseGroups(project, filtered)
  const ordered = [...groups.values()].flat()
  const pages = Math.max(1, Math.ceil(ordered.length / pageSize))
  const currentPage = Math.min(page, pages)
  const visible = new Set(ordered.slice((currentPage - 1) * pageSize, currentPage * pageSize).map(item => item.id))
  const saved = project.draft?.customReview
  const assessment = saved?.assessment
  const passed = exactReview && !!selection.length && assessment?.status === 'qualified' && !assessment.issues.length && !assessment.caseIssues?.length && !assessment.findings?.length && selection.every(id => assessment.caseReviews?.some(review => review.caseId === id && review.status === 'qualified'))
  if (locate !== appliedLocate) {
    setAppliedLocate(locate)
    setQuery('')
    const index = [...planningCaseGroups(project, cases).values()].flat().findIndex(item => item.id === locate?.caseId)
    if (index >= 0) setPage(Math.floor(index / pageSize) + 1)
  }
  React.useEffect(() => {
    if (!locate || query) return
    const target = document.getElementById(`planning-review-case-${locate.caseId}`)
    const details = target?.querySelector('details')
    if (!details) return
    const group = target?.closest<HTMLDetailsElement>('.planning-feature-group')
    if (group) group.open = true
    details.open = true
    target?.scrollIntoView({ block: 'center' })
    details.querySelector('summary')?.focus({ preventScroll: true })
  }, [locate, currentPage, query])
  async function proceed() {
    if (!passed || disabled || !onProceed || submitting.current) return
    const scope = { caseIds: cases.map(item => item.id), reason: reason.trim() }
    submitting.current = true; setPending(true); setError('')
    try { await onProceed(scope) } catch (caught) { setError(caught instanceof Error ? caught.message : '提交失败，请重试') }
    finally { submitting.current = false; setPending(false) }
  }
  return <section aria-label="审查工作区" className="planning-review-workspace" aria-busy={pending}>
    <header className="planning-review-heading"><h3><ListChecks size={18} />审查工作区</h3><span>已选 {selection.length} 条</span><button type="button" title="清空审查工作区" aria-label="清空审查工作区" disabled={disabled || pending || !selection.length} onClick={onClear}><X size={16} /></button></header>
    <div className="planning-scope-review"><label>审查范围理由<textarea rows={2} maxLength={2000} disabled={disabled || pending} value={reason} onChange={event => onReason(event.target.value)} /></label><button disabled={disabled || pending || !selection.length || !reason.trim()} onClick={() => onReview({ mode: 'review', version: project.version, caseIds: cases.map(item => item.id), reason: reason.trim() })}><ListChecks size={16} />审查所选用例</button><span>仅审查所选 {selection.length} 条 · 全量发布门禁不变</span>{passed && onProceed && <button disabled={disabled || pending} onClick={() => void proceed()}><ArrowRight size={16} />进入执行</button>}</div>
    {error && <p role="alert">{error}</p>}
    {saved && (exactReview ? <section aria-label="所选范围审查结果" className="planning-scope-result"><h4>已保存的范围审查 · {saved.caseIds.length} 条</h4><p>{saved.reason}</p><p>{saved.caseIds.join('、')}</p><button disabled={disabled || pending} onClick={() => onReview({ mode: 'review', version: project.version, caseIds: cases.map(item => item.id), reason: reason.trim() })}><ListChecks size={16} />继续此范围审查</button><DesignReviewSummary planning custom assessment={assessment} progressState={project.status === 'running' ? 'checking' : undefined} onLocate={onLocate} /></section> : <details className="planning-scope-result" aria-label="历史范围审查结果"><summary>历史范围审查 · 与当前选择、理由或用例版本不匹配</summary><p>{saved.reason}</p><p>{saved.caseIds.join('、')}</p><DesignReviewSummary planning custom historical assessment={assessment} progressState="unknown" onLocate={onLocate} /></details>)}
    <label className="planning-case-search"><span><Search size={14} />搜索审查用例</span><input type="search" value={query} placeholder="用例编号、标题或步骤" onChange={event => { setQuery(event.target.value); setPage(1) }} /></label>
    <div className="planning-review-list">{[...groups].map(([name, members]) => {
      const pageMembers = members.filter(item => visible.has(item.id))
      return pageMembers.length > 0 && <details className="planning-feature-group" key={name} open><summary><ClipboardList size={15} /><strong>{name}</strong><span>{members.length} 条匹配</span></summary>{pageMembers.map(item => <div className="planning-review-case" id={`planning-review-case-${item.id}`} key={item.id}>
        <ReviewCaseDetails status={exactReview ? reviews.get(item.id) || 'unknown' : 'unreviewed'} project={project} definition={item} disabled={disabled || pending} onEdit={onEdit} onOptimize={onOptimize} onReview={onReview} />
        <button type="button" title={`移出审查 ${item.id}`} aria-label={`移出审查 ${item.id}`} disabled={disabled || pending} onClick={() => onRemove(item.id)}><X size={16} /></button>
      </div>)}</details>
    })}</div>
    {!ordered.length && <p role="status">{selection.length ? '没有匹配的审查用例' : '尚未选择审查用例'}</p>}
    <div className="planning-case-pagination"><span>审查范围共 {filtered.length} 条 · 第 {currentPage} / {pages} 页</span><FilterSelect label="每页审查用例" value={String(pageSize)} options={[{ value: '10', label: '10 条 / 页' }, { value: '20', label: '20 条 / 页' }]} onChange={value => { setPageSize(Number(value)); setPage(1) }} /><button title="上一页审查用例" aria-label="上一页审查用例" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={16} /></button><button title="下一页审查用例" aria-label="下一页审查用例" disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}><ChevronRight size={16} /></button></div>
  </section>
}