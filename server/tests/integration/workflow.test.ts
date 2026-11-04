import assert from 'node:assert/strict'
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import type { CodingTask } from '../../../shared/task.js'
import { changedFiles, fileDiff } from '../../git/changes.js'
import { run, validateRepository } from '../../git/git.js'
import { TaskStore, TaskStorageError } from '../../tasks/store.js'

test('only approved GitHub and internal Git repository URLs are accepted', () => {
  assert.equal(validateRepository('https://github.com/owner/repo.git'), 'https://github.com/owner/repo.git')
  assert.equal(validateRepository('http://code.sunmi.com/FE/tmp.git'), 'http://code.sunmi.com/FE/tmp.git')
  for (const input of ['http://github.com/a/b', 'https://evil.example/a/b', 'https://github.com.evil.test/a/b', 'https://user:secret@github.com/a/b', 'https://github.com/a/b?token=x', 'https://github.com/a/b/c', 'file:///tmp/repo']) {
    assert.throws(() => validateRepository(input))
  }
})

test('tasks survive reload and incomplete sessions are marked failed', () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-flow-'))
  try {
    const file = join(directory, 'tasks.json')
    const store = new TaskStore(file)
    const now = new Date().toISOString()
    const task: CodingTask = {
      id: 'one', repository: 'https://github.com/owner/repo', instruction: 'Implement a login screen',
      prdName: 'prd.md', designNames: [], status: 'NEEDS_INPUT',
      question: { text: 'Which method?', choices: ['Email', 'Phone'], allowFreeform: false },
      createdAt: now, updatedAt: now, entries: [],
    }
    store.create(task)
    store.entry(task.id, 'info', 'Question asked')
    const restored = new TaskStore(file).get(task.id)
    assert.equal(restored?.status, 'FAILED')
    assert.equal(restored?.question, undefined)
    assert.match(restored?.error || '', /重新启动/)
    assert.equal(restored?.entries[0].text, 'Question asked')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('activity keeps the phase where a failure occurred', () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-flow-'))
  try {
    const store = new TaskStore(join(directory, 'tasks.json'))
    const now = new Date().toISOString()
    store.create({ id: 'phase', repository: 'https://github.com/owner/repo', instruction: 'Fix tests', prdName: 'prd.md', designNames: [], status: 'QUEUED', createdAt: now, updatedAt: now, entries: [] })
    store.status('phase', 'CLONING', '正在拉取仓库')
    store.status('phase', 'CODING', 'Copilot 正在编码')
    store.status('phase', 'VERIFYING', '开始验收')
    store.entry('phase', 'error', 'npm run test failed')
    store.update('phase', { status: 'FAILED' })
    assert.deepEqual(store.get('phase')?.entries.map((entry) => entry.stage), ['CLONING', 'CODING', 'VERIFYING', 'VERIFYING'])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('file preview shows tracked changes and untracked content without exposing other paths', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-flow-diff-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory })
  try {
    git('init', '-q')
    git('config', 'user.email', 'test@example.test')
    git('config', 'user.name', 'Test')
    writeFileSync(join(directory, 'tracked.txt'), 'before\n')
    git('add', 'tracked.txt')
    git('commit', '-qm', 'initial')
    writeFileSync(join(directory, 'tracked.txt'), 'after\n')
    writeFileSync(join(directory, 'new.txt'), 'hello\nworld\n')
    writeFileSync(join(directory, '中文 file.txt'), 'unicode\n')
    writeFileSync(join(directory, 'private.txt'), 'secret\n')
    const task = { workspace: directory, changes: await changedFiles(directory) } as CodingTask
    assert.ok(task.changes?.includes('中文 file.txt'))
    assert.match(await fileDiff(task, 'tracked.txt'), /-before\n\+after/)
    assert.match(await fileDiff(task, 'new.txt'), /--- \/dev\/null\n\+\+\+ b\/new.txt\n@@ -0,0 \+1,2 @@\n\+hello\n\+world/)
    assert.match(await fileDiff(task, '中文 file.txt'), /\+unicode/)
    await assert.rejects(fileDiff(task, '.git/config'))
    await assert.rejects(fileDiff({ ...task, changes: ['../private.txt'] }, '../private.txt'))
    writeFileSync(join(directory, 'new.txt'), Buffer.alloc(256 * 1024 + 1, 65))
    await assert.rejects(fileDiff(task, 'new.txt'), /文件过大/)
    git('mv', 'tracked.txt', 'renamed.txt')
    const renamed = await changedFiles(directory)
    assert.ok(renamed.includes('renamed.txt'))
    assert.ok(!renamed.includes('tracked.txt'))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('review status and self-test evidence survive restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-flow-review-'))
  try {
    const file = join(directory, 'tasks.json')
    const store = new TaskStore(file)
    const now = new Date().toISOString()
    store.create({ id: 'review', repository: 'https://github.com/owner/repo', instruction: 'Login', prdName: 'prd.md', designNames: [], status: 'SELF_TEST', createdAt: now, updatedAt: now, entries: [] })
    store.update('review', { selfTests: [{ id: 'TC-01', title: 'Login', source: 'PRD', steps: 'Submit', expected: 'Success', status: 'failed', output: 'assertion failed' }] })
    store.status('review', 'REVIEW', '需人工验收')
    const restored = new TaskStore(file).get('review')
    assert.equal(restored?.status, 'REVIEW')
    assert.equal(restored?.selfTests?.[0].output, 'assertion failed')
    const reloaded = new TaskStore(file)
    reloaded.status('review', 'ACCEPTED', '用户接受当前风险')
    const accepted = new TaskStore(file).get('review')
    assert.equal(accepted?.status, 'ACCEPTED')
    assert.equal(accepted?.selfTests?.[0].status, 'failed')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('interrupted self-test retains draft and completed cases for targeted retry', () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-flow-self-test-'))
  try {
    const file = join(directory, 'tasks.json')
    const store = new TaskStore(file)
    const now = new Date().toISOString()
    store.create({ id: 'interrupted', repository: 'https://github.com/owner/repo', instruction: 'Login', prdName: 'prd.md', designNames: [], status: 'SELF_TEST', workspace: join(directory, 'workspaces', 'interrupted'), createdBranch: 'copilot/task-interrupted', createdAt: now, updatedAt: now, entries: [] })
    store.update('interrupted', { selfTestDraft: '[{"steps":', selfTests: [{ id: 'TC-01', title: 'Login', source: 'PRD', steps: 'Submit', expected: 'Success', status: 'passed', output: 'passed' }, { id: 'TC-02', title: 'Invalid login', source: 'PRD', steps: '', expected: 'Error', status: 'invalid', output: 'missing steps' }] })
    const restored = new TaskStore(file).get('interrupted')
    assert.equal(restored?.status, 'REVIEW')
    assert.equal(restored?.selfTestDraft, '[{"steps":')
    assert.deepEqual(restored?.selfTests?.map((item) => item.status), ['passed', 'invalid'])
    assert.match(restored?.selfTestError || '', /继续执行或修正/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('interrupted execution retains passed and pending cases for continuation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-flow-execution-'))
  try {
    const file = join(directory, 'tasks.json')
    const store = new TaskStore(file)
    const now = new Date().toISOString()
    store.create({ id: 'execution', repository: 'https://github.com/owner/repo', instruction: 'Login', prdName: 'prd.md', designNames: [], status: 'TEST_EXECUTION', workspace: join(directory, 'workspaces', 'execution'), createdBranch: 'copilot/task-execution', createdAt: now, updatedAt: now, entries: [] })
    store.update('execution', { selfTests: [{ id: 'TC-01', title: 'Login', source: 'PRD', steps: 'Submit', expected: 'Success', status: 'passed', output: 'exit code 0' }, { id: 'TC-02', title: 'Invalid login', source: 'PRD', steps: 'Submit', expected: 'Error', status: 'pending', testFile: 'invalid.test.cjs' }] })
    const restored = new TaskStore(file).get('execution')
    assert.equal(restored?.status, 'REVIEW')
    assert.deepEqual(restored?.selfTests?.map((item) => item.status), ['passed', 'pending'])
    assert.match(restored?.selfTestError || '', /继续执行/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('automation task details and screenshot reference survive restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-flow-automation-'))
  try {
    const file = join(directory, 'tasks.json')
    const store = new TaskStore(file)
    const now = new Date().toISOString()
    store.create({ id: 'browser', repository: 'https://github.com/owner/repo', instruction: 'Login', prdName: 'prd.md', designNames: [], status: 'REVIEW', createdAt: now, updatedAt: now, entries: [], automationUrl: 'http://127.0.0.1:4173' })
    store.update('browser', { automationRuns: [{ caseId: 'TC-01', status: 'failed', script: '{"path":"/"}', screenshot: 'TC-01-00000000-0000-4000-8000-000000000000.png', output: 'assertion failed', finishedAt: now }] })
    const restored = new TaskStore(file).get('browser')
    assert.equal(restored?.automationUrl, 'http://127.0.0.1:4173')
    assert.equal(restored?.automationRuns?.[0].script, '{"path":"/"}')
    assert.match(restored?.automationRuns?.[0].screenshot || '', /^TC-01-/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('child output preserves Chinese characters across stdout and stderr chunk boundaries', async () => {
  for (const stream of ['stdout', 'stderr'] as const) {
    const script = `const bytes = Buffer.from('中文检查通过'); process.${stream}.write(bytes.subarray(0, 1)); setTimeout(() => process.${stream}.end(bytes.subarray(1)), 30)`
    assert.equal(await run(process.execPath, ['-e', script], process.cwd(), 5000), '中文检查通过')
  }
})

test('task storage retries transient rename locks and surfaces permanent failures', () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-flow-store-'))
  try {
    const file = join(directory, 'tasks.json')
    let attempts = 0
    const rename = (source: string, target: string) => {
      attempts++
      if (attempts === 1) throw Object.assign(new Error('locked'), { code: 'EPERM' })
      renameSync(source, target)
    }
    const store = new TaskStore(file, rename)
    assert.equal(attempts, 2)
    assert.deepEqual(store.list(), [])
    assert.throws(() => new TaskStore(file, () => { throw Object.assign(new Error('locked'), { code: 'EPERM' }) }), TaskStorageError)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})