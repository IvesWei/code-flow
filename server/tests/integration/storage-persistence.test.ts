import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CodingTask } from '../../../shared/task.js'
import { TaskStorageError, TaskStore, type TaskPersistence } from '../../tasks/store.js'
import { ModelTurn } from '../../execution/model-turn.js'
import { hash, StorageOverloadError, type TaskChange, type TaskRepository } from '../../storage/contracts.js'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function repositoryFake(commit: TaskRepository['commit'] = async change => change.expectedVersion + 1): TaskRepository {
  return { commit, recoverActive: async () => {}, loadTask: async () => undefined, queryTasks: async () => ({ items: [] }), history: async () => ({ items: [] }), hasBusyTasks: async () => false }
}

function task(): CodingTask {
  const now = new Date().toISOString()
  return { id: 'database-task', repository: 'repo', instruction: 'test', prdName: 'prd.md', designNames: [], status: 'REVIEW', createdAt: now, updatedAt: now, entries: [] }
}

test('database persistence loads existing tasks and stores snapshots in mutation order', async () => {
  const writes: CodingTask[][] = []
  const persistence: TaskPersistence = { load: async () => [], save: async (tasks) => { writes.push(tasks) } }
  const store = await TaskStore.fromPersistence(persistence)
  store.create(task())
  store.entry('database-task', 'info', 'first')
  store.update('database-task', { status: 'ACCEPTED' })
  await store.flush()
  assert.deepEqual(writes.map((snapshot) => snapshot[0]?.entries.length), [undefined, 0, 1, 1])
  assert.equal(writes[1][0].status, 'REVIEW')
  assert.equal(writes[3][0].status, 'ACCEPTED')
  const restored = await TaskStore.fromPersistence({ load: async () => writes[3], save: async () => {} })
  assert.equal(restored.get('database-task')?.status, 'ACCEPTED')
})

test('database startup recovers interrupted self tests and persists the recovery', async () => {
  const original = { ...task(), status: 'TEST_EXECUTION' as const, workspace: 'workspace', createdBranch: 'task-branch' }
  let saved: CodingTask[] = []
  const store = await TaskStore.fromPersistence({ load: async () => [original], save: async (tasks) => { saved = tasks } })
  assert.equal(store.get(original.id)?.status, 'REVIEW')
  assert.match(saved[0].selfTestError || '', /中断/)
})

test('database write failure rejects flush and prevents subsequent task mutations', async () => {
  let fail = false
  let writes = 0
  const store = await TaskStore.fromPersistence({ load: async () => [], save: async () => { writes++; if (fail) throw new Error('private connection details') } })
  fail = true
  store.create(task())
  store.update('database-task', { status: 'ACCEPTED' })
  await assert.rejects(store.flush(), TaskStorageError)
  assert.throws(() => store.entry('database-task', 'info', 'later'), TaskStorageError)
  assert.equal(writes, 2)
  await assert.rejects(store.flush(), (error: Error) => !error.message.includes('private'))
})

test('database initialization fails instead of silently falling back to a JSON file', async () => {
  await assert.rejects(TaskStore.fromPersistence({ load: async () => [], save: async () => { throw new Error('offline') } }), TaskStorageError)
})

test('database-backed model requests start only after turn state is persisted', async () => {
  let saved: CodingTask[] = []
  const store = await TaskStore.fromPersistence({ load: async () => [], save: async (tasks) => { saved = tasks } })
  store.create({ ...task(), modelId: 'auto' })
  const turn = new ModelTurn(store, 'database-task', 'auto', { setModel: async () => {} })
  await turn.send(async () => {
    assert.equal(saved[0].modelInTurn, true)
    assert.equal(saved[0].activeModelId, 'auto')
    assert.equal(saved[0].modelTurn?.status, 'running')
    assert.equal(saved[0].entries.at(-1)?.turnEvent, 'start')
  })
  assert.equal(saved[0].modelInTurn, false)
  assert.equal(saved[0].modelTurn?.status, 'completed')
})

test('restart marks an unfinished model request interrupted rather than running', async () => {
  const original = { ...task(), status: 'CODING' as const, modelInTurn: true, modelTurn: { id: 'turn', label: '编码执行', startedAt: task().createdAt, lastActivityAt: task().createdAt, summary: '正在执行 shell', inactivityTimeoutMs: 1200000, status: 'running' as const } }
  const store = await TaskStore.fromPersistence({ load: async () => [original], save: async () => {} })
  assert.equal(store.get(original.id)?.modelTurn?.status, 'interrupted')
  assert.equal(store.get(original.id)?.modelInTurn, false)
})
test('V2 working snapshots remain synchronous while HTTP reads only committed data', async () => {
  let unblock: () => void = () => {}
  const gate = new Promise<void>(resolve => { unblock = resolve })
  const changes: TaskChange[] = []
  const store = await TaskStore.fromPersistence(repositoryFake(async change => { changes.push(change); await gate; return change.expectedVersion + 1 }))
  const original = task()
  store.create(original)
  original.instruction = 'outside mutation'
  store.update(original.id, { instruction: 'pending' })
  assert.equal(store.get(original.id)?.instruction, 'pending')
  assert.equal(store.committed(original.id), undefined)
  assert.equal(await store.loadTask(original.id), undefined)
  unblock()
  await store.flush()
  assert.equal(store.committed(original.id)?.instruction, 'pending')
  store.get(original.id)!.entries.push({ kind: 'error', text: 'mutated', at: original.createdAt })
  store.committed(original.id)!.instruction = 'polluted'
  assert.equal(store.get(original.id)?.entries.length, 0)
  assert.equal(store.committed(original.id)?.instruction, 'pending')
  assert.deepEqual(changes.map(change => change.expectedVersion), [0, 1])
})
test('queue admission caps both operation count and bytes before mutating working state', async () => {
  let unblock: () => void = () => {}
  const gate = new Promise<void>(resolve => { unblock = resolve })
  const store = await TaskStore.fromPersistence(repositoryFake(async change => { await gate; return change.expectedVersion + 1 }))
  store.create(task())
  for (let index = 1; index < 200; index++) store.entry(task().id, 'info', `entry ${index}`)
  assert.equal(store.queueSize.operations, 200)
  assert.throws(() => store.entry(task().id, 'info', 'overflow'), StorageOverloadError)
  assert.equal(store.get(task().id)?.entries.length, 199)
  assert.equal(store.queueSize.operations, 200)
  unblock(); await store.flush()
  assert.deepEqual(store.queueSize, { operations: 0, bytes: 0 })
  const bytes = await TaskStore.fromPersistence(repositoryFake(), { bytes: 100 })
  assert.throws(() => bytes.create(task()), StorageOverloadError)
  assert.equal(bytes.get(task().id), undefined)
})
test('repository startup is lazy, detail reads deduplicate and release drops full cache', async () => {
  let recoveries = 0, loads = 0
  const fake = repositoryFake()
  fake.recoverActive = async () => { recoveries++ }
  fake.loadTask = async () => { loads++; return { task: task(), version: 4 } }
  const store = await TaskStore.fromPersistence(fake)
  assert.equal(recoveries, 1)
  assert.equal(loads, 0)
  await Promise.all([store.loadTask(task().id), store.loadTask(task().id)])
  assert.equal(loads, 1)
  const cached = await store.loadTask(task().id)
  cached!.entries.push({ kind: 'error', text: 'external mutation', at: cached!.createdAt })
  cached!.instruction = 'external mutation'
  assert.equal(store.committed(task().id)?.instruction, 'test')
  assert.deepEqual(store.committed(task().id)?.entries, [])
  store.entry(task().id, 'info', 'versioned')
  await store.flush()
  await store.release(task().id)
  assert.equal(store.get(task().id), undefined)
  await store.loadTask(task().id)
  assert.equal(loads, 2)
})
test('32 active cached tasks cannot evict the terminal task currently being loaded', async () => {
  const fake = repositoryFake()
  fake.loadTask = async id => ({ task: { ...task(), id, status: id.startsWith('active') ? 'CODING' : 'REVIEW' }, version: 1 })
  const store = await TaskStore.fromPersistence(fake)
  for (let index = 0; index < 32; index++) await store.loadTask(`active-${index}`)
  const [first, second] = await Promise.all([store.loadTask('terminal'), store.loadTask('terminal')])
  assert.equal(first?.id, 'terminal')
  assert.equal(second?.id, 'terminal')
  first!.instruction = 'external'
  assert.equal(second!.instruction, 'test')
  assert.equal(store.get('terminal')?.instruction, 'test')
  await store.loadTask('next-terminal')
  assert.equal(store.get('terminal'), undefined)
  assert.equal(store.get('active-0')?.status, 'CODING')
  assert.equal(store.get('next-terminal')?.id, 'next-terminal')
})
test('JSON worker completions close running history in place while actual retries remain separate', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'store-attempt-'))
  try {
    const file = join(directory, 'tasks.json')
    const store = new TaskStore(file)
    const original = task()
    original.selfTests = [{ title: 'case', id: 'TC-1', source: '', steps: '', expected: '', status: 'pending' }]
    store.create(original)
    for (let attempt = 0; attempt < 2; attempt++) {
      const startedAt = `2026-10-15T00:00:0${attempt * 3}.000Z`
      store.update(original.id, { selfTests: [{ ...store.get(original.id)!.selfTests![0], status: 'running', startedAt, finishedAt: undefined }] })
      store.update(original.id, { selfTests: [{ ...store.get(original.id)!.selfTests![0], status: attempt ? 'passed' : 'failed', startedAt: `2026-10-15T00:00:0${attempt * 3 + 1}.000Z`, finishedAt: `2026-10-15T00:00:0${attempt * 3 + 2}.000Z`, evidenceInputFingerprint: hash(`proof-${attempt}`) }] })
    }
    const restored = new TaskStore(file)
    const history = await restored.history(original.id, 'runs')
    assert.deepEqual(history.items.map(item => (item as { status: string }).status), ['failed', 'passed'])
    assert.notEqual((history.items[0] as { id: string }).id, (history.items[1] as { id: string }).id)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
test('a failed V2 write invalidates working cache without leaking pending changes to HTTP', async () => {
  let fail = false
  const store = await TaskStore.fromPersistence(repositoryFake(async change => { if (fail) throw new Error('secret database error'); return change.expectedVersion + 1 }))
  store.create(task()); await store.flush()
  fail = true
  store.update(task().id, { instruction: 'not committed' })
  await assert.rejects(store.flush(), TaskStorageError)
  assert.equal(store.get(task().id), undefined)
  assert.equal(store.committed(task().id)?.instruction, 'test')
  assert.throws(() => store.update(task().id, { instruction: 'later' }), TaskStorageError)
})
test('JSON history retains more than 1000 events, previous attempts, snapshots and metadata across reload', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'storage-v2-json-'))
  const file = join(directory, 'tasks.json')
  try {
    const store = new TaskStore(file)
    const original = task()
    original.entries = Array.from({ length: 1000 }, (_, index) => ({ kind: 'info' as const, text: `before-${index}`, at: original.createdAt }))
    original.selfTests = [{ id: 'TC-2', title: 'test', source: '', steps: '', expected: '', status: 'failed', output: 'first failure' }]
    store.create(original)
    store.update(original.id, { selfTests: original.selfTests.map(test => ({ ...test, status: 'passed', output: 'second success' })) })
    store.update(original.id, { acceptanceSelection: { mode: 'custom', caseIds: ['TC-2'], reason: 'explicit', confirmedAt: original.createdAt } })
    store.entry(original.id, 'info', 'after-1000')
    store.recordUsage(original.id, { sessionId: 'session', phase: 'coding', sourceEventId: 'event', observedAt: original.createdAt, body: { counting: 'cumulative', metrics: { inputTokens: 10 } } })
    store.recordUsage(original.id, { sessionId: 'session', phase: 'coding', sourceEventId: 'event', observedAt: original.createdAt, body: { counting: 'cumulative', metrics: { inputTokens: 10 } } })
    store.recordFile(original.id, { kind: 'session_manifest', storageKey: 'sessions/task/manifest.json', metadata: { directory: true } })
    const restored = new TaskStore(file)
    assert.equal(restored.get(original.id)?.entries.length, 1000)
    const first = await restored.history(original.id, 'events', undefined, 1000)
    assert.equal(first.items.length, 1000)
    assert.equal(first.nextCursor, '2')
    assert.equal((first.items[0] as { text: string }).text, 'before-1')
    assert.equal((first.items.at(-1) as { text: string }).text, 'after-1000')
    restored.entry(original.id, 'info', 'new-after-page')
    const older = await restored.history(original.id, 'events', first.nextCursor)
    assert.deepEqual(older.items.map(item => (item as { text: string }).text), ['before-0'])
    assert.equal(older.nextCursor, undefined)
    await assert.rejects(restored.history(original.id, 'events', '0'))
    await assert.rejects(restored.history(original.id, 'events', '1e2'))
    assert.equal((await restored.history(original.id, 'runs')).items.length, 2)
    assert.equal((await restored.history(original.id, 'snapshots')).items.length, 1)
    const stored = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(stored.bodyVersion, 1)
    assert.equal(stored.usage[0][1].length, 1)
    assert.equal(stored.files[0][1][0].kind, 'session_manifest')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
test('legacy fake history initialization appends each event once rather than duplicating the committed event', async () => {
  const store = await TaskStore.fromPersistence({ load: async () => [task()], save: async () => {} })
  store.entry(task().id, 'info', 'single event')
  await store.flush()
  assert.equal((await store.history(task().id, 'events')).items.length, 1)
})
test('new artifacts continue the highest persisted revision even when detail omitted older history', async () => {
  const original = task()
  original.selfTestArtifacts = [{ id: 'old', revision: 8, schemaVersion: 1, phase: 'review', scope: 'all', inputFingerprint: hash('old'), inputRefs: [], status: 'complete', createdAt: original.createdAt, finishedAt: original.createdAt, model: 'model', rulesVersion: 'rules' }]
  const fake = repositoryFake()
  fake.loadTask = async () => ({ task: original, version: 3 })
  const changes: TaskChange[] = []
  fake.commit = async change => { changes.push(change); return change.expectedVersion + 1 }
  const store = await TaskStore.fromPersistence(fake)
  await store.loadTask(original.id)
  const updated = store.update(original.id, { selfTestArtifacts: [...original.selfTestArtifacts, { ...original.selfTestArtifacts[0], id: 'new', revision: 2, status: 'running', finishedAt: undefined }] })
  await store.flush()
  assert.equal(updated.selfTestArtifacts?.at(-1)?.revision, 9)
  assert.equal(changes[0].artifacts[0].revision, 9)
})
test('JSON listing projects only the owner page without cloning any full task collection', async context => {
  const originals = Array.from({ length: 5 }, (_, index) => ({ ...task(), id: `task-${index}`, ownerId: index === 0 ? 2 : 1, workspace: 'private/workspace', selfTestDraft: 'private draft' }))
  const store = await TaskStore.fromPersistence({ load: async () => originals, save: async () => {} })
  const clone = structuredClone
  let clones = 0
  context.mock.method(globalThis, 'structuredClone', (value: unknown) => { clones++; return clone(value) })
  const page = await store.queryTasks(1, undefined, 2)
  assert.equal(page.items.length, 2)
  assert.equal(clones, 0)
  assert.deepEqual(page.items.map(item => item.id), ['task-4', 'task-3'])
  assert.equal(page.nextCursor, 'task-3')
  assert.equal(page.items[0].hasWorkspace, true)
  assert.equal(page.items[0].runnable, true)
  assert.equal(JSON.stringify(page).includes('private'), false)
  page.items[0].runs!.push({ caseId: 'outside', title: 'outside', status: 'passed' })
  assert.deepEqual((await store.queryTasks(1, undefined, 2)).items[0].runs, [])
})