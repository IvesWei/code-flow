import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import type { PlanningProject, PlanningQuestion } from '../../shared/testing.js'

export async function recoverPlanningQuestion(root: string, project: PlanningProject): Promise<PlanningQuestion | undefined> {
  if (project.question || project.status !== 'failed' || !project.error?.startsWith('Planning requires clarification.')) return undefined
  const started = project.events.findLast(event => /^planning:generation:/.test(event.text))?.at
  if (!started || !Number.isFinite(Date.parse(started))) return undefined
  const canonical = await realpath(root)
  const safe = async (path: string) => {
    try {
      const local = relative(canonical, await realpath(path))
      return !(await lstat(path)).isSymbolicLink() && !isAbsolute(local) && !local.split(/[\\/]/).includes('..')
    } catch { return false }
  }
  const newestDirectories = async (parent: string, limit: number) => {
    const entries = (await readdir(parent, { withFileTypes: true })).filter(item => item.isDirectory() && /^[a-f0-9-]{36}$/i.test(item.name))
    const dated = await Promise.all(entries.map(async entry => ({ name: entry.name, modified: await lstat(join(parent, entry.name)).then(info => info.mtimeMs, () => 0) })))
    return dated.sort((left, right) => right.modified - left.modified || left.name.localeCompare(right.name)).slice(0, limit)
  }
  const directory = join(canonical, 'testing', 'planning', project.id, 'sessions')
  try {
    for (let path = canonical, parts = ['testing', 'planning', project.id, 'sessions']; parts.length;) {
      path = join(path, parts.shift()!)
      if (!await safe(path)) return undefined
    }
    let result: PlanningQuestion | undefined
    let inspected = 0
    for (const session of await newestDirectories(directory, 20)) {
      const sessionPath = join(directory, session.name)
      const states = join(sessionPath, 'session-state')
      if (!await safe(sessionPath) || !await safe(states)) continue
      for (const state of await newestDirectories(states, 10)) {
        if (++inspected > 30) return result
        const statePath = join(states, state.name), file = join(statePath, 'events.jsonl')
        if (!await safe(statePath) || !await safe(file)) continue
        const info = await lstat(file)
        if (!info.isFile() || info.size > 16 * 1024 * 1024) continue
        for (const line of (await readFile(file, 'utf8')).split('\n')) {
          let event: { type?: string; timestamp?: string; data?: { toolName?: string; arguments?: { question?: unknown; choices?: unknown; allowFreeform?: unknown } } }
          try { event = JSON.parse(line) } catch { continue }
          if (event.type !== 'tool.execution_start' || event.data?.toolName !== 'ask_user' || !event.timestamp || !Number.isFinite(Date.parse(event.timestamp)) || Date.parse(event.timestamp) < Date.parse(started) || Date.parse(event.timestamp) > Date.parse(project.updatedAt)) continue
          const request = event.data.arguments
          if (!request || typeof request.question !== 'string' || !request.question.trim()) continue
          const choices = Array.isArray(request.choices) ? request.choices.filter((choice): choice is string => typeof choice === 'string' && !!choice.trim()).slice(0, 20).map(choice => choice.trim().slice(0, 3000)) : []
          if (!result || event.timestamp >= result.createdAt) result = { id: `legacy-${createHash('sha256').update(`${project.id}:${started}:${event.timestamp}:${request.question}`).digest('hex').slice(0, 32)}`, createdAt: event.timestamp, text: request.question.trim().slice(0, 6000), choices, allowFreeform: request.allowFreeform !== false || !choices.length }
        }
      }
    }
    return result
  } catch { return undefined }
}