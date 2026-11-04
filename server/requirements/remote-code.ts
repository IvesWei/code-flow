import { execFile, spawn } from 'node:child_process'
import { mkdtemp, mkdir, readdir, lstat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codeFileAllowed } from '../../shared/requirement-code.js'
import { validateRepository } from '../git/git.js'
import { createCodeSnapshot } from './code-snapshot.js'

export interface RemoteCodeInput {
  repository: string
  branch?: string
  directory?: string
}

function invalidInput(): never { throw new Error('\u8fdc\u7a0b\u4ee3\u7801\u53c2\u6570\u65e0\u6548') }

function normalizeRemoteCodeInput(value: unknown): RemoteCodeInput {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalidInput()
  const keys = Reflect.ownKeys(value)
  if (!keys.includes('repository') || keys.some(key => typeof key !== 'string' || !['repository', 'branch', 'directory'].includes(key))) invalidInput()
  const fields = Object.getOwnPropertyDescriptors(value)
  if (Object.values(fields).some(field => !Object.hasOwn(field, 'value'))) invalidInput()
  const repository = fields.repository.value
  const branch = fields.branch?.value
  const directory = fields.directory?.value
  if (typeof repository !== 'string' || repository.length > 2048) invalidInput()
  let normalizedRepository: string
  try { normalizedRepository = validateRepository(repository) } catch { invalidInput() }
  if (branch !== undefined && (typeof branch !== 'string' || !branch || branch === 'HEAD' || branch.length > 240 || branch.startsWith('-') || /[\s\p{Cc}~^:?*[\\@{}]/u.test(branch) || branch.includes('..') || branch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock')))) invalidInput()
  if (directory !== undefined && (typeof directory !== 'string' || directory.length > 240 || directory.includes('..') || (directory !== '' && (/[\s\p{Cc}\\:%<>"|?*]/u.test(directory) || directory.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.')))))) invalidInput()
  return { repository: normalizedRepository, ...(branch !== undefined ? { branch } : {}), ...(directory ? { directory } : {}) }
}

export function validateRemoteCodeInput(value: unknown): RemoteCodeInput {
  try { return normalizeRemoteCodeInput(value) } catch { invalidInput() }
}

export interface RemoteGitRunOptions {
  readonly cwd: string
  readonly env: Readonly<NodeJS.ProcessEnv>
  readonly signal: AbortSignal
  readonly timeoutMs: number
  readonly maxBuffer: number
}

export type RemoteGitRunner = (args: readonly string[], options: RemoteGitRunOptions) => Promise<Buffer>

export interface RemoteCodeResult extends RemoteCodeInput {
  files: { path: string; content: string }[]
  commit: string
  excluded: number
  excludedFiles?: string[]
}

const treeBytes = 2 * 1024 * 1024
export const remoteCodeSnapshotLimits = Object.freeze({ files: 2000, fileBytes: 512 * 1024, totalBytes: 8 * 1024 * 1024 })
const cloneBytes = 256 * 1024 * 1024
const treeEntries = 10000
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/

export class RemoteCodeError extends Error {}
function unsafe(): never { throw new RemoteCodeError('\u8fdc\u7a0b\u4ee3\u7801\u4e0d\u5b89\u5168\u3001\u683c\u5f0f\u65e0\u6548\u6216\u8d85\u51fa\u9650\u5236') }

export const runRemoteGit: RemoteGitRunner = (args, options) => new Promise((resolve, reject) => {
  if (options.signal.aborted) { reject(new RemoteCodeError('远程代码获取已取消')); return }
  const child = spawn('git', [...args], {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    shell: false,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout: Buffer[] = [], stderr: Buffer[] = []
  let stdoutBytes = 0, stderrBytes = 0
  let failure: RemoteCodeError | undefined
  let stopping: Promise<void> | undefined
  const stop = (error: RemoteCodeError) => {
    if (failure) return
    failure = error
    if (!child.pid) return
    if (process.platform === 'win32') {
      stopping = new Promise<void>(done => {
        execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }, () => { child.kill('SIGKILL'); done() })
      })
    } else {
      try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
    }
  }
  const abort = () => stop(new RemoteCodeError('远程代码获取已取消'))
  const timer = setTimeout(() => stop(new RemoteCodeError('远程 Git 操作超时，请检查网络或缩小仓库范围')), options.timeoutMs)
  options.signal.addEventListener('abort', abort, { once: true })
  if (options.signal.aborted) abort()
  child.stdout.on('data', (bytes: Buffer) => {
    stdoutBytes += bytes.length
    if (stdoutBytes > options.maxBuffer) stop(new RemoteCodeError('远程 Git 输出超出限制，请缩小仓库范围'))
    else stdout.push(bytes)
  })
  child.stderr.on('data', (bytes: Buffer) => {
    stderrBytes += bytes.length
    if (stderrBytes > options.maxBuffer) stop(new RemoteCodeError('远程 Git 输出超出限制，请缩小仓库范围'))
    else stderr.push(bytes)
  })
  child.on('error', () => { failure ??= new RemoteCodeError('无法启动 Git，请检查服务运行账户的 Git 安装和权限') })
  child.on('close', code => {
    clearTimeout(timer)
    options.signal.removeEventListener('abort', abort)
    void (async () => {
      await stopping
      if (failure) { reject(failure); return }
      if (code === 0) { resolve(Buffer.concat(stdout)); return }
      const diagnostic = Buffer.concat(stderr).toString('utf8')
      const message = /Authentication failed|could not read Username|could not read Password|unable to get password|401|403/i.test(diagnostic)
        ? '仓库认证失败，请检查 API 服务运行账户的本机 Git 凭据和仓库权限'
        : /Remote branch .* not found|couldn.t find remote ref/i.test(diagnostic)
          ? '远程分支不存在，请检查分支名称'
          : /SSL certificate|certificate verification/i.test(diagnostic)
            ? '仓库 TLS 证书校验失败，请检查服务端证书配置'
            : '远程 Git 读取失败，请检查仓库地址、网络和访问权限'
      reject(new RemoteCodeError(message))
    })()
  })
})

function isolatedEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432']) {
    const actualKey = Object.keys(process.env).find(candidate => candidate.toLowerCase() === key.toLowerCase())
    if (actualKey) env[key] = process.env[actualKey]
  }
  return {
    ...env,
    TMPDIR: home, TMP: home, TEMP: home,
    GIT_CEILING_DIRECTORIES: home,
    GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_LFS_SKIP_SMUDGE: '1',
    GIT_PAGER: '', GIT_EDITOR: '', LC_ALL: 'C',
  }
}

function gitConfiguration(empty: string): string[] {
  return ['--no-pager', '--literal-pathspecs', ...[
    'protocol.allow=never', 'protocol.http.allow=always', 'protocol.https.allow=always', 'protocol.file.allow=never', 'protocol.ext.allow=never',
    'http.followRedirects=false', 'http.proxy=', 'http.sslVerify=true', 'credential.interactive=false',
    'core.askPass=', `core.hooksPath=${empty}`, `core.attributesFile=${join(empty, 'no-attributes')}`, 'core.fsmonitor=false', 'core.gitProxy=',
    'submodule.recurse=false', 'fetch.recurseSubmodules=false', 'transfer.bundleURI=false',
    'filter.lfs.required=false', 'filter.lfs.clean=', 'filter.lfs.smudge=', 'filter.lfs.process=',
    'fetch.fsckObjects=true', 'transfer.fsckObjects=true', 'fetch.unpackLimit=1', 'fetch.uriprotocols=',
  ].flatMap(config => ['-c', config])]
}

async function checkCloneSize(root: string): Promise<void> {
  let bytes = 0
  let count = 0
  async function visit(directory: string): Promise<void> {
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      if (++count > treeEntries) unsafe()
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) unsafe()
      if (entry.isDirectory()) await visit(path)
      else {
        let stat
        try { stat = await lstat(path) } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw error
        }
        bytes += stat.size
        if (!stat.isFile()) unsafe()
        if (bytes > cloneBytes) throw new RemoteCodeError('临时克隆超过 256 MiB 限制，请使用更小的仓库或本地模块目录上传')
      }
    }
  }
  await visit(root)
}

function decode(bytes: Buffer): string { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }

async function cleanupTemporary(path: string): Promise<void> {
  try { await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) }
  catch { throw new Error('\u8fdc\u7a0b\u4ee3\u7801\u4e34\u65f6\u6570\u636e\u6e05\u7406\u5931\u8d25') }
}

function parseTree(bytes: Buffer, directory?: string): { eligible: { path: string; oid: string; size: number }[]; excluded: number } {
  if (bytes.length > treeBytes) unsafe()
  const text = decode(bytes)
  if (text && !text.endsWith('\0')) unsafe()
  const entries = text ? text.slice(0, -1).split('\0') : []
  if (entries.length > treeEntries) unsafe()
  const eligible: { path: string; oid: string; size: number }[] = []
  let excluded = 0
  let total = 0
  for (const entry of entries) {
    const match = /^(\d{6}) (blob|commit|tree) ([a-f0-9]+) +(-|\d+)\t([^\0]+)$/.exec(entry)
    if (!match || !objectId.test(match[3])) unsafe()
    const [, mode, type, oid, sizeText, path] = match
    if (directory && !path.startsWith(`${directory}/`)) unsafe()
    if (!['100644', '100755'].includes(mode) || type !== 'blob' || !codeFileAllowed(path)) { excluded++; continue }
    const size = Number(sizeText)
    total += size
    if (sizeText === '-' || !Number.isSafeInteger(size)) unsafe()
    if (size > remoteCodeSnapshotLimits.fileBytes || total > remoteCodeSnapshotLimits.totalBytes || eligible.length >= remoteCodeSnapshotLimits.files) throw new RemoteCodeError(`远程代码快照超出限制（${remoteCodeSnapshotLimits.files} 个文件、单文件 512 KiB、累计 8 MiB），请填写更小的模块目录`)
    eligible.push({ path, oid, size })
  }
  return { eligible, excluded }
}

export async function loadRemoteCode(input: RemoteCodeInput, signal?: AbortSignal, options: { runner?: RemoteGitRunner } = {}): Promise<RemoteCodeResult> {
  const normalized = validateRemoteCodeInput(input)
  const controller = new AbortController()
  const deadline = AbortSignal.timeout(90000)
  const operationSignal = AbortSignal.any([controller.signal, deadline, ...(signal ? [signal] : [])])
  let temporary: string | undefined
  let failed = false
  try {
    operationSignal.throwIfAborted()
    temporary = await mkdtemp(join(tmpdir(), 'codeflow-remote-code-'))
    const empty = join(temporary, 'empty')
    const repositoryDirectory = join(temporary, 'repository')
    await mkdir(empty)
    const env = Object.freeze(isolatedEnvironment(temporary))
    const configuration = gitConfiguration(empty)
    const execute = async (args: string[], cwd: string, maxBuffer: number, timeoutMs = 10000): Promise<Buffer> => {
      operationSignal.throwIfAborted()
      const bytes = await (options.runner ?? runRemoteGit)([...configuration, ...args], { cwd, env, signal: operationSignal, maxBuffer, timeoutMs })
      operationSignal.throwIfAborted()
      if (!Buffer.isBuffer(bytes) || bytes.length > maxBuffer) unsafe()
      return bytes
    }
    let monitorError: unknown
    let pendingCheck: Promise<void> | undefined
    const check = () => {
      pendingCheck ??= checkCloneSize(repositoryDirectory).catch(error => { monitorError = error; controller.abort() }).finally(() => { pendingCheck = undefined })
    }
    const monitor = setInterval(check, 100)
    let cloneError: unknown
    try {
      await execute(['clone', '--depth=1', '--single-branch', '--no-tags', '--no-checkout', '--no-recurse-submodules', '--no-local', `--template=${empty}`, ...(normalized.branch ? ['--branch', normalized.branch] : []), '--', normalized.repository, repositoryDirectory], temporary, 65536, 60000)
    } catch (error) {
      cloneError = error
    } finally {
      clearInterval(monitor)
      await pendingCheck
    }
    if (monitorError) throw monitorError
    if (cloneError) throw cloneError
    await checkCloneSize(repositoryDirectory)
    const commit = decode(await execute(['rev-parse', '--verify', 'HEAD^{commit}'], repositoryDirectory, 256)).trim()
    if (!objectId.test(commit)) unsafe()
    const { eligible, excluded } = parseTree(await execute(['ls-tree', '-r', '-z', '-l', '--full-tree', commit, ...(normalized.directory ? ['--', `${normalized.directory}/`] : [])], repositoryDirectory, treeBytes), normalized.directory)
    if (!eligible.length) throw new RemoteCodeError('\u6307\u5b9a\u8303\u56f4\u5185\u6ca1\u6709\u53ef\u8bfb\u53d6\u7684\u4ee3\u7801\u6587\u4ef6')
    const files: RemoteCodeResult['files'] = []
    const excludedFiles: string[] = []
    for (const blob of eligible) {
      const bytes = await execute(['cat-file', 'blob', blob.oid], repositoryDirectory, remoteCodeSnapshotLimits.fileBytes)
      if (bytes.length !== blob.size) unsafe()
      const file = { path: blob.path, content: decode(bytes) }
      try { createCodeSnapshot([file], remoteCodeSnapshotLimits) }
      catch { excludedFiles.push(blob.path); continue }
      files.push(file)
    }
    if (!files.length) throw new RemoteCodeError('指定范围内没有通过内容安全校验的代码文件，请选择其他模块目录')
    createCodeSnapshot(files, remoteCodeSnapshotLimits)
    return { ...normalized, files, commit, excluded: excluded + excludedFiles.length, ...(excludedFiles.length ? { excludedFiles } : {}) }
  } catch (error) {
    failed = true
    if (signal?.aborted) throw new Error('\u8fdc\u7a0b\u4ee3\u7801\u83b7\u53d6\u5df2\u53d6\u6d88')
    if (error instanceof RemoteCodeError) throw error
    throw new Error('\u8fdc\u7a0b\u4ee3\u7801\u83b7\u53d6\u5931\u8d25\u6216\u8d85\u65f6\uff0c\u8bf7\u68c0\u67e5\u4ed3\u5e93\u3001\u5206\u652f\u548c\u6587\u4ef6\u5b89\u5168\u6027')
  } finally {
    controller.abort()
    if (temporary) {
      try { await cleanupTemporary(temporary) }
      catch {
        console.error('[requirements:remote_cleanup_failed]', JSON.stringify({ code: 'TEMP_CLEANUP' }))
        if (!failed) throw new RemoteCodeError('远程代码临时数据清理失败，请检查服务端文件占用')
      }
    }
  }
}