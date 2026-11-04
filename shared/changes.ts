import type { CodingTask } from './task.js'

export function taskChangeFiles(task: CodingTask, current = task.changes || []): string[] {
  return [...new Set([...(task.publication?.commit ? task.publication.files : []), ...current])]
}