import { loadEnvFile } from 'node:process'
import { existsSync } from 'node:fs'
import { databaseConfig } from './database-config.js'
import { MysqlTaskPersistence } from './database.js'
import { TaskStore } from '../tasks/store.js'
import type { StartupDiagnostics } from '../execution/startup-diagnostics.js'
import type { DatabaseConfig } from './database-config.js'
import type { TaskRepository } from './contracts.js'

export interface StorageDependencies {
  config(): DatabaseConfig | undefined
  connect(config: DatabaseConfig): Promise<TaskRepository & { health(): Promise<void>; close(): Promise<void> }>
}

export function loadStorageEnvironment(): void {
  const file = process.env.CODEFLOW_ENV_FILE || (process.env.NODE_ENV !== 'production' && existsSync('.env') ? '.env' : undefined)
  if (!file) return
  try { loadEnvFile(file) }
  catch { throw new Error('后台环境文件加载失败，请检查 CODEFLOW_ENV_FILE 路径及文件权限') }
}

export async function initializeTaskStorage(file: string, diagnostics?: StartupDiagnostics, dependencies: StorageDependencies = { config: databaseConfig, connect: (config) => MysqlTaskPersistence.connect(config) }) {
  const run = <T>(stage: string, action: () => T | Promise<T>) => diagnostics ? diagnostics.run(stage, action) : Promise.resolve().then(action)
  const config = await run('存储配置校验', () => dependencies.config())
  if (!config) {
    const store = await run('JSON 任务加载与重启状态保存', () => new TaskStore(file))
    return { store, backend: 'json' as const, health: () => store.flush(), close: () => store.flush() }
  }
  const database = await run('MySQL 连接、单实例锁与 schema 检查', () => dependencies.connect(config))
  try {
    const store = await run('MySQL 活动任务中断恢复（不加载历史）', () => TaskStore.fromPersistence(database))
    return {
      store, backend: 'mysql' as const,
      health: async () => { await store.flush(); await database.health() },
      close: async () => { try { await store.flush() } finally { await database.close() } },
    }
  } catch (error) {
    await run('初始化失败后释放数据库连接', () => database.close())
    throw error
  }
}