import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

async function launchApi(overrides: Record<string, string>, verify: (output: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'codeflow-startup-'))
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:DB_|TASK_STORAGE$|CODEFLOW_ENV_FILE$|GITHUB_|COPILOT_)/i.test(name)))
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), resolve('server/index.ts')], {
    cwd: directory,
    env: { ...environment, NODE_ENV: 'production', TASK_STORAGE: 'json', DATA_DIR: directory, PORT: '0', ...overrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = once(child, 'exit')
  let output = ''
  try {
    await new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('Isolated API startup timed out')), 15_000)
      const collect = (chunk: Buffer) => {
        output += chunk.toString()
        if (output.includes('API listening on')) { clearTimeout(timer); resolveReady() }
      }
      child.stdout.on('data', collect)
      child.stderr.on('data', collect)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', () => { clearTimeout(timer); resolveReady() })
    })
    await verify(output)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await exited
    await rm(directory, { recursive: true, force: true })
  }
}

test('API reports configuration, task loading and listening stages in order', { timeout: 20_000 }, async () => {
  await launchApi({}, async output => {
    const stages = ['API 入口开始', '环境配置加载 开始', '环境配置加载 完成', '存储配置校验 开始', 'JSON 任务加载与重启状态保存 完成', '存储初始化完成，模式：json', 'API 端口监听 开始', 'API 端口监听 完成', 'API listening on']
    let previous = -1
    for (const stage of stages) {
      const position = output.indexOf(stage)
      assert.ok(position > previous, `Missing or out-of-order stage: ${stage}`)
      previous = position
    }
  })
})

test('API reports an occupied port without exposing a raw stack', { timeout: 20_000 }, async () => {
  const listener = createServer()
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const address = listener.address()
  assert.ok(address && typeof address !== 'string')
  try {
    await launchApi({ PORT: String(address.port) }, async output => {
      assert.match(output, /API 端口监听 失败，错误代码：EADDRINUSE/)
      assert.match(output, /已被占用，请停止原后台实例/)
      assert.ok(!output.includes('API listening on'))
      assert.ok(!output.includes('Error: listen'))
    })
  } finally { await new Promise<void>((resolveClose, reject) => listener.close(error => error ? reject(error) : resolveClose())) }
})

test('API logs the failed environment stage and never listens when its explicit file is missing', { timeout: 20_000 }, async () => {
  await launchApi({ CODEFLOW_ENV_FILE: join(tmpdir(), 'missing-codeflow-startup-config', 'private.env') }, async output => {
    assert.match(output, /环境配置加载 失败，错误代码：UNKNOWN/)
    assert.ok(!output.includes('API listening on'))
    assert.ok(!output.includes('private.env'))
  })
})