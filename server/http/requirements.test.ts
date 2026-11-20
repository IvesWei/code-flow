import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import express from 'express'
import { JsonRequirementRepository } from '../requirements/repository.js'
import { RequirementService } from '../requirements/service.js'
import { registerRequirementsRoutes } from './requirements.js'
import { dualPrdFixture } from '../tests/fixtures/dual-prd.js'
import { unzipSync } from 'fflate'

test('preview HTTP accepts concrete business entries with CAS and rejects foreign or sensitive contexts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'requirements-entry-http-'))
  const repository = new JsonRequirementRepository(root)
  await repository.verify()
  const service = new RequirementService(repository, root, { model: { generate: async () => ({}) } })
  const app = express()
  app.use(express.json())
  registerRequirementsRoutes(app, repository, { root, service, authenticate: async () => ({ ownerId: 7, token: 'fake' }) })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/requirements/projects`
  try {
    const initial = await service.create(7, { title: 'Capture entries', description: 'Existing plan', modelId: 'auto' }, 'fake')
    const patch = (body: unknown) => fetch(`${base}/${initial.id}/preview`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const body = { version: initial.version, origin: 'https://tmp.test.sunmi.com', entryPaths: ['https://tmp.test.sunmi.com/plans?projectId=42'] }
    const accepted = await patch(body)
    assert.equal(accepted.status, 200)
    const saved = await accepted.json()
    assert.deepEqual(saved.preview.entryPaths, ['/plans?projectId=42'])
    assert.equal((await patch(body)).status, 409)
    for (const entry of ['https://evil.invalid/plans?projectId=42', '/plans?sessionId=secret', '/plans?apiKey=secret', '/plans?projectId=1&projectId=2']) {
      const rejected = await patch({ ...body, version: saved.version, entryPaths: [entry] })
      assert.equal(rejected.status, 400)
      assert.match((await rejected.json()).error, /完整业务入口/)
    }
    assert.deepEqual(await service.detail(7, initial.id), saved)
    const entries = Array.from({ length: 13 }, (_value, index) => `/plans?projectId=${index}`)
    assert.equal((await patch({ ...body, version: saved.version, entryPaths: entries })).status, 400)
    const twelve = await patch({ ...body, version: saved.version, entryPaths: entries.slice(0, 12) })
    assert.equal(twelve.status, 200)
    assert.equal((await twelve.json()).preview.entryPaths.length, 12)
  } finally { await service.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) }
})

test('dual PRD HTTP persists both editions, rejects downgrade, and exports an owned two-Word ZIP', async () => {
  const root = await mkdtemp(join(tmpdir(), 'requirements-dual-http-'))
  const repository = new JsonRequirementRepository(root)
  await repository.verify()
  const legacy = { title: '审计记录', summary: '内部范围', blocks: [{ id: 'B1', title: '审计', content: '内部页面', requirementIds: ['R1'], sourceIds: [] }], requirements: [{ id: 'R1', title: '记录审计', description: '保存审计事件', nonVisualReason: '仅处理后台审计事件，没有交互页面', sourceIds: [], acceptance: [{ id: 'A1', text: '审计事件已记录' }] }] }
  const prd = dualPrdFixture(legacy)
  const service = new RequirementService(repository, root, { model: { generate: async (stage, project) => stage === 'analyze' ? { evidence: project.sources.map(source => ({ sourceId: source.id, summary: 'Read supplied facts', limitations: 'Isolated fake model' })), questions: [] } : { prd } } })
  const app = express()
  app.use(express.json())
  registerRequirementsRoutes(app, repository, { root, service, authenticate: async request => Number(request.get('x-owner') ?? 7) ? { ownerId: Number(request.get('x-owner') ?? 7), token: 'fake' } : undefined })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/requirements/projects`
  const request = (path = '', body?: unknown, headers: Record<string, string> = {}, method = 'POST') => fetch(`${base}${path}`, { method: body === undefined ? 'GET' : method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  try {
    let project = await (await request('', { title: '审计需求', description: '记录操作事件', modelId: 'auto' })).json()
    for (const stage of ['analyze', 'prd']) {
      const accepted = await request(`/${project.id}/jobs`, { version: project.version, stage })
      assert.equal(accepted.status, 202)
      await service.wait(project.id)
      project = await (await request(`/${project.id}`)).json()
      assert.equal(project.jobs.at(-1).status, 'succeeded')
    }
    assert.deepEqual(project.revisions[0].prd, prd)
    const downgrade = await request(`/${project.id}/prd`, { version: project.version, prd: legacy }, {}, 'PATCH')
    assert.equal(downgrade.status, 400)
    assert.match((await downgrade.json()).error, /不能移除 templateVersion/)
    assert.deepEqual(await (await request(`/${project.id}`)).json(), project)
    const edited = await request(`/${project.id}/prd`, { version: project.version, prd }, {}, 'PATCH')
    assert.equal(edited.status, 200)
    project = await edited.json()
    assert.equal(project.revisions.length, 2)
    for (const revision of project.revisions) {
      const path = `/${project.id}/exports?format=zip&scope=prd&revision=${revision.id}`
      const response = await request(path)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('content-type'), 'application/zip')
      assert.match(response.headers.get('content-disposition')!, /\.zip/)
      assert.deepEqual(Object.keys(unzipSync(new Uint8Array(await response.arrayBuffer()))), ['业务评审版.docx', '开发规格版.docx'])
      assert.equal((await request(path, undefined, { 'x-owner': '0' })).status, 401)
      assert.equal((await request(path, undefined, { 'x-owner': '8' })).status, 404)
      assert.equal((await request(path, undefined, { origin: 'https://evil.example' })).status, 403)
      assert.equal((await request(path.replace('format=zip', 'format=docx'))).status, 400)
    }
    assert.deepEqual(await (await request(`/${project.id}`)).json(), project)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) }
})

test('PRD restart HTTP bypasses the prior audit only for an explicitly restarted failed job', async () => {
  const root = await mkdtemp(join(tmpdir(), 'requirements-prd-restart-http-'))
  const repository = new JsonRequirementRepository(root)
  await repository.verify()
  const modes: unknown[] = []
  const service = new RequirementService(repository, root, { model: { generate: async (stage, _project, context) => {
    if (stage === 'analyze') return { evidence: [], questions: [] }
    modes.push({ restart: context.restartPrd, prior: !!context.loadPrdAudit })
    throw new Error('fixture draft failure')
  } } })
  const app = express(); app.use(express.json())
  registerRequirementsRoutes(app, repository, { root, service, authenticate: async request => ({ ownerId: Number(request.get('x-owner') ?? 7), token: 'fake' }) })
  const server = app.listen(0, '127.0.0.1')
  try {
    await new Promise<void>(resolve => server.once('listening', resolve))
    let data = await service.create(7, { title: 'Retry', description: 'Keep analysis', modelId: 'auto' }, 'fake')
    const path = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/requirements/projects/${data.id}/jobs`
    const post = (body: Record<string, unknown>, owner = 7) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-owner': String(owner) }, body: JSON.stringify({ version: data.version, ...body }) })
    assert.equal((await post({ stage: 'prd', restartPrd: true })).status, 400)
    for (const body of [{ stage: 'analyze' }, { stage: 'prd' }, { stage: 'prd' }]) {
      assert.equal((await post(body)).status, 202)
      await service.wait(data.id); data = await service.detail(7, data.id)
    }
    for (const restartPrd of [null, false, 1, 'true']) assert.equal((await post({ stage: 'prd', restartPrd })).status, 400)
    assert.equal((await post({ stage: 'analyze', restartPrd: true })).status, 400)
    assert.equal((await post({ stage: 'prd', restartPrd: true }, 8)).status, 404)
    assert.equal((await post({ stage: 'prd', restartPrd: true, version: 1 })).status, 409)
    assert.equal((await post({ stage: 'prd', restartPrd: true })).status, 202)
    await service.wait(data.id)
    assert.deepEqual(modes, [{ restart: false, prior: false }, { restart: false, prior: true }, { restart: true, prior: false }])
  } finally { await service.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) }
})

test('job login HTTP enforces auth, Origin, strict version/action inputs and service arguments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'requirements-login-http-'))
  const repository = new JsonRequirementRepository(root)
  await repository.verify()
  const service = new RequirementService(repository, root)
  const login = service.login.bind(service)
  const calls: Parameters<RequirementService['login']>[] = []
  service.login = async (...args) => {
    calls.push(args)
    return login(...args)
  }
  const app = express()
  app.use(express.json())
  registerRequirementsRoutes(app, repository, { root, service, authenticate: async request => {
    const ownerId = Number(request.get('x-owner') ?? 7)
    return ownerId ? { ownerId, token: 'fake' } : undefined
  } })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  try {
    const project = await service.create(7, { title: 'Login', description: 'Resume capture', modelId: 'auto' }, 'fake')
    const jobId = 'login-job'
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/requirements/projects/${project.id}/jobs/${jobId}/login`
    const body = { version: project.version, action: 'open' }
    const post = (value: unknown, headers: Record<string, string> = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value) })
    assert.equal((await post(body, { 'x-owner': '0' })).status, 401)
    assert.equal((await post(body, { origin: 'https://evil.example' })).status, 403)
    assert.equal(calls.length, 0)
    for (const value of [[], ...['expectedVersion', 'ownerId', 'token', 'password', 'cookie', 'cookies', 'authorization', 'storageState'].map(field => ({ ...body, [field]: 'PRIVATE_SENTINEL' }))]) {
      const response = await post(value)
      assert.equal(response.status, 400)
      assert.doesNotMatch(await response.text(), /PRIVATE_SENTINEL|stack|storageKey/)
    }
    assert.equal(calls.length, 0)
    for (const value of [{}, { action: 'open' }, { version: project.version }, { expectedVersion: project.version, action: 'open' }, ...[null, '1', 0, -1, 1.5, Number.MAX_SAFE_INTEGER].map(version => ({ ...body, version })), ...[null, '', 'OPEN', 'close', 1, {}, []].map(action => ({ ...body, action }))]) {
      const response = await post(value)
      assert.equal(response.status, 400)
      assert.doesNotMatch(await response.text(), /PRIVATE_SENTINEL|stack|storageKey/)
    }
    assert.equal((await post(body, { 'x-owner': '8' })).status, 404)
    assert.equal((await post({ ...body, version: project.version + 1 })).status, 409)
    calls.length = 0
    service.login = async (...args) => {
      calls.push(args)
      return project
    }
    for (const action of ['open', 'continue']) {
      const response = await post({ version: project.version, action })
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.deepEqual(await response.json(), project)
    }
    assert.deepEqual(calls, ['open', 'continue'].map(action => [7, project.id, jobId, { expectedVersion: project.version, action }]))
  } finally {
    await service.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

test('remote code HTTP enforces auth, Origin, strict repository inputs and version contract', async () => {
  const root = await mkdtemp(join(tmpdir(), 'requirements-remote-http-'))
  const repository = new JsonRequirementRepository(root)
  await repository.verify()
  let calls = 0
  const service = new RequirementService(repository, root, { loadRemoteCode: async input => {
    calls++
    return { ...input, commit: 'b'.repeat(40), excluded: 0, files: [{ path: 'src/index.ts', content: 'export const value = 1' }] }
  } })
  const app = express()
  app.use(express.json())
  registerRequirementsRoutes(app, repository, { root, service, authenticate: async request => {
    const ownerId = Number(request.get('x-owner') ?? 7)
    return ownerId ? { ownerId, token: 'fake' } : undefined
  } })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  try {
    const project = await service.create(7, { title: 'Remote', description: 'Improve', modelId: 'auto' }, 'fake')
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/requirements/projects/${project.id}/remote-code-snapshot`
    const body = { version: 1, repository: 'https://github.com/team/orders.git', branch: 'main', directory: 'src' }
    const post = (value: unknown, headers: Record<string, string> = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value) })
    assert.equal((await post(body, { 'x-owner': '0' })).status, 401)
    assert.equal((await post(body, { 'x-owner': '8' })).status, 404)
    assert.equal((await post(body, { origin: 'https://evil.example' })).status, 403)
    assert.equal((await post({ ...body, token: 'sentinel' })).status, 400)
    assert.equal((await post({ ...body, version: 2 })).status, 409)
    assert.equal(calls, 0)
    const response = await post(body)
    assert.equal(response.status, 200)
    assert.equal((await response.json()).sources[0].name, 'existing-project-code.md')
    assert.equal(calls, 1)
  } finally {
    await service.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

test('code snapshot HTTP contract uses version, strict fields, owned CAS and existing 2mb JSON limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'requirements-snapshot-http-'))
  const repository = new JsonRequirementRepository(root)
  await repository.verify()
  const service = new RequirementService(repository, root, { model: { generate: async (_stage, project) => ({ evidence: project.sources.map(source => ({ sourceId: source.id, summary: 'Supplied code', limitations: 'Not executed' })), questions: [] }) } })
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  registerRequirementsRoutes(app, repository, { root, service, authenticate: async request => {
    const ownerId = Number(request.get('x-owner') ?? 7)
    return ownerId ? { ownerId, token: 'fake' } : undefined
  } })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const project = await service.create(7, { title: 'Snapshot', description: 'Read supplied code', modelId: 'auto' }, 'fake')
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/requirements/projects/${project.id}/code-snapshot`
  const files = [{ path: 'src/main.ts', content: 'export const value = 1' }]
  const post = (body: unknown, headers: Record<string, string> = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  try {
    assert.equal((await post({ version: 1, files }, { 'x-owner': '0' })).status, 401)
    assert.equal((await post({ version: 1, files: null }, { 'x-owner': '8' })).status, 404)
    assert.equal((await post({ version: 1, files }, { origin: 'https://evil.example' })).status, 403)
    assert.equal((await post({ version: 2, files: null })).status, 409)
    for (const body of [[], {}, { files }, { version: 1 }, { version: '1', files }, { expectedVersion: 1, files }, ...['ownerId', 'expectedVersion', 'root', 'directory', 'token'].map(field => ({ version: 1, files, [field]: 'PRIVATE_SENTINEL' })), { version: 1, files: [{ ...files[0], extra: 'PRIVATE_SENTINEL' }] }, { version: 1, files: [{ ...files[0], content: '-----BEGIN PRIVATE KEY-----\nPRIVATE_SENTINEL' }] }]) {
      const response = await post(body)
      assert.equal(response.status, 400)
      assert.doesNotMatch(await response.text(), /PRIVATE_SENTINEL|stack|storageKey/)
    }
    const response = await post({ version: 1, files: Array.from({ length: 8 }, (_, index) => ({ path: `${index}.ts`, content: 'a'.repeat(131072) })) })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const saved = await response.json()
    assert.equal(saved.version, 2)
    assert.equal(saved.sources.length, 1)
    assert.equal(saved.sources[0].name, 'existing-project-code.md')
    assert.equal(saved.sources[0].kind, 'file')
    assert.equal((await post({ version: 1, files })).status, 409)
    assert.equal((await post({ version: 2, files: [{ ...files[0], content: 'a'.repeat(131073) }] })).status, 400)
    await service.launch(7, saved.id, { expectedVersion: 2, stage: 'analyze' }, 'fake')
    await service.wait(saved.id)
    const current = await service.detail(7, saved.id)
    const busy = { ...current, version: current.version + 1, status: 'running' as const }
    await repository.replace(busy, current.version)
    assert.equal((await post({ version: busy.version, files: null })).status, 409)
  } finally {
    await service.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

test('HTTP frontend contracts: auth, Origin, namespace 503, CAS, strict keys, multipart and owned exports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'requirements-http-'))
  const repository = new JsonRequirementRepository(root)
  await repository.verify()
  const prd = { title: 'Editor', summary: 'Save text', blocks: [{ id: 'B-1', title: 'Editor', content: 'Save', requirementIds: ['REQ-1'], sourceIds: [] }], requirements: [{ id: 'REQ-1', title: 'Save', description: 'Persist', acceptance: [{ id: 'AC-1', text: 'Saved' }], sourceIds: [] }] }
  const service = new RequirementService(repository, root, { model: { generate: async (stage, project) => stage === 'analyze' ? { evidence: project.sources.map(source => ({ sourceId: source.id, summary: 'Read supplied facts', limitations: 'Fake model only' })), questions: [] } : { prd } } })
  const app = express()
  app.use(express.json({ limit: '4mb' }))
  const authenticate = async (request: express.Request) => Number(request.get('x-owner') ?? 7) ? { ownerId: Number(request.get('x-owner') ?? 7), token: 'fake' } : undefined
  registerRequirementsRoutes(app, repository, { root, service, authenticate })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/requirements/projects`
  const request = (path = '', body?: unknown, headers: Record<string, string> = {}, method = 'POST') => fetch(`${base}${path}`, { method: body === undefined ? 'GET' : method, headers: { ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }) })
  try {
    const input = { title: 'Editor', description: 'Save', modelId: 'auto' }
    assert.equal((await request('', input, { 'x-owner': '0' })).status, 401)
    assert.equal((await request('', input, { origin: 'https://evil.example' })).status, 403)
    assert.equal((await request('', { ...input, ownerId: 8 })).status, 400)
    assert.equal((await request('', { ...input, modelId: '' })).status, 400)
    const created = await request('', input)
    assert.equal(created.status, 201)
    let project = await created.json()
    assert.equal((await request(`/${project.id}`, undefined, { 'x-owner': '8' })).status, 404)
    assert.equal((await request(`/${project.id}/sources`, { version: '1', url: 'https://example.com' })).status, 400)
    assert.equal((await request(`/${project.id}/sources`, { version: 1, url: 'http://127.0.0.1/private' })).status, 400)
    const form = new FormData()
    form.set('version', String(project.version))
    form.append('files', new Blob(['Source facts']), 'source.md')
    const uploaded = await request(`/${project.id}/sources`, form)
    assert.equal(uploaded.status, 200)
    project = await uploaded.json()
    assert.equal(project.sources[0].name, 'source.md')
    assert.match(project.sources[0].storageKey, new RegExp(`requirements/sources/7/${project.id}/`))
    assert.equal((await request(`/${project.id}/jobs`, { version: 1, stage: 'analyze' })).status, 409)
    assert.equal((await request(`/${project.id}/jobs`, { version: project.version, stage: 'analyze', token: 'injected' })).status, 400)
    assert.equal((await request(`/${project.id}/jobs`, { version: project.version, stage: 'design', validationFeedback: { reason: 'forged' } })).status, 400)
    assert.equal((await request(`/${project.id}/exports?format=md&revision=missing`, undefined, { 'x-owner': '8' })).status, 404)
    assert.equal((await request(`/${project.id}/exports?format=md&revision=missing`, undefined, { 'x-owner': '0' })).status, 401)
    assert.equal((await request(`/${project.id}/exports?format=md&revision=missing`)).status, 404)
    assert.equal((await request(`/${project.id}/screenshots/invalid?revision=missing`)).status, 400)
    const jobPath = `/${project.id}/jobs`
    assert.equal((await request(jobPath, { version: project.version, stage: 'analyze' })).status, 202)
    await service.wait(project.id)
    project = await (await request(`/${project.id}`)).json()
    assert.equal(project.evidence.length, 1)
    assert.equal((await request(jobPath, { version: project.version, stage: 'prd' })).status, 202)
    await service.wait(project.id)
    project = await (await request(`/${project.id}`)).json()
    const edited = await request(`/${project.id}/prd`, { version: project.version, prd: { ...prd, summary: 'Edited scope' } }, {}, 'PATCH')
    assert.equal(edited.status, 200)
    project = await edited.json()
    assert.equal(project.revisions.length, 2)
    const revision = project.revisions.at(-1).id
    const exported = await request(`/${project.id}/exports?format=md&revision=${revision}`)
    assert.equal(exported.status, 200)
    assert.equal((await request(`/${project.id}/exports?format=md&revision=${revision}`, undefined, { 'x-owner': '8' })).status, 404)
    assert.equal((await request(`/${project.id}/exports?format=md&revision=${revision}`, undefined, { origin: 'https://evil.example' })).status, 403)
    assert.match(exported.headers.get('content-disposition')!, /attachment/)
    assert.match(await exported.text(), /Discussion draft/)
    assert.equal((await request(`/${project.id}/exports?format=zip&revision=${revision}`)).status, 200)
    const prdExportPath = `/${project.id}/exports?format=docx&scope=prd&revision=${revision}`
    assert.equal((await request(prdExportPath, undefined, { 'x-owner': '0' })).status, 401)
    assert.equal((await request(prdExportPath, undefined, { 'x-owner': '8' })).status, 404)
    assert.equal((await request(prdExportPath, undefined, { origin: 'https://evil.example' })).status, 403)
    const missingScreenshots = await request(prdExportPath)
    assert.equal(missingScreenshots.status, 409)
    assert.match((await missingScreenshots.json()).error, /缺少完整的原型截图/)
    assert.equal((await request(`/${project.id}/exports?format=md&scope=prd&revision=${revision}`)).status, 400)
    assert.equal((await request(`/${project.id}/exports?format=docx&scope=unknown&revision=${revision}`)).status, 400)
    assert.equal((await request(`/${project.id}/exports?format=docx&scope=prd&scope=full&revision=${revision}`)).status, 400)
    assert.equal((await request(`/${project.id}/exports?format=docx&scope=prd&extra=1&revision=${revision}`)).status, 400)
    assert.deepEqual(await (await request(`/${project.id}`)).json(), project)
    const screens = [{ id: 'SCREEN-1', title: 'Manual editor', state: 'normal', requirementIds: ['REQ-1'], acceptanceIds: ['AC-1'], html: '<!doctype html><html><body><main data-requirement-id="REQ-1">Saved text</main></body></html>' }]
    const designPath = `/${project.id}/design`
    assert.equal((await request(designPath, { version: project.version, screens }, {}, 'PATCH')).status, 409)
    const confirmed = await request(`/${project.id}/confirm`, { version: project.version, target: 'prd' })
    assert.equal(confirmed.status, 200)
    project = await confirmed.json()
    assert.equal((await request(`/${project.id}/prd`, { version: project.version, prd }, {}, 'PATCH')).status, 409)
    const beforeDesign = structuredClone(project)
    const designBody = { version: project.version, screens }
    assert.equal((await request(designPath, designBody, { 'x-owner': '0' }, 'PATCH')).status, 401)
    assert.equal((await request(designPath, designBody, { 'x-owner': '8' }, 'PATCH')).status, 404)
    assert.equal((await request(designPath, designBody, { origin: 'https://evil.example' }, 'PATCH')).status, 403)
    for (const body of [[], {}, { screens }, { version: project.version }, { expectedVersion: project.version, screens }, ...['expectedVersion', 'ownerId', 'prd', 'revisionId', 'confirmedAt', 'screenshots', 'validation', 'designConfirmedAt'].map(field => ({ ...designBody, [field]: 'SECRET_RAW_INPUT' })), ...[null, '1', 0, -1, 1.5, Number.MAX_SAFE_INTEGER].map(version => ({ ...designBody, version }))]) {
      const response = await request(designPath, body, {}, 'PATCH')
      assert.equal(response.status, 400)
      assert.doesNotMatch(await response.text(), /SECRET_RAW_INPUT|stack|storageKey/)
    }
    for (const invalidScreens of [null, [], {}, [screens[0], screens[0]], [{ ...screens[0], requirementIds: ['REQ-MISSING'] }], [{ ...screens[0], acceptanceIds: ['AC-MISSING'] }], [{ ...screens[0], validation: {} }], [{ ...screens[0], html: 'SECRET_RAW_INPUT' }], Array.from({ length: 41 }, (_value, index) => ({ ...screens[0], id: `SCREEN-${index}` }))]) {
      const response = await request(designPath, { ...designBody, screens: invalidScreens }, {}, 'PATCH')
      assert.equal(response.status, 400)
      assert.deepEqual(await response.json(), { error: 'Invalid structured design screens' })
    }
    assert.equal((await request(designPath, { ...designBody, version: project.version - 1 }, {}, 'PATCH')).status, 409)
    assert.deepEqual(await (await request(`/${project.id}`)).json(), beforeDesign)
    const savedDesign = await request(designPath, designBody, {}, 'PATCH')
    assert.equal(savedDesign.status, 200)
    assert.equal(savedDesign.headers.get('cache-control'), 'no-store')
    project = await savedDesign.json()
    assert.equal(project.version, beforeDesign.version + 1)
    assert.equal(project.status, 'design_review')
    assert.deepEqual(project.revisions.slice(0, -1), beforeDesign.revisions)
    const design = project.revisions.at(-1)
    assert.match(design.id, /^[a-f0-9-]{36}$/)
    assert.match(design.screens[0].id, /^[a-f0-9-]{36}$/)
    assert.notEqual(design.screens[0].id, screens[0].id)
    assert.deepEqual(design.screens[0], { ...screens[0], id: design.screens[0].id })
    assert.deepEqual(design.prd, beforeDesign.revisions.at(-1).prd)
    assert.equal(design.confirmedAt, beforeDesign.revisions.at(-1).confirmedAt)
    for (const field of ['screenshots', 'validation', 'designConfirmedAt']) assert.equal(Object.hasOwn(design, field), false)
    for (const field of ['sources', 'evidence', 'questions', 'decisions', 'jobs']) assert.deepEqual(project[field], beforeDesign[field])
    assert.deepEqual(project.events.slice(0, -1), beforeDesign.events)
    assert.equal(project.events.at(-1).text, `prd:${design.id}`)
    assert.equal((await request(designPath, designBody, {}, 'PATCH')).status, 409)
    assert.equal((await request(`/${project.id}/confirm`, { version: project.version, target: 'design' })).status, 409)
    assert.equal((await request(`/${project.id}/revisions`, { version: project.version, instruction: 'Add empty state' })).status, 200)
    const unavailable = express()
    registerRequirementsRoutes(unavailable, undefined, { root, authenticate, unavailableReason: 'unavailable' })
    unavailable.get('/api/health', (_request, response) => response.json({ ok: true }))
    const isolated = unavailable.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => isolated.once('listening', resolve))
    try {
      const url = `http://127.0.0.1:${(isolated.address() as AddressInfo).port}`
      assert.equal((await fetch(`${url}/api/requirements/projects`)).status, 503)
      assert.equal((await fetch(`${url}/api/health`)).status, 200)
    } finally { await new Promise<void>(resolve => isolated.close(() => resolve())) }
  } finally { await service.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) }
})