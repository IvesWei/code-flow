export function startupErrorCode(error: unknown): string {
  let current = error
  for (let depth = 0; depth < 4; depth++) {
    if (!current || typeof current !== 'object') break
    if ('code' in current && typeof current.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(current.code)) return current.code
    current = 'cause' in current ? current.cause : undefined
  }
  return 'UNKNOWN'
}

export class StartupDiagnostics {
  constructor(private readonly output: (message: string) => void = console.log, private readonly warningAfterMs = 30_000) {}

  begin(stage: string): { complete: () => void; fail: (error: unknown) => void } {
    const started = Date.now()
    let finished = false
    this.output(`[startup] ${stage} 开始`)
    const timer = setTimeout(() => {
      this.output(`[startup] ${stage} 等待超过 ${this.warningAfterMs}ms，尚未完成；未自动取消或重试`)
    }, this.warningAfterMs)
    timer.unref()
    const finish = (result: string) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      this.output(`[startup] ${stage} ${result}，耗时 ${Date.now() - started}ms`)
    }
    return { complete: () => finish('完成'), fail: (error) => finish(`失败，错误代码：${startupErrorCode(error)}`) }
  }

  async run<T>(stage: string, action: () => T | Promise<T>): Promise<T> {
    const progress = this.begin(stage)
    try {
      const result = await action()
      progress.complete()
      return result
    } catch (error) {
      progress.fail(error)
      throw error
    }
  }
}