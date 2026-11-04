import assert from 'node:assert/strict'
import filesystem, { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { CasePackage, ExecutionRun, PlanningProject, TestingRepository } from '../../shared/testing.js'
import { createTestingRepository, JsonTestingRepository, MemoryTestingRepository, MysqlTestingRepository, TestingConflictError, TestingContractError, TestingStorageUnavailableError, type SqlPool } from './repository.js'

const at = '2026-10-20T00:00:00.000Z'
function project(id = 'project-1', ownerId = 1): PlanningProject {
  return { id, ownerId, version: 1, createdAt: at, updatedAt: at, status: 'draft', input: { title: 'Plan', requirements: 'Requirements', instruction: '', modelId: 'model', sources: [] }, events: [], caseSetIds: [] }
}
function execution(id = 'execution-1', status: ExecutionRun['status'] = 'preparing'): ExecutionRun {
  return { id, ownerId: 1, version: 1, createdAt: at, updatedAt: at, status, input: { title: 'Run', caseSetId: 'package-1', repository: 'repository', scope: { mode: 'default', caseIds: [], reason: '' } }, packageFingerprint: 'fingerprint', cases: [], events: [] }
}
function casePackage(): CasePackage {
  return { schemaVersion: 1, id: 'package-1', projectId: 'project-1', revision: 1, createdAt: at, sourceFingerprint: 'source', definitionFingerprint: 'definition', rulesVersion: 'rules', modelId: 'model', baseline: [], cases: [], assessment: { status: 'qualified', issues: [] } as unknown as CasePackage['assessment'] }
}

for (const backend of ['memory', 'json'] as const) {
  async function setup(context: { after(action: () => Promise<void>): void }): Promise<{ repository: TestingRepository; root: string }> {
    const root = await mkdtemp(join(tmpdir(), 'testing-repository-'))
    context.after(() => rm(root, { recursive: true, force: true }))
    return { root, repository: backend === 'memory' ? new MemoryTestingRepository() : await createTestingRepository('json', root) }
  }
  test(`${backend}: copy isolation, ownership, identity and immutable packages`, async context => {
    const { repository } = await setup(context)
    const original = project()
    await repository.create('project', original, 1)
    original.input.title = 'changed'
    const loaded = (await repository.get('project', original.id, 1))!
    assert.equal(loaded.input.title, 'Plan')
    loaded.events.push({ at, kind: 'info', text: 'local' })
    assert.deepEqual((await repository.get('project', original.id, 1))!.events, [])
    const listed = await repository.list('project', 1)
    listed[0].input.title = 'list changed'
    assert.equal((await repository.get('project', original.id, 1))!.input.title, 'Plan')
    assert.equal(await repository.get('project', original.id, 2), undefined)
    assert.deepEqual(await repository.list('project', 2), [])
    await assert.rejects(repository.create('project', project('wrong', 2), 1), TestingContractError)
    await assert.rejects(repository.create('project', project(), 1), TestingConflictError)
    await assert.rejects(repository.replace('project', { ...project(), version: 2, ownerId: 2 }, 1, 2), TestingConflictError)
    const pack = casePackage()
    await repository.create('package', pack, 1)
    pack.cases.push({ id: 'local' } as CasePackage['cases'][number])
    assert.deepEqual((await repository.get('package', pack.id, 1))!.cases, [])
    assert.equal(await repository.get('package', pack.id, 2), undefined)
    await assert.rejects(repository.create('package', casePackage(), 2), TestingConflictError)
    await assert.rejects(repository.replace('package' as 'project', { ...casePackage(), version: 2 } as unknown as PlanningProject, 1, 1), TestingContractError)
    await repository.create('execution', { ...execution('project-1'), status: 'draft' }, 1)
    assert.equal((await repository.get('execution', 'project-1', 1))!.status, 'draft')
  })
  test(`${backend}: pending clarification survives recovery and rejects malformed questions`, async context => {
    const { repository } = await setup(context)
    const waiting: PlanningProject = { ...project(), status: 'needs_input', question: { id: 'question-1', createdAt: at, text: 'Clear password?', choices: ['Clear', 'Keep'], allowFreeform: false } }
    await repository.create('project', waiting, 1)
    await repository.recover()
    assert.deepEqual(await repository.get('project', waiting.id, 1), waiting)
    await assert.rejects(repository.create('project', { ...waiting, id: 'bad-question', question: { ...waiting.question!, choices: [3 as unknown as string] } }, 1), TestingContractError)
    await assert.rejects(repository.create('project', { ...waiting, id: 'bad-history', clarifications: [{ question: waiting.question!, answer: '', answeredAt: at }] }, 1), TestingContractError)
  })
  test(`${backend}: CAS requires exact next version and serializes racing writes`, async context => {
    const { repository, root } = await setup(context)
    await repository.create('project', project(), 1)
    await assert.rejects(repository.replace('project', project(), 1, 1), TestingContractError)
    await assert.rejects(repository.replace('project', { ...project(), version: 3 }, 1, 1), TestingContractError)
    const second = backend === 'json' ? new JsonTestingRepository(root) : repository
    const attempts = await Promise.allSettled([repository.replace('project', { ...project(), version: 2, status: 'running' }, 1, 1), second.replace('project', { ...project(), version: 2, status: 'failed' }, 1, 1)])
    assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1)
    assert.ok((attempts.find(result => result.status === 'rejected') as PromiseRejectedResult).reason instanceof TestingConflictError)
    assert.equal((await repository.get('project', 'project-1', 1))!.version, 2)
    await assert.rejects(repository.replace('project', { ...project(), version: 3, createdAt: '2026-10-19T00:00:00.000Z' }, 2, 1))
  })
  test(`${backend}: bounded ordered lists are owner-scoped, not a full-history API`, async context => {
    const { repository } = await setup(context)
    for (let index = 204; index >= 0; index--) await repository.create('project', project(`item-${String(index).padStart(3, '0')}`), 1)
    await repository.create('project', project('foreign', 2), 2)
    await repository.create('project', { ...project('zzz-earlier'), createdAt: '2026-10-19T00:00:00.000Z' }, 1)
    const result = await repository.list('project', 1)
    assert.equal(result.length, 200)
    assert.equal(result[0].id, 'zzz-earlier'); assert.equal(result[1].id, 'item-000'); assert.equal(result[199].id, 'item-198')
    assert.equal((await repository.list('project', 2)).length, 1)
    assert.ok(await repository.get('project', 'item-204', 1))
  })
  test(`${backend}: recovery interrupts only active work, preserves bodies, and is idempotent`, async context => {
    const { repository, root } = await setup(context)
    const running = { ...project(), status: 'running' as const, error: 'preserve', events: [{ at, kind: 'warning' as const, text: 'checkpoint' }] }
    await repository.create('project', running, 1)
    await repository.create('project', project('other', 2), 2)
    await repository.create('package', casePackage(), 1)
    for (const status of ['preparing', 'running', 'ready', 'passed', 'blocked', 'interrupted'] as const) await repository.create('execution', execution(status, status), 1)
    const reopened = backend === 'json' ? await createTestingRepository('json', root) : repository
    assert.equal((await reopened.get('project', 'project-1', 1))!.status, 'running')
    await reopened.recover()
    const restored = (await reopened.get('project', 'project-1', 1))!
    assert.deepEqual(restored, { ...running, status: 'interrupted', version: 2, updatedAt: restored.updatedAt })
    for (const status of ['preparing', 'running', 'ready', 'passed', 'blocked', 'interrupted'] as const) {
      const value = (await reopened.get('execution', status, 1))!
      assert.equal(value.status, ['preparing', 'running'].includes(status) ? 'interrupted' : status)
      assert.equal(value.version, ['preparing', 'running'].includes(status) ? 2 : 1)
    }
    const before = await reopened.list('execution', 1)
    await reopened.recover()
    assert.deepEqual(await reopened.list('execution', 1), before)
    assert.deepEqual(await reopened.get('project', 'project-1', 1), restored)
    assert.deepEqual(await reopened.get('package', 'package-1', 1), casePackage())
  })
  test(`${backend}: malformed identity, runtime fields and lossy JSON are rejected`, async context => {
    const { repository } = await setup(context)
    for (const invalid of [{ ...project(), id: '../escape' }, { ...project(), version: 0 }, { ...project(), createdAt: 'invalid' }, { ...project(), status: 'passed' }, { ...project(), events: [{}] }, { ...project(), input: null }, { ...project(), extra: Infinity }, { ...project(), extra: undefined }]) {
      await assert.rejects(repository.create('project', invalid as PlanningProject, 1), TestingContractError)
    }
    await assert.rejects(repository.create('execution', { ...execution(), cases: [{ caseId: 'TC-1', selected: true, blocking: true, status: 'unknown' }] } as unknown as ExecutionRun, 1), TestingContractError)
    await assert.rejects(repository.get('project', 'id', 0), TestingContractError)
  })
}

test('json: failed manifest replacement leaves committed body intact and queue usable', async context => {
  const root = await mkdtemp(join(tmpdir(), 'testing-repository-failure-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const repository = await createTestingRepository('json', root)
  await repository.create('project', project(), 1)
  const manifest = join(root, 'testing', 'manifest.json'), before = await readFile(manifest, 'utf8')
  const failure = context.mock.method(filesystem, 'rename', async () => { throw Object.assign(new Error('Injected rename failure'), { code: 'EIO' }) })
  syncBuiltinESMExports()
  try { await assert.rejects(repository.replace('project', { ...project(), version: 2 }, 1, 1), /Injected rename failure/) }
  finally { failure.mock.restore(); syncBuiltinESMExports() }
  assert.equal(await readFile(manifest, 'utf8'), before)
  assert.equal((await readdir(join(root, 'testing'))).length, 2)
  assert.deepEqual(await repository.get('project', 'project-1', 1), project())
  await repository.replace('project', { ...project(), version: 2 }, 1, 1)
  assert.equal((await new JsonTestingRepository(root).get('project', 'project-1', 1))!.version, 2)
  assert.equal((await readdir(join(root, 'testing'))).filter(file => file.endsWith('.tmp')).length, 0)
})

test('json: corrupt manifests and bodies fail explicitly without resetting or fallback', async context => {
  const root = await mkdtemp(join(tmpdir(), 'testing-repository-corruption-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const repository = await createTestingRepository('json', root)
  await repository.create('project', project(), 1)
  const manifest = join(root, 'testing', 'manifest.json'), content = await readFile(manifest, 'utf8')
  const entry = JSON.parse(content).records[0]
  await writeFile(join(root, 'testing', entry.file), JSON.stringify({ ...project(), ownerId: 2 }))
  await assert.rejects(repository.get('project', 'project-1', 1), TestingContractError)
  await writeFile(manifest, '{broken')
  await assert.rejects(createTestingRepository('json', root))
  assert.equal(await readFile(manifest, 'utf8'), '{broken')
  await rm(manifest)
  await assert.rejects(createTestingRepository('json', root), TestingContractError)
  assert.equal((await readdir(join(root, 'testing'))).length, 1)
})

test('json: Windows transient rename contention retries atomically, permanent contention fails', { skip: process.platform !== 'win32' }, async context => {
  const root = await mkdtemp(join(tmpdir(), 'testing-repository-contention-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const repository = await createTestingRepository('json', root)
  await repository.create('project', project(), 1)
  const originalRename = filesystem.rename
  let attempts = 0, permanent = false
  const contention = context.mock.method(filesystem, 'rename', async (...args: Parameters<typeof originalRename>) => {
    attempts++
    if (permanent || attempts <= 2) throw Object.assign(new Error('Injected contention'), { code: 'EPERM' })
    return originalRename(...args)
  })
  syncBuiltinESMExports()
  try {
    await repository.replace('project', { ...project(), version: 2 }, 1, 1)
    assert.ok(attempts >= 3)
    permanent = true; attempts = 0
    await assert.rejects(repository.replace('project', { ...project(), version: 3 }, 2, 1), /Injected contention/)
    assert.equal(attempts, 5)
    assert.equal((await repository.get('project', 'project-1', 1))!.version, 2)
  } finally { contention.mock.restore(); syncBuiltinESMExports() }
})

function sqlPool(handler: (sql: string, values: unknown[]) => unknown | Promise<unknown>): SqlPool {
  return { query: async (options, values = []) => [await handler(options.sql, values)], getConnection: async () => { throw new Error('Unexpected connection') } }
}
function row(value: PlanningProject | ExecutionRun): Record<string, unknown> {
  return { kind: 'input' in value && 'caseSetId' in value.input ? 'execution' : 'project', id: value.id, owner_id: value.ownerId, version: value.version, created_at: value.createdAt, updated_at: value.updatedAt, status: value.status, body: JSON.stringify(value) }
}

test('mysql: bounded owned reads, parameterized CAS and duplicate conflict without transactions or legacy SQL', async () => {
  const calls: { sql: string; values: unknown[] }[] = []
  let affectedRows = 1
  const repository = new MysqlTestingRepository(sqlPool((sql, values) => {
    calls.push({ sql, values })
    assert.match(sql, /codeflow_testing_records/)
    if (sql.startsWith('SELECT')) return values.includes(2) ? [] : [row(project())]
    if (sql.startsWith('INSERT')) throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' })
    return { affectedRows }
  }))
  assert.deepEqual(await repository.list('project', 1), [project()])
  assert.match(calls[0].sql, /owner_id = \? ORDER BY created_at, id LIMIT 200$/)
  assert.equal(await repository.get('project', 'project-1', 2), undefined)
  await repository.replace('project', { ...project(), version: 2 }, 1, 1)
  assert.match(calls.at(-1)!.sql, /owner_id = \? AND version = \?/)
  assert.deepEqual(calls.at(-1)!.values.slice(4, 8), ['project', 'project-1', 1, 1])
  affectedRows = 0
  await assert.rejects(repository.replace('project', { ...project(), version: 2 }, 1, 1), TestingConflictError)
  await assert.rejects(repository.create('project', project(), 1), TestingConflictError)
  const count = calls.length
  await assert.rejects(repository.replace('project', project(), 1, 1), TestingContractError)
  assert.equal(calls.length, count)
})

test('mysql: recovery reads active batches only, uses CAS, and never replays', async () => {
  const activeProject = { ...project(), status: 'running' as const }
  const calls: string[] = [], updates: Record<string, unknown>[] = []
  const repository = new MysqlTestingRepository(sqlPool((sql, values) => {
    calls.push(sql)
    if (sql.startsWith('SELECT')) {
      assert.match(sql, /status IN \('preparing', 'running'\) AND id > \? ORDER BY id LIMIT 200$/)
      if (values[1] !== '') return []
      return [row(values[0] === 'project' ? activeProject : execution())]
    }
    updates.push(JSON.parse(String(values[3])))
    return { affectedRows: 1 }
  }))
  await repository.recover()
  assert.equal(updates.length, 2)
  assert.ok(updates.every(value => value.status === 'interrupted' && value.version === 2))
  assert.equal(calls.filter(sql => sql.startsWith('SELECT')).length, 4)
})

test('mysql: missing schema and pool produce sanitized 503 instructions with no fallback or DDL', async context => {
  const root = await mkdtemp(join(tmpdir(), 'testing-repository-no-fallback-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  for (const pool of [undefined, sqlPool(() => []), sqlPool(() => { throw new Error('secret connection details') })]) {
    await assert.rejects(createTestingRepository('mysql', root, pool), error => {
      assert.ok(error instanceof TestingStorageUnavailableError)
      assert.equal(error.statusCode, 503); assert.match(error.message, /sql\/mysql-testing-schema.sql/); assert.doesNotMatch(error.message, /secret/)
      return true
    })
  }
  assert.deepEqual(await readdir(root), [])
})

test('mysql: recovery keyset batches cross 200 rows, preserve owners, and are idempotent', async () => {
  const records = Array.from({ length: 205 }, (_, index) => row({ ...project(`item-${String(index).padStart(3, '0')}`, index % 2 + 1), status: 'running' }))
  const sizes: number[] = []
  const repository = new MysqlTestingRepository(sqlPool((sql, values) => {
    if (sql.startsWith('SELECT')) {
      const batch = records.filter(item => item.kind === values[0] && item.status === 'running' && String(item.id) > String(values[1])).slice(0, 200)
      sizes.push(batch.length)
      return batch
    }
    assert.match(sql, /^UPDATE codeflow_testing_records/)
    const existing = records.find(item => item.kind === values[4] && item.id === values[5] && item.owner_id === values[6] && item.version === values[7])
    if (!existing) return { affectedRows: 0 }
    Object.assign(existing, { version: values[0], updated_at: values[1], status: values[2], body: values[3] })
    return { affectedRows: 1 }
  }))
  await repository.recover()
  assert.deepEqual(sizes, [200, 5, 0, 0])
  assert.ok(records.every(item => item.status === 'interrupted' && item.version === 2 && JSON.parse(String(item.body)).ownerId === item.owner_id))
  const before = JSON.stringify(records)
  await repository.recover()
  assert.equal(JSON.stringify(records), before)
})

test('mysql: corrupt bodies and mismatched owners never escape read validation; persistence failures propagate', async () => {
  let response: unknown = [row({ ...project(), ownerId: 2 })]
  const repository = new MysqlTestingRepository(sqlPool(sql => {
    if (sql.startsWith('SELECT')) return response
    throw new Error('Injected persistence failure')
  }))
  await assert.rejects(repository.list('project', 1), TestingContractError)
  response = [{ ...row(project()), body: JSON.stringify({ ...project(), version: 99 }) }]
  await assert.rejects(repository.get('project', 'project-1', 1), TestingContractError)
  await assert.rejects(repository.create('project', project(), 1), /Injected persistence failure/)
  await assert.rejects(repository.replace('project', { ...project(), version: 2 }, 1, 1), /Injected persistence failure/)
})

test('mysql: verify accepts dedicated schema and rejects incompatible columns, indexes and engine', async () => {
  const definitions: Record<string, string> = { kind: 'varchar', id: 'varchar', owner_id: 'bigint', version: 'bigint', created_at: 'varchar', updated_at: 'varchar', status: 'varchar', body: 'json' }
  const columns = Object.entries(definitions).map(([name, type]) => ({ COLUMN_NAME: name, DATA_TYPE: type, COLUMN_TYPE: type === 'bigint' ? 'bigint(20) unsigned' : type, IS_NULLABLE: 'NO', CHARACTER_MAXIMUM_LENGTH: ({ kind: 16, id: 191, created_at: 24, updated_at: 24, status: 32 } as Record<string, number>)[name], COLLATION_NAME: type === 'varchar' ? 'utf8mb4_bin' : null }))
  const indexes = Object.entries({ PRIMARY: ['kind', 'id'], testing_owned_list: ['kind', 'owner_id', 'created_at', 'id'], testing_recovery: ['kind', 'status', 'id'] }).flatMap(([name, fields]) => fields.map((field, index) => ({ INDEX_NAME: name, NON_UNIQUE: name === 'PRIMARY' ? 0 : 1, SEQ_IN_INDEX: index + 1, COLUMN_NAME: field, SUB_PART: null })))
  const calls: string[] = []
  let schemaColumns: unknown[] = columns, schemaIndexes: unknown[] = indexes, engine = 'InnoDB'
  const pool = sqlPool(sql => {
    calls.push(sql)
    assert.match(sql, /^SELECT /)
    if (sql.includes('information_schema.COLUMNS')) return schemaColumns
    if (sql.includes('information_schema.STATISTICS')) return schemaIndexes
    if (sql.includes('information_schema.TABLES')) return [{ ENGINE: engine }]
    assert.match(sql, /FROM codeflow_testing_records LIMIT 0$/)
    return []
  })
  const repository = await createTestingRepository('mysql', 'unused', pool)
  assert.ok(repository instanceof MysqlTestingRepository)
  assert.equal(calls.length, 4)
  schemaColumns = columns.map(column => column.COLUMN_NAME === 'version' ? { ...column, COLUMN_TYPE: 'bigint' } : column)
  await assert.rejects(new MysqlTestingRepository(pool).verify(), TestingStorageUnavailableError)
  schemaColumns = columns.map(column => column.COLUMN_NAME === 'id' ? { ...column, COLLATION_NAME: 'utf8mb4_general_ci' } : column)
  await assert.rejects(new MysqlTestingRepository(pool).verify(), TestingStorageUnavailableError)
  schemaColumns = columns
  schemaIndexes = indexes.slice(1)
  await assert.rejects(new MysqlTestingRepository(pool).verify(), TestingStorageUnavailableError)
  schemaIndexes = indexes; engine = 'MyISAM'
  await assert.rejects(new MysqlTestingRepository(pool).verify(), TestingStorageUnavailableError)
})