import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import express from 'express'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright-core'
import { expect } from '@playwright/test'
import { TestingLinks } from '../../src/features/coding/TestingLinks.js'
import type { CodingTask } from '../../shared/task.js'
import type { CasePackage, ExecutionRun, PlanningProject } from '../../shared/testing.js'
import { parseTestingLinks } from '../../shared/testing-links.js'
import { decode, diffTask, storedJson, taskState, validateState } from '../storage/contracts.js'
import { TaskStore } from '../tasks/store.js'
import { taskDetail, taskSummary } from '../tasks/task-summary.js'
import { executionEnvironment } from '../execution/execution-environment.js'
import { MemoryTestingRepository } from '../testing/repository.js'
import { registerTaskReads } from './task-reads.js'
import { registerTestingLinks } from './testing-links.js'

const at = '2026-10-20T00:00:00.000Z'
const links = { planningProjectId: 'project', caseSetId: 'package', executionRunId: 'execution' }
const task: CodingTask = { id: 'task', ownerId: 7, repository: 'repo', instruction: 'unchanged', prdName: 'prd.md', designNames: [], status: 'SUCCESS', createdAt: at, updatedAt: at, entries: [], selfTests: [{ id: 'TC-1', title: 'kept', source: 'prd', steps: 'Open', expected: 'Visible', status: 'passed', output: 'kept evidence' }] }
const project: PlanningProject = { id: 'project', ownerId: 7, version: 1, createdAt: at, updatedAt: at, input: { title: 'Plan', requirements: 'Requirements', instruction: '', modelId: 'auto', sources: [] }, status: 'completed', events: [], caseSetIds: ['package'] }
const caseSet: CasePackage = { schemaVersion: 1, id: 'package', projectId: 'project', revision: 1, createdAt: at, sourceFingerprint: 'source', definitionFingerprint: 'definition', rulesVersion: 'rules', modelId: 'auto', baseline: [], cases: [], assessment: { status: 'qualified', checkedAt: at, issues: [], coveredIds: [], missingIds: [] } }
const execution: ExecutionRun = { id: 'execution', ownerId: 7, version: 1, createdAt: at, updatedAt: at, input: { title: 'Run', caseSetId: 'package', repository: 'repo', scope: { mode: 'default', caseIds: [], reason: '' } }, status: 'draft', packageFingerprint: 'definition', cases: [], events: [] }

async function fixture(unavailable = false) {
  const root = await mkdtemp(join(tmpdir(), 'codeflow-testing-links-'))
  const file = join(root, 'tasks.json')
  const store = new TaskStore(file)
  store.create(task)
  const repository = new MemoryTestingRepository()
  await repository.create('project', project, 7)
  await repository.create('package', caseSet, 7)
  await repository.create('execution', execution, 7)
  let busy = false
  const app = express()
  app.use(express.json())
  const owner = (request: express.Request) => Number(request.get('x-owner') ?? 7) || undefined
  registerTaskReads(app, store, owner)
  registerTestingLinks(app, store, unavailable ? undefined : repository, { authenticate: async request => {
    const ownerId = owner(request)
    return ownerId === undefined || request.get('x-auth-expired') ? undefined : { ownerId }
  }, isBusy: () => busy })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(done => server.once('listening', done))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tasks/task`
  const request = async (body: unknown = links, headers: Record<string, string> = {}, path = '/testing-links', method = 'POST') => {
    const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) })
    return { status: response.status, headers: response.headers, body: await response.json() }
  }
  return { store, repository, file, request, busy: (value: boolean) => { busy = value }, close: async () => {
    await new Promise<void>((done, reject) => { server.close(error => error ? reject(error) : done()); server.closeAllConnections() })
    await rm(root, { recursive: true, force: true })
  } }
}

test('testing link replacement validates explicit IDs and clears omitted/null fields', () => {
  assert.deepEqual(parseTestingLinks(links), links)
  assert.deepEqual(parseTestingLinks({ caseSetId: 'package', executionRunId: null }), { caseSetId: 'package' })
  assert.deepEqual(parseTestingLinks({}), {})
  for (const body of [null, [], 'project', { unknown: 'id' }, { caseSetId: '' }, { caseSetId: '../package' }, { caseSetId: 7 }, { caseSetId: 'x'.repeat(192) }]) assert.throws(() => parseTestingLinks(body))
})

test('testing links survive task state, detail, store get/read and JSON roundtrip without changing legacy results', async () => {
  const context = await fixture()
  try {
    const saved = await context.request()
    assert.equal(saved.status, 200)
    assert.equal(saved.headers.get('cache-control'), 'no-store')
    assert.deepEqual(saved.body, { testingLinks: links })
    const current = context.store.get('task')!
    assert.deepEqual({ ...current, updatedAt: at, testingLinks: undefined }, { ...task, testingLinks: undefined })
    assert.deepEqual(taskDetail(current).testingLinks, links)
    assert.deepEqual((await context.request(undefined, {}, '', 'GET')).body.testingLinks, links)
    const state = taskState(current)
    validateState(state)
    assert.deepEqual((decode(storedJson(state)) as Record<string, unknown>).testingLinks, links)
    assert.deepEqual(diffTask(task, current, 1).state?.testingLinks, links)
    const reopened = new TaskStore(context.file)
    assert.deepEqual(reopened.get('task')?.testingLinks, links)
    assert.deepEqual((await reopened.readTask('task'))?.testingLinks, links)
    assert.equal((await context.request({ executionRunId: 'execution' })).status, 200)
    assert.deepEqual(context.store.get('task')?.testingLinks, { executionRunId: 'execution' })
    assert.equal((await context.request({ executionRunId: null })).status, 200)
    assert.deepEqual(context.store.get('task')?.testingLinks, {})
    assert.equal((await context.request({})).status, 200)
  } finally { await context.close() }
})

test('testing links enforce authentication, Origin, task/resource/source ownership and paired consistency', async () => {
  const context = await fixture()
  try {
    assert.equal((await context.request(links, { 'x-owner': '0' })).status, 404)
    assert.equal((await context.request(links, { 'x-auth-expired': 'true' })).status, 401)
    assert.equal((await context.request(links, { 'x-owner': '8' })).status, 404)
    assert.equal((await context.request(links, { origin: 'https://evil.example' })).status, 403)
    assert.equal((await context.request({ ownerId: 7 })).status, 400)
    await context.repository.create('project', { ...project, id: 'other' }, 7)
    await context.repository.create('package', { ...caseSet, id: 'other', projectId: 'other' }, 7)
    await context.repository.create('project', { ...project, id: 'foreign', ownerId: 8 }, 8)
    await context.repository.create('package', { ...caseSet, id: 'foreign', projectId: 'foreign' }, 8)
    await context.repository.create('execution', { ...execution, id: 'foreign', ownerId: 8, input: { ...execution.input, caseSetId: 'foreign' } }, 8)
    await context.repository.create('package', { ...caseSet, id: 'foreign-source', projectId: 'foreign' }, 7)
    await context.repository.create('execution', { ...execution, id: 'foreign-source', input: { ...execution.input, caseSetId: 'foreign-source' } }, 7)
    for (const field of ['planningProjectId', 'caseSetId', 'executionRunId']) assert.equal((await context.request({ [field]: 'foreign' })).status, 404)
    for (const body of [{ caseSetId: 'foreign-source' }, { executionRunId: 'foreign-source' }, { caseSetId: 'missing' }]) assert.equal((await context.request(body)).status, 404)
    assert.equal((await context.request({ ...links, planningProjectId: 'other' })).status, 400)
    assert.equal((await context.request({ caseSetId: 'other', executionRunId: 'execution' })).status, 400)
    assert.equal(context.store.get('task')?.testingLinks, undefined)
  } finally { await context.close() }
})

test('busy, model-active, changed tasks and duplicate saves cannot mutate associations', async () => {
  const context = await fixture()
  try {
    context.busy(true)
    assert.equal((await context.request()).status, 409)
    context.busy(false)
    for (const patch of [{ status: 'TEST_EXECUTION' as const }, { status: 'REVIEW' as const, modelInTurn: true }, { modelInTurn: false, modelTurn: { id: 'turn', label: 'busy', startedAt: at, lastActivityAt: at, summary: '', inactivityTimeoutMs: 1000, status: 'running' as const } }]) {
      context.store.update('task', patch)
      assert.equal((await context.request()).status, 409)
    }
    context.store.update('task', { status: 'REVIEW', modelInTurn: false, modelTurn: undefined })
    const get = context.repository.get.bind(context.repository)
    context.repository.get = async (...args) => { const value = await get(...args); context.store.update('task', { instruction: 'changed concurrently' }); return value }
    assert.equal((await context.request()).status, 409)
    assert.equal(context.store.get('task')?.testingLinks, undefined)
    let release!: () => void
    let entered!: () => void
    const blocked = new Promise<void>(done => { release = done })
    const reached = new Promise<void>(done => { entered = done })
    context.repository.get = async (...args) => { entered(); await blocked; return get(...args) }
    const first = context.request()
    await reached
    const duplicate = await context.request()
    release()
    assert.equal(duplicate.status, 409)
    assert.equal((await first).status, 200)
  } finally { await context.close() }
})

test('missing testing storage fails only the optional endpoint; legacy detail remains readable', async () => {
  const context = await fixture(true)
  try {
    assert.equal((await context.request()).status, 503)
    const detail = await context.request(undefined, {}, '', 'GET')
    assert.equal(detail.status, 200)
    assert.equal(detail.body.status, task.status)
    assert.equal(detail.body.testingLinks, undefined)
    assert.deepEqual(detail.body.selfTests, task.selfTests)
  } finally { await context.close() }
})

test('optional links SSR is collapsed, preserves navigation and never embeds legacy results', () => {
  const empty = renderToStaticMarkup(createElement(TestingLinks, { task, onSaved: async () => {} }))
  assert.doesNotMatch(empty, /<form|<select|<details open|kept evidence/)
  const linked = renderToStaticMarkup(createElement(TestingLinks, { task: { ...task, testingLinks: links }, onSaved: async () => {} }))
  assert.match(linked, /view=planning&amp;planning=project/)
  assert.match(linked, /view=execution&amp;package=package/)
  assert.match(linked, /view=execution&amp;execution=execution/)
})

test('optional links lazy options, explicit save, navigation, errors and responsive FilterSelect interactions', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'codeflow-testing-links-ui-'))
  const server = await createServer({ configFile: false, envDir: false, cacheDir: join(temporary, '.vite'), plugins: [react()], server: { host: '127.0.0.1', port: 0, watch: null } })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await server.listen()
    const address = server.httpServer?.address()
    if (!address || typeof address === 'string') throw new Error('Missing isolated Vite port')
    browser = await chromium.launch({ channel: 'chrome', headless: true, env: executionEnvironment() })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.setDefaultTimeout(12000)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const current: CodingTask = structuredClone(task)
    const projects = Array.from({ length: 45 }, (_, index) => ({ ...project, id: index ? `project-${index}` : project.id, input: { ...project.input, title: `跨功能订单保存与支付结果核对及异常场景完整验证规划 ${index}` } }))
    let optionReads = 0
    let posts = 0
    let unavailable = false
    let failSave = false
    let submitted: unknown
    let detailReads = 0
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname
      const reply = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
      if (path === '/api/auth/status') return reply({ configured: true, authenticated: true, login: 'fixture' })
      if (path === '/api/copilot/models') return reply({ defaultModelId: 'auto', models: [] })
      if (path === '/api/tasks') return reply({ items: [taskSummary(current)], busy: false })
      if (path === '/api/tasks/task/events') return reply({ items: [] })
      if (path === '/api/tasks/task') { detailReads++; return reply(taskDetail(current)) }
      if (path === '/api/tasks/task/testing-links') {
        posts++; submitted = route.request().postDataJSON()
        if (failSave) return reply({ error: '关联保存冲突' }, 409)
        current.testingLinks = parseTestingLinks(submitted)
        return reply({ testingLinks: current.testingLinks })
      }
      if (path.startsWith('/api/testing/')) {
        optionReads++
        if (unavailable) return reply({ error: '测试存储不可用' }, 503)
        if (path === '/api/testing/projects') return reply(projects)
        if (path === '/api/testing/packages') return reply([caseSet])
        if (path === '/api/testing/executions') return reply([execution])
      }
      return reply({ error: `Unexpected fixture request ${path}` }, 500)
    })
    await page.goto(`http://127.0.0.1:${address.port}/?task=task`, { waitUntil: 'networkidle' })
    const section = page.getByRole('region', { name: '独立测试关联', exact: true })
    const summary = section.locator('summary')
    await summary.waitFor()
    assert.equal(optionReads, 0)
    assert.equal(await section.getByRole('combobox').count(), 0)
    assert.equal(await section.evaluate(element => element.nextElementSibling?.getAttribute('aria-label')), '生成用例')
    await summary.click()
    const save = section.getByRole('button', { name: '保存关联', exact: true })
    await expect(save).toBeEnabled()
    assert.equal(optionReads, 3)
    assert.deepEqual(await section.getByRole('combobox').allTextContents(), ['不关联', '不关联', '不关联'])
    const planning = section.getByRole('combobox', { name: '关联用例规划', exact: true })
    for (const width of [1440, 1367, 390, 320]) {
      await page.setViewportSize({ width, height: 900 })
      await planning.click()
      const menu = page.getByRole('listbox', { name: '关联用例规划', exact: true })
      await expect(menu).toBeVisible()
      await menu.press('Home')
      await menu.press('ArrowDown')
      await menu.press('Enter')
      await expect(planning).toBeFocused()
      await expect(planning).toContainText(projects[0].input.title)
      assert.equal(await page.getByRole('listbox').count(), 0)
      for (const name of ['关联用例规划', '关联用例包', '关联执行批次']) {
        const control = section.getByRole('combobox', { name, exact: true })
        await control.click()
        const dropdown = page.getByRole('listbox', { name, exact: true })
        await expect(dropdown).toBeVisible()
        const bounds = await dropdown.boundingBox()
        const trigger = await control.boundingBox()
        assert.ok(bounds && trigger)
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1)
        assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 901)
        assert.ok(bounds.y + bounds.height <= trigger.y + 1 || bounds.y >= trigger.y + trigger.height - 1)
        await page.screenshot({ path: join(temporary, `testing-links-${width}-${name === '关联用例规划' ? 'planning' : name === '关联用例包' ? 'package' : 'execution'}-expanded.png`), fullPage: true })
        await dropdown.press('Escape')
        await expect(control).toBeFocused()
      }
      const layout = await section.evaluate(element => {
        const container = element.getBoundingClientRect()
        const controls = [...element.querySelectorAll('[role="combobox"]')].map(control => {
          const box = control.getBoundingClientRect()
          const parent = control.parentElement!.parentElement!.getBoundingClientRect()
          return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, parentLeft: parent.left, parentRight: parent.right }
        })
        return { left: container.left, right: container.right, overflow: document.documentElement.scrollWidth > innerWidth, controls }
      })
      assert.ok(layout.left >= 0 && layout.right <= width + 1)
      assert.equal(layout.overflow, false)
      for (const control of layout.controls) assert.ok(control.left >= layout.left && control.right <= layout.right + 1 && control.left >= control.parentLeft && control.right <= control.parentRight + 1)
      for (let index = 1; index < layout.controls.length; index++) {
        const before = layout.controls[index - 1], after = layout.controls[index]
        assert.ok(after.left >= before.right - 1 || after.top >= before.bottom - 1)
      }
    }
    assert.equal(posts, 0)
    await planning.click()
    await summary.click()
    assert.equal(await page.getByRole('listbox').count(), 0)
    await summary.click()
    await expect(save).toBeEnabled()
    for (const [name, value] of [['关联用例包', 'package · v1'], ['关联执行批次', 'Run · execution']]) {
      await section.getByRole('combobox', { name, exact: true }).click()
      await page.getByRole('option', { name: value, exact: true }).click()
    }
    const readsBeforeSave = detailReads
    await save.click()
    await expect(section.getByRole('link', { name: '打开执行批次', exact: true })).toBeVisible()
    assert.deepEqual(submitted, links)
    assert.ok(detailReads > readsBeforeSave)
    assert.equal(current.status, task.status)
    assert.deepEqual(current.selfTests, task.selfTests)
    assert.equal(await section.getByRole('link', { name: '打开用例规划', exact: true }).getAttribute('href'), '?view=planning&planning=project')
    assert.equal(await section.getByRole('link', { name: '打开用例包', exact: true }).getAttribute('href'), '?view=execution&package=package')
    assert.equal(await section.getByRole('link', { name: '打开执行批次', exact: true }).getAttribute('href'), '?view=execution&execution=execution')
    failSave = true
    await save.click()
    await expect(section.getByRole('alert')).toHaveText('关联保存冲突')
    failSave = false
    for (const control of await section.getByRole('combobox').all()) {
      await control.click()
      await page.getByRole('option', { name: '不关联', exact: true }).click()
    }
    await save.click()
    await expect(section.getByRole('link')).toHaveCount(0)
    assert.deepEqual(submitted, { planningProjectId: null, caseSetId: null, executionRunId: null })
    current.testingLinks = { planningProjectId: 'unlisted-project' }
    await page.reload({ waitUntil: 'networkidle' })
    const beforeExpand = optionReads
    unavailable = true
    await summary.click()
    await expect(section.getByRole('alert')).toHaveText('测试存储不可用')
    await expect(save).toBeDisabled()
    assert.ok(optionReads > beforeExpand)
    unavailable = false
    await section.getByRole('button', { name: '刷新关联选项', exact: true }).click()
    await expect(save).toBeEnabled()
    await expect(planning).toContainText('当前关联 · unlisted-project')
    current.modelInTurn = true
    await page.reload({ waitUntil: 'networkidle' })
    await summary.click()
    await expect(section.getByText('任务忙碌或尚未稳定，暂不可修改关联。')).toBeVisible()
    await expect(save).toBeDisabled()
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    await server.close()
    if (process.env.KEEP_UI_SCREENSHOTS !== '1') await rm(temporary, { recursive: true, force: true })
    else console.log(`Testing links screenshots: ${temporary}`)
  }
})