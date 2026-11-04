import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const localOAuthFile = join(process.env.LOCALAPPDATA || join(homedir(), '.config'), 'CodeFlow', 'oauth.local.json')

export function oauthCredentials(file = localOAuthFile): { clientId: string; clientSecret: string } | undefined {
  const clientId = process.env.GITHUB_CLIENT_ID?.trim()
  const clientSecret = process.env.GITHUB_CLIENT_SECRET?.trim()
  if (clientId || clientSecret) return clientId && clientSecret ? { clientId, clientSecret } : undefined
  if (process.env.NODE_ENV === 'production') return undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return undefined
    const values = parsed as Record<string, unknown>
    if (typeof values.clientId !== 'string' || typeof values.clientSecret !== 'string') return undefined
    const fileId = values.clientId.trim()
    const fileSecret = values.clientSecret.trim()
    return fileId && fileSecret ? { clientId: fileId, clientSecret: fileSecret } : undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error('无法读取本地 OAuth 凭据文件，请检查格式与文件权限')
  }
}