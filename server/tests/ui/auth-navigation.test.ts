import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright-core'
import { expect } from '@playwright/test'
import { executionEnvironment } from '../../execution/execution-environment.js'

test('login gate shares authentication across workspaces, handles logout and expires on 401', { timeout: 90_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codeflow-auth-ui-'))
  const server = await createServer({ configFile: false, envDir: false, cacheDir: join(directory, '.vite'), plugins: [react()], server: { host: '127.0.0.1', port: 0, watch: null } })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await server.listen()
    const address = server.httpServer?.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    browser = await chromium.launch({ channel: 'chrome', headless: true, env: executionEnvironment() })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    const scripts: string[] = []
    let documentRequests = 0
    page.on('request', request => {
      if (request.resourceType() === 'script') scripts.push(new URL(request.url()).pathname)
      if (request.resourceType() === 'document') documentRequests++
    })
    let authenticated = false
    let authRequests = 0
    let protectedRequests = 0
    let expired = false
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname
      let payload: unknown = {}
      if (path === '/api/auth/status') { authRequests++; payload = { configured: true, authenticated, login: authenticated ? 'fixture-user' : undefined } }
      else if (path === '/api/auth/start') {
        authenticated = true
        await route.fulfill({ status: 302, headers: { location: '/' } })
        return
      } else if (path === '/api/auth/logout') { authenticated = false }
      else {
        protectedRequests++
        if (expired) { await route.fulfill({ status: 401, json: { error: '登录已失效' } }); return }
        if (path === '/api/tasks') payload = { items: [], busy: false }
        else if (path === '/api/copilot/models') payload = { defaultModelId: 'auto', models: [] }
        else if (path.startsWith('/api/testing/')) payload = []
      }
      await route.fulfill({ json: payload })
    })
    const base = `http://127.0.0.1:${address.port}`
    await page.goto(base)
    await page.getByRole('heading', { name: '登录 Code / Flow' }).waitFor()
    assert.equal(protectedRequests, 0)
    assert.equal(authRequests, 1, 'StrictMode must share the initial status request')
    assert.ok(!scripts.includes('/src/features/coding/CodingWorkspace.tsx') && !scripts.includes('/src/features/testing/TestingWorkspace.tsx'), 'login must not eagerly load workspace modules')
    for (const width of [1440, 1367, 390, 320]) {
      await page.setViewportSize({ width, height: 900 })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      await page.screenshot({ path: join(directory, `login-${width}.png`) })
    }
    await page.getByRole('button', { name: '使用 GitHub 登录' }).focus()
    await page.keyboard.press('Enter')
    await page.getByRole('button', { name: /fixture-user/ }).waitFor()
    assert.ok(!scripts.includes('/src/features/testing/TestingWorkspace.tsx'), 'coding route must not load the testing workspace')
    const signedInRequests = authRequests
    const signedInDocuments = documentRequests
    const menu = page.getByRole('navigation', { name: '功能菜单' })
    assert.equal(await menu.getByRole('link').count(), 5)
    await expect(menu.getByRole('link', { name: '编码工作流', exact: true })).toHaveAttribute('aria-current', 'page')
    assert.equal(await page.locator('.sidebar .brand').count(), 0)
    assert.equal(await page.locator('.guide-pane').count(), 0)
    for (const width of [1440, 1367, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 })
      const rail = await page.locator('.feature-rail').boundingBox()
      const content = await page.locator('.application-content').boundingBox()
      assert.ok(rail && content && rail.x === 0 && rail.x + rail.width <= content.x + 1)
      assert.ok(content.x + content.width <= width + 1)
      for (const link of await menu.getByRole('link').all()) {
        const bounds = await link.boundingBox()
        assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= rail.width + 1)
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      if (width <= 1200) {
        await menu.getByRole('link', { name: '用例规划', exact: true }).hover()
        const tooltip = page.getByRole('tooltip', { name: '用例规划', exact: true })
        await tooltip.waitFor()
        const tooltipBounds = await tooltip.boundingBox()
        assert.ok(tooltipBounds && tooltipBounds.x >= rail.x + rail.width && tooltipBounds.x + tooltipBounds.width <= width)
        await menu.getByRole('link', { name: '用例规划', exact: true }).focus()
        await expect(tooltip).toBeVisible()
      }
      await page.screenshot({ path: join(directory, `feature-menu-${width}.png`) })
    }
    await menu.getByRole('link', { name: '自动化任务', exact: true }).focus()
    await page.keyboard.press('Enter')
    await page.getByRole('heading', { name: '自动化执行任务', exact: true }).waitFor()
    await expect(menu.getByRole('link', { name: '自动化任务', exact: true })).toHaveAttribute('aria-current', 'page')
    await page.getByRole('link', { name: '用例规划', exact: true }).click()
    await page.locator('.testing-auth').waitFor()
    await expect(menu.getByRole('link', { name: '用例规划', exact: true })).toHaveAttribute('aria-current', 'page')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    assert.equal(new URL(page.url()).pathname, '/planning')
    await page.getByRole('link', { name: '用例执行', exact: true }).click()
    assert.equal(new URL(page.url()).pathname, '/execution')
    await expect(menu.getByRole('link', { name: '用例执行', exact: true })).toHaveAttribute('aria-current', 'page')
    await page.goBack()
    await page.locator('.testing-auth').waitFor()
    await page.getByRole('link', { name: /fixture-user.*已登录/ }).click()
    await page.getByRole('button', { name: /fixture-user/ }).waitFor()
    await expect(menu.getByRole('link', { name: '编码工作流', exact: true })).toHaveAttribute('aria-current', 'page')
    await page.clock.install()
    await page.clock.fastForward(31_000)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    assert.equal(authRequests, signedInRequests, 'internal navigation must not reload authentication')
    assert.equal(documentRequests, signedInDocuments, 'internal navigation must not request a new HTML document')
    await page.reload()
    await page.getByRole('button', { name: /fixture-user/ }).waitFor()
    assert.equal(authRequests, signedInRequests + 1, 'refresh confirms the server session once')
    await page.getByRole('button', { name: /fixture-user/ }).click()
    await page.getByRole('heading', { name: '登录 Code / Flow' }).waitFor()
    await page.getByRole('button', { name: '使用 GitHub 登录' }).click()
    await page.getByRole('button', { name: /fixture-user/ }).waitFor()
    await page.goto(`${base}/planning`, { waitUntil: 'networkidle' })
    await page.getByRole('heading', { name: '用例规划', exact: true }).waitFor()
    await page.reload()
    await page.getByRole('heading', { name: '用例规划', exact: true }).waitFor()
    await page.goto(`${base}/?view=execution`, { waitUntil: 'networkidle' })
    await page.getByRole('heading', { name: '用例执行', exact: true }).waitFor()
    await page.goto(`${base}/missing-page`, { waitUntil: 'networkidle' })
    await page.getByRole('heading', { name: '页面不存在' }).waitFor()
    await page.getByRole('link', { name: '返回工作台', exact: true }).click()
    await page.getByRole('button', { name: /fixture-user/ }).waitFor()
    expired = true
    await page.getByRole('link', { name: '用例规划', exact: true }).click()
    await page.getByRole('heading', { name: '登录 Code / Flow' }).waitFor()
  } finally {
    await browser?.close()
    await server.close()
    if (process.env.KEEP_UI_SCREENSHOTS === '1') console.log(`Login screenshots: ${directory}`)
    else rmSync(directory, { recursive: true, force: true })
  }
})