export interface RequirementRemoteCodeConfig { repository: string; branch?: string; directory?: string }
export interface RequirementSource {
  id: string
  name: string
  kind: 'file' | 'url'
  sha256: string
  sizeBytes: number
  storageKey?: string
  url?: string
  remoteCode?: RequirementRemoteCodeConfig & { commit: string }
}
export interface RequirementQuestion {
  id: string
  priority: 'P0' | 'P1' | 'P2'
  text: string
  impact: string
  choices: string[]
  recommendation: string
  capture?: { fingerprint: string; blockIds: string[] }
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
  capability?: string
  description: string
  fields?: { name: string; description: string }[]
  scenario?: string
  acceptance: { id: string; text: string }[]
  sourceIds: string[]
  nonVisualReason?: string
  specification?: PrdFunctionSpecification
}
export type PrdFieldChange = '新增' | '变更' | '删除' | '既有'
export interface BusinessReviewChange {
  requirementId: string
  kind: Exclude<PrdFieldChange, '既有'>
  scope: 'ui' | 'logic'
  text: string
  basis: string
  screenIds: string[]
}
export interface BusinessReview {
  changes: BusinessReviewChange[]
  pending: { requirementId: string; text: string }[]
}
export interface PrdFunctionSpecification {
  fields: { name: string; id: string; type: string; required: '是' | '否' | '待确认'; source: string; change?: PrdFieldChange; options: string[] }[]
  transitions: { id: string; from: string; to: string; event: string; precondition: string; role: string; effects: string }[]
  rules: { id: string; kind: '校验规则' | '计算 / 编号生成规则'; business: string; detail: string; validation: '双端' | '仅后端' | '待确认'; scope: string; businessVisible?: boolean }[]
  exceptions: { id: string; condition: string; outcome: string; dataImpact: '整体回滚' | '部分成功' | '只读保留' | '待确认' }[]
  permissions: { id: string; role: string; operation: string; availability: '可用' | '仅查看' | '不可见' | '待确认'; scope: string }[]
  criteria: { id: string; acceptanceId: string; given: string; when: string; then: string; example: string; refs: string[] }[]
}
export interface StructuredPrd {
  templateVersion?: 2
  title: string
  summary: string
  blocks: PrdBlock[]
  requirements: PrdRequirement[]
}
export interface RequirementScopeBlock {
  blockId: string
  kind: 'existing' | 'new'
  reason: string
}
export interface RequirementCapturePlan {
  version: 1
  fingerprint: string
  blocks: RequirementScopeBlock[]
  views?: { blockId: string; viewId: string }[]
  sourceFallback?: { code: string; blocks: { blockId: string; fields: string[]; content: string[] }[]; images?: { blockId: string; createdAt: string; image: RequirementSource }[] }
}
export interface RequirementScopeCheckpoint extends RequirementCapturePlan {
  prd: StructuredPrd
  mapping?: RequirementCaptureMappingPage[]
}
export interface RequirementCaptureMappingPage {
  blockId: string
  kind: 'existing'
  path: string
  sourceId: string
  quote: string
  openDialog?: string
  activate?: { kind: 'tab' | 'dialog'; name: string }[]
  expectedFields?: string[]
  expectedContent?: string[]
  discover?: RequirementCaptureDiscovery[]
}
export interface RequirementCaptureDiscovery {
  fromPath: string
  path: string
  column: string
  queryKeys: string[]
  sourceId: string
  quote: string
  columnQuote: string
  handler?: string
  tabs?: string[]
  expectedFields?: string[]
  expectedContent?: string[]
}
export interface RequirementPrototypeCapture {
  mode?: 'viewport' | 'element' | 'fullPage'
  scrollTo?: string
  selector?: string
  padding?: number
}
export interface RequirementScreen {
  id: string
  prototypeId?: string
  title: string
  state: string
  proves?: string
  capture?: RequirementPrototypeCapture
  requirementIds: string[]
  acceptanceIds: string[]
  html: string
}
export interface RequirementPrototype {
  id: string
  title: string
  mode?: 'incremental' | 'redesign'
  sourceAnchor?: { route: string; layout: string; pageFile: string }
  html: string
  states: {
    id: string
    name: string
    proves?: string
    capture?: RequirementPrototypeCapture
    requirementIds: string[]
    acceptanceIds: string[]
    changes: { node: string; text?: string; value?: string; hidden?: boolean }[]
  }[]
}
export interface RequirementSourceAnchor {
  domain: string
  sourceId: string
  route?: string
  layout?: string
  menu?: string
  pageFile: string
  position?: 'viewport' | 'lower' | 'dialog' | 'drawer' | 'tab'
  summary: string
}
export interface RequirementStageState {
  analysisFingerprint?: string
  prdInputFingerprint?: string
  prdRevisionId?: string
  prdClarificationJobId?: string
}
export interface RequirementRevision {
  id: string
  createdAt: string
  prd: StructuredPrd
  businessReview?: BusinessReview & { revisionId: string }
  confirmedAt?: string
  screens: RequirementScreen[]
  prototypes?: RequirementPrototype[]
  designConfirmedAt?: string
  screenshots?: { screenId: string; storageKey: string; sha256: string }[]
  validation?: { at: string; errors: string[] }
  existingPages?: { blockId: string; viewId?: string; path: string; capturedAt: string; fingerprint: string; image: RequirementSource; structure: string }[]
  capturePlan?: RequirementCapturePlan
}
export type RequirementJobStage = 'analyze' | 'prd' | 'design' | 'validate' | 'reconstruct' | 'business-review'
export interface RequirementJob {
  id: string
  stage: RequirementJobStage
  revisionId?: string
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
  remoteCodeConfig?: RequirementRemoteCodeConfig
  preview?: { origin: string; generation: number; entryPaths?: string[] }
  scopeCheckpoint?: RequirementScopeCheckpoint
  sourceAnchors?: RequirementSourceAnchor[]
  stageState?: RequirementStageState
  createdAt: string
  updatedAt: string
  status: 'draft' | 'running' | 'needs_input' | 'prd_review' | 'design_review' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  sources: RequirementSource[]
  evidence: { sourceId: string; summary: string; limitations: string }[]
  questions: RequirementQuestion[]
  decisions: RequirementDecision[]
  revisions: RequirementRevision[]
  prototypeConversations?: RequirementPrototypeConversation[]
  jobs: RequirementJob[]
  events: { id: string; at: string; text: string }[]
}
export interface RequirementPrototypeConversation {
  prototypeId: string
  conversationId: string
  sdkSessionId: string
  modelId: string
  contextFingerprint?: string
  prototypeFingerprint?: string
  skillFingerprint?: string
}
export interface RequirementRepository {
  list(ownerId: number): Promise<RequirementProject[]>
  get(id: string, ownerId: number): Promise<RequirementProject | undefined>
  create(project: RequirementProject): Promise<void>
  replace(project: RequirementProject, expectedVersion: number): Promise<void>
  recover(): Promise<void>
  appendConversation?(ownerId: number, projectId: string, jobId: string, entry: RequirementConversationEntry): Promise<void>
  readPrdAudit?(ownerId: number, projectId: string, jobId: string): Promise<RequirementPrdAudit | undefined>
}
export interface RequirementPrdGrounding {
  blocks: RequirementScopeBlock[]
  pages: NonNullable<RequirementRevision['existingPages']>
  sourceFallback?: NonNullable<RequirementCapturePlan['sourceFallback']>
}
export interface RequirementPrdCheckpoint {
  version: 1
  fingerprint: string
  grounding?: RequirementPrdGrounding
  candidate?: string
}
export interface RequirementPrdAudit {
  checkpoint?: Record<string, unknown>
  legacy?: { start: Record<string, unknown>; prompt: string; candidate: string }
}
export interface RequirementConversationEntry {
  conversationId: string
  sdkSessionId?: string
  sequence: number
  requestIndex: number
  createdAt: string
  kind: string
  body: Record<string, unknown>
}
export interface RequirementModelResult {
  businessReview?: BusinessReview
  evidence?: RequirementProject['evidence']
  sourceAnchors?: RequirementSourceAnchor[]
  questions?: RequirementQuestion[]
  prd?: StructuredPrd
  screens?: RequirementScreen[]
  prototypes?: RequirementPrototype[]
  existingPages?: RequirementRevision['existingPages']
  capturePlan?: RequirementCapturePlan
}
export interface RequirementDesignValidationFeedback {
  reason: string
  candidate: Pick<RequirementModelResult, 'screens' | 'prototypes'>
  states: {
    screenId: string
    state: string
    viewports: { width: number; height: number; errors: string[] }[]
  }[]
}
export interface RequirementDesignAdjustment {
  screenId: string
  instruction: string
  validationFeedback?: RequirementDesignValidationFeedback
}
export interface RequirementModel {
  prepareBusinessReview?(project: RequirementProject, context: Parameters<RequirementModel['generate']>[2]): Promise<BusinessReview>
  generate(stage: 'analyze' | 'prd' | 'design', project: RequirementProject, context: {
    root: string
    token: string
    signal: AbortSignal
    onProgress(text: string): Promise<void>
    recordConversation(entry: RequirementConversationEntry): Promise<void>
    loadPrdAudit?(): Promise<RequirementPrdAudit | undefined>
    restartPrd?: boolean
    savePrototypeConversation?(binding: RequirementPrototypeConversation): Promise<void>
    claimPrototypeCorrection?(): boolean
    assertCurrent?(): Promise<void>
    saveScopeCheckpoint?(checkpoint: RequirementScopeCheckpoint): Promise<void>
    designAdjustment?: RequirementDesignAdjustment
    sourceReconstruction?: boolean
    businessReviewOnly?: { previous?: BusinessReview }
    designValidationFeedback?: RequirementDesignValidationFeedback
    onLoginRequired?(controls: RequirementLoginControls): Promise<void>
  }): Promise<RequirementModelResult>
}