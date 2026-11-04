import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { TestingRecordKind, TestingRecordMap, TestingRepository } from '../../shared/testing.js'
import type { SqlPool } from '../storage/task-repository.js'

export type { SqlPool } from '../storage/task-repository.js'
export const TESTING_LIST_LIMIT = 200
export class TestingContractError extends Error {}
export class TestingConflictError extends Error {}
export class TestingStorageUnavailableError extends Error {
  readonly statusCode = 503
  constructor() { super('Testing storage unavailable. Manually apply sql/mysql-testing-schema.sql to the configured database and verify permissions; no JSON fallback is performed.') }
}

type Body = TestingRecordMap[TestingRecordKind]
type MutableKind = 'project' | 'execution'
type Entry = { kind: TestingRecordKind; id: string; ownerId: number; version: number; createdAt: string; updatedAt: string; status: string; file?: string }
type Index = { schemaVersion: 1; records: Entry[] }
type Row = Record<string, unknown>
const kinds = ['project', 'package', 'execution'] as const
const planningStatuses = ['draft', 'running', 'needs_input', 'completed', 'failed', 'interrupted', 'cancelled']
const executionStatuses = ['draft', 'preparing', 'ready', 'running', 'passed', 'failed', 'incomplete', 'blocked', 'cancelled', 'interrupted']
const locks = new Map<string, Promise<void>>()

async function exclusive<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(done => { release = done })
  locks.set(key, current)
  await previous
  try { return await action() }
  finally { release(); if (locks.get(key) === current) locks.delete(key) }
}
function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new TestingContractError('Invalid testing record or metadata')
}
function object(value: unknown): asserts value is Row { requireValue(value && typeof value === 'object' && !Array.isArray(value)) }
function text(value: unknown): asserts value is string { requireValue(typeof value === 'string' && value.length > 0) }
function identifier(value: unknown): asserts value is string { text(value); requireValue(value.length <= 191 && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value)) }
function positive(value: unknown): asserts value is number { requireValue(Number.isSafeInteger(value) && Number(value) > 0) }
function timestamp(value: unknown): asserts value is string { text(value); requireValue(Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value) }
function owner(kind: TestingRecordKind, ownerId: number): void { requireValue(kinds.includes(kind)); positive(ownerId) }
function json(value: unknown): string {
  const validate = (item: unknown, ancestors: Set<object>): void => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return
    if (typeof item === 'number') { requireValue(Number.isFinite(item)); return }
    requireValue(typeof item === 'object' && item !== null && Object.getOwnPropertySymbols(item).length === 0)
    if (Array.isArray(item)) {
      requireValue(!ancestors.has(item) && Object.keys(item).length === item.length)
      ancestors.add(item)
      for (const child of item) validate(child, ancestors)
      ancestors.delete(item)
    } else {
      requireValue(Object.getPrototypeOf(item) === Object.prototype && !ancestors.has(item))
      ancestors.add(item)
      for (const child of Object.values(item)) validate(child, ancestors)
      ancestors.delete(item)
    }
  }
  validate(value, new Set())
  const serialized = JSON.stringify(value)
  requireValue(Buffer.byteLength(serialized) <= 16 * 1024 * 1024)
  return serialized
}
function copy<T>(value: T): T { return JSON.parse(json(value)) as T }
function metadata(kind: TestingRecordKind, value: Body, ownerId: number): Entry {
  owner(kind, ownerId); object(value); identifier(value.id); timestamp(value.createdAt)
  if (kind === 'package') {
    const body = value as TestingRecordMap['package']
    requireValue(body.schemaVersion === 1 && !('version' in body) && !('ownerId' in body))
    identifier(body.projectId); positive(body.revision)
    for (const field of [body.sourceFingerprint, body.definitionFingerprint, body.rulesVersion, body.modelId]) text(field)
    requireValue(Array.isArray(body.baseline) && Array.isArray(body.cases)); object(body.assessment)
    json(body)
    return { kind, id: body.id, ownerId, version: 1, createdAt: body.createdAt, updatedAt: body.createdAt, status: 'immutable' }
  }
  const body = value as TestingRecordMap[MutableKind]
  requireValue(body.ownerId === ownerId); positive(body.version); timestamp(body.updatedAt)
  requireValue(body.updatedAt >= body.createdAt && Array.isArray(body.events)); object(body.input)
  requireValue((kind === 'project' ? planningStatuses : executionStatuses).includes(body.status))
  for (const event of body.events) {
    object(event); timestamp(event.at); requireValue(['info', 'warning', 'error'].includes(event.kind)); requireValue(typeof event.text === 'string')
  }
  requireValue(typeof body.input.title === 'string')
  if (kind === 'project') {
    const project = body as TestingRecordMap['project']
    for (const field of [project.input.requirements, project.input.instruction, project.input.modelId]) requireValue(typeof field === 'string')
    requireValue(Array.isArray(project.input.sources) && Array.isArray(project.caseSetIds))
    for (const id of project.caseSetIds) identifier(id)
    const question = (value: unknown) => {
      object(value); identifier(value.id); timestamp(value.createdAt); text(value.text)
      requireValue(value.text.length <= 6000 && Array.isArray(value.choices) && value.choices.length <= 20 && value.choices.every((choice: unknown) => typeof choice === 'string' && !!choice.length && choice.length <= 3000) && typeof value.allowFreeform === 'boolean')
    }
    if (project.question !== undefined) question(project.question)
    if (project.clarifications !== undefined) {
      requireValue(Array.isArray(project.clarifications) && project.clarifications.length <= 20)
      for (const item of project.clarifications) { object(item); question(item.question); text(item.answer); requireValue(item.answer.length <= 3000); timestamp(item.answeredAt) }
    }
    for (const source of project.input.sources) {
      object(source); identifier(source.id); text(source.name); text(source.storageKey)
      requireValue(['requirements', 'design'].includes(source.kind) && /^[a-f0-9]{64}$/.test(source.sha256) && Number.isSafeInteger(source.sizeBytes) && source.sizeBytes >= 0)
    }
  } else {
    const execution = body as TestingRecordMap['execution']
    identifier(execution.input.caseSetId); text(execution.input.repository); text(execution.packageFingerprint)
    object(execution.input.scope)
    requireValue(['default', 'custom'].includes(execution.input.scope.mode) && Array.isArray(execution.input.scope.caseIds) && typeof execution.input.scope.reason === 'string' && Array.isArray(execution.cases))
    for (const id of execution.input.scope.caseIds) identifier(id)
    for (const item of execution.cases) {
      object(item); identifier(item.caseId)
      requireValue(typeof item.selected === 'boolean' && typeof item.blocking === 'boolean' && ['pending', 'passed', 'failed', 'incomplete', 'blocked', 'skipped', 'cancelled'].includes(item.status))
    }
  }
  json(body)
  return { kind, id: body.id, ownerId, version: body.version, createdAt: body.createdAt, updatedAt: body.updatedAt, status: body.status }
}
function checkReplacement(kind: MutableKind, value: Body, expectedVersion: number, ownerId: number): Entry {
  requireValue(kind === 'project' || kind === 'execution'); positive(expectedVersion)
  const entry = metadata(kind, value, ownerId)
  requireValue(Number.isSafeInteger(expectedVersion + 1) && entry.version === expectedVersion + 1)
  return entry
}
function validateEntry(entry: Entry): void {
  object(entry); owner(entry.kind, entry.ownerId); identifier(entry.id); positive(entry.version)
  timestamp(entry.createdAt); timestamp(entry.updatedAt)
  requireValue(entry.updatedAt >= entry.createdAt)
  requireValue(entry.kind === 'package' ? entry.status === 'immutable' && entry.version === 1 && entry.updatedAt === entry.createdAt : (entry.kind === 'project' ? planningStatuses : executionStatuses).includes(entry.status))
}
function verifyBody(entry: Entry, value: Body): void {
  const actual = metadata(entry.kind, value, entry.ownerId)
  for (const key of ['kind', 'id', 'ownerId', 'version', 'createdAt', 'updatedAt', 'status'] as const) requireValue(actual[key] === entry[key])
}
function active(entry: Entry): boolean { return entry.kind === 'project' && entry.status === 'running' || entry.kind === 'execution' && ['preparing', 'running'].includes(entry.status) }
function interrupted(value: TestingRecordMap[MutableKind]): TestingRecordMap[MutableKind] {
  return { ...value, version: value.version + 1, status: 'interrupted', updatedAt: new Date(Math.max(Date.now(), Date.parse(value.updatedAt))).toISOString() }
}
function compare(left: Entry, right: Entry): number { return left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0 }

abstract class IndexedTestingRepository implements TestingRepository {
  protected abstract readonly lockKey: string
  protected abstract index(): Promise<Index>
  protected abstract read(entry: Entry): Promise<Body>
  protected abstract commit(index: Index, entry: Entry, value: Body): Promise<void>

  async list<Kind extends TestingRecordKind>(kind: Kind, ownerId: number): Promise<TestingRecordMap[Kind][]> {
    owner(kind, ownerId)
    return exclusive(this.lockKey, async () => {
      const entries = (await this.index()).records.filter(entry => entry.kind === kind && entry.ownerId === ownerId).sort(compare).slice(0, TESTING_LIST_LIMIT)
      return Promise.all(entries.map(async entry => copy(await this.read(entry)) as TestingRecordMap[Kind]))
    })
  }
  async get<Kind extends TestingRecordKind>(kind: Kind, id: string, ownerId: number): Promise<TestingRecordMap[Kind] | undefined> {
    owner(kind, ownerId); identifier(id)
    return exclusive(this.lockKey, async () => {
      const entry = (await this.index()).records.find(item => item.kind === kind && item.id === id && item.ownerId === ownerId)
      return entry ? copy(await this.read(entry)) as TestingRecordMap[Kind] : undefined
    })
  }
  async create<Kind extends TestingRecordKind>(kind: Kind, value: TestingRecordMap[Kind], ownerId: number): Promise<void> {
    const snapshot = copy(value), entry = metadata(kind, snapshot, ownerId)
    requireValue(entry.version === 1)
    await exclusive(this.lockKey, async () => {
      const index = await this.index()
      if (index.records.some(item => item.kind === kind && item.id === entry.id)) throw new TestingConflictError('Testing record already exists')
      await this.commit(index, entry, snapshot)
    })
  }
  async replace<Kind extends MutableKind>(kind: Kind, value: TestingRecordMap[Kind], expectedVersion: number, ownerId: number): Promise<void> {
    const snapshot = copy(value), entry = checkReplacement(kind, snapshot, expectedVersion, ownerId)
    await exclusive(this.lockKey, async () => {
      const index = await this.index()
      const previous = index.records.find(item => item.kind === kind && item.id === entry.id && item.ownerId === ownerId)
      if (!previous || previous.version !== expectedVersion) throw new TestingConflictError('Testing record revision conflict')
      requireValue(entry.createdAt === previous.createdAt && entry.updatedAt >= previous.updatedAt)
      await this.commit(index, entry, snapshot)
    })
  }
  async recover(): Promise<void> {
    await exclusive(this.lockKey, async () => {
      let index = await this.index()
      for (const entry of index.records.filter(active)) {
        const value = interrupted(await this.read(entry) as TestingRecordMap[MutableKind])
        const next = checkReplacement(entry.kind as MutableKind, value, entry.version, entry.ownerId)
        await this.commit(index, next, value)
        index = await this.index()
      }
    })
  }
}

export class MemoryTestingRepository extends IndexedTestingRepository {
  protected readonly lockKey = randomUUID()
  private state: Index = { schemaVersion: 1, records: [] }
  private readonly bodies = new Map<string, Body>()
  protected async index(): Promise<Index> { return copy(this.state) }
  protected async read(entry: Entry): Promise<Body> {
    const value = this.bodies.get(`${entry.kind}:${entry.id}`)!
    verifyBody(entry, value)
    return copy(value)
  }
  protected async commit(index: Index, entry: Entry, value: Body): Promise<void> {
    this.bodies.set(`${entry.kind}:${entry.id}`, copy(value))
    this.state = { ...index, records: [...index.records.filter(item => item.kind !== entry.kind || item.id !== entry.id), copy(entry)] }
  }
}

export class JsonTestingRepository extends IndexedTestingRepository {
  protected readonly lockKey: string
  private readonly directory: string
  constructor(root: string) { super(); this.directory = resolve(root, 'testing'); this.lockKey = `testing-json:${process.platform === 'win32' ? this.directory.toLowerCase() : this.directory}` }
  async verify(): Promise<void> { await exclusive(this.lockKey, async () => { await this.index() }) }
  protected async index(): Promise<Index> {
    await mkdir(this.directory, { recursive: true })
    let content: string
    try { content = await readFile(join(this.directory, 'manifest.json'), 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      requireValue((await readdir(this.directory)).length === 0)
      const initial: Index = { schemaVersion: 1, records: [] }
      await this.publish(initial)
      return initial
    }
    const index = JSON.parse(content) as Index
    object(index); requireValue(index.schemaVersion === 1 && Array.isArray(index.records))
    const seen = new Set<string>()
    for (const entry of index.records) {
      validateEntry(entry); requireValue(typeof entry.file === 'string' && /^[a-f0-9-]{36}\.json$/.test(entry.file))
      const key = `${entry.kind}:${entry.id}`; requireValue(!seen.has(key)); seen.add(key)
    }
    return index
  }
  protected async read(entry: Entry): Promise<Body> {
    const value = JSON.parse(await readFile(join(this.directory, entry.file!), 'utf8')) as Body
    verifyBody(entry, value)
    return value
  }
  private async publish(index: Index): Promise<void> {
    const temporary = join(this.directory, `${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, JSON.stringify(index), { flag: 'wx' })
      for (let attempt = 0; ; attempt++) {
        try { await rename(temporary, join(this.directory, 'manifest.json')); break }
        catch (error) {
          if (process.platform !== 'win32' || attempt >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
          await delay(10 * (attempt + 1))
        }
      }
    }
    finally { await unlink(temporary).catch(() => {}) }
  }
  protected async commit(index: Index, entry: Entry, value: Body): Promise<void> {
    const file = `${randomUUID()}.json`, path = join(this.directory, file)
    const previous = index.records.find(item => item.kind === entry.kind && item.id === entry.id)
    await writeFile(path, json(value), { flag: 'wx' })
    try { await this.publish({ ...index, records: [...index.records.filter(item => item !== previous), { ...entry, file }] }) }
    catch (error) { await unlink(path).catch(() => {}); throw error }
    if (previous?.file) await unlink(join(this.directory, previous.file)).catch(() => {})
  }
}

async function query(pool: Pick<SqlPool, 'query'>, sql: string, values: unknown[] = []): Promise<unknown> {
  const [result] = await pool.query({ sql, timeout: 15000 }, values)
  return result
}
async function rows(pool: Pick<SqlPool, 'query'>, sql: string, values: unknown[] = []): Promise<Row[]> {
  const result = await query(pool, sql, values); requireValue(Array.isArray(result)); return result as Row[]
}
function fromRow(row: Row): { entry: Entry; value: Body } {
  const entry: Entry = { kind: row.kind as TestingRecordKind, id: String(row.id), ownerId: Number(row.owner_id), version: Number(row.version), createdAt: String(row.created_at), updatedAt: String(row.updated_at), status: String(row.status) }
  validateEntry(entry)
  const value = (typeof row.body === 'string' ? JSON.parse(row.body) : Buffer.isBuffer(row.body) ? JSON.parse(row.body.toString('utf8')) : row.body) as Body
  verifyBody(entry, value)
  return { entry, value: copy(value) }
}

export class MysqlTestingRepository implements TestingRepository {
  constructor(private readonly pool: SqlPool) {}
  async verify(): Promise<void> {
    try {
      const columns = await rows(this.pool, 'SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH, COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', ['codeflow_testing_records'])
      const expected: Record<string, string> = { kind: 'varchar', id: 'varchar', owner_id: 'bigint', version: 'bigint', created_at: 'varchar', updated_at: 'varchar', status: 'varchar', body: 'json' }
      requireValue(columns.length === Object.keys(expected).length)
      for (const column of columns) {
        const name = String(column.COLUMN_NAME)
        requireValue(expected[name] === column.DATA_TYPE && column.IS_NULLABLE === 'NO')
        if (expected[name] === 'bigint') requireValue(/^bigint(?:\(\d+\))? unsigned$/.test(String(column.COLUMN_TYPE)))
        if (expected[name] === 'varchar') requireValue(Number(column.CHARACTER_MAXIMUM_LENGTH) === ({ kind: 16, id: 191, created_at: 24, updated_at: 24, status: 32 } as Record<string, number>)[name] && column.COLLATION_NAME === 'utf8mb4_bin')
      }
      const indexes = await rows(this.pool, 'SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, SUB_PART FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX', ['codeflow_testing_records'])
      const hasIndex = (name: string, fields: string[], unique: boolean): boolean => {
        const parts = indexes.filter(item => item.INDEX_NAME === name)
        return parts.length === fields.length && parts.every((item, index) => item.COLUMN_NAME === fields[index] && item.SUB_PART === null && Number(item.SEQ_IN_INDEX) === index + 1 && Number(item.NON_UNIQUE) === (unique ? 0 : 1))
      }
      requireValue(hasIndex('PRIMARY', ['kind', 'id'], true) && hasIndex('testing_owned_list', ['kind', 'owner_id', 'created_at', 'id'], false) && hasIndex('testing_recovery', ['kind', 'status', 'id'], false))
      const tables = await rows(this.pool, 'SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', ['codeflow_testing_records'])
      requireValue(tables.length === 1 && tables[0].ENGINE === 'InnoDB')
      await rows(this.pool, 'SELECT kind, id, owner_id, version, created_at, updated_at, status, body FROM codeflow_testing_records LIMIT 0')
    } catch { throw new TestingStorageUnavailableError() }
  }
  async list<Kind extends TestingRecordKind>(kind: Kind, ownerId: number): Promise<TestingRecordMap[Kind][]> {
    owner(kind, ownerId)
    const result = await rows(this.pool, 'SELECT * FROM codeflow_testing_records WHERE kind = ? AND owner_id = ? ORDER BY created_at, id LIMIT 200', [kind, ownerId])
    requireValue(result.length <= TESTING_LIST_LIMIT)
    return result.map(row => { const { entry, value } = fromRow(row); requireValue(entry.kind === kind && entry.ownerId === ownerId); return value as TestingRecordMap[Kind] })
  }
  async get<Kind extends TestingRecordKind>(kind: Kind, id: string, ownerId: number): Promise<TestingRecordMap[Kind] | undefined> {
    owner(kind, ownerId); identifier(id)
    const [row] = await rows(this.pool, 'SELECT * FROM codeflow_testing_records WHERE kind = ? AND id = ? AND owner_id = ?', [kind, id, ownerId])
    if (!row) return undefined
    const { entry, value } = fromRow(row); requireValue(entry.kind === kind && entry.id === id && entry.ownerId === ownerId)
    return value as TestingRecordMap[Kind]
  }
  async create<Kind extends TestingRecordKind>(kind: Kind, value: TestingRecordMap[Kind], ownerId: number): Promise<void> {
    const entry = metadata(kind, value, ownerId), body = json(value); requireValue(entry.version === 1)
    try { await query(this.pool, 'INSERT INTO codeflow_testing_records (kind, id, owner_id, version, created_at, updated_at, status, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [kind, entry.id, ownerId, entry.version, entry.createdAt, entry.updatedAt, entry.status, body]) }
    catch (error) { if ((error as { code?: string }).code === 'ER_DUP_ENTRY') throw new TestingConflictError('Testing record already exists'); throw error }
  }
  async replace<Kind extends MutableKind>(kind: Kind, value: TestingRecordMap[Kind], expectedVersion: number, ownerId: number): Promise<void> {
    const entry = checkReplacement(kind, value, expectedVersion, ownerId), body = json(value)
    const result = await query(this.pool, 'UPDATE codeflow_testing_records SET version = ?, updated_at = ?, status = ?, body = ? WHERE kind = ? AND id = ? AND owner_id = ? AND version = ? AND created_at = ? AND updated_at <= ?', [entry.version, entry.updatedAt, entry.status, body, kind, entry.id, ownerId, expectedVersion, entry.createdAt, entry.updatedAt])
    if (Number((result as { affectedRows: number }).affectedRows) !== 1) throw new TestingConflictError('Testing record revision conflict')
  }
  async recover(): Promise<void> {
    for (const kind of ['project', 'execution'] as const) {
      let cursor = ''
      while (true) {
        const batch = await rows(this.pool, "SELECT * FROM codeflow_testing_records WHERE kind = ? AND status IN ('preparing', 'running') AND id > ? ORDER BY id LIMIT 200", [kind, cursor])
        requireValue(batch.length <= TESTING_LIST_LIMIT)
        if (!batch.length) break
        for (const row of batch) {
          const { entry, value } = fromRow(row)
          requireValue(entry.kind === kind && entry.id > cursor && active(entry)); cursor = entry.id
          try { await this.replace(kind, interrupted(value as TestingRecordMap[MutableKind]), entry.version, entry.ownerId) }
          catch (error) { if (!(error instanceof TestingConflictError)) throw error }
        }
      }
    }
  }
}

export async function createTestingRepository(backend: 'mysql' | 'json', root: string, pool?: SqlPool): Promise<TestingRepository> {
  if (backend === 'mysql') {
    if (!pool) throw new TestingStorageUnavailableError()
    const repository = new MysqlTestingRepository(pool)
    await repository.verify()
    return repository
  }
  requireValue(backend === 'json')
  const repository = new JsonTestingRepository(root)
  await repository.verify()
  return repository
}