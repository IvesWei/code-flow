import type { PlaywrightExecutionBinding, TestExecutionResult } from './test-execution.js'

export type TaskStatus = 'QUEUED' | 'CLONING' | 'CODING' | 'NEEDS_INPUT' | 'VERIFYING' | 'PUBLISH_PENDING' | 'SELF_TEST' | 'TEST_EXECUTION' | 'REVIEW' | 'ACCEPTED' | 'SUCCESS' | 'FAILED'

export interface SelfTestCase {
  id: string
  title: string
  source: string
  steps: string
  expected: string
  testFile?: string
  requirementIds?: string[]
  scenario?: 'normal' | 'boundary' | 'negative' | 'permission' | 'state'
  preconditions?: string
  testData?: string
  assertions?: string[]
  cleanup?: string
  classification?: {
    testType: 'functional' | 'performance' | 'security' | 'compatibility' | 'reliability'
    tags: string[]
    priority: 'P0' | 'P1' | 'P2' | 'P3'
    riskReason: string
    executionPolicy: 'always' | 'on_demand'
  }
  status: 'pending' | 'running' | 'passed' | 'failed' | 'manual' | 'skipped' | 'invalid'
  output?: string
  startedAt?: string
  finishedAt?: string
  evidenceInputFingerprint?: string
  executionBinding?: PlaywrightExecutionBinding
  executionResult?: TestExecutionResult
}

export interface AcceptanceRequirement {
  id: string
  feature?: string
  source: string
  criterion: string
  required: boolean
  scenarios: NonNullable<SelfTestCase['scenario']>[]
}

export interface ReviewFinding {
  code: string
  category: 'coverage' | 'quality' | 'executability' | 'conflict' | 'safety'
  message: string
  caseIds: string[]
}

export type CaseReviewStatus = 'unreviewed' | 'reviewing' | 'qualified' | 'warning' | 'rejected' | 'unknown'

export interface CaseReview {
  caseId: string
  status: CaseReviewStatus
}

export interface AcceptanceAssessment {
  status: 'qualified' | 'rejected'
  checkedAt: string
  issues: string[]
  coveredIds: string[]
  missingIds: string[]
  caseIssues?: { caseId: string; message: string }[]
  findings?: ReviewFinding[]
  caseReviews?: CaseReview[]
  readiness?: 'checking' | 'ready' | 'blocked' | 'unknown'
  inputFingerprint?: string
}

export interface AutomationRun {
  runner?: 'playwright-test' | 'browser-dsl'
  executionResult?: TestExecutionResult
  caseId: string
  status: 'generating' | 'running' | 'passed' | 'failed' | 'skipped' | 'blocked'
  script?: string
  output?: string
  screenshot?: string
  failureKind?: 'script' | 'navigation' | 'step' | 'browser'
  failureCategory?: 'action' | 'assertion' | 'navigation' | 'browser' | 'policy'
  reasonCode?: 'capability' | 'environment' | 'authorization' | 'manual' | 'unknown'
  requiredCapabilities?: string[]
  protocolVersion?: string
  startedAt?: string
  finishedAt?: string
  inputFingerprint?: string
}

export interface TaskQuestion {
  text: string
  choices?: string[]
  allowFreeform: boolean
}

export interface TaskEntry {
  at: string
  kind: 'info' | 'agent' | 'answer' | 'warning' | 'error'
  text: string
  detail?: string
  toolCallId?: string
  toolEvent?: 'start' | 'complete'
  turnId?: string
  turnEvent?: 'start' | 'complete'
  stage?: 'CLONING' | 'CODING' | 'VERIFYING' | 'PUBLISH_PENDING' | 'SELF_TEST' | 'TEST_EXECUTION' | 'REVIEW' | 'ACCEPTED' | 'SUCCESS'
}

export interface SelfTestArtifact {
  id: string
  revision: number
  schemaVersion: 1
  phase: 'baseline' | 'generation' | 'review' | 'browser'
  scope: string
  inputFingerprint: string
  inputRefs: string[]
  status: 'running' | 'complete' | 'failed' | 'blocked'
  createdAt: string
  finishedAt?: string
  sessionId?: string
  model: string
  rulesVersion: string
  output?: { baseline?: AcceptanceRequirement[]; cases?: SelfTestCase[]; assessment?: AcceptanceAssessment; content?: string; writtenFiles?: string[]; coverage?: { requirementId: string; scenario: NonNullable<SelfTestCase['scenario']>; caseIds: string[] }[] }
  error?: string
}

export interface CodingTask {
  id: string
  ownerId?: number
  modelId?: string
  activeModelId?: string
  modelRevision?: number
  appliedModelRevision?: number
  modelInTurn?: boolean
  modelTurn?: {
    id: string
    label: string
    startedAt: string
    finishedAt?: string
    lastActivityAt: string
    summary: string
    firstResponseTimeoutMs?: number
    inactivityTimeoutMs: number
    status: 'running' | 'completed' | 'failed' | 'timed_out' | 'interrupted'
  }
  modelHistory?: { at: string; from: string; to: string; revision: number; appliedAt?: string; supersededAt?: string }[]
  repository: string
  branch?: string
  instruction: string
  automationUrl?: string
  automationRuns?: AutomationRun[]
  testingLinks?: { planningProjectId?: string; caseSetId?: string; executionRunId?: string }
  prdName: string
  designNames: string[]
  status: TaskStatus
  createdAt: string
  updatedAt: string
  workspace?: string
  createdBranch?: string
  publication?: { files: string[]; snapshot: string; baseCommit?: string; previousCommit?: string; blobs?: Record<string, string | null>; commit?: string; pushedAt?: string; skipped?: boolean; error?: string }
  question?: TaskQuestion
  confirmedDecisions?: { at: string; question: string; answer: string; stage: 'CODING' | 'SELF_TEST' | 'TEST_EXECUTION' }[]
  copilotSession?: { id: string; directory: string; previousIds?: string[] }
  sessionRestoreError?: string
  changes?: string[]
  checks?: { name: string; passed: boolean; output: string }[]
  selfTests?: SelfTestCase[]
  selfTestArtifacts?: SelfTestArtifact[]
  acceptanceSelection?: { mode: 'custom'; caseIds: string[]; reason: string; confirmedAt: string }
  acceptanceSelectionHistory?: NonNullable<CodingTask['acceptanceSelection']>[]
  executionAssessment?: AcceptanceAssessment & { caseIds: string[] }
  testExecutionPlan?: {
    version: 1
    createdAt: string
    mode?: 'default' | 'custom'
    inputFingerprint?: string
    artifactRefs?: string[]
    cases: { caseId: string; selected: boolean; gatePolicy: 'blocking' | 'advisory'; reason: string }[]
  }
  acceptanceBaseline?: AcceptanceRequirement[]
  acceptanceAssessment?: AcceptanceAssessment
  acceptanceHistory?: { at: string; baseline?: AcceptanceRequirement[]; assessment?: AcceptanceAssessment; cases: SelfTestCase[]; automationRuns: AutomationRun[] }[]
  selfTestError?: string
  selfTestDraft?: string
  selfTestPlanningStatus?: 'generating' | 'reviewing' | 'qualified' | 'rejected'
  error?: string
  entries: TaskEntry[]
}