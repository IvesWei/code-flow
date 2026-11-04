import { useEffect, useRef, useState } from 'react'
import type { TaskPage } from '../../../shared/task-summary'

export function useTaskHistory<T>(taskId: string | undefined, kind: 'events' | 'artifacts' | 'runs' | 'snapshots', revision: string, enabled = true) {
  const [page, setPage] = useState<TaskPage<T> & { taskId?: string }>({ items: [] })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const generation = useRef(0)
  const loadedPages = useRef(1)
  const activeTask = useRef(taskId)
  if (activeTask.current !== taskId) {
    activeTask.current = taskId
    loadedPages.current = 1
  }

  useEffect(() => {
    const requestGeneration = ++generation.current
    const controller = new AbortController()
    setError('')
    if (!taskId || !enabled) { setLoading(false); return }
    async function refresh() {
      setLoading(true)
      try {
        const items: T[] = []
        let cursor: string | undefined
        for (let index = 0; index < loadedPages.current; index++) {
          const query = new URLSearchParams({ limit: kind === 'events' ? '1000' : '50' })
          if (cursor) query.set('cursor', cursor)
          const response = await fetch(`/api/tasks/${encodeURIComponent(taskId!)}/${kind}?${query}`, { signal: controller.signal })
          const result = await response.json() as TaskPage<T> & { error?: string }
          if (!response.ok) throw new Error(result.error || '无法读取历史记录')
          if (!Array.isArray(result.items)) throw new Error('历史记录响应格式无效')
          if (kind === 'events') items.unshift(...result.items)
          else items.push(...result.items)
          cursor = result.nextCursor
          if (!cursor) break
        }
        if (generation.current === requestGeneration) setPage({ taskId, items, nextCursor: cursor })
      } catch (caught) {
        if (!controller.signal.aborted && generation.current === requestGeneration) setError(caught instanceof Error ? caught.message : '无法读取历史记录')
      } finally { if (generation.current === requestGeneration) setLoading(false) }
    }
    void refresh()
    return () => { controller.abort(); generation.current++ }
  }, [taskId, kind, revision, enabled, retry])

  return {
    ...(page.taskId === taskId ? page : { items: [], nextCursor: undefined }), loading, error,
    loadMore: () => { if (!loading && page.nextCursor) { loadedPages.current++; setRetry((value) => value + 1) } },
    retry: () => setRetry((value) => value + 1),
  }
}