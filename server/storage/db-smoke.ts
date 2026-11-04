import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPool } from 'mysql2/promise'
import type { CodingTask } from '../../shared/task.js'
import { decode, diffTask, hash, json, StorageConflictError, StorageContractError, type TaskRepository } from './contracts.js'
import { databaseConfig, type DatabaseConfig } from './database-config.js'
import { MysqlTaskPersistence } from './database.js'
import { loadStorageEnvironment } from './storage-runtime.js'
import { MysqlTaskRepository, type SqlConnection, type SqlPool } from './task-repository.js'

export const businessTables = [
  'codeflow_model_usage', 'codeflow_task_files', 'codeflow_case_runs',
  'codeflow_acceptance_snapshots', 'codeflow_test_cases', 'codeflow_self_test_artifacts',
  'codeflow_task_events', 'codeflow_tasks',
] as const
export interface SmokeSession {
  database: TaskRepository & { health(): Promise<void>; close(): Promise<void> }
  pool: SqlPool
}
export type OpenSmokeSession = () => Promise<SmokeSession>
export interface SmokeOptions { execute: boolean; keep: boolean }
export interface SmokeSummary { taskId: string; counts: Record<string, number>; cleaned: boolean }
export class SmokeFailure extends Error {
  constructor(readonly taskId: string, readonly cleaned: boolean, cause: unknown) {
    super('Storage smoke failed', { cause })
  }
}
const timeout = 15000
const unicode = '\u5b58\u50a8\u5192\u70df \u4e2d\u6587 \ud83e\uddea e\u0301'
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/

export function parseSmokeOptions(args: string[]): SmokeOptions {
  if (args.some(arg => !['--execute', '--keep'].includes(arg)) || new Set(args).size !== args.length) {
    throw new Error('Usage: npm run db:smoke -- [--execute [--keep]]')
  }
  const execute = args.includes('--execute'), keep = args.includes('--keep')
  if (keep && !execute) throw new Error('--keep requires --execute')
  return { execute, keep }
}

export function smokeFixture(taskId: string, at = new Date().toISOString()): CodingTask {
  assert.match(taskId, uuidPattern)
  const finishedAt = new Date(Date.parse(at) + 1234).toISOString()
  const fingerprint = hash(`storage-smoke:${taskId}`)
  const artifactId = randomUUID()
  return {
    id: taskId, repository: 'storage-smoke.invalid/no-network',
    instruction: `[storage smoke; synthetic; no execution] ${unicode}\r\n  JSON order preserved\t`,
    prdName: 'synthetic-no-file.md', designNames: [], status: 'REVIEW', createdAt: at, updatedAt: at,
    entries: [
      { text: unicode, detail: 'storage smoke: synthetic metadata only', at, kind: 'info', stage: 'REVIEW' },
      { text: `second ${unicode}`, at: finishedAt, kind: 'info', stage: 'REVIEW' },
    ],
    selfTests: [{
      title: unicode, status: 'running', source: 'synthetic', id: 'TC-SMOKE',
      steps: 'No model, browser, repository or file operations', startedAt: at,
      expected: unicode, evidenceInputFingerprint: fingerprint,
    }],
    selfTestArtifacts: [{
      id: artifactId, revision: 1, schemaVersion: 1, phase: 'review', scope: `storage-smoke:${taskId}:${unicode}`,
      inputFingerprint: fingerprint, inputRefs: [hash(`synthetic-input:${taskId}`)], status: 'complete',
      createdAt: at, finishedAt, model: 'synthetic-no-provider', rulesVersion: 'storage-smoke-1',
      output: { content: unicode, assessment: { status: 'qualified', checkedAt: finishedAt, issues: [], coveredIds: ['REQ-SMOKE'], missingIds: [] } },
    }],
    testExecutionPlan: {
      version: 1, createdAt: at, inputFingerprint: fingerprint, artifactRefs: [artifactId],
      cases: [{ caseId: 'TC-SMOKE', selected: true, gatePolicy: 'blocking', reason: unicode }],
    },
  }
}

export function smokeCreate(task: CodingTask) {
  const change = diffTask(undefined, task, 0)
  change.files.push({
    id: randomUUID(), kind: 'evidence', storageKey: `storage-smoke/${task.id}/synthetic.json`,
    sizeBytes: 0, createdAt: task.createdAt,
    metadata: { zebra: unicode, alpha: { second: 2, first: 1 }, synthetic: true, actualFile: false },
  })
  const artifactId = task.selfTestArtifacts![0].id
  change.usage.push(
    { id: randomUUID(), sessionId: `smoke-${task.id}`, turnId: task.id, artifactId, model: 'synthetic-no-provider', phase: 'review', sourceEventId: 'increment-1', observedAt: task.createdAt, body: { counting: 'incremental', inputTokens: 17, outputTokens: 7, cacheReadTokens: 5, cacheWriteTokens: 3, label: unicode } },
    { id: randomUUID(), sessionId: `smoke-${task.id}`, turnId: task.id, artifactId, model: 'synthetic-no-provider', phase: 'review', sourceEventId: 'increment-2', observedAt: task.createdAt, body: { counting: 'incremental', inputTokens: 11, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1, label: unicode } },
    { id: randomUUID(), sessionId: `smoke-${task.id}`, turnId: task.id, artifactId, model: 'synthetic-no-provider', phase: 'review', sourceEventId: 'platform-reuse', observedAt: task.createdAt, body: { counting: 'reuse', platformOnly: true, providerRequest: false, reusedArtifacts: 1, label: unicode } },
  )
  return change
}

async function rows(connection: Pick<SqlConnection, 'query'>, sql: string, values: unknown[]): Promise<Record<string, unknown>[]> {
  const [result] = await connection.query({ sql, timeout }, values)
  assert.ok(Array.isArray(result))
  return result as Record<string, unknown>[]
}
function taskWhere(table: string): string { return table === 'codeflow_tasks' ? 'id = ?' : 'task_id = ?' }
export async function smokeCounts(pool: SqlPool, taskId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const table of businessTables) {
    const [row] = await rows(pool, `SELECT COUNT(*) AS count FROM ${table} WHERE ${taskWhere(table)}`, [taskId])
    counts[table] = Number(row.count)
  }
  return counts
}

export async function cleanupSmoke(session: SmokeSession, taskId: string): Promise<void> {
  assert.match(taskId, uuidPattern)
  await session.database.health()
  const connection = await session.pool.getConnection()
  try {
    await connection.beginTransaction()
    for (const table of businessTables) {
      await connection.query({ sql: `DELETE FROM ${table} WHERE ${taskWhere(table)}`, timeout }, [taskId])
    }
    await connection.commit()
  } catch (error) {
    try { await connection.rollback() } catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Smoke cleanup rollback failed') }
    throw error
  } finally { connection.release() }
}

export function faultPool(pool: SqlPool, taskId: string, fileId: string, injected: Error) {
  let childInserted = false, triggered = false
  const wrapped: SqlPool = {
    query: pool.query.bind(pool),
    getConnection: async () => {
      const connection = await pool.getConnection()
      return {
        beginTransaction: () => connection.beginTransaction(), commit: () => connection.commit(),
        rollback: () => connection.rollback(), release: () => connection.release(),
        query: async (options, values) => {
          if (options.sql.startsWith('UPDATE codeflow_tasks SET')) {
            assert.ok(childInserted, 'Failure must follow a child INSERT')
            const files = await rows(connection, 'SELECT id FROM codeflow_task_files WHERE task_id = ? AND id = ?', [taskId, fileId])
            assert.equal(files.length, 1, 'Child must exist inside the failed transaction')
            triggered = true
            throw injected
          }
          const result = await connection.query(options, values)
          if (options.sql.startsWith('INSERT INTO codeflow_task_files')) childInserted = true
          return result
        },
      }
    },
  }
  return { pool: wrapped, triggered: () => triggered }
}

function exact(actual: unknown, expected: unknown): void { assert.equal(json(actual), json(expected)) }
async function verifyReadback(session: SmokeSession, expected: CodingTask, version: number, creation: ReturnType<typeof smokeCreate>): Promise<void> {
  await session.database.health()
  const loaded = await session.database.loadTask(expected.id)
  assert.ok(loaded)
  assert.equal(loaded.version, version)
  assert.equal(loaded.task.id, expected.id)
  assert.equal(loaded.task.ownerId, undefined)
  assert.equal(loaded.task.status, 'REVIEW')
  for (const key of ['repository', 'instruction', 'prdName', 'designNames', 'createdAt', 'updatedAt', 'entries', 'selfTests', 'testExecutionPlan'] as const) exact(loaded.task[key], expected[key])
  const actualArtifact = loaded.task.selfTestArtifacts?.[0], artifact = expected.selfTestArtifacts![0]
  assert.ok(actualArtifact)
  assert.equal(loaded.task.selfTestArtifacts!.length, 1)
  assert.deepEqual(actualArtifact, artifact)
  exact(actualArtifact.output, artifact.output)
  exact(actualArtifact.inputRefs, artifact.inputRefs)
  const found = await session.database.findArtifact!(expected.id, 'review', artifact.scope, artifact.inputFingerprint)
  assert.deepEqual(found, actualArtifact)
  const latest = await session.database.history(expected.id, 'events', undefined, 1)
  exact(latest.items, expected.entries.slice(1))
  assert.ok(latest.nextCursor)
  const older = await session.database.history(expected.id, 'events', latest.nextCursor, 1)
  exact(older.items, expected.entries.slice(0, 1))
  assert.equal(older.nextCursor, undefined)
  const artifacts = await session.database.history(expected.id, 'artifacts', undefined, 1)
  assert.deepEqual(artifacts.items, [artifact])
  assert.equal(artifacts.nextCursor, undefined)
  const snapshots = await session.database.history(expected.id, 'snapshots', undefined, 1)
  assert.equal(snapshots.items.length, 1)
  assert.equal(snapshots.nextCursor, undefined)
  const snapshot = snapshots.items[0] as { id: string; kind: string; createdAt: string; body: unknown }
  assert.equal(snapshot.id, creation.snapshots[0].id)
  assert.equal(snapshot.kind, 'execution_plan')
  assert.equal(snapshot.createdAt, expected.createdAt)
  exact(snapshot.body, { value: expected.testExecutionPlan })
  const runs = await session.database.history(expected.id, 'runs', undefined, 1)
  assert.equal(runs.items.length, 1)
  assert.equal(runs.nextCursor, undefined)
  const run = runs.items[0] as { id: string; status: string; startedAt: string; finishedAt: string; body: unknown }
  assert.equal(run.id, creation.runs[0].id)
  assert.equal(run.status, 'passed')
  assert.equal(run.startedAt, expected.selfTests![0].startedAt)
  assert.equal(run.finishedAt, expected.selfTests![0].finishedAt)
  exact(run.body, diffTask(undefined, expected, 0).runs[0].body)
  const cursor = Buffer.from(json({ at: expected.createdAt, id: `${expected.id}~` })).toString('base64url')
  const list = await session.database.queryTasks(undefined, cursor, 1)
  assert.equal(list.items[0]?.id, expected.id)
  assert.equal(list.items[0]?.status, 'REVIEW')
  const files = await rows(session.pool, 'SELECT id, metadata, created_at, size_bytes FROM codeflow_task_files WHERE task_id = ?', [expected.id])
  assert.equal(files.length, 1)
  assert.equal(files[0].id, creation.files[0].id)
  assert.equal(Number(files[0].size_bytes), 0)
  assert.equal((files[0].created_at as Date).toISOString(), expected.createdAt)
  exact(decode(files[0].metadata), creation.files[0].metadata)
  const usage = await rows(session.pool, 'SELECT id, body, observed_at, artifact_id FROM codeflow_model_usage WHERE task_id = ?', [expected.id])
  assert.equal(usage.length, creation.usage.length)
  for (const expectedUsage of creation.usage) {
    const actual = usage.find(item => item.id === expectedUsage.id)
    assert.ok(actual)
    assert.equal(actual.artifact_id, artifact.id)
    assert.equal((actual.observed_at as Date).toISOString(), expectedUsage.observedAt)
    exact(decode(actual.body), expectedUsage.body)
  }
  const bindings = await rows(session.pool, 'SELECT id, execution_plan_id, review_artifact_id FROM codeflow_case_runs WHERE task_id = ?', [expected.id])
  assert.deepEqual(bindings, [{ id: creation.runs[0].id, execution_plan_id: creation.snapshots[0].id, review_artifact_id: artifact.id }])
}

export async function verifySmokeGuards(session: SmokeSession, task: CodingTask, version: number): Promise<void> {
  const stale = structuredClone(task)
  stale.entries.push({ at: task.updatedAt, kind: 'warning', text: 'stale smoke: must not persist' })
  await assert.rejects(session.database.commit(diffTask(task, stale, version - 1)), StorageConflictError)
  let touchedSql = false
  const forbidden = async (): Promise<never> => { touchedSql = true; throw new Error('Invalid state reached SQL or health') }
  const invalid = diffTask(task, task, version)
  invalid.state = { ...invalid.state, repository: 123 }
  await assert.rejects(new MysqlTaskRepository({ query: forbidden, getConnection: forbidden }, forbidden).commit(invalid), StorageContractError)
  assert.equal(touchedSql, false)
  const countersSql = 'SELECT row_version, next_event_seq, next_case_ordinal, next_run_seq, next_snapshot_seq FROM codeflow_tasks WHERE id = ?'
  const before = await session.database.loadTask(task.id)
  const counts = await smokeCounts(session.pool, task.id)
  const counters = await rows(session.pool, countersSql, [task.id])
  const next = structuredClone(task)
  next.instruction = 'rollback smoke: must not persist'
  next.entries.push({ at: task.updatedAt, kind: 'warning', text: 'rollback smoke: must not persist' })
  const change = diffTask(task, next, version), fileId = randomUUID()
  change.files.push({ id: fileId, kind: 'test', storageKey: `storage-smoke/${task.id}/rollback`, metadata: { synthetic: true } })
  const injected = new Error('Injected smoke failure before final task UPDATE')
  const fault = faultPool(session.pool, task.id, fileId, injected)
  const failing = new MysqlTaskRepository(fault.pool, () => session.database.health())
  await assert.rejects(failing.commit(change), error => error instanceof Error && error.cause === injected)
  assert.equal(fault.triggered(), true)
  assert.deepEqual(await session.database.loadTask(task.id), before)
  assert.deepEqual(await smokeCounts(session.pool, task.id), counts)
  assert.deepEqual(await rows(session.pool, countersSql, [task.id]), counters)
  assert.deepEqual(await rows(session.pool, 'SELECT id FROM codeflow_task_files WHERE task_id = ? AND id = ?', [task.id, fileId]), [])
}

export async function runSmoke(open: OpenSmokeSession, keep = false): Promise<SmokeSummary> {
  const taskId = randomUUID(), task = smokeFixture(taskId), creation = smokeCreate(task)
  let session: SmokeSession | undefined, owned = false, cleaned = false
  let failure: unknown, counts: Record<string, number> = {}
  try {
    session = await open()
    await session.database.health()
    let version = await session.database.commit(creation)
    owned = true
    const passed = structuredClone(task)
    passed.updatedAt = new Date(Date.parse(task.createdAt) + 2345).toISOString()
    Object.assign(passed.selfTests![0], { status: 'passed', finishedAt: passed.updatedAt, output: unicode })
    version = await session.database.commit(diffTask(task, passed, version))
    await session.database.close()
    session = undefined
    session = await open()
    await verifyReadback(session, passed, version, creation)
    await verifySmokeGuards(session, passed, version)
    counts = await smokeCounts(session.pool, taskId)
    assert.deepEqual(Object.values(counts), [3, 1, 1, 1, 1, 1, 2, 1])
  } catch (error) { failure = error }
  finally {
    if (owned && !keep) {
      try {
        session ??= await open()
        await cleanupSmoke(session, taskId)
        const remaining = await smokeCounts(session.pool, taskId)
        assert.ok(Object.values(remaining).every(count => count === 0))
        cleaned = true
      } catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], 'Smoke and cleanup failed') }
    }
    try { await session?.database.close() }
    catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], 'Smoke close failed') }
  }
  if (failure !== undefined) throw new SmokeFailure(taskId, cleaned, failure)
  return { taskId, counts, cleaned }
}

export async function openSmokeSession(config: DatabaseConfig): Promise<SmokeSession> {
  let pool: SqlPool | undefined
  const database = await MysqlTaskPersistence.connect(config, options => {
    const created = typeof options === 'string' ? createPool(options) : createPool(options)
    pool = created as unknown as SqlPool
    return created
  })
  assert.ok(pool)
  return { database, pool }
}

export async function smokeCommand(args: string[], dependencies = {
  loadEnvironment: loadStorageEnvironment, config: databaseConfig, open: openSmokeSession,
  output: (message: string) => console.log(message), error: (message: string) => console.error(message),
}): Promise<number> {
  try {
    const options = parseSmokeOptions(args)
    if (!options.execute) {
      dependencies.output('DRY RUN: no environment loaded or DB connection. Plan: UUID REVIEW task; 8 business tables; reconnect/readback; stale-write, rollback and pre-SQL validation checks. No recovery, model, browser, repository or actual file operations. --execute writes and deletes only generated task rows transactionally; --execute --keep retains them. The CodeFlow owner must release its named lock first; this command never bypasses it.')
      return 0
    }
    dependencies.loadEnvironment()
    const config = dependencies.config()
    if (!config) throw new Error('MySQL configuration required')
    const summary = await runSmoke(() => dependencies.open(config), options.keep)
    dependencies.output(JSON.stringify(summary))
    return 0
  } catch (error) {
    dependencies.error(JSON.stringify({ status: 'failed', ...(error instanceof SmokeFailure ? { taskId: error.taskId, cleaned: error.cleaned } : {}) }))
    dependencies.error('Storage smoke failed. Check MySQL configuration/schema and release the existing CodeFlow owner lock before retrying. No lock bypass or task recovery is performed. Default cleanup targets only the generated taskId; --keep disables cleanup. Usage: npm run db:smoke -- [--execute [--keep]]. Raw database errors are not printed.')
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await smokeCommand(process.argv.slice(2))
}