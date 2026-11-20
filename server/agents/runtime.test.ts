import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CopilotSession, SessionConfig } from '@github/copilot-sdk'
import { AgentBoundaryError, runAgent, type AgentEvent } from './runtime.js'
import { agentProfiles } from './profiles.js'

const options = (resource = 'fixture') => ({ resource, revision: 1, signal: new AbortController().signal, onEvent: async (_event: AgentEvent) => {} })
const source = () => ({ send: (async () => 'receipt') as CopilotSession['send'], on: (() => () => {}) as CopilotSession['on'] })
const config = (): SessionConfig => ({
  availableTools: ['view'], systemMessage: { mode: 'replace', content: 'Original contract' },
  onPermissionRequest: async () => ({ kind: 'approve-once' }),
})

test('agent handoffs clone inputs and results and record only metadata', async () => {
  const input = { revision: { title: 'original' } }
  const events: AgentEvent[] = []
  const output = { fields: ['field'] }
  const result = await runAgent('test-implementation', input, { ...options(), onEvent: async event => { events.push(event) } }, async (snapshot, agent) => {
    input.revision.title = 'changed'
    assert.equal(snapshot.revision.title, 'original')
    assert.throws(() => { snapshot.revision.title = 'agent mutation' }, TypeError)
    assert.match(agent.handoff.inputFingerprint, /^[a-f0-9]{64}$/)
    return output
  })
  result.fields.push('other')
  assert.deepEqual(output.fields, ['field'])
  assert.deepEqual(events.map(event => event.kind), ['started', 'completed'])
  assert.ok(!JSON.stringify(events).includes('original'))
})

test('one resource cannot be written by concurrent agents, but unrelated resources can run', async () => {
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const first = runAgent('requirements', {}, options('shared'), async () => { await waiting })
  await assert.rejects(runAgent('design', {}, options('shared'), async () => {}), { code: 'AGENT_BUSY' })
  await runAgent('requirements', {}, options('independent'), async () => {})
  release()
  await first
  await runAgent('design', {}, options('shared'), async () => {})
})

test('stale input is checked before work and before accepting its output', async () => {
  let calls = 0, worked = false
  await assert.rejects(runAgent('requirements', {}, {
    ...options(), assertCurrent: async () => { if (++calls === 2) throw new AgentBoundaryError('AGENT_STALE') },
  }, async () => { worked = true; return { prd: 'candidate' } }), { code: 'AGENT_STALE' })
  assert.equal(worked, true)
  await assert.rejects(runAgent('requirements', {}, {
    ...options(), assertCurrent: async () => { throw new AgentBoundaryError('AGENT_STALE') },
  }, async () => { assert.fail('stale work ran') }), { code: 'AGENT_STALE' })
})

test('cancelled agents discard late output and release the resource after work settles', async () => {
  const controller = new AbortController()
  const events: AgentEvent[] = []
  await assert.rejects(runAgent('requirements', {}, {
    ...options(), signal: controller.signal, onEvent: async event => { events.push(event) },
  }, async () => { controller.abort(new Error('cancel')); return 'late output' }), /cancel/)
  assert.equal(events.at(-1)?.kind, 'cancelled')
  await runAgent('requirements', {}, options(), async () => {})
})

test('model request budgets stop requests before sending and are shared across child roles', async () => {
  let sent = 0
  await assert.rejects(runAgent('test-implementation', {}, options(), async (_input, agent) => {
    const session = agent.session({ ...source(), send: async () => { sent++; return 'receipt' } })
    await session.send({ prompt: 'first' })
    await session.send({ prompt: 'must not send' })
  }), { code: 'AGENT_BUDGET' })
  assert.equal(sent, 1)
  await assert.rejects(runAgent('requirements', {}, options(), async (_input, agent) => {
    agent.forRole('coding')
  }), { code: 'AGENT_ROLE' })
})

test('role policies preserve original contracts and never elevate existing permissions', async () => {
  await runAgent('test-implementation', {}, options(), async (_input, agent) => {
    const guarded = agent.configure(config())
    assert.ok(guarded.systemMessage && 'content' in guarded.systemMessage && guarded.systemMessage.content?.includes('Original contract'))
    assert.ok(guarded.systemMessage && 'content' in guarded.systemMessage && guarded.systemMessage.content?.includes('test-implementation'))
    assert.equal((await guarded.onPermissionRequest!({ kind: 'shell', fullCommandText: 'echo bad' }, { sessionId: 'fixture' })).kind, 'reject')
    const denied = agent.configure({ ...config(), onPermissionRequest: async () => ({ kind: 'reject', feedback: 'path boundary' }) })
    assert.equal((await denied.onPermissionRequest!({ kind: 'read', path: 'file' }, { sessionId: 'fixture' })).kind, 'reject')
  })
})

test('forbidden tools never reach the original handler, while a model can recover from a denial', async () => {
  await runAgent('test-implementation', {}, options(), async (_input, agent) => {
    const guarded = agent.configure(config())
    const decision = await guarded.hooks!.onPreToolUse!({ toolName: 'task', toolArgs: {} }, { sessionId: 'fixture' })
    assert.equal(decision?.permissionDecision, 'deny')
  })
})

test('tool budgets are shared across newly configured sessions', async () => {
  await assert.rejects(runAgent('test-implementation', {}, options(), async (_input, agent) => {
    for (let index = 0; index <= agentProfiles['test-implementation'].maxTools; index++) {
      await agent.configure(config()).hooks!.onPreToolUse!({ toolName: 'view', toolArgs: {} }, { sessionId: 'fixture' })
    }
  }), { code: 'AGENT_BUDGET' })
})

test('child agents cannot reset the parent request budget', async () => {
  let sent = 0
  await assert.rejects(runAgent('coding', {}, options(), async (_input, agent) => {
    const read = { ...source(), send: async () => { sent++; return 'receipt' } }
    for (let index = 0; index < 128; index++) await agent.forRole('test-review').session(read).send({ prompt: 'review' })
    for (let index = 0; index < 128; index++) await agent.forRole('test-authoring').session(read).send({ prompt: 'generate' })
    await agent.forRole('test-planning').session(read).send({ prompt: 'over budget' })
  }), { code: 'AGENT_BUDGET' })
  assert.equal(sent, 256)
})

test('child request audit identifies the real role and correlates it with the parent without leaking prompts', async () => {
  const events: AgentEvent[] = []
  await runAgent('test-planning', {}, { ...options(), onEvent: async event => { events.push(event) } }, async (_input, agent) => {
    await agent.forRole('test-review').session(source()).send({ prompt: 'private review evidence' })
  })
  const request = events.find(event => event.kind === 'request')!
  assert.equal(request.handoff.role, 'test-review')
  assert.equal(request.parentRole, 'test-planning')
  assert.equal(request.handoff.runId, events[0].handoff.runId)
  assert.match(request.requestFingerprint!, /^[a-f0-9]{64}$/)
  assert.ok(!JSON.stringify(events).includes('private review evidence'))
})

test('failures and audit failures never become successful outcomes or leak input', async () => {
  const events: AgentEvent[] = []
  await assert.rejects(runAgent('requirements', { secret: 'private-input' }, {
    ...options(), onEvent: async event => { events.push(event) },
  }, async () => { throw new Error('private-error') }), /private-error/)
  assert.equal(events.at(-1)?.kind, 'failed')
  assert.ok(!JSON.stringify(events).includes('private'))
  await assert.rejects(runAgent('requirements', {}, {
    ...options(), onEvent: async () => { throw new Error('audit unavailable') },
  }, async () => { assert.fail('unaudited work ran') }), /audit unavailable/)
  await runAgent('requirements', {}, options(), async () => {})
})
