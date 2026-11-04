import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { oauthCredentials } from './oauth-config.js'

test('local OAuth file is used only when no environment credentials are set', () => {
  const originalId = process.env.GITHUB_CLIENT_ID
  const originalSecret = process.env.GITHUB_CLIENT_SECRET
  const originalNodeEnv = process.env.NODE_ENV
  const folder = mkdtempSync(join(tmpdir(), 'codeflow-oauth-'))
  const file = join(folder, 'oauth.local.json')
  try {
    delete process.env.GITHUB_CLIENT_ID
    delete process.env.GITHUB_CLIENT_SECRET
    delete process.env.NODE_ENV
    assert.equal(oauthCredentials(file), undefined)
    writeFileSync(file, JSON.stringify({ clientId: 'local-id', clientSecret: 'local-secret' }))
    assert.deepEqual(oauthCredentials(file), { clientId: 'local-id', clientSecret: 'local-secret' })
    process.env.NODE_ENV = 'production'
    assert.equal(oauthCredentials(file), undefined)
    delete process.env.NODE_ENV
    process.env.GITHUB_CLIENT_ID = 'production-id'
    process.env.GITHUB_CLIENT_SECRET = 'production-secret'
    assert.deepEqual(oauthCredentials(file), { clientId: 'production-id', clientSecret: 'production-secret' })
    delete process.env.GITHUB_CLIENT_SECRET
    assert.equal(oauthCredentials(file), undefined)
  } finally {
    if (originalId === undefined) delete process.env.GITHUB_CLIENT_ID
    else process.env.GITHUB_CLIENT_ID = originalId
    if (originalSecret === undefined) delete process.env.GITHUB_CLIENT_SECRET
    else process.env.GITHUB_CLIENT_SECRET = originalSecret
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = originalNodeEnv
    rmSync(folder, { recursive: true, force: true })
  }
})