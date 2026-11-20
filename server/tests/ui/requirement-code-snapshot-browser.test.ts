import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright-core'
import { expect } from '@playwright/test'
import { executionEnvironment } from '../../execution/execution-environment.js'
import { codeSnapshotLimits } from '../../../shared/requirement-code.js'
import type { RequirementProject } from '../../../shared/requirements.js'

test('local code directory: explicit relative JSON, CAS retry retention, disabled actions and responsive candidate list', { timeout: 120000 }, async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'requirement-code-ui-'))
  const selectedRoot = join(temporary, 'selected-project')
  const largeRoot = join(temporary, 'large-project')
  const excludedRoot = join(temporary, 'excluded-project')
  const expectedFiles = [
    { path: 'package.json', content: '{"name":"fixture"}' },
    { path: 'src/main.ts', content: 'export const message = "本地代码"' },
    { path: `src/${'最长中文代码文件名'.repeat(5)}.ts`, content: 'export const selected = true' },
  ]
  for (const item of [...expectedFiles, { path: '.env', content: 'EXCLUDED=fixture' }, { path: 'node_modules/lib/index.ts', content: 'excluded' }, { path: 'dist/app.js', content: 'excluded' }, { path: 'image.png', content: 'excluded' }]) {
    const target = join(selectedRoot, item.path)
    mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, item.content)
  }
  mkdirSync(largeRoot); writeFileSync(join(largeRoot, 'large.ts'), 'x'.repeat(codeSnapshotLimits.fileBytes + 1))
  mkdirSync(excludedRoot); writeFileSync(join(excludedRoot, '.env'), 'EXCLUDED=fixture')
  const server = await createServer({ configFile: false, envDir: false, cacheDir: join(temporary, '.vite'), plugins: [react()], server: { host: '127.0.0.1', port: 0, watch: null } })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  let releaseConflict = () => {}
  const heldConflict = new Promise<void>(resolve => { releaseConflict = resolve })
  try {
    await server.listen()
    const address = server.httpServer?.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    browser = await chromium.launch({ channel: 'chrome', headless: true, env: executionEnvironment() })
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    await context.addInitScript(() => {
      const readText = File.prototype.text
      File.prototype.text = function () {
        const reads: string[] = JSON.parse(sessionStorage.getItem('snapshot:reads') || '[]')
        reads.push(this.webkitRelativePath)
        sessionStorage.setItem('snapshot:reads', JSON.stringify(reads))
        return readText.call(this)
      }
    })
    const page = await context.newPage()
    const projectId = 'code-directory-fixture'
    const root = '/api/requirements/projects'
    const endpoint = `${root}/${projectId}`
    const at = '2026-11-02T00:00:00.000Z'
    const project: RequirementProject = { schemaVersion: 1, id: projectId, ownerId: 7, version: 1, title: '目录快照隔离项目', description: '隔离资料输入', modelId: 'auto', createdAt: at, updatedAt: at, status: 'draft', sources: [], evidence: [], questions: [], decisions: [], revisions: [], jobs: [], events: [] }
    const writes: unknown[] = []
    const violations: string[] = []
    let detailReads = 0
    let failRefresh = false
    await context.route('**/*', async route => {
      const request = route.request()
      const url = new URL(request.url())
      if (url.origin !== origin) return route.abort()
      if (!url.pathname.startsWith('/api/')) return route.continue()
      const reply = (json: unknown, status = 200) => route.fulfill({ json, status })
      if (request.method() === 'GET') {
        if (url.pathname === '/api/auth/status') return reply({ configured: true, authenticated: true, login: 'fixture', userId: 7 })
        if (url.pathname === '/api/copilot/models' || url.pathname === '/api/models') return reply({ defaultModelId: 'auto', models: [{ id: 'auto', name: 'Auto', vision: true }] })
        if (url.pathname === '/api/tasks') return reply({ items: [], busy: false })
        if (url.pathname === root) return reply([project])
        if (url.pathname === endpoint) { detailReads++; return failRefresh ? reply({ error: '模拟刷新失败' }, 503) : reply(project) }
      }
      if (request.method() === 'POST' && url.pathname === `${endpoint}/code-snapshot`) {
        const body = request.postDataJSON()
        writes.push(body)
        assert.deepEqual(Object.keys(body).sort(), ['files', 'version'])
        assert.match(request.headers()['content-type'], /^application\/json/)
        assert.deepEqual([...body.files].sort((first, second) => first.path.localeCompare(second.path)), [...expectedFiles].sort((first, second) => first.path.localeCompare(second.path)))
        for (const item of body.files) assert.deepEqual(Object.keys(item).sort(), ['content', 'path'])
        assert.equal(body.version, project.version)
        if (writes.length === 1) {
          project.version++
          await heldConflict
          return reply({ error: '版本冲突，请使用最新版本重试' }, 409)
        }
        project.version++
        project.sources = [{ id: 'S-CODE', name: 'existing-project-code.md', kind: 'file', sha256: 'fixture', sizeBytes: 120 }]
        return reply(project)
      }
      violations.push(`Unexpected ${request.method()} ${url.pathname}`)
      return reply({ error: 'Unexpected fixture request' }, 400)
    })
    await page.goto(`${origin}/requirements/${projectId}`, { waitUntil: 'networkidle' })
    await page.getByText('添加已有项目代码', { exact: true }).click()
    const form = page.getByRole('form', { name: '本地已有项目代码', exact: true })
    const input = form.getByLabel('项目目录', { exact: true })
    const add = form.getByRole('button', { name: '添加代码快照', exact: true })
    const cancel = form.getByRole('button', { name: '取消选择', exact: true })
    const reads = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('snapshot:reads') || '[]'))
    await expect(input).toHaveAttribute('webkitdirectory', '')
    await expect(add).toBeDisabled()
    await input.setInputFiles(largeRoot)
    await expect(form.getByRole('alert')).toContainText('文件超限')
    await expect(input).toHaveAttribute('aria-invalid', 'true')
    await expect(add).toBeDisabled()
    assert.deepEqual(await reads(), [])
    await input.setInputFiles(excludedRoot)
    await expect(form.getByRole('alert')).toContainText('没有符合规则')
    await expect(form.getByRole('status')).toHaveText('候选 0 个文件 · 已排除 1 个文件')
    await cancel.click()
    await expect(input).toHaveValue('')
    await input.setInputFiles(selectedRoot)
    await expect(form.getByRole('status')).toHaveText('候选 3 个文件 · 已排除 4 个文件')
    await expect(add).toBeEnabled()
    assert.deepEqual(await reads(), [])
    assert.equal(writes.length, 0)
    const list = form.getByRole('list', { name: '候选代码文件' })
    for (const width of [1440, 1367, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 })
      await expect(list).toBeHidden()
      await form.locator('summary').focus()
      await page.keyboard.press('Enter')
      await expect(list).toBeVisible()
      await expect(list.getByRole('listitem')).toHaveCount(3)
      await form.scrollIntoViewIfNeeded()
      const bounds = await form.boundingBox()
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1)
      for (const control of [input, add, cancel, list]) {
        const controlBounds = await control.boundingBox()
        assert.ok(controlBounds && controlBounds.x >= bounds.x - 1 && controlBounds.x + controlBounds.width <= bounds.x + bounds.width + 1)
      }
      const addBounds = await add.boundingBox()
      const cancelBounds = await cancel.boundingBox()
      assert.ok(addBounds && cancelBounds && (cancelBounds.x >= addBounds.x + addBounds.width || cancelBounds.y >= addBounds.y + addBounds.height))
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      await page.screenshot({ path: join(temporary, `code-candidates-expanded-${width}.png`), fullPage: true })
      await form.locator('summary').click()
    }
    await cancel.focus(); await page.keyboard.press('Enter')
    await expect(form.getByRole('status')).toHaveText('候选 0 个文件 · 已排除 0 个文件')
    await expect(input).toHaveValue('')
    assert.equal(writes.length, 0)
    await input.setInputFiles(selectedRoot)
    const initialDetailReads = detailReads
    await add.focus(); await page.keyboard.press('Enter')
    await expect.poll(() => writes.length).toBe(1)
    await expect(add).toBeDisabled()
    await expect(input).toBeDisabled()
    await expect(cancel).toBeDisabled()
    await expect(page.getByRole('button', { name: '分析需求', exact: true })).toBeDisabled()
    await form.evaluate(element => { if (element instanceof HTMLFormElement) element.requestSubmit() })
    assert.equal(writes.length, 1)
    releaseConflict()
    await expect(page.getByRole('alert').first()).toContainText('版本冲突')
    await expect(add).toBeEnabled()
    await expect(form.getByRole('status')).toHaveText('候选 3 个文件 · 已排除 4 个文件')
    await expect(input).not.toHaveValue('')
    assert.equal(detailReads, initialDetailReads + 1)
    assert.equal((await reads()).length, 3)
    await add.click()
    await expect(form.getByRole('status').filter({ hasText: '已排除' })).toHaveText('候选 0 个文件 · 已排除 0 个文件')
    await expect(input).toHaveValue('')
    await expect(page.getByText('代码快照（只读）', { exact: false })).toBeVisible()
    assert.equal(writes.length, 2)
    assert.equal(detailReads, initialDetailReads + 2)
    assert.deepEqual((await reads()).sort(), expectedFiles.flatMap(item => [`selected-project/${item.path}`, `selected-project/${item.path}`]).sort())
    await expect(page.getByRole('alert')).toHaveCount(0)

    await input.setInputFiles(selectedRoot)
    failRefresh = true
    await add.click()
    await expect(page.getByRole('alert').first()).toContainText('模拟刷新失败')
    await expect(add).toBeDisabled()
    await expect(input).toBeDisabled()
    await expect(form.getByRole('status')).toHaveText('候选 3 个文件 · 已排除 4 个文件')
    failRefresh = false
    await page.getByRole('button', { name: '重新读取', exact: true }).click()
    await expect(add).toBeEnabled()
    project.status = 'running'
    failRefresh = true
    await add.click()
    await expect(page.getByRole('alert').first()).toContainText('模拟刷新失败')
    failRefresh = false
    await page.getByRole('button', { name: '重新读取', exact: true }).click()
    await expect(input).toBeDisabled()
    await expect(add).toBeDisabled()
    assert.deepEqual(violations, [])
    console.log(`Code directory screenshots: ${temporary}`)
  } finally {
    releaseConflict()
    await browser?.close()
    await server.close()
    if (process.env.KEEP_UI_SCREENSHOTS !== '1') rmSync(temporary, { recursive: true, force: true })
  }
})