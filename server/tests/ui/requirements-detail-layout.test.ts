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
import type { RequirementProject } from '../../../shared/requirements.js'

test('requirement detail zones preserve drafts, edit guards and responsive overlays without changing tasks', { timeout: 120000 }, async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'requirements-detail-layout-'))
  const server = await createServer({ configFile: false, envDir: false, cacheDir: join(temporary, '.vite'), plugins: [react()], server: { host: '127.0.0.1', port: 0, watch: null } })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  const at = '2026-11-11T08:00:00.000Z'
  const question = { id: 'Q1', text: '默认筛选是否保留已停用客户？', priority: 'P1' as const, impact: '影响默认展示范围', choices: ['保留', '不保留'] }
  const project: RequirementProject = {
    schemaVersion: 1, id: 'detail-layout', ownerId: 7, version: 1, title: '客户列表筛选与多行需求评审布局优化设计任务的长中文标题', description: '原始需求描述\n保持业务规则、权限、已有字段与状态门禁不变。', modelId: 'auto', createdAt: at, updatedAt: at, status: 'needs_input',
    sources: Array.from({ length: 12 }, (_, index) => ({ id: `source-${index}`, name: `原始需求说明与界面证据的较长文件名称-${index}.md`, kind: 'file', sha256: 'fixture', sizeBytes: 120 })),
    evidence: [{ sourceId: 'source-0', summary: '筛选条件与结果数量需要准确对应。', limitations: '只读资料，不代表业务交互验证通过。' }],
    questions: [question], decisions: [{ question: { ...question, id: 'resolved', text: '是否调整现有角色权限？' }, answer: '不调整角色权限。', at }],
    jobs: [{ id: 'analysis', stage: 'analyze', status: 'succeeded', startedAt: at }],
    events: [{ id: 'analysis', at, text: 'analysis:analysis' }, { id: 'prd', at, text: 'prd:revision-12' }],
    revisions: Array.from({ length: 12 }, (_, index) => ({
      id: `revision-${index + 1}`, createdAt: at,
      prd: { title: '客户列表需求', summary: '筛选客户并准确展示结果', blocks: [{ id: 'B1', title: '客户列表', requirementIds: ['REQ1'], sourceIds: ['source-0'], content: '保留现有查询规则' }], requirements: [{ id: 'REQ1', title: '按客户名称与状态组合筛选客户列表的多行需求标题', description: '筛选结果与总数一致', sourceIds: ['source-0'], acceptance: [{ id: 'AC1', text: '结果准确' }] }] },
      screens: [
        { id: 'screen-1', title: '客户列表名称与状态组合筛选的最长中文页面标题', state: '默认', requirementIds: ['REQ1'], acceptanceIds: ['AC1'], html: '<main><h1>客户列表</h1><p>仅供隔离布局验证</p></main>' },
        { id: 'screen-2', title: '客户列表名称与状态组合筛选的最长中文页面标题', state: '无匹配结果', requirementIds: ['REQ1'], acceptanceIds: ['AC1'], html: '<main>暂无匹配客户</main>' },
      ],
    })),
  }
  const previewOrigin = 'https://tmp.test.sunmi.com'
  const fixtureImage = { kind: 'file' as const, id: 'real', name: 'before.png', sha256: 'fixture', sizeBytes: 68 }
  project.sources[0].name = 'existing-project-code.md'
  project.revisions[0].existingPages = [{ blockId: 'B1', path: '/customers', capturedAt: at, fingerprint: 'fixture', image: fixtureImage, structure: '{}' }]
  const fallback = { code: 'PAGE_CAPTURE_TARGET', blocks: [{ blockId: 'B1', fields: ['客户名称'], content: [] }] }
  const latest = project.revisions.at(-1)!
  latest.capturePlan = { version: 1, fingerprint: 'fixture', blocks: [{ blockId: 'B1', kind: 'existing', reason: '已有页面' }], sourceFallback: fallback }
  latest.screenshots = [{ screenId: 'new-design', storageKey: 'not-before.png', sha256: 'fixture' }]
  let reconstructionRequests = 0
  const remoteCode = { repository: 'https://github.com/example/detail-layout.git', branch: 'main', directory: 'src/pages/Orders', commit: 'a'.repeat(40) }
  let created: RequirementProject | undefined
  let rejectSnapshot = false
  try {
    await server.listen()
    const address = server.httpServer?.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    browser = await chromium.launch({ channel: 'chrome', headless: true, env: executionEnvironment() })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.setDefaultTimeout(7500)
    const png = await page.screenshot({ clip: { x: 0, y: 0, width: 16, height: 10 } })
    const unexpected: string[] = [], errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/api/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname
      if (path === '/api/requirements/projects/detail-layout/jobs' && request.method() === 'POST') {
        assert.deepEqual(request.postDataJSON(), { stage: 'reconstruct', revisionId: latest.id, version: project.version })
        reconstructionRequests++
        project.jobs.push({ id: `replica-${reconstructionRequests}`, revisionId: latest.id, stage: 'reconstruct', startedAt: at, status: 'running' })
        project.version++
        return route.fulfill({ status: 202, json: project })
      }
      if (path.endsWith('/existing-pages/real') || path.endsWith('/source-reconstructions/replica')) {
        assert.equal(new URL(request.url()).searchParams.get('revision'), path.endsWith('/real') ? project.revisions[0].id : latest.id)
        return route.fulfill({ contentType: 'image/png', body: png })
      }
      if (request.method() === 'POST' && path === '/api/requirements/projects') {
        const { title, description, modelId, remoteCodeConfig } = request.postDataJSON()
        assert.deepEqual(remoteCodeConfig, { repository: remoteCode.repository, branch: remoteCode.branch, directory: remoteCode.directory })
        created = { ...project, id: rejectSnapshot ? 'created-partial' : 'created-complete', title, description, modelId, remoteCodeConfig, version: 1, status: 'draft', sources: [], evidence: [], questions: [], decisions: [], jobs: [], revisions: [], events: [] }
        return route.fulfill({ status: 201, json: created })
      }
      if (created && path === `/api/requirements/projects/${created.id}/preview` && request.method() === 'PATCH') {
        assert.deepEqual(request.postDataJSON(), { version: created.version, origin: previewOrigin, entryPaths: [] })
        created.preview = { origin: previewOrigin, generation: 1 }
        created.version++
        return route.fulfill({ json: created })
      }
      if (created && path === `/api/requirements/projects/${created.id}/remote-code-snapshot` && request.method() === 'POST') {
        const { commit: _commit, ...input } = remoteCode
        assert.deepEqual(request.postDataJSON(), { version: created.version, ...input })
        if (rejectSnapshot) return route.fulfill({ status: 400, json: { error: '隔离测试：仓库读取失败' } })
        created.sources.push({ id: 'remote-source', name: 'existing-project-code.md', kind: 'file', sha256: 'fixture', sizeBytes: 120, remoteCode })
        created.version++
        return route.fulfill({ json: created })
      }
      if (request.method() !== 'GET') { unexpected.push(`${request.method()} ${path}`); return route.fulfill({ status: 400, json: { error: '布局测试不允许写入' } }) }
      if (path === '/api/auth/status') return route.fulfill({ json: { configured: true, authenticated: true, login: 'fixture', userId: 7 } })
      if (path === '/api/copilot/models' || path === '/api/models') return route.fulfill({ json: { defaultModelId: 'auto', models: [{ id: 'auto', name: 'Auto', vision: true }] } })
      if (path === '/api/tasks') return route.fulfill({ json: { items: [], busy: false } })
      if (path === '/api/requirements/projects') return route.fulfill({ json: [project] })
      if (path === '/api/requirements/projects/detail-layout') return route.fulfill({ json: project })
      if (created && path === `/api/requirements/projects/${created.id}`) return route.fulfill({ json: created })
      unexpected.push(`${request.method()} ${path}`)
      return route.fulfill({ status: 404, json: { error: 'Unexpected endpoint' } })
    })
    const tab = (name: string) => page.getByRole('tab', { name: new RegExp(`^${name}`) })
    const assertBounds = async (label: string, locator: ReturnType<typeof tab>) => {
      const box = await locator.boundingBox()
      assert.ok(box && box.x >= 0 && box.x + box.width <= page.viewportSize()!.width + 1, `${label} horizontal bounds`)
      return box
    }
    for (const width of [1440, 1367, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 })
      await page.goto(`${origin}/requirements/detail-layout`, { waitUntil: 'networkidle' })
      await expect(tab('系统产物')).toHaveAttribute('aria-selected', 'true')
      await tab('系统产物').focus(); await page.keyboard.press('ArrowRight')
      await expect(tab('澄清与决策')).toBeFocused()
      await expect(page.getByRole('textbox', { name: '回答 · Q1', exact: true })).toBeVisible()
      await page.getByRole('textbox', { name: '回答 · Q1', exact: true }).fill(`保留，宽度 ${width}`)
      await page.getByRole('button', { name: '去填写答案', exact: true }).click()
      await expect(tab('澄清与决策')).toBeFocused()
      await tab('用户输入与证据').click()
      const evidence = page.getByRole('region', { name: '现有系统图像证据' })
      await expect(evidence).toContainText('真实截图 0 张 · 源码复刻 0 张')
      await expect(evidence).toContainText('PAGE_CAPTURE_TARGET')
      await expect(evidence.getByRole('img')).toHaveCount(0)
      await expect(evidence.getByRole('button', { name: '生成现状复刻图' })).toBeDisabled()
      await page.getByText('补充文件与链接', { exact: true }).click()
      await page.getByRole('textbox', { name: '补充链接', exact: true }).fill('https://example.com/layout')
      await page.getByLabel('补充文件', { exact: true }).setInputFiles({ name: 'layout-only.md', mimeType: 'text/markdown', buffer: Buffer.from('Isolated input retention') })
      for (const name of ['系统产物', '任务记录', '澄清与决策', '用户输入与证据']) {
        await tab(name).click()
        await assertBounds(`${width} ${name} panel`, page.getByRole('tabpanel', { name: new RegExp(`^${name}`) }))
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width} ${name}: document overflow`)
        const boxes = await page.getByRole('tab').evaluateAll(elements => elements.map(element => { const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } }))
        for (const [index, box] of boxes.entries()) {
          assert.ok(box.left >= 0 && box.right <= width + 1)
          for (const other of boxes.slice(index + 1)) assert.ok(box.right <= other.left + 1 || other.right <= box.left + 1 || box.bottom <= other.top + 1 || other.bottom <= box.top + 1, 'tabs do not overlap')
        }
      }
      await expect(page.getByRole('textbox', { name: '补充链接', exact: true })).toHaveValue('https://example.com/layout')
      assert.equal(await page.getByLabel('补充文件', { exact: true }).evaluate(element => (element as HTMLInputElement).files?.[0]?.name), 'layout-only.md')
      await page.getByRole('heading', { name: '用户输入与证据', exact: true }).click()
      await page.screenshot({ path: join(temporary, `detail-inputs-${width}.png`), fullPage: true })
      await tab('澄清与决策').click()
      await expect(page.getByRole('textbox', { name: '回答 · Q1', exact: true })).toHaveValue(`保留，宽度 ${width}`)
      await tab('系统产物').click()
      const selector = page.getByRole('combobox', { name: '修订历史', exact: true })
      await selector.click()
      const listbox = page.getByRole('listbox')
      const menu = await assertBounds(`${width} revision menu`, listbox)
      const trigger = await selector.boundingBox()
      assert.ok(menu.y >= 0 && menu.y + menu.height <= 1001)
      assert.ok(trigger && (menu.y >= trigger.y + trigger.height - 1 || menu.y + menu.height <= trigger.y + 1))
      await page.screenshot({ path: join(temporary, `detail-revision-expanded-${width}.png`), fullPage: true })
      await listbox.press('Home'); await listbox.press('Enter')
      await expect(page.getByText('历史修订 · 只读', { exact: true })).toBeVisible()
      await tab('用户输入与证据').click()
      await expect(evidence).toContainText('历史修订 · 真实截图 1 张 · 源码复刻 0 张')
      const original = evidence.getByRole('link', { name: /查看原图：真实截图/ })
      await original.focus()
      await expect(original).toBeFocused()
      await expect(original).toHaveAttribute('href', /\/existing-pages\/real\?revision=revision-1$/)
      await expect(original.locator('img')).toHaveJSProperty('naturalWidth', 16)
      await assertBounds(`${width} evidence image`, original)
      await expect(evidence.getByRole('button')).toHaveCount(0)
      await tab('系统产物').click()
      await selector.press('ArrowDown'); await listbox.press('End'); await listbox.press('Enter')
      await selector.press('ArrowDown'); await listbox.press('Escape')
      await expect(selector).toBeFocused()
      await selector.click(); await page.getByRole('heading', { name: '系统产物', exact: true }).click()
      await expect(listbox).toHaveCount(0)
      await page.getByRole('button', { name: '宽屏评审', exact: true }).click()
      await expect(page.locator('dialog:modal')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('button', { name: '宽屏评审', exact: true })).toBeFocused()
    }
    project.questions = []
    project.status = 'prd_review'
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.reload({ waitUntil: 'networkidle' })
    await tab('用户输入与证据').click()
    const evidence = page.getByRole('region', { name: '现有系统图像证据' })
    const generate = evidence.getByRole('button', { name: '生成现状复刻图' })
    assert.equal(reconstructionRequests, 0)
    for (const success of [false, true]) {
      await generate.focus(); await page.keyboard.press('Enter')
      await expect(generate).toBeDisabled()
      await expect(evidence.getByRole('progressbar')).toBeVisible()
      const job = project.jobs.at(-1)!
      job.status = success ? 'succeeded' : 'failed'
      if (success) latest.capturePlan!.sourceFallback!.images = [{ blockId: 'B1', createdAt: at, image: { ...fixtureImage, id: 'replica' } }]
      else job.error = '源码依据不足'
      project.version++
      if (!success) await expect(evidence.getByRole('alert')).toContainText('源码依据不足')
    }
    await expect(evidence).toContainText('真实截图 0 张 · 源码复刻 1 张')
    const replica = evidence.getByRole('link', { name: /查看原图：源码复刻/ })
    await expect(replica).toHaveAttribute('href', /\/source-reconstructions\/replica\?revision=revision-12$/)
    await replica.scrollIntoViewIfNeeded()
    await expect(replica.locator('img')).toHaveJSProperty('naturalWidth', 16)
    assert.equal(reconstructionRequests, 2)
    await page.route('**/source-reconstructions/replica?*', route => route.fulfill({ status: 503, body: 'Unavailable' }))
    await page.reload({ waitUntil: 'networkidle' }); await tab('用户输入与证据').click()
    await replica.scrollIntoViewIfNeeded()
    await expect(evidence.getByRole('alert')).toContainText('图片加载失败')
    await expect(evidence.getByRole('img')).toHaveCount(0)
    await tab('系统产物').click()
    await page.getByRole('button', { name: '编辑 JSON', exact: true }).click()
    await page.getByRole('textbox', { name: 'PRD JSON', exact: true }).fill('{ unsaved draft')
    page.once('dialog', dialog => dialog.dismiss())
    await tab('用户输入与证据').click()
    await expect(tab('系统产物')).toHaveAttribute('aria-selected', 'true')
    page.once('dialog', dialog => dialog.accept())
    await tab('用户输入与证据').click()
    await tab('系统产物').click()
    await expect(page.getByRole('textbox', { name: 'PRD JSON', exact: true })).toHaveValue('{ unsaved draft')
    await page.getByRole('button', { name: '放弃编辑', exact: true }).click()
    project.revisions = []
    project.status = 'draft'
    await page.reload({ waitUntil: 'networkidle' })
    await expect(tab('用户输入与证据')).toHaveAttribute('aria-selected', 'true')
    await tab('系统产物').click()
    await expect(page.getByText('尚未生成系统产物', { exact: true })).toBeVisible()
    await page.setViewportSize({ width: 320, height: 1000 })
    for (const fail of [false, true]) {
      rejectSnapshot = fail
      await page.goto(`${origin}/requirements`, { waitUntil: 'networkidle' })
      await page.getByLabel('项目名称', { exact: true }).fill('验证创建时的配置信息')
      await page.getByLabel('需求描述', { exact: true }).fill('保存已填写的系统和仓库信息')
      await page.getByRole('heading', { name: '初始资料与代码上下文（选填）' }).click()
      await page.getByLabel('现有测试系统地址（可选）', { exact: true }).fill(previewOrigin)
      await page.getByLabel('远程仓库地址', { exact: true }).fill(remoteCode.repository)
      await page.getByLabel('分支（可选）', { exact: true }).fill(remoteCode.branch)
      await page.getByLabel('相关模块目录（建议较大仓库填写）', { exact: true }).fill(remoteCode.directory)
      await page.getByRole('button', { name: '创建项目', exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`/requirements/created-${fail ? 'partial' : 'complete'}$`))
      if (fail) await expect(page.getByRole('alert')).toContainText('远程仓库代码快照：隔离测试：仓库读取失败')
      await page.reload({ waitUntil: 'networkidle' })
      await expect(page.getByText(`现有系统地址：${previewOrigin}`, { exact: true })).toBeVisible()
      await expect(page.getByLabel('现有系统地址', { exact: true })).toHaveValue(previewOrigin)
      await expect(page.getByText(`已保存的仓库配置：${remoteCode.repository} · ${remoteCode.branch} · ${remoteCode.directory}`, { exact: true })).toBeVisible()
      await page.getByText('添加已有项目代码', { exact: true }).click()
      const remote = page.getByRole('form', { name: '远程仓库代码' })
      await expect(remote.getByLabel('仓库地址', { exact: true })).toHaveValue(remoteCode.repository)
      await expect(remote.getByLabel('分支（可选）', { exact: true })).toHaveValue(remoteCode.branch)
      await expect(remote.getByLabel('模块目录（可选）', { exact: true })).toHaveValue(remoteCode.directory)
      if (!fail) {
        const sources = page.getByRole('list', { name: '原始资料列表' })
        await expect(sources.getByText(`仓库地址：${remoteCode.repository}`, { exact: true })).toBeVisible()
        await expect(sources.getByText(`分支：${remoteCode.branch} · 模块目录：${remoteCode.directory}`, { exact: true })).toBeVisible()
      } else {
        await expect(page.getByRole('list', { name: '原始资料列表' })).toHaveCount(0)
        await remote.getByRole('button', { name: '拉取代码快照' }).click()
        await expect(remote.getByRole('alert')).toContainText('隔离测试：仓库读取失败')
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    }
    assert.deepEqual(unexpected, [])
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    await server.close()
    if (process.env.KEEP_UI_SCREENSHOTS === '1') console.log(`Requirement detail screenshots: ${temporary}`)
    else rmSync(temporary, { recursive: true, force: true })
  }
})
