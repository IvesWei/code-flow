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
import type { RequirementProject, StructuredPrd } from '../../../shared/requirements.js'

const at = '2026-10-29T10:00:00.000Z'
const projectId = '11111111-1111-4111-8111-111111111111'
const root = '/api/requirements/projects'
const prd: StructuredPrd = {
  title: '订单 PRD', summary: '保存并检索订单',
  blocks: [
    { id: 'B1', module: '订单维护及最长中文模块名称以验证多行布局', title: '订单字段及最长中文需求章节标题以验证多行布局', content: Array(70).fill('保存和检索的详细约束').join('\n'), sourceIds: ['S1'], requirementIds: ['REQ1'], table: { columns: ['名称', '约束'], rows: [['订单号', '唯一']] } },
    { id: 'B2', module: '订单检索', title: '订单检索页面', content: '按订单号查询结果', sourceIds: [], requirementIds: ['REQ2'] },
  ],
  requirements: [
    { id: 'REQ1', title: '保存订单', description: '保存后可查询', sourceIds: ['S1'], acceptance: [{ id: 'AC1', text: '返回订单号' }] },
    { id: 'REQ2', title: '检索订单', scenario: '订单列表筛选', description: '按订单号检索\n修改条件后重新查询，展示匹配结果', fields: [{ name: '订单号', description: '精确匹配' }, { name: '订单状态', description: '待处理\n处理中\n已完成' }], sourceIds: [], acceptance: [{ id: 'AC2', text: '返回订单' }] },
  ],
}
const screens = [
  { id: 'screen1', title: '订单保存页面最长中文标签用于验证窄屏展开菜单边界', state: '默认', requirementIds: ['REQ1'], acceptanceIds: ['AC1'], html: '<meta http-equiv="refresh" content="0;url=https://forbidden.invalid"><base href="https://forbidden.invalid"><style>@import "https://forbidden.invalid/import";body{background-image:url(https://forbidden.invalid/css)}</style><button data-requirement-id="REQ1">保存订单</button><a href="https://forbidden.invalid/link">外部链接</a><img src="https://forbidden.invalid/tracker"><input type="file"><input type="password">' },
  { id: 'screen2', title: '检索订单', state: '结果', requirementIds: ['REQ2'], acceptanceIds: ['AC2'], html: '<button data-requirement-id="REQ2">检索订单</button>' },
]
screens[0].html += '<section data-requirement-id="REQ1"><details><summary>Static details</summary>Hidden content</details><label><input id="static-check" type="checkbox">Static check</label><input id="static-text" aria-label="Static text" value="Original"><textarea aria-label="Static area">Original area</textarea><select aria-label="Static select"><option>First</option><option>Second</option></select><form><input value="Form data"><button>Static submit</button></form></section>'
screens[1].html += '<svg data-requirement-id="REQ2" viewBox="0 0 24 24" width="48" height="48" aria-label="Static chart"><circle cx="12" cy="12" r="10" fill="#287650" /></svg>'
screens[1].html = `<style>body{margin:0;min-height:100vh}.fluid-table{width:100%;table-layout:fixed}.fluid-table td{width:25%}@media(max-width:1000px){.fluid-table{font-size:30px}}</style><main style="width:100%;min-height:1800px;background:#f2f6f4">${screens[1].html}<table class="fluid-table"><tr><td>CASE-1041</td><td>Payment successful</td><td>High priority</td><td><span class="fluid-actions">View Edit Move Delete</span></td></tr></table><button data-requirement-id="REQ2" style="display:block;margin-left:1100px;width:160px">Right edge</button><footer style="margin-top:1400px">Design bottom</footer></main>`

test('requirements real router: strict mocked contracts, revisions, safe previews and four responsive widths', { timeout: 180000 }, async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'requirements-workspace-ui-'))
  const server = await createServer({ configFile: false, envDir: false, cacheDir: join(temporary, '.vite'), plugins: [react()], server: { host: '127.0.0.1', port: 0, watch: null } })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await server.listen()
    const address = server.httpServer?.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    browser = await chromium.launch({ channel: 'chrome', headless: true, env: executionEnvironment() })
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const page = await context.newPage()
    let project: RequirementProject = { schemaVersion: 1, id: projectId, ownerId: 7, version: 1, title: '隔离需求项目', description: '订单需求', modelId: 'auto', createdAt: at, updatedAt: at, status: 'draft', sources: [], evidence: [], questions: [], decisions: [], revisions: [], jobs: [], events: [] }
    let created = false
    let analyzeCount = 0
    let authReads = 0
    let failSave = true
    let heldJob = false
    let adjustmentCount = 0
    const writes: { path: string; body: Record<string, unknown> }[] = []
    const violations: string[] = []
    const external: string[] = []
    await context.route('**/*', async route => {
      const request = route.request()
      const url = new URL(request.url())
      if (url.origin !== origin) { if (request.frame().parentFrame()) external.push(url.href); return route.abort() }
      const path = url.pathname
      if (!path.startsWith('/api/')) return route.continue()
      const reply = (json: unknown, status = 200) => route.fulfill({ json, status })
      if (path === '/api/auth/status') { authReads++; return reply({ configured: true, authenticated: true, login: 'fixture', userId: 7 }) }
      if (path === '/api/copilot/models' || path === '/api/models') return reply({ defaultModelId: 'auto', models: [{ id: 'auto', name: 'Auto', vision: true }] })
      if (path === '/api/tasks') return reply({ items: [], busy: false })
      if (path.includes('/exports')) {
        assert.ok(project.revisions.some(revision => revision.id === url.searchParams.get('revision')))
        return route.fulfill({ contentType: 'application/octet-stream', headers: { 'Content-Disposition': 'attachment; filename="requirements.txt"' }, body: `fixture ${url.searchParams.get('format')}` })
      }
      if (path.includes('/screenshots/')) return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0AAAAABJRU5ErkJggg==', 'base64') })
      if (request.method() === 'GET') {
        if (path === root) return reply(created ? [project] : [])
        if (path === `${root}/${projectId}`) return reply(project)
        violations.push(`Unexpected GET ${path}`); return reply({ error: 'Unexpected endpoint' }, 404)
      }
      if (request.headers()['content-type']?.startsWith('multipart/form-data')) {
        const body = request.postDataBuffer()!.toString()
        assert.match(body, /name="version"/)
        assert.match(body, new RegExp(`\\r\\n${project.version}\\r\\n`))
        assert.match(body, /filename="source.md"/)
        assert.doesNotMatch(body, /name="expectedVersion"/)
        project.sources.push({ id: 'S1', name: 'source.md', kind: 'file', sha256: 'fixture', sizeBytes: 12 })
        project.events.push({ id: `E${project.version}`, at, text: 'inputs:changed' }); project.version++
        return reply(project)
      }
      const body = request.postDataJSON() as Record<string, unknown>
      writes.push({ path, body })
      const suffix = path.slice(`${root}/${projectId}`.length)
      const allowed = path === root ? ['title', 'description', 'modelId'] : /\/login$/.test(suffix) ? ['version', 'action'] : suffix === '/preview' ? ['version', 'origin'] : suffix === '/jobs' ? ['version', 'stage', 'instruction', 'screenId'] : suffix === '/sources' ? ['version', 'url'] : suffix === '/answers' ? ['version', 'answers'] : suffix === '/prd' ? ['version', 'prd'] : suffix === '/confirm' ? ['version', 'target'] : suffix === '/revisions' ? ['version', 'instruction'] : /\/cancel$/.test(suffix) ? ['version'] : []
      if (!allowed.length || Object.keys(body).some(key => !allowed.includes(key))) { violations.push(`Invalid fields ${path}: ${Object.keys(body)}`); return reply({ error: 'Invalid request fields' }, 400) }
      if (path === root) {
        project.title = String(body.title); project.description = String(body.description); created = true
        return reply(project, 201)
      }
      if (body.version !== project.version) { violations.push('Stale version'); return reply({ error: '版本冲突' }, 409) }
      if (suffix.endsWith('/login')) {
        assert.ok(project.jobs.at(-1)?.interaction)
        if (body.action === 'open') project.jobs.at(-1)!.interaction!.phase = 'opened'
        else { assert.equal(body.action, 'continue'); delete project.jobs.at(-1)!.interaction }
      } else if (suffix === '/preview') {
        assert.equal(request.method(), 'PATCH')
        if (body.origin === '') delete project.preview
        else project.preview = { origin: String(body.origin), generation: (project.preview?.generation ?? 0) + 1 }
      } else if (suffix === '/sources') {
        project.sources.push({ id: 'S2', name: String(body.url), url: String(body.url), kind: 'url', sha256: 'fixture', sizeBytes: 0 })
        project.events.push({ id: `E${project.version}`, at, text: 'inputs:changed' })
      } else if (suffix === '/answers') {
        for (const answer of body.answers as { questionId: string; answer: string }[]) project.decisions.push({ question: project.questions.find(question => question.id === answer.questionId)!, answer: answer.answer, at })
        project.events.push({ id: `E${project.version}`, at, text: 'inputs:changed' }); project.status = 'draft'
      } else if (suffix === '/prd') {
        assert.equal(request.method(), 'PATCH')
        if (failSave) { failSave = false; return reply({ error: '模拟保存失败' }, 400) }
        project.revisions.push({ id: 'edited', createdAt: at, prd: body.prd as StructuredPrd, screens: [] })
      } else if (suffix === '/confirm') {
        if (body.target === 'prd') project.revisions.at(-1)!.confirmedAt = at
        else { project.revisions.at(-1)!.designConfirmedAt = at; project.status = 'completed' }
      } else if (suffix === '/revisions') {
        project.revisions.push({ id: 'requested', createdAt: at, prd: structuredClone(project.revisions.at(-1)!.prd), screens: [] })
        project.events.push({ id: `E${project.version}`, at, text: 'inputs:changed' }); project.status = 'draft'
      } else if (suffix.endsWith('/cancel')) {
        delete project.jobs.at(-1)!.interaction
        project.jobs.at(-1)!.status = 'cancelled'; project.status = 'cancelled'
      } else if (suffix === '/jobs') {
        assert.ok(!body.instruction || body.stage === 'analyze' || (body.stage === 'design' && body.screenId))
        const id = `J${project.jobs.length}`
        project.jobs.push({ id, stage: body.stage as 'analyze', status: heldJob ? 'running' : 'succeeded', startedAt: at })
        if (heldJob) project.status = 'running'
        else if (body.stage === 'analyze') {
          analyzeCount++; project.events.push({ id: `E${project.version}`, at, text: `analysis:${id}` })
          project.questions = analyzeCount === 1 ? [{ id: 'Q1', priority: 'P0', text: '允许重复订单吗？', impact: '影响唯一性', choices: ['不允许', '允许'], recommendation: '不允许' }] : []
          project.status = project.questions.length ? 'needs_input' : 'draft'
        } else if (body.stage === 'prd') {
          project.revisions.push({ id: 'original', createdAt: at, prd: structuredClone(prd), screens: [] }); project.status = 'prd_review'
        } else if (body.stage === 'design') {
          if (body.screenId) {
            assert.equal(body.screenId, 'screen1')
            adjustmentCount++
            assert.equal(body.instruction, adjustmentCount === 1 ? '调整字段间距，保留其他页面' : '调整字段间距，保留其他页面\n\n标题再紧凑一些')
            const previous = structuredClone(project.revisions.at(-1)!)
            project.revisions.push({ ...previous, id: `adjusted-${adjustmentCount}`, screens: previous.screens.map(screen => screen.title === screens[0].title ? { ...screen, html: screen.html + `<p>Adjusted ${adjustmentCount}</p>` } : screen), screenshots: previous.screens.map(screen => ({ screenId: screen.id, sha256: `fixture-${adjustmentCount}`, storageKey: `fixture-${adjustmentCount}` })) })
          } else project.revisions.push({ ...structuredClone(project.revisions.at(-1)!), id: 'designed', screens: [...structuredClone(screens), { ...structuredClone(screens[0]), id: 'screen-empty', state: '无数据', html: '<main data-requirement-id="REQ1">暂无订单</main>' }] })
          project.status = 'design_review'
        } else if (body.stage === 'validate') {
          const validation = { at, errors: [], artifactVersion: 1, allScreensValidated: true, interactionVerified: false, mode: 'static-script-disabled', screens: screens.map(screen => ({ screenId: screen.id, visual: 'passed', interaction: 'not_verified' })), limitations: ['Fixture: JavaScript disabled; static screenshots only.'] }
          project.revisions.push({ ...structuredClone(project.revisions.at(-1)!), id: 'validated', screens: [{ ...structuredClone(screens[0]), html: '<script>fetch("https://forbidden.invalid/credentials")</script><button>Unsafe</button>' }, structuredClone(screens[1])], screenshots: [{ screenId: 'screen1', sha256: 'fixture', storageKey: 'fixture' }], validation })
        }
      }
      project.version++
      return reply(project)
    })
    await page.goto(`${origin}/requirements`, { waitUntil: 'networkidle' })
    await page.evaluate(() => { (window as unknown as { requirementsMarker: string }).requirementsMarker = 'same-document' })
    const menuLink = page.getByRole('link', { name: '需求与设计', exact: true })
    await expect(menuLink).toHaveAttribute('aria-current', 'page')
    await page.getByRole('textbox', { name: '项目名称', exact: true }).fill('订单需求项目')
    await page.getByRole('textbox', { name: '需求描述', exact: true }).fill('隔离订单需求说明')
    await page.getByRole('button', { name: '创建项目', exact: true }).click()
    await expect(page.getByRole('heading', { name: '订单需求项目', exact: true })).toBeVisible()
    await page.getByRole('textbox', { name: '现有系统地址', exact: true }).fill('http://localhost:5173')
    await page.getByRole('button', { name: '保存取证地址', exact: true }).click()
    await expect(page.getByText('http://localhost:5173 · 取证版本 1', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '下次重新取证', exact: true }).click()
    await expect(page.getByText('http://localhost:5173 · 取证版本 2', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '停用取证', exact: true }).click()
    await expect(page.getByRole('textbox', { name: '现有系统地址', exact: true })).toHaveValue('')
    const historyTrigger = page.getByRole('button', { name: '项目记录', exact: true })
    const historyPanel = page.locator('#requirements-project-history')
    for (const width of [1440, 1367, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 })
      await page.mouse.move(width - 1, 0)
      await expect(historyTrigger).toHaveAttribute('aria-expanded', 'false')
      await expect(historyPanel).toBeHidden()
      const before = await page.locator('.requirements-body').boundingBox()
      const rail = await page.locator('.requirements-history-rail').boundingBox()
      assert.ok(rail && rail.width <= 30)
      await historyTrigger.hover()
      await expect(historyPanel).toBeVisible()
      const panel = await historyPanel.boundingBox()
      const trigger = await historyTrigger.boundingBox()
      const after = await page.locator('.requirements-body').boundingBox()
      assert.ok(panel && trigger && panel.x >= 0 && panel.x + panel.width <= width + 1 && panel.y >= 0 && panel.y + panel.height <= 1001)
      assert.ok(panel.y >= trigger.y + trigger.height - 1)
      assert.equal(before?.width, after?.width)
      assert.equal(before?.x, after?.x)
      await page.screenshot({ path: join(temporary, `requirements-history-expanded-${width}.png`) })
      await page.mouse.move(width - 1, 0)
      await expect(historyPanel).toBeHidden()
      await historyTrigger.focus()
      await historyTrigger.press('Enter')
      await expect(historyPanel).toBeVisible()
      await historyTrigger.press('Tab')
      await expect(page.getByRole('button', { name: '刷新项目列表', exact: true })).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(historyPanel).toBeHidden()
      await expect(historyTrigger).toBeFocused()
      await historyTrigger.press('Enter')
      await page.getByRole('heading', { name: '订单需求项目', exact: true }).click()
      await expect(historyPanel).toBeHidden()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.getByLabel('补充文件', { exact: true }).setInputFiles({ name: 'source.md', mimeType: 'text/markdown', buffer: Buffer.from('order source') })
    await page.getByRole('button', { name: '上传资料', exact: true }).click()
    await expect(page.getByLabel('补充文件', { exact: true })).toHaveValue('')
    await page.getByRole('textbox', { name: '补充链接', exact: true }).fill('https://example.com/spec')
    await page.getByRole('button', { name: '添加链接', exact: true }).click()
    await expect(page.getByRole('textbox', { name: '补充链接', exact: true })).toHaveValue('')
    await page.getByRole('button', { name: '分析需求', exact: true }).click()
    await page.getByRole('radio', { name: '不允许', exact: true }).check()
    await page.getByRole('button', { name: '提交已填写答案', exact: true }).click()
    await expect(page.getByText('已确认决策 · 1', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '生成 PRD', exact: true })).toBeDisabled()
    await page.getByText('已确认决策 · 1', { exact: true }).click()
    await expect(page.getByRole('heading', { name: '允许重复订单吗？', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '分析需求', exact: true }).click()
    await expect(page.getByRole('button', { name: '生成 PRD', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '生成 PRD', exact: true }).click()
    await page.getByRole('button', { name: '编辑 JSON', exact: true }).click()
    const editor = page.getByRole('textbox', { name: 'PRD JSON', exact: true })
    const edited = { ...structuredClone(prd), summary: '保存后的新修订' }
    await editor.fill('{ invalid')
    const beforeInvalid = writes.length
    await page.getByRole('button', { name: '保存 PRD', exact: true }).click()
    await expect(page.getByRole('alert')).toBeVisible()
    assert.equal(writes.length, beforeInvalid)
    await editor.fill(JSON.stringify(edited))
    await page.getByRole('button', { name: '保存 PRD', exact: true }).click()
    await expect(page.getByText('模拟保存失败', { exact: true }).first()).toBeVisible()
    await expect(editor).toHaveValue(JSON.stringify(edited))
    await page.getByRole('button', { name: '保存 PRD', exact: true }).click()
    await expect(page.getByText('保存后的新修订', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '确认 PRD', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '确认 PRD', exact: true }).click()
    await page.getByRole('textbox', { name: '修订意见', exact: true }).fill('尚未提交的修订草稿')
    await page.getByRole('button', { name: '生成设计', exact: true }).click()
    await expect(page.getByRole('button', { name: '调整原型', exact: true })).toBeEnabled()
    for (const width of [1440, 1367, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 })
      if (width < 760) await page.getByRole('radio', { name: '设计', exact: true }).check()
      await page.getByRole('button', { name: '调整原型', exact: true }).click()
      const adjustment = page.getByRole('dialog', { name: '原型调整', exact: true })
      await expect(page.getByRole('textbox', { name: '原型修改意见' })).toBeFocused()
      await page.getByRole('textbox', { name: '原型修改意见' }).fill('')
      await expect(adjustment.getByRole('button', { name: '发送并调整原型' })).toBeDisabled()
      await page.getByRole('textbox', { name: '原型修改意见' }).fill('调整字段间距，保留其他页面')
      await expect(adjustment.getByRole('list', { name: '同步调整状态' }).getByRole('listitem')).toHaveCount(2)
      const stateSelector = adjustment.getByRole('combobox', { name: '原型状态', exact: true })
      await stateSelector.click()
      const stateMenu = adjustment.getByRole('listbox')
      await expect(stateMenu.getByRole('option')).toHaveCount(2)
      const menuBounds = await stateMenu.boundingBox()
      const stateBounds = await stateSelector.boundingBox()
      assert.ok(menuBounds && stateBounds && menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= width + 1 && menuBounds.y >= 0 && menuBounds.y + menuBounds.height <= 1001)
      assert.ok(menuBounds.y >= stateBounds.y + stateBounds.height - 1 || menuBounds.y + menuBounds.height <= stateBounds.y + 1)
      await page.screenshot({ path: join(temporary, `prototype-states-expanded-${width}.png`), fullPage: true })
      await stateMenu.getByRole('option', { name: '无数据', exact: true }).click()
      await expect(adjustment.frameLocator('iframe').getByText('暂无订单', { exact: true })).toBeVisible()
      await stateSelector.click()
      await stateMenu.press('Home'); await stateMenu.press('Enter')
      await expect(stateSelector).toBeFocused()
      await expect(stateSelector).toContainText('默认')
      await stateSelector.click(); await stateMenu.press('Escape')
      await expect(stateSelector).toBeFocused()
      const bounds = await adjustment.boundingBox()
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1)
      assert.equal(await adjustment.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      await page.screenshot({ path: join(temporary, `single-page-adjustment-${width}.png`), fullPage: true })
      await page.keyboard.press('Escape')
      await expect(adjustment).not.toBeVisible()
      await expect(page.getByRole('button', { name: '调整原型', exact: true })).toBeFocused()
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.getByRole('button', { name: '调整原型', exact: true }).click()
    const untouched = structuredClone(project.revisions.at(-1)!.screens[1])
    await page.getByRole('button', { name: '发送并调整原型', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '原型调整', exact: true })).toBeVisible()
    await expect(page.getByRole('log', { name: '调整对话记录' })).toContainText('调整字段间距，保留其他页面')
    await expect(page.getByRole('log', { name: '调整对话记录' })).toContainText('原型和各状态截图已更新')
    assert.ok(project.revisions.at(-1)!.screens.filter(screen => screen.title === screens[0].title).every(screen => screen.html.includes('Adjusted 1')))
    assert.equal(project.revisions.at(-1)!.screenshots!.length, 3)
    await page.getByRole('textbox', { name: '原型修改意见' }).fill('标题再紧凑一些')
    await page.getByRole('button', { name: '发送并调整原型', exact: true }).click()
    await expect.poll(() => adjustmentCount).toBe(2)
    await expect(page.getByRole('log', { name: '调整对话记录' }).getByText('原型和各状态截图已更新。', { exact: false })).toHaveCount(2)
    await page.getByRole('button', { name: '关闭原型调整', exact: true }).click()
    assert.deepEqual(project.revisions.at(-1)!.screens[1], untouched)
    await expect(page.getByRole('slider', { name: '设计区域宽度', exact: true })).toHaveValue('70')
    await expect(page.locator('[aria-label="页面关联需求"], [aria-label="页面验收标准"]')).toHaveCount(0)
    const wideTrigger = page.getByRole('button', { name: '宽屏评审', exact: true })
    await wideTrigger.click()
    const reviewModal = page.locator('dialog:modal')
    await expect(reviewModal).toBeVisible()
    const designSelector = page.getByRole('combobox', { name: '设计页面', exact: true, includeHidden: true })
    const prdPane = page.locator('.requirements-prd-pane')
    const settleReading = () => page.evaluate(async () => { for (let frame = 0; frame < 4; frame++) await new Promise(requestAnimationFrame) })
    const scrollPrdTo = async (id: string) => {
      await page.locator(`[data-prd-requirement="${id}"]`).evaluate(element => {
        const pane = element.closest<HTMLElement>('.requirements-prd-pane')!
        pane.scrollTop += element.getBoundingClientRect().top - pane.getBoundingClientRect().top - 16
      })
      await settleReading()
    }
    const assertReading = async (id: string) => {
      if (id === 'REQ2') await expect(designSelector).toContainText('检索订单')
      else await expect(designSelector).toHaveText('订单保存页面最长中文标签页')
    }
    const prdState = () => prdPane.evaluate(element => ({
      scrollTop: element.scrollTop,
      selected: Array.from(element.querySelectorAll('[data-selected="true"]'), item => item.getAttribute('data-prd-requirement')),
      focused: element.contains(document.activeElement),
      mobileView: element.closest('.requirements-review')!.getAttribute('data-mobile-view'),
    }))
    await reviewModal.locator('.requirements-page-context').first().locator('summary').click()
    await designSelector.focus()
    for (const id of ['REQ2', 'REQ1', 'REQ2', 'REQ1']) {
      await scrollPrdTo(id)
      await assertReading(id)
      const state = await prdState()
      assert.ok(state.scrollTop > 0)
      assert.deepEqual(state.selected, [])
      assert.equal(state.focused, false)
      await expect(designSelector).toBeFocused()
      await settleReading()
      assert.deepEqual(await prdState(), state)
      assert.equal(await reviewModal.evaluate(element => element.scrollTop), 0)
    }
    await reviewModal.locator('.requirements-page-context').first().locator('summary').click()
    await expect(reviewModal.getByRole('heading', { name: '审阅模式', exact: true })).toBeVisible()
    assert.equal(await page.locator('iframe').count(), 1)
    const modalBounds = await reviewModal.boundingBox()
    assert.ok(modalBounds && modalBounds.width >= 1400 && modalBounds.x >= 0)
    await page.getByRole('combobox', { name: '设计页面', exact: true }).click()
    await expect(reviewModal.getByRole('listbox')).toBeVisible()
    await reviewModal.getByRole('listbox').press('Escape')
    await expect(reviewModal).toBeVisible()
    for (const [width, height] of [[1440, 1000], [1367, 1000], [390, 1000], [320, 1000], [1367, 640], [320, 640]]) {
      await page.setViewportSize({ width, height })
      if (width < 760) await page.getByRole('radio', { name: '设计', exact: true }).check()
      const bounds = await reviewModal.boundingBox()
      assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= height)
      assert.equal(await reviewModal.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true)
      assert.equal(await reviewModal.evaluate(element => element.scrollHeight <= element.clientHeight + 1), true)
      if (width < 760) await page.getByRole('radio', { name: 'PRD', exact: true }).check()
      await reviewModal.locator('.requirements-page-context').first().locator('summary').click()
      const directoryTrigger = reviewModal.getByRole('button', { name: 'PRD 目录', exact: true })
      const directory = reviewModal.getByRole('navigation', { name: 'PRD 目录', exact: true })
      await expect(directoryTrigger).toHaveAttribute('aria-expanded', 'false')
      await expect(directory).toBeHidden()
      const edge = await reviewModal.locator('.requirements-prd-directory').boundingBox()
      assert.ok(edge)
      await page.mouse.move(edge.x + 5, edge.y + 70)
      await expect(directory).toBeVisible()
      await expect(directoryTrigger).toHaveAttribute('aria-expanded', 'true')
      await directory.getByRole('button', { name: '订单检索', exact: true }).click()
      await expect(reviewModal.locator('[data-prd-module="订单检索"]')).toBeFocused()
      await directory.getByRole('button', { name: '订单检索页面', exact: true }).click()
      await expect(reviewModal.locator('[data-prd-page="B2"]')).toBeFocused()
      await directory.getByRole('button', { name: '检索订单', exact: true }).click()
      await expect(reviewModal.locator('[data-prd-requirement="REQ2"]')).toBeFocused()
      await expect.poll(() => reviewModal.locator('[data-prd-requirement="REQ2"]').evaluate(element => {
        const target = element.getBoundingClientRect()
        const pane = element.closest('.requirements-prd-pane')!.getBoundingClientRect()
        return target.top >= pane.top - 1 && target.bottom <= pane.bottom + 1
      })).toBe(true)
      await expect(directory.getByRole('button', { name: '检索订单', exact: true })).toHaveAttribute('aria-current', 'location')
      await assertReading('REQ2')
      const drawerBounds = await directory.boundingBox()
      assert.ok(drawerBounds && drawerBounds.x >= 0 && drawerBounds.x + drawerBounds.width <= width && drawerBounds.y + drawerBounds.height <= height)
      assert.equal(await directory.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true)
      assert.equal(await reviewModal.evaluate(element => element.scrollTop), 0)
      await page.screenshot({ path: join(temporary, `requirements-prd-directory-${width}-${height}.png`), fullPage: true })
      await reviewModal.getByRole('heading', { name: '审阅模式', exact: true }).hover()
      await expect(directory).toBeHidden()
      await page.screenshot({ path: join(temporary, `requirements-prd-directory-located-${width}-${height}.png`), fullPage: true })
      await directoryTrigger.focus()
      await directoryTrigger.press('Enter')
      await expect(directory).toBeVisible()
      await directory.getByRole('button', { name: '检索订单', exact: true }).focus()
      await page.keyboard.press('Escape')
      await expect(directory).toBeHidden()
      await expect(directoryTrigger).toBeFocused()
      await expect(reviewModal).toBeVisible()
      await scrollPrdTo('REQ1')
      await assertReading('REQ1')
      await reviewModal.locator('.requirements-page-context').first().locator('summary').click()
      if (width < 760) await page.getByRole('radio', { name: '设计', exact: true }).check()
      const closeBounds = await reviewModal.getByRole('button', { name: '关闭宽屏评审', exact: true }).boundingBox()
      assert.ok(closeBounds && closeBounds.width <= 30 && closeBounds.height <= 30)
      if (width > 760) {
        const heading = await reviewModal.getByRole('heading', { name: '审阅模式', exact: true }).boundingBox()
        const slider = await reviewModal.locator('.requirements-divider').boundingBox()
        assert.ok(heading && slider && bounds && Math.abs(slider.x + slider.width / 2 - (bounds.x + bounds.width / 2)) <= 2)
        assert.ok(Math.abs(heading.y + heading.height / 2 - (slider.y + slider.height / 2)) <= 2)
        const prdBounds = await reviewModal.locator('.requirements-prd-pane').boundingBox()
        const designBounds = await reviewModal.locator('.requirements-design-pane').boundingBox()
        assert.ok(prdBounds && designBounds && prdBounds.x + prdBounds.width <= designBounds.x + 1)
        assert.ok(bounds && designBounds.y + designBounds.height <= bounds.y + bounds.height && prdBounds.y + prdBounds.height <= bounds.y + bounds.height)
        for (const split of ['35', '54', '70']) {
          await reviewModal.getByRole('slider', { name: '设计区域宽度', exact: true }).fill(split)
          const ratio = await reviewModal.locator('.requirements-design-pane').evaluate(element => element.getBoundingClientRect().width / element.parentElement!.getBoundingClientRect().width)
          assert.ok(Math.abs(ratio - Number(split) / 100) < 0.01)
          assert.equal(await reviewModal.evaluate(element => element.scrollHeight <= element.clientHeight + 1), true)
        }
        const pageContext = reviewModal.locator('.requirements-page-context').first()
        await pageContext.locator('summary').click()
        const prdPane = reviewModal.locator('.requirements-prd-pane')
        assert.ok(await prdPane.evaluate(element => { element.scrollTop = element.scrollHeight; return element.scrollTop }) > 0)
        assert.equal(await reviewModal.evaluate(element => element.scrollTop), 0)
        await prdPane.evaluate(element => { element.scrollTop = 0 })
        await pageContext.locator('summary').click()
      }
      await reviewModal.getByRole('combobox', { name: '设计页面', exact: true }).click()
      const menu = reviewModal.getByRole('listbox')
      const modules = reviewModal.getByRole('group', { name: '功能模块', exact: true })
      await expect(modules.getByRole('button')).toHaveCount(2)
      await modules.getByRole('button', { name: '订单检索', exact: true }).hover()
      await expect(menu.getByRole('option')).toHaveCount(1)
      await expect(menu.getByRole('option')).toContainText('检索订单页')
      await expect(reviewModal.getByRole('combobox', { name: '设计页面', exact: true })).not.toContainText('检索订单')
      await menu.press('ArrowLeft')
      await expect(modules.getByRole('button', { name: '订单检索', exact: true })).toBeFocused()
      await page.keyboard.press('Home')
      await page.keyboard.press('ArrowRight')
      await expect(menu).toBeFocused()
      await expect(menu.getByRole('option').first()).not.toContainText('检索订单')
      await menu.getByRole('option').first().click()
      await expect(menu).toBeVisible()
      await expect(menu.getByRole('option').first()).toHaveAttribute('aria-selected', 'true')
      await modules.getByRole('button', { name: '订单检索', exact: true }).click()
      await menu.getByRole('option').click()
      await expect(menu).toBeVisible()
      await expect(menu.getByRole('option')).toHaveAttribute('aria-selected', 'true')
      await expect(reviewModal.getByRole('combobox', { name: '设计页面', exact: true })).toContainText('检索订单')
      const designPane = reviewModal.locator('.requirements-design-pane')
      await expect.poll(() => designPane.evaluate(element => {
        element.scrollTop = element.scrollHeight
        return element.scrollHeight <= element.clientHeight + 1 || element.scrollTop > 0
      })).toBe(true)
      assert.equal(await reviewModal.evaluate(element => element.scrollTop), 0)
      await designPane.evaluate(element => { element.scrollTop = 0 })
      const reviewBounds = await reviewModal.locator('.requirements-review').boundingBox()
      assert.ok(reviewBounds && bounds && Math.abs(reviewBounds.y + reviewBounds.height - (bounds.y + bounds.height - (width < 760 ? 13 : 17))) <= 2)
      const menuBounds = await reviewModal.locator('.filter-select-cascade').boundingBox()
      const triggerBounds = await reviewModal.getByRole('combobox', { name: '设计页面', exact: true }).boundingBox()
      assert.ok(menuBounds && triggerBounds && menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= width && menuBounds.y >= 0 && menuBounds.y + menuBounds.height <= height)
      await expect.poll(async () => {
        const overlay = await reviewModal.locator('.filter-select-cascade').boundingBox()
        const trigger = await reviewModal.getByRole('combobox', { name: '设计页面', exact: true }).boundingBox()
        return !!overlay && !!trigger && (overlay.y >= trigger.y + trigger.height - 1 || overlay.y + overlay.height <= trigger.y + 1)
      }).toBe(true)
      await page.screenshot({ path: join(temporary, `requirements-wide-review-${width}-${height}.png`), fullPage: true })
      await reviewModal.getByRole('heading', { name: '设计原型', exact: true }).click()
      await expect(menu).toHaveCount(0)
      await reviewModal.getByRole('combobox', { name: '设计页面', exact: true }).click()
      await menu.press('ArrowLeft'); await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight'); await menu.press('Enter')
      await expect(menu).toBeVisible()
      await menu.press('Escape')
      await expect(reviewModal).toBeVisible()
      await page.getByRole('button', { name: '关闭宽屏评审', exact: true }).focus()
      await page.keyboard.press('Tab')
      assert.equal(await reviewModal.evaluate(element => element.contains(document.activeElement)), true)
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.getByRole('button', { name: '关闭宽屏评审', exact: true }).click()
    await expect(reviewModal).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'PRD 目录', exact: true })).toHaveCount(0)
    await expect(wideTrigger).toBeFocused()
    await wideTrigger.click()
    await page.getByRole('button', { name: '关闭宽屏评审', exact: true }).press('Escape')
    await expect(reviewModal).toHaveCount(0)
    await expect(wideTrigger).toBeFocused()
    await expect(page.getByRole('button', { name: '编辑设计', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '保存设计', exact: true })).toHaveCount(0)
    await expect(page.getByRole('textbox', { name: '元素文字', exact: true })).toHaveCount(0)
    const preview = page.frameLocator('iframe')
    const clickPreview = async (target: ReturnType<typeof preview.locator>) => {
      await page.evaluate(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame) })
      await target.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }))
      const local = await target.evaluate(element => { const rect = element.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } })
      const before = await page.locator('iframe').boundingBox()
      assert.ok(before)
      await page.evaluate(point => window.scrollBy({ top: point - innerHeight / 2, behavior: 'instant' }), before.y + local.y * before.width / 1600)
      await page.evaluate(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame) })
      const bounds = await page.locator('iframe').boundingBox()
      assert.ok(bounds)
      const scale = bounds.width / 1600
      await page.mouse.click(bounds.x + local.x * scale, bounds.y + local.y * scale)
    }
    const assertNoReverseNavigation = async (activate: () => Promise<void>) => {
      const before = await prdState()
      await activate()
      await settleReading()
      const after = await prdState()
      assert.equal(after.scrollTop, before.scrollTop)
      assert.deepEqual(after.selected, before.selected)
      assert.equal(after.mobileView, before.mobileView)
      await expect(preview.locator('[data-platform-selection], mask')).toHaveCount(0)
      await expect(prdPane.locator('[data-selected="true"]')).toHaveCount(0)
    }
    await prdPane.scrollIntoViewIfNeeded()
    await prdPane.locator('.requirements-page-context').first().locator('summary').click()
    await scrollPrdTo('REQ1')
    await assertReading('REQ1')
    await assertNoReverseNavigation(() => clickPreview(preview.getByRole('button', { name: '保存订单', exact: true })))
    await wideTrigger.click()
    await expect(reviewModal).toBeVisible()
    await expect(prdPane.locator('[data-selected="true"]')).toHaveCount(0)
    await expect(preview.locator('[data-platform-selection], mask')).toHaveCount(0)
    await page.getByRole('button', { name: '关闭宽屏评审', exact: true }).click()
    await page.getByRole('heading', { name: 'PRD', exact: true }).click()
    await expect(prdPane.locator('[data-selected="true"]')).toHaveCount(0)
    await page.getByRole('heading', { name: '设计原型', exact: true }).click()
    await assertNoReverseNavigation(() => clickPreview(preview.getByRole('button', { name: '保存订单', exact: true })))
    await scrollPrdTo('REQ2')
    await assertReading('REQ2')
    await expect(preview.locator('[data-platform-selection], mask')).toHaveCount(0)
    await expect(preview.getByRole('button', { name: '检索订单', exact: true })).not.toHaveAttribute('style', /outline/)
    await designSelector.scrollIntoViewIfNeeded()
    const beforeManualPage = await prdPane.evaluate(element => element.scrollTop)
    await designSelector.press('ArrowDown')
    await expect(designSelector).toHaveAttribute('aria-expanded', 'true')
    await page.getByRole('listbox').press('ArrowLeft'); await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight')
    await page.getByRole('listbox').press('Home'); await page.getByRole('listbox').press('Enter')
    await expect(page.getByRole('listbox')).toBeVisible()
    await page.getByRole('listbox').press('Escape')
    await expect(designSelector).toHaveText('订单保存页面最长中文标签页')
    assert.equal(await prdPane.evaluate(element => element.scrollTop), beforeManualPage)
    await expect(preview.locator('meta[http-equiv="refresh"],base,a[href],img[src^="http"]')).toHaveCount(0)
    await expect(page.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts')
    await expect(page.locator('iframe')).toHaveAttribute('referrerpolicy', 'no-referrer')
    await expect(preview.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute('content', /script-src 'nonce-.*connect-src 'none'/)
    const isolated = await page.frames().find(frame => frame.parentFrame())!.evaluate(() => {
      let blocked = false
      try { void parent.document.cookie } catch { blocked = true }
      return { origin: location.origin, blocked }
    })
    assert.equal(isolated.blocked, true)
    await expect(page.getByRole('radio', { name: '交互', exact: true })).toHaveCount(0)
    await assertNoReverseNavigation(() => clickPreview(preview.getByRole('button', { name: '保存订单', exact: true })))
    const nativeFrame = page.frames().find(frame => frame.parentFrame())!
    await expect(preview.locator('form input')).toHaveValue('Form data')
    await clickPreview(preview.locator('summary'))
    await expect(preview.locator('details')).not.toHaveAttribute('open')
    await clickPreview(preview.getByRole('checkbox', { name: 'Static check', exact: true }))
    await expect(preview.getByRole('checkbox')).not.toBeChecked()
    await preview.getByRole('checkbox').press('Space')
    await expect(preview.getByRole('checkbox')).not.toBeChecked()
    await preview.getByRole('textbox', { name: 'Static text', exact: true }).pressSequentially('Changed')
    await expect(preview.getByRole('textbox', { name: 'Static text', exact: true })).toHaveValue('Original')
    await preview.getByRole('textbox', { name: 'Static area', exact: true }).pressSequentially('Changed')
    await expect(preview.getByRole('textbox', { name: 'Static area', exact: true })).toHaveValue('Original area')
    await preview.getByRole('combobox', { name: 'Static select', exact: true }).press('ArrowDown')
    await expect(preview.getByRole('combobox', { name: 'Static select', exact: true })).toHaveValue('First')
    const frameUrl = nativeFrame.url()
    await clickPreview(preview.getByRole('button', { name: 'Static submit', exact: true }))
    assert.equal(nativeFrame.url(), frameUrl)
    await expect(preview.getByRole('button', { name: 'Static submit', exact: true })).toBeVisible()
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.locator('.requirements-prd-pane').evaluate(element => { element.scrollTop = 0 })
      await settleReading()
      await assertNoReverseNavigation(() => clickPreview(preview.getByRole('button', { name: '保存订单', exact: true })))
    }
    for (const width of [1440, 1367, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 })
      if (width < 760) await page.getByRole('radio', { name: 'PRD', exact: true }).check()
      await scrollPrdTo(width < 760 ? 'REQ2' : 'REQ1')
      await assertReading(width < 760 ? 'REQ2' : 'REQ1')
      if (width < 760) await page.getByRole('radio', { name: '设计', exact: true }).check()
      await designSelector.scrollIntoViewIfNeeded(); await designSelector.click()
      const listbox = page.getByRole('listbox')
      await expect(listbox.getByRole('group')).toHaveCount(1)
      await expect(listbox.getByRole('option').first()).toContainText('页')
      const headingLayout = await designSelector.evaluate(element => {
        const bounds = element.getBoundingClientRect()
        const heading = element.closest('.requirements-design-heading')!.querySelector('h2')!.getBoundingClientRect()
        return { width: bounds.width, aligned: Math.abs((bounds.top + bounds.bottom) / 2 - (heading.top + heading.bottom) / 2) < 2, border: getComputedStyle(element).borderTopWidth, background: getComputedStyle(element).backgroundColor }
      })
      assert.ok(headingLayout.width <= 361 && headingLayout.aligned)
      if (width > 760) assert.ok(headingLayout.width >= 350)
      assert.equal(headingLayout.border, '0px')
      assert.notEqual(headingLayout.background, 'rgba(0, 0, 0, 0)')
      const bounds = await page.locator('.filter-select-cascade').boundingBox(); const trigger = await designSelector.boundingBox()
      assert.ok(bounds && trigger && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y + bounds.height <= 1001)
      assert.ok(bounds.y + bounds.height <= trigger.y + 1 || bounds.y >= trigger.y + trigger.height - 1)
      await page.screenshot({ path: join(temporary, `requirements-expanded-${width}.png`), fullPage: true })
      await listbox.press('Escape'); await expect(designSelector).toBeFocused()
      await designSelector.press('ArrowDown'); await listbox.press('ArrowLeft'); await page.keyboard.press('End'); await page.keyboard.press('ArrowRight'); await listbox.press('Enter')
      await expect(designSelector).toContainText('检索订单')
      await expect(listbox).toBeVisible()
      await page.getByRole('heading', { name: '设计原型', exact: true }).click()
      await expect(listbox).toHaveCount(0)
      const assertFit = async () => {
        await expect.poll(() => page.locator('.requirements-design-pane').evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true)
        await expect.poll(() => page.locator('.requirements-artboard iframe').evaluate(element => {
          const frame = element.getBoundingClientRect()
          const container = element.parentElement!.getBoundingClientRect()
          return frame.width <= container.width + 1 && frame.height <= container.height + 1
        })).toBe(true)
        await expect.poll(() => preview.locator('body').evaluate(body => {
          const right = body.querySelector('button[style]')!.getBoundingClientRect().right
          const footer = body.querySelector('footer')!.getBoundingClientRect().bottom
          return right <= document.documentElement.clientWidth + 1 && document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1 && footer <= innerHeight + 1
        })).toBe(true)
        const layout = await preview.locator('.fluid-table').evaluate(element => {
          const action = element.querySelector('.fluid-actions')!
          return { viewport: innerWidth, width: element.getBoundingClientRect().width, actionHeight: action.getBoundingClientRect().height, fontSize: getComputedStyle(element).fontSize }
        })
        assert.equal(layout.viewport, 1600)
        assert.ok(layout.width >= 1590)
        assert.ok(layout.actionHeight < 25)
        assert.notEqual(layout.fontSize, '30px')
        const heights = await page.locator('iframe').evaluate(async element => {
          const samples: number[] = []
          for (let frame = 0; frame < 12; frame++) {
            await new Promise(requestAnimationFrame)
            samples.push(element.clientHeight)
          }
          return samples
        })
        assert.equal(new Set(heights).size, 1, 'Viewport-relative content must not cause height feedback')
      }
      await assertFit()
      if (width > 760) {
        for (const split of ['35', '70']) {
          await page.getByRole('slider', { name: '设计区域宽度', exact: true }).fill(split)
          await assertFit()
        }
      }
      await designSelector.click()
      await expect(listbox).toBeVisible()
      if (width > 760) await clickPreview(preview.locator('footer'))
      else await page.getByRole('heading', { name: '设计原型', exact: true }).click()
      await expect(listbox).toHaveCount(0)
      await assertNoReverseNavigation(() => clickPreview(preview.getByRole('button', { name: 'Right edge', exact: true })))
      await page.screenshot({ path: join(temporary, `requirements-fit-width-${width}.png`), fullPage: true })
      await expect(preview.locator('svg circle')).toHaveAttribute('r', '10')
      await assertNoReverseNavigation(() => clickPreview(preview.locator('svg[data-requirement-id]')))
      await designSelector.click(); await page.getByRole('heading', { name: '设计原型', exact: true }).click()
      await expect(listbox).toHaveCount(0)
      await preview.getByRole('button', { name: '检索订单', exact: true }).focus()
      await assertNoReverseNavigation(() => preview.getByRole('button', { name: '检索订单', exact: true }).press('Enter'))
      if (width < 760) {
        await expect(page.getByRole('radio', { name: '设计', exact: true })).toBeChecked()
        await expect(prdPane).toBeHidden()
        await prdPane.evaluate(element => { element.scrollTop = 0 })
        await page.evaluate(() => window.dispatchEvent(new Event('resize')))
        await settleReading()
        await assertReading('REQ2')
        await page.getByRole('radio', { name: 'PRD', exact: true }).check()
        await prdPane.locator('[data-prd-requirement="REQ1"]').scrollIntoViewIfNeeded()
        await assertReading('REQ1')
        await page.getByRole('radio', { name: '设计', exact: true }).check()
      } else await expect(prdPane).toBeVisible()
      await page.screenshot({ path: join(temporary, `requirements-static-preview-${width}.png`), fullPage: true })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      const boxes = await page.locator('.requirements-stage-actions button').evaluateAll(elements => elements.map(element => { const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom } }))
      for (const [index, box] of boxes.entries()) {
        assert.ok(box.x >= 0 && box.right <= width + 1)
        for (const other of boxes.slice(index + 1)) assert.ok(box.right <= other.x + 1 || other.right <= box.x + 1 || box.bottom <= other.y + 1 || other.bottom <= box.y + 1)
      }
      if (width < 760) await page.getByRole('radio', { name: 'PRD', exact: true }).check()
      await expect(prdPane.getByRole('heading', { name: '模块：订单检索', exact: true, level: 3 })).toBeVisible()
      const functionOutline = prdPane.locator('[data-prd-requirement="REQ2"]')
      await expect(functionOutline.getByText('对应场景：订单列表筛选', { exact: true })).toBeVisible()
      await expect(functionOutline.getByRole('button', { name: '检索订单', exact: true })).toBeVisible()
      const fields = prdPane.getByRole('list', { name: '检索订单字段', exact: true })
      await expect(fields.locator(':scope > li')).toHaveCount(2)
      await expect(fields.locator(':scope > li').nth(1).getByRole('listitem')).toHaveText(['待处理', '处理中', '已完成'])
      assert.equal(await prdPane.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true)
      assert.doesNotMatch(await prdPane.innerText(), /REQ[12]|AC[12]/)
      await page.locator('[data-prd-requirement="REQ2"]').scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(temporary, `requirements-prd-hierarchy-${width}.png`), fullPage: true })
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
    const validateButton = page.getByRole('button', { name: '检查静态设计', exact: true })
    await validateButton.scrollIntoViewIfNeeded()
    await validateButton.click({ trial: true })
    await validateButton.click()
    await expect(page.getByText('静态检查未报告错误 · 交互未验证', { exact: true })).toBeVisible()
    await expect(page.getByRole('list', { name: '验证局限', exact: true })).toContainText('static screenshots only')
    await designSelector.press('ArrowDown')
    await page.getByRole('listbox').press('ArrowLeft'); await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight')
    await page.getByRole('listbox').press('Home'); await page.getByRole('listbox').press('Enter')
    await expect(page.getByRole('img', { name: /截图$/ })).toBeVisible()
    assert.equal(await page.getByRole('img', { name: /截图$/ }).evaluate(image => (image as HTMLImageElement).naturalWidth > 0), true)
    await expect(page.locator('iframe')).toHaveCount(0)
    await page.getByRole('button', { name: '确认设计', exact: true }).click()
    await expect(page.getByRole('button', { name: '确认设计', exact: true })).toBeDisabled()
    for (const format of ['MD', 'DOCX', 'HTML', 'ZIP']) {
      const download = page.waitForEvent('download')
      await page.getByRole('link', { name: format, exact: true }).click()
      await download
    }
    await page.getByRole('combobox', { name: '修订历史', exact: true }).click()
    await page.getByRole('listbox').press('Home'); await page.getByRole('listbox').press('Enter')
    await expect(page.getByText('历史修订 · 只读', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '确认 PRD', exact: true })).toBeDisabled()
    await expect(page.getByRole('link', { name: 'MD', exact: true })).toHaveAttribute('href', /revision=original/)
    await page.getByRole('combobox', { name: '修订历史', exact: true }).click()
    await page.getByRole('listbox').press('End'); await page.getByRole('listbox').press('Enter')
    await page.getByRole('button', { name: '创建修订', exact: true }).click()
    await expect(page.getByRole('textbox', { name: '修订意见', exact: true })).toHaveValue('')
    await expect(page.getByRole('button', { name: '生成 PRD', exact: true })).toBeDisabled()
    const jobErrors = ['Historical analysis failure', 'Historical PRD failure', 'Last design failure']
    project.jobs.push(
      { id: 'failed-analysis', stage: 'analyze', status: 'failed', startedAt: at, error: jobErrors[0] },
      { id: 'failed-prd', stage: 'prd', status: 'failed', startedAt: at, error: jobErrors[1] },
      { id: 'failed-design', stage: 'design', status: 'failed', startedAt: at, error: jobErrors[2] },
    )
    project.status = 'failed'; project.version++
    await historyTrigger.focus(); await historyTrigger.press('Enter')
    await page.getByRole('button', { name: '刷新项目列表', exact: true }).click()
    await page.keyboard.press('Escape')
    const overview = page.getByRole('region', { name: '项目概况', exact: true })
    await expect(overview.getByRole('alert')).toHaveCount(1)
    await expect(overview.getByRole('alert')).toHaveText(`生成设计 · ${jobErrors[2]}`)
    for (const message of jobErrors.slice(0, -1)) await expect(overview).not.toContainText(message)
    project.jobs.at(-1)!.error = '[PAGE_CAPTURE_LOGIN] 业务页面需要登录，独立浏览器没有会话'
    project.version++
    await historyTrigger.focus(); await historyTrigger.press('Enter')
    await page.getByRole('button', { name: '刷新项目列表', exact: true }).click()
    await page.keyboard.press('Escape')
    const supplement = page.getByRole('region', { name: '取证待补充', exact: true })
    await expect(supplement).toBeVisible()
    await expect(supplement.getByRole('button', { name: '重新取证并生成 PRD', exact: true })).toBeVisible()
    await expect(supplement.getByRole('button', { name: '重新取证并生成设计', exact: true })).toHaveCount(0)
    await expect(supplement).toContainText('仅在你自己的浏览器登录不会同步到平台')
    await supplement.getByRole('textbox', { name: '修正取证地址', exact: true }).fill('https://tmp.test.sunmi.com')
    await supplement.getByRole('button', { name: '保存地址', exact: true }).click()
    assert.equal(project.preview?.origin, 'https://tmp.test.sunmi.com')
    await supplement.getByRole('textbox', { name: '页面访问补充说明', exact: true }).fill('password=not-a-real-secret')
    await supplement.getByRole('button', { name: '提交补充资料', exact: true }).click()
    await expect(page.getByRole('alert').filter({ hasText: '请移除密码' })).toBeVisible()
    for (const width of [1440, 1367, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 })
      await supplement.scrollIntoViewIfNeeded()
      assert.equal(await supplement.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true)
      await page.screenshot({ path: join(temporary, `requirements-capture-supplement-${width}.png`), fullPage: true })
    }
    project.jobs.at(-1)!.error = jobErrors[2]; project.version++
    await page.setViewportSize({ width: 1440, height: 1000 })
    await historyTrigger.focus(); await historyTrigger.press('Enter')
    await page.getByRole('button', { name: '刷新项目列表', exact: true }).click()
    await page.keyboard.press('Escape')
    await expect(supplement).toHaveCount(0)
    const jobHistory = page.locator('details').filter({ has: page.locator('summary', { hasText: /^任务与进度记录$/ }) })
    await expect(jobHistory).not.toHaveAttribute('open')
    await jobHistory.locator('summary').click()
    for (const message of jobErrors) await expect(jobHistory.getByText(message, { exact: true })).toBeVisible()
    for (const status of ['failed', 'cancelled', 'interrupted'] as const) {
      project.status = status; project.version++
      await historyTrigger.focus(); await historyTrigger.press('Enter')
      await page.getByRole('button', { name: '刷新项目列表', exact: true }).click()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('status').filter({ hasText: `v${project.version}` })).toBeVisible()
      await expect(page.getByRole('button', { name: '分析需求', exact: true })).toBeEnabled()
    }
    heldJob = true
    await page.getByRole('button', { name: '分析需求', exact: true }).click()
    await expect(overview.getByRole('progressbar')).toBeVisible()
    project.jobs.at(-1)!.stage = 'design'
    project.jobs.at(-1)!.interaction = { kind: 'browser_login', phase: 'ready', origin: 'https://tmp.test.sunmi.com', expiresAt: new Date(Date.now() + 300000).toISOString() }
    project.version++
    await historyTrigger.focus(); await historyTrigger.press('Enter')
    await page.getByRole('button', { name: '刷新项目列表', exact: true }).click()
    const loginDialog = page.getByRole('dialog', { name: '需要你完成系统登录', exact: true })
    await expect(loginDialog).toBeVisible()
    assert.equal(await loginDialog.evaluate(element => element.contains(document.activeElement)), true)
    for (const width of [1440, 1367, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 })
      const bounds = await loginDialog.boundingBox()
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y >= 0 && bounds.y + bounds.height <= 1001)
      assert.equal(await loginDialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true)
      await page.screenshot({ path: join(temporary, `requirements-login-${width}.png`) })
    }
    await loginDialog.press('Escape')
    await expect(loginDialog).not.toBeVisible()
    await expect(page.getByRole('button', { name: '处理登录请求', exact: true })).toBeFocused()
    await page.getByRole('button', { name: '处理登录请求', exact: true }).click()
    await loginDialog.getByRole('button', { name: '打开登录窗口', exact: true }).click()
    await expect(loginDialog.getByRole('button', { name: '我已完成登录，继续取证', exact: true })).toBeVisible()
    await loginDialog.getByRole('button', { name: '我已完成登录，继续取证', exact: true }).click()
    await expect(loginDialog).toHaveCount(0)
    assert.equal(project.jobs.at(-1)?.status, 'running')
    project.jobs.at(-1)!.interaction = { kind: 'browser_login', phase: 'ready', origin: 'https://tmp.test.sunmi.com', expiresAt: new Date(Date.now() + 299000).toISOString() }
    project.version++
    await page.setViewportSize({ width: 1440, height: 1000 })
    await historyTrigger.focus(); await historyTrigger.press('Enter')
    await page.getByRole('button', { name: '刷新项目列表', exact: true }).click()
    await expect(loginDialog).toBeVisible()
    await loginDialog.getByRole('button', { name: '取消取证', exact: true }).click()
    await expect(loginDialog).toHaveCount(0)
    assert.equal(project.jobs.at(-1)?.interaction, undefined)
    await page.getByRole('button', { name: '分析需求', exact: true }).click()
    await expect(overview.getByRole('alert')).toHaveCount(0)
    for (const message of jobErrors) {
      await expect(overview).not.toContainText(message)
      await expect(jobHistory.getByText(message, { exact: true })).toBeVisible()
    }
    await page.getByRole('button', { name: '取消任务', exact: true }).click()
    await expect(page.getByRole('button', { name: '分析需求', exact: true })).toBeEnabled()
    heldJob = false
    await page.getByRole('button', { name: '分析需求', exact: true }).click()
    await expect(page.getByRole('button', { name: '生成 PRD', exact: true })).toBeEnabled()
    assert.equal(project.jobs.at(-1)?.status, 'succeeded')
    await expect(overview.getByRole('alert')).toHaveCount(0)
    for (const message of jobErrors) {
      await expect(overview).not.toContainText(message)
      await expect(jobHistory.getByText(message, { exact: true })).toBeVisible()
    }
    await menuLink.click()
    await expect(page.getByRole('heading', { name: '新建需求项目', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '项目记录', exact: true }).focus()
    await page.getByRole('button', { name: '项目记录', exact: true }).press('Enter')
    await page.getByRole('link', { name: /订单需求项目/ }).click()
    await page.goBack()
    await expect(page.getByRole('heading', { name: '新建需求项目', exact: true })).toBeVisible()
    assert.equal(await page.evaluate(() => (window as unknown as { requirementsMarker: string }).requirementsMarker), 'same-document')
    assert.equal(authReads, 1)
    assert.deepEqual(violations, [])
    assert.deepEqual(external, [])
  } finally {
    await browser?.close(); await server.close()
    if (process.env.KEEP_UI_SCREENSHOTS === '1') console.log(`Requirements screenshots: ${temporary}`)
    else rmSync(temporary, { recursive: true, force: true })
  }
})