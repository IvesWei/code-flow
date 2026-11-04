import assert from 'node:assert/strict'
import test from 'node:test'
import type { AcceptanceRequirement } from '../../shared/task.js'
import { validatePlanningCase, replacePlanningCase } from './planning-case.js'
import { PlanningError } from './planning-model.js'

const baseline: AcceptanceRequirement[] = [{ id: 'REQ-001', source: 'PRD', criterion: 'Persist name', required: true, scenarios: ['normal'] }]
const definition = { id: 'TC-1', title: 'Save name', source: 'PRD', steps: 'Save and reload', expected: 'Saved name', requirementIds: ['REQ-001'], scenario: 'normal' as const, preconditions: 'Account exists', testData: 'New name', assertions: ['Name persists'], cleanup: 'Restore name' }

test('single case definitions reject unknown/runtime fields, changed IDs and invalid design fields', () => {
  assert.deepEqual(validatePlanningCase(definition, 'TC-1', baseline), definition)
  for (const patch of [{ id: 'TC-2' }, { status: 'passed' }, { testFile: 'test.ts' }, { unexpected: true }, { assertions: [] }, { assertions: ['x', 'x'] }, { requirementIds: ['REQ-999'] }, { scenario: 'negative' }, { title: ' ' }, { cleanup: 'x'.repeat(2001) }, { classification: { testType: 'functional' } }]) {
    assert.throws(() => validatePlanningCase({ ...definition, ...patch }, 'TC-1', baseline), error => error instanceof PlanningError && error.code === 'INVALID_INPUT')
  }
})

test('replacement preserves order and baseline and invalidates every review scope', () => {
  const sibling = { ...definition, id: 'TC-2' }
  const draft = { baseline, cases: [definition, sibling], sourceFingerprint: 'source', assessment: { status: 'qualified' as const, issues: [], checkedAt: '', coveredIds: [], missingIds: [] }, reviewBatches: [], customReview: { caseIds: ['TC-1'], reason: 'Review', definitionFingerprint: '', batches: [] } }
  const changed = replacePlanningCase(draft, 'TC-1', { ...definition, title: 'Updated' })
  assert.deepEqual(changed.cases[1], sibling)
  assert.deepEqual(changed.baseline, baseline)
  assert.equal(changed.sourceFingerprint, 'source')
  assert.equal(changed.assessment, undefined)
  assert.equal(changed.customReview, undefined)
  assert.deepEqual(changed.reviewBatches, [])
  assert.match(changed.definitionFingerprint!, /^[a-f0-9]{64}$/)
  assert.equal(draft.cases[0].title, 'Save name')
})