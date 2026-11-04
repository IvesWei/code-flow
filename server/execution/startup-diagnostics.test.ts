import assert from 'node:assert/strict'
import { test } from 'node:test'
import { StartupDiagnostics, startupErrorCode } from './startup-diagnostics.js'

test('startup stages report completion and failures without leaking error details', async () => {
  const messages: string[] = []
  const diagnostics = new StartupDiagnostics(message => messages.push(message))
  assert.equal(await diagnostics.run('任务加载', () => 42), 42)
  const error = new Error('private credentials', { cause: Object.assign(new Error('private host'), { code: 'ECONNREFUSED' }) })
  await assert.rejects(diagnostics.run('数据库连接', () => { throw error }), error)
  assert.ok(messages.some(message => message.includes('任务加载 开始')))
  assert.ok(messages.some(message => message.includes('任务加载 完成')))
  assert.ok(messages.some(message => message.includes('数据库连接 失败，错误代码：ECONNREFUSED')))
  assert.ok(messages.every(message => !message.includes('private')))
  assert.equal(startupErrorCode({ code: 'token secret' }), 'UNKNOWN')
})

test('slow startup stages warn without cancelling and stop warning after completion', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const messages: string[] = []
  const diagnostics = new StartupDiagnostics(message => messages.push(message), 100)
  const progress = diagnostics.begin('数据库连接')
  context.mock.timers.tick(100)
  assert.equal(messages.filter(message => message.includes('等待超过')).length, 1)
  progress.complete()
  progress.fail(new Error('late'))
  assert.equal(messages.filter(message => message.includes('完成')).length, 2)
  const next = diagnostics.begin('任务加载')
  next.complete()
  context.mock.timers.tick(200)
  assert.equal(messages.filter(message => message.includes('等待超过')).length, 1)
})