import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ModelInfo } from '@github/copilot-sdk'
import { ModelTurn } from './model-turn.js'
import { defaultModel, validateModel } from './models.js'
import { TaskStore } from '../tasks/store.js'
import { SessionProgressTimeout } from './session-progress.js'

const models = [
  { id: 'text', name: 'Text', capabilities: { supports: { vision: false, reasoningEffort: false }, limits: { max_context_window_tokens: 128000 } }, policy: { state: 'enabled', terms: '' } },
  { id: 'vision', name: 'Vision', capabilities: { supports: { vision: true, reasoningEffort: false }, limits: { max_context_window_tokens: 128000 } } },
  { id: 'blocked', name: 'Blocked', capabilities: { supports: { vision: true, reasoningEffort: false }, limits: { max_context_window_tokens: 128000 } }, policy: { state: 'disabled', terms: '' } },
] as ModelInfo[]

test('the administrator default is used for new tasks, with auto as the fallback', () => {
  const previous = process.env.COPILOT_MODEL
  try {
    delete process.env.COPILOT_MODEL
    assert.equal(defaultModel(), 'auto')
    process.env.COPILOT_MODEL = ' vision '
    assert.equal(defaultModel(), 'vision')
  } finally {
    if (previous === undefined) delete process.env.COPILOT_MODEL
    else process.env.COPILOT_MODEL = previous
  }
})

test('explicit models are checked against account policy and image capabilities', () => {
  assert.equal(validateModel('auto', [], true), 'auto')
  assert.equal(validateModel('vision', models, true), 'vision')
  assert.equal(validateModel('text', models, false), 'text')
  assert.throws(() => validateModel('text', models, true), /不支持设计截图/)
  assert.throws(() => validateModel('blocked', models, false), /不可使用/)
  assert.throws(() => validateModel('invented', models, false), /不可使用/)
})

test('a switch during a turn affects the following turn and keeps the latest revision', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-flow-model-'))
  try {
    const store = new TaskStore(join(directory, 'tasks.json'))
    const now = new Date().toISOString()
    store.create({ id: 'task', repository: 'https://github.com/a/b', instruction: 'Fix', prdName: 'prd.md', designNames: [], modelId: 'text', modelRevision: 0, appliedModelRevision: 0, status: 'CODING', entries: [], createdAt: now, updatedAt: now })
    const switches: string[] = []
    const turns = new ModelTurn(store, 'task', 'text', { async setModel(model) { switches.push(model) } })
    let finish!: () => void
    const first = turns.send(() => new Promise<void>((resolve) => { finish = resolve }))
    assert.equal(store.get('task')?.modelInTurn, true)
    assert.equal(store.get('task')?.modelTurn?.status, 'running')
    assert.equal(store.get('task')?.entries.at(-1)?.turnEvent, 'start')
    store.update('task', { modelId: 'vision', modelRevision: 1 })
    store.update('task', { modelId: 'auto', modelRevision: 2 })
    assert.equal(store.get('task')?.activeModelId, 'text')
    finish()
    await first
    assert.equal(store.get('task')?.modelInTurn, false)
    assert.equal(store.get('task')?.modelTurn?.status, 'completed')
    await turns.send(async () => { assert.equal(store.get('task')?.activeModelId, 'auto') })
    assert.deepEqual(switches, ['auto'])
    assert.equal(store.get('task')?.appliedModelRevision, 2)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('a rejected model switch does not send another message on the old model', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-flow-model-'))
  try {
    const store = new TaskStore(join(directory, 'tasks.json'))
    const now = new Date().toISOString()
    store.create({ id: 'task', repository: 'https://github.com/a/b', instruction: 'Fix', prdName: 'prd.md', designNames: [], modelId: 'vision', modelRevision: 1, status: 'CODING', entries: [], createdAt: now, updatedAt: now })
    const turns = new ModelTurn(store, 'task', 'text', { async setModel() { throw new Error('Model unavailable') } })
    let sent = false
    await assert.rejects(turns.send(async () => { sent = true }), /Model unavailable/)
    assert.equal(sent, false)
    assert.notEqual(store.get('task')?.activeModelId, 'vision')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('a newer choice arriving while the SDK switches wins before sending', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-flow-model-'))
  try {
    const store = new TaskStore(join(directory, 'tasks.json'))
    const now = new Date().toISOString()
    store.create({ id: 'task', repository: 'https://github.com/a/b', instruction: 'Fix', prdName: 'prd.md', designNames: [], modelId: 'vision', modelRevision: 1, status: 'CODING', entries: [], createdAt: now, updatedAt: now })
    const switches: string[] = []
    let release!: () => void
    let waiting!: () => void
    const firstSwitch = new Promise<void>((resolve) => { waiting = resolve })
    const turns = new ModelTurn(store, 'task', 'text', { async setModel(model) {
      switches.push(model)
      if (model === 'vision') { waiting(); await new Promise<void>((resolve) => { release = resolve }) }
    } })
    const sent = turns.send(async () => store.get('task')?.activeModelId)
    await firstSwitch
    store.update('task', { modelId: 'auto', modelRevision: 2 })
    release()
    assert.equal(await sent, 'auto')
    assert.deepEqual(switches, ['vision', 'auto'])
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('a timed-out turn retains its last activity and correlated outcome after reload', async () => {
  let saved: import('../../shared/task.js').CodingTask[] = []
  const store = await TaskStore.fromPersistence({ load: async () => [], save: async (tasks) => { saved = tasks } })
  const now = new Date().toISOString()
  store.create({ id: 'timeout', repository: 'repo', instruction: 'code', prdName: 'prd.md', designNames: [], status: 'CODING', entries: [], createdAt: now, updatedAt: now })
  const turn = new ModelTurn(store, 'timeout', 'auto', { setModel: async () => {} })
  const progress = { lastActivityAt: now, summary: '正在执行 shell · npm test' }
  await assert.rejects(turn.send(async (report) => {
    report(progress)
    throw new SessionProgressTimeout(1200000, progress)
  }, '编码执行', { firstResponseMs: 600000, inactivityMs: 300000 }), SessionProgressTimeout)
  assert.equal(store.get('timeout')!.modelInTurn, false)
  assert.equal(saved[0].modelTurn?.status, 'timed_out')
  assert.equal(saved[0].modelTurn?.summary, progress.summary)
  assert.equal(saved[0].modelTurn?.firstResponseTimeoutMs, 600000)
  assert.equal(saved[0].modelTurn?.inactivityTimeoutMs, 300000)
  assert.match(saved[0].entries[0].detail!, /首次响应超时：600 秒/)
  const [start, finish] = saved[0].entries
  assert.equal(start.turnId, finish.turnId)
  assert.equal(finish.turnEvent, 'complete')
  assert.match(finish.detail!, /npm test/)
  const restored = await TaskStore.fromPersistence({ load: async () => saved, save: async () => {} })
  assert.equal(restored.get('timeout')!.modelTurn?.status, 'timed_out')
})