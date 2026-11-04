import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Code2, Github, LoaderCircle, LogIn, RefreshCw, ShieldCheck } from 'lucide-react'

import { AuthContext, type AuthStatus } from './auth-session'
let pendingStatus: Promise<AuthStatus> | undefined

function readStatus() {
  if (!pendingStatus) {
    pendingStatus = fetch('/api/auth/status', { credentials: 'same-origin', cache: 'no-store' }).then(async response => {
      if (!response.ok) throw new Error('无法检查登录状态，请稍后重试')
      const value = await response.json() as AuthStatus
      if (typeof value.configured !== 'boolean' || typeof value.authenticated !== 'boolean') throw new Error('登录状态响应无效')
      return value
    }).finally(() => { pendingStatus = undefined })
  }
  return pendingStatus
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthStatus>()
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let active = true
    void readStatus().then(value => { if (active) { setAuth(value); setError('') } }).catch(caught => { if (active) setError(caught instanceof Error ? caught.message : '无法检查登录状态') })
    return () => { active = false }
  }, [revision])
  useEffect(() => {
    const expire = () => setAuth(previous => ({ configured: previous?.configured ?? true, authenticated: false }))
    window.addEventListener('codeflow:unauthorized', expire)
    return () => window.removeEventListener('codeflow:unauthorized', expire)
  }, [])
  const login = () => window.location.assign('/api/auth/start')
  const logout = async () => {
    const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
    if (!response.ok) throw new Error('退出失败，请重试')
    setAuth(previous => ({ configured: previous?.configured ?? true, authenticated: false }))
  }
  if (!auth?.authenticated) return <main className="login-page">
    <header className="login-brand"><Code2 size={26} /><span>Code / Flow</span></header>
    <section className="login-content" aria-labelledby="login-title">
      <Github size={44} strokeWidth={1.4} />
      <h1 id="login-title">登录 Code / Flow</h1>
      {error ? <><p role="alert">{error}</p><button className="primary-button" onClick={() => { setError(''); setRevision(value => value + 1) }}><RefreshCw size={18} />重试</button></> : !auth ? <p role="status"><LoaderCircle className="spin" size={18} />正在确认登录状态</p> : auth.configured ? <button className="primary-button" onClick={login}><LogIn size={18} />使用 GitHub 登录</button> : <p role="status">GitHub 登录尚未配置，请联系管理员。</p>}
      <div className="login-security"><ShieldCheck size={16} />GitHub 账户认证</div>
    </section>
  </main>
  return <AuthContext value={{ auth, login, logout }}>{children}</AuthContext>
}

