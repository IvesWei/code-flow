import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CodingTask } from '../../../shared/task.js'
import { ActivitySection } from '../../../src/features/coding/ActivitySection.js'
import { TaskConversation } from '../../../src/features/coding/TaskConversation.js'

test('activity overview prioritizes failures but retains a way to inspect the full transcript', () => {
  const now = new Date().toISOString()
  const task: CodingTask = {
    id: 'test', repository: 'https://github.com/owner/repo', instruction: 'Build feature',
    prdName: 'prd.md', designNames: [], status: 'FAILED', createdAt: now, updatedAt: now,
    changes: ['src/index.ts'], checks: [{ name: 'npm run test', passed: false, output: 'assertion failed' }],
    entries: [
      { at: now, stage: 'CODING', kind: 'info', text: '一般流程提示' },
      { at: now, stage: 'CODING', kind: 'agent', text: '已实现功能' },
      { at: now, stage: 'CODING', kind: 'info', text: 'Copilot 正在执行 shell', toolEvent: 'start', toolCallId: '1', detail: 'command: npm test' },
      { at: now, stage: 'CODING', kind: 'error', text: 'shell 执行失败', toolEvent: 'complete', toolCallId: '1', detail: 'assertion failed' },
    ],
  }
  const html = renderToStaticMarkup(createElement(ActivitySection, { task }))
  assert.match(html, /1 个变更文件 · 0\/1 项检查通过 · 1 条异常/)
  assert.match(html, /重点/)
  assert.match(html, /全部/)
  assert.match(html, /assertion failed/)
  assert.doesNotMatch(html, /一般流程提示/)
})

test('focused view shows a running model request, input pause and the timed-out step', () => {
  const now = new Date().toISOString()
  const task: CodingTask = {
    id: 'task', repository: 'repo', instruction: 'code', prdName: 'prd.md', designNames: [], status: 'CODING', createdAt: now, updatedAt: now,
    modelInTurn: true, modelTurn: { id: 'turn', label: '编码执行', startedAt: now, lastActivityAt: now, summary: '模型正在响应', inactivityTimeoutMs: 1200000, status: 'running' },
    entries: [{ at: now, kind: 'info', text: '编码执行 · 模型 auto', stage: 'CODING', turnId: 'turn', turnEvent: 'start' }],
  }
  const render = () => renderToStaticMarkup(createElement(TaskConversation, { task, entries: task.entries }))
  assert.match(render(), /运行中/)
  assert.match(render(), /最后活动：模型正在响应/)
  task.modelTurn!.summary = 'SDK 已接收请求，等待模型响应'
  assert.match(render(), /最后活动：SDK 已接收请求/)
  task.modelTurn!.summary = 'Copilot SDK 正在压缩上下文，等待模型或工具进展'
  assert.match(render(), /最后活动：Copilot SDK 正在压缩上下文/)
  task.status = 'NEEDS_INPUT'
  assert.match(render(), /超时计时已暂停/)
  task.status = 'FAILED'
  task.modelTurn = { ...task.modelTurn!, status: 'timed_out', summary: '正在执行 shell · npm test', finishedAt: now }
  task.entries.push({ at: now, kind: 'error', text: '编码执行无进展超时', detail: '连续 1200 秒未收到进展', stage: 'CODING', turnId: 'turn', turnEvent: 'complete' })
  task.entries.push({ at: now, kind: 'info', text: 'Copilot 正在执行 shell', toolCallId: 'tool', toolEvent: 'start', stage: 'CODING' })
  assert.match(render(), /编码执行无进展超时/)
  assert.match(render(), /npm test/)
  assert.match(render(), /已中断/)
  assert.doesNotMatch(render(), /运行中/)
})