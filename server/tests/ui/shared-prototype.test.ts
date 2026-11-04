import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright-core'
import { expect } from '@playwright/test'
import { validatePrototypeDesign } from '../../requirements/prototype-design.js'
import { executionEnvironment } from '../../execution/execution-environment.js'
import type { RequirementProject, StructuredPrd } from '../../../shared/requirements.js'

test('shared page dialog switches three states and refreshes all previews after one source adjustment', { timeout: 120000 }, async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'shared-prototype-ui-'))
  const server = await createServer({ configFile: false, envDir: false, cacheDir: join(temporary, '.vite'), plugins: [react()], server: { host: '127.0.0.1', port: 0, watch: null } })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await server.listen()
    const address = server.httpServer!.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    browser = await chromium.launch({ channel: 'chrome', headless: true, env: executionEnvironment() })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    const at = '2026-11-04T00:00:00.000Z'
    const prd: StructuredPrd = { title: '测试计划', summary: '新建计划', blocks: [{ id: 'B1', title: '计划页', content: '新建', requirementIds: ['R1'], sourceIds: [] }], requirements: [{ id: 'R1', title: '新建计划', description: '填写并保存计划', sourceIds: [], acceptance: [{ id: 'A1', text: '新增成功' }] }] }
    const source = { id: 'PLAN', title: '测试计划页', html: '<!doctype html><html><head><style>body{margin:0}.dialog{width:600px;padding:16px;background:#d7e9dd}main{min-height:500px;background:#f4f6f5}</style></head><body><main data-requirement-id="R1" data-acceptance-id="A1"><section class="dialog" data-prototype-node="dialog"><h1>新建测试计划</h1><label>计划名称<input data-prototype-node="name"></label><p data-prototype-node="error" hidden>计划名称必填</p></section><p data-prototype-node="success" hidden>新增计划成功</p></main></body></html>', states: [
      { id: 'NORMAL', name: '正常新增', requirementIds: ['R1'], acceptanceIds: ['A1'], changes: [] },
      { id: 'ERROR', name: '字段校验失败', requirementIds: ['R1'], acceptanceIds: ['A1'], changes: [{ node: 'error', hidden: false }] },
      { id: 'SUCCESS', name: '新增成功', requirementIds: ['R1'], acceptanceIds: ['A1'], changes: [{ node: 'dialog', hidden: true }, { node: 'success', hidden: false }] },
    ] }
    const project: RequirementProject = { schemaVersion: 1, id: '11111111-1111-4111-8111-111111111111', ownerId: 7, version: 1, title: '共享原型', description: '测试计划', modelId: 'auto', createdAt: at, updatedAt: at, status: 'design_review', sources: [], evidence: [], questions: [], decisions: [], revisions: [{ id: 'V1', createdAt: at, confirmedAt: at, prd, ...validatePrototypeDesign([source], prd) }], jobs: [{ id: 'ANALYSIS', stage: 'analyze', status: 'succeeded', startedAt: at, endedAt: at }], events: [{ id: 'E1', at, text: 'analysis:ANALYSIS' }] }
    let writes = 0
    await page.route('**/api/**', async route => {
      const request = route.request()
      const path = new URL(request.url()).pathname
      if (path === '/api/auth/status') return route.fulfill({ json: { configured: true, authenticated: true, login: 'fixture', userId: 7 } })
      if (path === '/api/copilot/models') return route.fulfill({ json: { defaultModelId: 'auto', models: [{ id: 'auto', name: 'Auto', vision: true }] } })
      if (path === '/api/requirements/projects') return route.fulfill({ json: [project] })
      if (request.method() === 'GET' && path === `/api/requirements/projects/${project.id}`) return route.fulfill({ json: project })
      assert.equal(path, `/api/requirements/projects/${project.id}/jobs`)
      const body = request.postDataJSON()
      assert.deepEqual(Object.keys(body).sort(), ['instruction', 'screenId', 'stage', 'version'])
      assert.equal(body.version, project.version)
      assert.equal(body.screenId, 'NORMAL')
      assert.equal(body.stage, 'design')
      assert.equal(body.instruction, '弹窗宽度改为720px')
      writes++
      const updated = { ...source, html: source.html.replace('width:600px', 'width:720px'), states: source.states.map(state => ({ ...state, id: `${state.id}-V2` })) }
      const design = validatePrototypeDesign([updated], prd)
      project.revisions.push({ id: 'V2', createdAt: at, confirmedAt: at, prd, ...design, screenshots: design.screens.map(screen => ({ screenId: screen.id, storageKey: `V2/${screen.id}.png`, sha256: 'fixture' })) })
      project.jobs.push({ id: 'DESIGN', stage: 'design', status: 'succeeded', startedAt: at, endedAt: at })
      project.version++
      return route.fulfill({ json: project })
    })
    await page.goto(`${origin}/requirements/${project.id}`, { waitUntil: 'networkidle' })
    for (const width of [1440, 1367, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 })
      if (width < 760) await page.getByRole('radio', { name: '设计', exact: true }).check()
      await page.getByRole('button', { name: '调整原型', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '原型调整', exact: true })
      const selector = dialog.getByRole('combobox', { name: '原型状态', exact: true })
      await expect(dialog.getByRole('listitem')).toHaveCount(3)
      await selector.click()
      const menu = dialog.getByRole('listbox')
      const bounds = await menu.boundingBox()
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y >= 0 && bounds.y + bounds.height <= 1001)
      await page.screenshot({ path: join(temporary, `shared-states-${width}.png`), fullPage: true })
      await menu.getByRole('option', { name: '字段校验失败', exact: true }).click()
      await expect(dialog.frameLocator('iframe').getByText('计划名称必填', { exact: true })).toBeVisible()
      await selector.click(); await menu.getByRole('option', { name: '新增成功', exact: true }).click()
      await expect(dialog.frameLocator('iframe').getByText('新增计划成功', { exact: true })).toBeVisible()
      await expect(dialog.frameLocator('iframe').getByRole('heading', { name: '新建测试计划', exact: true })).toBeHidden()
      await selector.click(); await menu.press('Home'); await menu.press('Enter')
      await page.keyboard.press('Escape')
      await expect(page.getByRole('button', { name: '调整原型', exact: true })).toBeFocused()
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.getByRole('button', { name: '调整原型', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '原型调整', exact: true })
    await dialog.getByRole('textbox', { name: '原型修改意见' }).fill('弹窗宽度改为720px')
    await dialog.getByRole('button', { name: '发送并调整原型', exact: true }).click()
    await expect(dialog.getByRole('log')).toContainText('原型和各状态截图已更新')
    assert.equal(writes, 1)
    assert.equal(project.revisions[1].prototypes!.length, 1)
    assert.equal(project.revisions[1].screenshots!.length, 3)
    for (const name of ['正常新增', '字段校验失败', '新增成功']) {
      await dialog.getByRole('combobox', { name: '原型状态', exact: true }).click()
      await dialog.getByRole('option', { name, exact: true }).click()
      await expect.poll(() => dialog.frameLocator('iframe').locator('.dialog').evaluate(element => getComputedStyle(element).width)).toBe('720px')
    }
    assert.ok(project.revisions[0].screens.every(screen => screen.html.includes('width:600px')))
  } finally {
    await browser?.close(); await server.close()
    if (process.env.KEEP_UI_SCREENSHOTS === '1') console.log(`Shared prototype screenshots: ${temporary}`)
    else rmSync(temporary, { recursive: true, force: true })
  }
})