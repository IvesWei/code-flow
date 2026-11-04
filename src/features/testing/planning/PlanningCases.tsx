import * as React from 'react'
import { ChevronLeft, ChevronRight, ClipboardList, Search, X } from 'lucide-react'
import type { CaseDefinition, PlanningOperation, PlanningProject } from '../../../../shared/testing'
import { FilterSelect } from '../../../components/FilterSelect'
import { DesignReviewSummary } from '../review/DesignReviewSummary'
import { PlanningCaseActions, type PlanningCaseEdit, type PlanningCaseOptimize } from './PlanningCaseEditor'
import { PlanningReviewWorkspace } from './PlanningReviewWorkspace'

export function planningGenerationIdentity(project: PlanningProject) {
  let identity = ''
  project.events.forEach((event, index) => {
    if (!event.text.startsWith('planning:generation:')) return
    const next = project.events[index + 1]?.text || ''
    if (!/^(Reviewing saved|Planning (optimize|regenerate):|Continuing saved|Manually edited )/.test(next)) identity = event.text
  })
  return identity
}

export function restorePlanningSelection(project: PlanningProject) {
  const generation = planningGenerationIdentity(project)
  try {
    const raw = typeof window === 'undefined' ? null : window.sessionStorage.getItem(`planning-review:${project.ownerId}:${project.id}`)
    if (raw !== null) {
      const saved = JSON.parse(raw)
      if (saved.generation !== generation) return { selected: [] as string[], reason: '', generation }
      if (Array.isArray(saved.selected) && saved.selected.every((id: unknown) => typeof id === 'string') && typeof saved.reason === 'string') return { selected: [...new Set<string>(saved.selected)], reason: saved.reason, generation }
    }
  } catch {}
  return { selected: project.draft?.customReview?.caseIds || [], reason: project.draft?.customReview?.reason || '', generation }
}

const reviewLabels: Record<string, string> = { qualified: '审查通过', rejected: '审查不通过', unreviewed: '待审查', unknown: '审查未完成', warning: '质量提示' }
const typeLabels: Record<string, string> = { functional: '功能', boundary: '边界', negative: '异常', permission: '权限', state: '状态', security: '安全', performance: '性能', compatibility: '兼容性', usability: '易用性', accessibility: '无障碍', reliability: '可靠性', integration: '集成' }

export function planningCaseGroups(project: PlanningProject, cases: CaseDefinition[]) {
  const groups = new Map<string, CaseDefinition[]>()
  for (const item of cases) {
    const requirement = project.draft?.baseline.find(entry => entry.id === item.requirementIds?.[0])
    const name = requirement ? requirement.feature || `${requirement.id} · ${requirement.criterion}` : '未映射需求'
    groups.set(name, [...groups.get(name) || [], item])
  }
  return groups
}

type PlanningCasesProps = {
  project: PlanningProject
  busy: boolean
  onReview: (operation: PlanningOperation) => void
  onEdit?: PlanningCaseEdit
  onOptimize?: PlanningCaseOptimize
  onProceed?: (scope: { caseIds: string[]; reason: string }) => Promise<void>
}

export function PlanningCases(props: PlanningCasesProps) {
  return <PlanningCasesContent key={`${props.project.ownerId}:${props.project.id}`} {...props} />
}

function PlanningCasesContent({ project, busy, onReview, onEdit, onOptimize, onProceed }: PlanningCasesProps) {
  const [query, setQuery] = React.useState('')
  const [category, setCategory] = React.useState('all')
  const [status, setStatus] = React.useState('all')
  const [page, setPage] = React.useState(1)
  const [pageSize, setPageSize] = React.useState(10)
  const [scope, setScope] = React.useState(() => restorePlanningSelection(project))
  const generation = planningGenerationIdentity(project)
  if (scope.generation !== generation) setScope({ selected: [], reason: '', generation })
  const { selected, reason } = scope.generation === generation ? scope : { selected: [], reason: '' }
  const setSelected = (value: string[] | ((previous: string[]) => string[])) => setScope(previous => ({ ...previous, selected: typeof value === 'function' ? value(previous.selected) : value }))
  const setReason = (value: string) => setScope(previous => ({ ...previous, reason: value }))
  const [locating, setLocating] = React.useState('')
  const [reviewLocate, setReviewLocate] = React.useState<{ caseId: string; request: number }>()
  const cases = project.draft?.cases || []
  const assessment = project.draft?.assessment
  const savedReview = project.draft?.customReview
  const currentReview = savedReview && savedReview.definitionFingerprint === project.draft?.definitionFingerprint
  const selection = selected.filter(id => cases.some(item => item.id === id))
  const exactReview = !!currentReview && !!project.draft?.definitionFingerprint && savedReview.reason.trim() === reason.trim() && savedReview.caseIds.length === selection.length && new Set(savedReview.caseIds).size === selection.length && savedReview.caseIds.every(id => selection.includes(id))
  const disabled = busy || project.status === 'running' || !!project.question
  if (scope.generation === generation && project.draft && (cases.length || project.status !== 'running') && selected.some(id => !cases.some(item => item.id === id))) setScope(previous => ({ ...previous, selected: previous.selected.filter(id => cases.some(item => item.id === id)) }))
  React.useEffect(() => {
    try { window.sessionStorage.setItem(`planning-review:${project.ownerId}:${project.id}`, JSON.stringify(scope)) } catch {}
  }, [scope, project.ownerId, project.id])
  const reviews = new Map(assessment?.caseReviews?.map(item => [item.caseId, item.status]) || [])
  const scopeIds = new Set(currentReview ? savedReview.caseIds : [])
  for (const caseId of scopeIds) reviews.set(caseId, 'unknown')
  if (currentReview) for (const review of savedReview.assessment?.caseReviews || []) {
    if (scopeIds.has(review.caseId)) reviews.set(review.caseId, review.status)
  }
  const search = query.trim().toLocaleLowerCase()
  const filtered = cases.filter(item => (category === 'all' || (item.classification?.testType || 'legacy') === category)
    && (status === 'all' || (reviews.get(item.id) || 'unknown') === status)
    && (!search || [item.id, item.title, item.source, item.steps, item.expected, item.requirementIds?.map(id => { const requirement = project.draft?.baseline.find(entry => entry.id === id); return `${id} ${requirement?.feature || ''} ${requirement?.criterion || ''}` }).join(' '), item.preconditions, item.testData, item.cleanup].filter(Boolean).join(' ').toLocaleLowerCase().includes(search)))
  const groups = planningCaseGroups(project, filtered)
  const ordered = [...groups.values()].flat()
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const currentPage = Math.min(page, pages)
  const visible = ordered.slice((currentPage - 1) * pageSize, currentPage * pageSize)
  const visibleIds = new Set(visible.map(item => item.id))
  React.useEffect(() => {
    if (!locating) return
    const target = document.getElementById(`planning-case-${locating}`)
    const details = target?.querySelector('details')
    if (details) { const group = target?.closest<HTMLDetailsElement>('.planning-feature-group'); if (group) group.open = true; details.open = true; target?.scrollIntoView({ block: 'center' }); details.querySelector('summary')?.focus({ preventScroll: true }); setLocating('') }
  }, [locating, currentPage, cases])
  const locate = (caseId: string) => {
    const index = [...planningCaseGroups(project, cases).values()].flat().findIndex(item => item.id === caseId)
    if (index < 0) return
    setQuery(''); setCategory('all'); setStatus('all'); setPage(Math.floor(index / pageSize) + 1); setLocating(caseId)
  }
  const toggle = (ids: string[], checked: boolean) => setSelected(previous => checked ? [...new Set([...previous, ...ids])] : previous.filter(id => !ids.includes(id)))
  const filteredSelected = filtered.length > 0 && filtered.every(item => selection.includes(item.id))
  const types = [...new Set(cases.map(item => item.classification?.testType || 'legacy'))]
  return <section aria-label="用例设计列表" className="planning-case-browser">
    <DesignReviewSummary planning custom={false} assessment={assessment} progressState={project.status === 'running' ? 'checking' : undefined} onLocate={locate} />
    <h3>生成用例库 · {cases.length} 条</h3>
    <div className="planning-case-filters">
      <label className="planning-case-search"><span><Search size={14} />搜索用例</span><input type="search" value={query} placeholder="用例编号、标题、需求或步骤" onChange={event => { setQuery(event.target.value); setPage(1) }} /></label>
      <FilterSelect label="用例类型" value={category} options={[{ value: 'all', label: '全部类型' }, ...types.map(value => ({ value, label: value === 'legacy' ? '未分类（旧用例）' : typeLabels[value] || value }))]} onChange={value => { setCategory(value); setPage(1) }} />
      <FilterSelect label="审查状态" value={status} options={[{ value: 'all', label: '全部审查状态' }, ...Object.entries(reviewLabels).map(([value, label]) => ({ value, label }))]} onChange={value => { setStatus(value); setPage(1) }} />
    </div>
    <div className="planning-case-selection">
      <label className="testing-check"><input type="checkbox" disabled={disabled || !filtered.length} checked={filteredSelected} onChange={event => toggle(filtered.map(item => item.id), event.target.checked)} />选择全部筛选结果（{filtered.length} 条）</label>
      <label className="testing-check"><input type="checkbox" disabled={disabled || !visible.length} checked={visible.length > 0 && visible.every(item => selection.includes(item.id))} onChange={event => toggle(visible.map(item => item.id), event.target.checked)} />选择本页</label>
      <span>已选 {selection.length} 条</span><button type="button" title="清空选择" aria-label="清空用例选择" disabled={disabled || !selection.length} onClick={() => setSelected([])}><X size={15} /></button>
    </div>
    <div className="planning-case-list">{[...groups].map(([name, members]) => {
      const pageMembers = members.filter(item => visibleIds.has(item.id))
      if (!pageMembers.length) return null
      const allSelected = members.every(item => selection.includes(item.id))
      return <details className="planning-feature-group" key={name} open>
        <summary><ClipboardList size={15} /><strong>{name}</strong><span>{members.length} 条匹配</span></summary>
        <div className="planning-group-tools"><label className="testing-check"><input type="checkbox" aria-label={`选择功能组 ${name}`} disabled={disabled} checked={allSelected} ref={node => { if (node) node.indeterminate = !allSelected && members.some(item => selection.includes(item.id)) }} onChange={event => toggle(members.map(item => item.id), event.target.checked)} />选择当前过滤成员 · {members.length} 条</label></div>
        {pageMembers.map(item => <div key={item.id} id={`planning-case-${item.id}`} className="planning-selectable-case">
          <input type="checkbox" disabled={disabled} aria-label={`选择 ${item.id}`} checked={selection.includes(item.id)} onChange={event => toggle([item.id], event.target.checked)} />
          <details className="planning-case-details"><summary><strong>{item.id} · {item.title}</strong><span className="planning-case-meta">{item.classification ? `${typeLabels[item.classification.testType] || item.classification.testType} · ${item.classification.priority}` : '未分类（旧用例）'}</span><span className="planning-case-review" title={scopeIds.has(item.id) ? '已保存的自定义范围审查结果' : '全量设计审查结果'} data-review={reviews.get(item.id) || 'unknown'}>{scopeIds.has(item.id) ? '范围 · ' : ''}{reviewLabels[reviews.get(item.id) || 'unknown'] || '审查未完成'}</span></summary>
            <PlanningCaseActions project={project} definition={item} disabled={disabled} onEdit={onEdit} onOptimize={onOptimize} onReview={onReview} />
            <div className="planning-case-content"><dl>{Object.entries({ 来源: item.source, 需求映射: item.requirementIds?.map(id => { const requirement = project.draft?.baseline.find(entry => entry.id === id); return requirement ? `${id} · ${requirement.feature || requirement.criterion}` : `${id} · 未找到需求基线` }).join('\n'), 场景: item.scenario, 前置条件: item.preconditions, 测试数据: item.testData, 步骤: item.steps, 预期: item.expected, 清理: item.cleanup }).map(([label, value]) => <React.Fragment key={label}><dt>{label}</dt><dd>{value || '未提供'}</dd></React.Fragment>)}</dl><ol>{item.assertions?.map((assertion, index) => <li key={index}>{assertion}</li>)}</ol></div>
          </details>
        </div>)}
      </details>
    })}</div>
    {!visible.length && <p role="status">{cases.length ? '没有匹配的用例' : '尚无已保存用例'}</p>}
    <div className="planning-case-pagination"><span>共 {filtered.length} 条 · 第 {currentPage} / {pages} 页</span><FilterSelect label="每页用例" value={String(pageSize)} options={[{ value: '10', label: '10 条 / 页' }, { value: '20', label: '20 条 / 页' }]} onChange={value => { setPageSize(Number(value)); setPage(1) }} /><button aria-label="上一页用例" title="上一页" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={16} /></button><button aria-label="下一页用例" title="下一页" disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}><ChevronRight size={16} /></button></div>
    <PlanningReviewWorkspace project={project} selection={selection} reason={reason} disabled={disabled} exactReview={exactReview} reviews={reviews} locate={reviewLocate} onLocate={caseId => { if (selection.includes(caseId)) setReviewLocate(previous => ({ caseId, request: (previous?.request || 0) + 1 })); else locate(caseId) }} onReason={setReason} onRemove={id => setSelected(previous => previous.filter(value => value !== id))} onClear={() => setSelected([])} onReview={onReview} onEdit={onEdit} onOptimize={onOptimize} onProceed={onProceed} />
  </section>
}