import { randomBytes } from 'node:crypto'
import type { Request, Response } from 'express'
import { oauthCredentials } from './oauth-config.js'

interface Session { token: string; ownerId: number }
const sessions = new Map<string, Session>()
const pending = new Map<string, number>()
const cookieName = 'codeflow_session'
const stateCookie = 'codeflow_oauth_state'
const callbackUrl = 'http://127.0.0.1:3001/api/auth/callback'

function cookie(request: Request, name: string): string | undefined {
  return request.get('cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1)
}

function clearState(response: Response): void {
  response.clearCookie(stateCookie, { path: '/api/auth/callback' })
}

export function oauthConfigured(): boolean {
  return Boolean(oauthCredentials())
}

export function sessionUser(request: Request): Session | undefined {
  const id = cookie(request, cookieName)
  return id ? sessions.get(id) : undefined
}

export function sessionToken(request: Request): string | undefined {
  return sessionUser(request)?.token
}

export async function authenticatedUser(request: Request): Promise<Session | undefined> {
  const session = sessionUser(request)
  if (!session) return undefined
  const result = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${session.token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'code-flow-local' },
    signal: AbortSignal.timeout(10_000),
  })
  if (result.status === 401) {
    const id = cookie(request, cookieName)
    if (id) sessions.delete(id)
    return undefined
  }
  if (!result.ok) throw new Error('无法检查 GitHub 登录状态，请稍后重试')
  const user = await result.json() as { id: number }
  if (user.id !== session.ownerId) throw new Error('GitHub 登录身份不匹配，请重新登录')
  return session
}

export function authStart(request: Request, response: Response): void {
  const credentials = oauthCredentials()
  if (!credentials) {
    response.status(503).json({ error: '请先配置本地 OAuth 凭据文件或 GITHUB_CLIENT_ID 和 GITHUB_CLIENT_SECRET' })
    return
  }
  const state = randomBytes(24).toString('hex')
  pending.set(state, Date.now() + 5 * 60_000)
  response.cookie(stateCookie, state, { httpOnly: true, sameSite: 'lax', path: '/api/auth/callback', maxAge: 5 * 60_000 })
  const authorize = new URL('https://github.com/login/oauth/authorize')
  authorize.searchParams.set('client_id', credentials.clientId)
  authorize.searchParams.set('redirect_uri', callbackUrl)
  authorize.searchParams.set('state', state)
  response.redirect(authorize.toString())
}

export async function authCallback(request: Request, response: Response): Promise<void> {
  const state = typeof request.query.state === 'string' ? request.query.state : ''
  const code = typeof request.query.code === 'string' ? request.query.code : ''
  const expiration = pending.get(state)
  pending.delete(state)
  if (!code || !state || state !== cookie(request, stateCookie) || !expiration || expiration < Date.now()) {
    clearState(response)
    response.status(400).send('登录状态已过期或不匹配，请返回工作台重新登录。')
    return
  }
  clearState(response)
  try {
    const credentials = oauthCredentials()
    if (!credentials) throw new Error('OAuth App 凭据未配置')
    const result = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: credentials.clientId, client_secret: credentials.clientSecret, code, redirect_uri: callbackUrl }),
      signal: AbortSignal.timeout(15_000),
    })
    const data = await result.json() as { access_token?: string; error?: string }
    if (!result.ok || !data.access_token) throw new Error(data.error || 'GitHub 未返回访问令牌')
    const profile = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${data.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'code-flow-local' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!profile.ok) throw new Error('无法读取 GitHub 用户身份')
    const user = await profile.json() as { id?: number }
    if (!Number.isSafeInteger(user.id) || !user.id || user.id <= 0) throw new Error('GitHub 用户身份无效')
    const id = randomBytes(32).toString('hex')
    sessions.set(id, { token: data.access_token, ownerId: user.id })
    response.cookie(cookieName, id, { httpOnly: true, sameSite: 'lax', path: '/api', maxAge: 8 * 60 * 60_000 })
    response.redirect('http://127.0.0.1:5174/')
  } catch {
    response.status(502).send('GitHub 登录失败，请返回工作台重试。')
  }
}

export async function authStatus(request: Request, response: Response): Promise<void> {
  const token = sessionToken(request)
  if (!token) {
    response.json({ configured: oauthConfigured(), authenticated: false })
    return
  }
  try {
    const result = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'code-flow-local' },
      signal: AbortSignal.timeout(10_000),
    })
    if (result.status === 401) {
      const id = cookie(request, cookieName)
      if (id) sessions.delete(id)
      response.clearCookie(cookieName, { path: '/api' })
      response.json({ configured: oauthConfigured(), authenticated: false })
      return
    }
    if (!result.ok) throw new Error('GitHub status unavailable')
    const user = await result.json() as { login: string }
    response.json({ configured: true, authenticated: true, login: user.login })
  } catch {
    response.status(503).json({ error: '无法检查 GitHub 登录状态，请稍后重试' })
  }
}

export function authLogout(request: Request, response: Response): void {
  const id = cookie(request, cookieName)
  if (id) sessions.delete(id)
  response.clearCookie(cookieName, { path: '/api' })
  response.json({ authenticated: false })
}