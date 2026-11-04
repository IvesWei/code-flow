import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import type { CodingTask, SelfTestArtifact, TaskEntry, TaskStatus } from '../../shared/task.js'
import type { TaskListProjection } from '../../shared/task-summary.js'
import { diffTask, json, StorageContractError, StorageOverloadError, terminalStatuses, validateChange, validateFile, validateTask, validateUsage, type FileRecord, type HistoryKind, type Page, type TaskChange, type TaskRepository, type UsageRecord } from '../storage/contracts.js'
import { pageLimit } from '../storage/task-repository.js'
import { uploadName } from './upload-name.js'
import { taskSummary } from './task-summary.js'

export class TaskStorageError extends Error {
  constructor(cause: unknown) {
    super('\u4efb\u52a1\u6570\u636e\u4fdd\u5b58\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u5b58\u50a8\u670d\u52a1\u3001\u8fde\u63a5\u914d\u7f6e\u6216\u76ee\u5f55\u6743\u9650', { cause })
    this.name = 'TaskStorageError'
  }
}
export { StorageOverloadError }
export interface TaskPersistence {
  load(): Promise<CodingTask[]>
  save(tasks: CodingTask[]): Promise<void>
}
export interface QueueLimits { operations?: number; bytes?: number }
function repository(value: TaskPersistence | TaskRepository | undefined): value is TaskRepository { return !!value && 'commit' in value }
function detailProjection(task: CodingTask): CodingTask {
  const excluded = new Set(['selfTestArtifacts', 'modelHistory', 'acceptanceHistory', 'acceptanceSelectionHistory'])
  const projected = Object.fromEntries(Object.keys(task).filter(key => !excluded.has(key) && key !== 'entries').map(key => [key, task[key as keyof CodingTask]]))
  return structuredClone({ ...projected, entries: task.entries.slice(-1000) }) as CodingTask
}
function recover(task: CodingTask): CodingTask {
  const result = structuredClone(task)
  result.prdName = uploadName(result.prdName)
  result.designNames = result.designNames.map(uploadName)
  result.modelInTurn = false
  if (result.modelTurn?.status === 'running') result.modelTurn = { ...result.modelTurn, status: 'interrupted', finishedAt: new Date().toISOString(), summary: '\u540e\u53f0\u91cd\u65b0\u542f\u52a8\uff0c\u8bf7\u6c42\u5df2\u4e2d\u65ad' }
  if (['SELF_TEST', 'TEST_EXECUTION'].includes(result.status) && result.workspace && result.createdBranch) {
    result.status = 'REVIEW'
    result.selfTestError = '\u670d\u52a1\u91cd\u65b0\u542f\u52a8\uff0c\u81ea\u6d4b\u5df2\u4e2d\u65ad\uff1b\u53ef\u4ee5\u7ee7\u7eed\u6267\u884c\u6216\u4fee\u6b63\u672a\u5b8c\u6210\u7684\u7528\u4f8b\u3002'
    delete result.question
  } else if (!terminalStatuses.includes(result.status)) {
    result.status = 'FAILED'
    result.error = '\u670d\u52a1\u91cd\u65b0\u542f\u52a8\uff0c\u539f\u7f16\u7801\u4f1a\u8bdd\u5df2\u4e2d\u65ad\u3002\u8bf7\u91cd\u65b0\u521b\u5efa\u4efb\u52a1\u3002'
    delete result.question
  }
  return result
}

export class TaskStore {
  private readonly working = new Map<string, CodingTask>()
  private readonly committedTasks = new Map<string, CodingTask>()
  private readonly versions = new Map<string, number>()
  private readonly loading = new Map<string, Promise<CodingTask | undefined>>()
  private readonly writes = new Map<string, Promise<void>>()
  private storageError?: TaskStorageError
  private pendingOperations = 0
  private pendingBytes = 0
  private readonly files = new Map<string, FileRecord[]>()
  private readonly usage = new Map<string, UsageRecord[]>()
  private readonly journal = new Map<string, Pick<TaskChange, 'events' | 'artifacts' | 'runs' | 'snapshots'> & { eventBase: number }>()

  constructor(private readonly file: string | undefined, private readonly renameFile: typeof renameSync = renameSync, private readonly persistence?: TaskPersistence | TaskRepository, initialTasks: CodingTask[] = [], private readonly limits: QueueLimits = {}) {
    if (file) mkdirSync(dirname(file), { recursive: true })
    let tasks = initialTasks
    if (file) {
      try {
        const stored: unknown = JSON.parse(readFileSync(file, 'utf8'))
        if (Array.isArray(stored)) tasks = stored as CodingTask[]
        else {
          if (!stored || typeof stored !== 'object' || !('bodyVersion' in stored) || stored.bodyVersion !== 1 || !('tasks' in stored) || !Array.isArray(stored.tasks)) throw new StorageContractError('Invalid JSON storage version')
          tasks = stored.tasks as CodingTask[]
          const metadata = stored as { files?: [string, FileRecord[]][]; usage?: [string, UsageRecord[]][]; journal?: [string, Pick<TaskChange, 'events' | 'artifacts' | 'runs' | 'snapshots'> & { eventBase: number }][] }
          for (const [id, records] of metadata.files ?? []) { records.forEach(validateFile); this.files.set(id, records) }
          for (const [id, records] of metadata.usage ?? []) { records.forEach(validateUsage); this.usage.set(id, records) }
          for (const [id, history] of metadata.journal ?? []) this.journal.set(id, history)
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    for (const task of tasks) {
      validateTask(task)
      const recovered = recover(task)
      this.working.set(task.id, recovered)
      this.committedTasks.set(task.id, structuredClone(recovered))
      this.versions.set(task.id, 1)
    }
    if (repository(persistence)) return
    if (persistence) this.enqueueLegacyInitial()
    else if (file) { try { this.writeJson() } catch (error) { throw new TaskStorageError(error) } }
  }

  static async fromPersistence(persistence: TaskPersistence | TaskRepository, limits: QueueLimits = {}): Promise<TaskStore> {
    if (repository(persistence)) {
      await persistence.recoverActive()
      return new TaskStore(undefined, renameSync, persistence, [], limits)
    }
    const store = new TaskStore(undefined, renameSync, persistence, await persistence.load(), limits)
    await store.flush()
    return store
  }

  async flush(): Promise<void> {
    while (this.writes.size) await Promise.all([...this.writes.values()])
    if (this.storageError) throw this.storageError
  }
  get asynchronousPersistence(): boolean { return !!this.persistence }
  get queueSize(): Readonly<{ operations: number; bytes: number }> { return { operations: this.pendingOperations, bytes: this.pendingBytes } }
  private assertWritable(): void { if (this.storageError) throw this.storageError }
  list(): CodingTask[] { return [...this.committedTasks.values()].reverse().map(task => structuredClone(task)) }
  get(id: string): CodingTask | undefined {
    const task = this.working.get(id)
    return task ? structuredClone(task) : undefined
  }
  committed(id: string): CodingTask | undefined {
    const task = this.committedTasks.get(id)
    return task ? structuredClone(task) : undefined
  }
  async readTask(id: string): Promise<CodingTask | undefined> {
    const committed = this.committedTasks.get(id)
    if (committed) return detailProjection(committed)
    if (!repository(this.persistence)) return undefined
    if (!this.persistence.readTask) throw new StorageContractError('Repository does not support lightweight task reads')
    const loaded = await this.persistence.readTask(id)
    return loaded ? detailProjection(loaded.task) : undefined
  }
  async loadTask(id: string): Promise<CodingTask | undefined> {
    if (!repository(this.persistence)) return this.committed(id)
    if (this.committedTasks.has(id)) {
      const value = this.committedTasks.get(id)!
      this.committedTasks.delete(id); this.committedTasks.set(id, value)
      return structuredClone(value)
    }
    this.assertWritable()
    const current = this.loading.get(id)
    if (current) return structuredClone(await current)
    const promise = (async () => {
      const loaded = await (this.persistence as TaskRepository).loadTask(id)
      if (!loaded) return undefined
      if (!this.working.has(id)) {
        this.working.set(id, structuredClone(loaded.task)); this.committedTasks.set(id, structuredClone(loaded.task)); this.versions.set(id, loaded.version)
        this.evictIdle(id)
      }
      return this.committed(id)
    })()
    this.loading.set(id, promise)
    try { return await promise } finally { this.loading.delete(id) }
  }
  async release(id: string): Promise<void> {
    while (this.writes.has(id)) await this.writes.get(id)
    if (repository(this.persistence)) { this.working.delete(id); this.committedTasks.delete(id); this.versions.delete(id) }
  }
  private evictIdle(protectedId?: string): void {
    if (!repository(this.persistence)) return
    for (const [id, task] of this.committedTasks) {
      if (this.committedTasks.size <= 32) break
      if (id === protectedId || this.writes.has(id) || !terminalStatuses.includes(task.status) || task.modelInTurn) continue
      this.committedTasks.delete(id); this.working.delete(id); this.versions.delete(id)
    }
  }
  async queryTasks(ownerId?: number, cursor?: string, limit = 50): Promise<Page<TaskListProjection>> {
    pageLimit(limit)
    if (repository(this.persistence)) return this.persistence.queryTasks(ownerId, cursor, limit)
    const tasks = [...this.committedTasks.values()].filter(task => ownerId === undefined || task.ownerId === ownerId).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
    let start = 0
    if (cursor) { const index = tasks.findIndex(task => task.id === cursor); if (index < 0) throw new StorageContractError('Invalid task cursor'); start = index + 1 }
    const items = tasks.slice(start, start + limit).map(task => ({ ...taskSummary(task), ownerId: task.ownerId, instruction: '', prdName: '', designNames: [], entries: [] }))
    return { items, ...(tasks.length > start + limit ? { nextCursor: items.at(-1)!.id } : {}) }
  }
  async history(id: string, kind: HistoryKind, cursor?: string, limit = 50): Promise<Page<unknown>> {
    pageLimit(limit)
    if (repository(this.persistence)) return this.persistence.history(id, kind, cursor, limit)
    const task = this.committedTasks.get(id)
    if (!task) return { items: [] }
    const recorded = this.journal.get(id)
    let values: unknown[]
    if (kind === 'events') values = recorded ? [...task.entries.slice(0, recorded.eventBase), ...recorded.events] : task.entries
    else if (kind === 'artifacts') values = recorded?.artifacts ?? task.selfTestArtifacts ?? []
    else if (kind === 'runs') values = recorded?.runs ?? [...task.selfTests?.filter(test => test.status !== 'pending') ?? [], ...task.automationRuns ?? []]
    else if (kind === 'snapshots') values = recorded?.snapshots ?? diffTask(undefined, task, 0).snapshots
    else throw new StorageContractError('Invalid history kind')
    if (kind === 'events') {
      if (cursor !== undefined && (!/^[1-9][0-9]*$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))) throw new StorageContractError('Invalid history cursor')
      const end = cursor === undefined ? values.length : Math.min(Number(cursor) - 1, values.length)
      const start = Math.max(0, end - limit)
      return { items: structuredClone(values.slice(start, end)), ...(start > 0 ? { nextCursor: String(start + 1) } : {}) }
    }
    const start = cursor === undefined ? 0 : Number(cursor)
    if (!Number.isSafeInteger(start) || start < 0) throw new StorageContractError('Invalid history cursor')
    return { items: structuredClone(values.slice(start, start + limit)), ...(values.length > start + limit ? { nextCursor: String(start + limit) } : {}) }
  }
  async hasBusyTasks(): Promise<boolean> {
    if ([...this.working.values()].some(task => !terminalStatuses.includes(task.status) || task.modelInTurn)) return true
    return repository(this.persistence) ? this.persistence.hasBusyTasks() : false
  }
  async findArtifact(id: string, phase: SelfTestArtifact['phase'], scope: string, inputFingerprint: string): Promise<SelfTestArtifact | undefined> {
    const pending = this.working.get(id)?.selfTestArtifacts?.findLast(artifact => artifact.phase === phase && artifact.scope === scope && artifact.inputFingerprint === inputFingerprint && artifact.status === 'complete')
    if (pending) return structuredClone(pending)
    if (repository(this.persistence) && this.persistence.findArtifact) return this.persistence.findArtifact(id, phase, scope, inputFingerprint)
    return undefined
  }
  create(task: CodingTask): void {
    this.assertWritable()
    if (this.working.has(task.id)) throw new Error('Task already exists')
    this.saveTask(undefined, structuredClone(task))
  }
  update(id: string, patch: Partial<CodingTask>): CodingTask {
    this.assertWritable()
    const before = this.working.get(id)
    if (!before) throw new Error('Task not found; call loadTask first')
    if (patch.id !== undefined && patch.id !== id) throw new StorageContractError('Task ID is immutable')
    const after = { ...before, ...structuredClone(patch), updatedAt: new Date().toISOString() }
    if (patch.selfTestArtifacts) {
      const revisions = new Map<string, number>()
      const existing = new Set(before.selfTestArtifacts?.map(artifact => artifact.id))
      for (const artifact of before.selfTestArtifacts ?? []) revisions.set(`${artifact.phase}:${artifact.scope}`, Math.max(revisions.get(`${artifact.phase}:${artifact.scope}`) ?? 0, artifact.revision))
      after.selfTestArtifacts = after.selfTestArtifacts!.map(artifact => {
        if (existing.has(artifact.id)) return artifact
        const key = `${artifact.phase}:${artifact.scope}`
        const revision = Math.max(artifact.revision, (revisions.get(key) ?? 0) + 1)
        revisions.set(key, revision)
        return { ...artifact, revision }
      })
    }
    this.saveTask(before, after)
    return structuredClone(after)
  }
  entry(id: string, kind: TaskEntry['kind'], text: string, detail?: string, tool?: Pick<TaskEntry, 'toolCallId' | 'toolEvent' | 'turnId' | 'turnEvent'>): void {
    this.assertWritable()
    const task = this.working.get(id)
    if (!task) throw new Error('Task not found; call loadTask first')
    const stage = task.status === 'FAILED' || task.status === 'NEEDS_INPUT' ? task.entries.at(-1)?.stage || 'CODING' : task.status === 'QUEUED' ? 'CODING' : task.status
    const at = new Date().toISOString()
    const entry: TaskEntry = { at, kind, text: text.slice(0, 3000), detail: detail?.slice(0, 8000), stage, ...structuredClone(tool) }
    const after = { ...task, entries: [...task.entries, entry].slice(-1000), updatedAt: at }
    const change: TaskChange = { id, expectedVersion: this.versions.get(id) ?? 0, header: { ownerId: task.ownerId, status: task.status, createdAt: task.createdAt, updatedAt: at }, events: [entry], artifacts: [], cases: [], runs: [], snapshots: [], files: [], usage: [] }
    this.saveTask(task, after, change)
  }
  status(id: string, status: TaskStatus, detail: string): void {
    this.update(id, { status })
    this.entry(id, 'info', detail)
  }
  recordUsage(id: string, usage: UsageRecord): void {
    validateUsage(usage)
    this.record(id, 'usage', structuredClone(usage))
  }
  recordFile(id: string, file: FileRecord): void {
    validateFile(file)
    this.record(id, 'files', structuredClone(file))
  }
  private record(id: string, kind: 'files' | 'usage', value: FileRecord | UsageRecord): void {
    this.assertWritable()
    const task = this.working.get(id)
    if (!task) throw new Error('Task not found; call loadTask first')
    if (value.taskId !== undefined && value.taskId !== id) throw new StorageContractError('Metadata task mismatch')
    const change = diffTask(task, task, this.versions.get(id) ?? 0)
    if (kind === 'files') change.files.push(value as FileRecord)
    else change.usage.push(value as UsageRecord)
    this.saveTask(task, task, change)
  }
  private saveTask(before: CodingTask | undefined, after: CodingTask, supplied?: TaskChange): void {
    this.assertWritable()
    const change = supplied ?? diffTask(before, after, this.versions.get(after.id) ?? 0)
    validateChange(change)
    const touched = supplied ? { entries: supplied.events, collectionReferences: after.entries.length * 8 } : Object.fromEntries(Object.entries(after).filter(([key, value]) => value !== before?.[key as keyof CodingTask]))
    const bytes = Buffer.byteLength(json(change, Number.MAX_SAFE_INTEGER)) + Buffer.byteLength(json(touched, Number.MAX_SAFE_INTEGER))
    if (this.pendingOperations >= Math.min(this.limits.operations ?? 200, 200) || this.pendingBytes + bytes > Math.min(this.limits.bytes ?? 16 * 1024 * 1024, 16 * 1024 * 1024)) throw new StorageOverloadError()
    if (!this.persistence && !this.file) throw new TaskStorageError(new Error('Storage not configured'))
    if (!this.persistence) {
      this.working.set(after.id, after)
      const oldFiles = this.files.get(after.id), oldUsage = this.usage.get(after.id), oldJournal = this.journal.get(after.id)
      this.applyMetadata(change, before)
      try { this.writeJson(); this.committedTasks.set(after.id, after); this.versions.set(after.id, (this.versions.get(after.id) ?? 0) + 1) }
      catch (error) {
        if (before) this.working.set(after.id, before); else this.working.delete(after.id)
        if (oldFiles) this.files.set(after.id, oldFiles); else this.files.delete(after.id)
        if (oldUsage) this.usage.set(after.id, oldUsage); else this.usage.delete(after.id)
        if (oldJournal) this.journal.set(after.id, oldJournal); else this.journal.delete(after.id)
        this.storageError = new TaskStorageError(error); throw this.storageError
      }
      return
    }
    const nextVersion = change.create ? 1 : change.expectedVersion + 1
    const legacySnapshot = repository(this.persistence) ? undefined : [...this.working.values()].filter(task => task.id !== after.id).concat(after)
    this.enqueue(after.id, bytes, async () => {
      if (repository(this.persistence)) {
        const actual = await this.persistence.commit(change)
        if (actual !== nextVersion) throw new StorageContractError('Unexpected committed revision')
      } else await (this.persistence as TaskPersistence).save(legacySnapshot!)
      this.applyMetadata(change, before)
      this.committedTasks.set(after.id, after)
    })
    this.working.set(after.id, after)
    this.versions.set(after.id, nextVersion)
  }
  private applyMetadata(change: TaskChange, before?: CodingTask): void {
    if (repository(this.persistence)) return
    let previous = this.journal.get(change.id)
    if (!previous) {
      const seed = before ? diffTask(undefined, before, 0) : undefined
      previous = { events: before?.entries ?? [], artifacts: before?.selfTestArtifacts ?? [], runs: seed?.runs ?? [], snapshots: seed?.snapshots ?? [], eventBase: 0 }
    }
    const runs = [...previous.runs]
    for (const run of change.runs) {
      const index = run.continuation ? runs.findLastIndex(item => item.caseId === run.caseId && item.executor === run.executor) : -1
      const prior = runs[index]
      const identity = run.continuationFrom ?? run
      if (prior && ['running', 'generating'].includes(prior.status) && !prior.finishedAt && prior.startedAt === identity.startedAt && prior.inputFingerprint === identity.inputFingerprint) runs[index] = { ...run, id: prior.id }
      else runs.push(run)
    }
    this.journal.set(change.id, {
      eventBase: previous.eventBase, events: [...previous.events, ...change.events],
      artifacts: [...previous.artifacts.filter(artifact => !change.artifacts.some(next => next.id === artifact.id)), ...change.artifacts],
      runs, snapshots: [...previous.snapshots, ...change.snapshots],
    })
    for (const value of change.files) {
      const records = this.files.get(change.id) ?? []
      this.files.set(change.id, [...records.filter(file => file.storageKey !== value.storageKey), value])
    }
    for (const value of change.usage) {
      const records = this.usage.get(change.id) ?? []
      if (!records.some(usage => usage.sessionId === value.sessionId && usage.sourceEventId === value.sourceEventId)) this.usage.set(change.id, [...records, value])
    }
  }
  private enqueue(id: string, bytes: number, action: () => Promise<void>): void {
    this.pendingOperations++; this.pendingBytes += bytes
    const previous = repository(this.persistence) ? this.writes.get(id) ?? Promise.resolve() : Promise.all([...this.writes.values()]).then(() => {})
    const write = previous.then(async () => {
      if (this.storageError) return
      try { await action() }
      catch (error) { this.storageError = new TaskStorageError(error); this.working.clear(); this.versions.clear() }
    }).finally(() => {
      this.pendingOperations--; this.pendingBytes -= bytes
      if (this.writes.get(id) === write) this.writes.delete(id)
    })
    this.writes.set(id, write)
  }
  private enqueueLegacyInitial(): void {
    const snapshot = [...this.working.values()]
    this.enqueue('__startup__', Buffer.byteLength(json(snapshot, Number.MAX_SAFE_INTEGER)), async () => { await (this.persistence as TaskPersistence).save(snapshot) })
  }
  private writeJson(): void {
    if (!this.file) throw new TaskStorageError(new Error('Storage not configured'))
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify({ bodyVersion: 1, tasks: [...this.working.values()], files: [...this.files], usage: [...this.usage], journal: [...this.journal] }, null, 2))
      for (let attempt = 0; attempt < 4; attempt++) {
        try { this.renameFile(temporary, this.file); return }
        catch (error) {
          if (!['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code || '') || attempt === 3) throw error
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1))
        }
      }
    } finally { rmSync(temporary, { force: true }) }
  }
}