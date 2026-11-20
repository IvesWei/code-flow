export const requirementPreviewTestOrigins: readonly string[] = ['https://tmp.test.sunmi.com']

export function requirementPreviewOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 200) throw new Error('Invalid preview origin')
  const url = new URL(value)
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  const authorizedTest = requirementPreviewTestOrigins.includes(url.origin)
  if (!['http:', 'https:'].includes(url.protocol) || (!local && !authorizedTest) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Preview must be a loopback or authorized test origin without credentials or paths')
  return url.origin
}
export function requirementPreviewPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 800 || value.includes('..')) throw new Error('Invalid preview path')
  const [path, query, extra] = value.split('?')
  if (!/^\/(?!\/)[a-zA-Z0-9_\-/]*$/.test(path) || extra !== undefined || query === '') throw new Error('Invalid preview path')
  if (query !== undefined) {
    const entries = [...new URLSearchParams(query)]
    const keys = new Set<string>()
    if (!entries.length || entries.length > 8 || /[^\w.%=&-]/.test(query)) throw new Error('Invalid preview query')
    for (const [key, item] of entries) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || /token|secret|password|credential|session|cookie|authorization|^(?:auth|api_?key|access_?key|private_?key|jwt|signature|code|redirect.*|return.*|next|url|callback)$/i.test(key) || /^(?:delete|remove|save|submit|create|update|execute|action)$/i.test(key) || !/^[A-Za-z0-9_.-]{1,120}$/.test(item) || keys.has(key)) throw new Error('Invalid preview query')
      keys.add(key)
    }
  }
  return value
}
export function requirementPreviewEntry(value: unknown, origin: string): string {
  if (typeof value !== 'string' || value.length > 1000 || value.trim() !== value) throw new Error('Invalid preview entry')
  if (value.startsWith('/')) return requirementPreviewPath(value)
  const url = new URL(value)
  if (url.origin !== origin || url.username || url.password || url.hash) throw new Error('Preview entry must stay within the configured origin')
  const rawPath = /^https?:\/\/[^/]+(\/.*)$/i.exec(value)?.[1]
  if (rawPath !== url.pathname + url.search) throw new Error('Preview entry must be an unambiguous concrete path')
  return requirementPreviewPath(rawPath)
}