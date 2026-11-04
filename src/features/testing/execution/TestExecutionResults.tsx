import * as React from 'react'
import { ArrowLeft, ArrowRight, Crosshair, ExternalLink, Link2, ListChecks, Search } from 'lucide-react'
import type { CodingTask, SelfTestCase } from '../../../../shared/task'
import type { TestExecutionResult } from '../../../../shared/test-execution'
import { executionSummary } from '../../../../shared/test-policy'
import { FilterSelect } from '../../../components/FilterSelect'
import { executionBlocks, executionCaseState } from '../review/self-test-review'
import { canEditExecutionBinding, ExecutionBindingEditor } from './ExecutionBindingEditor'

export interface TestExecutionResultsProps {
  task: CodingTask
  onLocate: (id: string) => void
  onBindingSaved?: () => void | Promise<void>
  bindingBusy?: boolean
  children?: React.ReactNode
}

const statusLabels: Record<string, string> = {
  pending: '待运行', running: '运行中', passed: '通过', failed: '执行失败（断言原因待核对）',
  preparation_blocked: '执行准备受阻', manual: '需人工确认', skipped: '未执行', invalid: '待修正', incomplete: '验证未完成', unknown: '执行状态未记录',
}
const categoryLabels = { functional: '功能', performance: '性能', security: '安全', compatibility: '兼容性', reliability: '可靠性' }
const reasonLabels = { capability: '缺少执行能力', environment: '执行环境未就绪', authorization: '缺少安全授权', manual: '需人工验证', unknown: '执行受阻（原因待核对）' }
const failureLabels = { action: '操作执行失败', assertion: '断言失败', navigation: '页面导航失败', browser: '浏览器执行失败', policy: '执行策略受限' }

export interface ExecutionEvidenceSource {
  executionResult?: TestExecutionResult
  runner?: 'playwright-test' | 'browser-dsl'
}

export function executionEngine(source: ExecutionEvidenceSource) {
  return source.executionResult?.runner === 'playwright-test' || source.runner === 'playwright-test' ? 'Playwright Test' : source.runner === 'browser-dsl' ? 'DSL' : 'legacy'
}

export function structuredExecutionState(result: TestExecutionResult) {
  const state = result.status === 'blocked' ? 'preparation_blocked' : result.status
  return { state, label: statusLabels[state] }
}

export function ExecutionEvidence({ result }: { result: TestExecutionResult }) {
  const assertionLabels = { passed: '通过', failed: '失败', missing: '未执行' }
  return <div className="execution-evidence" aria-label="结构化执行结果">
    <p>必验断言 {result.assertions.filter(assertion => assertion.status === 'passed').length}/{result.assertions.length}</p>
    <p>执行原因：{result.reason || '未记录'}</p>
    <ul aria-label="必验断言检查">{result.assertions.map(assertion => <li key={assertion.id}>{assertion.id} · {assertionLabels[assertion.status]} · expect {assertion.expectCount}</li>)}</ul>
  </div>
}

export function TestExecutionResults({ task, onLocate, onBindingSaved, bindingBusy, children }: TestExecutionResultsProps) {
  const [bindingCaseId, setBindingCaseId] = React.useState<string | null>(null)
  const bindingTrigger = React.useRef<HTMLButtonElement | null>(null)
  const [query, setQuery] = React.useState('')
  const [status, setStatus] = React.useState('all')
  const [category, setCategory] = React.useState('all')
  const [blockingOnly, setBlockingOnly] = React.useState(false)
  const [page, setPage] = React.useState(1)
  const [pageSize, setPageSize] = React.useState(10)
  React.useEffect(() => {
    setBindingCaseId(null)
    setQuery(''); setStatus('all'); setCategory('all'); setBlockingOnly(false); setPage(1); setPageSize(10)
  }, [task.id])

  const plan = task.testExecutionPlan
  const designs = new Map((task.selfTests || []).map(item => [item.id, item]))
  const runs = new Map((task.automationRuns || []).map(run => [run.caseId, run]))
  const selectedIds = [...new Set(plan?.cases.filter(entry => entry.selected === true).map(entry => entry.caseId) || [])]
  const legacyIds = [...new Set([
    ...runs.keys(),
    ...(task.selfTests || []).filter(item => item.status !== 'pending' || (item as SelfTestCase & ExecutionEvidenceSource).executionResult).map(item => item.id),
  ])]
  const rows = (plan ? selectedIds : legacyIds).map(id => {
    const design = designs.get(id)
    const run = runs.get(id)
    const item: SelfTestCase = design || { id, title: '设计定义不可用', source: '', steps: '', expected: '', status: 'pending' }
    const evidence = (item as SelfTestCase & ExecutionEvidenceSource).executionResult || (run as ExecutionEvidenceSource | undefined)?.executionResult
    const actual: SelfTestCase = evidence ? { ...item, status: evidence.status === 'blocked' ? 'manual' : evidence.status === 'incomplete' ? 'skipped' : evidence.status } : run ? { ...item, status: run.status === 'generating' ? 'running' : run.status === 'blocked' ? 'manual' : run.status } : item
    const result = evidence ? structuredExecutionState(evidence) : executionCaseState(actual, true, run)
    const state = !design && !run ? { state: 'unknown', label: statusLabels.unknown } : result
    const source: ExecutionEvidenceSource = { ...(run as ExecutionEvidenceSource | undefined), executionResult: evidence }
    return { item: actual, design, run, state, evidence, source }
  })
  const summary = plan ? executionSummary(rows.map(row => row.item), plan) : undefined
  const blockedRows = rows.filter(row => row.state.state === 'preparation_blocked')
  const filtered = rows.filter(({ item, state }) => {
    const itemCategory = item.classification?.testType || 'unclassified'
    return (status === 'all' || state.state === status)
      && (category === 'all' || category === itemCategory)
      && (!blockingOnly || executionBlocks(state.state) || state.state === 'incomplete')
      && `${item.id} ${item.title}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  })
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const currentPage = Math.min(page, pages)
  const visible = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize)

  return <section className="self-test-section test-execution-section" aria-label="用例执行">
    <div className="content-header"><div><h2><ListChecks size={18} />用例执行</h2></div></div>
    {!plan && <p className="self-test-notice">尚无已提交的执行计划</p>}
    {children && <div className="execution-launch-controls">{children}</div>}
    {plan && <>
      <details className="execution-scope"><summary>已提交范围（只读） · {selectedIds.length} 条</summary><p>{selectedIds.join(' / ') || '未选中用例'}</p><p>提交时间：{plan.createdAt}</p></details>
      <div className="execution-summary" aria-label="已提交执行统计">
        <strong>已选中 {rows.length} 条</strong>
        {Object.entries(statusLabels).map(([value, label]) => <span key={value}>{label} {rows.filter(row => row.state.state === value).length}</span>)}
        {summary && <><span>必验通过 {summary.blockingPassed}/{summary.blockingTotal}</span><span>补充 {rows.length - summary.blockingTotal} 条 · 失败 {summary.advisoryFailed} · 未验证 {summary.advisoryUnverified}</span><span>本次未选中 {plan.cases.filter(entry => entry.selected !== true).length} 条</span></>}
      </div>
      {blockedRows.length > 0 && <div className="execution-summary" aria-label="已选中受阻原因统计">
        <strong>已选中受阻原因</strong>
        {Object.entries(reasonLabels).map(([value, label]) => <span key={value}>{label} {blockedRows.filter(row => (row.run?.reasonCode || 'unknown') === value).length}</span>)}
      </div>}
    </>}
    {!plan && rows.length > 0 && <p className="self-test-notice self-test-warning">历史执行记录（非完整已提交范围），仅包含已有运行记录或非待运行状态的用例。</p>}
    {(plan || rows.length > 0) && <>
      <div className="execution-filters">
        <label className="execution-search"><Search size={15} /><input type="search" aria-label="搜索执行用例" placeholder="搜索执行用例" value={query} onChange={event => { setQuery(event.target.value); setPage(1) }} /></label>
        <FilterSelect label="执行状态" value={status} options={[{ value: 'all', label: '全部执行状态' }, ...Object.entries(statusLabels).map(([value, label]) => ({ value, label }))]} onChange={value => { setStatus(value); setPage(1) }} />
        <FilterSelect label="执行类别" value={category} options={[{ value: 'all', label: '全部执行类别' }, ...Object.entries(categoryLabels).map(([value, label]) => ({ value, label })), { value: 'unclassified', label: '未分类（旧用例 / 定义不可用）' }]} onChange={value => { setCategory(value); setPage(1) }} />
        <label className="execution-blocking"><input type="checkbox" checked={blockingOnly} onChange={event => { setBlockingOnly(event.target.checked); setPage(1) }} />仅看执行阻断</label>
        <span className="execution-match-count">{filtered.length} 条匹配</span>
      </div>
      <div className="execution-rows">{visible.map(({ item, design, run, state, evidence, source }) => {
        const startedAt = evidence?.startedAt || run?.startedAt || item.startedAt
        const finishedAt = evidence?.finishedAt || run?.finishedAt || item.finishedAt
        const browserEvidence = executionEngine(source) !== 'Playwright Test'
        const entry = plan?.cases.find(candidate => candidate.caseId === item.id)
        return <details className="execution-row" key={`${task.id}-${item.id}`}>
          <summary><strong>{item.id} · {item.title}</strong><span className={`case-status case-${state.state}`}>{state.label}</span><span className="execution-time">{state.state === 'preparation_blocked' && <><span>{reasonLabels[run?.reasonCode || 'unknown']}</span><br /></>}{finishedAt ? <>结束 <time dateTime={finishedAt}>{finishedAt}</time></> : startedAt ? <>开始 <time dateTime={startedAt}>{startedAt}</time></> : '时间未记录'}</span></summary>
          <div className="execution-row-body">
            {!design && <p className="execution-unavailable">设计定义不可用，保留执行记录与用例 ID。</p>}
            {entry && <p>本次已选中 · {entry.gatePolicy === 'blocking' ? '必验' : '补充'} · {entry.reason}</p>}
            <p>{item.classification ? categoryLabels[item.classification.testType] : '未分类（旧用例 / 定义不可用）'}</p>
            <p>执行引擎：{executionEngine(source)}</p>
            {evidence && <ExecutionEvidence result={evidence} />}
            {state.state === 'preparation_blocked' && <p>受阻原因：{reasonLabels[run?.reasonCode || 'unknown']}</p>}
            {(state.state === 'failed' || run?.failureCategory) && <p>失败分类：{run?.failureCategory ? failureLabels[run.failureCategory] : '未记录（原因待核对）'}</p>}
            {!!run?.requiredCapabilities?.length && <p>所需执行能力：{run.requiredCapabilities.join(' / ')}</p>}
            {run?.protocolVersion && <p>执行协议版本：{run.protocolVersion}</p>}
            {startedAt && <p>开始时间：<time dateTime={startedAt}>{startedAt}</time></p>}
            {finishedAt && <p>结束时间：<time dateTime={finishedAt}>{finishedAt}</time></p>}
            <details><summary>预期结果</summary><pre>{design?.expected || '预期结果未记录'}</pre></details>
            <details><summary>执行输出</summary><pre>{design?.output || '用例执行输出未记录'}</pre>{run?.output && run.output !== design?.output && <pre>{run.output}</pre>}</details>
            {!browserEvidence && item.testFile && <p>测试文件：{item.testFile}</p>}
            {browserEvidence && <details><summary>执行脚本</summary>{item.testFile && <p>测试文件：{item.testFile}</p>}<pre>{run?.script || '脚本内容未记录'}</pre></details>}
            <div className="execution-row-actions">
              {!bindingBusy && canEditExecutionBinding(task, item.id) && <button type="button" aria-expanded={bindingCaseId === item.id} onClick={event => { bindingTrigger.current = event.currentTarget; setBindingCaseId(bindingCaseId === item.id ? null : item.id) }}><Link2 size={15} />{design?.executionBinding ? '审阅可信绑定' : '绑定可信 Playwright'} {item.id}</button>}
              <button type="button" onClick={() => onLocate(item.id)}><Crosshair size={15} />定位设计用例 {item.id}</button>
              {(run || evidence) && <a href={`/?task=${encodeURIComponent(task.id)}&automation=${encodeURIComponent(item.id)}`}><ExternalLink size={15} />查看自动化任务 {item.id}</a>}
              {browserEvidence && run?.screenshot && <a href={`/api/tasks/${encodeURIComponent(task.id)}/automation/${encodeURIComponent(item.id)}/screenshot`} target="_blank" rel="noreferrer"><ExternalLink size={15} />执行截图 {item.id}</a>}
            </div>
            {bindingCaseId === item.id && !bindingBusy && canEditExecutionBinding(task, item.id) && <ExecutionBindingEditor key={`${task.id}-${item.id}`} taskId={task.id} caseId={item.id} onSaved={onBindingSaved} onClose={() => { setBindingCaseId(null); bindingTrigger.current?.focus({ preventScroll: true }) }} />}
          </div>
        </details>
      })}</div>
      {!filtered.length && <p className="self-test-notice">没有匹配的执行用例</p>}
      <div className="execution-pagination"><FilterSelect label="每页执行用例数" value={String(pageSize)} options={[{ value: '10', label: '10' }, { value: '20', label: '20' }]} onChange={value => { setPageSize(Number(value)); setPage(1) }} /><span>第 {currentPage} / {pages} 页</span><button type="button" title="上一页执行用例" aria-label="上一页执行用例" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}><ArrowLeft size={16} /></button><button type="button" title="下一页执行用例" aria-label="下一页执行用例" disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}><ArrowRight size={16} /></button></div>
    </>}
  </section>
}