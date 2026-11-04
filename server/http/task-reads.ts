import type { Express, Request } from 'express'
import type { CodingTask, TaskEntry } from '../../shared/task.js'
import type { TaskPage } from '../../shared/task-summary.js'
import { ownsTask } from '../security/access.js'
import { displayEntry, taskDetail, taskSummary } from '../tasks/task-summary.js'

export interface TaskReader {
  hasBusyTasks(): Promise<boolean>
  readTask?(id: string): Promise<CodingTask | undefined>
  loadTask(id: string): Promise<CodingTask | undefined>
  queryTasks(ownerId?: number, cursor?: string, limit?: number): Promise<TaskPage<CodingTask>>
  history(id: string, kind: 'events' | 'artifacts' | 'runs' | 'snapshots', cursor?: string, limit?: number): Promise<TaskPage<unknown>>
}

function pagination(request: Request) {
  const { cursor, limit } = request.query
  if ((cursor !== undefined && (typeof cursor !== 'string' || !cursor || cursor.length > 2048)) ||
    (limit !== undefined && (typeof limit !== 'string' || !/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 1000))) {
    throw Object.assign(new Error('分页参数无效'), { status: 400 })
  }
  return { cursor: cursor as string | undefined, limit: limit === undefined ? 100 : Number(limit) }
}

export function registerTaskReads(app: Express, store: TaskReader, owner: (request: Request) => number | undefined) {
  app.get('/api/tasks', async (request, response) => {
    response.set('Cache-Control', 'no-store')
    const { cursor, limit } = pagination(request)
    const ownerId = owner(request)
    if (ownerId === undefined) return response.json({ items: [], busy: false })
    const page = await store.queryTasks(ownerId, cursor, limit)
    return response.json({ items: page.items.filter((task) => ownsTask(task, ownerId)).map(taskSummary), nextCursor: page.nextCursor, busy: await store.hasBusyTasks() })
  })
  app.use('/api/tasks/:id', async (request, response, next) => {
    const task = await ((request.method === 'GET' || request.method === 'HEAD') && store.readTask
      ? store.readTask(request.params.id)
      : store.loadTask(request.params.id))
    if (!task || !ownsTask(task, owner(request))) return response.status(404).json({ error: '任务不存在' })
    response.locals.task = task
    response.set('Cache-Control', 'no-store')
    return next()
  })
  app.get('/api/tasks/:id', (_request, response) => response.json(taskDetail(response.locals.task)))
  for (const kind of ['events', 'artifacts', 'runs', 'snapshots'] as const) {
    app.get(`/api/tasks/:id/${kind}`, async (request, response) => {
      const { cursor, limit } = pagination(request)
      const page = await store.history(response.locals.task.id, kind, cursor, limit)
      return response.json({ items: kind === 'events' ? page.items.map((entry) => displayEntry(entry as TaskEntry)) : page.items, nextCursor: page.nextCursor })
    })
  }
}