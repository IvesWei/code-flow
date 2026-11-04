export interface RequirementSource {
  id: string
  name: string
  kind: 'file' | 'url'
  sha256: string
  sizeBytes: number
  storageKey?: string
  url?: string
}
export interface RequirementQuestion {
  id: string
  priority: 'P0' | 'P1' | 'P2'
  text: string
  impact: string
  choices: string[]
  recommendation: string
}
export interface RequirementDecision {
  question: RequirementQuestion
  answer: string
  at: string
}
export interface PrdBlock {
  id: string
  title: string
  module?: string
  content: string
  requirementIds: string[]
  sourceIds: string[]
  table?: { columns: string[]; rows: string[][] }
}
export interface PrdRequirement {
  id: string
  title: string
  description: string
  fields?: { name: string; description: string }[]
  scenario?: string
  acceptance: { id: string; text: string }[]
  sourceIds: string[]
  nonVisualReason?: string
}
export interface StructuredPrd {
  title: string
  summary: string
  blocks: PrdBlock[]
  requirements: PrdRequirement[]
}
export interface RequirementScreen {
  id: string
  prototypeId?: string
  title: string
  state: string
  requirementIds: string[]
  acceptanceIds: string[]
  html: string
}
export interface RequirementPrototype {
  id: string
  title: string
  html: string
  states: {
    id: string
    name: string
    requirementIds: string[]
    acceptanceIds: string[]
    changes: { node: string; text?: string; value?: string; hidden?: boolean }[]
  }[]
}
export interface RequirementRevision {
  id: string
  createdAt: string
  prd: StructuredPrd
  confirmedAt?: string
  screens: RequirementScreen[]
  prototypes?: RequirementPrototype[]
  designConfirmedAt?: string
  screenshots?: { screenId: string; storageKey: string; sha256: string }[]
  validation?: { at: string; errors: string[] }
  existingPages?: { blockId: string; path: string; capturedAt: string; fingerprint: string; image: RequirementSource; structure: string }[]
}
export type RequirementJobStage = 'analyze' | 'prd' | 'design' | 'validate'
export interface RequirementJob {
  id: string
  stage: RequirementJobStage
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
  startedAt: string
  endedAt?: string
  error?: string
  interaction?: { kind: 'browser_login'; phase: 'ready' | 'opened'; origin: string; expiresAt: string }
}
export interface RequirementLoginControls {
  origin: string
  expiresAt: string
  open(): Promise<void>
}
export interface RequirementProject {
  schemaVersion: 1
  id: string
  ownerId: number
  version: number
  title: string
  description: string
  modelId: string
  preview?: { origin: string; generation: number }
  createdAt: string
  updatedAt: string
  status: 'draft' | 'running' | 'needs_input' | 'prd_review' | 'design_review' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  sources: RequirementSource[]
  evidence: { sourceId: string; summary: string; limitations: string }[]
  questions: RequirementQuestion[]
  decisions: RequirementDecision[]
  revisions: RequirementRevision[]
  jobs: RequirementJob[]
  events: { id: string; at: string; text: string }[]
}
export interface RequirementRepository {
  list(ownerId: number): Promise<RequirementProject[]>
  get(id: string, ownerId: number): Promise<RequirementProject | undefined>
  create(project: RequirementProject): Promise<void>
  replace(project: RequirementProject, expectedVersion: number): Promise<void>
  recover(): Promise<void>
}
export interface RequirementModelResult {
  evidence?: RequirementProject['evidence']
  questions?: RequirementQuestion[]
  prd?: StructuredPrd
  screens?: RequirementScreen[]
  prototypes?: RequirementPrototype[]
  existingPages?: RequirementRevision['existingPages']
}
export interface RequirementModel {
  generate(stage: Exclude<RequirementJobStage, 'validate'>, project: RequirementProject, context: {
    root: string
    token: string
    signal: AbortSignal
    onProgress(text: string): Promise<void>
    designAdjustment?: { screenId: string; instruction: string }
    onLoginRequired?(controls: RequirementLoginControls): Promise<void>
  }): Promise<RequirementModelResult>
}