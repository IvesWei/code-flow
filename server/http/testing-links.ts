import type { Express, Request } from 'express'
import { parseTestingLinks, testingLinksEditable } from '../../shared/testing-links.js'
import type { CodingTask } from '../../shared/task.js'
import type { TestingRepository } from '../../shared/testing.js'
import { allowedWorkbenchOrigin, ownsTask } from '../security/access.js'
import type { TaskStore } from '../tasks/store.js'

export interface TestingLinksOptions {
  authenticate: (request: Request) => Promise<{ ownerId: number } | undefined>
  isBusy: (id: string) => boolean
}

class LinksError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

export function registerTestingLinks(app: Express, store: Pick<TaskStore, 'loadTask' | 'get' | 'update' | 'flush' | 'committed'>, repository: TestingRepository | undefined, options: TestingLinksOptions): void {
  const saving = new Set<string>()
  const idle = (task: CodingTask) => {
    if (!testingLinksEditable(task) || options.isBusy(task.id)) throw new LinksError(409, 'Testing links require a stable idle task')
  }
  app.post('/api/tasks/:id/testing-links', async (request, response) => {
    response.set('Cache-Control', 'no-store')
    const id = String(request.params.id)
    let locked = false
    try {
      if (!allowedWorkbenchOrigin(request.get('origin'))) throw new LinksError(403, 'Workbench Origin required')
      const user = await options.authenticate(request)
      if (!user || !Number.isSafeInteger(user.ownerId) || user.ownerId <= 0) throw new LinksError(401, 'Authentication required')
      const task = await store.loadTask(id)
      if (!task || !ownsTask(task, user.ownerId)) throw new LinksError(404, 'Task not found')
      if (!repository) throw new LinksError(503, 'Testing storage unavailable')
      idle(task)
      if (saving.has(id)) throw new LinksError(409, 'Testing links save in progress')
      saving.add(id)
      locked = true
      let links
      try { links = parseTestingLinks(request.body) }
      catch { throw new LinksError(400, 'Submit only optional testing link IDs; omitted or null IDs are cleared') }
      const owned = async <Kind extends 'project' | 'package' | 'execution'>(kind: Kind, recordId: string) => {
        const record = await repository.get(kind, recordId, user.ownerId)
        if (!record || ('ownerId' in record && record.ownerId !== user.ownerId)) throw new LinksError(404, 'Testing record not found')
        return record
      }
      if (links.planningProjectId) await owned('project', links.planningProjectId)
      const caseSet = links.caseSetId ? await owned('package', links.caseSetId) : undefined
      if (caseSet) {
        await owned('project', caseSet.projectId)
        if (links.planningProjectId && caseSet.projectId !== links.planningProjectId) throw new LinksError(400, 'Case package does not belong to the selected planning project')
      }
      const execution = links.executionRunId ? await owned('execution', links.executionRunId) : undefined
      if (execution) {
        const source = await owned('package', execution.input.caseSetId)
        await owned('project', source.projectId)
        if (links.caseSetId && execution.input.caseSetId !== links.caseSetId) throw new LinksError(400, 'Execution does not use the selected case package')
      }
      const latest = store.get(id)
      if (!latest || !ownsTask(latest, user.ownerId)) throw new LinksError(404, 'Task not found')
      idle(latest)
      if (JSON.stringify(latest) !== JSON.stringify(task)) throw new LinksError(409, 'Task changed while validating testing links')
      store.update(id, { testingLinks: links })
      await store.flush()
      const saved = store.committed(id)
      if (!saved || JSON.stringify(saved.testingLinks) !== JSON.stringify(links)) throw new Error('Testing links not committed')
      return response.json({ testingLinks: saved.testingLinks })
    } catch (error) {
      return response.status(error instanceof LinksError ? error.status : 503).json({ error: error instanceof LinksError ? error.message : 'Testing links unavailable; save not confirmed' })
    } finally { if (locked) saving.delete(id) }
  })
}