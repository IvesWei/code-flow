import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export async function agentFileAccess(workspace: string, path: string, mode: 'read' | 'write', attachments: string[] = []): Promise<boolean> {
  try {
    const root = await realpath(workspace)
    const target = resolve(root, path)
    const local = relative(root, target)
    if (mode === 'read' && attachments.some(file => resolve(file) === target)) return !(await lstat(target)).isSymbolicLink() && await realpath(target) === target
    if (isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`)) return false
    if (local.split(sep).some(part => /^\.env(?:\..*)?$/i.test(part) && part !== '.env.example' || /^(?:id_rsa|id_ed25519|credentials)$/i.test(part) || mode === 'write' && part === '.git')) return false
    let existing = target
    for (;;) {
      try {
        const stat = await lstat(existing)
        if (stat.isSymbolicLink() || await realpath(existing) !== existing) return false
        return existing === target ? mode === 'read' || stat.isFile() : mode === 'write' && stat.isDirectory()
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || mode === 'read') return false
        const parent = dirname(existing)
        if (parent === existing) return false
        existing = parent
      }
    }
  } catch { return false }
}
