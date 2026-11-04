import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright-core'
import { executionEnvironment } from '../../execution/execution-environment.js'
import type { CodingTask } from '../../../shared/task.js'
import { createExecutionPlan } from '../../../shared/test-policy.js'
import { taskSummary } from '../../tasks/task-summary.js'

test('split generation and execution results preserve saved scope, independent controls and responsive dropdowns', async () => {
  const screenshots = mkdtempSync(join(tmpdir(), 'codeflow-policy-ui-'))
  const server = await createServer({ configFile: false, envDir: false, cacheDir: join(screenshots, '.vite'), plugins: [react()], server: { host: '127.0.0.1', port: 0, watch: null } })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await server.listen()
    const address = server.httpServer?.address()
    if (!address || typeof address === 'string') throw new Error('Missing UI test port')
    browser = await chromium.launch({ channel: 'chrome', headless: true, env: executionEnvironment() })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    const generation = page.getByRole('region', { name: '生成用例', exact: true })
    const execution = page.getByRole('region', { name: '用例执行', exact: true })
    const generationRows = generation.locator('.test-case-row')
    const executionRows = execution.locator('.execution-row')
    const chooseFilter = async (label: string, option: string) => {
      const section = /执行/.test(label) ? execution : generation
      await section.getByRole('combobox', { name: label, exact: true }).click()
      await page.getByRole('option', { name: option, exact: true }).click()
      assert.equal(await page.getByRole('listbox').count(), 0)
      assert.equal(await section.getByRole('combobox', { name: label, exact: true }).getAttribute('aria-expanded'), 'false')
    }
    const now = new Date().toISOString()
    const common = { source: 'PRD', steps: 'Save then query', expected: 'Data matches', scenario: 'normal', preconditions: 'Service ready', testData: 'Isolated data', assertions: ['Data matches'], cleanup: 'Delete data' }
    const task: CodingTask = { id: 'policy-ui', repository: 'https://github.com/example/demo', instruction: 'Verify policy', prdName: 'prd.md', designNames: [], status: 'SUCCESS', createdAt: now, updatedAt: now, workspace: 'preview', copilotSession: { id: 'preview', directory: 'preview' }, entries: [], checks: [], acceptanceBaseline: [{ id: 'REQ-001', source: 'PRD', criterion: 'Data matches', required: true, scenarios: ['normal'] }, { id: 'REQ-002', source: 'Recommendation', criterion: 'Explore capacity', required: false, scenarios: ['normal'] }], acceptanceAssessment: { status: 'qualified', checkedAt: now, issues: [], coveredIds: ['REQ-001', 'REQ-002'], missingIds: [] }, selfTests: [{ ...common, scenario: 'normal', id: 'TC-01', title: 'Save data', status: 'passed', requirementIds: ['REQ-001'] }, { ...common, scenario: 'normal', id: 'TC-02', title: 'Capacity exploration', status: 'pending', requirementIds: ['REQ-002'], classification: { testType: 'performance', tags: ['load'], priority: 'P2', riskReason: 'Optional exploration', executionPolicy: 'on_demand' } }] }
    const other: CodingTask = { ...task, id: 'other-ui', repository: 'https://github.com/example/other', selfTests: task.selfTests!.map((item) => ({ ...item })) }
    let submitted: unknown
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url())
      let payload: unknown = {}
      if (url.pathname === '/api/auth/status') payload = { configured: true, authenticated: true, login: 'preview' }
      else if (url.pathname === '/api/models') payload = { defaultModelId: 'auto', models: [{ id: 'auto', name: 'Auto', vision: true }] }
      else if (url.pathname === '/api/tasks') payload = { items: [taskSummary(task), taskSummary(other)], busy: false }
      else if (url.pathname.endsWith('/events')) payload = { items: url.pathname.includes('/policy-ui/') ? task.entries : other.entries }
      else if (url.pathname.endsWith('/self-test')) {
        submitted = route.request().postDataJSON()
        const body = submitted as { intent: string; selectedCaseIds?: string[]; acceptanceSelection?: null | { mode: 'custom'; caseIds: string[]; reason: string } }
        if (body.intent === 'repair') {
          await route.fulfill({ contentType: 'application/json', body: JSON.stringify(task) })
          return
        }
        if (body.acceptanceSelection) {
          task.acceptanceSelection = { ...body.acceptanceSelection, confirmedAt: now }
          task.executionAssessment = { status: 'rejected', readiness: 'ready', checkedAt: now, issues: [], coveredIds: [], missingIds: [], caseIds: body.acceptanceSelection.caseIds, findings: [{ category: 'quality', code: 'detail', caseIds: body.acceptanceSelection.caseIds, message: '断言细节待补充' }, { category: 'coverage', code: 'scope-gap', caseIds: [], message: '本次范围仍有需求缺口' }] }
        } else if (body.acceptanceSelection === null) { delete task.acceptanceSelection; delete task.executionAssessment }
        task.testExecutionPlan = createExecutionPlan(task.acceptanceBaseline!, task.selfTests!, body.selectedCaseIds || [], task.acceptanceSelection)
        payload = task
      }
      else if (url.pathname === '/api/tasks/policy-ui') payload = task
      else if (url.pathname === '/api/tasks/other-ui') payload = other
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) })
    })
    await page.goto(`http://127.0.0.1:${address.port}/?task=policy-ui`, { waitUntil: 'networkidle' })
    await generation.getByRole('heading', { name: '生成用例', exact: true }).waitFor()
    await execution.getByRole('heading', { name: '用例执行', exact: true }).waitFor()
    assert.equal(await generation.evaluate(element => element.nextElementSibling?.getAttribute('aria-label')), '用例执行')
    assert.equal(await page.getByRole('tablist', { name: '用例视图' }).count(), 0)
    assert.deepEqual(await generationRows.locator('.case-status').allTextContents(), ['审查未完成', '审查未完成'])
    assert.equal(await generationRows.locator('.case-passed').count(), 0)
    assert.equal(await execution.getByText('尚无已提交的执行计划', { exact: true }).count(), 1)
    await generation.getByRole('combobox', { name: '用例状态', exact: true }).click()
    assert.deepEqual(await page.getByRole('option').allTextContents(), ['全部状态', '待审查', '审查中', '审查通过', '存在质量提示', '审查不通过', '审查未完成'])
    await page.getByRole('listbox').press('Escape')
    task.entries = [{ at: now, kind: 'info', stage: 'TEST_EXECUTION', text: 'Execution started' }]
    await page.reload()
    await execution.getByRole('heading', { name: '用例执行', exact: true }).waitFor()
    assert.deepEqual(await generationRows.locator('.case-status').allTextContents(), ['审查未完成', '审查未完成'])
    assert.equal(await executionRows.count(), 1)
    assert.equal(await executionRows.locator('.case-status').innerText(), '通过')
    const checkbox = generation.getByRole('checkbox', { name: 'TC-02 · Capacity exploration' })
    const button = execution.getByRole('button', { name: '执行选中补充项' })
    assert.equal(await button.isDisabled(), true)
    await checkbox.check()
    assert.equal(await button.isEnabled(), true)
    await Promise.all([page.waitForResponse((response) => response.url().endsWith('/self-test')), button.click()])
    assert.deepEqual((submitted as { selectedCaseIds: string[] }).selectedCaseIds, ['TC-02'])
    assert.equal((submitted as { intent: string }).intent, 'execute')
    assert.equal((submitted as { acceptanceSelection: null }).acceptanceSelection, null)
    assert.equal(await checkbox.isChecked(), false)
    await Promise.all([page.waitForResponse((response) => response.url().endsWith('/self-test')), page.getByRole('button', { name: '修正用例设计' }).click()])
    assert.equal((submitted as { intent: string }).intent, 'repair')
    assert.equal('acceptanceSelection' in (submitted as object), false)

    task.acceptanceBaseline!.push({ id: 'REQ-003', feature: 'Orders', source: 'PRD', criterion: 'Save order', required: false, scenarios: ['normal'] }, { id: 'REQ-004', feature: 'Payments', source: 'PRD', criterion: 'Pay order', required: false, scenarios: ['normal'] })
    task.selfTests!.push(...Array.from({ length: 120 }, (_, index) => ({ ...common, scenario: 'normal' as const, id: `TC-${String(index + 3).padStart(3, '0')}`, title: `Order check ${index + 3}`, status: index === 119 ? 'invalid' as const : index % 3 === 0 ? 'failed' as const : 'pending' as const, requirementIds: index < 2 ? ['REQ-003', 'REQ-004'] : ['REQ-003'], classification: { testType: index % 2 ? 'performance' as const : 'functional' as const, priority: 'P1' as const, executionPolicy: 'on_demand' as const, tags: ['order'], riskReason: 'Optional order checks' } })))
    task.acceptanceAssessment = { status: 'rejected', checkedAt: now, issues: ['Default coverage missing'], coveredIds: [], missingIds: ['REQ-001'], caseReviews: [{ caseId: 'TC-01', status: 'qualified' }, { caseId: 'TC-003', status: 'reviewing' }, { caseId: 'TC-004', status: 'warning' }] }
    delete task.testExecutionPlan
    task.entries = [{ at: now, kind: 'info', stage: 'SELF_TEST', text: 'Review started' }]
    await page.reload()
    const execute = execution.getByRole('button', { name: '审查并执行所选用例', exact: true })
    await execute.waitFor()
    await chooseFilter('用例状态', '审查通过')
    assert.equal(await generationRows.count(), 1)
    assert.equal(await generationRows.locator('.case-status').innerText(), '审查通过')
    await chooseFilter('用例状态', '审查未完成')
    assert.equal(await generationRows.count(), 10)
    assert.equal(await generationRows.locator('.case-review-qualified').count(), 0)
    await chooseFilter('用例状态', '全部状态')
    assert.equal(await execute.isDisabled(), true)
    assert.equal(await generationRows.count(), 10)
    await generation.getByRole('radio', { name: '自定义必验', exact: true }).check()
    const confirm = generation.getByRole('checkbox', { name: '确认本次范围并承担未选需求风险' })
    const reason = generation.getByRole('textbox', { name: '范围调整与风险理由' })
    await reason.fill('  Order smoke only  ')
    assert.equal(await confirm.isDisabled(), true)
    const search = generation.getByRole('searchbox', { name: '搜索用例或需求' })
    await search.fill('Payments')
    assert.equal(await generationRows.count(), 2)
    await search.fill('TC-004')
    assert.equal(await generationRows.count(), 1)
    await generation.getByRole('checkbox', { name: '选择功能组 Orders' }).check()
    await search.fill('Payments')
    assert.equal(await generation.getByRole('checkbox', { name: 'TC-003 · Order check 3', exact: true }).isChecked(), false)
    assert.equal(await generation.getByRole('checkbox', { name: 'TC-004 · Order check 4', exact: true }).isChecked(), true)
    await generation.getByRole('checkbox', { name: 'TC-003 · Order check 3', exact: true }).check()
    await search.fill('')
    await generation.getByRole('checkbox', { name: 'TC-01 · Save data', exact: true }).check()
    await generation.getByRole('button', { name: '下一页', exact: true }).click()
    await generation.getByRole('checkbox', { name: 'TC-011 · Order check 11', exact: true }).check()
    await chooseFilter('用例类别', '性能效率')
    assert.equal(await generation.getByRole('checkbox', { name: 'TC-004 · Order check 4', exact: true }).isChecked(), true)
    await chooseFilter('用例类别', '未分类（旧用例）')
    assert.equal(await generationRows.count(), 1)
    await chooseFilter('用例类别', '全部类别')
    await chooseFilter('每页用例数', '20')
    assert.equal(await generationRows.count(), 20)
    await search.fill('TC-122')
    assert.equal(await generation.getByRole('checkbox', { name: 'TC-122 · Order check 122', exact: true }).isDisabled(), true)
    await search.fill('not-present')
    assert.equal(await page.getByText('没有匹配用例', { exact: true }).count(), 1)
    await search.fill('')
    await confirm.check()
    assert.equal(await execute.isEnabled(), true)
    await reason.fill('  Scoped order verification  ')
    assert.equal(await confirm.isChecked(), false)
    assert.equal(await execute.isDisabled(), true)
    await confirm.check()
    await Promise.all([page.waitForResponse((response) => response.url().endsWith('/self-test')), execute.click()])
    const customBody = submitted as { intent: string; acceptanceSelection: { mode: string; caseIds: string[]; reason: string }; allowNewSession: boolean }
    assert.equal(customBody.intent, 'execute')
    assert.equal(customBody.allowNewSession, undefined)
    assert.equal(customBody.acceptanceSelection.mode, 'custom')
    assert.equal(customBody.acceptanceSelection.reason, 'Scoped order verification')
    assert.deepEqual([...customBody.acceptanceSelection.caseIds].sort(), ['TC-004', 'TC-003', 'TC-01', 'TC-011'].sort())
    await generation.getByRole('heading', { name: '本次范围 · 设计审查完成', exact: true }).waitFor()
    assert.equal(await generation.locator('.design-review-advisory').first().getAttribute('open'), null)
    await generation.locator('.design-review-advisory > summary').first().click()
    assert.equal(await page.getByText(/已提交范围核对：可执行|执行就绪状态单独核对/).count(), 0)
    assert.equal(await page.getByText(/拒绝执行/).count(), 0)
    assert.equal(await page.getByText('本次范围仍有需求缺口', { exact: true }).count(), 1)
    await execution.locator('.execution-scope > summary').click()
    assert.equal(await execution.locator('.execution-scope').getAttribute('open'), '')
    const savedIds = task.testExecutionPlan!.cases.filter(entry => entry.selected).map(entry => entry.caseId)
    assert.equal(await execution.locator('.execution-scope > p').first().innerText(), savedIds.join(' / '))
    assert.equal(await execution.getByLabel('已提交执行统计', { exact: true }).getByText('已选中 4 条', { exact: true }).count(), 1)
    assert.equal(await executionRows.count(), 4)
    assert.deepEqual(await executionRows.locator('summary > strong').allTextContents(), ['TC-01 · Save data', 'TC-003 · Order check 3', 'TC-004 · Order check 4', 'TC-011 · Order check 11'])
    assert.equal(await executionRows.filter({ hasText: 'TC-02 · Capacity exploration' }).count(), 0)
    assert.equal(await generationRows.count(), 20)
    assert.equal(await generationRows.locator('.case-status').filter({ hasText: '未纳入本次范围' }).count(), 16)
    await page.screenshot({ path: join(screenshots, 'custom-ready-quality-warning.png'), fullPage: true })
    assert.equal(await page.getByText(/未通过，拒绝默认执行/).count(), 1)
    assert.equal(await execute.isEnabled(), true)
    await execution.getByRole('textbox', { name: '本机预览地址', exact: true }).fill('http://127.0.0.1:4173')
    await Promise.all([page.waitForResponse((response) => response.url().endsWith('/self-test')), execution.getByRole('button', { name: '启动浏览器自动化', exact: true }).click()])
    assert.equal((submitted as { intent: string }).intent, 'execute')
    assert.deepEqual((submitted as { acceptanceSelection: unknown }).acceptanceSelection, customBody.acceptanceSelection)

    const submittedRows = await executionRows.locator(':scope > summary').allTextContents()
    const submittedScope = await execution.locator('.execution-scope').innerText()
    await generation.getByRole('checkbox', { name: 'TC-01 · Save data', exact: true }).uncheck()
    await generation.getByRole('checkbox', { name: 'TC-02 · Capacity exploration', exact: true }).check()
    await reason.fill('Unsubmitted draft must not change saved execution')
    assert.equal(await confirm.isChecked(), false)
    assert.equal(await execute.isDisabled(), true)
    assert.deepEqual(await executionRows.locator(':scope > summary').allTextContents(), submittedRows)
    assert.equal(await execution.locator('.execution-scope').innerText(), submittedScope)
    assert.equal(await executionRows.filter({ hasText: 'TC-02 · Capacity exploration' }).count(), 0)
    assert.equal(await generationRows.count(), 20)

    await page.locator('.task-nav-item').filter({ hasText: 'other' }).click()
    assert.equal(await generation.getByRole('radio', { name: '默认质量门禁', exact: true }).isChecked(), true)
    await generation.getByRole('radio', { name: '自定义必验', exact: true }).check()
    assert.equal(await reason.inputValue(), '')
    assert.equal(await execute.isDisabled(), true)
    assert.equal(await generation.getByRole('checkbox', { name: 'TC-01 · Save data', exact: true }).isChecked(), false)
    await page.locator('.task-nav-item').filter({ hasText: 'demo' }).click()
    assert.equal(await generation.getByRole('checkbox', { name: 'TC-01 · Save data', exact: true }).isChecked(), true)
    await generation.getByRole('radio', { name: '默认质量门禁', exact: true }).check()
    assert.equal(await execute.isDisabled(), true)
    task.acceptanceAssessment.status = 'qualified'
    task.acceptanceAssessment.issues = []
    task.acceptanceAssessment.caseReviews = [{ caseId: 'TC-01', status: 'warning' }]
    task.acceptanceBaseline![0].feature = '订单保存与支付结果核对：跨功能需求映射、异常场景与历史未分类用例的完整验证'
    await page.reload()
    await generation.getByRole('radio', { name: '默认质量门禁', exact: true }).check()
    await Promise.all([page.waitForResponse((response) => response.url().endsWith('/self-test')), execute.click()])
    assert.equal((submitted as { intent: string }).intent, 'execute')
    assert.equal((submitted as { acceptanceSelection: null }).acceptanceSelection, null)
    await generation.getByRole('radio', { name: '自定义必验', exact: true }).check()
    await generation.getByRole('checkbox', { name: 'TC-01 · Save data', exact: true }).check()
    await reason.fill('Mobile risk review')
    await confirm.check()
    await chooseFilter('用例类别', '未分类（旧用例）')
    await generation.getByRole('radio', { name: '默认质量门禁', exact: true }).check()
    for (const view of ['generation', 'execution'] as const) {
    const section = view === 'generation' ? generation : execution
    const categoryLabel = view === 'generation' ? '用例类别' : '执行类别'
    const statusLabel = view === 'generation' ? '用例状态' : '执行状态'
    const allStatuses = view === 'generation' ? '全部状态' : '全部执行状态'
    const filterSelector = view === 'generation' ? '.test-filters' : '.execution-filters'
    await chooseFilter(categoryLabel, view === 'generation' ? '未分类（旧用例）' : '未分类（旧用例 / 定义不可用）')
    for (const [name, width, height] of [['desktop', 1440, 1000], ['screenshot-width', 1367, 768], ['mobile', 390, 844], ['narrow', 320, 760]] as const) {
      await page.setViewportSize({ width, height })
      await section.getByRole('heading', { name: view === 'generation' ? '生成用例' : '用例执行', exact: true }).scrollIntoViewIfNeeded()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, name)
      assert.equal(await generation.getByRole('checkbox', { name: 'TC-01 · Save data', exact: true }).isVisible(), true)
      assert.equal(await section.locator(view === 'generation' ? '.test-case-details > summary' : '.execution-row > summary').evaluateAll((summaries) => summaries.every((summary) => {
        const bounds = [...summary.children].map((child) => child.getBoundingClientRect())
        return bounds.every((first, index) => bounds.slice(index + 1).every((second) => first.right <= second.left + 1 || second.right <= first.left + 1 || first.bottom <= second.top + 1 || second.bottom <= first.top + 1))
      })), true, `${name}: row labels do not overlap`)
      assert.equal(await execution.locator('.self-test-actions button').evaluateAll((buttons) => buttons.every((button) => button.scrollWidth <= button.clientWidth + 1)), true, `${name}: actions fit`)
      assert.equal(await generation.locator('.test-feature-group > summary').evaluateAll((summaries) => summaries.every((summary) => [...summary.children].every((child) => {
        const box = child.getBoundingClientRect(), parent = summary.getBoundingClientRect()
        return box.left >= parent.left && box.right <= parent.right && child.scrollWidth <= child.clientWidth + 1
      }))), true, `${view} ${name}: long Chinese group headings fit`)
      await page.screenshot({ path: join(screenshots, `${view}-closed-${name}.png`), fullPage: true })
      if (view === 'generation') {
        await chooseFilter('用例状态', '存在质量提示')
        assert.equal(await generation.getByRole('combobox', { name: '用例状态', exact: true }).innerText(), '存在质量提示')
        assert.equal(await generation.locator('.test-filters').evaluate((element) => [...element.children].every((child) => child.scrollWidth <= child.clientWidth + 1)), true)
        await page.screenshot({ path: join(screenshots, `planning-selected-warning-${name}.png`), fullPage: true })
        await chooseFilter('用例状态', '全部状态')
      }
      const category = section.getByRole('combobox', { name: categoryLabel, exact: true })
      await category.click()
      const listbox = page.getByRole('listbox', { name: categoryLabel, exact: true })
      assert.equal(await listbox.isVisible(), true)
      assert.equal(await listbox.evaluate((element) => {
        const box = element.getBoundingClientRect()
        return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight && getComputedStyle(element).position === 'fixed'
      }), true, `${name}: open menu fits viewport and escapes clipped panel`)
      assert.equal(await section.locator(filterSelector).evaluate((element) => [...element.children].every((child) => {
        const box = child.getBoundingClientRect(), parent = element.getBoundingClientRect()
        return box.left >= parent.left && box.right <= parent.right && child.scrollWidth <= child.clientWidth + 1
      })), true, `${name}: filters and long values fit container`)
      const screenshot = join(screenshots, `${view}-${name}.png`)
      await page.screenshot({ path: screenshot })
      assert.ok(statSync(screenshot).size > 1000)
      await listbox.press('Escape')
      assert.equal(await listbox.count(), 0)
      assert.equal(await category.evaluate((element) => document.activeElement === element), true)
      const status = section.getByRole('combobox', { name: statusLabel, exact: true })
      await status.click()
      const statusMenu = page.getByRole('listbox', { name: statusLabel, exact: true })
      const triggerBounds = await status.boundingBox()
      assert.ok(triggerBounds)
      assert.equal(await statusMenu.evaluate((element, trigger) => {
        const box = element.getBoundingClientRect()
        return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight && (box.bottom <= trigger.y + 1 || box.top >= trigger.y + trigger.height - 1)
      }, triggerBounds), true, `${view} ${name}: status menu fits without covering trigger`)
      await page.screenshot({ path: join(screenshots, `${view}-status-${name}.png`) })
      await statusMenu.press('End')
      await statusMenu.press('Enter')
      assert.equal(await status.innerText(), view === 'generation' ? '审查未完成' : '执行状态未记录')
      await chooseFilter(statusLabel, allStatuses)
      assert.equal(await section.locator(view === 'generation' ? '.test-case-row .case-status' : '.execution-row .case-status').innerText(), view === 'generation' ? '存在质量提示' : '通过')
      await category.press('ArrowDown')
      await listbox.press('Home')
      await listbox.press('ArrowDown')
      await listbox.press('ArrowDown')
      await listbox.press('Enter')
      assert.equal(await category.innerText(), view === 'generation' ? '性能效率' : '性能')
      assert.equal(await category.evaluate(element => document.activeElement === element), true)
      await category.click()
      await section.getByRole('searchbox').click()
      assert.equal(await listbox.count(), 0)
      await chooseFilter(categoryLabel, view === 'generation' ? '未分类（旧用例）' : '未分类（旧用例 / 定义不可用）')
    }
    }
    const category = generation.getByRole('combobox', { name: '用例类别', exact: true })
    await category.press('ArrowDown')
    const listbox = page.getByRole('listbox', { name: '用例类别', exact: true })
    await listbox.press('Home')
    await listbox.press('ArrowDown')
    await listbox.press('ArrowDown')
    await listbox.press('Enter')
    assert.equal(await category.innerText(), '性能效率')
    await category.click()
    await search.click()
    assert.equal(await listbox.count(), 0)
    assert.equal(await page.getByRole('tablist', { name: '用例视图' }).count(), 0)

    const selectedExecutionIds = task.selfTests!.filter(item => item.id !== 'TC-02' && item.status !== 'invalid').slice(0, 24).map(item => item.id).concat('TC-120')
    task.acceptanceSelection = { mode: 'custom', caseIds: selectedExecutionIds, reason: 'Saved multi-page execution', confirmedAt: now }
    task.testExecutionPlan = createExecutionPlan(task.acceptanceBaseline!, task.selfTests!, [], task.acceptanceSelection)
    task.entries = [{ at: now, kind: 'info', stage: 'TEST_EXECUTION', text: 'Saved execution completed' }]
    const evidenceCase = task.selfTests!.find(item => item.id === 'TC-120')!
    evidenceCase.output = 'Saved case output: data matches'
    evidenceCase.testFile = 'tests/order.spec.ts'
    task.automationRuns = [{ caseId: 'TC-120', status: 'passed', startedAt: now, finishedAt: now, output: 'Browser evidence: order verified', script: 'await expect(order).toBeVisible()', screenshot: 'isolated-order.png' }]
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.reload()
    await generation.getByRole('heading', { name: '生成用例', exact: true }).waitFor()
    await execution.getByRole('heading', { name: '用例执行', exact: true }).waitFor()
    await generation.getByRole('radio', { name: '默认质量门禁', exact: true }).check()
    const generationPagination = generation.locator('.test-pagination')
    const executionPagination = execution.locator('.execution-pagination')
    const executionSearch = execution.getByRole('searchbox', { name: '搜索执行用例', exact: true })
    assert.equal(await generationRows.count(), 10)
    assert.equal(await executionRows.count(), 10)
    assert.equal(await generationPagination.getByText('第 1 / 13 页', { exact: true }).count(), 1)
    assert.equal(await executionPagination.getByText('第 1 / 3 页', { exact: true }).count(), 1)
    await execution.getByRole('button', { name: '下一页执行用例', exact: true }).click()
    assert.equal(await generationPagination.getByText('第 1 / 13 页', { exact: true }).count(), 1)
    await generation.getByRole('button', { name: '下一页', exact: true }).click()
    assert.equal(await generationPagination.getByText('第 2 / 13 页', { exact: true }).count(), 1)
    assert.equal(await executionPagination.getByText('第 2 / 3 页', { exact: true }).count(), 1)
    await search.fill('TC-120')
    assert.equal(await generationRows.count(), 1)
    assert.equal(await executionPagination.getByText('第 2 / 3 页', { exact: true }).count(), 1)
    await executionSearch.fill('Save data')
    assert.equal(await executionRows.count(), 1)
    assert.equal(await search.inputValue(), 'TC-120')
    await chooseFilter('执行状态', '通过')
    await chooseFilter('用例状态', '存在质量提示')
    assert.equal(await generationRows.count(), 0)
    assert.equal(await executionRows.locator('.case-status').innerText(), '通过')
    assert.equal(await executionSearch.inputValue(), 'Save data')
    await search.fill('')
    assert.equal(await generationRows.locator('.case-status').innerText(), '存在质量提示')
    await executionSearch.fill('')
    await chooseFilter('执行状态', '执行失败（断言原因待核对）')
    assert.ok(await executionRows.count() > 0)
    assert.ok((await executionRows.locator('.case-status').allTextContents()).every(text => text === '执行失败（断言原因待核对）'))
    assert.equal(await generationRows.count(), 1)
    assert.equal(await generation.getByRole('combobox', { name: '用例状态', exact: true }).innerText(), '存在质量提示')
    await chooseFilter('执行状态', '全部执行状态')
    await chooseFilter('用例状态', '全部状态')
    await chooseFilter('每页执行用例数', '20')
    assert.equal(await executionRows.count(), 20)
    assert.equal(await generationRows.count(), 10)
    await chooseFilter('每页用例数', '20')
    assert.equal(await generationRows.count(), 20)
    assert.equal(await executionRows.count(), 20)
    await chooseFilter('每页用例数', '10')
    await chooseFilter('每页执行用例数', '10')

    await executionSearch.fill('TC-120')
    await chooseFilter('执行状态', '通过')
    await chooseFilter('执行类别', '性能')
    const evidence = executionRows.filter({ hasText: 'TC-120 · Order check 120' })
    await evidence.locator(':scope > summary').click()
    assert.equal(await evidence.getAttribute('open'), '')
    assert.equal(await evidence.getByText(`开始时间：${now}`, { exact: true }).count(), 1)
    assert.equal(await evidence.getByText(`结束时间：${now}`, { exact: true }).count(), 1)
    for (const [label, contents] of [
      ['预期结果', ['Data matches']],
      ['执行输出', ['Saved case output: data matches', 'Browser evidence: order verified']],
      ['执行脚本', ['await expect(order).toBeVisible()', '测试文件：tests/order.spec.ts']],
    ] as const) {
      const detail = evidence.locator('details').filter({ has: page.getByText(label, { exact: true }) })
      assert.equal(await detail.getAttribute('open'), null)
      await detail.locator(':scope > summary').click()
      assert.equal(await detail.getAttribute('open'), '')
      for (const text of contents) assert.equal(await detail.getByText(text, { exact: true }).isVisible(), true)
    }
    assert.equal(await evidence.getByRole('link', { name: '查看自动化任务 TC-120', exact: true }).getAttribute('href'), '/?task=policy-ui&automation=TC-120')
    assert.equal(await evidence.getByRole('link', { name: '执行截图 TC-120', exact: true }).getAttribute('href'), '/api/tasks/policy-ui/automation/TC-120/screenshot')
    await generation.getByRole('button', { name: '下一页', exact: true }).click()
    await chooseFilter('用例类别', '功能')
    await chooseFilter('用例状态', '存在质量提示')
    await generation.getByRole('checkbox', { name: '仅看阻断', exact: true }).check()
    await search.fill('not-present')
    assert.equal(await generationRows.count(), 0)
    const locateExecution = evidence.getByRole('button', { name: '定位设计用例 TC-120', exact: true })
    await locateExecution.focus()
    await locateExecution.press('Enter')
    const locatedDesign = generation.locator('[data-case-id="TC-120"]')
    await locatedDesign.waitFor()
    assert.equal(await locatedDesign.getAttribute('open'), '')
    assert.equal(await locatedDesign.locator('..').locator('..').getAttribute('open'), '')
    assert.equal(await locatedDesign.locator(':scope > summary').evaluate(element => document.activeElement === element), true)
    assert.equal(await generationPagination.getByText('第 12 / 13 页', { exact: true }).count(), 1)
    assert.equal(await search.inputValue(), '')
    assert.equal(await generation.getByRole('combobox', { name: '用例类别', exact: true }).innerText(), '全部类别')
    assert.equal(await generation.getByRole('combobox', { name: '用例状态', exact: true }).innerText(), '全部状态')
    assert.equal(await generation.getByRole('checkbox', { name: '仅看阻断', exact: true }).isChecked(), false)
    assert.equal(await locatedDesign.locator('.case-status').innerText(), '审查未完成')
    assert.equal(await executionSearch.inputValue(), 'TC-120')
    assert.equal(await execution.getByRole('combobox', { name: '执行状态', exact: true }).innerText(), '通过')
    assert.equal(await execution.getByRole('combobox', { name: '执行类别', exact: true }).innerText(), '性能')
    assert.equal(await executionRows.count(), 1)
    assert.equal(await evidence.getAttribute('open'), '')
    await page.screenshot({ path: join(screenshots, 'execution-evidence-and-located-design.png'), fullPage: true })
    delete task.acceptanceSelection
    for (const [state, text] of [['generating', '正在生成用例'], ['reviewing', '正在审查用例']] as const) {
      task.status = 'SELF_TEST'
      task.selfTestPlanningStatus = state
      await page.reload()
      await generation.getByRole('heading', { name: '生成用例', exact: true }).waitFor()
      assert.equal(await page.locator('.page-heading .status-pill').innerText(), text)
      assert.equal(await generation.locator('[role="status"]').innerText(), `${text}…`)
      assert.ok((await page.locator('.phase-group > summary').allTextContents()).some((summary) => summary.includes(text)))
    }
    task.acceptanceSelection = { mode: 'custom', caseIds: ['TC-01'], reason: 'Scope check', confirmedAt: now }
    delete task.selfTestPlanningStatus
    task.modelTurn = { id: 'custom-turn', label: '自定义必验集合核对', startedAt: now, lastActivityAt: now, summary: '', inactivityTimeoutMs: 300000, status: 'running' }
    await page.reload()
    await page.getByText('正在核对自定义范围…', { exact: true }).waitFor()
    assert.equal(await page.locator('.page-heading .status-pill').innerText(), '正在核对自定义范围')
    task.status = 'REVIEW'
    task.selfTestPlanningStatus = 'rejected'
    task.entries = [{ at: now, kind: 'info', stage: 'SELF_TEST', text: 'Custom design review blocked' }]
    delete task.modelTurn
    task.acceptanceSelection = { mode: 'custom', caseIds: ['TC-01', 'TC-119', 'TC-120'], reason: 'Scoped blocker fixture', confirmedAt: now }
    task.executionAssessment = {
      status: 'rejected', readiness: 'blocked', checkedAt: now, coveredIds: [], missingIds: [], caseIds: ['TC-01', 'TC-119', 'TC-120'],
      issues: ['必须先确认专用测试账号的锁定保护与异常会话清理', '观察断言仍可补充细节'],
      findings: [
        { category: 'safety', code: 'account_safety', caseIds: ['TC-120'], message: '必须先确认专用测试账号的锁定保护与异常会话清理' },
        { category: 'executability', code: 'precondition', caseIds: ['TC-119'], message: '必须明确测试前置条件' },
        { category: 'quality', code: 'assertion_detail', caseIds: ['TC-01'], message: '观察断言仍可补充细节' },
      ],
      caseReviews: [{ caseId: 'TC-119', status: 'rejected' }, { caseId: 'TC-120', status: 'rejected' }, { caseId: 'TC-01', status: 'warning' }],
    }
    for (const [name, width, height] of [['desktop', 1440, 1000], ['screenshot-width', 1367, 768], ['mobile', 390, 844], ['narrow', 320, 760]] as const) {
      await page.setViewportSize({ width, height })
      await page.reload()
      const summary = generation.locator('.design-review-summary').first()
      await summary.getByRole('heading', { name: '本次范围 · 设计审查受阻' }).waitFor()
      assert.equal(await summary.getByText('阻断 2 项 · 受影响 case 2 条 · 非阻断提示 1 项', { exact: true }).count(), 1)
      assert.equal(await summary.locator('.design-review-blocking').getAttribute('open'), '')
      assert.equal(await summary.locator('.design-review-advisory').getAttribute('open'), null)
      await generation.getByRole('checkbox', { name: '仅看阻断', exact: true }).check()
      assert.equal(await generationRows.count(), 2)
      assert.deepEqual(await generationRows.locator('details').evaluateAll(elements => elements.map(element => element.getAttribute('data-case-id'))), ['TC-119', 'TC-120'])
      await search.fill('not-present')
      const locate = summary.getByRole('button', { name: '定位用例 TC-120', exact: true })
      await locate.focus()
      await locate.press('Enter')
      const target = generation.locator('details[data-case-id="TC-120"]')
      await target.waitFor()
      assert.equal(await target.getAttribute('open'), '')
      assert.equal(await target.locator(':scope > summary').evaluate(element => document.activeElement === element), true)
      assert.equal(await search.inputValue(), '')
      assert.equal(await generation.getByRole('checkbox', { name: '仅看阻断', exact: true }).isChecked(), false)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name}: blocker navigation fits`)
      await summary.locator('.design-review-advisory > summary').click()
      await page.screenshot({ path: join(screenshots, `blocker-and-warning-${name}.png`), fullPage: true })
      await generation.getByRole('checkbox', { name: '仅看阻断', exact: true }).check()
      await generationRows.filter({ has: page.locator('[data-case-id="TC-119"]') }).getByRole('checkbox').uncheck()
      const history = generation.getByRole('region', { name: '上次审查参考', exact: true })
      await history.getByRole('heading', { name: '上次审查参考（非当前结论） · 设计审查受阻', exact: true }).waitFor()
      assert.equal(await history.getByRole('button', { name: '定位用例 TC-120', exact: true }).count(), 1)
      assert.equal(await generationRows.count(), 2)
      assert.equal(await confirm.isChecked(), false)
      assert.equal(await execute.isDisabled(), true)
      await generationRows.filter({ has: page.locator('[data-case-id="TC-120"]') }).getByRole('checkbox').uncheck()
      assert.equal(await generationRows.count(), 2)
      assert.equal(await history.locator('.design-review-blocking').getAttribute('open'), '')
      assert.equal(await history.getByText('阻断 2 项 · 受影响 case 2 条 · 非阻断提示 1 项', { exact: true }).count(), 1)
      await history.getByRole('button', { name: '定位用例 TC-120', exact: true }).click()
      assert.equal(await target.locator(':scope > summary').evaluate(element => document.activeElement === element), true)
      assert.equal(await target.locator('.case-status').innerText(), '未纳入本次范围')
      await reason.fill('Changed scope reason')
      await summary.getByRole('heading', { name: '本次范围 · 设计审查未完成', exact: true }).waitFor()
      assert.equal(await summary.locator('.design-review-blocking').count(), 0)
      assert.equal(await history.getByRole('button', { name: '定位用例 TC-119', exact: true }).count(), 1)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name}: historical review fits`)
      await page.screenshot({ path: join(screenshots, `changed-scope-review-${name}.png`), fullPage: true })
    }
  } finally {
    await browser?.close()
    await server.close()
    if (process.env.KEEP_UI_SCREENSHOTS === '1') console.log(`UI screenshots: ${screenshots}`)
    else rmSync(screenshots, { recursive: true, force: true })
  }
})