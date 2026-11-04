import { defaultModel } from './models.js'
import { TaskStore } from '../tasks/store.js'
import { randomUUID } from 'node:crypto'
import { SessionProgressTimeout, type SessionProgress } from './session-progress.js'
import type { ModelTimeouts } from './model-timeouts.js'

export class ModelTurn {
  private sessionModel: string

  constructor(private readonly store: TaskStore, private readonly taskId: string, initialModel: string, private readonly session: { setModel(model: string): Promise<void> }) {
    this.sessionModel = initialModel
  }

  async send<T>(sendMessage: (report: (progress: SessionProgress) => void) => Promise<T>, label = 'Copilot 对话请求', timeout: number | ModelTimeouts = 20 * 60_000): Promise<T> {
    const { firstResponseMs, inactivityMs } = typeof timeout === 'number' ? { firstResponseMs: timeout, inactivityMs: timeout } : timeout
    const turnId = randomUUID()
    while (true) {
      const before = this.store.get(this.taskId)!
      const expectedRevision = before.modelRevision || 0
      const target = before.modelId || this.sessionModel || defaultModel()
      if (target !== this.sessionModel) {
        await this.session.setModel(target)
        this.sessionModel = target
      }
      const current = this.store.get(this.taskId)!
      if ((current.modelRevision || 0) !== expectedRevision) continue
      const revision = expectedRevision
      this.store.update(this.taskId, {
        activeModelId: this.sessionModel, appliedModelRevision: revision, modelInTurn: true,
        modelHistory: current.modelHistory?.map((change) => change.revision === revision && !change.appliedAt ? { ...change, appliedAt: new Date().toISOString() } : change),
      })
      const startedAt = new Date().toISOString()
      this.store.update(this.taskId, { modelTurn: { id: turnId, label, startedAt, lastActivityAt: startedAt, summary: '正在发送请求', firstResponseTimeoutMs: firstResponseMs, inactivityTimeoutMs: inactivityMs, status: 'running' } })
      this.store.entry(this.taskId, 'info', `${label} · 模型 ${this.sessionModel}`, `首次响应超时：${Math.round(firstResponseMs / 1000)} 秒；后续无进展超时：${Math.round(inactivityMs / 1000)} 秒。有模型或工具进展时重新计时，等待用户回答时暂停；SDK 接收、回合启动和上下文压缩事件不延长等待。超时不自动重试或重放命令。`, { turnId, turnEvent: 'start' })
      break
    }
    try {
      if (this.store.asynchronousPersistence) await this.store.flush()
      const response = await sendMessage((progress) => {
        const current = this.store.get(this.taskId)!.modelTurn!
        this.store.update(this.taskId, { modelTurn: { ...current, ...progress } })
      })
      const current = this.store.get(this.taskId)!.modelTurn!
      this.store.update(this.taskId, { modelTurn: { ...current, status: 'completed', finishedAt: new Date().toISOString() } })
      this.store.entry(this.taskId, 'info', `${label}完成`, undefined, { turnId, turnEvent: 'complete' })
      return response
    } catch (error) {
      const current = this.store.get(this.taskId)!.modelTurn!
      const timedOut = error instanceof SessionProgressTimeout
      const message = error instanceof Error ? error.message : String(error)
      this.store.update(this.taskId, { modelTurn: { ...current, status: timedOut ? 'timed_out' : 'failed', finishedAt: new Date().toISOString() } })
      this.store.entry(this.taskId, 'error', `${label}${timedOut ? '无进展超时' : '失败'}`, message, { turnId, turnEvent: 'complete' })
      throw error
    } finally {
      this.store.update(this.taskId, { modelInTurn: false })
      if (this.store.asynchronousPersistence) await this.store.flush()
    }
  }
}