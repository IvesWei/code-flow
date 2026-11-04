import type { BrowserContext } from 'playwright-core'
import type { TestLoginConfig } from './test-login-config.js'
import { RequirementDiagnosticError } from './diagnostics.js'

export function allowedTmpRequest(url: URL, method: string, resourceType: string): boolean {
  if (url.username || url.password) return false
  const read = ['GET', 'HEAD'].includes(method)
  if (url.origin === 'https://tmp.test.sunmi.com') return read
  if (url.origin === 'https://static-test.cdn.sunmi.com') return read && ['script', 'stylesheet', 'image', 'font'].includes(resourceType)
  if (url.origin === 'https://tmp-defender.test.sunmi.com') return read || (url.pathname === '/tmpdefender/login' && ['POST', 'OPTIONS'].includes(method))
  return false
}

export async function loginTmp(context: BrowserContext, config: TestLoginConfig, signal: AbortSignal): Promise<void> {
  const page = await context.newPage()
  const closePopup = (opened: typeof page) => { if (opened !== page) void opened.close().catch(() => {}) }
  context.on('page', closePopup)
  const abort = () => { void page.close().catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  await context.routeWebSocket('**/*', socket => socket.close())
  await context.route('**/*', route => {
    const request = route.request()
    const url = new URL(request.url())
    if (signal.aborted || !allowedTmpRequest(url, request.method(), request.resourceType()) || (request.isNavigationRequest() && url.origin !== config.origin)) return route.abort()
    return route.fallback()
  })
  try {
    signal.throwIfAborted()
    await page.goto(`${config.origin}/user/login`, { waitUntil: 'domcontentloaded', timeout: 20000 })
    await page.getByRole('button', { name: /更多登录方式/ }).click({ timeout: 15000 })
    await page.getByRole('textbox', { name: 'LDAP 账号', exact: true }).fill(config.username)
    await page.getByRole('textbox', { name: '密码', exact: true }).fill(config.password)
    await page.getByRole('button').filter({ hasText: 'LDAP 账号登录' }).click()
    await page.waitForURL(url => url.origin === config.origin && url.pathname !== '/user/login', { timeout: 20000 })
    signal.throwIfAborted()
  } catch {
    signal.throwIfAborted()
    throw new RequirementDiagnosticError('output_validation', 'PAGE_CAPTURE_LOGIN', '测试环境 LDAP 自动登录未完成，请检查账号有效性或必要服务；未记录凭据或原始浏览器异常')
  } finally {
    signal.removeEventListener('abort', abort)
    context.off('page', closePopup)
    await page.close().catch(() => {})
    await context.unrouteAll({ behavior: 'wait' })
  }
}