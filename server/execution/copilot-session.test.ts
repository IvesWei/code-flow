import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CopilotClient, ResumeSessionConfig, SessionConfig } from '@github/copilot-sdk'
import { openTaskSession, SessionRestoreError } from './copilot-session.js'
import { TaskStorageError, TaskStore } from '../tasks/store.js'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

async function setup() {
  const store = await TaskStore.fromPersistence({ load: async () => [], save: async () => {} })
  const now = new Date().toISOString()
  store.create({ id: 'task', repository: 'repo', instruction: '', prdName: 'prd.md', designNames: [], status: 'REVIEW', createdAt: now, updatedAt: now, entries: [] })
  let creates = 0, resumes = 0
  const config: SessionConfig = { onPermissionRequest: () => ({ kind: 'approve-once' }) }
  const client = {
    createSession: async () => { creates++; return { sessionId: `session-${creates}` } },
    resumeSession: async (id: string, options: ResumeSessionConfig) => { resumes++; assert.equal(options.continuePendingWork, false); assert.equal(options.onPermissionRequest, config.onPermissionRequest); return { sessionId: id } },
  } as unknown as Pick<CopilotClient, 'createSession' | 'resumeSession'>
  return { store, config, client, counts: () => ({ creates, resumes }) }
}

test('new sessions are saved and continued tasks resume the same SDK session', async () => {
  const state = await setup()
  await openTaskSession(state.client, state.store, 'task', '/sessions/task', state.config, false)
  assert.equal(state.store.get('task')?.copilotSession?.id, 'session-1')
  const resumed = await openTaskSession(state.client, state.store, 'task', '/sessions/task', state.config, true)
  assert.equal(resumed.restored, true)
  assert.deepEqual(state.counts(), { creates: 1, resumes: 1 })
})

test('missing, failed or mismatched sessions never silently create a replacement', async () => {
  const state = await setup()
  await assert.rejects(openTaskSession(state.client, state.store, 'task', '/sessions/task', state.config, true), SessionRestoreError)
  await openTaskSession(state.client, state.store, 'task', '/sessions/task', state.config, false)
  await assert.rejects(openTaskSession(state.client, state.store, 'task', '/other', state.config, true), SessionRestoreError)
  state.client.resumeSession = async () => { throw new Error('unavailable') }
  await assert.rejects(openTaskSession(state.client, state.store, 'task', '/sessions/task', state.config, true), SessionRestoreError)
  assert.equal(state.counts().creates, 1)
  await openTaskSession(state.client, state.store, 'task', '/sessions/task', state.config, true, true)
  assert.equal(state.store.get('task')?.copilotSession?.id, 'session-2')
  assert.deepEqual(state.store.get('task')?.copilotSession?.previousIds, ['session-1'])
})

test('a restarted store restores the persisted SDK session association', async () => {
  const state = await setup()
  await openTaskSession(state.client, state.store, 'task', '/sessions/task', state.config, false)
  const persisted = structuredClone(state.store.list())
  const reloaded = await TaskStore.fromPersistence({ load: async () => persisted, save: async () => {} })
  const restored = await openTaskSession(state.client, reloaded, 'task', '/sessions/task', state.config, true)
  assert.equal(restored.session.sessionId, 'session-1')
  assert.deepEqual(state.counts(), { creates: 1, resumes: 1 })
})

test('session persistence failure prevents returning a session to the worker', async () => {
  let fail = false, disconnected = false
  const store = await TaskStore.fromPersistence({ load: async () => [], save: async () => { if (fail) throw new Error('offline') } })
  const state = await setup()
  store.create(structuredClone(state.store.get('task')!))
  await store.flush()
  fail = true
  const client = { createSession: async () => ({ sessionId: 'new-id', disconnect: async () => { disconnected = true } }) } as unknown as Pick<CopilotClient, 'createSession' | 'resumeSession'>
  await assert.rejects(openTaskSession(client, store, 'task', '/sessions/task', state.config, false), TaskStorageError)
  assert.equal(disconnected, true)
})

test('known SDK restore errors are explained without exposing raw error secrets', async () => {
  const state = await setup()
  await openTaskSession(state.client, state.store, 'task', '/sessions/task', state.config, false)
  state.client.resumeSession = async () => { throw new Error('Session was not created with authentication info secret-token') }
  await assert.rejects(openTaskSession(state.client, state.store, 'task', '/sessions/task', state.config, true), error => {
    assert.ok(error instanceof SessionRestoreError)
    assert.match(error.message, /会话认证缺失/)
    assert.ok(!error.message.includes('secret-token'))
    return true
  })
  state.client.resumeSession = async () => { throw new Error('Session not found: private-session') }
  await assert.rejects(openTaskSession(state.client, state.store, 'task', '/sessions/task', state.config, true), /SDK 未找到/)
  assert.equal(state.counts().creates, 1)
})

test('attachment parser failure repairs backed-up history and retries the same session once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codeflow-resume-repair-'))
  try {
    const state = await setup()
    await openTaskSession(state.client, state.store, 'task', directory, state.config, false)
    const sessionDirectory = join(directory, 'session-state', 'session-1')
    await mkdir(sessionDirectory, { recursive: true })
    const file = join(sessionDirectory, 'events.jsonl')
    await writeFile(file, JSON.stringify({ type: 'user.message', data: { attachments: [{ type: 'file', path: '/uploads/prd.md' }] } }))
    let attempts = 0
    state.client.resumeSession = async (id, config) => {
      attempts++
      assert.equal(id, 'session-1')
      assert.equal(config.continuePendingWork, false)
      if (attempts === 1) throw new Error('Failed to read JSONL: Invalid event at line 11: data did not match any variant of untagged enum Attachment')
      assert.equal(JSON.parse(await readFile(file, 'utf8')).data.attachments[0].displayName, 'prd.md')
      return { sessionId: id } as Awaited<ReturnType<CopilotClient['resumeSession']>>
    }
    assert.equal((await openTaskSession(state.client, state.store, 'task', directory, state.config, true)).restored, true)
    assert.equal(attempts, 2)
    assert.equal(state.counts().creates, 1)
    assert.ok(state.store.get('task')!.entries.some(entry => entry.text.includes('已备份 SDK 历史')))
  } finally { await rm(directory, { recursive: true, force: true }) }
})