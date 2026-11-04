export interface DatabaseConfig {
  host: string
  port: number
  user: string
  password: string
  database: string
  connectionLimit: number
  connectTimeout: number
  tls: boolean
  caFile?: string
}

function integer(value: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} 必须是 ${min} 至 ${max} 的整数`)
  return parsed
}

export function databaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig | undefined {
  const backend = env.TASK_STORAGE || 'json'
  if (backend === 'json') return undefined
  if (backend !== 'mysql') throw new Error('TASK_STORAGE 只能为 json 或 mysql')
  for (const key of ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME']) {
    if (!env[key]?.trim()) throw new Error(`MySQL 配置缺少 ${key}`)
  }
  if (env.DB_TLS !== undefined && !['true', 'false'].includes(env.DB_TLS)) throw new Error('DB_TLS 必须为 true 或 false')
  if (env.DB_TLS_CA_FILE && env.DB_TLS !== 'true') throw new Error('DB_TLS_CA_FILE 需要启用 DB_TLS=true')
  return {
    host: env.DB_HOST!.trim(), user: env.DB_USER!.trim(), password: env.DB_PASSWORD!, database: env.DB_NAME!.trim(),
    port: integer(env.DB_PORT, 3306, 1, 65535, 'DB_PORT'),
    connectionLimit: integer(env.DB_POOL_SIZE, 5, 2, 50, 'DB_POOL_SIZE'),
    connectTimeout: integer(env.DB_CONNECT_TIMEOUT_MS, 10000, 1000, 120000, 'DB_CONNECT_TIMEOUT_MS'),
    tls: env.DB_TLS === 'true', caFile: env.DB_TLS_CA_FILE,
  }
}