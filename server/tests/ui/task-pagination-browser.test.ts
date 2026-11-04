import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright-core'
import type { CodingTask, TaskEntry } from '../../../shared/task.js'
import { taskDetail, taskSummary } from '../../tasks/task-summary.js'
import { executionEnvironment } from '../../execution/execution-environment.js'

test('paged summaries, independent selected detail and paged history keep task boundaries', { timeout: 60000 }, async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'codeflow-task-pages-'))
  const server = await createServer({ configFile: false, envDir: false, cacheDir: join(temporary, '.vite'), plugins: [react()], server: { host: '127.0.0.1', port: 0, watch: null } })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await server.listen()
    const address = server.httpServer?.address()
    assert.ok(address && typeof address !== 'string')
    browser = await chromium.launch({ channel: 'chrome', headless: true, env: executionEnvironment() })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.setDefaultTimeout(5000)
    const now = new Date().toISOString()
    const task: CodingTask = { id: 'selected', ownerId: 1, repository: 'https://github.com/example/selected-repo', instruction: 'Independent selected detail', prdName: 'prd.md', designNames: [], status: 'REVIEW', createdAt: now, updatedAt: now, workspace: 'fixture', copilotSession: { id: 'fixture', directory: 'fixture' }, entries: [] }
    const other: CodingTask = { ...task, id: 'other', repository: 'https://github.com/example/other-repo', instruction: 'Other task detail' }
    const requests: string[] = []
    let releaseSlowDetail: (() => void) | undefined
    let slowDetailStarted: (() => void) | undefined
    const slowStarted = new Promise<void>((resolve) => { slowDetailStarted = resolve })
    let releaseSlowEvents: (() => void) | undefined
    let slowEventsStarted: (() => void) | undefined
    const eventsStarted = new Promise<void>((resolve) => { slowEventsStarted = resolve })
    let failOlderHistory = true
    await page.addInitScript(() => {
      const originalFetch = window.fetch.bind(window)
      window.fetch = (input, options) => originalFetch(input, String(input).startsWith('/api/tasks/slow') ? { ...options, signal: undefined } : options)
    })
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url())
      requests.push(url.pathname + url.search)
      let payload: unknown = {}
      if (url.pathname === '/api/auth/status') payload = { configured: true, authenticated: true, login: 'fixture' }
      else if (url.pathname === '/api/copilot/models') payload = { defaultModelId: 'auto', models: [] }
      else if (url.pathname === '/api/tasks') payload = url.searchParams.get('cursor') === 'next-tasks' ? { items: [taskSummary(task)], busy: false } : { items: [taskSummary(other)], nextCursor: 'next-tasks', busy: false }
      else if (url.pathname === '/api/tasks/selected') payload = taskDetail(task)
      else if (url.pathname === '/api/tasks/other') payload = taskDetail(other)
      else if (url.pathname === '/api/tasks/slow') {
        slowDetailStarted!()
        await new Promise<void>((resolve) => { releaseSlowDetail = resolve })
        payload = taskDetail({ ...task, id: 'slow', instruction: 'LATE WRONG TASK' })
      }
      else if (url.pathname.endsWith('/events')) {
        if (url.pathname === '/api/tasks/slow/events') {
          slowEventsStarted!()
          await new Promise<void>((resolve) => { releaseSlowEvents = resolve })
          return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [{ at: now, stage: 'CODING', kind: 'agent', text: 'LATE WRONG EVENT' }] }) })
        }
        const older = url.searchParams.get('cursor') === 'older-events'
        if (older && failOlderHistory) {
          failOlderHistory = false
          return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture history unavailable' }) })
        }
        const text = url.pathname.includes('/other/') ? 'Other task event' : older ? 'Earlier selected event' : 'Latest selected event'
        const entry: TaskEntry = { at: now, stage: 'CODING', kind: 'agent', text }
        payload = { items: [entry, { at: now, stage: 'CODING', kind: 'info', text: 'Model selection changed', modelChange: { at: now, from: 'auto', to: 'fixture-model', revision: 1 } }], nextCursor: !older && !url.pathname.includes('/other/') ? 'older-events' : undefined }
      }
      else if (url.pathname.endsWith('/artifacts') || url.pathname.endsWith('/runs') || url.pathname.endsWith('/snapshots')) {
        payload = url.searchParams.has('cursor') ? { items: [{ id: 'history-2', kind: 'baseline', status: 'complete', output: 'Second history body' }] } : { items: [{ id: 'history-1', kind: 'baseline', status: 'complete', output: 'First history body' }], nextCursor: 'next-history' }
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) })
    })
    await page.goto(`http://127.0.0.1:${address.port}/?task=selected`, { waitUntil: 'networkidle', timeout: 30000 })
    await page.locator('.details-pane').getByText('Independent selected detail', { exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: /selected-repo/ }).count(), 0)
    await page.locator('.phase-group > summary').filter({ hasText: 'Copilot 编码' }).click()
    await page.getByText('Latest selected event', { exact: true }).waitFor()
    await page.getByText('模型变更记录', { exact: true }).click()
    await page.getByText(/auto → fixture-model · 待生效/).waitFor()
    await page.getByRole('button', { name: '更多执行记录', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: 'Fixture history unavailable' }).waitFor()
    assert.equal(await page.getByText('Latest selected event', { exact: true }).count(), 1)
    await page.getByRole('button', { name: '重试加载执行记录', exact: true }).click()
    await page.getByText('Earlier selected event', { exact: true }).waitFor()
    assert.equal(await page.getByText('Latest selected event', { exact: true }).count(), 1)
    assert.deepEqual(await page.locator('.conversation-turn > p').filter({ hasText: /^(Earlier|Latest) selected event$/ }).allTextContents(), ['Earlier selected event', 'Latest selected event'])
    assert.equal(await page.getByRole('button', { name: '更多执行记录', exact: true }).count(), 0)
    assert.equal(requests.some((url) => /\/(artifacts|runs|snapshots)\?/.test(url)), false)
    for (const [kind, title] of [['artifacts', '自测产物历史'], ['runs', '用例执行历史'], ['snapshots', '验收快照历史']]) {
      const panel = page.locator('.phase-group').filter({ has: page.locator(':scope > summary').filter({ hasText: title }) })
      await panel.locator(':scope > summary').click()
      await panel.getByRole('button', { name: `更多${title}`, exact: true }).click()
      await panel.getByText('baseline · complete', { exact: true }).nth(1).waitFor()
      assert.ok(requests.some((url) => url.includes(`/${kind}?`) && url.includes('cursor=next-history')))
      await panel.locator(':scope > summary').click()
    }
    await page.getByRole('button', { name: '更多任务', exact: true }).click()
    await page.getByRole('button', { name: /selected-repo/ }).waitFor()
    assert.ok(requests.some((url) => url.includes('cursor=next-tasks')))
    assert.ok(requests.some((url) => url.includes('cursor=older-events')))
    await page.getByRole('button', { name: /other-repo/ }).click()
    await page.locator('.details-pane').getByText('Other task detail', { exact: true }).waitFor()
    assert.equal(await page.getByText('Latest selected event', { exact: true }).count(), 0)
    await page.getByRole('navigation', { name: '功能菜单' }).getByRole('link', { name: '自动化任务', exact: true }).click()
    await page.getByRole('heading', { name: '自动化执行任务', exact: true }).waitFor()
    assert.equal(await page.getByText('0 条用例 · 0 条自动化记录', { exact: true }).count(), 2)
    await page.getByRole('button', { name: /other-repo/ }).click()
    await page.locator('.details-pane').getByText('Other task detail', { exact: true }).waitFor()
    await page.evaluate(() => { history.pushState({}, '', '/?task=slow'); dispatchEvent(new PopStateEvent('popstate')) })
    await Promise.all([slowStarted, eventsStarted])
    await page.getByRole('button', { name: /other-repo/ }).click()
    await page.locator('.details-pane').getByText('Other task detail', { exact: true }).waitFor()
    const lateDetail = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/tasks/slow')
    const lateEvents = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/tasks/slow/events')
    releaseSlowDetail!()
    releaseSlowEvents!()
    await Promise.all([(await lateDetail).finished(), (await lateEvents).finished()])
    await page.locator('.phase-group > summary').filter({ hasText: 'Copilot 编码' }).click()
    await page.getByText('Other task event', { exact: true }).waitFor()
    await page.locator('.details-pane').getByText('Other task detail', { exact: true }).waitFor()
    assert.equal(await page.getByText('LATE WRONG TASK', { exact: true }).count(), 0)
    assert.equal(await page.getByText('LATE WRONG EVENT', { exact: true }).count(), 0)
    assert.equal(await page.getByText('Earlier selected event', { exact: true }).count(), 0)
    assert.ok(requests.filter((url) => url.startsWith('/api/tasks?')).every((url) => new URL(url, 'http://fixture').searchParams.get('limit') === '50'))
  } finally {
    await browser?.close()
    await server.close()
    rmSync(temporary, { recursive: true, force: true })
  }
})