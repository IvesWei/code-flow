import type { CopilotSession, SessionEvent } from '@github/copilot-sdk'

type UsageEvent = Extract<SessionEvent, { type: 'assistant.usage' | 'session.shutdown' }>

export interface ModelUsageContext {
  taskId: string
  turnId?: string
  artifactId?: string
  model?: string
  phase: string
}

export interface ModelUsageMetrics {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  cost?: number
  totalNanoAiu?: number
  requestCount?: number
}

export interface ModelUsageObservation extends ModelUsageContext {
  sessionId: string
  sourceEventId: string
  observedAt: string
  bodyVersion: 1
  body: {
    sourceEventType: UsageEvent['type']
    counting: 'incremental' | 'cumulative'
    aggregation: 'authoritative' | 'reference-only'
    metrics: ModelUsageMetrics
    modelMetrics?: Record<string, ModelUsageMetrics>
    raw: UsageEvent
  }
}

export interface ModelUsageObserver {
  flush(): Promise<void>
  dispose(): void
}

function metrics(source: ModelUsageMetrics): ModelUsageMetrics {
  const result: ModelUsageMetrics = {}
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'cost', 'totalNanoAiu', 'requestCount'] as const) {
    const value = source[key]
    if (value !== undefined) result[key] = value
  }
  return result
}

export function attachModelUsage(
  session: Pick<CopilotSession, 'sessionId' | 'on'>,
  callback: (observation: ModelUsageObservation) => void | Promise<void>,
  context: ModelUsageContext | (() => ModelUsageContext),
): ModelUsageObserver {
  const seen = new Set<string>()
  const failures: unknown[] = []
  let pending = Promise.resolve()
  let disposed = false

  const unsubscribe = session.on((event) => {
    if (disposed || (event.type !== 'assistant.usage' && event.type !== 'session.shutdown')) return
    if (seen.has(event.id)) return
    try {
      const raw = structuredClone(event)
      const attribution = structuredClone(typeof context === 'function' ? context() : context)
      const body: ModelUsageObservation['body'] = raw.type === 'assistant.usage'
        ? {
          sourceEventType: raw.type,
          counting: 'incremental',
          aggregation: 'authoritative',
          metrics: metrics({ ...raw.data, totalNanoAiu: raw.data.copilotUsage?.totalNanoAiu }),
          raw,
        }
        : {
          sourceEventType: raw.type,
          counting: 'cumulative',
          aggregation: 'reference-only',
          metrics: metrics({ totalNanoAiu: raw.data.totalNanoAiu }),
          modelMetrics: Object.fromEntries(Object.entries(raw.data.modelMetrics).flatMap(([model, metric]) => metric === undefined ? [] : [[model, metrics({
            ...metric.usage,
            cost: metric.requests.cost,
            requestCount: metric.requests.count,
            totalNanoAiu: metric.totalNanoAiu,
          })]])),
          raw,
        }
      const model = raw.type === 'assistant.usage' ? raw.data.model : raw.data.currentModel
      const observation: ModelUsageObservation = {
        ...attribution,
        ...(model === undefined ? {} : { model }),
        sessionId: session.sessionId,
        sourceEventId: raw.id,
        observedAt: new Date().toISOString(),
        bodyVersion: 1,
        body,
      }
      seen.add(raw.id)
      pending = pending.then(() => callback(observation)).catch((error: unknown) => { failures.push(error) })
    } catch (error) {
      failures.push(error)
    }
  })

  return {
    async flush() {
      let barrier: Promise<void>
      do {
        barrier = pending
        await barrier
      } while (barrier !== pending)
      if (failures.length) throw new AggregateError(failures.splice(0), 'Model usage observation failed')
    },
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribe()
    },
  }
}