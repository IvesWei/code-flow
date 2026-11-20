import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, open, readFile, rm, stat, watch, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { validateRepository } from '../git/git.js'
import { loadRemoteCode, runRemoteGit, validateRemoteCodeInput, remoteCodeSnapshotLimits as codeSnapshotLimits, type RemoteGitRunner, type RemoteGitRunOptions } from './remote-code.js'

test('remote repository validation matches the coding workflow and normalizes optional input', () => {
  for (const repository of ['https://github.com/org/repo', 'https://github.com/org/repo.git', 'https://github.com/org/repo.git/', 'http://code.sunmi.com/team/repo', 'https://code.sunmi.com/team/repo.git']) {
    assert.deepEqual(validateRemoteCodeInput({ repository, branch: 'feature/safe-1', directory: 'src/module' }), { repository: validateRepository(repository), branch: 'feature/safe-1', directory: 'src/module' })
    assert.deepEqual(validateRemoteCodeInput({ repository, directory: '' }), { repository: validateRepository(repository) })
  }
  for (const repository of ['http://github.com/org/repo', 'file:///tmp/repo', 'ssh://github.com/org/repo', 'https://elsewhere.test/org/repo', 'https://user:PRIVATE_SENTINEL@github.com/org/repo', 'https://github.com:444/org/repo', 'https://github.com/org/repo?token=PRIVATE_SENTINEL']) {
    assert.throws(() => validateRepository(repository))
    assert.throws(() => validateRemoteCodeInput({ repository }), { message: '\u8fdc\u7a0b\u4ee3\u7801\u53c2\u6570\u65e0\u6548' })
  }
})

test('remote input rejects unknown fields, accessors, unsafe branches and directories', () => {
  const base = { repository: 'https://github.com/org/repo' }
  for (const value of [null, [], 1, {}, { ...base, version: 1 }, { ...base, [Symbol('extra')]: true }, Object.create(base), Object.defineProperty({ ...base }, 'branch', { get() { throw new Error('must not execute') } }), new Proxy(base, { getPrototypeOf() { throw new Error('PRIVATE_SENTINEL') } })]) assert.throws(() => validateRemoteCodeInput(value), { message: '\u8fdc\u7a0b\u4ee3\u7801\u53c2\u6570\u65e0\u6548' })
  for (const branch of ['', 'HEAD', '-flag', 'a..b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[', 'a\\b', 'a b', 'a\nb', 'a\u00a0b', 'a\u2028b', '@', 'a@{1}', 'a{b}', '.hidden', 'a/.b', '/a', 'a/', 'a//b', 'a.', 'a.lock', 'a.lock/b', 1, null]) assert.throws(() => validateRemoteCodeInput({ ...base, branch }), String(branch))
  for (const directory of ['..', '../src', 'src/../other', 'src/a..b', '/src', 'C:/src', 'C:\\src', '\\\\server\\src', '.git', 'src/.hidden', './src', 'src/', 'src//x', 'src/x.', 'src/a b', 'src/a\u00a0b', 'src/%2e', 1, null]) assert.throws(() => validateRemoteCodeInput({ ...base, directory }), String(directory))
})

const repository = 'https://github.com/org/repo.git'
const commit = 'a'.repeat(40)
const blobId = 'b'.repeat(40)
const source = Buffer.from('export const label = "\u4e2d\u6587"\n')
const commands = ['clone', 'rev-parse', 'ls-tree', 'cat-file']
type Call = { args: readonly string[]; options: RemoteGitRunOptions; command: string }
function tree(path = 'src/main.ts', content = source, mode = '100644', type = 'blob', oid = blobId): string {
  return `${mode} ${type} ${oid} ${type === 'commit' ? '-' : content.length}\t${path}\0`
}
function mockGit(overrides: { tree?: Buffer | string; blob?: Buffer; commit?: string; hook?: (call: Call) => Promise<void> } = {}) {
  const calls: Call[] = []
  const runner: RemoteGitRunner = async (args, options) => {
    const command = args.find(arg => commands.includes(arg))!
    const call = { args, options, command }
    calls.push(call)
    await overrides.hook?.(call)
    if (command === 'clone') return Buffer.alloc(0)
    if (command === 'rev-parse') return Buffer.from(`${overrides.commit ?? commit}\n`)
    if (command === 'ls-tree') return Buffer.from(overrides.tree ?? tree())
    if (command === 'cat-file') return overrides.blob ?? source
    throw new Error('unexpected command')
  }
  return { calls, runner }
}
async function assertCleaned(calls: Call[]) {
  assert.ok(calls.length)
  await assert.rejects(stat(calls[0].options.cwd), { code: 'ENOENT' })
}
async function assertSanitized(action: () => Promise<unknown>) {
  await assert.rejects(action, error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /[\u4e00-\u9fff]/)
    assert.doesNotMatch(error.message, /PRIVATE_SENTINEL|codeflow-remote-code-|https?:|stderr|[A-Z]:\\/)
    assert.equal(error.cause, undefined)
    return true
  })
}

test('remote load preserves branch/directory/commit evidence with bounded and isolated Git arguments', async () => {
  const mock = mockGit({ tree: tree() + tree('src/link.ts', source, '120000') + tree('src/module', source, '160000', 'commit') + tree('src/.hidden.ts') + tree('src/image.png') })
  const result = await loadRemoteCode({ repository, branch: 'feature/evidence', directory: 'src' }, undefined, mock)
  assert.deepEqual(result, { repository, branch: 'feature/evidence', directory: 'src', commit, files: [{ path: 'src/main.ts', content: source.toString('utf8') }], excluded: 4 })
  assert.deepEqual(mock.calls.map(call => call.command), commands)
  const config = ['protocol.allow=never', 'protocol.http.allow=always', 'protocol.https.allow=always', 'protocol.file.allow=never', 'protocol.ext.allow=never', 'http.followRedirects=false', 'http.proxy=', 'core.askPass=', 'core.fsmonitor=false', 'submodule.recurse=false', 'fetch.recurseSubmodules=false', 'transfer.bundleURI=false', 'filter.lfs.process=', 'filter.lfs.smudge=', 'fetch.fsckObjects=true']
  for (const { args, options } of mock.calls) {
    for (const setting of config) assert.ok(args.includes(setting), setting)
    assert.ok(args.includes('--literal-pathspecs'))
    assert.ok(args.some(arg => arg.startsWith('core.hooksPath=')))
    assert.equal(options.env.GIT_TERMINAL_PROMPT, '0')
    assert.equal(options.env.GCM_INTERACTIVE, 'Never')
    assert.equal(options.env.GIT_CONFIG_NOSYSTEM, undefined)
    assert.equal(options.env.GIT_LFS_SKIP_SMUDGE, '1')
    assert.equal(options.env.HOME, process.env.HOME)
    assert.equal(options.env.USERPROFILE, process.env.USERPROFILE)
    assert.equal(options.env.APPDATA, process.env.APPDATA)
    assert.equal(options.env.XDG_CONFIG_HOME, process.env.XDG_CONFIG_HOME)
    assert.equal(options.env.GIT_CEILING_DIRECTORIES, mock.calls[0].options.cwd)
    assert.equal(options.env.GIT_CONFIG_GLOBAL, undefined)
    assert.equal(options.env.GIT_CONFIG_SYSTEM, undefined)
    assert.ok(!args.includes('credential.helper='))
    assert.ok(options.signal instanceof AbortSignal)
    assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 60000)
    assert.equal(options.maxBuffer, { clone: 65536, 'rev-parse': 256, 'ls-tree': 2 * 1024 * 1024, 'cat-file': codeSnapshotLimits.fileBytes }[args.find(arg => commands.includes(arg))!])
    assert.ok(!args.some(arg => ['checkout', 'show', '--filters', '--textconv', '--recurse-submodules'].includes(arg)))
  }
  const clone = mock.calls[0].args
  for (const arg of ['--depth=1', '--single-branch', '--no-checkout', '--no-recurse-submodules', '--no-local']) assert.ok(clone.includes(arg))
  assert.deepEqual(clone.slice(clone.indexOf('--branch')), ['--branch', 'feature/evidence', '--', repository, join(mock.calls[0].options.cwd, 'repository')])
  assert.deepEqual(mock.calls[2].args.slice(mock.calls[2].args.indexOf('ls-tree')), ['ls-tree', '-r', '-z', '-l', '--full-tree', commit, '--', 'src/'])
  assert.deepEqual(mock.calls[3].args.slice(-3), ['cat-file', 'blob', blobId])
  await assertCleaned(mock.calls)
})

test('empty scope and filtered scope give distinct diagnostics before reading blobs', async () => {
  for (const [entries, diagnostic] of [['', /模块目录没有文件/], [tree('src/image.png') + tree('src/link.ts', source, '120000'), /2 个 Git 条目均不符合/]] as const) {
    const mock = mockGit({ tree: entries })
    await assert.rejects(loadRemoteCode({ repository, directory: 'src' }, undefined, mock), diagnostic)
    assert.deepEqual(mock.calls.map(call => call.command), ['clone', 'rev-parse', 'ls-tree'])
    await assertCleaned(mock.calls)
  }
})

test('remote runner environment excludes tokens, proxy and Git overrides while allowing local credential configuration', async () => {
  const keys = ['GIT_CONFIG', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_EXEC_PATH', 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'SSH_ASKPASS', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'https_proxy', 'GITHUB_TOKEN', 'GH_TOKEN', 'NODE_OPTIONS', 'LD_PRELOAD', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_TEMPLATE_DIR', 'GIT_SSL_NO_VERIFY']
  const previous = new Map(keys.map(key => [key, process.env[key]]))
  try {
    for (const key of keys) process.env[key] = 'PRIVATE_SENTINEL'
    const mock = mockGit()
    await loadRemoteCode({ repository }, undefined, mock)
    for (const key of keys) assert.equal(mock.calls[0].options.env[key], undefined, key)
    assert.doesNotMatch(JSON.stringify(mock.calls[0].options.env), /PRIVATE_SENTINEL/)
    await assertCleaned(mock.calls)
  } finally {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
})

test('local global credential helper configuration is available to the Git subprocess', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codeflow-credential-config-'))
  const previous = new Map(['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME'].map(key => [key, process.env[key]]))
  try {
    await writeFile(join(home, '.gitconfig'), '[credential]\n\thelper = codeflow-test-helper\n')
    for (const key of previous.keys()) process.env[key] = home
    const mock = mockGit({ hook: async ({ command, options }) => {
      if (command !== 'clone') return
      const { stdout } = await promisify(execFile)('git', ['config', '--global', '--get', 'credential.helper'], { cwd: options.cwd, env: options.env })
      assert.equal(stdout.trim(), 'codeflow-test-helper')
    } })
    await loadRemoteCode({ repository }, undefined, mock)
    await assertCleaned(mock.calls)
  } finally {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await rm(home, { recursive: true, force: true })
  }
})

test('all Git stage failures are sanitized and clean up temporary directories', async () => {
  for (const stage of commands) {
    const mock = mockGit({ hook: async ({ command, options }) => { if (command === stage) throw new Error(`stderr PRIVATE_SENTINEL ${options.cwd}`) } })
    await assertSanitized(() => loadRemoteCode({ repository }, undefined, mock))
    await assertCleaned(mock.calls)
  }
})

test('abort before and during every Git stage cleans up and stops further reads', async () => {
  const before = mockGit()
  await assertSanitized(() => loadRemoteCode({ repository }, AbortSignal.abort(), before))
  assert.equal(before.calls.length, 0)
  for (const stage of commands) {
    const controller = new AbortController()
    const mock = mockGit({ hook: async ({ command }) => { if (command === stage) controller.abort(new Error('PRIVATE_SENTINEL')) } })
    await assert.rejects(loadRemoteCode({ repository }, controller.signal, mock), { message: '\u8fdc\u7a0b\u4ee3\u7801\u83b7\u53d6\u5df2\u53d6\u6d88' })
    assert.equal(mock.calls.at(-1)?.command, stage)
    await assertCleaned(mock.calls)
  }
  const controller = new AbortController()
  const waiting = mockGit({ hook: async ({ command, options }) => {
    if (command !== 'clone') return
    const stopped = new Promise<void>((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('PRIVATE_SENTINEL')), { once: true }))
    controller.abort()
    await stopped
  } })
  await assertSanitized(() => loadRemoteCode({ repository }, controller.signal, waiting))
  await assertCleaned(waiting.calls)
})

test('tree metadata, scope and commit must be valid; no eligible blob is silently truncated', async () => {
  const cases = [
    { commit: 'PRIVATE_SENTINEL' }, { commit: `${commit}\n${commit}` },
    { tree: '' }, { tree: tree('src/link.ts', source, '120000') }, { tree: tree('other/main.ts') },
    { tree: tree().slice(0, -1) }, { tree: 'PRIVATE_SENTINEL\0' }, { tree: Buffer.from([255, 0]) },
    { tree: Buffer.alloc(2 * 1024 * 1024 + 1) },
    { tree: tree().replace(blobId, '-flag') },
    { tree: tree('src/large.ts', Buffer.alloc(codeSnapshotLimits.fileBytes + 1)) },
    { tree: Array.from({ length: codeSnapshotLimits.files + 1 }, (_, index) => tree(`src/${index}.ts`, Buffer.alloc(0))).join('') },
    { tree: Array.from({ length: codeSnapshotLimits.totalBytes / codeSnapshotLimits.fileBytes + 1 }, (_, index) => tree(`src/${index}.ts`, Buffer.alloc(codeSnapshotLimits.fileBytes))).join('') },
    { tree: tree() + tree('src/extra.ts', source, '100644', 'blob', 'c'.repeat(64)) + Array.from({ length: 9999 }, (_, index) => tree(`src/${index}.png`)).join('') },
  ]
  for (const fixture of cases) {
    const mock = mockGit(fixture)
    await assertSanitized(() => loadRemoteCode({ repository, directory: 'src' }, undefined, mock))
    assert.equal(mock.calls.filter(call => call.command === 'cat-file').length, 0)
    await assertCleaned(mock.calls)
  }
})

test('blob size, strict UTF-8, duplicate names, control characters and credentials fail closed', async () => {
  const contents = [Buffer.from([0xc3, 0x28]), Buffer.from([0]), Buffer.from(`const apiKey = "ghp_${'x'.repeat(36)}"`), Buffer.from('-----BEGIN PRIVATE KEY-----\nPRIVATE_SENTINEL'), Buffer.alloc(codeSnapshotLimits.fileBytes + 1, 'a')]
  for (const blob of contents) {
    const mock = mockGit({ tree: tree('src/main.ts', blob.length > codeSnapshotLimits.fileBytes ? source : blob), blob })
    await assertSanitized(() => loadRemoteCode({ repository }, undefined, mock))
    await assertCleaned(mock.calls)
  }
  for (const fixture of [{ tree: tree() + tree('SRC/Main.ts') }, { blob: Buffer.from('short') }]) {
    const mock = mockGit(fixture)
    await assertSanitized(() => loadRemoteCode({ repository }, undefined, mock))
    await assertCleaned(mock.calls)
  }
})

test('remote content safety exclusions preserve remaining files and disclose excluded paths without retaining unsafe content', async () => {
  const bad = Buffer.from('-----BEGIN PRIVATE KEY-----\nPRIVATE_SENTINEL')
  const goodId = 'c'.repeat(40)
  const mock = mockGit({ tree: tree('src/private.ts', bad) + tree('src/safe.ts', source, '100644', 'blob', goodId) })
  const runner: RemoteGitRunner = (args, options) => args.includes('cat-file') && args.at(-1) === blobId ? Promise.resolve(bad) : mock.runner(args, options)
  const result = await loadRemoteCode({ repository }, undefined, { runner })
  assert.deepEqual(result.files, [{ path: 'src/safe.ts', content: source.toString('utf8') }])
  assert.deepEqual(result.excludedFiles, ['src/private.ts'])
  assert.equal(result.excluded, 1)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL/)
  await assertCleaned(mock.calls)
})

test('remote snapshots retain component variables and ordinary authorization metadata without safety exclusions', async () => {
  const component = Buffer.from('<template><label>Approver</label><token>{{ currentToken }}</token></template>\n<script>const fields = { token: currentToken, password: passwordValue, authorization: "only-view" };</script>')
  const mock = mockGit({ tree: tree('src/DevConfirmItem.vue', component), blob: component })
  const result = await loadRemoteCode({ repository }, undefined, mock)
  assert.deepEqual(result.files, [{ path: 'src/DevConfirmItem.vue', content: component.toString('utf8') }])
  assert.equal(result.excluded, 0)
  assert.equal(result.excludedFiles, undefined)
  await assertCleaned(mock.calls)
})

test('exact file/count/total limits succeed and preserve BOM bytes', async () => {
  for (const [count, blob] of [[codeSnapshotLimits.files, Buffer.alloc(0)], [codeSnapshotLimits.totalBytes / codeSnapshotLimits.fileBytes, Buffer.alloc(codeSnapshotLimits.fileBytes, 'a')], [1, Buffer.from('\ufeffexport const value = 1')]] as const) {
    const mock = mockGit({ tree: Array.from({ length: count }, (_, index) => tree(`src/${index}.ts`, blob)).join(''), blob })
    const result = await loadRemoteCode({ repository }, undefined, mock)
    assert.equal(result.files.length, count)
    assert.equal(result.files[0].content, blob.toString('utf8'))
    assert.equal(result.branch, undefined)
    assert.equal(result.directory, undefined)
    await assertCleaned(mock.calls)
  }
})

test('clone object-size postcheck and live watchdog cancel and clean up oversized data', async () => {
  for (const live of [false, true]) {
    const mock = mockGit({ hook: async ({ command, args, options }) => {
      if (command !== 'clone') return
      const target = args.at(-1)!
      await mkdir(target)
      const file = await open(join(target, 'oversize.pack'), 'w')
      try { await file.truncate(256 * 1024 * 1024 + 1) } finally { await file.close() }
      if (live) await new Promise<void>((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('PRIVATE_SENTINEL')), { once: true }))
    } })
    await assert.rejects(loadRemoteCode({ repository }, undefined, mock), /临时克隆超过 256 MiB/)
    assert.equal(mock.calls.length, 1)
    await assertCleaned(mock.calls)
  }
})

test('real Git cancellation and timeout terminate descendant processes before returning', { timeout: 20000 }, async () => {
  for (const cancelled of [true, false]) {
    const temporary = await mkdtemp(join(tmpdir(), 'remote-git-process-'))
    const controller = new AbortController()
    let running: Promise<Buffer> | undefined
    try {
      const script = join(temporary, 'wait.cjs')
      const childScript = `const fs = require('node:fs'); const path = require('node:path'); fs.writeFileSync(path.join(process.argv[1], 'ready.tmp'), JSON.stringify({ parent: Number(process.argv[2]), child: process.pid })); fs.renameSync(path.join(process.argv[1], 'ready.tmp'), path.join(process.argv[1], 'ready.json')); setInterval(() => {}, 1000)`
      await writeFile(script, `const {spawn} = require('node:child_process'); spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}, ${JSON.stringify(temporary)}, String(process.pid)], {stdio: 'inherit'}); setInterval(() => {}, 1000)`)
      const ready = (async () => {
        for await (const event of watch(temporary, { signal: AbortSignal.timeout(10000) })) {
          if (event.filename === 'ready.json') return JSON.parse(await readFile(join(temporary, 'ready.json'), 'utf8')) as { parent: number; child: number }
        }
        throw new Error('Git descendant fixture did not start')
      })()
      running = runRemoteGit(['-c', `alias.codeflow-wait=!node "${script.replaceAll('\\', '/')}"`, 'codeflow-wait'], {
        cwd: temporary, env: process.env, signal: controller.signal, timeoutMs: cancelled ? 10000 : 2500, maxBuffer: 4096,
      })
      const rejected = assert.rejects(running, cancelled ? /已取消/ : /超时/)
      const processes = await ready
      if (cancelled) controller.abort()
      await rejected
      for (const pid of [processes.parent, processes.child]) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
    } finally {
      controller.abort()
      await running?.catch(() => {})
      await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  }
})

test('real Git errors classify authentication failures without exposing stderr and bound output', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'remote-git-errors-'))
  try {
    const script = join(temporary, 'fail.cjs')
    const options = { cwd: temporary, env: process.env, signal: new AbortController().signal, timeoutMs: 10000, maxBuffer: 1024 }
    await writeFile(script, 'process.stderr.write("Authentication failed PRIVATE_SENTINEL"); process.exitCode = 1')
    const args = ['-c', `alias.codeflow-fail=!node "${script.replaceAll('\\', '/')}"`, 'codeflow-fail']
    await assert.rejects(runRemoteGit(args, options), error => {
      assert.match((error as Error).message, /仓库认证失败/)
      assert.doesNotMatch((error as Error).message, /PRIVATE_SENTINEL|stderr/)
      return true
    })
    for (const diagnostic of ['fatal: unable to access PRIVATE_SENTINEL: The requested URL returned error: 302', 'fatal: unable to update url base from redirection PRIVATE_SENTINEL']) {
      await writeFile(script, `process.stderr.write(${JSON.stringify(diagnostic)}); process.exitCode = 1`)
      await assert.rejects(runRemoteGit(args, options), error => {
        assert.match((error as Error).message, /仓库地址发生重定向/)
        assert.doesNotMatch((error as Error).message, /PRIVATE_SENTINEL|stderr/)
        return true
      })
    }
    await writeFile(script, 'process.stdout.write("x".repeat(4096)); setInterval(() => {}, 1000)')
    await assert.rejects(runRemoteGit(args, options), /输出超出限制/)
  } finally { await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) }
})

const exec = promisify(execFile)
test('real local Git objects prove scoped root-relative paths, modes, branch and SHA-1/SHA-256 evidence without remote access', async () => {
  for (const format of ['sha1', 'sha256']) {
    const temporary = await mkdtemp(join(tmpdir(), 'remote-code-objects-'))
    try {
      const fixture = join(temporary, 'fixture')
      await mkdir(fixture)
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, HOME: temporary, USERPROFILE: temporary, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(temporary, 'no-config'), GIT_TERMINAL_PROMPT: '0' }
      const git = async (args: string[]) => (await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd: fixture, env, encoding: 'utf8' })).stdout.trim()
      await git(['init', `--object-format=${format}`, '--initial-branch=feature/evidence'])
      await mkdir(join(fixture, 'src'))
      await writeFile(join(fixture, 'src', 'main.ts'), source)
      await writeFile(join(fixture, 'outside.ts'), 'never read outside directory')
      await writeFile(join(fixture, '.gitattributes'), '*.ts filter=untrusted')
      await git(['add', '.'])
      await git(['commit', '-m', 'fixture'])
      const initialCommit = await git(['rev-parse', 'HEAD'])
      const oid = await git(['rev-parse', 'HEAD:src/main.ts'])
      await git(['update-index', '--add', '--cacheinfo', `120000,${oid},src/link.ts`])
      await git(['update-index', '--add', '--cacheinfo', `160000,${initialCommit},src/module`])
      await git(['commit', '-m', 'special modes'])
      const expectedCommit = await git(['rev-parse', 'HEAD'])
      const calls: Call[] = []
      const runner: RemoteGitRunner = async (args, options) => {
        const command = args.find(arg => commands.includes(arg))!
        calls.push({ command, args, options })
        if (command === 'clone') {
          const target = args.at(-1)!
          await mkdir(target)
          await cp(join(fixture, '.git'), join(target, '.git'), { recursive: true })
          return Buffer.alloc(0)
        }
        return (await exec('git', [...args], { cwd: options.cwd, env: options.env, signal: options.signal, timeout: options.timeoutMs, maxBuffer: options.maxBuffer, encoding: 'buffer', shell: false })).stdout
      }
      const result = await loadRemoteCode({ repository, branch: 'feature/evidence', directory: 'src' }, undefined, { runner })
      assert.deepEqual(result.files, [{ path: 'src/main.ts', content: source.toString('utf8') }])
      assert.equal(result.excluded, 2)
      assert.equal(result.branch, 'feature/evidence')
      assert.equal(result.commit, expectedCommit)
      assert.equal(result.commit.length, format === 'sha1' ? 40 : 64)
      assert.equal(calls.filter(call => call.command === 'cat-file').length, 1)
      await assertCleaned(calls)
    } finally { await rm(temporary, { recursive: true, force: true, maxRetries: 3 }) }
  }
})