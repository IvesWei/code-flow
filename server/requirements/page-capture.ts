import { chromium, type Browser, type BrowserContext, type Request } from 'playwright-core'
import { requirementPreviewOrigin, requirementPreviewPath } from '../../shared/requirement-preview.js'
import type { RequirementLoginControls, StructuredPrd } from '../../shared/requirements.js'
import type { WorkspaceSnapshot } from './workspace.js'
import { RequirementDiagnosticError } from './diagnostics.js'
import { testLoginConfig } from './test-login-config.js'
import { allowedTmpRequest, loginTmp } from './tmp-test-login.js'

export interface CaptureTarget { blockId: string; path: string; openDialog?: string; expectedFields?: string[] }
export function parseCaptureTargets(content: string, prd: StructuredPrd, snapshots: WorkspaceSnapshot[]): CaptureTarget[] {
  const fail = (reason = '路由结果格式无效') => new RequirementDiagnosticError('output_validation', 'PAGE_MAPPING', `业务页面路由定位未通过：${reason}；未猜测页面地址`)
  try {
    if (content.length > 30000) throw fail()
    const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i.exec(content)
    const result = JSON.parse(fenced ? fenced[1] : content, (key, value: unknown) => {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw fail()
      return value
    }) as { pages: { blockId: string; kind: string; path?: string; sourceId?: string; quote?: string }[] }
    if (!result || Object.keys(result).some(key => key !== 'pages') || !Array.isArray(result.pages) || result.pages.length > 12) throw fail()
    const seen = new Set<string>()
    const targets = []
    const visual = prd.blocks.filter(block => block.requirementIds.some(id => !prd.requirements.find(requirement => requirement.id === id)?.nonVisualReason))
    for (const page of result.pages) {
      if (!page || Object.keys(page).some(key => !['blockId', 'kind', 'path', 'sourceId', 'quote', 'openDialog', 'expectedFields'].includes(key)) || !visual.some(block => block.id === page.blockId) || seen.has(page.blockId)) throw fail('区块映射重复、未知或字段无效')
      seen.add(page.blockId)
      if (page.kind === 'new') continue
      if (page.kind !== 'existing' || typeof page.quote !== 'string' || page.quote.length > 2000) throw fail()
      let path: string
      try { path = requirementPreviewPath(page.path) } catch { throw fail('路由不是受支持的具体路径，当前不支持动态参数、查询或哈希路由') }
      const source = snapshots.find(source => source.sourceId === page.sourceId)
      if (!source) throw fail('路由引用的来源不存在')
      const normalize = (text: string) => text.replace(/\r\n?/g, '\n').replace(/^\d+\t/gm, '')
      if (!normalize(source.text).includes(normalize(page.quote))) throw fail('路由引用与源码不匹配，请重新读取相关代码')
      if (!page.quote.includes(path)) throw fail('完整路径未出现在引用中，嵌套路由或常量组合需要进一步确认')
      const state = page as typeof page & { openDialog?: string; expectedFields?: string[] }
      const evidenced = (text: unknown): text is string => typeof text === 'string' && !!text.trim() && text.length <= 120 && snapshots.some(snapshot => snapshot.text.includes(text))
      if (state.openDialog !== undefined && !evidenced(state.openDialog)) throw fail('弹窗入口文字缺少源码证据')
      if (state.expectedFields !== undefined && (!Array.isArray(state.expectedFields) || !state.expectedFields.length || state.expectedFields.length > 80 || new Set(state.expectedFields).size !== state.expectedFields.length || state.expectedFields.some(field => !evidenced(field)))) throw fail('字段清单缺少源码证据或格式无效')
      if (state.openDialog && !state.expectedFields?.length) throw fail('弹窗必须提供完整现有字段清单')
      targets.push({ blockId: page.blockId, path, ...(state.openDialog ? { openDialog: state.openDialog } : {}), ...(state.expectedFields ? { expectedFields: state.expectedFields } : {}) })
    }
    if (visual.some(block => !seen.has(block.id))) throw fail('未覆盖全部可视 PRD 区块，可将多个区块映射到同一已有页面')
    if (!targets.length) throw fail('没有确认任何已有业务页面')
    return targets
  } catch (error) {
    if (error instanceof RequirementDiagnosticError && error.code === 'PAGE_MAPPING') throw error
    throw fail()
  }
}
export async function captureExistingPages(originValue: string, targets: CaptureTarget[], signal: AbortSignal, options: { onLoginRequired?: (controls: RequirementLoginControls) => Promise<void> } = {}) {
  const origin = requirementPreviewOrigin(originValue)
  if (!targets.length || targets.length > 12) throw new Error('Capture requires 1..12 pages')
  targets.forEach(target => requirementPreviewPath(target.path))
  const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATHEXT'].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []))
  const failure = (code: string, message: string) => new RequirementDiagnosticError('output_validation', code, message)
  const controller = new AbortController()
  let browser: Browser | undefined
  let launching: Promise<Browser> | undefined
  let stopped = false
  let deadline: ReturnType<typeof setTimeout> | undefined
  const cancelled = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
  })
  void cancelled.catch(() => {})
  const abort = () => {
    controller.abort(signal.reason)
    void browser?.close().catch(() => {})
  }
  const setDeadline = (milliseconds: number) => {
    clearTimeout(deadline)
    deadline = setTimeout(() => {
      controller.abort(failure('PAGE_CAPTURE_TIMEOUT', '页面取证或人工登录等待超时，浏览器已关闭'))
      void browser?.close().catch(() => {})
    }, milliseconds)
  }
  const checkActive = () => {
    controller.signal.throwIfAborted()
    if (stopped) throw failure('PAGE_CAPTURE_LOGIN', '人工登录检查点已结束，请重新发起取证')
  }
  const launch = async (headless: boolean) => {
    checkActive()
    launching = chromium.launch({ channel: 'chrome', headless, env }).catch(() => { throw failure('PAGE_CAPTURE_BROWSER', '取证浏览器启动失败，请确认 API 运行机器已安装 Chrome 且服务账户可启动浏览器') })
    const launched = await launching
    if (stopped || controller.signal.aborted) {
      await launched.close().catch(() => {})
      checkActive()
    }
    browser = launched
    return launched
  }
  const newContext = (launched: Browser) => launched.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block', acceptDownloads: false })
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  setDeadline(120000)
  try {
    return await Promise.race([(async () => {
      try {
        const initial = await launch(true)
        try {
          const context = await newContext(initial)
          if (origin === 'https://tmp.test.sunmi.com') {
            const config = await testLoginConfig()
            if (config) await loginTmp(context, config, controller.signal)
          }
          return await captureWithContext(context, origin, targets, controller.signal)
        }
        finally { await initial.close().catch(() => {}); browser = undefined }
      } catch (error) {
        checkActive()
        if (!(error instanceof RequirementDiagnosticError) || error.code !== 'PAGE_CAPTURE_LOGIN' || !options.onLoginRequired) throw error
      }
      setDeadline(300000)
      const expiresAt = new Date(Date.now() + 300000).toISOString()
      let loginActive = true
      let context: BrowserContext | undefined
      let opening: Promise<void> | undefined
      const controls: RequirementLoginControls = {
        origin,
        expiresAt,
        open: async () => {
          checkActive()
          if (!loginActive) return Promise.reject(failure('PAGE_CAPTURE_LOGIN', '人工登录检查点已结束，请重新发起取证'))
          opening ??= (async () => {
            const visible = await launch(false)
            checkActive()
            context = await newContext(visible)
            checkActive()
            const loginPage = await context.newPage()
            context.on('page', page => {
              if (page !== loginPage) void page.close().catch(() => {})
            })
            loginPage.on('dialog', dialog => { void dialog.dismiss().catch(() => {}) })
            await context.routeWebSocket('**/*', socket => socket.close())
            await context.route('**/*', async route => {
              const request = route.request()
              const url = new URL(request.url())
              try { if (request.frame().page() !== loginPage) return route.abort() }
              catch { return route.abort() }
              const authenticationPaths = ['/login', '/user/login', '/api/login', '/api/auth/login', '/auth/login', '/session']
              if (!loginActive || controller.signal.aborted || url.origin !== origin || url.username || url.password || !['GET', 'HEAD', 'POST'].includes(request.method()) || (request.method() === 'POST' && !authenticationPaths.includes(url.pathname))) return route.abort()
              try {
                const response = await fetchWithinOrigin(context!, request, origin, controller.signal, destination => loginActive && (request.method() !== 'POST' || authenticationPaths.includes(destination.pathname)))
                if (!response) return route.abort()
                await route.fulfill({ response })
              } catch { await route.abort().catch(() => {}) }
            })
            await loginPage.goto(`${origin}${targets[0].path}`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {
              checkActive()
              throw failure('PAGE_CAPTURE_LOGIN', '人工登录页面加载失败，请检查同源登录页面；未保留浏览器错误')
            })
          })()
          void opening.catch(() => {})
          return opening
        },
      }
      try {
        await options.onLoginRequired(controls)
        checkActive()
        if (opening) await opening
      } finally { loginActive = false }
      checkActive()
      if (!context) throw failure('PAGE_CAPTURE_LOGIN', '未打开人工登录浏览器，无法继续取证')
      await Promise.all(context.pages().map(page => page.close()))
      context.removeAllListeners('page')
      await context.unrouteAll({ behavior: 'wait' })
      checkActive()
      setDeadline(120000)
      return captureWithContext(context, origin, targets, controller.signal)
    })(), cancelled])
  } finally {
    stopped = true
    clearTimeout(deadline)
    signal.removeEventListener('abort', abort)
    await browser?.close().catch(() => {})
    await launching?.then(launched => launched.close()).catch(() => {})
  }
}

async function fetchWithinOrigin(context: BrowserContext, request: Request, origin: string, signal: AbortSignal, allow: (destination: URL) => boolean) {
  let destination = new URL(request.url())
  let method = request.method()
  let data = request.postDataBuffer() ?? undefined
  const headers = { ...request.headers() }
  delete headers.cookie
  for (let redirects = 0; redirects < 20; redirects++) {
    signal.throwIfAborted()
    if (!allow(destination) || destination.origin !== origin || destination.username || destination.password) return
    const response = await context.request.fetch(destination.href, { method, headers, data, maxRedirects: 0 })
    const status = response.status()
    const location = response.headers().location
    if (![301, 302, 303, 307, 308].includes(status) || !location) return response
    destination = new URL(location, destination)
    await response.dispose()
    if ((status === 303 && method !== 'HEAD') || ([301, 302].includes(status) && method === 'POST')) {
      method = 'GET'
      data = undefined
      delete headers['content-type']
      delete headers['content-length']
    }
  }
}

async function captureWithContext(context: BrowserContext, origin: string, targets: CaptureTarget[], signal: AbortSignal) {
  const failure = (code: string, message: string) => new RequirementDiagnosticError('output_validation', code, message)
    let currentPath = ''
    let blockedLogin = false
    let blockedNavigation = false
    let blockedResources = 0
    await context.route('**/*', async route => {
      const request = route.request()
      const url = new URL(request.url())
      let nestedFrame = false
      try { nestedFrame = Boolean(request.frame().parentFrame()) }
      catch { return route.abort() }
      if (request.isNavigationRequest() && (url.pathname !== currentPath || nestedFrame)) {
        if (!nestedFrame) {
          blockedLogin ||= /(?:^|\/)(?:login|signin|sign-in|auth)(?:\/|$)/i.test(url.pathname)
          blockedNavigation = true
        }
        return route.abort()
      }
      if (origin === 'https://tmp.test.sunmi.com' && !url.username && !url.password && ['GET', 'HEAD'].includes(request.method()) && allowedTmpRequest(url, request.method(), request.resourceType()) && (!request.isNavigationRequest() || url.origin === origin)) return route.continue()
      if (url.origin !== origin || !['GET', 'HEAD'].includes(request.method())) blockedResources++
      if (url.origin !== origin || url.username || url.password || !['GET', 'HEAD'].includes(request.method())) return route.abort()
      try {
        const response = await fetchWithinOrigin(context, request, origin, signal, destination => {
          if (request.isNavigationRequest() && destination.pathname !== currentPath) {
            blockedLogin ||= /(?:^|\/)(?:login|signin|sign-in|auth)(?:\/|$)/i.test(destination.pathname)
            blockedNavigation = true
            return false
          }
          if (destination.origin !== origin || destination.username || destination.password) {
            blockedResources++
            return false
          }
          return true
        })
        if (!response) return route.abort()
        await route.fulfill({ response })
      } catch { await route.abort().catch(() => {}) }
    })
    await context.routeWebSocket('**/*', socket => socket.close())
    const captures = []
    for (const target of targets) {
      signal.throwIfAborted()
      const page = await context.newPage()
      currentPath = target.path
      blockedLogin = false; blockedNavigation = false; blockedResources = 0
      let step = '页面加载'
      page.on('popup', popup => { void popup.close() })
      page.on('dialog', dialog => { void dialog.dismiss() })
      page.on('response', response => {
        if (!response.request().isNavigationRequest()) return
        const location = response.headers().location
        if (!location) return
        try {
          const destination = new URL(location, response.url())
          if (/(?:^|\/)(?:login|signin|sign-in|auth)(?:\/|$)/i.test(destination.pathname)) blockedLogin = true
          if (destination.origin !== origin || destination.pathname !== target.path) blockedNavigation = true
        } catch { blockedNavigation = true }
      })
      try {
        const response = await page.goto(`${origin}${target.path}`, { waitUntil: 'domcontentloaded', timeout: 20000 })
        if (!response || response.status() >= 400) throw failure('PAGE_CAPTURE_HTTP', `业务页面响应失败（${response?.status() ?? '无响应'}），请确认路由和页面访问权限`)
        step = '页面渲染'
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
        if (blockedLogin || /(?:^|\/)(?:login|signin|sign-in|auth)(?:\/|$)/i.test(new URL(page.url()).pathname) || await page.locator('input[type=password]').count()) throw failure('PAGE_CAPTURE_LOGIN', '业务页面需要登录，请在专用取证浏览器直接完成登录；不要提交密码、Cookie 或令牌')
        step = '等待页面主体可见'
        await page.locator('body').waitFor({ state: 'visible', timeout: 10000 }).catch(error => {
          if (blockedResources) throw failure('PAGE_CAPTURE_RESOURCES', '页面主体未显示，必要的跨域资源或非 GET/HEAD 请求被拦截；请确认并授权页面依赖域名，当前未进入登录检查点')
          throw error
        })
        step = '等待页面字体就绪'
        await page.evaluate(async () => { await document.fonts.ready })
        step = '读取业务页面内容'
        if (blockedLogin || /(?:^|\/)(?:login|signin|sign-in|auth)(?:\/|$)/i.test(new URL(page.url()).pathname) || await page.locator('input[type=password]').count()) throw failure('PAGE_CAPTURE_LOGIN', '业务页面需要登录；独立取证浏览器没有 OA/LDAP 会话。请提供可匿名读取的测试页面或脱敏页面截图，不要提交密码、Cookie 或令牌')
        if (!(await page.locator('body').innerText()).trim()) throw failure(blockedResources ? 'PAGE_CAPTURE_RESOURCES' : 'PAGE_CAPTURE_BLANK', blockedResources ? '页面为空，取证期间有跨域资源或非 GET/HEAD 请求被拦截；请补充页面依赖域名和读取接口说明，不要提交凭据' : '页面渲染后为空，请确认测试页面可访问且包含业务内容')
        step = '等待目标业务内容就绪'
        const business = page.locator('main, [role=main]').first()
        if (await business.count()) {
          try {
            await page.waitForFunction(() => {
              const main = document.querySelector<HTMLElement>('main, [role=main]')
              if (!main?.innerText.trim() || /^(loading[.\s]*|加载中[.。\s]*|正在加载[.。\s]*)$/i.test(main.innerText.trim())) return false
              return !Array.from(main.querySelectorAll<HTMLElement>('[aria-busy=true], .ant-spin-spinning, .el-loading-mask, [role=progressbar]')).some(element => element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0)
            }, undefined, { timeout: 10000 })
          } catch { throw failure('PAGE_CAPTURE_NOT_READY', '目标业务区域仍为空或加载中，未将导航外壳保存为有效取证') }
        }
        if (target.openDialog) {
          const trigger = page.getByRole('button', { name: target.openDialog, exact: true })
          try {
            await trigger.waitFor({ state: 'visible', timeout: 10000 })
            if (await trigger.evaluate(element => element.tagName !== 'BUTTON' || (element as HTMLButtonElement).type === 'submit' || !!element.closest('form'))) throw new Error('Unsafe opener')
            await trigger.click({ timeout: 5000 })
            await page.locator('[role=dialog], dialog[open], .ant-modal-content, .el-dialog').filter({ visible: true }).first().waitFor({ state: 'visible', timeout: 10000 })
          } catch { throw failure('PAGE_CAPTURE_TARGET', '无法安全打开已确认的表单弹窗；未填写、提交或使用其他页面替代') }
        }
        const region = target.openDialog ? page.locator('[role=dialog], dialog[open], .ant-modal-content, .el-dialog').filter({ visible: true }).first() : business
        for (const field of target.expectedFields ?? []) {
          try { await region.getByText(field, { exact: true }).first().waitFor({ state: 'visible', timeout: 5000 }) }
          catch { throw failure('PAGE_CAPTURE_FIELDS', '目标表单未展示完整的源码字段清单，已停止取证和 PRD 生成') }
        }
        if (new URL(page.url()).origin !== origin || new URL(page.url()).pathname !== target.path) throw failure('PAGE_CAPTURE_REDIRECT', '业务页面跳转到其他地址，已停止取证；请确认准确的业务页面路由')
        await page.locator('input[type=password], input[type=email], [data-sensitive], [autocomplete*=credit-card]').evaluateAll(elements => elements.forEach(element => { (element as HTMLElement).style.visibility = 'hidden' }))
        const structure = await page.locator('body').evaluate(body => ({
          title: document.title,
          regions: Array.from(body.querySelectorAll('header,nav,aside,main,section,table,form')).slice(0, 40).map(element => {
            const rect = element.getBoundingClientRect()
            const style = getComputedStyle(element)
            return { tag: element.tagName, width: Math.round(rect.width), height: Math.round(rect.height), x: Math.round(rect.x), y: Math.round(rect.y), color: style.color, background: style.backgroundColor, font: style.fontFamily }
          }),
        }))
        Object.assign(structure, { fields: target.expectedFields ?? [], ...(target.openDialog ? { dialog: target.openDialog } : {}) })
        step = '截图保存'
        const png = await page.screenshot({ type: 'png', animations: 'disabled', timeout: 10000 })
        if (png.length > 5 * 1024 * 1024) throw new Error('Capture exceeds image limit')
        captures.push({ ...target, structure, png })
      } catch (error) {
        if (signal.aborted) throw error
        if (blockedLogin) throw failure('PAGE_CAPTURE_LOGIN', '业务页面跳转到登录页，已阻止该导航；独立取证浏览器没有 OA/LDAP 会话。请提供可匿名读取的测试页面或脱敏页面截图，不要提交密码、Cookie 或令牌')
        if (error instanceof RequirementDiagnosticError) throw error
        if (blockedNavigation) throw failure('PAGE_CAPTURE_REDIRECT', '取证期间发生未经允许的页面跳转，已阻止；请确认业务页面路由及登录要求')
        throw failure('PAGE_CAPTURE_LOAD', `${step}失败，请检查 API 运行机器的网络、TLS 证书和页面响应；未保留原始浏览器错误`)
      } finally { await page.close().catch(() => {}) }
    }
    return captures
}