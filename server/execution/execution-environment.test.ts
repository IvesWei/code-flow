import assert from 'node:assert/strict'
import { test } from 'node:test'
import { executionEnvironment } from './execution-environment.js'

test('task subprocesses do not inherit backend database credentials or configuration file paths', () => {
  const input = { PATH: 'tools', HOME: 'home', DB_PASSWORD: 'private', DB_HOST: 'host', db_user: 'user', CODEFLOW_ENV_FILE: 'private.env', TASK_STORAGE: 'mysql', NODE_TEST_CONTEXT: 'child' }
  assert.deepEqual(executionEnvironment(input), { PATH: 'tools', HOME: 'home', NODE_TEST_CONTEXT: 'child' })
  assert.equal(input.DB_PASSWORD, 'private')
})