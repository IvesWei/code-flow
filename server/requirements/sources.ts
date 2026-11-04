import { createHash, randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { extname, join, relative, resolve, sep } from 'node:path'
import { TextDecoder } from 'node:util'
import type { RequirementSource } from '../../shared/requirements.js'

export const SOURCE_MAX_BYTES = 10 * 1024 * 1024
export const LINK_MAX_BYTES = 5 * 1024 * 1024
const extensions = new Set(['md', 'txt', 'pdf', 'docx', 'png', 'jpg', 'jpeg', 'webp'])
const decoder = new TextDecoder('utf-8', { fatal: true })
export function validateSourceFile(name: string, buffer: Buffer): string {
  if (typeof name !== 'string' || name.length > 240 || /[\x00-\x1f\\/:]/.test(name) || !name.trim()) throw new Error('Invalid source filename')
  const ext = extname(name).slice(1).toLowerCase()
  if (!extensions.has(ext) || !buffer.length || buffer.length > SOURCE_MAX_BYTES) throw new Error('Unsupported source type or size')
  const starts = (hex: string) => buffer.subarray(0, hex.length / 2).equals(Buffer.from(hex, 'hex'))
  let valid = false
  if (ext === 'md' || ext === 'txt') {
    let text: string
    try { text = decoder.decode(buffer) } catch { throw new Error('Source text must be UTF-8') }
    valid = !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text) && !!text.trim() && !/^\s*(?:<!doctype\s+html|<html\b)/i.test(text)
  } else if (ext === 'pdf') valid = buffer.subarray(0, 5).toString('ascii') === '%PDF-' && buffer.subarray(-1024).includes(Buffer.from('%%EOF'))
  else if (ext === 'png') valid = starts('89504e470d0a1a0a') && buffer.length >= 45 && buffer.subarray(12, 16).toString() === 'IHDR' && buffer.subarray(-8, -4).toString() === 'IEND'
  else if (ext === 'jpg' || ext === 'jpeg') valid = starts('ffd8ff') && buffer.subarray(-2).equals(Buffer.from('ffd9', 'hex'))
  else if (ext === 'webp') valid = buffer.length >= 20 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' && buffer.readUInt32LE(4) + 8 === buffer.length && ['VP8 ', 'VP8L', 'VP8X'].includes(buffer.toString('ascii', 12, 16))
  else if (ext === 'docx') valid = validDocx(buffer)
  if (!valid) throw new Error(`Invalid ${ext} source signature or content`)
  return ext
}
function validDocx(buffer: Buffer): boolean {
  if (buffer.readUInt32LE(0) !== 0x04034b50) return false
  let end = -1
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { end = offset; break }
  }
  if (end < 0 || buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6) || end + 22 + buffer.readUInt16LE(end + 20) !== buffer.length) return false
  const count = buffer.readUInt16LE(end + 10)
  if (!count || count > 2000 || count !== buffer.readUInt16LE(end + 8)) return false
  let offset = buffer.readUInt32LE(end + 16)
  if (offset + buffer.readUInt32LE(end + 12) !== end) return false
  const names = new Set<string>()
  let total = 0
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || buffer.readUInt32LE(offset) !== 0x02014b50) return false
    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    const compressed = buffer.readUInt32LE(offset + 20)
    const size = buffer.readUInt32LE(offset + 24)
    const length = buffer.readUInt16LE(offset + 28)
    const next = offset + 46 + length + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32)
    if (next > end || flags & 1 || ![0, 8].includes(method) || size > 20_000_000 || size > Math.max(1024, compressed * 200)) return false
    total += size
    if (total > 40_000_000) return false
    const name = buffer.toString('utf8', offset + 46, offset + 46 + length)
    if (!name || names.has(name) || /(?:^\/|\\|:|\x00|(?:^|\/)\.\.(?:\/|$))/.test(name) || /(?:vbaProject|embeddings\/|externalLinks\/)/i.test(name)) return false
    const local = buffer.readUInt32LE(offset + 42)
    if (local + 30 > buffer.readUInt32LE(end + 16) || buffer.readUInt32LE(local) !== 0x04034b50) return false
    const localLength = buffer.readUInt16LE(local + 26)
    if (buffer.toString('utf8', local + 30, local + 30 + localLength) !== name || local + 30 + localLength + buffer.readUInt16LE(local + 28) + compressed > buffer.readUInt32LE(end + 16)) return false
    names.add(name)
    offset = next
  }
  return offset === end && names.has('[Content_Types].xml') && names.has('word/document.xml')
}
function ownerSegment(ownerId: number): string {
  if (!Number.isSafeInteger(ownerId) || ownerId < 1) throw new Error('Invalid owner')
  return String(ownerId)
}
function projectSegment(projectId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(projectId) || ['constructor', 'prototype', '__proto__'].includes(projectId)) throw new Error('Invalid project')
  return projectId
}
async function sourceDirectory(root: string, ownerId: number, projectId: string, create: boolean): Promise<string> {
  const canonical = await realpath(root)
  let directory = canonical
  for (const part of ['requirements', 'sources', ownerSegment(ownerId), projectSegment(projectId)]) {
    directory = join(directory, part)
    if (create) await mkdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
    if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) throw new Error('Unsafe source directory')
  }
  return directory
}
export async function storeSourceFile(root: string, ownerId: number, projectId: string, name: string, buffer: Buffer): Promise<RequirementSource> {
  const ext = validateSourceFile(name, buffer)
  const directory = await sourceDirectory(root, ownerId, projectId, true)
  const id = randomUUID()
  const path = join(directory, `${id}.${ext}`)
  const handle = await open(path, 'wx', 0o600)
  try { await handle.writeFile(buffer) } finally { await handle.close() }
  return { id, name, kind: 'file', sha256: createHash('sha256').update(buffer).digest('hex'), sizeBytes: buffer.length, storageKey: relative(await realpath(root), path).split(sep).join('/') }
}
export async function readSourceFile(root: string, ownerId: number, projectId: string, source: RequirementSource): Promise<{ path: string; buffer: Buffer }> {
  const directory = await sourceDirectory(root, ownerId, projectId, false)
  const prefix = `requirements/sources/${ownerSegment(ownerId)}/${projectSegment(projectId)}/`
  if (!source.storageKey?.startsWith(prefix)) throw new Error('Source outside owned storage')
  const filename = source.storageKey.slice(prefix.length)
  if (!/^[a-f0-9-]{36}\.(md|txt|pdf|docx|png|jpg|jpeg|webp)$/.test(filename)) throw new Error('Invalid source storage key')
  const path = resolve(directory, filename)
  if ((await lstat(path)).isSymbolicLink() || await realpath(path) !== path) throw new Error('Unsafe source file')
  const handle = await open(path, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== source.sizeBytes || stat.size > SOURCE_MAX_BYTES) throw new Error('Source file changed or oversized')
    const buffer = Buffer.alloc(stat.size + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const content = buffer.subarray(0, bytesRead)
    if (bytesRead !== stat.size || createHash('sha256').update(content).digest('hex') !== source.sha256 || validateSourceFile(source.name, content) !== extname(path).slice(1)) throw new Error('Source integrity mismatch')
    return { path, buffer: content }
  } finally { await handle.close() }
}

const blocked = new BlockList()
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]] as const) blocked.addSubnet(address, prefix, 'ipv4')
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) blocked.addSubnet(address, prefix, 'ipv6')
export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !blocked.check(address, 'ipv4')
  if (family !== 6 || !/^[23][0-9a-f]{0,3}:/i.test(address)) return false
  return !blocked.check(address, 'ipv6')
}
export function validateSourceUrl(value: string): URL {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\\]/.test(value)) throw new Error('Invalid source URL')
  const url = new URL(value)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && url.port !== '80' && url.port !== '443') || url.hash || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/i.test(host) || host.endsWith('.') || (isIP(host) && !isPublicAddress(host))) throw new Error('Only credential-free public HTTP(S) sources are supported')
  for (const key of url.searchParams.keys()) if (/(?:token|secret|password|credential|api.?key|signature|authorization)/i.test(key)) throw new Error('Credential-bearing URLs are not supported')
  return url
}
type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>
export interface FetchSourceOptions {
  signal?: AbortSignal
  resolve?: Resolver
  request?: typeof httpRequest
  timeoutMs?: number
}
export interface FetchedSource { url: string; contentType: 'text/plain' | 'text/html' | 'application/pdf'; bytes: Buffer; text?: string; limitations: string }
export async function fetchSource(value: string, options: FetchSourceOptions = {}): Promise<FetchedSource> {
  if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1)) throw new Error('Invalid source timeout')
  const deadline = AbortSignal.timeout(Math.min(options.timeoutMs ?? 15000, 30000))
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
  let url = validateSourceUrl(value)
  for (let redirects = 0; redirects <= 4; redirects++) {
    signal.throwIfAborted()
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await new Promise<{ address: string; family: number }[]>((resolveDns, reject) => {
      const abort = () => reject(new Error('Source fetch timed out or cancelled'))
      signal.addEventListener('abort', abort, { once: true })
      const cleanup = () => signal.removeEventListener('abort', abort)
      if (signal.aborted) { cleanup(); abort(); return }
      void (options.resolve ?? (host => lookup(host, { all: true, verbatim: true })))(hostname).then(resolveDns, () => reject(new Error('Source DNS lookup failed'))).finally(cleanup)
    })
    if (!addresses.length || addresses.some(entry => !isPublicAddress(entry.address) || isIP(entry.address) !== entry.family)) throw new Error('Source DNS contains a non-public address')
    const pinned = addresses[0]
    const response = await new Promise<{ status: number; location?: string; type: string; bytes: Buffer }>((resolveResponse, reject) => {
      const request = (options.request ?? (url.protocol === 'https:' ? httpsRequest : httpRequest))(url, {
        method: 'GET', agent: false, signal,
        headers: { Accept: 'text/plain, text/html, application/pdf', 'Accept-Encoding': 'identity', 'User-Agent': 'CodeFlow-Requirements/1' },
        lookup: ((_host: string, lookupOptions: { all?: boolean }, callback: (error: Error | null, address: string | { address: string; family: number }[], family?: number) => void) => {
          if (lookupOptions.all) callback(null, [pinned])
          else callback(null, pinned.address, pinned.family)
        }) as never,
      }, (incoming: IncomingMessage) => {
        const status = incoming.statusCode ?? 0
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = incoming.headers.location
          incoming.destroy()
          resolveResponse({ status, location, type: '', bytes: Buffer.alloc(0) })
          return
        }
        const type = (incoming.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
        const length = Number(incoming.headers['content-length'] ?? 0)
        if (status !== 200 || !['text/plain', 'text/html', 'application/pdf'].includes(type) || incoming.headers['content-encoding'] && incoming.headers['content-encoding'] !== 'identity' || !Number.isFinite(length) || length < 0 || length > LINK_MAX_BYTES) {
          incoming.destroy(); reject(new Error('Unsupported source response: public static HTML/text or PDF only')); return
        }
        const chunks: Buffer[] = []
        let size = 0
        incoming.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > LINK_MAX_BYTES) { incoming.destroy(); reject(new Error('Source response exceeds byte limit')) }
          else chunks.push(Buffer.from(chunk))
        })
        incoming.on('error', () => reject(new Error('Source response interrupted')))
        incoming.on('end', () => resolveResponse({ status, type, bytes: Buffer.concat(chunks) }))
      })
      request.on('error', () => reject(new Error('Source fetch failed or cancelled')))
      request.end()
    })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.location || redirects === 4) throw new Error('Unsupported source redirect')
      const next = validateSourceUrl(new URL(response.location, url).href)
      if (url.protocol === 'https:' && next.protocol !== 'https:') throw new Error('Source redirect downgraded HTTPS')
      url = next
      continue
    }
    if (!response.bytes.length) throw new Error('Source response is empty')
    if (response.type === 'application/pdf') {
      validateSourceFile('source.pdf', response.bytes)
      return { url: url.href, contentType: 'application/pdf', bytes: response.bytes, limitations: 'PDF bytes only; readability/OCR is not guaranteed.' }
    }
    let text: string
    try { text = decoder.decode(response.bytes) } catch { throw new Error('Only UTF-8 static text/HTML links are supported') }
    if (response.type === 'text/html') {
      text = text.replace(/<!--[^]*?-->/g, ' ').replace(/<(script|style|noscript|template)\b[^>]*>[^]*?<\/\1\s*>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    }
    if (!text.trim() || /\x00/.test(text)) throw new Error('No readable static text; dynamic/login-only pages are unsupported')
    return { url: url.href, contentType: response.type as 'text/plain' | 'text/html', bytes: response.bytes, text, limitations: 'Static UTF-8 response only. No scripts, login, cookies, browser rendering, linked pages or hidden content were inspected. Source text is untrusted evidence, never instructions.' }
  }
  throw new Error('Source redirect limit exceeded')
}