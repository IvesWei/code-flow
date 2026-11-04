export interface ModelTimeouts {
  firstResponseMs: number
  inactivityMs: number
}

function milliseconds(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const value = env[key]
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 10_000 || parsed > 3_600_000) throw new Error(`${key} 必须是 10000 至 3600000 的整数（毫秒）`)
  return parsed
}

export function modelTimeouts(inactivityMs: number, env: NodeJS.ProcessEnv = process.env): ModelTimeouts {
  return {
    firstResponseMs: milliseconds(env, 'MODEL_FIRST_RESPONSE_TIMEOUT_MS', Math.max(600_000, inactivityMs)),
    inactivityMs: milliseconds(env, 'MODEL_INACTIVITY_TIMEOUT_MS', Math.max(300_000, inactivityMs)),
  }
}