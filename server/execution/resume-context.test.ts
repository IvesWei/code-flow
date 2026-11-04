import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import type { CodingTask } from '../../shared/task.js'
import { resumeContext } from './resume-context.js'
import { CodingWorker } from './worker.js'
import { TaskStore } from '../tasks/store.js'
import { CopilotClient } from '@github/copilot-sdk'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const now = new Date().toISOString()
const task: CodingTask = { id: 'resume', repository: 'repo', instruction: '登录', prdName: 'prd.md', designNames: [], status: 'NEEDS_INPUT', createdAt: now, updatedAt: now, entries: [], question: { text: '采用哪种登录方式？', allowFreeform: true } }

function workerFixture(context: TestContext, prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'workspaces', task.id), { recursive: true })
  const prdPath = join(root, 'prd.md')
  writeFileSync(prdPath, '# Login requirements\nImplement login.\n')
  return { root, prdPath }
}

test('resume context includes confirmed questions, answers and legacy guidance', () => {
  const content = resumeContext({ ...task, confirmedDecisions: [{ at: now, question: '采用哪种登录方式？', answer: '短信验证码', stage: 'CODING' }], entries: [{ at: now, kind: 'answer', text: '保留已有注册页面' }, { at: now, kind: 'agent', text: '已实现验证码表单' }] })
  for (const text of ['采用哪种登录方式', '短信验证码', '保留已有注册页面', '已实现验证码表单', '不要重复询问']) assert.ok(content.includes(text))
})

test('answer persists the question and decision before resolving model input and survives reload', async () => {
  let saved: CodingTask[] = []
  const store = await TaskStore.fromPersistence({ load: async () => [], save: async (tasks) => { saved = tasks } })
  store.create(structuredClone(task))
  const worker = new CodingWorker(store, 'unused')
  let resolved = false
  const pending = (worker as unknown as { pending: Map<string, unknown> }).pending
  pending.set(task.id, { stage: 'CODING', resolve: () => { resolved = true }, reject: () => {} })
  assert.equal(worker.answer(task.id, '短信验证码'), true)
  await store.flush()
  await Promise.resolve()
  assert.equal(resolved, true)
  assert.equal(saved[0].confirmedDecisions?.[0].question, task.question?.text)
  const restored = await TaskStore.fromPersistence({ load: async () => saved, save: async () => {} })
  assert.ok(resumeContext(restored.get(task.id)!).includes('短信验证码'))
})

test('explicit fallback sends persisted decisions to the newly created model session', async (context) => {
  const { root, prdPath } = workerFixture(context, 'codeflow-fallback-')
  const store = await TaskStore.fromPersistence({ load: async () => [], save: async () => {} })
  store.create({ ...structuredClone(task), status: 'FAILED', confirmedDecisions: [{ at: now, question: '采用哪种登录方式？', answer: '短信验证码', stage: 'CODING' }] })
  let prompt = ''
  let sends = 0
  const session = {
    sessionId: 'test-session',
    on: () => () => {}, setModel: async () => {}, abort: async () => {}, disconnect: async () => {},
    send: async (options: { prompt: string; attachments: { path: string; displayName?: string }[] }) => {
      sends++
      assert.equal(options.attachments[0].path, prdPath)
      assert.equal(options.attachments[0].displayName, 'prd.md')
      prompt = options.prompt
      throw new Error('test stops before code execution')
    },
  }
  context.mock.method(CopilotClient.prototype, 'createSession', async (config: import('@github/copilot-sdk').SessionConfig) => {
    assert.equal(config.gitHubToken, 'test-token')
    return session
  })
  context.mock.method(CopilotClient.prototype, 'stop', async () => [])
  await new CodingWorker(store, root).execute(store.get(task.id)!, prdPath, [], 'test-token', '继续完成验证码页面', false, true)
  assert.equal(sends, 1)
  assert.ok(prompt.includes('采用哪种登录方式'))
  assert.ok(prompt.includes('短信验证码'))
  assert.ok(prompt.includes('继续完成验证码页面'))
  assert.ok(prompt.includes('不要重复询问'))
})

test('continuing worker resumes the original session with guards and without a reconstructed summary', async (context) => {
  const { root, prdPath } = workerFixture(context, 'codeflow-resume-')
  const store = await TaskStore.fromPersistence({ load: async () => [], save: async () => {} })
  store.create({ ...structuredClone(task), status: 'FAILED', copilotSession: { id: 'original-id', directory: join(root, 'sessions', task.id) }, confirmedDecisions: [{ at: now, question: '采用哪种登录方式？', answer: '短信验证码', stage: 'CODING' }] })
  let prompt = '', creates = 0, sends = 0
  const session = { sessionId: 'original-id', on: () => () => {}, setModel: async () => {}, abort: async () => {}, disconnect: async () => {}, send: async (options: { prompt: string }) => { sends++; prompt = options.prompt; throw new Error('stop before code execution') } }
  context.mock.method(CopilotClient.prototype, 'createSession', async () => { creates++; throw new Error('must not create') })
  context.mock.method(CopilotClient.prototype, 'resumeSession', async (id: string, config: import('@github/copilot-sdk').ResumeSessionConfig) => {
    assert.equal(id, 'original-id')
    assert.equal(config.gitHubToken, 'test-token')
    assert.equal(config.continuePendingWork, false)
    assert.equal(typeof config.onUserInputRequest, 'function')
    assert.equal(typeof config.hooks?.onPreToolUse, 'function')
    assert.equal(typeof config.onPermissionRequest, 'function')
    return session
  })
  context.mock.method(CopilotClient.prototype, 'stop', async () => [])
  await new CodingWorker(store, root).execute(store.get(task.id)!, prdPath, [], 'test-token', '继续完成验证码页面')
  assert.equal(creates, 0)
  assert.equal(sends, 1)
  assert.ok(prompt.includes('继续完成验证码页面'))
  assert.ok(!prompt.includes('采用哪种登录方式'))
  assert.ok(store.get(task.id)!.entries.some((entry) => entry.text.includes('已恢复原 SDK 会话')))
})

test('worker restore failure retains previous checks and never sends a coding request', async (context) => {
  const { root, prdPath } = workerFixture(context, 'codeflow-restore-fail-')
  const store = await TaskStore.fromPersistence({ load: async () => [], save: async () => {} })
  const checks = [{ name: 'test', passed: false, output: 'prior failure' }]
  store.create({ ...structuredClone(task), status: 'FAILED', checks, copilotSession: { id: 'original-id', directory: join(root, 'sessions', task.id) } })
  context.mock.method(CopilotClient.prototype, 'createSession', async () => { assert.fail('must not create') })
  context.mock.method(CopilotClient.prototype, 'resumeSession', async () => { throw new Error('unavailable') })
  context.mock.method(CopilotClient.prototype, 'stop', async () => [])
  const worker = new CodingWorker(store, root)
  await worker.execute(store.get(task.id)!, prdPath, [], 'test-token', '继续')
  assert.equal(store.get(task.id)!.status, 'FAILED')
  assert.match(store.get(task.id)!.sessionRestoreError!, /未自动创建新会话/)
  assert.deepEqual(store.get(task.id)!.checks, checks)
  assert.equal(worker.isRunning(task.id), false)
})

test('coding inactivity timeout records the last command and aborts without sending again', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const { root, prdPath } = workerFixture(context, 'codeflow-timeout-')
  const store = await TaskStore.fromPersistence({ load: async () => [], save: async () => {} })
  store.create({ ...structuredClone(task), status: 'FAILED' })
  const handlers = new Set<(event: import('@github/copilot-sdk').SessionEvent) => void>()
  let started!: () => void
  const sending = new Promise<void>((resolve) => { started = resolve })
  let sends = 0, aborts = 0, disconnects = 0
  const session = {
    sessionId: 'timeout-session',
    on: (typeOrHandler: unknown, handler?: (event: import('@github/copilot-sdk').SessionEvent) => void) => {
      const callback = typeof typeOrHandler === 'function' ? typeOrHandler as (event: import('@github/copilot-sdk').SessionEvent) => void : handler!
      const listener = (event: import('@github/copilot-sdk').SessionEvent) => { if (typeof typeOrHandler === 'function' || event.type === typeOrHandler) callback(event) }
      handlers.add(listener)
      return () => { handlers.delete(listener) }
    },
    setModel: async () => {}, abort: async () => { aborts++ }, disconnect: async () => { disconnects++ },
    send: async () => {
      sends++
      const event = { type: 'tool.execution_start', data: { toolCallId: 'shell', toolName: 'shell', arguments: { command: 'npm test' } } } as import('@github/copilot-sdk').SessionEvent
      for (const handler of handlers) handler(event)
      started()
      return 'message'
    },
  }
  context.mock.method(CopilotClient.prototype, 'createSession', async () => session)
  context.mock.method(CopilotClient.prototype, 'stop', async () => [])
  const worker = new CodingWorker(store, root)
  const execution = worker.execute(store.get(task.id)!, prdPath, [], 'test-token', '继续', false, true)
  await sending
  assert.equal(store.get(task.id)?.modelTurn?.status, 'running')
  context.mock.timers.tick(1200000)
  await execution
  assert.equal(store.get(task.id)?.status, 'FAILED')
  assert.equal(store.get(task.id)?.modelTurn?.status, 'timed_out')
  assert.match(store.get(task.id)?.error || '', /npm test/)
  assert.equal(sends, 1)
  assert.equal(aborts, 1)
  assert.equal(disconnects, 1)
  assert.equal(worker.isRunning(task.id), false)
})

test('missing PRD fails the worker without sending a coding request', async (context) => {
  const { root, prdPath } = workerFixture(context, 'codeflow-missing-prd-')
  rmSync(prdPath)
  const store = await TaskStore.fromPersistence({ load: async () => [], save: async () => {} })
  store.create({ ...structuredClone(task), status: 'FAILED' })
  let sends = 0
  const session = {
    sessionId: 'missing-prd-session',
    on: () => () => {}, setModel: async () => {}, abort: async () => {}, disconnect: async () => {},
    send: async () => { sends++; assert.fail('must not send without PRD') },
  }
  context.mock.method(CopilotClient.prototype, 'createSession', async () => session)
  context.mock.method(CopilotClient.prototype, 'stop', async () => [])
  const worker = new CodingWorker(store, root)
  await worker.execute(store.get(task.id)!, prdPath, [], 'test-token', '继续', false, true)
  assert.equal(store.get(task.id)!.status, 'FAILED')
  assert.match(store.get(task.id)!.error || '', /ENOENT/)
  assert.equal(sends, 0)
  assert.equal(worker.isRunning(task.id), false)
})