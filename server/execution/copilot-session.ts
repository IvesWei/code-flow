import type { CopilotClient, SessionConfig } from '@github/copilot-sdk'
import { TaskStorageError, type TaskStore } from '../tasks/store.js'
import { repairAttachmentHistory } from './session-history.js'

export class SessionRestoreError extends Error {}

export async function openTaskSession(client: Pick<CopilotClient, 'createSession' | 'resumeSession'>, store: TaskStore, taskId: string, directory: string, config: SessionConfig, continuing: boolean, allowNewSession = false) {
  const saved = store.get(taskId)!.copilotSession
  if (continuing && !allowNewSession) {
    if (!saved) throw new SessionRestoreError('此任务没有保存 SDK 会话 ID。不能自动恢复；如需继续，请明确选择使用历史记录开启新会话。')
    if (saved.directory !== directory) throw new SessionRestoreError('SDK 会话目录与当前任务不一致，已阻止恢复。请检查 DATA_DIR 配置。')
    try {
      const resume = () => client.resumeSession(saved.id, { ...config, continuePendingWork: false })
      let session
      try { session = await resume() }
      catch (error) {
        const message = error instanceof Error ? error.message : ''
        if (!/Failed to read JSONL.*Invalid event.*untagged enum Attachment/s.test(message)) throw error
        let repaired: number
        try { repaired = await repairAttachmentHistory(directory, saved.id) }
        catch { throw new SessionRestoreError('SDK 历史附件格式不兼容，备份或修复未完成。原会话未替换，请检查目录权限和历史文件。') }
        if (!repaired) throw new SessionRestoreError('SDK 历史附件格式不兼容，但没有可安全补全的附件字段。原会话未替换，请检查 SDK 版本。')
        store.entry(taskId, 'warning', `已备份 SDK 历史并补全 ${repaired} 个附件显示名，正在重试恢复原会话`)
        await store.flush()
        session = await resume()
      }
      if (session.sessionId !== saved.id) throw new SessionRestoreError('SDK 返回的会话 ID 与任务不一致，已阻止继续。')
      store.update(taskId, { sessionRestoreError: undefined })
      await store.flush()
      return { session, restored: true }
    } catch (error) {
      if (error instanceof SessionRestoreError || error instanceof TaskStorageError) throw error
      const message = error instanceof Error ? error.message : ''
      if (/Session was not created with authentication info|authentication required|unauthorized|invalid.*token|token.*expired/i.test(message)) {
        throw new SessionRestoreError('SDK 原会话恢复失败：会话认证缺失或登录已失效。请重新登录后恢复原会话；未自动创建新会话。')
      }
      if (/session.*(?:not found|does not exist)|no such session/i.test(message)) {
        throw new SessionRestoreError('SDK 原会话恢复失败：SDK 未找到已保存的会话。请检查本地会话历史目录；未自动创建新会话。')
      }
      throw new SessionRestoreError('SDK 原会话恢复失败，未自动创建新会话。请检查会话目录是否保留、SDK 服务是否可用，或明确选择使用历史记录开启新会话。')
    }
  }
  const session = await client.createSession(config)
  if (!session.sessionId) throw new Error('SDK 没有返回有效会话 ID，已阻止发送编码请求')
  try {
    store.update(taskId, { copilotSession: { id: session.sessionId, directory, previousIds: saved ? [...(saved.previousIds || []), saved.id] : [] }, sessionRestoreError: undefined })
    await store.flush()
  } catch (error) {
    await session.disconnect().catch(() => {})
    throw error
  }
  return { session, restored: false }
}