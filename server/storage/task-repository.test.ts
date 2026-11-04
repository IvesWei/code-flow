import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CodingTask } from '../../shared/task.js'
import type { TestExecutionResult } from '../../shared/test-execution.js'
import { caseDefinition, decode, diffTask, hash, storedJson, taskState, StorageConflictError, StorageContractError } from './contracts.js'
import { MysqlTaskRepository, type SqlPool } from './task-repository.js'
import { taskSummary } from '../tasks/task-summary.js'
import { caseInputs, fingerprint } from '../verification/self-test-artifacts.js'

const now = '2026-10-15T00:00:00.000Z'
function executionResultFixture(): TestExecutionResult {
  return {
    version: 1, runner: 'playwright-test', caseId: 'TC-1', caseFingerprint: hash('case'),
    status: 'passed', reason: 'Assertions passed',
    assertions: [{ id: 'TC-1:A001', status: 'passed', expectCount: 2 }],
    startedAt: now, finishedAt: now,
  }
}
export function taskFixture(): CodingTask { return { id: 'task', repository: 'repo', instruction: 'test', prdName: 'prd', designNames: [], status: 'REVIEW', createdAt: now, updatedAt: now, entries: [] } }
export function fakeSql(respond?: (sql: string, values: unknown[]) => unknown) {
  const statements: { sql: string; values: unknown[] }[] = []
  let commits = 0, rollbacks = 0, releases = 0
  const connection = {
    query: async ({ sql }: { sql: string }, values: unknown[] = []): Promise<[unknown]> => {
      statements.push({ sql, values })
      const response = respond?.(sql, values)
      if (response !== undefined) return [response]
      if (sql.startsWith('SELECT row_version')) return [[{ row_version: 1, next_event_seq: 3, next_case_ordinal: 1, next_run_seq: 1, next_snapshot_seq: 1 }]]
      return [sql.startsWith('SELECT') ? [] : { affectedRows: 1 }]
    },
    beginTransaction: async () => {}, commit: async () => { commits++ }, rollback: async () => { rollbacks++ }, release: () => { releases++ },
  }
  const pool: SqlPool = { query: connection.query, getConnection: async () => connection }
  return { pool, statements, state: () => ({ commits, rollbacks, releases }) }
}
test('event appends one normalized row and advances optimistic version without state or other collections', async () => {
  const fake = fakeSql(), repository = new MysqlTaskRepository(fake.pool)
  const before = taskFixture(), after = structuredClone(before)
  after.entries.push({ kind: 'info', text: 'event', at: now })
  assert.equal(await repository.commit(diffTask(before, after, 1)), 2)
  assert.deepEqual(fake.statements.map(item => item.sql.split(' ').slice(0, 3).join(' ')), ['SELECT row_version, next_event_seq,', 'INSERT INTO codeflow_task_events', 'UPDATE codeflow_tasks SET'])
  assert.equal(fake.statements[1].values[1], 3)
  assert.ok(!fake.statements[2].sql.includes('state ='))
  assert.ok(fake.statements[2].sql.endsWith('WHERE id = ? AND row_version = ?'))
  assert.equal(fake.state().commits, 1)
})
test('version mismatch and failed final compare-and-set both roll back', async () => {
  for (const mode of ['lock', 'update']) {
    const fake = fakeSql(sql => mode === 'lock' && sql.startsWith('SELECT row_version') ? [{ row_version: 4 }] : mode === 'update' && sql.startsWith('UPDATE codeflow_tasks') ? { affectedRows: 0 } : undefined)
    await assert.rejects(new MysqlTaskRepository(fake.pool).commit(diffTask(taskFixture(), taskFixture(), 1)), StorageConflictError)
    assert.deepEqual(fake.state(), { commits: 0, rollbacks: 1, releases: 1 })
  }
})
test('normalized case definition and manual evidence are committed together', async () => {
  const fake = fakeSql(sql => sql.startsWith('SELECT definition_revision') ? [{ definition_revision: 1, definition_fingerprint: 'old' }] : undefined)
  const task = taskFixture()
  task.selfTests = [{ id: 'TC-10', title: 'test', source: '', steps: '', expected: '', status: 'manual', output: 'manual evidence' }]
  await new MysqlTaskRepository(fake.pool).commit(diffTask(undefined, task, 0))
  assert.ok(fake.statements.some(item => item.sql.startsWith('UPDATE codeflow_test_cases SET definition_revision')))
  const run = fake.statements.find(item => item.sql.startsWith('INSERT INTO codeflow_case_runs'))!
  assert.equal(run.values[9], 'manual')
  assert.equal(JSON.parse(String(run.values[13])).output, 'manual evidence')
  const main = fake.statements.find(item => item.sql.startsWith('INSERT INTO codeflow_tasks'))!
  assert.equal(JSON.parse(String(main.values[6])).selfTests, undefined)
})
test('browser v2 optional fields survive normalized run payload writes and detail reads', async () => {
  const task = taskFixture()
  task.automationRuns = [
    { caseId: 'legacy-blocked', status: 'blocked', output: 'Legacy reason', reasonCode: 'unknown', protocolVersion: 'browser-v2' },
    { caseId: 'capability-blocked', status: 'blocked', output: 'Missing capability', reasonCode: 'capability', requiredCapabilities: ['download.verify', 'clipboard.read'], protocolVersion: 'browser-v2' },
    { caseId: 'assertion-failed', status: 'failed', failureKind: 'step', failureCategory: 'assertion', protocolVersion: 'browser-v2' },
    { caseId: 'action-failed', status: 'failed', failureKind: 'step', failureCategory: 'action', protocolVersion: 'browser-v2' },
    { caseId: 'TC-1', status: 'passed', runner: 'playwright-test', executionResult: executionResultFixture(), script: 'private script', output: 'private output' },
  ]
  const writer = fakeSql(sql => sql.startsWith('SELECT definition_revision') ? [{ definition_revision: 1 }] : undefined)
  await new MysqlTaskRepository(writer.pool).commit(diffTask(undefined, task, 0))
  const state = writer.statements.find(item => item.sql.startsWith('INSERT INTO codeflow_tasks'))!.values[6]
  const payloads = writer.statements.filter(item => item.sql.startsWith('INSERT INTO codeflow_case_runs')).map(item => item.values[13])
  assert.equal(payloads.length, task.automationRuns.length)
  assert.equal(decode<Record<string, unknown>>(state).automationRuns, undefined)
  for (const [index, payload] of payloads.entries()) assert.deepEqual(decode(payload), { ...task.automationRuns[index], projectionIndex: index })
  const reader = fakeSql(sql => {
    if (sql.startsWith('SELECT * FROM codeflow_tasks')) return [{ id: task.id, status: task.status, created_at: now, updated_at: now, row_version: 1, body_version: 1, state }]
    if (sql.startsWith('SELECT r.*')) return payloads.map((body, index) => ({ case_id: task.automationRuns![index].caseId, executor: 'browser', body_version: 1, body }))
    return undefined
  })
  const repository = new MysqlTaskRepository(reader.pool)
  assert.deepEqual((await repository.loadTask(task.id))?.task.automationRuns, task.automationRuns)
  assert.deepEqual((await repository.readTask(task.id))?.task.automationRuns, task.automationRuns)
  assert.deepEqual(decode(storedJson(task)), task)
})
test('foreign artifact references fail closed and do not commit', async () => {
  const fake = fakeSql()
  const task = taskFixture()
  task.selfTestArtifacts = [{ id: 'artifact', revision: 1, schemaVersion: 1, phase: 'review', scope: 'all', inputFingerprint: hash('input'), inputRefs: ['another-task-artifact'], status: 'running', createdAt: now, model: 'model', rulesVersion: '1' }]
  await assert.rejects(new MysqlTaskRepository(fake.pool).commit(diffTask(undefined, task, 0)), /same-task artifact/)
  assert.equal(fake.state().rollbacks, 1)
})
test('SQL listing is owner scoped and bounded, history uses strict sequence cursors', async () => {
  const fake = fakeSql(), repository = new MysqlTaskRepository(fake.pool)
  await repository.queryTasks(42, undefined, 10)
  assert.ok(fake.statements[0].sql.includes('owner_id = ?'))
  assert.deepEqual(fake.statements[0].values, [42, 11])
  await repository.history('task', 'events', '22', 10)
  assert.deepEqual(fake.statements[1].values, ['task', 22, 11])
  await assert.rejects(repository.history('task', 'events', '1 OR 1=1'))
  await assert.rejects(repository.queryTasks(undefined, undefined, 1001))
})
test('restart selects active IDs and never loads historical bodies', async () => {
  const fake = fakeSql(), repository = new MysqlTaskRepository(fake.pool)
  await repository.recoverActive()
  assert.equal(fake.statements.length, 1)
  assert.ok(fake.statements[0].sql.startsWith('SELECT id FROM codeflow_tasks'))
  assert.ok(!fake.statements[0].sql.includes('JOIN'))
})
test('event history starts with the latest page and moves strictly older with chronological responses', async () => {
  const events = Array.from({ length: 7 }, (_, index) => ({ seq: index + 1, created_at: now, kind: 'info', body_version: 1, body: storedJson({ text: String(index + 1) }) }))
  const fake = fakeSql((sql, values) => {
    if (!sql.includes('FROM codeflow_task_events')) return undefined
    assert.match(sql, /ORDER BY seq DESC LIMIT/)
    const boundary = sql.includes('seq < ?') ? Number(values[1]) : Infinity
    return events.filter(item => item.seq < boundary).reverse().slice(0, Number(values.at(-1)))
  })
  const repository = new MysqlTaskRepository(fake.pool)
  const latest = await repository.history('task', 'events', undefined, 3)
  assert.deepEqual(latest.items.map(item => (item as { text: string }).text), ['5', '6', '7'])
  assert.equal(latest.nextCursor, '5')
  events.push({ ...events[0], seq: 8, body: storedJson({ text: '8' }) })
  const older = await repository.history('task', 'events', latest.nextCursor, 3)
  assert.deepEqual(older.items.map(item => (item as { text: string }).text), ['2', '3', '4'])
  assert.equal(older.nextCursor, '2')
  const first = await repository.history('task', 'events', older.nextCursor, 3)
  assert.deepEqual(first.items.map(item => (item as { text: string }).text), ['1'])
  assert.equal(first.nextCursor, undefined)
})
test('normalized detail projects case order, executions and original JSON order with a consistent task lock', async () => {
  const task = taskFixture()
  task.selfTests = [{ id: 'TC-10', title: 'ten', source: '', steps: '', expected: '', status: 'passed', output: 'ok' }, { id: 'TC-2', title: 'two', source: '', steps: '', expected: '', status: 'pending' }]
  task.selfTestArtifacts = []
  task.automationRuns = []
  const fake = fakeSql(sql => {
    if (sql.startsWith('SELECT * FROM codeflow_tasks WHERE')) return [{ id: task.id, owner_id: null, status: task.status, created_at: now, updated_at: now, row_version: 7, body_version: 1, state: storedJson(taskState(task)) }]
    if (sql.startsWith('SELECT * FROM codeflow_test_cases')) return task.selfTests!.map((item, index) => ({ case_id: item.id, ordinal: index + 1, definition_revision: 1, definition_fingerprint: caseDefinition(item).fingerprint, body_version: 1, definition: storedJson(caseDefinition(item).definition) }))
    if (sql.startsWith('SELECT r.*')) return [{ id: 'run', case_id: 'TC-10', executor: 'test', definition_revision: 1, run_seq: 1, body_version: 1, body: storedJson({ status: 'passed', output: 'ok' }) }]
    return undefined
  })
  const loaded = await new MysqlTaskRepository(fake.pool).loadTask(task.id)
  assert.equal(loaded?.version, 7)
  assert.deepEqual(loaded?.task.selfTests, task.selfTests)
  assert.deepEqual(loaded?.task.selfTestArtifacts, [])
  assert.deepEqual(loaded?.task.automationRuns, [])
  assert.equal('_collections' in loaded!.task, false)
  assert.ok(fake.statements[0].sql.endsWith('LOCK IN SHARE MODE'))
  assert.equal(fake.state().commits, 1)
})
test('title-first cases roundtrip exact repair JSON and caseInputs fingerprints without storage metadata', async () => {
  const task = taskFixture()
  task.selfTests = [{
    title: 'title first', status: 'passed', source: 'prd', id: 'TC-1', output: 'proof', steps: 'run', startedAt: now,
    expected: 'ok', evidenceInputFingerprint: hash('input'), finishedAt: now,
    executionBinding: {
      version: 1, caseFingerprint: hash('case'), designFingerprint: hash('design'), testSourceFingerprint: hash('source'),
      testFile: 'sample.spec.ts', testTitle: 'target', project: 'chromium', assertionIds: ['TC-1:A001'],
      approvedBy: 'reviewer', approvedAt: now, reviewedAt: now,
    },
    executionResult: executionResultFixture(),
  }]
  const change = diffTask(undefined, task, 0)
  const writer = fakeSql(sql => sql.startsWith('SELECT definition_revision FROM') ? [{ definition_revision: 1 }] : undefined)
  await new MysqlTaskRepository(writer.pool).commit(change)
  const state = writer.statements.find(item => item.sql.startsWith('INSERT INTO codeflow_tasks'))!.values[6]
  const definition = writer.statements.find(item => item.sql.startsWith('INSERT INTO codeflow_test_cases'))!.values[5]
  const run = writer.statements.find(item => item.sql.startsWith('INSERT INTO codeflow_case_runs'))!.values[13]
  const reorder = (value: unknown): unknown => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, reorder(item)])) : value
  const reader = fakeSql(sql => {
    if (sql.startsWith('SELECT * FROM codeflow_tasks')) return [{ id: task.id, status: task.status, created_at: now, updated_at: now, row_version: 1, body_version: 1, state: reorder(JSON.parse(String(state))) }]
    if (sql.startsWith('SELECT * FROM codeflow_test_cases')) return [{ case_id: 'TC-1', definition_revision: 1, definition_fingerprint: change.cases[0].fingerprint, body_version: 1, definition: reorder(JSON.parse(String(definition))) }]
    if (sql.startsWith('SELECT r.*')) return [{ case_id: 'TC-1', executor: 'test', definition_revision: 1, body_version: 1, body: reorder(JSON.parse(String(run))) }]
    return undefined
  })
  const restored = (await new MysqlTaskRepository(reader.pool).loadTask(task.id))!.task
  assert.equal(JSON.stringify(restored.selfTests), JSON.stringify(task.selfTests))
  assert.equal(JSON.stringify(caseInputs(restored.selfTests!)), JSON.stringify(caseInputs(task.selfTests)))
  assert.equal(fingerprint(caseInputs(restored.selfTests!)), fingerprint(caseInputs(task.selfTests)))
  assert.equal(fingerprint(restored.selfTests), fingerprint(task.selfTests))
  assert.deepEqual(restored.selfTests![0].executionBinding, task.selfTests[0].executionBinding)
  assert.deepEqual(restored.selfTests![0].executionResult, task.selfTests[0].executionResult)
  assert.deepEqual(decode(storedJson(task)), task)
  assert.equal(JSON.stringify(restored).includes('caseKeys'), false)
  assert.equal(JSON.stringify(restored).includes('__codeflow_keys'), false)
  assert.deepEqual(diffTask(task, restored, 1).cases, [])
})
test('detail caps historical generation request scopes before fetching bodies and leaves other artifact consumers intact', async () => {
  const task = taskFixture()
  const requests = Array.from({ length: 80 }, (_, index) => ({ scope_hash: hash(`generation-request:${index}`) })).reverse()
  const retained = requests.slice(0, 32)
  const fake = fakeSql((sql, values) => {
    if (sql.startsWith('SELECT * FROM codeflow_tasks')) return [{ id: task.id, status: task.status, created_at: now, updated_at: now, row_version: 1, body_version: 1, state: storedJson(taskState(task)) }]
    if (sql.startsWith('SELECT scope_hash')) {
      assert.match(sql, /GROUP BY scope_hash ORDER BY MAX\(created_at\) DESC, scope_hash DESC LIMIT 32$/)
      assert.deepEqual(values, [task.id])
      assert.equal(/SELECT \*|output|input_refs/.test(sql), false)
      return retained
    }
    if (sql.startsWith('SELECT a.*')) {
      assert.match(sql, /a.phase <> 'generation' OR a.scope NOT LIKE 'generation-request:%' OR a.scope_hash IN/)
      assert.deepEqual(values, [task.id, ...retained.map(item => item.scope_hash)])
      assert.match(sql, /a.status = 'complete' AND NOT EXISTS/)
    }
    return undefined
  })
  await new MysqlTaskRepository(fake.pool).loadTask(task.id)
  assert.equal(fake.statements.some(item => item.sql.includes('FROM codeflow_acceptance_snapshots')), false)
  await new MysqlTaskRepository(fake.pool).findArtifact(task.id, 'generation', 'generation-request:0', hash('old-input'))
  assert.deepEqual(fake.statements.at(-1)!.values, [task.id, 'generation', hash('generation-request:0'), hash('old-input')])
})
test('readTask skips artifact scopes and model history, filters current case IDs in SQL, and leaves loadTask complete', async () => {
  const task = taskFixture()
  task.selfTests = [{ id: 'TC-1', title: 'current', source: '', steps: '', expected: '', status: 'passed', output: 'proof' }]
  task.automationRuns = [{ caseId: 'B-1', status: 'passed', output: 'browser proof' }]
  task.modelHistory = [{ at: now, from: 'old', to: 'new', revision: 1 }]
  task.selfTestArtifacts = []
  task.acceptanceHistory = []
  task.acceptanceSelectionHistory = []
  const definition = caseDefinition(task.selfTests[0])
  const fake = fakeSql(sql => {
    if (sql.startsWith('SELECT * FROM codeflow_tasks')) return [{ id: task.id, owner_id: 42, status: task.status, created_at: now, updated_at: now, row_version: 7, body_version: 1, state: storedJson(taskState(task)) }]
    if (sql.startsWith('SELECT * FROM codeflow_test_cases')) return [{ case_id: 'TC-1', definition_revision: 1, definition_fingerprint: definition.fingerprint, body_version: 1, definition: storedJson(definition.definition) }]
    if (sql.startsWith('SELECT r.*')) return [
      { case_id: 'TC-1', executor: 'test', definition_revision: 1, body_version: 1, body: storedJson({ status: 'passed', output: 'proof' }) },
      { case_id: 'B-1', executor: 'browser', body_version: 1, body: storedJson({ ...task.automationRuns![0], projectionIndex: 0 }) },
    ]
    if (sql.startsWith('SELECT body, body_version')) return [{ body_version: 1, body: storedJson({ modelIndex: 0, modelChange: task.modelHistory![0] }) }]
    if (sql.includes('FROM codeflow_task_events')) return [{ created_at: now, kind: 'info', body_version: 1, body: storedJson({ text: 'recent' }) }]
    return undefined
  })
  const repository = new MysqlTaskRepository(fake.pool)
  const detail = await repository.readTask(task.id)
  assert.equal(detail?.version, 7)
  assert.equal(detail?.task.ownerId, 42)
  assert.deepEqual(detail?.task.selfTests, task.selfTests)
  assert.deepEqual(detail?.task.automationRuns, task.automationRuns)
  assert.equal(detail?.task.entries[0].text, 'recent')
  for (const key of ['selfTestArtifacts', 'modelHistory', 'acceptanceHistory', 'acceptanceSelectionHistory']) assert.equal(Object.hasOwn(detail!.task, key), false)
  assert.equal(fake.statements.length, 4)
  assert.equal(fake.statements.some(item => /codeflow_self_test_artifacts|codeflow_acceptance_snapshots|SELECT body, body_version/.test(item.sql)), false)
  assert.match(fake.statements[1].sql, /AND NOT JSON_CONTAINS_PATH\(body, 'one', '\$\.modelChange'\).*LIMIT 1000/)
  assert.match(fake.statements[2].sql, /AND case_id IN \(\?\)/)
  assert.deepEqual(fake.statements[2].values, ['task', 'TC-1'])
  assert.match(fake.statements[3].sql, /r.executor = 'test' AND r.case_id IN \(\?\).*r.executor = 'browser' AND r.case_id IN \(\?\)/)
  assert.deepEqual(fake.statements[3].values, ['task', 'TC-1', 'B-1'])
  const full = await repository.loadTask(task.id)
  assert.deepEqual(full?.task.modelHistory, task.modelHistory)
  assert.deepEqual(full?.task.selfTestArtifacts, [])
  assert.deepEqual(full?.task.acceptanceHistory, [])
  assert.deepEqual(full?.task.acceptanceSelectionHistory, [])
  assert.ok(fake.statements.some(item => item.sql.startsWith('SELECT scope_hash')))
  assert.ok(fake.statements.some(item => item.sql.startsWith('SELECT a.*')))
  assert.ok(fake.statements.some(item => item.sql.startsWith('SELECT body, body_version')))
})
test('readTask empty current IDs exclude retired definitions and runs in SQL and preserve null collections', async () => {
  for (const collection of [[], null]) {
    const state = { repository: 'repo', instruction: 'test', prdName: 'prd', designNames: [], _collections: { selfTests: collection === null ? null : true, automationRuns: collection === null ? null : true, caseIds: [], browserCaseIds: [], selfTestArtifacts: null, modelHistory: null, acceptanceHistory: null } }
    const fake = fakeSql(sql => sql.startsWith('SELECT * FROM codeflow_tasks') ? [{ id: 'task', status: 'REVIEW', created_at: now, updated_at: now, row_version: 1, body_version: 1, state: storedJson(state) }] : undefined)
    const detail = await new MysqlTaskRepository(fake.pool).readTask('task')
    assert.deepEqual(detail?.task.selfTests, collection)
    assert.deepEqual(detail?.task.automationRuns, collection)
    assert.match(fake.statements[2].sql, /AND FALSE ORDER BY ordinal/)
    assert.match(fake.statements[3].sql, /r.executor = 'test' AND FALSE.*r.executor = 'browser' AND FALSE/)
    assert.deepEqual(fake.statements[3].values, ['task'])
    assert.equal(Object.hasOwn(detail!.task, 'selfTestArtifacts'), false)
    assert.equal(Object.hasOwn(detail!.task, 'modelHistory'), false)
  }
})
test('readTask handles missing tasks and rolls back failed projections', async () => {
  const missing = fakeSql()
  assert.equal(await new MysqlTaskRepository(missing.pool).readTask('missing'), undefined)
  assert.deepEqual(missing.state(), { commits: 1, rollbacks: 0, releases: 1 })
  const invalid = fakeSql(sql => sql.startsWith('SELECT * FROM codeflow_tasks') ? [{ id: 'task', body_version: 99, state: {} }] : undefined)
  await assert.rejects(new MysqlTaskRepository(invalid.pool).readTask('task'), StorageContractError)
  assert.deepEqual(invalid.state(), { commits: 0, rollbacks: 1, releases: 1 })
})
test('usage and file writes use the exact normalized columns and deduplication keys', async () => {
  const fake = fakeSql()
  const change = diffTask(taskFixture(), taskFixture(), 1)
  change.files.push({ kind: 'evidence', storageKey: 'evidence/task/shot.png', sizeBytes: 100, metadata: { caseId: 'TC-1' } })
  change.usage.push({ turnId: 'turn', sessionId: 'session', model: 'model', phase: 'review', sourceEventId: 'event', observedAt: now, body: { counting: 'incremental', metrics: { inputTokens: 10 } } })
  await new MysqlTaskRepository(fake.pool).commit(change)
  const file = fake.statements.find(item => item.sql.startsWith('INSERT INTO codeflow_task_files'))!
  assert.equal(file.values[4], hash('evidence/task/shot.png'))
  const usage = fake.statements.find(item => item.sql.startsWith('INSERT INTO codeflow_model_usage'))!
  assert.equal(usage.values[7], 'event')
  assert.deepEqual(decode(usage.values[10]), change.usage[0].body)
  assert.ok(usage.sql.includes('ON DUPLICATE KEY UPDATE id = id'))
})
test('file global IDs reject mismatched ownership before upsert and allow the same task and storage key', async () => {
  for (const explicit of [false, true]) {
    for (const mismatch of ['task', 'key', 'none'] as const) {
      let proposedId: unknown
      const fake = fakeSql((sql, values) => {
        if (!sql.startsWith('SELECT task_id, storage_key FROM codeflow_task_files WHERE id')) return undefined
        assert.match(sql, /FOR UPDATE$/)
        proposedId = values[0]
        return [{ task_id: mismatch === 'task' ? 'other-task' : 'task', storage_key: mismatch === 'key' ? 'evidence/other.png' : 'evidence/shot.png' }]
      })
      const change = diffTask(taskFixture(), taskFixture(), 1)
      change.files.push({ ...(explicit ? { id: 'file-id' } : {}), kind: 'evidence', storageKey: 'evidence/shot.png', metadata: { caseId: 'TC-1' } })
      const commit = new MysqlTaskRepository(fake.pool).commit(change)
      if (mismatch === 'none') {
        await commit
        const insert = fake.statements.find(item => item.sql.startsWith('INSERT INTO codeflow_task_files'))!
        assert.equal(insert.values[0], proposedId)
        assert.deepEqual(fake.state(), { commits: 1, rollbacks: 0, releases: 1 })
      } else {
        await assert.rejects(commit, StorageContractError)
        assert.equal(fake.statements.some(item => item.sql.startsWith('INSERT INTO codeflow_task_files')), false)
        assert.deepEqual(fake.state(), { commits: 0, rollbacks: 1, releases: 1 })
      }
      assert.equal(typeof proposedId, 'string')
      if (explicit) assert.equal(proposedId, 'file-id')
    }
  }
})
test('usage global IDs reject mismatched source tuples before deduplication and allow identical retries', async () => {
  for (const explicit of [false, true]) {
    for (const mismatch of ['task', 'session', 'event', 'none'] as const) {
      let proposedId: unknown
      const fake = fakeSql((sql, values) => {
        if (!sql.startsWith('SELECT task_id, session_id, source_event_id FROM codeflow_model_usage WHERE id')) return undefined
        assert.match(sql, /FOR UPDATE$/)
        proposedId = values[0]
        return [{ task_id: mismatch === 'task' ? 'other-task' : 'task', session_id: mismatch === 'session' ? 'other-session' : 'session', source_event_id: mismatch === 'event' ? 'other-event' : 'event' }]
      })
      const change = diffTask(taskFixture(), taskFixture(), 1)
      change.usage.push({ ...(explicit ? { id: 'usage-id' } : {}), sessionId: 'session', phase: 'review', sourceEventId: 'event', observedAt: now, body: { counting: 'incremental' } })
      const commit = new MysqlTaskRepository(fake.pool).commit(change)
      if (mismatch === 'none') {
        await commit
        const insert = fake.statements.find(item => item.sql.startsWith('INSERT INTO codeflow_model_usage'))!
        assert.equal(insert.values[0], proposedId)
        assert.match(insert.sql, /ON DUPLICATE KEY UPDATE id = id$/)
        assert.deepEqual(fake.state(), { commits: 1, rollbacks: 0, releases: 1 })
      } else {
        await assert.rejects(commit, StorageContractError)
        assert.equal(fake.statements.some(item => item.sql.startsWith('INSERT INTO codeflow_model_usage')), false)
        assert.deepEqual(fake.state(), { commits: 0, rollbacks: 1, releases: 1 })
      }
      assert.equal(typeof proposedId, 'string')
      if (explicit) assert.equal(proposedId, 'usage-id')
    }
  }
})
test('runs and frozen plan snapshots bind same-task review artifacts atomically', async () => {
  const fake = fakeSql((sql, values) => sql.startsWith('SELECT id, phase FROM codeflow_self_test_artifacts') ? [{ id: values[1], phase: 'review' }] : sql.startsWith('SELECT definition_revision') ? [{ definition_revision: 1 }] : undefined)
  const task = taskFixture()
  task.selfTests = [{ id: 'TC-1', title: 'case', source: '', steps: '', expected: '', status: 'running', startedAt: now, evidenceInputFingerprint: hash('input') }]
  task.testExecutionPlan = { version: 1, createdAt: now, artifactRefs: ['review-artifact'], cases: [{ caseId: 'TC-1', selected: true, gatePolicy: 'blocking', reason: 'required' }] }
  await new MysqlTaskRepository(fake.pool).commit(diffTask(undefined, task, 0))
  const snapshot = fake.statements.find(item => item.sql.startsWith('INSERT INTO codeflow_acceptance_snapshots'))!
  const run = fake.statements.find(item => item.sql.startsWith('INSERT INTO codeflow_case_runs'))!
  assert.equal(run.values[6], snapshot.values[0])
  assert.equal(run.values[7], 'review-artifact')
  assert.equal(fake.state().commits, 1)
})
test('failure after a child insert rolls back all rows and finalized artifacts cannot be overwritten', async () => {
  const task = taskFixture()
  task.entries = [{ kind: 'info', text: 'event', at: now }]
  const failing = fakeSql(sql => { if (sql.startsWith('UPDATE codeflow_tasks')) throw new Error('database fault'); return undefined })
  await assert.rejects(new MysqlTaskRepository(failing.pool).commit(diffTask(undefined, task, 0)), /transaction failed/)
  assert.equal(failing.state().rollbacks, 1)
  assert.equal(failing.state().commits, 0)
  const artifact = { id: 'artifact', revision: 1, schemaVersion: 1 as const, phase: 'review' as const, scope: 'all', inputFingerprint: hash('input'), inputRefs: [], status: 'running' as const, createdAt: now, model: 'model', rulesVersion: '1' }
  const fake = fakeSql(sql => sql.startsWith('SELECT * FROM codeflow_self_test_artifacts') ? [{ id: 'artifact', revision: 1, phase: 'review', scope: 'all', scope_hash: hash('all'), input_fingerprint: hash('input'), input_refs: [], status: 'complete', created_at: now, finished_at: now, model: 'model', rules_version: '1', body_version: 1, output: null }] : undefined)
  const change = diffTask(taskFixture(), taskFixture(), 1)
  change.artifacts.push(artifact)
  await assert.rejects(new MysqlTaskRepository(fake.pool).commit(change), /immutable/)
  assert.equal(fake.state().commits, 0)
})
test('explicitly clearing the plan never binds evidence to a null plan or falls back to the older plan', async () => {
  const fake = fakeSql(sql => sql.startsWith('SELECT definition_revision') ? [{ definition_revision: 1 }] : undefined)
  const before = taskFixture()
  before.selfTests = [{ id: 'TC-1', title: 'test', source: '', steps: '', expected: '', status: 'pending' }]
  before.testExecutionPlan = { version: 1, createdAt: now, cases: [] }
  const after = structuredClone(before)
  after.testExecutionPlan = undefined
  after.selfTests![0].status = 'manual'
  await new MysqlTaskRepository(fake.pool).commit(diffTask(before, after, 1))
  const run = fake.statements.find(item => item.sql.startsWith('INSERT INTO codeflow_case_runs'))!
  assert.equal(run.values[6], null)
  assert.equal(run.values[7], null)
  assert.equal(fake.statements.some(item => item.sql.startsWith('SELECT id, body, body_version FROM codeflow_acceptance_snapshots')), false)
})
test('SQL list projection matches the shared API summary without loading historical bodies', async () => {
  for (const status of ['pending', 'invalid', 'failed', 'skipped', 'running', 'passed', 'manual'] as const) {
    for (const browser of [false, true]) {
      const task = taskFixture()
      task.workspace = 'private/workspace'
      task.automationUrl = '/automation/task'
      task.selfTests = [{ id: 'TC-1', title: 'Current title', source: '', steps: '', expected: '', status }]
      task.automationRuns = browser ? [{ caseId: 'TC-1', status: 'passed', script: 'private script', output: 'large private output' }] : []
      const fake = fakeSql(sql => {
        if (sql.startsWith('SELECT id, owner_id')) return [{ id: task.id, status: task.status, created_at: now, updated_at: now, row_version: 1, body_version: 1, state: { repository: 'repo', instruction: '', prdName: '', designNames: [] }, has_workspace: 1, has_draft: 0, automation_url: task.automationUrl, collections: JSON.parse(storedJson(taskState(task)._collections)) }]
        if (sql.startsWith('SELECT task_id, case_id')) return [{ task_id: task.id, case_id: 'TC-1', title: 'Current title', definition_revision: 2 }, { task_id: task.id, case_id: 'retired', title: 'Retired', definition_revision: 1 }]
        if (sql.startsWith('SELECT r.task_id')) return [{ task_id: task.id, case_id: 'TC-1', executor: 'test', status, definition_revision: 2 }, ...(browser ? [{ task_id: task.id, case_id: 'TC-1', executor: 'browser', status: 'passed', projection_index: 0 }] : []), { task_id: task.id, case_id: 'retired', executor: 'browser', status: 'failed' }]
        return undefined
      })
      const page = await new MysqlTaskRepository(fake.pool).queryTasks(undefined, undefined, 1)
      assert.deepEqual(taskSummary(page.items[0]), taskSummary(task))
      assert.equal(page.items[0].selfTests, undefined)
      assert.equal(page.items[0].automationRuns, undefined)
      assert.equal(page.items[0].workspace, undefined)
      assert.equal(JSON.stringify(page).includes('private'), false)
      assert.equal(fake.statements.length, 3)
      assert.deepEqual(fake.statements[1].values, ['task'])
      assert.deepEqual(fake.statements[2].values, ['task'])
      assert.ok(fake.statements.every(item => !/SELECT \*|SELECT r\.\*|artifacts|task_events|acceptance_snapshots/.test(item.sql)))
    }
  }
})
test('SQL list allowlists optional runner and execution results across JSON driver representations', async () => {
  for (const metadata of [{}, { runner: 'browser-dsl' as const }, { runner: 'playwright-test' as const }, { executionResult: executionResultFixture() }, { runner: 'playwright-test' as const, executionResult: executionResultFixture() }]) {
    for (const serialized of [false, true]) {
      const task = taskFixture()
      task.selfTests = [{ id: 'TC-1', title: 'Current title', source: '', steps: '', expected: '', status: 'passed' }]
      task.automationRuns = [{ caseId: 'TC-1', status: 'passed', ...metadata, script: 'private script', output: 'private output' }]
      const fake = fakeSql(sql => {
        if (sql.startsWith('SELECT id, owner_id')) return [{ id: task.id, status: task.status, created_at: now, updated_at: now, row_version: 1, body_version: 1, state: { repository: 'repo', instruction: '', prdName: '', designNames: [] } }]
        if (sql.startsWith('SELECT task_id, case_id')) return [{ task_id: task.id, case_id: 'TC-1', title: 'Current title', definition_revision: 1 }]
        if (sql.startsWith('SELECT r.task_id')) return [{
          task_id: task.id, case_id: 'TC-1', executor: 'browser', status: 'passed', projection_index: 0,
          runner: metadata.runner ?? (serialized ? 'null' : null),
          execution_result: serialized ? metadata.executionResult ? storedJson(metadata.executionResult) : 'null' : metadata.executionResult ?? null,
          script: 'private script', output: 'private output', internalFutureField: 'private state',
        }, { task_id: task.id, case_id: 'TC-1', executor: 'test', status: 'passed', definition_revision: 1 }]
        return undefined
      })
      const page = await new MysqlTaskRepository(fake.pool).queryTasks()
      assert.deepEqual(page.items[0].runs, taskSummary(task).runs)
      assert.deepEqual(taskSummary(page.items[0]), taskSummary(task))
      assert.deepEqual(JSON.parse(JSON.stringify(page.items[0].runs)), taskSummary(task).runs)
      assert.doesNotMatch(JSON.stringify(page), /private|script|output|internalFutureField|__codeflow_keys/)
      const sql = fake.statements[2].sql
      assert.match(sql, /JSON_UNQUOTE\(JSON_EXTRACT\(r\.body, '\$\.runner'\)\) AS runner/)
      assert.match(sql, /JSON_EXTRACT\(r\.body, '\$\.executionResult'\) AS execution_result/)
      assert.doesNotMatch(sql, /SELECT \*|r\.\*|(?:SELECT|,)\s+r\.body(?:\s|,|$)|\$\.(?:script|output)/)
    }
  }
})
test('list projection uses current definition revision, empty cases and draft semantics', async () => {
  for (const mode of ['changed-definition', 'empty', 'draft'] as const) {
    const fake = fakeSql(sql => {
      if (sql.startsWith('SELECT id, owner_id')) return [{ id: 'task', status: 'REVIEW', created_at: now, updated_at: now, row_version: 1, body_version: 1, state: { repository: 'repo', instruction: '', prdName: '', designNames: [] }, has_workspace: 0, has_draft: mode === 'draft' ? 1 : 0 }]
      if (sql.startsWith('SELECT task_id, case_id')) return mode === 'empty' ? [] : [{ task_id: 'task', case_id: 'TC-1', title: 'title', definition_revision: 2 }]
      if (sql.startsWith('SELECT r.task_id')) return [{ task_id: 'task', case_id: 'TC-1', executor: 'test', status: 'passed', definition_revision: mode === 'changed-definition' ? 1 : 2 }, { task_id: 'task', case_id: 'TC-1', executor: 'browser', status: 'passed' }]
      return undefined
    })
    const page = await new MysqlTaskRepository(fake.pool).queryTasks()
    assert.equal(page.items[0].runnable, true)
    assert.equal(page.items[0].hasWorkspace, false)
    assert.equal(page.items[0].caseCount, mode === 'empty' ? 0 : 1)
  }
})
test('same attempt finalizes in place but retries and changed bindings preserve previous evidence', async () => {
  for (const mode of ['same', 'started', 'fingerprint', 'definition', 'plan', 'review', 'finished', 'reset'] as const) {
    const before = taskFixture()
    before.selfTests = [{ id: 'TC-1', title: 'case', source: '', steps: '', expected: '', status: 'running', startedAt: now, evidenceInputFingerprint: hash('input') }]
    const after = structuredClone(before)
    Object.assign(after.selfTests![0], { status: mode === 'reset' ? 'pending' : 'passed', finishedAt: now, output: 'new evidence' })
    const fake = fakeSql(sql => {
      if (sql.startsWith('SELECT definition_revision')) return [{ definition_revision: 2 }]
      if (sql.startsWith('SELECT id, input_fingerprint')) return mode === 'finished' ? [] : [{ id: 'old-run', input_fingerprint: hash(mode === 'fingerprint' ? 'old' : 'input'), definition_revision: mode === 'definition' ? 1 : 2, started_at: mode === 'started' ? '2026-10-14T00:00:00.000Z' : now, execution_plan_id: mode === 'plan' ? 'old-plan' : null, review_artifact_id: mode === 'review' ? 'old-review' : null }]
      return undefined
    })
    await new MysqlTaskRepository(fake.pool).commit(diffTask(before, after, 1))
    assert.equal(fake.statements.filter(item => item.sql.startsWith('UPDATE codeflow_case_runs')).length, mode === 'same' ? 1 : 0, mode)
    assert.equal(fake.statements.filter(item => item.sql.startsWith('INSERT INTO codeflow_case_runs')).length, mode === 'same' ? 0 : 1, mode)
    if (mode === 'same') assert.deepEqual(decode(fake.statements.find(item => item.sql.startsWith('UPDATE codeflow_case_runs'))!.values[4]), { status: 'passed', output: 'new evidence', startedAt: now, finishedAt: now, evidenceInputFingerprint: hash('input') })
  }
})
test('actual worker completion changes executor time and late evidence fingerprint without orphaning running attempts', async () => {
  for (const priorFingerprint of [undefined, hash('previous-proof')]) {
    const before = taskFixture()
    before.selfTests = [{ title: 'case', id: 'TC-1', source: '', steps: '', expected: '', status: 'running', startedAt: now, ...(priorFingerprint ? { evidenceInputFingerprint: priorFingerprint } : {}) }]
    const after = structuredClone(before)
    Object.assign(after.selfTests![0], { status: 'passed', startedAt: '2026-10-15T00:00:01.000Z', finishedAt: '2026-10-15T00:00:02.000Z', evidenceInputFingerprint: hash('new-proof'), output: 'passed' })
    const fake = fakeSql(sql => {
      if (sql.startsWith('SELECT definition_revision')) return [{ definition_revision: 1 }]
      if (sql.startsWith('SELECT id, input_fingerprint')) return [{ id: 'attempt', definition_revision: 1, input_fingerprint: priorFingerprint ?? null, started_at: now }]
      return undefined
    })
    const change = diffTask(before, after, 1)
    assert.equal(change.runs[0].continuation, true)
    assert.deepEqual(change.runs[0].continuationFrom, { startedAt: now, inputFingerprint: priorFingerprint })
    await new MysqlTaskRepository(fake.pool).commit(change)
    assert.equal(fake.statements.some(item => item.sql.startsWith('INSERT INTO codeflow_case_runs')), false)
    const update = fake.statements.find(item => item.sql.startsWith('UPDATE codeflow_case_runs'))!
    assert.equal(update.values[5], hash('new-proof'))
    assert.equal(update.values.at(-1), 'attempt')
    const retry = structuredClone(after)
    Object.assign(retry.selfTests![0], { status: 'running', startedAt: '2026-10-15T00:00:03.000Z', finishedAt: undefined })
    assert.equal(diffTask(after, retry, 2).runs[0].continuation, false)
    const changedPlan = { ...after, testExecutionPlan: { version: 1 as const, createdAt: now, cases: [] } }
    assert.equal(diffTask(before, changedPlan, 1).runs[0].continuation, false)
  }
})
test('browser generation and execution finalize the matching case despite worker list reordering and executor timestamps', async () => {
  for (const transition of ['generating-running', 'running-passed', 'generating-blocked', 'running-failed'] as const) {
    const before = taskFixture()
    const generating = transition.startsWith('generating')
    before.automationRuns = [{ caseId: 'TC-1', status: generating ? 'generating' : 'running', startedAt: now, ...(generating ? {} : { inputFingerprint: hash('browser') }) }, { caseId: 'TC-2', status: 'passed' }]
    const after = structuredClone(before)
    after.automationRuns = [after.automationRuns![1], { caseId: 'TC-1', status: transition === 'generating-running' ? 'running' : transition === 'running-passed' ? 'passed' : transition === 'generating-blocked' ? 'blocked' : 'failed', ...(transition === 'generating-running' ? { startedAt: now } : transition === 'running-passed' ? { startedAt: '2026-10-15T00:00:01.000Z', finishedAt: '2026-10-15T00:00:02.000Z' } : { finishedAt: now }), inputFingerprint: hash('browser') }]
    const change = diffTask(before, after, 1)
    assert.equal(change.runs.length, 1)
    assert.equal(change.runs[0].continuation, true)
    const fake = fakeSql(sql => {
      if (sql.startsWith('SELECT definition_revision')) return [{ definition_revision: 1 }]
      if (sql.startsWith('SELECT id, input_fingerprint')) return [{ id: 'browser-attempt', definition_revision: 1, input_fingerprint: generating ? null : hash('browser'), started_at: now }]
      return undefined
    })
    await new MysqlTaskRepository(fake.pool).commit(change)
    assert.equal(fake.statements.some(item => item.sql.startsWith('INSERT INTO codeflow_case_runs')), false, transition)
    assert.equal(fake.statements.find(item => item.sql.startsWith('UPDATE codeflow_case_runs'))!.values.at(-1), 'browser-attempt')
  }
})
test('artifact JSON stays a typed references array and output object with nested key order preserved', async () => {
  const task = taskFixture()
  const output = { content: 'result', writtenFiles: ['z.test.ts', 'a.test.ts'] }
  task.selfTestArtifacts = [{ id: 'artifact', revision: 1, schemaVersion: 1, phase: 'review', scope: 'scope', inputFingerprint: hash('input'), inputRefs: [hash('workspace'), 'previous-artifact'], status: 'complete', createdAt: now, finishedAt: now, model: 'model', rulesVersion: '1', output }]
  const fake = fakeSql((sql, values) => sql.startsWith('SELECT id FROM codeflow_self_test_artifacts') && values[1] === 'previous-artifact' ? [{ id: 'previous-artifact' }] : undefined)
  await new MysqlTaskRepository(fake.pool).commit(diffTask(undefined, task, 0))
  const artifact = fake.statements.find(item => item.sql.startsWith('INSERT INTO codeflow_self_test_artifacts'))!
  const rawRefs = JSON.parse(String(artifact.values[16]))
  assert.ok(Array.isArray(rawRefs))
  assert.deepEqual(rawRefs.map(value => value.kind), ['content_fingerprint', 'artifact'])
  const rawOutput = JSON.parse(String(artifact.values[14]))
  assert.equal(typeof rawOutput, 'object')
  assert.equal(Array.isArray(rawOutput), false)
  assert.equal(JSON.stringify(decode(rawOutput)), JSON.stringify(output))
  assert.deepEqual(decode(rawRefs), [{ kind: 'content_fingerprint', value: hash('workspace') }, { kind: 'artifact', value: 'previous-artifact' }])
})
test('task list cursor keeps timestamp ties exclusive and projects only selected page IDs', async () => {
  const fake = fakeSql(sql => sql.startsWith('SELECT id, owner_id') ? ['c', 'b', 'a'].map(id => ({ id, status: 'REVIEW', created_at: now, updated_at: now, row_version: 1, body_version: 1, state: { repository: 'repo', instruction: '', prdName: '', designNames: [] } })) : undefined)
  const repository = new MysqlTaskRepository(fake.pool)
  const page = await repository.queryTasks(42, undefined, 2)
  assert.deepEqual(page.items.map(item => item.id), ['c', 'b'])
  assert.deepEqual(JSON.parse(Buffer.from(page.nextCursor!, 'base64url').toString()), { at: now, id: 'b' })
  assert.deepEqual(fake.statements[1].values, ['c', 'b'])
  await repository.queryTasks(42, page.nextCursor, 2)
  assert.match(fake.statements[3].sql, /created_at < \? OR \(created_at = \? AND id < \?\)/)
  assert.deepEqual(fake.statements[3].values, [42, new Date(now), new Date(now), 'b', 3])
})
test('restart rewrites only unfinished current runs through the ordered JSON encoder', async () => {
  const task = { ...taskFixture(), status: 'CODING' as const }
  const original = { output: 'partial', status: 'running', nested: { z: 1, a: 2 } }
  const fake = fakeSql(sql => {
    if (sql.startsWith('SELECT id FROM codeflow_tasks')) return [{ id: task.id }]
    if (sql.startsWith('SELECT * FROM codeflow_tasks')) return [{ id: task.id, status: task.status, created_at: now, updated_at: now, row_version: 1, body_version: 1, state: storedJson(taskState(task)) }]
    if (sql.startsWith('SELECT id, body, body_version FROM codeflow_case_runs')) {
      assert.match(sql, /status IN \('running', 'generating'\) AND finished_at IS NULL FOR UPDATE/)
      return [{ id: 'active-run', body_version: 1, body: storedJson(original) }]
    }
    return undefined
  })
  await new MysqlTaskRepository(fake.pool).recoverActive()
  const update = fake.statements.find(item => item.sql.startsWith('UPDATE codeflow_case_runs'))!
  const at = (update.values[0] as Date).toISOString()
  assert.equal(JSON.stringify(decode(update.values[2])), JSON.stringify({ ...original, status: 'failed', finishedAt: at, output: 'Interrupted by restart' }))
  assert.deepEqual(update.values.slice(3), ['task', 'active-run'])
  assert.ok(fake.statements.every(item => !item.sql.includes('JSON_SET') && !item.sql.includes('codeflow_task_events')))
})
test('a retry without timestamps never attaches to an unrelated unfinished attempt', async () => {
  const before = taskFixture()
  before.selfTests = [{ id: 'TC-1', title: 'case', source: '', steps: '', expected: '', status: 'failed', output: 'old proof' }]
  const after = structuredClone(before)
  after.selfTests![0].status = 'running'
  const fake = fakeSql(sql => {
    if (sql.startsWith('SELECT definition_revision')) return [{ definition_revision: 1 }]
    if (sql.startsWith('SELECT id, input_fingerprint')) throw new Error('new attempt must not search for resumable historical runs')
    return undefined
  })
  const change = diffTask(before, after, 1)
  assert.equal(change.runs[0].continuation, false)
  await new MysqlTaskRepository(fake.pool).commit(change)
  assert.equal(fake.statements.filter(item => item.sql.startsWith('INSERT INTO codeflow_case_runs')).length, 1)
  assert.equal(fake.statements.filter(item => item.sql.startsWith('UPDATE codeflow_case_runs')).length, 0)
})

test('detail reads use MySQL 5.7 shared locks for the entire transaction', async () => {
  for (const method of ['loadTask', 'readTask'] as const) {
    for (const mode of ['found', 'missing', 'failure'] as const) {
      const task = taskFixture(), lifecycle: string[] = []
      const fake = fakeSql(sql => {
        lifecycle.push(sql)
        if (sql.startsWith('SELECT * FROM codeflow_tasks')) {
          assert.equal(lifecycle[0], 'begin')
          assert.match(sql, /WHERE id = \? LOCK IN SHARE MODE$/)
          if (mode === 'failure') throw new StorageContractError('read failure')
          if (mode === 'found') return [{ id: task.id, status: task.status, created_at: now, updated_at: now, row_version: 1, body_version: 1, state: storedJson(taskState(task)) }]
        }
        return undefined
      })
      const connection = await fake.pool.getConnection()
      const pool: SqlPool = { ...fake.pool, getConnection: async () => ({
        query: connection.query,
        beginTransaction: async () => { lifecycle.push('begin'); await connection.beginTransaction() },
        commit: async () => { lifecycle.push('commit'); await connection.commit() },
        rollback: async () => { lifecycle.push('rollback'); await connection.rollback() },
        release: () => { lifecycle.push('release'); connection.release() },
      }) }
      const read = new MysqlTaskRepository(pool)[method](task.id)
      if (mode === 'failure') await assert.rejects(read, StorageContractError)
      else assert.equal((await read)?.task.id, mode === 'found' ? task.id : undefined)
      assert.deepEqual(lifecycle.slice(-2), [mode === 'failure' ? 'rollback' : 'commit', 'release'])
      assert.equal(lifecycle.some(item => item.includes('FOR SHARE')), false)
      assert.deepEqual(fake.state(), { commits: mode === 'failure' ? 0 : 1, rollbacks: mode === 'failure' ? 1 : 0, releases: 1 })
    }
  }
})

test('final event, run, snapshot and new-case counters reject overflow and roll back child writes', async () => {
  for (const counter of ['next_event_seq', 'next_run_seq', 'next_snapshot_seq', 'next_case_ordinal'] as const) {
    for (const count of [1, 2]) {
      const change = diffTask(taskFixture(), taskFixture(), 1)
      const fake = fakeSql(sql => {
        if (sql.startsWith('SELECT row_version')) return [{ row_version: 1, next_event_seq: 1, next_run_seq: 1, next_snapshot_seq: 1, next_case_ordinal: 1, [counter]: Number.MAX_SAFE_INTEGER - count + 1 }]
        if (sql.startsWith('SELECT definition_revision FROM')) return [{ definition_revision: 1 }]
        return undefined
      })
      for (let index = 0; index < count; index++) {
        if (counter === 'next_event_seq') change.events.push({ kind: 'info', text: 'event', at: now })
        if (counter === 'next_run_seq') change.runs.push({ id: `run-${index}`, caseId: 'TC-1', executor: 'test', status: 'pending', body: {} })
        if (counter === 'next_snapshot_seq') change.snapshots.push({ id: `snapshot-${index}`, kind: 'baseline', createdAt: now, body: {} })
        if (counter === 'next_case_ordinal') change.cases.push(caseDefinition({ id: `TC-${index}`, title: 'case', source: '', steps: '', expected: '', status: 'pending' }))
      }
      await assert.rejects(new MysqlTaskRepository(fake.pool).commit(change), StorageContractError)
      assert.equal(fake.statements.filter(item => item.sql.startsWith('INSERT INTO')).length, count)
      assert.equal(fake.statements.some(item => item.sql.startsWith('UPDATE codeflow_tasks')), false)
      assert.deepEqual(fake.state(), { commits: 0, rollbacks: 1, releases: 1 })
    }
  }
})

test('case reorder reservations and retained historical ordinals reject overflow', async () => {
  for (const mode of ['reservation', 'retained', 'retained-after-reservation'] as const) {
    const change = diffTask(taskFixture(), taskFixture(), 1)
    change.caseOrder = mode === 'retained' ? [] : ['TC-1', 'TC-2']
    const fake = fakeSql(sql => {
      if (sql.startsWith('SELECT row_version')) return [{ row_version: 1, next_event_seq: 1, next_run_seq: 1, next_snapshot_seq: 1, next_case_ordinal: Number.MAX_SAFE_INTEGER - (mode === 'reservation' ? 1 : mode === 'retained' ? 0 : 2) }]
      if (sql.startsWith('SELECT case_id, ordinal')) return mode === 'reservation' ? [] : [{ case_id: 'retired', ordinal: 1 }]
      if (sql.startsWith('SELECT id FROM codeflow_case_runs')) return [{ id: 'historical-run' }]
      return undefined
    })
    await assert.rejects(new MysqlTaskRepository(fake.pool).commit(change), StorageContractError)
    const updates = fake.statements.filter(item => item.sql.startsWith('UPDATE codeflow_test_cases SET ordinal'))
    assert.deepEqual(updates.map(item => item.values[0]), mode === 'reservation' ? [] : [Number.MAX_SAFE_INTEGER])
    assert.equal(fake.statements.some(item => item.sql.startsWith('UPDATE codeflow_tasks')), false)
    assert.deepEqual(fake.state(), { commits: 0, rollbacks: 1, releases: 1 })
  }
})

test('task version overflow is rejected under the task lock before any child writes', async () => {
  const change = diffTask(taskFixture(), taskFixture(), Number.MAX_SAFE_INTEGER)
  change.events.push({ kind: 'info', text: 'event', at: now })
  const fake = fakeSql(sql => sql.startsWith('SELECT row_version') ? [{ row_version: Number.MAX_SAFE_INTEGER, next_event_seq: 1, next_case_ordinal: 1, next_run_seq: 1, next_snapshot_seq: 1 }] : undefined)
  await assert.rejects(new MysqlTaskRepository(fake.pool).commit(change), StorageContractError)
  assert.equal(fake.statements.length, 1)
  assert.match(fake.statements[0].sql, /FOR UPDATE$/)
  assert.deepEqual(fake.state(), { commits: 0, rollbacks: 1, releases: 1 })
})

test('existing definition revisions must be safe positive integers before SQL increment', async () => {
  for (const value of [0, -1, 1.5, 'not-a-number', Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)]) {
    const change = diffTask(taskFixture(), taskFixture(), 1)
    change.events.push({ kind: 'info', text: 'prior write', at: now })
    change.cases.push(caseDefinition({ id: 'TC-1', title: 'changed', source: '', steps: '', expected: '', status: 'pending' }))
    const fake = fakeSql(sql => sql.startsWith('SELECT definition_revision, definition_fingerprint') ? [{ definition_revision: value, definition_fingerprint: 'old' }] : undefined)
    await assert.rejects(new MysqlTaskRepository(fake.pool).commit(change), StorageContractError)
    assert.match(fake.statements[0].sql, /FOR UPDATE$/)
    assert.ok(fake.statements.some(item => item.sql.startsWith('INSERT INTO codeflow_task_events')))
    assert.equal(fake.statements.some(item => item.sql.startsWith('UPDATE codeflow_test_cases SET definition_revision')), false)
    assert.equal(fake.statements.some(item => item.sql.startsWith('UPDATE codeflow_tasks')), false)
    assert.deepEqual(fake.state(), { commits: 0, rollbacks: 1, releases: 1 })
  }
})

test('recovery rejects task version overflow under its task lock without committing', async () => {
  const task = { ...taskFixture(), status: 'CODING' as const }
  const fake = fakeSql(sql => {
    if (sql.startsWith('SELECT id FROM codeflow_tasks')) return [{ id: task.id }]
    if (sql.startsWith('SELECT * FROM codeflow_tasks')) return [{ id: task.id, status: task.status, created_at: now, updated_at: now, row_version: String(Number.MAX_SAFE_INTEGER), body_version: 1, state: storedJson(taskState(task)) }]
    return undefined
  })
  await assert.rejects(new MysqlTaskRepository(fake.pool).recoverActive(), StorageContractError)
  assert.match(fake.statements[1].sql, /FOR UPDATE$/)
  assert.equal(fake.statements.some(item => item.sql.startsWith('UPDATE')), false)
  assert.deepEqual(fake.state(), { commits: 0, rollbacks: 1, releases: 1 })
})

test('last safe task version and final counters commit exactly with ordered case reservations', async () => {
  const start = Number.MAX_SAFE_INTEGER - 2
  const change = diffTask(taskFixture(), taskFixture(), Number.MAX_SAFE_INTEGER - 1)
  change.caseOrder = ['TC-1', 'TC-2']
  for (const caseId of change.caseOrder) {
    change.events.push({ kind: 'info', text: 'event', at: now })
    change.cases.push(caseDefinition({ id: caseId, title: 'case', source: '', steps: '', expected: '', status: 'pending' }))
    change.runs.push({ id: `run-${caseId}`, caseId, executor: 'test', status: 'pending', body: {} })
    change.snapshots.push({ id: `snapshot-${caseId}`, kind: 'baseline', createdAt: now, body: {} })
  }
  const fake = fakeSql(sql => {
    if (sql.startsWith('SELECT row_version')) return [{ row_version: String(change.expectedVersion), next_event_seq: String(start), next_case_ordinal: String(start), next_run_seq: String(start), next_snapshot_seq: String(start) }]
    if (sql.startsWith('SELECT definition_revision FROM')) return [{ definition_revision: 1 }]
    return undefined
  })
  assert.equal(await new MysqlTaskRepository(fake.pool).commit(change), Number.MAX_SAFE_INTEGER)
  const final = fake.statements.find(item => item.sql.startsWith('UPDATE codeflow_tasks'))!
  assert.match(final.sql, /row_version = row_version \+ 1/)
  assert.deepEqual(final.values.slice(3, 7), Array(4).fill(Number.MAX_SAFE_INTEGER))
  assert.equal(final.values.at(-1), change.expectedVersion)
  for (const [table, index] of [['codeflow_task_events', 1], ['codeflow_test_cases', 2], ['codeflow_case_runs', 3], ['codeflow_acceptance_snapshots', 2]] as const) {
    assert.deepEqual(fake.statements.filter(item => item.sql.startsWith(`INSERT INTO ${table} `)).map(item => item.values[index]), [start, start + 1])
  }
  assert.deepEqual(fake.state(), { commits: 1, rollbacks: 0, releases: 1 })
})

test('new and retained historical cases allocate the last ordinal with a safe successor', async () => {
  for (const retained of [false, true]) {
    const change = diffTask(taskFixture(), taskFixture(), 1)
    if (retained) change.caseOrder = []
    else change.cases.push(caseDefinition({ id: 'TC-1', title: 'case', source: '', steps: '', expected: '', status: 'pending' }))
    const fake = fakeSql(sql => {
      if (sql.startsWith('SELECT row_version')) return [{ row_version: 1, next_event_seq: 1, next_case_ordinal: String(Number.MAX_SAFE_INTEGER - 1), next_run_seq: 1, next_snapshot_seq: 1 }]
      if (sql.startsWith('SELECT case_id, ordinal')) return [{ case_id: 'retired', ordinal: 1 }]
      if (sql.startsWith('SELECT id FROM codeflow_case_runs')) return [{ id: 'historical-run' }]
      return undefined
    })
    assert.equal(await new MysqlTaskRepository(fake.pool).commit(change), 2)
    const allocation = fake.statements.find(item => item.sql.startsWith(retained ? 'UPDATE codeflow_test_cases SET ordinal' : 'INSERT INTO codeflow_test_cases'))!
    assert.equal(allocation.values[retained ? 0 : 2], Number.MAX_SAFE_INTEGER - 1)
    assert.equal(fake.statements.find(item => item.sql.startsWith('UPDATE codeflow_tasks'))!.values[4], Number.MAX_SAFE_INTEGER)
    assert.deepEqual(fake.state(), { commits: 1, rollbacks: 0, releases: 1 })
  }
})

test('definition revisions allow the last safe increment and unchanged exhausted revisions', async () => {
  for (const changed of [true, false]) {
    const change = diffTask(taskFixture(), taskFixture(), 1)
    const definition = caseDefinition({ id: 'TC-1', title: 'case', source: '', steps: '', expected: '', status: 'pending' })
    change.cases.push(definition)
    const fake = fakeSql(sql => sql.startsWith('SELECT definition_revision, definition_fingerprint') ? [{ definition_revision: String(Number.MAX_SAFE_INTEGER - (changed ? 1 : 0)), definition_fingerprint: changed ? hash('old') : definition.fingerprint }] : undefined)
    assert.equal(await new MysqlTaskRepository(fake.pool).commit(change), 2)
    assert.match(fake.statements[0].sql, /FOR UPDATE$/)
    const updates = fake.statements.filter(item => item.sql.startsWith('UPDATE codeflow_test_cases SET definition_revision'))
    assert.equal(updates.length, changed ? 1 : 0)
    if (changed) assert.match(updates[0].sql, /definition_revision = definition_revision \+ 1/)
    assert.deepEqual(fake.state(), { commits: 1, rollbacks: 0, releases: 1 })
  }
})

test('exhausted but unconsumed counters remain valid and unsafe locked counters fail closed', async () => {
  for (const invalidCounter of [undefined, 'next_event_seq', 'next_case_ordinal', 'next_run_seq', 'next_snapshot_seq']) {
    const change = diffTask(taskFixture(), taskFixture(), 1)
    change.caseOrder = []
    const fake = fakeSql(sql => sql.startsWith('SELECT row_version') ? [{ row_version: 1, next_event_seq: Number.MAX_SAFE_INTEGER, next_case_ordinal: Number.MAX_SAFE_INTEGER, next_run_seq: Number.MAX_SAFE_INTEGER, next_snapshot_seq: Number.MAX_SAFE_INTEGER, ...(invalidCounter ? { [invalidCounter]: String(Number.MAX_SAFE_INTEGER + 1) } : {}) }] : undefined)
    const commit = new MysqlTaskRepository(fake.pool).commit(change)
    if (invalidCounter) {
      await assert.rejects(commit, StorageContractError)
      assert.equal(fake.statements.length, 1)
      assert.deepEqual(fake.state(), { commits: 0, rollbacks: 1, releases: 1 })
    } else {
      assert.equal(await commit, 2)
      assert.deepEqual(fake.statements.find(item => item.sql.startsWith('UPDATE codeflow_tasks'))!.values.slice(3, 7), Array(4).fill(Number.MAX_SAFE_INTEGER))
      assert.deepEqual(fake.state(), { commits: 1, rollbacks: 0, releases: 1 })
    }
  }
})