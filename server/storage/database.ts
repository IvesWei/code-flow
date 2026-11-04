import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createPool, type Pool, type PoolConnection, type RowDataPacket } from 'mysql2/promise'
import type { DatabaseConfig } from './database-config.js'
import { MysqlTaskRepository, type SqlPool } from './task-repository.js'

const queryTimeout = 15000

type ColumnShape = { type: string; nullable?: boolean; default?: string; collation?: string }
type ForeignKeyShape = { columns: string[]; table: string; references: string[] }
type TableShape = {
  columns: Record<string, ColumnShape>
  indexes: Record<string, { columns: string[]; unique: boolean }>
  foreignKeys?: Record<string, ForeignKeyShape>
  checks?: string[]
}

const column = (type: string, nullable = false): ColumnShape => ({ type, nullable })
const ascii = (type = 'varchar(64)', nullable = false): ColumnShape => ({ type, nullable, collation: 'ascii_bin' })
const binaryText = (type: string, nullable = false): ColumnShape => ({ type, nullable, collation: 'utf8mb4_bin' })
const counter: ColumnShape = { type: 'bigint unsigned', default: '1' }
const bigint = (nullable = false) => column('bigint unsigned', nullable)
const datetime = (nullable = false) => column('datetime(3)', nullable)
const bodyVersion = column('smallint unsigned')
const index = (columns: string[], unique = false) => ({ columns, unique })
const taskForeignKey: ForeignKeyShape = { columns: ['task_id'], table: 'codeflow_tasks', references: ['id'] }

const schema: Record<string, TableShape> = {
  codeflow_schema: {
    columns: { version: column('int'), installed_at: { type: 'datetime(3)', default: 'current_timestamp(3)' } },
    indexes: { PRIMARY: index(['version'], true) },
  },
  codeflow_tasks: {
    columns: {
      id: ascii(), owner_id: bigint(true), status: ascii('varchar(32)'), created_at: datetime(), updated_at: datetime(),
      row_version: counter, body_version: bodyVersion, state: column('json'), next_event_seq: counter,
      next_case_ordinal: counter, next_run_seq: counter, next_snapshot_seq: counter,
    },
    indexes: {
      PRIMARY: index(['id'], true), idx_tasks_owner_created: index(['owner_id', 'created_at', 'id']),
      idx_tasks_status_updated: index(['status', 'updated_at', 'id']),
    },
    checks: ['chk_tasks_versions', 'chk_tasks_sequences', 'chk_tasks_state', 'chk_tasks_state_collections', 'chk_tasks_state_columns'],
  },
  codeflow_task_events: {
    columns: {
      task_id: ascii(), seq: bigint(), created_at: datetime(), kind: ascii('varchar(24)'), stage: ascii('varchar(32)', true),
      turn_id: ascii('varchar(64)', true), tool_call_id: binaryText('varchar(128)', true), body_version: bodyVersion, body: column('json'),
    },
    indexes: { PRIMARY: index(['task_id', 'seq'], true), idx_events_turn: index(['task_id', 'turn_id', 'seq']), idx_events_created: index(['task_id', 'created_at', 'seq']) },
    foreignKeys: { fk_events_task: taskForeignKey }, checks: ['chk_events_versions', 'chk_events_body'],
  },
  codeflow_self_test_artifacts: {
    columns: {
      id: ascii(), task_id: ascii(), phase: ascii('varchar(16)'), scope: column('mediumtext'), scope_hash: ascii('char(64)'),
      revision: bigint(), status: ascii('varchar(16)'), input_fingerprint: ascii('char(64)'), rules_version: column('varchar(64)'),
      model: column('varchar(128)'), session_id: binaryText('varchar(128)', true), created_at: datetime(), finished_at: datetime(true),
      body_version: bodyVersion, output: column('json', true), error: column('mediumtext', true), input_refs: column('json'),
    },
    indexes: {
      PRIMARY: index(['id'], true), uq_artifacts_task_id: index(['task_id', 'id'], true),
      uq_artifacts_revision: index(['task_id', 'phase', 'scope_hash', 'revision'], true),
      idx_artifacts_reuse: index(['task_id', 'phase', 'scope_hash', 'input_fingerprint', 'status', 'revision']),
    },
    foreignKeys: { fk_artifacts_task: taskForeignKey }, checks: ['chk_artifacts_versions', 'chk_artifacts_status', 'chk_artifacts_refs'],
  },
  codeflow_test_cases: {
    columns: {
      task_id: ascii(), case_id: ascii(), ordinal: bigint(), definition_revision: bigint(), definition_fingerprint: ascii('char(64)'),
      body_version: bodyVersion, definition: column('json'), created_at: datetime(), updated_at: datetime(),
    },
    indexes: { PRIMARY: index(['task_id', 'case_id'], true), uq_cases_ordinal: index(['task_id', 'ordinal'], true) },
    foreignKeys: { fk_cases_task: taskForeignKey }, checks: ['chk_cases_versions', 'chk_cases_definition'],
  },
  codeflow_acceptance_snapshots: {
    columns: {
      id: ascii(), task_id: ascii(), seq: bigint(), kind: ascii('varchar(32)'), created_at: datetime(),
      input_fingerprint: ascii('char(64)', true), body_version: bodyVersion, body: column('json'),
    },
    indexes: {
      PRIMARY: index(['id'], true), uq_snapshots_task_id: index(['task_id', 'id'], true), uq_snapshots_seq: index(['task_id', 'seq'], true),
      idx_snapshots_kind: index(['task_id', 'kind', 'seq']),
    },
    foreignKeys: { fk_snapshots_task: taskForeignKey }, checks: ['chk_snapshots_versions', 'chk_snapshots_kind', 'chk_snapshots_body'],
  },
  codeflow_case_runs: {
    columns: {
      id: ascii(), task_id: ascii(), case_id: ascii(), run_seq: bigint(), definition_revision: bigint(), input_fingerprint: ascii('char(64)', true),
      execution_plan_id: ascii('varchar(64)', true), review_artifact_id: ascii('varchar(64)', true), executor: ascii('varchar(24)'),
      status: ascii('varchar(24)'), started_at: datetime(true), finished_at: datetime(true), body_version: bodyVersion, body: column('json'),
    },
    indexes: {
      PRIMARY: index(['id'], true), uq_runs_attempt: index(['task_id', 'case_id', 'run_seq'], true),
      idx_runs_status: index(['task_id', 'status', 'run_seq']), idx_runs_plan: index(['task_id', 'execution_plan_id']),
      idx_runs_review: index(['task_id', 'review_artifact_id']),
    },
    foreignKeys: {
      fk_runs_case: { columns: ['task_id', 'case_id'], table: 'codeflow_test_cases', references: ['task_id', 'case_id'] },
      fk_runs_plan: { columns: ['task_id', 'execution_plan_id'], table: 'codeflow_acceptance_snapshots', references: ['task_id', 'id'] },
      fk_runs_review: { columns: ['task_id', 'review_artifact_id'], table: 'codeflow_self_test_artifacts', references: ['task_id', 'id'] },
    },
    checks: ['chk_runs_versions', 'chk_runs_body'],
  },
  codeflow_task_files: {
    columns: {
      id: ascii(), task_id: ascii(), kind: ascii('varchar(24)'), storage_key: column('varchar(512)'), storage_key_hash: ascii('char(64)'),
      sha256: ascii('char(64)', true), size_bytes: bigint(true), created_at: datetime(), body_version: bodyVersion, metadata: column('json'),
    },
    indexes: { PRIMARY: index(['id'], true), uq_files_storage_key: index(['task_id', 'storage_key_hash'], true) },
    foreignKeys: { fk_files_task: taskForeignKey }, checks: ['chk_files_version', 'chk_files_kind', 'chk_files_metadata'],
  },
  codeflow_model_usage: {
    columns: {
      id: ascii(), task_id: ascii(), turn_id: ascii(), session_id: binaryText('varchar(128)'), artifact_id: ascii('varchar(64)', true),
      model: column('varchar(128)'), phase: ascii('varchar(24)'), source_event_id: binaryText('varchar(128)'), observed_at: datetime(),
      body_version: bodyVersion, body: column('json'),
    },
    indexes: {
      PRIMARY: index(['id'], true), uq_usage_source: index(['task_id', 'session_id', 'source_event_id'], true),
      idx_usage_turn: index(['task_id', 'turn_id']), idx_usage_model_time: index(['model', 'observed_at']), idx_usage_artifact: index(['task_id', 'artifact_id']),
    },
    foreignKeys: {
      fk_usage_task: taskForeignKey,
      fk_usage_artifact: { columns: ['task_id', 'artifact_id'], table: 'codeflow_self_test_artifacts', references: ['task_id', 'id'] },
    },
    checks: ['chk_usage_version', 'chk_usage_body'],
  },
}

class SchemaError extends Error {
  constructor() { super('MySQL schema verification failed: complete V2 structure required; review the installation SQL offline') }
}

async function verifySchema(connection: PoolConnection, legacy57: boolean): Promise<void> {
  try {
    const tables = Object.keys(schema)
    const placeholders = tables.map(() => '?').join(', ')
    const metadata = async (sql: string) => {
      const [rows] = await connection.query<RowDataPacket[]>({ sql, timeout: queryTimeout }, tables)
      return rows
    }
    const tableRows = await metadata(`SELECT TABLE_NAME, ENGINE, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${placeholders})`)
    const columnRows = await metadata(`SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLLATION_NAME, EXTRA FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${placeholders})`)
    const indexRows = await metadata(`SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, SUB_PART, INDEX_TYPE, ${legacy57 ? "'YES' AS IS_VISIBLE" : 'IS_VISIBLE'} FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${placeholders})`)
    const foreignKeyRows = await metadata(`SELECT k.TABLE_NAME, k.CONSTRAINT_NAME, k.COLUMN_NAME, k.ORDINAL_POSITION, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.DELETE_RULE, r.UPDATE_RULE, (k.REFERENCED_TABLE_SCHEMA = DATABASE()) AS LOCAL_REFERENCE FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE k JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.TABLE_NAME = k.TABLE_NAME AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME WHERE k.TABLE_SCHEMA = DATABASE() AND k.TABLE_NAME IN (${placeholders})`)
    const checkRows = legacy57 ? [] : await metadata(`SELECT TABLE_NAME, CONSTRAINT_NAME, ENFORCED FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS WHERE CONSTRAINT_TYPE = 'CHECK' AND TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${placeholders})`)
    const requireShape = (valid: boolean) => { if (!valid) throw new SchemaError() }
    for (const [tableName, expected] of Object.entries(schema)) {
      const table = tableRows.filter(row => row.TABLE_NAME === tableName)
      requireShape(table.length === 1 && table[0].ENGINE?.toLowerCase() === 'innodb' && table[0].TABLE_TYPE === 'BASE TABLE')
      const actualColumns = columnRows.filter(row => row.TABLE_NAME === tableName)
      requireShape(actualColumns.length === Object.keys(expected.columns).length)
      for (const [name, shape] of Object.entries(expected.columns)) {
        const actual = actualColumns.find(row => row.COLUMN_NAME === name)
        const expectedCollation = shape.collation ?? (/^(?:varchar|char|mediumtext)/.test(shape.type) ? 'utf8mb4_unicode_ci' : null)
        requireShape(Boolean(actual && String(actual.COLUMN_TYPE).toLowerCase().replace(/\b(int|bigint|smallint)\(\d+\)/g, '$1') === shape.type
          && actual.IS_NULLABLE === (shape.nullable ? 'YES' : 'NO')
          && (actual.COLUMN_DEFAULT == null ? null : String(actual.COLUMN_DEFAULT).toLowerCase()) === (shape.default ?? null)
          && actual.COLLATION_NAME === expectedCollation
          && ['', 'DEFAULT_GENERATED'].includes(String(actual.EXTRA).toUpperCase())))
      }
      for (const [name, shape] of Object.entries(expected.indexes)) {
        const actual = indexRows.filter(row => row.TABLE_NAME === tableName && row.INDEX_NAME === name).sort((left, right) => Number(left.SEQ_IN_INDEX) - Number(right.SEQ_IN_INDEX))
        requireShape(actual.length === shape.columns.length && actual.every((row, position) => row.COLUMN_NAME === shape.columns[position]
          && Number(row.SEQ_IN_INDEX) === position + 1 && Number(row.NON_UNIQUE) === (shape.unique ? 0 : 1)
          && row.SUB_PART == null && row.INDEX_TYPE === 'BTREE' && row.IS_VISIBLE === 'YES'))
      }
      for (const [name, shape] of Object.entries(expected.foreignKeys ?? {})) {
        const actual = foreignKeyRows.filter(row => row.TABLE_NAME === tableName && row.CONSTRAINT_NAME === name).sort((left, right) => Number(left.ORDINAL_POSITION) - Number(right.ORDINAL_POSITION))
        requireShape(actual.length === shape.columns.length && actual.every((row, position) => row.COLUMN_NAME === shape.columns[position]
          && Number(row.ORDINAL_POSITION) === position + 1 && row.REFERENCED_TABLE_NAME === shape.table
          && row.REFERENCED_COLUMN_NAME === shape.references[position] && Number(row.LOCAL_REFERENCE) === 1
          && row.DELETE_RULE === 'RESTRICT' && row.UPDATE_RULE === 'RESTRICT'))
      }
      for (const name of legacy57 ? [] : expected.checks ?? []) {
        requireShape(checkRows.some(row => row.TABLE_NAME === tableName && row.CONSTRAINT_NAME === name && row.ENFORCED === 'YES'))
      }
    }
  } catch {
    throw new SchemaError()
  }
}

export class MysqlTaskPersistence extends MysqlTaskRepository {
  private closed = false

  private constructor(private readonly databasePool: Pool, private readonly lockConnection: PoolConnection, private readonly lockName: string) {
    super(databasePool as unknown as SqlPool, async () => this.health())
  }

  static async connect(config: DatabaseConfig, poolFactory: typeof createPool = createPool): Promise<MysqlTaskPersistence> {
    const ca = config.caFile ? await readFile(config.caFile, 'utf8') : undefined
    const pool = poolFactory({
      host: config.host, port: config.port, user: config.user, password: config.password, database: config.database,
      connectionLimit: config.connectionLimit, connectTimeout: config.connectTimeout,
      waitForConnections: true, queueLimit: 100, enableKeepAlive: true, keepAliveInitialDelay: 0,
      charset: 'utf8mb4', timezone: 'Z', multipleStatements: false,
      ssl: config.tls ? { rejectUnauthorized: true, ...(ca ? { ca } : {}) } : undefined,
    })
    let connection: PoolConnection | undefined
    try {
      connection = await pool.getConnection()
      const [serverVersions] = await connection.query<RowDataPacket[]>({ sql: 'SELECT VERSION() AS server_version', timeout: queryTimeout })
      const serverVersion = String(serverVersions[0]?.server_version ?? '')
      const versionParts = /^(5|8|9)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(serverVersion)
      const legacy57 = Boolean(versionParts && Number(versionParts[1]) === 5 && Number(versionParts[2]) === 7 && Number(versionParts[3]) >= 35)
      if (!versionParts || /mariadb/i.test(serverVersion) || (Number(versionParts[1]) === 5 && !legacy57) || (Number(versionParts[1]) === 8 && Number(versionParts[2]) === 0 && Number(versionParts[3]) < 16)) {
        const reportedVersion = /^\d+\.\d+\.\d+/.exec(serverVersion)?.[0] ?? 'unknown'
        throw new Error(`MySQL server version unsupported: ${reportedVersion}; MySQL 5.7.35+ or 8.0.16+ required; MariaDB is not supported`)
      }
      const lockName = `codeflow:${createHash('sha256').update(config.database).digest('hex').slice(0, 40)}`
      const [locks] = await connection.query<RowDataPacket[]>({ sql: 'SELECT GET_LOCK(?, 0) AS acquired', timeout: queryTimeout }, [lockName])
      if (Number(locks[0]?.acquired) !== 1) throw new Error('测试数据库已被另一个 CodeFlow 后台占用，请先停止旧实例')
      let versions: RowDataPacket[]
      try {
        ;[versions] = await connection.query<RowDataPacket[]>({ sql: 'SELECT version FROM codeflow_schema ORDER BY version DESC LIMIT 1', timeout: queryTimeout })
      } catch { throw new SchemaError() }
      if (Number(versions[0]?.version) !== 2) throw new Error('数据库 schema 版本不支持，需要完整 V2 结构')
      await verifySchema(connection, legacy57)
      return new MysqlTaskPersistence(pool, connection, lockName)
    } catch (error) {
      connection?.destroy()
      await pool.end()
      if (error instanceof SchemaError || (error instanceof Error && /^(MySQL server version unsupported:|数据库 schema 版本不支持|测试数据库已被另一个 CodeFlow 后台占用)/.test(error.message))) throw error
      throw new Error('MySQL 初始化失败：请检查连接配置、TLS、权限及建表 SQL', { cause: error })
    }
  }

  async health(): Promise<void> {
    if (this.closed) throw new Error('数据库连接已关闭')
    const [rows] = await this.lockConnection.query<RowDataPacket[]>({ sql: 'SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS owns_lock', timeout: queryTimeout }, [this.lockName])
    if (Number(rows[0]?.owns_lock) !== 1) throw new Error('数据库单实例锁已丢失')
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try { await this.lockConnection.query({ sql: 'SELECT RELEASE_LOCK(?)', timeout: queryTimeout }, [this.lockName]) }
    catch {}
    finally { this.lockConnection.destroy(); await this.databasePool.end() }
  }
}