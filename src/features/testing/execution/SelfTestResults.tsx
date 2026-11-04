import { ArrowLeft, ArrowRight, CircleAlert, ClipboardList, LoaderCircle, Play, Search, Wrench } from 'lucide-react'
import * as React from 'react'
import type { CodingTask, SelfTestCase } from '../../../../shared/task'
import { reviewCaseState } from '../../../../shared/case-review'
import { casePolicy } from '../../../../shared/test-policy'
import { TestExecutionResults } from './TestExecutionResults'
import { FilterSelect } from '../../../components/FilterSelect'
import { DesignReviewSummary } from '../review/DesignReviewSummary'
import { currentScopeAssessment, defaultReviewProgress, designReviewState, reviewProblems } from '../review/self-test-review'

const typeLabels = { functional: '功能', performance: '性能效率', security: '安全', compatibility: '兼容性', reliability: '可靠性' }
const reviewLabels = { unreviewed: '待审查', reviewing: '审查中', qualified: '审查通过', warning: '存在质量提示', rejected: '审查不通过', unknown: '审查未完成' }
export type SelfTestStartOptions = { intent: 'execute' | 'repair'; acceptanceSelection?: null | { mode: 'custom'; caseIds: string[]; reason: string } }
type Props = { task: CodingTask; onAccept: () => void; accepting: boolean; onStart: (ids?: string[], options?: SelfTestStartOptions) => void; starting: boolean; previewUrl: string; onPreviewUrlChange: (value: string) => void; onBindingSaved?: () => void | Promise<void> }

export function selfTestStageLabel(task: Pick<CodingTask, 'selfTestPlanningStatus' | 'acceptanceSelection' | 'modelTurn'>): string {
  const turnLabel = task.modelTurn?.label || ''
  if (task.acceptanceSelection && /核对|审查|评估|检查/.test(turnLabel)) return '正在核对自定义范围'
  if (task.selfTestPlanningStatus === 'generating') return '正在生成用例'
  if (task.selfTestPlanningStatus === 'reviewing') return task.acceptanceSelection ? '正在核对自定义范围' : '正在审查用例'
  if (/生成/.test(turnLabel)) return '正在生成用例'
  if (/审查|评估|核对|检查/.test(turnLabel)) return task.acceptanceSelection ? '正在核对自定义范围' : '正在审查用例'
  return '正在规划用例'
}

export function SelfTestResults(props: Props) {
  return <Results key={props.task.id} {...props} />
}

function Results({ task, onAccept, accepting, onStart, starting, previewUrl, onPreviewUrlChange, onBindingSaved }: Props) {
  const [mode, setMode] = React.useState<'default' | 'custom'>(task.acceptanceSelection ? 'custom' : 'default')
  const [customIds, setCustomIds] = React.useState<string[]>(task.acceptanceSelection?.caseIds || [])
  const [supplementIds, setSupplementIds] = React.useState<string[]>([])
  const [reason, setReason] = React.useState(task.acceptanceSelection?.reason || '')
  const [confirmation, setConfirmation] = React.useState('')
  const [query, setQuery] = React.useState('')
  const [category, setCategory] = React.useState('all')
  const [status, setStatus] = React.useState('all')
  const [page, setPage] = React.useState(1)
  const [pageSize, setPageSize] = React.useState(10)
  const [blockingOnly, setBlockingOnly] = React.useState(false)
  const [locateId, setLocateId] = React.useState<string | null>(null)
  const [locationError, setLocationError] = React.useState('')
  const sectionRef = React.useRef<HTMLElement>(null)
  React.useEffect(() => {
    if (!locateId) return
    const details = [...(sectionRef.current?.querySelectorAll<HTMLDetailsElement>('[data-case-id]') || [])].find(node => node.dataset.caseId === locateId)
    if (!details) return
    details.open = true
    const group = details.closest('.test-feature-group') as HTMLDetailsElement | null
    if (group) group.open = true
    const summary = details.querySelector('summary')
    summary?.focus({ preventScroll: true })
    summary?.scrollIntoView({ block: 'center' })
    setLocateId(null)
  }, [locateId, page, query, category, status, blockingOnly])
  if (!task.selfTests && !task.selfTestError && !['SELF_TEST', 'TEST_EXECUTION', 'REVIEW', 'ACCEPTED'].includes(task.status) && !(task.status === 'SUCCESS' && task.workspace)) return null
  const tests = task.selfTests || []
  const baseline = task.acceptanceBaseline || []
  const runnable = ['REVIEW', 'SUCCESS', 'ACCEPTED'].includes(task.status)
  const selectedIds = customIds.filter((id) => tests.some((item) => item.id === id && item.status !== 'invalid'))
  const currentAssessment = mode === 'custom' ? currentScopeAssessment(task, selectedIds, reason) : task.acceptanceAssessment
  const referenceAssessment = currentAssessment || (mode === 'custom' ? task.executionAssessment || task.acceptanceAssessment : undefined)
  const historicalReview = mode === 'custom' && !currentAssessment && !!referenceAssessment
  const progressState = defaultReviewProgress(task, true)
  const defaultState = designReviewState(task.acceptanceAssessment, false, progressState)
  const problems = reviewProblems(referenceAssessment, mode === 'custom' && referenceAssessment === task.executionAssessment)
  const globalBlock = problems.some(problem => problem.blocking && !problem.caseIds.length)
  const blockingIds = new Set(problems.filter(problem => problem.blocking).flatMap(problem => problem.caseIds.length ? problem.caseIds : referenceAssessment === task.executionAssessment ? task.executionAssessment!.caseIds : tests.map(item => item.id)))
  const reviewState = (id: string) => mode === 'custom' && !selectedIds.includes(id) ? 'out_of_scope' : reviewCaseState(currentAssessment, id)
  const currentReviewLabels = { ...reviewLabels, out_of_scope: '未纳入本次范围' }
  for (const review of referenceAssessment?.caseReviews || []) if (review.status === 'rejected') blockingIds.add(review.caseId)
  const reviewFilterLabels = mode === 'custom' ? currentReviewLabels : reviewLabels
  const scopeKey = JSON.stringify([selectedIds, reason.trim()])
  const confirmed = confirmation === scopeKey
  const setConfirmed = (value: boolean) => setConfirmation(value ? scopeKey : '')
  const selectable = (item: SelfTestCase) => mode === 'custom' ? item.status !== 'invalid' : casePolicy(baseline, item).gatePolicy === 'advisory' && item.classification?.executionPolicy === 'on_demand' && ['pending', 'manual'].includes(item.status) && !task.automationRuns?.some((run) => run.caseId === item.id)
  const supplements = supplementIds.filter((id) => tests.some((item) => item.id === id && selectable(item)))
  const checkedIds = mode === 'custom' ? selectedIds : supplements
  const canExecute = runnable && !starting && (mode === 'default' ? defaultState === 'ready' && tests.length > 0 : selectedIds.length > 0 && !!reason.trim() && reason.length <= 2000 && confirmed)
  const execute = (ids: string[] = []) => {
    onStart(ids, { intent: 'execute', acceptanceSelection: mode === 'custom' ? { mode: 'custom', caseIds: selectedIds, reason: reason.trim() } : null })
    if (mode === 'default') setSupplementIds([])
  }
  const repair = () => onStart([], { intent: 'repair' })
  const mappings = (item: SelfTestCase) => (item.requirementIds || []).map((id) => {
    const requirement = baseline.find((entry) => entry.id === id)
    return requirement ? `${id} · ${requirement.feature || requirement.source || requirement.criterion} · ${requirement.criterion}` : `${id} · 未找到需求基线`
  })
  const feature = (item: SelfTestCase) => {
    const requirement = baseline.find((entry) => entry.id === item.requirementIds?.[0])
    return requirement ? requirement.feature || `${requirement.id} · ${requirement.criterion}` : '未映射需求'
  }
  const filtered = tests.filter((item) => (!blockingOnly || blockingIds.has(item.id)) && (category === 'all' || (item.classification?.testType || 'unclassified') === category) && (status === 'all' || (historicalReview && status !== 'out_of_scope' ? reviewCaseState(referenceAssessment, item.id) : reviewState(item.id)) === status) && [item.id, item.title, item.source, ...mappings(item), ...(item.classification?.tags || [])].join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const groups = new Map<string, SelfTestCase[]>()
  for (const item of filtered) { const name = feature(item); groups.set(name, [...(groups.get(name) || []), item]) }
  const ordered = [...groups.values()].flat()
  const pages = Math.max(1, Math.ceil(ordered.length / pageSize))
  const currentPage = Math.min(page, pages)
  const visibleIds = new Set(ordered.slice((currentPage - 1) * pageSize, currentPage * pageSize).map((item) => item.id))
  const locateCase = (id: string) => {
    if (!tests.some(item => item.id === id)) { setLocationError(`未找到用例 ${id}，保留审查原文。`); return }
    const allGroups = new Map<string, SelfTestCase[]>()
    for (const item of tests) { const name = feature(item); allGroups.set(name, [...(allGroups.get(name) || []), item]) }
    const index = [...allGroups.values()].flat().findIndex(item => item.id === id)
    setQuery(''); setCategory('all'); setStatus('all'); setBlockingOnly(false)
    setPage(Math.floor(index / pageSize) + 1); setLocateId(id); setLocationError('')
  }
  const toggle = (items: SelfTestCase[], checked: boolean) => {
    const ids = items.filter(selectable).map((item) => item.id)
    const next = checked ? [...new Set([...checkedIds, ...ids])] : checkedIds.filter((id) => !ids.includes(id))
    if (mode === 'custom') { setCustomIds(next); setConfirmed(false) } else setSupplementIds(next)
  }
  const launch = <>
    <div className="self-test-actions"><button type="button" className="accept-test-button" disabled={!canExecute} onClick={() => execute()}><Play size={15} />{task.selfTestError && task.selfTestPlanningStatus === 'reviewing' ? '继续审查所选用例' : '审查并执行所选用例'}</button>{mode === 'default' && <button type="button" className="accept-test-button" disabled={!canExecute || !supplements.length} onClick={() => execute(supplements)}><Play size={15} />执行选中补充项</button>}<span>{mode === 'default' ? `默认必验 ${tests.filter((item) => casePolicy(baseline, item).gatePolicy === 'blocking').length} 条 · 已选补充 ${supplements.length} 条` : `已选必验 ${selectedIds.length} 条 · ${confirmed ? '已确认' : '待确认'}`}</span></div>
    {runnable && <div className="self-test-notice test-preview"><label htmlFor="preview-url">本机预览地址</label><input id="preview-url" type="url" placeholder={task.automationUrl || 'http://127.0.0.1:4173'} value={previewUrl} onChange={(event) => onPreviewUrlChange(event.target.value)} /><button type="button" className="accept-test-button" disabled={!canExecute || !(previewUrl || task.automationUrl)} onClick={() => execute()}><Play size={15} />启动浏览器自动化</button></div>}
  </>
  return <><section ref={sectionRef} className="self-test-section" aria-label="生成用例">
    <div className="content-header"><div><h2>生成用例</h2><p>需求功能点与质量审查</p></div><span>{tests.length} 条用例</span></div>
    <DesignReviewSummary assessment={currentAssessment} custom={mode === 'custom'} progressState={progressState} onLocate={locateCase} />
    {historicalReview && <section aria-label="上次审查参考"><DesignReviewSummary assessment={referenceAssessment} custom={referenceAssessment === task.executionAssessment} historical onLocate={locateCase} /></section>}
    {locationError && <p className="self-test-notice" role="status">{locationError}</p>}
    <details className="self-test-baseline" open={mode === 'default' ? true : undefined}><summary>默认审查记录 · {defaultState === 'ready' ? '通过，可进入执行准备' : defaultState === 'blocked' ? '未通过，拒绝默认执行' : defaultState === 'checking' ? '正在核对，尚未完成验收' : '尚未完成验收'}</summary>
      <p className="self-test-notice">需求基线 {baseline.length} 项 · 已覆盖 {task.acceptanceAssessment?.coveredIds.length || 0} 项</p>
      {mode === 'custom' && <DesignReviewSummary assessment={task.acceptanceAssessment} custom={false} progressState={progressState} onLocate={locateCase} />}
    </details>
    {!!baseline.length && <details className="self-test-baseline"><summary>需求验收基线 · {baseline.length} 项</summary><div className="self-test-detail">{baseline.map((item) => <p key={item.id}><strong>{item.id} · {item.feature || item.source || item.criterion} · {item.required ? '必验' : '非必验'} · {item.scenarios.join(' / ')}</strong>{item.criterion}<br />来源：{item.source}</p>)}</div></details>}
    {task.selfTestError && <p className="self-test-notice self-test-warning" role="alert"><CircleAlert size={15} />自测未完成：{task.selfTestError}</p>}
    {task.status === 'SELF_TEST' && <p className="self-test-notice" role="status"><LoaderCircle className="spin" size={15} />{selfTestStageLabel(task)}…</p>}
    {runnable && <div className="self-test-actions"><button type="button" className="accept-test-button" disabled={starting} onClick={repair}><Wrench size={15} />{tests.length ? '修正用例设计' : '生成用例'}</button>{task.status === 'REVIEW' && <><button type="button" className="accept-test-button" disabled={accepting || starting} onClick={onAccept}><CircleAlert size={15} />接受当前风险</button><span>仅记录风险接受，不放行、不启动执行。</span></>}</div>}
    {task.status === 'ACCEPTED' && <p className="self-test-notice self-test-warning"><CircleAlert size={15} />已接受当前风险；不放行、不启动执行，未通过或未执行的用例仍保留。</p>}
    {!!tests.length && <>
      <div className="test-scope"><fieldset disabled={starting}><legend>本次必验集合</legend><div className="test-mode"><label><input type="radio" name={`scope-${task.id}`} checked={mode === 'default'} onChange={() => { setMode('default'); setConfirmed(false) }} />默认质量门禁</label><label><input type="radio" name={`scope-${task.id}`} checked={mode === 'custom'} onChange={() => { setMode('custom'); setConfirmed(false) }} />自定义必验</label></div></fieldset>
        {mode === 'custom' && <div className="test-custom-scope"><p className="self-test-warning">已选 {selectedIds.length} / {tests.length} 条；未选用例不计为通过，默认需求缺口仍保留。</p><label>范围调整与风险理由<textarea aria-label="范围调整与风险理由" value={reason} maxLength={2000} disabled={starting} onChange={(event) => { setReason(event.target.value); setConfirmed(false) }} /></label><label className="test-confirm"><input type="checkbox" checked={confirmed} disabled={starting || !selectedIds.length || !reason.trim()} onChange={(event) => setConfirmed(event.target.checked)} />确认本次范围并承担未选需求风险</label></div>}
        {mode === 'custom' && designReviewState(currentAssessment, true) === 'blocked' && <p className="self-test-warning">当前范围已知受阻：请先修正用例或调整范围与理由；仍可确认后重新提交审查。</p>}
      </div>
      <div className="test-blocking-filter"><label><input type="checkbox" checked={blockingOnly} onChange={event => { setBlockingOnly(event.target.checked); setPage(1) }} />仅看阻断</label><p>{historicalReview ? '按上次审查问题和状态筛选，已取消选中的阻断项仍保留；不是当前范围结论。' : globalBlock ? '含全局设计阻断：仅看阻断会纳入当前范围全部用例，不表示每条用例都有独立问题。' : '按当前设计审查的阻断问题与不通过用例筛选。'}</p></div>
      <div className="test-filters"><label className="test-search"><Search size={15} /><input type="search" aria-label="搜索用例或需求" placeholder="搜索用例或需求" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1) }} /></label><div className="test-filter-field"><span>类别</span><FilterSelect label="用例类别" value={category} options={[{ value: 'all', label: '全部类别' }, ...Object.entries(typeLabels).map(([value, label]) => ({ value, label })), { value: 'unclassified', label: '未分类（旧用例）' }]} onChange={(value) => { setCategory(value); setPage(1) }} /></div><div className="test-filter-field"><span>审查状态</span><FilterSelect label="用例状态" value={status} options={[{ value: 'all', label: '全部状态' }, ...Object.entries(reviewFilterLabels).map(([value, label]) => ({ value, label }))]} onChange={(value) => { setStatus(value); setPage(1) }} /></div><span className="test-filter-count">{filtered.length} 条匹配</span></div>
      <div className="test-groups">{[...groups].map(([name, members]) => {
        const visible = members.filter((item) => visibleIds.has(item.id))
        if (!visible.length) return null
        const eligible = members.filter(selectable)
        return <details className="test-feature-group" key={name} open><summary><ClipboardList size={15} /><strong>{name}</strong><span>{members.length} 条匹配</span></summary><div className="test-group-tools"><label><input type="checkbox" aria-label={`选择功能组 ${name}`} disabled={starting || !eligible.length} checked={eligible.length > 0 && eligible.every((item) => checkedIds.includes(item.id))} ref={(node) => { if (node) node.indeterminate = eligible.some((item) => checkedIds.includes(item.id)) && !eligible.every((item) => checkedIds.includes(item.id)) }} onChange={(event) => toggle(members, event.target.checked)} />选择当前过滤成员 · {eligible.length} 条</label></div>{visible.map((item) => {
          const policy = casePolicy(baseline, item)
          const review = reviewState(item.id)
          const state = review
          return <div className="test-case-row" key={item.id}>
            <input type="checkbox" aria-label={`${item.id} · ${item.title}`} checked={checkedIds.includes(item.id)} disabled={starting || !selectable(item)} onChange={(event) => toggle([item], event.target.checked)} />
            <details className="test-case-details" data-case-id={item.id}>
              <summary tabIndex={0}>
                <strong>{item.id} · {item.title}</strong>
                <span className="test-case-meta">{item.classification ? `${typeLabels[item.classification.testType]} · ${item.classification.priority}` : '未分类 · 优先级未记录'}</span>
                <span className={`case-status case-review-${state}`}>{currentReviewLabels[review]}</span>
              </summary>
              <div className="self-test-detail">
                <p><strong>分类 / 优先级</strong>{item.classification ? `${typeLabels[item.classification.testType]} · ${item.classification.priority} · ${item.classification.tags.join(' / ') || '无标签'}` : '旧用例未分类，沿用全部必验'}</p>
                <p><strong>默认执行 / 门禁策略</strong>{policy.gatePolicy === 'blocking' ? '必须执行 · 阻断验收' : item.classification?.executionPolicy === 'always' ? '常规执行 · 非阻断' : '按需执行 · 非阻断'}</p>
                <p><strong>本次设计审查</strong>{currentReviewLabels[review]}</p>
                {historicalReview && <p><strong>上次设计审查参考（非当前结论）</strong>{reviewLabels[reviewCaseState(referenceAssessment, item.id)]}</p>}
                {problems.filter(problem => !problem.caseIds.length || problem.caseIds.includes(item.id)).map(problem => <p key={problem.message}><strong>{problem.caseIds.length ? '关联审查问题' : '全局审查问题'}</strong>{problem.message}</p>)}
                <p><strong>风险依据</strong>{item.classification?.riskReason || '旧用例未记录分类依据'}</p>
                <p><strong>需求映射 / 场景</strong>{mappings(item).join('\n') || '未映射'} · {item.scenario || '未指定'}</p>
                <p><strong>需求来源</strong>{item.source}</p>
                <p><strong>前置条件 / 数据</strong>{item.preconditions || '未指定'} / {item.testData || '未指定'}</p>
                <p><strong>操作步骤</strong>{item.steps}</p>
                <p><strong>预期结果</strong>{item.expected}</p>
                <p><strong>验收断言</strong>{item.assertions?.join('\n') || '未指定'}</p>
                <p><strong>清理方式</strong>{item.cleanup || '未指定'}</p>
                {item.testFile && <p><strong>测试文件</strong>{item.testFile}</p>}
              </div>
            </details>
          </div>
        })}</details>
      })}</div>
      {!filtered.length && <p className="self-test-notice">没有匹配用例</p>}
      <div className="test-pagination"><div className="test-filter-field"><span>每页</span><FilterSelect label="每页用例数" value={String(pageSize)} options={[{ value: '10', label: '10' }, { value: '20', label: '20' }]} onChange={(value) => { setPageSize(Number(value)); setPage(1) }} /></div><span>第 {currentPage} / {pages} 页</span><button type="button" title="上一页" aria-label="上一页" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}><ArrowLeft size={16} /></button><button type="button" title="下一页" aria-label="下一页" disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}><ArrowRight size={16} /></button></div>
    </>}
  </section><TestExecutionResults task={task} onLocate={locateCase} onBindingSaved={onBindingSaved} bindingBusy={starting || accepting}>{!!tests.length && launch}</TestExecutionResults></>
}