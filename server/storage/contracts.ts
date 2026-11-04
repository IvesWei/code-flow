import { createHash, randomUUID } from 'node:crypto'
import { caseReviewStatuses, reviewFindingCategories } from '../../shared/case-review.js'
import type { CodingTask, SelfTestArtifact, SelfTestCase, TaskEntry } from '../../shared/task.js'
import type { TaskListProjection } from '../../shared/task-summary.js'

export const BODY_VERSION = 1
export const STATE_LIMIT = 1024 * 1024
export const BODY_LIMIT = 4 * 1024 * 1024
export const terminalStatuses = ['SUCCESS', 'FAILED', 'REVIEW', 'ACCEPTED', 'PUBLISH_PENDING']
const statuses = [...terminalStatuses, 'QUEUED', 'CLONING', 'CODING', 'NEEDS_INPUT', 'VERIFYING', 'SELF_TEST', 'TEST_EXECUTION']
export type HistoryKind = 'events' | 'artifacts' | 'runs' | 'snapshots'
export type SnapshotKind = 'baseline' | 'default_review' | 'scoped_review' | 'execution_plan' | 'selection' | 'acceptance_history'
export interface Page<T> { items: T[]; nextCursor?: string }
export interface UsageRecord {
  id?: string; taskId?: string; turnId?: string; sessionId: string; artifactId?: string; model?: string; phase: string
  sourceEventId: string; observedAt: string; body: Record<string, unknown>
}
export interface FileRecord {
  id?: string; taskId?: string; kind: 'prd' | 'design' | 'evidence' | 'test' | 'session_manifest'
  storageKey: string; sha256?: string; sizeBytes?: number; createdAt?: string; metadata: Record<string, unknown>
}
export interface CaseDefinition { id: string; definition: Record<string, unknown>; fingerprint: string }
export interface CaseRun {
  id: string; caseId: string; executor: 'test' | 'browser'; status: string; startedAt?: string; finishedAt?: string
  inputFingerprint?: string; continuation?: boolean; continuationFrom?: { startedAt?: string; inputFingerprint?: string }; body: Record<string, unknown>
}
export interface Snapshot { id: string; kind: SnapshotKind; createdAt: string; body: Record<string, unknown>; inputFingerprint?: string }
export interface TaskChange {
  id: string; expectedVersion: number; create?: boolean
  header: Pick<CodingTask, 'ownerId' | 'status' | 'createdAt' | 'updatedAt'>
  state?: Record<string, unknown>; events: TaskEntry[]; artifacts: SelfTestArtifact[]
  cases: CaseDefinition[]; caseOrder?: string[]; runs: CaseRun[]; snapshots: Snapshot[]
  files: FileRecord[]; usage: UsageRecord[]
}
export interface LoadedTask { task: CodingTask; version: number }
export interface TaskRepository {
  loadTask(id: string): Promise<LoadedTask | undefined>
  readTask?(id: string): Promise<LoadedTask | undefined>
  queryTasks(ownerId?: number, cursor?: string, limit?: number): Promise<Page<TaskListProjection>>
  history(id: string, kind: HistoryKind, cursor?: string, limit?: number): Promise<Page<unknown>>
  hasBusyTasks(): Promise<boolean>
  recoverActive(): Promise<void>
  commit(change: TaskChange): Promise<number>
  findArtifact?(taskId: string, phase: SelfTestArtifact['phase'], scope: string, inputFingerprint: string): Promise<SelfTestArtifact | undefined>
}
export class StorageContractError extends Error {}
export class StorageConflictError extends Error {}
export class StorageOverloadError extends Error {
  readonly statusCode = 503
  readonly status = 503
  constructor() { super('Storage queue capacity exceeded'); this.name = 'StorageOverloadError' }
}
export function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StorageContractError('Expected object')
}
export function string(value: unknown, max = 128): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > max) throw new StorageContractError('Invalid string')
}
export function identifier(value: unknown): asserts value is string {
  string(value, 64)
  if (!/^[\x21-\x7e]+$/.test(value)) throw new StorageContractError('Invalid identifier')
}
export function timestamp(value: unknown): asserts value is string {
  string(value, 40)
  if (!Number.isFinite(Date.parse(value))) throw new StorageContractError('Invalid timestamp')
}
export function fingerprint(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new StorageContractError('Invalid fingerprint')
}
export function positive(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new StorageContractError('Invalid revision')
}
export function json(value: unknown, limit = BODY_LIMIT): string {
  const result = JSON.stringify(value)
  if (result === undefined || Buffer.byteLength(result) > limit) throw new StorageContractError('Storage body exceeds limit')
  return result
}
export function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }
export function decode(value: unknown, version: unknown = BODY_VERSION): unknown {
  if (Number(version) !== BODY_VERSION) throw new StorageContractError('Unsupported body version')
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value
  const restore = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(restore)
    if (!item || typeof item !== 'object') return item
    const record = item as Record<string, unknown>
    const order = record.__codeflow_keys
    if (order !== undefined && (!Array.isArray(order) || !order.every(key => typeof key === 'string') || new Set(order).size !== order.length)) throw new StorageContractError('Invalid stored key order')
    const keys = [...(Array.isArray(order) ? order as string[] : []), ...Object.keys(record).filter(key => key !== '__codeflow_keys' && (!Array.isArray(order) || !order.includes(key)))]
    return Object.fromEntries(keys.filter(key => Object.hasOwn(record, key)).map(key => [key, restore(record[key])]))
  }
  return restore(parsed)
}
export function storedJson(value: unknown, limit = BODY_LIMIT): string {
  const prepare = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(prepare)
    if (!item || typeof item !== 'object') return item
    const record = item as Record<string, unknown>
    if (Object.hasOwn(record, '__codeflow_keys')) throw new StorageContractError('Reserved storage metadata key')
    const keys = Object.keys(record).filter(key => record[key] !== undefined)
    return { ...Object.fromEntries(keys.map(key => [key, prepare(record[key])])), __codeflow_keys: keys }
  }
  return json(prepare(JSON.parse(json(value, limit))), limit)
}
const excluded = new Set(['id', 'ownerId', 'status', 'createdAt', 'updatedAt', 'entries', 'selfTestArtifacts', 'selfTests', 'automationRuns', 'acceptanceHistory', 'acceptanceSelectionHistory', 'modelHistory'])
export function taskState(task: CodingTask): Record<string, unknown> {
  const state = Object.fromEntries(Object.entries(task).filter(([key, value]) => !excluded.has(key) && value !== undefined))
  const collections: Record<string, unknown> = Object.fromEntries(['selfTests', 'selfTestArtifacts', 'automationRuns', 'modelHistory', 'acceptanceHistory', 'acceptanceSelectionHistory'].map(key => [key, task[key as keyof CodingTask] === undefined ? false : task[key as keyof CodingTask] === null ? null : true]))
  if (Object.keys(collections).length) {
    if (task.selfTests) {
      collections.caseIds = task.selfTests.map(test => test.id)
      collections.caseKeys = Object.fromEntries(task.selfTests.map(test => [test.id, Object.keys(JSON.parse(json(test)))]))
    }
    if (task.automationRuns) collections.browserCaseIds = task.automationRuns.map(run => run.caseId)
    state._collections = collections
  }
  return state
}
export function validateState(state: unknown): asserts state is Record<string, unknown> {
  object(state)
  if (Object.keys(state).some(key => excluded.has(key) || ['owner_id', 'row_version', 'rowVersion', 'created_at', 'updated_at'].includes(key))) throw new StorageContractError('State contains authoritative columns or histories')
  for (const key of ['repository', 'instruction', 'prdName']) if (typeof state[key] !== 'string') throw new StorageContractError(`Invalid state ${key}`)
  if (!Array.isArray(state.designNames) || !state.designNames.every(item => typeof item === 'string')) throw new StorageContractError('Invalid design names')
  for (const key of ['confirmedDecisions', 'checks', 'acceptanceBaseline', 'changes']) if (state[key] !== undefined && !Array.isArray(state[key])) throw new StorageContractError(`Invalid state ${key}`)
  if (state.acceptanceBaseline !== undefined) validateBaseline(state.acceptanceBaseline)
  if (state.acceptanceAssessment !== undefined) validateAssessment(state.acceptanceAssessment)
  if (state.executionAssessment !== undefined) validateAssessment(state.executionAssessment)
  if (state.acceptanceSelection !== undefined) validateSelection(state.acceptanceSelection)
  if (state.testExecutionPlan !== undefined) validatePlan(state.testExecutionPlan)
  if (state.modelTurn !== undefined) {
    object(state.modelTurn)
    if (!['running', 'completed', 'failed', 'timed_out', 'interrupted'].includes(String(state.modelTurn.status))) throw new StorageContractError('Invalid model turn')
  }
  json(state, STATE_LIMIT)
}
export function validateTask(task: CodingTask): void {
  identifier(task.id); timestamp(task.createdAt); timestamp(task.updatedAt)
  if (!statuses.includes(task.status)) throw new StorageContractError('Invalid task status')
  if (task.ownerId !== undefined) positive(task.ownerId)
  validateState(taskState(task))
  if (!Array.isArray(task.entries)) throw new StorageContractError('Invalid entries')
  task.entries.forEach(validateEntry)
  task.selfTestArtifacts?.forEach(validateArtifact)
  task.selfTests?.forEach(validateCase)
}
export function validateEntry(entry: TaskEntry): void {
  object(entry); timestamp(entry.at)
  if (!['info', 'agent', 'answer', 'warning', 'error'].includes(entry.kind) || typeof entry.text !== 'string' || entry.text.length > 3000 || (entry.detail !== undefined && (typeof entry.detail !== 'string' || entry.detail.length > 8000))) throw new StorageContractError('Invalid event')
  if (entry.stage !== undefined && !statuses.includes(entry.stage)) throw new StorageContractError('Invalid event stage')
  if (entry.turnId !== undefined) identifier(entry.turnId)
  if (entry.toolCallId !== undefined) string(entry.toolCallId)
}
export function validateCase(test: SelfTestCase): void {
  object(test); identifier(test.id)
  for (const key of ['title', 'source', 'steps', 'expected'] as const) if (typeof test[key] !== 'string') throw new StorageContractError('Invalid case definition')
  if (!['pending', 'running', 'passed', 'failed', 'manual', 'skipped', 'invalid'].includes(test.status)) throw new StorageContractError('Invalid case status')
  if (test.evidenceInputFingerprint !== undefined) fingerprint(test.evidenceInputFingerprint)
  json(test)
}
export function validateArtifact(artifact: SelfTestArtifact): void {
  object(artifact); identifier(artifact.id); positive(artifact.revision); timestamp(artifact.createdAt)
  if (artifact.schemaVersion !== 1 || !['baseline', 'generation', 'review', 'browser'].includes(artifact.phase) || !['running', 'complete', 'failed', 'blocked'].includes(artifact.status)) throw new StorageContractError('Invalid artifact discriminant')
  fingerprint(artifact.inputFingerprint); string(artifact.scope, 1024 * 1024); string(artifact.model); string(artifact.rulesVersion, 64)
  if (!Array.isArray(artifact.inputRefs) || !artifact.inputRefs.every(ref => typeof ref === 'string')) throw new StorageContractError('Invalid artifact references')
  if (artifact.sessionId !== undefined) string(artifact.sessionId)
  if (artifact.finishedAt !== undefined) timestamp(artifact.finishedAt)
  if (artifact.status !== 'running' && !artifact.finishedAt) throw new StorageContractError('Final artifact needs finish time')
  if (artifact.output !== undefined) {
    object(artifact.output)
    if (artifact.output.cases !== undefined) {
      if (!Array.isArray(artifact.output.cases)) throw new StorageContractError('Invalid artifact cases')
      artifact.output.cases.forEach(validateCase)
    }
    if (artifact.output.assessment !== undefined) validateAssessment(artifact.output.assessment)
    if (artifact.output.baseline !== undefined) validateBaseline(artifact.output.baseline)
    if (artifact.output.content !== undefined && typeof artifact.output.content !== 'string') throw new StorageContractError('Invalid browser output')
    const allowed = { baseline: ['baseline', 'content', 'writtenFiles'], generation: ['cases', 'writtenFiles', 'coverage', 'content'], review: ['assessment', 'content', 'writtenFiles'], browser: ['content', 'writtenFiles'] }
    if (Object.keys(artifact.output).some(key => !allowed[artifact.phase].includes(key))) throw new StorageContractError('Artifact output does not match phase')
  }
  json(artifact)
}
function validateBaseline(value: unknown): void {
  if (!Array.isArray(value)) throw new StorageContractError('Invalid baseline')
  for (const requirement of value) {
    object(requirement); identifier(requirement.id)
    if (typeof requirement.source !== 'string' || typeof requirement.criterion !== 'string' || typeof requirement.required !== 'boolean' || !Array.isArray(requirement.scenarios) || !requirement.scenarios.every(item => ['normal', 'boundary', 'negative', 'permission', 'state'].includes(String(item)))) throw new StorageContractError('Invalid requirement')
  }
}
function validateSelection(value: unknown): void {
  object(value)
  if (value.mode !== 'custom' || typeof value.reason !== 'string' || !Array.isArray(value.caseIds) || !value.caseIds.every(item => typeof item === 'string')) throw new StorageContractError('Invalid selection')
  timestamp(value.confirmedAt)
}
function validatePlan(value: unknown): void {
  object(value)
  if (value.version !== 1 || !Array.isArray(value.cases)) throw new StorageContractError('Invalid execution plan')
  timestamp(value.createdAt)
  if (value.inputFingerprint !== undefined) fingerprint(value.inputFingerprint)
  for (const item of value.cases) {
    object(item); identifier(item.caseId)
    if (typeof item.selected !== 'boolean' || !['blocking', 'advisory'].includes(String(item.gatePolicy)) || typeof item.reason !== 'string') throw new StorageContractError('Invalid planned case')
  }
}
function validateAssessment(value: unknown): void {
  object(value)
  if (!['qualified', 'rejected'].includes(String(value.status)) || !['issues', 'coveredIds', 'missingIds'].every(key => Array.isArray(value[key]) && value[key].every(item => typeof item === 'string'))) throw new StorageContractError('Invalid assessment')
  timestamp(value.checkedAt)
  if (value.readiness !== undefined && !['checking', 'ready', 'blocked', 'unknown'].includes(value.readiness as string)) throw new StorageContractError('Invalid assessment readiness')
  if (value.inputFingerprint !== undefined) fingerprint(value.inputFingerprint)
  const ids = (items: unknown): string[] => {
    if (!Array.isArray(items) || items.length > 1000) throw new StorageContractError('Invalid assessment case IDs')
    items.forEach(identifier)
    if (new Set(items).size !== items.length) throw new StorageContractError('Duplicate assessment case IDs')
    return items
  }
  const scope = value.caseIds === undefined ? undefined : new Set(ids(value.caseIds))
  const caseId = (id: unknown) => {
    identifier(id)
    if (scope && !scope.has(id)) throw new StorageContractError('Assessment case ID outside scope')
  }
  if (value.caseIssues !== undefined) {
    if (!Array.isArray(value.caseIssues) || value.caseIssues.length > 10000) throw new StorageContractError('Invalid assessment case issues')
    for (const issue of value.caseIssues) {
      object(issue); caseId(issue.caseId); string(issue.message, 2000)
      if (!issue.message.trim()) throw new StorageContractError('Empty assessment case issue')
    }
  }
  if (value.findings !== undefined) {
    if (!Array.isArray(value.findings) || value.findings.length > 10000) throw new StorageContractError('Invalid assessment findings')
    for (const finding of value.findings) {
      object(finding); identifier(finding.code); string(finding.message, 2000)
      if (Object.keys(finding).some(key => !['code', 'category', 'message', 'caseIds'].includes(key)) || !reviewFindingCategories.includes(finding.category as typeof reviewFindingCategories[number]) || !finding.message.trim()) throw new StorageContractError('Invalid review finding')
      ids(finding.caseIds).forEach(caseId)
    }
  }
  if (value.caseReviews !== undefined) {
    if (!Array.isArray(value.caseReviews) || value.caseReviews.length > 1000) throw new StorageContractError('Invalid case reviews')
    const seen = new Set<string>()
    for (const review of value.caseReviews) {
      object(review); caseId(review.caseId)
      if (!caseReviewStatuses.includes(review.status as typeof caseReviewStatuses[number]) || seen.has(review.caseId as string)) throw new StorageContractError('Invalid case review')
      seen.add(review.caseId as string)
    }
  }
}
export function validateFile(file: FileRecord): void {
  if (!['prd', 'design', 'evidence', 'test', 'session_manifest'].includes(file.kind)) throw new StorageContractError('Invalid file kind')
  string(file.storageKey, 512)
  if (file.storageKey.includes('\\') || file.storageKey.startsWith('/') || file.storageKey.includes(':') || file.storageKey.split('/').some(part => !part || part === '.' || part === '..') || [...file.storageKey].some(character => character.charCodeAt(0) < 32)) throw new StorageContractError('Unsafe storage key')
  if (file.sha256 !== undefined) fingerprint(file.sha256)
  if (file.sizeBytes !== undefined && (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0)) throw new StorageContractError('Invalid file size')
  if (file.createdAt !== undefined) timestamp(file.createdAt)
  object(file.metadata); json(file.metadata)
}
export function validateUsage(usage: UsageRecord): void {
  if (usage.turnId !== undefined) identifier(usage.turnId)
  if (usage.model !== undefined) string(usage.model)
  string(usage.sessionId); string(usage.phase, 24); string(usage.sourceEventId); timestamp(usage.observedAt)
  if (usage.artifactId !== undefined) identifier(usage.artifactId)
  object(usage.body); json(usage.body)
  if (!['incremental', 'cumulative', 'reuse'].includes(String(usage.body.counting ?? usage.body.kind ?? usage.body.basis ?? usage.body.measurement))) throw new StorageContractError('Usage needs incremental/cumulative/reuse basis')
}
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right) }
export function caseDefinition(test: SelfTestCase): CaseDefinition {
  const definition = Object.fromEntries(Object.entries(test).filter(([key]) => !['id', 'status', 'output', 'startedAt', 'finishedAt', 'evidenceInputFingerprint'].includes(key)))
  return { id: test.id, definition, fingerprint: hash(json(definition)) }
}
function snapshot(kind: SnapshotKind, value: unknown, at: string): Snapshot {
  return { id: randomUUID(), kind, createdAt: at, body: { value } }
}
export function diffTask(before: CodingTask | undefined, after: CodingTask, expectedVersion: number): TaskChange {
  validateTask(after)
  const change: TaskChange = {
    id: after.id, expectedVersion, create: !before,
    header: { ownerId: after.ownerId, status: after.status, createdAt: after.createdAt, updatedAt: after.updatedAt },
    events: [], artifacts: [], cases: [], runs: [], snapshots: [], files: [], usage: [],
  }
  const state = taskState(after)
  if (!before || !same(taskState(before), state)) change.state = state
  const previousEntries = before?.entries ?? []
  let overlap = Math.min(previousEntries.length, after.entries.length)
  while (overlap && !same(previousEntries.slice(-overlap), after.entries.slice(0, overlap))) overlap--
  change.events = after.entries.slice(overlap)
  const previousArtifacts = new Map(before?.selfTestArtifacts?.map(artifact => [artifact.id, artifact]))
  for (const artifact of after.selfTestArtifacts ?? []) {
    const previous = previousArtifacts.get(artifact.id)
    if (same(previous, artifact)) continue
    if (previous && previous.status !== 'running') throw new StorageContractError('Final artifacts are immutable')
    if (previous && (previous.phase !== artifact.phase || previous.scope !== artifact.scope || previous.inputFingerprint !== artifact.inputFingerprint || previous.revision !== artifact.revision || !same(previous.inputRefs, artifact.inputRefs))) throw new StorageContractError('Artifact identity is immutable')
    change.artifacts.push(artifact)
  }
  const oldCases = new Map(before?.selfTests?.map(test => [test.id, test]))
  const ids = after.selfTests?.map(test => test.id) ?? []
  if (new Set(ids).size !== ids.length) throw new StorageContractError('Duplicate case IDs')
  if (!same(before?.selfTests?.map(test => test.id) ?? [], ids)) change.caseOrder = ids
  for (const test of after.selfTests ?? []) {
    const previous = oldCases.get(test.id)
    if (!previous || !same(caseDefinition(previous), caseDefinition(test))) change.cases.push(caseDefinition(test))
    const execution = (value: SelfTestCase) => ({ status: value.status, output: value.output, startedAt: value.startedAt, finishedAt: value.finishedAt, evidenceInputFingerprint: value.evidenceInputFingerprint })
    if ((!previous && test.status === 'pending' && !test.output) || (previous && same(execution(previous), execution(test)))) continue
    const terminal = !['pending', 'running'].includes(test.status)
    const continuation = previous?.status === 'running' && !previous.finishedAt && test.status !== 'pending' && (terminal || (previous.startedAt === test.startedAt && previous.evidenceInputFingerprint === test.evidenceInputFingerprint)) && same(caseDefinition(previous), caseDefinition(test)) && same(before?.testExecutionPlan, after.testExecutionPlan)
    change.runs.push({ id: randomUUID(), caseId: test.id, executor: 'test', status: test.status, startedAt: test.startedAt, finishedAt: test.finishedAt, inputFingerprint: test.evidenceInputFingerprint, continuation, ...(continuation ? { continuationFrom: { startedAt: previous.startedAt, inputFingerprint: previous.evidenceInputFingerprint } } : {}), body: execution(test) })
  }
  for (let index = 0; index < (after.automationRuns?.length ?? 0); index++) {
    const run = after.automationRuns![index]
    const previous = before?.automationRuns?.find(item => item.caseId === run.caseId)
    if (same(previous, run)) continue
    const oldCase = oldCases.get(run.caseId)
    const currentCase = after.selfTests?.find(item => item.id === run.caseId)
    const terminal = !['running', 'generating'].includes(run.status)
    const continuation = !!previous && !previous.finishedAt && ['running', 'generating'].includes(previous.status) && (terminal || (previous.startedAt === run.startedAt && (previous.status === 'generating' || previous.inputFingerprint === run.inputFingerprint))) && same(oldCase && caseDefinition(oldCase), currentCase && caseDefinition(currentCase)) && same(before?.testExecutionPlan, after.testExecutionPlan)
    change.runs.push({ id: randomUUID(), caseId: run.caseId, executor: 'browser', status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt, inputFingerprint: run.inputFingerprint, continuation, ...(continuation ? { continuationFrom: { startedAt: previous.startedAt, inputFingerprint: previous.inputFingerprint } } : {}), body: { ...run, projectionIndex: index } })
  }
  const current = { acceptanceBaseline: 'baseline', acceptanceAssessment: 'default_review', executionAssessment: 'scoped_review', testExecutionPlan: 'execution_plan', acceptanceSelection: 'selection' } as const
  for (const [field, kind] of Object.entries(current) as [keyof typeof current, SnapshotKind][]) {
    if (!same(before?.[field], after[field])) change.snapshots.push(snapshot(kind, after[field] ?? null, after.updatedAt))
  }
  for (const value of after.acceptanceHistory?.slice(before?.acceptanceHistory?.length ?? 0) ?? []) change.snapshots.push(snapshot('acceptance_history', value, value.at))
  for (const value of after.acceptanceSelectionHistory?.slice(before?.acceptanceSelectionHistory?.length ?? 0) ?? []) change.snapshots.push({ ...snapshot('selection', value, value.confirmedAt), body: { value, history: true } })
  for (let index = 0; index < (after.modelHistory?.length ?? 0); index++) {
    const value = after.modelHistory![index]
    if (!same(before?.modelHistory?.[index], value)) change.events.push({ at: value.at, kind: 'info', text: 'Model selection changed', modelChange: value, modelIndex: index } as TaskEntry)
  }
  return structuredClone(change)
}
export function validateChange(change: TaskChange): void {
  identifier(change.id)
  if (!Number.isSafeInteger(change.expectedVersion) || change.expectedVersion < 0 || (!!change.create !== (change.expectedVersion === 0))) throw new StorageContractError('Invalid expected version')
  if (!statuses.includes(change.header.status)) throw new StorageContractError('Invalid task status')
  timestamp(change.header.createdAt); timestamp(change.header.updatedAt)
  if (change.header.ownerId !== undefined) positive(change.header.ownerId)
  if (change.state !== undefined) { validateState(change.state); validateState(JSON.parse(json(change.state, STATE_LIMIT))) }
  if (change.create && !change.state) throw new StorageContractError('New task requires state')
  change.events.forEach(entry => { validateEntry(entry); validateEntry(JSON.parse(json(entry))) })
  change.artifacts.forEach(artifact => { validateArtifact(artifact); validateArtifact(JSON.parse(json(artifact))) })
  change.files.forEach(file => { validateFile(file); validateFile({ ...file, metadata: JSON.parse(json(file.metadata)) }) })
  change.usage.forEach(usage => { validateUsage(usage); validateUsage({ ...usage, body: JSON.parse(json(usage.body)) }) })
  if (change.caseOrder !== undefined) {
    if (!Array.isArray(change.caseOrder)) throw new StorageContractError('Invalid case order')
    for (const caseId of change.caseOrder) identifier(caseId)
    if (new Set(change.caseOrder).size !== change.caseOrder.length) throw new StorageContractError('Duplicate case IDs')
  }
  for (const item of change.cases) {
    identifier(item.id); object(item.definition); fingerprint(item.fingerprint)
    validateCase({ ...item.definition, id: item.id, status: 'pending' } as SelfTestCase)
    const serialized = json(item.definition)
    const definition: unknown = JSON.parse(serialized)
    object(definition)
    validateCase({ ...definition, id: item.id, status: 'pending' } as SelfTestCase)
    if (hash(serialized) !== item.fingerprint) throw new StorageContractError('Case fingerprint mismatch')
  }
  for (const run of change.runs) {
    identifier(run.id); identifier(run.caseId)
    if (!['test', 'browser'].includes(run.executor) || !['pending', 'generating', 'running', 'passed', 'failed', 'manual', 'skipped', 'invalid', 'blocked'].includes(run.status)) throw new StorageContractError('Invalid run')
    if (run.inputFingerprint !== undefined) fingerprint(run.inputFingerprint)
    if (run.continuationFrom !== undefined) {
      object(run.continuationFrom)
      if (run.continuation !== true) throw new StorageContractError('Continuation identity needs continuation')
      if (run.continuationFrom.startedAt !== undefined) timestamp(run.continuationFrom.startedAt)
      if (run.continuationFrom.inputFingerprint !== undefined) fingerprint(run.continuationFrom.inputFingerprint)
    }
    object(run.body); object(JSON.parse(json(run.body)))
  }
  for (const item of change.snapshots) { identifier(item.id); timestamp(item.createdAt); if (!['baseline', 'default_review', 'scoped_review', 'execution_plan', 'selection', 'acceptance_history'].includes(item.kind)) throw new StorageContractError('Invalid snapshot'); object(item.body); object(JSON.parse(json(item.body))) }
}