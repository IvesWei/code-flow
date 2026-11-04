import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { decode, diffTask, storedJson, validateChange } from './contracts.js'
import { businessTables, cleanupSmoke, faultPool, parseSmokeOptions, runSmoke, SmokeFailure, smokeCommand, smokeCreate, smokeFixture, type SmokeSession } from './db-smoke.js'
import { MysqlTaskRepository, type SqlPool } from './task-repository.js'

test('smoke defaults to no environment, configuration or connection; options require explicit execution', async () => {
  const output: string[] = []
  const forbidden = (): never => { throw new Error('Must not access environment or DB') }
  const deps = { loadEnvironment: forbidden, config: forbidden, open: forbidden, output: (text: string) => output.push(text), error: forbidden }
  assert.equal(await smokeCommand([], deps), 0)
  assert.match(output[0], /DRY RUN/)
  assert.match(output[0], /named lock/)
  assert.deepEqual(parseSmokeOptions(['--execute']), { execute: true, keep: false })
  assert.deepEqual(parseSmokeOptions(['--execute', '--keep']), { execute: true, keep: true })
  for (const args of [['--keep'], ['--force'], ['--execute', '--execute'], ['--cleanup'], ['--skip-lock']]) assert.throws(() => parseSmokeOptions(args))
})

test('smoke fixture covers all eight normalized business tables without active task execution or ownership', () => {
  const task = smokeFixture(randomUUID(), '2026-10-16T12:34:56.789Z')
  const change = smokeCreate(task)
  validateChange(change)
  assert.equal(task.ownerId, undefined)
  assert.equal(task.status, 'REVIEW')
  assert.equal(task.workspace, undefined)
  assert.equal(task.copilotSession, undefined)
  assert.match(task.instruction, /storage smoke/)
  assert.equal(businessTables.length, 8)
  assert.deepEqual([change.events.length, change.artifacts.length, change.cases.length, change.snapshots.length, change.runs.length, change.files.length, change.usage.length], [2, 1, 1, 1, 1, 1, 3])
  assert.equal(change.runs[0].status, 'running')
  assert.equal(change.artifacts[0].status, 'complete')
  assert.equal(change.usage[0].body.counting, 'incremental')
  assert.equal(change.usage[0].body.cacheReadTokens, 5)
  assert.equal(change.usage[2].body.platformOnly, true)
  assert.equal(change.files[0].metadata.actualFile, false)
  assert.match(JSON.stringify(task), /\u4e2d\u6587/)
})

function sqlFixture(failDelete = false) {
  const statements: { sql: string; values: unknown[] }[] = []
  const lifecycle: string[] = []
  const connection = {
    query: async (options: { sql: string }, values: unknown[] = []): Promise<[unknown]> => {
      statements.push({ sql: options.sql, values })
      if (failDelete && options.sql.startsWith('DELETE')) throw new Error('delete root failure')
      return [options.sql.startsWith('SELECT') ? [{ id: values[1] }] : { affectedRows: 1 }]
    },
    beginTransaction: async () => { lifecycle.push('begin') }, commit: async () => { lifecycle.push('commit') },
    rollback: async () => { lifecycle.push('rollback') }, release: () => { lifecycle.push('release') },
  }
  const pool: SqlPool = { query: connection.query, getConnection: async () => connection }
  const database = { health: async () => { lifecycle.push('health') } } as SmokeSession['database']
  return { pool, database, statements, lifecycle }
}

test('cleanup is transactional, locked, FK ordered and bound exclusively to the generated UUID', async () => {
  const fake = sqlFixture(), taskId = randomUUID()
  await cleanupSmoke(fake, taskId)
  assert.deepEqual(fake.lifecycle, ['health', 'begin', 'commit', 'release'])
  assert.deepEqual(fake.statements.map(item => item.sql), businessTables.map(table => `DELETE FROM ${table} WHERE ${table === 'codeflow_tasks' ? 'id' : 'task_id'} = ?`))
  assert.ok(fake.statements.every(item => JSON.stringify(item.values) === JSON.stringify([taskId])))
  await assert.rejects(cleanupSmoke(fake, 'existing-task'))
  assert.equal(fake.statements.length, 8)
  const failed = sqlFixture(true)
  await assert.rejects(cleanupSmoke(failed, taskId), /delete root failure/)
  assert.deepEqual(failed.lifecycle, ['health', 'begin', 'rollback', 'release'])
})

test('fault wrapper proves child visibility before failing final UPDATE and retains original injected error', async () => {
  const fake = sqlFixture(), taskId = randomUUID(), fileId = randomUUID(), injected = new Error('sentinel')
  const fault = faultPool(fake.pool, taskId, fileId, injected)
  const connection = await fault.pool.getConnection()
  await connection.beginTransaction()
  await connection.query({ sql: 'INSERT INTO codeflow_task_files ...', timeout: 1 }, [])
  await assert.rejects(connection.query({ sql: 'UPDATE codeflow_tasks SET ...', timeout: 1 }, []), error => error === injected)
  assert.equal(fault.triggered(), true)
  assert.deepEqual(fake.statements.at(-1)?.values, [taskId, fileId])
  await connection.rollback()
  connection.release()
  assert.deepEqual(fake.lifecycle, ['begin', 'rollback', 'release'])
})

test('CLI never prints raw connection errors or credentials', async () => {
  const messages: string[] = []
  const code = await smokeCommand(['--execute'], {
    loadEnvironment: () => {}, config: () => { throw new Error('secret-password raw mysql error') },
    open: async () => { throw new Error('must not open') },
    output: text => messages.push(text), error: text => messages.push(text),
  })
  assert.equal(code, 1)
  assert.equal(messages.join('').includes('secret-password'), false)
  assert.equal(messages.join('').includes('raw mysql error'), false)
})

type Row = Record<string, unknown>
type Tables = Record<string, Row[]>
function mysqlJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(mysqlJson)
  if (!value || typeof value !== 'object' || value instanceof Date) return value
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, mysqlJson(item)]))
}

function memoryDatabase(options: { failCompletion?: boolean; failCleanup?: boolean; failReconnect?: boolean; corruptRead?: boolean; locked?: boolean } = {}) {
  const statements: { sql: string; values: unknown[] }[] = []
  const lifecycle: string[] = []
  let tables: Tables = Object.fromEntries(businessTables.map(table => [table, []]))
  const sentinel = { id: 'existing-task-never-recover', status: 'CODING', state: { untouched: true }, row_version: 999 }
  tables.codeflow_tasks.push(structuredClone(sentinel))
  let opens = 0, held = options.locked ?? false
  const execute = (data: Tables, sql: string, values: unknown[]): unknown => {
    statements.push({ sql, values: structuredClone(values) })
    if (sql.startsWith('INSERT INTO')) {
      const match = /^INSERT INTO (\w+) \(([^)]+)\) VALUES \(([^)]+)\)/.exec(sql)!
      assert.ok(match, sql)
      let index = 0
      const expressions = match[3].split(', ')
      const row: Row = Object.fromEntries(match[2].split(', ').map((column, position) => [column, expressions[position] === '?' ? structuredClone(values[index++]) : Number(expressions[position])]))
      for (const key of ['state', 'body', 'definition', 'metadata', 'output', 'input_refs']) {
        if (typeof row[key] === 'string') row[key] = mysqlJson(JSON.parse(row[key] as string))
      }
      if (match[1] === 'codeflow_tasks') Object.assign(row, { next_event_seq: 1, next_case_ordinal: 1, next_run_seq: 1, next_snapshot_seq: 1 })
      data[match[1]].push(row)
      return { affectedRows: 1 }
    }
    if (sql.startsWith('UPDATE codeflow_tasks SET')) {
      if (options.failCompletion && sql.includes('row_version = row_version + 1')) throw new Error('completion root failure')
      const row = data.codeflow_tasks.find(item => item.id === values.at(-2) && item.row_version === values.at(-1))
      if (!row) return { affectedRows: 0 }
      let index = 0
      for (const assignment of sql.split(' SET ')[1].split(' WHERE ')[0].split(', ')) {
        const column = assignment.split(' = ')[0]
        if (assignment.endsWith(' + 1')) row[column] = Number(row[column]) + 1
        else {
          const value = structuredClone(values[index++])
          row[column] = column === 'state' ? mysqlJson(JSON.parse(String(value))) : value
        }
      }
      return { affectedRows: 1 }
    }
    if (sql.startsWith('UPDATE codeflow_case_runs SET')) {
      const row = data.codeflow_case_runs.find(item => item.task_id === values[6] && item.id === values[7])!
      Object.assign(row, { status: values[0], started_at: row.started_at ?? values[1], finished_at: values[2], body_version: values[3], body: mysqlJson(JSON.parse(String(values[4]))), input_fingerprint: values[5] })
      return { affectedRows: 1 }
    }
    if (sql.startsWith('DELETE FROM')) {
      if (options.failCleanup) throw new Error('cleanup root failure')
      const table = sql.split(' ')[2]
      data[table] = data[table].filter(row => (table === 'codeflow_tasks' ? row.id : row.task_id) !== values[0])
      return { affectedRows: 1 }
    }
    assert.ok(sql.startsWith('SELECT'), sql)
    const table = /FROM (codeflow_\w+)/.exec(sql)?.[1]
    assert.ok(table, sql)
    let selected = data[table].filter(row => (table === 'codeflow_tasks' ? row.id : row.task_id) === values[0])
    if (sql.includes('JSON_OBJECT(')) {
      selected = data.codeflow_tasks.filter(row => row.id !== sentinel.id && ((row.created_at as Date).getTime() < (values[0] as Date).getTime() || ((row.created_at as Date).getTime() === (values[0] as Date).getTime() && String(row.id) < String(values[2]))))
        .toSorted((left, right) => (right.created_at as Date).getTime() - (left.created_at as Date).getTime() || String(right.id).localeCompare(String(left.id)))
        .slice(0, Number(values.at(-1)))
      return selected.map(row => {
        const state = decode(row.state) as Row
        return { ...row, state: storedJson({ repository: state.repository, instruction: '', prdName: '', designNames: [] }), collections: storedJson(state._collections) }
      })
    }
    if (sql.includes('task_id IN (')) selected = data[table].filter(row => values.includes(row.task_id))
    if (sql.includes('COUNT(*)')) return [{ count: selected.length }]
    if (sql.startsWith('SELECT scope_hash')) return []
    if (sql.includes('WHERE id = ? FOR UPDATE') && table !== 'codeflow_tasks') selected = data[table].filter(row => row.id === values[0])
    else if (/AND (?:r\.)?id = \?/.test(sql)) selected = selected.filter(row => row.id === values[1])
    if (sql.includes('storage_key_hash = ?')) selected = selected.filter(row => row.storage_key_hash === values[1])
    if (sql.includes('AND case_id = ?')) selected = selected.filter(row => row.case_id === values[1])
    if (sql.includes('AND phase = ?')) selected = selected.filter(row => row.phase === values[1] && row.scope_hash === values[2] && row.input_fingerprint === values[3])
    if (sql.includes("kind = 'execution_plan'")) selected = selected.filter(row => row.kind === 'execution_plan')
    if (sql.includes("status IN ('running', 'generating')")) selected = selected.filter(row => ['running', 'generating'].includes(String(row.status)) && row.finished_at == null)
    if (sql.includes('AND seq < ?')) selected = selected.filter(row => Number(row.seq) < Number(values[1]))
    if (sql.includes('AND seq > ?')) selected = selected.filter(row => Number(row.seq) > Number(values[1]))
    if (sql.includes('AND run_seq > ?')) selected = selected.filter(row => Number(row.run_seq) > Number(values[1]))
    if (sql.includes('ORDER BY seq DESC')) selected = selected.toSorted((left, right) => Number(right.seq) - Number(left.seq))
    if (sql.includes('ORDER BY seq DESC LIMIT 1000)')) selected = selected.reverse()
    if (/LIMIT \?$/.test(sql)) selected = selected.slice(0, Number(values.at(-1)))
    if (sql.startsWith('SELECT id, execution_plan_id, review_artifact_id')) return selected.map(row => ({ id: row.id, execution_plan_id: row.execution_plan_id, review_artifact_id: row.review_artifact_id }))
    if (sql.startsWith('SELECT id FROM')) return selected.map(row => ({ id: row.id }))
    if (options.corruptRead && opens > 1 && sql.startsWith('SELECT * FROM codeflow_tasks')) return selected.map(row => ({ ...row, updated_at: new Date(0) }))
    return structuredClone(selected)
  }
  const open = async (): Promise<SmokeSession> => {
    opens++
    if (held) throw new Error('owner lock held')
    if (options.failReconnect && opens === 2) throw new Error('reconnect root failure')
    held = true
    lifecycle.push('connect-lock')
    let closed = false
    const health = async () => { assert.equal(closed, false); assert.equal(held, true); lifecycle.push('health') }
    const pool: SqlPool = {
      query: async ({ sql }, values = []) => { assert.equal(closed, false); return [execute(tables, sql, values)] },
      getConnection: async () => {
        assert.equal(closed, false)
        let transaction: Tables | undefined
        return {
          beginTransaction: async () => { transaction = structuredClone(tables); lifecycle.push('begin') },
          commit: async () => { assert.ok(transaction); tables = transaction; transaction = undefined; lifecycle.push('commit') },
          rollback: async () => { transaction = undefined; lifecycle.push('rollback') },
          release: () => { lifecycle.push('release') },
          query: async ({ sql }, values = []) => [execute(transaction ?? tables, sql, values)],
        }
      },
    }
    const database = Object.assign(new MysqlTaskRepository(pool, health), { health, close: async () => { assert.equal(closed, false); closed = true; held = false; lifecycle.push('close-unlock') } })
    return { database, pool }
  }
  return { open, statements, lifecycle, tables: () => tables, opens: () => opens, sentinel }
}

test('real repository smoke reconnects and preserves ordered Unicode JSON, runs, snapshots, dates and metadata', async () => {
  const fake = memoryDatabase()
  const result = await runSmoke(fake.open)
  assert.equal(result.cleaned, true)
  assert.deepEqual(Object.values(result.counts), [3, 1, 1, 1, 1, 1, 2, 1])
  assert.equal(fake.opens(), 2)
  assert.equal(fake.lifecycle.filter(item => item === 'close-unlock').length, 2)
  assert.equal(fake.lifecycle.filter(item => item === 'rollback').length, 2)
  assert.deepEqual(fake.tables().codeflow_tasks, [fake.sentinel])
  assert.ok(businessTables.slice(0, -1).every(table => fake.tables()[table].length === 0))
  const writes = fake.statements.filter(item => /^(INSERT|UPDATE|DELETE)/.test(item.sql))
  assert.ok(writes.every(item => !item.values.includes(fake.sentinel.id)))
  assert.equal(fake.statements.some(item => /recover|status NOT IN/.test(item.sql)), false)
})

test('--keep retains only synthetic task rows with one completed attempt; a new smoke uses new IDs', async () => {
  const fake = memoryDatabase()
  const first = await runSmoke(fake.open, true), second = await runSmoke(fake.open, true)
  assert.notEqual(first.taskId, second.taskId)
  assert.equal(first.cleaned, false)
  assert.equal(fake.statements.some(item => item.sql.startsWith('DELETE')), false)
  const runs = fake.tables().codeflow_case_runs
  assert.equal(runs.length, 2)
  assert.ok(runs.every(row => row.status === 'passed' && row.run_seq === 1))
  assert.ok(fake.tables().codeflow_tasks.filter(row => row.id !== fake.sentinel.id).every(row => row.status === 'REVIEW' && row.owner_id === null && row.row_version === 2))
})

test('failure after task creation cleans only owned rows and preserves the original debugging cause', async () => {
  const fake = memoryDatabase({ failCompletion: true })
  await assert.rejects(runSmoke(fake.open), error => {
    assert.ok(error instanceof SmokeFailure)
    assert.equal(error.cleaned, true)
    assert.ok(error.cause instanceof Error)
    assert.equal((error.cause.cause as Error).message, 'completion root failure')
    return true
  })
  assert.deepEqual(fake.tables().codeflow_tasks, [fake.sentinel])
  assert.equal(fake.lifecycle.at(-1), 'close-unlock')
})

test('failed reconnect retries only for owned cleanup; readback corruption fails and cleans up', async () => {
  for (const options of [{ failReconnect: true }, { corruptRead: true }]) {
    const fake = memoryDatabase(options)
    await assert.rejects(runSmoke(fake.open), error => error instanceof SmokeFailure && error.cleaned)
    assert.deepEqual(fake.tables().codeflow_tasks, [fake.sentinel])
    assert.equal(fake.lifecycle.at(-1), 'close-unlock')
  }
})

test('cleanup failures retain both root causes and close; --keep on failure suppresses cleanup', async () => {
  const fake = memoryDatabase({ failCompletion: true, failCleanup: true })
  await assert.rejects(runSmoke(fake.open), error => {
    assert.ok(error instanceof SmokeFailure)
    assert.equal(error.cleaned, false)
    assert.ok(error.cause instanceof AggregateError)
    assert.equal(error.cause.errors[1].message, 'cleanup root failure')
    return true
  })
  assert.equal(fake.lifecycle.at(-1), 'close-unlock')
  const kept = memoryDatabase({ failCompletion: true })
  await assert.rejects(runSmoke(kept.open, true), error => error instanceof SmokeFailure && !error.cleaned)
  assert.equal(kept.tables().codeflow_tasks.length, 2)
  assert.equal(kept.statements.some(item => item.sql.startsWith('DELETE')), false)
})

test('held owner lock fails before any SQL, never recovers tasks or attempts cleanup', async () => {
  const fake = memoryDatabase({ locked: true })
  await assert.rejects(runSmoke(fake.open), error => error instanceof SmokeFailure && !error.cleaned && (error.cause as Error).message === 'owner lock held')
  assert.deepEqual(fake.statements, [])
  assert.deepEqual(fake.tables().codeflow_tasks, [fake.sentinel])
})

test('running-to-passed delta continues the same attempt without rewriting artifact, definition or frozen plan', () => {
  const running = smokeFixture(randomUUID()), passed = structuredClone(running)
  Object.assign(passed.selfTests![0], { status: 'passed', finishedAt: running.createdAt, output: 'passed' })
  const change = diffTask(running, passed, 1)
  validateChange(change)
  assert.equal(change.runs[0].continuation, true)
  assert.equal(change.runs[0].continuationFrom?.startedAt, running.createdAt)
  assert.deepEqual([change.artifacts, change.cases, change.snapshots, change.events], [[], [], [], []])
})