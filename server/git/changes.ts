import { spawn } from 'node:child_process'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { CodingTask } from '../../shared/task.js'
import { taskChangeFiles } from '../../shared/changes.js'
import { run } from './git.js'

const maxBytes = 256 * 1024

export { taskChangeFiles } from '../../shared/changes.js'

export async function fileDiff(task: CodingTask, file: string): Promise<string> {
  if (!task.workspace || !taskChangeFiles(task).includes(file) || !file || isAbsolute(file) || file.split(/[\\/]/).includes('..')) {
    throw new Error('文件不在当前任务的变更列表中')
  }
  const workspace = await realpath(task.workspace)
  const path = resolve(workspace, file)
  const inside = relative(workspace, path)
  if (!inside || inside.startsWith(`..${sep}`) || inside === '..' || isAbsolute(inside)) throw new Error('文件路径不合法')
  try {
    const info = await lstat(path)
    if (!info.isFile() || (await realpath(path)) !== path) throw new Error('不支持查看链接或非普通文件')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const publication = task.publication
  if (publication?.commit && publication.files.includes(file)) {
    if (!publication.baseCommit || ![publication.baseCommit, publication.commit].every((revision) => /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(revision))) throw new Error('发布提交基线缺失或不合法，无法查看已提交差异')
    const published = await gitDiff(workspace, file, [publication.baseCommit, publication.commit])
    const pending = await gitDiff(workspace, file, [publication.commit])
    const preview = [published ? `已提交变更\n${published}` : '', pending ? `提交后的本地变更（未推送）\n${pending}` : ''].filter(Boolean).join('\n')
    if (Buffer.byteLength(preview, 'utf8') > maxBytes) throw new Error('差异过大，无法在页面预览')
    return preview || '该发布文件没有可显示的文本差异'
  }
  const diff = await gitDiff(workspace, file)
  if (diff) return diff
  const tracked = await run('git', ['ls-files', '--cached', '--', `:(literal)${file}`], workspace, 15_000)
  if (tracked) return '该文件当前没有未提交的文本变更'
  const info = await lstat(path)
  if (!info.isFile() || (await realpath(path)) !== path) throw new Error('不支持查看链接或非普通文件')
  const data = await readFile(path)
  if (data.length > maxBytes) throw new Error('文件过大，无法在页面预览')
  if (data.includes(0)) return '二进制新文件，无法显示文本差异'
  const text = data.toString('utf8')
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return [`--- /dev/null`, `+++ b/${file}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join('\n')
}

function gitDiff(workspace: string, file: string, revisions = ['HEAD']): Promise<string> {
  return new Promise((done, reject) => {
    const child = spawn('git', ['-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-textconv', ...revisions, '--', `:(literal)${file}`], {
      cwd: workspace, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    const chunks: Buffer[] = []
    let size = 0
    const timer = setTimeout(() => child.kill(), 15_000)
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) child.kill()
      else chunks.push(chunk)
    })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (size > maxBytes) reject(new Error('差异过大，无法在页面预览'))
      else if (code !== 0) reject(new Error('无法获取文件差异'))
      else done(Buffer.concat(chunks).toString('utf8'))
    })
  })
}

export async function changedFiles(workspace: string): Promise<string[]> {
  return new Promise((done, reject) => {
    const child = spawn('git', ['status', '--porcelain=v1', '-z', '-uall'], { cwd: workspace, windowsHide: true })
    const chunks: Buffer[] = []
    let size = 0
    const timer = setTimeout(() => child.kill(), 15_000)
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) child.kill()
      else chunks.push(chunk)
    })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (size > maxBytes) return reject(new Error('变更文件列表过大'))
      if (code !== 0) return reject(new Error('无法获取变更文件列表'))
      const records = Buffer.concat(chunks).toString('utf8').split('\0')
      const files: string[] = []
      for (let index = 0; index < records.length - 1; index++) {
        const record = records[index]
        files.push(record.slice(3))
        if (/^[RC]/.test(record.slice(0, 2)) || /[RC]$/.test(record.slice(0, 2))) index++
      }
      done(files)
    })
  })
}