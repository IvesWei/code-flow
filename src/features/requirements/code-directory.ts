import { codeFileAllowed, codeSnapshotLimits } from '../../../shared/requirement-code'

export type DirectoryFile = Pick<File, 'webkitRelativePath' | 'size' | 'text'>
export type CodeSelection = {
  files: { path: string; file: DirectoryFile }[]
  excluded: number
  error: string
}

export function codeRelativePath(path: string): string | undefined {
  if (!path || path.includes('\\') || path.includes(':') || Array.from(path).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return
  const parts = path.split('/')
  if (parts.length < 2 || parts.some(part => !part || part === '.' || part === '..')) return
  return parts.slice(1).join('/')
}

export function selectCodeFiles(files: readonly DirectoryFile[]): CodeSelection {
  const selection: CodeSelection = { files: [], excluded: 0, error: '' }
  const paths = new Set<string>()
  let totalBytes = 0
  for (const file of files) {
    const path = codeRelativePath(file.webkitRelativePath)
    if (!path || !codeFileAllowed(path)) { selection.excluded++; continue }
    selection.files.push({ path, file })
    if (paths.has(path)) selection.error ||= `代码路径重复：${path}`
    paths.add(path)
    totalBytes += file.size
    if (file.size > codeSnapshotLimits.fileBytes) selection.error ||= `文件超限：${path}，单文件最多 ${codeSnapshotLimits.fileBytes} 字节`
  }
  if (selection.files.length > codeSnapshotLimits.files) selection.error ||= `候选文件超限：最多 ${codeSnapshotLimits.files} 个文件`
  if (totalBytes > codeSnapshotLimits.totalBytes) selection.error ||= `代码总大小超限：最多 ${codeSnapshotLimits.totalBytes} 字节`
  return selection
}

export async function readCodeSnapshot(selection: CodeSelection, signal: AbortSignal): Promise<{ path: string; content: string }[]> {
  signal.throwIfAborted()
  if (selection.error) throw new Error(selection.error)
  if (!selection.files.length) throw new Error('没有可添加的代码文件')
  const encoder = new TextEncoder()
  const files: { path: string; content: string }[] = []
  let totalBytes = 0
  for (const candidate of selection.files) {
    signal.throwIfAborted()
    let content: string
    try { content = await candidate.file.text() }
    catch { signal.throwIfAborted(); throw new Error(`无法读取代码文件：${candidate.path}`) }
    signal.throwIfAborted()
    const bytes = encoder.encode(content).byteLength
    if (bytes > codeSnapshotLimits.fileBytes) throw new Error(`文件 UTF-8 大小超限：${candidate.path}，单文件最多 ${codeSnapshotLimits.fileBytes} 字节`)
    totalBytes += bytes
    if (totalBytes > codeSnapshotLimits.totalBytes) throw new Error(`代码 UTF-8 总大小超限：最多 ${codeSnapshotLimits.totalBytes} 字节`)
    files.push({ path: candidate.path, content })
  }
  return files
}