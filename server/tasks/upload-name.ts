const utf8 = new TextDecoder('utf-8', { fatal: true })

export function uploadName(name: string): string {
  if (!/[\u0080-\u00ff]/.test(name)) return name
  try {
    const bytes = Buffer.from(name, 'latin1')
    if (bytes.toString('latin1') !== name) return name
    return utf8.decode(bytes)
  } catch {
    return name
  }
}