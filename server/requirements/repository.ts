import { randomUUID } from 'node:crypto'
import { appendFile, link, mkdir, open, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join, resolve } from 'node:path'
import type { RequirementConversationEntry, RequirementPrdAudit, RequirementProject, RequirementRepository } from '../../shared/requirements.js'
import { requirementPreviewOrigin, requirementPreviewPath } from '../../shared/requirement-preview.js'
import { assertPrototypeSources } from './prototype-design.js'
import { validateCapturePlan, validateScopeCheckpoint } from './capture-plan.js'
import { validatePrototypeCapture, validateQuestions, validateSourceAnchors } from './validation.js'
import { validatePrdTemplate } from '../../shared/prd-template.js'
import { readBusinessReview } from '../../shared/business-review.js'
import { validateRemoteCodeInput } from './remote-code.js'

export type { RequirementRepository } from '../../shared/requirements.js'
export const REQUIREMENT_LIST_LIMIT = 100
export const REQUIREMENT_BODY_LIMIT = 8 * 1024 * 1024
export const REQUIREMENT_CONVERSATION_BODY_LIMIT = 16 * 1024 * 1024
export interface RequirementSqlPool {
  query(options: { sql: string; timeout: number }, values?: unknown[]): Promise<unknown[]>
}
export class RequirementContractError extends Error {
  readonly statusCode = 400
  constructor() { super('Invalid requirement project or metadata') }
}
export class RequirementConflictError extends Error {
  readonly statusCode = 409
  constructor() { super('Requirement project revision conflict') }
}
export class RequirementStorageUnavailableError extends Error {
  readonly statusCode = 503
  constructor() { super('Requirement storage unavailable; verify configuration, permissions and sql/mysql-requirements-schema.sql. No JSON fallback is performed.') }
}

type Row = Record<string, unknown>
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const statuses = ['draft', 'running', 'needs_input', 'prd_review', 'design_review', 'completed', 'failed', 'cancelled', 'interrupted']
const locks = new Map<string, Promise<void>>()

function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new RequirementContractError()
}
function positive(value: unknown): asserts value is number { requireValue(Number.isSafeInteger(value) && Number(value) > 0) }
function identifier(value: unknown): asserts value is string { requireValue(typeof value === 'string' && uuid.test(value)) }
function timestamp(value: unknown): asserts value is string {
  requireValue(typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value)
}
function conversationBody(entry: RequirementConversationEntry): string {
  identifier(entry.conversationId); timestamp(entry.createdAt)
  requireValue(Number.isSafeInteger(entry.sequence) && entry.sequence > 0 && Number.isSafeInteger(entry.requestIndex) && entry.requestIndex >= 0)
  requireValue(typeof entry.kind === 'string' && /^[a-z][a-z_.]{0,63}$/.test(entry.kind))
  if (entry.sdkSessionId !== undefined) requireValue(typeof entry.sdkSessionId === 'string' && entry.sdkSessionId.length <= 128)
  object(entry.body)
  const body = JSON.stringify(entry.body)
  requireValue(Buffer.byteLength(body) <= REQUIREMENT_CONVERSATION_BODY_LIMIT)
  return body
}
function object(value: unknown): asserts value is Row {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value))
}
function text(value: unknown): asserts value is string { requireValue(typeof value === 'string') }
function strings(value: unknown): asserts value is string[] { requireValue(Array.isArray(value)); value.forEach(text) }
function question(value: unknown): void {
  object(value); text(value.id); text(value.text); text(value.impact); text(value.recommendation); strings(value.choices)
  requireValue(['P0', 'P1', 'P2'].includes(String(value.priority)))
  if (value.capture !== undefined) {
    try { validateQuestions([value]) } catch { throw new RequirementContractError() }
  }
}
function validate(value: unknown): asserts value is RequirementProject {
  object(value); identifier(value.id); positive(value.ownerId); positive(value.version)
  requireValue(value.schemaVersion === 1 && statuses.includes(String(value.status)))
  timestamp(value.createdAt); timestamp(value.updatedAt); requireValue(value.updatedAt >= value.createdAt)
  for (const field of ['title', 'description', 'modelId']) text(value[field])
  for (const field of ['sources', 'evidence', 'questions', 'decisions', 'revisions', 'jobs', 'events']) requireValue(Array.isArray(value[field]))
  const project = value as unknown as RequirementProject
  if (project.remoteCodeConfig !== undefined) {
    try { validateRemoteCodeInput(project.remoteCodeConfig) } catch { throw new RequirementContractError() }
  }
  if (project.prototypeConversations !== undefined) {
    requireValue(Array.isArray(project.prototypeConversations) && project.prototypeConversations.length <= 500)
    const prototypes = new Set<string>(), conversations = new Set<string>(), sessions = new Set<string>()
    for (const binding of project.prototypeConversations) {
      object(binding)
      requireValue(Object.keys(binding).every(key => ['prototypeId', 'conversationId', 'sdkSessionId', 'modelId', 'contextFingerprint', 'prototypeFingerprint', 'skillFingerprint'].includes(key)))
      requireValue(typeof binding.prototypeId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(binding.prototypeId))
      identifier(binding.conversationId); identifier(binding.sdkSessionId); text(binding.modelId)
      requireValue(binding.modelId.length > 0 && binding.modelId.length <= 120)
      requireValue(!prototypes.has(binding.prototypeId) && !conversations.has(binding.conversationId) && !sessions.has(binding.sdkSessionId))
      prototypes.add(binding.prototypeId); conversations.add(binding.conversationId); sessions.add(binding.sdkSessionId)
      for (const fingerprint of [binding.contextFingerprint, binding.prototypeFingerprint, binding.skillFingerprint]) {
        if (fingerprint !== undefined) requireValue(typeof fingerprint === 'string' && /^[a-f0-9]{64}$/.test(fingerprint))
      }
    }
  }
  if (project.preview !== undefined) {
    object(project.preview); positive(project.preview.generation)
    try { requireValue(requirementPreviewOrigin(project.preview.origin) === project.preview.origin) } catch { throw new RequirementContractError() }
    if (project.preview.entryPaths !== undefined) {
      strings(project.preview.entryPaths)
      requireValue(project.preview.entryPaths.length <= 12 && new Set(project.preview.entryPaths).size === project.preview.entryPaths.length)
      try { project.preview.entryPaths.forEach(path => requireValue(requirementPreviewPath(path) === path)) } catch { throw new RequirementContractError() }
    }
  }
  for (const source of project.sources) {
    object(source); text(source.id); text(source.name)
    requireValue(['file', 'url'].includes(source.kind) && typeof source.sha256 === 'string' && /^[a-f0-9]{64}$/.test(source.sha256))
    requireValue(Number.isSafeInteger(source.sizeBytes) && source.sizeBytes >= 0)
    if (source.storageKey !== undefined) text(source.storageKey)
    if (source.url !== undefined) text(source.url)
  }
  for (const item of project.evidence) { object(item); text(item.sourceId); text(item.summary); text(item.limitations) }
  if (project.sourceAnchors !== undefined) {
    try { validateSourceAnchors(project.sourceAnchors, project.sources) } catch { throw new RequirementContractError() }
  }
  if (project.stageState !== undefined) {
    object(project.stageState)
    requireValue(Object.keys(project.stageState).every(key => ['analysisFingerprint', 'prdInputFingerprint', 'prdRevisionId', 'prdClarificationJobId'].includes(key)))
    for (const fingerprint of [project.stageState.analysisFingerprint, project.stageState.prdInputFingerprint]) {
      if (fingerprint !== undefined) requireValue(typeof fingerprint === 'string' && /^[a-f0-9]{64}$/.test(fingerprint))
    }
    for (const stageId of [project.stageState.prdRevisionId, project.stageState.prdClarificationJobId]) {
      if (stageId !== undefined) requireValue(typeof stageId === 'string' && stageId.length > 0 && stageId.length <= 120)
    }
  }
  project.questions.forEach(question)
  if (project.scopeCheckpoint !== undefined) {
    try { validateScopeCheckpoint(project.scopeCheckpoint, project.sources.map(source => source.id)) } catch { throw new RequirementContractError() }
  }
  for (const item of project.decisions) { object(item); question(item.question); text(item.answer); timestamp(item.at) }
  for (const revision of project.revisions) {
    object(revision); text(revision.id); timestamp(revision.createdAt); object(revision.prd)
    text(revision.prd.title); text(revision.prd.summary)
    if (revision.prd.templateVersion !== undefined) {
      try { validatePrdTemplate(revision.prd) } catch { throw new RequirementContractError() }
    }
    requireValue(Array.isArray(revision.prd.blocks) && Array.isArray(revision.prd.requirements) && Array.isArray(revision.screens))
    for (const block of revision.prd.blocks) {
      object(block); text(block.id); text(block.title); text(block.content); strings(block.requirementIds); strings(block.sourceIds)
      if (block.table !== undefined) { object(block.table); strings(block.table.columns); requireValue(Array.isArray(block.table.rows)); block.table.rows.forEach(strings) }
    }
    for (const requirement of revision.prd.requirements) {
      object(requirement); text(requirement.id); text(requirement.title); text(requirement.description); strings(requirement.sourceIds)
      if (requirement.capability !== undefined) text(requirement.capability)
      requireValue(Array.isArray(requirement.acceptance))
      for (const item of requirement.acceptance) { object(item); text(item.id); text(item.text) }
      if (requirement.nonVisualReason !== undefined) text(requirement.nonVisualReason)
    }
    for (const screen of revision.screens) {
      object(screen); text(screen.id); text(screen.title); text(screen.state); text(screen.html); strings(screen.requirementIds); strings(screen.acceptanceIds)
      if (screen.proves !== undefined) text(screen.proves)
      if (screen.capture !== undefined) {
        try { validatePrototypeCapture(screen.capture) } catch { throw new RequirementContractError() }
      }
    }
    try { assertPrototypeSources(revision) } catch { throw new RequirementContractError() }
    if (revision.businessReview !== undefined) {
      try {
        const { revisionId, ...body } = revision.businessReview
        requireValue(revision.prd.templateVersion === 2 && revision.id === revisionId)
        readBusinessReview(body, revision.prd, revision.screens)
      } catch { throw new RequirementContractError() }
    }
    if (revision.confirmedAt !== undefined) timestamp(revision.confirmedAt)
    if (revision.designConfirmedAt !== undefined) timestamp(revision.designConfirmedAt)
    if (revision.capturePlan !== undefined) {
      try { validateCapturePlan(revision.capturePlan, revision.prd, revision.existingPages) } catch { throw new RequirementContractError() }
      for (const { image } of revision.capturePlan.sourceFallback?.images ?? []) {
        requireValue(image.storageKey === `requirements/sources/${project.ownerId}/${project.id}/${image.id}.png` && !project.sources.some(source => source.id === image.id))
      }
    }
    if (revision.screenshots !== undefined) {
      requireValue(Array.isArray(revision.screenshots))
      for (const item of revision.screenshots) { object(item); text(item.screenId); text(item.storageKey); requireValue(typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/.test(item.sha256)) }
    }
    if (revision.validation !== undefined) { object(revision.validation); timestamp(revision.validation.at); strings(revision.validation.errors) }
    if (revision.existingPages !== undefined) {
      requireValue(Array.isArray(revision.existingPages) && revision.existingPages.length <= 12)
      for (const page of revision.existingPages) {
        object(page); text(page.blockId); timestamp(page.capturedAt); text(page.structure)
        if (page.viewId !== undefined) requireValue(typeof page.viewId === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(page.viewId))
        try { requirementPreviewPath(page.path) } catch { throw new RequirementContractError() }
        requireValue(/^[a-f0-9]{64}$/.test(page.fingerprint))
        object(page.image); text(page.image.id); text(page.image.storageKey); requireValue(page.image.kind === 'file' && /^[a-f0-9]{64}$/.test(page.image.sha256))
      }
    }
  }
  for (const job of project.jobs) {
    object(job); text(job.id); timestamp(job.startedAt)
    requireValue(['analyze', 'prd', 'design', 'validate', 'reconstruct', 'business-review'].includes(job.stage) && ['running', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(job.status))
    if (job.stage === 'reconstruct') requireValue(project.revisions.some(revision => revision.id === job.revisionId && revision.capturePlan?.sourceFallback))
    else if (job.stage === 'business-review') requireValue(project.revisions.some(revision => revision.id === job.revisionId && revision.prd.templateVersion === 2))
    else requireValue(job.revisionId === undefined)
    if (job.endedAt !== undefined) timestamp(job.endedAt)
    if (job.error !== undefined) text(job.error)
    if (job.interaction !== undefined) {
      const interaction = job.interaction
      object(interaction)
      requireValue(Object.keys(interaction).length === 4 && Object.keys(interaction).every(key => ['kind', 'phase', 'origin', 'expiresAt'].includes(key)))
      requireValue(interaction.kind === 'browser_login' && ['ready', 'opened'].includes(interaction.phase))
      requireValue(['prd', 'design'].includes(job.stage) && job.status === 'running' && project.status === 'running' && job.endedAt === undefined && job.error === undefined)
      requireValue(project.preview?.origin === interaction.origin)
      try { requireValue(requirementPreviewOrigin(interaction.origin) === interaction.origin) } catch { throw new RequirementContractError() }
      timestamp(interaction.expiresAt)
      requireValue(interaction.expiresAt > job.startedAt && Date.parse(interaction.expiresAt) <= Date.parse(project.updatedAt) + 300000)
    }
  }
  requireValue(project.jobs.filter(job => job.interaction !== undefined).length <= 1)
  for (const event of project.events) { object(event); text(event.id); timestamp(event.at); text(event.text) }
}
function serialize(value: unknown): string {
  let bytes = 0, nodes = 0
  const ancestors = new Set<object>()
  const visit = (item: unknown, depth: number): void => {
    requireValue(depth <= 64 && ++nodes <= 200000)
    if (item === null || typeof item === 'boolean' || typeof item === 'string' || typeof item === 'number') {
      if (typeof item === 'number') requireValue(Number.isFinite(item))
      if (typeof item === 'string') requireValue(item.length <= REQUIREMENT_BODY_LIMIT)
      bytes += Buffer.byteLength(JSON.stringify(item)) + 1
    } else {
      requireValue(item !== null && typeof item === 'object' && !ancestors.has(item) && Object.getOwnPropertySymbols(item).length === 0)
      requireValue(Array.isArray(item) ? Object.keys(item).length === item.length : Object.getPrototypeOf(item) === Object.prototype)
      ancestors.add(item); bytes += 2
      for (const key of Object.keys(item)) {
        requireValue(key.length <= REQUIREMENT_BODY_LIMIT)
        bytes += Buffer.byteLength(JSON.stringify(key)) + 1
        requireValue(bytes <= REQUIREMENT_BODY_LIMIT)
        visit((item as Row)[key], depth + 1)
      }
      ancestors.delete(item)
    }
    requireValue(bytes <= REQUIREMENT_BODY_LIMIT)
  }
  visit(value, 0)
  const body = JSON.stringify(value)
  requireValue(Buffer.byteLength(body) <= REQUIREMENT_BODY_LIMIT)
  return body
}
function snapshot(value: RequirementProject): RequirementProject {
  const result: unknown = JSON.parse(serialize(value)); validate(result); return result
}
function replacement(project: RequirementProject, expectedVersion: number): RequirementProject {
  positive(expectedVersion)
  const result = snapshot(project)
  requireValue(Number.isSafeInteger(expectedVersion + 1) && result.version === expectedVersion + 1)
  return result
}
async function storage<T>(action: () => Promise<T>): Promise<T> {
  try { return await action() }
  catch (error) {
    if (error instanceof RequirementContractError || error instanceof RequirementConflictError || error instanceof RequirementStorageUnavailableError) throw error
    throw new RequirementStorageUnavailableError()
  }
}
async function exclusive<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(done => { release = done })
  locks.set(key, current)
  await previous
  try { return await action() }
  finally { release(); if (locks.get(key) === current) locks.delete(key) }
}
function interrupted(project: RequirementProject): RequirementProject | undefined {
  if (project.status !== 'running' && !project.jobs.some(job => job.status === 'running')) return
  const at = new Date(Math.max(Date.now(), Date.parse(project.updatedAt), ...project.jobs.filter(job => job.status === 'running').map(job => Date.parse(job.startedAt)))).toISOString()
  return {
    ...project, version: project.version + 1, updatedAt: at, status: project.jobs.some(job => job.status === 'running' && ['reconstruct', 'business-review'].includes(job.stage)) ? project.status : 'interrupted',
    jobs: project.jobs.map(job => {
      if (job.status !== 'running') return job
      const { interaction: _interaction, ...rest } = job
      return { ...rest, status: 'interrupted', endedAt: at, error: 'Requirement runtime interrupted; explicit retry required.' }
    }),
  }
}

export class JsonRequirementRepository implements RequirementRepository {
  private readonly directory: string
  private readonly lockKey: string
  constructor(root: string) {
    this.directory = resolve(root, 'requirements', 'projects')
    this.lockKey = process.platform === 'win32' ? this.directory.toLowerCase() : this.directory
  }
  private locked<T>(action: () => Promise<T>): Promise<T> { return storage(() => exclusive(this.lockKey, action)) }
  async verify(): Promise<void> { await this.locked(async () => { await mkdir(this.directory, { recursive: true }); await this.ids() }) }
  private async ids(): Promise<string[]> {
    await mkdir(this.directory, { recursive: true })
    const entries = await readdir(this.directory, { withFileTypes: true })
    if (entries.some(entry => !entry.isFile() || !uuid.test(entry.name.slice(0, -5)) || !entry.name.endsWith('.json'))) throw new RequirementStorageUnavailableError()
    return entries.map(entry => entry.name.slice(0, -5))
  }
  private async read(id: string): Promise<RequirementProject | undefined> {
    let handle
    try { handle = await open(join(this.directory, `${id}.json`), 'r') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    try {
      const info = await handle.stat()
      requireValue(info.isFile() && info.size <= REQUIREMENT_BODY_LIMIT)
      const value: unknown = JSON.parse(await handle.readFile('utf8'))
      validate(value); requireValue(value.id === id); serialize(value)
      return value
    } catch { throw new RequirementStorageUnavailableError() }
    finally { await handle.close() }
  }
  private async publish(project: RequirementProject, create: boolean): Promise<void> {
    const temporary = join(resolve(this.directory, '..'), `.${randomUUID()}.tmp`)
    await mkdir(this.directory, { recursive: true })
    try {
      await writeFile(temporary, serialize(project), { flag: 'wx', mode: 0o600 })
      const target = join(this.directory, `${project.id}.json`)
      if (create) {
        try { await link(temporary, target) }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new RequirementConflictError(); throw error }
      } else await rename(temporary, target)
    } finally { await unlink(temporary).catch(() => {}) }
  }
  async list(ownerId: number): Promise<RequirementProject[]> {
    positive(ownerId)
    return this.locked(async () => {
      const projects: RequirementProject[] = []
      for (const id of await this.ids()) {
        const project = await this.read(id)
        if (project?.ownerId === ownerId) {
          projects.push(project)
          projects.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
          if (projects.length > REQUIREMENT_LIST_LIMIT) projects.pop()
        }
      }
      return projects
    })
  }
  async get(id: string, ownerId: number): Promise<RequirementProject | undefined> {
    identifier(id); positive(ownerId)
    return this.locked(async () => { const project = await this.read(id); return project?.ownerId === ownerId ? project : undefined })
  }
  async create(project: RequirementProject): Promise<void> {
    const next = snapshot(project); requireValue(next.version === 1)
    await this.locked(() => this.publish(next, true))
  }
  async replace(project: RequirementProject, expectedVersion: number): Promise<void> {
    const next = replacement(project, expectedVersion)
    await this.locked(async () => {
      const previous = await this.read(next.id)
      if (!previous || previous.ownerId !== next.ownerId || previous.version !== expectedVersion) throw new RequirementConflictError()
      requireValue(next.createdAt === previous.createdAt && next.updatedAt >= previous.updatedAt)
      await this.publish(next, false)
    })
  }
  async recover(): Promise<void> {
    await this.locked(async () => {
      for (const id of await this.ids()) {
        const previous = await this.read(id)
        const next = previous && interrupted(previous)
        if (next) await this.publish(replacement(next, previous.version), false)
      }
    })
  }
  async appendConversation(ownerId: number, projectId: string, jobId: string, entry: RequirementConversationEntry): Promise<void> {
    positive(ownerId); identifier(projectId); identifier(jobId)
    conversationBody(entry)
    await this.locked(async () => {
      const project = await this.read(projectId)
      requireValue(project?.ownerId === ownerId && project.jobs.some(job => job.id === jobId))
      const directory = resolve(this.directory, '..', 'conversations', projectId, jobId)
      await mkdir(directory, { recursive: true })
      await appendFile(join(directory, `${entry.conversationId}.jsonl`), `${JSON.stringify(entry)}\n`, { mode: 0o600 })
    })
  }
  async readPrdAudit(ownerId: number, projectId: string, jobId: string): Promise<RequirementPrdAudit | undefined> {
    identifier(projectId); identifier(jobId); positive(ownerId)
    const project = await this.get(projectId, ownerId)
    if (!project?.jobs.some(job => job.id === jobId && job.stage === 'prd')) return
    return storage(async () => {
      const directory = resolve(this.directory, '..', 'conversations', projectId, jobId)
      let files
      try { files = await readdir(directory, { withFileTypes: true }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
      if (await realpath(directory) !== directory || files.length > 32) return
      let latest = '', result: RequirementPrdAudit | undefined
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith('.jsonl') || !uuid.test(file.name.slice(0, -6))) continue
        const handle = await open(join(directory, file.name), 'r')
        try {
          const stat = await handle.stat()
          if (!stat.isFile() || stat.nlink !== 1 || stat.size > 128 * 1024 * 1024) continue
          const lines = createInterface({ input: handle.createReadStream({ autoClose: false }), crlfDelay: Infinity })
          let start: Row | undefined, prompt: string | undefined
          try { for await (const line of lines) {
            const entry = JSON.parse(line) as RequirementConversationEntry
            if (entry.conversationId !== file.name.slice(0, -6)) break
            if (entry.kind === 'prd.checkpoint' && entry.createdAt >= latest) { latest = entry.createdAt; result = { checkpoint: entry.body }; continue }
            if (entry.kind === 'session.start') { if (entry.body.stage !== 'prd') break; if (entry.body.purpose === 'prd-authoring') start = entry.body }
            if (!start) continue
            if (entry.kind === 'request' && entry.requestIndex === 1 && typeof entry.body.prompt === 'string') prompt = entry.body.prompt
            if (!result?.checkpoint && prompt && entry.kind === 'assistant.message' && typeof entry.body.content === 'string' && entry.body.content.trim() && entry.createdAt >= latest) {
              latest = entry.createdAt; result = { legacy: { start, prompt, candidate: entry.body.content } }
            }
          } } finally { lines.close() }
        } finally { await handle.close() }
      }
      return result
    })
  }
}

const columns = 'id, owner_id, version, status, created_at, updated_at, body'
async function query(pool: RequirementSqlPool, sql: string, values: unknown[] = []): Promise<unknown> {
  const [result] = await pool.query({ sql, timeout: 15000 }, values)
  return result
}
async function rows(pool: RequirementSqlPool, sql: string, values: unknown[] = []): Promise<Row[]> {
  const result = await query(pool, sql, values)
  if (!Array.isArray(result)) throw new RequirementStorageUnavailableError()
  return result as Row[]
}
function fromRow(row: Row): RequirementProject {
  try {
    const raw: unknown = typeof row.body === 'string' ? JSON.parse(row.body) : Buffer.isBuffer(row.body) ? JSON.parse(row.body.toString('utf8')) : row.body
    validate(raw)
    requireValue(raw.id === row.id && raw.ownerId === Number(row.owner_id) && raw.version === Number(row.version) && raw.status === row.status && raw.createdAt === row.created_at && raw.updatedAt === row.updated_at)
    return snapshot(raw)
  } catch { throw new RequirementStorageUnavailableError() }
}

export class MysqlRequirementRepository implements RequirementRepository {
  constructor(private readonly pool: RequirementSqlPool) {}
  async verify(): Promise<void> {
    await storage(async () => {
      await rows(this.pool, `SELECT ${columns} FROM codeflow_requirement_projects LIMIT 0`)
      await rows(this.pool, 'SELECT owner_id, project_id, job_id, conversation_id, sdk_session_id, sequence, request_index, created_at, kind, body FROM codeflow_requirement_conversation_events LIMIT 0')
    })
  }
  async list(ownerId: number): Promise<RequirementProject[]> {
    positive(ownerId)
    return storage(async () => (await rows(this.pool, `SELECT ${columns} FROM codeflow_requirement_projects WHERE owner_id = ? ORDER BY created_at DESC, id DESC LIMIT 100`, [ownerId])).map(fromRow))
  }
  async get(id: string, ownerId: number): Promise<RequirementProject | undefined> {
    identifier(id); positive(ownerId)
    return storage(async () => {
      const result = await rows(this.pool, `SELECT ${columns} FROM codeflow_requirement_projects WHERE id = ? AND owner_id = ?`, [id, ownerId])
      if (!result.length) return
      const project = fromRow(result[0]); requireValue(project.id === id && project.ownerId === ownerId)
      return project
    })
  }
  async create(project: RequirementProject): Promise<void> {
    const next = snapshot(project); requireValue(next.version === 1)
    await storage(async () => {
      try {
        await query(this.pool, `INSERT INTO codeflow_requirement_projects (${columns}) VALUES (?, ?, ?, ?, ?, ?, ?)`, [next.id, next.ownerId, next.version, next.status, next.createdAt, next.updatedAt, serialize(next)])
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ER_DUP_ENTRY') throw new RequirementConflictError(); throw error }
    })
  }
  async replace(project: RequirementProject, expectedVersion: number): Promise<void> {
    const next = replacement(project, expectedVersion)
    await storage(async () => {
      const result = await query(this.pool,
        'UPDATE codeflow_requirement_projects SET version = ?, status = ?, updated_at = ?, body = ? WHERE id = ? AND owner_id = ? AND version = ? AND created_at = ? AND updated_at <= ?',
        [next.version, next.status, next.updatedAt, serialize(next), next.id, next.ownerId, expectedVersion, next.createdAt, next.updatedAt]) as { affectedRows?: number }
      if (result?.affectedRows !== 1) throw new RequirementConflictError()
    })
  }
  async recover(): Promise<void> {
    await storage(async () => {
      let cursor = ''
      for (;;) {
        const batch = await rows(this.pool, `SELECT ${columns} FROM codeflow_requirement_projects WHERE id > ? AND (status = 'running' OR JSON_CONTAINS(JSON_EXTRACT(body, '$.jobs[*].status'), JSON_QUOTE('running')) = 1) ORDER BY id LIMIT 100`, [cursor])
        if (!batch.length) return
        for (const row of batch) {
          const previous = fromRow(row), next = interrupted(previous)
          if (next) await this.replace(next, previous.version)
          cursor = previous.id
        }
      }
    })
  }
  async appendConversation(ownerId: number, projectId: string, jobId: string, entry: RequirementConversationEntry): Promise<void> {
    positive(ownerId); identifier(projectId); identifier(jobId)
    const body = conversationBody(entry)
    await storage(async () => {
      const result = await query(this.pool,
        `INSERT INTO codeflow_requirement_conversation_events
          (owner_id, project_id, job_id, conversation_id, sdk_session_id, sequence, request_index, created_at, kind, body)
         SELECT ?, id, ?, ?, ?, ?, ?, ?, ?, ? FROM codeflow_requirement_projects
         WHERE id = ? AND owner_id = ? AND JSON_CONTAINS(JSON_EXTRACT(body, '$.jobs[*].id'), JSON_QUOTE(?)) = 1`,
        [ownerId, jobId, entry.conversationId, entry.sdkSessionId ?? null, entry.sequence, entry.requestIndex, entry.createdAt, entry.kind, body, projectId, ownerId, jobId]) as { affectedRows?: number }
      if (result.affectedRows !== 1) throw new RequirementStorageUnavailableError()
    })
  }
  async readPrdAudit(ownerId: number, projectId: string, jobId: string): Promise<RequirementPrdAudit | undefined> {
    identifier(projectId); identifier(jobId); positive(ownerId)
    return storage(async () => {
      const scope = 'FROM codeflow_requirement_conversation_events WHERE owner_id = ? AND project_id = ? AND job_id = ?'
      const ids = [ownerId, projectId, jobId]
      const [row] = await rows(this.pool, `SELECT conversation_id, kind, body ${scope} AND (kind = 'prd.checkpoint' OR (kind = 'session.start' AND JSON_UNQUOTE(JSON_EXTRACT(body, '$.purpose')) = 'prd-authoring')) ORDER BY created_at DESC, sequence DESC LIMIT 1`, ids)
      if (!row) return
      const body = typeof row.body === 'string' || Buffer.isBuffer(row.body) ? JSON.parse(String(row.body)) : row.body
      object(body)
      if (row.kind === 'prd.checkpoint') return { checkpoint: body }
      const conversation = [...ids, row.conversation_id], filter = `${scope} AND conversation_id = ?`
      const [request] = await rows(this.pool, `SELECT JSON_UNQUOTE(JSON_EXTRACT(body, '$.prompt')) AS prompt ${filter} AND kind = 'request' AND request_index = 1 ORDER BY sequence LIMIT 1`, conversation)
      const [message] = await rows(this.pool, `SELECT JSON_UNQUOTE(JSON_EXTRACT(body, '$.content')) AS content ${filter} AND kind = 'assistant.message' AND CHAR_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(body, '$.content'))) > 0 ORDER BY sequence DESC LIMIT 1`, conversation)
      if (typeof request?.prompt === 'string' && typeof message?.content === 'string') return { legacy: { start: body, prompt: request.prompt, candidate: message.content } }
    })
  }
}

export async function createRequirementRepository(backend: 'json' | 'mysql', root: string, pool?: RequirementSqlPool): Promise<RequirementRepository> {
  let repository: JsonRequirementRepository | MysqlRequirementRepository
  if (backend === 'json') repository = new JsonRequirementRepository(root)
  else if (backend === 'mysql' && pool) repository = new MysqlRequirementRepository(pool)
  else throw new RequirementStorageUnavailableError()
  await repository.verify()
  return repository
}