import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CodingTask } from '../../shared/task.js'
import { allowedWorkbenchOrigin, ownsTask } from './access.js'

test('workbench origins allow local Vite fallback ports but reject external and malformed origins', () => {
  for (const origin of [undefined, 'http://127.0.0.1:5174', 'http://127.0.0.1:5176', 'http://localhost:5174', 'http://[::1]:5199']) {
    assert.equal(allowedWorkbenchOrigin(origin, undefined), true)
  }
  for (const origin of ['null', 'https://evil.example', 'http://127.0.0.1.evil.test:5176', 'http://127.0.0.1:3001', 'http://127.0.0.1:5200', 'http://user@localhost:5176', 'http://localhost:5176/path', 'https://localhost:5176']) {
    assert.equal(allowedWorkbenchOrigin(origin, undefined), false, origin)
  }
  assert.equal(allowedWorkbenchOrigin('http://localhost:6000', 'http://localhost:6000, http://127.0.0.1:5176'), true)
  assert.equal(allowedWorkbenchOrigin('http://localhost:5174', 'http://localhost:6000'), false)
  assert.equal(allowedWorkbenchOrigin('http://evil.example:6000', 'http://evil.example:6000'), false)
})

test('tasks are visible only to their signed-in owner', () => {
  const task = { ownerId: 123 } as CodingTask
  assert.equal(ownsTask(task, 123), true)
  assert.equal(ownsTask(task, 456), false)
  assert.equal(ownsTask(task, undefined), false)
  assert.equal(ownsTask({} as CodingTask, 123), false)
})