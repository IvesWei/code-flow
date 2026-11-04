import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createPool, type PoolOptions } from 'mysql2/promise'
import type { RequirementRepository } from '../../shared/requirements.js'
import { databaseConfig, type DatabaseConfig } from '../storage/database-config.js'
import { acquireTestingRuntimeLease, type TestingRuntimeLease } from '../testing/runtime.js'
import { createRequirementRepository, type RequirementSqlPool } from './repository.js'

export type RequirementPool = RequirementSqlPool & { end(): Promise<void> }
export interface RequirementsStorageDependencies {
  config(): DatabaseConfig | undefined
  createPool(options: PoolOptions): RequirementPool
  readCa(file: string): Promise<string>
  createRepository: typeof createRequirementRepository
  acquireLease?(root: string): Promise<TestingRuntimeLease>
}
export interface RequirementsStorageRuntime {
  repository?: RequirementRepository
  error?: string
  close(): Promise<void>
}
const defaults: RequirementsStorageDependencies = {
  config: databaseConfig,
  createPool: options => createPool(options) as unknown as RequirementPool,
  readCa: file => readFile(file, 'utf8'),
  createRepository: createRequirementRepository,
}

export async function initializeRequirementsStorage(
  root: string,
  backend: 'json' | 'mysql',
  dependencies: RequirementsStorageDependencies = defaults,
): Promise<RequirementsStorageRuntime> {
  let pool: RequirementPool | undefined
  let lease: TestingRuntimeLease | undefined
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => closing ??= Promise.resolve().then(async () => {
    try { await pool?.end() }
    catch { throw new Error('Requirement storage shutdown failed; check database connectivity.') }
    finally { await lease?.release() }
  })
  try {
    lease = await (dependencies.acquireLease ?? acquireTestingRuntimeLease)(join(root, 'requirements', 'runtime'))
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
    } else if (backend !== 'json') throw new Error('Unsupported requirement backend')
    const repository = await dependencies.createRepository(backend, root, pool)
    await repository.recover()
    return { repository, close }
  } catch {
    await close().catch(() => {})
    return {
      error: backend === 'mysql'
        ? 'Requirement MySQL storage not ready. Check sql/mysql-requirements-schema.sql, database configuration, TLS, permissions and runtime lease, then restart the API. Apply DDL manually; no JSON fallback.'
        : 'Requirement JSON storage not ready. Check project files, directory permissions and runtime lease, then restart the API.',
      close,
    }
  }
}