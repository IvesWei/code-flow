import * as React from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { ArrowRight, Check, ChevronDown, ChevronLeft, ChevronRight, Clock3, Download, FileText, FolderOpen, GitBranch, Globe, Info, Layers, Maximize2, MessageSquare, PanelLeft, Play, Plus, RefreshCw, Save, Square, Upload, X } from 'lucide-react'
import type { RequirementProject, RequirementJobStage, StructuredPrd } from '../../../shared/requirements'
import { businessReviewSections, type BusinessNote } from '../../../shared/business-review'
import type { PrdEdition } from '../../../shared/prd-template'
import { requirementAnalysisCurrent, requirementPrdClarification, requirementPrdCurrent, requirementPrdResumeReady } from '../../../shared/requirement-progress'
import { ModelPicker } from '../../components/ModelPicker'
import type { ModelOption } from '../../components/ModelPicker'
import { FilterSelect } from '../../components/FilterSelect'
import { useNavigation } from '../../app/navigation'
import { invalidateAuth, useAuth } from '../auth/auth-session'
import { PrdReview } from './PrdReview'
import { DesignReview } from './DesignReview'
import { BusinessPreview } from './BusinessReview'
import { CodeDirectoryInput } from './CodeDirectoryInput.tsx'
import { RemoteCodeInput } from './RemoteCodeInput'
import { readCodeSnapshot } from './code-directory'
import { ExecutionFeedback } from './ExecutionFeedback'
import { SystemPageEvidence } from './SystemPageEvidence'

const root = '/api/requirements/projects'
const stages: Record<RequirementJobStage, string> = { analyze: '分析需求', prd: '生成 PRD', design: '生成设计', validate: '验证设计', reconstruct: '生成现状复刻图', 'business-review': '整理业务变更' }
const statuses: Record<RequirementProject['status'], string> = { draft: '草稿', running: '运行中', needs_input: '待补充', prd_review: 'PRD 待审核', design_review: '设计待审核', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' }
const jobStatuses = { running: '运行中', succeeded: '成功', failed: '失败', cancelled: '已取消', interrupted: '已中断' }
const detailSections = [
  { id: 'sources', title: '用户输入与证据', icon: FolderOpen },
  { id: 'artifacts', title: '系统产物', icon: Layers },
  { id: 'decisions', title: '澄清与决策', icon: MessageSquare },
  { id: 'activity', title: '任务记录', icon: Clock3 },
] as const
type DetailSection = typeof detailSections[number]['id']
type StageActionId = RequirementJobStage | 'confirm-prd' | 'confirm-design' | 'restart-prd'
const feedbackActions = {
  history: { area: 'history', pending: '正在刷新项目列表…', success: '项目列表已更新' },
  refresh: { area: 'overview', pending: '正在重新读取任务状态…', success: '任务状态已更新' },
  create: { area: 'create', pending: '正在创建需求项目…', success: '需求项目已创建' },
  models: { area: 'models', pending: '正在读取模型目录…', success: '模型目录已更新' },
  analyze: { area: 'overview', pending: '正在提交需求分析任务…', success: '需求分析请求已提交，请查看任务执行状态' },
  prd: { area: 'overview', pending: '正在提交 PRD 生成任务…', success: 'PRD 生成请求已提交，请查看任务执行状态' },
  design: { area: 'overview', pending: '正在提交设计生成任务…', success: '设计生成请求已提交，请查看任务执行状态' },
  validate: { area: 'overview', pending: '正在提交静态检查任务…', success: '静态检查请求已提交，请查看任务执行状态' },
  reconstruct: { area: 'reconstruction', pending: '正在提交现状复刻任务…', success: '现状复刻请求已提交' },
  'business-review': { area: 'business-review', pending: '正在提交业务整理任务…', success: '业务整理请求已提交' },
  'confirm-prd': { area: 'overview', pending: '正在确认 PRD…', success: 'PRD 已确认' },
  'confirm-design': { area: 'overview', pending: '正在确认设计…', success: '设计已确认 · 交互未验证' },
  cancel: { area: 'overview', pending: '正在取消任务…', success: '取消请求已处理，请查看任务状态' },
  login: { area: 'login', pending: '正在处理取证登录请求…', success: '登录请求已处理，请查看取证任务状态' },
  'capture-preview': { area: 'capture', pending: '正在保存修正后的取证地址…', success: '取证地址已保存' },
  'capture-note': { area: 'capture', pending: '正在提交访问补充说明…', success: '访问补充说明已保存' },
  upload: { area: 'sources', pending: '正在上传并保存资料…', success: '资料已上传，原始资料列表已更新' },
  link: { area: 'sources', pending: '正在读取并保存链接资料…', success: '链接资料已添加' },
  preview: { area: 'preview', pending: '正在保存取证配置…', success: '取证配置已保存；页面取证将在后续生成任务中执行' },
  answers: { area: 'answers', pending: '正在提交澄清答案…', success: '已填写的澄清答案已保存' },
  'save-prd': { area: 'prd', pending: '正在保存 PRD…', success: 'PRD 已保存' },
  revision: { area: 'revision', pending: '正在创建修订…', success: '修订意见已保存' },
  export: { area: 'export', pending: '正在导出 PRD…', success: 'PRD 已开始下载' },
} as const
type FeedbackAction = keyof typeof feedbackActions
type FeedbackArea = typeof feedbackActions[FeedbackAction]['area']
type Operation = { id: FeedbackAction } & ({ state: 'pending' | 'success' } | { state: 'error'; error: string })

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
  const navigateWithState = useNavigate()
  const { state: routeState } = useLocation()
  const { auth } = useAuth()
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
  const [initialFiles, setInitialFiles] = React.useState<File[]>([])
  const [initialUrl, setInitialUrl] = React.useState('')
  const [initialRepository, setInitialRepository] = React.useState('')
  const [initialBranch, setInitialBranch] = React.useState('')
  const [initialDirectory, setInitialDirectory] = React.useState('')
  const [initialPreviewOrigin, setInitialPreviewOrigin] = React.useState('')
  const initialFileInput = React.useRef<HTMLInputElement>(null)
  const [files, setFiles] = React.useState<File[]>([])
  const [url, setUrl] = React.useState('')
  const [previewOrigin, setPreviewOrigin] = React.useState('')
  const [previewEntryDraft, setPreviewEntryDraft] = React.useState<{ projectId: string; saved: string; text: string }>()
  const [captureNote, setCaptureNote] = React.useState('')
  const [loginPromptOpen, setLoginPromptOpen] = React.useState(false)
  const loginDialog = React.useRef<HTMLDialogElement>(null)
  const loginTrigger = React.useRef<HTMLButtonElement>(null)
  const [instruction, setInstruction] = React.useState('')
  const [answers, setAnswers] = React.useState<Record<string, string>>({})
  const [questionId, setQuestionId] = React.useState('')
  const questionHeading = React.useRef<HTMLLegendElement>(null)
  const focusQuestion = React.useRef<'pointer' | 'keyboard' | undefined>(undefined)
  const [storageError, setStorageError] = React.useState('')
  const [revisionId, setRevisionId] = React.useState('')
  const [selectedId, setSelectedId] = React.useState('')
  const [adjustedPage, setAdjustedPage] = React.useState<{ title: string; state: string }>()
  const [reading, setReading] = React.useState({ revisionId: '', requirementId: '' })
  const [editing, setEditing] = React.useState(false)
  const [section, setSection] = React.useState<DetailSection>()
  const sectionTabs = React.useRef<HTMLDivElement>(null)
  const [split, setSplit] = React.useState(56)
  const [wideReview, setWideReview] = React.useState(false)
  const [edition, setEdition] = React.useState<PrdEdition>('business')
  const [noteSelection, setNoteSelection] = React.useState({ revisionId: '', key: '' })
  const reviewDialog = React.useRef<HTMLDialogElement>(null)
  const reviewTrigger = React.useRef<HTMLButtonElement>(null)
  const restoreReviewFocus = React.useRef(false)
  const [mobileView, setMobileView] = React.useState('prd')
  const [busy, setBusy] = React.useState(false)
  const [operation, setOperation] = React.useState<Operation>()
  const [exporting, setExporting] = React.useState(false)
  const [exportStatus, setExportStatus] = React.useState<{ revisionId: string; error: boolean; text: string }>()
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState(() => projectId && typeof routeState?.creationWarning === 'string' ? routeState.creationWarning as string : '')
  const [synced, setSynced] = React.useState(false)
  const scope = React.useRef<AbortController | null>(null)
  const lock = React.useRef(false)
  const fileInput = React.useRef<HTMLInputElement>(null)
  const exportTrigger = React.useRef<HTMLButtonElement>(null)
  const savedAnswers = React.useRef(false)
  const revision = project?.revisions.find(item => item.id === revisionId) || project?.revisions.at(-1)
  const latest = project?.revisions.at(-1)
  const validation = revision?.validation as (NonNullable<typeof revision>['validation'] & {
    artifactVersion?: number; allScreensValidated?: boolean; interactionVerified?: boolean; mode?: string
    screens?: { screenId: string; visual: string; interaction: string }[]; limitations?: unknown
  }) | undefined
  const staticValidated = !!revision?.screens.length && !!validation && !validation.errors.length && validation.artifactVersion === 1 && validation.allScreensValidated === true && validation.interactionVerified === false && validation.mode === 'static-script-disabled' && validation.screens?.length === revision.screens.length && revision.screens.every(screen => validation.screens?.some(check => check.screenId === screen.id && check.visual === 'passed' && check.interaction === 'not_verified'))
  const historical = !!revision && revision.id !== latest?.id
  const business = revision?.prd.templateVersion === 2 && edition === 'business'
  const focusedBusiness = business && wideReview
  const businessNotes: BusinessNote[] = business && revision ? businessReviewSections(revision).flatMap(module => module.functions.flatMap(item => [...item.changes, ...item.pending])) : []
  const activeNote = businessNotes.find(note => noteSelection.revisionId === revision?.id && note.key === noteSelection.key) ?? businessNotes[0]
  const reviewJob = project?.jobs.findLast(item => item.stage === 'business-review' && item.revisionId === revision?.id)
  const lastJob = project?.jobs.findLast(item => item.stage !== 'reconstruct' && item.stage !== 'business-review')
  const evidenceJob = project?.jobs.findLast(item => item.stage === 'reconstruct' && item.revisionId === revision?.id)
  const designJob = lastJob?.stage === 'design' ? lastJob : undefined
  const designProgress = designJob ? project?.events.filter(event => event.at >= designJob.startedAt).at(-1) : undefined
  const runningJob = project?.jobs.find(item => item.status === 'running')
  const running = !!runningJob || project?.status === 'running'
  const loginInteraction = runningJob?.interaction
  const captureNeedsInput = lastJob?.status === 'failed' && /\[(?:PAGE_CAPTURE(?:_[A-Z]+)?|PAGE_MAPPING(?:_[A-Z_]+)?|DESIGN_STYLE_EVIDENCE)\]/.test(lastJob.error || '')
  const disabled = busy || running || historical || editing || !synced
  const endpoint = `${root}/${encodeURIComponent(projectId)}`
  const unresolved = project?.questions.filter(question => !project.decisions.some(item => item.question.id === question.id)) || []
  const questionIndex = Math.max(0, unresolved.findIndex(question => question.id === questionId))
  const currentQuestion = unresolved[questionIndex]
  const answeredCount = unresolved.filter(question => answers[question.id]?.trim()).length
  const analyzed = !!project && requirementAnalysisCurrent(project)
  const currentPrd = !!project && requirementPrdCurrent(project)
  const prdClarification = !!project && requirementPrdClarification(project)
  const prdResumeReady = !!project && requirementPrdResumeReady(project)
  const retryPrd = project?.jobs.at(-1)?.stage === 'prd' && ['failed', 'interrupted'].includes(project.jobs.at(-1)!.status)
  const activeSection = section || (revision ? 'artifacts' : 'sources')
  React.useLayoutEffect(() => {
    if (focusQuestion.current) {
      const heading = questionHeading.current
      if (heading) {
        heading.toggleAttribute('data-pointer-focus', focusQuestion.current === 'pointer')
        heading.focus()
      }
      focusQuestion.current = undefined
    }
  }, [currentQuestion?.id])
  React.useEffect(() => { setPreviewOrigin(project?.preview?.origin || '') }, [project?.preview?.origin])
  const storedPreviewEntries = project?.preview?.entryPaths?.join('\n') || ''
  const previewEntries = previewEntryDraft?.projectId === projectId && previewEntryDraft.saved === storedPreviewEntries ? previewEntryDraft.text : storedPreviewEntries
  const setPreviewEntries = (text: string) => setPreviewEntryDraft({ projectId, saved: storedPreviewEntries, text })
  const entryPaths = previewEntries.split(/\r?\n/).map(entry => entry.trim()).filter(Boolean)
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
      if (!(event.target instanceof Element) || event.target.closest('.requirements-preview, .requirements-prd-pane, .requirements-mobile-switch, .requirements-detail-tabs, .requirements-attention, [data-review-toggle]')) return
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

  const acceptProject = React.useCallback((value: RequirementProject) => {
    if (value.id !== projectId) throw new Error('服务端项目与当前地址不匹配')
    if (project && value.version < project.version) return
    if (revisionId === project?.revisions.at(-1)?.id && value.revisions.at(-1)?.id !== revisionId) setRevisionId('')
    setProject(previous => previous && previous.version > value.version ? previous : value)
    setProjects(previous => previous.map(item => item.id === value.id ? value : item))
    setSynced(true)
    if (!savedAnswers.current) { setAnswers(readAnswers(value)); savedAnswers.current = true }
  }, [projectId, project, revisionId])
  const refresh = React.useCallback(async (signal: AbortSignal) => {
    try { acceptProject(await request<RequirementProject>(endpoint, signal)) }
    catch (caught) { if (!signal.aborted) setSynced(false); throw caught }
  }, [acceptProject, endpoint])
  const refreshFromEffect = React.useEffectEvent(refresh)
  React.useEffect(() => {
    const controller = new AbortController(); scope.current = controller
    void request<RequirementProject[]>(root, controller.signal).then(value => { if (!controller.signal.aborted) setProjects(value) }).catch(caught => { if (!controller.signal.aborted) setError(caught.message) })
    void request<{ defaultModelId: string; models: ModelOption[] }>('/api/copilot/models', controller.signal).then(value => { if (!controller.signal.aborted) setCatalog(value) }).catch(caught => { if (!controller.signal.aborted) setModelError(caught.message) })
    if (projectId) void refreshFromEffect(controller.signal).catch(caught => { if (!controller.signal.aborted) setError(caught.message) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    else setLoading(false)
    return () => { controller.abort() }
  }, [projectId])
  React.useEffect(() => {
    if (!running) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try { await refreshFromEffect(controller.signal); if (!controller.signal.aborted) setError('') }
      catch (caught) { if (!controller.signal.aborted) setError(`任务状态同步失败：${caught instanceof Error ? caught.message : '刷新失败'}。后台任务可能仍在执行，请勿重复提交。`) }
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

  async function action(work: (signal: AbortSignal) => Promise<void>, id?: FeedbackAction) {
    if (lock.current || !scope.current || scope.current.signal.aborted) return
    lock.current = true; setBusy(true); setError('')
    setOperation(id ? { id, state: 'pending' } : undefined)
    const signal = scope.current.signal
    try { await work(signal); if (id && !signal.aborted) setOperation({ id, state: 'success' }) }
    catch (caught) { if (!signal.aborted) { const message = caught instanceof Error ? caught.message : '请求失败'; setError(message); if (id) setOperation({ id, state: 'error', error: message }); throw caught } }
    finally { lock.current = false; if (!signal.aborted) setBusy(false) }
  }
  function run(id: FeedbackAction, work: (signal: AbortSignal) => Promise<void>) { void action(work, id).catch(() => {}) }
  function feedback(area: FeedbackArea) {
    if (!operation || feedbackActions[operation.id].area !== area) return null
    const labels = feedbackActions[operation.id]
    return <ExecutionFeedback state={operation.state} title={operation.state === 'pending' ? labels.pending : operation.state === 'error' ? operation.error : labels.success} detail={operation.state === 'pending' ? '操作正在执行，请勿重复提交。' : undefined} />
  }
  async function mutate(path: string, body: Record<string, unknown>, signal: AbortSignal, method = 'POST') {
    if (!project) return
    try { acceptProject(await request<RequirementProject>(`${endpoint}${path}`, signal, { ...body, version: project.version }, method)) }
    catch (caught) { await refresh(signal).catch(() => {}); throw caught }
  }
  function job(stage: RequirementJobStage, restartPrd = false) { run(stage, signal => mutate('/jobs', { stage, ...(restartPrd ? { restartPrd: true } : {}), ...(['reconstruct', 'business-review'].includes(stage) ? { revisionId: revision?.id } : {}), ...(stage === 'analyze' && instruction.trim() ? { instruction: instruction.trim() } : {}) }, signal)) }
  function exportPrd() {
    if (!revision) return
    const target = revision.id
    const dual = revision.prd.templateVersion === 2
    run('export', async signal => {
      setExporting(true)
      setExportStatus({ revisionId: target, error: false, text: dual ? '正在生成两份 PRD Word 文档及 ZIP 压缩包…' : '正在生成 PRD Word 文档及原型截图…' })
      try {
        const response = await fetch(`${endpoint}/exports?format=${dual ? 'zip' : 'docx'}&scope=prd&revision=${encodeURIComponent(target)}`, { signal, credentials: 'same-origin' })
        if (response.status === 401) invalidateAuth()
        if (!response.ok) {
          const data = await response.json().catch(() => null)
          throw new Error(typeof data?.error === 'string' ? data.error : `导出失败 (${response.status})`)
        }
        if (response.headers.get('content-type')?.split(';')[0] !== (dual ? 'application/zip' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')) throw new Error(dual ? '服务端未返回有效的双版本 PRD 压缩包' : '服务端未返回有效的 Word 文档')
        const blob = await response.blob()
        if (signal.aborted) return
        if (!blob.size) throw new Error(dual ? '导出的双版本 ZIP 文件为空' : '导出的 Word 文档为空')
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url; anchor.download = `prd-${projectId}-${target}.${dual ? 'zip' : 'docx'}`; anchor.click(); URL.revokeObjectURL(url)
        setExportStatus({ revisionId: target, error: false, text: dual ? '双版本 PRD 已开始下载：ZIP 内含业务评审版和开发规格版 Word。' : 'PRD Word 文档已开始下载，包含当前修订的原型截图。' })
      } catch (caught) {
        if (!signal.aborted) setExportStatus({ revisionId: target, error: true, text: caught instanceof Error ? caught.message : 'PRD 导出失败' })
        throw caught
      } finally { if (!signal.aborted) setExporting(false) }
    })
  }
  function go(event: React.MouseEvent<HTMLAnchorElement>, path: string) {
    if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
    if (editing && !window.confirm('尚有未保存的 PRD 编辑，确认离开？')) { event.preventDefault(); return }
    event.preventDefault(); navigate(path)
  }
  const selectedModel = modelId || catalog?.defaultModelId || 'auto'
  const modelAvailable = !!catalog && (selectedModel === 'auto' || catalog.models.some(item => item.id === selectedModel && !['disabled', 'unconfigured'].includes(item.policy || '')))
  function changeSection(value: DetailSection, focus = false) {
    if (activeSection === 'artifacts' && value !== activeSection && editing && !window.confirm('尚有未保存的 PRD 编辑，确认切换功能分区？草稿会保留。')) return
    setSection(value)
    if (focus) sectionTabs.current?.querySelector<HTMLButtonElement>(`[data-section="${value}"]`)?.focus()
  }
  function showQuestion(index: number, input: 'pointer' | 'keyboard') {
    if (index < 0 || index >= unresolved.length || index === questionIndex) return
    focusQuestion.current = input
    setQuestionId(unresolved[index].id)
  }
  function chooseAnswer(choice: string, input: 'pointer' | 'keyboard') {
    if (!currentQuestion) return
    setAnswers(previous => ({ ...previous, [currentQuestion.id]: choice }))
    showQuestion(questionIndex + 1, input)
  }
  const stageActions: { id: StageActionId; label: string; icon: typeof Check; disabled: boolean }[] = project ? [
    { id: 'analyze', label: '分析需求', icon: Play, disabled: disabled || !['draft', 'needs_input', 'failed', 'cancelled', 'interrupted'].includes(project.status) || unresolved.length > 0 },
    { id: 'prd', label: prdResumeReady || retryPrd ? '继续生成 PRD' : '生成 PRD', icon: FileText, disabled: disabled || unresolved.length > 0 || !analyzed },
    ...(retryPrd && !captureNeedsInput ? [{ id: 'restart-prd' as const, label: project.preview ? '重新取证并生成 PRD' : '从头撰写 PRD', icon: RefreshCw, disabled: disabled || unresolved.length > 0 || !analyzed }] : []),
    { id: 'confirm-prd', label: '确认 PRD', icon: Check, disabled: disabled || !analyzed || !currentPrd || unresolved.length > 0 || !latest || !!latest.confirmedAt },
    { id: 'design', label: '生成设计', icon: Play, disabled: disabled || !analyzed || !currentPrd || unresolved.length > 0 || !latest?.confirmedAt },
    { id: 'validate', label: '检查静态设计', icon: Check, disabled: disabled || !analyzed || !currentPrd || unresolved.length > 0 || !latest?.confirmedAt || !latest.screens.length },
    { id: 'confirm-design', label: '确认设计', icon: Check, disabled: disabled || !analyzed || !currentPrd || unresolved.length > 0 || !latest?.confirmedAt || !staticValidated || !!latest.designConfirmedAt },
  ] : []
  function performStageAction(id: StageActionId) {
    if (id === 'restart-prd') job('prd', true)
    else if (id === 'confirm-prd' || id === 'confirm-design') run(id, signal => mutate('/confirm', { target: id === 'confirm-prd' ? 'prd' : 'design' }, signal))
    else job(id)
  }
  const nextActionId = !analyzed ? 'analyze' : !currentPrd ? 'prd' : !latest?.confirmedAt ? 'confirm-prd' : !latest.screens.length ? 'design' : !staticValidated ? 'validate' : !latest.designConfirmedAt ? 'confirm-design' : undefined
  const primaryAction = !running && !unresolved.length ? stageActions.find(item => item.id === nextActionId) : undefined
  const progressSteps = [
    { title: '需求分析', done: analyzed, note: analyzed ? '分析完成' : '待分析' },
    { title: 'PRD 评审', done: currentPrd && !!latest?.confirmedAt, note: currentPrd ? latest?.confirmedAt ? '已确认' : '待确认' : '待生成' },
    { title: '设计与静态检查', done: !!latest?.screens.length && staticValidated, note: latest?.screens.length ? staticValidated ? '静态检查通过 · 交互未验证' : '待检查 · 交互未验证' : '待生成设计' },
    { title: '确认设计', done: !!latest?.designConfirmedAt, note: latest?.designConfirmedAt ? '已确认 · 交互未验证' : '待确认' },
  ]
  const currentStep = progressSteps.findIndex(item => !item.done)
  const currentProgress = project?.events.filter(event => !runningJob || event.at >= runningJob.startedAt).at(-1)
  const taskFeedback = running && <ExecutionFeedback state={loginInteraction ? 'waiting' : 'pending'} title={loginInteraction ? '页面取证等待人工登录' : runningJob ? `${stages[runningJob.stage]}进行中…` : '任务正在执行…'} detail={loginInteraction ? '请处理登录请求，后台任务尚未完成。' : `${currentProgress?.text || '任务已接收，等待后台进度更新。'}${runningJob ? `\n开始于 ${new Date(runningJob.startedAt).toLocaleString()}` : ''}\n耗时操作仍在后台执行，可切换分区查看，请勿重复提交。`} />
  const createRepoInvalid = !!initialRepository.trim() && !/^(?:https:\/\/github\.com|https?:\/\/code\.sunmi\.com)\/[\w.-]+\/[\w.-]+(?:\.git)?\/?$/i.test(initialRepository.trim())
  const formatTime = (value: string) => new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
  async function createProjectWithContext(signal: AbortSignal) {
    const remoteCodeConfig = initialRepository.trim() ? {
      repository: initialRepository.trim(),
      ...(initialBranch.trim() ? { branch: initialBranch.trim() } : {}),
      ...(initialDirectory.trim() ? { directory: initialDirectory.trim() } : {}),
    } : undefined
    let current = await request<RequirementProject>(root, signal, { title: title.trim(), description: description.trim(), modelId: selectedModel, remoteCodeConfig })
    const targetEndpoint = `${root}/${encodeURIComponent(current.id)}`
    const failures: string[] = []
    async function saveContext(label: string, save: () => Promise<RequirementProject>) {
      try { current = await save() }
      catch (caught) {
        signal.throwIfAborted()
        failures.push(`${label}：${caught instanceof Error ? caught.message : '保存失败'}`)
        current = await request<RequirementProject>(targetEndpoint, signal).catch(() => current)
      }
    }
    try {
      if (initialPreviewOrigin.trim()) await saveContext('现有系统取证', () => request(`${targetEndpoint}/preview`, signal, { version: current.version, origin: initialPreviewOrigin.trim(), entryPaths: [] }, 'PATCH'))
      if (initialFiles.length) await saveContext('需求文件', () => {
        const form = new FormData()
        form.set('version', String(current.version))
        initialFiles.forEach(file => form.append('files', file))
        return request(`${targetEndpoint}/sources`, signal, form)
      })
      if (initialUrl.trim()) await saveContext('参考文档链接', () => request(`${targetEndpoint}/sources`, signal, { version: current.version, url: initialUrl.trim() }))
      if (remoteCodeConfig) await saveContext('远程仓库代码快照', () => request(`${targetEndpoint}/remote-code-snapshot`, signal, {
        version: current.version,
        ...remoteCodeConfig,
      }))
    } finally {
      if (!signal.aborted) navigateWithState(`/requirements/${encodeURIComponent(current.id)}`, {
        state: failures.length ? { creationWarning: `项目已创建，部分配置未保存。请在「用户输入与证据」中补充：${failures.join('；')}` } : undefined,
      })
    }
  }
  return <main className="requirements-workspace">
    <div className="requirements-topbar">
      <div className="requirements-breadcrumb">
        <h1>需求工作区</h1>
        <span className="requirements-crumb" aria-hidden="true">/</span>
        <span className="requirements-crumb-current">{project ? project.title : projectId ? '加载项目中…' : '新建需求项目'}</span>
      </div>
      <div className="requirements-topbar-actions">
        {auth?.authenticated && <span className="requirements-auth-pill"><span className="requirements-status-dot" data-status="completed" aria-hidden="true" />{auth.login || '已登录'}</span>}
        <a className="requirements-new-link" href="/requirements" onClick={event => go(event, '/requirements')}><Plus size={15} />新建项目</a>
      </div>
    </div>
    <div className="requirements-layout" data-history-open={historyOpen}>
      <aside ref={historyRail} className="requirements-history-rail" aria-label="需求项目" onPointerLeave={() => { if (!historyRail.current?.contains(document.activeElement)) setHistoryOpen(false) }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setHistoryOpen(false) }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); historyTrigger.current?.focus(); setHistoryOpen(false) } }}>
        <button ref={historyTrigger} className="requirements-history-trigger" aria-label="项目记录" title="项目记录" aria-expanded={historyOpen} aria-controls="requirements-project-history" onPointerEnter={event => { if (event.pointerType === 'mouse') setHistoryOpen(true) }} onClick={() => setHistoryOpen(value => !value)}><PanelLeft size={16} /></button>
        <div id="requirements-project-history" className="requirements-history" hidden={!historyOpen}>
          <div className="requirements-history-header"><h2>项目列表</h2><span className="requirements-badge">{projects.length}</span><button disabled={busy} aria-label="刷新项目列表" title="刷新项目列表" onClick={() => run('history', async signal => { setProjects(await request<RequirementProject[]>(root, signal)); if (projectId) await refresh(signal) })}><RefreshCw size={15} /></button></div>
          {feedback('history')}
          {!projects.length && <p className="requirements-history-empty">暂无需求项目</p>}
          {projects.map(item => <a key={item.id} href={`/requirements/${encodeURIComponent(item.id)}`} aria-current={projectId === item.id ? 'page' : undefined} onClick={event => go(event, `/requirements/${encodeURIComponent(item.id)}`)}>
            <span className="requirements-status-dot" data-status={item.status} aria-hidden="true" />
            <div><strong>{item.title}</strong><span>{statuses[item.status]} · {formatTime(item.updatedAt)}</span></div>
          </a>)}
        </div>
      </aside>
      <div className="requirements-body" aria-busy={loading}>
        {error && <div className="requirements-error" role="alert"><span>{error}</span><button disabled={busy} onClick={() => run('refresh', async signal => { if (projectId) await refresh(signal); else setProjects(await request<RequirementProject[]>(root, signal)) })}><RefreshCw size={15} />重新读取</button></div>}
        {!project && feedback('overview')}
        {loading && <p className="requirements-loading-note" role="status">正在读取项目…</p>}
        {!projectId && <div className="requirements-create-shell">
          <div className="requirements-create-hero">
            <div>
              <p className="requirements-eyebrow">REQUIREMENTS &amp; UI DESIGN</p>
              <h2>新建需求项目</h2>
              <p className="requirements-card-description">基于需求原文、存量代码回溯与用户澄清，收敛业务评审版与开发规格版 PRD，并生成多状态桌面静态原型。</p>
            </div>
          </div>
          <form className="requirements-create" onSubmit={event => { event.preventDefault(); run('create', createProjectWithContext) }}>
            <fieldset disabled={busy}>
              <section className="requirements-form-section">
                <div className="requirements-section-title"><span className="requirements-section-index">01</span><div><h3>核心需求定义</h3><p>明确本次新增或改造的业务目标、涉及模块及范围边界</p></div></div>
                <label>项目名称<input required maxLength={200} placeholder="例如：测试计划模块支持自定义审批人与状态筛选" value={title} onChange={event => setTitle(event.target.value)} /></label>
                <label>需求描述<textarea required rows={7} placeholder="请描述业务背景、核心用户场景、预期变更的功能点、角色权限要求及明确不做的事项…" value={description} onChange={event => setDescription(event.target.value)} /></label>
                <div className="requirements-model-row">
                  <div className="requirements-model"><span>Copilot 模型</span><ModelPicker label="需求项目模型" value={selectedModel} models={catalog?.models} hasImages={initialFiles.some(file => /\.(png|jpe?g|webp)$/i.test(file.name)) || !!initialPreviewOrigin.trim()} loading={!catalog && !modelError} disabled={busy || !catalog} onSelect={setModelId} /></div>
                  <small className="requirements-field-hint">涉及图片资料或现有系统页面截图取证时，请选择支持视觉能力的模型。</small>
                </div>
                {modelError && <p className="requirements-error" role="alert"><span>{modelError}</span><button type="button" onClick={() => run('models', async signal => { setCatalog(await request('/api/copilot/models', signal)); setModelError('') })}><RefreshCw size={15} />重试模型目录</button></p>}
              </section>
              <details className="requirements-form-section requirements-optional-context">
                <summary className="requirements-optional-summary">
                  <span className="requirements-section-index">02</span>
                  <div><h3>初始资料与代码上下文（选填）</h3><p>创建时一并附带需求文档、远程仓库代码或测试系统地址；也可创建后再补充</p></div>
                  <ChevronDown size={16} aria-hidden="true" />
                </summary>
                <div className="requirements-optional-body">
                  <div className="requirements-create-grid">
                    <div>
                      <label className={`requirements-upload-drop${initialFiles.length ? ' has-file' : ''}`}>
                        <span>初始需求文件（可选，最多 7 个）</span>
                        <input ref={initialFileInput} type="file" multiple onChange={event => setInitialFiles(Array.from(event.target.files || []).slice(0, 7))} />
                        <Upload size={20} aria-hidden="true" />
                        <strong>{initialFiles.length ? `已选 ${initialFiles.length} 个文件` : '点击选择需求文档或截图'}</strong>
                        <small>支持 MD、TXT、PDF、PNG、JPG、WebP</small>
                      </label>
                      {initialFiles.length > 0 && <ul className="requirements-file-pills">{initialFiles.map((file, index) => <li key={`${file.name}:${index}`}><span>{file.name}</span><button type="button" aria-label={`移除 ${file.name}`} onClick={() => { setInitialFiles(previous => previous.filter((_, itemIndex) => itemIndex !== index)); if (initialFileInput.current && initialFiles.length === 1) initialFileInput.current.value = '' }}><X size={13} /></button></li>)}</ul>}
                    </div>
                    <div>
                      <label>参考文档链接（可选）<input type="url" placeholder="https://example.com/spec.md" value={initialUrl} onChange={event => setInitialUrl(event.target.value)} /></label>
                      <label>现有测试系统地址（可选）<input type="url" placeholder="http://localhost:5173 或 https://tmp.test.sunmi.com" value={initialPreviewOrigin} onChange={event => setInitialPreviewOrigin(event.target.value)} /></label>
                    </div>
                  </div>
                  <div className="requirements-subcard">
                    <h4><GitBranch size={15} aria-hidden="true" />关联远程仓库代码快照（可选）</h4>
                    <label>远程仓库地址<input type="url" placeholder="https://github.com/owner/repo 或 http://code.sunmi.com/team/repo.git" aria-invalid={createRepoInvalid} value={initialRepository} onChange={event => setInitialRepository(event.target.value)} /></label>
                    {createRepoInvalid && <p className="requirements-error" role="alert">请输入 GitHub HTTPS 或 code.sunmi.com 仓库地址</p>}
                    <div className="requirements-inline-fields">
                      <label>分支（可选）<input placeholder="默认分支" value={initialBranch} onChange={event => setInitialBranch(event.target.value)} /></label>
                      <label>相关模块目录（建议较大仓库填写）<input placeholder="如 src/pages/TestPlan" value={initialDirectory} onChange={event => setInitialDirectory(event.target.value)} /></label>
                    </div>
                  </div>
                </div>
              </details>
              <div className="requirements-create-footer">
                <span><Check size={15} aria-hidden="true" />安全边界：代码仅做只读快照分析，原型在隔离静态沙箱渲染</span>
                <button className="requirements-primary-action" type="submit" disabled={!title.trim() || !description.trim() || !modelAvailable || createRepoInvalid}><Plus size={16} />创建项目</button>
              </div>
            </fieldset>
            {feedback('models')}{feedback('create')}
          </form>
        </div>}
        {project && <>
          <section className="requirements-overview" aria-label="项目概况">
            <div className="requirements-project-heading">
              <div>
                <div className="requirements-toolbar requirements-title-row">
                  <h2>{project.title}</h2>
                  <span className="requirements-status-pill" data-status={project.status} role="status">{statuses[project.status]} · v{project.version}</span>
                </div>
                <div className="requirements-meta-strip">
                  <small>模型：{catalog?.models.find(item => item.id === project.modelId)?.name || project.modelId}</small>
                  <small>资料：{project.sources.length} 份</small>
                  {revision && <small>修订：共 {project.revisions.length} 版</small>}
                  {project.preview && <small>现有系统地址：{project.preview.origin}</small>}
                </div>
              </div>
              <div className="requirements-project-actions">{primaryAction && <button className="requirements-primary-action" disabled={primaryAction.disabled} onClick={() => performStageAction(primaryAction.id)}><primaryAction.icon size={16} />{primaryAction.label}{!primaryAction.disabled && <ArrowRight size={14} aria-hidden="true" />}</button>}{runningJob && <button className="requirements-danger-outline" disabled={busy || !synced} onClick={() => run('cancel', signal => mutate(`/jobs/${encodeURIComponent(runningJob.id)}/cancel`, {}, signal))}><Square size={15} />取消任务</button>}</div>
            </div>
            <ol className="requirements-stage-strip" aria-label="任务阶段">{progressSteps.map((step, index) => <li key={step.title} data-completed={step.done} aria-current={index === currentStep ? 'step' : undefined}><span className="requirements-stage-number">{step.done ? <Check size={14} aria-hidden="true" /> : index + 1}</span><div><strong>{step.title}</strong><small>{step.note}</small></div></li>)}</ol>
            <div className="requirements-overview-drawers">
              <details className="requirements-description"><summary>查看需求描述<ChevronDown size={14} aria-hidden="true" /></summary><p className="requirements-prewrap">{project.description}</p></details>
              <details className="requirements-all-actions"><summary>全部阶段操作<ChevronDown size={14} aria-hidden="true" /></summary><div className="requirements-toolbar requirements-stage-actions">{stageActions.filter(item => item.id !== primaryAction?.id).map(item => <button key={item.id} disabled={item.disabled} onClick={() => performStageAction(item.id)}><item.icon size={15} />{item.label}</button>)}</div></details>
            </div>
            {unresolved.length > 0 && <div className="requirements-attention" role="status"><Info size={16} aria-hidden="true" /><div><strong>需要你补充 {unresolved.length} 个问题</strong><p>填写答案后，继续按现有流程分析或生成 PRD。</p></div><button type="button" onClick={() => changeSection('decisions', true)}>去填写答案</button></div>}
            {prdResumeReady && <p className="requirements-resume-banner" role="status"><Check size={15} aria-hidden="true" /><span>PRD 澄清答案已保存，可继续生成 PRD，无需重新分析。</span></p>}
            {feedback('overview')}{taskFeedback}
            {loginInteraction && <div className="requirements-login-banner">
              <p role="status">等待人工登录 · {loginInteraction.origin} · 截止 {new Date(loginInteraction.expiresAt).toLocaleTimeString()}</p>
              <button ref={loginTrigger} type="button" onClick={() => setLoginPromptOpen(true)}><Play size={15} />处理登录请求</button>
              <dialog ref={loginDialog} className="requirements-login-dialog" aria-labelledby="requirements-login-heading" onCancel={event => { event.preventDefault(); setLoginPromptOpen(false) }}>
                <div className="requirements-toolbar"><h3 id="requirements-login-heading">需要你完成系统登录</h3><button type="button" aria-label="收起登录提示" title="收起登录提示" onClick={() => setLoginPromptOpen(false)}><X size={15} /></button></div>
                <p><strong>{loginInteraction.origin}</strong></p>
                <p>专用 Chrome 窗口将在 API 所在机器打开，请直接在该窗口完成登录。密码、验证码和会话不会交给设计模型。关闭提示不会取消任务。</p>
                <p>仅允许目标系统同源认证；跳转其他 OA 域名暂未授权，可使用该系统提供的同源登录方式。远程服务无法在你的电脑打开窗口。</p>
                <p>有效期至 <time dateTime={loginInteraction.expiresAt}>{new Date(loginInteraction.expiresAt).toLocaleString()}</time>，取消或超时后会话会被清理。</p>
                <div className="requirements-toolbar">
                  {loginInteraction.phase === 'ready' ? <button className="requirements-primary-action" autoFocus disabled={busy || !synced} onClick={() => run('login', signal => mutate(`/jobs/${encodeURIComponent(runningJob!.id)}/login`, { action: 'open' }, signal))}><Play size={15} />打开登录窗口</button> : <button className="requirements-primary-action" autoFocus disabled={busy || !synced} onClick={() => run('login', signal => mutate(`/jobs/${encodeURIComponent(runningJob!.id)}/login`, { action: 'continue' }, signal))}><Check size={15} />我已完成登录，继续取证</button>}
                  <button disabled={busy || !synced} onClick={() => run('cancel', signal => mutate(`/jobs/${encodeURIComponent(runningJob!.id)}/cancel`, {}, signal))}><Square size={15} />取消取证</button>
                </div>
                {feedback('login')}{feedback('overview')}
                {error && <p className="requirements-error" role="alert">{error}</p>}
              </dialog>
            </div>}
            {lastJob?.error && <p className="requirements-error" role="alert">{stages[lastJob.stage]} · {lastJob.error}</p>}
            {!!validation?.errors.length && <div className="requirements-error" role="alert"><div><strong>静态设计检查存在问题</strong><ul>{validation.errors.map((item, index) => <li key={index}>{item}</li>)}</ul></div><button onClick={() => changeSection('artifacts', true)}>查看系统产物</button></div>}
            {captureNeedsInput && <section className="requirements-capture-recovery" aria-label="取证待补充">
              <h3>取证待补充</h3>
              <p>{lastJob?.error?.includes('PAGE_CAPTURE_LOGIN') ? '目标系统需要登录，当前独立取证浏览器没有登录会话。仅在你自己的浏览器登录不会同步到平台。' : '本次取证已停止，请根据失败原因补充页面访问信息。'}</p>
              <form onSubmit={event => { event.preventDefault(); run('capture-preview', signal => mutate('/preview', { origin: previewOrigin.trim(), entryPaths }, signal, 'PATCH')) }}>
                <fieldset disabled={disabled}><label>修正取证地址<input type="url" required aria-label="修正取证地址" maxLength={200} value={previewOrigin} onChange={event => setPreviewOrigin(event.target.value)} /></label><label>修正取证业务入口<textarea rows={2} maxLength={13000} value={previewEntries} onChange={event => setPreviewEntries(event.target.value)} placeholder="每行一个完整入口，包含 projectId 等非敏感参数" /></label><button type="submit"><Save size={15} />保存地址</button></fieldset>
              </form>
              <form onSubmit={event => {
                event.preventDefault()
                run('capture-note', async signal => {
                  if (/\b(?:password|passwd|cookie|authorization|access[_-]?token|secret)\s*[:=]|(?:密码|令牌)\s*[:：=]/i.test(captureNote)) throw new Error('请移除密码、Cookie、令牌或其他凭据，只提交非敏感访问说明')
                  const form = new FormData()
                  form.set('version', String(project.version))
                  form.append('files', new File([captureNote.trim()], 'capture-access-notes.txt', { type: 'text/plain' }))
                  try { await request(`${endpoint}/sources`, signal, form) } catch (caught) { await refresh(signal).catch(() => {}); throw caught }
                  await refresh(signal); setCaptureNote('')
                })
              }}><fieldset disabled={disabled}><label>页面访问补充说明<textarea aria-label="页面访问补充说明" required maxLength={8000} rows={4} value={captureNote} onChange={event => setCaptureNote(event.target.value)} /></label>
                <p className="requirements-card-description">仅填写路由、登录要求、依赖域名或读取接口说明，不要填写密码、Cookie 或令牌。提交后需重新分析需求并确认 PRD；不会自动开放跨域访问或恢复登录。</p>
                <button type="submit" disabled={!captureNote.trim()}><Upload size={15} />提交补充资料</button></fieldset></form>
              {feedback('capture')}
              <button className="requirements-primary-action" type="button" disabled={disabled || !analyzed || unresolved.length > 0} onClick={() => job('prd', retryPrd)}><RefreshCw size={15} />重新取证并生成 PRD</button>
            </section>}
          </section>
          <div ref={sectionTabs} className="requirements-detail-tabs" role="tablist" aria-label="任务详情功能分区">{detailSections.map((item, index) => <button key={item.id} id={`requirements-tab-${item.id}`} type="button" role="tab" data-section={item.id} aria-selected={activeSection === item.id} aria-controls={`requirements-panel-${item.id}`} tabIndex={activeSection === item.id ? 0 : -1} onClick={() => changeSection(item.id)} onKeyDown={event => {
            const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? detailSections.length - 1 : offset ? (index + offset + detailSections.length) % detailSections.length : undefined
            if (next !== undefined) { event.preventDefault(); changeSection(detailSections[next].id, true) }
          }}><item.icon size={16} aria-hidden="true" /><span>{item.title}</span>{item.id === 'sources' && <small>{project.sources.length}</small>}{item.id === 'decisions' && <small data-urgent={unresolved.length > 0 || undefined} aria-label={unresolved.length ? `${unresolved.length} 个待回答` : `${project.decisions.length} 项已确认`}>{unresolved.length || project.decisions.length}</small>}{item.id === 'activity' && <small>{project.jobs.length}</small>}</button>)}</div>
          <section id="requirements-panel-sources" className="requirements-detail-panel" role="tabpanel" aria-labelledby="requirements-tab-sources" hidden={activeSection !== 'sources'} tabIndex={0}>
            <header className="requirements-zone-heading"><h2>用户输入与证据</h2><p>原始资料与系统提取依据分开查看，取证与代码配置按需展开。</p></header>
            <div className="requirements-input-grid"><div>
          <section className="requirements-card" aria-label="需求资料"><div className="requirements-card-heading"><h3><FolderOpen size={16} aria-hidden="true" />原始资料</h3><span className="requirements-badge">用户输入 · {project.sources.length}</span></div>
            {!project.sources.length && <p className="requirements-empty">暂无补充资料，可添加文件、链接或已有项目代码。</p>}
            {project.sources.length > 0 && <ul className="requirements-source-list" aria-label="原始资料列表" tabIndex={0}>{project.sources.map(source => <li key={source.id}>{source.kind === 'url' ? <Globe size={17} aria-hidden="true" /> : <FileText size={17} aria-hidden="true" />}<div><strong>{source.name}</strong><p>{source.kind === 'file' && source.name === 'existing-project-code.md' ? '代码快照（只读） · ' : ''}{source.kind === 'file' ? `${source.sizeBytes} B` : source.url}</p>{source.remoteCode && <><p>仓库地址：{source.remoteCode.repository}</p><p>分支：{source.remoteCode.branch || '默认分支'} · 模块目录：{source.remoteCode.directory || '仓库根目录'}</p></>}<details><summary>来源标识</summary><small>{source.id}</small>{source.remoteCode && <p>提交：{source.remoteCode.commit}</p>}</details></div><span className="requirements-badge">{source.kind === 'file' ? '文件' : '链接'}</span></li>)}</ul>}
            <details className="requirements-source-additions"><summary><Upload size={15} aria-hidden="true" />补充文件与链接<ChevronDown size={14} aria-hidden="true" /></summary>
            <form onSubmit={event => { event.preventDefault(); run('upload', async signal => { const form = new FormData(); form.set('version', String(project.version)); files.forEach(file => form.append('files', file)); try { await request(`${endpoint}/sources`, signal, form) } catch (caught) { await refresh(signal).catch(() => {}); throw caught } await refresh(signal); setFiles([]); if (fileInput.current) fileInput.current.value = '' }) }}><fieldset disabled={disabled}><label className={`requirements-upload-drop${files.length ? ' has-file' : ''}`}><span>补充文件</span><input ref={fileInput} type="file" multiple aria-label="补充文件" onChange={event => setFiles(Array.from(event.target.files || []))} /><strong aria-hidden="true">{files.length ? `已选 ${files.length} 个文件` : '选择要上传的资料文件'}</strong><small aria-hidden="true">单次最多 7 个文件 · 累计上限 30 MiB</small></label>{files.length > 0 && <ul className="requirements-file-pills">{files.map((file, index) => <li key={`${file.name}:${index}`}><span>{file.name}</span></li>)}</ul>}<button disabled={!files.length}><Upload size={15} />上传资料</button></fieldset></form>
            <form onSubmit={event => { event.preventDefault(); run('link', async signal => { await mutate('/sources', { url: url.trim() }, signal); setUrl('') }) }}><fieldset disabled={disabled}><label>补充链接<input type="url" placeholder="https://example.com/requirement" required value={url} onChange={event => setUrl(event.target.value)} /></label><button disabled={!/^https?:\/\//i.test(url.trim())}><Plus size={15} />添加链接</button></fieldset></form>
            </details>
            {feedback('sources')}
            {project.remoteCodeConfig && <p className="requirements-prewrap" style={{ overflowWrap: 'anywhere' }}>已保存的仓库配置：{project.remoteCodeConfig.repository} · {project.remoteCodeConfig.branch || '默认分支'} · {project.remoteCodeConfig.directory || '仓库根目录'}</p>}
            <details className="requirements-source-additions"><summary><FolderOpen size={15} aria-hidden="true" />添加已有项目代码<ChevronDown size={14} aria-hidden="true" /></summary>
              <div className="requirements-code-stack">
                <CodeDirectoryInput disabled={disabled} onAdd={selection => action(async signal => { const snapshot = await readCodeSnapshot(selection, signal); await mutate('/code-snapshot', { files: snapshot }, signal); await refresh(signal) })} />
                <RemoteCodeInput saved={project.remoteCodeConfig} disabled={disabled} onAdd={selection => action(signal => mutate('/remote-code-snapshot', { ...selection }, signal))} />
              </div>
            </details>
          </section>
          <section className="requirements-card" aria-label="现有系统取证"><div className="requirements-card-heading"><h3><Layers size={16} aria-hidden="true" />现有系统取证</h3><span className="requirements-badge" data-configured={!!project.preview || undefined}>{project.preview ? '已配置' : '未配置'}</span></div>
            <p className="requirements-card-description">提供现有页面地址，作为设计参考与页面基线来源。</p>
            <form onSubmit={event => { event.preventDefault(); run('preview', signal => mutate('/preview', { origin: previewOrigin.trim(), entryPaths }, signal, 'PATCH')) }}>
              <fieldset disabled={disabled}><label>现有系统地址<input type="url" aria-label="现有系统地址" placeholder="http://localhost:5173" maxLength={200} value={previewOrigin} onChange={event => setPreviewOrigin(event.target.value)} /></label>
                <label>完整业务入口（可选，每行一个）<textarea rows={3} maxLength={13000} aria-describedby="preview-entry-help" value={previewEntries} onChange={event => setPreviewEntries(event.target.value)} placeholder="https://tmp.test.sunmi.com/projects/overview/view?projectId=123" /></label>
                <p id="preview-entry-help" className="requirements-card-description">页面依赖项目或计划参数时，粘贴浏览器中的完整入口；最多 12 条，同一取证环境，不含密码、Cookie 或令牌。这里只补充取证上下文，不改变已确认的需求分类。</p>
                <div className="requirements-toolbar requirements-compact-actions"><button type="submit" disabled={!previewOrigin.trim()}><Save size={15} />保存取证地址</button>{project.preview && <><button type="button" onClick={() => run('preview', signal => mutate('/preview', { origin: project.preview!.origin }, signal, 'PATCH'))}><RefreshCw size={15} />下次重新取证</button><button type="button" onClick={() => run('preview', signal => mutate('/preview', { origin: '' }, signal, 'PATCH'))}><X size={15} />停用取证</button></>}</div>
              </fieldset>
              {project.preview && <p className="requirements-preview-status" role="status">{project.preview.origin} · 取证版本 {project.preview.generation}</p>}
            </form>
            {feedback('preview')}{project.preview && runningJob?.stage === 'prd' && taskFeedback}
          </section>
          </div><section className="requirements-card requirements-evidence" aria-label="资料证据"><div className="requirements-card-heading"><h3><FileText size={16} aria-hidden="true" />系统提取证据</h3><span className="requirements-badge">只读依据</span></div><p className="requirements-card-description">系统整理的摘要与局限，不等同于用户原始输入或运行验证。</p>
            {runningJob?.stage === 'analyze' && taskFeedback}
            {!project.evidence.length && <p className="requirements-empty">{runningJob?.stage === 'analyze' ? '资料分析完成后，证据摘要会更新在此处。' : '分析需求后，在此查看资料摘要及其局限。'}</p>}
            {project.evidence.map((item, index) => <article className="requirements-evidence-item" key={`${item.sourceId}:${index}`}><h4>{project.sources.find(source => source.id === item.sourceId)?.name || item.sourceId}</h4><p className="requirements-prewrap">{item.summary}</p><p className="requirements-limitations">局限：{item.limitations || '未记录'}</p></article>)}
            <SystemPageEvidence anchors={project.sourceAnchors ?? []} revision={revision} revisionNumber={revision ? project.revisions.indexOf(revision) + 1 : 0} historical={historical} endpoint={endpoint}>
              {!historical && !revision?.capturePlan?.sourceFallback?.images?.length && <button type="button" disabled={disabled || !analyzed || !currentPrd || !!unresolved.length || !project.sources.some(source => source.kind === 'file' && source.name === 'existing-project-code.md')} onClick={() => job('reconstruct')}><Layers size={15} aria-hidden="true" />生成现状复刻图</button>}
              {(!evidenceJob || operation?.state === 'pending' || operation?.state === 'error') && !historical && feedback('reconstruction')}
              {evidenceJob?.status === 'running' && taskFeedback}
              {evidenceJob && ['failed', 'cancelled', 'interrupted'].includes(evidenceJob.status) && <ExecutionFeedback state={evidenceJob.status === 'failed' ? 'error' : 'waiting'} title={`现状复刻${jobStatuses[evidenceJob.status]}`} detail={evidenceJob.error || '未保存复刻图，原修订保持不变。'} />}
            </SystemPageEvidence>
          </section></div>
          </section>
          <section id="requirements-panel-decisions" className="requirements-detail-panel" role="tabpanel" aria-labelledby="requirements-tab-decisions" hidden={activeSection !== 'decisions'} tabIndex={0}>
            <header className="requirements-zone-heading"><h2>澄清与决策</h2><p>优先处理待回答问题，已确认的业务决策单独保留。</p></header>
            {!unresolved.length && <div className="requirements-empty"><Check size={18} aria-hidden="true" /><strong>当前没有待澄清问题</strong><p>已提交的答案保留在下方决策记录中。</p></div>}
          {currentQuestion && <section className="requirements-card requirements-clarification" aria-label="待澄清问题"><div className="requirements-card-heading"><h3>待澄清问题 · {unresolved.length}</h3><span className="requirements-badge" role="status" aria-live="polite" aria-atomic="true">第 {questionIndex + 1} / {unresolved.length} 条 · 已填写 {answeredCount} / {unresolved.length}</span></div><div className="requirements-question-meter" aria-hidden="true"><span style={{ width: `${Math.round((answeredCount / unresolved.length) * 100)}%` }} /></div>{prdClarification && <p className="requirements-prd-clarification-note">这些问题来自 PRD 阶段。提交全部答案后可继续生成 PRD；修改代码或资料后仍需重新分析。</p>}<p id="requirements-question-help" className="requirements-card-description">选择选项后自动进入下一条，可返回修改；手动填写后使用“下一条”。方向键浏览选项，空格键确认。</p>{storageError && <p className="requirements-error" role="alert">{storageError}</p>}<form onSubmit={event => {
            event.preventDefault(); const submitted = unresolved.filter(item => answers[item.id]?.trim()).map(item => ({ questionId: item.id, answer: answers[item.id].trim() }))
            run('answers', async signal => { await mutate('/answers', { answers: submitted }, signal); setAnswers(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => !submitted.some(item => item.questionId === id)))) })
          }}><fieldset disabled={disabled}><fieldset key={currentQuestion.id} className="requirements-question" aria-describedby="requirements-question-help">
            <legend ref={questionHeading} tabIndex={-1}><span className="requirements-priority-tag" data-priority={currentQuestion.priority}>{currentQuestion.priority}</span><span>{currentQuestion.text}</span></legend><p className="requirements-question-impact">{currentQuestion.impact}</p>
            <div className="requirements-question-choices">{currentQuestion.choices.map((choice, index) => <label className="requirements-choice" key={index}>
              <input type="radio" name={`question-${currentQuestion.id}`} aria-label={choice} aria-describedby={choice === currentQuestion.recommendation ? `requirements-recommendation-${index}` : undefined} checked={answers[currentQuestion.id] === choice} onChange={() => setAnswers(previous => ({ ...previous, [currentQuestion.id]: choice }))} onClick={event => chooseAnswer(choice, event.detail ? 'pointer' : 'keyboard')} onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); chooseAnswer(choice, 'keyboard'); return }
                const offset = ['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : ['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : 0
                if (offset) {
                  event.preventDefault()
                  const next = (index + offset + currentQuestion.choices.length) % currentQuestion.choices.length
                  setAnswers(previous => ({ ...previous, [currentQuestion.id]: currentQuestion.choices[next] }))
                  event.currentTarget.closest('fieldset')?.querySelectorAll<HTMLInputElement>('input[type=radio]')[next]?.focus()
                }
              }} />
              <span>{choice}{choice === currentQuestion.recommendation && <span id={`requirements-recommendation-${index}`} className="requirements-recommendation">【推荐】</span>}</span>
            </label>)}</div>
            <label>回答 · {currentQuestion.id}<textarea rows={3} placeholder="选择上方推荐项，或在此输入具体业务约束与补充说明…" value={answers[currentQuestion.id] || ''} onChange={event => setAnswers(previous => ({ ...previous, [currentQuestion.id]: event.target.value }))} /></label>
          </fieldset></fieldset>
          <div className="requirements-question-footer"><nav className="requirements-question-navigation" aria-label="澄清问题切换"><button type="button" disabled={questionIndex === 0} onClick={event => showQuestion(questionIndex - 1, event.detail ? 'pointer' : 'keyboard')}><ChevronLeft size={15} aria-hidden="true" />上一条</button><button type="button" disabled={questionIndex === unresolved.length - 1} onClick={event => showQuestion(questionIndex + 1, event.detail ? 'pointer' : 'keyboard')}>下一条<ChevronRight size={15} aria-hidden="true" /></button></nav>
            <button className="requirements-primary-action" type="submit" disabled={disabled || !answeredCount}><Save size={15} />提交已填写答案</button>
          </div></form></section>}
          {feedback('answers')}
          {project.decisions.length > 0 && <details className="requirements-card requirements-decisions"><summary>已确认决策 · {project.decisions.length}</summary><div className="requirements-decision-list">{project.decisions.map((decision, index) => <article key={`${decision.question.id}:${index}`}><div className="requirements-decision-head"><span className="requirements-priority-tag" data-priority={decision.question.priority}>{decision.question.priority}</span><h3>{decision.question.text}</h3></div><p className="requirements-prewrap">{decision.answer}</p><time dateTime={decision.at}>{new Date(decision.at).toLocaleString()}</time></article>)}</div></details>}
          </section>
          <section id="requirements-panel-artifacts" className="requirements-detail-panel" role="tabpanel" aria-labelledby="requirements-tab-artifacts" hidden={activeSection !== 'artifacts'} tabIndex={0}>
            <header className="requirements-zone-heading"><h2>系统产物</h2><p>围绕选中修订，集中审阅 PRD、设计原型及静态检查结果。</p></header>
            {taskFeedback}
            {!revision && <div className="requirements-empty"><FileText size={20} aria-hidden="true" /><strong>{running ? '正在处理任务，系统产物尚未就绪' : '尚未生成系统产物'}</strong><p>{running ? '任务完成后将在此更新结果，无需重复启动。' : '补充资料并分析需求后，使用顶部阶段操作生成 PRD。'}</p></div>}
          {revision && <section className="requirements-artifact-shell" aria-label="修订评审">
            <div className="requirements-artifact-bar">
              <div className="requirements-revision-toolbar">
                <FilterSelect label="修订历史" value={revision.id} options={project.revisions.map((item, index) => ({ value: item.id, label: `修订 ${index + 1} · ${new Date(item.createdAt).toLocaleString()}${item.id === latest?.id ? ' · 当前' : ''}` }))} onChange={value => { if (editing && !window.confirm('放弃未保存的 PRD 编辑并切换修订？')) return; setRevisionId(value); setSelectedId(''); setEditing(false) }} />
                {revision.prd.templateVersion !== 2 && <div className="requirements-exports" aria-label="导出修订"><Download size={16} />{(['md', 'docx', 'html', 'zip'] as const).map(format => <a key={format} href={`${endpoint}/exports?format=${format}&revision=${encodeURIComponent(revision.id)}`} download>{format.toUpperCase()}</a>)}</div>}
              </div>
              <div className="requirements-artifact-meta">
                {historical && <span className="requirements-badge" data-tone="amber" role="status">历史修订 · 只读</span>}
                {revision.capturePlan?.sourceFallback && <span className="requirements-badge" data-tone="amber">基于源码复刻 · 真实运行态未验证</span>}
                <span className="requirements-badge" data-confirmed={!!revision.confirmedAt || undefined}>PRD：{revision.confirmedAt ? '已确认' : '未确认'}</span>
                <span className="requirements-badge" data-confirmed={!!revision.designConfirmedAt || undefined}>设计：{revision.designConfirmedAt ? '已确认' : '未确认'}</span>
                <details className="requirements-scope-disclosure"><summary>验证边界说明</summary><p className="requirements-limitations">验证范围：仅静态页面、映射与截图检查；未验证业务交互、接口或端到端流程。确认设计不代表交互验收通过，HTML 导出也是静态截图原型。</p></details>
                <button ref={reviewTrigger} data-review-toggle type="button" disabled={editing} onClick={() => setWideReview(true)}><Maximize2 size={15} />宽屏评审</button>
              </div>
            </div>
            {validation && <details className="requirements-validation-strip" open><summary role="status"><span className="requirements-status-dot" data-status={validation.errors.length ? 'failed' : staticValidated ? 'completed' : 'needs_input'} aria-hidden="true" /><strong>静态设计检查：</strong><span>{validation.errors.length ? `发现 ${validation.errors.length} 项问题` : staticValidated ? '静态检查未报告错误 · 交互未验证' : '静态验证证据不完整，请重新检查设计 · 交互未验证'}</span><time dateTime={validation.at}>{formatTime(validation.at)}</time></summary><div className="requirements-validation-detail">{validation.errors.length > 0 && <ul>{validation.errors.map((item, index) => <li key={index}>{item}</li>)}</ul>}{Array.isArray(validation.limitations) && <ul aria-label="验证局限">{validation.limitations.filter((item): item is string => typeof item === 'string').map((item, index) => <li key={index}>{item}</li>)}</ul>}</div></details>}
            <dialog ref={reviewDialog} open className="requirements-review-dialog" data-business-focus={focusedBusiness || undefined} aria-label="审阅模式" onCancel={event => { event.preventDefault(); setWideReview(false) }}>
            {focusedBusiness ? <button className="business-close" data-review-toggle type="button" aria-label="关闭宽屏评审" title="关闭宽屏评审" onClick={() => setWideReview(false)}><X size={20} /></button> : <div className={`requirements-review-controls${wideReview ? ' requirements-review-dialog-heading' : ''}`}>
            {wideReview && <h2>审阅模式</h2>}
            {wideReview && revision.capturePlan?.sourceFallback && <span className="requirements-badge" data-tone="amber">基于源码复刻 · 真实运行态未验证</span>}
            <label className="requirements-divider">设计区域宽度 <input aria-label="设计区域宽度" type="range" min={35} max={70} value={split} onChange={event => setSplit(Number(event.target.value))} /><output>{split}%</output></label>
            <div className="requirements-review-actions"><button ref={exportTrigger} className="requirements-prd-export" type="button" disabled={busy || running || editing || !synced || exporting} aria-busy={exporting} title={revision.prd.templateVersion === 2 ? '下载 ZIP：业务评审版和开发规格版 Word，包含对应功能的原型截图' : '导出 Word 文档：仅 PRD 正文及本修订的原型截图'} onClick={exportPrd}><Download size={15} />{exporting ? '正在导出…' : '导出 PRD'}</button>
            {wideReview && <button data-review-toggle type="button" aria-label="关闭宽屏评审" title="关闭宽屏评审" onClick={() => setWideReview(false)}><X size={16} /></button>}</div>
            {exportStatus?.revisionId === revision.id && <p className="requirements-review-export-status" role={exportStatus.error ? 'alert' : 'status'}><span>{exportStatus.text}</span>{!exporting && <button type="button" aria-label="关闭导出提示" onClick={() => { setExportStatus(undefined); exportTrigger.current?.focus() }}><X size={15} /></button>}</p>}
            </div>}
            <fieldset className="requirements-mobile-switch requirements-segments"><legend className="requirements-sr-only">评审视图</legend>{[{ id: 'design', title: '设计' }, { id: 'prd', title: 'PRD' }].map(view => <label key={view.id}><input type="radio" name="requirements-mobile-view" checked={mobileView === view.id} onChange={() => setMobileView(view.id)} />{view.title}</label>)}</fieldset>
            <div className="requirements-review" data-mobile-view={mobileView} style={{ '--requirements-split': `${split}%` } as React.CSSProperties}>
              <div className="requirements-prd-pane" tabIndex={0} role="region" aria-label="PRD 评审">{feedback('prd')}<PrdReview key={revision.id} prd={revision.prd} revision={revision} projectId={project.id} selectedId={selectedId} reviewMode={wideReview} edition={edition} onEditionChange={setEdition} activeNote={activeNote?.key} onNote={key => setNoteSelection({ revisionId: revision.id, key })} onRead={requirementId => setReading({ revisionId: revision.id, requirementId })} onSelect={setSelectedId} busy={busy || running || !synced} readOnly={focusedBusiness || historical || !!revision.confirmedAt || !analyzed || unresolved.length > 0} onEditing={setEditing} onSave={async (prd: StructuredPrd) => { await action(signal => mutate('/prd', { prd }, signal, 'PATCH'), 'save-prd'); setEditing(false) }} />
                {business && !historical && <>{(!revision.businessReview || revision.businessReview.changes.some(change => change.scope === 'ui' && !change.screenIds.length && revision.screens.length > 0)) && <button type="button" disabled={disabled || !currentPrd || !!unresolved.length} onClick={() => job('business-review')}><RefreshCw size={15} />整理业务变更</button>}
                  {(!reviewJob || operation?.state !== 'success') && feedback('business-review')}
                  {reviewJob && (!focusedBusiness || reviewJob.status !== 'succeeded') && <p role={reviewJob.status === 'failed' ? 'alert' : 'status'}>整理业务变更：{jobStatuses[reviewJob.status]}{reviewJob.error && ` · ${reviewJob.error}`}{reviewJob.status === 'running' && <button type="button" disabled={busy} onClick={() => run('cancel', signal => mutate(`/jobs/${encodeURIComponent(reviewJob.id)}/cancel`, {}, signal))}>取消整理</button>}</p>}
                </>}
              </div>
              <div className="requirements-design-pane" tabIndex={0} role="region" aria-label="设计评审">{runningJob?.stage === 'design' || runningJob?.stage === 'validate' ? taskFeedback : null}{business ? <BusinessPreview key={`${revision.id}:${activeNote?.key}`} note={activeNote} revision={revision} projectId={project.id} /> : <DesignReview key={project.id} projectId={project.id} revision={revision} preferredScreen={adjustedPage} running={running} job={designJob} progress={designProgress} requestError={error} onRefresh={() => run('refresh', signal => refresh(signal))} taskError={lastJob?.status === 'failed' ? lastJob.error : undefined} onCancel={runningJob ? () => run('cancel', signal => mutate(`/jobs/${encodeURIComponent(runningJob.id)}/cancel`, {}, signal)) : undefined} selectedId={reading.revisionId === revision.id ? reading.requirementId : ''} adjustmentDisabled={disabled || !analyzed || !currentPrd || unresolved.length > 0 || !revision.confirmedAt} onAdjust={(screenId, instruction) => action(async signal => { setMobileView('design'); const target = revision.screens.find(screen => screen.id === screenId); if (target) setAdjustedPage({ title: target.title, state: target.state }); await mutate('/jobs', { stage: 'design', screenId, instruction }, signal) })} />}</div>
            </div>
            </dialog>
            <details className="requirements-revision-feedback"><summary><MessageSquare size={16} aria-hidden="true" />修订意见<ChevronDown size={14} aria-hidden="true" /></summary><p>需求内容的修改走修订流程；单页设计调整请使用“调整原型”。</p>
            <form onSubmit={event => { event.preventDefault(); run('revision', async signal => { await mutate('/revisions', { instruction: instruction.trim() }, signal); setRevisionId(''); setSelectedId(''); setInstruction('') }) }}><fieldset disabled={disabled}><label>修订意见<textarea rows={3} placeholder="说明需要新增、修改或精简的业务规则，提交后将基于该修订重新分析…" required value={instruction} onChange={event => setInstruction(event.target.value)} /></label><button disabled={!instruction.trim()}><Plus size={15} />创建修订</button></fieldset></form>
            </details>
            {feedback('revision')}
          </section>}
          </section>
          <section id="requirements-panel-activity" className="requirements-detail-panel" role="tabpanel" aria-labelledby="requirements-tab-activity" hidden={activeSection !== 'activity'} tabIndex={0}>
            <header className="requirements-zone-heading"><h2>任务记录</h2><p>阶段执行结果与过程日志分开查看；运行进度、错误及登录请求仍在顶部提示。</p></header>
            {taskFeedback}
            <div className="requirements-activity-grid"><section className="requirements-card" aria-label="阶段任务"><div className="requirements-card-heading"><h3>阶段任务 · {project.jobs.length}</h3><span className="requirements-badge">执行历史</span></div>{!project.jobs.length && <p className="requirements-empty">暂无执行任务。</p>}<ul className="requirements-job-list">{project.jobs.map(item => <li key={item.id}><div><strong>{stages[item.stage]}</strong><time dateTime={item.startedAt}>{new Date(item.startedAt).toLocaleString()}{item.endedAt ? ` → ${formatTime(item.endedAt)}` : ''}</time>{item.error && <p className="requirements-error">{item.error}</p>}</div><span className="requirements-status-pill" data-status={item.status === 'succeeded' ? 'completed' : item.status}>{jobStatuses[item.status]}</span></li>)}</ul></section>
            <section className="requirements-card" aria-label="进度时间线"><div className="requirements-card-heading"><h3>进度时间线</h3><span className="requirements-badge">{project.events.length} 条</span></div>{!project.events.length && <p className="requirements-empty">暂无进度记录。</p>}<ol className="requirements-event-list">{project.events.map(item => <li key={item.id}><time dateTime={item.at}>{new Date(item.at).toLocaleString()}</time><p>{item.text}</p></li>)}</ol></section></div>
          </section>
        </>}
      </div>
    </div>
  </main>
}