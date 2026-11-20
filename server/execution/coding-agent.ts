import { randomUUID } from 'node:crypto'
import type { CodingTask } from '../../shared/task.js'
import { AgentExecution, type AgentEvent } from '../agents/runtime.js'
import { jsonDigest } from '../storage/json-digest.js'

export class CodingAgent extends AgentExecution {
  constructor(task: CodingTask, onEvent: (event: AgentEvent) => Promise<void>, operation: {
    guidance?: string; selfTestOnly: boolean; selectedCaseIds: string[]; intent: 'repair' | 'execute'
  }) {
    super({
      schemaVersion: 1, runId: randomUUID(), role: 'coding',
      resourceHash: jsonDigest(`coding:${task.ownerId ?? 'legacy'}:${task.id}`),
      revision: jsonDigest({ instruction: task.instruction, repository: task.repository, branch: task.branch, decisions: task.confirmedDecisions }),
      inputFingerprint: jsonDigest({ task, operation }),
    }, { resource: task.id, revision: 1, signal: new AbortController().signal, onEvent })
  }
}
