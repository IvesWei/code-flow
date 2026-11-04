import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { CodingTask } from '../../shared/task.js'
import { changedFiles, fileDiff, taskChangeFiles } from './changes.js'

test('published previews retain modified, new and deleted diffs on a clean committed tree', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'codeflow-published-diff-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace }).toString().trim()
  try {
    git('init', '-q')
    git('config', 'user.email', 'test@example.test')
    git('config', 'user.name', 'Test')
    writeFileSync(join(workspace, 'tracked.txt'), 'before\n')
    writeFileSync(join(workspace, 'deleted.txt'), 'removed\n')
    git('add', '.')
    git('commit', '-qm', 'base')
    const baseCommit = git('rev-parse', 'HEAD')
    writeFileSync(join(workspace, 'tracked.txt'), 'after\n')
    writeFileSync(join(workspace, 'new.txt'), 'added\n')
    unlinkSync(join(workspace, 'deleted.txt'))
    const files = await changedFiles(workspace)
    const task = { workspace, changes: files } as CodingTask
    assert.match(await fileDiff(task, 'tracked.txt'), /-before\n\+after/)
    git('add', '.')
    git('commit', '-qm', 'publication')
    task.publication = { files, snapshot: 'test', baseCommit, commit: git('rev-parse', 'HEAD') }
    task.changes = await changedFiles(workspace)
    assert.deepEqual(task.changes, [])
    assert.deepEqual(taskChangeFiles(task).sort(), files.sort())
    assert.match(await fileDiff(task, 'tracked.txt'), /已提交变更[\s\S]*-before\n\+after/)
    assert.match(await fileDiff(task, 'new.txt'), /new file mode[\s\S]*\+added/)
    assert.match(await fileDiff(task, 'deleted.txt'), /deleted file mode[\s\S]*-removed/)
    task.publication.pushedAt = new Date().toISOString()
    assert.match(await fileDiff(task, 'tracked.txt'), /-before\n\+after/)
    writeFileSync(join(workspace, 'tracked.txt'), 'later\n')
    writeFileSync(join(workspace, 'test.txt'), 'test\n')
    task.changes = taskChangeFiles(task, await changedFiles(workspace))
    assert.ok(task.changes.includes('test.txt'))
    assert.equal(task.changes.filter((file) => file === 'tracked.txt').length, 1)
    const preview = await fileDiff(task, 'tracked.txt')
    assert.match(preview, /-before\n\+after/)
    assert.match(preview, /提交后的本地变更（未推送）[\s\S]*-after\n\+later/)
    await assert.rejects(fileDiff(task, '.git/config'))
    await assert.rejects(fileDiff({ ...task, changes: ['../outside'] }, '../outside'))
    task.publication.commit = '--stat'
    await assert.rejects(fileDiff(task, 'tracked.txt'), /基线.*不合法/)
  } finally { rmSync(workspace, { recursive: true, force: true }) }
})