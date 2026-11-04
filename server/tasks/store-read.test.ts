import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CodingTask } from '../../shared/task.js'
import { StorageContractError, type TaskRepository } from '../storage/contracts.js'
import { TaskStore } from './store.js'

const now = '2026-10-15T00:00:00.000Z'
function fixture(): CodingTask {
  return {
    id: 'task', repository: 'repo', instruction: 'committed', prdName: 'prd', designNames: [], status: 'REVIEW', createdAt: now, updatedAt: now,
    entries: [{ at: now, kind: 'info', text: 'event' }],
    selfTests: [{ id: 'TC-1', title: 'test', source: '', steps: '', expected: '', status: 'pending' }],
    modelHistory: [{ at: now, from: 'old', to: 'new', revision: 1 }],
    selfTestArtifacts: [], acceptanceHistory: [], acceptanceSelectionHistory: [],
  }
}
function repository(task: CodingTask) {
  const calls = { read: 0, load: 0, commit: 0 }
  const persistence: TaskRepository = {
    readTask: async id => { calls.read++; return id === task.id ? { task, version: 1 } : undefined },
    loadTask: async id => { calls.load++; return id === task.id ? { task, version: 1 } : undefined },
    queryTasks: async () => ({ items: [] }), history: async () => ({ items: [] }),
    recoverActive: async () => {}, hasBusyTasks: async () => false,
    commit: async change => { calls.commit++; return change.expectedVersion + 1 },
  }
  return { persistence, calls }
}
test('cold readTask is isolated, never populates worker caches, and full loadTask retains AI history', async () => {
  const task = fixture(), fake = repository(task)
  const store = await TaskStore.fromPersistence(fake.persistence)
  const first = await store.readTask(task.id)
  assert.equal(first?.instruction, 'committed')
  assert.deepEqual(first?.selfTests, task.selfTests)
  assert.equal(store.get(task.id), undefined)
  assert.equal(store.committed(task.id), undefined)
  assert.throws(() => store.update(task.id, { instruction: 'mutation' }), /loadTask first/)
  for (const key of ['selfTestArtifacts', 'modelHistory', 'acceptanceHistory', 'acceptanceSelectionHistory']) assert.equal(Object.hasOwn(first!, key), false)
  first!.selfTests![0].title = 'isolated'
  first!.entries[0].text = 'isolated'
  assert.equal((await store.readTask(task.id))?.selfTests?.[0].title, 'test')
  assert.equal((await store.readTask('missing')), undefined)
  assert.deepEqual(fake.calls, { read: 3, load: 0, commit: 0 })
  const full = await store.loadTask(task.id)
  assert.deepEqual(full?.modelHistory, task.modelHistory)
  assert.deepEqual(full?.selfTestArtifacts, [])
  full!.entries[0].text = 'not cached'
  assert.equal(store.get(task.id)?.entries[0].text, 'event')
  await store.readTask(task.id)
  assert.deepEqual(fake.calls, { read: 3, load: 1, commit: 0 })
})
test('warm readTask uses committed state while a worker mutation is pending and strips bodies before cloning', async () => {
  const task = fixture(), fake = repository(task)
  let finish!: (version: number) => void
  fake.persistence.commit = async () => new Promise<number>(resolve => { finish = resolve })
  const store = await TaskStore.fromPersistence(fake.persistence)
  await store.loadTask(task.id)
  store.update(task.id, { instruction: 'uncommitted' })
  await Promise.resolve()
  assert.equal(store.get(task.id)?.instruction, 'uncommitted')
  const cached = (store as unknown as { committedTasks: Map<string, CodingTask> }).committedTasks.get(task.id)!
  for (const key of ['selfTestArtifacts', 'modelHistory', 'acceptanceHistory', 'acceptanceSelectionHistory']) {
    Object.defineProperty(cached, key, { configurable: true, enumerable: true, get: () => { throw new Error('Heavy history accessed') } })
  }
  try {
    const detail = await store.readTask(task.id)
    assert.equal(detail?.instruction, 'committed')
    detail!.entries[0].text = 'isolated'
    assert.equal((await store.readTask(task.id))?.entries[0].text, 'event')
    assert.equal(fake.calls.read, 0)
  } finally {
    finish(2)
    await store.flush()
  }
  assert.equal((await store.readTask(task.id))?.instruction, 'uncommitted')
})
test('repositories without optional readTask never silently invoke full loadTask', async () => {
  const fake = repository(fixture())
  delete fake.persistence.readTask
  const store = await TaskStore.fromPersistence(fake.persistence)
  await assert.rejects(store.readTask('task'), StorageContractError)
  assert.deepEqual(fake.calls, { read: 0, load: 0, commit: 0 })
})
test('legacy persistence readTask projects recent committed entries without losing complete worker state', async () => {
  const task = fixture()
  task.entries = Array.from({ length: 1005 }, (_, index) => ({ at: now, kind: 'info', text: String(index) }))
  const store = await TaskStore.fromPersistence({ load: async () => [task], save: async () => {} })
  const detail = await store.readTask(task.id)
  assert.equal(detail?.entries.length, 1000)
  assert.equal(detail?.entries[0].text, '5')
  assert.equal(detail?.entries.at(-1)?.text, '1004')
  assert.equal(Object.hasOwn(detail!, 'modelHistory'), false)
  detail!.selfTests![0].title = 'isolated'
  assert.equal((await store.readTask(task.id))?.selfTests?.[0].title, 'test')
  assert.equal((await store.loadTask(task.id))?.entries.length, 1005)
  assert.deepEqual((await store.loadTask(task.id))?.modelHistory, task.modelHistory)
  assert.equal(await store.readTask('missing'), undefined)
})
test('cold repository readTask strips heavy properties before clone without full-load access', async () => {
  const task = fixture(), fake = repository(task)
  for (const key of ['selfTestArtifacts', 'modelHistory', 'acceptanceHistory', 'acceptanceSelectionHistory']) {
    Object.defineProperty(task, key, { enumerable: true, get: () => { throw new Error('Heavy history accessed') } })
  }
  const store = await TaskStore.fromPersistence(fake.persistence)
  assert.equal((await store.readTask(task.id))?.entries[0].text, 'event')
  assert.deepEqual(fake.calls, { read: 1, load: 0, commit: 0 })
  assert.equal(store.get(task.id), undefined)
})