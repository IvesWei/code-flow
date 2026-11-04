import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { canWriteTestFile } from './self-test-permissions.js'

test('generation only writes test files inside the workspace without following links', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phase-permissions-'))
  try {
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    assert.equal(await canWriteTestFile(workspace, 'src/save.test.ts'), true)
    assert.equal(await canWriteTestFile(workspace, 'src/index.ts'), false)
    writeFileSync(join(workspace, 'user.test.ts'), 'existing user test')
    assert.equal(await canWriteTestFile(workspace, 'user.test.ts'), false)
    assert.equal(await canWriteTestFile(workspace, 'user.test.ts', ['user.test.ts']), true)
    assert.equal(await canWriteTestFile(workspace, '../outside.test.ts'), false)
    assert.equal(await canWriteTestFile(workspace, 'node_modules/save.test.ts'), false)
    symlinkSync(root, join(workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal(await canWriteTestFile(workspace, 'linked/save.test.ts'), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})