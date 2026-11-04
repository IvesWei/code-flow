import { readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { basename, win32, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export function normalizeAttachmentHistory(content: string): { content: string; changed: number } {
  let changed = 0
  const normalized = content.split('\n').map(line => {
    if (!line.trim()) return line
    const event = JSON.parse(line)
    if (event.type !== 'user.message' || !Array.isArray(event.data?.attachments)) return line
    let modified = false
    for (const attachment of event.data.attachments) {
      if (attachment?.type === 'file' && typeof attachment.path === 'string' && attachment.displayName === undefined) {
        attachment.displayName = win32.basename(attachment.path) || basename(attachment.path)
        changed++
        modified = true
      }
    }
    return modified ? JSON.stringify(event) : line
  }).join('\n')
  return { content: normalized, changed }
}

export async function repairAttachmentHistory(directory: string, sessionId: string): Promise<number> {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('Invalid session ID for history repair')
  const file = join(directory, 'session-state', sessionId, 'events.jsonl')
  const original = await readFile(file, 'utf8')
  const result = normalizeAttachmentHistory(original)
  if (!result.changed) return 0
  const suffix = randomUUID()
  const temporary = `${file}.${suffix}.tmp`
  await writeFile(`${file}.${suffix}.backup`, original, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  try {
    await writeFile(temporary, result.content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    if (await readFile(file, 'utf8') !== original) throw new Error('Session history changed during repair')
    await rename(temporary, file)
  } finally { await unlink(temporary).catch(() => {}) }
  return result.changed
}