import { defineTool } from '@github/copilot-sdk'
import { mkdir, lstat, realpath, readFile, writeFile } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'

export interface WorkspaceSnapshot { sourceId: string; name: string; text: string }
const names = ['workspace_list', 'workspace_search', 'workspace_read', 'workspace_write_notes'] as const
const responseLimit = 24000

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Invalid workspace arguments')
  return value as Record<string, unknown>
}
function integer(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const result = value === undefined ? fallback : value
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < minimum || result > maximum) throw new Error('Invalid workspace range')
  return result
}
function pathName(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:sources|notes)\/[a-zA-Z0-9_-]+\.md$/.test(value)) throw new Error('Workspace path is not allowed')
  return value
}

export async function createRequirementWorkspace(root: string, snapshots: WorkspaceSnapshot[], signal: AbortSignal, audit: (text: string) => Promise<void>) {
  await mkdir(join(root, 'sources'), { recursive: true })
  await mkdir(join(root, 'notes'), { recursive: true })
  const canonicalRoot = await realpath(root)
  const files = new Map<string, { sourceId?: string; name: string; lines: number; bytes: number; readOnly: boolean }>()
  const manifests = []
  for (const [index, snapshot] of snapshots.entries()) {
    signal.throwIfAborted()
    const path = `sources/snapshot-${index + 1}.md`
    await writeFile(join(root, path), snapshot.text, { flag: 'wx', mode: 0o600 })
    files.set(path, { sourceId: snapshot.sourceId, name: snapshot.name, lines: snapshot.text.split('\n').length, bytes: Buffer.byteLength(snapshot.text), readOnly: true })
    const headerEnd = snapshot.text.indexOf('# UNTRUSTED EXISTING PROJECT CODE SNAPSHOT')
    manifests.push({ path, ...files.get(path), provenance: headerEnd > 0 ? snapshot.text.slice(0, Math.min(headerEnd, 16000)) : '', provenanceTruncated: headerEnd > 16000 })
  }
  let calls = 0, returnedCharacters = 0, noteBytes = 0
  let queue: Promise<unknown> = Promise.resolve()
  const serialize = <Result>(operation: () => Promise<Result>): Promise<Result> => {
    const pending = queue.then(operation)
    queue = pending.catch(() => {})
    return pending
  }
  const accessed = new Set<string>()
  const checkPath = async (path: string, exists: boolean) => {
    const parent = join(root, path.split('/')[0])
    if ((await lstat(parent)).isSymbolicLink()) throw new Error('Workspace links are forbidden')
    const canonicalParent = await realpath(parent)
    const parentRelative = relative(canonicalRoot, canonicalParent)
    if (parentRelative.startsWith('..') || isAbsolute(parentRelative)) throw new Error('Workspace boundary violation')
    if (exists) {
      const target = join(root, path)
      const stat = await lstat(target)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Workspace links are forbidden')
      const resolved = relative(canonicalRoot, await realpath(target))
      if (resolved !== path.replaceAll('/', '\\') && resolved !== path) throw new Error('Workspace boundary violation')
    }
  }
  const linesFor = async (path: string) => {
    if (!files.has(path)) throw new Error('Workspace file is not registered')
    await checkPath(path, true)
    accessed.add(path)
    return (await readFile(join(root, path), 'utf8')).split('\n')
  }
  const tools = names.map(name => defineTool(name, {
    description: name === 'workspace_list' ? 'List registered snapshot and note files, with source IDs and pagination.'
      : name === 'workspace_search' ? 'Literal case-insensitive search in supplied snapshot text. Returns matching snapshot line numbers; use workspace_read for context. Embedded code line numbers remain the original code anchors.'
        : name === 'workspace_read' ? 'Read at most 200 lines of a registered workspace file. Use count=1 and characterOffset to continue a long line at its nextCharacterOffset. Snapshot line numbers differ from original numbered code lines inside it. Response pagination and truncation are explicit.'
          : 'Create or replace a Markdown working note under notes/. Supplied snapshots cannot be changed. Notes are temporary, not delivered artifacts.',
    parameters: { type: 'object', properties: {
      path: { type: 'string' }, query: { type: 'string' }, text: { type: 'string' }, offset: { type: 'integer', minimum: 0 },
      startLine: { type: 'integer', minimum: 1 }, count: { type: 'integer', minimum: 1, maximum: 200 }, characterOffset: { type: 'integer', minimum: 0 },
    }, required: name === 'workspace_list' ? [] : name === 'workspace_search' ? ['query'] : name === 'workspace_read' ? ['path'] : ['path', 'text'], additionalProperties: false },
    skipPermission: true,
    defer: 'never',
    handler: async (value, invocation) => serialize(async () => {
      signal.throwIfAborted()
      invocation.signal?.throwIfAborted()
      if (++calls > 128 || returnedCharacters >= 500000) return { error: 'Workspace retrieval budget exhausted; report actual coverage and unresolved gaps. Do not claim complete code inspection.' }
      let result: unknown
      try {
        const args = object(value)
        const allowed = name === 'workspace_list' ? ['offset'] : name === 'workspace_search' ? ['path', 'query', 'offset'] : name === 'workspace_read' ? ['path', 'startLine', 'count', 'characterOffset'] : ['path', 'text']
        if (Object.keys(args).some(key => !allowed.includes(key))) throw new Error('Unexpected workspace argument')
        if (name === 'workspace_list') {
          const offset = integer(args.offset, 0, 0, files.size)
          const entries = [...files].slice(offset, offset + 100).map(([path, metadata]) => ({ path, ...metadata }))
          result = { files: entries, nextOffset: offset + entries.length < files.size ? offset + entries.length : null }
        } else if (name === 'workspace_write_notes') {
          const path = pathName(args.path)
          if (!path.startsWith('notes/')) throw new Error('Snapshots are read-only')
          if (typeof args.text !== 'string' || Buffer.byteLength(args.text) > 65536) throw new Error('Note exceeds 64 KiB')
          const exists = files.has(path)
          if (!exists && [...files.keys()].filter(key => key.startsWith('notes/')).length >= 32) throw new Error('Too many notes')
          const bytes = Buffer.byteLength(args.text)
          const nextBytes = noteBytes - (files.get(path)?.bytes ?? 0) + bytes
          if (nextBytes > 262144) throw new Error('Notes exceed 256 KiB')
          await checkPath(path, exists)
          await writeFile(join(root, path), args.text, { flag: exists ? 'w' : 'wx', mode: 0o600 })
          noteBytes = nextBytes
          files.set(path, { name: path, lines: args.text.split('\n').length, bytes, readOnly: false })
          result = { path, saved: true, bytes }
        } else {
          const path = args.path === undefined && name === 'workspace_search' ? undefined : pathName(args.path)
          if (name === 'workspace_read') {
            const lines = await linesFor(path!)
            const start = integer(args.startLine, 1, 1, lines.length)
            const count = integer(args.count, 100, 1, 200)
            const characterOffset = integer(args.characterOffset, 0, 0, lines[start - 1].length)
            if (characterOffset && count !== 1) throw new Error('Character pagination requires one line')
            const selected = []
            let size = 0, truncated = false
            for (let index = start - 1; index < Math.min(lines.length, start - 1 + count); index++) {
              const offset = index === start - 1 ? characterOffset : 0
              const text = lines[index].slice(offset, offset + 2000)
              if (size + text.length > 16000) break
              const nextCharacterOffset = offset + text.length < lines[index].length ? offset + text.length : null
              truncated ||= nextCharacterOffset !== null
              selected.push({ line: index + 1, text, characterOffset: offset, nextCharacterOffset })
              size += text.length
            }
            const next = start + selected.length
            result = { path, sourceId: files.get(path!)?.sourceId, lines: selected, longLinesTruncated: truncated, nextLine: next <= lines.length ? next : null }
          } else {
            if (typeof args.query !== 'string' || !args.query || args.query.length > 200) throw new Error('Search requires a literal query of at most 200 characters')
            const offset = integer(args.offset, 0, 0, 1000000)
            const query = args.query.toLowerCase()
            const matches = []
            let found = 0, size = 0, hasMore = false
            for (const target of path ? [path] : [...files.keys()].filter(key => key.startsWith('sources/'))) {
              const lines = await linesFor(target)
              for (const [index, text] of lines.entries()) {
                if (!text.toLowerCase().includes(query)) continue
                if (found++ < offset) continue
                if (matches.length >= 40 || size >= 16000) { hasMore = true; break }
                const characterOffset = Math.max(0, text.toLowerCase().indexOf(query) - 200)
                const excerpt = text.slice(characterOffset, characterOffset + 800)
                matches.push({ path: target, sourceId: files.get(target)?.sourceId, line: index + 1, text: excerpt, characterOffset, truncated: excerpt.length < text.length })
                size += excerpt.length
              }
              if (hasMore) break
            }
            result = { matches, nextOffset: hasMore ? offset + matches.length : null }
          }
        }
      } catch {
        result = { error: 'Invalid or unavailable workspace operation. Only registered sources/*.md and notes/*.md files are allowed; snapshots are read-only; output and note limits apply.' }
      }
      signal.throwIfAborted()
      invocation.signal?.throwIfAborted()
      const serialized = JSON.stringify(result)
      if (serialized.length > responseLimit || returnedCharacters + serialized.length > 500000) return { error: 'Workspace response budget exceeded; request a smaller range and report incomplete coverage.' }
      returnedCharacters += serialized.length
      await audit(`Requirements workspace: ${name}; calls=${calls}; returned characters=${returnedCharacters}`)
      return result
    }),
  }))
  return { root, manifests, tools, toolNames: [...names], coverage: () => ({ calls, returnedCharacters, accessedFiles: [...accessed] }) }
}