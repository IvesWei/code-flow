import express from 'express'
import multer from 'multer'
import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, extname, resolve } from 'node:path'
import type { CodingTask } from '../shared/task.js'
import { casePolicy, parseAcceptanceSelection, requestedCaseIds } from '../shared/test-policy.js'
import { run, validateRepository } from './git/git.js'
import { TaskStorageError } from './tasks/store.js'
import { CodingWorker } from './execution/worker.js'
import { authCallback, authLogout, authStart, authenticatedUser, authStatus, oauthConfigured, sessionUser } from './security/auth.js'
import { allowedWorkbenchOrigin, ownsTask } from './security/access.js'
import { fileDiff } from './git/changes.js'
import { uploadName } from './tasks/upload-name.js'
import { localPreviewUrl } from './verification/browser-automation.js'
import { taskDetail } from './tasks/task-summary.js'
import { registerTaskReads } from './http/task-reads.js'
import { registerExecutionBindings } from './http/execution-binding.js'
import { publicationSnapshot, publishBranch } from './git/publish.js'
import { availableModels, defaultModel, validateModel } from './execution/models.js'
import { initializeTaskStorage, loadStorageEnvironment } from './storage/storage-runtime.js'
import { storageResponse } from './http/storage-response.js'
import { StartupDiagnostics, startupErrorCode } from './execution/startup-diagnostics.js'
import { initializeTestingStorage } from './testing/runtime.js'
import { registerTestingRoutes } from './http/testing.js'
import { registerTestingLinks } from './http/testing-links.js'
import { initializeRequirementsStorage } from './requirements/runtime.js'
import { registerRequirementsRoutes } from './http/requirements.js'

console.log(`[startup] API 入口开始，PID ${process.pid}，Node ${process.version}`)
const startup = new StartupDiagnostics()
await startup.run('环境配置加载', () => loadStorageEnvironment()).catch(() => process.exit(1))
const root = resolve(process.env.DATA_DIR || 'data')
const storage = await initializeTaskStorage(join(root, 'tasks.json'), startup).catch(() => process.exit(1))
console.log(`[startup] 存储初始化完成，模式：${storage.backend}`)
const testingStorage = await initializeTestingStorage(root, storage.backend)
if (testingStorage.error) console.error(`[startup] ${testingStorage.error}`)
const requirementsStorage = await initializeRequirementsStorage(root, storage.backend)
if (requirementsStorage.error) console.error(`[startup] ${requirementsStorage.error}`)
const store = storage.store
const worker = new CodingWorker(store, root)
const publishing = new Set<string>()
const app = express()
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 7 },
})

app.disable('x-powered-by')
app.use('/api/testing', express.json({ limit: '4mb' }))
app.use('/api/requirements', express.json({ limit: '4mb' }))
app.use(express.json({ limit: '32kb' }))
app.use('/api', (request, response, next) => {
  const origin = request.get('origin')
  if (request.method !== 'GET' && !allowedWorkbenchOrigin(origin)) {
    return response.status(403).json({ error: '仅允许从本地工作台提交任务' })
  }
  return next()
})

app.get('/api/health', async (_request, response) => {
  try { await storage.health(); return response.json({ ok: true, storage: storage.backend }) }
  catch (error) {
    console.error(`[health] Storage check failed (${startupErrorCode(error)})`)
    return response.status(503).json({ ok: false, storage: storage.backend, error: '任务存储不可用' })
  }
})
app.use('/api/auth', (_request, response, next) => { response.set('Cache-Control', 'no-store'); next() })
app.get('/api/auth/status', (request, response) => { void authStatus(request, response) })
app.get('/api/auth/start', authStart)
app.get('/api/auth/callback', (request, response) => { void authCallback(request, response) })
app.post('/api/auth/logout', authLogout)
app.use('/api/testing', (_request, response, next) => {
  if (testingStorage.error) return response.status(503).json({ error: testingStorage.error })
  return next()
})
registerTestingRoutes(app, testingStorage.repository, { root, authenticate: authenticatedUser, unavailableReason: testingStorage.error })
const requirementsService = registerRequirementsRoutes(app, requirementsStorage.repository, { root, authenticate: authenticatedUser, unavailableReason: requirementsStorage.error })
app.use('/api', storageResponse(store))
app.get('/api/copilot/models', async (request, response) => {
  response.set('Cache-Control', 'no-store')
  try {
    const user = await authenticatedUser(request)
    if (!user) return response.status(401).json({ error: 'Copilot 登录已失效，请重新登录' })
    const models = await availableModels(user.token)
    return response.json({ defaultModelId: defaultModel(), models: models.map((model) => ({
      id: model.id, name: model.name, policy: model.policy?.state,
      vision: model.capabilities.supports.vision, multiplier: model.billing?.multiplier,
    })) })
  } catch { return response.status(503).json({ error: '暂时无法获取可用模型，请稍后重试' }) }
})
registerTaskReads(app, store, (request) => sessionUser(request)?.ownerId)
registerTestingLinks(app, store, testingStorage.repository, { authenticate: authenticatedUser, isBusy: (id) => worker.isRunning(id) || publishing.has(id) })
registerExecutionBindings(app, store, { root, authenticate: authenticatedUser, isBusy: (id) => worker.isRunning(id) || publishing.has(id) })
async function committedTask(id: string): Promise<CodingTask> {
  await store.flush()
  const task = store.committed(id)
  if (!task) throw new TaskStorageError('任务存储不可用')
  return taskDetail(task)
}

app.get('/api/tasks/:id/automation/:caseId', (request, response) => {
  response.set('Cache-Control', 'no-store')
  const task = response.locals.task as CodingTask
  if (!task || !ownsTask(task, sessionUser(request)?.ownerId)) return response.status(404).json({ error: '任务不存在' })
  const run = task.automationRuns?.find((item) => item.caseId === request.params.caseId)
  if (!run || !task.selfTests?.some((item) => item.id === run.caseId)) return response.status(404).json({ error: '自动化任务不存在' })
  return response.json({ run, testCase: task.selfTests.find((item) => item.id === run.caseId) })
})

app.get('/api/tasks/:id/automation/:caseId/screenshot', async (request, response) => {
  response.set('Cache-Control', 'no-store')
  const task = response.locals.task as CodingTask
  if (!task || !ownsTask(task, sessionUser(request)?.ownerId)) return response.status(404).json({ error: '任务不存在' })
  const filename = task.automationRuns?.find((item) => item.caseId === request.params.caseId)?.screenshot
  if (!filename || !/^TC-\d{2}-[0-9a-f-]{36}\.png$/.test(filename)) return response.status(404).json({ error: '截图不存在' })
  try {
    const image = await readFile(join(root, 'evidence', task.id, filename))
    response.type('png')
    return response.send(image)
  } catch { return response.status(404).json({ error: '截图不存在' }) }
})

app.get('/api/tasks/:id/diff', async (request, response) => {
  response.set('Cache-Control', 'no-store')
  const task = response.locals.task as CodingTask
  if (!task || !ownsTask(task, sessionUser(request)?.ownerId)) return response.status(404).json({ error: '任务不存在' })
  if (!task.workspace || task.workspace !== join(root, 'workspaces', task.id)) return response.status(409).json({ error: '任务工作目录不可用' })
  if (typeof request.query.path !== 'string') return response.status(400).json({ error: '请选择变更文件' })
  try {
    return response.json({ diff: await fileDiff(task, request.query.path) })
  } catch (error) {
    return response.status(400).json({ error: error instanceof Error ? error.message : '无法读取文件差异' })
  }
})

app.post('/api/tasks', upload.fields([{ name: 'prd', maxCount: 1 }, { name: 'designs', maxCount: 6 }]), async (request, response) => {
  try {
    if (!oauthConfigured()) return response.status(503).json({ error: '请先配置本地 OAuth 凭据文件或部署环境中的 GitHub OAuth App 凭据' })
    const user = await authenticatedUser(request)
    if (!user) return response.status(401).json({ error: 'Copilot 登录已失效，请重新登录' })
    if (await store.hasBusyTasks()) {
      return response.status(409).json({ error: '同一时间只能执行一个任务，请先完成当前任务' })
    }
    const repository = validateRepository(String(request.body.repository || '').trim())
    const branch = String(request.body.branch || '').trim()
    const instruction = String(request.body.instruction || '').trim()
    const automationUrl = request.body.automationUrl ? localPreviewUrl(String(request.body.automationUrl)) : undefined
    if (branch && !/^[\w./-]{1,100}$/.test(branch)) throw new Error('分支名称格式不正确')
    if (instruction.length < 5 || instruction.length > 5000) throw new Error('请输入 5 至 5000 字的编码目标')
    const files = request.files as Record<string, Express.Multer.File[]> | undefined
    const prd = files?.prd?.[0]
    const designs = files?.designs || []
    if (prd) prd.originalname = uploadName(prd.originalname)
    for (const file of designs) file.originalname = uploadName(file.originalname)
    if (!prd || !/\.(md|txt|pdf)$/i.test(prd.originalname)) throw new Error('请上传 Markdown、TXT 或 PDF 格式的 PRD')
    if (designs.some((file) => !/\.(png|jpe?g|webp)$/i.test(file.originalname))) throw new Error('设计图支持 PNG、JPG 或 WebP')
    const requestedModel = request.body.modelId === undefined ? defaultModel() : request.body.modelId
    const modelId = validateModel(requestedModel, requestedModel === 'auto' ? [] : await availableModels(user.token), designs.length > 0)

    const id = randomUUID()
    const uploads = join(root, 'uploads', id)
    await mkdir(uploads, { recursive: true })
    const prdPath = join(uploads, `prd${extname(prd.originalname).toLowerCase()}`)
    await writeFile(prdPath, prd.buffer)
    const designPaths = await Promise.all(designs.map(async (file, index) => {
      const path = join(uploads, `design-${index}${extname(file.originalname).toLowerCase()}`)
      await writeFile(path, file.buffer)
      return path
    }))
    const now = new Date().toISOString()
    const task: CodingTask = {
      id, ownerId: user.ownerId, repository, branch: branch || undefined, instruction, automationUrl, modelId,
      modelRevision: 0, appliedModelRevision: 0,
      prdName: prd.originalname, designNames: designs.map((file) => file.originalname),
      status: 'QUEUED', createdAt: now, updatedAt: now,
      entries: [{ at: now, kind: 'info', text: '任务已创建' }],
    }
    store.create(task)
    void worker.execute(task, prdPath, designPaths, user.token)
    return response.status(201).json(await committedTask(task.id))
  } catch (error) {
    return response.status(400).json({ error: error instanceof Error ? error.message : String(error) })
  }
})

app.put('/api/tasks/:id/model', async (request, response) => {
  const task = response.locals.task as CodingTask
  if (!task || !ownsTask(task, sessionUser(request)?.ownerId)) return response.status(404).json({ error: '任务不存在' })
  try {
    const user = await authenticatedUser(request)
    if (!user) return response.status(401).json({ error: 'Copilot 登录已失效，请重新登录' })
    const { modelId, expectedRevision } = request.body || {}
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== (task.modelRevision || 0)) return response.status(409).json({ error: '模型选择已更新，请刷新任务后重试', task: await committedTask(task.id) })
    const selected = validateModel(modelId, modelId === 'auto' ? [] : await availableModels(user.token), task.designNames.length > 0)
    const latest = (await store.loadTask(task.id))!
    if (expectedRevision !== (latest.modelRevision || 0)) return response.status(409).json({ error: '模型选择已更新，请刷新任务后重试', task: await committedTask(task.id) })
    if (selected === latest.modelId) return response.json(await committedTask(task.id))
    const revision = (latest.modelRevision || 0) + 1
    const now = new Date().toISOString()
    const previous = latest.modelId || latest.activeModelId || defaultModel()
    store.update(task.id, { modelId: selected, modelRevision: revision, modelHistory: [...(latest.modelHistory || []).map((change) => !change.appliedAt && !change.supersededAt ? { ...change, supersededAt: now } : change), { at: now, from: previous, to: selected, revision }] })
    store.entry(task.id, 'info', `用户已选择模型 ${selected}，将在下一次 Copilot 对话中使用`)
    return response.json(await committedTask(task.id))
  } catch (error) { return response.status(400).json({ error: error instanceof Error ? error.message : '无法切换模型' }) }
})

app.post('/api/tasks/:id/answer', async (request, response) => {
  const task = response.locals.task as CodingTask
  if (!task || !ownsTask(task, sessionUser(request)?.ownerId)) {
    return response.status(404).json({ error: '任务不存在' })
  }
  const answer = request.body?.answer
  if (typeof answer !== 'string' || !answer.trim() || answer.length > 3000) {
    return response.status(400).json({ error: '请输入不超过 3000 字的回答' })
  }
  if (!worker.answer(request.params.id, answer.trim())) {
    return response.status(409).json({ error: '任务没有待回答的问题，或回答不属于提供的选项' })
  }
  return response.json(await committedTask(task.id))
})

app.post('/api/tasks/:id/accept', async (request, response) => {
  const task = response.locals.task as CodingTask
  if (!task || !ownsTask(task, sessionUser(request)?.ownerId)) return response.status(404).json({ error: '任务不存在' })
  if (task.status !== 'REVIEW' || worker.isRunning(task.id)) return response.status(409).json({ error: '只有已停止的待验收任务可确认接受' })
  store.status(task.id, 'ACCEPTED', '用户已查看并接受当前自测结果，未通过或未执行的用例仍需关注')
  return response.json(await committedTask(task.id))
})

app.post('/api/tasks/:id/publication/refresh', async (request, response) => {
  const task = response.locals.task as CodingTask
  if (!task || !ownsTask(task, sessionUser(request)?.ownerId)) return response.status(404).json({ error: '任务不存在' })
  if (task.status !== 'PUBLISH_PENDING' || publishing.has(task.id) || worker.isRunning(task.id)) return response.status(409).json({ error: '任务尚未准备好刷新待推送清单' })
  if (task.publication?.commit) return response.status(409).json({ error: '本地提交已创建，不能重新选择文件；可重试推送或跳过' })
  if (task.workspace !== join(root, 'workspaces', task.id)) return response.status(409).json({ error: '任务工作目录不可用' })
  publishing.add(task.id)
  try {
    if (!await authenticatedUser(request)) return response.status(401).json({ error: 'Copilot 登录已失效，请重新登录' })
    if (task.publication?.baseCommit && await run('git', ['rev-parse', 'HEAD'], task.workspace, 15_000) !== task.publication.baseCommit) {
      return response.status(409).json({ error: '本地提交已经产生，请重试确认推送，不能刷新审批清单' })
    }
    const publication = await publicationSnapshot(task, task.workspace)
    store.update(task.id, { publication, changes: publication.files })
    return response.json(await committedTask(task.id))
  } catch (error) {
    store.update(task.id, { publication: { files: [], snapshot: '', error: error instanceof Error ? error.message : String(error) } })
    return response.status(409).json({ error: error instanceof Error ? error.message : '无法刷新待推送清单' })
  } finally { publishing.delete(task.id) }
})

app.post('/api/tasks/:id/publication/confirm', async (request, response) => {
  const task = response.locals.task as CodingTask
  if (!task || !ownsTask(task, sessionUser(request)?.ownerId)) return response.status(404).json({ error: '任务不存在' })
  if (task.status !== 'PUBLISH_PENDING' || publishing.has(task.id) || worker.isRunning(task.id)) return response.status(409).json({ error: '任务尚未准备好推送' })
  if (task.workspace !== join(root, 'workspaces', task.id)) return response.status(409).json({ error: '任务工作目录不可用' })
  if (typeof request.body?.snapshot !== 'string' || !/^[a-f0-9]{64}$/.test(request.body.snapshot)) return response.status(400).json({ error: '请先刷新并确认待推送清单' })
  publishing.add(task.id)
  try {
    const user = await authenticatedUser(request)
    if (!user) return response.status(401).json({ error: 'Copilot 登录已失效，请重新登录' })
    await store.flush()
    const commit = await publishBranch(task, task.workspace, request.body.snapshot, async (saved) => {
      store.update(task.id, { publication: { ...task.publication!, commit: saved, error: undefined } })
      await store.flush()
    })
    store.update(task.id, { publication: { ...task.publication!, commit, pushedAt: new Date().toISOString(), error: undefined } })
    store.entry(task.id, 'info', `任务分支 ${task.createdBranch} 已推送，提交 ${commit}`)
    await startPublishedSelfTest(task, user.token)
    return response.json(await committedTask(task.id))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    store.update(task.id, { publication: { ...task.publication!, error: message } })
    store.entry(task.id, 'error', `推送未完成：${message}`)
    return response.status(409).json({ error: message })
  } finally { publishing.delete(task.id) }
})

app.post('/api/tasks/:id/publication/skip', async (request, response) => {
  const task = response.locals.task as CodingTask
  if (!task || !ownsTask(task, sessionUser(request)?.ownerId)) return response.status(404).json({ error: '任务不存在' })
  if (task.status !== 'PUBLISH_PENDING' || task.publication?.pushedAt || publishing.has(task.id) || worker.isRunning(task.id)) return response.status(409).json({ error: '任务尚未准备好跳过推送' })
  if (task.workspace !== join(root, 'workspaces', task.id)) return response.status(409).json({ error: '任务工作目录不可用' })
  if (request.body?.skip !== true) return response.status(400).json({ error: '请明确确认跳过推送' })
  publishing.add(task.id)
  try {
    const user = await authenticatedUser(request)
    if (!user) return response.status(401).json({ error: 'Copilot 登录已失效，请重新登录' })
    store.update(task.id, { publication: { ...task.publication!, skipped: true, error: undefined } })
    store.entry(task.id, 'warning', '用户选择跳过远端推送，仅保留本地代码')
    await startPublishedSelfTest(task, user.token)
    return response.json(await committedTask(task.id))
  } catch (error) {
    return response.status(409).json({ error: error instanceof Error ? error.message : '无法继续生成用例' })
  } finally { publishing.delete(task.id) }
})

async function startPublishedSelfTest(task: CodingTask, token: string): Promise<void> {
  await store.flush()
  const workspace = join(root, 'workspaces', task.id)
  await access(workspace)
  const branch = await run('git', ['branch', '--show-current'], workspace, 15_000)
  if (branch.trim() !== task.createdBranch) throw new Error('任务分支已改变，无法生成用例')
  const prdPath = join(root, 'uploads', task.id, `prd${extname(task.prdName).toLowerCase()}`)
  const designPaths = task.designNames.map((name, index) => join(root, 'uploads', task.id, `design-${index}${extname(name).toLowerCase()}`))
  await Promise.all([prdPath, ...designPaths].map((path) => access(path)))
  store.update(task.id, { status: 'SELF_TEST' })
  void worker.execute(task, prdPath, designPaths, token, undefined, true)
}

app.post('/api/tasks/:id/self-test', async (request, response) => {
  const task = response.locals.task as CodingTask
  if (!task || !ownsTask(task, sessionUser(request)?.ownerId)) return response.status(404).json({ error: '任务不存在' })
  let selectedCaseIds: string[]
  const intent = request.body?.intent ?? 'execute'
  if (!['execute', 'repair'].includes(intent)) return response.status(400).json({ error: '请选择执行已有用例或修正用例' })
  let selection = task.acceptanceSelection
  try {
    selectedCaseIds = requestedCaseIds(request.body?.selectedCaseIds, task.selfTests || [])
    if (Object.prototype.hasOwnProperty.call(request.body || {}, 'acceptanceSelection')) selection = parseAcceptanceSelection(request.body.acceptanceSelection, task.selfTests || [])
  }
  catch (error) { return response.status(400).json({ error: (error as Error).message }) }
  if (intent === 'execute' && !selection && (task.acceptanceAssessment?.status !== 'qualified' || task.selfTestDraft)) return response.status(409).json({ error: '默认质量门禁未通过。请明确修正问题用例，或确认自定义必验范围；填写测试地址不会重新生成用例。' })
  const browserRequested = !!task.automationUrl || !!request.body?.automationUrl
  const retryable = task.acceptanceAssessment?.status !== 'qualified' || !task.selfTests?.length || !!task.selfTestDraft || selectedCaseIds.length > 0 || task.selfTests.some((item) => casePolicy(task.acceptanceBaseline || [], item).selected && (['pending', 'invalid', 'failed', 'skipped', 'running'].includes(item.status) || (browserRequested && !item.testFile && item.status === 'manual' && !task.automationRuns?.some((run) => run.caseId === item.id))))
  if (!['SUCCESS', 'REVIEW', 'ACCEPTED'].includes(task.status) || (intent === 'repair' && !retryable) || worker.isRunning(task.id)) return response.status(409).json({ error: '只有已结束且可继续处理的任务可启动' })
  if (await store.hasBusyTasks()) return response.status(409).json({ error: '请等待当前任务结束' })
  if (!task.workspace || task.workspace !== join(root, 'workspaces', task.id) || !task.createdBranch) return response.status(409).json({ error: '原工作目录不存在' })
  try {
    const user = await authenticatedUser(request)
    if (!user) return response.status(401).json({ error: 'Copilot 登录已失效，请重新登录' })
    await access(task.workspace)
    const branch = await run('git', ['branch', '--show-current'], task.workspace, 15_000)
    if (branch.trim() !== task.createdBranch) return response.status(409).json({ error: '任务分支已改变' })
    const prdPath = join(root, 'uploads', task.id, `prd${extname(task.prdName).toLowerCase()}`)
    const designPaths = task.designNames.map((name, index) => join(root, 'uploads', task.id, `design-${index}${extname(name).toLowerCase()}`))
    await Promise.all([prdPath, ...designPaths].map((path) => access(path)))
    if (request.body?.automationUrl) store.update(task.id, { automationUrl: localPreviewUrl(String(request.body.automationUrl)) })
    if (Object.prototype.hasOwnProperty.call(request.body || {}, 'acceptanceSelection')) {
      store.update(task.id, { acceptanceSelection: selection, executionAssessment: undefined, acceptanceSelectionHistory: selection ? [...(task.acceptanceSelectionHistory || []), selection] : task.acceptanceSelectionHistory })
      store.entry(task.id, 'info', selection ? `用户确认自定义验收范围：${selection.caseIds.length} 条；理由：${selection.reason}` : '用户恢复默认质量门禁', selection ? selection.caseIds.join(', ') : undefined)
    }
    await store.flush()
    void worker.execute((await store.loadTask(task.id))!, prdPath, designPaths, user.token, undefined, true, request.body?.allowNewSession === true, selectedCaseIds, intent)
    return response.json(await committedTask(task.id))
  } catch (error) {
    return response.status(409).json({ error: error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT' ? '原工作目录或附件不存在' : '无法开始编码自测' })
  }
})

app.post('/api/tasks/:id/resume', async (request, response) => {
  const task = response.locals.task as CodingTask
  if (!task || !ownsTask(task, sessionUser(request)?.ownerId)) return response.status(404).json({ error: '任务不存在' })
  if (!['FAILED', 'REVIEW'].includes(task.status) || worker.isRunning(task.id)) return response.status(409).json({ error: '只有已停止的失败或待验收任务可以继续' })
  if (await store.hasBusyTasks()) return response.status(409).json({ error: '请等待当前任务结束' })
  const guidance = request.body?.guidance
  if (typeof guidance !== 'string' || !guidance.trim() || guidance.length > 3000) return response.status(400).json({ error: '请输入 1 至 3000 字的补充说明' })
  if (!task.workspace || task.workspace !== join(root, 'workspaces', task.id) || !task.createdBranch) return response.status(409).json({ error: '原工作目录不存在，请重新创建任务' })
  try {
    const user = await authenticatedUser(request)
    if (!user) return response.status(401).json({ error: 'Copilot 登录已失效，请重新登录' })
    await access(task.workspace)
    const branch = await run('git', ['branch', '--show-current'], task.workspace, 15_000)
    if (branch.trim() !== task.createdBranch) return response.status(409).json({ error: '任务分支已改变，请检查工作目录后重新创建任务' })
    const prdPath = join(root, 'uploads', task.id, `prd${extname(task.prdName).toLowerCase()}`)
    const designPaths = task.designNames.map((name, index) => join(root, 'uploads', task.id, `design-${index}${extname(name).toLowerCase()}`))
    await Promise.all([prdPath, ...designPaths].map((path) => access(path)))
    store.update(task.id, { status: 'CODING', question: undefined })
    store.entry(task.id, 'answer', `用户补充说明：${guidance.trim()}`)
    void worker.execute(task, prdPath, designPaths, user.token, guidance.trim(), false, request.body?.allowNewSession === true)
    return response.json(await committedTask(task.id))
  } catch (error) {
    return response.status(409).json({ error: error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT' ? '原工作目录或附件不存在，请重新创建任务' : '无法继续任务，请检查原工作目录' })
  }
})

app.use((error: Error, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  response.status(error instanceof TaskStorageError ? 503 : 400).json({ error: error.message })
})

const port = Number(process.env.PORT || 3001)
async function closeStorage(): Promise<void> {
  try { await requirementsService?.close() }
  finally {
    try { await requirementsStorage.close() }
    finally { try { await testingStorage.close() } finally { await storage.close() } }
  }
}
const listening = startup.begin('API 端口监听')
const server = app.listen(port, '127.0.0.1', (error?: Error) => {
  if (error) return
  listening.complete()
  console.log(`API listening on http://127.0.0.1:${port} (storage: ${storage.backend})`)
})
server.on('error', (error) => {
  listening.fail(error)
  console.error(startupErrorCode(error) === 'EADDRINUSE' ? `[startup] API 端口 ${port} 已被占用，请停止原后台实例` : '[startup] API 监听失败，请根据错误代码检查端口与监听权限')
  void startup.run('监听失败后释放存储', closeStorage).catch(() => {}).finally(() => process.exit(1))
})
let shuttingDown = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[shutdown] 收到 ${signal}，正在关闭 API 与存储`)
    server.close()
    void startup.run('关闭存储与保存待写入任务', closeStorage).then(() => process.exit(0)).catch(() => {
      console.error('后台关闭时任务数据未能保存，请检查数据库')
      process.exit(1)
    })
  })
}