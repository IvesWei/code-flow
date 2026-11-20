import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { CopilotSession, SessionConfig, SessionEvent } from '@github/copilot-sdk'
import type { RequirementConversationEntry, RequirementPrdCheckpoint } from '../../shared/requirements.js'
import { RequirementDiagnosticError } from './diagnostics.js'

const credentialKeys = /^(?:githubtoken|authorization|proxy-authorization|cookie|set-cookie|password|credentials|reasoning|reasoningtext)$/i
const eventTypes = new Set([
  'assistant.message', 'assistant.usage', 'assistant.turn_start', 'assistant.turn_end',
  'tool.execution_start', 'tool.execution_complete', 'tool.execution_partial_result', 'tool.execution_progress',
  'session.error', 'session.idle', 'session.compaction_start', 'session.compaction_complete', 'session.truncation',
])
type Session = {
  sessionId?: string
  send: CopilotSession['send']
  on(handler: (event: SessionEvent) => void): () => void
}

export class RequirementConversationAudit {
  readonly conversationId: string
  private sequence = 0
  private requestIndex = 0
  private sdkSessionId?: string
  private pending = Promise.resolve()
  private error?: RequirementDiagnosticError
  private unsubscribe?: () => void
  private closed = false
  private readonly partials = new Map<string, string>()
  private readonly attachments = new Map<string, string>()

  constructor(
    private readonly record: (entry: RequirementConversationEntry) => Promise<void>,
    private readonly credentials: string[] = [],
    private readonly onFailure: (error: RequirementDiagnosticError) => void = () => {},
    conversationId: string = randomUUID(),
  ) { this.conversationId = conversationId }

  get failure() { return this.error }

  private clean(body: Record<string, unknown>): Record<string, unknown> {
    const cleaned: unknown = JSON.parse(JSON.stringify(body, (key, value: unknown) => {
      if (credentialKeys.test(key)) return undefined
      if (typeof value !== 'string') return value
      let text = value
      for (const credential of this.credentials) if (credential) text = text.replaceAll(credential, '[REDACTED]')
      return text
    }))
    if (!cleaned || typeof cleaned !== 'object' || Array.isArray(cleaned)) throw new Error('Invalid conversation body')
    return cleaned as Record<string, unknown>
  }

  private append(kind: string, body: Record<string, unknown>): Promise<void> {
    const sequence = ++this.sequence, requestIndex = this.requestIndex
    const createdAt = new Date().toISOString()
    this.pending = this.pending.then(async () => {
      if (this.error) throw this.error
      try {
        await this.record({
          conversationId: this.conversationId, sdkSessionId: this.sdkSessionId,
          sequence, requestIndex, createdAt, kind, body: this.clean(body),
        })
      } catch {
        this.error = new RequirementDiagnosticError('storage', 'CONVERSATION_STORAGE', 'Copilot 会话记录写入失败，任务已停止；请检查会话记录表、数据库连接和写入权限')
        this.onFailure(this.error)
        throw this.error
      }
    })
    void this.pending.catch(() => {})
    return this.pending
  }

  async start(config: SessionConfig, metadata: Record<string, unknown>): Promise<void> {
    await this.append('session.start', {
      ...metadata, model: config.model, systemMessage: config.systemMessage,
      streaming: config.streaming, availableTools: config.availableTools,
      tools: config.tools?.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
      permissions: 'Only registered application tools outside format correction; no shell, arbitrary filesystem or network permissions.',
    })
  }

  async attach(session: Session, restored = false): Promise<void> {
    this.sdkSessionId = session.sessionId
    this.unsubscribe = session.on(event => {
      if (this.closed) return
      if (event.type === 'assistant.message_delta') {
        const id = event.data.messageId
        this.partials.set(id, (this.partials.get(id) ?? '') + event.data.deltaContent)
        return
      }
      if (event.type === 'assistant.message') this.partials.delete(event.data.messageId)
      if (eventTypes.has(event.type)) void this.append(event.type, { ...event.data, eventId: event.id, timestamp: event.timestamp })
    })
    await this.append(restored ? 'session.resumed' : 'session.created', { sdkSessionId: this.sdkSessionId })
  }

  async send(session: Session, options: Parameters<CopilotSession['send']>[0], signal?: AbortSignal): ReturnType<CopilotSession['send']> {
    await this.pending
    signal?.throwIfAborted()
    this.requestIndex++
    const files = []
    for (const attachment of options.attachments ?? []) {
      if (attachment.type !== 'file') throw new RequirementDiagnosticError('prompt', 'CONVERSATION_ATTACHMENT', 'Unsupported Copilot audit attachment type')
      const bytes = await readFile(attachment.path)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const existingId = this.attachments.get(sha256)
      files.push({ bytes, sha256, existingId, attachmentId: existingId ?? randomUUID(), displayName: attachment.displayName })
    }
    await this.append('request', {
      prompt: options.prompt, mode: options.mode,
      attachments: files.map(file => ({ type: 'file', attachmentId: file.attachmentId, displayName: file.displayName, sha256: file.sha256, sizeBytes: file.bytes.length })),
    })
    for (const file of files) {
      if (file.existingId) continue
      for (let offset = 0, chunkIndex = 0; offset < file.bytes.length; offset += 256 * 1024, chunkIndex++) {
        await this.append('attachment.chunk', {
          attachmentId: file.attachmentId, chunkIndex, encoding: 'base64',
          content: file.bytes.subarray(offset, offset + 256 * 1024).toString('base64'),
        })
      }
      this.attachments.set(file.sha256, file.attachmentId)
    }
    signal?.throwIfAborted()
    const requestId = await session.send(options)
    if (!this.closed) await this.append('request.accepted', { requestId })
    await this.pending
    return requestId
  }

  async flush(): Promise<void> { await this.pending }
  checkpoint(value: RequirementPrdCheckpoint): Promise<void> { return this.append('prd.checkpoint', { ...value }) }
  dispose(): void { this.unsubscribe?.() }

  async finish(status: 'succeeded' | 'failed' | 'cancelled', error?: RequirementDiagnosticError): Promise<void> {
    if (this.closed) return this.flush()
    this.closed = true
    this.dispose()
    for (const [messageId, content] of this.partials) await this.append('assistant.partial', { messageId, content })
    await this.append('session.finish', { status, ...(error ? { code: error.code, phase: error.phase, message: error.message } : {}) })
  }
}
