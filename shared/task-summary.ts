import type { AutomationRun, CodingTask, TaskEntry, TaskStatus } from './task.js'

export interface TaskSummary {
  id: string
  repository: string
  status: TaskStatus
  createdAt: string
  updatedAt: string
  automationUrl?: string
  hasWorkspace: boolean
  caseCount: number
  automationCount: number
  runnable: boolean
  runs: (Pick<AutomationRun, 'caseId' | 'status' | 'runner' | 'executionResult'> & { title: string })[]
}

export interface TaskPage<T> {
  items: T[]
  nextCursor?: string
}

export interface TaskListPage extends TaskPage<TaskSummary> {
  busy: boolean
}

export type TaskListProjection = CodingTask & Partial<Pick<TaskSummary, 'hasWorkspace' | 'caseCount' | 'automationCount' | 'runnable' | 'runs'>>

export type TaskEvent = TaskEntry & { modelChange?: NonNullable<CodingTask['modelHistory']>[number] }