import { stripVTControlCharacters } from 'node:util'
import type { CodingTask, TaskEntry } from '../../shared/task.js'
import type { TaskListProjection, TaskSummary } from '../../shared/task-summary.js'

export function taskSummary(task: TaskListProjection): TaskSummary {
  const runs = task.automationRuns || []
  return {
    id: task.id, repository: task.repository, status: task.status,
    createdAt: task.createdAt, updatedAt: task.updatedAt,
    automationUrl: task.automationUrl, hasWorkspace: task.hasWorkspace ?? !!task.workspace,
    caseCount: task.caseCount ?? task.selfTests?.length ?? 0, automationCount: task.automationCount ?? runs.length,
    runnable: task.runnable ?? (!task.selfTests?.length || !!task.selfTestDraft || task.selfTests.some((item) =>
      ['pending', 'invalid', 'failed', 'skipped', 'running'].includes(item.status) ||
      (['manual', 'passed'].includes(item.status) && !runs.some((run) => run.caseId === item.id)))),
    runs: (task.runs ?? runs).map((run) => ({
      caseId: run.caseId, status: run.status,
      title: 'title' in run ? run.title : task.selfTests?.find((item) => item.id === run.caseId)?.title || '自动化用例',
      ...(run.runner === undefined ? {} : { runner: run.runner }),
      ...(run.executionResult === undefined ? {} : { executionResult: run.executionResult }),
    })),
  }
}

export function displayEntry(entry: TaskEntry): TaskEntry {
  return { ...entry, text: stripVTControlCharacters(entry.text), detail: entry.detail && stripVTControlCharacters(entry.detail) }
}

export function taskDetail(task: CodingTask): CodingTask {
  return {
    id: task.id, ownerId: task.ownerId, repository: task.repository, branch: task.branch,
    instruction: task.instruction, prdName: task.prdName, designNames: task.designNames,
    status: task.status, createdAt: task.createdAt, updatedAt: task.updatedAt,
    modelId: task.modelId, activeModelId: task.activeModelId, modelRevision: task.modelRevision,
    appliedModelRevision: task.appliedModelRevision, modelInTurn: task.modelInTurn, modelTurn: task.modelTurn,
    automationUrl: task.automationUrl,
    testingLinks: task.testingLinks,
    automationRuns: task.automationRuns?.map(({ script: _script, ...run }) => run),
    workspace: task.workspace, createdBranch: task.createdBranch, publication: task.publication,
    question: task.question, confirmedDecisions: task.confirmedDecisions, copilotSession: task.copilotSession,
    sessionRestoreError: task.sessionRestoreError, changes: task.changes,
    checks: task.checks?.map((check) => ({ ...check, output: stripVTControlCharacters(check.output) })),
    selfTests: task.selfTests, acceptanceSelection: task.acceptanceSelection,
    executionAssessment: task.executionAssessment, testExecutionPlan: task.testExecutionPlan,
    acceptanceBaseline: task.acceptanceBaseline, acceptanceAssessment: task.acceptanceAssessment,
    selfTestError: task.selfTestError, selfTestDraft: task.selfTestDraft,
    selfTestPlanningStatus: task.selfTestPlanningStatus, error: task.error, entries: [],
  }
}