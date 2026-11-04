import * as React from 'react'
import { useParams } from 'react-router-dom'
import { Check, Download, FileText, Maximize2, PanelLeft, Play, Plus, RefreshCw, Save, Square, Upload, X } from 'lucide-react'
import type { RequirementProject, RequirementJobStage, StructuredPrd } from '../../../shared/requirements'
import { ModelPicker } from '../../components/ModelPicker'
import type { ModelOption } from '../../components/ModelPicker'
import { FilterSelect } from '../../components/FilterSelect'
import { useNavigation } from '../../app/navigation'
import { invalidateAuth } from '../auth/auth-session'
import { PrdReview } from './PrdReview'
import { DesignReview } from './DesignReview'
import { CodeDirectoryInput } from './CodeDirectoryInput.tsx'
import { RemoteCodeInput } from './RemoteCodeInput'
import { readCodeSnapshot } from './code-directory'

const root = '/api/requirements/projects'
const stages: Record<RequirementJobStage, string> = { analyze: '分析需求', prd: '生成 PRD', design: '生成设计', validate: '验证设计' }
const statuses: Record<RequirementProject['status'], string> = { draft: '草稿', running: '运行中', needs_input: '待补充', prd_review: 'PRD 待审核', design_review: '设计待审核', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' }
const jobStatuses = { running: '运行中', succeeded: '成功', failed: '失败', cancelled: '已取消', interrupted: '已中断' }

async function request<Value>(path: string, signal: AbortSignal, body?: unknown, method = 'POST'): Promise<Value> {
  const form = body instanceof FormData
  const response = await fetch(path, { signal, credentials: 'same-origin', ...(body === undefined ? {} : { method, ...(form ? {} : { headers: { 'Content-Type': 'application/json' } }), body: form ? body : JSON.stringify(body) }) })
  if (response.status === 401) invalidateAuth()
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : `请求失败 (${response.status})`)
  if (data === null) throw new Error('服务端未返回有效 JSON')
  return data as Value
}

function readAnswers(project: RequirementProject): Record<string, string> {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(`requirements:answers:${project.ownerId}:${project.id}`) || '{}')
    if (!value || typeof value !== 'object') return {}
    return Object.fromEntries(Object.entries(value).filter(([id, answer]) => project.questions.some(item => item.id === id) && typeof answer === 'string'))
  } catch { return {} }
}

export default function RequirementsWorkspace() {
  const { projectId = '' } = useParams<{ projectId: string }>()
  return <RequirementsPage key={projectId || 'new'} projectId={projectId} />
}

function RequirementsPage({ projectId }: { projectId: string }) {
  const navigate = useNavigation()
  const [historyOpen, setHistoryOpen] = React.useState(false)
  const historyRail = React.useRef<HTMLElement>(null)
  const historyTrigger = React.useRef<HTMLButtonElement>(null)
  const [projects, setProjects] = React.useState<RequirementProject[]>([])
  const [project, setProject] = React.useState<RequirementProject>()
  const [catalog, setCatalog] = React.useState<{ defaultModelId: string; models: ModelOption[] }>()
  const [modelError, setModelError] = React.useState('')
  const [modelId, setModelId] = React.useState('')
  const [title, setTitle] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [files, setFiles] = React.useState<File[]>([])
  const [url, setUrl] = React.useState('')
  const [previewOrigin, setPreviewOrigin] = React.useState('')
  const [captureNote, setCaptureNote] = React.useState('')
  const [loginPromptOpen, setLoginPromptOpen] = React.useState(false)
  const loginDialog = React.useRef<HTMLDialogElement>(null)
  const loginTrigger = React.useRef<HTMLButtonElement>(null)
  const [instruction, setInstruction] = React.useState('')
  const [answers, setAnswers] = React.useState<Record<string, string>>({})
  const [storageError, setStorageError] = React.useState('')
  const [revisionId, setRevisionId] = React.useState('')
  const [selectedId, setSelectedId] = React.useState('')
  const [adjustedPage, setAdjustedPage] = React.useState<{ title: string; state: string }>()
  const [reading, setReading] = React.useState({ revisionId: '', requirementId: '' })
  const [editing, setEditing] = React.useState(false)
  const [split, setSplit] = React.useState(70)
  const [wideReview, setWideReview] = React.useState(false)
  const reviewDialog = React.useRef<HTMLDialogElement>(null)
  const reviewTrigger = React.useRef<HTMLButtonElement>(null)
  const restoreReviewFocus = React.useRef(false)
  const [mobileView, setMobileView] = React.useState('prd')
  const [busy, setBusy] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState('')
  const [synced, setSynced] = React.useState(false)
  const scope = React.useRef<AbortController | null>(null)
  const lock = React.useRef(false)
  const fileInput = React.useRef<HTMLInputElement>(null)
  const savedAnswers = React.useRef(false)
  const revision = project?.revisions.find(item => item.id === revisionId) || project?.revisions.at(-1)
  const latest = project?.revisions.at(-1)
  const validation = revision?.validation as (NonNullable<typeof revision>['validation'] & {
    artifactVersion?: number; allScreensValidated?: boolean; interactionVerified?: boolean; mode?: string
    screens?: { screenId: string; visual: string; interaction: string }[]; limitations?: unknown
  }) | undefined
  const staticValidated = !!revision?.screens.length && !!validation && !validation.errors.length && validation.artifactVersion === 1 && validation.allScreensValidated === true && validation.interactionVerified === false && validation.mode === 'static-script-disabled' && validation.screens?.length === revision.screens.length && revision.screens.every(screen => validation.screens?.some(check => check.screenId === screen.id && check.visual === 'passed' && check.interaction === 'not_verified'))
  const historical = !!revision && revision.id !== latest?.id
  const lastJob = project?.jobs.at(-1)
  const runningJob = project?.jobs.find(item => item.status === 'running')
  const running = !!runningJob || project?.status === 'running'
  const loginInteraction = runningJob?.interaction
  const captureNeedsInput = lastJob?.status === 'failed' && /\[(?:PAGE_CAPTURE(?:_[A-Z]+)?|PAGE_MAPPING|DESIGN_STYLE_EVIDENCE)\]/.test(lastJob.error || '')
  const disabled = busy || running || historical || editing || !synced
  const endpoint = `${root}/${encodeURIComponent(projectId)}`
  const unresolved = project?.questions.filter(question => !project.decisions.some(item => item.question.id === question.id)) || []
  const analysis = project?.jobs.findLast(item => item.stage === 'analyze' && item.status === 'succeeded')
  const analyzed = !!project && !!analysis && project.events.findLastIndex(event => event.text === `analysis:${analysis.id}`) > project.events.findLastIndex(event => event.text === 'inputs:changed')
  React.useEffect(() => { setPreviewOrigin(project?.preview?.origin || '') }, [project?.preview?.origin])
  React.useEffect(() => { setLoginPromptOpen(!!loginInteraction) }, [loginInteraction?.expiresAt])
  React.useLayoutEffect(() => {
    const dialog = loginDialog.current
    if (!dialog || !loginInteraction) return
    if (loginPromptOpen && !dialog.open) dialog.showModal()
    if (!loginPromptOpen) { if (dialog.open) dialog.close(); loginTrigger.current?.focus() }
    return () => { if (dialog.open) dialog.close() }
  }, [loginPromptOpen, loginInteraction?.expiresAt])

  React.useLayoutEffect(() => {
    const dialog = reviewDialog.current
    if (!dialog) return
    dialog.close()
    if (!wideReview) {
      dialog.show()
      if (restoreReviewFocus.current) { reviewTrigger.current?.focus({ preventScroll: true }); restoreReviewFocus.current = false }
      return
    }
    restoreReviewFocus.current = true
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialog.showModal()
    return () => {
      dialog.close()
      document.body.style.overflow = overflow
    }
  }, [wideReview, !!revision])

  React.useEffect(() => {
    if (!selectedId) return
    const clearSelection = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || event.target.closest('.requirements-preview, .requirements-prd-pane, .requirements-mobile-switch, [data-review-toggle]')) return
      setSelectedId('')
    }
    document.addEventListener('click', clearSelection)
    return () => document.removeEventListener('click', clearSelection)
  }, [selectedId])

  React.useEffect(() => {
    if (!historyOpen) return
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !historyRail.current?.contains(event.target)) setHistoryOpen(false)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [historyOpen])

  const acceptProject = React.useEffectEvent((value: RequirementProject) => {
    if (value.id !== projectId) throw new Error('服务端项目与当前地址不匹配')
    if (project && value.version < project.version) return
    if (revisionId === project?.revisions.at(-1)?.id && value.revisions.at(-1)?.id !== revisionId) setRevisionId('')
    setProject(previous => previous && previous.version > value.version ? previous : value)
    setProjects(previous => previous.map(item => item.id === value.id ? value : item))
    setSynced(true)
    if (!savedAnswers.current) { setAnswers(readAnswers(value)); savedAnswers.current = true }
  })
  const refresh = React.useEffectEvent(async (signal: AbortSignal) => {
    try { acceptProject(await request<RequirementProject>(endpoint, signal)) }
    catch (caught) { if (!signal.aborted) setSynced(false); throw caught }
  })
  React.useEffect(() => {
    const controller = new AbortController(); scope.current = controller
    void request<RequirementProject[]>(root, controller.signal).then(value => { if (!controller.signal.aborted) setProjects(value) }).catch(caught => { if (!controller.signal.aborted) setError(caught.message) })
    void request<{ defaultModelId: string; models: ModelOption[] }>('/api/copilot/models', controller.signal).then(value => { if (!controller.signal.aborted) setCatalog(value) }).catch(caught => { if (!controller.signal.aborted) setModelError(caught.message) })
    if (projectId) void refresh(controller.signal).catch(caught => { if (!controller.signal.aborted) setError(caught.message) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    else setLoading(false)
    return () => { controller.abort() }
  }, [projectId])
  React.useEffect(() => {
    if (!running) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try { await refresh(controller.signal); if (!controller.signal.aborted) setError('') }
      catch (caught) { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : '刷新失败') }
      if (!controller.signal.aborted) timer = setTimeout(() => { void poll() }, 2500)
    }
    timer = setTimeout(() => { void poll() }, 2500)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [running])
  React.useEffect(() => {
    if (!project || !savedAnswers.current) return
    try { sessionStorage.setItem(`requirements:answers:${project.ownerId}:${project.id}`, JSON.stringify(answers)); setStorageError('') }
    catch { setStorageError('浏览器无法保存临时答案，请在离开前提交。') }
  }, [answers, project])

  async function action(work: (signal: AbortSignal) => Promise<void>) {
    if (lock.current || !scope.current || scope.current.signal.aborted) return
    lock.current = true; setBusy(true); setError('')
    const signal = scope.current.signal
    try { await work(signal) }
    catch (caught) { if (!signal.aborted) { setError(caught instanceof Error ? caught.message : '请求失败'); throw caught } }
    finally { lock.current = false; if (!signal.aborted) setBusy(false) }
  }
  function run(work: (signal: AbortSignal) => Promise<void>) { void action(work).catch(() => {}) }
  async function mutate(path: string, body: Record<string, unknown>, signal: AbortSignal, method = 'POST') {
    if (!project) return
    try { await request(`${endpoint}${path}`, signal, { ...body, version: project.version }, method) }
    catch (caught) { await refresh(signal).catch(() => {}); throw caught }
    await refresh(signal)
  }
  function job(stage: RequirementJobStage) { run(signal => mutate('/jobs', { stage, ...(stage === 'analyze' && instruction.trim() ? { instruction: instruction.trim() } : {}) }, signal)) }
  function go(event: React.MouseEvent<HTMLAnchorElement>, path: string) {
    if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
    if (editing && !window.confirm('尚有未保存的 PRD 编辑，确认离开？')) { event.preventDefault(); return }
    event.preventDefault(); navigate(path)
  }
  const selectedModel = modelId || catalog?.defaultModelId || 'auto'
  const modelAvailable = !!catalog && (selectedModel === 'auto' || catalog.models.some(item => item.id === selectedModel && !['disabled', 'unconfigured'].includes(item.policy || '')))
  return <main className="requirements-workspace">
    <header className="requirements-heading"><h1>需求工作区</h1><a href="/requirements" onClick={event => go(event, '/requirements')}><Plus size={16} />新建项目</a></header>
    <div className="requirements-layout">
      <aside ref={historyRail} className="requirements-history-rail" aria-label="需求项目" onPointerLeave={() => { if (!historyRail.current?.contains(document.activeElement)) setHistoryOpen(false) }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setHistoryOpen(false) }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); historyTrigger.current?.focus(); setHistoryOpen(false) } }}>
        <button ref={historyTrigger} className="requirements-history-trigger" aria-label="项目记录" title="项目记录" aria-expanded={historyOpen} aria-controls="requirements-project-history" onPointerEnter={event => { if (event.pointerType === 'mouse') setHistoryOpen(true) }} onClick={() => setHistoryOpen(value => !value)}><PanelLeft size={16} /></button>
        <div id="requirements-project-history" className="requirements-history" hidden={!historyOpen}><h2>项目</h2><button disabled={busy} aria-label="刷新项目列表" title="刷新项目列表" onClick={() => run(async signal => { setProjects(await request<RequirementProject[]>(root, signal)); if (projectId) await refresh(signal) })}><RefreshCw size={16} /></button>
        {!projects.length && <p>暂无项目</p>}{projects.map(item => <a key={item.id} href={`/requirements/${encodeURIComponent(item.id)}`} aria-current={projectId === item.id ? 'page' : undefined} onClick={event => go(event, `/requirements/${encodeURIComponent(item.id)}`)}><strong>{item.title}</strong><span>{statuses[item.status]}</span></a>)}
        </div>
      </aside>
      <div className="requirements-body" aria-busy={loading || busy}>
        {error && <div className="requirements-error" role="alert">{error}<button disabled={busy} onClick={() => run(async signal => { if (projectId) await refresh(signal); else setProjects(await request<RequirementProject[]>(root, signal)) })}><RefreshCw size={15} />重新读取</button></div>}
        {loading && <p role="status">正在读取项目…</p>}
        {!projectId && <form className="requirements-create" onSubmit={event => { event.preventDefault(); run(async signal => { const created = await request<RequirementProject>(root, signal, { title: title.trim(), description: description.trim(), modelId: selectedModel }); navigate(`/requirements/${encodeURIComponent(created.id)}`) }) }}>
          <h2>新建需求项目</h2><fieldset disabled={busy}><label>项目名称<input required maxLength={200} value={title} onChange={event => setTitle(event.target.value)} /></label><label>需求描述<textarea required rows={8} value={description} onChange={event => setDescription(event.target.value)} /></label><div className="requirements-model"><span>Copilot 模型</span><ModelPicker label="需求项目模型" value={selectedModel} models={catalog?.models} hasImages={false} loading={!catalog && !modelError} disabled={busy || !catalog} onSelect={setModelId} /></div>{modelError && <p role="alert">{modelError}<button type="button" onClick={() => run(async signal => { setCatalog(await request('/api/copilot/models', signal)); setModelError('') })}><RefreshCw size={15} />重试模型目录</button></p>}<button type="submit" disabled={!title.trim() || !description.trim() || !modelAvailable}><Plus size={16} />创建项目</button></fieldset>
        </form>}
        {project && <>
          <section aria-label="项目概况"><div className="requirements-toolbar"><h2>{project.title}</h2><span role="status">{statuses[project.status]} · v{project.version}</span></div><p className="requirements-prewrap">{project.description}</p><small>模型：{catalog?.models.find(item => item.id === project.modelId)?.name || project.modelId}</small>
            <div className="requirements-toolbar requirements-stage-actions">
              <button disabled={disabled || !['draft', 'needs_input', 'failed', 'cancelled', 'interrupted'].includes(project.status) || unresolved.length > 0} onClick={() => job('analyze')}><Play size={15} />分析需求</button>
              <button disabled={disabled || unresolved.length > 0 || !analyzed} onClick={() => job('prd')}><FileText size={15} />生成 PRD</button>
              <button disabled={disabled || !analyzed || unresolved.length > 0 || !latest || !!latest.confirmedAt} onClick={() => run(signal => mutate('/confirm', { target: 'prd' }, signal))}><Check size={15} />确认 PRD</button>
              <button disabled={disabled || !analyzed || unresolved.length > 0 || !latest?.confirmedAt} onClick={() => job('design')}><Play size={15} />生成设计</button>
              <button disabled={disabled || !analyzed || unresolved.length > 0 || !latest?.confirmedAt || !latest.screens.length} onClick={() => job('validate')}><Check size={15} />检查静态设计</button>
              <button disabled={disabled || !analyzed || unresolved.length > 0 || !latest?.confirmedAt || !staticValidated || !!latest.designConfirmedAt} onClick={() => run(signal => mutate('/confirm', { target: 'design' }, signal))}><Check size={15} />确认设计</button>
              {runningJob && <button disabled={busy || !synced} onClick={() => run(signal => mutate(`/jobs/${encodeURIComponent(runningJob.id)}/cancel`, {}, signal))}><Square size={15} />取消任务</button>}
            </div>
            {running && <div className="requirements-progress" role="status"><progress aria-label={runningJob ? stages[runningJob.stage] : '任务运行中'} />{runningJob ? stages[runningJob.stage] : '任务运行中'} · {project.events.at(-1)?.text || '等待进度'}{runningJob && <time dateTime={runningJob.startedAt}>{new Date(runningJob.startedAt).toLocaleString()}</time>}</div>}
            {loginInteraction && <>
              <p role="status">等待人工登录 · {loginInteraction.origin} · 截止 {new Date(loginInteraction.expiresAt).toLocaleTimeString()}</p>
              <button ref={loginTrigger} type="button" onClick={() => setLoginPromptOpen(true)}><Play size={15} />处理登录请求</button>
              <dialog ref={loginDialog} className="requirements-login-dialog" aria-labelledby="requirements-login-heading" onCancel={event => { event.preventDefault(); setLoginPromptOpen(false) }}>
                <div className="requirements-toolbar"><h3 id="requirements-login-heading">需要你完成系统登录</h3><button type="button" aria-label="收起登录提示" title="收起登录提示" onClick={() => setLoginPromptOpen(false)}><X size={15} /></button></div>
                <p>{loginInteraction.origin}</p>
                <p>专用 Chrome 窗口将在 API 所在机器打开，请直接在该窗口完成登录。密码、验证码和会话不会交给设计模型。关闭提示不会取消任务。</p>
                <p>仅允许目标系统同源认证；跳转其他 OA 域名暂未授权，可使用该系统提供的同源登录方式。远程服务无法在你的电脑打开窗口。</p>
                <p>有效期至 <time dateTime={loginInteraction.expiresAt}>{new Date(loginInteraction.expiresAt).toLocaleString()}</time>，取消或超时后会话会被清理。</p>
                <div className="requirements-toolbar">
                  {loginInteraction.phase === 'ready' ? <button autoFocus disabled={busy || !synced} onClick={() => run(signal => mutate(`/jobs/${encodeURIComponent(runningJob!.id)}/login`, { action: 'open' }, signal))}><Play size={15} />打开登录窗口</button> : <button autoFocus disabled={busy || !synced} onClick={() => run(signal => mutate(`/jobs/${encodeURIComponent(runningJob!.id)}/login`, { action: 'continue' }, signal))}><Check size={15} />我已完成登录，继续取证</button>}
                  <button disabled={busy || !synced} onClick={() => run(signal => mutate(`/jobs/${encodeURIComponent(runningJob!.id)}/cancel`, {}, signal))}><Square size={15} />取消取证</button>
                </div>
                {error && <p role="alert">{error}</p>}
              </dialog>
            </>}
            {lastJob?.error && <p role="alert">{stages[lastJob.stage]} · {lastJob.error}</p>}
            {captureNeedsInput && <section aria-label="取证待补充">
              <h3>取证待补充</h3>
              <p>{lastJob?.error?.includes('PAGE_CAPTURE_LOGIN') ? '目标系统需要登录，当前独立取证浏览器没有登录会话。仅在你自己的浏览器登录不会同步到平台。' : '本次取证已停止，请根据失败原因补充页面访问信息。'}</p>
              <form onSubmit={event => { event.preventDefault(); run(signal => mutate('/preview', { origin: previewOrigin.trim() }, signal, 'PATCH')) }}>
                <fieldset disabled={disabled}><label>修正取证地址<input type="url" required aria-label="修正取证地址" maxLength={200} value={previewOrigin} onChange={event => setPreviewOrigin(event.target.value)} /></label><button type="submit"><Save size={15} />保存地址</button></fieldset>
              </form>
              <form onSubmit={event => {
                event.preventDefault()
                run(async signal => {
                  if (/\b(?:password|passwd|cookie|authorization|access[_-]?token|secret)\s*[:=]|(?:密码|令牌)\s*[:：=]/i.test(captureNote)) throw new Error('请移除密码、Cookie、令牌或其他凭据，只提交非敏感访问说明')
                  const form = new FormData()
                  form.set('version', String(project.version))
                  form.append('files', new File([captureNote.trim()], 'capture-access-notes.txt', { type: 'text/plain' }))
                  try { await request(`${endpoint}/sources`, signal, form) } catch (caught) { await refresh(signal).catch(() => {}); throw caught }
                  await refresh(signal); setCaptureNote('')
                })
              }}><fieldset disabled={disabled}><label>页面访问补充说明<textarea aria-label="页面访问补充说明" required maxLength={8000} rows={4} value={captureNote} onChange={event => setCaptureNote(event.target.value)} /></label>
                <p>仅填写路由、登录要求、依赖域名或读取接口说明，不要填写密码、Cookie 或令牌。提交后需重新分析需求并确认 PRD；不会自动开放跨域访问或恢复登录。</p>
                <button type="submit" disabled={!captureNote.trim()}><Upload size={15} />提交补充资料</button></fieldset></form>
              <button type="button" disabled={disabled || !analyzed || unresolved.length > 0} onClick={() => job('prd')}><RefreshCw size={15} />重新取证并生成 PRD</button>
            </section>}
          </section>
          <section aria-label="需求资料"><h2>需求资料</h2><ul>{project.sources.map(source => <li key={source.id}><strong>{source.name}</strong>{source.kind === 'file' && source.name === 'existing-project-code.md' && <small> · 代码快照（只读）</small>} · {source.kind === 'file' ? `${source.sizeBytes} B` : source.url}<small> · {source.id}</small></li>)}</ul>
            <form onSubmit={event => { event.preventDefault(); run(signal => mutate('/preview', { origin: previewOrigin.trim() }, signal, 'PATCH')) }}>
              <fieldset disabled={disabled}><label>现有系统地址<input type="url" aria-label="现有系统地址" placeholder="http://localhost:5173" maxLength={200} value={previewOrigin} onChange={event => setPreviewOrigin(event.target.value)} /></label>
                <div className="requirements-toolbar"><button type="submit" disabled={!previewOrigin.trim()}><Save size={15} />保存取证地址</button>{project.preview && <><button type="button" onClick={() => run(signal => mutate('/preview', { origin: project.preview!.origin }, signal, 'PATCH'))}><RefreshCw size={15} />下次重新取证</button><button type="button" onClick={() => run(signal => mutate('/preview', { origin: '' }, signal, 'PATCH'))}><X size={15} />停用取证</button></>}</div>
              </fieldset>
              {project.preview && <p role="status">{project.preview.origin} · 取证版本 {project.preview.generation}</p>}
            </form>
            <CodeDirectoryInput disabled={disabled} onAdd={selection => action(async signal => { const snapshot = await readCodeSnapshot(selection, signal); await mutate('/code-snapshot', { files: snapshot }, signal) })} />
            <RemoteCodeInput disabled={disabled} onAdd={selection => action(signal => mutate('/remote-code-snapshot', selection, signal))} />
            <form onSubmit={event => { event.preventDefault(); run(async signal => { const form = new FormData(); form.set('version', String(project.version)); files.forEach(file => form.append('files', file)); try { await request(`${endpoint}/sources`, signal, form) } catch (caught) { await refresh(signal).catch(() => {}); throw caught } await refresh(signal); setFiles([]); if (fileInput.current) fileInput.current.value = '' }) }}><fieldset disabled={disabled}><label>补充文件<input ref={fileInput} type="file" multiple onChange={event => setFiles(Array.from(event.target.files || []))} /></label>{files.length > 0 && <ul>{files.map((file, index) => <li key={`${file.name}:${index}`}>{file.name}</li>)}</ul>}<button disabled={!files.length}><Upload size={15} />上传资料</button></fieldset></form>
            <form onSubmit={event => { event.preventDefault(); run(async signal => { await mutate('/sources', { url: url.trim() }, signal); setUrl('') }) }}><fieldset disabled={disabled}><label>补充链接<input type="url" required value={url} onChange={event => setUrl(event.target.value)} /></label><button disabled={!/^https?:\/\//i.test(url.trim())}><Plus size={15} />添加链接</button></fieldset></form>
          </section>
          {project.evidence.length > 0 && <section aria-label="资料证据"><h2>资料证据</h2>{project.evidence.map((item, index) => <article key={`${item.sourceId}:${index}`}><h3>{project.sources.find(source => source.id === item.sourceId)?.name || item.sourceId}</h3><p className="requirements-prewrap">{item.summary}</p><p>局限：{item.limitations || '未记录'}</p></article>)}</section>}
          {unresolved.length > 0 && <section aria-label="待澄清问题"><h2>待澄清问题</h2>{storageError && <p role="alert">{storageError}</p>}<form onSubmit={event => {
            event.preventDefault(); const submitted = unresolved.filter(item => answers[item.id]?.trim()).map(item => ({ questionId: item.id, answer: answers[item.id].trim() }))
            run(async signal => { await mutate('/answers', { answers: submitted }, signal); setAnswers(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => !submitted.some(item => item.questionId === id)))) })
          }}><fieldset disabled={disabled}>{unresolved.map(question => <fieldset key={question.id} className="requirements-question"><legend>{question.priority} · {question.text}</legend><p>{question.impact}</p>{question.recommendation && <p>建议：{question.recommendation}</p>}{question.choices.map((choice, index) => <label className="requirements-choice" key={index}><input type="radio" name={`question-${question.id}`} checked={answers[question.id] === choice} onChange={() => setAnswers(previous => ({ ...previous, [question.id]: choice }))} />{choice}</label>)}<label>回答 · {question.id}<textarea rows={3} value={answers[question.id] || ''} onChange={event => setAnswers(previous => ({ ...previous, [question.id]: event.target.value }))} /></label></fieldset>)}<button disabled={!unresolved.some(item => answers[item.id]?.trim())}><Save size={15} />提交已填写答案</button></fieldset></form></section>}
          {project.decisions.length > 0 && <details><summary>已确认决策 · {project.decisions.length}</summary>{project.decisions.map((decision, index) => <article key={`${decision.question.id}:${index}`}><h3>{decision.question.text}</h3><p className="requirements-prewrap">{decision.answer}</p><time dateTime={decision.at}>{new Date(decision.at).toLocaleString()}</time></article>)}</details>}
          {revision && <section aria-label="修订评审">
            {!!revision.existingPages?.length && <details><summary>现有页面基线 · {revision.existingPages.length}</summary>{revision.existingPages.map(page => <figure key={page.image.id}><figcaption>{revision.prd.blocks.find(block => block.id === page.blockId)?.title || page.blockId} · {page.path} · {new Date(page.capturedAt).toLocaleString()}</figcaption><img loading="lazy" alt={`现有页面 ${page.path}`} src={`${endpoint}/existing-pages/${encodeURIComponent(page.image.id)}?revision=${encodeURIComponent(revision.id)}`} style={{ display: 'block', width: '100%', maxWidth: 1600, aspectRatio: '8 / 5', objectFit: 'contain' }} /></figure>)}</details>}
            <div className="requirements-revision-toolbar"><FilterSelect label="修订历史" value={revision.id} options={project.revisions.map((item, index) => ({ value: item.id, label: `修订 ${index + 1} · ${new Date(item.createdAt).toLocaleString()}${item.id === latest?.id ? ' · 当前' : ''}` }))} onChange={value => { if (editing && !window.confirm('放弃未保存的 PRD 编辑并切换修订？')) return; setRevisionId(value); setSelectedId(''); setEditing(false) }} />
              <div className="requirements-exports" aria-label="导出修订"><Download size={16} />{(['md', 'docx', 'html', 'zip'] as const).map(format => <a key={format} href={`${endpoint}/exports?format=${format}&revision=${encodeURIComponent(revision.id)}`} download>{format.toUpperCase()}</a>)}</div>
            </div>
            {historical && <p role="status">历史修订 · 只读</p>}
            <p>PRD：{revision.confirmedAt ? '已确认' : '未确认'} · 设计：{revision.designConfirmedAt ? '已确认' : '未确认'}</p>
            <p className="requirements-limitations">验证范围：仅静态页面、映射与截图检查；未验证业务交互、接口或端到端流程。确认设计不代表交互验收通过，HTML 导出也是静态截图原型。</p>
            {validation && <div role="status"><h3>静态设计检查</h3>{validation.errors.length ? <ul>{validation.errors.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>{staticValidated ? '静态检查未报告错误 · 交互未验证' : '静态验证证据不完整，请重新检查设计 · 交互未验证'}</p>}{Array.isArray(validation.limitations) && <ul aria-label="验证局限">{validation.limitations.filter((item): item is string => typeof item === 'string').map((item, index) => <li key={index}>{item}</li>)}</ul>}<time dateTime={validation.at}>{new Date(validation.at).toLocaleString()}</time></div>}
            <div className="requirements-toolbar"><button ref={reviewTrigger} data-review-toggle type="button" onClick={() => setWideReview(true)}><Maximize2 size={16} />宽屏评审</button></div>
            <dialog ref={reviewDialog} open className="requirements-review-dialog" aria-label="审阅模式" onCancel={event => { event.preventDefault(); setWideReview(false) }}>
            <div className={`requirements-review-controls${wideReview ? ' requirements-review-dialog-heading' : ''}`}>
            {wideReview && <h2>审阅模式</h2>}
            <label className="requirements-divider">设计区域宽度 <input aria-label="设计区域宽度" type="range" min={35} max={70} value={split} onChange={event => setSplit(Number(event.target.value))} /><output>{split}%</output></label>
            {wideReview && <button data-review-toggle type="button" aria-label="关闭宽屏评审" title="关闭宽屏评审" onClick={() => setWideReview(false)}><X size={16} /></button>}
            </div>
            <fieldset className="requirements-mobile-switch requirements-segments"><legend className="requirements-sr-only">评审视图</legend>{[{ id: 'design', title: '设计' }, { id: 'prd', title: 'PRD' }].map(view => <label key={view.id}><input type="radio" name="requirements-mobile-view" checked={mobileView === view.id} onChange={() => setMobileView(view.id)} />{view.title}</label>)}</fieldset>
            <div className="requirements-review" data-mobile-view={mobileView} style={{ '--requirements-split': `${split}%` } as React.CSSProperties}>
              <div className="requirements-prd-pane" tabIndex={0} role="region" aria-label="PRD 评审"><PrdReview key={revision.id} prd={revision.prd} selectedId={selectedId} reviewMode={wideReview} onRead={requirementId => setReading({ revisionId: revision.id, requirementId })} onSelect={setSelectedId} busy={busy || running || !synced} readOnly={historical || !!revision.confirmedAt || !analyzed || unresolved.length > 0} onEditing={setEditing} onSave={async (prd: StructuredPrd) => { await action(signal => mutate('/prd', { prd }, signal, 'PATCH')); setEditing(false) }} /></div>
              <div className="requirements-design-pane" tabIndex={0} role="region" aria-label="设计评审"><DesignReview key={project.id} projectId={project.id} revision={revision} preferredScreen={adjustedPage} running={running} taskError={lastJob?.status === 'failed' ? lastJob.error : undefined} onCancel={runningJob ? () => run(signal => mutate(`/jobs/${encodeURIComponent(runningJob.id)}/cancel`, {}, signal)) : undefined} selectedId={reading.revisionId === revision.id ? reading.requirementId : ''} adjustmentDisabled={disabled || !analyzed || unresolved.length > 0 || !revision.confirmedAt} onAdjust={(screenId, instruction) => action(async signal => { const target = revision.screens.find(screen => screen.id === screenId); if (target) setAdjustedPage({ title: target.title, state: target.state }); await mutate('/jobs', { stage: 'design', screenId, instruction }, signal) })} /></div>
            </div>
            </dialog>
            <form onSubmit={event => { event.preventDefault(); run(async signal => { await mutate('/revisions', { instruction: instruction.trim() }, signal); setRevisionId(''); setSelectedId(''); setInstruction('') }) }}><fieldset disabled={disabled}><label>修订意见<textarea rows={3} required value={instruction} onChange={event => setInstruction(event.target.value)} /></label><button disabled={!instruction.trim()}><Plus size={15} />创建修订</button></fieldset></form>
          </section>}
          <details><summary>任务与进度记录</summary><ul>{project.jobs.map(item => <li key={item.id}>{stages[item.stage]} · {jobStatuses[item.status]} · <time dateTime={item.startedAt}>{new Date(item.startedAt).toLocaleString()}</time>{item.error && <p>{item.error}</p>}</li>)}</ul><ol>{project.events.map(item => <li key={item.id}><time dateTime={item.at}>{new Date(item.at).toLocaleString()}</time> {item.text}</li>)}</ol></details>
        </>}
      </div>
    </div>
  </main>
}