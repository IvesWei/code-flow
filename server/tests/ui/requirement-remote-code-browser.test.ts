import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright-core'
import { expect } from '@playwright/test'
import { executionEnvironment } from '../../execution/execution-environment.js'
import type { RequirementProject } from '../../../shared/requirements.js'

test('remote repository form: exact JSON, CAS retry, busy/abort, local uploads and four responsive widths', { timeout: 180000 }, async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'requirement-remote-code-ui-'))
  const selectedRoot = join(temporary, 'local-project')
  mkdirSync(selectedRoot)
  writeFileSync(join(selectedRoot, 'main.ts'), 'export const local = true')
  const server = await createServer({ configFile: false, envDir: false, cacheDir: join(temporary, '.vite'), plugins: [react()], server: { host: '127.0.0.1', port: 0, watch: null } })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  let releaseRequest = () => {}
  let holdRequest: Promise<void> | undefined
  function hold() { holdRequest = new Promise<void>(resolve => { releaseRequest = resolve }) }
  try {
    await server.listen()
    const address = server.httpServer?.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    browser = await chromium.launch({ channel: 'chrome', headless: true, env: executionEnvironment() })
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    await context.addInitScript(() => {
      const originalFetch = window.fetch
      window.fetch = (input, init) => {
        if (typeof input === 'string' && input.endsWith('/remote-code-snapshot')) {
          init?.signal?.addEventListener('abort', () => sessionStorage.setItem('remote:aborted', 'true'), { once: true })
        }
        return originalFetch(input, init)
      }
    })
    const page = await context.newPage()
    const root = '/api/requirements/projects'
    const projectId = 'remote-code-fixture'
    const endpoint = `${root}/${projectId}`
    const at = '2026-11-02T00:00:00.000Z'
    const project: RequirementProject = { schemaVersion: 1, id: projectId, ownerId: 7, version: 1, title: '远程仓库隔离项目', description: '隔离资料输入', modelId: 'auto', createdAt: at, updatedAt: at, status: 'draft', sources: [], evidence: [], questions: [], decisions: [], revisions: [], jobs: [], events: [] }
    const writes: Record<string, unknown>[] = []
    const localWrites: unknown[] = []
    const uploads: string[] = []
    const violations: string[] = []
    const remoteHeaders: string[] = []
    let detailReads = 0
    let failRefresh = false
    let outcome: 'success' | 'conflict' | 'failure' = 'success'
    await context.route('**/*', async route => {
      const request = route.request()
      const url = new URL(request.url())
      if (url.origin === 'https://fonts.googleapis.com') return route.fulfill({ contentType: 'text/css', body: '' })
      if (url.origin !== origin) { violations.push(`External request: ${url.origin}`); return route.abort() }
      if (!url.pathname.startsWith('/api/')) return route.continue()
      const reply = (json: unknown, status = 200) => route.fulfill({ json, status })
      if (request.method() === 'GET') {
        if (url.pathname === '/api/auth/status') return reply({ configured: true, authenticated: true, login: 'fixture', userId: 7 })
        if (url.pathname === '/api/copilot/models' || url.pathname === '/api/models') return reply({ defaultModelId: 'auto', models: [{ id: 'auto', name: 'Auto', vision: true }] })
        if (url.pathname === '/api/tasks') return reply({ items: [], busy: false })
        if (url.pathname === root) return reply([project])
        if (url.pathname === endpoint) { detailReads++; return failRefresh ? reply({ error: '模拟刷新失败' }, 503) : reply(project) }
      }
      if (request.method() === 'POST' && url.pathname === `${endpoint}/remote-code-snapshot`) {
        const body = request.postDataJSON() as Record<string, unknown>
        writes.push(body)
        remoteHeaders.push(request.headers()['content-type'])
        if (Object.keys(body).some(key => !['version', 'repository', 'branch', 'directory'].includes(key))) {
          violations.push('Unknown remote field')
          return reply({ error: 'Unknown field' }, 400)
        }
        if (body.version !== project.version) { violations.push('Stale CAS version'); return reply({ error: 'Stale CAS version' }, 409) }
        const result = outcome
        const held = holdRequest
        holdRequest = undefined
        if (result === 'conflict') project.version++
        if (held) await held
        if (result === 'conflict') return reply({ error: '版本冲突，请使用最新版本重试' }, 409)
        if (result === 'failure') return reply({ error: '模拟拉取失败' }, 422)
        project.version++
        project.sources = [{ id: 'S-CODE', name: 'existing-project-code.md', kind: 'file', sha256: 'fixture', sizeBytes: 120 }]
        return reply(project).catch(() => {})
      }
      if (request.method() === 'POST' && url.pathname === `${endpoint}/code-snapshot`) {
        localWrites.push(request.postDataJSON()); project.version++
        return reply(project)
      }
      if (request.method() === 'POST' && url.pathname === `${endpoint}/sources`) {
        uploads.push(request.postDataBuffer()?.toString('utf8') || '')
        project.version++
        return reply(project)
      }
      violations.push(`Unexpected ${request.method()} ${url.pathname}`)
      return reply({ error: 'Unexpected fixture request' }, 400)
    })
    await page.goto(`${origin}/requirements/${projectId}`, { waitUntil: 'networkidle' })
    await page.getByText('补充文件与链接', { exact: true }).click()
    await page.getByText('添加已有项目代码', { exact: true }).click()
    const form = page.getByRole('form', { name: '远程仓库代码', exact: true })
    const repository = form.getByLabel('仓库地址', { exact: true })
    const branch = form.getByLabel('分支（可选）', { exact: true })
    const directory = form.getByLabel('模块目录（可选）', { exact: true })
    const submit = form.getByRole('button', { name: '拉取代码快照', exact: true })
    const local = page.getByRole('form', { name: '本地已有项目代码', exact: true })
    const localInput = local.getByLabel('项目目录', { exact: true })
    const localSubmit = local.getByRole('button', { name: '添加代码快照', exact: true })
    await expect(form.getByRole('heading', { name: '远程仓库代码' })).toBeVisible()
    await expect(submit).toBeDisabled()
    await expect(form.locator('input')).toHaveCount(3)
    await expect(form.locator('input[type="password"], input[name*="token" i]')).toHaveCount(0)
    for (const invalid of ['http://github.com/owner/repo', 'https://example.com/owner/repo', 'https://github.com/owner', 'https://github.com/owner/repo/tree/main', 'https://user:secret@github.com/owner/repo', 'https://github.com:444/owner/repo', 'https://github.com/owner/repo?token=fixture', 'https://github.com/owner/repo#main', 'git@github.com:owner/repo.git', 'not-a-url']) {
      await repository.fill(invalid)
      await expect(repository).toHaveAttribute('aria-invalid', 'true')
      await expect(form.getByRole('alert')).toContainText('请输入 GitHub HTTPS 或 code.sunmi.com 仓库地址')
      await expect(submit).toBeDisabled()
      await form.evaluate(element => { if (element instanceof HTMLFormElement) element.requestSubmit() })
    }
    assert.equal(writes.length, 0)
    await localInput.setInputFiles(selectedRoot)
    const longOwner = 'long-owner-'.repeat(12)
    const longRepository = 'long-repository-'.repeat(12)
    const repositories = [
      `https://github.com/${longOwner}/${longRepository}.git`,
      `http://code.sunmi.com/${longOwner}/${longRepository}.git`,
      `https://code.sunmi.com/${longOwner}/${longRepository}`,
      `https://github.com/${longOwner}/${longRepository}`,
    ]
    for (const [index, width] of [1440, 1367, 390, 320].entries()) {
      await page.setViewportSize({ width, height: 1000 })
      await repository.fill(repositories[index])
      await branch.fill(' feature/远程代码 ')
      await directory.fill(` packages/${'最长中文模块目录'.repeat(8)}/src `)
      await expect(form.getByRole('alert')).toHaveCount(0)
      await expect(repository).toHaveAttribute('aria-invalid', 'false')
      await expect(submit).toBeEnabled()
      await form.scrollIntoViewIfNeeded()
      const bounds = await form.boundingBox()
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1)
      const controls = form.locator('label, input, button, h3')
      const boxes = await controls.evaluateAll(elements => elements.map(element => {
        const box = element.getBoundingClientRect()
        return { x: box.x, right: box.right, width: box.width }
      }))
      for (const box of boxes) assert.ok(box.width > 0 && box.x >= bounds.x - 1 && box.right <= bounds.x + bounds.width + 1)
      const branchBox = await branch.boundingBox()
      const directoryBox = await directory.boundingBox()
      assert.ok(branchBox && directoryBox && (directoryBox.x >= branchBox.x + branchBox.width || directoryBox.y >= branchBox.y + branchBox.height))
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      await page.screenshot({ path: join(temporary, `remote-code-${width}.png`), fullPage: true })
      const version = project.version
      await submit.focus(); await page.keyboard.press('Enter')
      await expect(repository).toHaveValue('')
      await expect(branch).toHaveValue('')
      await expect(directory).toHaveValue('')
      assert.deepEqual(writes.at(-1), { repository: repositories[index], branch: 'feature/远程代码', directory: `packages/${'最长中文模块目录'.repeat(8)}/src`, version })
      await expect(local.getByRole('status')).toHaveText('候选 1 个文件 · 已排除 0 个文件')
      await expect(localInput).not.toHaveValue('')
      await expect(page.getByText('代码快照（只读）', { exact: false })).toBeVisible()
    }

    await repository.fill('http://code.sunmi.com/owner/retry.git')
    await branch.fill('release/fixture')
    await directory.fill('packages/module')
    const versionBeforeConflict = project.version
    const writesBeforeConflict = writes.length
    const readsBeforeConflict = detailReads
    outcome = 'conflict'; hold()
    await submit.click()
    await expect.poll(() => writes.length).toBe(writesBeforeConflict + 1)
    await expect(form.locator('fieldset')).toHaveAttribute('aria-busy', 'true')
    for (const control of [repository, branch, directory, submit, localInput, localSubmit, local.getByRole('button', { name: '取消选择' }), page.getByLabel('补充文件'), page.getByRole('button', { name: '分析需求', exact: true })]) await expect(control).toBeDisabled()
    await form.evaluate(element => { if (element instanceof HTMLFormElement) { element.requestSubmit(); element.requestSubmit() } })
    assert.equal(writes.length, writesBeforeConflict + 1)
    releaseRequest()
    await expect(page.getByRole('alert').first()).toContainText('版本冲突')
    await expect(submit).toBeEnabled()
    await expect(repository).toHaveValue('http://code.sunmi.com/owner/retry.git')
    await expect(branch).toHaveValue('release/fixture')
    await expect(directory).toHaveValue('packages/module')
    assert.equal(detailReads, readsBeforeConflict + 1)
    outcome = 'success'
    await submit.click()
    await expect(repository).toHaveValue('')
    assert.deepEqual(writes.slice(-2), [
      { repository: 'http://code.sunmi.com/owner/retry.git', branch: 'release/fixture', directory: 'packages/module', version: versionBeforeConflict },
      { repository: 'http://code.sunmi.com/owner/retry.git', branch: 'release/fixture', directory: 'packages/module', version: versionBeforeConflict + 1 },
    ])
    await expect(page.getByRole('alert')).toHaveCount(0)

    await repository.fill('https://github.com/owner/optional.git')
    await branch.fill('   '); await directory.fill('   ')
    outcome = 'failure'
    await submit.click()
    await expect(page.getByRole('alert').first()).toContainText('模拟拉取失败')
    await expect(repository).toHaveValue('https://github.com/owner/optional.git')
    await expect(branch).toHaveValue('   ')
    await expect(directory).toHaveValue('   ')
    await expect(submit).toBeEnabled()
    assert.deepEqual(writes.at(-1), { repository: 'https://github.com/owner/optional.git', version: project.version })
    outcome = 'success'; failRefresh = true
    await submit.click()
    await expect(page.getByRole('alert').first()).toContainText('模拟刷新失败')
    await expect(repository).toHaveValue('https://github.com/owner/optional.git')
    await expect(submit).toBeDisabled()
    failRefresh = false
    await page.getByRole('button', { name: '重新读取', exact: true }).click()
    await expect(submit).toBeEnabled()
    const retryVersion = project.version
    await submit.click()
    await expect(repository).toHaveValue('')
    assert.deepEqual(writes.at(-1), { repository: 'https://github.com/owner/optional.git', version: retryVersion })

    const localVersion = project.version
    await localSubmit.click()
    await expect(localInput).toHaveValue('')
    assert.deepEqual(localWrites, [{ version: localVersion, files: [{ path: 'main.ts', content: 'export const local = true' }] }])
    const uploadVersion = project.version
    await page.getByLabel('补充文件').setInputFiles({ name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('local attachment') })
    await page.getByRole('button', { name: '上传资料', exact: true }).click()
    await expect(page.getByLabel('补充文件')).toHaveValue('')
    assert.equal(uploads.length, 1)
    assert.match(uploads[0], new RegExp(`name="version"\r\n\r\n${uploadVersion}\r\n`))
    assert.match(uploads[0], /filename="fixture.txt"/)
    assert.match(uploads[0], /local attachment/)

    await repository.fill('https://github.com/owner/running')
    project.status = 'running'
    outcome = 'failure'
    await submit.click()
    await expect(page.getByRole('alert').first()).toContainText('模拟拉取失败')
    await expect(repository).toBeDisabled()
    await expect(submit).toBeDisabled()
    project.status = 'draft'
    await page.getByRole('button', { name: '重新读取', exact: true }).click()
    await expect(submit).toBeEnabled()

    outcome = 'success'; hold()
    const beforeAbort = writes.length
    await submit.click()
    await expect.poll(() => writes.length).toBe(beforeAbort + 1)
    await page.getByRole('link', { name: '新建项目', exact: true }).click()
    await expect(page.getByRole('heading', { name: '新建需求项目', exact: true })).toBeVisible()
    assert.equal(await page.evaluate(() => sessionStorage.getItem('remote:aborted')), 'true')
    releaseRequest()
    await expect(form).toHaveCount(0)
    await expect(page.getByRole('alert')).toHaveCount(0)
    assert.ok(remoteHeaders.every(header => /^application\/json/.test(header)))
    assert.deepEqual(violations, [])
    console.log(`Remote code screenshots: ${temporary}`)
  } finally {
    releaseRequest()
    await browser?.close()
    await server.close()
    if (process.env.KEEP_UI_SCREENSHOTS !== '1') rmSync(temporary, { recursive: true, force: true })
  }
})