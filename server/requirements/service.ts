import { createHash, randomUUID } from 'node:crypto'
import type { RequirementJobStage, RequirementLoginControls, RequirementModel, RequirementProject, RequirementRepository, RequirementRevision } from '../../shared/requirements.js'
import { prototypeScreens } from '../../shared/requirement-prototypes.js'
import { availableModels, validateModel } from '../execution/models.js'
import { exportRequirementRevision, validatePrototypeRevision } from './artifacts.js'
import { CopilotRequirementModel } from './model.js'
import { RequirementConflictError } from './repository.js'
import { SOURCE_MAX_BYTES, storeSourceFile, validateSourceFile, validateSourceUrl } from './sources.js'
import { validateEvidence, validatePrd, validateQuestions, validateScreens } from './validation.js'
import { RequirementDiagnosticError, requirementDiagnostic, type RequirementFailurePhase } from './diagnostics.js'
import { createCodeSnapshot } from './code-snapshot.js'
import { loadRemoteCode, RemoteCodeError, remoteCodeSnapshotLimits, validateRemoteCodeInput } from './remote-code.js'
import { requirementPreviewOrigin } from '../../shared/requirement-preview.js'
import { validatePrototypeDesign } from './prototype-design.js'

export class RequirementServiceError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message) }
}
export function requirementObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(value).some(key => !keys.includes(key))) throw new RequirementServiceError(400, 'Invalid request fields')
  return value as Record<string, unknown>
}
export function requirementText(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new RequirementServiceError(400, 'Invalid text or length')
  return value.trim()
}
function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) >= Number.MAX_SAFE_INTEGER) throw new RequirementServiceError(400, 'Invalid expectedVersion')
  return Number(value)
}
function conflict(message: string): never { throw new RequirementServiceError(409, message) }
const now = () => new Date().toISOString()
const inputChanged = 'inputs:changed'
type Upload = { name: string; buffer: Buffer }
type PendingLogin = { jobId: string; controls: RequirementLoginControls; busy: boolean; resolve(): void; reject(error: Error): void }
export interface RequirementServiceOptions {
  loadRemoteCode?: typeof loadRemoteCode
  model?: RequirementModel
  availableModels?: typeof availableModels
  validatePrototype?: typeof validatePrototypeRevision
  exportRevision?: typeof exportRequirementRevision
}

export class RequirementService {
  private readonly model: RequirementModel
  private readonly active = new Map<string, { controller: AbortController; work: Promise<void>; login?: PendingLogin }>()
  private closing = false
  constructor(private readonly repository: RequirementRepository, private readonly root: string, private readonly options: RequirementServiceOptions = {}) {
    this.model = options.model ?? new CopilotRequirementModel()
  }
  async list(ownerId: number) { return this.repository.list(ownerId) }
  async detail(ownerId: number, id: string): Promise<RequirementProject> {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) throw new RequirementServiceError(404, 'Project not found')
    const project = await this.repository.get(id, ownerId)
    if (!project || project.ownerId !== ownerId) throw new RequirementServiceError(404, 'Project not found')
    return project
  }
  private event(project: RequirementProject, text: string) {
    if (project.events.length >= 10000) conflict('Project event limit reached')
    project.events.push({ id: randomUUID(), at: now(), text })
  }
  private async save(project: RequirementProject): Promise<RequirementProject> {
    const expectedVersion = project.version
    project.version++
    project.updatedAt = new Date(Math.max(Date.now(), Date.parse(project.updatedAt))).toISOString()
    await this.repository.replace(project, expectedVersion)
    return project
  }
  private async editable(ownerId: number, id: string, expectedVersion: unknown) {
    const expected = version(expectedVersion)
    const project = await this.detail(ownerId, id)
    if (project.version !== expected) throw new RequirementConflictError()
    if (this.closing || project.jobs.some(job => job.status === 'running') || project.status === 'running') conflict('Project is busy')
    return project
  }
  private invalidate(project: RequirementProject) {
    project.status = 'draft'
    project.evidence = []
    project.questions = []
    this.event(project, inputChanged)
  }
  private analyzed(project: RequirementProject) {
    const job = project.jobs.findLast(item => item.stage === 'analyze' && item.status === 'succeeded')
    return !!job && project.events.findLastIndex(event => event.text === `analysis:${job.id}`) > project.events.findLastIndex(event => event.text === inputChanged)
  }
  private unresolved(project: RequirementProject) {
    return project.questions.filter(question => !project.decisions.some(decision => decision.question.id === question.id))
  }
  private async selectedModel(modelId: unknown, token: string, images: boolean) {
    requirementText(modelId, 120)
    try { return validateModel(modelId, modelId === 'auto' ? [] : await (this.options.availableModels ?? availableModels)(token), images) }
    catch { throw new RequirementServiceError(400, 'Selected model is unavailable or does not support image sources') }
  }
  async create(ownerId: number, value: unknown, token: string): Promise<RequirementProject> {
    const body = requirementObject(value, ['title', 'description', 'modelId'])
    if (this.closing) throw new RequirementServiceError(503, 'Requirements service is closing')
    if (!Number.isSafeInteger(ownerId) || ownerId < 1) throw new RequirementServiceError(401, 'Authentication required')
    const title = requirementText(body.title, 200), description = requirementText(body.description, 100000)
    const modelId = await this.selectedModel(body.modelId, token, false)
    const at = now()
    const project: RequirementProject = { schemaVersion: 1, id: randomUUID(), ownerId, version: 1, title, description, modelId, createdAt: at, updatedAt: at, status: 'draft', sources: [], evidence: [], questions: [], decisions: [], revisions: [], jobs: [], events: [] }
    await this.repository.create(project)
    return project
  }
  async addSources(ownerId: number, id: string, value: unknown, files: Upload[] = [], token = '') {
    const body = requirementObject(value, ['expectedVersion', 'url'])
    const project = await this.editable(ownerId, id, body.expectedVersion)
    if (!Array.isArray(files) || files.length > 7 || (!files.length && body.url === undefined) || (files.length && body.url !== undefined)) throw new RequirementServiceError(400, 'Supply files or one URL')
    if (project.sources.length + (files.length || 1) > 100) throw new RequirementServiceError(400, 'Source count exceeds 100')
    let bytes = project.sources.reduce((total, source) => total + source.sizeBytes, 0)
    for (const file of files) {
      requirementObject(file, ['name', 'buffer'])
      if (!Buffer.isBuffer(file.buffer)) throw new RequirementServiceError(400, 'Invalid source bytes')
      try { validateSourceFile(file.name, file.buffer) } catch { throw new RequirementServiceError(400, 'Invalid source file') }
      bytes += file.buffer.length
    }
    if (bytes > 30 * 1024 * 1024 || files.some(file => file.buffer.length > SOURCE_MAX_BYTES)) throw new RequirementServiceError(400, 'Sources exceed 30 MiB')
    if (files.some(file => /\.(png|jpe?g|webp)$/i.test(file.name))) await this.selectedModel(project.modelId, token, true)
    let url: string | undefined
    if (body.url !== undefined) {
      try { url = validateSourceUrl(requirementText(body.url, 2048)).href } catch { throw new RequirementServiceError(400, 'Invalid public source URL') }
    }
    const sources = []
    for (const file of files) sources.push(await storeSourceFile(this.root, ownerId, id, file.name, file.buffer))
    if (url) sources.push({ id: randomUUID(), name: url, kind: 'url' as const, url, sha256: createHash('sha256').update(url).digest('hex'), sizeBytes: 0 })
    project.sources.push(...sources)
    this.invalidate(project)
    return this.save(project)
  }
  async configurePreview(ownerId: number, id: string, value: unknown, token: string) {
    const body = requirementObject(value, ['expectedVersion', 'origin'])
    const project = await this.editable(ownerId, id, body.expectedVersion)
    let origin: string
    try { origin = body.origin === '' ? '' : requirementPreviewOrigin(body.origin) } catch { throw new RequirementServiceError(400, '请输入本机地址或已授权测试环境 https://tmp.test.sunmi.com，不含路径、查询和凭据；其他测试域名需加入白名单') }
    if (origin) {
      await this.selectedModel(project.modelId, token, true)
      project.preview = { origin, generation: (project.preview?.generation ?? 0) + 1 }
    } else delete project.preview
    this.event(project, 'preview:changed; existing page capture cache invalidated')
    return this.save(project)
  }
  async addCodeSnapshot(ownerId: number, id: string, value: unknown) {
    const body = requirementObject(value, ['expectedVersion', 'files'])
    const project = await this.editable(ownerId, id, body.expectedVersion)
    let buffer: Buffer
    try { buffer = createCodeSnapshot(body.files) }
    catch { throw new RequirementServiceError(400, 'Invalid or unsafe code snapshot') }
    if (project.sources.length >= 100 || buffer.length > SOURCE_MAX_BYTES || project.sources.reduce((total, source) => total + source.sizeBytes, buffer.length) > 30 * 1024 * 1024) throw new RequirementServiceError(400, 'Source count or byte limit exceeded')
    if (project.events.length >= 10000) conflict('Project event limit reached')
    const source = await storeSourceFile(this.root, ownerId, id, 'existing-project-code.md', buffer)
    project.sources.push(source)
    this.invalidate(project)
    return this.save(project)
  }
  async addRemoteCodeSnapshot(ownerId: number, id: string, value: unknown, signal?: AbortSignal) {
    const body = requirementObject(value, ['expectedVersion', 'repository', 'branch', 'directory'])
    const project = await this.editable(ownerId, id, body.expectedVersion)
    if (project.sources.length >= 100 || project.events.length >= 10000) throw new RequirementServiceError(400, 'Project source or event limit reached')
    const { expectedVersion: _expectedVersion, ...reference } = body
    let input: ReturnType<typeof validateRemoteCodeInput>
    try { input = validateRemoteCodeInput(reference) }
    catch { throw new RequirementServiceError(400, '请输入 GitHub HTTPS 或 code.sunmi.com 仓库地址，以及有效分支和相对模块目录') }
    const remote = await (this.options.loadRemoteCode ?? loadRemoteCode)(input, signal)
      .catch(error => { throw new RequirementServiceError(400, error instanceof RemoteCodeError ? error.message : '仓库读取失败，请检查地址、分支、访问权限及代码范围；不会执行仓库代码') })
    signal?.throwIfAborted()
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(remote.commit)) throw new RequirementServiceError(400, 'Invalid repository commit')
    const buffer = createCodeSnapshot(remote.files, remoteCodeSnapshotLimits)
    const metadata = Buffer.from(`Repository: ${JSON.stringify(input.repository)}\nCommit: ${remote.commit}\nBranch: ${JSON.stringify(input.branch || 'default')}\nDirectory: ${JSON.stringify(input.directory || '')}\nExcluded entries: ${remote.excluded}\n${remote.excludedFiles?.length ? `Content safety exclusions (contents not retained): ${JSON.stringify(remote.excludedFiles)}\nThis snapshot is incomplete for these files; do not infer their implementation or behavior.\n` : ''}\n`)
    const snapshot = Buffer.concat([metadata, buffer])
    if (snapshot.length > SOURCE_MAX_BYTES) throw new RequirementServiceError(400, '格式化代码快照超过 10 MiB，请填写更小的模块目录')
    const current = await this.editable(ownerId, id, body.expectedVersion)
    if (current.sources.reduce((total, source) => total + source.sizeBytes, snapshot.length) > 30 * 1024 * 1024) throw new RequirementServiceError(400, 'Source byte limit exceeded')
    const source = await storeSourceFile(this.root, ownerId, id, 'existing-project-code.md', snapshot)
    current.sources.push(source)
    this.invalidate(current)
    return this.save(current)
  }
  async answers(ownerId: number, id: string, value: unknown) {
    const body = requirementObject(value, ['expectedVersion', 'answers'])
    const project = await this.editable(ownerId, id, body.expectedVersion)
    if (!Array.isArray(body.answers) || !body.answers.length || body.answers.length > 9) throw new RequirementServiceError(400, 'Supply 1 to 9 answers')
    const pending = this.unresolved(project), seen = new Set<string>()
    const decisions = body.answers.map(item => {
      const answer = requirementObject(item, ['questionId', 'answer'])
      const questionId = requirementText(answer.questionId, 80)
      const question = pending.find(item => item.id === questionId)
      if (!question || seen.has(questionId)) throw new RequirementServiceError(400, 'Unknown, duplicate or already answered question')
      seen.add(questionId)
      return { question, answer: requirementText(answer.answer, 3000), at: now() }
    })
    if (project.decisions.length + decisions.length > 1000) conflict('Decision limit reached')
    project.decisions.push(...decisions)
    this.event(project, inputChanged)
    project.status = this.unresolved(project).length ? 'needs_input' : 'draft'
    return this.save(project)
  }
  async editPrd(ownerId: number, id: string, value: unknown) {
    const body = requirementObject(value, ['expectedVersion', 'prd'])
    const project = await this.editable(ownerId, id, body.expectedVersion)
    const revision = project.revisions.at(-1)
    if (!revision || revision.confirmedAt || !this.analyzed(project) || this.unresolved(project).length) conflict('An unconfirmed analyzed PRD is required')
    let prd
    try { prd = validatePrd(body.prd, project.sources.map(source => source.id)) } catch { throw new RequirementServiceError(400, 'Invalid structured PRD') }
    this.appendRevision(project, { id: randomUUID(), createdAt: now(), prd, screens: [] })
    project.status = 'prd_review'
    return this.save(project)
  }
  async editDesign(ownerId: number, id: string, value: unknown) {
    const body = requirementObject(value, ['expectedVersion', 'screens'])
    const project = await this.editable(ownerId, id, body.expectedVersion)
    const revision = project.revisions.at(-1)
    if (!revision?.confirmedAt || !this.analyzed(project) || !this.currentPrd(project) || this.unresolved(project).length) conflict('A confirmed current analyzed PRD and resolved questions are required')
    if (revision.prototypes?.length) conflict('Shared prototypes must be changed through their page source, not individual rendered screens')
    let screens
    try {
      screens = validateScreens(body.screens, revision.prd)
    } catch { throw new RequirementServiceError(400, 'Invalid structured design screens') }
    this.appendRevision(project, { id: randomUUID(), createdAt: now(), prd: revision.prd, confirmedAt: revision.confirmedAt, screens: screens.map(screen => ({ ...screen, id: randomUUID() })) })
    project.status = 'design_review'
    return this.save(project)
  }
  async revise(ownerId: number, id: string, value: unknown) {
    const body = requirementObject(value, ['expectedVersion', 'instruction'])
    const project = await this.editable(ownerId, id, body.expectedVersion)
    const revision = project.revisions.at(-1)
    if (!revision) conflict('A PRD revision is required')
    const instruction = requirementText(body.instruction, 10000)
    project.description = requirementText(`${project.description}\n\nRevision request:\n${instruction}`, 100000)
    this.appendRevision(project, { id: randomUUID(), createdAt: now(), prd: revision.prd, screens: [] })
    this.invalidate(project)
    return this.save(project)
  }
  private appendRevision(project: RequirementProject, revision: RequirementRevision) {
    if (project.revisions.length >= 50) conflict('Revision limit reached')
    project.revisions.push(revision)
    this.event(project, `prd:${revision.id}`)
  }
  private currentPrd(project: RequirementProject) {
    return project.events.findLastIndex(event => event.text === `prd:${project.revisions.at(-1)?.id}`) > project.events.findLastIndex(event => event.text === inputChanged)
  }
  async confirm(ownerId: number, id: string, value: unknown) {
    const body = requirementObject(value, ['expectedVersion', 'target'])
    if (!['prd', 'design'].includes(String(body.target))) throw new RequirementServiceError(400, 'Invalid confirmation target')
    const project = await this.editable(ownerId, id, body.expectedVersion)
    const revision = project.revisions.at(-1)
    if (!revision || !this.analyzed(project) || !this.currentPrd(project) || this.unresolved(project).length) conflict('Analyze current inputs, regenerate the PRD and resolve all questions first')
    if (body.target === 'prd') {
      if (revision.confirmedAt) conflict('PRD already confirmed')
      validatePrd(revision.prd, project.sources.map(source => source.id))
      revision.confirmedAt = now()
      project.status = 'prd_review'
    } else {
      const validation = revision.validation as Awaited<ReturnType<typeof validatePrototypeRevision>>['validation'] | undefined
      if (!revision.confirmedAt || revision.designConfirmedAt || !revision.screens.length || !validation || validation.errors.length || !validation.allScreensValidated || validation.artifactVersion !== 1 || validation.mode !== 'static-script-disabled' || validation.interactionVerified !== false || validation.screens.length !== revision.screens.length || !revision.screens.every(screen => validation.screens.some(check => check.screenId === screen.id && check.visual === 'passed' && check.interaction === 'not_verified'))) conflict('Current static visual validation is required; interactions are not verified')
      if (validation.screens.some(check => check.interactionErrors.length || check.viewports.length !== 2 || ![1600, 390].every(width => check.viewports.some(view => view.width === width && view.height === 1000 && !view.errors.length)))) conflict('Both desktop and mobile static visual evidence are required')
      const fingerprint = createHash('sha256').update(JSON.stringify({ projectId: project.id, revisionId: revision.id, prd: revision.prd, screens: revision.screens, sources: project.sources, decisions: project.decisions })).digest('hex')
      if (validation.inputSha256 !== fingerprint || revision.screenshots?.length !== revision.screens.length) conflict('Validation evidence is stale or incomplete')
      await (this.options.exportRevision ?? exportRequirementRevision)(project, revision, 'md', this.root)
      revision.designConfirmedAt = now()
      project.status = 'completed'
      this.event(project, 'Design confirmed: static visual evidence only; interactions are not verified')
    }
    return this.save(project)
  }
  async launch(ownerId: number, id: string, value: unknown, token: string) {
    const body = requirementObject(value, ['expectedVersion', 'stage', 'instruction', 'screenId'])
    if (!['analyze', 'prd', 'design', 'validate'].includes(String(body.stage))) throw new RequirementServiceError(400, 'Invalid job stage')
    const stage = body.stage as RequirementJobStage
    const project = await this.editable(ownerId, id, body.expectedVersion)
    if (this.active.has(id)) conflict('Previous job has not settled')
    const adjustment = body.screenId !== undefined ? { screenId: requirementText(body.screenId, 100), instruction: requirementText(body.instruction, 10000) } : undefined
    if (adjustment && (stage !== 'design' || !project.revisions.at(-1)?.screens.some(screen => screen.id === adjustment.screenId))) throw new RequirementServiceError(400, 'Select an existing design page')
    if (body.instruction !== undefined && !adjustment) {
      if (stage !== 'analyze') throw new RequirementServiceError(400, 'Revision instructions require analysis first')
      project.description = requirementText(`${project.description}\n\n${requirementText(body.instruction, 10000)}`, 100000)
      this.invalidate(project)
    }
    if (this.unresolved(project).length) conflict('Resolve pending questions first')
    const revision = project.revisions.at(-1)
    if (stage !== 'analyze' && !this.analyzed(project)) conflict('Analyze current inputs first')
    if (stage === 'design' && (!revision?.confirmedAt || !this.currentPrd(project))) conflict('Confirm the current PRD first')
    if (['prd', 'design'].includes(stage) && project.preview && !project.sources.some(source => source.kind === 'file' && source.name === 'existing-project-code.md')) throw new RequirementServiceError(400, '自动页面取证需要现有代码快照，用于确认 PRD 对应路由')
    if (stage === 'validate' && (!revision?.confirmedAt || !revision.screens.length || !this.currentPrd(project))) conflict('Generate a confirmed current PRD design first')
    if (stage !== 'validate') await this.selectedModel(project.modelId, token, (['prd', 'design'].includes(stage) && !!project.preview) || project.sources.some(source => /\.(png|jpe?g|webp)$/i.test(source.name)))
    if (project.jobs.length >= 500) conflict('Job limit reached')
    const job = { id: randomUUID(), stage, status: 'running' as const, startedAt: now() }
    project.jobs.push(job)
    project.status = 'running'
    const saved = await this.save(project)
    const controller = new AbortController()
    const work = Promise.resolve().then(() => this.execute(saved, job.id, stage, token, controller.signal, adjustment))
    this.active.set(id, { controller, work })
    void work.finally(() => { if (this.active.get(id)?.work === work) this.active.delete(id) }).catch(() => {})
    return saved
  }
  private async updateJob(ownerId: number, id: string, jobId: string, action: (project: RequirementProject) => void) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const project = await this.detail(ownerId, id)
      if (!project.jobs.some(job => job.id === jobId && job.status === 'running')) return
      action(project)
      try { return await this.save(project) }
      catch (error) { if (!(error instanceof RequirementConflictError)) throw error }
    }
    throw new RequirementConflictError()
  }
  private async execute(project: RequirementProject, jobId: string, stage: RequirementJobStage, token: string, signal: AbortSignal, designAdjustment?: { screenId: string; instruction: string }) {
    let phase: RequirementFailurePhase = stage === 'validate' ? 'prototype_validation' : 'model'
    const abort = new Promise<never>((_resolve, reject) => {
      if (signal.aborted) reject(new Error('Cancelled'))
      else signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true })
    })
    try {
      const output = await Promise.race([Promise.resolve().then(async () => {
        signal.throwIfAborted()
        if (stage === 'validate') {
          const previous = project.revisions.at(-1)!
          const revision: RequirementRevision = { id: randomUUID(), createdAt: now(), prd: previous.prd, confirmedAt: previous.confirmedAt!, screens: previous.screens, ...(previous.prototypes ? { prototypes: previous.prototypes } : {}), ...(previous.existingPages ? { existingPages: previous.existingPages } : {}) }
          return (this.options.validatePrototype ?? validatePrototypeRevision)(project, revision, this.root, signal)
        }
        const result = await this.model.generate(stage, structuredClone(project), { root: this.root, token, signal, designAdjustment, onLoginRequired: controls => this.loginRequired(project, jobId, stage, controls, signal), onProgress: async text => {
          signal.throwIfAborted()
          await this.updateJob(project.ownerId, project.id, jobId, current => this.event(current, requirementText(text, 1000)))
        } })
        if (!designAdjustment) return result
        const previous = project.revisions.at(-1)!
        const originals = prototypeScreens(previous, designAdjustment.screenId)
        const targetPrototype = result.prototypes?.find(prototype => prototype.states.some(state => state.id === designAdjustment.screenId))
        if (result.prototypes && (!targetPrototype || targetPrototype.states.length !== originals.length || targetPrototype.states.some(state => !originals.some(original => original.id === state.id)) || (originals[0].prototypeId && targetPrototype.id !== originals[0].prototypeId) || previous.prototypes?.some(prototype => prototype.id === targetPrototype.id && prototype.id !== originals[0].prototypeId))) throw new RequirementDiagnosticError('output_validation', 'DESIGN_ADJUSTMENT', '共享原型状态或页面标识发生变化，原稿已保留')
        if (originals[0].prototypeId && !targetPrototype) throw new RequirementDiagnosticError('output_validation', 'DESIGN_ADJUSTMENT', '共享原型不能退回独立 HTML')
        const generated = targetPrototype ? validatePrototypeDesign([targetPrototype], previous.prd, previous.screens.filter(screen => !originals.some(original => original.id === screen.id))).screens : validateScreens(result.screens, previous.prd)
        const replacements = originals.map(original => {
          const replacement = generated.find(screen => screen.id === original.id)
          if (!replacement || replacement.title !== original.title || replacement.state !== original.state || JSON.stringify(replacement.requirementIds) !== JSON.stringify(original.requirementIds) || JSON.stringify(replacement.acceptanceIds) !== JSON.stringify(original.acceptanceIds)) throw new RequirementDiagnosticError('output_validation', 'DESIGN_ADJUSTMENT', '原型状态缺失或页面映射发生变化，原稿已保留')
          return replacement
        })
        if (originals.every((original, index) => original.html.trim() === replacements[index].html.trim())) throw new RequirementDiagnosticError('output_validation', 'DESIGN_ADJUSTMENT_UNCHANGED', '模型返回的原型与原稿相同，未产生调整；原稿已保留')
        const stateIds = new Map(originals.map(screen => [screen.id, randomUUID()]))
        const screens = validateScreens(previous.screens.map(screen => {
          const replacement = replacements.find(item => item.id === screen.id)
          return replacement ? { ...replacement, id: stateIds.get(screen.id)! } : screen
        }), previous.prd)
        const prototypes = targetPrototype ? [...(previous.prototypes ?? []).filter(prototype => prototype.id !== originals[0].prototypeId), { ...targetPrototype, states: targetPrototype.states.map(state => ({ ...state, id: stateIds.get(state.id)! })) }] : previous.prototypes
        const revision: RequirementRevision = { id: randomUUID(), createdAt: now(), prd: previous.prd, confirmedAt: previous.confirmedAt, screens, ...(prototypes ? { prototypes } : {}), ...(previous.existingPages ? { existingPages: previous.existingPages } : {}) }
        phase = 'prototype_validation'
        await this.updateJob(project.ownerId, project.id, jobId, current => this.event(current, '原型调整完成，正在重新生成所有状态截图并检查静态布局'))
        const validated = await (this.options.validatePrototype ?? validatePrototypeRevision)(project, revision, this.root, signal)
        const targetIds = new Set<string>(stateIds.values())
        const targetChecks = validated.validation.screens.filter(check => targetIds.has(check.screenId))
        const screenErrors = new Set(validated.validation.screens.flatMap(check => [
          ...check.interactionErrors.map(error => `${check.screenId}: ${error}`),
          ...check.viewports.flatMap(view => view.errors.map(error => `${check.screenId} (${view.width}x${view.height}): ${error}`)),
        ]))
        const globalFailure = validated.validation.errors.some(error => !screenErrors.has(error))
        const targetEvidenceComplete = [...targetIds].every(id => validated.screenshots?.filter(shot => shot.screenId === id).length === 1 && targetChecks.filter(check => check.screenId === id).length === 1 && targetChecks.some(check => check.screenId === id && check.visual === 'passed' && check.viewports.length === 1 && check.viewports[0].width === 1600 && check.viewports[0].height === 1000 && !check.viewports[0].errors.length))
        if (globalFailure || !targetEvidenceComplete) {
          const reasons = targetChecks.flatMap(check => check.viewports.flatMap(view => view.errors.map(error => {
            const reason = error === 'Horizontal geometry overflow' ? '水平布局溢出' : error.startsWith('Missing visible mapping: ') ? '需求或验收映射不可见' : error.startsWith('Dangling DOM mapping: ') ? '存在未声明映射' : error === 'Broken or blocked image' ? '图片加载失败' : error === 'Blank or invisible body' || error === 'Blank screenshot pixels' ? '页面或截图为空' : '页面渲染失败'
            return `状态 ${revision.screens.findIndex(screen => screen.id === check.screenId) + 1} · ${view.width}px：${reason}`
          })))
          const details = [...new Set(reasons)].slice(0, 6)
          if (!targetEvidenceComplete && !reasons.length) details.push('目标原型截图或状态检查不完整')
          if (globalFailure) details.push('全局映射检查失败或浏览器验证不可用')
          if (!details.length) details.push('全局映射检查失败或浏览器验证不可用')
          throw new RequirementDiagnosticError('prototype_validation', 'DESIGN_ADJUSTMENT_VALIDATION', `调整后的原型未通过静态检查（${details.join('；')}），未更新原型或 PRD 截图；原稿已保留`)
        }
        return validated
      }), abort])
      signal.throwIfAborted()
      phase = 'storage'
      await this.updateJob(project.ownerId, project.id, jobId, current => {
        if (stage === 'validate' || designAdjustment) {
          const revision = output as RequirementRevision
          this.appendRevision(current, revision)
          if (designAdjustment) this.event(current, `prototype:adjusted ${prototypeScreens(project.revisions.at(-1)!, designAdjustment.screenId)[0]?.title ?? ''}`)
          current.status = 'design_review'
        } else {
          const result = output as Awaited<ReturnType<RequirementModel['generate']>>
          if (stage === 'analyze') {
            current.evidence = validateEvidence(result.evidence, current.sources)
            current.questions = validateQuestions(result.questions).map(question => current.decisions.some(decision => decision.question.id === question.id) ? { ...question, id: randomUUID() } : question)
            current.status = current.questions.length ? 'needs_input' : 'draft'
            this.event(current, `analysis:${jobId}`)
          } else if (stage === 'prd') {
            this.appendRevision(current, { id: randomUUID(), createdAt: now(), prd: validatePrd(result.prd, current.sources.map(source => source.id)), screens: [], ...(result.existingPages ? { existingPages: result.existingPages } : {}) })
            current.status = 'prd_review'
          } else {
            const previous = current.revisions.at(-1)!
            const prototypes = result.prototypes?.map(prototype => ({ ...prototype, states: prototype.states.map(state => ({ ...state, id: randomUUID() })) }))
            const screens = prototypes ? validatePrototypeDesign(prototypes, previous.prd).screens : validateScreens(result.screens, previous.prd).map(screen => ({ ...screen, id: randomUUID() }))
            const existingPages = result.existingPages
            this.appendRevision(current, { id: randomUUID(), createdAt: now(), prd: previous.prd, confirmedAt: previous.confirmedAt!, screens, ...(prototypes ? { prototypes } : {}), ...(existingPages ? { existingPages } : {}) })
            current.status = 'design_review'
          }
        }
        const job = current.jobs.find(item => item.id === jobId)!
        delete job.interaction
        job.status = 'succeeded'; job.endedAt = now()
      })
    } catch (error) {
      const diagnostic = requirementDiagnostic(error, phase)
      if (!signal.aborted) console.error('[requirements:job_failed]', JSON.stringify({ projectId: project.id, jobId, stage, phase: diagnostic.phase, code: diagnostic.code, message: diagnostic.message }))
      await this.updateJob(project.ownerId, project.id, jobId, current => {
        const job = current.jobs.find(item => item.id === jobId)!
        delete job.interaction
        job.status = signal.aborted ? 'cancelled' : 'failed'; job.endedAt = now()
        job.error = signal.aborted ? 'Job cancelled; late results discarded' : diagnostic.message
        if (!signal.aborted) this.event(current, `failure:${jobId} ${diagnostic.phase} ${diagnostic.message}`)
        current.status = signal.aborted ? 'cancelled' : 'failed'
      }).catch(() => {
        console.error('[requirements:failure_save_failed]', JSON.stringify({ projectId: project.id, jobId, stage, code: 'STORAGE' }))
      })
    }
  }
  private async loginRequired(project: RequirementProject, jobId: string, stage: RequirementJobStage, controls: RequirementLoginControls, signal: AbortSignal) {
    signal.throwIfAborted()
    const active = this.active.get(project.id)
    const remaining = Date.parse(controls.expiresAt) - Date.now()
    if (!active || active.login || !['prd', 'design'].includes(stage) || controls.origin !== project.preview?.origin || requirementPreviewOrigin(controls.origin) !== controls.origin || !Number.isFinite(remaining) || remaining <= 0 || remaining > 300000 || new Date(controls.expiresAt).toISOString() !== controls.expiresAt) conflict('Invalid login checkpoint')
    let resolve!: () => void, reject!: (error: Error) => void
    const waiting = new Promise<void>((done, fail) => { resolve = done; reject = fail })
    void waiting.catch(() => {})
    const pending: PendingLogin = { jobId, controls, busy: true, resolve, reject }
    active.login = pending
    const expired = () => reject(new RequirementDiagnosticError('output_validation', 'PAGE_CAPTURE_LOGIN_TIMEOUT', 'Browser login checkpoint expired; explicit retry required'))
    const cancelled = () => reject(new Error('Cancelled'))
    const timer = setTimeout(expired, remaining)
    signal.addEventListener('abort', cancelled, { once: true })
    try {
      const saved = await this.updateJob(project.ownerId, project.id, jobId, current => {
        current.jobs.find(job => job.id === jobId)!.interaction = { kind: 'browser_login', phase: 'ready', origin: controls.origin, expiresAt: controls.expiresAt }
      })
      if (!saved) conflict('Job is no longer running')
      signal.throwIfAborted()
      pending.busy = false
      await waiting
      signal.throwIfAborted()
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancelled)
      if (active.login === pending) delete active.login
      await this.updateJob(project.ownerId, project.id, jobId, current => { delete current.jobs.find(job => job.id === jobId)!.interaction })
    }
  }
  async login(ownerId: number, id: string, jobId: string, value: unknown) {
    const body = requirementObject(value, ['expectedVersion', 'action'])
    const expected = version(body.expectedVersion)
    if (!['open', 'continue'].includes(String(body.action))) throw new RequirementServiceError(400, 'Invalid login action')
    const project = await this.detail(ownerId, id)
    if (project.version !== expected) throw new RequirementConflictError()
    const job = project.jobs.find(job => job.id === jobId && job.status === 'running')
    const active = this.active.get(id), pending = active?.login
    if (this.closing || !pending || pending.jobId !== jobId || pending.busy || active!.controller.signal.aborted || !job?.interaction || job.interaction.expiresAt !== pending.controls.expiresAt || Date.parse(job.interaction.expiresAt) <= Date.now()) conflict('No active login checkpoint')
    if ((body.action === 'open' && job.interaction.phase !== 'ready') || (body.action === 'continue' && job.interaction.phase !== 'opened')) conflict('Invalid login action for current phase')
    pending.busy = true
    try {
      if (body.action === 'open') job.interaction.phase = 'opened'
      else delete job.interaction
      const saved = await this.save(project)
      active!.controller.signal.throwIfAborted()
      if (body.action === 'open') {
        try { await pending.controls.open() }
        catch {
          const error = new RequirementDiagnosticError('output_validation', 'PAGE_CAPTURE_BROWSER', 'Visible login browser could not be opened; explicit retry required')
          pending.reject(error)
          throw new RequirementServiceError(409, error.message)
        }
        active!.controller.signal.throwIfAborted()
      } else pending.resolve()
      return saved
    } finally { pending.busy = false }
  }
  async cancel(ownerId: number, id: string, jobId: string, value: unknown) {
    const body = requirementObject(value, ['expectedVersion'])
    const expected = version(body.expectedVersion)
    const project = await this.detail(ownerId, id)
    if (project.version !== expected) throw new RequirementConflictError()
    const job = project.jobs.find(item => item.id === jobId && item.status === 'running')
    if (!job) conflict('No matching running job')
    delete job.interaction
    job.status = 'cancelled'; job.endedAt = now(); project.status = 'cancelled'
    const saved = await this.save(project)
    this.active.get(id)?.controller.abort()
    return saved
  }
  async wait(id: string) { await this.active.get(id)?.work }
  async close() {
    this.closing = true
    for (const active of this.active.values()) active.controller.abort()
    await Promise.all([...this.active.values()].map(active => active.work))
  }
  async export(ownerId: number, id: string, revisionId: string, format: string) {
    const project = await this.detail(ownerId, id)
    const revision = project.revisions.find(item => item.id === revisionId)
    if (!revision) throw new RequirementServiceError(404, 'Revision not found')
    if (!['md', 'docx', 'html', 'zip'].includes(format)) throw new RequirementServiceError(400, 'Invalid export format')
    return (this.options.exportRevision ?? exportRequirementRevision)(project, revision, format as 'md' | 'docx' | 'html' | 'zip', this.root)
  }
}