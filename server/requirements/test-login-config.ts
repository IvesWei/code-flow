import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export interface TestLoginConfig {
  origin: string
  username: string
  password: string
}

export function parseTestLoginConfig(value: unknown): TestLoginConfig {
  const config = value as Partial<TestLoginConfig> | null
  if (!config || Object.keys(config).some(key => !['origin', 'username', 'password'].includes(key)) || config.origin !== 'https://tmp.test.sunmi.com' || typeof config.username !== 'string' || !config.username.trim() || typeof config.password !== 'string' || !config.password) throw new Error('测试登录配置无效，请检查后端私密配置')
  return { origin: config.origin, username: config.username.trim(), password: config.password }
}

export async function testLoginConfig(): Promise<TestLoginConfig | undefined> {
  let content: string
  try { content = await readFile(resolve('data/requirement-test-login.local'), 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new Error('无法读取后端测试登录配置') }
  try { return parseTestLoginConfig(JSON.parse(content)) }
  catch { throw new Error('测试登录配置无效，请检查后端私密配置') }
}