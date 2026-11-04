import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseTestLoginConfig } from './test-login-config.js'

test('test login configuration is restricted to TMP and errors never contain credentials', () => {
  const config = { origin: 'https://tmp.test.sunmi.com', username: 'fixture-user', password: 'fixture-secret' }
  assert.deepEqual(parseTestLoginConfig(config), config)
  for (const value of [null, {}, { ...config, origin: 'https://outside.invalid' }, { ...config, password: '' }, { ...config, extra: 'fixture-secret' }]) {
    assert.throws(() => parseTestLoginConfig(value), error => error instanceof Error && !error.message.includes('fixture-secret') && !error.message.includes('fixture-user'))
  }
})