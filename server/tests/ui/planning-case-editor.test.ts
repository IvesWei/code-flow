import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright-core'
import { expect } from '@playwright/test'
import type { CaseDefinition, PlanningProject } from '../../../shared/testing.js'
import { PlanningCaseActions, PlanningCaseEditor } from '../../../src/features/testing/planning/PlanningCaseEditor.js'
import { executionEnvironment } from '../../execution/execution-environment.js'

const definition: CaseDefinition = { id: 'TC-1', title: 'Title', source: 'Requirements', steps: 'Steps', expected: 'Expected', requirementIds: ['REQ-1'], assertions: ['First', 'Second'] }
const project: PlanningProject = { id: 'project', ownerId: 1, version: 4, createdAt: '', updatedAt: '', input: { title: '', requirements: '', instruction: '', modelId: 'auto', sources: [] }, events: [], caseSetIds: [], status: 'draft', draft: { baseline: [], cases: [definition], definitionFingerprint: 'current', assessment: { status: 'rejected', checkedAt: '', coveredIds: [], missingIds: [], issues: ['Global issue', 'TC-2: unrelated'], caseIssues: [{ caseId: 'TC-1', message: 'Fix first' }, { caseId: 'TC-2', message: 'Fix second' }] }, customReview: { caseIds: ['TC-1'], reason: 'Scope', definitionFingerprint: 'current', batches: [], assessment: { status: 'rejected', checkedAt: '', coveredIds: [], missingIds: [], issues: [], findings: [{ code: 'quality', category: 'quality', caseIds: ['TC-1'], message: 'Custom first' }] } } } }

test('single-case issues include only associated current full and custom review problems', () => {
  const render = (value: PlanningProject) => renderToStaticMarkup(createElement(PlanningCaseActions, { project: value, definition, disabled: false, onReview: () => {} }))
  const markup = render(project)
  assert.match(markup, /Fix first/)
  assert.match(markup, /Custom first/)
  assert.doesNotMatch(markup, /Global issue|Fix second|unrelated/)
  const stale = structuredClone(project)
  stale.draft!.customReview!.definitionFingerprint = 'old'
  assert.match(render(stale), /Fix first/)
  assert.doesNotMatch(render(stale), /Custom first/)
})

test('editor renders complete legacy-safe fields and custom selects without an editable id', () => {
  const markup = renderToStaticMarkup(createElement(PlanningCaseEditor, { definition, baseline: [], version: 4, mode: 'edit', issues: [], disabled: false, onEdit: async () => {}, onClose: () => {} }))
  for (const text of ['标题', '来源', '需求映射', 'REQ-1', '前置条件', '测试数据', '步骤', '预期', '断言（每行一条）', '清理', '设置用例分类']) assert.ok(markup.includes(text), text)
  assert.match(markup, /readonly="" value="TC-1"/i)
  assert.match(markup, /First\nSecond/)
  assert.doesNotMatch(markup, /<select|风险理由|测试文件/)
  const classified = renderToStaticMarkup(createElement(PlanningCaseEditor, { definition: { ...definition, classification: { testType: 'security', priority: 'P0', executionPolicy: 'on_demand', riskReason: 'Risk', tags: ['auth'] } }, baseline: [], version: 4, mode: 'edit', issues: [], disabled: false, onClose: () => {} }))
  for (const text of ['测试类型 TC-1', '优先级 TC-1', '执行策略 TC-1', '风险理由', '标签（逗号分隔）', 'auth']) assert.ok(classified.includes(text), text)
})

test('optimization prefills only supplied issues and requires a reason', () => {
  const markup = renderToStaticMarkup(createElement(PlanningCaseEditor, { definition, baseline: [], version: 4, mode: 'optimize', issues: ['Fix first', 'Custom first'], disabled: false, onClose: () => {} }))
  assert.match(markup, /Fix first\nCustom first/)
  assert.match(markup, /重新生成此用例/)
  assert.match(markup, /required="" maxlength="2000"/i)
  assert.doesNotMatch(markup, /Global issue|Fix second|unrelated|<select/)
})

test('mocked case editing retains conflicts and polling inputs, submits captured versions and bounds expanded controls', async context => {
  const temporary = mkdtempSync(join(tmpdir(), 'planning-case-editor-'))
  const server = await createServer({ configFile: false, envDir: false, cacheDir: join(temporary, '.vite'), plugins: [react()], server: { host: '127.0.0.1', port: 0, watch: null } })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await server.listen()
    const address = server.httpServer?.address()
    if (!address || typeof address === 'string') throw new Error('Missing Vite port')
    browser = await chromium.launch({ channel: 'chrome', headless: true, env: executionEnvironment() })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.setDefaultTimeout(10000)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const current = structuredClone(project)
    current.id = 'project/one'
    current.draft!.cases[0].id = 'TC-1'
    current.draft!.baseline = [{ id: 'REQ-1', feature: 'Long requirement heading '.repeat(8), criterion: 'Criterion', source: 'Requirements', required: true, scenarios: ['normal'] }]
    let rejectEdit = true
    let rejectOptimize = true
    const posts: { path: string; body: Record<string, unknown> }[] = []
    await page.route('**/api/**', async route => {
      const request = route.request()
      const path = new URL(request.url()).pathname
      const respond = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
      if (request.method() === 'POST') {
        const body = request.postDataJSON() as Record<string, unknown>
        posts.push({ path, body })
        if (path.endsWith('/cases/TC-1')) {
          if (rejectEdit) return respond({ error: 'Version conflict: refresh required' }, 409)
          current.draft!.cases[0] = body.caseDefinition as CaseDefinition
          current.version++
          current.draft!.assessment = undefined
          current.draft!.customReview = undefined
          return respond(current)
        }
        if (path.endsWith('/optimize')) {
          if (Object.keys(body).some(key => !['version', 'caseIds', 'reason', 'regenerate'].includes(key))) return respond({ error: 'Invalid optimization fields' }, 400)
          return rejectOptimize ? respond({ error: 'Optimization failed' }, 503) : respond(current, 202)
        }
        if (path.endsWith('/review')) return respond(current, 202)
        throw new Error(`Unexpected POST ${path}`)
      }
      if (path === '/api/auth/status') return respond({ configured: true, authenticated: true })
      if (path === '/api/copilot/models') return respond({ models: [] })
      if (path === '/api/testing/packages') return respond([])
      if (path === '/api/testing/projects') return respond([current])
      if (path === '/api/testing/projects/project%2Fone') return respond(current)
      throw new Error(`Unexpected GET ${path}`)
    })
    await page.goto(`http://127.0.0.1:${address.port}/?view=planning&planning=project%2Fone`, { waitUntil: 'networkidle' })
    await page.locator('.planning-case-details > summary').click()
    const actions = page.locator('.planning-case-actions')
    await expect(actions.getByLabel('审查问题 TC-1')).toContainText('Custom first')
    await expect(actions).not.toContainText('Global issue')
    await page.getByRole('button', { name: '编辑 TC-1', exact: true }).click()
    let form = page.getByRole('form', { name: '编辑用例 TC-1', exact: true })
    await form.getByLabel('标题', { exact: true }).fill('Local title')
    current.version = 9
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await expect(page.getByRole('main')).toHaveAttribute('aria-busy', 'false')
    await expect(form.getByLabel('标题', { exact: true })).toHaveValue('Local title')
    await form.getByRole('button', { name: '保存', exact: true }).click()
    await expect(form.getByRole('alert')).toContainText('Version conflict')
    assert.equal(posts.at(-1)?.body.version, 4)
    assert.equal(posts.at(-1)?.path, '/api/testing/projects/project%2Fone/cases/TC-1')
    await expect(form.getByLabel('标题', { exact: true })).toHaveValue('Local title')
    await form.getByRole('button', { name: '取消', exact: true }).click()
    await expect(page.getByRole('button', { name: '编辑 TC-1', exact: true })).toBeFocused()
    await page.getByRole('button', { name: '编辑 TC-1', exact: true }).click()
    form = page.getByRole('form', { name: '编辑用例 TC-1', exact: true })
    await form.getByLabel('设置用例分类').check()
    await form.getByLabel('风险理由').fill('Reviewed risk')
    await form.getByLabel('标签（逗号分隔）').fill('auth, regression')
    for (const width of [1440, 1367, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 })
      const scenario = form.getByRole('combobox', { name: '场景 TC-1', exact: true })
      await scenario.click()
      const menu = page.getByRole('listbox', { name: '场景 TC-1', exact: true })
      await expect(menu).toBeVisible()
      const box = await menu.boundingBox()
      const trigger = await scenario.boundingBox()
      assert.ok(box && trigger && box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= 1000)
      assert.ok(box!.y >= trigger!.y + trigger!.height || box!.y + box!.height <= trigger!.y)
      await page.screenshot({ path: join(temporary, `expanded-${width}.png`), fullPage: true })
      await menu.press('End')
      await menu.press('Enter')
      await expect(scenario).toBeFocused()
      await scenario.click()
      await page.getByRole('listbox').press('Escape')
      await expect(scenario).toBeFocused()
      const bounds = await form.evaluate(element => {
        const box = element.getBoundingClientRect()
        return { left: box.left, right: box.right, overflow: document.documentElement.scrollWidth > window.innerWidth, controls: [...element.querySelectorAll('input,textarea,button')].every(control => { const rect = control.getBoundingClientRect(); return rect.left >= box.left - 1 && rect.right <= box.right + 1 }) }
      })
      assert.ok(bounds.left >= 0 && bounds.right <= width && !bounds.overflow && bounds.controls, JSON.stringify({ width, ...bounds }))
    }
    await form.getByLabel('标题', { exact: true }).fill('Saved title')
    await form.getByLabel('断言（每行一条）').fill('First updated\nSecond updated')
    rejectEdit = false
    await form.getByRole('button', { name: '保存', exact: true }).click()
    await expect(form).toHaveCount(0)
    assert.equal(posts.at(-1)?.body.version, 9)
    const saved = posts.at(-1)?.body.caseDefinition as CaseDefinition
    assert.equal(saved.id, 'TC-1')
    assert.equal(saved.scenario, 'state')
    assert.deepEqual(saved.classification?.tags, ['auth', 'regression'])
    assert.deepEqual(saved.assertions, ['First updated', 'Second updated'])
    await page.getByRole('button', { name: '优化 TC-1', exact: true }).click()
    const optimize = page.getByRole('form', { name: '优化用例 TC-1', exact: true })
    await expect(optimize.getByRole('button', { name: '优化此用例', exact: true })).toBeDisabled()
    await optimize.getByLabel('优化理由').fill('Improve this case only')
    await optimize.getByRole('button', { name: '优化此用例', exact: true }).click()
    await expect(optimize.getByRole('alert')).toHaveText('Optimization failed')
    assert.deepEqual(posts.at(-1)?.body, { version: 10, caseIds: ['TC-1'], reason: 'Improve this case only', regenerate: false })
    await expect(optimize.getByLabel('优化理由')).toHaveValue('Improve this case only')
    await optimize.getByLabel('重新生成此用例', { exact: true }).check()
    rejectOptimize = false
    await optimize.getByRole('button', { name: '重新生成此用例', exact: true }).click()
    await expect(optimize).toHaveCount(0)
    assert.deepEqual(posts.at(-1)?.body, { version: 10, caseIds: ['TC-1'], reason: 'Improve this case only', regenerate: true })
    await page.getByRole('button', { name: '审查此用例 TC-1', exact: true }).click()
    await expect.poll(() => posts.at(-1)?.path).toBe('/api/testing/projects/project%2Fone/review')
    assert.deepEqual(posts.at(-1)?.body.caseIds, ['TC-1'])
    assert.deepEqual(errors, [])
    if (process.env.KEEP_UI_SCREENSHOTS === '1') context.diagnostic(`Screenshots: ${temporary}`)
  } finally {
    await browser?.close()
    await server.close()
    if (process.env.KEEP_UI_SCREENSHOTS !== '1') rmSync(temporary, { recursive: true, force: true })
  }
})