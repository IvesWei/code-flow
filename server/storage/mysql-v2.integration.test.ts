import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { createPool, type Pool, type RowDataPacket } from 'mysql2/promise'
import type { CodingTask, TaskEntry } from '../../shared/task.js'
import { decode, diffTask, hash, StorageConflictError, type TaskChange } from './contracts.js'
import { MysqlTaskPersistence } from './database.js'
import type { DatabaseConfig } from './database-config.js'
import { parseSqlScript } from './sql-script.js'
import { MysqlTaskRepository, type SqlPool } from './task-repository.js'

export function integrationConfig(env: NodeJS.ProcessEnv): DatabaseConfig | undefined {
  if (env.CODEFLOW_TEST_DB_ENABLE !== '1') return undefined
  for (const key of ['HOST', 'PORT', 'USER', 'PASSWORD', 'NAME', 'PREFIX']) {
    if (env[`CODEFLOW_TEST_DB_${key}`] === undefined) throw new Error(`Missing CODEFLOW_TEST_DB_${key}`)
  }
  const prefix = env.CODEFLOW_TEST_DB_PREFIX!
  const database = env.CODEFLOW_TEST_DB_NAME!
  if (!/^codeflow_test_[a-z0-9]{12,32}_$/.test(prefix) || !database.startsWith(prefix) || !/^[a-z0-9_]{1,64}$/.test(database) || database.length === prefix.length) {
    throw new Error('Test database must start with CODEFLOW_TEST_DB_PREFIX=codeflow_test_<unique 12-32 lowercase alphanumeric characters>_ and have a suffix')
  }
  const port = Number(env.CODEFLOW_TEST_DB_PORT)
  if (!/^\d+$/.test(env.CODEFLOW_TEST_DB_PORT!) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid CODEFLOW_TEST_DB_PORT')
  if (!env.CODEFLOW_TEST_DB_HOST!.trim() || !env.CODEFLOW_TEST_DB_USER!.trim()) throw new Error('Empty explicit test host/user')
  if (env.CODEFLOW_TEST_DB_TLS !== undefined && !['true', 'false'].includes(env.CODEFLOW_TEST_DB_TLS)) throw new Error('Invalid CODEFLOW_TEST_DB_TLS')
  return { host: env.CODEFLOW_TEST_DB_HOST!, port, user: env.CODEFLOW_TEST_DB_USER!, password: env.CODEFLOW_TEST_DB_PASSWORD!, database, connectionLimit: 4, connectTimeout: 5000, tls: env.CODEFLOW_TEST_DB_TLS === 'true' }
}

test('MySQL integration configuration never falls back to application DB variables', () => {
  assert.equal(integrationConfig({ DB_HOST: 'production', DB_PASSWORD: 'not-used' }), undefined)
  assert.equal(integrationConfig({ CODEFLOW_TEST_DB_NAME: 'production' }), undefined)
  assert.throws(() => integrationConfig({ CODEFLOW_TEST_DB_ENABLE: '1' }), /Missing CODEFLOW_TEST_DB_HOST/)
  const env = { CODEFLOW_TEST_DB_ENABLE: '1', CODEFLOW_TEST_DB_HOST: 'localhost', CODEFLOW_TEST_DB_PORT: '3306', CODEFLOW_TEST_DB_USER: 'test', CODEFLOW_TEST_DB_PASSWORD: '', CODEFLOW_TEST_DB_PREFIX: 'codeflow_test_0123456789ab_', CODEFLOW_TEST_DB_NAME: 'codeflow_test_0123456789ab_v2' }
  assert.equal(integrationConfig(env)?.database, env.CODEFLOW_TEST_DB_NAME)
  assert.throws(() => integrationConfig({ ...env, CODEFLOW_TEST_DB_NAME: 'codeflow' }), /Test database/)
  assert.throws(() => integrationConfig({ ...env, CODEFLOW_TEST_DB_PREFIX: 'codeflow_test_' }), /Test database/)
})

const config = integrationConfig(process.env)
const tableNames = ['codeflow_model_usage', 'codeflow_task_files', 'codeflow_case_runs', 'codeflow_acceptance_snapshots', 'codeflow_test_cases', 'codeflow_self_test_artifacts', 'codeflow_task_events', 'codeflow_tasks', 'codeflow_schema']
const routineNames = ['codeflow_install_v2', 'codeflow_reset_v1_to_v2']
const at = '2026-10-15T12:34:56.789Z'
function fixture(id: string): CodingTask {
  return { id, ownerId: 42, repository: 'repo', instruction: 'integration', prdName: 'prd', designNames: [], status: 'REVIEW', createdAt: at, updatedAt: at, entries: [] }
}
async function records(pool: Pool, sql: string, values: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>({ sql, timeout: 10000 }, values)
  return result
}
async function executeScript(pool: Pool, name: string): Promise<void> {
  const source = await readFile(new URL(`../../sql/${name}`, import.meta.url), 'utf8')
  for (const sql of parseSqlScript(source)) await pool.query({ sql, timeout: 15000 })
}
async function verifyInstalledSchema(pool: Pool, databaseConfig: DatabaseConfig): Promise<void> {
  const persistence = await MysqlTaskPersistence.connect(databaseConfig)
  try { await persistence.health() } finally { await persistence.close() }
  const columns = await records(pool, `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, COLUMN_DEFAULT, COLLATION_NAME, EXTRA
    FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE()`)
  assert.equal(columns.length, 92)
  for (const row of columns) {
    const name = `${row.TABLE_NAME}.${row.COLUMN_NAME}`
    const text = /^(?:varchar|char|mediumtext)\b/i.test(row.COLUMN_TYPE)
    const external = ['tool_call_id', 'session_id', 'source_event_id'].includes(row.COLUMN_NAME)
    const ascii = ['id', 'task_id', 'case_id', 'turn_id', 'execution_plan_id', 'review_artifact_id', 'artifact_id', 'status', 'kind', 'stage', 'phase', 'executor', 'scope_hash', 'input_fingerprint', 'definition_fingerprint', 'storage_key_hash', 'sha256'].includes(row.COLUMN_NAME)
    assert.equal(row.COLLATION_NAME, !text ? null : external ? 'utf8mb4_bin' : ascii ? 'ascii_bin' : 'utf8mb4_unicode_ci', name)
    if (external) assert.equal(row.COLUMN_TYPE, 'varchar(128)', name)
    const timestampDefault = name === 'codeflow_schema.installed_at'
    const counterDefault = row.TABLE_NAME === 'codeflow_tasks' && ['row_version', 'next_event_seq', 'next_case_ordinal', 'next_run_seq', 'next_snapshot_seq'].includes(row.COLUMN_NAME)
    assert.equal(row.COLUMN_DEFAULT == null ? null : String(row.COLUMN_DEFAULT).toLowerCase(), timestampDefault ? 'current_timestamp(3)' : counterDefault ? '1' : null, name)
    assert.equal(String(row.EXTRA).toUpperCase(), timestampDefault ? 'DEFAULT_GENERATED' : '', name)
  }
  const foreignKeys = await records(pool, `SELECT CONSTRAINT_NAME, DELETE_RULE, UPDATE_RULE
    FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE()`)
  assert.equal(foreignKeys.length, 10)
  for (const row of foreignKeys) {
    assert.equal(row.DELETE_RULE, 'RESTRICT', row.CONSTRAINT_NAME)
    assert.equal(row.UPDATE_RULE, 'RESTRICT', row.CONSTRAINT_NAME)
  }
}
async function clearOwnedObjects(pool: Pool): Promise<void> {
  for (const name of routineNames) await pool.query(`DROP PROCEDURE IF EXISTS ${name}`)
  for (const name of tableNames) await pool.query(`DROP TABLE IF EXISTS ${name}`)
}
function mysqlCode(code: string): (error: unknown) => boolean {
  return error => !!error && typeof error === 'object' && 'code' in error && error.code === code
}

function requireMysqlVersion(version: string): void {
  const match = /^(8|9)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version)
  assert.ok(match && !/mariadb/i.test(version), 'Requires real MySQL 8.0.16+, not MariaDB')
  const [, major, minor, patch] = match.map(Number)
  assert.ok(major > 8 || minor > 0 || patch >= 16, 'CHECK enforcement requires MySQL 8.0.16+')
}

test('MySQL version guard accepts vendor suffixes without accepting pre-CHECK or MariaDB versions', () => {
  for (const version of ['8.0.16', '8.0.16-commercial', '8.0.36-28', '8.4.0', '9.0.1']) requireMysqlVersion(version)
  for (const version of ['8.0.15', '8.0.15-commercial', '8.0', '5.7.44', '10.11.0-MariaDB', '8.0.36-MariaDB']) {
    assert.throws(() => requireMysqlVersion(version))
  }
})

test('real MySQL V2 storage integration', { timeout: 120000, skip: config ? false : 'Opt-in only: set CODEFLOW_TEST_DB_ENABLE=1 and explicit CODEFLOW_TEST_DB_HOST/PORT/USER/PASSWORD/NAME/PREFIX for a unique empty isolated database; .env is never loaded' }, async context => {
  assert.ok(config)
  const pool = createPool({ host: config.host, port: config.port, user: config.user, password: config.password, database: config.database, connectionLimit: 4, connectTimeout: config.connectTimeout, timezone: 'Z', charset: 'utf8mb4', multipleStatements: false, ssl: config.tls ? { rejectUnauthorized: true } : undefined })
  const lockName = `codeflow-test:${createHash('sha256').update(config.database).digest('hex').slice(0, 40)}`
  let owned = false
  let guard: Awaited<ReturnType<Pool['getConnection']>> | undefined
  try {
    guard = await pool.getConnection()
    const [locks] = await guard.query<RowDataPacket[]>('SELECT GET_LOCK(?, 0) AS acquired', [lockName])
    assert.equal(Number(locks[0].acquired), 1, 'Another integration runner owns this database')
    const [identity] = await guard.query<RowDataPacket[]>('SELECT DATABASE() AS db, VERSION() AS version, @@SESSION.sql_mode AS mode, @@innodb_page_size AS page_size')
    assert.equal(identity[0].db, config.database)
    requireMysqlVersion(String(identity[0].version))
    assert.match(String(identity[0].mode), /STRICT_TRANS_TABLES|STRICT_ALL_TABLES/)
    assert.ok(Number(identity[0].page_size) >= 16384, 'DDL indexes require a 3072-byte InnoDB key limit')
    const objects = await records(pool, `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()
      UNION ALL SELECT routine_name FROM information_schema.routines WHERE routine_schema = DATABASE()
      UNION ALL SELECT trigger_name FROM information_schema.triggers WHERE trigger_schema = DATABASE()
      UNION ALL SELECT event_name FROM information_schema.events WHERE event_schema = DATABASE()`)
    assert.equal(objects.length, 0, 'Refusing all DDL/cleanup: dedicated database must be entirely empty')
    owned = true

    await context.test('fresh SQL installs through Node and rejects an existing V2 without altering it', async () => {
      await executeScript(pool, 'mysql-schema.sql')
      await verifyInstalledSchema(pool, config)
      assert.deepEqual((await records(pool, 'SELECT version FROM codeflow_schema')).map(row => row.version), [2])
      await assert.rejects(executeScript(pool, 'mysql-schema.sql'), /Fresh V2 install requires/)
      assert.equal((await records(pool, 'SELECT version FROM codeflow_schema'))[0].version, 2)
      await pool.query('DROP PROCEDURE codeflow_install_v2')
    })

    const repository = new MysqlTaskRepository(pool as unknown as SqlPool)
    let current = fixture('task-z'), version = 0
    const externalKey = '\u6d4b'.repeat(128)
    await context.test('commit/load preserves JSON key order, Unicode keys, millisecond dates and large scopes', async () => {
      current.entries = Array.from({ length: 7 }, (_, index) => ({ at, kind: 'info', text: String(index + 1), toolCallId: externalKey }))
      current.selfTests = ['TC-10', 'TC-2'].map(id => ({ id, title: id, source: '', steps: '', expected: '', status: 'pending' }))
      current.acceptanceBaseline = []
      current.selfTestArtifacts = [1, 2, 3].map(revision => ({ id: `review-${revision}`, schemaVersion: 1, revision, phase: 'review', scope: 'x'.repeat(70000), inputFingerprint: hash('input'), inputRefs: [hash('workspace')], status: revision === 1 ? 'failed' : 'complete', createdAt: at, finishedAt: at, model: 'model', rulesVersion: '1', sessionId: externalKey, ...(revision === 1 ? { error: 'e'.repeat(70000) } : { output: { content: 'review' } }) }))
      current.testExecutionPlan = { version: 1, createdAt: at, artifactRefs: ['review-3'], cases: [] }
      const change = diffTask(undefined, current, 0)
      change.files.push({ kind: 'test', storageKey: `tests/${'x'.repeat(506)}`, metadata: { zebra: 1, alpha: { zebra: 2, alpha: 3 } }, sizeBytes: 0 })
      change.usage.push({ sessionId: externalKey, sourceEventId: externalKey, phase: 'review', observedAt: at, body: { counting: 'incremental', zebra: 1, alpha: 2 } })
      version = await repository.commit(change)
      const loaded = await repository.loadTask(current.id)
      assert.equal(loaded?.version, 1)
      assert.equal(loaded.task.createdAt, at)
      assert.equal(loaded.task.updatedAt, at)
      assert.deepEqual(loaded.task.entries, current.entries)
      assert.equal(JSON.stringify(loaded.task.selfTests), JSON.stringify(current.selfTests))
      assert.equal(loaded.task.selfTestArtifacts?.at(-1)?.scope.length, 70000)
      assert.equal(loaded.task.selfTestArtifacts?.at(-1)?.sessionId, externalKey)
      assert.deepEqual(loaded.task.selfTestArtifacts?.at(-1)?.inputRefs, [hash('workspace')])
      assert.deepEqual(loaded.task.selfTestArtifacts?.at(-1)?.output, { content: 'review' })
      assert.equal((await repository.findArtifact!(current.id, 'review', 'x'.repeat(70000), hash('input')))?.revision, 3)
      const files = await records(pool, 'SELECT metadata FROM codeflow_task_files')
      assert.equal(JSON.stringify(decode(files[0].metadata)), JSON.stringify(change.files[0].metadata))
      const usage = await records(pool, 'SELECT body, observed_at FROM codeflow_model_usage')
      assert.deepEqual(decode(usage[0].body), change.usage[0].body)
      assert.equal((usage[0].observed_at as Date).toISOString(), at)
      const stringDates = createPool({ host: config.host, port: config.port, user: config.user, password: config.password, database: config.database, timezone: 'Z', dateStrings: true, ssl: config.tls ? { rejectUnauthorized: true } : undefined })
      try { assert.equal((await new MysqlTaskRepository(stringDates as unknown as SqlPool).loadTask(current.id))?.task.createdAt, at) }
      finally { await stringDates.end() }
    })

    await context.test('reordering and execution continuation retain attempts, bindings and history paging', async () => {
      const reordered = structuredClone(current)
      reordered.selfTests!.reverse()
      version = await repository.commit(diffTask(current, reordered, version)); current = reordered
      assert.deepEqual((await repository.loadTask(current.id))?.task.selfTests?.map(item => item.id), ['TC-2', 'TC-10'])
      for (const status of ['running', 'passed', 'running', 'passed'] as const) {
        const next = structuredClone(current)
        Object.assign(next.selfTests![0], { status, startedAt: status === 'running' && current.selfTests![0].status === 'passed' ? '2026-10-15T13:00:00.123Z' : current.selfTests![0].startedAt ?? at, finishedAt: status === 'passed' ? '2026-10-15T14:00:00.456Z' : undefined })
        version = await repository.commit(diffTask(current, next, version)); current = next
      }
      const runs = await records(pool, 'SELECT run_seq, execution_plan_id, review_artifact_id, started_at, finished_at FROM codeflow_case_runs ORDER BY run_seq')
      assert.equal(runs.length, 2)
      assert.deepEqual(runs.map(row => Number(row.run_seq)), [1, 2])
      assert.ok(runs.every(row => row.execution_plan_id && row.review_artifact_id === 'review-3'))
      assert.equal((runs[1].started_at as Date).toISOString(), '2026-10-15T13:00:00.123Z')
      const first = await repository.history(current.id, 'runs', undefined, 1)
      const second = await repository.history(current.id, 'runs', first.nextCursor, 1)
      assert.equal(first.items.length, 1); assert.equal(second.items.length, 1); assert.equal(second.nextCursor, undefined)
      assert.notDeepEqual(first.items, second.items)
      const artifacts = await repository.history(current.id, 'artifacts', undefined, 2)
      assert.equal(artifacts.items.length, 2)
      assert.equal((artifacts.items[0] as { error: string }).error.length, 70000)
      assert.equal((await repository.history(current.id, 'artifacts', artifacts.nextCursor, 2)).items.length, 1)
      const snapshots = await repository.history(current.id, 'snapshots', undefined, 1)
      assert.equal(snapshots.items.length, 1)
      assert.ok(snapshots.nextCursor)
      const nextSnapshots = await repository.history(current.id, 'snapshots', snapshots.nextCursor, 1)
      assert.equal(nextSnapshots.items.length, 1)
      assert.equal(nextSnapshots.nextCursor, undefined)
      assert.notDeepEqual(snapshots.items, nextSnapshots.items)
    })

    await context.test('event and task keyset paging remain strict across concurrent appends and timestamp ties', async () => {
      const latest = await repository.history(current.id, 'events', undefined, 3)
      assert.deepEqual((latest.items as TaskEntry[]).map(item => item.text), ['5', '6', '7'])
      assert.equal(latest.nextCursor, '5')
      const next = structuredClone(current)
      next.entries.push({ at, kind: 'info', text: '8' })
      version = await repository.commit(diffTask(current, next, version)); current = next
      const older = await repository.history(current.id, 'events', latest.nextCursor, 3)
      assert.deepEqual((older.items as TaskEntry[]).map(item => item.text), ['2', '3', '4'])
      const oldest = await repository.history(current.id, 'events', older.nextCursor, 3)
      assert.deepEqual((oldest.items as TaskEntry[]).map(item => item.text), ['1'])
      assert.equal(oldest.nextCursor, undefined)
      for (const id of ['task-a', 'task-m']) await repository.commit(diffTask(undefined, fixture(id), 0))
      const first = await repository.queryTasks(42, undefined, 2)
      assert.deepEqual(first.items.map(item => item.id), ['task-z', 'task-m'])
      const second = await repository.queryTasks(42, first.nextCursor, 2)
      assert.deepEqual(second.items.map(item => item.id), ['task-a'])
      assert.equal(second.nextCursor, undefined)
      assert.deepEqual((await repository.queryTasks(43)).items, [])
    })

    await context.test('CHECK, unique, key-length, JSON-shape and same-task foreign-key constraints reject invalid SQL', async () => {
      const maximumId = fixture('x'.repeat(64))
      await repository.commit(diffTask(undefined, maximumId, 0))
      assert.equal((await repository.loadTask(maximumId.id))?.task.id, maximumId.id)
      for (const sql of [
        'UPDATE codeflow_tasks SET next_event_seq = 0 WHERE id = ?',
        'UPDATE codeflow_tasks SET body_version = 0 WHERE id = ?',
        "UPDATE codeflow_tasks SET state = JSON_ARRAY() WHERE id = ?",
        "UPDATE codeflow_tasks SET state = JSON_SET(state, '$.entries', JSON_ARRAY()) WHERE id = ?",
        "UPDATE codeflow_tasks SET state = JSON_SET(state, '$.status', 'REVIEW') WHERE id = ?",
      ]) await assert.rejects(pool.query(sql, [current.id]), mysqlCode('ER_CHECK_CONSTRAINT_VIOLATED'))
      await assert.rejects(pool.query("UPDATE codeflow_self_test_artifacts SET input_refs = JSON_OBJECT() WHERE id = 'review-1'"), mysqlCode('ER_CHECK_CONSTRAINT_VIOLATED'))
      await assert.rejects(pool.query("UPDATE codeflow_self_test_artifacts SET status = 'invalid' WHERE id = 'review-1'"), mysqlCode('ER_CHECK_CONSTRAINT_VIOLATED'))
      await assert.rejects(pool.query("UPDATE codeflow_task_files SET kind = 'invalid'"), mysqlCode('ER_CHECK_CONSTRAINT_VIOLATED'))
      await assert.rejects(pool.query("UPDATE codeflow_acceptance_snapshots SET kind = 'invalid'"), mysqlCode('ER_CHECK_CONSTRAINT_VIOLATED'))
      await assert.rejects(pool.query("UPDATE codeflow_test_cases SET ordinal = 1 WHERE task_id = ?", [current.id]), mysqlCode('ER_DUP_ENTRY'))
      await assert.rejects(pool.query('UPDATE codeflow_tasks SET id = ? WHERE id = ?', ['x'.repeat(65), 'task-a']), mysqlCode('ER_DATA_TOO_LONG'))
      for (const [table, column] of [
        ['codeflow_task_events', 'tool_call_id'],
        ['codeflow_self_test_artifacts', 'session_id'],
        ['codeflow_model_usage', 'session_id'],
        ['codeflow_model_usage', 'source_event_id'],
      ]) await assert.rejects(pool.query(`UPDATE ${table} SET ${column} = ?`, ['\u6d4b'.repeat(129)]), mysqlCode('ER_DATA_TOO_LONG'))
      await assert.rejects(pool.query('UPDATE codeflow_case_runs SET task_id = ?', ['task-a']), mysqlCode('ER_NO_REFERENCED_ROW_2'))
      await assert.rejects(pool.query('DELETE FROM codeflow_tasks WHERE id = ?', [current.id]), mysqlCode('ER_ROW_IS_REFERENCED_2'))
    })

    await context.test('late SQL failure rolls back children, state, version and counters; optimistic concurrency admits one writer', async () => {
      const before = await repository.loadTask(current.id)
      const counters = await records(pool, 'SELECT row_version, next_event_seq, next_case_ordinal, next_run_seq, next_snapshot_seq FROM codeflow_tasks WHERE id = ?', [current.id])
      const next = structuredClone(current)
      next.entries.push({ at, kind: 'warning', text: 'must roll back' })
      next.instruction = 'must roll back'
      const change = diffTask(current, next, version)
      change.files.push({ id: 'file-one', kind: 'test', storageKey: 'test/rollback-one', metadata: {} }, { id: 'file-two', kind: 'test', storageKey: 'test/rollback-two', metadata: {} })
      let reachedFinalUpdate = false
      const failingPool: SqlPool = { query: pool.query.bind(pool) as SqlPool['query'], getConnection: async () => {
        const connection = await pool.getConnection()
        return { beginTransaction: () => connection.beginTransaction(), commit: () => connection.commit(), rollback: () => connection.rollback(), release: () => connection.release(), query: async (options, values) => {
          if (options.sql.startsWith('UPDATE codeflow_tasks SET')) {
            const [files] = await connection.query<RowDataPacket[]>("SELECT id FROM codeflow_task_files WHERE storage_key LIKE 'test/rollback%' ORDER BY id")
            assert.deepEqual(files.map(row => row.id), ['file-one', 'file-two'])
            reachedFinalUpdate = true
            throw new Error('Injected final-update failure after actual child SQL')
          }
          return connection.query(options, values) as ReturnType<SqlPool['query']>
        } }
      } }
      await assert.rejects(new MysqlTaskRepository(failingPool).commit(change), /transaction failed/)
      assert.equal(reachedFinalUpdate, true, 'Must fail at the final update, not an earlier child statement')
      assert.deepEqual(await repository.loadTask(current.id), before)
      assert.deepEqual(await records(pool, 'SELECT row_version, next_event_seq, next_case_ordinal, next_run_seq, next_snapshot_seq FROM codeflow_tasks WHERE id = ?', [current.id]), counters)
      assert.equal((await records(pool, "SELECT id FROM codeflow_task_files WHERE storage_key LIKE 'test/rollback%'")).length, 0)
      const changes: TaskChange[] = ['writer-one', 'writer-two'].map(text => {
        const task = structuredClone(current); task.entries.push({ at, kind: 'info', text })
        return diffTask(current, task, version)
      })
      const results = await Promise.allSettled(changes.map(item => repository.commit(item)))
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
      const failure = results.find(result => result.status === 'rejected') as PromiseRejectedResult
      assert.ok(failure.reason instanceof StorageConflictError)
      const loaded = await repository.loadTask(current.id)
      assert.equal(loaded?.version, version + 1)
      assert.equal(loaded.task.entries.length, current.entries.length + 1)
      version = loaded.version; current = loaded.task
    })

    await context.test('row locks time out a competing writer and retained application locks release on close', async () => {
      const holder = await pool.getConnection(), contender = await pool.getConnection()
      try {
        await holder.beginTransaction()
        await holder.query('SELECT id FROM codeflow_tasks WHERE id = ? FOR UPDATE', [current.id])
        await contender.query('SET SESSION innodb_lock_wait_timeout = 1')
        await assert.rejects(contender.query('UPDATE codeflow_tasks SET row_version = row_version + 1 WHERE id = ?', [current.id]), mysqlCode('ER_LOCK_WAIT_TIMEOUT'))
      } finally { await holder.rollback(); holder.release(); contender.release() }
      const persistence = await MysqlTaskPersistence.connect(config)
      try {
        await persistence.health()
        await assert.rejects(MysqlTaskPersistence.connect(config), /CodeFlow/)
      } finally { await persistence.close() }
      const reopened = await MysqlTaskPersistence.connect(config)
      try { await reopened.health() } finally { await reopened.close() }
    })

    await context.test('reset SQL refuses nonempty V1, then upgrades an empty V1 using the Node parser', async () => {
      await clearOwnedObjects(pool)
      await pool.query('CREATE TABLE codeflow_schema (version INT NOT NULL PRIMARY KEY, installed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)) ENGINE=InnoDB')
      await pool.query('INSERT INTO codeflow_schema (version) VALUES (1)')
      await pool.query('CREATE TABLE codeflow_tasks (id VARCHAR(64) PRIMARY KEY, owner_id BIGINT UNSIGNED NULL, status VARCHAR(32) NOT NULL, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, payload JSON NOT NULL) ENGINE=InnoDB')
      await pool.query("INSERT INTO codeflow_tasks VALUES ('v1-sentinel', NULL, 'REVIEW', ?, ?, JSON_OBJECT())", [new Date(at), new Date(at)])
      await assert.rejects(executeScript(pool, 'mysql-reset-v1-to-v2.sql'), /Nonempty V1 tasks/)
      assert.equal((await records(pool, 'SELECT id FROM codeflow_tasks'))[0].id, 'v1-sentinel')
      assert.equal((await records(pool, 'SELECT version FROM codeflow_schema'))[0].version, 1)
      await pool.query('DROP PROCEDURE codeflow_reset_v1_to_v2')
      await pool.query("DELETE FROM codeflow_tasks WHERE id = 'v1-sentinel'")
      await executeScript(pool, 'mysql-reset-v1-to-v2.sql')
      await verifyInstalledSchema(pool, config)
      assert.equal((await records(pool, 'SELECT version FROM codeflow_schema'))[0].version, 2)
      const task = fixture('reset-roundtrip')
      await repository.commit(diffTask(undefined, task, 0))
      assert.deepEqual((await repository.loadTask(task.id))?.task, task)
    })
  } finally {
    try { if (owned) await clearOwnedObjects(pool) }
    finally {
      try { if (guard) await guard.query('SELECT RELEASE_LOCK(?)', [lockName]) }
      finally { guard?.release(); await pool.end() }
    }
  }
})