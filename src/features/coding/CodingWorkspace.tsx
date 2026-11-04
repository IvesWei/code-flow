import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import { Activity, ArrowRight, Check, CheckCircle2, CircleAlert, ClipboardList, Code2, FileText, FolderGit2, GitBranch, ImagePlus, LoaderCircle, LogIn, LogOut, MessageSquareText, Plus, RefreshCw, Send, X } from 'lucide-react'
import type { CodingTask, TaskStatus } from '../../../shared/task'
import type { TaskEvent, TaskListPage, TaskSummary } from '../../../shared/task-summary'
import { useTaskHistory } from './useTaskHistory'
import { ActivitySection } from './ActivitySection'
import { FileChanges } from './FileChanges'
import { SelfTestResults, selfTestStageLabel, type SelfTestStartOptions } from '../testing/execution/SelfTestResults'
import { AutomationTaskDetail } from '../automation/AutomationTaskDetail'
import { AutomationDashboard } from '../automation/AutomationDashboard'
import { PublicationPanel } from './PublicationPanel'
import { ModelPicker } from '../../components/ModelPicker'
import { TestingLinks } from './TestingLinks'
import { invalidateAuth, useAuth } from '../auth/auth-session'
import { useLocation } from 'react-router-dom'
import { useNavigation } from '../../app/navigation'

const labels: Record<TaskStatus, string> = {
  QUEUED: '等待开始', CLONING: '拉取仓库', CODING: '正在编码',
  NEEDS_INPUT: '等待确认', VERIFYING: '正在检查', PUBLISH_PENDING: '等待确认推送', SELF_TEST: '正在规划用例', TEST_EXECUTION: '正在执行用例', REVIEW: '待验收', ACCEPTED: '已接受风险', SUCCESS: '已完成', FAILED: '执行失败',
}

interface ModelCatalog { defaultModelId: string; models: { id: string; name: string; policy?: string; vision: boolean; multiplier?: number }[] }
const phases = [
  { id: 'CLONING', title: '拉取代码', icon: FolderGit2 },
  { id: 'CODING', title: 'Copilot 编码', icon: Code2 },
  { id: 'PUBLISH_PENDING', title: '确认推送', icon: GitBranch },
  { id: 'SELF_TEST', title: '用例规划', icon: ClipboardList },
  { id: 'TEST_EXECUTION', title: '自动执行', icon: Activity },
  { id: 'SUCCESS', title: '验收结果', icon: Check },
] as const

async function json<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options)
  if (response.status === 401) invalidateAuth()
  const payload = await response.json()
  if (!response.ok) throw new Error(payload.error || `请求失败 (${response.status})`)
  return payload as T
}

function relativeTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

function CodingWorkspace() {
  const navigate = useNavigation()
  const routeLocation = useLocation()
  const previousLocation = useRef(routeLocation.key)
  const [tasks, setTasks] = useState<TaskSummary[]>([])
  const [selectedTask, setSelectedTask] = useState<CodingTask>()
  const [nextCursor, setNextCursor] = useState<string>()
  const [listPages, setListPages] = useState(1)
  const [listLoading, setListLoading] = useState(false)
  const [serverBusy, setServerBusy] = useState(false)
  const [refreshRevision, setRefreshRevision] = useState(0)
  const detailGeneration = useRef(0)
  const [selectedId, setSelectedId] = useState<string | null>(() => new URLSearchParams(location.search).get('task') || sessionStorage.getItem('codeflow_selected_task'))
  const [showForm, setShowForm] = useState(() => !(new URLSearchParams(location.search).get('task') || sessionStorage.getItem('codeflow_selected_task')))
  const [automationCaseId, setAutomationCaseId] = useState(() => new URLSearchParams(location.search).get('automation'))
  const [repository, setRepository] = useState('')
  const [branch, setBranch] = useState('')
  const [instruction, setInstruction] = useState('')
  const [automationUrl, setAutomationUrl] = useState('')
  const [prd, setPrd] = useState<File | null>(null)
  const [designs, setDesigns] = useState<{ file: File; url: string }[]>([])
  const previewUrls = useRef<string[]>([])
  const [answer, setAnswer] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [sendingAnswer, setSendingAnswer] = useState(false)
  const [guidance, setGuidance] = useState('')
  const [newSessionTaskId, setNewSessionTaskId] = useState<string | null>(null)
  const allowNewSession = newSessionTaskId !== null && newSessionTaskId === selectedId
  const [resuming, setResuming] = useState(false)
  const [accepting, setAccepting] = useState(false)
  const [startingSelfTest, setStartingSelfTest] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [startingAutomationId, setStartingAutomationId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [connected, setConnected] = useState(true)
  const { auth, login, logout: signOut } = useAuth()
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog | null>(null)
  const [modelError, setModelError] = useState('')
  const [modelsLoading, setModelsLoading] = useState(false)
  const [newModel, setNewModel] = useState<string | null>(null)
  const [savingModel, setSavingModel] = useState(false)
  const modelFetch = useRef(0)
  const busy = serverBusy || tasks.some((task) => !['SUCCESS', 'FAILED', 'REVIEW', 'ACCEPTED'].includes(task.status)) || !!(selectedTask?.id === selectedId && !['SUCCESS', 'FAILED', 'REVIEW', 'ACCEPTED'].includes(selectedTask.status))
  const history = useTaskHistory<TaskEvent>(selectedId || undefined, 'events', selectedTask?.id === selectedId ? selectedTask.updatedAt : '')

  useEffect(() => {
    if (previousLocation.current === routeLocation.key) return
    previousLocation.current = routeLocation.key
    const query = new URLSearchParams(routeLocation.search)
    const taskId = query.get('task')
    setSelectedId(taskId)
    setShowForm(!taskId && !query.get('automation'))
    setAutomationCaseId(query.get('automation'))
  }, [routeLocation.key, routeLocation.search])

  useEffect(() => { setNewSessionTaskId(null) }, [selectedId])

  useEffect(() => () => previewUrls.current.forEach((url) => URL.revokeObjectURL(url)), [])

  useEffect(() => {
    let alive = true
    let refreshing = false
    async function refresh() {
      if (refreshing) return
      refreshing = true
      setListLoading(true)
      try {
        const items: TaskSummary[] = []
        let cursor: string | undefined
        for (let pageIndex = 0; pageIndex < listPages; pageIndex++) {
          const query = new URLSearchParams({ limit: '50' })
          if (cursor) query.set('cursor', cursor)
          const page = await json<TaskListPage>(`/api/tasks?${query}`)
          if (alive) setServerBusy(page.busy)
          items.push(...page.items)
          cursor = page.nextCursor
          if (!cursor) break
        }
        if (alive) { setTasks([...new Map(items.map((task) => [task.id, task])).values()]); setNextCursor(cursor); setConnected(true) }
      } catch {
        if (alive) setConnected(false)
      } finally { refreshing = false; if (alive) setListLoading(false) }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), busy ? 2000 : 10_000)
    return () => { alive = false; clearInterval(timer) }
  }, [busy, listPages, refreshRevision])

  useEffect(() => {
    let alive = true
    let refreshing = false
    const controller = new AbortController()
    setSelectedTask(undefined)
    if (!selectedId) return
    async function refreshDetail() {
      if (refreshing) return
      refreshing = true
      const generation = ++detailGeneration.current
      try {
        const task = await json<CodingTask>(`/api/tasks/${encodeURIComponent(selectedId!)}`, { signal: controller.signal })
        if (alive && generation === detailGeneration.current) setSelectedTask(task)
      } catch (caught) {
        if (alive && !controller.signal.aborted) setError(caught instanceof Error ? caught.message : '无法读取任务详情')
      } finally { refreshing = false }
    }
    void refreshDetail()
    const timer = setInterval(() => void refreshDetail(), 2000)
    return () => { alive = false; controller.abort(); detailGeneration.current++; clearInterval(timer) }
  }, [selectedId])

  function acceptDetail(task: CodingTask) {
    detailGeneration.current++
    setSelectedTask((previous) => previous?.id === task.id ? task : previous)
    setRefreshRevision((value) => value + 1)
  }

  async function loadModels() {
    const generation = ++modelFetch.current
    setModelsLoading(true)
    try {
      const catalog = await json<ModelCatalog>('/api/copilot/models')
      if (generation === modelFetch.current) { setModelCatalog(catalog); setModelError('') }
    } catch (caught) {
      if (generation === modelFetch.current) { setModelCatalog(null); setModelError(caught instanceof Error ? caught.message : '无法获取模型') }
    } finally { if (generation === modelFetch.current) setModelsLoading(false) }
  }

  useEffect(() => {
    let cancelled = false
    const generation = ++modelFetch.current
    if (auth?.authenticated) {
      async function refresh() {
        try {
          const catalog = await json<ModelCatalog>('/api/copilot/models')
          if (!cancelled && generation === modelFetch.current) { setModelCatalog(catalog); setModelError(''); setModelsLoading(false) }
        } catch (caught) {
          if (!cancelled && generation === modelFetch.current) { setModelCatalog(null); setModelError(caught instanceof Error ? caught.message : '无法获取模型'); setModelsLoading(false) }
        }
      }
      void refresh()
    }
    return () => { cancelled = true }
  }, [auth?.authenticated, auth?.login])

  async function logout() {
    try {
      await signOut()
    } catch (caught) { setError(caught instanceof Error ? caught.message : '退出失败') }
  }

  const current = selectedTask?.id === selectedId ? {
    ...selectedTask, entries: history.items,
    modelHistory: [...new Map(history.items.flatMap((entry) => entry.modelChange ? [[entry.modelChange.revision, entry.modelChange] as const] : [])).values()],
  } : undefined
  const modelsPending = !!auth?.authenticated && !modelCatalog && !modelError
  const createModel = newModel ?? modelCatalog?.defaultModelId ?? 'auto'
  const selectable = (id: string, hasImages: boolean) => id === 'auto' || !!modelCatalog?.models.some((model) => model.id === id && model.policy !== 'disabled' && model.policy !== 'unconfigured' && (!hasImages || model.vision))

  async function changeModel(modelId: string) {
    if (!current || savingModel || modelId === current.modelId || !selectable(modelId, current.designNames.length > 0)) return
    setSavingModel(true); setError('')
    try {
      const updated = await json<CodingTask>(`/api/tasks/${current.id}/model`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId, expectedRevision: current.modelRevision || 0 }),
      })
      acceptDetail(updated)
    } catch (caught) { setError(caught instanceof Error ? caught.message : '无法更换模型') }
    finally { setSavingModel(false) }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!prd) { setError('请选择 PRD 文档'); return }
    setSubmitting(true); setError('')
    try {
      const form = new FormData()
      form.append('repository', repository)
      form.append('branch', branch)
      form.append('instruction', instruction)
      form.append('modelId', createModel)
      if (automationUrl.trim()) form.append('automationUrl', automationUrl.trim())
      form.append('prd', prd)
      designs.forEach(({ file }) => form.append('designs', file))
      const task = await json<CodingTask>('/api/tasks', { method: 'POST', body: form })
      setRefreshRevision((value) => value + 1)
      sessionStorage.setItem('codeflow_selected_task', task.id)
      setSelectedId(task.id); setShowForm(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '任务创建失败')
    }
    finally { setSubmitting(false) }
  }

  async function reply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!current || !answer.trim()) return
    setSendingAnswer(true); setError('')
    try {
      const updated = await json<CodingTask>(`/api/tasks/${current.id}/answer`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer: answer.trim() }),
      })
      acceptDetail(updated)
      setAnswer('')
    } catch (caught) { setError(caught instanceof Error ? caught.message : '提交回答失败') }
    finally { setSendingAnswer(false) }
  }

  async function resume(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!current || !guidance.trim()) return
    if ((!current.copilotSession || current.sessionRestoreError) && !allowNewSession) { setError(current.sessionRestoreError || '旧任务未保存 SDK 会话 ID，请先明确选择备用新会话恢复。'); return }
    setResuming(true); setError('')
    try {
      const updated = await json<CodingTask>(`/api/tasks/${current.id}/resume`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guidance: guidance.trim(), allowNewSession: allowNewSession && (!current.copilotSession || !!current.sessionRestoreError) }),
      })
      acceptDetail(updated)
      setGuidance('')
      setNewSessionTaskId(null)
    } catch (caught) { setError(caught instanceof Error ? caught.message : '无法继续任务') }
    finally { setResuming(false) }
  }

  async function acceptReview() {
    if (!current || !window.confirm('确认接受当前未通过或未执行的自测用例？这些结果仍会保留。')) return
    setAccepting(true); setError('')
    try {
      const updated = await json<CodingTask>(`/api/tasks/${current.id}/accept`, { method: 'POST' })
      acceptDetail(updated)
    } catch (caught) { setError(caught instanceof Error ? caught.message : '无法确认验收结果') }
    finally { setAccepting(false) }
  }

  async function startSelfTest(selectedCaseIds: string[] = [], options: SelfTestStartOptions = { intent: 'execute' }) {
    if (!current) return
    setStartingSelfTest(true); setError('')
    try {
      const updated = await json<CodingTask>(`/api/tasks/${current.id}/self-test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ automationUrl: automationUrl.trim() || current.automationUrl, selectedCaseIds, ...options }) })
      acceptDetail(updated)
      setNewSessionTaskId(null)
    } catch (caught) { setError(caught instanceof Error ? caught.message : '无法开始编码自测') }
    finally { setStartingSelfTest(false) }
  }

  async function publicationAction(action: 'refresh' | 'confirm' | 'skip', snapshot?: string) {
    if (!current || publishing) return
    setPublishing(true); setError('')
    try {
      const updated = await json<CodingTask>(`/api/tasks/${current.id}/publication/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'confirm' ? { snapshot } : action === 'skip' ? { skip: true } : {}),
      })
      acceptDetail(updated)
    } catch (caught) { setError(caught instanceof Error ? caught.message : '发布操作失败') }
    finally { setPublishing(false) }
  }

  async function startAutomation(task: TaskSummary, url: string) {
    setStartingAutomationId(task.id); setError('')
    try {
      const updated = await json<CodingTask>(`/api/tasks/${task.id}/self-test`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ automationUrl: url, intent: 'execute' }),
      })
      acceptDetail(updated)
    } catch (caught) { setError(caught instanceof Error ? caught.message : '无法启动自动化任务') }
    finally { setStartingAutomationId(null) }
  }

  function addDesigns(event: ChangeEvent<HTMLInputElement>) {
    const added = Array.from(event.target.files || []).slice(0, 6 - designs.length).map((file) => ({ file, url: URL.createObjectURL(file) }))
    previewUrls.current.push(...added.map(({ url }) => url))
    setDesigns((previous) => [...previous, ...added])
    event.target.value = ''
  }

  function removeDesign(index: number) {
    const url = designs[index].url
    URL.revokeObjectURL(url)
    previewUrls.current = previewUrls.current.filter((item) => item !== url)
    setDesigns((previous) => previous.filter((_, position) => position !== index))
  }

  function openTask(id: string) {
    sessionStorage.setItem('codeflow_selected_task', id)
    setAutomationCaseId(null)
    setAutomationUrl('')
    navigate(`/?task=${encodeURIComponent(id)}`)
    setSelectedId(id); setShowForm(false); setError(''); setAnswer(''); setGuidance('')
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <h2 className="sidebar-heading">任务记录</h2>
        <button className={`nav-item ${showForm ? 'active' : ''}`} onClick={() => { sessionStorage.removeItem('codeflow_selected_task'); navigate('/'); setAutomationCaseId(null); setAutomationUrl(''); setShowForm(true); setSelectedId(null); setError('') }}><Plus size={17} /> 新建任务</button>
        <div className="sidebar-label history-label">最近任务 <span>{tasks.length}</span></div>
        <div className="task-nav">
          {tasks.length === 0 && <p className="empty-nav">还没有任务</p>}
          {tasks.map((task) => <button key={task.id} className={`task-nav-item ${selectedId === task.id && !showForm ? 'selected' : ''}`} onClick={() => openTask(task.id)}><span className={`nav-state ${task.status.toLowerCase()}`} /><span className="task-nav-copy"><strong>{task.repository.split('/').at(-1)?.replace(/\.git$/, '')}</strong><small>{relativeTime(task.createdAt)} · {labels[task.status]}</small></span></button>)}
          {nextCursor && <button type="button" className="nav-item" disabled={listLoading} onClick={() => setListPages((value) => value + 1)}><Plus size={16} />更多任务</button>}
        </div>
        <div className="sidebar-bottom"><span className={`connection-dot ${connected ? '' : 'offline'}`} />{connected ? '本地服务已连接' : '无法连接后台服务'}</div>
      </aside>
      <div className="main-area">
        <header className="topbar"><span>工作台 <span className="crumb">/</span> {automationCaseId ? '自动化任务' : showForm ? '新建任务' : '任务详情'}</span><div className="topbar-right"><span className="local-badge"><span className="connection-dot" /> LOCAL</span><button className="auth-button" onClick={() => void logout()} title="退出 GitHub 登录"><LogOut size={15} />{auth.login || '已登录'}</button><span className="topbar-date">{new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date())}</span></div></header>
        <main className="content">
          {error && <div className="error-banner" role="alert"><CircleAlert size={18} />{error}<button aria-label="关闭提示" title="关闭提示" onClick={() => setError('')}><X size={16} /></button></div>}
          {auth && !auth.authenticated && <div className="auth-banner" role="status"><LogIn size={18} /><span>{auth.configured ? '开始编码前请先使用 GitHub 账号登录 Copilot。授权后会自动返回此工作台。' : '登录尚未配置：请在后台设置 GITHUB_CLIENT_ID 和 GITHUB_CLIENT_SECRET。'}</span>{auth.configured && <button onClick={login}>前往登录 <ArrowRight size={15} /></button>}</div>}
          {automationCaseId === 'overview' ? <AutomationDashboard tasks={tasks} onStart={(task, url) => void startAutomation(task, url)} onOpenRun={(taskId, caseId) => { setSelectedId(taskId); setAutomationCaseId(caseId); navigate(`/?task=${encodeURIComponent(taskId)}&automation=${encodeURIComponent(caseId)}`) }} startingId={startingAutomationId} busy={busy} authenticated={!!auth?.authenticated} /> : automationCaseId && current ? <AutomationTaskDetail taskId={current.id} caseId={automationCaseId} runs={current.automationRuns || []} onBack={() => { setAutomationCaseId('overview'); navigate('/?automation=overview') }} /> : showForm ? <div className="page-wrap">
            <div className="page-heading"><h1>启动编码任务</h1></div>
            <div className="layout-grid new-task-layout"><form className="form-pane" onSubmit={(event) => void submit(event)}>
              <section className="form-section"><div className="section-title"><span className="section-index">01</span><div><h2>代码来源</h2><p>支持 GitHub HTTPS 和 code.sunmi.com 仓库</p></div></div>
                <label className="field-label" htmlFor="repository">仓库地址 <span>*</span></label><div className="input-icon"><FolderGit2 size={18} /><input id="repository" type="url" placeholder="http://code.sunmi.com/FE/tmp.git" value={repository} onChange={(event) => setRepository(event.target.value)} required /></div>
                <label className="field-label" htmlFor="branch">源分支 <em>选填，默认仓库分支；克隆后自动新建本地任务分支</em></label><div className="input-icon"><GitBranch size={18} /><input id="branch" placeholder="main" value={branch} onChange={(event) => setBranch(event.target.value)} /></div>
              </section>
              <section className="form-section"><div className="section-title"><span className="section-index">02</span><div><h2>需求与设计</h2><p>让 Copilot 获得准确的任务上下文</p></div></div>
                <label className="field-label" htmlFor="instruction">编码目标 <span>*</span></label><textarea id="instruction" className="instruction-input" placeholder="例如：根据 PRD 实现用户登录与注册页面，参照设计图还原布局和交互，并补充必要的测试。" value={instruction} onChange={(event) => setInstruction(event.target.value)} minLength={5} maxLength={5000} required />
                <div className="field-label model-label">Copilot 模型</div><ModelPicker label="新任务 Copilot 模型" value={createModel} models={modelCatalog?.models} hasImages={designs.length > 0} disabled={modelsLoading || modelsPending || !auth?.authenticated || !modelCatalog} onSelect={setNewModel} />
                <div className="model-hint">{modelsLoading || modelsPending ? '正在获取当前账号可用模型…' : modelError ? <span>{modelError}；可主动选择自动模式。 <button type="button" onClick={() => setNewModel('auto')}>使用自动选择</button> <button type="button" onClick={() => void loadModels()}><RefreshCw size={13} />重试</button></span> : '费用仅在 Copilot 提供相对计费倍率时显示，不估算实际金额。'}</div>
                <label className="field-label" htmlFor="automation-url">本机预览地址 <em>选填，需先启动应用才能进行无头浏览器测试与截图</em></label><div className="input-icon"><input id="automation-url" type="url" placeholder="http://127.0.0.1:4173" value={automationUrl} onChange={(event) => setAutomationUrl(event.target.value)} /></div>
                <div className="upload-grid"><div><span className="field-label">PRD 文档 <span>*</span></span><label className={`upload-box ${prd ? 'has-file' : ''}`}><input type="file" accept=".md,.txt,.pdf" onChange={(event) => setPrd(event.target.files?.[0] || null)} /><FileText size={22} /><strong>{prd ? prd.name : '选择 PRD 文档'}</strong><small>MD、TXT 或 PDF · 最大 12 MB</small></label></div><div><span className="field-label">设计截图 <em>选填，最多 6 张</em></span><label className="upload-box"><input type="file" accept=".png,.jpg,.jpeg,.webp" multiple onChange={addDesigns} disabled={designs.length >= 6} /><ImagePlus size={22} /><strong>添加设计图</strong><small>PNG、JPG 或 WebP</small></label></div></div>
                {designs.length > 0 && <div className="design-list">{designs.map(({ file, url }, index) => <div className="design-thumb" key={url}><img src={url} alt={file.name} /><span title={file.name}>{file.name}</span><button type="button" title="移除图片" aria-label={`移除 ${file.name}`} onClick={() => removeDesign(index)}><X size={13} /></button></div>)}</div>}
              </section>
              <div className="form-footer"><span><Check size={16} />只有确认后才会提交并推送任务分支</span><button type="submit" className="primary-button" disabled={submitting || busy || !connected || !auth?.authenticated || modelsLoading || modelsPending || (!!modelError && newModel === null) || !selectable(createModel, designs.length > 0)}>{submitting ? <LoaderCircle className="spin" size={17} /> : <ArrowRight size={17} />}{busy ? '请先完成当前任务' : submitting ? '正在创建…' : '拉取并开始编码'}</button></div>
            </form></div>
          </div> : current ? <div className="page-wrap">
            <div className="page-heading"><div><p className="eyebrow">RUN <span> / {current.id.slice(0, 8).toUpperCase()}</span></p><h1>{current.repository.split('/').at(-1)?.replace(/\.git$/, '')}</h1><p className="heading-note">{current.repository} {current.branch && `· ${current.branch}`}</p></div><span className={`status-pill ${current.status.toLowerCase()}`}>{['CLONING', 'CODING', 'VERIFYING', 'SELF_TEST', 'TEST_EXECUTION'].includes(current.status) && <LoaderCircle className="spin" size={15} />}{current.status === 'SELF_TEST' ? selfTestStageLabel(current) : labels[current.status]}</span></div>
            <div className="layout-grid"><div className="run-main"><div className="stage-bar">{phases.map((phase, index) => { const last = current.entries.at(-1); const failedStage = last?.stage === 'VERIFYING' ? 'CODING' : last?.stage || 'CODING'; const reviewStage = current.entries.some((entry) => entry.stage === 'TEST_EXECUTION') ? 'TEST_EXECUTION' : 'SELF_TEST'; const currentStage = current.status === 'FAILED' ? failedStage : current.status === 'ACCEPTED' ? 'SUCCESS' : current.status === 'REVIEW' ? reviewStage : current.status === 'NEEDS_INPUT' ? last?.stage === 'SELF_TEST' || last?.stage === 'TEST_EXECUTION' ? last.stage : 'CODING' : current.status === 'VERIFYING' ? 'CODING' : current.status === 'QUEUED' ? 'CLONING' : current.status; const position = phases.findIndex((item) => item.id === currentStage); const done = current.status === 'SUCCESS' || index < position; return <div className={`stage ${done ? 'done' : ''} ${index === position ? current.status === 'FAILED' ? 'failed' : 'current' : ''}`} key={phase.id}><span>{done ? <Check size={14} /> : index === position && current.status === 'FAILED' ? <CircleAlert size={14} /> : String(index + 1).padStart(2, '0')}</span><small>{phase.title}</small></div> })}</div>
              {['FAILED', 'REVIEW', 'SUCCESS', 'ACCEPTED'].includes(current.status) && (!current.copilotSession || current.sessionRestoreError) && <section className="session-recovery" aria-label="会话恢复"><p role={current.sessionRestoreError ? 'alert' : undefined}>{current.sessionRestoreError || '旧任务未保存 SDK 会话 ID，无法自动恢复原会话。'}</p><label><input type="checkbox" checked={allowNewSession} onChange={(event) => setNewSessionTaskId(event.target.checked ? current.id : null)} />使用历史记录开启新会话（不恢复 SDK 完整历史）</label></section>}
              {current.question && <section className="question-panel"><div className="question-caption"><MessageSquareText size={18} /> 需要你的确认</div><h2>{current.question.text}</h2><form onSubmit={(event) => void reply(event)}>{current.question.choices && <div className="choice-list">{current.question.choices.map((choice) => <button type="button" className={answer === choice ? 'choice selected' : 'choice'} key={choice} onClick={() => setAnswer(choice)}>{choice}{answer === choice && <Check size={16} />}</button>)}</div>}{current.question.allowFreeform && <textarea aria-label="回复 Copilot" placeholder="输入你的决定或补充说明…" value={answer} onChange={(event) => setAnswer(event.target.value)} maxLength={3000} />}<button className="primary-button" type="submit" disabled={!answer.trim() || sendingAnswer}>{sendingAnswer ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}发送回答</button></form></section>}
              {current.status === 'FAILED' && current.error && <div className="failure-panel"><CircleAlert size={19} /><div><strong>任务未完成</strong><p>{current.error}</p></div></div>}{['FAILED', 'REVIEW'].includes(current.status) && current.workspace && <form className="resume-panel" onSubmit={(event) => void resume(event)}><label htmlFor="resume-guidance">补充说明并继续</label><textarea id="resume-guidance" value={guidance} onChange={(event) => setGuidance(event.target.value)} placeholder="说明如何处理自测失败的用例，或指示 Copilot 继续完成改动" maxLength={3000} required /><button type="submit" className="primary-button" disabled={!guidance.trim() || resuming || busy || !auth?.authenticated}>{resuming ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}继续任务</button></form>}{current.status === 'SUCCESS' && <div className="success-panel"><CheckCircle2 size={19} /><div><strong>编码已完成</strong><p>{current.publication?.pushedAt ? `编码变更已推送至 ${current.createdBranch}；后续测试文件仍在本地。` : '变更保留在本地工作目录，未推送到远端。'}</p></div></div>}
              {current.status === 'PUBLISH_PENDING' && <PublicationPanel task={current} onAction={publicationAction} />}
              <TestingLinks key={current.id} task={current} onSaved={async () => acceptDetail(await json<CodingTask>(`/api/tasks/${encodeURIComponent(current.id)}`))} />
              <SelfTestResults task={current} onAccept={() => void acceptReview()} accepting={accepting} onStart={(ids, options) => void startSelfTest(ids, options)} starting={startingSelfTest} previewUrl={automationUrl} onPreviewUrlChange={setAutomationUrl} onBindingSaved={async () => acceptDetail(await json<CodingTask>(`/api/tasks/${encodeURIComponent(current.id)}`))} />
              <ActivitySection task={current} history={history} />
            </div><aside className="details-pane"><div className="detail-head"><h2>任务信息</h2><span>#{current.id.slice(0, 8)}</span></div><div className="detail-block"><small>编码目标</small><p>{current.instruction}</p></div><div className="detail-block model-detail"><small>Copilot 模型</small><p>{current.modelInTurn ? '当前对话' : '最近对话'}：{current.activeModelId === 'auto' ? '自动选择' : current.activeModelId || '尚未开始'}</p><p>下次对话：{current.modelId === 'auto' ? '自动选择' : current.modelId || '历史任务（未记录）'}</p>{(current.modelRevision || 0) > (current.appliedModelRevision || 0) && <p className="model-pending">{current.modelInTurn ? '待本次对话结束后生效' : '将在下次对话生效'}</p>}<div className="model-choice"><span>更换模型</span><ModelPicker label="更换任务模型" value={current.modelId || 'auto'} models={modelCatalog?.models} hasImages={current.designNames.length > 0} disabled={savingModel || !auth?.authenticated || !modelCatalog} loading={savingModel} onSelect={(modelId) => void changeModel(modelId)} /></div>{!!current.modelHistory?.length && <details><summary>模型变更记录</summary>{current.modelHistory.map((change) => <p key={change.revision}>{relativeTime(change.at)} · {change.from} → {change.to} · {change.appliedAt ? '已生效' : change.supersededAt ? '已被后续选择替代' : '待生效'}</p>)}</details>}{modelError && <div className="model-hint">{modelError} <button type="button" onClick={() => void loadModels()}><RefreshCw size={13} />重试</button></div>}</div><div className="detail-block"><small>输入材料</small><p><FileText size={15} />{current.prdName}</p>{current.designNames.map((name, index) => <p key={index}><ImagePlus size={15} />{name}</p>)}</div><div className="detail-block"><small>本地目录</small><p className="path-text">{current.workspace || '等待仓库拉取'}</p></div>{current.changes && <FileChanges key={current.id} task={current} />}<div className="detail-foot">{relativeTime(current.createdAt)} 创建</div></aside></div>
          </div> : <div className="page-wrap"><p>任务不存在，请从左侧选择任务。</p></div>}
        </main>
      </div>
    </div>
  )
}

export default CodingWorkspace