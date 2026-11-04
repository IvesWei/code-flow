import { realpath, lstat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export async function canWriteTestFile(workspace: string, fileName: string, allowedExisting: string[] = []): Promise<boolean> {
  if (!/\.(test|spec)\.[a-z0-9]+$/i.test(fileName)) return false
  const root = await realpath(workspace)
  const target = resolve(root, fileName)
  const inside = relative(root, target)
  if (!inside || isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`) || inside.split(sep).some((part) => ['.git', 'node_modules', '.env'].includes(part))) return false
  let existing = target
  while (true) {
    try {
      const stat = await lstat(existing)
      if (stat.isSymbolicLink() || await realpath(existing) !== existing) return false
      return existing === target ? stat.isFile() && allowedExisting.some((path) => resolve(root, path) === target) : stat.isDirectory()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
      const parent = dirname(existing)
      if (parent === existing) return false
      existing = parent
    }
  }
}