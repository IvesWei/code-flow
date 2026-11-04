import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright-core'
import { expect } from '@playwright/test'
import type { CasePackage, ExecutionInput, ExecutionRun, PlanningProject } from '../../../shared/testing.js'
import { executionEnvironment } from '../../execution/execution-environment.js'

test('isolated App preserves planning selection through optimization and hands off an immutable reviewed scope to execution', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'planning-scope-handoff-'))
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
    const unexpected: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const now = '2026-10-23T08:00:00.000Z'
    const originalFingerprint = 'a'.repeat(64)
    const optimizedFingerprint = 'b'.repeat(64)
    const reason = 'Only order creation and payment are in this release'
    const selectedIds = ['TC-1', 'TC-2']
    const assessment: CasePackage['assessment'] = { status: 'qualified', checkedAt: now, coveredIds: ['REQ-1'], missingIds: [], issues: [], caseReviews: selectedIds.map(caseId => ({ caseId, status: 'qualified' })) }
    const current: PlanningProject = {
      id: 'scope-planning', ownerId: 1, version: 4, createdAt: now, updatedAt: now,
      input: { title: 'Order planning', requirements: 'Create orders, pay and inspect history', instruction: '', modelId: 'auto', sources: [] },
      status: 'completed', caseSetIds: [], events: [{ at: now, kind: 'info', text: 'planning:generation:initial' }],
      draft: {
        baseline: [{ id: 'REQ-1', feature: 'Orders', criterion: 'Order workflows', source: 'Requirements', required: true, scenarios: ['normal'] }],
        cases: ['Create order', 'Pay order', 'Inspect history'].map((title, index) => ({ id: `TC-${index + 1}`, title, source: 'Requirements', requirementIds: ['REQ-1'], scenario: 'normal', preconditions: 'Isolated order service is ready', testData: 'Fixture order', steps: title, expected: `${title} succeeds`, assertions: [`${title} result is visible`], cleanup: 'Remove fixture order' })),
        sourceFingerprint: 'c'.repeat(64), definitionFingerprint: originalFingerprint,
        assessment: { ...assessment, status: 'rejected', issues: ['TC-3: history needs clarification'], caseReviews: [{ caseId: 'TC-1', status: 'qualified' }, { caseId: 'TC-2', status: 'qualified' }, { caseId: 'TC-3', status: 'rejected' }] },
        reviewBatches: [{ caseIds: selectedIds, result: { qualified: true, issues: [], caseIssues: [] } }],
        customReview: { caseIds: ['TC-3'], reason: 'Previous history scope', definitionFingerprint: originalFingerprint, batches: [], assessment: { ...assessment, caseReviews: [{ caseId: 'TC-3', status: 'qualified' }] } },
      },
    }
    const posts: { path: string; body: Record<string, unknown> }[] = []
    let published: CasePackage | undefined
    let execution: ExecutionRun | undefined
    let publishAttempts = 0
    let packageReads = 0
    let optimizedReads = 0
    await page.route('**/api/**', async route => {
      const request = route.request()
      const path = new URL(request.url()).pathname
      const method = request.method()
      const reply = (payload: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) })
      if (method === 'GET') {
        if (path === '/api/auth/status') return reply({ configured: true, authenticated: true, login: 'isolated-user' })
        if (path === '/api/copilot/models') return reply({ models: [{ id: 'auto', name: 'Auto' }] })
        if (path === '/api/testing/projects') return reply([current])
        if (path === '/api/testing/projects/scope-planning') {
          if (current.draft?.definitionFingerprint === optimizedFingerprint) optimizedReads++
          return reply(current)
        }
        if (path === '/api/testing/packages') return reply(published ? [published] : [])
        if (path === '/api/testing/packages/scopepkg' && published) { packageReads++; return reply(published) }
        if (path === '/api/testing/executions') return reply(execution ? [execution] : [])
        if (path === '/api/testing/executions/scope-run' && execution) return reply(execution)
      }
      if (method === 'POST') {
        const body = request.postDataJSON() as Record<string, unknown>
        posts.push({ path, body })
        if (path === '/api/testing/projects/scope-planning/optimize') {
          assert.deepEqual(body, { version: 4, caseIds: ['TC-1'], reason: 'Make the order result deterministic', regenerate: false })
          current.version++
          current.status = 'running'
          current.events.push({ at: now, kind: 'info', text: 'planning:generation:optimize-one' }, { at: now, kind: 'info', text: 'Planning optimize: TC-1' })
          return reply(current, 202)
        }
        if (path === '/api/testing/projects/scope-planning/review') {
          assert.deepEqual(body, { mode: 'review', version: 6, caseIds: selectedIds, reason })
          assert.equal(current.draft!.customReview, undefined)
          current.version++
          current.draft!.customReview = {
            caseIds: [...selectedIds], reason, definitionFingerprint: optimizedFingerprint,
            batches: [{ caseIds: [...selectedIds], result: { qualified: true, issues: [], caseIssues: [] } }],
            assessment: structuredClone(assessment),
          }
          return reply(current, 202)
        }
        if (path === '/api/testing/projects/scope-planning/publish-scope') {
          assert.deepEqual(body, { version: 7, caseIds: selectedIds, reason })
          publishAttempts++
          if (publishAttempts === 1) return reply({ error: 'Scope publication conflict; retry the reviewed selection' }, 409)
          published = {
            schemaVersion: 1, id: 'scopepkg', projectId: current.id, revision: 1, createdAt: now,
            sourceFingerprint: current.draft!.sourceFingerprint!, definitionFingerprint: 'd'.repeat(64), rulesVersion: 'planning-rules', modelId: 'auto',
            scope: { mode: 'custom', caseIds: [...selectedIds], reason, originalDefinitionFingerprint: optimizedFingerprint },
            baseline: structuredClone(current.draft!.baseline), cases: structuredClone(current.draft!.cases.filter(item => selectedIds.includes(item.id))), assessment: structuredClone(assessment),
          }
          return reply(published, 201)
        }
        if (path === '/api/testing/executions') {
          assert.equal(packageReads > 0, true)
          assert.deepEqual(body, { title: 'Scoped order execution', repository: 'https://github.com/example/isolated-orders.git', caseSetId: 'scopepkg', scope: { mode: 'custom', caseIds: selectedIds, reason } })
          execution = {
            id: 'scope-run', ownerId: 1, version: 1, createdAt: now, updatedAt: now,
            input: body as unknown as ExecutionInput, status: 'draft', packageFingerprint: published!.definitionFingerprint,
            cases: selectedIds.map(caseId => ({ caseId, selected: true, blocking: true, status: 'pending' })), events: [],
          }
          return reply(execution, 201)
        }
      }
      unexpected.push(`${method} ${path}`)
      return reply({ error: `Unexpected isolated request: ${method} ${path}` }, 500)
    })
    await page.goto(`http://127.0.0.1:${address.port}/?view=planning&planning=scope-planning`, { waitUntil: 'networkidle' })
    const main = page.getByRole('main')
    const review = main.getByRole('region', { name: '审查工作区', exact: true })
    await expect(review).toBeVisible()
    const reviewNode = await review.elementHandle()
    assert.ok(reviewNode)
    await main.getByRole('checkbox', { name: '选择 TC-3', exact: true }).uncheck()
    for (const caseId of selectedIds) await main.getByRole('checkbox', { name: `选择 ${caseId}`, exact: true }).check()
    await review.getByRole('textbox', { name: '审查范围理由', exact: true }).fill(reason)
    const assertSelection = async () => {
      await expect(review.getByText('已选 2 条', { exact: true })).toBeVisible()
      await expect(review.getByRole('textbox', { name: '审查范围理由', exact: true })).toHaveValue(reason)
      for (const caseId of selectedIds) {
        await expect(main.getByRole('checkbox', { name: `选择 ${caseId}`, exact: true })).toBeChecked()
        await expect(review.locator(`[id="planning-review-case-${caseId}"]`)).toHaveCount(1)
      }
      await expect(main.getByRole('checkbox', { name: '选择 TC-3', exact: true })).not.toBeChecked()
      await expect(review.locator('[id="planning-review-case-TC-3"]')).toHaveCount(0)
      await expect(review.locator('.planning-review-case')).toHaveCount(2)
      assert.equal(await reviewNode.evaluate(element => element === document.querySelector('[aria-label="审查工作区"]')), true, 'Parent refresh must not remount PlanningCases')
    }
    await assertSelection()
    await expect(review.getByRole('button', { name: '进入执行', exact: true })).toHaveCount(0)
    await review.locator('[id="planning-review-case-TC-1"] details > summary').click()
    await review.getByRole('button', { name: '优化 TC-1', exact: true }).click()
    const optimize = review.getByRole('form', { name: '优化用例 TC-1', exact: true })
    await optimize.getByRole('textbox', { name: '优化理由', exact: true }).fill('Make the order result deterministic')
    await optimize.getByRole('button', { name: '优化此用例', exact: true }).click()
    await expect(main.getByRole('button', { name: '取消规划', exact: true })).toBeVisible()
    await expect(main).toHaveAttribute('aria-busy', 'false')
    await assertSelection()
    await expect(review.getByRole('button', { name: '审查所选用例', exact: true })).toBeDisabled()
    current.version++
    current.status = 'draft'
    current.draft!.cases[0] = { ...current.draft!.cases[0], title: 'Create order with deterministic result', expected: 'Exactly one saved order is visible' }
    current.draft!.definitionFingerprint = optimizedFingerprint
    current.draft!.assessment = undefined
    current.draft!.reviewBatches = undefined
    current.draft!.customReview = undefined
    await main.getByRole('button', { name: '刷新', exact: true }).click()
    await expect(main).toHaveAttribute('aria-busy', 'false')
    await expect(review.locator('[id="planning-review-case-TC-1"] summary')).toContainText('Create order with deterministic result')
    assert.ok(optimizedReads > 0)
    await assertSelection()
    await expect(review.getByRole('region', { name: '所选范围审查结果', exact: true })).toHaveCount(0)
    await expect(review.getByRole('button', { name: '进入执行', exact: true })).toHaveCount(0)
    await review.getByRole('button', { name: '审查所选用例', exact: true }).click()
    const proceed = review.getByRole('button', { name: '进入执行', exact: true })
    await expect(proceed).toBeEnabled()
    await expect(review.getByRole('region', { name: '所选范围审查结果', exact: true })).toContainText(reason)
    assert.equal(current.draft!.customReview!.definitionFingerprint, optimizedFingerprint)
    assert.deepEqual(current.draft!.customReview!.batches, [{ caseIds: selectedIds, result: { qualified: true, issues: [], caseIssues: [] } }])
    await assertSelection()
    const executionPosts = () => posts.filter(item => item.path.startsWith('/api/testing/executions'))
    assert.deepEqual(executionPosts(), [])
    await proceed.click()
    await expect(review.getByRole('alert')).toHaveText('Scope publication conflict; retry the reviewed selection')
    await expect(page).toHaveURL(/\?view=planning&planning=scope-planning$/)
    await assertSelection()
    assert.equal(publishAttempts, 1)
    assert.deepEqual(executionPosts(), [])
    await expect(proceed).toBeEnabled()
    await proceed.click()
    await expect(page).toHaveURL(/\?view=execution&package=scopepkg$/)
    const form = main.getByRole('form', { name: '新建执行', exact: true })
    await expect(form.getByRole('status')).toContainText('已审查范围包 · 2 条')
    assert.equal(publishAttempts, 2)
    const snapshot = structuredClone(published!)
    assert.deepEqual(snapshot.scope, { mode: 'custom', caseIds: selectedIds, reason, originalDefinitionFingerprint: optimizedFingerprint })
    assert.match(snapshot.scope!.originalDefinitionFingerprint, /^[a-f0-9]{64}$/)
    assert.deepEqual(snapshot.cases.map(item => item.id), selectedIds)
    await expect(form.getByRole('combobox', { name: '执行用例包', exact: true })).toContainText('scopepkg')
    const custom = form.getByRole('radio', { name: '自定义范围', exact: true })
    await expect(custom).toBeChecked()
    await expect(custom).toBeDisabled()
    const defaultScope = form.getByRole('radio', { name: '默认质量门禁', exact: true })
    await expect(defaultScope).not.toBeChecked()
    await expect(defaultScope).toBeDisabled()
    for (const caseId of selectedIds) {
      const checkbox = form.getByRole('checkbox', { name: new RegExp(`^${caseId} ·`) })
      await expect(checkbox).toBeChecked()
      await expect(checkbox).toBeDisabled()
    }
    await expect(form.getByRole('checkbox')).toHaveCount(2)
    await expect(form.getByRole('checkbox', { name: /^TC-3 ·/ })).toHaveCount(0)
    await expect(form.getByRole('textbox', { name: '范围调整理由', exact: true })).toHaveValue(reason)
    await expect(form.getByRole('textbox', { name: '范围调整理由', exact: true })).toBeDisabled()
    await form.getByRole('textbox', { name: '执行标题', exact: true }).fill('Scoped order execution')
    await form.getByRole('textbox', { name: '目标仓库', exact: true }).fill('https://github.com/example/isolated-orders.git')
    assert.deepEqual(executionPosts(), [])
    await form.getByRole('button', { name: '创建执行', exact: true }).click()
    await expect(page).toHaveURL(/\?view=execution&execution=scope-run$/)
    await expect(main.getByRole('region', { name: '执行详情', exact: true })).toContainText('Scoped order execution')
    assert.equal(executionPosts().length, 1)
    assert.deepEqual(executionPosts()[0].body.scope, { mode: 'custom', caseIds: selectedIds, reason })
    assert.deepEqual(published, snapshot)
    assert.deepEqual(posts.map(item => item.path), [
      '/api/testing/projects/scope-planning/optimize', '/api/testing/projects/scope-planning/review',
      '/api/testing/projects/scope-planning/publish-scope', '/api/testing/projects/scope-planning/publish-scope', '/api/testing/executions',
    ])
    assert.deepEqual(unexpected, [])
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    await server.close()
    rmSync(temporary, { recursive: true, force: true })
  }
})