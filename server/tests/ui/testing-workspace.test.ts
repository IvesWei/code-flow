import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright-core'
import { expect } from '@playwright/test'
import type { CasePackage, ExecutionInput, ExecutionRun, PlanningInput, PlanningProject, TestingSource } from '../../../shared/testing.js'
import type { PlaywrightExecutionBinding } from '../../../shared/test-execution.js'
import { TestingCases, TestingWorkspace } from '../../../src/features/testing/TestingWorkspace.js'
import { AuthContext } from '../../../src/features/auth/auth-session.js'
import { PlanningActivity, PlanningProgress, planningProgress, planningFeedback } from '../../../src/features/testing/planning/PlanningProgress.js'
import { PlanningCases, planningCaseGroups } from '../../../src/features/testing/planning/PlanningCases.js'
import { executionEnvironment } from '../../execution/execution-environment.js'

const now = '2026-10-20T08:00:00.000Z'
const cases: CasePackage['cases'] = [{ id: 'TC-1', title: '订单保存与支付结果核对：跨功能需求映射与异常场景完整验证', source: '需求文档', steps: '保存订单，然后查询订单状态', expected: '订单已保存', assertions: ['订单数据一致', '订单状态可见'], requirementIds: ['REQ-1'], preconditions: '服务已启动', testData: '隔离数据', cleanup: '删除测试订单' }, { id: 'TC-2', title: '补充性能检查', source: '需求文档', steps: '测量耗时', expected: '耗时满足要求', assertions: ['满足阈值'], classification: { testType: 'performance', tags: [], priority: 'P2', riskReason: '补充检查', executionPolicy: 'on_demand' } }]
const assessment: CasePackage['assessment'] = { status: 'qualified', checkedAt: now, coveredIds: ['REQ-1'], missingIds: [], issues: [], caseReviews: [{ caseId: 'TC-1', status: 'qualified' }, { caseId: 'TC-2', status: 'warning' }] }
const casePackage: CasePackage = { schemaVersion: 1, id: 'package-1', projectId: 'planning-1', revision: 1, createdAt: now, sourceFingerprint: 'source', definitionFingerprint: 'definition', rulesVersion: 'rules-1', modelId: 'auto', baseline: [{ id: 'REQ-1', criterion: '保存订单并保留默认质量门禁', source: '需求', required: true, scenarios: ['normal'] }], cases, assessment }
const implementation = { testFile: 'tests/order.spec.ts', testTitle: 'orders saves an order', project: 'chromium' }
const implementationSource = `import { test, expect } from '@playwright/test';

test('orders saves an order', async ({ page }) => {
  const description = '${'订单完整源码核对'.repeat(80)}';
  await page.goto('/orders');
  await test.step('[assertion:TC-1:server-assertion-one]', async () => {
    await expect(page.getByText('订单已保存')).toBeVisible();
  });
  await test.step('[assertion:TC-1:server-assertion-two]', async () => {
    await expect(page.getByText(description)).toBeVisible();
  });
});
`

test('standalone workspace SSR has independent forms and conservative review labels', () => {
  const auth = { auth: { configured: true, authenticated: true, login: 'fixture' }, login: () => {}, logout: async () => {} }
  const planning = renderToStaticMarkup(createElement(AuthContext, { value: auth }, createElement(TestingWorkspace, { view: 'planning' })))
  const execution = renderToStaticMarkup(createElement(AuthContext, { value: auth }, createElement(TestingWorkspace, { view: 'execution' })))
  assert.match(planning, /需求正文/)
  assert.match(planning, /需求文档/)
  assert.match(planning, /规划模型/)
  assert.match(planning, /规划指令（可选）/)
  assert.doesNotMatch(planning, /用例包版本|导入 JSON/)
  assert.match(execution, /用例包版本/)
  assert.match(execution, /执行用例包/)
  assert.match(execution, /默认质量门禁/)
  assert.doesNotMatch(planning + execution, /<select|role="tab|CodingTask|api\/tasks/)
  const unknown = renderToStaticMarkup(createElement(TestingCases, { cases }))
  assert.match(unknown, /审查未完成/)
  assert.match(unknown, /未分类（旧用例）/)
  assert.doesNotMatch(unknown, /审查通过/)
  const reviewed = renderToStaticMarkup(createElement(TestingCases, { cases, assessment }))
  assert.match(reviewed, /审查通过/)
  assert.match(reviewed, /质量提示/)
})

test('planning progress uses current generation only and keeps clarification and review states conservative', () => {
  const project: PlanningProject = { id: 'planning-1', ownerId: 1, version: 4, createdAt: now, updatedAt: now, input: { title: '登录界面优化', requirements: '登录需求', instruction: '', modelId: 'auto', sources: [] }, status: 'running', caseSetIds: [], events: [
    { at: now, kind: 'info', text: 'Model progress: Planning review: fresh read-only session.' },
    { at: now, kind: 'info', text: 'planning:generation:new-round' },
    { at: now, kind: 'info', text: 'Model progress: Planning baseline: fresh read-only session.' },
  ] }
  assert.equal(planningProgress(project).index, 0)
  assert.match(renderToStaticMarkup(createElement(PlanningProgress, { project })), /待审查/)
  project.events.push({ at: now, kind: 'info', text: 'Model progress: Planning generation: fresh read-only session.' })
  assert.equal(planningProgress(project).index, 1)
  project.events.push({ at: now, kind: 'info', text: 'Model progress: Planning review: fresh read-only session.' })
  assert.equal(planningProgress(project).index, 2)
  project.status = 'failed'
  project.error = 'Planning requires clarification. Update the requirements or instruction and generate again.'
  const failed = renderToStaticMarkup(createElement(PlanningProgress, { project }))
  assert.match(failed, /需要补充需求/)
  assert.match(failed, /模型未保存具体澄清问题/)
  assert.doesNotMatch(failed, /Planning requires|审查通过/)
  project.error = 'Planning baseline output is invalid after one format correction.'
  const invalidBaseline = renderToStaticMarkup(createElement(PlanningProgress, { project }))
  assert.match(invalidBaseline, /需求基线格式无效/)
  assert.doesNotMatch(invalidBaseline, /模型调用失败|Planning baseline output/)
  project.events.push({ at: now, kind: 'info', text: 'Model progress: Planning baseline output format invalid; requesting one format correction.' })
  assert.match(renderToStaticMarkup(createElement(PlanningActivity, { project })), /正在进行一次格式修正/)
  project.status = 'interrupted'
  project.draft = { baseline: casePackage.baseline, cases, assessment }
  assert.doesNotMatch(renderToStaticMarkup(createElement(PlanningProgress, { project })), /审查通过/)
  project.status = 'completed'
  assert.match(renderToStaticMarkup(createElement(PlanningProgress, { project })), /用例生成完成|审查通过/)
  const activity = renderToStaticMarkup(createElement(PlanningActivity, { project }))
  assert.match(activity, /正在提取需求基线/)
  assert.doesNotMatch(activity, /<details open/)
})

test('scoped planning rejects selected design problems without importing old unselected failures', () => {
  const project: PlanningProject = { id: 'scope', ownerId: 1, version: 4, createdAt: now, updatedAt: now, input: { title: 'Scope', requirements: '', instruction: '', modelId: 'auto', sources: [] }, status: 'draft', caseSetIds: [], events: [], draft: { baseline: casePackage.baseline, cases, definitionFingerprint: 'same', assessment: { ...assessment, status: 'rejected', issues: ['Old unselected failure'], caseIssues: [{ caseId: 'TC-2', message: 'Old unselected failure' }], caseReviews: [{ caseId: 'TC-1', status: 'rejected' }, { caseId: 'TC-2', status: 'rejected' }] }, customReview: { definitionFingerprint: 'same', caseIds: ['TC-1'], reason: 'Only first', batches: [], assessment: { ...assessment, status: 'rejected', issues: ['Selected assertion conflicts'], caseIssues: [{ caseId: 'TC-1', message: 'Selected assertion conflicts' }], findings: [{ code: 'quality_review', category: 'quality', message: 'Selected assertion conflicts', caseIds: ['TC-1'] }], caseReviews: [{ caseId: 'TC-1', status: 'rejected' }] } } } }
  const markup = renderToStaticMarkup(createElement(PlanningCases, { project, busy: false, onReview: () => {} }))
  const scope = markup.split('aria-label="所选范围审查结果"')[1].split('<div class="planning-case-list">')[0]
  assert.match(scope, /阻断 1 项/)
  assert.match(scope, /非阻断提示 0 项/)
  assert.match(scope, /Selected assertion conflicts/)
  assert.doesNotMatch(scope, /Old unselected failure|data-case-target="TC-2"/)
  assert.match(markup, /范围 · 审查不通过/)
  project.draft!.customReview!.assessment = { ...assessment, caseReviews: [{ caseId: 'TC-1', status: 'qualified' }] }
  const passed = renderToStaticMarkup(createElement(PlanningCases, { project, busy: false, onReview: () => {} }))
  assert.match(passed, /范围 · 审查通过/)
  assert.match(passed, /所选范围设计审查完成，全量发布门禁不变/)
  project.draft!.customReview!.assessment = undefined
  assert.match(renderToStaticMarkup(createElement(PlanningCases, { project, busy: false, onReview: () => {} })), /范围 · 审查未完成/)
  project.status = 'failed'
  project.error = 'Planning review response format invalid; saved draft checkpoints remain available.'
  const invalid = renderToStaticMarkup(createElement(PlanningProgress, { project }))
  assert.match(invalid, /审查结果格式无效|审查返回格式校验未通过/)
  assert.doesNotMatch(invalid, /模型调用失败|Planning review response/)
})

test('planning feedback distinguishes silence, stale snapshots and interruptions without inventing progress', () => {
  const timestamp = Date.parse(now)
  const project: PlanningProject = { id: 'waiting', ownerId: 1, version: 2, createdAt: now, updatedAt: now, input: { title: 'Planning', requirements: 'Requirements', instruction: '', modelId: 'auto', sources: [] }, status: 'running', caseSetIds: [], draft: { baseline: casePackage.baseline, cases }, events: [
    { at: now, kind: 'info', text: 'planning:generation:current' },
    { at: now, kind: 'info', text: 'Model progress: 用例批次 8：补齐 8 个需求场景，已保存 57 条（第 1 次尝试）' },
    { at: now, kind: 'info', text: 'Model progress: Planning generation: fresh read-only session.' },
    { at: now, kind: 'info', text: `Model progress: Planning activity: ${JSON.stringify({ phase: 'generation', summary: 'SDK 已启动模型回合，等待模型响应', firstResponseMs: 1200000, inactivityMs: 1200000 })}` },
  ] }
  assert.equal(planningFeedback(project, timestamp + 119000).silent, false)
  assert.equal(planningFeedback(project, timestamp + 120000).silent, true)
  assert.match(planningFeedback(project).batch!, /用例批次 8/)
  const waiting = renderToStaticMarkup(createElement(PlanningProgress, { project }))
  assert.match(waiting, /尚不能判定失败|首次响应等待上限|不会自动重放/)
  assert.doesNotMatch(waiting, /用例生成失败|审查通过/)
  const stale = renderToStaticMarkup(createElement(PlanningProgress, { project, syncError: true }))
  assert.match(stale, /状态刷新失败|上次保存状态/)
  assert.doesNotMatch(stale, /仍在等待响应，尚不能判定失败/)
  project.status = 'interrupted'
  assert.equal(planningFeedback(project).silent, false)
  assert.match(renderToStaticMarkup(createElement(PlanningProgress, { project })), /不会自动续跑|不是从当前条数断点续跑/)
  project.status = 'running'
  project.events.push({ at: now, kind: 'info', text: 'planning:generation:new' })
  assert.equal(planningFeedback(project).batch, undefined)
  assert.equal(planningFeedback(project).limits, undefined)
  project.events.push({ at: now, kind: 'info', text: 'Model progress: Planning activity: {broken' })
  assert.doesNotThrow(() => planningFeedback(project))
})

test('planning cases group once by requirement feature and preserve legacy and complete cross mappings', () => {
  const baseline: CasePackage['baseline'] = [
    { ...casePackage.baseline[0], feature: '桌面布局' },
    { ...casePackage.baseline[0], id: 'REQ-2', feature: '品牌文案' },
    { ...casePackage.baseline[0], id: 'REQ-3', criterion: '旧需求未记录功能点名称' },
  ]
  const definitions = [
    { ...cases[0], id: 'TC-1', requirementIds: ['REQ-1', 'REQ-2'] },
    { ...cases[0], id: 'TC-2', requirementIds: ['REQ-2'] },
    { ...cases[0], id: 'TC-3', requirementIds: ['REQ-1'] },
    { ...cases[0], id: 'TC-4', requirementIds: ['REQ-3'] },
    { ...cases[0], id: 'TC-5', requirementIds: ['REQ-404'] },
  ]
  const project: PlanningProject = { id: 'groups', ownerId: 1, version: 1, createdAt: now, updatedAt: now, input: { title: 'Groups', requirements: 'Requirements', instruction: '', modelId: 'auto', sources: [] }, status: 'draft', caseSetIds: [], events: [], draft: { baseline, cases: definitions } }
  const groups = planningCaseGroups(project, definitions)
  assert.deepEqual([...groups.keys()], ['桌面布局', '品牌文案', 'REQ-3 · 旧需求未记录功能点名称', '未映射需求'])
  assert.deepEqual([...groups.values()].flat().map(item => item.id), ['TC-1', 'TC-3', 'TC-2', 'TC-4', 'TC-5'])
  const markup = renderToStaticMarkup(createElement(PlanningCases, { project, busy: false, onReview: () => {} }))
  assert.equal((markup.match(/class="planning-selectable-case"/g) || []).length, 5)
  assert.match(markup, /REQ-1 · 桌面布局\nREQ-2 · 品牌文案/)
  assert.match(markup, /选择功能组 桌面布局/)
  assert.match(markup, /未分类（旧用例）/)
})

test('isolated planning and execution workflows, trusted bindings and responsive overlays', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'codeflow-testing-ui-'))
  const server = await createServer({ configFile: false, envDir: false, cacheDir: join(temporary, '.vite'), plugins: [react()], server: { host: '127.0.0.1', port: 0, watch: null } })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await server.listen()
    const address = server.httpServer?.address()
    if (!address || typeof address === 'string') throw new Error('Missing isolated Vite port')
    browser = await chromium.launch({ channel: 'chrome', headless: true, env: executionEnvironment() })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true })
    page.setDefaultTimeout(12000)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const requests: { path: string; body: unknown; method: string }[] = []
    const projects: PlanningProject[] = []
    const packages: CasePackage[] = []
    const executions: ExecutionRun[] = []
    let generationReads = 0
    let executionReads = 0
    let pendingOperation: 'prepare' | 'implement' | 'install' | undefined
    let operationReads = 0
    let missingSource = false
    let preparationFailure = true
    let installFailure = true
    let implementationFailure = true
    let bindingFailure = false
    let unauthenticated = false
    let authStatusFailed = false
    let authConfigured = true
    let uploaded = false
    let planningAnswerFailure = true
    let holdPlanningRead = false
    let releasePlanningRead: (() => void) | undefined
    let binding: PlaywrightExecutionBinding | null = null
    const manifest = { version: 1, caseId: 'TC-1', definitionKey: 'server-owned-definition', assertions: [{ id: 'server-assertion-one', definition: '订单数据一致' }, { id: 'server-assertion-two', definition: '订单状态可见' }] }
    await page.route('**/api/**', async route => {
      const request = route.request()
      const path = new URL(request.url()).pathname
      const method = request.method()
      const body = request.headers()['content-type']?.includes('application/json') && request.postData() ? request.postDataJSON() : undefined
      requests.push({ path, body, method })
      const reply = (payload: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) })
      if (path === '/api/auth/status') return authStatusFailed ? reply({ error: 'unavailable' }, 503) : reply({ configured: authConfigured, authenticated: !unauthenticated, ...(!unauthenticated ? { login: 'codeflow-user' } : {}) })
      if (path === '/api/copilot/models') return reply({ models: [{ id: 'auto', name: 'Auto' }, { id: 'model-long', name: '完整需求、设计与跨功能断言规划专用模型名称' }] })
      if (!path.startsWith('/api/testing/')) return reply({ error: 'Unexpected legacy API call' }, 500)
      if (unauthenticated) return reply({ error: '登录已过期' }, 401)
      if (path === '/api/testing/sources') {
        const multipart = request.postDataBuffer()?.toString() || ''
        assert.match(multipart, /name="kind"/)
        assert.match(multipart, /requirements/)
        assert.match(multipart, /name="files"; filename="requirements.md"/)
        uploaded = true
        return reply([{ id: 'source-1', name: 'requirements.md', kind: 'requirements', sizeBytes: 12, sha256: 'server-sha', storageKey: 'server-key' } satisfies TestingSource])
      }
      if (path === '/api/testing/projects' && method === 'GET') return reply(projects)
      if (path === '/api/testing/packages' && method === 'GET') return reply(packages)
      if (path === '/api/testing/executions' && method === 'GET') return reply(executions)
      if (path === '/api/testing/projects' && method === 'POST') {
        assert.equal('referenceRepository' in body, false)
        assert.equal('referenceBranch' in body, false)
        const project: PlanningProject = { id: 'planning-1', ownerId: 1, version: 1, createdAt: now, updatedAt: now, input: body as PlanningInput, status: 'draft', events: [], caseSetIds: [] }
        projects.push(project)
        return reply(project, 201)
      }
      const project = projects[0]
      if (path === '/api/testing/projects/planning-1/answer') {
        assert.equal(body.questionId, project.question?.id)
        assert.equal(body.version, project.version)
        assert.equal(body.answer, '认证失败后清空密码、保留账号，并将焦点移回密码字段')
        if (planningAnswerFailure) { planningAnswerFailure = false; return reply({ error: '答复暂未保存，请重试' }, 503) }
        project.clarifications = [{ question: project.question!, answer: body.answer, answeredAt: now }]
        project.question = undefined
        project.error = undefined
        project.status = 'running'
        project.version++
        generationReads = 0
        return reply(project, 202)
      }
      if (path === '/api/testing/projects/planning-1/generate') {
        assert.deepEqual(body, {})
        generationReads = 0
        project.version++; project.status = 'running'; project.draft = { baseline: casePackage.baseline, cases: [cases[0]] }; project.events = [{ at: now, kind: 'info', text: '已生成首批用例，等待审查' }]
        return reply(project)
      }
      if (path === '/api/testing/projects/planning-1/review' || path === '/api/testing/projects/planning-1/continue') {
        assert.equal(body.version, project.version)
        if (body.caseIds) {
          assert.ok(body.caseIds.every((id: string) => project.draft!.cases.some(item => item.id === id)))
          project.draft!.definitionFingerprint = 'fixture'
          project.draft!.customReview = { caseIds: body.caseIds, reason: body.reason, definitionFingerprint: 'fixture', batches: [], assessment: { ...assessment, caseReviews: body.caseIds.map((caseId: string) => ({ caseId, status: 'qualified' })) } }
        }
        project.version++
        return reply(project, 202)
      }
      if (path === '/api/testing/projects/planning-1/cancel') {
        assert.deepEqual(body, {})
        project.status = 'cancelled'; project.version++
        return reply(project)
      }
      if (path === '/api/testing/projects/planning-1/publish') {
        assert.deepEqual(body, {})
        packages.push(structuredClone(casePackage)); project.caseSetIds.push(casePackage.id)
        return reply(casePackage)
      }
      if (path === '/api/testing/projects/planning-1') {
        if (holdPlanningRead) {
          holdPlanningRead = false
          const stale = structuredClone(project)
          await new Promise<void>(resolve => { releasePlanningRead = resolve })
          return reply(stale)
        }
        if (project.status === 'running' && ++generationReads >= 2) { project.status = 'completed'; project.version++; project.draft = { baseline: casePackage.baseline, cases, assessment } }
        return reply(project)
      }
      if (path === '/api/testing/packages/import') return reply({ error: '导入包审查未通过：服务端重新校验拒绝' }, 422)
      if (path === '/api/testing/packages/package-1' || path === '/api/testing/packages/package-1/export') return reply(casePackage)
      if (path === '/api/testing/executions' && method === 'POST') {
        assert.equal('branch' in body, false)
        assert.equal('previewUrl' in body, false)
        assert.equal(packages.length, 1)
        const run: ExecutionRun = { id: `execution-${executions.length + 1}`, ownerId: 1, version: 1, createdAt: now, updatedAt: now, input: body as ExecutionInput, status: 'draft', phase: 'cloning', packageFingerprint: 'package-fingerprint', events: [], cases: [{ caseId: 'TC-1', selected: true, blocking: true, status: 'pending' }, { caseId: 'TC-2', selected: false, blocking: false, status: 'skipped' }] }
        executions.push(run)
        return reply(run, 201)
      }
      const run = executions[0]
      if (path === '/api/testing/executions/execution-1/prepare') {
        assert.deepEqual(body, {})
        assert.ok(['draft', 'blocked'].includes(run.status))
        assert.equal(run.workspaceFingerprint, undefined)
        if (preparationFailure) {
          run.status = 'blocked'; run.phase = 'cloning'; run.version++
          run.error = '克隆仓库失败，未自动重试'
          return reply({ error: run.error }, 422)
        }
        pendingOperation = 'prepare'; operationReads = 0
        run.status = 'preparing'; run.phase = 'cloning'; run.error = undefined; run.version++
        return reply(run, 202)
      }
      if (path === '/api/testing/executions/execution-1/implement') {
        assert.deepEqual(body, {})
        assert.ok(['awaiting_implementation', 'implementing'].includes(run.phase!))
        assert.equal(run.cases[0].binding, undefined)
        pendingOperation = 'implement'; operationReads = 0
        run.status = 'preparing'; run.phase = 'implementing'; run.error = undefined; run.version++
        return reply(run, 202)
      }
      if (path === '/api/testing/executions/execution-1/install') {
        assert.deepEqual(body, { confirm: true })
        assert.ok(['awaiting_installation', 'installing'].includes(run.phase!))
        pendingOperation = 'install'; operationReads = 0
        run.status = 'preparing'; run.phase = 'installing'; run.error = undefined; run.version++
        return reply(run, 202)
      }
      if (path === '/api/testing/executions/execution-1/bindings/TC-1') {
        if (method === 'POST') {
          if (bindingFailure) return reply({ error: '脚本已变化，绑定未保存' }, 409)
          const fields = body as { testFile: string; testTitle: string; project: string; assertionIds: string[]; confirm: boolean }
          assert.deepEqual(fields.assertionIds, manifest.assertions.map(item => item.id))
          assert.equal(fields.confirm, true)
          assert.equal('approvedBy' in fields, false)
          binding = { ...fields, version: 1, caseFingerprint: 'case', designFingerprint: 'design', testSourceFingerprint: 'source', approvedAt: now, approvedBy: 'server-reviewer', reviewedAt: now }
          run.cases[0].binding = binding
          run.status = 'ready'; run.phase = 'ready'; run.version++
        }
        return reply({ manifest, testCase: cases[0], binding, implementation: run.cases[0].implementation, ...(!missingSource && run.cases[0].implementation ? { source: implementationSource } : {}) })
      }
      if (path === '/api/testing/executions/execution-1/start') {
        assert.deepEqual(body, {})
        assert.ok(binding)
        run.status = 'running'; run.phase = 'executing'; run.version++
        return reply(run)
      }
      if (path === '/api/testing/executions/execution-1/report') return reply({ schemaVersion: 1, run, casePackage, scope: run.input.scope })
      if (path === '/api/testing/executions/execution-2') return reply(executions[1])
      if (path === '/api/testing/executions/execution-1') {
        if (pendingOperation) {
          if (++operationReads >= 2) {
            run.status = 'blocked'; run.version++
            if (pendingOperation === 'implement' && implementationFailure) {
              run.phase = 'implementing'; run.error = '生成实现失败，未自动修复'
            } else if (pendingOperation === 'install' && installFailure) {
              run.phase = 'installing'; run.error = '安装依赖失败，未自动重试'
            } else if (pendingOperation === 'prepare') {
              run.workspaceFingerprint = 'cloned-workspace'; run.phase = 'awaiting_implementation'
              run.error = '缺少目标仓库 Playwright 依赖；未自动安装或启动服务'
            } else {
              if (pendingOperation === 'implement') run.cases[0].implementation = structuredClone(implementation)
              run.phase = pendingOperation === 'implement' ? 'awaiting_installation' : 'awaiting_approval'; run.error = undefined
            }
            pendingOperation = undefined
          }
          return reply(run)
        }
        if (run.status === 'running' && ++executionReads >= 2) {
          run.status = 'incomplete'; run.phase = 'finished'; run.cases[0].status = 'incomplete'; run.version++
          run.cases[0].result = { version: 1, runner: 'playwright-test', caseId: 'TC-1', caseFingerprint: 'case', status: 'incomplete', reason: '仍有缺失断言，不能标记通过', assertions: [{ id: 'server-assertion-one', status: 'passed', expectCount: 1 }, { id: 'server-assertion-two', status: 'missing', expectCount: 0 }], startedAt: now, finishedAt: now }
        }
        return reply(run)
      }
      return reply({ error: `Unhandled mock ${method} ${path}` }, 404)
    })
    const base = `http://127.0.0.1:${address.port}`
    const assertLayout = async (width: number) => {
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `No horizontal overflow at ${width}`)
      assert.equal(await page.locator('.testing-fields, .filter-select, .testing-fields label, .filter-select-trigger').evaluateAll(elements => elements.every(element => {
        const box = element.getBoundingClientRect(), parent = element.parentElement!.getBoundingClientRect()
        return box.left >= parent.left - 1 && box.right <= parent.right + 1
      })), true, `Controls stay within containers at ${width}`)
      assert.equal(await page.locator('.testing-case-heading, .testing-actions, .testing-heading, .testing-fields').evaluateAll(rows => rows.every(row => {
        const boxes = [...row.children].map(child => child.getBoundingClientRect())
        return boxes.every((box, index) => boxes.slice(index + 1).every(other => box.right <= other.left + 1 || other.right <= box.left + 1 || box.bottom <= other.top + 1 || other.bottom <= box.top + 1))
      })), true, `No row overlap at ${width}`)
    }
    await page.goto(`${base}/?view=planning`, { waitUntil: 'networkidle' })
    await expect(page.getByRole('form', { name: '新建规划' })).toBeVisible()
    await expect(page.locator('.testing-topbar')).toContainText('codeflow-user · 已登录')
    await expect(page.locator('.testing-topbar').getByRole('link', { name: '登录 Copilot', exact: true })).toHaveCount(0)
    await expect(page.getByRole('region', { name: '用例包版本', exact: true })).toHaveCount(0)
    await expect(page.getByLabel('规划指令（可选）', { exact: true })).toHaveValue('')
    await expect(page.getByLabel('规划指令（可选）', { exact: true })).not.toHaveAttribute('required')
    assert.equal(requests.some(item => item.path === '/api/testing/executions'), false)
    await page.getByLabel('规划标题', { exact: true }).fill('全新独立规划')
    const createPlanning = page.getByRole('button', { name: '创建规划', exact: true })
    assert.equal(await createPlanning.isDisabled(), true)
    await page.getByLabel('需求正文', { exact: true }).fill('保存订单，查询订单状态，并审查完整断言。')
    await page.getByLabel('参考仓库（可选）', { exact: true }).fill('   ')
    await page.getByLabel('参考分支（可选）', { exact: true }).fill('   ')
    assert.equal(await createPlanning.isEnabled(), true)

    await expect(createPlanning).toHaveCSS('background-color', 'rgb(40, 110, 80)')
    await expect(page.getByLabel('规划标题', { exact: true })).toHaveCSS('min-height', '42px')
    const requirementUpload = page.getByLabel('需求文档', { exact: true })
    await requirementUpload.focus()
    await requirementUpload.press('Tab')
    await page.keyboard.press('Shift+Tab')
    await expect(requirementUpload).toBeFocused()
    await expect(requirementUpload).toHaveCSS('outline-style', 'solid')
    await expect(requirementUpload.locator('..')).toHaveCSS('outline-style', 'none')
    const keyboardChooser = page.waitForEvent('filechooser')
    await requirementUpload.press('Enter')
    await (await keyboardChooser).setFiles([])

    for (const width of [1440, 1367, 390, 320]) {
      await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 })
      assert.equal(await page.locator('input[type=file]').evaluateAll(elements => elements.every(element => {
        const control = element as HTMLInputElement
        const box = control.getBoundingClientRect()
        const parent = control.parentElement!.getBoundingClientRect()
        return getComputedStyle(control, '::file-selector-button').visibility === 'hidden'
          && getComputedStyle(control).color === 'rgba(0, 0, 0, 0)'
          && Math.abs(box.width - parent.width) <= 2 && Math.abs(box.height - parent.height) <= 2
      })), true, `Styled upload controls cover their triggers at ${width}`)
      const combo = page.getByRole('combobox', { name: '规划模型' })
      await combo.click()
      await page.getByRole('listbox').press('End')
      await page.getByRole('listbox').press('Enter')
      assert.match(await combo.innerText(), /完整需求/)
      await combo.click()
      const menu = page.getByRole('listbox')
      await expect(combo).toHaveAttribute('aria-expanded', 'true')
      await expect(menu.getByRole('option', { selected: true })).toContainText('完整需求')
      const menuBox = await menu.boundingBox(), triggerBox = await combo.boundingBox()
      assert.ok(menuBox && triggerBox)
      assert.ok(menuBox.x >= 0 && menuBox.x + menuBox.width <= width + 1)
      assert.ok(menuBox.y >= 0 && menuBox.y + menuBox.height <= (width < 500 ? 844 : 1000) + 1)
      assert.ok(menuBox.y >= triggerBox.y + triggerBox.height || menuBox.y + menuBox.height <= triggerBox.y)
      await page.screenshot({ path: join(temporary, `planning-expanded-${width}.png`), fullPage: true })
      await menu.press('Escape')
      await expect(combo).toBeFocused()
      await expect(combo).toHaveAttribute('aria-expanded', 'false')
      await combo.click()
      await page.getByRole('heading', { name: '用例规划', exact: true }).click()
      assert.equal(await page.getByRole('listbox').count(), 0)
      assert.equal(await page.locator('select').count(), 0)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      assert.equal(await page.locator('.testing-heading h2').evaluateAll(elements => elements.every(element => element.getBoundingClientRect().width >= Math.min(180, element.parentElement!.clientWidth) - 1)), true, `Section headings remain readable at ${width}`)
      assert.equal(await page.locator('.testing-fields label').evaluateAll(elements => elements.every(element => { const box = element.getBoundingClientRect(); const parent = element.parentElement!.getBoundingClientRect(); return box.left >= parent.left - 1 && box.right <= parent.right + 1 })), true)
      await assertLayout(width)
    }
    const pointerChooser = page.waitForEvent('filechooser')
    await requirementUpload.click()
    await (await pointerChooser).setFiles({ name: 'requirements.md', mimeType: 'text/markdown', buffer: Buffer.from('requirements') })
    await expect(page.getByRole('button', { name: '移除 requirements.md' })).toBeVisible()
    assert.equal(uploaded, true)
    await page.getByLabel('需求正文', { exact: true }).fill('')
    await createPlanning.click()
    await expect(page).toHaveURL(/view=planning&planning=planning-1/)
    assert.equal(projects[0].input.requirements, '')
    assert.equal(projects[0].input.sources[0].storageKey, 'server-key')
    assert.equal(projects[0].input.modelId, 'model-long')
    const publish = page.getByRole('button', { name: '发布用例包' })
    assert.equal(await publish.isDisabled(), true)
    await page.getByRole('button', { name: '生成用例', exact: true }).click()
    await page.getByRole('region', { name: '进度记录', exact: true }).getByText(/^进度记录 ·/).click()
    await expect(page.getByRole('region', { name: '用例生成进度' }).getByText('已生成首批用例，等待审查', { exact: true })).toBeVisible()
    assert.equal(await publish.isDisabled(), true)
    await expect(publish).toBeEnabled()
    await publish.click()
    await expect(page.getByRole('region', { name: '不可变用例包', exact: true })).toBeVisible()
    const planningDetail = page.getByRole('region', { name: '规划详情', exact: true })
    await expect(planningDetail.getByRole('region', { name: '用例生成进度', exact: true })).toContainText('用例生成完成')
    const completedProject = structuredClone(projects[0])
    projects[0].version++
    projects[0].status = 'running'
    generationReads = -100
    const waitingAt = new Date(Date.now() - 180000).toISOString()
    projects[0].events = [
      { at: waitingAt, kind: 'info', text: 'planning:generation:waiting' },
      { at: waitingAt, kind: 'info', text: 'Model progress: 用例批次 8：补齐 8 个需求场景，已保存 57 条（第 1 次尝试）' },
      { at: waitingAt, kind: 'info', text: 'Model progress: Planning generation: fresh read-only session.' },
      { at: waitingAt, kind: 'info', text: `Model progress: Planning activity: ${JSON.stringify({ phase: 'generation', summary: 'SDK 已启动模型回合，等待模型响应', firstResponseMs: 1200000, inactivityMs: 1200000 })}` },
    ]
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    const live = planningDetail.locator('.planning-live')
    await expect(live).toContainText('尚不能判定失败')
    await expect(live).toContainText('用例批次 8')
    for (const width of [1440, 1367, 390, 320]) {
      await page.setViewportSize({ width, height: 900 })
      const bounds = await live.boundingBox()
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width)
      const rows = await live.locator('p').all()
      let bottom = 0
      for (const row of rows) {
        const rowBounds = await row.boundingBox()
        assert.ok(rowBounds && rowBounds.y >= bottom && rowBounds.x + rowBounds.width <= width)
        bottom = rowBounds.y + rowBounds.height
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      await page.screenshot({ path: join(temporary, `planning-waiting-${width}.png`), fullPage: true })
    }
    projects[0].version++
    projects[0].status = 'failed'
    projects[0].error = 'Planning requires clarification. Update the requirements or instruction and generate again.'
    projects[0].draft = undefined
    projects[0].events = [{ at: now, kind: 'info', text: 'planning:generation:current-round' }, { at: now, kind: 'info', text: 'Model progress: Planning baseline: fresh read-only session.' }]
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await expect(planningDetail.getByRole('heading', { name: '需要补充需求', exact: true })).toBeVisible()
    await expect(planningDetail.getByRole('alert')).toContainText('模型未保存具体澄清问题')
    await expect(publish).toBeDisabled()
    const planningActivity = page.getByRole('region', { name: '进度记录', exact: true })
    await expect(planningActivity.locator('details').filter({ has: page.getByText('原始诊断记录', { exact: true }) })).not.toHaveAttribute('open')
    await planningActivity.getByText(/^进度记录 ·/).click()
    await expect(planningActivity.locator('details[open]')).toHaveCount(0)
    for (const width of [1440, 1367, 390, 320]) {
      await page.setViewportSize({ width, height: 900 })
      await assertLayout(width)
      await page.screenshot({ path: join(temporary, `planning-clarification-${width}.png`), fullPage: true })
    }
    projects[0].status = 'needs_input'
    projects[0].question = { id: 'password-freeform-question', createdAt: now, text: '认证失败后是否清空密码？请确认最终验收规则。', choices: ['认证失败后清空密码、保留账号，并将焦点移回密码字段', '认证失败后保留密码与账号', '尚未确定，列为必须完成安全评审的阻断项'], allowFreeform: true }
    projects[0].version++
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    const questionPanel = planningDetail.getByRole('region', { name: '需要你的确认', exact: true })
    await expect(questionPanel).toContainText('认证失败后是否清空密码？')
    await expect(planningDetail.getByRole('button', { name: '生成用例', exact: true })).toBeDisabled()
    const answerSubmit = questionPanel.getByRole('button', { name: '提交答复并重新规划', exact: true })
    await expect(answerSubmit).toBeDisabled()
    await questionPanel.getByRole('textbox', { name: '回复 Copilot', exact: true }).fill('待安全评审确认，不预设密码保留行为')
    await expect(answerSubmit).toBeEnabled()
    projects[0].question = { ...projects[0].question!, id: 'password-question', allowFreeform: false }
    projects[0].version++
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await expect(answerSubmit).toBeDisabled()
    await expect(questionPanel.getByRole('textbox')).toHaveCount(0)
    const clearPassword = questionPanel.getByRole('radio', { name: '认证失败后清空密码、保留账号，并将焦点移回密码字段', exact: true })
    await clearPassword.focus()
    await clearPassword.press('ArrowDown')
    await expect(questionPanel.getByRole('radio', { name: '认证失败后保留密码与账号', exact: true })).toBeChecked()
    await clearPassword.check()
    for (const width of [1440, 1367, 390, 320]) {
      await page.setViewportSize({ width, height: 900 })
      await assertLayout(width)
      await page.screenshot({ path: join(temporary, `planning-question-${width}.png`), fullPage: true })
    }
    await answerSubmit.click()
    await expect(page.getByRole('alert').filter({ hasText: '答复暂未保存' })).toBeVisible()
    await expect(clearPassword).toBeChecked()
    await expect(answerSubmit).toBeEnabled()
    await answerSubmit.click()
    await expect(questionPanel).toHaveCount(0)
    await expect(page.getByRole('alert').filter({ hasText: '答复暂未保存' })).toHaveCount(0)
    await expect(planningDetail.getByRole('region', { name: '用例生成进度', exact: true })).toContainText('用例生成完成')
    await planningDetail.getByText('已确认问题 · 1 项', { exact: true }).click()
    await expect(planningDetail.getByText('认证失败后清空密码、保留账号，并将焦点移回密码字段', { exact: true })).toBeVisible()
    projects[0] = { ...completedProject, version: projects[0].version + 1, draft: { ...completedProject.draft!, assessment: { ...assessment, status: 'rejected', caseIssues: [{ caseId: 'TC-1', message: '补充登录异常断言' }] } } }
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await planningDetail.getByRole('button', { name: '定位用例 TC-1', exact: true }).click()
    await expect(page.locator('#planning-case-TC-1 details')).toHaveAttribute('open', '')
    await expect(page.locator('#planning-case-TC-1 summary')).toBeFocused()
    await expect(publish).toBeDisabled()
    projects[0] = { ...completedProject, version: projects[0].version + 1 }
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    const manyCases = Array.from({ length: 25 }, (_item, index) => ({ ...cases[0], id: `TC-${index + 1}`, title: `订单用例 ${index + 1}：跨页条件和结果核对`, classification: index % 2 ? { testType: 'functional' as const, tags: [], priority: 'P1' as const, riskReason: 'Order persistence', executionPolicy: 'always' as const } : undefined }))
    projects[0] = { ...completedProject, version: projects[0].version + 1, draft: { ...completedProject.draft!, cases: manyCases, assessment: { ...assessment, caseReviews: manyCases.map(item => ({ caseId: item.id, status: 'qualified' })) } } }
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    const caseList = page.getByRole('region', { name: '用例设计列表', exact: true })
    await expect(caseList.locator('.planning-selectable-case')).toHaveCount(10)
    await caseList.getByRole('checkbox', { name: '选择 TC-1', exact: true }).check()
    await caseList.getByRole('button', { name: '下一页用例', exact: true }).click()
    await expect(caseList.locator('#planning-case-TC-11')).toBeVisible()
    await caseList.getByRole('checkbox', { name: '选择 TC-11', exact: true }).check()
    await expect(caseList).toContainText('已选 2 条')
    await caseList.getByRole('searchbox', { name: '搜索用例' }).fill('订单用例 25')
    await expect(caseList.locator('.planning-selectable-case')).toHaveCount(1)
    await expect(caseList.locator('#planning-case-TC-25')).toBeVisible()
    await caseList.getByRole('checkbox', { name: /选择全部筛选结果/ }).check()
    await expect(caseList).toContainText('已选 3 条')
    await caseList.getByLabel('审查范围理由', { exact: true }).fill('优先核对订单保存和跨页范围')
    await caseList.getByRole('button', { name: '审查所选用例', exact: true }).click()
    await expect(caseList.getByRole('region', { name: '所选范围审查结果' })).toContainText('全量发布门禁不变')
    const scopeRequest = requests.findLast(item => item.path === '/api/testing/projects/planning-1/review')
    assert.deepEqual((scopeRequest!.body as { caseIds: string[] }).caseIds, ['TC-1', 'TC-11', 'TC-25'])
    await caseList.getByRole('button', { name: '继续此范围审查', exact: true }).click()
    await expect.poll(() => requests.filter(item => item.path === '/api/testing/projects/planning-1/review').length).toBe(2)
    await caseList.getByRole('searchbox', { name: '搜索用例' }).fill('')
    for (const width of [1440, 1367, 390, 320]) {
      await page.setViewportSize({ width, height: 900 })
      const filter = caseList.getByRole('combobox', { name: '用例类型', exact: true })
      await filter.click()
      const menu = page.getByRole('listbox', { name: '用例类型', exact: true })
      await expect(menu).toBeVisible()
      const bounds = await menu.boundingBox()
      const triggerBounds = await filter.boundingBox()
      assert.ok(bounds && triggerBounds && bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y >= 0 && bounds.y + bounds.height <= 900)
      assert.ok(bounds!.y >= triggerBounds!.y + triggerBounds!.height || bounds!.y + bounds!.height <= triggerBounds!.y)
      await page.screenshot({ path: join(temporary, `planning-cases-expanded-${width}.png`), fullPage: true })
      await menu.press('Escape')
      await expect(filter).toBeFocused()
      await filter.press('ArrowDown')
      await expect(menu).toBeVisible()
      await menu.press('End')
      await menu.press('Enter')
      await expect(filter).toBeFocused()
      await filter.click()
      await page.getByRole('option', { name: '全部类型', exact: true }).click()
      await assertLayout(width)
      const controls = await caseList.locator('.planning-case-filters > *').all()
      for (const control of controls) { const box = await control.boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= width) }
    }
    projects[0].draft!.assessment = { ...assessment, status: 'rejected', caseIssues: [{ caseId: 'TC-25', message: '补充最后一页断言' }] }
    projects[0].version++
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await caseList.getByRole('button', { name: '定位用例 TC-25', exact: true }).click()
    await expect(caseList.locator('#planning-case-TC-25 details')).toHaveAttribute('open', '')
    await expect(caseList.locator('#planning-case-TC-25 summary')).toBeFocused()
    await planningDetail.getByRole('button', { name: '继续全量审查', exact: true }).click()
    await expect.poll(() => requests.filter(item => item.path === '/api/testing/projects/planning-1/review').length).toBe(3)
    await planningDetail.getByRole('button', { name: '继续生成并审查', exact: true }).click()
    assert.ok(requests.some(item => item.path === '/api/testing/projects/planning-1/continue'))
    const longFeature = '登录引导与身份认证状态切换：保留需求原文并验证长标题在移动端完整换行展示'
    const groupedBaseline = [
      { ...casePackage.baseline[0], feature: '桌面布局' },
      { ...casePackage.baseline[0], id: 'REQ-2', feature: '品牌文案' },
      { ...casePackage.baseline[0], id: 'REQ-3', feature: longFeature },
    ]
    const groupedCases = manyCases.map((item, index) => ({ ...item, requirementIds: [groupedBaseline[index % 3].id], title: index === 0 ? '标准桌面默认态双栏布局与基础视觉' : item.title }))
    projects[0] = { ...completedProject, version: projects[0].version + 1, draft: { baseline: groupedBaseline, cases: groupedCases, assessment: { ...assessment, caseReviews: groupedCases.map(item => ({ caseId: item.id, status: 'qualified' })) } } }
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await caseList.getByRole('button', { name: '清空用例选择', exact: true }).click()
    await caseList.getByRole('searchbox', { name: '搜索用例' }).fill('桌面布局')
    await caseList.getByRole('searchbox', { name: '搜索用例' }).fill('')
    const desktopGroup = caseList.locator('.planning-feature-group').filter({ has: page.getByRole('checkbox', { name: '选择功能组 桌面布局', exact: true }) })
    await expect(desktopGroup.locator('.planning-selectable-case')).toHaveCount(9)
    await desktopGroup.getByRole('checkbox', { name: '选择 TC-1', exact: true }).check()
    const groupCheckbox = desktopGroup.getByRole('checkbox', { name: '选择功能组 桌面布局', exact: true })
    assert.equal(await groupCheckbox.evaluate(element => (element as HTMLInputElement).indeterminate), true)
    await groupCheckbox.check()
    await expect(caseList).toContainText('已选 9 条')
    await groupCheckbox.focus()
    await groupCheckbox.press('Space')
    await expect(caseList).toContainText('已选 0 条')
    await caseList.getByRole('searchbox', { name: '搜索用例' }).fill('品牌文案')
    await expect(caseList.locator('.planning-selectable-case')).toHaveCount(8)
    await expect(caseList.locator('.planning-feature-group')).toHaveCount(1)
    await caseList.getByRole('searchbox', { name: '搜索用例' }).fill('')
    for (const width of [1440, 1367, 390, 320]) {
      await page.setViewportSize({ width, height: 900 })
      const row = caseList.locator('#planning-case-TC-1')
      const rowBox = await row.boundingBox()
      const checkboxBox = await row.getByRole('checkbox').boundingBox()
      const titleBox = await row.locator('summary > strong').boundingBox()
      assert.ok(rowBox && checkboxBox && titleBox)
      assert.ok(checkboxBox!.y < titleBox!.y + titleBox!.height && checkboxBox!.y + checkboxBox!.height > titleBox!.y)
      assert.ok(checkboxBox!.x + checkboxBox!.width <= titleBox!.x)
      assert.ok(rowBox!.height <= (width >= 700 ? 65 : 135))
      const paginationBox = await caseList.getByRole('combobox', { name: '每页用例', exact: true }).boundingBox()
      assert.ok(paginationBox && paginationBox.width <= 160)
      await assertLayout(width)
      await page.screenshot({ path: join(temporary, `planning-grouped-${width}.png`), fullPage: true })
    }
    projects[0].draft!.assessment = { ...assessment, status: 'rejected', caseIssues: [{ caseId: 'TC-3', message: '长功能标题的跨页用例待补充' }] }
    projects[0].version++
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await caseList.getByRole('button', { name: '定位用例 TC-3', exact: true }).click()
    const targetGroup = caseList.locator('.planning-feature-group').filter({ has: page.locator('#planning-case-TC-3') })
    await expect(targetGroup).toHaveAttribute('open', '')
    await expect(page.locator('#planning-case-TC-3 details')).toHaveAttribute('open', '')
    await expect(page.locator('#planning-case-TC-3 summary')).toBeFocused()
    await targetGroup.locator(':scope > summary').click()
    await expect(targetGroup).not.toHaveAttribute('open')
    await caseList.getByRole('button', { name: '定位用例 TC-3', exact: true }).click()
    await expect(targetGroup).toHaveAttribute('open', '')
    await expect(page.locator('#planning-case-TC-3 summary')).toBeFocused()
    for (const width of [1440, 1367, 390, 320]) {
      await page.setViewportSize({ width, height: 900 })
      await assertLayout(width)
      const heading = targetGroup.locator(':scope > summary')
      await expect(heading).toContainText(longFeature)
      const headingBox = await heading.boundingBox()
      assert.ok(headingBox && headingBox.x >= 0 && headingBox.x + headingBox.width <= width)
      assert.equal(await heading.evaluate(element => element.scrollWidth <= element.clientWidth), true)
      await page.screenshot({ path: join(temporary, `planning-long-group-${width}.png`), fullPage: true })
    }
    projects[0] = { ...completedProject, version: projects[0].version + 1 }
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    for (const width of [1440, 1367, 390, 320]) {
      await page.setViewportSize({ width, height: 900 })
      await assertLayout(width)
      await page.screenshot({ path: join(temporary, `planning-detail-${width}.png`), fullPage: true })
    }
    const packageSnapshot = JSON.stringify(packages[0])
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: '导出用例包', exact: true }).click()
    assert.equal((await download).suggestedFilename(), 'package-package-1.json')
    await page.getByRole('button', { name: '从此版本创建执行' }).click()
    await expect(page).toHaveURL(/view=execution&package=package-1/)
    await expect(page.locator('.testing-topbar')).toContainText('codeflow-user · 已登录')
    await expect(page.getByRole('button', { name: '创建执行', exact: true })).toBeEnabled()
    await expect(page.getByRole('button', { name: '创建执行', exact: true })).toHaveCSS('background-color', 'rgb(40, 110, 80)')
    await page.getByLabel('执行标题', { exact: true }).fill('独立执行')
    await page.getByLabel('目标仓库', { exact: true }).fill('https://github.com/example/target.git')
    await page.getByLabel('执行分支（可选）', { exact: true }).fill('   ')
    await expect(page.getByLabel('预览 URL（可选）', { exact: true })).toHaveValue('')
    await page.getByRole('radio', { name: '自定义范围', exact: true }).check()
    assert.equal(await page.getByRole('button', { name: '创建执行', exact: true }).isDisabled(), true)
    await page.getByRole('checkbox', { name: /TC-1/ }).check()
    await page.getByLabel('范围调整理由', { exact: true }).fill('只运行订单用例，补充项另行执行')
    for (const width of [1440, 1367, 390, 320]) {
      await page.setViewportSize({ width, height: 900 })
      const importTrigger = page.getByLabel('导入 JSON', { exact: true }).locator('..')
      await expect(importTrigger).toHaveCSS('border-top-style', 'solid')
      assert.ok((await importTrigger.boundingBox())!.height < 50, 'JSON import remains a compact action')
      const combo = page.getByRole('combobox', { name: '执行用例包' })
      await combo.click()
      const menu = page.getByRole('listbox')
      const box = await menu.boundingBox(), triggerBox = await combo.boundingBox()
      assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1 && box.y >= 0 && box.y + box.height <= 901)
      assert.ok(triggerBox && (box.y >= triggerBox.y + triggerBox.height || box.y + box.height <= triggerBox.y))
      await expect(menu.getByRole('option', { selected: true })).toContainText('package-1')
      await page.screenshot({ path: join(temporary, `execution-expanded-${width}.png`), fullPage: true })
      await menu.press('Home')
      await menu.press('ArrowDown')
      await menu.press('Enter')
      await expect(combo).toBeFocused()
      await expect(combo).toContainText('package-1')
      await combo.click()
      await page.getByRole('listbox').press('Escape')
      await expect(combo).toBeFocused()
      await assertLayout(width)
    }
    await page.getByRole('radio', { name: '默认质量门禁', exact: true }).isChecked().then(checked => assert.equal(checked, true))
    await page.getByRole('radio', { name: '自定义范围', exact: true }).check()
    await expect(page.getByRole('button', { name: '创建执行', exact: true })).toBeDisabled()
    await page.getByRole('checkbox', { name: /TC-1/ }).check()
    await page.getByLabel('范围调整理由', { exact: true }).fill('只运行订单用例，补充项另行执行')
    await page.getByRole('button', { name: '创建执行', exact: true }).click()
    await expect(page).toHaveURL(/view=execution&execution=execution-1/)
    assert.deepEqual(executions[0].input.scope, { mode: 'custom', caseIds: ['TC-1'], reason: '只运行订单用例，补充项另行执行' })
    await page.goBack()
    await expect(page.getByRole('form', { name: '新建执行' })).toBeVisible()
    await page.goForward()
    await expect(page.getByRole('region', { name: '执行详情', exact: true })).toBeVisible()
    assert.equal(await page.getByRole('button', { name: '执行已选用例', exact: true }).isDisabled(), true)
    const posts = () => requests.filter(item => item.method === 'POST' && item.path.includes('/executions/execution-1/')).map(item => item.path.split('/').at(-1))
    const generateImplementation = page.getByRole('button', { name: '生成测试实现', exact: true })
    const prepare = page.getByRole('button', { name: '准备执行环境', exact: true })
    const assertPersistentFailure = async (message: string, phase: ExecutionRun['phase']) => {
      await expect(page.getByRole('alert').filter({ hasText: message }).first()).toBeVisible()
      assert.equal(executions[0].status, 'blocked')
      assert.equal(executions[0].phase, phase)
      await page.reload({ waitUntil: 'networkidle' })
      await expect(page.getByRole('alert').filter({ hasText: message }).first()).toBeVisible()
      const before = posts()
      const reads = requests.filter(item => item.path === '/api/testing/executions/execution-1').length
      await page.clock.fastForward(10000)
      assert.deepEqual(posts(), before, 'Blocked failures never retry automatically')
      assert.equal(requests.filter(item => item.path === '/api/testing/executions/execution-1').length, reads, 'Blocked failures do not poll')
      await expect(page.getByRole('alert').filter({ hasText: message }).first()).toBeVisible()
    }
    await page.clock.install()
    assert.equal(await generateImplementation.isDisabled(), true)
    await prepare.click()
    await assertPersistentFailure('克隆仓库失败，未自动重试', 'cloning')
    await expect(prepare).toBeEnabled()
    await expect(generateImplementation).toBeDisabled()
    preparationFailure = false
    const preparingResponse = page.waitForResponse(response => response.url().endsWith('/execution-1/prepare') && response.status() === 202)
    await prepare.click()
    await preparingResponse
    await expect(prepare).toBeDisabled()
    await expect(generateImplementation).toBeDisabled()
    await expect(page.getByRole('alert').filter({ hasText: '缺少目标仓库' })).toBeVisible()
    assert.ok(operationReads >= 2, 'Preparation retry 202 is followed by detail polling')
    await expect(page.getByRole('region', { name: '执行详情', exact: true }).getByRole('status')).toContainText('等待生成实现')
    assert.equal(await page.getByRole('button', { name: '准备执行环境', exact: true }).isDisabled(), true)
    assert.deepEqual(posts(), ['prepare', 'prepare'])
    await generateImplementation.click()
    await expect(generateImplementation).toBeDisabled()
    await assertPersistentFailure('生成实现失败，未自动修复', 'implementing')
    await expect(generateImplementation).toBeEnabled()
    await expect(prepare).toBeDisabled()
    await expect(page.getByRole('button', { name: '审阅绑定 TC-1', exact: true })).toBeDisabled()
    implementationFailure = false
    const implementingResponse = page.waitForResponse(response => response.url().endsWith('/execution-1/implement') && response.status() === 202)
    await generateImplementation.click()
    await implementingResponse
    await expect(page.getByRole('region', { name: '执行详情', exact: true }).getByRole('status')).toContainText('生成实现中')
    await expect(generateImplementation).toBeDisabled()
    await expect(page.getByRole('button', { name: '审阅绑定 TC-1', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: '执行已选用例', exact: true })).toBeDisabled()
    await expect(page.getByText(/已生成，未批准：tests\/order.spec.ts/)).toBeVisible()
    assert.ok(operationReads >= 2, 'Implementation 202 is followed by detail polling')
    await expect(page.getByRole('region', { name: '执行详情', exact: true }).getByRole('status')).toContainText('等待确认安装')
    const install = page.getByRole('button', { name: '安装 Playwright 依赖', exact: true })
    const installConsent = page.getByRole('checkbox', { name: /我了解 npm 包供应链风险/ })
    assert.equal(await install.isDisabled(), true)
    assert.equal(await installConsent.isChecked(), false)
    assert.equal(await page.getByRole('button', { name: '审阅绑定 TC-1', exact: true }).isDisabled(), true)
    assert.deepEqual(posts(), ['prepare', 'prepare', 'implement', 'implement'])
    await expect(page.getByText(/@playwright\/test@1.63.0/)).toContainText('--ignore-scripts')
    await installConsent.check()
    await install.click()
    await expect(install).toHaveCount(0)
    await assertPersistentFailure('安装依赖失败，未自动重试', 'installing')
    await expect(installConsent).not.toBeChecked()
    await expect(install).toBeDisabled()
    await expect(prepare).toBeDisabled()
    await expect(generateImplementation).toBeDisabled()
    await expect(page.getByRole('button', { name: '审阅绑定 TC-1', exact: true })).toBeDisabled()
    installFailure = false
    await installConsent.focus()
    await installConsent.press('Space')
    const installingResponse = page.waitForResponse(response => response.url().endsWith('/execution-1/install') && response.status() === 202)
    await install.click()
    await installingResponse
    await expect(page.getByRole('region', { name: '执行详情', exact: true }).getByRole('status')).toContainText('安装依赖中')
    await expect(page.getByRole('button', { name: '安装 Playwright 依赖', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '审阅绑定 TC-1', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: '执行已选用例', exact: true })).toBeDisabled()
    assert.deepEqual(posts(), ['prepare', 'prepare', 'implement', 'implement', 'install', 'install'])
    assert.equal(binding, null)
    await expect(page.getByRole('region', { name: '执行详情', exact: true }).getByRole('status')).toContainText('等待人工审核绑定')
    assert.ok(operationReads >= 2, 'Installation 202 is followed by detail polling')
    missingSource = true
    await page.getByRole('button', { name: '审阅绑定 TC-1', exact: true }).click()
    const bindingForm = page.getByRole('form', { name: '绑定 TC-1', exact: true })
    await expect(bindingForm.getByRole('alert')).toContainText('生成脚本源码未加载')
    assert.equal(await bindingForm.getByRole('checkbox').isDisabled(), true)
    assert.equal(await bindingForm.getByRole('button', { name: '保存绑定' }).isDisabled(), true)
    missingSource = false
    await page.getByRole('button', { name: '审阅绑定 TC-1', exact: true }).click()
    await page.getByRole('button', { name: '审阅绑定 TC-1', exact: true }).click()
    await expect(bindingForm.getByText('server-assertion-one', { exact: true })).toBeVisible()
    assert.equal(await bindingForm.getByRole('checkbox').isChecked(), false)
    await expect(bindingForm.getByLabel('测试文件', { exact: true })).toHaveValue(implementation.testFile)
    await expect(bindingForm.getByLabel('完整测试标题', { exact: true })).toHaveValue(implementation.testTitle)
    await expect(bindingForm.getByLabel('Playwright 项目（可选）', { exact: true })).toHaveValue(implementation.project)
    assert.equal(await bindingForm.getByLabel('脚本源码 TC-1', { exact: true }).textContent(), implementationSource)
    for (const width of [1440, 1367, 390, 320]) {
      await page.setViewportSize({ width, height: 900 })
      await assertLayout(width)
      assert.equal(await bindingForm.locator('pre').evaluate(element => {
        const box = element.getBoundingClientRect(), parent = element.parentElement!.getBoundingClientRect()
        return box.left >= parent.left - 1 && box.right <= parent.right + 1 && element.clientHeight <= 480
      }), true)
      await page.screenshot({ path: join(temporary, `source-review-${width}.png`), fullPage: true })
    }
    await bindingForm.getByRole('checkbox').check()
    await bindingForm.getByLabel('测试文件', { exact: true }).fill('tests/other.spec.ts')
    assert.equal(await bindingForm.getByRole('checkbox').isDisabled(), true)
    await bindingForm.getByLabel('测试文件', { exact: true }).fill(implementation.testFile)
    await bindingForm.getByRole('checkbox').check()
    await bindingForm.getByLabel('完整测试标题', { exact: true }).fill('orders changed title')
    assert.equal(await bindingForm.getByRole('checkbox').isChecked(), false)
    await bindingForm.getByLabel('完整测试标题', { exact: true }).fill(implementation.testTitle)
    await bindingForm.getByRole('checkbox').check()
    await bindingForm.getByLabel('Playwright 项目（可选）', { exact: true }).fill('')
    assert.equal(await bindingForm.getByRole('checkbox').isChecked(), false)
    assert.equal(await bindingForm.getByRole('button', { name: '保存绑定' }).isDisabled(), true)
    await bindingForm.getByLabel('Playwright 项目（可选）', { exact: true }).fill(implementation.project)
    bindingFailure = true
    await bindingForm.getByRole('checkbox').check()
    await bindingForm.getByRole('button', { name: '保存绑定' }).click()
    await expect(bindingForm.getByRole('alert')).toContainText('脚本已变化')
    assert.equal(await bindingForm.getByRole('checkbox').isChecked(), false)
    assert.equal(binding, null)
    bindingFailure = false
    await bindingForm.getByRole('checkbox').check()
    await bindingForm.getByRole('button', { name: '保存绑定' }).click()
    await expect(page.getByRole('button', { name: '执行已选用例', exact: true })).toBeEnabled()
    assert.equal(await page.getByRole('button', { name: '审阅绑定 TC-2', exact: true }).count(), 0)
    await page.getByRole('button', { name: '执行已选用例', exact: true }).click()
    await expect(page.getByRole('list', { name: '断言结果 TC-1' })).toContainText('缺失')
    await expect(page.getByRole('button', { name: '准备执行环境', exact: true })).toBeDisabled()
    await expect(generateImplementation).toBeDisabled()
    await expect(page.getByRole('button', { name: '审阅绑定 TC-1', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: '执行已选用例', exact: true })).toBeDisabled()
    assert.equal(JSON.stringify(packages[0]), packageSnapshot)
    for (const width of [1440, 1367, 390, 320]) {
      await page.setViewportSize({ width, height: 900 })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      assert.equal(await page.locator('.testing-case-heading, .testing-actions, .testing-heading').evaluateAll(rows => rows.every(row => {
        const boxes = [...row.children].map(child => child.getBoundingClientRect())
        return boxes.every((box, index) => boxes.slice(index + 1).every(other => box.right <= other.left + 1 || other.right <= box.left + 1 || box.bottom <= other.top + 1 || other.bottom <= box.top + 1))
      })), true, `No row overlap at ${width}`)
      await page.screenshot({ path: join(temporary, `results-${width}.png`), fullPage: true })
    }
    const reportDownload = page.waitForEvent('download')
    await page.getByRole('button', { name: '导出报告' }).click()
    assert.equal((await reportDownload).suggestedFilename(), 'execution-execution-1.json')
    const finishedSnapshot = JSON.stringify(executions[0])
    await page.getByRole('button', { name: '从此版本创建执行', exact: true }).click()
    await expect(page).toHaveURL(/view=execution&package=package-1/)
    await expect(page.getByRole('combobox', { name: '执行用例包' })).toContainText('package-1')
    await expect(page.getByRole('radio', { name: '默认质量门禁', exact: true })).toBeChecked()
    await page.getByLabel('执行标题', { exact: true }).fill('同包新批次')
    await page.getByLabel('目标仓库', { exact: true }).fill('https://github.com/example/target.git')
    await page.getByRole('button', { name: '创建执行', exact: true }).click()
    await expect(page).toHaveURL(/view=execution&execution=execution-2/)
    await expect(page.getByRole('region', { name: '执行详情', exact: true })).toContainText('同包新批次')
    assert.equal(executions[1].input.caseSetId, executions[0].input.caseSetId)
    assert.equal(executions[1].cases[0].binding, undefined)
    assert.equal(JSON.stringify(executions[0]), finishedSnapshot)
    await page.goBack()
    await page.goBack()
    await expect(page.getByRole('region', { name: '执行详情', exact: true }).getByRole('status')).toContainText('批次已结束')
    await page.getByLabel('导入 JSON', { exact: true }).setInputFiles({ name: 'forged.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...casePackage, assessment: { ...assessment, status: 'qualified' } })) })
    await expect(page.getByRole('alert').filter({ hasText: '服务端重新校验拒绝' })).toBeVisible()
    assert.ok(requests.some(item => item.path.endsWith('/packages/import') && 'package' in (item.body as object)))
    const finishedReads = requests.filter(item => item.path === '/api/testing/executions/execution-1').length
    await page.clock.fastForward(10000)
    assert.equal(requests.filter(item => item.path === '/api/testing/executions/execution-1').length, finishedReads)
    await page.getByRole('link', { name: '用例规划', exact: true }).click()
    await expect(page.getByRole('form', { name: '新建规划' })).toBeVisible()
    const switchedReads = requests.filter(item => item.path === '/api/testing/executions/execution-1').length
    await page.clock.fastForward(10000)
    assert.equal(requests.filter(item => item.path === '/api/testing/executions/execution-1').length, switchedReads)
    await page.getByRole('link', { name: /全新独立规划/ }).click()
    await expect(page.getByRole('button', { name: '重新生成新草稿' })).toBeEnabled()
    await page.getByRole('button', { name: '重新生成新草稿' }).click()
    await expect(page.getByRole('button', { name: '取消规划' })).toBeVisible()
    assert.equal(await page.getByRole('button', { name: '发布用例包' }).isDisabled(), true)
    holdPlanningRead = true
    await page.clock.fastForward(2000)
    await expect.poll(() => !!releasePlanningRead).toBe(true)
    await page.getByRole('button', { name: '取消规划' }).click()
    await expect(page.getByRole('region', { name: '规划详情', exact: true }).getByRole('status').filter({ hasText: /^已取消$/ })).toBeVisible()
    const staleResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/testing/projects/planning-1')
    releasePlanningRead!()
    await staleResponse
    await expect(page.getByRole('region', { name: '规划详情', exact: true }).getByRole('status').filter({ hasText: /^已取消$/ })).toBeVisible()
    assert.equal(JSON.stringify(packages[0]), packageSnapshot)
    await page.getByRole('button', { name: /planning-1 · v1 · 2 条/ }).click()
    await expect(page.getByRole('button', { name: '从此版本创建执行' })).toBeVisible()
    await page.getByRole('button', { name: '从此版本创建执行' }).click()
    await expect(page.getByRole('radio', { name: '默认质量门禁', exact: true })).toBeChecked()
    assert.equal(await page.getByLabel('范围调整理由', { exact: true }).count(), 0)
    assert.equal(await page.getByRole('checkbox', { name: /TC-1/ }).count(), 0)
    unauthenticated = true
    const authReads = requests.filter(item => item.path === '/api/auth/status').length
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(page.locator('.testing-topbar')).toContainText('codeflow-user · 已登录')
    assert.equal(requests.filter(item => item.path === '/api/auth/status').length, authReads)
    await page.reload()
    await expect(page.getByRole('button', { name: '使用 GitHub 登录' })).toBeVisible()
    authStatusFailed = true
    await page.reload()
    await expect(page.getByRole('alert')).toContainText('无法检查登录状态')
    authStatusFailed = false
    authConfigured = false
    await page.getByRole('button', { name: '重试', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('登录尚未配置')
    authConfigured = true
    unauthenticated = false
    await page.reload()
    await expect(page.locator('.testing-topbar')).toContainText('codeflow-user · 已登录')
    unauthenticated = true
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await expect(page.getByRole('button', { name: '使用 GitHub 登录' })).toBeVisible()
    assert.equal(requests.some(item => item.path.startsWith('/api/tasks')), false)
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    await server.close()
    if (process.env.KEEP_UI_SCREENSHOTS === '1') console.log(`Testing workspace screenshots: ${temporary}`)
    else rmSync(temporary, { recursive: true, force: true })
  }
})