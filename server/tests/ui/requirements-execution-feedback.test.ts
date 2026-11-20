import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright-core'
import { expect } from '@playwright/test'
import { executionEnvironment } from '../../execution/execution-environment.js'
import type { RequirementJobStage, RequirementProject } from '../../../shared/requirements.js'

test('long operations provide contextual feedback before completion and preserve retry, navigation and background polling', { timeout: 180000 }, async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'requirements-execution-feedback-'))
  const directory = join(temporary, 'sample-code')
  mkdirSync(directory)
  writeFileSync(join(directory, 'example.ts'), 'export const value = 1\n')
  const server = await createServer({ configFile: false, envDir: false, cacheDir: join(temporary, '.vite'), plugins: [react()], server: { host: '127.0.0.1', port: 0, watch: null } })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  const at = '2026-11-12T08:00:00.000Z'
  const root = '/api/requirements/projects'
  const fixture: RequirementProject = {
    schemaVersion: 1, id: 'execution-feedback', ownerId: 7, version: 1, title: '隔离长耗时任务反馈', description: '保持既有数据与任务执行规则。', modelId: 'auto', createdAt: at, updatedAt: at, status: 'draft',
    preview: { origin: 'https://example.com', generation: 1 }, sources: [], evidence: [], questions: [], decisions: [], revisions: [], jobs: [], events: [],
  }
  try {
    await server.listen()
    const address = server.httpServer?.address()
    assert.ok(address && typeof address !== 'string')
    browser = await chromium.launch({ channel: 'chrome', headless: true, env: executionEnvironment() })
    for (const width of [1440, 1367, 390, 320]) {
      let project = structuredClone(fixture)
      let pending: { path: string; finish: (fail: boolean) => void } | undefined
      const writes: string[] = [], unexpected: string[] = [], errors: string[] = []
      const prdRetries: Record<string, unknown>[] = []
      const page = await browser.newPage({ viewport: { width, height: 1000 } })
      page.on('pageerror', error => errors.push(error.message))
      await page.route('**/api/**', async route => {
        const request = route.request(), path = new URL(request.url()).pathname
        const reply = (json: unknown, status = 200) => route.fulfill({ json, status })
        if (request.method() === 'GET') {
          if (path === '/api/auth/status') return reply({ configured: true, authenticated: true, login: 'fixture', userId: 7 })
          if (path === '/api/copilot/models' || path === '/api/models') return reply({ defaultModelId: 'auto', models: [{ id: 'auto', name: 'Auto', vision: true }] })
          if (path === '/api/tasks') return reply({ items: [], busy: false })
          if (path === root) return reply([project])
          if (path === `${root}/${project.id}`) return reply(project)
        }
        const operation = path.slice(`${root}/${project.id}`.length)
        if ((request.method() === 'POST' && ['/code-snapshot', '/remote-code-snapshot', '/jobs'].includes(operation)) || (request.method() === 'PATCH' && operation === '/preview')) {
          writes.push(operation)
          assert.equal(pending, undefined, 'Only one mutation may be active')
          const body = request.postDataJSON() as { version: number; stage?: RequirementJobStage; origin?: string; repository?: string; files?: { path: string; content: string }[] }
          assert.equal(body.version, project.version)
          if (operation === '/jobs' && body.stage === 'prd') { prdRetries.push({ ...body }); return reply(project, 202) }
          const fail = await new Promise<boolean>(finish => { pending = { path: operation, finish } })
          pending = undefined
          if (fail) return reply({ error: '隔离测试：快照读取失败，请重试' }, 503)
          if (operation === '/code-snapshot' || operation === '/remote-code-snapshot') {
            if (operation === '/code-snapshot') assert.deepEqual(body.files, [{ path: 'example.ts', content: 'export const value = 1\n' }])
            else {
              assert.equal(body.repository, 'https://github.com/example/sample')
              project.remoteCodeConfig = { repository: body.repository! }
            }
            project.sources.push({ id: `code-${project.version}`, name: 'existing-project-code.md', kind: 'file', sha256: 'fixture', sizeBytes: 32 })
          } else if (operation === '/preview') {
            project.preview = { origin: body.origin!, generation: project.preview!.generation + 1 }
          } else {
            assert.equal(body.stage, 'analyze')
            project.status = 'running'
            project.jobs.push({ id: 'analysis', stage: 'analyze', status: 'running', startedAt: at })
          }
          project.version++
          return reply(project)
        }
        unexpected.push(`${request.method()} ${path}`)
        return reply({ error: 'Unexpected endpoint' }, 404)
      })
      const tab = (name: string) => page.getByRole('tab', { name: new RegExp(`^${name}`) })
      const finish = async (path: string, fail = false) => {
        await expect.poll(() => pending?.path).toBe(path)
        pending!.finish(fail)
      }
      const assertFit = async (locator: ReturnType<typeof tab>) => {
        const box = await locator.boundingBox()
        assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1, `${width}: feedback stays within viewport`)
        assert.equal(await locator.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true)
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      }
      const assertLive = async (locator: ReturnType<typeof tab>) => {
        await expect(locator).toHaveAttribute('aria-live', 'polite')
        assert.equal(await locator.evaluate(element => !!element.closest('[aria-busy=true]')), false, 'Busy containers must not defer live feedback')
      }
      await page.goto(`http://127.0.0.1:${address.port}/requirements/${project.id}`, { waitUntil: 'networkidle' })
      await page.getByText('添加已有项目代码', { exact: true }).click()
      const local = page.getByRole('form', { name: '本地已有项目代码', exact: true })
      const remote = page.getByRole('form', { name: '远程仓库代码', exact: true })
      await local.getByLabel('项目目录', { exact: true }).setInputFiles(directory)
      await local.getByRole('button', { name: '添加代码快照', exact: true }).focus()
      await page.keyboard.press('Enter')
      const localPending = local.getByRole('status').filter({ hasText: '正在读取并保存本地代码快照' })
      await expect(localPending).toBeVisible()
      await expect(local.locator('button[type="submit"]')).toBeDisabled()
      await expect(local.locator('button[type="submit"]')).toContainText('正在添加代码快照…')
      await assertLive(localPending)
      await assertFit(localPending)
      await finish('/code-snapshot', true)
      await expect(local.getByRole('alert')).toContainText('快照读取失败')
      assert.equal(await local.getByLabel('项目目录').evaluate(element => (element as HTMLInputElement).files?.length), 1, 'Failed snapshots retain the chosen directory')
      await local.getByRole('button', { name: '添加代码快照', exact: true }).click()
      await finish('/code-snapshot')
      await expect(local.getByRole('status').filter({ hasText: '本地代码快照已添加' })).toBeVisible()
      await expect(local.locator('[aria-busy=true]')).toHaveCount(0)
      assert.equal(await local.getByLabel('项目目录').evaluate(element => (element as HTMLInputElement).files?.length), 0)

      await remote.getByRole('textbox', { name: '仓库地址', exact: true }).fill('https://github.com/example/sample')
      await remote.getByRole('button', { name: '拉取代码快照', exact: true }).click()
      await expect.poll(() => pending?.path).toBe('/remote-code-snapshot')
      const remotePending = remote.getByRole('status')
      await expect(remotePending).toContainText('正在拉取远程仓库代码快照')
      await expect(remote.locator('button[type="submit"]')).toBeDisabled()
      await expect(remote.locator('button[type="submit"]')).toContainText('正在拉取快照…')
      await expect(remote.getByRole('textbox', { name: '仓库地址', exact: true })).toBeDisabled()
      await assertLive(remotePending)
      const started = Date.now()
      await new Promise(resolve => setTimeout(resolve, 2200))
      assert.ok(Date.now() - started > 2000, 'Observe the actual in-flight UI after more than two seconds')
      await expect(remotePending).toBeVisible()
      await remote.evaluate(form => (form as HTMLFormElement).requestSubmit())
      assert.equal(writes.filter(path => path === '/remote-code-snapshot').length, 1, 'Repeated submits cannot start another snapshot request')
      await tab('任务记录').click()
      await tab('用户输入与证据').click()
      await expect(remotePending).toBeVisible()
      await assertFit(remotePending)
      await remote.scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(temporary, `remote-pending-${width}.png`), fullPage: true })
      await finish('/remote-code-snapshot', true)
      await expect(remote.getByRole('alert')).toContainText('快照读取失败')
      await expect(remote.getByRole('textbox', { name: '仓库地址', exact: true })).toHaveValue('https://github.com/example/sample')
      await remote.getByRole('button', { name: '拉取代码快照', exact: true }).click()
      await finish('/remote-code-snapshot')
      await expect(remote.getByRole('status')).toContainText('远程仓库代码快照已添加')
      await expect(remote.getByRole('textbox', { name: '仓库地址', exact: true })).toHaveValue('https://github.com/example/sample')
      await expect(remote.locator('[aria-busy=true]')).toHaveCount(0)
      await expect(page.getByRole('list', { name: '原始资料列表' }).getByText('existing-project-code.md', { exact: true })).toHaveCount(2)

      const preview = page.getByRole('region', { name: '现有系统取证', exact: true })
      await preview.getByRole('button', { name: '保存取证地址', exact: true }).focus()
      await page.keyboard.press('Enter')
      await expect(preview.getByRole('status').filter({ hasText: '正在保存取证配置' })).toBeVisible()
      await expect(preview.getByRole('button', { name: '保存取证地址', exact: true })).toBeDisabled()
      await finish('/preview')
      await expect(preview.getByRole('status').filter({ hasText: '取证配置已保存' })).toBeVisible()

      const overview = page.getByRole('region', { name: '项目概况', exact: true })
      await overview.getByRole('button', { name: '分析需求', exact: true }).click()
      await expect(overview.getByRole('status').filter({ hasText: '正在提交需求分析任务' })).toBeVisible()
      await expect(overview).not.toContainText('需求分析请求已提交')
      await finish('/jobs')
      const evidence = page.getByRole('region', { name: '资料证据', exact: true })
      await expect(evidence.getByRole('status')).toContainText('分析需求进行中')
      await expect(evidence.getByRole('progressbar')).toBeVisible()
      await tab('系统产物').click()
      const artifacts = page.getByRole('tabpanel', { name: /^系统产物/ })
      await expect(artifacts.getByRole('status')).toContainText('分析需求进行中')
      await expect(artifacts).toContainText('正在处理任务，系统产物尚未就绪')
      await assertFit(artifacts.getByRole('status'))
      await page.reload({ waitUntil: 'networkidle' })
      await expect(evidence.getByRole('status')).toContainText('分析需求进行中')
      project.jobs.at(-1)!.status = 'succeeded'
      project.events.push({ id: 'analysis', at, text: 'analysis:analysis' })
      project.status = 'draft'
      project.version++
      await expect(evidence.getByRole('progressbar')).toHaveCount(0, { timeout: 10000 })

      project.jobs.push({ id: 'prd', stage: 'prd', status: 'running', startedAt: at })
      project.status = 'running'
      project.events.push({ id: 'capture', at, text: '正在获取客户列表页面快照，等待页面渲染完成' })
      project.version++
      await page.reload({ waitUntil: 'networkidle' })
      await expect(preview.getByRole('status').filter({ hasText: '正在获取客户列表页面快照' })).toBeVisible()
      await assertFit(preview.getByRole('status').filter({ hasText: '正在获取客户列表页面快照' }))
      await tab('任务记录').click()
      const activity = page.getByRole('tabpanel', { name: /^任务记录/ })
      await expect(activity.getByRole('status')).toContainText('正在获取客户列表页面快照')
      await tab('系统产物').click()
      await expect(artifacts.getByRole('status')).toContainText('正在获取客户列表页面快照')
      await page.screenshot({ path: join(temporary, `capture-pending-${width}.png`), fullPage: true })
      project.jobs.at(-1)!.interaction = { kind: 'browser_login', phase: 'ready', origin: 'https://example.com', expiresAt: '2026-11-12T09:00:00.000Z' }
      project.version++
      await expect(page.getByRole('dialog', { name: '需要你完成系统登录', exact: true })).toBeVisible({ timeout: 10000 })
      await page.getByRole('button', { name: '收起登录提示', exact: true }).click()
      await expect(artifacts.getByRole('status')).toContainText('页面取证等待人工登录')
      await expect(artifacts.getByRole('progressbar')).toHaveCount(0)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await expect(local.locator('.requirements-spinner')).toHaveCount(0)
      project.jobs.at(-1)!.interaction = undefined
      project.version++
      await expect(artifacts.getByRole('progressbar')).toBeVisible({ timeout: 10000 })
      assert.equal(await artifacts.locator('.requirements-spinner').evaluate(element => getComputedStyle(element).animationName), 'none')
      project.jobs.at(-1)!.status = 'failed'
      project.jobs.at(-1)!.error = '[PAGE_CAPTURE_TIMEOUT] 隔离测试页面快照获取超时'
      project.status = 'failed'
      project.version++
      await expect(artifacts.getByRole('progressbar')).toHaveCount(0, { timeout: 10000 })
      await expect(overview.getByRole('alert')).toContainText('页面快照获取超时')
      assert.equal(prdRetries.length, 0)
      await overview.getByRole('button', { name: '继续生成 PRD', exact: true }).click()
      await expect.poll(() => prdRetries.length).toBe(1)
      await overview.getByText('全部阶段操作', { exact: true }).click()
      const restart = overview.getByRole('button', { name: '重新取证并生成 PRD', exact: true })
      await assertFit(restart)
      await restart.focus()
      await page.keyboard.press('Enter')
      await expect.poll(() => prdRetries.length).toBe(2)
      assert.deepEqual(prdRetries, [{ stage: 'prd', version: project.version }, { stage: 'prd', version: project.version, restartPrd: true }])
      project.jobs.at(-1)!.error = '[OUTPUT_VALIDATION] 字段缺少 options'
      project.version++
      await page.reload({ waitUntil: 'networkidle' })
      await expect(restart).toBeHidden()
      await overview.getByText('全部阶段操作', { exact: true }).click()
      await assertFit(restart)
      await restart.click()
      await expect.poll(() => prdRetries.at(-1)).toEqual({ stage: 'prd', version: project.version, restartPrd: true })
      assert.deepEqual(errors, [])
      assert.deepEqual(unexpected, [])
      await page.close()
    }
  } finally {
    await browser?.close()
    await server.close()
    if (process.env.KEEP_UI_SCREENSHOTS !== '1') rmSync(temporary, { recursive: true, force: true })
    else console.log(`execution feedback screenshots: ${temporary}`)
  }
})
