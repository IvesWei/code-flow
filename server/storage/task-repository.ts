import { randomUUID } from 'node:crypto'
import type { AutomationRun, CodingTask, SelfTestArtifact, SelfTestCase, TaskEntry } from '../../shared/task.js'
import type { TaskListProjection } from '../../shared/task-summary.js'
import { BODY_VERSION, STATE_LIMIT, StorageConflictError, StorageContractError, decode, hash, identifier, json, storedJson, positive, taskState, validateArtifact, validateChange, validateEntry, validateState, validateTask, type HistoryKind, type LoadedTask, type Page, type TaskChange, type TaskRepository } from './contracts.js'

export interface SqlConnection {
  query(options: { sql: string; timeout: number }, values?: unknown[]): Promise<[unknown, unknown?]>
  beginTransaction(): Promise<void>; commit(): Promise<void>; rollback(): Promise<void>; release(): void
}
export interface SqlPool {
  query: SqlConnection['query']
  getConnection(): Promise<SqlConnection>
}
type Row = Record<string, unknown>
const timeout = 15000
async function query(connection: Pick<SqlConnection, 'query'>, sql: string, values: unknown[] = []): Promise<unknown> {
  const [result] = await connection.query({ sql, timeout }, values)
  return result
}
async function rows(connection: Pick<SqlConnection, 'query'>, sql: string, values: unknown[] = []): Promise<Row[]> {
  const result = await query(connection, sql, values)
  if (!Array.isArray(result)) throw new StorageContractError('Expected database rows')
  return result as Row[]
}
function affected(result: unknown): number { return Number((result as { affectedRows?: number })?.affectedRows) }
function date(value: unknown): string {
  const result = value instanceof Date ? value : new Date(String(value).includes('T') ? String(value) : `${String(value).replace(' ', 'T')}Z`)
  if (!Number.isFinite(result.getTime())) throw new StorageContractError('Invalid database date')
  return result.toISOString()
}
function optionalDate(value: unknown): string | undefined { return value == null ? undefined : date(value) }
function revision(value: unknown): number { const result = Number(value); positive(result); return result }
function increment(value: number, amount = 1): number { const result = value + amount; positive(result); return result }
function body(row: Row, key = 'body'): Record<string, unknown> {
  const value = decode(row[key], row.body_version)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StorageContractError('Invalid database body')
  return value as Record<string, unknown>
}
function taskRow(row: Row): LoadedTask {
  const state = body(row, 'state'); validateState(state)
  const task = { ...state, id: String(row.id), ...(row.owner_id == null ? {} : { ownerId: Number(row.owner_id) }), status: row.status, createdAt: date(row.created_at), updatedAt: date(row.updated_at), entries: [] } as unknown as CodingTask
  delete (task as unknown as Row)._collections
  delete (task as unknown as Row)._snapshotRefs
  validateTask(task)
  return { task, version: revision(row.row_version) }
}
function artifactRow(row: Row): SelfTestArtifact {
  const refs = decode(row.input_refs, row.body_version)
  if (!Array.isArray(refs)) throw new StorageContractError('Invalid artifact references')
  if (hash(String(row.scope)) !== row.scope_hash) throw new StorageContractError('Scope hash mismatch')
  const artifact: SelfTestArtifact = {
    id: String(row.id), revision: revision(row.revision), schemaVersion: 1, phase: row.phase as SelfTestArtifact['phase'], scope: String(row.scope),
    inputFingerprint: String(row.input_fingerprint), inputRefs: refs.map(ref => {
      if (!ref || typeof ref !== 'object' || !['artifact', 'content_fingerprint', 'workspace_fingerprint'].includes(ref.kind) || typeof ref.value !== 'string') throw new StorageContractError('Invalid input reference')
      return ref.value as string
    }), status: row.status as SelfTestArtifact['status'], createdAt: date(row.created_at), model: String(row.model), rulesVersion: String(row.rules_version),
    ...(row.session_id == null ? {} : { sessionId: String(row.session_id) }), ...(row.finished_at == null ? {} : { finishedAt: date(row.finished_at) }),
    ...(row.output == null ? {} : { output: decode(row.output, row.body_version) as SelfTestArtifact['output'] }), ...(row.error == null ? {} : { error: String(row.error) }),
  }
  validateArtifact(artifact)
  return artifact
}
function entryRow(row: Row): TaskEntry {
  const entry = { ...body(row), at: date(row.created_at), kind: row.kind, ...(row.stage == null ? {} : { stage: row.stage }), ...(row.turn_id == null ? {} : { turnId: row.turn_id }), ...(row.tool_call_id == null ? {} : { toolCallId: row.tool_call_id }) } as TaskEntry
  validateEntry(entry); return entry
}
export function pageLimit(limit = 50): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new StorageContractError('Invalid page limit')
  return limit
}
function sequenceCursor(cursor?: string): number {
  if (cursor === undefined) return 0
  if (!/^[1-9][0-9]*$/.test(cursor) || !Number.isSafeInteger(Number(cursor))) throw new StorageContractError('Invalid history cursor')
  return Number(cursor)
}
function listCursor(cursor: string): { at: string; id: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as { at: string; id: string }
    identifier(value.id)
    if (!Number.isFinite(Date.parse(value.at))) throw new Error()
    return value
  } catch { throw new StorageContractError('Invalid task cursor') }
}

export class MysqlTaskRepository implements TaskRepository {
  constructor(private readonly pool: SqlPool, private readonly healthCheck: () => Promise<void> = async () => {}) {}

  async commit(change: TaskChange): Promise<number> {
    validateChange(change)
    let connection: SqlConnection | undefined
    try {
      await this.healthCheck()
      connection = await this.pool.getConnection()
      await connection.beginTransaction()
      let eventSeq = 1, caseOrdinal = 1, runSeq = 1, snapshotSeq = 1
      if (change.create) {
        await query(connection, 'INSERT INTO codeflow_tasks (id, owner_id, status, created_at, updated_at, row_version, body_version, state) VALUES (?, ?, ?, ?, ?, 1, ?, ?)', [change.id, change.header.ownerId ?? null, change.header.status, new Date(change.header.createdAt), new Date(change.header.updatedAt), BODY_VERSION, storedJson(change.state, STATE_LIMIT)])
      } else {
        const [locked] = await rows(connection, 'SELECT row_version, next_event_seq, next_case_ordinal, next_run_seq, next_snapshot_seq FROM codeflow_tasks WHERE id = ? FOR UPDATE', [change.id])
        if (!locked || revision(locked.row_version) !== change.expectedVersion) throw new StorageConflictError('Task revision conflict')
        eventSeq = revision(locked.next_event_seq); caseOrdinal = revision(locked.next_case_ordinal); runSeq = revision(locked.next_run_seq); snapshotSeq = revision(locked.next_snapshot_seq)
      }
      const nextVersion = change.create ? 1 : increment(change.expectedVersion)
      for (const entry of change.events) {
        const { at, kind, stage, turnId, toolCallId, ...eventBody } = entry
        await query(connection, 'INSERT INTO codeflow_task_events (task_id, seq, created_at, kind, stage, turn_id, tool_call_id, body_version, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [change.id, eventSeq, new Date(at), kind, stage ?? null, turnId ?? null, toolCallId ?? null, BODY_VERSION, storedJson(eventBody)])
        eventSeq = increment(eventSeq)
      }
      for (const artifact of change.artifacts) {
        const [existing] = await rows(connection, 'SELECT * FROM codeflow_self_test_artifacts WHERE task_id = ? AND id = ? FOR UPDATE', [change.id, artifact.id])
        const inputRefs = []
        for (const value of artifact.inputRefs) {
          const [reference] = await rows(connection, 'SELECT id FROM codeflow_self_test_artifacts WHERE task_id = ? AND id = ?', [change.id, value])
          if (!reference && !/^[a-f0-9]{64}$/.test(value)) throw new StorageContractError('Missing same-task artifact reference')
          inputRefs.push({ kind: reference ? 'artifact' : 'content_fingerprint', value })
        }
        if (existing) {
          const previous = artifactRow(existing)
          if (previous.status !== 'running' || previous.scope !== artifact.scope || previous.phase !== artifact.phase || previous.revision !== artifact.revision || previous.inputFingerprint !== artifact.inputFingerprint || json(previous.inputRefs) !== json(artifact.inputRefs)) throw new StorageContractError('Artifact is immutable')
          const result = await query(connection, "UPDATE codeflow_self_test_artifacts SET session_id = ?, status = ?, finished_at = ?, output = ?, error = ? WHERE task_id = ? AND id = ? AND status = 'running'", [artifact.sessionId ?? null, artifact.status, artifact.finishedAt ? new Date(artifact.finishedAt) : null, artifact.output === undefined ? null : storedJson(artifact.output), artifact.error ?? null, change.id, artifact.id])
          if (affected(result) !== 1) throw new StorageConflictError('Artifact finalization conflict')
        } else {
          await query(connection, 'INSERT INTO codeflow_self_test_artifacts (id, task_id, phase, scope, scope_hash, revision, status, input_fingerprint, rules_version, model, session_id, created_at, finished_at, body_version, output, error, input_refs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [artifact.id, change.id, artifact.phase, artifact.scope, hash(artifact.scope), artifact.revision, artifact.status, artifact.inputFingerprint, artifact.rulesVersion, artifact.model, artifact.sessionId ?? null, new Date(artifact.createdAt), artifact.finishedAt ? new Date(artifact.finishedAt) : null, BODY_VERSION, artifact.output === undefined ? null : storedJson(artifact.output), artifact.error ?? null, storedJson(inputRefs)])
        }
      }
      let order: Map<string, number> | undefined
      if (change.caseOrder) {
        const existing = await rows(connection, 'SELECT case_id, ordinal FROM codeflow_test_cases WHERE task_id = ? ORDER BY ordinal', [change.id])
        const firstOrdinal = caseOrdinal
        caseOrdinal = increment(caseOrdinal, change.caseOrder.length)
        order = new Map(change.caseOrder.map((id, index) => [id, increment(firstOrdinal, index)]))
        for (const item of existing) {
          const ordinal = order.get(String(item.case_id))
          if (ordinal === undefined) {
            const [used] = await rows(connection, 'SELECT id FROM codeflow_case_runs WHERE task_id = ? AND case_id = ? LIMIT 1', [change.id, item.case_id])
            if (used) {
              await query(connection, 'UPDATE codeflow_test_cases SET ordinal = ? WHERE task_id = ? AND case_id = ?', [caseOrdinal, change.id, item.case_id])
              caseOrdinal = increment(caseOrdinal)
            } else await query(connection, 'DELETE FROM codeflow_test_cases WHERE task_id = ? AND case_id = ?', [change.id, item.case_id])
          } else await query(connection, 'UPDATE codeflow_test_cases SET ordinal = ? WHERE task_id = ? AND case_id = ?', [ordinal, change.id, item.case_id])
        }
      }
      for (const item of change.cases) {
        const [existing] = await rows(connection, 'SELECT definition_revision, definition_fingerprint FROM codeflow_test_cases WHERE task_id = ? AND case_id = ?', [change.id, item.id])
        if (existing) {
          const definitionRevision = revision(existing.definition_revision)
          if (existing.definition_fingerprint !== item.fingerprint) {
            increment(definitionRevision)
            await query(connection, 'UPDATE codeflow_test_cases SET definition_revision = definition_revision + 1, definition_fingerprint = ?, body_version = ?, definition = ?, updated_at = ? WHERE task_id = ? AND case_id = ?', [item.fingerprint, BODY_VERSION, storedJson(item.definition), new Date(change.header.updatedAt), change.id, item.id])
          }
        } else {
          const ordinal = order?.get(item.id)
          await query(connection, 'INSERT INTO codeflow_test_cases (task_id, case_id, ordinal, definition_revision, definition_fingerprint, body_version, definition, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)', [change.id, item.id, ordinal ?? caseOrdinal, item.fingerprint, BODY_VERSION, storedJson(item.definition), new Date(change.header.updatedAt), new Date(change.header.updatedAt)])
          if (ordinal === undefined) caseOrdinal = increment(caseOrdinal)
        }
      }
      let planId: string | null = null
      let reviewId: string | null = null
      let planChanged = false
      for (const item of change.snapshots) {
        if (item.kind === 'execution_plan' && item.body.value) {
          const plan = item.body.value as { artifactRefs?: string[] }
          for (const reference of plan.artifactRefs ?? []) {
            const [artifact] = await rows(connection, 'SELECT id, phase FROM codeflow_self_test_artifacts WHERE task_id = ? AND id = ?', [change.id, reference])
            if (!artifact) throw new StorageContractError('Plan references missing same-task artifact')
            if (artifact.phase === 'review') reviewId = reference
          }
        }
        await query(connection, 'INSERT INTO codeflow_acceptance_snapshots (id, task_id, seq, kind, created_at, input_fingerprint, body_version, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [item.id, change.id, snapshotSeq, item.kind, new Date(item.createdAt), item.inputFingerprint ?? null, BODY_VERSION, storedJson(item.body)])
        snapshotSeq = increment(snapshotSeq)
        if (item.kind === 'execution_plan') { planChanged = true; planId = item.body.value == null ? null : item.id; if (!planId) reviewId = null }
      }
      if (change.runs.length && !planChanged) {
        const [plan] = await rows(connection, "SELECT id, body, body_version FROM codeflow_acceptance_snapshots WHERE task_id = ? AND kind = 'execution_plan' ORDER BY seq DESC LIMIT 1", [change.id])
        planId = plan ? String(plan.id) : null
        if (plan) {
          const value = body(plan).value as { artifactRefs?: string[] } | null
          if (!value) planId = null
          for (const reference of value?.artifactRefs ?? []) {
            const [artifact] = await rows(connection, 'SELECT id, phase FROM codeflow_self_test_artifacts WHERE task_id = ? AND id = ?', [change.id, reference])
            if (!artifact) throw new StorageContractError('Plan references missing same-task artifact')
            if (artifact.phase === 'review') reviewId = reference
          }
        }
      }
      for (const run of change.runs) {
        const [definition] = await rows(connection, 'SELECT definition_revision FROM codeflow_test_cases WHERE task_id = ? AND case_id = ?', [change.id, run.caseId])
        if (!definition) throw new StorageContractError('Missing case definition')
        const definitionRevision = revision(definition.definition_revision)
        const [unfinished] = run.continuation ? await rows(connection, "SELECT id, input_fingerprint, definition_revision, started_at, execution_plan_id, review_artifact_id FROM codeflow_case_runs WHERE task_id = ? AND case_id = ? AND executor = ? AND status IN ('running', 'generating') AND finished_at IS NULL ORDER BY run_seq DESC LIMIT 1 FOR UPDATE", [change.id, run.caseId, run.executor]) : []
        const identity = run.continuationFrom ?? { startedAt: run.startedAt, inputFingerprint: run.inputFingerprint }
        if (unfinished && run.status !== 'pending' && unfinished.input_fingerprint === (identity.inputFingerprint ?? null) && revision(unfinished.definition_revision) === definitionRevision && optionalDate(unfinished.started_at) === identity.startedAt && (unfinished.execution_plan_id ?? null) === planId && (unfinished.review_artifact_id ?? null) === reviewId) {
          const result = await query(connection, "UPDATE codeflow_case_runs SET status = ?, started_at = COALESCE(started_at, ?), finished_at = ?, body_version = ?, body = ?, input_fingerprint = ? WHERE task_id = ? AND id = ? AND status IN ('running', 'generating') AND finished_at IS NULL", [run.status, run.startedAt ? new Date(run.startedAt) : null, run.finishedAt ? new Date(run.finishedAt) : null, BODY_VERSION, storedJson(run.body), run.inputFingerprint ?? null, change.id, unfinished.id])
          if (affected(result) !== 1) throw new StorageConflictError('Run completion conflict')
        } else {
          await query(connection, 'INSERT INTO codeflow_case_runs (id, task_id, case_id, run_seq, definition_revision, input_fingerprint, execution_plan_id, review_artifact_id, executor, status, started_at, finished_at, body_version, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [run.id, change.id, run.caseId, runSeq, definitionRevision, run.inputFingerprint ?? null, planId, reviewId, run.executor, run.status, run.startedAt ? new Date(run.startedAt) : null, run.finishedAt ? new Date(run.finishedAt) : null, BODY_VERSION, storedJson(run.body)])
          runSeq = increment(runSeq)
        }
      }
      for (const file of change.files) {
        const fileId = file.id ?? randomUUID()
        const [identity] = await rows(connection, 'SELECT task_id, storage_key FROM codeflow_task_files WHERE id = ? FOR UPDATE', [fileId])
        if (identity && (identity.task_id !== change.id || identity.storage_key !== file.storageKey)) throw new StorageContractError('File ID belongs to another task or storage key')
        const [existing] = await rows(connection, 'SELECT storage_key FROM codeflow_task_files WHERE task_id = ? AND storage_key_hash = ?', [change.id, hash(file.storageKey)])
        if (existing && existing.storage_key !== file.storageKey) throw new StorageContractError('Storage key hash collision')
        await query(connection, 'INSERT INTO codeflow_task_files (id, task_id, kind, storage_key, storage_key_hash, sha256, size_bytes, created_at, body_version, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE kind = VALUES(kind), sha256 = VALUES(sha256), size_bytes = VALUES(size_bytes), metadata = VALUES(metadata)', [fileId, change.id, file.kind, file.storageKey, hash(file.storageKey), file.sha256 ?? null, file.sizeBytes ?? null, new Date(file.createdAt ?? change.header.updatedAt), BODY_VERSION, storedJson(file.metadata)])
      }
      for (const usage of change.usage) {
        const usageId = usage.id ?? randomUUID()
        const [identity] = await rows(connection, 'SELECT task_id, session_id, source_event_id FROM codeflow_model_usage WHERE id = ? FOR UPDATE', [usageId])
        if (identity && (identity.task_id !== change.id || identity.session_id !== usage.sessionId || identity.source_event_id !== usage.sourceEventId)) throw new StorageContractError('Usage ID belongs to another task or source tuple')
        if (usage.artifactId) {
          const [artifact] = await rows(connection, 'SELECT id FROM codeflow_self_test_artifacts WHERE task_id = ? AND id = ?', [change.id, usage.artifactId])
          if (!artifact) throw new StorageContractError('Usage artifact belongs to another task')
        }
        await query(connection, 'INSERT INTO codeflow_model_usage (id, task_id, turn_id, session_id, artifact_id, model, phase, source_event_id, observed_at, body_version, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE id = id', [usageId, change.id, usage.turnId ?? 'session', usage.sessionId, usage.artifactId ?? null, usage.model ?? 'unknown', usage.phase, usage.sourceEventId, new Date(usage.observedAt), BODY_VERSION, storedJson(usage.body)])
      }
      const assignments = ['owner_id = ?', 'status = ?', 'updated_at = ?', 'next_event_seq = ?', 'next_case_ordinal = ?', 'next_run_seq = ?', 'next_snapshot_seq = ?']
      const values: unknown[] = [change.header.ownerId ?? null, change.header.status, new Date(change.header.updatedAt), eventSeq, caseOrdinal, runSeq, snapshotSeq]
      if (change.state !== undefined && !change.create) { assignments.push('state = ?', 'body_version = ?'); values.push(storedJson(change.state, STATE_LIMIT), BODY_VERSION) }
      if (!change.create) assignments.push('row_version = row_version + 1')
      const result = await query(connection, `UPDATE codeflow_tasks SET ${assignments.join(', ')} WHERE id = ? AND row_version = ?`, [...values, change.id, change.create ? 1 : change.expectedVersion])
      if (affected(result) !== 1) throw new StorageConflictError('Task revision conflict')
      await connection.commit()
      return nextVersion
    } catch (error) {
      await connection?.rollback().catch(() => {})
      if (error instanceof StorageContractError || error instanceof StorageConflictError) throw error
      throw new Error('MySQL task transaction failed', { cause: error })
    } finally { connection?.release() }
  }

  async loadTask(id: string): Promise<LoadedTask | undefined> {
    return this.loadDetail(id, false)
  }

  async readTask(id: string): Promise<LoadedTask | undefined> {
    return this.loadDetail(id, true)
  }

  private async loadDetail(id: string, projected: boolean): Promise<LoadedTask | undefined> {
    identifier(id)
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [row] = await rows(connection, 'SELECT * FROM codeflow_tasks WHERE id = ? LOCK IN SHARE MODE', [id])
      if (!row) { await connection.commit(); return undefined }
      const loaded = taskRow(row)
      const flags = (body(row, 'state')._collections ?? {}) as Row
      const eventFilter = projected ? " AND NOT JSON_CONTAINS_PATH(body, 'one', '$.modelChange')" : ''
      const events = await rows(connection, `SELECT * FROM (SELECT * FROM codeflow_task_events WHERE task_id = ?${eventFilter} ORDER BY seq DESC LIMIT 1000) recent ORDER BY seq`, [id])
      loaded.task.entries = events.filter(item => !body(item).modelChange).map(entryRow)
      if (!projected && flags.modelHistory) {
        const changes = await rows(connection, "SELECT body, body_version FROM codeflow_task_events WHERE task_id = ? AND JSON_CONTAINS_PATH(body, 'one', '$.modelChange') ORDER BY seq", [id])
        const history = new Map<number, unknown>()
        for (const item of changes) { const value = body(item); history.set(Number(value.modelIndex), value.modelChange) }
        loaded.task.modelHistory = [...history.entries()].sort(([left], [right]) => left - right).map(([, value]) => value) as CodingTask['modelHistory']
      }
      if (!projected) {
        const requestScopes = await rows(connection, "SELECT scope_hash FROM codeflow_self_test_artifacts WHERE task_id = ? AND phase = 'generation' AND scope LIKE 'generation-request:%' GROUP BY scope_hash ORDER BY MAX(created_at) DESC, scope_hash DESC LIMIT 32", [id])
        const requestHashes = requestScopes.map(item => String(item.scope_hash))
        const requestFilter = requestHashes.length ? `a.scope_hash IN (${requestHashes.map(() => '?').join(', ')})` : 'FALSE'
        const artifacts = await rows(connection, `SELECT a.* FROM codeflow_self_test_artifacts a WHERE a.task_id = ? AND (a.phase <> 'generation' OR a.scope NOT LIKE 'generation-request:%' OR ${requestFilter}) AND (NOT EXISTS (SELECT 1 FROM codeflow_self_test_artifacts newer WHERE newer.task_id = a.task_id AND newer.phase = a.phase AND newer.scope_hash = a.scope_hash AND newer.revision > a.revision) OR (a.status = 'complete' AND NOT EXISTS (SELECT 1 FROM codeflow_self_test_artifacts newer WHERE newer.task_id = a.task_id AND newer.phase = a.phase AND newer.scope_hash = a.scope_hash AND newer.status = 'complete' AND newer.revision > a.revision))) ORDER BY a.created_at, a.id`, [id, ...requestHashes])
        if (flags.selfTestArtifacts !== false && (artifacts.length || flags.selfTestArtifacts)) loaded.task.selfTestArtifacts = artifacts.map(artifactRow)
        for (const field of ['acceptanceHistory', 'acceptanceSelectionHistory'] as const) if (flags[field]) loaded.task[field] = []
      }
      const currentIds = (field: string, ids: unknown, column: string): { sql: string; values: unknown[] } => {
        if (!projected) return { sql: '', values: [] }
        if (flags[field] === false || flags[field] === null) return { sql: ' AND FALSE', values: [] }
        if (!Array.isArray(ids)) return { sql: '', values: [] }
        ids.forEach(identifier)
        return { sql: ids.length ? ` AND ${column} IN (${ids.map(() => '?').join(', ')})` : ' AND FALSE', values: ids }
      }
      const definitionFilter = currentIds('selfTests', flags.caseIds, 'case_id')
      const testFilter = currentIds('selfTests', flags.caseIds, 'r.case_id')
      const browserFilter = currentIds('automationRuns', flags.browserCaseIds, 'r.case_id')
      const runFilter = projected ? ` AND ((r.executor = 'test'${testFilter.sql}) OR (r.executor = 'browser'${browserFilter.sql}))` : ''
      const definitions = await rows(connection, `SELECT * FROM codeflow_test_cases WHERE task_id = ?${definitionFilter.sql} ORDER BY ordinal`, [id, ...definitionFilter.values])
      const runs = await rows(connection, `SELECT r.* FROM codeflow_case_runs r WHERE r.task_id = ?${runFilter} AND NOT EXISTS (SELECT 1 FROM codeflow_case_runs newer WHERE newer.task_id = r.task_id AND newer.case_id = r.case_id AND newer.executor = r.executor AND newer.run_seq > r.run_seq) ORDER BY r.run_seq`, [id, ...testFilter.values, ...browserFilter.values])
      if (flags.selfTests !== false && (definitions.length || flags.selfTests)) {
        const activeIds = Array.isArray(flags.caseIds) ? new Set(flags.caseIds) : undefined
        loaded.task.selfTests = definitions.filter(item => !activeIds || activeIds.has(item.case_id)).map(item => {
          const definition = body(item, 'definition')
          if (hash(json(definition)) !== item.definition_fingerprint) throw new StorageContractError('Case definition fingerprint mismatch')
          const run = runs.find(attempt => attempt.case_id === item.case_id && attempt.executor === 'test' && Number(attempt.definition_revision) === Number(item.definition_revision))
          const value = { id: String(item.case_id), ...definition, status: 'pending', ...(run ? body(run) : {}) }
          const keys = (flags.caseKeys as Record<string, unknown> | undefined)?.[String(item.case_id)]
          if (keys === undefined) return value as SelfTestCase
          if (!Array.isArray(keys) || !keys.every(key => typeof key === 'string') || new Set(keys).size !== keys.length) throw new StorageContractError('Invalid case key order')
          return Object.fromEntries([...keys, ...Object.keys(value).filter(key => !keys.includes(key))].filter(key => Object.hasOwn(value, key)).map(key => [key, value[key as keyof typeof value]])) as unknown as SelfTestCase
        })
      }
      const browserRuns = runs.filter(run => run.executor === 'browser' && (!Array.isArray(flags.browserCaseIds) || flags.browserCaseIds.includes(run.case_id))).map(run => body(run)).sort((left, right) => Number(left.projectionIndex ?? 0) - Number(right.projectionIndex ?? 0)).map(run => { const { projectionIndex: _index, ...value } = run; return value })
      if (flags.automationRuns !== false && (browserRuns.length || flags.automationRuns)) loaded.task.automationRuns = browserRuns as unknown as CodingTask['automationRuns']
      for (const key of projected ? ['selfTests', 'automationRuns'] : ['selfTests', 'selfTestArtifacts', 'automationRuns', 'modelHistory', 'acceptanceHistory', 'acceptanceSelectionHistory']) if (flags[key] === null) Object.assign(loaded.task, { [key]: null })
      validateTask(loaded.task)
      await connection.commit()
      return loaded
    } catch (error) { await connection.rollback().catch(() => {}); throw error }
    finally { connection.release() }
  }

  async queryTasks(ownerId?: number, cursor?: string, limit = 50): Promise<Page<TaskListProjection>> {
    pageLimit(limit)
    if (ownerId !== undefined) positive(ownerId)
    const where: string[] = [], values: unknown[] = []
    if (ownerId !== undefined) { where.push('owner_id = ?'); values.push(ownerId) }
    if (cursor) {
      const decoded = listCursor(cursor)
      where.push('(created_at < ? OR (created_at = ? AND id < ?))'); values.push(new Date(decoded.at), new Date(decoded.at), decoded.id)
    }
    const result = await rows(this.pool, `SELECT id, owner_id, status, created_at, updated_at, row_version, body_version, JSON_OBJECT('repository', JSON_UNQUOTE(JSON_EXTRACT(state, '$.repository')), 'instruction', '', 'prdName', '', 'designNames', JSON_ARRAY()) AS state, JSON_UNQUOTE(JSON_EXTRACT(state, '$.automationUrl')) AS automation_url, COALESCE(JSON_TYPE(JSON_EXTRACT(state, '$.workspace')) = 'STRING' AND JSON_UNQUOTE(JSON_EXTRACT(state, '$.workspace')) <> '', false) AS has_workspace, COALESCE(JSON_TYPE(JSON_EXTRACT(state, '$.selfTestDraft')) = 'STRING' AND JSON_UNQUOTE(JSON_EXTRACT(state, '$.selfTestDraft')) <> '', false) AS has_draft, JSON_EXTRACT(state, '$._collections') AS collections FROM codeflow_tasks${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`, [...values, limit + 1])
    const selected = result.slice(0, limit)
    const ids = selected.map(item => item.id), placeholders = ids.map(() => '?').join(', ')
    const definitions = ids.length ? await rows(this.pool, `SELECT task_id, case_id, definition_revision, JSON_UNQUOTE(JSON_EXTRACT(definition, '$.title')) AS title FROM codeflow_test_cases WHERE task_id IN (${placeholders}) ORDER BY ordinal`, ids) : []
    const executions = ids.length ? await rows(this.pool, `SELECT r.task_id, r.case_id, r.executor, r.status, r.definition_revision, JSON_EXTRACT(r.body, '$.projectionIndex') AS projection_index, JSON_UNQUOTE(JSON_EXTRACT(r.body, '$.runner')) AS runner, JSON_EXTRACT(r.body, '$.executionResult') AS execution_result FROM codeflow_case_runs r WHERE r.task_id IN (${placeholders}) AND NOT EXISTS (SELECT 1 FROM codeflow_case_runs newer WHERE newer.task_id = r.task_id AND newer.case_id = r.case_id AND newer.executor = r.executor AND newer.run_seq > r.run_seq) ORDER BY r.run_seq`, ids) : []
    const items = selected.map(item => {
      const task = taskRow(item).task
      const flags = (decode(item.collections ?? {}) ?? {}) as Row
      const cases = flags.selfTests === false || flags.selfTests === null ? [] : definitions.filter(value => value.task_id === task.id && (!Array.isArray(flags.caseIds) || flags.caseIds.includes(value.case_id)))
      const latest = executions.filter(value => value.task_id === task.id)
      const browser = flags.automationRuns === false || flags.automationRuns === null ? [] : latest.filter(value => value.executor === 'browser' && (!Array.isArray(flags.browserCaseIds) || flags.browserCaseIds.includes(value.case_id))).sort((left, right) => Number(left.projection_index ?? 0) - Number(right.projection_index ?? 0))
      const runs = browser.map(value => {
        const executionResult = decode(value.execution_result ?? null) as AutomationRun['executionResult'] | null
        return {
          caseId: String(value.case_id), status: value.status as AutomationRun['status'],
          title: String(cases.find(test => test.case_id === value.case_id)?.title || '\u81ea\u52a8\u5316\u7528\u4f8b'),
          ...(value.runner == null || value.runner === 'null' ? {} : { runner: value.runner as AutomationRun['runner'] }),
          ...(executionResult == null ? {} : { executionResult }),
        }
      })
      const runnable = !cases.length || Number(item.has_draft) === 1 || cases.some(value => {
        const run = latest.find(attempt => attempt.executor === 'test' && attempt.case_id === value.case_id && Number(attempt.definition_revision) === Number(value.definition_revision))
        const status = String(run?.status ?? 'pending')
        return ['pending', 'invalid', 'failed', 'skipped', 'running'].includes(status) || (['manual', 'passed'].includes(status) && !runs.some(attempt => attempt.caseId === value.case_id))
      })
      return { ...task, ...(item.automation_url == null || item.automation_url === 'null' ? {} : { automationUrl: String(item.automation_url) }), hasWorkspace: Number(item.has_workspace) === 1, caseCount: cases.length, automationCount: runs.length, runnable, runs }
    })
    const last = items.at(-1)
    return { items, ...(result.length > limit && last ? { nextCursor: Buffer.from(json({ at: last.createdAt, id: last.id })).toString('base64url') } : {}) }
  }

  async history(id: string, kind: HistoryKind, cursor?: string, limit = 50): Promise<Page<unknown>> {
    identifier(id); pageLimit(limit)
    const cursorValue = kind === 'artifacts' ? 0 : sequenceCursor(cursor)
    const tables = { events: ['codeflow_task_events', 'seq'], runs: ['codeflow_case_runs', 'run_seq'], snapshots: ['codeflow_acceptance_snapshots', 'seq'], artifacts: ['codeflow_self_test_artifacts', 'id'] } as const
    if (!(kind in tables)) throw new StorageContractError('Invalid history kind')
    if (kind === 'artifacts') {
      let after: { at: string; id: string } | undefined
      if (cursor) after = listCursor(cursor)
      const result = await rows(this.pool, `SELECT * FROM codeflow_self_test_artifacts WHERE task_id = ?${after ? ' AND (created_at > ? OR (created_at = ? AND id > ?))' : ''} ORDER BY created_at, id LIMIT ?`, [id, ...(after ? [new Date(after.at), new Date(after.at), after.id] : []), limit + 1])
      const selected = result.slice(0, limit), last = selected.at(-1)
      return { items: selected.map(artifactRow), ...(result.length > limit && last ? { nextCursor: Buffer.from(json({ at: date(last.created_at), id: last.id })).toString('base64url') } : {}) }
    }
    const [table, sequence] = tables[kind]
    if (kind === 'events') {
      const result = await rows(this.pool, `SELECT * FROM ${table} WHERE task_id = ?${cursor === undefined ? '' : ' AND seq < ?'} ORDER BY seq DESC LIMIT ?`, [id, ...(cursor === undefined ? [] : [cursorValue]), limit + 1])
      const selected = result.slice(0, limit)
      const oldest = selected.at(-1)
      return { items: selected.reverse().map(entryRow), ...(result.length > limit && oldest ? { nextCursor: String(oldest.seq) } : {}) }
    }
    const result = await rows(this.pool, `SELECT * FROM ${table} WHERE task_id = ? AND ${sequence} > ? ORDER BY ${sequence} LIMIT ?`, [id, cursorValue, limit + 1])
    const selected = result.slice(0, limit)
    return { items: selected.map(item => ({ id: item.id, seq: revision(item[sequence]), ...(kind === 'snapshots' ? { kind: item.kind, createdAt: date(item.created_at) } : { caseId: item.case_id, status: item.status, executor: item.executor, startedAt: optionalDate(item.started_at), finishedAt: optionalDate(item.finished_at) }), body: body(item) })), ...(result.length > limit ? { nextCursor: String(selected.at(-1)![sequence]) } : {}) }
  }

  async findArtifact(taskId: string, phase: SelfTestArtifact['phase'], scope: string, inputFingerprint: string): Promise<SelfTestArtifact | undefined> {
    const [row] = await rows(this.pool, "SELECT * FROM codeflow_self_test_artifacts WHERE task_id = ? AND phase = ? AND scope_hash = ? AND input_fingerprint = ? AND status = 'complete' ORDER BY revision DESC LIMIT 1", [taskId, phase, hash(scope), inputFingerprint])
    if (!row) return undefined
    if (row.scope !== scope) throw new StorageContractError('Scope hash collision')
    return artifactRow(row)
  }

  async hasBusyTasks(): Promise<boolean> {
    const [row] = await rows(this.pool, "SELECT id FROM codeflow_tasks WHERE status NOT IN ('SUCCESS', 'FAILED', 'REVIEW', 'ACCEPTED', 'PUBLISH_PENDING') OR JSON_EXTRACT(state, '$.modelInTurn') = true OR JSON_UNQUOTE(JSON_EXTRACT(state, '$.modelTurn.status')) = 'running' LIMIT 1")
    return !!row
  }

  async recoverActive(): Promise<void> {
    const active = await rows(this.pool, "SELECT id FROM codeflow_tasks WHERE status NOT IN ('SUCCESS', 'FAILED', 'REVIEW', 'ACCEPTED', 'PUBLISH_PENDING') OR JSON_EXTRACT(state, '$.modelInTurn') = true OR JSON_UNQUOTE(JSON_EXTRACT(state, '$.modelTurn.status')) = 'running'")
    for (const item of active) {
      const connection = await this.pool.getConnection()
      try {
        await connection.beginTransaction()
        const [row] = await rows(connection, 'SELECT * FROM codeflow_tasks WHERE id = ? FOR UPDATE', [item.id])
        if (!row) { await connection.commit(); continue }
        const { task, version } = taskRow(row)
        increment(version)
        const state = taskState(task)
        state.modelInTurn = false
        const at = new Date().toISOString()
        if (task.modelTurn?.status === 'running') state.modelTurn = { ...task.modelTurn, status: 'interrupted', finishedAt: at, summary: '\u540e\u53f0\u91cd\u65b0\u542f\u52a8\uff0c\u8bf7\u6c42\u5df2\u4e2d\u65ad' }
        let status = task.status
        if (['SELF_TEST', 'TEST_EXECUTION'].includes(status) && task.workspace && task.createdBranch) {
          status = 'REVIEW'; state.selfTestError = '\u670d\u52a1\u91cd\u65b0\u542f\u52a8\uff0c\u81ea\u6d4b\u5df2\u4e2d\u65ad\uff1b\u53ef\u4ee5\u7ee7\u7eed\u6267\u884c\u6216\u4fee\u6b63\u672a\u5b8c\u6210\u7684\u7528\u4f8b\u3002'; delete state.question
        } else if (!['SUCCESS', 'FAILED', 'REVIEW', 'ACCEPTED', 'PUBLISH_PENDING'].includes(status)) {
          status = 'FAILED'; state.error = '\u670d\u52a1\u91cd\u65b0\u542f\u52a8\uff0c\u539f\u7f16\u7801\u4f1a\u8bdd\u5df2\u4e2d\u65ad\u3002\u8bf7\u91cd\u65b0\u521b\u5efa\u4efb\u52a1\u3002'; delete state.question
        }
        const original = body(row, 'state')
        if (original._collections) state._collections = original._collections
        const result = await query(connection, 'UPDATE codeflow_tasks SET status = ?, state = ?, updated_at = ?, row_version = row_version + 1 WHERE id = ? AND row_version = ?', [status, storedJson(state, STATE_LIMIT), new Date(at), item.id, version])
        if (affected(result) !== 1) throw new StorageConflictError('Recovery revision conflict')
        await query(connection, "UPDATE codeflow_self_test_artifacts SET status = 'failed', finished_at = ?, error = ? WHERE task_id = ? AND status = 'running'", [new Date(at), 'Interrupted by restart', item.id])
        const running = await rows(connection, "SELECT id, body, body_version FROM codeflow_case_runs WHERE task_id = ? AND status IN ('running', 'generating') AND finished_at IS NULL FOR UPDATE", [item.id])
        for (const run of running) {
          const interrupted = { ...body(run), status: 'failed', finishedAt: at, output: 'Interrupted by restart' }
          await query(connection, "UPDATE codeflow_case_runs SET status = 'failed', finished_at = ?, body_version = ?, body = ? WHERE task_id = ? AND id = ? AND finished_at IS NULL", [new Date(at), BODY_VERSION, storedJson(interrupted), item.id, run.id])
        }
        await connection.commit()
      } catch (error) { await connection.rollback().catch(() => {}); throw error }
      finally { connection.release() }
    }
  }
}