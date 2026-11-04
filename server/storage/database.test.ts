import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { Pool, PoolOptions, createPool } from 'mysql2/promise'
import type { CodingTask } from '../../shared/task.js'
import { databaseConfig } from './database-config.js'
import { MysqlTaskPersistence } from './database.js'
import { diffTask } from './contracts.js'

type MetadataRow = Record<string, string | number | null>
type Metadata = Record<'TABLES' | 'COLUMNS' | 'STATISTICS' | 'KEY_COLUMN_USAGE' | 'TABLE_CONSTRAINTS', MetadataRow[]>

function installedSchema(): Metadata {
  const metadata: Metadata = { TABLES: [], COLUMNS: [], STATISTICS: [], KEY_COLUMN_USAGE: [], TABLE_CONSTRAINTS: [] }
  const sql = readFileSync(new URL('../../sql/mysql-schema.sql', import.meta.url), 'utf8')
  for (const match of sql.matchAll(/CREATE TABLE (codeflow_\w+) \(([\s\S]*?)\n    \) ENGINE=InnoDB/g)) {
    const table = match[1]
    metadata.TABLES.push({ TABLE_NAME: table, ENGINE: 'InnoDB', TABLE_TYPE: 'BASE TABLE' })
    const addIndex = (name: string, fields: string, unique: boolean) => {
      fields.split(',').map(field => field.trim()).forEach((field, position) => {
        metadata.STATISTICS.push({ TABLE_NAME: table, INDEX_NAME: name, NON_UNIQUE: unique ? 0 : 1, SEQ_IN_INDEX: position + 1, COLUMN_NAME: field, SUB_PART: null, INDEX_TYPE: 'BTREE', IS_VISIBLE: 'YES' })
      })
    }
    for (const line of match[2].split('\n').map(value => value.trim())) {
      const field = /^(\w+) (INT|BIGINT|SMALLINT|VARCHAR\(\d+\)|CHAR\(\d+\)|DATETIME\(3\)|JSON|MEDIUMTEXT)( UNSIGNED)?(.*)/.exec(line)
      if (field) {
        const type = `${field[2]}${field[3] ?? ''}`.toLowerCase()
        const defaultValue = /\bDEFAULT (\S+)/.exec(field[4])?.[1].replace(/,$/, '').toLowerCase() ?? null
        const collation = /COLLATE (\w+)/.exec(field[4])?.[1] ?? (/^(varchar|char|mediumtext)/.test(type) ? 'utf8mb4_unicode_ci' : null)
        metadata.COLUMNS.push({ TABLE_NAME: table, COLUMN_NAME: field[1], COLUMN_TYPE: type, IS_NULLABLE: field[4].includes('NOT NULL') ? 'NO' : 'YES', COLUMN_DEFAULT: defaultValue, COLLATION_NAME: collation, EXTRA: defaultValue?.startsWith('current_timestamp') ? 'DEFAULT_GENERATED' : '' })
        if (line.includes('PRIMARY KEY')) addIndex('PRIMARY', field[1], true)
      }
      const key = /^(PRIMARY KEY|UNIQUE KEY (\w+)|KEY (\w+)) \(([^)]+)\)/.exec(line)
      if (key) addIndex(key[2] ?? key[3] ?? 'PRIMARY', key[4], !key[3])
      const foreignKey = /^CONSTRAINT (\w+) FOREIGN KEY \(([^)]+)\) REFERENCES (\w+) \(([^)]+)\) ON DELETE (\w+) ON UPDATE (\w+)/.exec(line)
      if (foreignKey) {
        const references = foreignKey[4].split(',').map(value => value.trim())
        foreignKey[2].split(',').map(value => value.trim()).forEach((field, position) => {
          metadata.KEY_COLUMN_USAGE.push({ TABLE_NAME: table, CONSTRAINT_NAME: foreignKey[1], COLUMN_NAME: field, ORDINAL_POSITION: position + 1, REFERENCED_TABLE_NAME: foreignKey[3], REFERENCED_COLUMN_NAME: references[position], DELETE_RULE: foreignKey[5], UPDATE_RULE: foreignKey[6], LOCAL_REFERENCE: 1 })
        })
      }
      const check = /^CONSTRAINT (\w+) CHECK/.exec(line)
      if (check) metadata.TABLE_CONSTRAINTS.push({ TABLE_NAME: table, CONSTRAINT_NAME: check[1], ENFORCED: 'YES' })
    }
  }
  assert.equal(metadata.TABLES.length, 9)
  assert.equal(metadata.COLUMNS.length, 92)
  return metadata
}

function fakeDatabase({ acquire = 1, failWrite = false, failHealth = false, failConnection = false, version = 2, serverVersion = '8.0.36', mutateMetadata = (_metadata: Metadata) => {}, failMetadata = false } = {}) {
  const metadata = installedSchema()
  mutateMetadata(metadata)
  let connections = 0
  let options: PoolOptions | undefined
  let commits = 0, rollbacks = 0, ended = false, released = false, destroyed = false
  const statements: { sql: string; values?: unknown[] }[] = []
  const connection = {
    query: async (query: { sql: string }, values?: unknown[]) => {
      statements.push({ sql: query.sql, values })
      if (query.sql === 'SELECT VERSION() AS server_version') return [[{ server_version: serverVersion }]]
      if (query.sql.includes('GET_LOCK')) return [[{ acquired: acquire }]]
      if (query.sql.includes('IS_USED_LOCK')) {
        if (failHealth) throw Object.assign(new Error('private connection details'), { code: 'ECONNRESET' })
        return [[{ owns_lock: 1 }]]
      }
      if (query.sql.includes('SELECT version')) return [[{ version }]]
      const source = /FROM INFORMATION_SCHEMA\.(\w+)/.exec(query.sql)?.[1] as keyof Metadata | undefined
      if (source) {
        if (serverVersion.startsWith('5.7.')) {
          assert.doesNotMatch(query.sql, /INDEX_TYPE, IS_VISIBLE|ENFORCED|TABLE_CONSTRAINTS/)
          if (source === 'STATISTICS') assert.match(query.sql, /'YES' AS IS_VISIBLE/)
        }
        if (failMetadata) throw new Error('schema private diagnostics password=secret')
        assert.equal(values?.length, 9)
        return [metadata[source]]
      }
      if (query.sql.startsWith('INSERT') && failWrite) throw new Error('private database diagnostics')
      return [query.sql.startsWith('SELECT') ? [] : { affectedRows: 1 }]
    },
    beginTransaction: async () => {}, commit: async () => { commits++ }, rollback: async () => { rollbacks++ },
    release: () => { released = true }, destroy: () => { destroyed = true },
  }
  const pool = { getConnection: async () => {
    if (++connections > 1 && failConnection) throw Object.assign(new Error('private pool details'), { code: 'ETIMEDOUT' })
    return connection
  }, query: connection.query, end: async () => { ended = true } }
  const factory = ((input: PoolOptions) => { options = input; return pool as unknown as Pool }) as typeof createPool
  return { factory, statements, state: () => ({ options, commits, rollbacks, ended, released, destroyed }) }
}

const config = databaseConfig({ TASK_STORAGE: 'mysql', DB_HOST: 'db', DB_USER: 'app', DB_PASSWORD: 'private', DB_NAME: 'codeflow_test', DB_TLS: 'true' })!
const now = new Date().toISOString()
const task: CodingTask = { id: 'task', ownerId: 1, repository: 'repo', instruction: '中文', prdName: 'prd.md', designNames: [], status: 'REVIEW', createdAt: now, updatedAt: now, entries: [] }

test('unsupported servers fail before locks, schema metadata or business reads and writes', async () => {
  for (const serverVersion of ['5.7.34', '5.6.51', '8.0.15', '8.0.36-MariaDB', '10.11.0-MariaDB', 'private password=secret']) {
    const fake = fakeDatabase({ serverVersion })
    await assert.rejects(MysqlTaskPersistence.connect(config, fake.factory), (error: Error) => {
      assert.match(error.message, /MySQL server version unsupported:.*MySQL 5\.7\.35\+ or 8\.0\.16\+ required/)
      assert.doesNotMatch(error.message, /private|password|secret/)
      return true
    })
    assert.equal(fake.statements.length, 1)
    assert.equal(fake.state().ended, true)
    assert.equal(fake.state().destroyed, true)
  }
  for (const serverVersion of ['5.7.35-log', '5.7.44', '8.0.16', '8.0.36-commercial', '8.4.0', '9.0.1']) {
    const fake = fakeDatabase({ serverVersion })
    const database = await MysqlTaskPersistence.connect(config, fake.factory)
    await database.close()
  }
})

test('MySQL 5.7 verifies exact structure without querying unavailable CHECK or index visibility metadata', async () => {
  const fake = fakeDatabase({ serverVersion: '5.7.35-log', mutateMetadata: metadata => {
    metadata.TABLE_CONSTRAINTS = []
    for (const row of metadata.COLUMNS) {
      row.COLUMN_TYPE = String(row.COLUMN_TYPE).replace(/^(int|bigint|smallint)\b/, '$1(20)')
      row.EXTRA = ''
    }
  } })
  const database = await MysqlTaskPersistence.connect(config, fake.factory)
  await database.close()
  assert.equal(fake.statements.filter(item => item.sql.includes('FROM INFORMATION_SCHEMA.')).length, 4)
  for (const mutateMetadata of [
    (metadata: Metadata) => { metadata.STATISTICS = metadata.STATISTICS.filter(row => row.INDEX_NAME !== 'uq_runs_attempt') },
    (metadata: Metadata) => { metadata.KEY_COLUMN_USAGE[0].DELETE_RULE = 'CASCADE' },
    (metadata: Metadata) => { metadata.COLUMNS.find(row => row.COLUMN_NAME === 'state')!.COLUMN_TYPE = 'longtext' },
  ]) {
    const broken = fakeDatabase({ serverVersion: '5.7.35-log', mutateMetadata })
    await assert.rejects(MysqlTaskPersistence.connect(config, broken.factory), /schema verification failed/)
  }
})

test('mysql uses verified TLS, SQL-script V2 structure and parameterized normalized transactions', async () => {
  const fake = fakeDatabase()
  const database = await MysqlTaskPersistence.connect(config, fake.factory)
  try {
    await database.commit(diffTask(undefined, task, 0))
    const writes = fake.statements.filter((item) => item.sql.startsWith('INSERT'))
    assert.equal(writes.length, 1)
    assert.equal(writes[0].values?.[0], task.id)
    assert.equal(JSON.parse(String(writes[0].values?.[6])).instruction, '中文')
    assert.equal(fake.statements.filter(item => item.sql.includes('FROM INFORMATION_SCHEMA.')).length, 5)
    assert.equal(fake.statements.some(item => item.sql.includes('payload')), false)
    assert.equal(fake.state().commits, 1)
    assert.equal(fake.state().options?.timezone, 'Z')
    assert.deepEqual(fake.state().options?.ssl, { rejectUnauthorized: true })
    assert.equal(fake.state().options?.multipleStatements, false)
  } finally { await database.close() }
  assert.equal(fake.state().ended, true)
})

test('mysql write failure rolls back and returns sanitized error', async () => {
  const fake = fakeDatabase({ failWrite: true })
  const database = await MysqlTaskPersistence.connect(config, fake.factory)
  try {
    await assert.rejects(database.commit(diffTask(undefined, task, 0)), /MySQL task transaction failed/)
    assert.equal(fake.state().commits, 0)
    assert.equal(fake.state().rollbacks, 1)
    assert.equal(fake.state().released, true)
  } finally { await database.close() }
})

test('mysql rejects a second backend instance and closes initialization connections', async () => {
  const fake = fakeDatabase({ acquire: 0 })
  await assert.rejects(MysqlTaskPersistence.connect(config, fake.factory), /另一个 CodeFlow/)
  assert.equal(fake.state().ended, true)
})

test('health and connection failures report safe errors without starting writes', async () => {
  for (const failure of [{ failHealth: true }, { failConnection: true }]) {
    const fake = fakeDatabase(failure)
    const database = await MysqlTaskPersistence.connect(config, fake.factory)
    try {
      await assert.rejects(database.commit(diffTask(undefined, task, 0)), (error: Error) => {
        assert.ok(error.message.includes('MySQL task transaction failed'))
        assert.ok(!error.message.includes('private'))
        return true
      })
      assert.equal(fake.state().commits, 0)
      assert.equal(fake.statements.some(statement => statement.sql.startsWith('INSERT')), false)
    } finally { await database.close() }
  }
})
test('V1 or incomplete schema is rejected before reading any business history', async () => {
  const fake = fakeDatabase({ version: 1 })
  await assert.rejects(MysqlTaskPersistence.connect(config, fake.factory), /V2/)
  assert.equal(fake.state().ended, true)
  assert.equal(fake.statements.some(item => item.sql.includes('FROM codeflow_tasks')), false)
})

test('startup rejects incomplete or incompatible V2 structures without writes or leaked diagnostics', async (context) => {
  const mutations: Record<string, (metadata: Metadata) => void> = {
    'missing table': metadata => { metadata.TABLES.pop() },
    'wrong engine': metadata => { metadata.TABLES[1].ENGINE = 'MyISAM' },
    'missing engine': metadata => { metadata.TABLES[1].ENGINE = null },
    'view instead of table': metadata => { metadata.TABLES[1].TABLE_TYPE = 'VIEW' },
    'missing unique index': metadata => { metadata.STATISTICS = metadata.STATISTICS.filter(row => row.INDEX_NAME !== 'uq_runs_attempt') },
    'nonunique index': metadata => { metadata.STATISTICS.find(row => row.INDEX_NAME === 'uq_cases_ordinal')!.NON_UNIQUE = 1 },
    'wrong primary columns': metadata => { metadata.STATISTICS.find(row => row.TABLE_NAME === 'codeflow_test_cases' && row.INDEX_NAME === 'PRIMARY')!.COLUMN_NAME = 'ordinal' },
    'reordered index': metadata => { metadata.STATISTICS.find(row => row.INDEX_NAME === 'uq_runs_attempt')!.SEQ_IN_INDEX = 3 },
    'prefix index': metadata => { metadata.STATISTICS.find(row => row.INDEX_NAME === 'uq_usage_source')!.SUB_PART = 8 },
    'invisible index': metadata => { metadata.STATISTICS[0].IS_VISIBLE = 'NO' },
    'missing secondary index': metadata => { metadata.STATISTICS = metadata.STATISTICS.filter(row => row.INDEX_NAME !== 'idx_tasks_owner_created') },
    'missing foreign key': metadata => { metadata.KEY_COLUMN_USAGE = metadata.KEY_COLUMN_USAGE.filter(row => row.CONSTRAINT_NAME !== 'fk_runs_plan') },
    'wrong foreign table': metadata => { metadata.KEY_COLUMN_USAGE[0].REFERENCED_TABLE_NAME = 'private_table' },
    'wrong foreign column': metadata => { metadata.KEY_COLUMN_USAGE[0].REFERENCED_COLUMN_NAME = 'owner_id' },
    'cross database foreign key': metadata => { metadata.KEY_COLUMN_USAGE[0].LOCAL_REFERENCE = 0 },
    'wrong composite foreign key': metadata => { metadata.KEY_COLUMN_USAGE.find(row => row.CONSTRAINT_NAME === 'fk_runs_case')!.COLUMN_NAME = 'case_id' },
    'cascade delete': metadata => { metadata.KEY_COLUMN_USAGE[0].DELETE_RULE = 'CASCADE' },
    'cascade update': metadata => { metadata.KEY_COLUMN_USAGE[0].UPDATE_RULE = 'CASCADE' },
    'missing counter': metadata => { metadata.COLUMNS = metadata.COLUMNS.filter(row => row.COLUMN_NAME !== 'next_run_seq') },
    'missing counter default': metadata => { metadata.COLUMNS.find(row => row.COLUMN_NAME === 'next_event_seq')!.COLUMN_DEFAULT = null },
    'wrong counter default': metadata => { metadata.COLUMNS.find(row => row.COLUMN_NAME === 'row_version')!.COLUMN_DEFAULT = '0' },
    'signed counter': metadata => { metadata.COLUMNS.find(row => row.COLUMN_NAME === 'next_snapshot_seq')!.COLUMN_TYPE = 'bigint' },
    'nullable counter': metadata => { metadata.COLUMNS.find(row => row.COLUMN_NAME === 'next_case_ordinal')!.IS_NULLABLE = 'YES' },
    'wrong schema column type': metadata => { metadata.COLUMNS[0].COLUMN_TYPE = 'varchar(20)' },
    'wrong JSON column type': metadata => { metadata.COLUMNS.find(row => row.COLUMN_NAME === 'state')!.COLUMN_TYPE = 'longtext' },
    'wrong identity collation': metadata => { metadata.COLUMNS.find(row => row.COLUMN_NAME === 'id')!.COLLATION_NAME = 'utf8mb4_unicode_ci' },
    'generated column': metadata => { metadata.COLUMNS.find(row => row.COLUMN_NAME === 'state')!.EXTRA = 'STORED GENERATED' },
    'missing check constraint': metadata => { metadata.TABLE_CONSTRAINTS.pop() },
    'unenforced check constraint': metadata => { metadata.TABLE_CONSTRAINTS[0].ENFORCED = 'NO' },
  }
  for (const [name, mutateMetadata] of Object.entries(mutations)) {
    await context.test(name, async () => {
      const fake = fakeDatabase({ mutateMetadata })
      await assert.rejects(MysqlTaskPersistence.connect(config, fake.factory), (error: Error) => {
        assert.equal(error.message, 'MySQL schema verification failed: complete V2 structure required; review the installation SQL offline')
        assert.equal('cause' in error, false)
        return true
      })
      assert.equal(fake.state().ended, true)
      assert.equal(fake.state().destroyed, true)
      assert.equal(fake.statements.some(statement => /^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/.test(statement.sql)), false)
      assert.equal(fake.statements.some(statement => /FROM codeflow_(?!schema)/.test(statement.sql)), false)
    })
  }
})

test('metadata query failures are sanitized even when driver diagnostics mention schema', async () => {
  const fake = fakeDatabase({ failMetadata: true })
  await assert.rejects(MysqlTaskPersistence.connect(config, fake.factory), (error: Error) => {
    assert.match(error.message, /schema verification failed/)
    assert.doesNotMatch(error.message, /private|password|secret/)
    assert.equal('cause' in error, false)
    return true
  })
  assert.equal(fake.state().ended, true)
  assert.equal(fake.state().destroyed, true)
})

test('integer display widths do not reject otherwise matching MySQL metadata', async () => {
  const fake = fakeDatabase({ mutateMetadata: metadata => {
    for (const row of metadata.COLUMNS) row.COLUMN_TYPE = String(row.COLUMN_TYPE).replace(/^(int|bigint|smallint)\b/, '$1(20)')
  } })
  const database = await MysqlTaskPersistence.connect(config, fake.factory)
  await database.close()
})