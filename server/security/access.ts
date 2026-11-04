import type { CodingTask } from '../../shared/task.js'

export function allowedWorkbenchOrigin(origin: string | undefined, configuredOrigins = process.env.WORKBENCH_ORIGINS): boolean {
  if (!origin) return true
  try {
    const url = new URL(origin)
    if (url.origin !== origin || url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return false
    if (configuredOrigins !== undefined) return configuredOrigins.split(',').map((value) => value.trim()).includes(origin)
    const port = Number(url.port)
    return port >= 5173 && port <= 5199
  } catch {
    return false
  }
}

export function ownsTask(task: CodingTask, ownerId: number | undefined): boolean {
  return ownerId !== undefined && task.ownerId === ownerId
}