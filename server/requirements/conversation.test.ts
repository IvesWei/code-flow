import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { CopilotSession, SessionConfig, SessionEvent } from '@github/copilot-sdk'
import type { RequirementConversationEntry } from '../../shared/requirements.js'
import { RequirementConversationAudit } from './conversation.js'
import { MysqlRequirementRepository, type RequirementSqlPool } from './repository.js'

test('conversation records persist exact content separately from project bodies and enforce owner/job boundaries', async () => {
  const calls: { sql: string; values: unknown[] }[] = []
  let affectedRows = 1
  const pool: RequirementSqlPool = { async query(options, values = []) {
    calls.push({ sql: options.sql, values })
    return [{ affectedRows }, []]
  } }
  const repository = new MysqlRequirementRepository(pool)
  const projectId = randomUUID(), jobId = randomUUID()
  const entry: RequirementConversationEntry = {
    conversationId: randomUUID(), sequence: 1, requestIndex: 1, createdAt: new Date().toISOString(),
    kind: 'request', body: { prompt: '完整提示词\n"原型"\n' + 'x'.repeat(100000) },
  }
  await repository.appendConversation(7, projectId, jobId, entry)
  assert.match(calls[0].sql, /INSERT INTO codeflow_requirement_conversation_events/)
  assert.match(calls[0].sql, /owner_id = \?/)
  assert.match(calls[0].sql, /jobs\[\*\]\.id/)
  assert.ok(calls[0].values.includes(projectId))
  assert.ok(calls[0].values.includes(jobId))
  assert.ok(calls[0].values.includes(JSON.stringify(entry.body)))
  affectedRows = 0
  await assert.rejects(repository.appendConversation(8, projectId, jobId, entry))
  await assert.rejects(repository.appendConversation(7, projectId, jobId, { ...entry, sequence: 0 }))
})

test('PRD recovery reads only the previous owned job checkpoint, never attachment or tool bodies', async () => {
  const projectId = randomUUID(), jobId = randomUUID(), conversation = randomUUID()
  const pool: RequirementSqlPool = { async query(options, values = []) {
    assert.match(options.sql, /WHERE owner_id = \? AND project_id = \? AND job_id = \?/)
    assert.match(options.sql, /LIMIT 1/)
    assert.doesNotMatch(options.sql, /attachment\.chunk|tool\.execution/)
    if (JSON.stringify(values.slice(0, 3)) !== JSON.stringify([7, projectId, jobId])) return [[], []]
    return [[{ conversation_id: conversation, kind: 'prd.checkpoint', body: JSON.stringify({ fingerprint: 'bound' }) }], []]
  } }
  const repository = new MysqlRequirementRepository(pool)
  assert.deepEqual(await repository.readPrdAudit(7, projectId, jobId), { checkpoint: { fingerprint: 'bound' } })
  assert.equal(await repository.readPrdAudit(8, projectId, jobId), undefined)
  assert.equal(await repository.readPrdAudit(7, projectId, randomUUID()), undefined)
})

function session() {
  const listeners = new Set<(event: SessionEvent) => void>()
  const sent: Parameters<CopilotSession['send']>[0][] = []
  const value = {
    sessionId: 'sdk-audit-session',
    on(handler: (event: SessionEvent) => void) { listeners.add(handler); return () => listeners.delete(handler) },
    async send(options: Parameters<CopilotSession['send']>[0]) { sent.push(options); return 'request-id' },
  }
  return { value, sent, emit(event: SessionEvent) { for (const listener of listeners) listener(event) } }
}
const config: SessionConfig = {
  model: 'test', systemMessage: { mode: 'replace', content: 'actual system instructions' },
  availableTools: ['workspace_read'], gitHubToken: 'transport-secret',
}
test('audit captures ordered requests, tool I/O, assistant output and context events without credentials or hidden reasoning', async () => {
  const entries: RequirementConversationEntry[] = []
  const audit = new RequirementConversationAudit(async entry => { entries.push(entry) }, ['transport-secret'])
  await audit.start(config, { stage: 'design', projectVersion: 3 })
  const fake = session()
  await audit.attach(fake.value)
  await audit.send(fake.value, { prompt: 'Full first input' })
  fake.emit({ type: 'tool.execution_start', id: 't1', data: { toolCallId: 'read', toolName: 'workspace_read', arguments: { path: 'sources/snapshot-1.md' } } } as SessionEvent)
  fake.emit({ type: 'tool.execution_complete', id: 't2', data: { toolCallId: 'read', success: true, result: { content: 'exact code excerpt', cookie: 'private-cookie' } } } as SessionEvent)
  fake.emit({ type: 'assistant.reasoning_delta', data: { deltaContent: 'hidden reasoning' } } as SessionEvent)
  fake.emit({ type: 'assistant.message_delta', data: { messageId: 'm1', deltaContent: 'complete ' } } as SessionEvent)
  fake.emit({ type: 'assistant.message', id: 'a1', data: { messageId: 'm1', content: 'complete output transport-secret', reasoningText: 'hidden reasoning' } } as SessionEvent)
  fake.emit({ type: 'session.compaction_complete', data: { success: true } } as SessionEvent)
  await audit.send(fake.value, { prompt: 'Correction with original candidate and errors' })
  await audit.finish('succeeded')
  assert.deepEqual(entries.map(entry => entry.sequence), entries.map((_entry, index) => index + 1))
  assert.equal(new Set(entries.map(entry => entry.conversationId)).size, 1)
  assert.equal(entries.find(entry => entry.kind === 'session.start')?.body.systemMessage && JSON.stringify(entries[0].body).includes('actual system instructions'), true)
  assert.deepEqual(entries.filter(entry => entry.kind === 'request').map(entry => entry.body.prompt), fake.sent.map(entry => entry.prompt))
  assert.deepEqual(entries.filter(entry => entry.kind === 'request').map(entry => entry.requestIndex), [1, 2])
  assert.ok(entries.some(entry => entry.kind === 'tool.execution_complete' && JSON.stringify(entry.body).includes('exact code excerpt')))
  assert.ok(entries.some(entry => entry.kind === 'assistant.message' && entry.body.content === 'complete output [REDACTED]'))
  assert.ok(entries.some(entry => entry.kind === 'session.compaction_complete'))
  assert.doesNotMatch(JSON.stringify(entries), /transport-secret|private-cookie|hidden reasoning|gitHubToken/)
  assert.equal(entries.at(-1)?.body.status, 'succeeded')
})
test('audit failures stop sends and are surfaced; cancellation retains partial assistant content', async () => {
  const broken = new RequirementConversationAudit(async () => { throw new Error('private database details') })
  await assert.rejects(broken.start(config, {}), /CONVERSATION_STORAGE/)
  const fake = session()
  await assert.rejects(broken.send(fake.value, { prompt: 'must not send' }), /CONVERSATION_STORAGE/)
  assert.equal(fake.sent.length, 0)
  const entries: RequirementConversationEntry[] = []
  const audit = new RequirementConversationAudit(async entry => { entries.push(entry) })
  await audit.start(config, {})
  await audit.attach(fake.value)
  await audit.send(fake.value, { prompt: 'input' })
  fake.emit({ type: 'assistant.message_delta', data: { messageId: 'partial', deltaContent: 'unfinished response' } } as SessionEvent)
  await audit.finish('cancelled')
  assert.equal(entries.find(entry => entry.kind === 'assistant.partial')?.body.content, 'unfinished response')
  assert.equal(entries.at(-1)?.body.status, 'cancelled')
})
test('attachment bytes survive temporary file cleanup and repeated requests reference the same exact chunks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'requirement-audit-attachment-'))
  const path = join(root, 'attachment.pdf')
  const bytes = Buffer.alloc(600000, 0xff)
  const entries: RequirementConversationEntry[] = []
  const audit = new RequirementConversationAudit(async entry => { entries.push(entry) })
  const fake = session()
  try {
    await writeFile(path, bytes)
    await audit.start(config, {})
    await audit.attach(fake.value)
    for (let index = 0; index < 2; index++) await audit.send(fake.value, { prompt: `round ${index}`, attachments: [{ type: 'file', path, displayName: 'Original.pdf' }] })
    await audit.finish('succeeded')
    const chunks = entries.filter(entry => entry.kind === 'attachment.chunk')
    assert.equal(chunks.length, 3)
    assert.deepEqual(Buffer.concat(chunks.map(entry => Buffer.from(String(entry.body.content), 'base64'))), bytes)
    const requests = entries.filter(entry => entry.kind === 'request')
    assert.deepEqual(requests[0].body.attachments, requests[1].body.attachments)
    assert.ok(JSON.stringify(requests[0].body.attachments).includes(createHash('sha256').update(bytes).digest('hex')))
    assert.ok(!JSON.stringify(entries).includes(path))
  } finally { await rm(root, { recursive: true, force: true }) }
})
