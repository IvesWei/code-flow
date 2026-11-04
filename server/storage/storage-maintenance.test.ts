import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { hash, terminalStatuses } from './contracts.js'
import { auditFiles, parseMaintenanceArgs, StorageMaintenance } from './storage-maintenance.js'

function fixture(options: { status?: string; active?: boolean; busyField?: 'modelInTurn' | 'modelTurn.status'; running?: boolean; absent?: boolean; lock?: number; version?: number; failDelete?: boolean; wrongCount?: boolean; loseLock?: boolean; loseLockAfterDelete?: boolean } = {}) {
  const statements: { sql: string; values: unknown[] }[] = []
  let commits = 0, rollbacks = 0, checks = 0
  const connection = {
    query: async ({ sql }: { sql: string }, values: unknown[] = []): Promise<[unknown]> => {
      statements.push({ sql, values })
      if (sql.includes('GET_LOCK')) return [[{ acquired: options.lock ?? 1 }]]
      if (sql.includes('IS_USED_LOCK')) {
        checks++
        return [[{ owns_lock: options.loseLock && checks > 1 || options.loseLockAfterDelete && checks > 2 ? 0 : 1 }]]
      }
      if (sql.includes('SELECT version')) return [[{ version: options.version ?? 2 }]]
      if (sql.includes('FOR UPDATE')) return [options.absent ? [] : [{ id: values[0], status: options.status ?? 'REVIEW' }]]
      if (sql.includes('status NOT IN')) return [options.active || options.busyField && sql.includes(`$.${options.busyField}`) ? [{ id: 'other' }] : []]
      if (sql.includes("status = 'running'") || sql.includes("status IN ('running', 'generating')")) return [options.running ? [{ id: 'run' }] : []]
      if (sql.startsWith('DELETE')) {
        if (options.failDelete && sql.includes('case_runs')) throw new Error('failure')
        return [{ affectedRows: options.wrongCount ? 0 : 1 }]
      }
      if (sql.includes('GROUP BY')) return [[{ task_id: 'task', row_count: '1', json_text_bytes: '12' }]]
      if (sql.includes('COUNT(*)')) return [[{ row_count: '1', json_text_bytes: '12', max_body_bytes: '12' }]]
      return [[]]
    },
    beginTransaction: async () => {}, commit: async () => { commits++ }, rollback: async () => { rollbacks++ },
  }
  return { maintenance: new StorageMaintenance(connection, 'codeflow_test'), statements, state: () => ({ commits, rollbacks }) }
}

test('strict CLI requires an explicit task and never permits file deletion', () => {
  assert.deepEqual(parseMaintenanceArgs(['delete-task', '--taskId', 'task']), { command: 'delete-task', taskId: 'task', execute: false })
  assert.equal(parseMaintenanceArgs(['delete-task', '--taskId', 'task', '--execute']).execute, true)
  for (const args of [[], ['delete-task', '--execute'], ['capacity', '--execute'], ['files', '--data-dir', 'temp', '--execute'], ['delete-task', '--taskId', 'task', '--delete-files'], ['capacity', '--taskId'], ['capacity', '--execute', '--execute']]) {
    assert.throws(() => parseMaintenanceArgs(args))
  }
})

test('same core lock name, schema 2 and loss of lock fail closed', async () => {
  const good = fixture()
  await good.maintenance.acquire()
  assert.equal(good.statements[0].values[0], `codeflow:${hash('codeflow_test').slice(0, 40)}`)
  for (const options of [{ lock: 0 }, { version: 1 }]) await assert.rejects(fixture(options).maintenance.acquire())
  const lost = fixture({ loseLock: true })
  await assert.rejects(lost.maintenance.deleteTask('task', true), /lock lost/)
  assert.equal(lost.statements.some(item => item.sql.startsWith('DELETE')), false)
  assert.equal(lost.state().rollbacks, 1)
})

test('dry run counts all eight tables but writes nothing and rolls back', async () => {
  const fake = fixture()
  const result = await fake.maintenance.deleteTask('task')
  assert.equal(result.executed, false)
  assert.equal(result.filesRetained, true)
  assert.equal(Object.keys(result.counts).length, 8)
  assert.equal(fake.statements.some(item => /^(DELETE|INSERT|UPDATE)/.test(item.sql)), false)
  assert.deepEqual(fake.state(), { commits: 0, rollbacks: 1 })
})

test('only core terminal states are deletable; active tasks and unfinished children block deletion', async () => {
  for (const status of terminalStatuses) assert.equal((await fixture({ status }).maintenance.deleteTask('task')).status, status)
  for (const options of [{ status: 'CODING' }, { status: 'NEEDS_INPUT' }, { status: 'unknown' }, { active: true }, { running: true }]) {
    const fake = fixture(options)
    await assert.rejects(fake.maintenance.deleteTask('task', true))
    assert.equal(fake.statements.some(item => item.sql.startsWith('DELETE')), false)
  }
})

test('explicit deletion uses FK order and task parameters; failures roll back', async () => {
  const fake = fixture()
  const result = await fake.maintenance.deleteTask("task'quoted", true)
  assert.equal(result.executed, true)
  const deletes = fake.statements.filter(item => item.sql.startsWith('DELETE'))
  assert.deepEqual(deletes.map(item => item.sql.split(' ')[2]), ['codeflow_model_usage', 'codeflow_case_runs', 'codeflow_task_events', 'codeflow_task_files', 'codeflow_acceptance_snapshots', 'codeflow_self_test_artifacts', 'codeflow_test_cases', 'codeflow_tasks'])
  assert.ok(deletes.every(item => item.values[0] === "task'quoted" && !item.sql.includes('quoted')))
  assert.equal(fake.state().commits, 1)
  const failing = fixture({ failDelete: true })
  await assert.rejects(failing.maintenance.deleteTask('task', true))
  assert.deepEqual(failing.state(), { commits: 0, rollbacks: 1 })
})

test('capacity is SELECT-only and aggregates normalized task bytes without loading bodies', async () => {
  const fake = fixture()
  const report = await fake.maintenance.capacity('task')
  assert.equal(report.tables.length, 8)
  assert.deepEqual(report.tasks, [{ taskId: 'task', rows: 8, jsonTextBytes: 96 }])
  assert.ok(fake.statements.every(item => item.sql.startsWith('SELECT')))
  assert.ok(fake.statements.filter(item => item.sql.includes('GROUP BY')).every(item => item.values[0] === 'task'))
})

test('file audit retains files, reports missing/unsafe/unregistered, and directory manifests cover SDK children', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codeflow-maintenance-'))
  try {
    await mkdir(path.join(directory, 'uploads', 'task'), { recursive: true })
    await mkdir(path.join(directory, 'sessions', 'task'), { recursive: true })
    await writeFile(path.join(directory, 'uploads', 'task', 'kept.txt'), 'kept')
    await writeFile(path.join(directory, 'uploads', 'task', 'candidate.txt'), 'candidate')
    await writeFile(path.join(directory, 'sessions', 'task', 'sdk-state'), 'opaque')
    const record = (key: string) => ({ kind: 'prd', storage_key: key, storage_key_hash: hash(key) })
    const report = await auditFiles(directory, [record('uploads/task/kept.txt'), record('uploads/task/missing.txt'), record('../outside'), record('uploads/task/NUL'), record('sessions/task')])
    assert.deepEqual(report.missing, ['uploads/task/missing.txt'])
    assert.deepEqual(report.unregisteredCandidates, ['uploads/task/candidate.txt'])
    assert.deepEqual(report.unsafe, ['../outside', 'uploads/task/NUL'])
    await assert.rejects(auditFiles(directory, [], 1), /entry limit/)
    await assert.rejects(auditFiles(path.join(directory, 'absent'), []))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('file audit never follows directory links outside DATA_DIR', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codeflow-links-'))
  const outside = await mkdtemp(path.join(os.tmpdir(), 'codeflow-outside-'))
  try {
    await mkdir(path.join(directory, 'uploads'))
    await writeFile(path.join(outside, 'private.txt'), 'not read')
    await symlink(outside, path.join(directory, 'uploads', 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const key = 'uploads/linked/private.txt'
    const report = await auditFiles(directory, [{ kind: 'prd', storage_key: key, storage_key_hash: hash(key) }])
    assert.ok(report.unsafe.includes(key))
    assert.ok(report.unsafe.includes('uploads/linked'))
    assert.deepEqual(report.unregisteredCandidates, [])
  } finally { await rm(directory, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
})

test('terminal task model activity, missing tasks, changed counts and late lock loss fail closed', async () => {
  for (const busyField of ['modelInTurn', 'modelTurn.status'] as const) {
    const fake = fixture({ busyField })
    await assert.rejects(fake.maintenance.deleteTask('task', true), /Active tasks/)
    assert.equal(fake.statements.some(item => item.sql.startsWith('DELETE')), false)
  }
  for (const options of [{ absent: true }, { wrongCount: true }, { loseLockAfterDelete: true }]) {
    const fake = fixture(options)
    await assert.rejects(fake.maintenance.deleteTask('task', true))
    assert.deepEqual(fake.state(), { commits: 0, rollbacks: 1 })
  }
})