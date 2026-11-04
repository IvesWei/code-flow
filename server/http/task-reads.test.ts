import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import type { CodingTask } from '../../shared/task.js'
import { registerTaskReads } from './task-reads.js'

test('paged task reads authorize detail/history without loading full worker state', async () => {
  const task: CodingTask = { id: 'cold', ownerId: 7, repository: 'repo', instruction: 'goal', prdName: 'prd', designNames: [], status: 'REVIEW', createdAt: '', updatedAt: '', entries: [{ at: '', kind: 'info', text: 'secret history' }] }
  const calls: unknown[] = []
  Object.assign(task, {
    checks: [{ name: 'fixture check', passed: true, output: 'Selected task check body' }],
    selfTestArtifacts: [{ output: 'Private artifact history body' }],
    acceptanceHistory: [{ output: 'Private acceptance history body' }],
    modelHistory: [{ output: 'Private model history body' }],
    automationUrl: 'http://example.test',
    selfTests: [{ id: 'TC-01', title: 'case', source: 'prd', steps: 'open', expected: 'ready', status: 'passed' }],
    automationRuns: [{ caseId: 'TC-01', status: 'passed', script: 'private script', screenshot: 'TC-01-image.png', output: 'run output' }],
  })
  let readCount = 0
  let loadCount = 0
  const app = express()
  registerTaskReads(app, {
    hasBusyTasks: async () => true,
    readTask: async (id) => {
      readCount++
      if (id !== 'cold') return undefined
      const { selfTestArtifacts: _artifacts, acceptanceHistory: _acceptance, modelHistory: _models, ...readonlyTask } = task
      return readonlyTask
    },
    loadTask: async (id) => { loadCount++; return id === 'cold' ? task : undefined },
    queryTasks: async (...args) => { calls.push(['list', ...args]); return { items: [task], nextCursor: 'next' } },
    history: async (...args) => { calls.push(['history', ...args]); return { items: [{ at: '', kind: 'info', text: '\u001b[31mrecord\u001b[0m' }], nextCursor: 'older' } },
  }, (request) => request.get('owner') === '7' ? 7 : request.get('owner') === '8' ? 8 : undefined)
  for (const path of ['automation/TC-01', 'automation/TC-01/screenshot']) {
    app.get(`/api/tasks/:id/${path}`, (_request, response) => {
      assert.equal(response.locals.task.automationRuns[0].script, 'private script')
      assert.equal(response.locals.task.selfTests[0].id, 'TC-01')
      response.json({ screenshot: response.locals.task.automationRuns[0].screenshot })
    })
  }
  for (const method of ['post', 'put', 'patch', 'delete'] as const) {
    app[method]('/api/tasks/:id/action', (_request, response) => {
      assert.equal(response.locals.task, task)
      assert.ok(response.locals.task.selfTestArtifacts)
      response.json({ id: response.locals.task.id })
    })
  }
  app.use((error: Error, _request: express.Request, response: express.Response, _next: express.NextFunction) => response.status(400).json({ error: error.message }))
  const server = app.listen(0, '127.0.0.1')
  try {
    await new Promise<void>((resolve) => server.on('listening', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}/api/tasks`
    const headers = { owner: '7' }
    assert.deepEqual(await (await fetch(base)).json(), { items: [], busy: false })
    const list = await (await fetch(`${base}?cursor=page&limit=2`, { headers })).json()
    assert.equal(list.nextCursor, 'next')
    assert.equal(list.busy, true)
    assert.equal('entries' in list.items[0], false)
    assert.ok(calls.some((call) => JSON.stringify(call) === JSON.stringify(['list', 7, 'page', 2])))
    calls.length = 0
    const detailResponse = await fetch(`${base}/cold`, { headers })
    assert.equal(detailResponse.headers.get('cache-control'), 'no-store')
    const detail = await detailResponse.json()
    assert.equal(detail.instruction, 'goal')
    assert.equal(detail.checks[0].output, 'Selected task check body')
    assert.equal(detail.automationUrl, 'http://example.test')
    assert.equal(detail.automationRuns[0].screenshot, 'TC-01-image.png')
    assert.equal(detail.automationRuns[0].output, 'run output')
    assert.equal(Object.hasOwn(detail.automationRuns[0], 'script'), false)
    assert.deepEqual(detail.entries, [])
    for (const field of ['selfTestArtifacts', 'acceptanceHistory', 'modelHistory']) assert.equal(Object.hasOwn(detail, field), false)
    assert.doesNotMatch(JSON.stringify(detail), /Private/)
    assert.equal((await fetch(`${base}/cold`, { headers: { owner: '8' } })).status, 404)
    for (const kind of ['events', 'artifacts', 'runs', 'snapshots']) {
      assert.equal((await fetch(`${base}/cold/${kind}`)).status, 404)
      const historyCalls = calls.filter((call) => (call as unknown[])[0] === 'history').length
      assert.equal((await fetch(`${base}/cold/${kind}?cursor=before&limit=3`, { headers: { owner: '8' } })).status, 404)
      assert.equal(calls.filter((call) => (call as unknown[])[0] === 'history').length, historyCalls)
      const page = await (await fetch(`${base}/cold/${kind}?cursor=before&limit=3`, { headers })).json()
      assert.equal(page.nextCursor, 'older')
      if (kind === 'events') assert.equal(page.items[0].text, 'record')
      assert.ok(calls.some((call) => JSON.stringify(call) === JSON.stringify(['history', 'cold', kind, 'before', 3])))
    }
    assert.equal(calls.some((call) => (call as unknown[])[0] === 'list'), false)
    assert.equal((await fetch(`${base}/missing/events`, { headers })).status, 404)
    for (const path of ['automation/TC-01', 'automation/TC-01/screenshot']) {
      assert.equal((await fetch(`${base}/cold/${path}`, { headers: { owner: '8' } })).status, 404)
      assert.deepEqual(await (await fetch(`${base}/cold/${path}`, { headers })).json(), { screenshot: 'TC-01-image.png' })
    }
    assert.equal((await fetch(`${base}/cold`, { method: 'HEAD', headers })).status, 200)
    for (const query of ['limit=0', 'limit=1001', 'limit=abc', 'cursor=a&cursor=b']) {
      assert.equal((await fetch(`${base}?${query}`, { headers })).status, 400)
      assert.equal((await fetch(`${base}/cold/events?${query}`, { headers })).status, 400)
    }
    assert.ok(readCount > 0)
    assert.equal(loadCount, 0)
    const readsBeforeMutations = readCount
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal((await fetch(`${base}/cold/action`, { method })).status, 404)
      assert.equal((await fetch(`${base}/cold/action`, { method, headers: { owner: '8' } })).status, 404)
      assert.equal((await fetch(`${base}/cold/action`, { method, headers })).status, 200)
    }
    assert.equal(loadCount, 12)
    assert.equal(readCount, readsBeforeMutations)
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())) }
})

test('legacy readers without readTask still preload GET requests through loadTask', async () => {
  let loadCount = 0
  const app = express()
  registerTaskReads(app, {
    hasBusyTasks: async () => false,
    loadTask: async () => { loadCount++; return undefined },
    queryTasks: async () => ({ items: [] }),
    history: async () => ({ items: [] }),
  }, () => 7)
  const server = app.listen(0, '127.0.0.1')
  try {
    await new Promise<void>((resolve) => server.on('listening', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/tasks/missing`)).status, 404)
    assert.equal(loadCount, 1)
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())) }
})