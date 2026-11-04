import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createPool, type PoolOptions } from 'mysql2/promise'
import type { TestingRepository } from '../../shared/testing.js'
import { databaseConfig, type DatabaseConfig } from '../storage/database-config.js'
import { createTestingRepository, type SqlPool } from './repository.js'

type TestingPool = SqlPool & { end(): Promise<void> }

export interface TestingRuntimeLease {
  initializeJson?(): Promise<void>
  release(): Promise<void>
}

export async function acquireTestingRuntimeLease(root: string): Promise<TestingRuntimeLease> {
  const directory = join(root, 'testing')
  const lock = join(directory, 'runtime.lock')
  const token = randomUUID()
  const owner = `${process.pid}-${token}.json`
  const staging = join(directory, `.runtime-${token}`)
  await mkdir(directory, { recursive: true })
  await mkdir(staging)
  try {
    await writeFile(join(staging, owner), JSON.stringify({ pid: process.pid, token }), { flag: 'wx' })
    for (;;) {
      try { await rename(staging, lock); break }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      }
      const lockInfo = await lstat(lock)
      if (!lockInfo.isDirectory() || lockInfo.isSymbolicLink()) throw new Error('Invalid testing runtime lock')
      const entries = await readdir(lock)
      if (entries.length !== 1 || !/^\d+-[a-f0-9-]+\.json$/.test(entries[0])) throw new Error('Testing runtime lock unavailable')
      const path = join(lock, entries[0])
      const before = await lstat(path)
      if (!before.isFile() || before.isSymbolicLink()) throw new Error('Invalid testing runtime lock')
      const stale = JSON.parse(await readFile(path, 'utf8')) as { pid: number; token: string }
      if (!Number.isSafeInteger(stale.pid) || stale.pid <= 0 || entries[0] !== `${stale.pid}-${stale.token}.json`) throw new Error('Invalid testing runtime lock')
      try { process.kill(stale.pid, 0); throw new Error('Testing runtime already active') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
      const after = await lstat(path)
      if (before.dev !== after.dev || before.ino !== after.ino || await readFile(path, 'utf8') !== JSON.stringify(stale)) throw new Error('Testing runtime lock changed')
      await unlink(path)
      await rmdir(lock)
    }
    const identity = await lstat(join(lock, owner))
    let released = false
    return { initializeJson: async () => {
      const manifest = join(directory, 'manifest.json')
      try { await readFile(manifest); return }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const entries = await readdir(directory)
      if (entries.some(entry => entry !== 'runtime.lock' && !/^\.runtime-[a-f0-9-]{36}$/.test(entry))) throw new Error('Testing JSON manifest missing')
      await writeFile(manifest, JSON.stringify({ schemaVersion: 1, records: [] }), { flag: 'wx' })
    }, release: async () => {
      if (released) return
      released = true
      const path = join(lock, owner)
      try {
        const current = await lstat(path)
        if (current.dev !== identity.dev || current.ino !== identity.ino || await readFile(path, 'utf8') !== JSON.stringify({ pid: process.pid, token })) return
        await unlink(path)
        await rmdir(lock)
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    } }
  } finally {
    await unlink(join(staging, owner)).catch(() => {})
    await rmdir(staging).catch(() => {})
  }
}

export interface TestingStorageDependencies {
  config(): DatabaseConfig | undefined
  createPool(options: PoolOptions): TestingPool
  readCa(file: string): Promise<string>
  createRepository: typeof createTestingRepository
  acquireLease?(root: string): Promise<TestingRuntimeLease>
}

export interface TestingStorageRuntime {
  repository?: TestingRepository
  error?: string
  close(): Promise<void>
}

const defaults: TestingStorageDependencies = {
  config: databaseConfig,
  createPool: options => createPool(options) as unknown as TestingPool,
  readCa: file => readFile(file, 'utf8'),
  createRepository: createTestingRepository,
}

export async function initializeTestingStorage(
  root: string,
  backend: 'json' | 'mysql',
  dependencies: TestingStorageDependencies = defaults,
): Promise<TestingStorageRuntime> {
  let pool: TestingPool | undefined
  let lease: TestingRuntimeLease | undefined
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => closing ??= Promise.resolve().then(async () => {
    try { await pool?.end() }
    catch { throw new Error('Testing storage shutdown failed; check database connectivity.') }
    finally { await lease?.release() }
  })
  try {
    lease = await (dependencies.acquireLease ?? acquireTestingRuntimeLease)(root)
    if (backend === 'mysql') {
      const config = dependencies.config()
      if (!config) throw new Error('MySQL configuration required')
      const ca = config.caFile ? await dependencies.readCa(config.caFile) : undefined
      pool = dependencies.createPool({
        host: config.host, port: config.port, user: config.user, password: config.password, database: config.database,
        connectionLimit: config.connectionLimit, connectTimeout: config.connectTimeout,
        waitForConnections: true, queueLimit: 100, enableKeepAlive: true, keepAliveInitialDelay: 0,
        charset: 'utf8mb4', timezone: 'Z', multipleStatements: false,
        ssl: config.tls ? { rejectUnauthorized: true, ...(ca ? { ca } : {}) } : undefined,
      })
    } else if (backend !== 'json') {
      throw new Error('Unsupported testing backend')
    }
    if (backend === 'json') await lease.initializeJson?.()
    const repository = await dependencies.createRepository(backend, root, pool)
    await repository.recover()
    return { repository, close }
  } catch {
    await close().catch(() => {})
    return {
      error: backend === 'mysql'
        ? '独立测试存储未就绪。请检查测试表结构、数据库配置、TLS、权限及实例锁；尚未建表时手动应用 sql/mysql-testing-schema.sql，再重启 API。不会回退到 JSON，旧任务不受此模块停用影响。'
        : '独立测试 JSON 存储未就绪。请检查数据目录、清单文件、目录权限及实例锁，再重启 API。',
      close,
    }
  }
}