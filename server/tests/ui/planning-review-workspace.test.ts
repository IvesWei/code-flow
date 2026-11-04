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
import type { PlanningProject } from '../../../shared/testing.js'
import { PlanningCases, planningGenerationIdentity, restorePlanningSelection } from '../../../src/features/testing/planning/PlanningCases.js'
import { executionEnvironment } from '../../execution/execution-environment.js'

const project: PlanningProject = {
  id: 'review-project', ownerId: 7, version: 4, createdAt: '', updatedAt: '', status: 'draft',
  input: { title: 'Review', requirements: '', instruction: '', modelId: 'auto', sources: [] },
  events: [{ at: '2026-10-23', kind: 'info', text: 'planning:generation:first' }], caseSetIds: [],
  draft: {
    definitionFingerprint: 'definition',
    baseline: [{ id: 'REQ-1', feature: '登录状态与认证结果完整核对：多行需求标题和异常数据清理'.repeat(3), criterion: '状态一致', source: '需求', required: true, scenarios: ['normal'] }],
    cases: Array.from({ length: 25 }, (_, index) => ({ id: `TC-${index + 1}`, title: `核对结果 ${index + 1}`, requirementIds: ['REQ-1'], source: '需求', steps: '提交并查询结果', expected: '结果一致', assertions: ['结果可观察'] })),
  },
}

test('SSR restores saved scope without browser storage and preserves independent row identifiers', () => {
  const value = structuredClone(project)
  value.draft!.customReview = { caseIds: ['TC-1'], reason: '范围理由', definitionFingerprint: 'definition', batches: [], assessment: { status: 'qualified', checkedAt: '', coveredIds: [], missingIds: [], issues: [], caseReviews: [{ caseId: 'TC-1', status: 'qualified' }] } }
  assert.deepEqual(restorePlanningSelection(value).selected, ['TC-1'])
  const markup = renderToStaticMarkup(createElement(PlanningCases, { project: value, busy: false, onReview: () => {}, onProceed: async () => {} }))
  for (const text of ['aria-label="用例设计列表"', 'aria-label="审查工作区"', 'aria-label="所选范围审查结果"', 'id="planning-case-TC-1"', 'id="planning-review-case-TC-1"', '进入执行']) assert.ok(markup.includes(text), text)
  assert.equal((markup.match(/id="planning-review-case-/g) || []).length, 1)
  value.draft!.customReview!.definitionFingerprint = 'stale'
  const stale = renderToStaticMarkup(createElement(PlanningCases, { project: value, busy: false, onReview: () => {}, onProceed: async () => {} }))
  assert.match(stale, /历史范围审查结果/)
  assert.doesNotMatch(stale, /aria-label="所选范围审查结果"|进入执行/)
})

test('only explicit fresh generation changes selection identity, not review, optimize, continue or manual edits', () => {
  for (const text of ['Reviewing saved case definitions; generation will not run.', 'Planning optimize: TC-1; a new design review is required.', 'Planning regenerate: TC-1; a new design review is required.', 'Continuing saved planning draft with 25 cases.', 'Manually edited TC-1; all prior design reviews invalidated.']) {
    const value = structuredClone(project)
    value.events.push({ at: '', kind: 'info', text: 'planning:generation:operation' }, { at: '', kind: 'info', text })
    assert.equal(planningGenerationIdentity(value), 'planning:generation:first', text)
    value.events.push({ at: '', kind: 'info', text: 'planning:generation:fresh' })
    assert.equal(planningGenerationIdentity(value), 'planning:generation:fresh')
  }
})

test('proceed requires a complete issue-free matching selected assessment and remains disabled while busy', () => {
  const value = structuredClone(project)
  value.draft!.customReview = { caseIds: ['TC-1'], reason: '范围理由', definitionFingerprint: 'definition', batches: [], assessment: { status: 'qualified', checkedAt: '', coveredIds: [], missingIds: [], issues: [], caseReviews: [{ caseId: 'TC-1', status: 'qualified' }] } }
  const assessment = value.draft!.customReview!.assessment!
  const render = () => renderToStaticMarkup(createElement(PlanningCases, { project: value, busy: false, onReview: () => {}, onProceed: async () => {} }))
  for (const change of [() => { assessment.issues = ['设计问题'] }, () => { assessment.caseIssues = [{ caseId: 'TC-1', message: '断言问题' }] }, () => { assessment.findings = [{ code: 'quality', category: 'quality', caseIds: ['TC-1'], message: '质量问题' }] }, () => { assessment.caseReviews = [] }, () => { assessment.caseReviews = [{ caseId: 'TC-1', status: 'unknown' }] }, () => { assessment.status = 'rejected' }]) {
    const original = structuredClone(assessment)
    change()
    assert.doesNotMatch(render(), /进入执行/)
    value.draft!.customReview!.assessment = structuredClone(original)
    Object.keys(assessment).forEach(key => Reflect.deleteProperty(assessment, key))
    Object.assign(assessment, original)
    value.draft!.customReview!.assessment = assessment
  }
  const busy = renderToStaticMarkup(createElement(PlanningCases, { project: value, busy: true, onReview: () => {}, onProceed: async () => {} }))
  assert.match(busy, /<button disabled="">[^]*?进入执行/)
  value.draft!.definitionFingerprint = undefined
  assert.doesNotMatch(render(), /进入执行/)
})

test('selected review workspace persists scopes, isolates controls and validates exact current results across four viewports', async context => {
  const temporary = mkdtempSync(join(tmpdir(), 'planning-review-ui-'))
  const html = `<html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module">
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { PlanningCases } from '/src/features/testing/planning/PlanningCases.tsx';
    import '/src/styles/index.css'; import '/src/styles/App.css'; import '/src/styles/testing.css';
    function Fixture() {
      const [project, setProject] = React.useState();
      React.useEffect(() => { fetch('/api/review-fixture').then(response => response.json()).then(setProject); const update = event => setProject(event.detail); window.addEventListener('fixture-project', update); return () => window.removeEventListener('fixture-project', update); }, []);
      async function post(action, body) { const response = await fetch('/api/review-fixture/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const value = await response.json(); if (!response.ok) throw new Error(value.error); if (action !== 'proceed') setProject(value); }
      return project && React.createElement('main', { className: 'testing-shell testing-workspace', style: { maxWidth: 1100, margin: 'auto', padding: 16 } }, React.createElement(PlanningCases, { project, busy: false, onReview: operation => post('review', operation), onEdit: (caseId, caseDefinition, version) => post('edit', { caseId, caseDefinition, version }), onOptimize: operation => post('optimize', operation), onProceed: scope => post('proceed', scope) }));
    }
    createRoot(document.getElementById('root')).render(React.createElement(Fixture));
  </script></body></html>`
  const server = await createServer({ configFile: false, envDir: false, cacheDir: join(temporary, '.vite'), plugins: [react(), { name: 'planning-review-fixture', configureServer(vite) { vite.middlewares.use('/__planning-review', async (_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end(await vite.transformIndexHtml('/__planning-review', html)) }) } }], server: { host: '127.0.0.1', port: 0, watch: null } })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await server.listen()
    const address = server.httpServer?.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    browser = await chromium.launch({ channel: 'chrome', headless: true, env: executionEnvironment() })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    let current = structuredClone(project)
    let rejectProceed = false
    const posts: { action: string; body: Record<string, unknown> }[] = []
    await page.route('**/api/review-fixture**', async route => {
      const request = route.request()
      const action = new URL(request.url()).pathname.split('/').at(-1)!
      const reply = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) })
      if (request.method() === 'GET') return reply(current)
      const body = request.postDataJSON()
      posts.push({ action, body })
      if (action === 'proceed') return rejectProceed ? reply({ error: '范围提交失败' }, 409) : reply({})
      assert.equal(body.version, current.version)
      current.version++
      if (action === 'review') current.draft!.customReview = { caseIds: body.caseIds, reason: body.reason, definitionFingerprint: current.draft!.definitionFingerprint!, batches: [], assessment: { status: 'qualified', checkedAt: '', coveredIds: [], missingIds: [], issues: [], caseReviews: body.caseIds.map((caseId: string) => ({ caseId, status: 'qualified' })) } }
      if (action === 'edit') { current.draft!.cases = current.draft!.cases.map(item => item.id === body.caseId ? body.caseDefinition : item); current.draft!.definitionFingerprint = `edited-${current.version}` }
      if (action === 'optimize' || action === 'edit') {
        current.draft!.customReview = undefined
        current.events.push({ at: '', kind: 'info', text: `planning:generation:operation-${current.version}` }, { at: '', kind: 'info', text: action === 'edit' ? 'Manually edited TC-1; all prior design reviews invalidated.' : 'Planning optimize: TC-1; a new design review is required.' })
      }
      return reply(current)
    })
    await page.goto(`http://127.0.0.1:${address.port}/__planning-review`, { waitUntil: 'networkidle' })
    const library = page.getByRole('region', { name: '用例设计列表', exact: true })
    const review = page.getByRole('region', { name: '审查工作区', exact: true })
    const update = async () => { await page.evaluate(value => window.dispatchEvent(new CustomEvent('fixture-project', { detail: value })), current) }
    await expect(review).toBeVisible()
    await library.getByRole('checkbox', { name: '选择全部筛选结果（25 条）', exact: true }).check()
    await review.getByLabel('审查范围理由', { exact: true }).fill('仅本次审查范围')
    await expect(review.locator('.planning-review-case')).toHaveCount(10)
    await review.getByRole('button', { name: '下一页审查用例', exact: true }).click()
    await expect(review.locator('.planning-review-case').first()).toHaveAttribute('id', 'planning-review-case-TC-11')
    await expect(library.locator('.planning-selectable-case').first()).toHaveAttribute('id', 'planning-case-TC-1')
    await review.getByRole('searchbox', { name: '搜索审查用例' }).fill('TC-25')
    await expect(review.locator('.planning-review-case')).toHaveCount(1)
    await library.getByRole('searchbox', { name: '搜索用例', exact: true }).fill('TC-1')
    await expect(review.locator('.planning-review-case')).toHaveCount(1)
    await expect(review.locator('.planning-review-case')).toContainText('TC-25')
    await review.getByRole('searchbox', { name: '搜索审查用例' }).fill('')
    await library.getByRole('searchbox', { name: '搜索用例', exact: true }).fill('')
    for (const width of [1440, 1367, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 })
      for (const label of ['用例类型', '每页审查用例']) {
        const trigger = page.getByRole('combobox', { name: label, exact: true })
        await trigger.click()
        const menu = page.getByRole('listbox', { name: label, exact: true })
        await expect(menu).toBeVisible()
        const box = await menu.boundingBox()
        const anchor = await trigger.boundingBox()
        assert.ok(box && anchor && box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= 1000)
        assert.ok(box!.y >= anchor!.y + anchor!.height || box!.y + box!.height <= anchor!.y)
        await page.screenshot({ path: join(temporary, `expanded-${label === '用例类型' ? 'library' : 'review'}-${width}.png`), fullPage: true })
        await menu.press('End'); await menu.press('Enter')
        await expect(trigger).toBeFocused()
        await trigger.press('ArrowDown'); await page.getByRole('listbox').press('Escape')
        await expect(trigger).toBeFocused()
        await trigger.click()
        await page.getByRole('heading', { name: '审查工作区', exact: true }).click()
        await expect(menu).toHaveCount(0)
      }
      const bounds = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth, valid: [...document.querySelectorAll('.planning-case-filters > *, .planning-review-workspace, .planning-review-case')].every(element => { const box = element.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth }) , overlap: [...document.querySelectorAll('.planning-review-case')].some(element => { const [details, button] = [...element.children].map(child => child.getBoundingClientRect()); return details.right > button.left }) }))
      assert.deepEqual(bounds, { overflow: false, valid: true, overlap: false }, JSON.stringify({ width, ...bounds }))
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.reload({ waitUntil: 'networkidle' })
    await expect(review).toContainText('已选 25 条')
    await expect(review.getByLabel('审查范围理由')).toHaveValue('仅本次审查范围')
    await review.getByRole('button', { name: '审查所选用例', exact: true }).click()
    await expect(review.getByRole('button', { name: '进入执行', exact: true })).toBeVisible()
    assert.deepEqual(posts.at(-1)?.body.caseIds, current.draft!.cases.map(item => item.id))
    const fingerprint = current.draft!.definitionFingerprint
    current.draft!.definitionFingerprint = 'changed'
    await update()
    await expect(review.getByRole('button', { name: '进入执行', exact: true })).toHaveCount(0)
    current.draft!.definitionFingerprint = fingerprint
    await update()
    await expect(review.getByRole('button', { name: '进入执行', exact: true })).toBeVisible()
    rejectProceed = true
    await review.getByRole('button', { name: '进入执行', exact: true }).click()
    await expect(review.getByRole('alert')).toHaveText('范围提交失败')
    assert.deepEqual(posts.at(-1)?.body, { caseIds: current.draft!.cases.map(item => item.id), reason: '仅本次审查范围' })
    rejectProceed = false
    await review.getByRole('button', { name: '进入执行', exact: true }).click()
    await expect(review.getByRole('alert')).toHaveCount(0)
    await expect(review).toBeVisible()
    await review.getByLabel('审查范围理由').fill('修改理由')
    await expect(review.getByRole('region', { name: '所选范围审查结果', exact: true })).toHaveCount(0)
    await expect(review.getByRole('button', { name: '进入执行', exact: true })).toHaveCount(0)
    await review.getByLabel('审查范围理由').fill('仅本次审查范围')
    const selectedAssessment = current.draft!.customReview!.assessment!
    selectedAssessment.status = 'rejected'
    selectedAssessment.caseIssues = [{ caseId: 'TC-25', message: '补充断言' }]
    selectedAssessment.caseReviews = current.draft!.cases.map(item => ({ caseId: item.id, status: item.id === 'TC-25' ? 'rejected' : 'qualified' }))
    await update()
    await review.getByRole('searchbox', { name: '搜索审查用例' }).fill('TC-1')
    await review.getByRole('button', { name: '定位用例 TC-25', exact: true }).click()
    await expect(review.locator('#planning-review-case-TC-25 summary')).toBeFocused()
    await expect(review.getByRole('searchbox', { name: '搜索审查用例' })).toHaveValue('')
    await expect(review.getByRole('button', { name: '进入执行', exact: true })).toHaveCount(0)
    await review.getByRole('searchbox', { name: '搜索审查用例' }).fill('TC-1')
    await review.locator('#planning-review-case-TC-1 > details > summary').click()
    await review.getByRole('button', { name: '编辑 TC-1', exact: true }).click()
    const edit = review.getByRole('form', { name: '编辑用例 TC-1', exact: true })
    await edit.getByLabel('标题', { exact: true }).fill('编辑后的用例')
    await edit.getByRole('button', { name: '保存', exact: true }).click()
    await expect(edit).toHaveCount(0)
    await expect(review).toContainText('已选 25 条')
    await review.getByRole('button', { name: '优化 TC-1', exact: true }).click()
    const optimize = review.getByRole('form', { name: '优化用例 TC-1', exact: true })
    await optimize.getByLabel('优化理由').fill('补充精确断言')
    await optimize.getByRole('button', { name: '优化此用例', exact: true }).click()
    await expect(optimize).toHaveCount(0)
    await page.reload({ waitUntil: 'networkidle' })
    await expect(review).toContainText('已选 25 条')
    await expect(review.getByLabel('审查范围理由')).toHaveValue('仅本次审查范围')
    await review.locator('#planning-review-case-TC-1 > details > summary').click()
    await review.getByRole('button', { name: '审查此用例 TC-1', exact: true }).click()
    await expect(review.locator('[aria-label="历史范围审查结果"]')).toBeVisible()
    await expect(review).toContainText('已选 25 条')
    await review.getByRole('button', { name: '清空审查工作区', exact: true }).click()
    await page.reload({ waitUntil: 'networkidle' })
    await expect(review).toContainText('已选 0 条')
    await library.getByRole('checkbox', { name: '选择 TC-1', exact: true }).check()
    await review.getByRole('button', { name: '移出审查 TC-1', exact: true }).click()
    await expect(library.getByRole('checkbox', { name: '选择 TC-1', exact: true })).not.toBeChecked()
    await library.getByRole('checkbox', { name: '选择 TC-1', exact: true }).check()
    const ownerOne = structuredClone(current)
    current.ownerId = 8
    current.draft!.customReview = undefined
    await update()
    await expect(review).toContainText('已选 0 条')
    current = ownerOne
    await update()
    await expect(review).toContainText('已选 1 条')
    const savedCases = structuredClone(current.draft!.cases)
    current.draft!.cases = savedCases.filter(item => item.id !== 'TC-1')
    await update()
    await expect(review).toContainText('已选 0 条')
    current.draft!.cases = savedCases
    await update()
    await expect(library.getByRole('checkbox', { name: '选择 TC-1', exact: true })).not.toBeChecked()
    await library.getByRole('checkbox', { name: '选择 TC-1', exact: true }).check()
    const originalDraft = structuredClone(current.draft!)
    current.status = 'running'; current.draft = undefined
    current.events.push({ at: '', kind: 'info', text: 'planning:generation:fresh' })
    await update()
    await expect(review).toContainText('已选 0 条')
    await page.reload({ waitUntil: 'networkidle' })
    await expect(review).toContainText('已选 0 条')
    current.status = 'draft'; current.draft = { ...originalDraft, customReview: undefined }
    await update()
    await expect(library.getByRole('checkbox', { name: '选择 TC-1', exact: true })).not.toBeChecked()
    assert.equal(await page.locator('[id]').evaluateAll(elements => new Set(elements.map(element => element.id)).size === elements.length), true)
    assert.deepEqual(errors, [])
    if (process.env.KEEP_UI_SCREENSHOTS === '1') context.diagnostic(`Screenshots: ${temporary}`)
  } finally {
    await browser?.close()
    await server.close()
    if (process.env.KEEP_UI_SCREENSHOTS !== '1') rmSync(temporary, { recursive: true, force: true })
  }
})