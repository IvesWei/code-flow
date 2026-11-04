import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { CasePackage, PlanningInput, PlanningProject, PlanningOperation, PlanningDraft, TestingRepository } from '../../shared/testing.js'
import { defaultModel } from '../execution/models.js'
import { recoverPlanningQuestion } from './planning-question.js'
import { replacePlanningCase } from './planning-case.js'
import { scopedPlanning } from './scoped-package.js'
import { CopilotPlanningModel, PlanningError, planningDefinitions, planningDigest, planningEnvironment, planningRulesVersion, planningSecretPath, qualifiedPlanning, type PlanningModel } from './planning-model.js'

export { PlanningError } from './planning-model.js'
export type { PlanningModel } from './planning-model.js'

const execute = promisify(execFile)
const activePlanning = new Map<string, AbortController>()
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const now = () => new Date().toISOString()
const jsonSnapshot = <Value>(value: Value): Value => JSON.parse(JSON.stringify(value)) as Value
const marker = (project: PlanningProject) => project.events.findLast(event => /^planning:(?:generation|publish):/.test(event.text))
const boundary = (root: string, path: string) => { const local = relative(root, path); return !isAbsolute(local) && !local.split(/[\\/]/).includes('..') }

export class CasePlanningService {
  private readonly active = activePlanning

  constructor(private readonly repository: TestingRepository, private readonly root: string, private readonly model: PlanningModel = new CopilotPlanningModel()) {}

  async create(ownerId: number, input: PlanningInput): Promise<PlanningProject> {
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0) throw new PlanningError('NOT_FOUND')
    const normalized = this.input(input)
    await this.sources(normalized)
    const at = now()
    const project: PlanningProject = { id: randomUUID(), ownerId, version: 1, createdAt: at, updatedAt: at, input: normalized, status: 'draft', events: [], caseSetIds: [] }
    try { await this.repository.create('project', project, ownerId) } catch { throw new PlanningError('STORAGE_FAILED') }
    return structuredClone(project)
  }

  async generate(ownerId: number, id: string, token: string, operation?: PlanningOperation): Promise<void> {
    let project = operation?.mode === 'optimize' ? await this.detail(ownerId, id) : await this.project(ownerId, id)
    const previous = operation ? structuredClone(project.draft) : undefined
    const priorStatus = project.status
    if (operation) {
      if (!['continue', 'review', 'optimize'].includes(operation.mode) || !Number.isSafeInteger(operation.version) || operation.version !== project.version) throw new PlanningError('CONFLICT')
      if (!previous?.baseline.length || operation.mode === 'review' && !previous.cases.length) throw new PlanningError('INVALID_INPUT')
      if (operation.mode === 'optimize' && (!Array.isArray(operation.caseIds) || operation.caseIds.length !== 1 || operation.regenerate !== undefined && typeof operation.regenerate !== 'boolean')) throw new PlanningError('INVALID_INPUT')
      if (operation.caseIds !== undefined) {
        if (!['review', 'optimize'].includes(operation.mode) || !Array.isArray(operation.caseIds) || !operation.caseIds.length || operation.caseIds.length > 1000 || new Set(operation.caseIds).size !== operation.caseIds.length || operation.caseIds.some(id => !previous.cases.some(item => item.id === id)) || typeof operation.reason !== 'string' || !operation.reason.trim() || operation.reason.length > 2000) throw new PlanningError('INVALID_INPUT')
        operation = { ...operation, caseIds: previous.cases.filter(item => operation!.caseIds!.includes(item.id)).map(item => item.id), reason: operation.reason.trim() }
      }
      await this.sources(project.input)
      const workspace = join(await this.storageRoot(), 'testing', 'planning', id, 'workspace')
      await this.verifyWorkspace(project.input, workspace)
      const snapshot = await this.referenceFingerprint(workspace, !!project.input.referenceRepository)
      if (!!previous.sourceFingerprint !== !!previous.definitionFingerprint) throw new PlanningError('SOURCE_CHANGED')
      if (previous.sourceFingerprint ? previous.sourceFingerprint !== this.sourceFingerprint(project.input, snapshot) : !!project.input.referenceRepository) throw new PlanningError('SOURCE_CHANGED')
      if (previous.definitionFingerprint && previous.definitionFingerprint !== planningDigest({ baseline: previous.baseline, cases: previous.cases })) throw new PlanningError('SOURCE_CHANGED')
      if (!previous.sourceFingerprint) {
        previous.reviewBatches = []
        previous.customReview = undefined
      }
    }
    const activeId = this.activeId(id)
    if (project.status === 'running' || project.question || this.active.has(activeId)) throw new PlanningError('CONFLICT')
    await this.ensurePublication(project)
    const controller = new AbortController()
    project = await this.replace(project, { status: 'running', draft: previous, question: undefined, error: undefined, events: [...project.events, { at: now(), kind: 'info', text: `planning:generation:${randomUUID()}` }, ...(operation ? [{ at: now(), kind: 'info' as const, text: operation.mode === 'review' ? 'Reviewing saved case definitions; generation will not run.' : operation.mode === 'optimize' ? `Planning ${operation.regenerate ? 'regenerate' : 'optimize'}: ${operation.caseIds![0]}; a new design review is required.` : `Continuing saved planning draft with ${previous!.cases.length} cases.` }] : [])] })
    this.active.set(activeId, controller)
    const input = structuredClone(project.input)
    const attemptVersion = project.version
    let queue = Promise.resolve()
    let checkpointError: unknown
    const save = (update: (current: PlanningProject) => Partial<PlanningProject>) => {
      const operation = queue.then(async () => {
        controller.signal.throwIfAborted()
        const current = await this.project(ownerId, id)
        if (current.status !== 'running' || current.version < attemptVersion || marker(current)?.text !== marker(project)?.text) throw new PlanningError('CANCELLED')
        project = await this.replace(current, update(current))
      })
      queue = operation.catch(error => { checkpointError ??= error })
      return operation
    }
    try {
      const workspace = operation ? join(await this.storageRoot(), 'testing', 'planning', id, 'workspace') : await this.workspace(id)
      const sources = await this.sources(input)
      if (!operation) {
      await mkdir(join(workspace, 'sources'), { recursive: true })
      for (const source of sources) await writeFile(join(workspace, 'sources', source.file), source.bytes, { flag: 'wx' })
      await writeFile(join(workspace, 'requirements.txt'), input.requirements, { flag: 'wx' })
      await writeFile(join(workspace, 'instruction.txt'), input.instruction, { flag: 'wx' })
      }
      const referenceSnapshot = operation ? await this.referenceFingerprint(workspace, !!input.referenceRepository) : await this.reference(input, workspace, controller.signal)
      const sourceFingerprint = this.sourceFingerprint(input, referenceSnapshot)
      const result = await this.model.generate(input, {
        workspace, token, signal: controller.signal, previous, operation,
        onProgress: text => save(current => ({ events: [...current.events, { at: now(), kind: 'info', text: `Model progress: ${this.sanitize(text, token)}` }] })),
        onDraft: draft => save(() => ({ draft: operation?.mode === 'optimize' ? this.optimizedDraft(previous!, draft, operation, sourceFingerprint) : this.safeDraft(draft, sourceFingerprint, token) })),
      })
      await queue
      if (checkpointError) throw checkpointError
      controller.signal.throwIfAborted()
      await this.sources(input)
      await this.verifyWorkspace(input, workspace)
      if (await this.referenceFingerprint(workspace, !!input.referenceRepository) !== referenceSnapshot) throw new PlanningError('SOURCE_CHANGED')
      if (previous && operation?.mode === 'review' && planningDigest({ baseline: previous.baseline, cases: previous.cases }) !== planningDigest({ baseline: result.baseline, cases: result.cases })) throw new PlanningError('SOURCE_CHANGED')
      const saved = operation?.mode === 'optimize' ? this.optimizedDraft(previous!, result, operation, sourceFingerprint) : this.safeDraft(result, sourceFingerprint, token)
      await save(() => ({ draft: saved }))
      if (operation?.mode === 'optimize') {
        await save(current => ({ status: 'draft', error: undefined, events: [...current.events, { at: now(), kind: 'info', text: 'Single case definition saved; all prior design reviews invalidated. Review again before publication.' }] }))
        return
      }
      if (operation?.caseIds) {
        await save(() => ({ status: priorStatus === 'completed' ? 'completed' : 'draft', error: undefined, events: [...project.events, { at: now(), kind: 'info', text: 'Selected design review finished; full publication gate unchanged.' }] }))
        return
      }
      const qualified = qualifiedPlanning(result)
      const definitionFingerprint = planningDigest({ baseline: qualified.baseline, cases: qualified.cases })
      qualified.assessment.inputFingerprint = planningDigest({ sourceFingerprint, definitionFingerprint, rulesVersion: planningRulesVersion })
      await save(() => ({ status: 'completed', draft: { ...saved, ...qualified }, error: undefined, events: [...project.events, { at: now(), kind: 'info', text: `Planning design review complete. Reference snapshot: ${referenceSnapshot}` }] }))
    } catch (error) {
      await queue
      const safe = controller.signal.aborted ? new PlanningError('CANCELLED') : error instanceof PlanningError ? error : new PlanningError('MODEL_FAILED')
      const current = await this.project(ownerId, id)
      if (current.status === 'running' && marker(current)?.text === marker(project)?.text) {
        const question = safe.question ? { id: randomUUID(), createdAt: now(), text: this.sanitize(safe.question.text, token, 6000), choices: safe.question.choices.map(choice => this.sanitize(choice, token, 3000)), allowFreeform: safe.question.allowFreeform || !safe.question.choices.length } : undefined
        await this.replace(current, { status: safe.code === 'CANCELLED' ? 'cancelled' : safe.code === 'NEEDS_INPUT' ? 'needs_input' : 'failed', question, error: safe.message, events: [...current.events, { at: now(), kind: safe.code === 'NEEDS_INPUT' ? 'warning' : 'error', text: safe.message }] })
      }
      throw safe
    } finally { if (this.active.get(activeId) === controller) this.active.delete(activeId) }
  }

  async detail(ownerId: number, id: string): Promise<PlanningProject> {
    const project = await this.project(ownerId, id)
    const question = await recoverPlanningQuestion(this.root, project)
    if (!question) return project
    return { ...project, status: 'needs_input', question: { ...question, text: this.sanitize(question.text, '', 6000), choices: question.choices.map(choice => this.sanitize(choice, '', 3000)) } }
  }

  async editCase(ownerId: number, id: string, caseId: string, expectedVersion: number, caseDefinition: unknown): Promise<PlanningProject> {
    const project = await this.detail(ownerId, id)
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== project.version || project.status === 'running' || project.question || this.active.has(this.activeId(id))) throw new PlanningError('CONFLICT')
    if (!project.draft?.baseline.length) throw new PlanningError('INVALID_INPUT')
    const draft = replacePlanningCase(project.draft, caseId, caseDefinition)
    await this.ensurePublication(project)
    await this.sources(project.input)
    const workspace = join(await this.storageRoot(), 'testing', 'planning', id, 'workspace')
    await this.verifyWorkspace(project.input, workspace)
    const snapshot = await this.referenceFingerprint(workspace, !!project.input.referenceRepository)
    const sourceFingerprint = this.sourceFingerprint(project.input, snapshot)
    if (!!project.draft.sourceFingerprint !== !!project.draft.definitionFingerprint || (project.draft.sourceFingerprint ? project.draft.sourceFingerprint !== sourceFingerprint : !!project.input.referenceRepository) || project.draft.definitionFingerprint && project.draft.definitionFingerprint !== planningDigest({ baseline: project.draft.baseline, cases: project.draft.cases })) throw new PlanningError('SOURCE_CHANGED')
    if (planningDigest(project.draft.cases) === planningDigest(draft.cases)) return project
    return this.replace(project, { status: 'draft', draft: { ...draft, sourceFingerprint }, error: undefined, events: [...project.events, { at: now(), kind: 'info', text: `planning:generation:${randomUUID()}` }, { at: now(), kind: 'info', text: `Manually edited ${caseId}; all prior design reviews invalidated. Review again before publication.` }] })
  }

  private optimizedDraft(previous: PlanningDraft, draft: PlanningDraft, operation: PlanningOperation, sourceFingerprint: string): PlanningDraft {
    const caseId = operation.caseIds![0]
    const replacement = replacePlanningCase(previous, caseId, draft.cases.find(item => item.id === caseId))
    if (planningDigest({ baseline: replacement.baseline, cases: replacement.cases }) !== planningDigest({ baseline: draft.baseline, cases: draft.cases })) throw new PlanningError('INVALID_INPUT')
    return { ...replacement, sourceFingerprint }
  }

  async answer(ownerId: number, id: string, questionId: string, answer: string, expectedVersion: number): Promise<PlanningProject> {
    const project = await this.detail(ownerId, id)
    if (project.status !== 'needs_input' || !project.question || project.question.id !== questionId || project.version !== expectedVersion || this.active.has(this.activeId(id))) throw new PlanningError('CONFLICT')
    if (typeof answer !== 'string' || !answer.trim() || answer.length > 3000 || !project.question.allowFreeform && !project.question.choices.includes(answer.trim())) throw new PlanningError('INVALID_INPUT', 'instruction')
    if ((project.clarifications?.length || 0) >= 20) throw new PlanningError('INVALID_INPUT', 'instruction')
    const value = this.sanitize(answer.trim(), '', 3000)
    const instruction = `${project.input.instruction}\n\nUser-confirmed planning clarification:\n${JSON.stringify({ question: project.question.text, answer: value })}`
    const input = this.input({ ...project.input, instruction })
    return this.replace(project, { status: 'draft', input, question: undefined, error: undefined, draft: undefined, clarifications: [...project.clarifications || [], { question: project.question, answer: value, answeredAt: now() }], events: [...project.events, { at: now(), kind: 'info', text: 'Planning clarification answered; a fresh generation is required.' }] })
  }

  async publish(ownerId: number, id: string): Promise<CasePackage> {
    let project = await this.project(ownerId, id)
    if (project.status !== 'completed' || !project.draft?.assessment) throw new PlanningError('UNQUALIFIED')
    try {
      const provenance = JSON.parse(project.input.requirements).provenance
      if (provenance?.kind === 'external-package-import' && provenance.scope !== undefined) throw new PlanningError('UNQUALIFIED')
    } catch (error) { if (error instanceof PlanningError) throw error }
    await this.ensureScopePublications(project)
    await this.sources(project.input)
    const qualified = qualifiedPlanning({ ...project.draft, assessment: project.draft.assessment })
    const workspace = join(await this.storageRoot(), 'testing', 'planning', id, 'workspace')
    await this.verifyWorkspace(project.input, workspace)
    const snapshot = await this.referenceFingerprint(workspace, !!project.input.referenceRepository)
    const sourceFingerprint = this.sourceFingerprint(project.input, snapshot)
    const definitionFingerprint = planningDigest({ baseline: qualified.baseline, cases: qualified.cases })
    if (project.draft.assessment.inputFingerprint !== planningDigest({ sourceFingerprint, definitionFingerprint, rulesVersion: planningRulesVersion })) throw new PlanningError('SOURCE_CHANGED')
    const prior = marker(project)
    if (prior?.text.startsWith('planning:publish:')) return this.materialize(project, prior.text.slice('planning:publish:'.length), prior.at, qualified, sourceFingerprint, definitionFingerprint)
    const packageId = randomUUID()
    const at = now()
    try {
      project = await this.replace(project, { caseSetIds: [...project.caseSetIds, packageId], events: [...project.events, { at, kind: 'info', text: `planning:publish:${packageId}` }] })
    } catch (error) {
      if (!(error instanceof PlanningError) || error.code !== 'CONFLICT') throw error
      const current = await this.project(ownerId, id)
      const reservation = marker(current)
      if (current.status !== 'completed' || !reservation?.text.startsWith('planning:publish:') || current.draft?.assessment?.inputFingerprint !== project.draft?.assessment?.inputFingerprint) throw error
      return this.materialize(current, reservation.text.slice('planning:publish:'.length), reservation.at, qualified, sourceFingerprint, definitionFingerprint)
    }
    return this.materialize(project, packageId, at, qualified, sourceFingerprint, definitionFingerprint)
  }

  async publishScope(ownerId: number, id: string, version: number, caseIds: string[], reason: string): Promise<CasePackage> {
    let project = await this.detail(ownerId, id)
    if (!Number.isSafeInteger(version) || project.status === 'running' || project.question || this.active.has(this.activeId(id))) throw new PlanningError('CONFLICT')
    if (!project.draft) throw new PlanningError('UNQUALIFIED')
    const scoped = scopedPlanning(project.draft, caseIds, reason)
    await this.verifyScopeSource(project, scoped.sourceFingerprint)
    const key = planningDigest({ sourceFingerprint: scoped.sourceFingerprint, definitionFingerprint: scoped.definitionFingerprint, scope: scoped.scope, rulesVersion: planningRulesVersion })
    const prefix = 'planning:publish-scope:'
    const reservation = project.events.findLast(event => event.text.startsWith(prefix) && event.text.includes(` key:${key} `))
    if (project.version !== version && (!reservation || project.version !== version + 1 || !reservation.text.endsWith(` version:${version}`))) throw new PlanningError('CONFLICT')
    if (reservation) {
      const packageId = reservation.text.slice(prefix.length).split(' ')[0]
      const existing = await this.package(packageId, ownerId)
      if (existing) {
        if (!project.caseSetIds.includes(packageId) || !reservation.text.includes(` package-sha256:${planningDigest(existing)} `)) throw new PlanningError('SOURCE_CHANGED')
        return structuredClone(existing)
      }
      const value: CasePackage = jsonSnapshot({ schemaVersion: 1, id: packageId, projectId: id, revision: project.caseSetIds.indexOf(packageId) + 1, createdAt: reservation.at, rulesVersion: planningRulesVersion, modelId: project.input.modelId, ...scoped })
      if (!uuid.test(packageId) || !project.caseSetIds.includes(packageId) || !reservation.text.includes(` package-sha256:${planningDigest(value)} `)) throw new PlanningError('SOURCE_CHANGED')
      return this.materializeScope(project, value)
    }
    await this.ensurePublication(project)
    const packageId = randomUUID(), at = now()
    const value: CasePackage = jsonSnapshot({ schemaVersion: 1, id: packageId, projectId: id, revision: project.caseSetIds.length + 1, createdAt: at, rulesVersion: planningRulesVersion, modelId: project.input.modelId, ...scoped })
    try {
      project = await this.replace(project, { caseSetIds: [...project.caseSetIds, packageId], events: [...project.events, { at, kind: 'info', text: `${prefix}${packageId} key:${key} package-sha256:${planningDigest(value)} version:${version}` }] })
    } catch (error) {
      if (!(error instanceof PlanningError) || error.code !== 'CONFLICT') throw error
      const current = await this.project(ownerId, id)
      if (current.version !== version + 1 || !current.events.some(event => event.text.startsWith(prefix) && event.text.includes(` key:${key} `) && event.text.endsWith(` version:${version}`))) throw error
      return this.publishScope(ownerId, id, version, caseIds, reason)
    }
    return this.materializeScope(project, value)
  }

  private async materializeScope(project: PlanningProject, value: CasePackage): Promise<CasePackage> {
    if (!project.caseSetIds.includes(value.id) || value.revision !== project.caseSetIds.indexOf(value.id) + 1) throw new PlanningError('CONFLICT')
    await this.verifyScopeSource(project, value.sourceFingerprint)
    try { await this.repository.create('package', value, project.ownerId) }
    catch {
      const existing = await this.package(value.id, project.ownerId)
      if (!existing) throw new PlanningError('STORAGE_FAILED')
      if (planningDigest(existing) !== planningDigest(value)) throw new PlanningError('SOURCE_CHANGED')
      return structuredClone(existing)
    }
    return structuredClone(value)
  }

  private async verifyScopeSource(project: PlanningProject, fingerprint: string): Promise<void> {
    await this.sources(project.input)
    const workspace = join(await this.storageRoot(), 'testing', 'planning', project.id, 'workspace')
    await this.verifyWorkspace(project.input, workspace)
    const snapshot = await this.referenceFingerprint(workspace, !!project.input.referenceRepository)
    if (fingerprint !== this.sourceFingerprint(project.input, snapshot)) throw new PlanningError('SOURCE_CHANGED')
  }

  async cancel(ownerId: number, id: string): Promise<PlanningProject> {
    const project = await this.project(ownerId, id)
    if (project.status === 'cancelled') return project
    if (project.status === 'completed') throw new PlanningError('CONFLICT')
    if (project.status !== 'running') await this.ensurePublication(project)
    const cancelled = await this.replace(project, { status: 'cancelled', events: [...project.events, { at: now(), kind: 'info', text: 'Planning cancelled.' }] })
    this.active.get(this.activeId(id))?.abort()
    return cancelled
  }

  private activeId(id: string): string {
    const root = resolve(this.root)
    return `${process.platform === 'win32' ? root.toLowerCase() : root}:${id}`
  }

  private async project(ownerId: number, id: string): Promise<PlanningProject> {
    if (!uuid.test(id) || !Number.isSafeInteger(ownerId) || ownerId <= 0) throw new PlanningError('NOT_FOUND')
    let project: PlanningProject | undefined
    try { project = await this.repository.get('project', id, ownerId) } catch { throw new PlanningError('STORAGE_FAILED') }
    if (!project || project.ownerId !== ownerId) throw new PlanningError('NOT_FOUND')
    return structuredClone(project)
  }

  private async replace(project: PlanningProject, patch: Partial<PlanningProject>): Promise<PlanningProject> {
    const next = jsonSnapshot({ ...project, ...patch, version: project.version + 1, updatedAt: new Date(Math.max(Date.now(), Date.parse(project.updatedAt))).toISOString() })
    try { await this.repository.replace('project', next, project.version, project.ownerId) }
    catch {
      const current = await this.project(project.ownerId, project.id)
      throw new PlanningError(current.version !== project.version ? 'CONFLICT' : 'STORAGE_FAILED')
    }
    return next
  }

  private input(input: PlanningInput): PlanningInput {
    if (!input || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200) throw new PlanningError('INVALID_INPUT', 'title')
    if (typeof input.requirements !== 'string' || input.requirements.length > 200_000 || (!input.requirements.trim() && !input.sources?.length)) throw new PlanningError('INVALID_INPUT', 'requirements')
    if (typeof input.instruction !== 'string' || input.instruction.length > 50_000) throw new PlanningError('INVALID_INPUT', 'instruction')
    if (!Array.isArray(input.sources) || input.sources.length > 50) throw new PlanningError('INVALID_INPUT', 'sources')
    if (input.modelId !== undefined && typeof input.modelId !== 'string') throw new PlanningError('INVALID_INPUT', 'modelId')
    const modelId = input.modelId?.trim() || defaultModel()
    if (!/^[a-z0-9][a-z0-9._:/-]{0,119}$/i.test(modelId)) throw new PlanningError('INVALID_INPUT', 'modelId')
    const ids = new Set<string>()
    for (const source of input.sources) {
      if (!source || !uuid.test(source.id) || ids.has(source.id) || !['requirements', 'design'].includes(source.kind) || typeof source.name !== 'string' || !source.name || source.name.length > 200 || /[\\/]|\p{Cc}/u.test(source.name) || planningSecretPath(source.name) || !/^[0-9a-f]{64}$/i.test(source.sha256) || !Number.isSafeInteger(source.sizeBytes) || source.sizeBytes < 0 || source.sizeBytes > 20_000_000 || typeof source.storageKey !== 'string') throw new PlanningError('INVALID_INPUT', 'sources')
      ids.add(source.id)
    }
    let referenceRepository: string | undefined
    if (input.referenceRepository !== undefined) {
      if (typeof input.referenceRepository !== 'string') throw new PlanningError('INVALID_INPUT', 'referenceRepository')
      const value = input.referenceRepository.trim()
      if (value) {
        let url: URL
        try { url = new URL(value) } catch { throw new PlanningError('INVALID_INPUT', 'referenceRepository') }
        if (url.protocol !== 'https:' || url.host !== 'github.com' || url.username || url.password || url.search || url.hash || !/^\/[a-z0-9_-]+\/(?!\.{1,2}(?:\/|$))[a-z0-9_.-]+\/?$/i.test(url.pathname) || /[\\\s]|\p{Cc}/u.test(value) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(value)) throw new PlanningError('INVALID_INPUT', 'referenceRepository')
        referenceRepository = `https://github.com${url.pathname.replace(/\/$/, '')}`
      }
    }
    if (input.referenceBranch !== undefined && typeof input.referenceBranch !== 'string') throw new PlanningError('INVALID_INPUT', 'referenceBranch')
    const referenceBranch = input.referenceBranch?.trim() || undefined
    if (referenceBranch && (!referenceRepository || !/^[a-z0-9][a-z0-9_./-]{0,199}$/i.test(referenceBranch) || referenceBranch.includes('..') || referenceBranch.includes('//') || referenceBranch.endsWith('/'))) throw new PlanningError('INVALID_INPUT', 'referenceBranch')
    return structuredClone({ title: input.title.trim(), requirements: input.requirements, instruction: input.instruction, modelId, sources: input.sources.map(({ id, name, kind, sha256, sizeBytes, storageKey }) => ({ id, name, kind, sha256: sha256.toLowerCase(), sizeBytes, storageKey })), ...(referenceRepository ? { referenceRepository, ...(referenceBranch ? { referenceBranch } : {}) } : {}) })
  }

  private async sources(input: PlanningInput) {
    const root = await this.storageRoot()
    const result: { file: string; bytes: Buffer }[] = []
    for (const source of input.sources) {
      const key = source.storageKey
      if (!key || /[\\:]|\p{Cc}/u.test(key) || isAbsolute(key) || key.split('/').some(part => !part || part === '.' || part === '..') || planningSecretPath(key)) throw new PlanningError('INVALID_INPUT', 'sources')
      let target = root
      try {
        for (const part of key.split('/')) { target = join(target, part); if ((await lstat(target)).isSymbolicLink()) throw new PlanningError('INVALID_INPUT', 'sources') }
        if (!boundary(root, await realpath(target)) || !(await lstat(target)).isFile()) throw new PlanningError('INVALID_INPUT', 'sources')
        const bytes = await readFile(target)
        if (bytes.length !== source.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== source.sha256.toLowerCase()) throw new PlanningError('SOURCE_CHANGED')
        result.push({ file: `${source.id}${source.name.match(/\.[a-z0-9]{1,10}$/i)?.[0] || '.txt'}`, bytes })
      } catch (error) { throw error instanceof PlanningError ? error : new PlanningError('INVALID_INPUT', 'sources') }
    }
    return result
  }

  private async workspace(id: string): Promise<string> {
    const root = await this.storageRoot()
    let directory = root
    for (const part of ['testing', 'planning', id]) {
      directory = join(directory, part)
      await mkdir(directory, { recursive: true })
      if ((await lstat(directory)).isSymbolicLink() || !boundary(root, await realpath(directory))) throw new PlanningError('INVALID_INPUT')
    }
    const workspace = join(directory, 'workspace')
    try { if ((await lstat(workspace)).isSymbolicLink()) throw new PlanningError('INVALID_INPUT') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await rm(workspace, { recursive: true, force: true })
    await mkdir(workspace)
    return workspace
  }

  private async reference(input: PlanningInput, workspace: string, signal: AbortSignal): Promise<string> {
    if (!input.referenceRepository) return 'none'
    const checkout = join(workspace, '..', `checkout-${randomUUID()}`)
    const env = { ...planningEnvironment(), GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' }
    try {
      await execute('git', ['-c', 'core.hooksPath=', '-c', 'credential.helper=', '-c', 'protocol.file.allow=never', 'clone', '--depth', '1', '--single-branch', ...(input.referenceBranch ? ['--branch', input.referenceBranch] : []), '--', input.referenceRepository, checkout], { env, signal, timeout: 120_000, maxBuffer: 1_000_000 })
      const { stdout } = await execute('git', ['-C', checkout, 'rev-parse', 'HEAD'], { env, signal, timeout: 15_000 })
      const commit = stdout.trim()
      if (!/^[a-f0-9]{40,64}$/i.test(commit)) throw new PlanningError('INVALID_INPUT')
      const target = join(workspace, 'reference')
      await mkdir(target)
      let count = 0, bytes = 0
      const copy = async (directory: string) => {
        for (const entry of await readdir(join(checkout, directory), { withFileTypes: true })) {
          signal.throwIfAborted()
          const local = join(directory, entry.name)
          if (entry.name.startsWith('.') || planningSecretPath(local) || entry.isSymbolicLink()) continue
          if (entry.isDirectory()) { await mkdir(join(target, local), { recursive: true }); await copy(local) }
          else if (entry.isFile() && /\.(?:[cm]?[jt]sx?|json|md|txt|html|css|sql|java|py|go|rs|ya?ml)$/i.test(local)) {
            bytes += (await lstat(join(checkout, local))).size
            if (++count > 2000 || bytes > 20_000_000) throw new PlanningError('INVALID_INPUT')
            await copyFile(join(checkout, local), join(target, local))
          }
        }
      }
      await copy('')
      await writeFile(join(workspace, 'reference-commit.txt'), commit)
      return this.referenceFingerprint(workspace, true)
    } finally { await rm(checkout, { recursive: true, force: true }) }
  }

  private async referenceFingerprint(workspace: string, present: boolean): Promise<string> {
    if (!present) return 'none'
    const entries: { path: string; sha256: string }[] = []
    const scan = async (directory: string) => {
      for (const entry of await readdir(join(workspace, 'reference', directory), { withFileTypes: true })) {
        const local = join(directory, entry.name)
        if (entry.isSymbolicLink() || planningSecretPath(local)) throw new PlanningError('SOURCE_CHANGED')
        if (entry.isDirectory()) await scan(local)
        else if (entry.isFile()) entries.push({ path: local.replaceAll('\\', '/'), sha256: createHash('sha256').update(await readFile(join(workspace, 'reference', local))).digest('hex') })
      }
    }
    try {
      await scan('')
      entries.sort((left, right) => left.path.localeCompare(right.path))
      return planningDigest({ commit: (await readFile(join(workspace, 'reference-commit.txt'), 'utf8')).trim(), entries })
    } catch { throw new PlanningError('SOURCE_CHANGED') }
  }

  private async verifyWorkspace(input: PlanningInput, workspace: string): Promise<void> {
    try {
      const root = await realpath(this.root)
      let directory = root
      for (const part of relative(root, workspace).split(/[\\/]/)) {
        directory = join(directory, part)
        if (part === '..' || (await lstat(directory)).isSymbolicLink()) throw new PlanningError('SOURCE_CHANGED')
      }
      const expected = [
        { file: 'requirements.txt', hash: createHash('sha256').update(input.requirements).digest('hex') },
        { file: 'instruction.txt', hash: createHash('sha256').update(input.instruction).digest('hex') },
        ...input.sources.map(source => ({ file: join('sources', `${source.id}${source.name.match(/\.[a-z0-9]{1,10}$/i)?.[0] || '.txt'}`), hash: source.sha256.toLowerCase() })),
      ]
      for (const source of expected) {
        const path = join(workspace, source.file)
        if ((await lstat(path)).isSymbolicLink() || !boundary(workspace, await realpath(path)) || createHash('sha256').update(await readFile(path)).digest('hex') !== source.hash) throw new PlanningError('SOURCE_CHANGED')
      }
    } catch { throw new PlanningError('SOURCE_CHANGED') }
  }

  private sourceFingerprint(input: PlanningInput, referenceSnapshot: string): string {
    return planningDigest({ requirements: input.requirements, instruction: input.instruction, sources: input.sources.map(({ id, kind, name, sha256, sizeBytes }) => ({ id, kind, name, sha256, sizeBytes })), referenceRepository: input.referenceRepository, referenceBranch: input.referenceBranch, referenceSnapshot, modelId: input.modelId, rulesVersion: planningRulesVersion })
  }

  private async ensurePublication(project: PlanningProject): Promise<void> {
    await this.ensureScopePublications(project)
    const reservation = marker(project)
    if (reservation?.text.startsWith('planning:publish:') && !await this.package(reservation.text.slice('planning:publish:'.length), project.ownerId)) throw new PlanningError('CONFLICT')
  }

  private async ensureScopePublications(project: PlanningProject): Promise<void> {
    const importedScope = (project.draft as PlanningDraft & { importedPackage?: CasePackage } | undefined)?.importedPackage?.scope
    for (const event of project.events) {
      const prefix = event.text.startsWith('planning:publish-scope:') ? 'planning:publish-scope:' : importedScope && event.text.startsWith('planning:import:publish:') ? 'planning:import:publish:' : undefined
      if (!prefix) continue
      const id = event.text.slice(prefix.length).split(' ')[0]
      if (!await this.package(id, project.ownerId)) throw new PlanningError('CONFLICT')
    }
  }

  private async materialize(project: PlanningProject, id: string, createdAt: string, draft: ReturnType<typeof qualifiedPlanning>, sourceFingerprint: string, definitionFingerprint: string): Promise<CasePackage> {
    if (!uuid.test(id) || !project.caseSetIds.includes(id)) throw new PlanningError('CONFLICT')
    draft.assessment.checkedAt = project.draft!.assessment!.checkedAt
    draft.assessment.inputFingerprint = project.draft!.assessment!.inputFingerprint
    const value: CasePackage = jsonSnapshot({ schemaVersion: 1, id, projectId: project.id, revision: project.caseSetIds.indexOf(id) + 1, createdAt, sourceFingerprint, definitionFingerprint, rulesVersion: planningRulesVersion, modelId: project.input.modelId, ...draft })
    const existing = await this.package(id, project.ownerId)
    if (existing) return structuredClone(existing)
    try { await this.repository.create('package', value, project.ownerId) }
    catch {
      const concurrent = await this.package(id, project.ownerId)
      if (concurrent) return structuredClone(concurrent)
      throw new PlanningError('STORAGE_FAILED')
    }
    return structuredClone(value)
  }

  private async package(id: string, ownerId: number): Promise<CasePackage | undefined> {
    try { return await this.repository.get('package', id, ownerId) } catch { throw new PlanningError('STORAGE_FAILED') }
  }

  private async storageRoot(): Promise<string> {
    try { return await realpath(this.root) } catch { throw new PlanningError('INVALID_INPUT') }
  }

  private sanitize(text: string, token: string, limit = 1000): string {
    const clean = String(text).split(token || '\u0000').join('[redacted]')
      .replace(/(?:github_pat_|gh[pousr]_)[a-z0-9_]+/gi, '[redacted]')
      .replace(/(?:bearer\s+\S+|(?:password|token|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+)/gi, '[redacted]')
      .replace(/\p{Cc}/gu, ' ')
    return clean.slice(0, limit)
  }

  private safeAssessment(assessment: NonNullable<NonNullable<PlanningProject['draft']>['assessment']>, token: string) {
    const safe = structuredClone(assessment)
    safe.issues = safe.issues.map(text => this.sanitize(text, token))
    safe.caseIssues = safe.caseIssues?.map(item => ({ ...item, message: this.sanitize(item.message, token) }))
    safe.findings = safe.findings?.map(item => ({ ...item, message: this.sanitize(item.message, token) }))
    return safe
  }

  private safeDraft(draft: PlanningDraft, sourceFingerprint: string, token: string): PlanningDraft {
    const cleanBatches = (items: NonNullable<PlanningDraft['reviewBatches']>) => items.map(item => ({ caseIds: [...item.caseIds], result: { qualified: item.result.qualified, issues: item.result.issues.map(text => this.sanitize(text, token)), caseIssues: item.result.caseIssues.map(issue => ({ caseId: issue.caseId, message: this.sanitize(issue.message, token) })) } }))
    const cases = planningDefinitions(draft.cases)
    return { baseline: structuredClone(draft.baseline), cases, sourceFingerprint, definitionFingerprint: planningDigest({ baseline: draft.baseline, cases }), ...(draft.assessment ? { assessment: this.safeAssessment(draft.assessment, token) } : {}), reviewBatches: cleanBatches(draft.reviewBatches || []), ...(draft.customReview ? { customReview: { ...structuredClone(draft.customReview), reason: this.sanitize(draft.customReview.reason, token, 2000), batches: cleanBatches(draft.customReview.batches), ...(draft.customReview.assessment ? { assessment: this.safeAssessment(draft.customReview.assessment, token) } : {}) } } : {}) }
  }
}