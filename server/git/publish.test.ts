import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { CodingTask } from '../../shared/task.js'
import { publicationSnapshot, publishBranch } from './publish.js'
import { TaskStore } from '../tasks/store.js'

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'code-flow-publish-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.test')
  writeFileSync(join(directory, 'code.txt'), 'before\n')
  git('add', '.')
  git('commit', '-qm', 'initial')
  git('switch', '-qc', 'copilot/task-12345678')
  git('remote', 'add', 'origin', 'https://github.com/owner/repo.git')
  const task: CodingTask = {
    id: '12345678-0000-4000-8000-000000000000', ownerId: 1,
    repository: 'https://github.com/owner/repo.git', createdBranch: 'copilot/task-12345678',
    instruction: 'Change code', prdName: 'prd.md', designNames: [], status: 'PUBLISH_PENDING',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), entries: [], workspace: directory,
  }
  return { directory, git, task }
}

test('publication binds confirmation to file bytes and base commit', async () => {
  const { directory, git, task } = fixture()
  try {
    writeFileSync(join(directory, 'code.txt'), 'after\n')
    const publication = await publicationSnapshot(task, directory)
    assert.deepEqual(publication.files, ['code.txt'])
    assert.equal(publication.baseCommit, git('rev-parse', 'HEAD'))
    task.publication = publication
    writeFileSync(join(directory, 'code.txt'), 'changed again\n')
    await assert.rejects(publishBranch(task, directory, publication.snapshot, () => {}), /待推送文件已改变/)
    assert.equal(git('rev-parse', 'HEAD'), publication.baseCommit)
    assert.equal(git('diff', '--cached', '--name-only'), '')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('publication rejects changed branch, origin push URL and sensitive files', async () => {
  const { directory, git, task } = fixture()
  try {
    writeFileSync(join(directory, 'code.txt'), 'after\n')
    git('config', 'remote.origin.pushurl', 'https://github.com/other/repo.git')
    await assert.rejects(publicationSnapshot(task, directory), /origin 或推送地址/)
    git('config', '--unset', 'remote.origin.pushurl')
    git('switch', '-qc', 'main')
    await assert.rejects(publicationSnapshot(task, directory), /任务分支已改变/)
    git('switch', 'copilot/task-12345678')
    writeFileSync(join(directory, '.env.production'), 'secret\n')
    await assert.rejects(publicationSnapshot(task, directory), /凭据文件/)
    rmSync(join(directory, '.env.production'))
    try {
      symlinkSync(join(directory, 'code.txt'), join(directory, 'link.txt'))
      await assert.rejects(publicationSnapshot(task, directory), /链接或非普通文件/)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('publication approval and local commit survive restart', async () => {
  const { directory, task } = fixture()
  const data = mkdtempSync(join(tmpdir(), 'code-flow-publish-data-'))
  try {
    writeFileSync(join(directory, 'code.txt'), 'after\n')
    const file = join(data, 'tasks.json')
    const store = new TaskStore(file)
    store.create(task)
    store.update(task.id, { publication: await publicationSnapshot(task, directory) })
    const restored = new TaskStore(file).get(task.id)
    assert.equal(restored?.status, 'PUBLISH_PENDING')
    assert.deepEqual(restored?.publication?.files, ['code.txt'])
    store.update(task.id, { publication: { ...restored!.publication!, commit: 'local-commit' } })
    assert.equal(new TaskStore(file).get(task.id)?.publication?.commit, 'local-commit')
  } finally { rmSync(directory, { recursive: true, force: true }); rmSync(data, { recursive: true, force: true }) }
})