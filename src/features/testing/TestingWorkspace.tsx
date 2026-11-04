import * as React from 'react'
import { Play, Plus, RefreshCw, Download, Upload, Save, Square, Code2 } from 'lucide-react'
import type { CaseDefinition, CasePackage, ExecutionInput, ExecutionRun, PlanningInput, PlanningProject, TestingSource } from '../../../shared/testing'
import type { AcceptanceAssessment } from '../../../shared/task'
import type { AssertionManifest, PlaywrightExecutionBinding } from '../../../shared/test-execution'
import { FilterSelect } from '../../components/FilterSelect'
import { PlanningCases } from './planning/PlanningCases'
import { PlanningActivity, PlanningProgress } from './planning/PlanningProgress'
import { PlanningQuestion } from './planning/PlanningQuestion'
import { invalidateAuth, useAuth } from '../auth/auth-session'
import { useNavigation } from '../../app/navigation'

export type TestingView = 'planning' | 'execution'
function TestingAuthStatus() {
  const { auth } = useAuth()
  if (auth.authenticated) return <a className="testing-auth" href="/" title="返回工作台管理 GitHub 登录">{auth.login || 'GitHub'} · 已登录</a>
  if (!auth.configured) return <span className="testing-auth" role="status">登录尚未配置</span>
  return <a className="testing-auth" href="/api/auth/start">登录 Copilot</a>
}

class ApiError extends Error {
  status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}
async function api<Value>(path: string, signal: AbortSignal, body?: unknown): Promise<Value> {
  const optionalFields = path === '/projects' ? ['referenceRepository', 'referenceBranch'] : path === '/executions' ? ['branch', 'previewUrl'] : []
  const response = await fetch(`/api/testing${path}`, { signal, ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body, (key, value: unknown) => optionalFields.includes(key) && typeof value === 'string' ? value.trim() || undefined : value) }) })
  if (response.status === 401) invalidateAuth()
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new ApiError(typeof payload?.error === 'string' ? payload.error : `请求失败 (${response.status})`, response.status)
  if (payload === null) throw new Error('服务端未返回 JSON')
  return payload as Value
}
const statusLabels: Record<string, string> = { draft: '草稿', running: '进行中', needs_input: '等待确认', completed: '规划完成', failed: '失败', interrupted: '已中断', cancelled: '已取消', preparing: '准备中', ready: '已就绪', passed: '通过', incomplete: '未完成', blocked: '受阻', pending: '待执行', skipped: '未选中', qualified: '审查通过', rejected: '审查不通过', reviewing: '审查中', warning: '质量提示', unreviewed: '待审查', unknown: '审查未完成', missing: '缺失' }
const label = (status?: string) => statusLabels[status || 'unknown'] || status
const phaseLabels: Record<NonNullable<ExecutionRun['phase']>, string> = { cloning: '克隆仓库', implementing: '生成实现中', installing: '安装依赖中', awaiting_implementation: '等待生成实现', awaiting_installation: '等待确认安装', awaiting_approval: '等待人工审核绑定', ready: '已就绪，等待执行', executing: '执行用例中', finished: '批次已结束' }
const active = (record?: PlanningProject | ExecutionRun) => !!record && ['running', 'preparing'].includes(record.status)
function Assessment({ value }: { value?: AcceptanceAssessment }) {
  return <section aria-label="审查结果"><h3>{value ? label(value.status) : '审查未完成'}</h3>{value && <>{value.readiness && <p>执行就绪：{label(value.readiness)}</p>}<p>覆盖 {value.coveredIds.length} · 缺失 {value.missingIds.join('、') || '无'}</p><ul>{value.issues.map((issue, index) => <li key={index}>{issue}</li>)}{value.findings?.map((finding, index) => <li key={`f${index}`}>{finding.category} · {finding.caseIds.join('、')} {finding.message}</li>)}{value.caseIssues?.map((issue, index) => <li key={`c${index}`}>{issue.caseId} · {issue.message}</li>)}</ul></>}</section>
}
export function TestingCases({ cases, assessment }: { cases: CaseDefinition[]; assessment?: AcceptanceAssessment }) {
  return <div className="testing-cases">{cases.map(item => <details key={item.id}><summary><strong>{item.id} · {item.title}</strong><span>{label(assessment?.caseReviews?.find(review => review.caseId === item.id)?.status)} · {item.classification?.testType || '未分类（旧用例）'}</span></summary><dl>{Object.entries({ 来源: item.source, 需求: item.requirementIds?.join('、'), 场景: item.scenario, 前置条件: item.preconditions, 测试数据: item.testData, 步骤: item.steps, 预期: item.expected, 清理: item.cleanup }).map(([name, value]) => <React.Fragment key={name}><dt>{name}</dt><dd>{value || '未提供'}</dd></React.Fragment>)}</dl><ol>{item.assertions?.map((assertion, index) => <li key={index}>{assertion}</li>)}</ol></details>)}</div>
}
type Implementation = NonNullable<ExecutionRun['cases'][number]['implementation']>
type BindingDetail = { manifest: AssertionManifest; testCase: CaseDefinition; binding: PlaywrightExecutionBinding | null; source?: string; implementation?: Implementation }
function BindingForm({ runId, caseId, implementation, signal, saved }: { runId: string; caseId: string; implementation?: Implementation; signal: AbortSignal; saved: () => Promise<void> }) {
  const [detail, setDetail] = React.useState<BindingDetail>()
  const [fields, setFields] = React.useState({ testFile: '', testTitle: '', project: '' })
  const [confirmed, setConfirmed] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [authFailed, setAuthFailed] = React.useState(false)
  const request = React.useRef<AbortController | null>(null)
  const firstInput = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => {
    if (detail) firstInput.current?.focus()
  }, [detail])
  const endpoint = `/executions/${encodeURIComponent(runId)}/bindings/${encodeURIComponent(caseId)}`
  React.useEffect(() => {
    const controller = new AbortController()
    request.current = controller
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort)
    void api<BindingDetail>(endpoint, controller.signal).then(value => {
      if (controller.signal.aborted) return
      if (value.manifest?.version !== 1 || value.manifest.caseId !== caseId || value.testCase?.id !== caseId || !Array.isArray(value.manifest.assertions)) throw new Error('断言清单与当前用例不匹配')
      const hint = value.binding ?? value.implementation ?? implementation
      setDetail(value); setFields({ testFile: hint?.testFile || value.testCase.testFile || '', testTitle: hint?.testTitle || '', project: hint?.project || '' })
    }).catch(caught => { if (!controller.signal.aborted) { setError(caught.message); setAuthFailed(caught instanceof ApiError && [401, 403].includes(caught.status)) } })
    return () => { controller.abort(); signal.removeEventListener('abort', abort) }
  }, [endpoint, caseId, implementation, signal])
  const assertions = detail?.manifest.assertions || []
  const validAssertions = assertions.length > 0 && assertions.every(item => !!item.id && !!item.definition.trim()) && new Set(assertions.map(item => item.id)).size === assertions.length
  const generated = detail?.implementation ?? implementation
  const sourceFile = detail?.implementation?.testFile ?? detail?.binding?.testFile ?? implementation?.testFile
  const hasSource = typeof detail?.source === 'string' && !!detail.source.trim()
  const reviewable = !generated || (hasSource && fields.testFile.trim() === sourceFile)
  return <form className="testing-binding" aria-label={`绑定 ${caseId}`} onSubmit={event => {
    event.preventDefault()
    if (!confirmed || !detail || !validAssertions || !reviewable || busy) return
    setBusy(true); setError('')
    const saveSignal = request.current?.signal || signal
    void api(endpoint, saveSignal, { ...fields, assertionIds: assertions.map(item => item.id), confirm: true })
      .then(async () => { if (!saveSignal.aborted) { setConfirmed(false); await saved() } })
      .catch(caught => { if (!saveSignal.aborted) { setError(caught.message); setConfirmed(false); setAuthFailed(caught instanceof ApiError && [401, 403].includes(caught.status)) } })
      .finally(() => { if (!saveSignal.aborted) setBusy(false) })
  }}>
    <fieldset disabled={busy || !detail}>
      <legend>人工确认 · {caseId}</legend>
      <p>仅提交已完整审阅的可信脚本。保存不代表通过。</p>
      <p>脚本和 Playwright 配置会作为代码执行，并非浏览器沙箱，也不保证隔离凭据。</p>
      {hasSource ? <details className="testing-source" open><summary>完整脚本源码 · {sourceFile}</summary><pre tabIndex={0} aria-label={`脚本源码 ${caseId}`}><code>{detail?.source}</code></pre></details> : <p role={generated ? 'alert' : undefined}>{generated ? '生成脚本源码未加载，无法批准。请关闭后重新读取。' : '未返回源码；请先在仓库中完整审阅实际脚本，再手动填写并确认映射。'}</p>}
      <div className="testing-fields">{(['testFile', 'testTitle', 'project'] as const).map((key, index) => <label key={key}>
        {['测试文件', '完整测试标题', 'Playwright 项目（可选）'][index]}
        <input ref={index === 0 ? firstInput : undefined} required={key !== 'project'} value={fields[key]} onChange={event => { setFields({ ...fields, [key]: event.target.value }); setConfirmed(false) }} />
      </label>)}</div>
      <ol aria-label="服务端断言清单">{assertions.map(item => <li key={item.id}><code>{item.id}</code> · {item.definition}</li>)}</ol>
      {detail && !validAssertions && <p role="alert">断言清单为空或不完整，无法确认绑定。</p>}
      {generated && hasSource && !reviewable && <p role="alert">映射文件与已加载源码不同，无法批准。请恢复源码对应文件后审核。</p>}
      <label className="testing-check"><input type="checkbox" checked={confirmed} disabled={!validAssertions || !reviewable} onChange={event => setConfirmed(event.target.checked)} />我已完整审阅并信任脚本，确认文件、标题、项目与全部断言映射</label>
      <button disabled={!confirmed || !validAssertions || !reviewable || !fields.testFile.trim() || !fields.testTitle.trim()}><Save size={16} />保存绑定</button>
    </fieldset>
    {error && <p role="alert">{error}{authFailed && <a href="/api/auth/start">重新登录</a>}</p>}
  </form>
}

function ExecutionDetail({ run, selectedPackage, busy, signal, action, refreshRecord, download }: {
  run: ExecutionRun
  selectedPackage?: CasePackage
  busy: boolean
  signal: AbortSignal
  action: (work: () => Promise<void>) => Promise<void>
  refreshRecord: () => Promise<void>
  download: (path: string, name: string) => Promise<void>
}) {
  const [bindingId, setBindingId] = React.useState('')
  const [installConfirmed, setInstallConfirmed] = React.useState(false)
  React.useEffect(() => { setInstallConfirmed(false); setBindingId('') }, [run.id, run.phase])
  const terminal = ['passed', 'failed', 'incomplete', 'cancelled', 'interrupted'].includes(run.status) || run.phase === 'finished'
  const running = active(run)
  const idle = !terminal && !running && !run.events.some(event => event.text === 'Approved Playwright execution started.')
  const canPrepare = idle && ['draft', 'blocked'].includes(run.status) && !run.workspaceFingerprint
  const canImplement = idle && !!run.workspaceFingerprint && (run.phase === 'awaiting_implementation' || (run.status === 'blocked' && run.phase === 'implementing'))
  const canInstall = idle && !!run.workspaceFingerprint && (run.phase === 'awaiting_installation' || (run.status === 'blocked' && run.phase === 'installing'))
  const canReview = idle && !!run.workspaceFingerprint && (!run.phase || ['awaiting_approval', 'ready'].includes(run.phase))
  const canStart = idle && run.status === 'ready' && (!run.phase || run.phase === 'ready') && run.cases.some(item => item.selected) && run.cases.every(item => !item.selected || !!item.binding)
  async function mutate(operation: string, body: unknown = {}) {
    setBindingId(''); setInstallConfirmed(false)
    try { await api(`/executions/${encodeURIComponent(run.id)}/${operation}`, signal, body) }
    catch (caught) { await refreshRecord().catch(() => {}); throw caught }
    await refreshRecord()
  }
  return <section aria-label="执行详情">
    <h2>{run.input.title}</h2>
    <p role="status" className="testing-run-status"><span>{label(run.status)}</span><span className="testing-phase">{run.phase ? phaseLabels[run.phase] : '旧批次 · 未记录阶段'}</span><span>{run.input.scope.mode === 'default' ? '默认质量门禁' : `自定义范围：${run.input.scope.reason}`}</span></p>
    <p>{run.input.repository} · {run.input.branch || '默认分支'} · {run.input.previewUrl || '未提供预览地址'}</p>
    <div className="testing-actions">
      <button disabled={busy || !canPrepare} onClick={() => void action(() => mutate('prepare'))}><RefreshCw size={16} />准备执行环境</button>
      <button disabled={busy || !canImplement} onClick={() => void action(() => mutate('implement'))}><Code2 size={16} />生成测试实现</button>
      <button disabled={busy || !canStart} onClick={() => void action(() => mutate('start'))}><Play size={16} />执行已选用例</button>
      {running && <button disabled={busy || terminal} onClick={() => void action(() => mutate('cancel'))}><Square size={16} />取消执行</button>}
      <button disabled={busy} onClick={() => void action(() => download(`/executions/${encodeURIComponent(run.id)}/report`, `execution-${run.id}.json`))}><Download size={16} />导出报告</button>
    </div>
    <p className="testing-notice">准备仅克隆仓库；生成实现使用独立短模型会话，仅写入测试脚本，不批准绑定、不执行脚本。依赖安装、源码审核与执行均需分别确认，不自动修复失败。</p>
    {canInstall && <fieldset className="testing-install" disabled={busy}>
      <legend>确认安装依赖</legend>
      <p>将通过 npm 下载固定版本 @playwright/test@1.63.0，使用 --ignore-scripts 禁用生命周期脚本。npm 包仍有供应链风险；不会自动安装浏览器、启动服务或批准测试。</p>
      <label className="testing-check"><input type="checkbox" checked={installConfirmed} onChange={event => setInstallConfirmed(event.target.checked)} />我了解 npm 包供应链风险，确认安装固定版本依赖</label>
      <button disabled={!installConfirmed} onClick={() => void action(() => mutate('install', { confirm: true }))}><Download size={16} />安装 Playwright 依赖</button>
    </fieldset>}
    {terminal && <p className="testing-notice">此批次已结束，结果与绑定不可修改。再次执行请创建新批次。</p>}
    <Assessment value={run.readiness} />
    {run.cases.map(item => <article className="testing-case" key={item.caseId}>
      <div className="testing-case-heading"><h3>{item.caseId} · {selectedPackage?.cases.find(value => value.id === item.caseId)?.title || '定义读取中'}</h3><span>{item.selected ? label(item.status) : '未选中'} · {item.blocking ? '门禁' : '补充'}</span></div>
      {item.reason && <p>{item.reason}</p>}
      {item.selected && <>
        <p>{item.binding ? `已确认：${item.binding.testFile} · ${item.binding.testTitle} · ${item.binding.approvedBy}` : item.implementation ? `已生成，未批准：${item.implementation.testFile} · ${item.implementation.testTitle} · ${item.implementation.project || '默认项目'}` : '尚无人工确认绑定'}</p>
        <button disabled={busy || !canReview} onClick={() => setBindingId(bindingId === item.caseId ? '' : item.caseId)} aria-expanded={bindingId === item.caseId}><Code2 size={16} />审阅绑定 {item.caseId}</button>
        {bindingId === item.caseId && canReview && <BindingForm key={item.caseId} runId={run.id} caseId={item.caseId} implementation={item.implementation} signal={signal} saved={async () => { setBindingId(''); await refreshRecord() }} />}
      </>}
      {item.result && <><p>{item.result.reason}</p><ul aria-label={`断言结果 ${item.caseId}`}>{item.result.assertions.map(assertion => <li key={assertion.id}>{assertion.id} · {label(assertion.status)} · {assertion.expectCount} 次 expect</li>)}</ul></>}
    </article>)}
  </section>
}

export function TestingWorkspace({ view, id = '' }: { view: TestingView; id?: string }) {
  const navigate = useNavigation()
  function testingNavigate(target: TestingView, targetId = '') {
    const query = new URLSearchParams({ view: target })
    if (targetId) query.set(target, targetId)
    navigate(`/${target}?${query}`)
  }
  const [controller] = React.useState(() => new AbortController())
  const lifetime = React.useRef(0)
  const responseSequence = React.useRef(0)
  const signal = controller.signal
  React.useEffect(() => {
    const generation = ++lifetime.current
    const isCurrent = () => lifetime.current === generation
    return () => { queueMicrotask(() => { if (isCurrent()) controller.abort() }) }
  }, [controller])
  const [projects, setProjects] = React.useState<PlanningProject[]>([])
  const [packages, setPackages] = React.useState<CasePackage[]>([])
  const [runs, setRuns] = React.useState<ExecutionRun[]>([])
  const [record, setRecord] = React.useState<PlanningProject | ExecutionRun>()
  const [loadedPackage, setLoadedPackage] = React.useState<CasePackage>()
  const [packageId, setPackageId] = React.useState(() => typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('package') || '')
  const [planning, setPlanning] = React.useState<PlanningInput>({ title: '', requirements: '', instruction: '', modelId: 'auto', sources: [], referenceRepository: '', referenceBranch: '' })
  const [execution, setExecution] = React.useState<Omit<ExecutionInput, 'caseSetId'>>({ title: '', repository: '', branch: '', previewUrl: '', scope: { mode: 'default', caseIds: [], reason: '' } })
  const [models, setModels] = React.useState([{ value: 'auto', label: 'Auto' }])
  const [error, setError] = React.useState('')
  const [authFailed, setAuthFailed] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const caseMutation = React.useRef(false)
  const [syncError, setSyncError] = React.useState(false)
  const [search, setSearch] = React.useState('')
  const heading = React.useRef<HTMLHeadingElement>(null)
  const project = view === 'planning' ? record as PlanningProject | undefined : undefined
  const run = view === 'execution' ? record as ExecutionRun | undefined : undefined
  const packageTarget = packageId || run?.input.caseSetId || ''
  const selectedPackage = loadedPackage?.id === packageTarget ? loadedPackage : undefined
  function failure(caught: unknown) { if (!signal.aborted) { setError(caught instanceof Error ? caught.message : '请求失败'); if (caught instanceof ApiError && [401, 403].includes(caught.status)) setAuthFailed(true) } }
  async function refreshRecord() {
    if (!id) return
    const sequence = ++responseSequence.current
    try {
      const value = await api<PlanningProject | ExecutionRun>(`/${view === 'planning' ? 'projects' : 'executions'}/${encodeURIComponent(id)}`, signal)
      if (value.id !== id) throw new Error('服务端返回的记录与当前 URL 不匹配')
      if (!signal.aborted && sequence === responseSequence.current) {
        setRecord(previous => previous && previous.version > value.version ? previous : value)
        setSyncError(false)
      }
    } catch (caught) {
      if (!signal.aborted && sequence === responseSequence.current) setSyncError(true)
      throw caught
    }
  }
  async function lists() {
    await Promise.all([
      api<CasePackage[]>('/packages', signal).then(value => { if (!signal.aborted) setPackages(value) }),
      view === 'planning'
        ? api<PlanningProject[]>('/projects', signal).then(value => { if (!signal.aborted) setProjects(value) })
        : api<ExecutionRun[]>('/executions', signal).then(value => { if (!signal.aborted) setRuns(value) }),
    ])
  }
  async function action(work: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    try { await work() } catch (caught) { failure(caught) } finally { if (!signal.aborted) setBusy(false) }
  }
  async function caseAction(work: () => Promise<void>) {
    if (busy || caseMutation.current) throw new Error('另一个操作正在提交，请稍后重试')
    caseMutation.current = true
    setBusy(true); setError(''); setAuthFailed(false)
    try {
      await work()
      await refreshRecord()
      await lists()
      if (signal.aborted) throw new Error('请求已取消')
    } catch (caught) { failure(caught); throw caught }
    finally { caseMutation.current = false; if (!signal.aborted) setBusy(false) }
  }
  const loadInitial = React.useEffectEvent(() => {
    heading.current?.focus({ preventScroll: true })
    void Promise.all([lists(), refreshRecord()]).catch(failure).finally(() => { if (!signal.aborted) setLoading(false) })
    if (view === 'planning') void fetch('/api/copilot/models', { signal }).then(async response => {
      if (!response.ok) return
      const catalog = await response.json() as { models: { id: string; name: string; policy?: string }[] }
      if (!signal.aborted && Array.isArray(catalog.models)) setModels([{ value: 'auto', label: 'Auto' }, ...catalog.models.filter(item => item.id !== 'auto' && !['disabled', 'unconfigured'].includes(item.policy || '')).map(item => ({ value: item.id, label: item.name }))])
    }).catch(() => {})
  })
  React.useEffect(() => { loadInitial() }, [])
  const pollRecord = React.useEffectEvent(async () => { try { await refreshRecord() } catch (caught) { failure(caught) } })
  const isActive = active(record)
  React.useEffect(() => {
    if (!isActive) return
    let cancelled = false
    let timer: number
    const poll = async () => {
      try { await pollRecord() }
      finally { if (!cancelled && !signal.aborted) timer = window.setTimeout(() => void poll(), 2000) }
    }
    timer = window.setTimeout(() => void poll(), 2000)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [isActive, signal])
  const packageFailure = React.useEffectEvent(failure)
  React.useEffect(() => {
    const target = packageTarget
    if (!target) return
    const request = new AbortController()
    const abort = () => request.abort()
    signal.addEventListener('abort', abort)
    void api<CasePackage>(`/packages/${encodeURIComponent(target)}`, request.signal).then(value => {
      if (value.id !== target) throw new Error('用例包与当前选择不匹配')
      if (!request.signal.aborted) {
        setLoadedPackage(value)
        if (value.scope) setExecution(previous => ({ ...previous, scope: { mode: 'custom', caseIds: [...value.scope!.caseIds], reason: value.scope!.reason } }))
      }
    }).catch(caught => { if (!request.signal.aborted) packageFailure(caught) })
    return () => { request.abort(); signal.removeEventListener('abort', abort) }
  }, [packageTarget, signal])
  async function download(path: string, name: string) {
    const value = await api<unknown>(path, signal)
    if (signal.aborted) return
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }))
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url)
  }
  function packageExecution(value: CasePackage) {
    const query = new URLSearchParams({ view: 'execution', package: value.id })
    navigate(`/execution?${query}`)
  }
  async function upload(files: FileList | null, kind: TestingSource['kind']) {
    if (!files?.length) return
    const data = new FormData(); data.append('kind', kind)
    Array.from(files).forEach(file => data.append('files', file))
    const response = await fetch('/api/testing/sources', { method: 'POST', body: data, signal })
    const value = await response.json()
    if (!response.ok) throw new ApiError(value.error || `上传失败 (${response.status})`, response.status)
    if (!Array.isArray(value)) throw new Error('上传接口未返回来源清单')
    if (!signal.aborted) setPlanning(previous => ({ ...previous, sources: [...previous.sources, ...value as TestingSource[]] }))
  }
  const history = view === 'planning' ? projects.map(item => ({ id: item.id, title: item.input.title, status: item.status })) : runs.map(item => ({ id: item.id, title: item.input.title, status: item.status }))
  const scope = selectedPackage?.scope ? { mode: 'custom' as const, caseIds: selectedPackage.scope.caseIds, reason: selectedPackage.scope.reason } : execution.scope
  const running = active(record)
  return <div className="testing-shell"><header className="testing-topbar"><a className="testing-brand" href="/">工作台</a><span className="testing-breadcrumb">/ {view === 'planning' ? '用例规划' : '用例执行'}</span><TestingAuthStatus /></header><main className="testing-workspace" aria-busy={busy || loading}><div className="testing-heading"><h1 ref={heading} tabIndex={-1}>{view === 'planning' ? '用例规划' : '用例执行'}</h1><button onClick={() => testingNavigate(view)}><Plus size={16} />{view === 'planning' ? '新建规划' : '新建执行'}</button><button title="刷新" aria-label="刷新" disabled={busy} onClick={() => void action(async () => { await lists(); await refreshRecord() })}><RefreshCw size={16} /></button></div>
    {error && <div role="alert" className="testing-error">{error}{authFailed && <a href="/api/auth/start">登录后重试</a>}</div>}{loading && <p role="status">正在读取…</p>}
    <div className="testing-layout"><aside className="testing-history" aria-label="历史记录"><h2>历史记录</h2><input aria-label="搜索历史记录" type="search" value={search} onChange={event => setSearch(event.target.value)} />{history.filter(item => item.title.includes(search)).map(item => <a key={item.id} href={`?view=${view}&${view}=${encodeURIComponent(item.id)}`} aria-current={id === item.id ? 'page' : undefined} onClick={event => { event.preventDefault(); testingNavigate(view, item.id) }}><strong>{item.title}</strong><span>{label(item.status)}</span></a>)}{!history.length && <p>暂无记录</p>}</aside><div className="testing-body">
    {!id && view === 'planning' && <form aria-label="新建规划" onSubmit={event => { event.preventDefault(); void action(async () => { const value = await api<PlanningProject>('/projects', signal, planning); if (!signal.aborted) testingNavigate('planning', value.id) }) }}><fieldset disabled={busy}><legend>新建规划</legend><label>规划标题<input required value={planning.title} onChange={event => setPlanning({ ...planning, title: event.target.value })} /></label><label htmlFor="planning-requirements">需求正文</label><textarea id="planning-requirements" required={!planning.sources.some(source => source.kind === 'requirements')} rows={8} value={planning.requirements} onChange={event => setPlanning({ ...planning, requirements: event.target.value })} /><div className="testing-fields">{(['requirements', 'design'] as const).map(kind => <label key={kind}><Upload size={16} />{kind === 'requirements' ? '需求文档' : '设计文件'}<input type="file" multiple onChange={event => { const files = event.target.files; void action(() => upload(files, kind)); event.target.value = '' }} /></label>)}</div><ul>{planning.sources.map(source => <li key={source.id}>{source.name} · {source.kind}<button type="button" aria-label={`移除 ${source.name}`} onClick={() => setPlanning({ ...planning, sources: planning.sources.filter(item => item.id !== source.id) })}>移除</button></li>)}</ul><label htmlFor="planning-instruction">规划指令（可选）</label><textarea id="planning-instruction" rows={3} value={planning.instruction} onChange={event => setPlanning({ ...planning, instruction: event.target.value })} /><FilterSelect label="规划模型" value={planning.modelId} options={models} onChange={modelId => setPlanning({ ...planning, modelId })} /><div className="testing-fields"><label>参考仓库（可选）<input value={planning.referenceRepository} onChange={event => setPlanning({ ...planning, referenceRepository: event.target.value })} /></label><label>参考分支（可选）<input value={planning.referenceBranch} onChange={event => setPlanning({ ...planning, referenceBranch: event.target.value })} /></label></div><button type="submit" disabled={!planning.requirements.trim() && !planning.sources.some(source => source.kind === 'requirements')}><Save size={16} />创建规划</button></fieldset></form>}
    {project && <section aria-label="规划详情">
      <h2>{project.input.title}</h2><p role="status">{label(project.status)}</p>
      <div className="testing-actions">
        <button disabled={busy || running || project.status === 'needs_input' && !!project.question} onClick={() => void action(async () => { await api(`/projects/${encodeURIComponent(id)}/generate`, signal, {}); await refreshRecord() })}><Play size={16} />{project.draft ? '重新生成新草稿' : '生成用例'}</button>
        {!!project.draft?.baseline.length && <button disabled={busy || running || !!project.question} onClick={() => void action(async () => { setError(''); await api(`/projects/${encodeURIComponent(id)}/continue`, signal, { version: project.version }); await refreshRecord() })}><Play size={16} />继续生成并审查</button>}
        {!!project.draft?.cases.length && <button disabled={busy || running || !!project.question} onClick={() => void action(async () => { setError(''); await api(`/projects/${encodeURIComponent(id)}/review`, signal, { version: project.version }); await refreshRecord() })}><RefreshCw size={16} />继续全量审查</button>}
        <button disabled={busy || running || project.status !== 'completed' || project.draft?.assessment?.status !== 'qualified'} onClick={() => void action(async () => { const value = await api<CasePackage>(`/projects/${encodeURIComponent(id)}/publish`, signal, {}); await lists(); setPackageId(value.id); await refreshRecord() })}><Save size={16} />发布用例包</button>
        {running && <button disabled={busy} onClick={() => void action(async () => { await api(`/projects/${encodeURIComponent(id)}/cancel`, signal, {}); await refreshRecord() })}><Square size={16} />取消规划</button>}
      </div>
      <PlanningProgress project={project} syncError={syncError} />
      <PlanningQuestion key={project.question?.id || project.id} project={project} busy={busy} onAnswer={answer => action(async () => {
        setError('')
        setAuthFailed(false)
        await api(`/projects/${encodeURIComponent(id)}/answer`, signal, { questionId: project.question?.id, version: project.version, answer })
        await refreshRecord()
        await lists()
      })} />
      {!!project.clarifications?.length && <details className="planning-answers"><summary>已确认问题 · {project.clarifications.length} 项</summary><ol>{project.clarifications.map(item => <li key={item.question.id}><strong>{item.question.text}</strong><p>{item.answer}</p></li>)}</ol></details>}
      <details><summary>需求与来源</summary><p>{project.input.requirements}</p><p>{project.input.instruction}</p><ul>{project.input.sources.map(source => <li key={source.id}>{source.name}</li>)}</ul></details>
      <details className="planning-baseline"><summary>需求基线 · {project.draft?.baseline.length || 0} 项</summary><ul>{project.draft?.baseline.map(item => <li key={item.id}>{item.id} · {item.criterion} · {item.required ? '必验' : '补充'}</li>)}</ul></details>
      <PlanningCases key={`cases:${project.id}`} project={project} busy={busy} onReview={operation => void action(async () => { setError(''); await api(`/projects/${encodeURIComponent(id)}/review`, signal, operation); await refreshRecord() })}
        onEdit={(caseId, caseDefinition, version) => caseAction(async () => { await api<PlanningProject>(`/projects/${encodeURIComponent(id)}/cases/${encodeURIComponent(caseId)}`, signal, { version, caseDefinition }) })}
        onOptimize={({ version, caseIds, reason, regenerate }) => caseAction(async () => { await api(`/projects/${encodeURIComponent(id)}/optimize`, signal, { version, caseIds, reason, regenerate }) })}
        onProceed={async selectedScope => {
          if (busy) throw new Error('另一个操作正在提交，请稍后重试')
          setBusy(true); setError('')
          try {
            const value = await api<CasePackage>(`/projects/${encodeURIComponent(id)}/publish-scope`, signal, { version: project.version, ...selectedScope })
            if (!signal.aborted) packageExecution(value)
          } catch (caught) { failure(caught); throw caught }
          finally { if (!signal.aborted) setBusy(false) }
        }} />
    </section>}
    {!id && view === 'execution' && <form aria-label="新建执行" onSubmit={event => { event.preventDefault(); void action(async () => { const value = await api<ExecutionRun>('/executions', signal, { ...execution, scope, caseSetId: packageId }); if (!signal.aborted) testingNavigate('execution', value.id) }) }}>
      <fieldset disabled={busy}><legend>新建执行</legend>
        <FilterSelect label="执行用例包" value={packageId} options={[{ value: '', label: '选择用例包' }, ...packages.map(item => ({ value: item.id, label: `${item.projectId} · v${item.revision} · ${item.id}` }))]} onChange={value => { setPackageId(value); setExecution({ ...execution, scope: { mode: 'default', caseIds: [], reason: '' } }) }} />
        <label>执行标题<input required value={execution.title} onChange={event => setExecution({ ...execution, title: event.target.value })} /></label>
        <div className="testing-fields"><label>目标仓库<input required value={execution.repository} onChange={event => setExecution({ ...execution, repository: event.target.value })} /></label><label>执行分支（可选）<input value={execution.branch} onChange={event => setExecution({ ...execution, branch: event.target.value })} /></label></div>
        <label>预览 URL（可选）<input type="url" value={execution.previewUrl} onChange={event => setExecution({ ...execution, previewUrl: event.target.value })} /></label>
        {selectedPackage?.scope && <p role="status">已审查范围包 · {selectedPackage.scope.caseIds.length} 条 · {selectedPackage.scope.reason}</p>}
        <fieldset disabled={!!selectedPackage?.scope}><legend>执行范围</legend>
          <label className="testing-check"><input type="radio" name="scope" checked={scope.mode === 'default'} onChange={() => setExecution({ ...execution, scope: { mode: 'default', caseIds: [], reason: '' } })} />默认质量门禁</label>
          <label className="testing-check"><input type="radio" name="scope" checked={scope.mode === 'custom'} onChange={() => setExecution({ ...execution, scope: { mode: 'custom', caseIds: [], reason: '' } })} />自定义范围</label>
          {scope.mode === 'custom' && <>{selectedPackage?.cases.map(item => <label className="testing-check" key={item.id}><input type="checkbox" checked={scope.caseIds.includes(item.id)} onChange={event => setExecution({ ...execution, scope: { ...scope, caseIds: event.target.checked ? [...scope.caseIds, item.id] : scope.caseIds.filter(value => value !== item.id) } })} />{item.id} · {item.title}</label>)}<label>范围调整理由<textarea required value={scope.reason} onChange={event => setExecution({ ...execution, scope: { ...scope, reason: event.target.value } })} /></label></>}
        </fieldset>
        <button disabled={!packageId || !selectedPackage || scope.mode === 'custom' && (!scope.caseIds.length || !scope.reason.trim())}><Plus size={16} />创建执行</button>
      </fieldset>
    </form>}
    {run && <ExecutionDetail key={run.id} run={run} selectedPackage={selectedPackage} busy={busy} signal={signal} action={action} refreshRecord={refreshRecord} download={download} />}
    {project ? <PlanningActivity project={project} /> : record && <section aria-label="进度记录"><h3>进度记录</h3>{record.error && <p role="alert">{record.error}</p>}<ol>{record.events.map((event, index) => <li key={index}><time>{event.at}</time> · {event.kind} · {event.text}</li>)}</ol></section>}
    {(view === 'execution' || project) && <section aria-label="用例包版本"><div className="testing-heading"><h2>用例包版本</h2><label className="testing-import"><Upload size={16} />导入 JSON<input type="file" accept="application/json,.json" disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void action(async () => { const value: unknown = JSON.parse(await file.text()); const imported = await api<CasePackage>('/packages/import', signal, { package: value }); await lists(); setPackageId(imported.id) }) }} /></label></div><div className="testing-package-list">{packages.filter(item => !project || item.projectId === project.id).map(item => <button key={item.id} disabled={busy} aria-pressed={packageId === item.id} onClick={() => setPackageId(item.id)}>{item.projectId} · v{item.revision} · {item.cases.length} 条</button>)}</div>{selectedPackage && <section aria-label="不可变用例包"><h3>{selectedPackage.id} · v{selectedPackage.revision}</h3><p>{selectedPackage.createdAt} · {selectedPackage.rulesVersion}</p><div className="testing-actions"><button disabled={busy} onClick={() => void action(() => download(`/packages/${encodeURIComponent(selectedPackage.id)}/export`, `package-${selectedPackage.id}.json`))}><Download size={16} />导出用例包</button><button onClick={() => packageExecution(selectedPackage)}><Play size={16} />从此版本创建执行</button></div><Assessment value={selectedPackage.assessment} /><TestingCases cases={selectedPackage.cases} assessment={selectedPackage.assessment} /></section>}</section>}
    </div></div></main></div>
}