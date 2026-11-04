import { stripVTControlCharacters } from 'node:util'

function safeText(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/(gh[opusr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|ghu_[A-Za-z0-9_]+)/gi, '[REDACTED]')
    .replace(/(Bearer\s+)\S+/gi, '$1[REDACTED]')
    .replace(/((?:client_secret|GITHUB_CLIENT_SECRET|password|api[_-]?key|access[_-]?token)\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[REDACTED]')
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, 'https://[REDACTED]@')
    .replace(/[^\s"']*oauth\.local\.json/gi, '[private config]')
    .slice(0, 8000)
}

export function toolArguments(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const argumentsRecord = value as Record<string, unknown>
  const fields = ['command', 'cmd', 'input', 'code', 'description', 'explanation', 'filePath', 'file_path', 'path', 'query', 'pattern']
  const lines = fields.flatMap((field) => typeof argumentsRecord[field] === 'string' ? [`${field}: ${argumentsRecord[field]}`] : [])
  return lines.length ? safeText(lines.join('\n')) : undefined
}

export function toolOutput(value: string | undefined): string | undefined {
  return value ? safeText(value) : undefined
}