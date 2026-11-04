import type { RequestHandler } from 'express'
import type { TaskStore } from '../tasks/store.js'

export function storageResponse(store: Pick<TaskStore, 'flush'>): RequestHandler {
  return (_request, response, next) => {
    const sendJson = response.json.bind(response)
    response.json = (body: unknown) => {
      const snapshot = structuredClone(body)
      void store.flush().then(() => {
        if (!response.destroyed) sendJson(snapshot)
      }).catch(() => {
        if (!response.destroyed && !response.headersSent) response.status(503)
        if (!response.destroyed && !response.headersSent) sendJson({ error: '任务存储不可用，操作未确认落库；请恢复数据库后重启后台' })
      })
      return response
    }
    void store.flush().then(() => next()).catch(() => {
      response.status(503)
      sendJson({ error: '任务存储不可用，请恢复数据库后重启后台' })
    })
  }
}