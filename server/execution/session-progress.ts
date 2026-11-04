import type { CopilotSession, SessionEvent } from '@github/copilot-sdk'
import { toolArguments } from './tool-detail.js'
import type { ModelTimeouts } from './model-timeouts.js'

export interface SessionProgress {
  lastActivityAt: string
  summary: string
}

export class SessionProgressTimeout extends Error {
  constructor(timeout: number, progress: SessionProgress, firstResponse = false) {
    super(`${firstResponse ? '等待首次模型或工具响应超时：' : ''}连续 ${Math.round(timeout / 1000)} 秒未收到模型或工具进展，等待 session.idle 超时。最后活动：${progress.summary}（${progress.lastActivityAt}）。未自动重试或重放命令。`)
    this.name = 'SessionProgressTimeout'
  }
}

type SessionSource = Pick<CopilotSession, 'send' | 'on'>

export class SessionProgressWaiter {
  private paused = false
  private refresh?: () => void

  constructor(private readonly session: SessionSource) {}

  pause(): void { this.paused = true; this.refresh?.() }
  resume(): void { this.paused = false; this.refresh?.() }

  async send(options: Parameters<CopilotSession['send']>[0], timeout: number | ModelTimeouts, report: (progress: SessionProgress) => void = () => {}): Promise<Extract<SessionEvent, { type: 'assistant.message' }> | undefined> {
    const limits = typeof timeout === 'number' ? { firstResponseMs: timeout, inactivityMs: timeout } : timeout
    let firstResponse = true
    let progress: SessionProgress = { lastActivityAt: new Date().toISOString(), summary: '正在发送请求，等待 SDK 接收' }
    let lastMessage: Extract<SessionEvent, { type: 'assistant.message' }> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    let resolveOutcome!: () => void
    let rejectOutcome!: (error: unknown) => void
    let lastReported = 0
    const tools = new Map<string, string>()
    const outcome = new Promise<void>((resolve, reject) => { resolveOutcome = resolve; rejectOutcome = reject })
    const refresh = () => {
      clearTimeout(timer)
      const duration = firstResponse ? limits.firstResponseMs : limits.inactivityMs
      if (!settled && !this.paused) timer = setTimeout(() => {
        settled = true
        rejectOutcome(new SessionProgressTimeout(duration, progress, firstResponse))
      }, duration)
    }
    this.refresh = refresh
    const unsubscribe = this.session.on((event) => {
      if (settled) return
      if (event.type === 'session.idle' && event.data.mode !== 'autopilot') {
        settled = true
        resolveOutcome()
        return
      }
      if (event.type === 'session.error') {
        settled = true
        rejectOutcome(new Error(event.data.message))
        return
      }
      let summary: string | undefined
      let immediate = false
      let meaningful = true
      if (event.type === 'assistant.turn_start') {
        summary = 'SDK 已启动模型回合，等待模型响应'
        meaningful = false
        immediate = true
      } else if (event.type === 'session.compaction_start') {
        summary = 'Copilot SDK 正在压缩上下文，等待模型或工具进展'
        meaningful = false
        immediate = true
      } else if (event.type === 'session.compaction_complete') {
        summary = event.data.success ? 'Copilot SDK 上下文压缩完成，等待模型或工具进展' : 'Copilot SDK 上下文压缩未成功，等待后续事件'
        meaningful = false
        immediate = true
      } else if (event.type === 'session.truncation') {
        summary = 'Copilot SDK 已截断部分会话上下文，等待模型或工具进展'
        meaningful = false
        immediate = true
      } else if (event.type === 'assistant.message') {
        lastMessage = event
        summary = '模型已返回消息，等待会话结束或下一步工具执行'
        immediate = true
      } else if (event.type === 'assistant.message_delta' || event.type === 'assistant.reasoning_delta') {
        summary = tools.size ? `模型正在响应；未结束工具：${[...tools.values()].join('；')}` : '模型正在响应'
      } else if (event.type === 'tool.execution_start') {
        const detail = toolArguments(event.data.arguments)?.split('\n')[0]?.slice(0, 160)
        const name = `${event.data.toolName}${detail ? ` · ${detail}` : ''}`
        tools.set(event.data.toolCallId, name)
        summary = `正在执行 ${name}`
        immediate = true
      } else if (event.type === 'tool.execution_complete') {
        const name = tools.get(event.data.toolCallId) || '工具'
        tools.delete(event.data.toolCallId)
        summary = tools.size ? `未结束工具：${[...tools.values()].join('；')}` : `${name} 已返回，等待模型下一步`
        immediate = true
      } else if (event.type === 'tool.execution_progress' || event.type === 'tool.execution_partial_result') {
        summary = `工具正在返回进展：${tools.get(event.data.toolCallId) || event.data.toolCallId}`
      }
      if (!summary) return
      progress = { lastActivityAt: new Date().toISOString(), summary: summary.slice(0, 1000) }
      if (meaningful) { firstResponse = false; refresh() }
      if (immediate || Date.now() - lastReported >= 10_000) {
        lastReported = Date.now()
        try { report(progress) } catch (error) { settled = true; rejectOutcome(error) }
      }
    })
    try {
      report(progress)
      refresh()
      await Promise.race([this.session.send(options).then(() => {
        if (!settled && progress.summary === '正在发送请求，等待 SDK 接收') {
          progress = { lastActivityAt: new Date().toISOString(), summary: 'SDK 已接收请求，等待模型响应' }
          report(progress)
        }
        return outcome
      }), outcome])
      return lastMessage
    } finally {
      settled = true
      clearTimeout(timer)
      this.refresh = undefined
      unsubscribe()
    }
  }
}