import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { PoolOptions } from 'mysql2/promise'
import type { ExecutionRun, PlanningProject } from '../../shared/testing.js'
import type { DatabaseConfig } from '../storage/database-config.js'
import { createTestingRepository, MemoryTestingRepository } from './repository.js'
import { acquireTestingRuntimeLease, initializeTestingStorage, type TestingStorageDependencies } from './runtime.js'

const config: DatabaseConfig = {
  host: 'fake-host', port: 3307, user: 'fake-user', password: 'fake-password', database: 'fake-database',
  connectionLimit: 7, connectTimeout: 1200, tls: true, caFile: 'fake-ca.pem',
}

function fixture() {
  const calls: string[] = []
  const repository = new MemoryTestingRepository()
  const pool = {
    query: async () => { throw new Error('Unexpected SQL') },
    getConnection: async () => { throw new Error('Unexpected task connection or lock') },
    end: async () => { calls.push('close') },
  }
  const dependencies: TestingStorageDependencies = {
    acquireLease: async () => ({ release: async () => {} }),
    config: () => { calls.push('config'); return config },
    readCa: async file => { assert.equal(file, config.caFile); calls.push('ca'); return 'fake-ca' },
    createPool: () => { calls.push('pool'); return pool },
    createRepository: async (backend, root, actualPool) => {
      assert.equal(backend, 'mysql'); assert.equal(root, 'unused'); assert.equal(actualPool, pool)
      calls.push('verify'); return repository
    },
  }
  repository.recover = async () => { calls.push('recover') }
  return { calls, repository, pool, dependencies }
}

test('mysql owns a separate pool with task-equivalent options and recovers before returning', async () => {
  const { dependencies, calls, pool, repository } = fixture()
  let options: PoolOptions | undefined
  dependencies.createPool = value => { options = value; calls.push('pool'); return pool }
  const runtime = await initializeTestingStorage('unused', 'mysql', dependencies)
  assert.equal(runtime.repository, repository)
  assert.equal(runtime.error, undefined)
  assert.deepEqual(calls, ['config', 'ca', 'pool', 'verify', 'recover'])
  assert.deepEqual(options, {
    host: config.host, port: config.port, user: config.user, password: config.password, database: config.database,
    connectionLimit: 7, connectTimeout: 1200, waitForConnections: true, queueLimit: 100,
    enableKeepAlive: true, keepAliveInitialDelay: 0, charset: 'utf8mb4', timezone: 'Z', multipleStatements: false,
    ssl: { rejectUnauthorized: true, ca: 'fake-ca' },
  })
  await Promise.all([runtime.close(), runtime.close()])
  assert.equal(calls.filter(call => call === 'close').length, 1)
})

test('mysql without TLS or CA preserves pool defaults', async () => {
  const { dependencies, pool } = fixture()
  dependencies.config = () => ({ ...config, tls: false, caFile: undefined })
  dependencies.readCa = async () => { throw new Error('Unexpected CA read') }
  dependencies.createPool = options => { assert.equal(options.ssl, undefined); return pool }
  const runtime = await initializeTestingStorage('unused', 'mysql', dependencies)
  assert.ok(runtime.repository)
  await runtime.close()
})

for (const stage of ['config', 'ca', 'pool', 'verify', 'recover'] as const) {
  test(`mysql ${stage} failure is sanitized, disables testing and never falls back`, async () => {
    const { dependencies, calls, repository } = fixture()
    const fail = () => { throw new Error('secret-password host=private /private/ca.pem') }
    if (stage === 'config') dependencies.config = fail
    if (stage === 'ca') dependencies.readCa = fail
    if (stage === 'pool') dependencies.createPool = fail
    if (stage === 'verify') dependencies.createRepository = async backend => { assert.equal(backend, 'mysql'); fail() }
    if (stage === 'recover') repository.recover = fail
    const runtime = await initializeTestingStorage('unused', 'mysql', dependencies)
    assert.equal(runtime.repository, undefined)
    assert.match(runtime.error!, /sql\/mysql-testing-schema\.sql/)
    assert.match(runtime.error!, /重启 API/)
    assert.match(runtime.error!, /不会回退到 JSON/)
    assert.doesNotMatch(runtime.error!, /secret-password|private/)
    await runtime.close()
    assert.equal(calls.filter(call => call === 'close').length, ['verify', 'recover'].includes(stage) ? 1 : 0)
    if (stage === 'verify') assert.ok(!calls.includes('recover'))
  })
}

test('mysql requires configuration even if the environment would otherwise choose JSON', async () => {
  const { dependencies, calls } = fixture()
  dependencies.config = () => undefined
  const runtime = await initializeTestingStorage('unused', 'mysql', dependencies)
  assert.equal(runtime.repository, undefined)
  assert.match(runtime.error!, /不会回退到 JSON/)
  assert.deepEqual(calls, [])
})

test('cleanup failure does not leak initialization or close diagnostics and pool ends once', async () => {
  const { dependencies, pool } = fixture()
  let closes = 0
  dependencies.createRepository = async () => { throw new Error('private initialization') }
  pool.end = async () => { closes++; throw new Error('private cleanup') }
  const runtime = await initializeTestingStorage('unused', 'mysql', dependencies)
  assert.doesNotMatch(runtime.error!, /private/)
  await assert.rejects(runtime.close(), { message: 'Testing storage shutdown failed; check database connectivity.' })
  assert.equal(closes, 1)
})

test('real repository factory rejects a missing testing table without task schema checks, locks or DDL', async () => {
  const { dependencies, pool, calls } = fixture()
  const statements: string[] = []
  dependencies.createRepository = createTestingRepository
  dependencies.createPool = () => ({
    ...pool,
    query: async options => { statements.push(options.sql); assert.equal(options.timeout, 15000); return [[], undefined] },
  })
  const runtime = await initializeTestingStorage('unused', 'mysql', dependencies)
  assert.equal(runtime.repository, undefined)
  assert.match(runtime.error!, /手动应用 sql\/mysql-testing-schema\.sql/)
  assert.equal(statements.length, 1)
  assert.match(statements[0], /information_schema\.COLUMNS/)
  assert.doesNotMatch(statements.join('\n'), /GET_LOCK|codeflow_schema|CREATE|ALTER|INSERT|UPDATE/)
  assert.equal(calls.filter(call => call === 'close').length, 1)
  await runtime.close()
})

test('explicit JSON creates a missing root and recovers standalone records without replay', async context => {
  const temporary = await mkdtemp(join(tmpdir(), 'testing-runtime-'))
  context.after(() => rm(temporary, { recursive: true, force: true }))
  const root = join(temporary, 'missing', 'root')
  const { dependencies } = fixture()
  dependencies.config = () => { throw new Error('JSON must not read DB configuration') }
  dependencies.createPool = () => { throw new Error('JSON must not connect') }
  dependencies.createRepository = createTestingRepository
  dependencies.acquireLease = acquireTestingRuntimeLease
  const first = await initializeTestingStorage(root, 'json', dependencies)
  assert.ok(first.repository)
  const at = '2026-10-20T00:00:00.000Z'
  const project: PlanningProject = {
    id: 'project-1', ownerId: 1, version: 1, status: 'running', createdAt: at, updatedAt: at,
    input: { title: 'Plan', requirements: 'Requirements', instruction: '', modelId: 'fake', sources: [] }, events: [], caseSetIds: [],
  }
  const execution: ExecutionRun = {
    id: 'execution-1', ownerId: 1, version: 1, status: 'preparing', createdAt: at, updatedAt: at,
    input: { title: 'Run', caseSetId: 'package-1', repository: 'fake', scope: { mode: 'default', caseIds: [], reason: '' } },
    packageFingerprint: 'fake', cases: [], events: [],
  }
  await first.repository.create('project', project, 1)
  await first.repository.create('execution', execution, 1)
  const duplicate = await initializeTestingStorage(root, 'json', dependencies)
  assert.equal(duplicate.repository, undefined)
  assert.match(duplicate.error!, /JSON 存储未就绪/)
  await duplicate.close()
  assert.equal((await first.repository.get('project', project.id, 1))!.status, 'running')
  assert.equal((await first.repository.get('execution', execution.id, 1))!.status, 'preparing')
  assert.equal((await first.repository.get('execution', execution.id, 1))!.version, 1)
  await first.close()
  const reopened = await initializeTestingStorage(root, 'json', dependencies)
  assert.equal((await reopened.repository!.get('project', project.id, 1))!.status, 'interrupted')
  assert.equal((await reopened.repository!.get('execution', execution.id, 1))!.status, 'interrupted')
  assert.equal((await reopened.repository!.get('execution', execution.id, 1))!.version, 2)
  await reopened.close()
  await writeFile(join(root, 'testing', 'manifest.json'), '{invalid')
  const unavailable = await initializeTestingStorage(root, 'json', dependencies)
  assert.equal(unavailable.repository, undefined)
  assert.match(unavailable.error!, /JSON 存储未就绪/)
  assert.equal(await readFile(join(root, 'testing', 'manifest.json'), 'utf8'), '{invalid')
  assert.ok((await readdir(temporary)).includes('missing'))
})

test('default lease excludes a second runtime before pool creation or recovery and releases on close', async context => {
  const root = await mkdtemp(join(tmpdir(), 'testing-lease-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const { dependencies, calls, repository } = fixture()
  dependencies.acquireLease = undefined
  dependencies.createRepository = async () => repository
  const first = await initializeTestingStorage(root, 'mysql', dependencies)
  assert.equal(first.repository, repository)
  const before = [...calls]
  const second = await initializeTestingStorage(root, 'mysql', dependencies)
  assert.equal(second.repository, undefined)
  assert.deepEqual(calls, before)
  await second.close()
  await assert.rejects(acquireTestingRuntimeLease(root))
  await first.close()
  const next = await acquireTestingRuntimeLease(root)
  await next.release()
  await next.release()
})

test('crashed process lease is reclaimed with only one concurrent successor', async context => {
  const root = await mkdtemp(join(tmpdir(), 'testing-crash-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `import { acquireTestingRuntimeLease } from ${JSON.stringify(new URL('./runtime.ts', import.meta.url).href)}; await acquireTestingRuntimeLease(${JSON.stringify(root)});`], { encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => acquireTestingRuntimeLease(root)))
  const acquired = attempts.filter(result => result.status === 'fulfilled')
  assert.equal(acquired.length, 1)
  await acquired[0].value.release()
  assert.deepEqual(await readdir(join(root, 'testing')), [])
})

test('lease release never deletes a replacement lock', async context => {
  const root = await mkdtemp(join(tmpdir(), 'testing-replace-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const first = await acquireTestingRuntimeLease(root)
  await rename(join(root, 'testing', 'runtime.lock'), join(root, 'testing', 'old.lock'))
  const replacement = await acquireTestingRuntimeLease(root)
  await first.release()
  await assert.rejects(acquireTestingRuntimeLease(root))
  await replacement.release()
})

test('unknown PID state and incomplete lock fail closed without recovery', async context => {
  const root = await mkdtemp(join(tmpdir(), 'testing-invalid-lease-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const lock = join(root, 'testing', 'runtime.lock')
  await mkdir(lock, { recursive: true })
  await assert.rejects(acquireTestingRuntimeLease(root))
  const token = 'a0000000-0000-0000-0000-000000000000'
  const path = join(lock, `${process.pid}-${token}.json`)
  await writeFile(path, JSON.stringify({ pid: process.pid, token }))
  context.mock.method(process, 'kill', () => { throw Object.assign(new Error('Not permitted'), { code: 'EPERM' }) })
  await assert.rejects(acquireTestingRuntimeLease(root), { code: 'EPERM' })
  assert.equal(JSON.parse(await readFile(path, 'utf8')).token, token)
})

test('initialization and shutdown failures still release the real lease', async context => {
  const root = await mkdtemp(join(tmpdir(), 'testing-cleanup-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const { dependencies, pool } = fixture()
  dependencies.acquireLease = acquireTestingRuntimeLease
  dependencies.createRepository = async () => { throw new Error('Initialization failed') }
  pool.end = async () => { throw new Error('Shutdown failed') }
  const unavailable = await initializeTestingStorage(root, 'mysql', dependencies)
  assert.equal(unavailable.repository, undefined)
  const next = await acquireTestingRuntimeLease(root)
  await next.release()
  await assert.rejects(unavailable.close(), /Testing storage shutdown failed/)
})

test('root startup keeps testing parsing, routes and shutdown independent of task middleware', async () => {
  const source = await readFile(new URL('../index.ts', import.meta.url), 'utf8')
  assert.match(source, /initializeTestingStorage\(root, storage\.backend\)/)
  assert.ok(source.indexOf("app.use('/api/testing', express.json({ limit: '4mb' }))") < source.indexOf("app.use(express.json({ limit: '32kb' }))"))
  assert.ok(source.indexOf('registerTestingRoutes(app,') < source.indexOf("app.use('/api', storageResponse(store))"))
  assert.equal(source.match(/registerTestingRoutes\(app,/g)?.length, 1)
  assert.doesNotMatch(source, /importPackage:/)
  assert.equal(source.match(/testingStorage\.close\(\)/g)?.length, 2)
})