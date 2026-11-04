import assert from 'node:assert/strict'
import { test } from 'node:test'
import { databaseConfig } from './database-config.js'

const config = { TASK_STORAGE: 'mysql', DB_HOST: 'db.example.test', DB_USER: 'codeflow', DB_PASSWORD: 'test-password', DB_NAME: 'codeflow_test' }

test('database storage is opt-in and requires explicit credentials', () => {
  assert.equal(databaseConfig({}), undefined)
  assert.equal(databaseConfig({ TASK_STORAGE: 'json' }), undefined)
  assert.throws(() => databaseConfig({ TASK_STORAGE: 'other' }), /TASK_STORAGE/)
  assert.throws(() => databaseConfig({ ...config, DB_PASSWORD: '' }), /DB_PASSWORD/)
  assert.equal(databaseConfig(config)?.port, 3306)
  assert.equal(databaseConfig(config)?.connectionLimit, 5)
  assert.equal(databaseConfig(config)?.password, config.DB_PASSWORD)
})

test('database configuration validates port, pool, timeout and TLS settings', () => {
  for (const settings of [{ DB_PORT: '0' }, { DB_PORT: '3306oops' }, { DB_POOL_SIZE: '1' }, { DB_CONNECT_TIMEOUT_MS: 'NaN' }, { DB_TLS: 'yes' }, { DB_TLS_CA_FILE: 'ca.pem' }]) {
    assert.throws(() => databaseConfig({ ...config, ...settings }))
  }
  assert.equal(databaseConfig({ ...config, DB_TLS: 'true', DB_TLS_CA_FILE: 'ca.pem' })?.tls, true)
})