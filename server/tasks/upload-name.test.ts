import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { TaskStore } from './store.js'
import { uploadName } from './upload-name.js'

test('restores UTF-8 multipart filenames decoded as Latin-1', () => {
  const filename = 'TMP_V1.0_登录界面体验优化_PRD.md'
  assert.equal(uploadName(Buffer.from(filename).toString('latin1')), filename)
  assert.equal(uploadName('login-default.png'), 'login-default.png')
  assert.equal(uploadName('café.md'), 'café.md')
  assert.equal(uploadName(filename), filename)
})

test('restores stored upload names without changing a completed task status', () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-flow-upload-'))
  const file = join(directory, 'tasks.json')
  try {
    const name = '登录界面体验优化_PRD.md'
    const task = {
      id: 'existing', status: 'REVIEW', prdName: Buffer.from(name).toString('latin1'),
      repository: 'repo', createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z',
      designNames: ['login.png', Buffer.from('登录设计.png').toString('latin1')],
      entries: [], instruction: '保持原任务',
    }
    writeFileSync(file, JSON.stringify([task]))
    const restored = new TaskStore(file).get('existing')
    assert.equal(restored?.prdName, name)
    assert.deepEqual(restored?.designNames, ['login.png', '登录设计.png'])
    assert.equal(restored?.status, 'REVIEW')
    assert.equal(restored?.instruction, task.instruction)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})