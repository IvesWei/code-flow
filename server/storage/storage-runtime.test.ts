import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeTaskStorage, loadStorageEnvironment } from './storage-runtime.js'
import { databaseConfig } from './database-config.js'
import type { TaskRepository } from './contracts.js'

test('development startup loads local env, respects explicit files and production isolation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'codeflow-env-'))
  const originalDirectory = process.cwd()
  const original = { ...process.env }
  try {
    process.chdir(directory)
    delete process.env.CODEFLOW_ENV_FILE
    delete process.env.CODEFLOW_STARTUP_TEST
    process.env.NODE_ENV = 'development'
    loadStorageEnvironment()
    assert.equal(process.env.CODEFLOW_STARTUP_TEST, undefined)
    writeFileSync('.env', 'CODEFLOW_STARTUP_TEST=local\n')
    loadStorageEnvironment()
    assert.equal(process.env.CODEFLOW_STARTUP_TEST, 'local')
    process.env.CODEFLOW_STARTUP_TEST = 'injected'
    loadStorageEnvironment()
    assert.equal(process.env.CODEFLOW_STARTUP_TEST, 'injected')
    delete process.env.CODEFLOW_STARTUP_TEST
    process.env.NODE_ENV = 'production'
    loadStorageEnvironment()
    assert.equal(process.env.CODEFLOW_STARTUP_TEST, undefined)
    writeFileSync('explicit.env', 'CODEFLOW_STARTUP_TEST=explicit\n')
    process.env.CODEFLOW_ENV_FILE = join(directory, 'explicit.env')
    loadStorageEnvironment()
    assert.equal(process.env.CODEFLOW_STARTUP_TEST, 'explicit')
    process.env.CODEFLOW_ENV_FILE = join(directory, 'missing.env')
    assert.throws(loadStorageEnvironment, /后台环境文件加载失败/)
  } finally {
    process.chdir(originalDirectory)
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]
    Object.assign(process.env, original)
    rmSync(directory, { recursive: true, force: true })
  }
})
test('V2 startup recovers active only and closes after flush without a full task load', async () => {
  const calls: string[] = []
  const database: TaskRepository & { health(): Promise<void>; close(): Promise<void> } = {
    recoverActive: async () => { calls.push('recover') }, loadTask: async () => { calls.push('load'); return undefined },
    queryTasks: async () => { calls.push('query'); return { items: [] } }, history: async () => ({ items: [] }),
    hasBusyTasks: async () => false, commit: async change => change.expectedVersion + 1,
    health: async () => { calls.push('health') }, close: async () => { calls.push('close') },
  }
  const config = databaseConfig({ TASK_STORAGE: 'mysql', DB_HOST: 'fake', DB_USER: 'fake', DB_PASSWORD: 'fake', DB_NAME: 'fake' })!
  const runtime = await initializeTaskStorage('unused.json', undefined, { config: () => config, connect: async () => database })
  assert.equal(runtime.backend, 'mysql')
  assert.deepEqual(calls, ['recover'])
  await runtime.health()
  await runtime.close()
  assert.deepEqual(calls, ['recover', 'health', 'close'])
})
test('V2 recovery failure closes database and never falls back to JSON', async () => {
  let closed = false
  const config = databaseConfig({ TASK_STORAGE: 'mysql', DB_HOST: 'fake', DB_USER: 'fake', DB_PASSWORD: 'fake', DB_NAME: 'fake' })!
  const database = { commit: async () => 1, recoverActive: async () => { throw new Error('recovery failed') }, close: async () => { closed = true } } as unknown as TaskRepository & { health(): Promise<void>; close(): Promise<void> }
  await assert.rejects(initializeTaskStorage('unused.json', undefined, { config: () => config, connect: async () => database }), /recovery failed/)
  assert.equal(closed, true)
})