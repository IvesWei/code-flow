import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { normalizeAttachmentHistory, repairAttachmentHistory } from './session-history.js'

test('attachment repair preserves events and only fills missing file display names', () => {
  const event = { type: 'user.message', id: 'event-id', data: { content: 'original request', attachments: [{ type: 'file', path: 'C:\\uploads\\design.png', assetId: 'asset', mimeType: 'image/png' }, { type: 'file', path: '/uploads/prd.md', displayName: 'existing' }, { type: 'blob', data: 'image' }] } }
  const original = `${JSON.stringify(event)}\n{"type":"assistant.message","data":{"content":"history"}}\n`
  const result = normalizeAttachmentHistory(original)
  assert.equal(result.changed, 1)
  const restored = JSON.parse(result.content.split('\n')[0])
  assert.equal(restored.data.attachments[0].displayName, 'design.png')
  delete restored.data.attachments[0].displayName
  assert.deepEqual(restored, event)
  assert.equal(normalizeAttachmentHistory(result.content).changed, 0)
  assert.throws(() => normalizeAttachmentHistory('not json'))
})

test('history repair backs up original before replacement and rejects unsafe IDs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codeflow-history-'))
  try {
    const state = join(directory, 'session-state', 'session-id')
    await mkdir(state, { recursive: true })
    const original = JSON.stringify({ type: 'user.message', data: { attachments: [{ type: 'file', path: '/uploads/prd.md' }] } })
    await writeFile(join(state, 'events.jsonl'), original)
    assert.equal(await repairAttachmentHistory(directory, 'session-id'), 1)
    const backups = (await readdir(state)).filter(name => name.endsWith('.backup'))
    assert.equal(backups.length, 1)
    assert.equal(await readFile(join(state, backups[0]), 'utf8'), original)
    assert.equal(JSON.parse(await readFile(join(state, 'events.jsonl'), 'utf8')).data.attachments[0].displayName, 'prd.md')
    assert.equal(await repairAttachmentHistory(directory, 'session-id'), 0)
    await assert.rejects(repairAttachmentHistory(directory, '../outside'))
  } finally { await rm(directory, { recursive: true, force: true }) }
})