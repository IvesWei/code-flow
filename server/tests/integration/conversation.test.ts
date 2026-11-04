import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TaskEntry } from '../../../shared/task.js'
import { conversationItems, focusedConversationItems } from '../../../shared/conversation.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStore } from '../../tasks/store.js'

test('interleaved tool calls keep their own commands and return values', () => {
  const entry = (toolCallId: string, toolEvent: 'start' | 'complete', detail: string): TaskEntry => ({
    at: '2026-09-26T00:00:00Z', kind: 'info', text: detail, detail, toolCallId, toolEvent, stage: 'CODING',
  })
  const entries = [entry('a', 'start', 'npm test'), entry('b', 'start', 'git status'), entry('b', 'complete', 'clean'), entry('a', 'complete', 'passed')]
  const items = conversationItems(entries)
  assert.equal(items.length, 2)
  assert.equal(items[0].entry.detail, 'npm test')
  assert.equal(items[0].result?.detail, 'passed')
  assert.equal(items[1].result?.detail, 'clean')
  assert.equal(conversationItems([entry('orphan', 'complete', 'old result')]).length, 1)
})

test('long agent runs keep more than one hundred events', () => {
  const directory = mkdtempSync(join(tmpdir(), 'code-flow-conversation-'))
  try {
    const store = new TaskStore(join(directory, 'tasks.json'))
    const now = new Date().toISOString()
    store.create({ id: 'long', repository: 'https://github.com/owner/repo', instruction: 'Implement feature', prdName: 'prd.md', designNames: [], status: 'CODING', createdAt: now, updatedAt: now, entries: Array.from({ length: 120 }, (_, index) => ({ at: now, kind: 'info' as const, text: `step ${index}` })) })
    store.entry('long', 'info', 'step 120')
    assert.equal(store.get('long')?.entries.length, 121)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('focused view keeps failures, outstanding calls, decisions and orphaned results', () => {
  const entry = (toolCallId: string, toolEvent: 'start' | 'complete', kind: TaskEntry['kind']): TaskEntry => ({
    at: '2026-09-26T00:00:00Z', kind, text: toolCallId, toolCallId, toolEvent, stage: 'CODING',
  })
  const entries: TaskEntry[] = [entry('ok', 'start', 'info'), entry('fail', 'start', 'info'), entry('ok', 'complete', 'info'),
    entry('fail', 'complete', 'error'), entry('pending', 'start', 'info'), entry('orphan', 'complete', 'info'),
    { at: '2026-09-26T00:00:01Z', kind: 'answer', text: '确认', stage: 'CODING' },
    { at: '2026-09-26T00:00:02Z', kind: 'info', text: '根据你的补充说明，在原工作目录继续编码', stage: 'CODING' }]
  assert.deepEqual(focusedConversationItems(conversationItems(entries)).map((item) => item.entry.toolCallId || item.entry.text),
    ['fail', 'pending', 'orphan', '确认', '根据你的补充说明，在原工作目录继续编码'])
})

test('focused records pair model turns and retain them without any tool events', () => {
  const entries: TaskEntry[] = [
    { at: '2026-10-12T00:00:00Z', kind: 'info', text: '编码执行', turnId: 'turn', turnEvent: 'start', stage: 'CODING' },
    { at: '2026-10-12T00:20:00Z', kind: 'error', text: '编码执行无进展超时', detail: '最后活动：npm test', turnId: 'turn', turnEvent: 'complete', stage: 'CODING' },
  ]
  assert.equal(focusedConversationItems(conversationItems(entries.slice(0, 1))).length, 1)
  const focused = focusedConversationItems(conversationItems(entries))
  assert.equal(focused.length, 1)
  assert.equal(focused[0].result?.detail, '最后活动：npm test')
})