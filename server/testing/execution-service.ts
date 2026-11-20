import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { SelfTestCase } from '../../shared/task.js'
import type { CasePackage, ExecutionInput, ExecutionReport, ExecutionRun, TestingRepository } from '../../shared/testing.js'
import { buildAssertionManifest, type AssertionManifest, type PlaywrightExecutionBinding, type TestExecutionResult } from '../../shared/test-execution.js'
import { createExecutionPlan } from '../../shared/test-policy.js'
import { validateRepository } from '../git/git.js'
import { parseExecutionBindingApproval } from '../http/execution-binding.js'
import { applyExecutionReview, assessExecutionReadiness } from '../verification/acceptance.js'
import { buildCaseExecutionFingerprint, runPlaywrightTest, type PlaywrightTestOptions } from '../verification/playwright-test.js'
import { workspaceFingerprint } from '../verification/self-test-artifacts.js'
import { canWriteTestFile } from '../verification/self-test-permissions.js'
import { TestImplementationAgent, parseExecutionImplementation, type ExecutionImplementation, type ExecutionModelContext, type ExecutionModelInput, type ExecutionModelResult } from './execution-model.js'
import { AgentBoundaryError } from '../agents/runtime.js'
import { planningDigest, planningEnvironment, planningRulesVersion, qualifiedPlanning } from './planning-model.js'
import { packageInputFingerprint, validatePackageScope } from './scoped-package.js'

export type ExecutionErrorCode = 'NOT_FOUND' | 'INVALID_INPUT' | 'CONFLICT' | 'UNQUALIFIED' | 'SOURCE_CHANGED' | 'PREPARATION_FAILED' | 'STORAGE_FAILED'
const messages: Record<ExecutionErrorCode, string> = {
  NOT_FOUND: 'Execution or published package not found.', INVALID_INPUT: 'Invalid execution input or approval.',
  CONFLICT: 'Execution changed or cannot be reused; create a new execution.', UNQUALIFIED: 'A published qualified case package is required.',
  SOURCE_CHANGED: 'Execution inputs changed; create and approve a new execution.',
  PREPARATION_FAILED: 'Workspace preparation failed; no credentials or raw command output retained.', STORAGE_FAILED: 'Execution storage operation failed.',
}
export class ExecutionError extends Error {
  constructor(readonly code: ExecutionErrorCode, message = messages[code]) { super(message); this.name = 'ExecutionError' }
}

export interface ExecutionRunnerOptions extends PlaywrightTestOptions {
  signal: AbortSignal
  env: Record<string, string>
  toolchainFingerprint?: string
}
export interface TestExecutionDependencies {
  clone?: (repository: string, workspace: string, branch: string | undefined, signal: AbortSignal) => Promise<void>
  snapshot?: (workspace: string) => Promise<string>
  runner?: (options: ExecutionRunnerOptions) => Promise<TestExecutionResult>
  implement?: (input: ExecutionModelInput, context: ExecutionModelContext) => Promise<ExecutionModelResult>
  install?: (workspace: string, signal: AbortSignal) => Promise<void>
}

type ImplementedCase = ExecutionRun['cases'][number] & { implementation?: ExecutionImplementation }
export type ExecutionPreparationPhase = 'cloning' | 'implementing' | 'installing' | 'awaiting_implementation' | 'awaiting_installation' | 'awaiting_approval' | 'ready' | 'executing' | 'finished'
export type PreparedExecutionRun = ExecutionRun & { phase?: ExecutionPreparationPhase; sourceFingerprint?: string; installComplete?: boolean; cases: ImplementedCase[] }
type ExecutionPatch = Partial<PreparedExecutionRun>
const playwrightVersion = '1.63.0'

const execute = promisify(execFile)
const active = new Map<string, AbortController>()
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const hash = /^[a-f0-9]{64}$/i
const now = () => new Date().toISOString()
const terminal = (run: ExecutionRun) => ['passed', 'failed', 'incomplete', 'cancelled', 'interrupted'].includes(run.status)
const inside = (root: string, target: string) => { const local = relative(root, target); return !isAbsolute(local) && !local.split(/[\\/]/).includes('..') }

async function cloneRepository(repository: string, workspace: string, branch: string | undefined, signal: AbortSignal): Promise<void> {
  await execute('git', ['-c', 'core.hooksPath=', '-c', 'credential.helper=', '-c', 'protocol.file.allow=never', 'clone', '--depth', '1', '--single-branch',
    '--config', 'core.hooksPath=', '--config', 'credential.helper=', ...(branch ? ['--branch', branch] : []), '--', repository, workspace], {
    env: { ...planningEnvironment(), GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' },
    signal, timeout: 120_000, maxBuffer: 1_000_000, windowsHide: true,
  })
}

async function sourceHash(workspace: string, file: string): Promise<string> {
  if (!file || isAbsolute(file) || /[:\p{Cc}]/u.test(file) || file.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) throw new ExecutionError('INVALID_INPUT')
  let target = workspace
  for (const part of file.split(/[\\/]/)) {
    target = join(target, part)
    if ((await lstat(target)).isSymbolicLink()) throw new ExecutionError('SOURCE_CHANGED')
  }
  if (!inside(workspace, await realpath(target))) throw new ExecutionError('SOURCE_CHANGED')
  const handle = await open(target, 'r')
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > 128 * 1024) throw new ExecutionError('INVALID_INPUT')
    const bytes = Buffer.alloc(128 * 1024 + 1)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    const after = await lstat(target)
    if (bytesRead !== before.size || after.isSymbolicLink() || after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new ExecutionError('SOURCE_CHANGED')
    return createHash('sha256').update(bytes.subarray(0, bytesRead)).digest('hex')
  } finally { await handle.close() }
}

async function snapshotWorkspace(workspace: string, excluded?: string[]): Promise<string> {
  const files: [string, string][] = []
  let bytes = 0
  const scan = async (directory: string): Promise<void> => {
    for (const entry of await readdir(join(workspace, directory), { withFileTypes: true })) {
      if (!directory && ['.git', 'node_modules'].includes(entry.name)) continue
      const local = join(directory, entry.name)
      if (excluded?.includes(local.replaceAll('\\', '/'))) continue
      if (entry.isSymbolicLink()) throw new ExecutionError('SOURCE_CHANGED')
      if (entry.isDirectory()) await scan(local)
      else if (entry.isFile()) {
        const info = await lstat(join(workspace, local))
        bytes += info.size
        if (files.length >= 20_000 || bytes > 64 * 1024 * 1024) throw new ExecutionError('PREPARATION_FAILED')
        const handle = await open(join(workspace, local), 'r')
        try { files.push([local.replaceAll('\\', '/'), createHash('sha256').update(await handle.readFile()).digest('hex')]) }
        finally { await handle.close() }
      } else throw new ExecutionError('SOURCE_CHANGED')
    }
  }
  await scan('')
  files.sort(([left], [right]) => left.localeCompare(right))
  return planningDigest({ git: excluded ? undefined : await workspaceFingerprint(workspace), files })
}

async function sourceText(workspace: string, file: string): Promise<string> {
  const fingerprint = await sourceHash(workspace, file)
  const handle = await open(join(workspace, file), 'r')
  try {
    const bytes = Buffer.alloc(128 * 1024 + 1)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    if (bytesRead > 128 * 1024 || createHash('sha256').update(bytes.subarray(0, bytesRead)).digest('hex') !== fingerprint) throw new ExecutionError('SOURCE_CHANGED')
    return bytes.subarray(0, bytesRead).toString('utf8')
  } finally { await handle.close() }
}

async function dependencyFingerprint(workspace: string): Promise<string> {
  const files: [string, string][] = []
  let bytes = 0
  const scan = async (directory: string): Promise<void> => {
    const info = await lstat(join(workspace, directory))
    if (info.isSymbolicLink()) throw new ExecutionError('SOURCE_CHANGED')
    if (info.isDirectory()) {
      for (const entry of await readdir(join(workspace, directory))) await scan(join(directory, entry))
    } else if (info.isFile()) {
      bytes += info.size
      if (files.length >= 100_000 || bytes > 512 * 1024 * 1024) throw new ExecutionError('PREPARATION_FAILED')
      const handle = await open(join(workspace, directory), 'r')
      try { files.push([directory.replaceAll('\\', '/'), createHash('sha256').update(await handle.readFile()).digest('hex')]) }
      finally { await handle.close() }
    } else throw new ExecutionError('SOURCE_CHANGED')
  }
  try { await lstat(join(workspace, 'node_modules')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return planningDigest([]); throw error }
  await scan('node_modules')
  return planningDigest(files.sort(([left], [right]) => left.localeCompare(right)))
}

async function installPlaywright(workspace: string, signal: AbortSignal): Promise<void> {
  try { await lstat(join(workspace, '.npmrc')); throw new ExecutionError('PREPARATION_FAILED') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const candidates = [join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ...(process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').map(directory => join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'))]
  const cli = await (async () => {
    for (const candidate of candidates) {
      try { if ((await lstat(candidate)).isFile()) return candidate } catch {}
    }
    throw new ExecutionError('PREPARATION_FAILED')
  })()
  const cache = await mkdtemp(join(workspace, '..', 'npm-cache-'))
  const emptyConfig = process.platform === 'win32' ? 'NUL' : '/dev/null'
  try {
    await execute(process.execPath, [cli, 'install', '--ignore-scripts', '--no-save', '--package-lock=false', `@playwright/test@${playwrightVersion}`,
      `--prefix=${workspace}`, '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/', `--userconfig=${emptyConfig}`, `--globalconfig=${emptyConfig}`, `--cache=${cache}`, '--bin-links=false'],
    { cwd: workspace, env: { ...planningEnvironment(), GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig,
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '' }, signal, timeout: 120_000, maxBuffer: 1_000_000, windowsHide: true })
  } finally { await rm(cache, { recursive: true, force: true }) }
}

export class TestExecutionService {
  private readonly clone: NonNullable<TestExecutionDependencies['clone']>
  private readonly snapshot: NonNullable<TestExecutionDependencies['snapshot']>
  private readonly runner: NonNullable<TestExecutionDependencies['runner']>
  private readonly implementScripts: NonNullable<TestExecutionDependencies['implement']>
  private readonly installDependencies: NonNullable<TestExecutionDependencies['install']>

  constructor(private readonly repo: TestingRepository, private readonly root: string, dependencies: TestExecutionDependencies = {}) {
    this.clone = dependencies.clone ?? cloneRepository
    const snapshot = dependencies.snapshot ?? snapshotWorkspace
    this.snapshot = async workspace => planningDigest({ source: await snapshot(workspace), dependencies: await dependencyFingerprint(workspace), playwrightVersion })
    this.runner = dependencies.runner ?? runPlaywrightTest
    const model = new TestImplementationAgent()
    this.implementScripts = dependencies.implement ?? model.generate.bind(model)
    this.installDependencies = dependencies.install ?? installPlaywright
  }

  async create(owner: number, input: ExecutionInput): Promise<PreparedExecutionRun> {
    this.identity(owner, input?.caseSetId)
    const value = await this.package(owner, input.caseSetId)
    const normalized = this.input(input, value)
    const cases = this.definitions(value)
    const plan = createExecutionPlan(value.baseline, cases, normalized.scope.caseIds, normalized.scope.mode === 'custom'
      ? { mode: 'custom', caseIds: normalized.scope.caseIds, reason: normalized.scope.reason, confirmedAt: now() } : undefined)
    const selected = cases.filter(item => plan.cases.some(entry => entry.caseId === item.id && entry.selected))
    const readiness = applyExecutionReview(assessExecutionReadiness(value.baseline, selected), '{"findings":[]}', selected.map(item => item.id))
    if (readiness.readiness !== 'ready') throw new ExecutionError('UNQUALIFIED')
    const at = now()
    const run: PreparedExecutionRun = { id: randomUUID(), ownerId: owner, version: 1, createdAt: at, updatedAt: at, input: normalized, phase: 'cloning',
      status: 'draft', packageFingerprint: planningDigest(value), readiness, events: [],
      cases: plan.cases.map(entry => ({ caseId: entry.caseId, selected: entry.selected, blocking: entry.gatePolicy === 'blocking', status: entry.selected ? 'pending' : 'skipped' })), }
    try { await this.repo.create('execution', run, owner) } catch { throw new ExecutionError('STORAGE_FAILED') }
    return structuredClone(run)
  }

  async prepare(owner: number, id: string, _token?: string): Promise<void> {
    let run = await this.run(owner, id)
    this.idle(run)
    await this.packageFor(run)
    const key = this.key(id)
    const controller = new AbortController()
    if (active.has(key)) throw new ExecutionError('CONFLICT')
    active.set(key, controller)
    let partialWorkspace: string | undefined
    try {
      run = await this.replace(run, { status: 'preparing', phase: 'cloning', error: undefined })
      let workspace: string
      if (run.workspaceFingerprint) {
        workspace = await this.workspace(id)
        await this.unchanged(run, workspace)
      } else {
        workspace = await this.workspace(id, true)
        partialWorkspace = workspace
        await this.clone(run.input.repository, workspace, run.input.branch, controller.signal)
        controller.signal.throwIfAborted()
        workspace = await this.workspace(id)
        run = await this.replace(run, { workspaceFingerprint: await this.snapshot(workspace), sourceFingerprint: await snapshotWorkspace(workspace, []) })
      }
      controller.signal.throwIfAborted()
      const available = await this.available(workspace)
      run = await this.replace(run, { ...this.prepared(run, available), installComplete: run.installComplete ?? (available ? true : undefined) })
    } catch (error) {
      if (!controller.signal.aborted) {
        let safe = error instanceof ExecutionError ? error : new ExecutionError('PREPARATION_FAILED')
        const current = await this.run(owner, id)
        if (partialWorkspace && !current.workspaceFingerprint && current.version === run.version && current.status !== 'cancelled') {
          try { await this.removeOwned(run.id) }
          catch (cleanupError) { if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') safe = new ExecutionError('SOURCE_CHANGED') }
        }
        await this.failCurrent(run, safe)
        throw safe
      }
    } finally { if (active.get(key) === controller) active.delete(key) }
  }

  async implement(owner: number, id: string, token: string): Promise<void> {
    let run = await this.run(owner, id)
    this.idle(run)
    if (typeof token !== 'string' || !token.trim()) throw new ExecutionError('INVALID_INPUT')
    const value = await this.packageFor(run)
    const workspace = await this.workspace(id)
    await this.unchanged(run, workspace)
    const controller = new AbortController()
    const key = this.key(id)
    if (active.has(key)) throw new ExecutionError('CONFLICT')
    active.set(key, controller)
    try {
      run = await this.replace(run, { status: 'preparing', phase: 'implementing', error: undefined,
        events: [...run.events, { at: now(), kind: 'info', text: 'Implementation generation started; read-only model, no execution.' }] })
      const selected = this.definitions(value).filter(testCase => run.cases.some(item => item.selected && item.caseId === testCase.id))
      const output = parseExecutionImplementation(JSON.stringify(await this.implementScripts({ modelId: value.modelId, cases: selected }, {
        workspace, token, signal: controller.signal,
        assertCurrent: async () => {
          controller.signal.throwIfAborted()
          const current = await this.run(owner, id)
          if (current.version !== run.version || current.status !== 'preparing') throw new AgentBoundaryError('AGENT_STALE')
          await this.packageFor(run)
          await this.unchanged(run, workspace)
        },
        onProgress: async () => {
          controller.signal.throwIfAborted()
          run = await this.replace(run, { events: [...run.events, { at: now(), kind: 'info', text: 'Implementation model progress; read-only session active.' }] })
        },
      })))
      controller.signal.throwIfAborted()
      await this.packageFor(run)
      await this.unchanged(run, workspace)
      if (output.mappings.length !== selected.length || selected.some(testCase => !output.mappings.some(mapping => mapping.caseId === testCase.id))) throw new ExecutionError('INVALID_INPUT')
      const tracked = await execute('git', ['ls-files', '-z'], { cwd: workspace, env: planningEnvironment(), signal: controller.signal, maxBuffer: 32 * 1024 * 1024, windowsHide: true })
      const trackedPaths = new Set(tracked.stdout.split('\0').map(path => path.toLowerCase()))
      for (const file of output.files) {
        if (trackedPaths.has(file.path.toLowerCase()) || !await canWriteTestFile(workspace, file.path)) throw new ExecutionError('INVALID_INPUT')
      }
      const excluded = output.files.map(file => file.path)
      const beforeWrites = await snapshotWorkspace(workspace, excluded)
      run = await this.replace(run, { cases: this.resetCases(run), events: [...run.events, { at: now(), kind: 'info', text: 'Implementation validated; all prior approvals and results reset before script writes.' }] })
      for (const file of output.files) {
        controller.signal.throwIfAborted()
        let directory = workspace
        for (const part of file.path.split('/').slice(0, -1)) {
          controller.signal.throwIfAborted()
          directory = join(directory, part)
          try { await mkdir(directory) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
          if ((await lstat(directory)).isSymbolicLink() || !inside(workspace, await realpath(directory))) throw new ExecutionError('SOURCE_CHANGED')
        }
        if (!await canWriteTestFile(workspace, file.path)) throw new ExecutionError('INVALID_INPUT')
        controller.signal.throwIfAborted()
        const handle = await open(join(workspace, file.path), 'wx', 0o600)
        try { controller.signal.throwIfAborted(); await handle.writeFile(file.content, 'utf8') } finally { await handle.close() }
      }
      controller.signal.throwIfAborted()
      const cases: ImplementedCase[] = this.resetCases(run).map(item => {
        const mapping = output.mappings.find(entry => entry.caseId === item.caseId)
        return { ...item, ...(mapping ? { implementation: { testFile: mapping.testFile, testTitle: mapping.testTitle, project: mapping.project } } : {}) }
      })
      if (beforeWrites !== await snapshotWorkspace(workspace, excluded)) throw new ExecutionError('SOURCE_CHANGED')
      for (const file of output.files) if (await sourceText(workspace, file.path) !== file.content) throw new ExecutionError('SOURCE_CHANGED')
      const next = { ...run, cases, workspaceFingerprint: await this.snapshot(workspace), sourceFingerprint: await snapshotWorkspace(workspace, []) }
      controller.signal.throwIfAborted()
      await this.replace(run, { ...this.prepared(next, await this.available(workspace)), workspaceFingerprint: next.workspaceFingerprint, sourceFingerprint: next.sourceFingerprint,
        events: [...run.events, { at: now(), kind: 'info', text: 'Implementation source snapshot saved; explicit human approval required.' }] })
    } catch (error) {
      if (!controller.signal.aborted) {
        const safe = error instanceof ExecutionError ? error : new ExecutionError('PREPARATION_FAILED')
        await this.failCurrent(run, safe)
        throw safe
      }
    } finally { if (active.get(key) === controller) active.delete(key) }
  }

  async install(owner: number, id: string): Promise<void> {
    let run = await this.run(owner, id)
    this.idle(run)
    await this.packageFor(run)
    const workspace = await this.workspace(id)
    const retry = run.phase === 'awaiting_installation' && run.installComplete === false && !run.cases.some(item => item.binding || item.result)
    if (retry) {
      if (!run.sourceFingerprint || run.sourceFingerprint !== await snapshotWorkspace(workspace, [])) throw new ExecutionError('SOURCE_CHANGED')
    } else await this.unchanged(run, workspace)
    const controller = new AbortController()
    const key = this.key(id)
    if (active.has(key)) throw new ExecutionError('CONFLICT')
    active.set(key, controller)
    try {
      const before = await snapshotWorkspace(workspace, [])
      run = await this.replace(run, { status: 'preparing', phase: 'installing', installComplete: false, sourceFingerprint: before, error: undefined, cases: this.resetCases(run),
        events: [...run.events, { at: now(), kind: 'info', text: `Explicit dependency installation started: @playwright/test@${playwrightVersion}; lifecycle scripts disabled.` }] })
      await this.assertUntrackedDependencies(workspace)
      if (retry) await this.removeOwned(id, 'node_modules')
      await this.installDependencies(workspace, controller.signal)
      controller.signal.throwIfAborted()
      await this.packageFor(run)
      if (before !== await snapshotWorkspace(workspace, [])) throw new ExecutionError('SOURCE_CHANGED')
      if (!await this.available(workspace)) throw new ExecutionError('PREPARATION_FAILED')
      const next = { ...run, installComplete: true, workspaceFingerprint: await this.snapshot(workspace) }
      controller.signal.throwIfAborted()
      await this.replace(run, { ...this.prepared(next, true), installComplete: true, workspaceFingerprint: next.workspaceFingerprint,
        events: [...run.events, { at: now(), kind: 'info', text: `Pinned toolchain ${playwrightVersion} snapshot saved; explicit human approval required.` }] })
    } catch (error) {
      if (!controller.signal.aborted) {
        let safe = error instanceof ExecutionError ? error : new ExecutionError('PREPARATION_FAILED')
        const current = await this.run(owner, id)
        if (run.phase === 'installing' && current.version === run.version && current.status !== 'cancelled') {
          try {
            if (run.sourceFingerprint !== await snapshotWorkspace(workspace, [])) throw new ExecutionError('SOURCE_CHANGED')
            await this.assertUntrackedDependencies(workspace)
            await this.removeOwned(id, 'node_modules')
            controller.signal.throwIfAborted()
            run = await this.replace(run, { workspaceFingerprint: await this.snapshot(workspace), installComplete: false, cases: this.resetCases(run) })
          } catch { safe = new ExecutionError('SOURCE_CHANGED') }
        }
        await this.failCurrent(run, safe)
        throw safe
      }
    } finally { if (active.get(key) === controller) active.delete(key) }
  }

  private resetCases(run: ExecutionRun): ImplementedCase[] {
    return run.cases.map(item => ({ ...item, binding: undefined, result: undefined, reason: undefined, status: item.selected ? 'pending' : 'skipped' }))
  }

  async binding(owner: number, id: string, caseId: string): Promise<{ manifest: AssertionManifest; testCase: SelfTestCase; binding: PlaywrightExecutionBinding | null; source?: string; implementation?: ExecutionImplementation }> {
    const run = await this.run(owner, id)
    this.idle(run)
    const testCase = this.case(await this.packageFor(run), run, caseId)
    const workspace = await this.workspace(id)
    await this.unchanged(run, workspace)
    const item = run.cases.find(item => item.caseId === caseId)! as ImplementedCase
    const file = item.implementation?.testFile ?? item.binding?.testFile
    const source = file ? await sourceText(workspace, file) : undefined
    await this.unchanged(run, workspace)
    return { manifest: buildAssertionManifest(testCase), testCase, binding: structuredClone(item.binding ?? null), source, implementation: structuredClone(item.implementation) }
  }

  async approve(owner: number, id: string, caseId: string, body: unknown): Promise<PlaywrightExecutionBinding> {
    const run = await this.run(owner, id)
    this.idle(run)
    const testCase = this.case(await this.packageFor(run), run, caseId)
    let approval: ReturnType<typeof parseExecutionBindingApproval>
    try { approval = parseExecutionBindingApproval(body, buildAssertionManifest(testCase)) } catch { throw new ExecutionError('INVALID_INPUT') }
    const workspace = await this.workspace(id)
    await this.unchanged(run, workspace)
    if (run.installComplete === false || !await this.available(workspace)) throw new ExecutionError('PREPARATION_FAILED')
    let testSourceFingerprint: string
    try { testSourceFingerprint = await sourceHash(workspace, approval.testFile) } catch (error) { throw error instanceof ExecutionError ? error : new ExecutionError('INVALID_INPUT') }
    await this.unchanged(run, workspace)
    if (await sourceHash(workspace, approval.testFile) !== testSourceFingerprint) throw new ExecutionError('SOURCE_CHANGED')
    const at = now()
    const binding: PlaywrightExecutionBinding = { version: 1, caseFingerprint: buildCaseExecutionFingerprint(testCase), designFingerprint: run.workspaceFingerprint!,
      testSourceFingerprint, testFile: approval.testFile, testTitle: approval.testTitle, project: approval.project, assertionIds: approval.assertionIds,
      approvedBy: String(owner), approvedAt: at, reviewedAt: at }
    const next = { ...run, cases: run.cases.map(item => item.caseId === caseId ? { ...item, binding, result: undefined, status: 'pending' as const } : item) }
    await this.replace(run, this.prepared(next, await this.available(workspace)))
    return structuredClone(binding)
  }

  async start(owner: number, id: string): Promise<void> {
    let run = await this.run(owner, id)
    this.idle(run)
    const value = await this.packageFor(run)
    const key = this.key(id)
    if (active.has(key)) throw new ExecutionError('CONFLICT')
    const controller = new AbortController()
    active.set(key, controller)
    try {
      const workspace = await this.workspace(id)
      await this.unchanged(run, workspace)
      const preparation = this.prepared(run, await this.available(workspace))
      if (preparation.status !== 'ready') { await this.replace(run, preparation); return }
      run = await this.replace(run, { status: 'running', phase: 'executing', error: undefined, events: [...run.events, { at: now(), kind: 'info', text: 'Approved Playwright execution started.' }] })
      for (const item of run.cases.filter(entry => entry.selected)) {
        controller.signal.throwIfAborted()
        await this.packageFor(run)
        await this.unchanged(run, workspace)
        const testCase = this.case(value, run, item.caseId)
        const binding = item.binding!
        await this.verifyBinding(run, workspace, testCase, binding)
        const startedAt = now()
        const result = await this.runner({ workspace, testCase: structuredClone(testCase), binding: structuredClone(binding), designFingerprint: run.workspaceFingerprint!,
          signal: controller.signal, toolchainFingerprint: await dependencyFingerprint(workspace), env: run.input.previewUrl ? { CODEFLOW_BASE_URL: run.input.previewUrl } : {} })
        controller.signal.throwIfAborted()
        await this.unchanged(run, workspace)
        await this.verifyBinding(run, workspace, testCase, binding)
        await this.packageFor(run)
        const verified = this.result(testCase, binding, result, startedAt)
        run = await this.replace(run, { cases: run.cases.map(entry => entry.caseId === item.caseId ? { ...entry, status: verified.status, result: verified, reason: verified.reason } : entry) })
      }
      const blocking = run.cases.filter(item => item.selected && item.blocking)
      const status = blocking.length && blocking.every(item => item.status === 'passed') ? 'passed'
        : blocking.some(item => item.status === 'failed') ? 'failed'
        : blocking.some(item => item.status === 'blocked') ? 'blocked' : 'incomplete'
      await this.replace(run, { status, phase: 'finished' })
    } catch (error) {
      if (!controller.signal.aborted) await this.failCurrent(run, error instanceof ExecutionError ? error : new ExecutionError('PREPARATION_FAILED'))
    } finally { if (active.get(key) === controller) active.delete(key) }
  }

  async cancel(owner: number, id: string): Promise<ExecutionRun> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const run = await this.run(owner, id)
      if (run.status === 'cancelled') return run
      if (terminal(run)) throw new ExecutionError('CONFLICT')
      try {
        const cancelled = await this.replace(run, { status: 'cancelled', phase: 'finished', cases: run.cases.map(item => item.selected && ['pending', 'blocked'].includes(item.status) ? { ...item, status: 'cancelled', reason: 'Execution cancelled.' } : item) })
        active.get(this.key(id))?.abort()
        return cancelled
      } catch (error) { if (!(error instanceof ExecutionError) || error.code !== 'CONFLICT' || attempt === 3) throw error }
    }
    throw new ExecutionError('CONFLICT')
  }

  async report(owner: number, id: string): Promise<ExecutionReport> {
    const run = await this.run(owner, id)
    return structuredClone({ schemaVersion: 1, run, casePackage: await this.packageFor(run), scope: run.input.scope })
  }

  private identity(owner: number, id: string): void {
    if (!Number.isSafeInteger(owner) || owner <= 0 || typeof id !== 'string' || !uuid.test(id)) throw new ExecutionError('NOT_FOUND')
  }

  private async run(owner: number, id: string): Promise<PreparedExecutionRun> {
    this.identity(owner, id)
    let run: ExecutionRun | undefined
    try { run = await this.repo.get('execution', id, owner) } catch { throw new ExecutionError('STORAGE_FAILED') }
    if (!run || run.ownerId !== owner || run.id !== id) throw new ExecutionError('NOT_FOUND')
    return structuredClone(run)
  }

  private async package(owner: number, id: string): Promise<CasePackage> {
    this.identity(owner, id)
    let value: CasePackage | undefined
    try {
      value = await this.repo.get('package', id, owner)
      if (!value) throw new ExecutionError('NOT_FOUND')
      this.identity(owner, value.projectId)
      const project = await this.repo.get('project', value.projectId, owner)
      if (!project || project.ownerId !== owner || project.id !== value.projectId || !project.caseSetIds.includes(id)) throw new ExecutionError('NOT_FOUND')
    } catch (error) { throw error instanceof ExecutionError ? error : new ExecutionError('STORAGE_FAILED') }
    try {
      if (value.schemaVersion !== 1 || value.id !== id || !hash.test(value.sourceFingerprint) || value.rulesVersion !== planningRulesVersion
        || value.definitionFingerprint !== planningDigest({ baseline: value.baseline, cases: value.cases })
        || value.assessment.inputFingerprint !== packageInputFingerprint(value)
        || !Number.isFinite(Date.parse(value.assessment.checkedAt)) || Date.parse(value.assessment.checkedAt) > Date.now()) throw new Error('Invalid package')
      validatePackageScope(value)
      const qualified = qualifiedPlanning(value)
      if (planningDigest({ baseline: qualified.baseline, cases: qualified.cases }) !== value.definitionFingerprint) throw new Error('Invalid definitions')
    } catch { throw new ExecutionError('UNQUALIFIED') }
    return structuredClone(value)
  }

  private async packageFor(run: ExecutionRun): Promise<CasePackage> {
    const value = await this.package(run.ownerId, run.input.caseSetId)
    if (planningDigest(value) !== run.packageFingerprint) throw new ExecutionError('SOURCE_CHANGED')
    return value
  }

  private definitions(value: CasePackage): SelfTestCase[] { return value.cases.map(item => ({ ...structuredClone(item), status: 'pending' })) }

  private case(value: CasePackage, run: ExecutionRun, id: string): SelfTestCase {
    const item = this.definitions(value).find(entry => entry.id === id)
    if (!item || !run.cases.some(entry => entry.caseId === id && entry.selected)) throw new ExecutionError('NOT_FOUND')
    return item
  }

  private input(input: ExecutionInput, value: CasePackage): ExecutionInput {
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200 || typeof input.repository !== 'string'
      || !input.scope || !['default', 'custom'].includes(input.scope.mode) || !Array.isArray(input.scope.caseIds) || input.scope.caseIds.length > 1000
      || new Set(input.scope.caseIds).size !== input.scope.caseIds.length || input.scope.caseIds.some(id => typeof id !== 'string' || !value.cases.some(item => item.id === id))
      || typeof input.scope.reason !== 'string' || input.scope.reason.length > 2000) throw new ExecutionError('INVALID_INPUT')
    let repository: string
    try { repository = validateRepository(input.repository) } catch { throw new ExecutionError('INVALID_INPUT') }
    const branch = input.branch
    if (branch !== undefined && (typeof branch !== 'string' || !/^[a-z0-9][a-z0-9_./-]{0,199}$/i.test(branch) || /\.\.|\/\/|\.lock(?:\/|$)/i.test(branch) || /[/.]$/.test(branch))) throw new ExecutionError('INVALID_INPUT')
    if (input.previewUrl !== undefined) {
      try {
        const url = new URL(input.previewUrl)
        if (typeof input.previewUrl !== 'string' || url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.hash || url.search || /[\p{Cc}]/u.test(input.previewUrl)) throw new Error('Unsafe preview')
      } catch { throw new ExecutionError('INVALID_INPUT', 'Preview URL must use local HTTP (localhost, 127.0.0.1 or [::1]) without credentials, query or fragment; HTTPS is not supported.') }
    }
    const ids = [...input.scope.caseIds]
    if (value.scope && (input.scope.mode !== 'custom' || planningDigest([...ids].sort()) !== planningDigest(value.scope.caseIds) || input.scope.reason.trim() !== value.scope.reason)) throw new ExecutionError('INVALID_INPUT')
    if (input.scope.mode === 'custom') {
      if (!ids.length || !input.scope.reason.trim()) throw new ExecutionError('INVALID_INPUT')
    } else {
      const required = createExecutionPlan(value.baseline, this.definitions(value)).cases.filter(item => item.selected).map(item => item.caseId)
      if (ids.length && required.some(id => !ids.includes(id))) throw new ExecutionError('INVALID_INPUT')
      if (!ids.length) ids.push(...required)
    }
    if (!ids.length) throw new ExecutionError('INVALID_INPUT')
    return structuredClone({ title: input.title.trim(), caseSetId: value.id, repository, ...(branch ? { branch } : {}), ...(input.previewUrl ? { previewUrl: input.previewUrl } : {}), scope: { mode: input.scope.mode, caseIds: ids, reason: input.scope.reason.trim() } })
  }

  private key(id: string): string { return `${resolve(this.root).toLowerCase()}:${id}` }

  private idle(run: ExecutionRun): void {
    if (terminal(run) || run.events.some(event => event.text === 'Approved Playwright execution started.') || ['running', 'preparing'].includes(run.status) || active.has(this.key(run.id))) throw new ExecutionError('CONFLICT')
  }

  private async replace(run: ExecutionRun, patch: ExecutionPatch): Promise<PreparedExecutionRun> {
    const next: PreparedExecutionRun = JSON.parse(JSON.stringify({ ...run, ...patch, version: run.version + 1, updatedAt: now(), events: (patch.events ?? run.events).slice(-200) }))
    try { await this.repo.replace('execution', next, run.version, run.ownerId) }
    catch { const current = await this.run(run.ownerId, run.id); throw new ExecutionError(current.version !== run.version ? 'CONFLICT' : 'STORAGE_FAILED') }
    return next
  }

  private async workspace(id: string, fresh = false): Promise<string> {
    const root = await realpath(this.root)
    let directory = root
    for (const part of ['testing', 'executions', id, ...(fresh ? [] : ['workspace'])]) {
      directory = join(directory, part)
      if (fresh) await mkdir(directory, { recursive: true })
      if ((await lstat(directory)).isSymbolicLink() || !inside(root, await realpath(directory))) throw new ExecutionError('SOURCE_CHANGED')
    }
    if (!fresh) return directory
    const workspace = join(directory, 'workspace')
    try { await lstat(workspace); throw new ExecutionError('CONFLICT') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    return workspace
  }

  private async unchanged(run: ExecutionRun, workspace: string): Promise<void> {
    if (!run.workspaceFingerprint || await this.snapshot(workspace) !== run.workspaceFingerprint) throw new ExecutionError('SOURCE_CHANGED')
  }

  private async assertUntrackedDependencies(workspace: string): Promise<void> {
    const git = await lstat(join(workspace, '.git'))
    if (!git.isDirectory() || git.isSymbolicLink()) throw new ExecutionError('SOURCE_CHANGED')
    const tracked = await execute('git', ['ls-files', '-z'], { cwd: workspace, env: planningEnvironment(), maxBuffer: 32 * 1024 * 1024, windowsHide: true })
    if (tracked.stdout.split('\0').some(file => /^node_modules(?:\/|$)/i.test(file))) throw new ExecutionError('SOURCE_CHANGED')
  }

  private async removeOwned(id: string, dependency?: 'node_modules'): Promise<void> {
    const workspace = await this.workspace(id)
    const target = dependency ? join(workspace, dependency) : workspace
    const check = async (directory: string): Promise<void> => {
      const info = await lstat(directory)
      if (info.isSymbolicLink() || !inside(workspace, await realpath(directory))) throw new ExecutionError('SOURCE_CHANGED')
      if (info.isDirectory()) for (const entry of await readdir(directory)) await check(join(directory, entry))
      else if (!info.isFile()) throw new ExecutionError('SOURCE_CHANGED')
    }
    try { await check(target) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    if (workspace !== await this.workspace(id)) throw new ExecutionError('SOURCE_CHANGED')
    await rm(target, { recursive: true, force: true })
  }

  private async available(workspace: string): Promise<boolean> {
    try {
      const local = join(workspace, 'node_modules', '@playwright', 'test')
      if (!(await lstat(join(local, 'package.json'))).isFile() || (await lstat(local)).isSymbolicLink()) return false
      const metadata = JSON.parse(await sourceText(workspace, 'node_modules/@playwright/test/package.json')) as { name?: string; version?: string }
      if (metadata.name !== '@playwright/test' || metadata.version !== playwrightVersion) return false
      const cli = createRequire(join(workspace, 'package.json')).resolve('@playwright/test/cli')
      return inside(await realpath(join(workspace, 'node_modules')), await realpath(cli))
    } catch { return false }
  }

  private prepared(run: PreparedExecutionRun, available: boolean): ExecutionPatch {
    available = available && run.installComplete !== false
    const complete = run.cases.filter(item => item.selected).every(item => !!item.binding)
    const implemented = run.cases.filter(item => item.selected).every(item => !!(item as ImplementedCase).implementation || !!item.binding)
    return { status: available && complete ? 'ready' : 'blocked', phase: available && complete ? 'ready' : run.installComplete === false ? 'awaiting_installation' : !implemented ? 'awaiting_implementation' : !available ? 'awaiting_installation' : 'awaiting_approval',
      error: available ? undefined : `Local @playwright/test@${playwrightVersion} required; explicitly confirm installation. No automatic installation.`,
      cases: run.cases.map(item => item.selected ? { ...item, status: item.binding && available ? 'pending' : 'blocked', reason: !item.binding
        ? (item as ImplementedCase).implementation ? 'Script generated; human execution binding approval required.' : 'Script implementation or manual binding required.'
        : !available ? 'Pinned local Playwright runner unavailable.' : undefined } : item) }
  }

  private async verifyBinding(run: ExecutionRun, workspace: string, testCase: SelfTestCase, binding: PlaywrightExecutionBinding): Promise<void> {
    if (!binding || binding.caseFingerprint !== buildCaseExecutionFingerprint(testCase) || binding.designFingerprint !== run.workspaceFingerprint
      || binding.approvedBy !== String(run.ownerId) || !Number.isFinite(Date.parse(binding.approvedAt)) || binding.approvedAt !== binding.reviewedAt
      || JSON.stringify(binding.assertionIds) !== JSON.stringify(buildAssertionManifest(testCase).assertions.map(item => item.id))
      || await sourceHash(workspace, binding.testFile) !== binding.testSourceFingerprint) throw new ExecutionError('SOURCE_CHANGED')
  }

  private result(testCase: SelfTestCase, binding: PlaywrightExecutionBinding, result: TestExecutionResult, startedAt: string): TestExecutionResult {
    const valid = result?.version === 1 && result.runner === 'playwright-test' && result.caseId === testCase.id && result.caseFingerprint === binding.caseFingerprint
      && ['passed', 'failed', 'incomplete', 'blocked'].includes(result.status) && Array.isArray(result.assertions)
      && JSON.stringify(result.assertions.map(item => item.id)) === JSON.stringify(binding.assertionIds)
      && result.assertions.every(item => ['passed', 'failed', 'missing'].includes(item.status) && Number.isSafeInteger(item.expectCount) && item.expectCount >= 0)
      && (result.status !== 'passed' || result.assertions.length > 0 && result.assertions.every(item => item.status === 'passed' && item.expectCount > 0))
    return { version: 1, runner: 'playwright-test', caseId: testCase.id, caseFingerprint: binding.caseFingerprint,
      status: valid ? result.status : 'incomplete', reason: valid ? `Playwright execution ${result.status}.` : 'Invalid or incomplete runner evidence.',
      assertions: valid ? structuredClone(result.assertions) : binding.assertionIds.map(id => ({ id, status: 'missing', expectCount: 0 })), startedAt, finishedAt: now() }
  }

  private async failCurrent(run: ExecutionRun, error: ExecutionError): Promise<void> {
    const current = await this.run(run.ownerId, run.id)
    if (current.version !== run.version || current.status === 'cancelled') return
    const phase = current.phase === 'installing' ? 'awaiting_installation'
      : current.phase === 'cloning' || current.phase === 'implementing' ? 'awaiting_implementation' : current.phase
    await this.replace(current, { status: 'blocked', phase, error: error.message, cases: current.cases.map(item => item.selected && item.status !== 'passed' ? { ...item, status: 'blocked', reason: error.message } : item),
      events: [...current.events, { at: now(), kind: 'error', text: error.message }] })
  }
}