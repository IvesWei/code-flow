import assert from 'node:assert/strict'
import { test } from 'node:test'
import { modelTimeouts } from './model-timeouts.js'

test('short model reviews get separate bounded response and inactivity windows without shortening coding', () => {
  assert.deepEqual(modelTimeouts(120_000, {}), { firstResponseMs: 600_000, inactivityMs: 300_000 })
  assert.deepEqual(modelTimeouts(1_200_000, {}), { firstResponseMs: 1_200_000, inactivityMs: 1_200_000 })
  assert.deepEqual(modelTimeouts(120_000, { MODEL_FIRST_RESPONSE_TIMEOUT_MS: '900000', MODEL_INACTIVITY_TIMEOUT_MS: '420000' }), { firstResponseMs: 900_000, inactivityMs: 420_000 })
})

test('invalid timeout configuration is rejected rather than disabling the deadline', () => {
  for (const value of ['', 'NaN', '-1', '9999', '3600001', '1e5', 'Infinity']) {
    assert.throws(() => modelTimeouts(120_000, { MODEL_FIRST_RESPONSE_TIMEOUT_MS: value }), /MODEL_FIRST_RESPONSE_TIMEOUT_MS/)
    assert.throws(() => modelTimeouts(120_000, { MODEL_INACTIVITY_TIMEOUT_MS: value }), /MODEL_INACTIVITY_TIMEOUT_MS/)
  }
})