import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AcceptanceAssessment, CodingTask, SelfTestArtifact } from '../../shared/task.js'
import { BODY_LIMIT, STATE_LIMIT, StorageContractError, decode, diffTask, hash, json, storedJson, taskState, validateArtifact, validateChange, validateFile, validateState, validateUsage } from './contracts.js'
import type { TaskChange } from './contracts.js'

export function fixture(): CodingTask {
  return { id: 'task', repository: 'repo', instruction: 'test', prdName: 'prd.md', designNames: [], status: 'REVIEW', createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z', entries: [] }
}

const reviewAssessment: AcceptanceAssessment = {
  status: 'rejected', checkedAt: '2026-10-16T00:00:00.000Z', issues: ['coverage warning'], coveredIds: [], missingIds: ['REQ-001'],
  findings: [{ code: 'missing_coverage', category: 'coverage', message: 'coverage warning', caseIds: [] }],
  caseReviews: [{ caseId: 'TC-1', status: 'warning' }], readiness: 'ready', inputFingerprint: 'a'.repeat(64),
}

function reviewArtifact(assessment: unknown): SelfTestArtifact {
  return { id: 'artifact', revision: 1, schemaVersion: 1, phase: 'review', scope: 'custom', inputFingerprint: 'a'.repeat(64), inputRefs: [], status: 'complete', createdAt: fixture().createdAt, finishedAt: fixture().createdAt, model: 'model', rulesVersion: 'review-v1', output: { assessment: assessment as AcceptanceAssessment } }
}

test('review contract persists optional fields and legacy assessments in state and artifacts', () => {
  const legacy = { status: 'qualified', checkedAt: fixture().createdAt, issues: [], coveredIds: [], missingIds: [] }
  for (const assessment of [legacy, reviewAssessment]) {
    assert.doesNotThrow(() => validateState({ ...taskState(fixture()), acceptanceAssessment: assessment, executionAssessment: { ...assessment, caseIds: ['TC-1'] } }))
    assert.doesNotThrow(() => validateArtifact(reviewArtifact(assessment)))
    assert.deepEqual(decode(storedJson(assessment)), assessment)
  }
  for (const status of ['unreviewed', 'reviewing', 'qualified', 'warning', 'rejected', 'unknown']) {
    assert.doesNotThrow(() => validateArtifact(reviewArtifact({ ...reviewAssessment, caseReviews: [{ caseId: 'TC-1', status }] })))
  }
  for (const readiness of ['checking', 'ready', 'blocked', 'unknown']) {
    assert.doesNotThrow(() => validateArtifact(reviewArtifact({ ...reviewAssessment, readiness })))
  }
  for (const category of ['coverage', 'quality', 'executability', 'conflict', 'safety']) {
    assert.doesNotThrow(() => validateArtifact(reviewArtifact({ ...reviewAssessment, findings: [{ ...reviewAssessment.findings![0], category }] })))
  }
})

test('review optional fields reject malformed enums, identifiers, lengths and fingerprints at both boundaries', () => {
  const finding = reviewAssessment.findings![0]
  const invalid: unknown[] = [
    { readiness: 'qualified' }, { readiness: null }, { inputFingerprint: 'legacy' }, { inputFingerprint: 'A'.repeat(64) },
    { findings: {} }, { findings: [null] }, { findings: [{ ...finding, code: '' }] }, { findings: [{ ...finding, code: 'x'.repeat(65) }] },
    { findings: [{ ...finding, category: 'unknown' }] }, { findings: [{ ...finding, message: '  ' }] }, { findings: [{ ...finding, message: 'x'.repeat(2001) }] },
    { findings: [{ ...finding, blocking: false }] }, { findings: [{ ...finding, caseIds: 'TC-1' }] },
    ...['', 'has space', 'x'.repeat(65)].map(id => ({ findings: [{ ...finding, caseIds: [id] }] })),
    { findings: [{ ...finding, caseIds: ['TC-1', 'TC-1'] }] }, { findings: [{ ...finding, caseIds: Array.from({ length: 1001 }, (_, index) => `TC-${index}`) }] },
    { caseReviews: {} }, { caseReviews: [null] }, { caseReviews: [{ caseId: 'TC-1', status: 'ready' }] },
    { caseReviews: [{ caseId: 'TC-1', status: 'qualified' }, { caseId: 'TC-1', status: 'unknown' }] },
    ...['', 'has space', 'x'.repeat(65)].map(caseId => ({ caseReviews: [{ caseId, status: 'qualified' }] })),
    { caseReviews: Array.from({ length: 1001 }, (_, index) => ({ caseId: `TC-${index}`, status: 'unknown' })) },
    { caseIds: ['TC-2'] }, { caseIds: ['TC-1', 'TC-1'] }, { caseIssues: [{ caseId: '', message: 'bad' }] },
    { caseIssues: [{ caseId: 'TC-1', message: 'x'.repeat(2001) }] },
  ]
  for (const fields of invalid) {
    const assessment = { ...reviewAssessment, ...fields as object }
    assert.throws(() => validateState({ ...taskState(fixture()), executionAssessment: assessment }), StorageContractError, JSON.stringify(fields))
    assert.throws(() => validateArtifact(reviewArtifact(assessment)), StorageContractError, JSON.stringify(fields))
  }
})

test('serialized review artifacts cannot bypass assessment validation', () => {
  const change = diffTask(undefined, fixture(), 0)
  const assessment = { ...reviewAssessment, toJSON: () => ({ ...reviewAssessment, readiness: 'invalid' }) }
  change.artifacts = [reviewArtifact(assessment)]
  assert.throws(() => validateChange(change), StorageContractError)
})
test('event-only delta excludes all state and unchanged collections', () => {
  const before = fixture()
  const after = structuredClone(before)
  after.entries.push({ at: before.createdAt, kind: 'info', text: 'hello' })
  const change = diffTask(before, after, 1)
  validateChange(change)
  assert.equal(change.state, undefined)
  assert.equal(change.events.length, 1)
  assert.deepEqual(change.cases, [])
  assert.deepEqual(change.snapshots, [])
  assert.deepEqual(change.artifacts, [])
})
test('state rejects authoritative/history fields, bad discriminants and oversized UTF8', () => {
  assert.throws(() => validateState({ ...taskState(fixture()), entries: [] }))
  assert.throws(() => validateState({ ...taskState(fixture()), instruction: '\u4e2d'.repeat(400000) }))
  assert.throws(() => diffTask(undefined, { ...fixture(), status: 'UNKNOWN' } as unknown as CodingTask, 0))
})
test('file keys and usage have explicit runtime contracts', () => {
  assert.throws(() => validateFile({ kind: 'evidence', storageKey: '../secret', metadata: {} }))
  assert.throws(() => validateUsage({ turnId: 'turn', sessionId: 'session', model: 'model', phase: 'coding', sourceEventId: 'event', observedAt: fixture().createdAt, body: {} }))
  validateFile({ kind: 'evidence', storageKey: 'evidence/task/screen.png', sizeBytes: 0, metadata: {} })
})
test('case definitions exclude executions and pending cases do not fabricate runs', () => {
  const after = { ...fixture(), selfTests: [{ id: 'TC-2', title: 'test', source: '', steps: '', expected: '', status: 'pending' as const }] }
  const change = diffTask(undefined, after, 0)
  assert.equal(change.cases.length, 1)
  assert.equal(change.runs.length, 0)
  assert.equal(change.cases[0].definition.status, undefined)
  assert.deepEqual(change.caseOrder, ['TC-2'])
})
test('stored JSON restores object order after MySQL key reordering without leaking metadata', () => {
  const value = { z: 1, a: [{ title: 'test', id: 'TC-2', status: 'pending' }], optional: null }
  const reorder = (item: unknown): unknown => Array.isArray(item) ? item.map(reorder) : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)).map(([key, field]) => [key, reorder(field)])) : item
  const restored = decode(reorder(JSON.parse(storedJson(value))))
  assert.equal(JSON.stringify(restored), JSON.stringify(value))
})
test('ordered JSON encoding honors JSON values, dates, omitted keys and null array slots', () => {
  const value = { z: new Date('2026-10-15T00:00:00.000Z'), omitted: undefined, values: [undefined, null, { b: true, a: 'value' }], empty: {} }
  assert.equal(JSON.stringify(decode(storedJson(value))), JSON.stringify(value))
  const refs = [{ kind: 'workspace_fingerprint', value: 'a'.repeat(64) }]
  assert.ok(Array.isArray(JSON.parse(storedJson(refs))))
  assert.deepEqual(decode(storedJson(refs)), refs)
  assert.throws(() => storedJson({ nested: { __codeflow_keys: [] } }), /Reserved/)
})
test('change rejects non-object serialized row bodies including Date and toJSON replacements', () => {
  const at = fixture().createdAt
  const definition = { title: 'test', source: '', steps: '', expected: '' }
  const setters: Record<string, (change: TaskChange, body: Record<string, unknown>) => void> = {
    state: (change, body) => { change.state = Object.assign(body, taskState(fixture())) },
    event: (change, body) => { change.events = [Object.assign(body, { at, kind: 'info' as const, text: 'hello' })] },
    definition: (change, body) => {
      Object.assign(body, definition)
      change.cases = [{ id: 'TC-1', definition: body, fingerprint: hash(json(body)) }]
    },
    snapshot: (change, body) => { change.snapshots = [{ id: 'snapshot', kind: 'baseline', createdAt: at, body }] },
    run: (change, body) => { change.runs = [{ id: 'run', caseId: 'TC-1', executor: 'test', status: 'pending', body }] },
    file: (change, body) => { change.files = [{ kind: 'evidence', storageKey: 'evidence/task/file', metadata: body }] },
    usage: (change, body) => {
      Object.assign(body, { counting: 'incremental' })
      change.usage = [{ sessionId: 'session', phase: 'coding', sourceEventId: 'event', observedAt: at, body }]
    },
  }
  for (const [name, setBody] of Object.entries(setters)) {
    for (const body of [new Date(at), { toJSON: () => [] }, { toJSON: () => 'text' }, { toJSON: () => null }]) {
      const change = diffTask(undefined, fixture(), 0)
      setBody(change, body as unknown as Record<string, unknown>)
      assert.throws(() => validateChange(change), StorageContractError, name)
    }
  }
})
test('change validates original and serialized state keys, fields and limits', () => {
  const state = taskState(fixture())
  for (const key of ['id', 'ownerId', 'owner_id', 'status', 'createdAt', 'created_at', 'updatedAt', 'updated_at', 'rowVersion', 'row_version', 'entries', 'selfTestArtifacts', 'selfTests', 'automationRuns', 'acceptanceHistory', 'acceptanceSelectionHistory', 'modelHistory']) {
    const change = diffTask(undefined, fixture(), 0)
    change.state = { ...state, toJSON: () => ({ ...state, [key]: [] }) }
    assert.throws(() => validateChange(change), StorageContractError, key)
    change.state = { ...state, [key]: [], toJSON: () => state }
    assert.throws(() => validateChange(change), StorageContractError, `original ${key}`)
  }
  for (const replacement of [{ ...state, instruction: 1 }, { ...state, instruction: 'x'.repeat(STATE_LIMIT) }]) {
    const change = diffTask(undefined, fixture(), 0)
    change.state = { ...state, toJSON: () => replacement }
    assert.throws(() => validateChange(change), StorageContractError)
  }
  const change = diffTask(undefined, fixture(), 0)
  change.snapshots = [{ id: 'snapshot', kind: 'baseline', createdAt: fixture().createdAt, body: { toJSON: () => ({ text: 'x'.repeat(BODY_LIMIT) }) } }]
  assert.throws(() => validateChange(change), StorageContractError)
})
test('change rejects serialized invalid event, definition and usage fields', () => {
  const change = diffTask(undefined, fixture(), 0)
  const entry = { at: fixture().createdAt, kind: 'info' as const, text: 'hello' }
  change.events = [{ ...entry, toJSON: () => ({ ...entry, kind: 'invalid' }) } as typeof entry]
  assert.throws(() => validateChange(change), StorageContractError)
  change.events = []
  const definition = { title: 'test', source: '', steps: '', expected: '', toJSON: () => ({ title: 1, source: '', steps: '', expected: '' }) }
  change.cases = [{ id: 'TC-1', definition, fingerprint: hash(json(definition)) }]
  assert.throws(() => validateChange(change), StorageContractError)
  change.cases = []
  change.usage = [{ sessionId: 'session', phase: 'coding', sourceEventId: 'event', observedAt: fixture().createdAt, body: { counting: 'incremental', toJSON: () => ({ counting: 'invalid' }) } }]
  assert.throws(() => validateChange(change), StorageContractError)
})
test('direct case order requires unique valid identifiers', () => {
  const change = diffTask(undefined, fixture(), 0)
  for (const order of [['TC-1', 'TC-1'], [''], ['has space'], ['x'.repeat(65)], [undefined], 'TC-1']) {
    change.caseOrder = order as string[]
    assert.throws(() => validateChange(change), StorageContractError)
  }
  for (const order of [[], ['TC-2', 'TC-1']]) {
    change.caseOrder = order
    assert.doesNotThrow(() => validateChange(change))
  }
})
test('change preserves nested Date values, JSON order and explicit prompt bytes', () => {
  const change = diffTask(undefined, fixture(), 0)
  const prompt = '  explicit\r\nprompt\tbytes\n'
  const value = { z: new Date(fixture().createdAt), a: { toJSON: () => ({ second: 2, first: 1 }) }, prompt }
  change.state = { ...change.state, instruction: prompt, nested: value }
  change.events = [{ at: fixture().createdAt, kind: 'info', text: prompt, ...value }]
  change.cases = [{ id: 'TC-1', definition: { title: prompt, source: '', steps: '', expected: '', ...value }, fingerprint: '' }]
  change.cases[0].fingerprint = hash(json(change.cases[0].definition))
  change.snapshots = [{ id: 'snapshot', kind: 'baseline', createdAt: fixture().createdAt, body: value }]
  change.runs = [{ id: 'run', caseId: 'TC-1', executor: 'test', status: 'pending', body: value }]
  change.files = [{ kind: 'evidence', storageKey: 'evidence/task/file', metadata: value }]
  change.usage = [{ sessionId: 'session', phase: 'coding', sourceEventId: 'event', observedAt: fixture().createdAt, body: { counting: 'incremental', ...value } }]
  const before = json(change)
  validateChange(change)
  assert.equal(json(change), before)
  for (const body of [change.state, ...change.events, change.cases[0].definition, value, change.usage[0].body]) {
    assert.equal(json(decode(storedJson(body))), json(body))
  }
  assert.equal(change.state.instruction, prompt)
})