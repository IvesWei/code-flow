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
  if (typeof value !== 'string' || value.length > 300 || !/^\/(?!\/)[a-zA-Z0-9_\-/]*$/.test(value) || value.includes('..')) throw new Error('Invalid preview path')
  return value
}