import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import { storageResponse } from './storage-response.js'
import { TaskStore } from '../tasks/store.js'

test('HTTP success waits for persistence and failed writes return 503 without exposing connection details', async () => {
  let fail = false
  let persisted = false
  const store = await TaskStore.fromPersistence({ load: async () => [], save: async () => { if (fail) throw new Error('secret'); persisted = true } })
  const app = express()
  app.get('/api/auth/status', (_request, response) => response.json({ authenticated: false }))
  app.use(storageResponse(store))
  app.post('/task', (_request, response) => {
    persisted = false
    const now = new Date().toISOString()
    store.create({ id: fail ? 'failed' : 'success', repository: 'repo', instruction: '', prdName: 'prd.md', designNames: [], status: 'REVIEW', createdAt: now, updatedAt: now, entries: [] })
    response.json({ ok: true })
  })
  const server = app.listen(0, '127.0.0.1')
  try {
    await new Promise<void>((resolve) => server.on('listening', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const url = `http://127.0.0.1:${address.port}/task`
    const success = await fetch(url, { method: 'POST' })
    assert.equal(success.status, 200)
    assert.equal(persisted, true)
    fail = true
    const failure = await fetch(url, { method: 'POST' })
    assert.equal(failure.status, 503)
    assert.doesNotMatch(await failure.text(), /secret/)
    assert.equal((await fetch(url, { method: 'POST' })).status, 503)
    const authentication = await fetch(`http://127.0.0.1:${address.port}/api/auth/status`)
    assert.equal(authentication.status, 200)
    assert.deepEqual(await authentication.json(), { authenticated: false })
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
})