import type { Express, Request, Response } from 'express'
import multer from 'multer'
import { readRequirementScreenshot } from '../requirements/artifacts.js'
import type { RequirementRepository } from '../../shared/requirements.js'
import { allowedWorkbenchOrigin } from '../security/access.js'
import { uploadName } from '../tasks/upload-name.js'
import { SOURCE_MAX_BYTES } from '../requirements/sources.js'
import { readSourceFile } from '../requirements/sources.js'
import { RequirementService, RequirementServiceError, requirementObject } from '../requirements/service.js'
import { RequirementContractError, RequirementConflictError, RequirementStorageUnavailableError } from '../requirements/repository.js'

export interface RequirementsRouteOptions {
  root: string
  authenticate(request: Request): Promise<{ ownerId: number; token: string } | undefined>
  service?: RequirementService
  unavailableReason?: string
}
type RequirementRequest = Request<{ id: string; jobId: string; screenId: string }>
function sendError(response: Response, error: unknown) {
  if (error instanceof RequirementServiceError) return response.status(error.statusCode).json({ error: error.message })
  if (error instanceof RequirementConflictError) return response.status(409).json({ error: 'Project changed; refresh and retry' })
  if (error instanceof RequirementContractError) return response.status(400).json({ error: 'Invalid requirement data' })
  if (error instanceof RequirementStorageUnavailableError) return response.status(503).json({ error: 'Requirement storage unavailable' })
  if (error instanceof SyntaxError || error instanceof multer.MulterError || (error as { status?: number })?.status === 400) return response.status(400).json({ error: 'Invalid request body or upload' })
  if ((error as { status?: number })?.status === 413) return response.status(413).json({ error: 'Request body too large' })
  return response.status(503).json({ error: 'Requirements operation unavailable; check sources, artifacts and storage' })
}
function mutation(value: unknown, fields: string[], multipart = false) {
  const body = requirementObject(value, ['version', ...fields])
  const expectedVersion = multipart && typeof body.version === 'string' && /^[1-9]\d{0,15}$/.test(body.version) ? Number(body.version) : body.version
  const { version: _version, ...rest } = body
  return { ...rest, expectedVersion }
}
export function registerRequirementsRoutes(app: Express, repository: RequirementRepository | undefined, options: RequirementsRouteOptions): RequirementService | undefined {
  const service = options.service ?? (repository ? new RequirementService(repository, options.root) : undefined)
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: SOURCE_MAX_BYTES, files: 7, fields: 1, parts: 8, fieldSize: 32 } }).array('files', 7)
  type User = { ownerId: number; token: string }
  const route = (method: 'get' | 'post' | 'patch', path: string, action: (request: RequirementRequest, response: Response, user: User) => Promise<unknown>) => {
    app[method](`/api/requirements/projects${path}`, async (request: RequirementRequest, response) => {
      response.set('Cache-Control', 'no-store')
      response.set('X-Content-Type-Options', 'nosniff')
      try {
        if (!allowedWorkbenchOrigin(request.get('origin'))) throw new RequirementServiceError(403, 'Untrusted request Origin')
        const user = await options.authenticate(request)
        if (!user || !Number.isSafeInteger(user.ownerId) || user.ownerId < 1) throw new RequirementServiceError(401, 'Authentication required')
        if (!service || options.unavailableReason) throw new RequirementServiceError(503, 'Requirements storage unavailable; verify schema, permissions and runtime lease')
        return await action(request, response, user)
      } catch (error) { return sendError(response, error) }
    })
  }
  route('get', '', async (_request, response, user) => response.json(await service!.list(user.ownerId)))
  route('post', '', async (request, response, user) => response.status(201).json(await service!.create(user.ownerId, request.body, user.token)))
  route('get', '/:id', async (request, response, user) => response.json(await service!.detailWithSourceProvenance(user.ownerId, request.params.id)))
  route('patch', '/:id/preview', async (request, response, user) => response.json(await service!.configurePreview(user.ownerId, request.params.id, mutation(request.body, ['origin', 'entryPaths']), user.token)))
  route('get', '/:id/existing-pages/:screenId', async (request, response, user) => {
    const query = requirementObject(request.query, ['revision'])
    const project = await service!.detail(user.ownerId, request.params.id)
    const page = project.revisions.find(revision => revision.id === query.revision)?.existingPages?.find(page => page.image.id === request.params.screenId)
    if (!page) throw new RequirementServiceError(404, 'Existing page capture not found')
    const file = await readSourceFile(options.root, user.ownerId, project.id, page.image)
    return response.type('png').send(file.buffer)
  })
  route('get', '/:id/source-reconstructions/:screenId', async (request, response, user) => {
    const query = requirementObject(request.query, ['revision'])
    const project = await service!.detail(user.ownerId, request.params.id)
    const entry = project.revisions.find(revision => revision.id === query.revision)?.capturePlan?.sourceFallback?.images?.find(entry => entry.image.id === request.params.screenId)
    if (!entry) throw new RequirementServiceError(404, 'Source reconstruction not found')
    const file = await readSourceFile(options.root, user.ownerId, project.id, entry.image)
    return response.type('png').send(file.buffer)
  })
  route('post', '/:id/sources', async (request, response, user) => {
    await service!.detail(user.ownerId, request.params.id)
    const multipart = !!request.is('multipart/form-data')
    if (multipart) await new Promise<void>((resolve, reject) => upload(request, response, error => error ? reject(error) : resolve()))
    const body = mutation(request.body, multipart ? [] : ['url'], multipart)
    const files = multipart ? (request.files as Express.Multer.File[] || []).map(file => ({ name: uploadName(file.originalname), buffer: file.buffer })) : []
    return response.json(await service!.addSources(user.ownerId, request.params.id, body, files, user.token))
  })
  route('post', '/:id/code-snapshot', async (request, response, user) => response.json(await service!.addCodeSnapshot(user.ownerId, request.params.id, mutation(request.body, ['files']))))
  route('post', '/:id/remote-code-snapshot', async (request, response, user) => {
    const controller = new AbortController()
    const disconnect = () => { if (!response.writableEnded) controller.abort() }
    response.once('close', disconnect)
    try { return response.json(await service!.addRemoteCodeSnapshot(user.ownerId, request.params.id, mutation(request.body, ['repository', 'branch', 'directory']), controller.signal)) }
    finally { response.removeListener('close', disconnect) }
  })
  route('post', '/:id/answers', async (request, response, user) => response.json(await service!.answers(user.ownerId, request.params.id, mutation(request.body, ['answers']))))
  route('patch', '/:id/prd', async (request, response, user) => response.json(await service!.editPrd(user.ownerId, request.params.id, mutation(request.body, ['prd']))))
  route('patch', '/:id/design', async (request, response, user) => response.json(await service!.editDesign(user.ownerId, request.params.id, mutation(request.body, ['screens']))))
  route('post', '/:id/revisions', async (request, response, user) => response.json(await service!.revise(user.ownerId, request.params.id, mutation(request.body, ['instruction']))))
  route('post', '/:id/confirm', async (request, response, user) => response.json(await service!.confirm(user.ownerId, request.params.id, mutation(request.body, ['target']))))
  route('post', '/:id/jobs', async (request, response, user) => response.status(202).json(await service!.launch(user.ownerId, request.params.id, mutation(request.body, ['stage', 'instruction', 'screenId', 'revisionId', 'restartPrd']), user.token)))
  route('post', '/:id/jobs/:jobId/cancel', async (request, response, user) => response.json(await service!.cancel(user.ownerId, request.params.id, request.params.jobId, mutation(request.body, []))))
  route('post', '/:id/jobs/:jobId/login', async (request, response, user) => response.json(await service!.login(user.ownerId, request.params.id, request.params.jobId, mutation(request.body, ['action']))))
  route('get', '/:id/exports', async (request, response, user) => {
    const query = requirementObject(request.query, ['revision', 'format', 'scope'])
    if (typeof query.revision !== 'string' || typeof query.format !== 'string') throw new RequirementServiceError(400, 'Specify revision and format')
    const artifact = await service!.export(user.ownerId, request.params.id, query.revision, query.format, query.scope)
    response.set('Content-Disposition', `attachment; filename="${artifact.filename}"`)
    response.set('Content-Security-Policy', "default-src 'none'; sandbox")
    return response.type(artifact.contentType).send(artifact.buffer)
  })
  route('get', '/:id/screenshots/:screenId', async (request, response, user) => {
    const query = requirementObject(request.query, ['revision'])
    if (typeof query.revision !== 'string' || !/^[a-f0-9-]{36}$/.test(request.params.screenId)) throw new RequirementServiceError(400, 'Invalid screenshot identity')
    const project = await service!.detail(user.ownerId, request.params.id)
    const revision = project.revisions.find(item => item.id === query.revision)
    if (!revision?.screenshots?.some(item => item.screenId === request.params.screenId)) throw new RequirementServiceError(404, 'Screenshot not found')
    const image = await readRequirementScreenshot(project, revision, request.params.screenId, options.root)
    return response.type('png').send(image)
  })
  return service
}