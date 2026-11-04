import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath, unlink, writeFile } from 'node:fs/promises'
import { extname, isAbsolute, join, relative } from 'node:path'
import type { Express, Request, Response } from 'express'
import multer from 'multer'
import type { CasePackage, ExecutionInput, PlanningInput, TestingRepository, TestingSource } from '../../shared/testing.js'
import { availableModels, validateModel } from '../execution/models.js'
import { allowedWorkbenchOrigin } from '../security/access.js'
import { uploadName } from '../tasks/upload-name.js'
import { CasePlanningService, PlanningError } from '../testing/planning-service.js'
import { planningDigest } from '../testing/planning-model.js'
import { importCasePackage } from '../testing/package-import.js'
import { ExecutionError, TestExecutionService } from '../testing/execution-service.js'
import { TESTING_LIST_LIMIT, TestingConflictError, TestingContractError, TestingStorageUnavailableError } from '../testing/repository.js'
import { parseExecutionBindingApproval } from './execution-binding.js'
import { buildCaseExecutionFingerprint } from '../verification/playwright-test.js'
type ExecutionService = Pick<TestExecutionService, 'create' | 'prepare' | 'binding' | 'approve' | 'start' | 'cancel' | 'report'> & Partial<Pick<TestExecutionService, 'implement' | 'install'>>

export interface TestingRouteOptions {
  root: string
  authenticate: (request: Request) => Promise<{ ownerId: number; token: string } | undefined>
  planning?: Pick<CasePlanningService, 'create' | 'generate' | 'publish' | 'cancel'> & Partial<Pick<CasePlanningService, 'detail' | 'answer' | 'editCase' | 'publishScope'>>
  execution?: ExecutionService
  unavailableReason?: string
  availableModels?: typeof availableModels
  importPackage?: (ownerId: number, value: unknown, token: string) => Promise<CasePackage>
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

const maxFileSize = 12 * 1024 * 1024
const extensions = new Set(['.md', '.txt', '.pdf', '.png', '.jpg', '.jpeg', '.webp'])
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const storageMessage = '测试存储不可用，请检查测试模块表结构及存储权限后重试；不会回退到其他存储。'
const planningErrors = {
  NOT_FOUND: [404, '规划不存在或无权访问。'], INVALID_INPUT: [400, '规划输入或来源无效，请检查文件和字段。'],
  CONFLICT: [409, '记录已变化或操作进行中，请刷新后重试。'], SOURCE_CHANGED: [409, '来源已变化，请重新上传并生成。'],
  UNQUALIFIED: [409, '请先完成用例生成与合格的设计审查，再发布。'], CANCELLED: [409, '操作已取消，请刷新记录。'],
  NEEDS_INPUT: [409, '请补充需求或规划指令后重新生成。'], MODEL_FAILED: [502, '模型调用失败，请查看已保存草稿并重试。'], STORAGE_FAILED: [503, storageMessage],
  BASELINE_INVALID: [502, '模型返回的需求基线格式无效，一次格式修正后仍未通过校验；尚未进入用例生成，请重新生成。'],
  REVIEW_INVALID: [502, '设计审查返回格式无效，已保存的草稿检查点仍可使用，请重新审查。'],
} as const

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '请提交有效的 JSON 对象。')
  return value as Record<string, unknown>
}

function errorResponse(response: Response, error: unknown) {
  if (error instanceof HttpError) return response.status(error.status).json({ error: error.message })
  if (error instanceof PlanningError) {
    const [status, message] = planningErrors[error.code]
    if (error.code === 'INVALID_INPUT' && error.field) {
      const fields: Record<NonNullable<PlanningError['field']>, string> = {
        title: '规划标题不能为空，且不能超过 200 个字符。',
        requirements: '请填写需求正文或上传需求文档；需求正文不能超过 200000 个字符。',
        instruction: '规划指令可留空，但必须是文本且不能超过 50000 个字符。',
        modelId: '规划模型标识无效，请重新选择模型。',
        sources: '来源文件无效、不可读取或已不存在，请移除后重新上传；请勿上传凭证或密钥文件。',
        referenceRepository: '参考仓库须为 GitHub HTTPS 仓库首页地址，例如 https://github.com/owner/repo；不要填写分支页面、查询参数或账号凭证。不需要参考仓库时可留空。',
        referenceBranch: '参考分支须与参考仓库一起填写，且不能包含空格、连续点号或以连字符开头；不指定分支时可留空。',
      }
      return response.status(status).json({ error: fields[error.field], field: error.field })
    }
    return response.status(status).json({ error: message })
  }
  if (error instanceof ExecutionError) {
    const errors = {
      NOT_FOUND: [404, '执行或用例包不存在或无权访问。'], INVALID_INPUT: [400, '执行输入或绑定无效，请检查字段。'],
      CONFLICT: [409, '执行已变化或正忙，请刷新后重试或新建执行。'], UNQUALIFIED: [409, '请先发布通过设计审查的用例包。'],
      SOURCE_CHANGED: [409, '执行来源已变化，请新建执行并重新确认绑定。'],
      PREPARATION_FAILED: [503, '环境准备失败，请检查仓库、分支和本地运行依赖后重试。'], STORAGE_FAILED: [503, storageMessage],
    } as const
    const [status, message] = errors[error.code]
    return response.status(status).json({ error: message })
  }
  if (error instanceof TestingConflictError) return response.status(409).json({ error: '记录已变化，请刷新后重试。' })
  if (error instanceof TestingContractError) return response.status(400).json({ error: '测试数据格式无效，请检查输入。' })
  if (error instanceof TestingStorageUnavailableError) return response.status(503).json({ error: storageMessage })
  return response.status(503).json({ error: '测试操作暂不可用，请刷新记录并检查服务配置后重试。' })
}

async function sourceDirectory(root: string, ownerId: number): Promise<string> {
  const canonical = await realpath(root)
  let directory = canonical
  for (const part of ['testing', 'sources', String(ownerId)]) {
    directory = join(directory, part)
    await mkdir(directory, { recursive: true })
    const local = relative(canonical, await realpath(directory))
    if ((await lstat(directory)).isSymbolicLink() || isAbsolute(local) || local.split(/[\\/]/).includes('..')) throw new HttpError(400, '上传目录不安全，请检查存储目录。')
  }
  return directory
}

export function registerTestingRoutes(app: Express, repository: TestingRepository | undefined, options: TestingRouteOptions): void {
  const planning = options.planning ?? (repository ? new CasePlanningService(repository, options.root) : undefined)
  const execution: ExecutionService | undefined = options.execution ?? (repository ? new TestExecutionService(repository, options.root) : undefined)
  const importPackage = options.importPackage ?? ((ownerId: number, value: unknown, token: string) => importCasePackage(repository!, options.root, ownerId, value, token))
  const active = new Map<string, Promise<void>>()
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxFileSize, files: 7, fields: 1, parts: 8, fieldSize: 100 }, fileFilter: (_request, file, done) => {
    if (!extensions.has(extname(uploadName(file.originalname)).toLowerCase())) return done(new Error('Unsupported source extension'))
    done(null, true)
  } }).array('files', 7)
  const executionService = (): ExecutionService => execution!
  type User = { ownerId: number; token: string }
  type Action = (request: Request, response: Response, user: User) => Promise<unknown>
  const route = (method: 'get' | 'post', path: string, action: Action) => app[method](`/api/testing${path}`, async (request, response) => {
    response.set('Cache-Control', 'no-store')
    try {
      if (!allowedWorkbenchOrigin(request.get('origin'))) throw new HttpError(403, '请求来源不受信任，请从工作台重试。')
      const user = await options.authenticate(request)
      if (!user || !Number.isSafeInteger(user.ownerId) || user.ownerId <= 0) throw new HttpError(401, '请先登录后重试。')
      if (!repository) throw new HttpError(503, storageMessage)
      return await action(request, response, user)
    } catch (error) { return errorResponse(response, error) }
  })
  const owned = async <Kind extends 'project' | 'package' | 'execution'>(kind: Kind, id: string, ownerId: number) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,190}$/.test(id)) throw new HttpError(404, '记录不存在或无权访问。')
    const record = await repository!.get(kind, id, ownerId)
    if (!record || ('ownerId' in record && record.ownerId !== ownerId)) throw new HttpError(404, '记录不存在或无权访问。')
    return record
  }
  const idle = (key: string) => { if (active.has(key)) throw new HttpError(409, '操作进行中，请稍后刷新。') }
  const launch = async (kind: 'project' | 'execution', id: string, ownerId: number, work: () => Promise<unknown>, response: Response) => {
    const key = `${kind}:${ownerId}:${id}`
    idle(key)
    let settled = false
    let failure: unknown
    const operation = Promise.resolve().then(work).then(() => { settled = true }, error => { settled = true; failure = error })
    active.set(key, operation)
    void operation.finally(() => { if (active.get(key) === operation) active.delete(key) })
    await Promise.race([operation, new Promise<void>(done => setImmediate(done))])
    if (settled && failure && !(failure instanceof PlanningError && failure.code === 'NEEDS_INPUT')) throw failure
    return response.status(202).json(await owned(kind, id, ownerId))
  }

  route('post', '/sources', async (request, response, user) => {
    await new Promise<void>((done, reject) => upload(request, response, error => error ? reject(new HttpError(400, '上传失败：最多 7 个文件，每个不超过 12 MiB，仅支持 md/txt/pdf/png/jpg/webp。')) : done()))
    const files = request.files as Express.Multer.File[]
    const kind = request.body?.kind
    if (!['requirements', 'design'].includes(kind) || !files?.length || files.some(file => file.size === 0)) throw new HttpError(400, '请选择来源类型并上传支持的非空文件。')
    if (files.some(file => !(kind === 'requirements' ? /\.(?:md|txt|pdf)$/i : /\.(?:png|jpe?g|webp)$/i).test(uploadName(file.originalname)))) throw new HttpError(400, '需求来源仅支持 md/txt/pdf，设计来源仅支持 png/jpg/webp 图片。')
    const directory = await sourceDirectory(options.root, user.ownerId)
    const written: string[] = []
    try {
      const sources: TestingSource[] = []
      for (const file of files) {
        const name = uploadName(file.originalname)
        if (name.length > 200 || /[\\/]|\p{Cc}/u.test(name)) throw new HttpError(400, '文件名无效，请重命名后上传。')
        const id = randomUUID(), extension = extname(name).toLowerCase()
        const target = join(directory, `${id}${extension}`)
        await writeFile(target, file.buffer, { flag: 'wx' })
        written.push(target)
        sources.push({ id, name, kind, sha256: createHash('sha256').update(file.buffer).digest('hex'), sizeBytes: file.size, storageKey: `testing/sources/${user.ownerId}/${id}${extension}` })
      }
      return response.status(201).json(sources)
    } catch (error) { await Promise.all(written.map(file => unlink(file).catch(() => {}))); throw error }
  })
  for (const [path, kind] of [['projects', 'project'], ['packages', 'package'], ['executions', 'execution']] as const) {
    route('get', `/${path}`, async (_request, response, user) => response.set('X-Result-Limit', String(TESTING_LIST_LIMIT)).json((await repository!.list(kind, user.ownerId)).slice(0, TESTING_LIST_LIMIT)))
  }
  route('post', '/projects', async (request, response, user) => {
    const input = object(request.body) as unknown as PlanningInput
    if (!Array.isArray(input.sources) || input.sources.length > 7) throw new HttpError(400, '来源文件最多 7 个。')
    for (const source of input.sources) {
      if (!source || typeof source.storageKey !== 'string' || !new RegExp(`^testing/sources/${user.ownerId}/(${uuid})\\.(md|txt|pdf|png|jpg|jpeg|webp)$`, 'i').test(source.storageKey)
        || source.storageKey.split('/').at(-1)?.split('.')[0] !== source.id || !Number.isSafeInteger(source.sizeBytes) || source.sizeBytes <= 0 || source.sizeBytes > maxFileSize) throw new HttpError(400, '来源必须是当前账号上传的文件，请重新上传。')
      if (!(source.kind === 'requirements' ? /\.(?:md|txt|pdf)$/i : source.kind === 'design' ? /\.(?:png|jpe?g|webp)$/i : /$^/).test(source.storageKey)) throw new HttpError(400, '来源类型与文件格式不匹配。')
    }
    return response.status(201).json(await planning!.create(user.ownerId, input))
  })
  route('post', '/packages/import', async (request, response, user) => {
    const value = object(object(request.body).package)
    if (typeof value.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,190}$/.test(value.id)) {
      const existing = await repository!.get('package', value.id, user.ownerId)
      if (existing && planningDigest(existing) === planningDigest(value)) return response.json(existing)
    }
    return response.status(201).json(await importPackage(user.ownerId, value, user.token))
  })
  route('get', '/packages/:id/export', async (request, response, user) => {
    const value = await owned('package', String(request.params.id), user.ownerId)
    return response.set('Content-Disposition', `attachment; filename="package-${value.id}.json"`).json(value)
  })
  for (const [path, kind] of [['projects', 'project'], ['packages', 'package'], ['executions', 'execution']] as const) {
    route('get', `/${path}/:id`, async (request, response, user) => {
      const record = await owned(kind, String(request.params.id), user.ownerId)
      return response.json(kind === 'project' && planning?.detail ? await planning.detail(user.ownerId, record.id) : record)
    })
  }
  route('post', '/projects/:id/generate', async (request, response, user) => {
    const id = String(request.params.id), project = await owned('project', id, user.ownerId)
    idle(`project:${user.ownerId}:${id}`)
    if (project.status === 'running') throw new HttpError(409, '规划正在进行，请稍后刷新。')
    try { validateModel(project.input.modelId, project.input.modelId === 'auto' ? [] : await (options.availableModels ?? availableModels)(user.token), project.input.sources.some(source => /\.(png|jpe?g|webp)$/i.test(source.name))) }
    catch { throw new HttpError(400, '无法使用所选模型，请检查账号权限及图片支持后重新选择。') }
    return launch('project', id, user.ownerId, () => planning!.generate(user.ownerId, id, user.token), response)
  })
  route('post', '/projects/:id/answer', async (request, response, user) => {
    const id = String(request.params.id), project = await owned('project', id, user.ownerId)
    idle(`project:${user.ownerId}:${id}`)
    if (!planning?.answer) throw new HttpError(503, '当前服务尚不支持规划问题答复。')
    const body = object(request.body)
    if (typeof body.questionId !== 'string' || typeof body.answer !== 'string' || !body.answer.trim() || body.answer.length > 3000 || !Number.isSafeInteger(body.version)) throw new HttpError(400, '请选择选项或填写不超过 3000 字的答复。')
    try { validateModel(project.input.modelId, project.input.modelId === 'auto' ? [] : await (options.availableModels ?? availableModels)(user.token), project.input.sources.some(source => /\.(png|jpe?g|webp)$/i.test(source.name))) }
    catch { throw new HttpError(400, '无法使用所选模型，请检查账号权限及图片支持。') }
    await planning.answer(user.ownerId, id, body.questionId, body.answer, body.version as number)
    return launch('project', id, user.ownerId, () => planning!.generate(user.ownerId, id, user.token), response)
  })
  route('post', '/projects/:id/cases/:caseId', async (request, response, user) => {
    const id = String(request.params.id), project = await owned('project', id, user.ownerId)
    idle(`project:${user.ownerId}:${id}`)
    if (!planning?.editCase) throw new HttpError(503, '当前服务尚不支持编辑规划用例。')
    const body = object(request.body)
    if (!Number.isSafeInteger(body.version) || body.version !== project.version) throw new HttpError(409, '草稿已变化，请刷新后重新编辑。')
    if (project.status === 'running' || project.question) throw new HttpError(409, '请等待当前操作完成或先答复待确认问题。')
    if (Object.keys(body).some(key => !['version', 'caseDefinition'].includes(key))) throw new HttpError(400, '仅允许提交版本和用例定义。')
    return response.json(await planning.editCase(user.ownerId, id, String(request.params.caseId), body.version as number, body.caseDefinition))
  })
  for (const action of ['continue', 'review', 'optimize'] as const) route('post', `/projects/:id/${action}`, async (request, response, user) => {
    const id = String(request.params.id), project = await owned('project', id, user.ownerId)
    idle(`project:${user.ownerId}:${id}`)
    const body = object(request.body)
    if (!Number.isSafeInteger(body.version) || body.version !== project.version) throw new HttpError(409, '草稿已变化，请刷新后重新确认范围。')
    if (project.status === 'running' || project.question) throw new HttpError(409, '请等待当前操作完成或先答复待确认问题。')
    if (action === 'optimize' && (Object.keys(body).some(key => !['version', 'caseIds', 'reason', 'regenerate'].includes(key)) || !Array.isArray(body.caseIds) || body.caseIds.length !== 1 || body.regenerate !== undefined && typeof body.regenerate !== 'boolean')) throw new HttpError(400, '请选择一条用例并提交有效的优化或重新生成请求。')
    if (body.caseIds !== undefined && (action === 'continue' || !Array.isArray(body.caseIds) || !body.caseIds.length || body.caseIds.length > 1000 || body.caseIds.some(id => typeof id !== 'string') || new Set(body.caseIds).size !== body.caseIds.length || typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 2000)) throw new HttpError(400, '请选择有效用例范围并填写不超过 2000 字的理由。')
    try { validateModel(project.input.modelId, project.input.modelId === 'auto' ? [] : await (options.availableModels ?? availableModels)(user.token), project.input.sources.some(source => /\.(png|jpe?g|webp)$/i.test(source.name))) }
    catch { throw new HttpError(400, '无法使用所选模型，请检查账号权限及图片支持。') }
    return launch('project', id, user.ownerId, () => planning!.generate(user.ownerId, id, user.token, { mode: action, version: body.version as number, ...(body.caseIds === undefined ? {} : { caseIds: body.caseIds as string[], reason: body.reason as string }), ...(action === 'optimize' && body.regenerate !== undefined ? { regenerate: body.regenerate as boolean } : {}) }), response)
  })
  route('post', '/projects/:id/publish-scope', async (request, response, user) => {
    const id = String(request.params.id)
    await owned('project', id, user.ownerId)
    idle(`project:${user.ownerId}:${id}`)
    if (!planning?.publishScope) throw new HttpError(503, 'Scoped publication is unavailable.')
    const body = object(request.body)
    if (Object.keys(body).some(key => !['version', 'caseIds', 'reason'].includes(key)) || !Number.isSafeInteger(body.version) || Number(body.version) <= 0
      || !Array.isArray(body.caseIds) || !body.caseIds.length || body.caseIds.length > 1000 || body.caseIds.some(id => typeof id !== 'string') || new Set(body.caseIds).size !== body.caseIds.length
      || typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 2000) throw new HttpError(400, 'Invalid scoped publication version, case IDs or reason.')
    return response.json(await planning.publishScope(user.ownerId, id, body.version as number, body.caseIds as string[], body.reason))
  })
  for (const action of ['publish', 'cancel'] as const) route('post', `/projects/:id/${action}`, async (request, response, user) => {
    const id = String(request.params.id)
    await owned('project', id, user.ownerId)
    if (action === 'publish') idle(`project:${user.ownerId}:${id}`)
    return response.json(await planning![action](user.ownerId, id))
  })
  route('post', '/executions', async (request, response, user) => {
    const input = object(request.body) as unknown as ExecutionInput
    await owned('package', String(input.caseSetId), user.ownerId)
    return response.status(201).json(await executionService().create(user.ownerId, input))
  })
  for (const action of ['prepare', 'start', 'cancel'] as const) route('post', `/executions/:id/${action}`, async (request, response, user) => {
    const id = String(request.params.id), run = await owned('execution', id, user.ownerId)
    const service = executionService()
    if (action === 'cancel') return response.json(await service.cancel(user.ownerId, id))
    if (action === 'start' && (run.status !== 'ready' || !run.cases.some(item => item.selected) || run.cases.some(item => item.selected && !item.binding))) throw new HttpError(409, '请先准备环境并人工确认全部所选用例绑定，再开始执行。')
    if (['preparing', 'running'].includes(run.status)) throw new HttpError(409, '执行操作进行中，请稍后刷新。')
    return launch('execution', id, user.ownerId, () => action === 'prepare' ? service.prepare(user.ownerId, id, user.token) : service.start(user.ownerId, id), response)
  })
  route('get', '/executions/:id/report', async (request, response, user) => {
    const id = String(request.params.id)
    await owned('execution', id, user.ownerId)
    return response.json(await executionService().report(user.ownerId, id))
  })
  for (const action of ['implement', 'install'] as const) route('post', `/executions/:id/${action}`, async (request, response, user) => {
    const id = String(request.params.id), run = await owned('execution', id, user.ownerId)
    idle(`execution:${user.ownerId}:${id}`)
    if (['preparing', 'running'].includes(run.status)) throw new HttpError(409, '执行操作进行中，请稍后刷新。')
    if (action === 'install' && object(request.body).confirm !== true) throw new HttpError(400, '安装依赖前必须明确确认。')
    const service = executionService()
    const work = action === 'implement' ? service.implement && (() => service.implement!(user.ownerId, id, user.token)) : service.install && (() => service.install!(user.ownerId, id))
    if (!work) throw new HttpError(503, '当前执行服务暂不支持此操作。')
    return launch('execution', id, user.ownerId, work, response)
  })
  for (const method of ['get', 'post'] as const) route(method, '/executions/:id/bindings/:caseId', async (request, response, user) => {
    const id = String(request.params.id), caseId = String(request.params.caseId)
    const run = await owned('execution', id, user.ownerId)
    if (!run.cases.some(item => item.caseId === caseId)) throw new HttpError(404, '用例不存在。')
    idle(`execution:${user.ownerId}:${id}`)
    if (['preparing', 'running'].includes(run.status)) throw new HttpError(409, '请等待执行空闲后确认绑定。')
    const service = executionService(), binding = await service.binding(user.ownerId, id, caseId)
    if (method === 'get') return response.json({ ...binding, caseId, caseFingerprint: buildCaseExecutionFingerprint(binding.testCase), designFingerprint: run.workspaceFingerprint })
    let approval: ReturnType<typeof parseExecutionBindingApproval>
    try { approval = parseExecutionBindingApproval(request.body, binding.manifest) }
    catch { throw new HttpError(400, '请明确确认完整的用例断言映射，不得提交服务器授权字段。') }
    return response.json({ caseId, binding: await service.approve(user.ownerId, id, caseId, approval) })
  })
}