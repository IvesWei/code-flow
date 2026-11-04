import type { TaskEntry } from './task.js'

export interface ConversationItem { entry: TaskEntry; result?: TaskEntry }

export function conversationItems(entries: TaskEntry[]): ConversationItem[] {
  const items: ConversationItem[] = []
  const starts = new Map<string, ConversationItem>()
  for (const entry of entries) {
    if (entry.toolCallId && entry.toolEvent === 'start') {
      const item = { entry }
      items.push(item)
      starts.set(entry.toolCallId, item)
    } else if (entry.toolCallId && entry.toolEvent === 'complete' && starts.has(entry.toolCallId)) {
      starts.get(entry.toolCallId)!.result = entry
    } else if (entry.turnId && entry.turnEvent === 'start') {
      const item = { entry }
      items.push(item)
      starts.set(`turn:${entry.turnId}`, item)
    } else if (entry.turnId && entry.turnEvent === 'complete' && starts.has(`turn:${entry.turnId}`)) {
      starts.get(`turn:${entry.turnId}`)!.result = entry
    } else {
      items.push({ entry })
    }
  }
  return items
}

export function focusedConversationItems(items: ConversationItem[]): ConversationItem[] {
  return items.filter(({ entry, result }) =>
    !!entry.turnId ||
    ['agent', 'answer', 'warning', 'error'].includes(entry.kind) ||
    (entry.kind === 'info' && /根据你的补充说明|补跑编码自测|正在定点修正|用户选择跳过|已推送/.test(entry.text)) ||
    (entry.toolEvent === 'start' && (!result || ['warning', 'error'].includes(result.kind))) ||
    (entry.toolEvent === 'complete' && !items.some((item) => item.entry.toolEvent === 'start' && item.entry.toolCallId === entry.toolCallId)))
}