import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CopilotSession, SessionEvent } from '@github/copilot-sdk'
import { SessionProgressTimeout, SessionProgressWaiter, type SessionProgress } from './session-progress.js'

function source(send = async () => 'message') {
  const handlers = new Set<(event: SessionEvent) => void>()
  const session = {
    send,
    on(handler: (event: SessionEvent) => void) { handlers.add(handler); return () => { handlers.delete(handler) } },
  } as Pick<CopilotSession, 'send' | 'on'>
  return { waiter: new SessionProgressWaiter(session), handlers, emit: (type: string, data: object = {}) => { for (const handler of handlers) handler({ type, data } as SessionEvent) } }
}

test('active progress can exceed the old total timeout and listeners are removed on idle', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const { waiter, emit, handlers } = source()
  const result = waiter.send('code', 100)
  for (let step = 0; step < 5; step++) {
    context.mock.timers.tick(80)
    emit('assistant.message_delta', { deltaContent: 'working' })
  }
  emit('assistant.message', { content: 'done' })
  emit('session.idle')
  assert.equal((await result)?.data.content, 'done')
  assert.equal(handlers.size, 0)
})

test('no progress times out with the last tool and does not resend', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  let sends = 0
  const { waiter, emit, handlers } = source(async () => { sends++; return 'message' })
  const result = waiter.send('code', 100)
  const rejected = assert.rejects(result, (error: Error) => error instanceof SessionProgressTimeout && /shell.*npm test/.test(error.message))
  emit('tool.execution_start', { toolCallId: 'tool', toolName: 'shell', arguments: { command: 'npm test' } })
  context.mock.timers.tick(100)
  await rejected
  assert.equal(sends, 1)
  assert.equal(handlers.size, 0)
})

test('user input pauses the deadline and resuming starts a fresh inactivity window', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const { waiter, emit } = source()
  const result = waiter.send('code', 100)
  waiter.pause()
  context.mock.timers.tick(1000)
  waiter.resume()
  context.mock.timers.tick(99)
  emit('assistant.message', { content: 'answered' })
  emit('session.idle')
  assert.equal((await result)?.data.content, 'answered')
})

test('autopilot idle and unrelated heartbeat events do not finish or prolong a turn', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const { waiter, emit } = source()
  const result = waiter.send('code', 100)
  const rejected = assert.rejects(result, SessionProgressTimeout)
  context.mock.timers.tick(80)
  emit('session.idle', { mode: 'autopilot' })
  emit('session.usage_info', {})
  context.mock.timers.tick(20)
  await rejected
})

test('send failures and session errors clean up listeners', async () => {
  const failedSend = source(async () => { throw new Error('send failed') })
  await assert.rejects(failedSend.waiter.send('code', 1000), /send failed/)
  assert.equal(failedSend.handlers.size, 0)
  const failedSession = source()
  const result = failedSession.waiter.send('code', 1000)
  failedSession.emit('session.error', { message: 'session failed' })
  await assert.rejects(result, /session failed/)
  assert.equal(failedSession.handlers.size, 0)
})

test('a stalled send RPC is bounded by the inactivity deadline', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const { waiter, handlers } = source(() => new Promise<string>(() => {}))
  const result = waiter.send('code', 100)
  const rejected = assert.rejects(result, SessionProgressTimeout)
  context.mock.timers.tick(100)
  await rejected
  assert.equal(handlers.size, 0)
})

test('first response uses its own deadline then tool progress switches to inactivity', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const { waiter, emit } = source()
  const result = waiter.send('review', { firstResponseMs: 600, inactivityMs: 100 })
  const rejected = assert.rejects(result, (error: Error) => error instanceof SessionProgressTimeout && !error.message.includes('等待首次') && error.message.includes('view'))
  context.mock.timers.tick(500)
  emit('tool.execution_start', { toolCallId: 'read', toolName: 'view', arguments: {} })
  context.mock.timers.tick(99)
  emit('tool.execution_progress', { toolCallId: 'read' })
  context.mock.timers.tick(100)
  await rejected
})

test('SDK lifecycle and repeated compaction events are visible but cannot prolong first response or resend', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  let sends = 0
  const { waiter, emit, handlers } = source(async () => { sends++; return 'accepted' })
  const reports: SessionProgress[] = []
  const result = waiter.send('review', { firstResponseMs: 600, inactivityMs: 100 }, (progress) => reports.push(progress))
  const rejected = assert.rejects(result, (error: Error) => error instanceof SessionProgressTimeout && /等待首次/.test(error.message) && /压缩/.test(error.message))
  await Promise.resolve()
  assert.match(reports.at(-1)!.summary, /SDK 已接收请求/)
  emit('assistant.turn_start')
  assert.match(reports.at(-1)!.summary, /已启动模型回合/)
  context.mock.timers.tick(300)
  emit('session.compaction_start')
  assert.match(reports.at(-1)!.summary, /SDK 正在压缩上下文/)
  context.mock.timers.tick(200)
  emit('session.compaction_complete', { success: true })
  assert.match(reports.at(-1)!.summary, /压缩完成/)
  emit('session.truncation')
  assert.match(reports.at(-1)!.summary, /截断/)
  emit('session.compaction_start')
  context.mock.timers.tick(100)
  await rejected
  assert.equal(sends, 1)
  assert.equal(handlers.size, 0)
})

test('compaction does not extend an active inactivity window and input pause retains the first response phase', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const { waiter, emit } = source()
  const result = waiter.send('review', { firstResponseMs: 600, inactivityMs: 100 })
  const rejected = assert.rejects(result, SessionProgressTimeout)
  waiter.pause()
  context.mock.timers.tick(1000)
  waiter.resume()
  context.mock.timers.tick(500)
  emit('assistant.reasoning_delta', { deltaContent: 'working' })
  context.mock.timers.tick(90)
  emit('session.compaction_start')
  context.mock.timers.tick(10)
  await rejected
})