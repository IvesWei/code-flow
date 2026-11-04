import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { buildAssertionManifest } from '../../shared/test-execution.js'
import type { SelfTestCase } from '../../shared/task.js'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, watch, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildCaseExecutionFingerprint, runPlaywrightTest, validatePlaywrightReport, type PlaywrightTestOptions } from './playwright-test.js'

const sample: SelfTestCase = {
  id: 'TC-1', title: 'example', source: 'requirement', steps: 'click',
  expected: 'visible', assertions: ['visible'], status: 'pending',
}

test('manifest binds definition fields, not execution state or object property order', () => {
  const manifest = buildAssertionManifest(sample)
  assert.equal(manifest.assertions[0].id, 'TC-1:A001')
  assert.equal(buildAssertionManifest({ ...sample, status: 'passed', output: 'ok' }).definitionKey, manifest.definitionKey)
  for (const field of ['title', 'steps', 'expected', 'preconditions', 'testData', 'cleanup', 'source', 'testFile'] as const) {
    assert.notEqual(buildAssertionManifest({ ...sample, [field]: 'changed' }).definitionKey, manifest.definitionKey)
  }
  assert.notEqual(buildAssertionManifest({ ...sample, assertions: ['other'] }).definitionKey, manifest.definitionKey)
  assert.deepEqual(buildAssertionManifest({ ...sample, assertions: undefined }).assertions, [])
})

function options(workspace = process.cwd(), source = ''): PlaywrightTestOptions {
  return {
    workspace, testCase: sample, designFingerprint: 'design-v1', timeoutMs: 30_000,
    binding: {
      version: 1, caseFingerprint: buildCaseExecutionFingerprint(sample), designFingerprint: 'design-v1',
      testFile: 'sample.spec.ts', testTitle: 'target', project: 'chromium',
      testSourceFingerprint: createHash('sha256').update(source).digest('hex'),
      assertionIds: ['TC-1:A001'], approvedBy: 'human-reviewer',
      approvedAt: '2026-10-20T00:00:00Z', reviewedAt: '2026-10-20T00:00:00Z',
    },
  }
}

function report(target = path.resolve('sample.spec.ts')) {
  return {
    version: 1, status: 'passed', errors: 0,
    tests: [{
      file: target, fullTitle: 'target', titlePath: ['', 'chromium', 'sample.spec.ts', 'target'],
      project: 'chromium', status: 'passed', expectedStatus: 'passed', retry: 0, errorCount: 0, skipped: false,
      checks: [{ id: 'TC-1:A001', expectCount: 1, failed: false, skipped: false }],
    }],
  }
}

test('strict reports require one exact target and all actual expect groups', () => {
  const target = path.resolve('sample.spec.ts')
  assert.equal(validatePlaywrightReport(report(), options(), target, 0).status, 'passed')
  const invalid: [string, (value: ReturnType<typeof report>) => void][] = [
    ['missing assertion', value => { value.tests[0].checks = [] }],
    ['no expect', value => { value.tests[0].checks[0].expectCount = 0 }],
    ['skipped group', value => { value.tests[0].checks[0].skipped = true }],
    ['skipped test', value => { value.tests[0].status = 'skipped'; value.tests[0].skipped = true }],
    ['interrupted', value => { value.tests[0].status = 'interrupted' }],
    ['wrong project', value => { value.tests[0].project = 'other' }],
    ['wrong title', value => { value.tests[0].fullTitle = 'other' }],
    ['wrong file', value => { value.tests[0].file = path.resolve('other.spec.ts') }],
    ['retry', value => { value.tests[0].retry = 1 }],
    ['expected failure', value => { value.tests[0].expectedStatus = 'failed' }],
    ['no results', value => { value.tests = [] }],
    ['unrelated test', value => { value.tests.push(structuredClone(value.tests[0])) }],
    ['duplicate assertion', value => { value.tests[0].checks.push(structuredClone(value.tests[0].checks[0])) }],
    ['unknown assertion', value => { value.tests[0].checks[0].id = 'unknown' }],
    ['global error', value => { value.errors = 1 }],
    ['flaky attempts', value => { const retry = structuredClone(value.tests[0]); retry.retry = 1; value.tests.push(retry) }],
  ]
  for (const [name, mutate] of invalid) {
    const value = report()
    mutate(value)
    assert.notEqual(validatePlaywrightReport(value, options(), target, 0).status, 'passed', name)
  }
  assert.notEqual(validatePlaywrightReport(report(), options(), target, 1).status, 'passed')
  assert.notEqual(validatePlaywrightReport(null, options(), target, 0).status, 'passed')
  const failed = report()
  failed.tests[0].checks[0].failed = true
  failed.tests[0].status = 'failed'
  assert.equal(validatePlaywrightReport(failed, options(), target, 1).status, 'failed')
})

test('binding approval, assertion coverage and current definition are required before launch', async () => {
  const variants = [
    { ...options(), testCase: { ...sample, steps: 'changed' } },
    { ...options(), designFingerprint: 'new-design' },
    { ...options(), testCase: { ...sample, assertions: [] } },
    { ...options(), binding: { ...options().binding, approvedBy: '' } },
    { ...options(), binding: { ...options().binding, reviewedAt: '' } },
    { ...options(), binding: { ...options().binding, assertionIds: [] } },
  ]
  for (const variant of variants) assert.equal((await runPlaywrightTest(variant)).status, 'blocked')
})

test('unsafe, symlink and oversized target sources are blocked', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'codeflow-pw-path-'))
  try {
    const execution = options(workspace)
    for (const testFile of ['../outside.spec.ts', '/absolute.spec.ts', 'missing.spec.ts']) {
      assert.equal((await runPlaywrightTest({ ...execution, binding: { ...execution.binding, testFile } })).status, 'blocked')
    }
    await writeFile(path.join(workspace, 'sample.spec.ts'), 'x'.repeat(128 * 1024 + 1))
    assert.equal((await runPlaywrightTest(execution)).status, 'blocked')
    await mkdir(path.join(workspace, 'real'))
    await writeFile(path.join(workspace, 'real', 'sample.spec.ts'), 'export {}')
    await symlink(path.join(workspace, 'real'), path.join(workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal((await runPlaywrightTest({ ...execution, binding: { ...execution.binding, testFile: 'linked/sample.spec.ts' } })).status, 'blocked')
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

const localRequire = createRequire(import.meta.url)
test('changed source is blocked before toolchain preparation', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'codeflow-pw-source-'))
  try {
    const source = 'export {}\n'
    const execution = options(workspace, source)
    await writeFile(path.join(workspace, 'sample.spec.ts'), `${source}export const changed = true\n`)
    const result = await runPlaywrightTest(execution)
    assert.equal(result.status, 'blocked')
    assert.equal(result.reason, 'Approved test source changed; review the execution binding again')
    await writeFile(path.join(workspace, 'sample.spec.ts'), source)
    assert.equal((await runPlaywrightTest(execution)).reason, 'Target workspace requires an existing local @playwright/test installation')
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('custom reporter records native expect leaves, skip/failure signals and attempts without raw secrets', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codeflow-pw-reporter-'))
  const previous = process.env.CODEFLOW_PLAYWRIGHT_REPORT
  try {
    process.env.CODEFLOW_PLAYWRIGHT_REPORT = path.join(directory, 'report.json')
    const Reporter = localRequire('./playwright-reporter.cjs')
    const reporter = new Reporter()
    const nativeTest = {
      location: { file: path.resolve('sample.spec.ts') },
      titlePath: () => ['', 'chromium', 'sample.spec.ts', 'target'],
      parent: { project: () => ({ name: 'chromium' }) }, expectedStatus: 'passed', annotations: [],
    }
    const expectStep = { category: 'expect', title: 'expect.toBe', steps: [], error: undefined, annotations: [] }
    const group = { category: 'test.step', title: '[assertion:TC-1:A001]', steps: [expectStep], annotations: [] }
    reporter.onTestEnd(nativeTest, { status: 'passed', retry: 0, errors: [], steps: [group] })
    reporter.onTestEnd(nativeTest, { status: 'failed', retry: 1, errors: [{ message: 'SECRET' }], steps: [{ ...group, steps: [{ ...expectStep, error: { message: 'SECRET' } }] }] })
    reporter.onTestEnd(nativeTest, { status: 'passed', retry: 0, errors: [], steps: [{ ...group, annotations: [{ type: 'skip' }] }] })
    reporter.onTestEnd(nativeTest, { status: 'passed', retry: 0, errors: [], steps: [{ ...group, steps: [{ ...group, title: '[assertion:TC-1:A002]' }] }] })
    reporter.onEnd({ status: 'failed' })
    const raw = await readFile(process.env.CODEFLOW_PLAYWRIGHT_REPORT, 'utf8')
    const actual = JSON.parse(raw)
    assert.equal(actual.tests[0].checks[0].expectCount, 1)
    assert.equal(actual.tests[1].retry, 1)
    assert.equal(actual.tests[1].checks[0].failed, true)
    assert.equal(actual.tests[2].checks[0].skipped, true)
    assert.equal(actual.tests[3].checks[0].expectCount, 0)
    assert.equal(actual.tests[3].checks[1].expectCount, 1)
    assert.equal(raw.includes('SECRET'), false)
  } finally {
    if (previous === undefined) delete process.env.CODEFLOW_PLAYWRIGHT_REPORT
    else process.env.CODEFLOW_PLAYWRIGHT_REPORT = previous
    await rm(directory, { recursive: true, force: true })
  }
})

let toolchain: string | undefined
try { toolchain = path.dirname(localRequire.resolve('@playwright/test/package.json')) } catch {}

test('pre-aborted execution is incomplete before source or CLI preparation', async () => {
  const controller = new AbortController()
  controller.abort()
  const result = await runPlaywrightTest({ ...options('missing-workspace'), signal: controller.signal })
  assert.equal(result.status, 'incomplete')
  assert.equal(result.reason, 'cancelled')
})

test('invalid preview URLs and arbitrary environment keys are rejected before source or spawn', async () => {
  for (const value of ['https://localhost:3000', 'http://localhost.evil.test', 'http://example.com', 'http://user:secret@localhost:3000', 'http://localhost:3000/?token=secret', 'http://localhost:3000/#secret', 'not-a-url']) {
    const result = await runPlaywrightTest({ ...options('missing-workspace'), env: { CODEFLOW_BASE_URL: value } })
    assert.equal(result.status, 'blocked')
    assert.equal(result.reason, 'Only CODEFLOW_BASE_URL with a local HTTP preview URL is allowed')
    assert.equal(JSON.stringify(result).includes('secret'), false)
  }
  for (const env of [{ TOKEN: 'secret' }, { NODE_OPTIONS: '--require=untrusted', CODEFLOW_BASE_URL: 'http://localhost:3000' }]) {
    const result = await runPlaywrightTest({ ...options('missing-workspace'), env })
    assert.equal(result.reason, 'Only CODEFLOW_BASE_URL with a local HTTP preview URL is allowed')
  }
})

async function localFixture(source: string, config: string) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'codeflow-pw-cancel-'))
  await mkdir(path.join(workspace, 'node_modules', '@playwright'), { recursive: true })
  await symlink(toolchain!, path.join(workspace, 'node_modules', '@playwright', 'test'), process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(path.join(workspace, 'package.json'), JSON.stringify({ private: true }))
  await writeFile(path.join(workspace, 'playwright.config.ts'), config)
  await writeFile(path.join(workspace, 'sample.spec.ts'), source)
  return workspace
}

test('real local CLI receives validated base URL in target configuration without modifying source', { skip: !toolchain }, async () => {
  const source = `import { test, expect } from '@playwright/test';
test('target', async ({ baseURL }) => { await test.step('[assertion:TC-1:A001]', async () => { expect(baseURL).toBe('http://localhost:4567/preview'); expect(process.env.CODEFLOW_BASE_URL).toBe(baseURL); }); });
`
  const config = `export default { projects: [{ name: 'chromium' }], use: { baseURL: process.env.CODEFLOW_BASE_URL }, webServer: { command: 'node -e "process.exit(97)"', port: 9 } };\n`
  const workspace = await localFixture(source, config)
  try {
    const result = await runPlaywrightTest({ ...options(workspace, source), env: { CODEFLOW_BASE_URL: 'http://localhost:4567/preview' } })
    assert.equal(result.status, 'passed', JSON.stringify(result))
    assert.equal(await readFile(path.join(workspace, 'sample.spec.ts'), 'utf8'), source)
    assert.equal(await readFile(path.join(workspace, 'playwright.config.ts'), 'utf8'), config)
    assert.deepEqual((await readdir(workspace)).sort(), ['node_modules', 'package.json', 'playwright.config.ts', 'sample.spec.ts'])
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

for (const projectDiscovery of [false, true]) {
  test(`real CLI bounds standalone discovery with ${projectDiscovery ? 'project' : 'top-level'} overrides`, { skip: !toolchain }, async () => {
    const source = `import { test as base, expect } from '@playwright/test';
const test = base.extend({ marker: async ({}, use) => { await use('fixture-preserved'); } });
test.describe('approved suite', () => {
  test('target [exact].*', async ({ marker, baseURL }, testInfo) => {
    await test.step('[assertion:TC-1:A001]', async () => { expect(marker).toBe('fixture-preserved'); expect(baseURL).toBe('http://localhost:4567/'); expect(process.env.CODEFLOW_BASE_URL).toBe(baseURL); });
    await test.step('[assertion:TC-1:A002]', async () => { expect(testInfo.project.name).toBe('chromium'); expect(testInfo.project.use.locale).toBe('fr-FR'); expect(testInfo.timeout).toBe(12345); expect(testInfo.config.metadata).toMatchObject({ preserved: true }); });
  });
  test('target [exact].* suffix', () => { throw new Error('Unapproved title ran'); });
});
`
    const overrides = `testDir: 'project-tests', testMatch: '**/never-project.spec.ts', testIgnore: '**/*', `
    const config = `export default { testDir: 'tests', testMatch: '**/never-top.spec.ts', testIgnore: '**/*', metadata: { preserved: true }, use: { baseURL: process.env.CODEFLOW_BASE_URL, locale: 'en-US' }, projects: [
  { name: 'setup', testDir: 'setup-tests' },
  { name: 'chromium', ${projectDiscovery ? overrides : ''}dependencies: ['setup'], timeout: 12345, use: { locale: 'fr-FR' } },
  { name: 'other', testDir: 'other-tests', use: { baseURL: 'http://unselected.invalid' } }
], webServer: { command: 'node -e "process.exit(97)"', port: 9 } };\n`
    const workspace = await localFixture(source, config)
    const testFile = '.codeflow-tests/approved [exact]+.spec.ts'
    const target = path.join(workspace, testFile)
    const unrelated = `throw new Error('Unapproved file was discovered');\n`
    try {
      await mkdir(path.dirname(target))
      await writeFile(target, source)
      await writeFile(path.join(path.dirname(target), 'approved eexact.spec.ts'), unrelated)
      await mkdir(path.join(path.dirname(target), 'nested'))
      await writeFile(path.join(path.dirname(target), 'nested', path.basename(target)), unrelated)
      for (const directory of ['tests', 'project-tests', 'setup-tests', 'other-tests']) {
        await mkdir(path.join(workspace, directory))
        await writeFile(path.join(workspace, directory, 'unrelated.spec.ts'), unrelated)
      }
      const testCase = { ...sample, assertions: ['visible', 'configuration preserved'] }
      const execution = {
        ...options(workspace, source), testCase, env: { CODEFLOW_BASE_URL: 'http://localhost:4567' },
        binding: {
          ...options(workspace, source).binding, testFile, testTitle: 'approved suite target [exact].*',
          caseFingerprint: buildCaseExecutionFingerprint(testCase), assertionIds: ['TC-1:A001', 'TC-1:A002'],
        },
      }
      const result = await runPlaywrightTest(execution)
      assert.equal(result.status, 'passed', JSON.stringify(result))
      assert.deepEqual(result.assertions.map(({ id, status }) => ({ id, status })), [
        { id: 'TC-1:A001', status: 'passed' }, { id: 'TC-1:A002', status: 'passed' },
      ])
      assert.ok(result.assertions.every(assertion => assertion.expectCount > 0))
      const uncoveredCase = { ...testCase, assertions: [...testCase.assertions, 'missing assertion'] }
      const uncovered = await runPlaywrightTest({
        ...execution, testCase: uncoveredCase,
        binding: { ...execution.binding, caseFingerprint: buildCaseExecutionFingerprint(uncoveredCase), assertionIds: ['TC-1:A001', 'TC-1:A002', 'TC-1:A003'] },
      })
      assert.equal(uncovered.status, 'incomplete', JSON.stringify(uncovered))
      assert.equal(uncovered.assertions[2].status, 'missing')
      assert.equal(await readFile(target, 'utf8'), source)
      assert.equal(await readFile(path.join(workspace, 'sample.spec.ts'), 'utf8'), source)
      assert.equal(await readFile(path.join(workspace, 'playwright.config.ts'), 'utf8'), config)
      assert.equal(await readFile(path.join(path.dirname(target), 'approved eexact.spec.ts'), 'utf8'), unrelated)
      assert.equal((await readdir(workspace)).some(name => /^\.codeflow-playwright-/.test(name)), false)
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })
}

test('real local CLI long test cancels its process tree below one second without Chrome', { skip: !toolchain }, async () => {
  const source = `import { test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
test('target', async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.send(process.pid); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const descendant = await new Promise(resolve => child.once('message', resolve));
  await writeFile('ready.json', JSON.stringify([process.pid, descendant]));
  await new Promise(() => {});
});
`
  const config = `export default { projects: [{ name: 'chromium' }], timeout: 120000 };\n`
  const workspace = await localFixture(source, config)
  const controller = new AbortController()
  const watcher = watch(workspace, { signal: AbortSignal.timeout(15000) })
  const execution = runPlaywrightTest({ ...options(workspace, source), signal: controller.signal })
  try {
    for await (const event of watcher) { if (event.filename === 'ready.json') break }
    const pids: number[] = JSON.parse(await readFile(path.join(workspace, 'ready.json'), 'utf8'))
    const started = performance.now()
    controller.abort()
    const result = await execution
    const elapsed = performance.now() - started
    assert.equal(result.status, 'incomplete')
    assert.equal(result.reason, 'cancelled')
    assert.ok(elapsed < 1000, `Cancellation took ${elapsed}ms`)
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), `Process ${pid} survived cancellation`)
    assert.equal(await readFile(path.join(workspace, 'sample.spec.ts'), 'utf8'), source)
    assert.equal(await readFile(path.join(workspace, 'playwright.config.ts'), 'utf8'), config)
    assert.equal((await readdir(workspace)).some(name => name.startsWith('.codeflow-')), false)
  } finally {
    controller.abort()
    await watcher.return()
    await execution
    await rm(workspace, { recursive: true, force: true })
  }
})

for (const behavior of ['click', 'layout', 'network'] as const) {
  test(`real CLI and reporter: isolated ${behavior} assertion`, { skip: toolchain ? false : 'Local @playwright/test not installed; no automatic installation' }, async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'codeflow-pw-real-'))
    try {
      await mkdir(path.join(workspace, 'node_modules', '@playwright'), { recursive: true })
      await symlink(toolchain!, path.join(workspace, 'node_modules', '@playwright', 'test'), process.platform === 'win32' ? 'junction' : 'dir')
      await writeFile(path.join(workspace, 'package.json'), JSON.stringify({ private: true }))
      const originalConfig = `export default { projects: [{ name: 'chromium', use: { browserName: 'chromium', channel: 'chrome', headless: true } }], webServer: { command: 'node -e "process.exit(97)"', port: 9 } };\n`
      await writeFile(path.join(workspace, 'playwright.config.ts'), originalConfig)
      const body = {
        click: `await page.setContent('<button>Go</button><output>waiting</output><script>document.querySelector("button").onclick=()=>document.querySelector("output").textContent="done"</script>'); await page.getByRole('button').click(); await expect(page.locator('output')).toHaveText('done');`,
        layout: `await page.setContent('<div style="width:120px;height:40px">box</div>'); const box = await page.locator('div').boundingBox(); expect(box.width).toBe(120); expect(box.height).toBe(40);`,
        network: `await page.route('https://fixture.invalid/value', route => route.fulfill({ json: { value: 42 }, headers: { 'access-control-allow-origin': '*' } })); await page.goto('https://fixture.invalid/value'); await expect(page.locator('body')).toContainText('42');`,
      }[behavior]
      const source = `import { test, expect } from '@playwright/test';\ntest('target', async ({ page }) => { await test.step('[assertion:TC-1:A001]', async () => { ${body} }); });\n`
      await writeFile(path.join(workspace, 'sample.spec.ts'), source)
      const result = await runPlaywrightTest(options(workspace, source))
      assert.equal(result.status, 'passed', JSON.stringify(result))
      assert.ok(result.assertions[0].expectCount > 0)
      assert.equal(await readFile(path.join(workspace, 'playwright.config.ts'), 'utf8'), originalConfig)
      if (behavior === 'click') {
        const failures = [
          `await test.step('[assertion:TC-1:A001]', async () => { expect(1).toBe(2) });`,
          `await test.step('[assertion:TC-1:A001]', async () => {});`,
          `await test.step.skip('[assertion:TC-1:A001]', async () => { expect(1).toBe(1) });`,
        ]
        for (const [index, statement] of failures.entries()) {
          const failureSource = `import { test, expect } from '@playwright/test';\ntest('target', async () => { ${statement} });\n`
          await writeFile(path.join(workspace, 'sample.spec.ts'), failureSource)
          const failure = await runPlaywrightTest(options(workspace, failureSource))
          assert.equal(failure.status, index === 0 ? 'failed' : 'incomplete', JSON.stringify(failure))
        }
      }
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })
}