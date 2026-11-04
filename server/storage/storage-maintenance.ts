import { readFile, lstat, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createConnection } from 'mysql2/promise'
import { databaseConfig, type DatabaseConfig } from './database-config.js'
import { hash, identifier, terminalStatuses, validateFile } from './contracts.js'
import type { SqlConnection } from './task-repository.js'

const tables = [
  ['codeflow_tasks', 'state'], ['codeflow_task_events', 'body'],
  ['codeflow_self_test_artifacts', 'output', 'input_refs', 'error', 'scope'],
  ['codeflow_test_cases', 'definition'], ['codeflow_case_runs', 'body'],
  ['codeflow_acceptance_snapshots', 'body'], ['codeflow_task_files', 'metadata'],
  ['codeflow_model_usage', 'body'],
] as const
const deletionOrder = ['codeflow_model_usage', 'codeflow_case_runs', 'codeflow_task_events',
  'codeflow_task_files', 'codeflow_acceptance_snapshots', 'codeflow_self_test_artifacts', 'codeflow_test_cases', 'codeflow_tasks']
const roots = ['uploads', 'evidence', 'sessions', 'workspaces']
type Row = Record<string, unknown>
export type MaintenanceConnection = Pick<SqlConnection, 'query' | 'beginTransaction' | 'commit' | 'rollback'>
export type MaintenanceOptions = { command: 'capacity' | 'files' | 'delete-task'; taskId?: string; execute: boolean; dataDir?: string }

async function query(connection: MaintenanceConnection, sql: string, values: unknown[] = []): Promise<unknown> {
  return (await connection.query({ sql, timeout: 15000 }, values))[0]
}
async function rows(connection: MaintenanceConnection, sql: string, values: unknown[] = []): Promise<Row[]> {
  const result = await query(connection, sql, values)
  if (!Array.isArray(result)) throw new Error('Expected database rows')
  return result as Row[]
}
function integer(value: unknown): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('Unsafe database count or byte size')
  return result
}

export function parseMaintenanceArgs(args: string[]): MaintenanceOptions {
  const [command, ...flags] = args
  if (!['capacity', 'files', 'delete-task'].includes(command)) throw new Error('Use capacity, files, or delete-task')
  const result: MaintenanceOptions = { command: command as MaintenanceOptions['command'], execute: false }
  const seen = new Set<string>()
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index]
    if (seen.has(flag)) throw new Error('Duplicate option')
    seen.add(flag)
    if (flag === '--execute') result.execute = true
    else if (flag === '--taskId' || flag === '--data-dir') {
      const value = flags[++index]
      if (!value || value.startsWith('--')) throw new Error('Missing option value')
      if (flag === '--taskId') { identifier(value); result.taskId = value }
      else result.dataDir = value
    } else throw new Error('Unknown option')
  }
  if (result.command === 'delete-task' && !result.taskId) throw new Error('Explicit --taskId required')
  if (result.execute && result.command !== 'delete-task') throw new Error('--execute is only for delete-task')
  if (result.dataDir && result.command !== 'files') throw new Error('--data-dir is only for files')
  if (result.command === 'files' && (!result.dataDir || result.taskId)) throw new Error('files requires --data-dir and scans all metadata')
  return result
}

export class StorageMaintenance {
  private readonly lockName: string
  constructor(private readonly connection: MaintenanceConnection, database: string) {
    this.lockName = `codeflow:${hash(database).slice(0, 40)}`
  }
  async acquire(): Promise<void> {
    const result = await rows(this.connection, 'SELECT GET_LOCK(?, 0) AS acquired', [this.lockName])
    if (Number(result[0]?.acquired) !== 1) throw new Error('CodeFlow instance lock unavailable; stop all writers first')
    await this.check()
    for (const [table, ...columns] of tables) {
      await rows(this.connection, `SELECT ${table === 'codeflow_tasks' ? 'id, status' : 'task_id'}, ${columns.join(', ')} FROM ${table} LIMIT 0`)
    }
  }
  async release(): Promise<void> { await query(this.connection, 'SELECT RELEASE_LOCK(?)', [this.lockName]) }
  private async check(): Promise<void> {
    const lock = await rows(this.connection, 'SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS owns_lock', [this.lockName])
    if (Number(lock[0]?.owns_lock) !== 1) throw new Error('CodeFlow instance lock lost')
    const versions = await rows(this.connection, 'SELECT version FROM codeflow_schema ORDER BY version')
    if (versions.length !== 1 || Number(versions[0].version) !== 2) throw new Error('Complete schema 2 required')
  }
  async capacity(taskId?: string) {
    if (taskId !== undefined) identifier(taskId)
    await this.check()
    const physical = await rows(this.connection, 'SELECT TABLE_NAME AS table_name, DATA_LENGTH AS data_bytes, INDEX_LENGTH AS index_bytes FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?, ?, ?, ?, ?, ?, ?, ?, ?)', ['codeflow_schema', ...tables.map(([table]) => table)])
    const summaries = []
    const taskBytes = new Map<string, { taskId: string; rows: number; jsonTextBytes: number }>()
    for (const [table, ...columns] of tables) {
      const bytes = columns.map(column => `COALESCE(OCTET_LENGTH(${column}), 0)`).join(' + ')
      const taskColumn = table === 'codeflow_tasks' ? 'id' : 'task_id'
      const where = taskId === undefined ? '' : ` WHERE ${taskColumn} = ?`
      const values = taskId === undefined ? [] : [taskId]
      const totals = await rows(this.connection, `SELECT COUNT(*) AS row_count, COALESCE(SUM(${bytes}), 0) AS json_text_bytes, COALESCE(MAX(${bytes}), 0) AS max_body_bytes FROM ${table}${where}`, values)
      summaries.push({ table, ...totals[0] })
      const grouped = await rows(this.connection, `SELECT ${taskColumn} AS task_id, COUNT(*) AS row_count, COALESCE(SUM(${bytes}), 0) AS json_text_bytes FROM ${table}${where} GROUP BY ${taskColumn}`, values)
      for (const row of grouped) {
        const id = String(row.task_id)
        const previous = taskBytes.get(id) ?? { taskId: id, rows: 0, jsonTextBytes: 0 }
        previous.rows = integer(previous.rows + integer(row.row_count))
        previous.jsonTextBytes = integer(previous.jsonTextBytes + integer(row.json_text_bytes))
        taskBytes.set(id, previous)
      }
    }
    const schema = await rows(this.connection, 'SELECT COUNT(*) AS row_count FROM codeflow_schema')
    return { schemaVersion: 2, readOnly: true, physicalEstimates: physical, schemaRows: schema[0]?.row_count,
      tables: summaries, tasks: [...taskBytes.values()],
      note: 'JSON/text octets only, not total row/disk bytes; InnoDB physical sizes are estimates for the entire table. Offline scan, no cross-table snapshot.' }
  }
  async files(dataDir: string) {
    await this.check()
    const metadata = await rows(this.connection, 'SELECT task_id, storage_key, storage_key_hash, kind FROM codeflow_task_files')
    return auditFiles(dataDir, metadata)
  }
  async deleteTask(taskId: string, execute = false) {
    identifier(taskId)
    await this.check()
    await this.connection.beginTransaction()
    try {
      const tasks = await rows(this.connection, 'SELECT id, status FROM codeflow_tasks WHERE id = ? FOR UPDATE', [taskId])
      if (tasks.length !== 1) throw new Error('Task not found')
      if (!terminalStatuses.includes(String(tasks[0].status))) throw new Error('Active or unknown task status; deletion refused')
      const active = await rows(this.connection, `SELECT id FROM codeflow_tasks WHERE status NOT IN (${terminalStatuses.map(() => '?').join(', ')}) OR JSON_EXTRACT(state, '$.modelInTurn') = true OR JSON_UNQUOTE(JSON_EXTRACT(state, '$.modelTurn.status')) = 'running' LIMIT 1`, [...terminalStatuses])
      if (active.length) throw new Error('Active tasks exist; deletion refused')
      const artifacts = await rows(this.connection, "SELECT id FROM codeflow_self_test_artifacts WHERE task_id = ? AND status = 'running' LIMIT 1", [taskId])
      const runs = await rows(this.connection, "SELECT id FROM codeflow_case_runs WHERE task_id = ? AND (status IN ('running', 'generating') OR started_at IS NOT NULL AND finished_at IS NULL) LIMIT 1", [taskId])
      if (artifacts.length || runs.length) throw new Error('Unfinished execution records; deletion refused')
      const counts: Record<string, number> = {}
      for (const table of deletionOrder) {
        const column = table === 'codeflow_tasks' ? 'id' : 'task_id'
        const result = await rows(this.connection, `SELECT COUNT(*) AS row_count FROM ${table} WHERE ${column} = ?`, [taskId])
        counts[table] = integer(result[0]?.row_count)
      }
      await this.check()
      if (execute) {
        for (const table of deletionOrder) {
          const column = table === 'codeflow_tasks' ? 'id' : 'task_id'
          const result = await query(this.connection, `DELETE FROM ${table} WHERE ${column} = ?`, [taskId]) as { affectedRows?: number }
          if (integer(result.affectedRows) !== counts[table]) throw new Error('Deletion count changed; rollback required')
        }
        await this.check()
        await this.connection.commit()
      } else await this.connection.rollback()
      return { taskId, status: tasks[0].status, executed: execute, counts, filesRetained: true, sdkDataRetained: true }
    } catch (error) { await this.connection.rollback(); throw error }
  }
}

export async function auditFiles(dataDir: string, metadata: Row[], maxEntries = 100000) {
  const base = path.resolve(dataDir)
  if ((await lstat(base)).isSymbolicLink() || path.relative(base, await realpath(base)) !== '') throw new Error('DATA_DIR must be a canonical directory without links')
  if (!(await lstat(base)).isDirectory()) throw new Error('DATA_DIR must be a directory')
  const missing: string[] = [], unsafe: string[] = [], unregisteredCandidates: string[] = []
  const registered = new Set<string>(), directories = new Set<string>()
  let visited = 0
  const budget = () => { if (++visited > maxEntries) throw new Error('File audit entry limit exceeded; no complete report') }
  for (const row of metadata) {
    budget()
    const key = String(row.storage_key)
    try {
      validateFile({ kind: row.kind as 'prd', storageKey: key, metadata: {} })
      if (hash(key) !== row.storage_key_hash || !roots.includes(key.split('/')[0]) || key.split('/').some(part => /[. ]$|[<>"|?*]|^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) throw new Error('Unsafe key')
      let target = base
      let directory = false
      for (const part of key.split('/')) {
        target = path.join(target, part)
        const stat = await lstat(target)
        if (stat.isSymbolicLink()) throw new Error('Linked path')
        directory = stat.isDirectory()
        if (!directory && !stat.isFile()) throw new Error('Special file')
      }
      registered.add(key)
      if (directory) directories.add(key)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing.push(key)
      else unsafe.push(key)
    }
  }
  const covered = (key: string) => registered.has(key) || [...directories].some(directory => key.startsWith(`${directory}/`))
  const walk = async (key: string): Promise<void> => {
    budget()
    const target = path.join(base, ...key.split('/'))
    let stat
    try { stat = await lstat(target) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    if (stat.isSymbolicLink()) { unsafe.push(key); return }
    if (stat.isDirectory()) {
      for (const entry of await readdir(target)) await walk(`${key}/${entry}`)
    } else if (stat.isFile()) { if (!covered(key)) unregisteredCandidates.push(key) }
    else unsafe.push(key)
  }
  for (const root of roots) await walk(root)
  return { readOnly: true, missing, unsafe: [...new Set(unsafe)], unregisteredCandidates, visited,
    note: 'Candidates are not proven orphans: metadata may be incomplete. Directory manifests cover descendants, not content integrity. No hashes checked, files changed, or SDK state opened.' }
}

export async function connectMaintenance(config: DatabaseConfig) {
  const ca = config.caFile ? await readFile(config.caFile, 'utf8') : undefined
  return createConnection({ host: config.host, port: config.port, user: config.user, password: config.password,
    database: config.database, connectTimeout: config.connectTimeout, charset: 'utf8mb4', timezone: 'Z',
    multipleStatements: false, ssl: config.tls ? { rejectUnauthorized: true, ...(ca ? { ca } : {}) } : undefined })
}

async function main() {
  const options = parseMaintenanceArgs(process.argv.slice(2))
  const config = databaseConfig()
  if (!config) throw new Error('TASK_STORAGE=mysql and injected DB_* variables required; no environment files loaded')
  const connection = await connectMaintenance(config)
  const maintenance = new StorageMaintenance(connection, config.database)
  try {
    await maintenance.acquire()
    const result = options.command === 'capacity' ? await maintenance.capacity(options.taskId)
      : options.command === 'files' ? await maintenance.files(options.dataDir!)
        : await maintenance.deleteTask(options.taskId!, options.execute)
    console.log(JSON.stringify(result, null, 2))
  } finally {
    try { await maintenance.release() } finally { await connection.end() }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Storage maintenance failed; check arguments, schema 2, lock, task state, paths and injected connection permissions. No automatic retry.'); process.exitCode = 1 })
}