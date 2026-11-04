import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { lstat, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SelfTestCase } from '../../shared/task.js'
import { buildAssertionManifest, type PlaywrightExecutionBinding, type TestExecutionResult } from '../../shared/test-execution.js'
import { executionEnvironment } from '../execution/execution-environment.js'

export function buildCaseExecutionFingerprint(testCase: SelfTestCase): string {
  return createHash('sha256').update(buildAssertionManifest(testCase).definitionKey).digest('hex')
}

export interface PlaywrightTestOptions {
  workspace: string
  testCase: SelfTestCase
  binding: PlaywrightExecutionBinding
  designFingerprint: string
  timeoutMs?: number
  signal?: AbortSignal
  env?: Record<string, string>
  toolchainFingerprint?: string
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function resultFor(options: PlaywrightTestOptions, startedAt: string, status: TestExecutionResult['status'], reason: string): TestExecutionResult {
  return {
    version: 1, runner: 'playwright-test', caseId: options.testCase.id,
    caseFingerprint: buildCaseExecutionFingerprint(options.testCase), status, reason,
    assertions: buildAssertionManifest(options.testCase).assertions.map(({ id }) => ({ id, status: 'missing', expectCount: 0 })),
    startedAt, finishedAt: new Date().toISOString(),
  }
}

export function validatePlaywrightReport(report: unknown, options: PlaywrightTestOptions, targetFile: string, exitCode: number | null, startedAt = new Date().toISOString()): TestExecutionResult {
  const result = resultFor(options, startedAt, 'incomplete', 'Invalid or incomplete execution report')
  if (!record(report) || report.version !== 1 || !Array.isArray(report.tests) || report.tests.length !== 1 || report.errors !== 0) return result
  const actual = report.tests[0]
  if (!record(actual) || typeof actual.file !== 'string' || path.resolve(actual.file) !== path.resolve(targetFile)
    || actual.fullTitle !== options.binding.testTitle || actual.project !== options.binding.project
    || !Array.isArray(actual.titlePath) || !actual.titlePath.every(part => typeof part === 'string')
    || actual.titlePath.slice(3).join(' ') !== actual.fullTitle
    || actual.retry !== 0 || actual.expectedStatus !== 'passed' || typeof actual.skipped !== 'boolean'
    || !Number.isSafeInteger(actual.errorCount) || (actual.errorCount as number) < 0 || !Array.isArray(actual.checks)) return result
  const ids = result.assertions.map(assertion => assertion.id)
  const seen = new Set<string>()
  for (const check of actual.checks) {
    if (!record(check) || typeof check.id !== 'string' || !ids.includes(check.id) || seen.has(check.id)
      || !Number.isSafeInteger(check.expectCount) || (check.expectCount as number) < 0
      || typeof check.failed !== 'boolean' || typeof check.skipped !== 'boolean') return result
    seen.add(check.id)
    const assertion = result.assertions.find(item => item.id === check.id)!
    assertion.expectCount = check.expectCount as number
    assertion.status = check.failed ? 'failed' : check.skipped || assertion.expectCount === 0 ? 'missing' : 'passed'
  }
  if (actual.status === 'failed' || actual.status === 'timedOut' || (actual.errorCount as number) > 0 || result.assertions.some(item => item.status === 'failed')) {
    result.status = 'failed'
    result.reason = 'Playwright test or assertion failed'
  } else if (exitCode === 0 && report.status === 'passed' && actual.status === 'passed' && !actual.skipped
    && ids.length > 0 && result.assertions.every(item => item.status === 'passed')) {
    result.status = 'passed'
    result.reason = 'All bound assertions verified by Playwright expect steps'
  }
  return result
}

function escaped(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

async function safeTarget(workspace: string, testFile: string): Promise<string> {
  if (!testFile || path.isAbsolute(testFile) || testFile.split(/[\\/]/).some(part => part === '..' || part === '.' || !part)) throw new Error('Unsafe test path')
  const target = path.resolve(workspace, testFile)
  const relative = path.relative(workspace, target)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe test path')
  let current = workspace
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part)
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Symlink test path')
  }
  const actual = await realpath(target)
  const info = await stat(actual)
  if (actual !== target || !info.isFile() || info.size > 128 * 1024 || !/\.(?:spec|test)\.[cm]?[jt]sx?$/.test(actual)) throw new Error('Invalid test source')
  return actual
}

export async function runPlaywrightTest(options: PlaywrightTestOptions): Promise<TestExecutionResult> {
  const startedAt = new Date().toISOString()
  const blocked = (reason: string) => resultFor(options, startedAt, 'blocked', reason)
  const cancelled = () => resultFor(options, startedAt, 'incomplete', 'cancelled')
  if (options.signal?.aborted) return cancelled()
  const environment = executionEnvironment()
  delete environment.CODEFLOW_BASE_URL
  if (options.env !== undefined) {
    try {
      if (!record(options.env) || Object.keys(options.env).some(key => key !== 'CODEFLOW_BASE_URL')) throw new Error('Invalid environment')
      if (options.env.CODEFLOW_BASE_URL !== undefined) {
        if (typeof options.env.CODEFLOW_BASE_URL !== 'string') throw new Error('Invalid URL')
        const url = new URL(options.env.CODEFLOW_BASE_URL)
        if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
          || url.username || url.password || url.search || url.hash) throw new Error('Invalid URL')
        environment.CODEFLOW_BASE_URL = url.href
      }
    } catch { return blocked('Only CODEFLOW_BASE_URL with a local HTTP preview URL is allowed') }
  }
  const manifest = buildAssertionManifest(options.testCase)
  const binding = options.binding
  if (!binding || binding.version !== 1 || binding.caseFingerprint !== buildCaseExecutionFingerprint(options.testCase)
    || typeof options.designFingerprint !== 'string' || !options.designFingerprint.trim() || binding.designFingerprint !== options.designFingerprint
    || ![binding.approvedBy, binding.approvedAt, binding.reviewedAt, binding.testTitle].every(value => typeof value === 'string' && value.trim())
    || !Number.isFinite(Date.parse(binding.approvedAt)) || !Number.isFinite(Date.parse(binding.reviewedAt))
    || typeof binding.project !== 'string' || typeof binding.testFile !== 'string' || !Array.isArray(binding.assertionIds)
    || manifest.assertions.length === 0 || manifest.assertions.some(assertion => !assertion.definition.trim())
    || JSON.stringify(binding.assertionIds) !== JSON.stringify(manifest.assertions.map(assertion => assertion.id))) return blocked('Missing, stale, or unapproved execution binding')
  let directory: string | undefined
  let wrapper: string | undefined
  try {
    const workspace = await realpath(options.workspace)
    const target = await safeTarget(workspace, binding.testFile)
    if (createHash('sha256').update(await readFile(target)).digest('hex') !== binding.testSourceFingerprint) return blocked('Approved test source changed; review the execution binding again')
    const require = createRequire(path.join(workspace, 'package.json'))
    let cli: string
    try {
      await stat(path.join(workspace, 'node_modules', '@playwright', 'test', 'package.json'))
      cli = require.resolve('@playwright/test/cli')
    } catch { return blocked('Target workspace requires an existing local @playwright/test installation') }
    const configs: string[] = []
    for (const name of ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mts', 'playwright.config.mjs', 'playwright.config.cts', 'playwright.config.cjs']) {
      try { if ((await stat(path.join(workspace, name))).isFile()) configs.push(name) } catch {}
    }
    if (configs.length > 1) return blocked('Ambiguous Playwright configuration')
    directory = await mkdtemp(path.join(tmpdir(), 'codeflow-playwright-'))
    wrapper = path.join(workspace, `.codeflow-playwright-${randomUUID()}.config.ts`)
    const configSource = (configs.length ? `import config from ${JSON.stringify(`./${configs[0]}`)};\n` : 'const config = {};\n')
      + `const discovery = { testDir: ${JSON.stringify(path.dirname(target))}, testMatch: new RegExp(${JSON.stringify(`(?:^|[/\\\\])${escaped(path.basename(target))}$`)}), testIgnore: [] };\n`
      + 'export default { ...config, ...discovery, ...(config.projects ? { projects: config.projects.map(project => ({ ...project, ...discovery })) } : {}), webServer: undefined };\n'
    await writeFile(wrapper, configSource, { flag: 'wx' })
    const reporter = fileURLToPath(new URL('./playwright-reporter.cjs', import.meta.url))
    try { if (!(await stat(reporter)).isFile()) return blocked('Playwright execution reporter unavailable') }
    catch { return blocked('Playwright execution reporter unavailable') }
    const reportFile = path.join(directory, 'execution.json')
    const jsonFile = path.join(directory, 'playwright.json')
    const timeoutMs = Math.min(300_000, Math.max(1000, options.timeoutMs ?? 60_000))
    const args = [cli, 'test', `${escaped(target.replaceAll('\\', '/'))}$`, '--config', wrapper, '--project', binding.project,
      '--grep', `(?:^| )${escaped(binding.testTitle)}(?: @\\S+)*$`, '--no-deps', '--retries', '0', '--workers', '1', '--repeat-each', '1',
      '--reporter', `json,${reporter}`, '--output', path.join(directory, 'artifacts'), '--global-timeout', String(timeoutMs)]
    const execution = await new Promise<{ code: number | null; bounded: boolean; timedOut: boolean }>((resolve, reject) => {
      if (options.signal?.aborted) { resolve({ code: null, bounded: false, timedOut: false }); return }
      const child = spawn(process.execPath, args, { cwd: workspace, shell: false, windowsHide: true,
        detached: process.platform !== 'win32',
        env: { ...environment, CODEFLOW_PLAYWRIGHT_REPORT: reportFile, PLAYWRIGHT_JSON_OUTPUT_FILE: jsonFile, PLAYWRIGHT_JSON_OUTPUT_NAME: jsonFile } })
      let bytes = 0
      let bounded = false
      let timedOut = false
      let settled = false
      let stopping = false
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined
      let forceTimer: ReturnType<typeof setTimeout> | undefined
      let killer: ReturnType<typeof spawn> | undefined
      const cleanup = () => {
        clearTimeout(timer)
        clearTimeout(cleanupTimer)
        clearTimeout(forceTimer)
        options.signal?.removeEventListener('abort', stop)
      }
      const finish = (code: number | null, error?: Error) => {
        if (settled) return
        settled = true
        if (stopping && process.platform !== 'win32') terminateGroup('SIGKILL')
        cleanup()
        if (error && !stopping && !options.signal?.aborted) reject(error)
        else resolve({ code, bounded, timedOut })
      }
      const terminateGroup = (signal: NodeJS.Signals) => {
        try { if (child.pid) process.kill(-child.pid, signal) }
        catch { try { child.kill(signal) } catch {} }
      }
      const stop = () => {
        if (stopping || settled) return
        stopping = true
        if (process.platform === 'win32' && child.pid) {
          killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' })
          killer.once('error', () => { try { child.kill() } catch {} })
        } else terminateGroup('SIGTERM')
        forceTimer = setTimeout(() => {
          if (process.platform !== 'win32') terminateGroup('SIGKILL')
        }, 150)
        cleanupTimer = setTimeout(() => {
          try { child.kill() } catch {}
          try { killer?.kill() } catch {}
          child.stdout.destroy()
          child.stderr.destroy()
          child.unref()
          finish(null)
        }, 750)
      }
      const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs + 2000)
      const consume = (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1024 * 1024) { bounded = true; stop() } }
      child.stdout.on('data', consume)
      child.stderr.on('data', consume)
      child.once('error', error => { if (!stopping) finish(null, error) })
      child.once('close', code => finish(code))
      options.signal?.addEventListener('abort', stop, { once: true })
      if (options.signal?.aborted) stop()
    })
    if (options.signal?.aborted) return cancelled()
    if (execution.bounded || execution.timedOut) return resultFor(options, startedAt, 'incomplete', 'Playwright exceeded execution limits')
    if ((await stat(reportFile)).size > 2 * 1024 * 1024) return resultFor(options, startedAt, 'incomplete', 'Execution report exceeded size limit')
    if ((await stat(jsonFile)).size > 2 * 1024 * 1024) return resultFor(options, startedAt, 'incomplete', 'Native JSON report exceeded size limit')
    const report = JSON.parse(await readFile(reportFile, 'utf8'))
    if (options.signal?.aborted) return cancelled()
    return validatePlaywrightReport(report, options, target, execution.code, startedAt)
  } catch {
    if (options.signal?.aborted) return cancelled()
    return blocked('Playwright preparation or report unavailable; no execution pass recorded')
  } finally {
    if (wrapper) await rm(wrapper, { force: true }).catch(() => {})
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}