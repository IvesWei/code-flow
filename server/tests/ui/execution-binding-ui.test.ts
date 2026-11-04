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
import type { CodingTask } from '../../../shared/task.js'
import type { PlaywrightExecutionBinding } from '../../../shared/test-execution.js'
import { createExecutionPlan } from '../../../shared/test-policy.js'
import { executionEnvironment } from '../../execution/execution-environment.js'
import { taskSummary } from '../../tasks/task-summary.js'
import { canEditExecutionBinding, ExecutionBindingEditor } from '../../../src/features/testing/execution/ExecutionBindingEditor.js'
import { SelfTestResults } from '../../../src/features/testing/execution/SelfTestResults.js'

function fixture(): CodingTask {
  const now = new Date().toISOString()
  const task: CodingTask = {
    id: 'binding-ui', repository: 'https://github.com/example/demo', instruction: 'Verify binding', prdName: 'prd.md', designNames: [],
    status: 'REVIEW', createdAt: now, updatedAt: now, entries: [], checks: [],
    acceptanceBaseline: [{ id: 'REQ-1', source: 'PRD', criterion: 'Saved', required: true, scenarios: ['normal'] }],
    acceptanceAssessment: { status: 'qualified', inputFingerprint: 'review-fingerprint', checkedAt: now, issues: [], coveredIds: ['REQ-1'], missingIds: [] },
    selfTests: [{ id: 'TC-1', title: 'Save', source: 'PRD', steps: 'Save', expected: 'Saved', assertions: ['Saved', 'Visible'], testFile: 'tests/save.spec.ts', status: 'pending', requirementIds: ['REQ-1'] }],
  }
  task.testExecutionPlan = createExecutionPlan(task.acceptanceBaseline!, task.selfTests!)
  return task
}

test('binding entry is execution-only and requires idle current reviewed scope', () => {
  const task = fixture()
  const html = renderToStaticMarkup(createElement(SelfTestResults, { task, onAccept() {}, accepting: false, onStart() {}, starting: false, previewUrl: '', onPreviewUrlChange() {} }))
  const boundary = html.indexOf('aria-label="用例执行"')
  assert.doesNotMatch(html.slice(0, boundary), /绑定可信 Playwright/)
  assert.match(html.slice(boundary), /绑定可信 Playwright/)
  for (const status of ['REVIEW', 'SUCCESS', 'ACCEPTED'] as const) {
    task.status = status
    assert.equal(canEditExecutionBinding(task, 'TC-1'), true)
  }
  task.status = 'TEST_EXECUTION'
  assert.equal(canEditExecutionBinding(task, 'TC-1'), false)
  task.status = 'REVIEW'; task.modelInTurn = true
  assert.equal(canEditExecutionBinding(task, 'TC-1'), false)
  task.modelInTurn = false; task.acceptanceAssessment!.status = 'rejected'
  assert.equal(canEditExecutionBinding(task, 'TC-1'), false)
  task.acceptanceSelection = { mode: 'custom', caseIds: ['TC-1'], reason: 'Smoke', confirmedAt: task.createdAt }
  task.executionAssessment = { ...task.acceptanceAssessment!, readiness: 'ready', caseIds: ['TC-1'] }
  assert.equal(canEditExecutionBinding(task, 'TC-1'), true)
  assert.equal(canEditExecutionBinding(task, 'TC-2'), false)
  task.acceptanceSelection.confirmedAt = new Date(Date.parse(task.createdAt) + 1000).toISOString()
  assert.equal(canEditExecutionBinding(task, 'TC-1'), false)
  task.acceptanceSelection.confirmedAt = task.createdAt; task.executionAssessment.readiness = 'blocked'
  assert.equal(canEditExecutionBinding(task, 'TC-1'), false)
})

test('editor initially loads without approving or executing anything', () => {
  const html = renderToStaticMarkup(createElement(ExecutionBindingEditor, { taskId: 'task', caseId: 'TC-1', onClose() {} }))
  assert.match(html, /aria-busy="true"/)
  assert.match(html, /role="status"/)
  assert.match(html, /已人工审阅且可信的测试脚本/)
  assert.doesNotMatch(html, /type="submit"|checked=""/)
})

test('mocked binding UI requires human confirmation, preserves drafts and fits mobile forms', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'codeflow-binding-ui-'))
  const server = await createServer({ configFile: false, envDir: false, cacheDir: join(temporary, '.vite'), plugins: [react()], server: { host: '127.0.0.1', port: 0, watch: null } })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await server.listen()
    const address = server.httpServer?.address()
    if (!address || typeof address === 'string') throw new Error('Missing isolated UI port')
    browser = await chromium.launch({ channel: 'chrome', headless: true, env: executionEnvironment() })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    const task = fixture()
    task.selfTests![0].title = '人工审阅可信测试脚本并核对所有断言的长中文用例标题'.repeat(3)
    const assertions = [{ id: 'TC-1:A002', definition: '保存后的结果与输入一致'.repeat(12) }, { id: 'TC-1:A001', definition: '页面显示完整结果' }]
    const existing: PlaywrightExecutionBinding = {
      version: 1, caseFingerprint: 'case', designFingerprint: 'review', testSourceFingerprint: 'source',
      testFile: 'tests/save.spec.ts', testTitle: 'Suite > saves data', project: 'chromium', assertionIds: assertions.map(item => item.id),
      approvedBy: 'human', approvedAt: task.createdAt, reviewedAt: task.createdAt,
    }
    let rejectGet = true
    let rejectPost = true
    let submitted: Record<string, unknown>[] = []
    let detailReads = 0
    let releaseGet: (() => void) | undefined
    const heldGet = new Promise<void>(resolve => { releaseGet = resolve })
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url())
      let payload: unknown = {}
      let status = 200
      if (url.pathname.includes('/execution-bindings/')) {
        if (route.request().method() === 'POST') {
          const body = route.request().postDataJSON()
          submitted.push(body)
          if (rejectPost) { status = 409; payload = { error: 'Design review no longer matches current inputs and workspace' } }
          else {
            task.selfTests![0].executionBinding = { ...existing, ...body }
            task.selfTests![0].output = 'Saved binding reload'
            payload = { caseId: 'TC-1', binding: task.selfTests![0].executionBinding }
          }
        } else if (rejectGet) { status = 409; payload = { error: 'Execution binding requires a stable idle task' } }
        else {
          await heldGet
          payload = { caseId: 'TC-1', testCase: task.selfTests![0], manifest: { assertions }, binding: existing }
        }
      } else if (url.pathname === '/api/auth/status') payload = { configured: true, authenticated: true, login: 'fixture' }
      else if (url.pathname === '/api/copilot/models') payload = { defaultModelId: 'auto', models: [] }
      else if (url.pathname === '/api/tasks') payload = { items: [taskSummary(task)], busy: false }
      else if (url.pathname.endsWith('/events')) payload = { items: [] }
      else if (url.pathname === `/api/tasks/${task.id}`) { detailReads++; payload = task }
      else throw new Error(`Unexpected mock API request: ${route.request().method()} ${url.pathname}`)
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) })
    })
    await page.goto(`http://127.0.0.1:${address.port}/?task=${task.id}`, { waitUntil: 'networkidle' })
    const generation = page.getByRole('region', { name: '生成用例', exact: true })
    const execution = page.getByRole('region', { name: '用例执行', exact: true })
    const row = execution.locator('.execution-row')
    await row.locator(':scope > summary').click()
    const trigger = execution.getByRole('button', { name: '绑定可信 Playwright TC-1', exact: true })
    await trigger.click()
    const editor = execution.getByRole('region', { name: '可信 Playwright 绑定 TC-1', exact: true })
    await editor.getByRole('alert').filter({ hasText: 'stable idle task' }).waitFor()
    assert.equal(await editor.getByRole('button', { name: '保存可信绑定' }).count(), 0)
    await editor.getByRole('button', { name: '关闭绑定编辑' }).click()
    assert.equal(await trigger.evaluate(element => element === document.activeElement), true)
    rejectGet = false
    await trigger.click()
    await editor.getByRole('status').filter({ hasText: '正在读取断言清单' }).waitFor()
    assert.equal(submitted.length, 0)
    releaseGet!()
    const file = editor.getByRole('textbox', { name: '测试文件', exact: true })
    const title = editor.getByRole('textbox', { name: '完整测试标题', exact: true })
    const project = editor.getByRole('textbox', { name: 'Playwright 项目（可留空）', exact: true })
    const confirm = editor.getByRole('checkbox')
    const save = editor.getByRole('button', { name: '保存可信绑定', exact: true })
    await title.waitFor()
    assert.equal(await file.inputValue(), existing.testFile)
    assert.equal(await title.inputValue(), existing.testTitle)
    assert.equal(await project.inputValue(), existing.project)
    assert.equal(await confirm.isChecked(), false)
    assert.equal(await save.isDisabled(), true)
    assert.deepEqual(await editor.locator('ol code').allTextContents(), assertions.map(item => item.id))
    for (const assertion of assertions) assert.ok((await editor.innerText()).includes(assertion.definition))
    await title.fill('Manually reviewed > saves and displays')
    await project.fill('')
    await confirm.focus()
    await confirm.press('Space')
    assert.equal(await save.isEnabled(), true)
    await file.fill('tests/reviewed.spec.ts')
    assert.equal(await confirm.isChecked(), false)
    assert.equal(await save.isDisabled(), true)
    await confirm.check()
    await save.click()
    await editor.getByRole('alert').filter({ hasText: 'Design review no longer matches' }).waitFor()
    assert.equal(await confirm.isChecked(), false)
    assert.equal(await title.inputValue(), 'Manually reviewed > saves and displays')
    assert.equal(await save.isDisabled(), true)
    rejectPost = false
    const readsBeforeSave = detailReads
    await confirm.check()
    await save.click()
    await editor.getByRole('status').filter({ hasText: '可信绑定已保存' }).waitFor()
    await row.getByText('Saved binding reload', { exact: true }).waitFor({ state: 'attached' })
    assert.ok(detailReads > readsBeforeSave)
    assert.equal(submitted.length, 2)
    assert.deepEqual(submitted[1], { testFile: 'tests/reviewed.spec.ts', testTitle: 'Manually reviewed > saves and displays', project: '', assertionIds: ['TC-1:A002', 'TC-1:A001'], confirm: true })
    assert.equal(await confirm.isChecked(), false)
    assert.equal(await generation.getByRole('button', { name: /可信.*绑定|绑定可信/ }).count(), 0)
    await generation.getByRole('radio', { name: '自定义必验', exact: true }).check()
    await generation.getByRole('textbox', { name: '范围调整与风险理由' }).fill('Unsaved local scope reason')
    await editor.getByRole('button', { name: '关闭绑定编辑' }).click()
    await execution.getByRole('button', { name: '审阅可信绑定 TC-1', exact: true }).click()
    assert.equal(await generation.getByRole('textbox', { name: '范围调整与风险理由' }).inputValue(), 'Unsaved local scope reason')
    await file.waitFor()
    assert.equal(await confirm.isChecked(), false)
    await title.fill('Very long explicit reviewed test title '.repeat(30))
    for (const width of [1440, 1367, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 })
      await editor.scrollIntoViewIfNeeded()
      const bounds = await editor.evaluate(element => {
        const outer = element.getBoundingClientRect()
        const controls = [...element.querySelectorAll('input, button, fieldset, label, li')].map(control => {
          const rect = control.getBoundingClientRect()
          return { left: rect.left, right: rect.right, width: rect.width }
        })
        return { left: outer.left, right: outer.right, controls, overflow: document.documentElement.scrollWidth > innerWidth }
      })
      assert.equal(bounds.overflow, false, `horizontal overflow at ${width}`)
      assert.ok(bounds.left >= 0 && bounds.right <= width, `editor outside viewport at ${width}`)
      assert.ok(bounds.controls.every(control => control.width > 0 && control.left >= bounds.left - 1 && control.right <= bounds.right + 1), `control outside editor at ${width}`)
      await page.screenshot({ path: join(temporary, `binding-${width}.png`), fullPage: true })
    }
    assert.equal(submitted.length, 2, 'editing and changing draft scope must not autoapprove')
    console.log(`Binding UI screenshots: ${temporary}`)
  } finally {
    await browser?.close()
    await server.close()
    rmSync(join(temporary, '.vite'), { recursive: true, force: true })
  }
})