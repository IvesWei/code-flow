import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CodingTask } from '../../../shared/task.js'
import { FileChanges } from '../../../src/features/coding/FileChanges.js'

test('file list retains published files when old task changes were cleared by self-test', () => {
  const task = { id: 'task', changes: ['test.ts', 'code.ts'], publication: { files: ['code.ts', 'deleted.ts'], snapshot: 'snapshot', baseCommit: 'a'.repeat(40), commit: 'b'.repeat(40) } } as CodingTask
  const html = renderToStaticMarkup(createElement(FileChanges, { task }))
  assert.match(html, /文件变更 · 3/)
  assert.match(html, /deleted.ts/)
  assert.match(html, /test.ts/)
  task.changes = []
  const restored = renderToStaticMarkup(createElement(FileChanges, { task }))
  assert.match(restored, /文件变更 · 2/)
  assert.match(restored, /code.ts/)
  assert.doesNotMatch(restored, /没有文件变更/)
})