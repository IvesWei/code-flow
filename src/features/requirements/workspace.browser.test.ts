import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright-core'
import type { RequirementProject } from '../../../shared/requirements'

const now = '2026-10-29T10:00:00.000Z'
function fixture(): RequirementProject {
  return {
    schemaVersion: 1, id: 'project-one', ownerId: 7, version: 1, title: '需求工作区回归项目', description: '保存并确认订单需求', modelId: 'auto', createdAt: now, updatedAt: now, status: 'prd_review',
    sources: [{ id: 'source-one', name: '原始资料', kind: 'file', sha256: 'abc', sizeBytes: 10 }], evidence: [{ sourceId: 'source-one', summary: '订单保存需可重复验证', limitations: '尚未确认支付' }], questions: [], decisions: [], events: [],
    jobs: [{ id: 'analysis', stage: 'analyze', status: 'succeeded', startedAt: now }],
    revisions: [{ id: 'revision-one', createdAt: now, prd: { title: '订单 PRD', summary: '订单工作流', blocks: [{ id: 'block-one', title: '订单字段', content: '保存订单', requirementIds: ['REQ-1'], sourceIds: ['source-one'], table: { columns: ['名称', '约束'], rows: [['订单号', '唯一']] } }], requirements: [{ id: 'REQ-1', title: '保存订单', description: '保存后可查询', acceptance: [{ id: 'AC-1', text: '返回订单号' }], sourceIds: ['source-one'] }, { id: 'REQ-2', title: '检索订单', description: '按订单号查询', acceptance: [{ id: 'AC-2', text: '查询成功' }], sourceIds: [] }] }, screens: [{ id: 'screen-one', title: '订单页面包含最长中文标签用于验证窄屏布局不重叠', state: '默认', requirementIds: ['REQ-1', 'REQ-2'], acceptanceIds: ['AC-1', 'AC-2'], html: '<meta http-equiv="refresh" content="0;url=https://example.com"><base href="https://example.com"><style>body{font-family:sans-serif}button{margin:12px;padding:12px}</style><button data-requirement-id="REQ-1">保存订单</button><button data-requirement-id="REQ-2">检索订单</button><a href="https://example.com">外部链接</a><img src="https://example.com/tracker">' }] }],
  }
}

test('requirements workspace uses isolated APIs, versioned saves, scoped drafts, safe previews and responsive review', { timeout: 120000 }, async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'requirements-ui-'))
  const entry = `import * as React from 'react';import{createRoot}from'react-dom/client';import{BrowserRouter,Routes,Route,useNavigate}from'react-router-dom';import Workspace from '/src/features/requirements/RequirementsWorkspace.tsx';import{NavigationContext}from'/src/app/navigation.ts';import'/src/styles/App.css';import'/src/styles/requirements.css';function App(){const navigate=useNavigate();return <NavigationContext.Provider value={navigate}><Routes><Route path="/requirements" element={<Workspace/>}/><Route path="/requirements/:projectId" element={<Workspace/>}/></Routes></NavigationContext.Provider>}createRoot(document.getElementById('root')).render(<BrowserRouter><App/></BrowserRouter>);`
  const server = await createServer({ configFile: false, envDir: false, cacheDir: join(temporary, '.vite'), plugins: [react(), {
    name: 'requirements-test-fixture', resolveId(id) { if (id === '/@requirements-fixture.tsx') return id }, load(id) { if (id === '/@requirements-fixture.tsx') return entry },
    configureServer(instance) { instance.middlewares.use((request, response, next) => { if (!request.url?.startsWith('/requirements')) return next(); void instance.transformIndexHtml(request.url, '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@requirements-fixture.tsx"></script></body></html>').then(html => { response.setHeader('Content-Type', 'text/html'); response.end(html) }).catch(next) }) },
  }], server: { host: '127.0.0.1', port: 0, watch: null } })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await server.listen()
    const address = server.httpServer?.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    browser = await chromium.launch({ channel: 'chrome', headless: true, env: Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && /^(path|systemroot|temp|tmp|localappdata|programfiles)$/i.test(key))) })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    let project = fixture()
    let reads = 0
    let rejectSave = false
    const writes: { path: string; body: Record<string, unknown> }[] = []
    await page.route('**/api/**', async route => {
      const request = route.request()
      const path = new URL(request.url()).pathname
      if (path === '/api/copilot/models') return route.fulfill({ json: { defaultModelId: 'auto', models: [{ id: 'model-one', name: '测试模型', vision: true }] } })
      if (request.method() === 'GET') {
        if (path.endsWith('/projects')) return route.fulfill({ json: [project, { ...project, id: 'project-two', title: '第二项目' }] })
        reads++
        return route.fulfill({ json: path.endsWith('project-two') ? { ...project, id: 'project-two', title: '第二项目' } : project })
      }
      const body = request.postDataJSON() as Record<string, unknown>
      writes.push({ path, body })
      if (body.version !== project.version) return route.fulfill({ status: 409, json: { error: '版本冲突' } })
      if (path.endsWith('/prd')) {
        if (rejectSave) return route.fulfill({ status: 400, json: { error: '模拟保存失败' } })
        project.revisions.at(-1)!.prd = body.prd as RequirementProject['revisions'][number]['prd']
      }
      if (path.endsWith('/answers')) {
        for (const answer of body.answers as { questionId: string; answer: string }[]) project.decisions.push({ question: project.questions.find(item => item.id === answer.questionId)!, answer: answer.answer, at: now })
        project.status = 'needs_input'
      }
      if (path.endsWith('/confirm')) project.revisions.at(-1)!.confirmedAt = now
      project.version++
      return route.fulfill({ json: project })
    })
    const origin = `http://127.0.0.1:${address.port}`
    await page.goto(`${origin}/requirements/project-one`, { waitUntil: 'networkidle' })
    await page.getByRole('heading', { name: project.title, exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: '生成设计', exact: true }).isDisabled(), true)
    await page.getByRole('button', { name: '编辑 JSON' }).click()
    const editor = page.getByRole('textbox', { name: 'PRD JSON' })
    await editor.fill('{ invalid')
    await page.getByRole('button', { name: '保存 PRD', exact: true }).click()
    assert.equal(writes.length, 0)
    const modified = structuredClone(project.revisions[0].prd); modified.summary = '明确保存后的 PRD'
    await editor.fill(JSON.stringify(modified))
    rejectSave = true
    await page.getByRole('button', { name: '保存 PRD', exact: true }).click()
    await page.getByText('模拟保存失败', { exact: true }).first().waitFor()
    assert.equal(await editor.inputValue(), JSON.stringify(modified))
    rejectSave = false
    await page.getByRole('button', { name: '保存 PRD', exact: true }).click()
    await page.getByText('明确保存后的 PRD', { exact: true }).waitFor()
    assert.equal(writes.at(-1)?.body.version, 1)
    assert.deepEqual(Object.keys(writes.at(-1)!.body).sort(), ['prd', 'version'])
    const preview = page.frameLocator('iframe[title$="原型"]')
    await preview.getByRole('button', { name: '检索订单', exact: true }).click()
    await page.locator('[data-prd-requirement="REQ-2"][data-selected=true]').waitFor()
    await page.getByRole('button', { name: 'REQ-1 · 保存订单', exact: true }).click()
    assert.match(await preview.getByRole('button', { name: '保存订单', exact: true }).getAttribute('style') || '', /outline/)
    assert.equal(await preview.locator('meta[http-equiv=refresh], base, a[href], img[src^="https"]').count(), 0)
    assert.equal(await page.locator('iframe').getAttribute('sandbox'), 'allow-scripts')
    assert.match(await preview.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content') || '', /default-src 'none'/)
    await page.getByRole('radio', { name: '交互', exact: true }).check()
    await preview.getByRole('button', { name: '检索订单', exact: true }).click()
    assert.equal(await page.locator('[data-prd-requirement="REQ-1"]').getAttribute('data-selected'), 'true')
    for (const width of [1440, 1367, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 })
      if (width < 760) await page.getByRole('radio', { name: '设计', exact: true }).check()
      const selector = page.getByRole('combobox', { name: '设计页面', exact: true })
      await selector.scrollIntoViewIfNeeded(); await selector.click()
      const menu = page.getByRole('listbox')
      const box = await menu.boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1)
      await page.screenshot({ path: join(temporary, `expanded-${width}.png`) })
      await menu.press('Escape'); assert.equal(await selector.evaluate(element => element === document.activeElement), true)
      await selector.click(); await page.getByRole('option').click()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      if (width < 760) await page.getByRole('radio', { name: 'PRD', exact: true }).check()
    }
    project.revisions.push({ ...structuredClone(project.revisions[0]), id: 'revision-two' }); project.version++
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.getByRole('button', { name: '刷新项目列表' }).click()
    await page.getByRole('combobox', { name: '修订历史', exact: true }).click()
    await page.getByRole('option').first().click()
    await page.getByText('历史修订 · 只读', { exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: '编辑 JSON' }).count(), 0)
    assert.equal(await page.getByRole('button', { name: '确认 PRD', exact: true }).isDisabled(), true)
    assert.match(await page.getByRole('link', { name: 'MD', exact: true }).getAttribute('href') || '', /revision=revision-one/)
    project.questions = [{ id: 'question-one', priority: 'P0', text: '是否允许重复订单？', impact: '影响唯一性', choices: ['不允许', '允许'], recommendation: '不允许' }]; project.status = 'needs_input'; project.version++
    await page.reload({ waitUntil: 'networkidle' })
    await page.getByRole('textbox', { name: '回答 · question-one' }).fill('保留我的部分答案')
    await page.reload({ waitUntil: 'networkidle' })
    assert.equal(await page.getByRole('textbox', { name: '回答 · question-one' }).inputValue(), '保留我的部分答案')
    assert.equal(await page.getByRole('button', { name: '生成 PRD', exact: true }).isDisabled(), true)
    await page.getByRole('link', { name: /第二项目/ }).click()
    assert.equal(await page.getByRole('textbox', { name: '回答 · question-one' }).inputValue(), '')
    await page.locator('a[href="/requirements/project-one"]').click()
    await page.getByRole('button', { name: '提交已填写答案' }).click()
    await page.getByText('已确认决策 · 1', { exact: true }).waitFor()
    assert.equal(writes.at(-1)?.body.version, project.version - 1)
    await page.clock.install()
    const idleReads = reads; await page.clock.runFor(6000); assert.equal(reads, idleReads)
    project.status = 'running'; project.jobs.push({ id: 'running-job', stage: 'design', status: 'running', startedAt: now }); project.version++
    await page.getByRole('button', { name: '刷新项目列表' }).click()
    await page.getByRole('button', { name: '取消任务' }).waitFor()
    const activeReads = reads; await page.clock.runFor(3000)
    await page.waitForFunction(() => document.querySelector('.requirements-progress'))
    assert.ok(reads > activeReads)
    await page.route('**/api/requirements/projects/project-one', route => route.fulfill({ status: 401, json: { error: '登录已失效' } }))
    await page.getByRole('button', { name: '刷新项目列表' }).click()
    await page.getByRole('alert').filter({ hasText: '登录已失效' }).waitFor()
  } finally { await browser?.close(); await server.close(); rmSync(temporary, { recursive: true, force: true }) }
})