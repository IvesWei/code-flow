import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { CodingTask } from '../../shared/task.js'
import { changedFiles } from './changes.js'
import { run, validateRepository } from './git.js'

const git = (workspace: string, ...args: string[]) => run('git', args, workspace, 30_000)

async function assertTarget(task: CodingTask, workspace: string): Promise<void> {
  if (!task.createdBranch || task.createdBranch !== `copilot/task-${task.id.slice(0, 8)}` || !/^copilot\/task-[0-9a-f]{8}$/.test(task.createdBranch) ||
    (await git(workspace, 'branch', '--show-current')).trim() !== task.createdBranch) throw new Error('任务分支已改变，拒绝推送')
  const origin = (await git(workspace, 'remote', 'get-url', 'origin')).trim()
  const pushUrls = (await git(workspace, 'remote', 'get-url', '--push', '--all', 'origin')).split(/\r?\n/)
  const expected = validateRepository(task.repository).replace(/\.git\/?$/, '').replace(/\/$/, '')
  if (pushUrls.length !== 1 || [origin, ...pushUrls].some((url) => validateRepository(url).replace(/\.git\/?$/, '').replace(/\/$/, '') !== expected)) throw new Error('origin 或推送地址与任务仓库不一致，拒绝推送')
}

export async function publicationSnapshot(task: CodingTask, workspace: string): Promise<{ files: string[]; snapshot: string; baseCommit: string; blobs: Record<string, string | null> }> {
  await assertTarget(task, workspace)
  if (await git(workspace, 'diff', '--cached', '--name-only')) throw new Error('工作区已有暂存变更，请先清理后重试')
  const files = await changedFiles(workspace)
  if (!files.length) throw new Error('没有待发布的代码变更')
  const baseCommit = await git(workspace, 'rev-parse', 'HEAD')
  const digest = createHash('sha256')
  const blobs: Record<string, string | null> = {}
  digest.update(baseCommit)
  digest.update(await git(workspace, 'status', '--porcelain=v1', '-z', '-uall'))
  for (const file of files) {
    if (!file || isAbsolute(file) || file.split(/[\\/]/).includes('..')) throw new Error('变更路径不合法')
    if (file.split(/[\\/]/).some((part) => /^\.env(?:\.|$)|\.pem$|\.key$|^oauth\.local\.json$/i.test(part))) throw new Error('变更包含可能的凭据文件，拒绝自动推送')
    const path = resolve(workspace, file)
    const inside = relative(workspace, path)
    if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error('变更路径不合法')
    digest.update(`${file}\0`)
    try {
      const info = await lstat(path)
      if (!info.isFile() || !(await realpath(path)).startsWith(`${await realpath(workspace)}${sep}`)) throw new Error('变更包含链接或非普通文件，拒绝推送')
      digest.update(await readFile(path))
      blobs[file] = await git(workspace, 'hash-object', '--', file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      digest.update('deleted')
      blobs[file] = null
    }
  }
  return { files, snapshot: digest.digest('hex'), baseCommit, blobs }
}

export async function publishBranch(task: CodingTask, workspace: string, confirmSnapshot: string,
  saveCommit: (commit: string) => void | Promise<void>): Promise<string> {
  await assertTarget(task, workspace)
  if (!task.publication || task.publication.snapshot !== confirmSnapshot) throw new Error('待推送文件清单已改变，请刷新后确认')
  let commit = task.publication.commit
  const baseCommit = task.publication.baseCommit
  if (!baseCommit) throw new Error('请先刷新待推送清单')
  const head = await git(workspace, 'rev-parse', 'HEAD')
  if (!commit && head !== baseCommit) {
    const parent = await git(workspace, 'rev-parse', 'HEAD^')
    const message = await git(workspace, 'log', '-1', '--format=%s')
    const committed = (await git(workspace, 'diff-tree', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD')).split('\0').filter(Boolean)
    if (parent !== baseCommit || message !== `chore: save coding task ${task.id.slice(0, 8)}` ||
        (await changedFiles(workspace)).length || !sameFiles(committed, task.publication.files)) throw new Error('基线提交已改变，拒绝推送')
    commit = head
    await saveCommit(commit)
  }
  if (commit) {
    if ((await git(workspace, 'rev-parse', 'HEAD')) !== commit || (await changedFiles(workspace)).length) throw new Error('提交后的工作目录已改变，拒绝继续推送')
  } else {
    const current = await publicationSnapshot(task, workspace)
    if (current.snapshot !== confirmSnapshot || current.baseCommit !== baseCommit || !sameFiles(current.files, task.publication.files)) throw new Error('待推送文件已改变，请刷新清单后确认')
    await git(workspace, 'add', '-A', '--', '.')
    if (!sameFiles(await publicationSnapshotAfterStage(workspace), current.files)) throw new Error('暂存文件与确认清单不同，拒绝提交')
    for (const [file, blob] of Object.entries(task.publication.blobs || {})) {
      if (blob && (await git(workspace, 'rev-parse', `:${file}`)) !== blob) throw new Error('暂存文件内容与确认时不同，拒绝提交')
      if (blob === null && await git(workspace, 'ls-files', '--cached', '-z', '--', `:(literal)${file}`)) throw new Error('已删除的文件重新出现，拒绝提交')
    }
    if (Object.keys(task.publication.blobs || {}).length !== current.files.length ||
        (await git(workspace, 'diff', '--name-only')).length) throw new Error('工作目录已改变，拒绝提交')
    await git(workspace, 'commit', '-m', `chore: save coding task ${task.id.slice(0, 8)}`)
    commit = await git(workspace, 'rev-parse', 'HEAD')
    await saveCommit(commit)
  }
  const remote = await git(workspace, 'ls-remote', '--heads', 'origin', `refs/heads/${task.createdBranch}`)
  const remoteCommit = remote ? remote.split(/\s+/)[0] : undefined
  if (remoteCommit !== commit) {
    if (task.publication.previousCommit) {
      if (remoteCommit !== task.publication.previousCommit) throw new Error('远端任务分支不是上次推送的提交，拒绝覆盖')
      await git(workspace, 'merge-base', '--is-ancestor', remoteCommit, commit)
    } else if (remoteCommit) throw new Error('远端任务分支已存在不同提交，拒绝覆盖')
    await run('git', ['push', 'origin', `HEAD:refs/heads/${task.createdBranch}`], workspace, 120_000)
  }
  return commit
}

async function publicationSnapshotAfterStage(workspace: string): Promise<string[]> {
  return (await git(workspace, 'diff', '--cached', '--name-only', '-z')).split('\0').filter(Boolean)
}

function sameFiles(first: string[], second: string[]): boolean {
  const expected = [...second].sort()
  return first.length === expected.length && [...first].sort().every((file, index) => file === expected[index])
}