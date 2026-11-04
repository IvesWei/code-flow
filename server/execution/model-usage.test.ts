import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CopilotSession, SessionEvent } from '@github/copilot-sdk'
import { attachModelUsage, type ModelUsageContext, type ModelUsageObservation } from './model-usage.js'

type UsageEvent = Extract<SessionEvent, { type: 'assistant.usage' | 'session.shutdown' }>

function source() {
  const handlers = new Set<(event: SessionEvent) => void>()
  const calls: string[] = []
  const session = {
    sessionId: 'session-1',
    on(handler: (event: SessionEvent) => void) { handlers.add(handler); return () => { handlers.delete(handler) } },
    async send() { calls.push('send') },
    async sendAndWait() { calls.push('sendAndWait') },
    async setModel() { calls.push('setModel') },
  } as unknown as Pick<CopilotSession, 'sessionId' | 'on'>
  return { session, handlers, calls, emit(event: SessionEvent) { for (const handler of handlers) handler(event) } }
}

const context: ModelUsageContext = { taskId: 'task-1', turnId: 'turn-1', phase: 'review', artifactId: 'artifact-1', model: 'fallback' }

function usage(id = 'usage-1', data: Partial<Extract<UsageEvent, { type: 'assistant.usage' }>['data']> = {}): Extract<UsageEvent, { type: 'assistant.usage' }> {
  return { type: 'assistant.usage', id, timestamp: '2026-10-15T00:00:00.000Z', parentId: null, ephemeral: true, data: { model: 'actual-model', ...data } }
}

function shutdown(): UsageEvent {
  return {
    type: 'session.shutdown', id: 'shutdown-1', timestamp: '2026-10-15T00:01:00.000Z', parentId: 'usage-1',
    data: {
      shutdownType: 'routine', sessionStartTime: 0, totalApiDurationMs: 12, totalNanoAiu: 25,
      codeChanges: { filesModified: [], linesAdded: 0, linesRemoved: 0 },
      modelMetrics: {
        'actual-model': { requests: { cost: 0.5, count: 1 }, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 0 }, totalNanoAiu: 25 },
        'other-model': { requests: {}, usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      },
    },
  }
}

test('normalizes available SDK usage, snapshots raw attribution and never sends or changes the session', async () => {
  const fixture = source()
  const observations: ModelUsageObservation[] = []
  const attribution = { ...context }
  const observer = attachModelUsage(fixture.session, (value) => { observations.push(value) }, () => attribution)
  const event = usage('usage-1', { inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 0, reasoningTokens: 4, cost: 0.5, copilotUsage: { totalNanoAiu: 25 }, providerCallId: 'provider-1' })
  const original = structuredClone(event)
  fixture.emit(event)
  attribution.turnId = 'turn-2'
  event.data.model = 'mutated'
  await observer.flush()
  assert.equal(observations.length, 1)
  const observation = observations[0]
  assert.equal(observation.model, 'actual-model')
  assert.equal(observation.turnId, 'turn-1')
  assert.equal(observation.artifactId, 'artifact-1')
  assert.equal(observation.taskId, 'task-1')
  assert.equal(observation.sessionId, 'session-1')
  assert.equal(observation.sourceEventId, 'usage-1')
  assert.equal(observation.bodyVersion, 1)
  assert.ok(Number.isFinite(Date.parse(observation.observedAt)))
  assert.deepEqual(observation.body.raw, original)
  assert.deepEqual(observation.body.metrics, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 0, reasoningTokens: 4, cost: 0.5, totalNanoAiu: 25 })
  assert.deepEqual(fixture.calls, [])
  observer.dispose()
})

test('missing metrics stay absent while explicitly reported zero remains zero', async () => {
  const fixture = source()
  const observations: ModelUsageObservation[] = []
  const observer = attachModelUsage(fixture.session, (value) => { observations.push(value) }, context)
  fixture.emit(usage('empty'))
  fixture.emit(usage('zero', { inputTokens: 0, cost: 0 }))
  await observer.flush()
  assert.deepEqual(observations[0].body.metrics, {})
  assert.deepEqual(observations[1].body.metrics, { inputTokens: 0, cost: 0 })
  observer.dispose()
})

test('deduplicates source event IDs, not API IDs, and never adds cumulative shutdown to request usage', async () => {
  const fixture = source()
  const observations: ModelUsageObservation[] = []
  const observer = attachModelUsage(fixture.session, (value) => { observations.push(value) }, context)
  const event = usage('usage-1', { inputTokens: 100, outputTokens: 20, apiCallId: 'api-1' })
  fixture.emit(event)
  fixture.emit(structuredClone(event))
  fixture.emit(shutdown())
  fixture.emit(shutdown())
  await observer.flush()
  assert.equal(observations.length, 2)
  assert.equal(observations[0].body.counting, 'incremental')
  assert.equal(observations[0].body.aggregation, 'authoritative')
  assert.equal(observations[1].body.counting, 'cumulative')
  assert.equal(observations[1].body.aggregation, 'reference-only')
  assert.deepEqual(observations[1].body.metrics, { totalNanoAiu: 25 })
  assert.deepEqual(observations[1].body.modelMetrics?.['actual-model'], { inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 0, cost: 0.5, requestCount: 1, totalNanoAiu: 25 })
  assert.equal(Object.hasOwn(observations[1].body.modelMetrics!['other-model'], 'cost'), false)
  assert.equal(observations.filter((value) => value.body.aggregation === 'authoritative').reduce((total, value) => total + value.body.metrics.inputTokens!, 0), 100)
  fixture.emit(usage('usage-2', { apiCallId: 'api-1', outputTokens: 3 }))
  await observer.flush()
  assert.equal(observations.length, 3)
  assert.equal(observations[2].sourceEventId, 'usage-2')
  observer.dispose()
})

test('context window occupancy and unrelated events are not billable usage', async () => {
  const fixture = source()
  const observations: ModelUsageObservation[] = []
  const observer = attachModelUsage(fixture.session, (value) => { observations.push(value) }, context)
  fixture.emit({ type: 'session.usage_info', id: 'context', timestamp: '', parentId: null, ephemeral: true, data: { currentTokens: 400, tokenLimit: 1000, messagesLength: 2 } })
  fixture.emit({ type: 'session.idle', id: 'idle', timestamp: '', parentId: null, ephemeral: true, data: {} })
  await observer.flush()
  assert.deepEqual(observations, [])
  observer.dispose()
})

test('flush waits for ordered callbacks and observations arriving during a flush', async () => {
  const fixture = source()
  const order: string[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const observer = attachModelUsage(fixture.session, async (value) => {
    order.push(value.sourceEventId)
    if (value.sourceEventId === 'first') await gate
  }, context)
  fixture.emit(usage('first'))
  let flushed = false
  const flushing = observer.flush().then(() => { flushed = true })
  await Promise.resolve()
  fixture.emit(usage('second'))
  assert.equal(flushed, false)
  assert.deepEqual(order, ['first'])
  release()
  await flushing
  assert.deepEqual(order, ['first', 'second'])
  observer.dispose()
})

test('sync throws and async rejections are handled immediately and surfaced by flush without stopping later callbacks', async () => {
  const fixture = source()
  const syncError = new Error('sync write failed')
  const asyncError = new Error('async write failed')
  const completed: string[] = []
  const observer = attachModelUsage(fixture.session, (value) => {
    if (value.sourceEventId === 'sync') throw syncError
    if (value.sourceEventId === 'async') return Promise.reject(asyncError)
    completed.push(value.sourceEventId)
  }, context)
  fixture.emit(usage('sync'))
  fixture.emit(usage('async'))
  fixture.emit(usage('ok'))
  await new Promise<void>((resolve) => setImmediate(resolve))
  await assert.rejects(observer.flush(), (error: AggregateError) => {
    assert.deepEqual(error.errors, [syncError, asyncError])
    return true
  })
  assert.deepEqual(completed, ['ok'])
  await observer.flush()
  observer.dispose()
})

test('dispose is idempotent, removes listeners, and still permits flushing pending writes', async () => {
  const fixture = source()
  const observations: ModelUsageObservation[] = []
  const observer = attachModelUsage(fixture.session, (value) => { observations.push(value) }, context)
  fixture.emit(usage())
  observer.dispose()
  observer.dispose()
  fixture.emit(usage('ignored'))
  await observer.flush()
  assert.equal(fixture.handlers.size, 0)
  assert.equal(observations.length, 1)
})

test('context failures do not escape the SDK handler and are reported at the worker barrier', async () => {
  const fixture = source()
  const failure = new Error('context failed')
  const observer = attachModelUsage(fixture.session, () => { assert.fail('must not write') }, () => { throw failure })
  assert.doesNotThrow(() => fixture.emit(usage()))
  await assert.rejects(observer.flush(), (error: AggregateError) => {
    assert.deepEqual(error.errors, [failure])
    return true
  })
  observer.dispose()
})