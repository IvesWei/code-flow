import type { AcceptanceAssessment, AcceptanceRequirement, SelfTestCase } from './task.js'
import type { PlaywrightExecutionBinding, TestExecutionResult } from './test-execution.js'

export type CaseDefinition = Omit<SelfTestCase, 'status' | 'output' | 'startedAt' | 'finishedAt' | 'evidenceInputFingerprint' | 'executionBinding' | 'executionResult'>
export type PlanningStatus = 'draft' | 'running' | 'needs_input' | 'completed' | 'failed' | 'interrupted' | 'cancelled'
export type ExecutionStatus = 'draft' | 'preparing' | 'ready' | 'running' | 'passed' | 'failed' | 'incomplete' | 'blocked' | 'cancelled' | 'interrupted'

export interface TestingSource {
  id: string
  name: string
  kind: 'requirements' | 'design'
  sha256: string
  sizeBytes: number
  storageKey: string
}

export interface PlanningInput {
  title: string
  requirements: string
  instruction: string
  modelId: string
  sources: TestingSource[]
  referenceRepository?: string
  referenceBranch?: string
}

export interface TestingEvent {
  at: string
  kind: 'info' | 'warning' | 'error'
  text: string
}

export interface PlanningPrompt {
  text: string
  choices: string[]
  allowFreeform: boolean
}

export interface PlanningQuestion extends PlanningPrompt {
  id: string
  createdAt: string
}

export interface PlanningReviewBatch {
  caseIds: string[]
  result: { qualified: boolean; issues: string[]; caseIssues: { caseId: string; message: string }[] }
}

export interface PlanningDraft {
  baseline: AcceptanceRequirement[]
  cases: CaseDefinition[]
  assessment?: AcceptanceAssessment
  sourceFingerprint?: string
  definitionFingerprint?: string
  reviewBatches?: PlanningReviewBatch[]
  customReview?: {
    caseIds: string[]
    reason: string
    definitionFingerprint: string
    assessment?: AcceptanceAssessment
    batches: PlanningReviewBatch[]
  }
}

export interface PlanningOperation {
  mode: 'continue' | 'review' | 'optimize'
  version: number
  caseIds?: string[]
  reason?: string
  regenerate?: boolean
}

export interface PlanningProject {
  id: string
  ownerId: number
  version: number
  createdAt: string
  updatedAt: string
  input: PlanningInput
  status: PlanningStatus
  events: TestingEvent[]
  draft?: PlanningDraft
  caseSetIds: string[]
  error?: string
  question?: PlanningQuestion
  clarifications?: { question: PlanningQuestion; answer: string; answeredAt: string }[]
}

export interface CasePackage {
  schemaVersion: 1
  id: string
  projectId: string
  revision: number
  createdAt: string
  sourceFingerprint: string
  definitionFingerprint: string
  rulesVersion: string
  modelId: string
  scope?: {
    mode: 'custom'
    caseIds: string[]
    reason: string
    originalDefinitionFingerprint: string
  }
  baseline: AcceptanceRequirement[]
  cases: CaseDefinition[]
  assessment: AcceptanceAssessment
}

export interface ExecutionInput {
  title: string
  caseSetId: string
  repository: string
  branch?: string
  previewUrl?: string
  scope: { mode: 'default' | 'custom'; caseIds: string[]; reason: string }
}

export interface ExecutionCase {
  caseId: string
  selected: boolean
  blocking: boolean
  status: 'pending' | 'passed' | 'failed' | 'incomplete' | 'blocked' | 'skipped' | 'cancelled'
  binding?: PlaywrightExecutionBinding
  implementation?: { testFile: string; testTitle: string; project: string }
  result?: TestExecutionResult
  reason?: string
}

export interface ExecutionRun {
  id: string
  ownerId: number
  version: number
  createdAt: string
  updatedAt: string
  input: ExecutionInput
  status: ExecutionStatus
  phase?: 'cloning' | 'implementing' | 'installing' | 'awaiting_implementation' | 'awaiting_installation' | 'awaiting_approval' | 'ready' | 'executing' | 'finished'
  packageFingerprint: string
  workspaceFingerprint?: string
  sourceFingerprint?: string
  installComplete?: boolean
  readiness?: AcceptanceAssessment
  cases: ExecutionCase[]
  events: TestingEvent[]
  error?: string
}

export interface ExecutionReport {
  schemaVersion: 1
  run: ExecutionRun
  casePackage: CasePackage
  scope: ExecutionInput['scope']
}

export interface TestingRecordMap {
  project: PlanningProject
  package: CasePackage
  execution: ExecutionRun
}

export type TestingRecordKind = keyof TestingRecordMap

export interface TestingRepository {
  list<Kind extends TestingRecordKind>(kind: Kind, ownerId: number): Promise<TestingRecordMap[Kind][]>
  get<Kind extends TestingRecordKind>(kind: Kind, id: string, ownerId: number): Promise<TestingRecordMap[Kind] | undefined>
  create<Kind extends TestingRecordKind>(kind: Kind, value: TestingRecordMap[Kind], ownerId: number): Promise<void>
  replace<Kind extends 'project' | 'execution'>(kind: Kind, value: TestingRecordMap[Kind], expectedVersion: number, ownerId: number): Promise<void>
  recover(): Promise<void>
}