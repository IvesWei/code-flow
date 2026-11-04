import assert from 'node:assert/strict'
import { test } from 'node:test'
import { batches, missingCoverage, testPlanPolicy } from './test-plan-policy.js'
import type { AcceptanceRequirement, SelfTestCase } from '../../shared/task.js'

test('planning limits are configurable, bounded and never silently accept invalid values', () => {
  assert.deepEqual(testPlanPolicy({}), { batchSize: 8, maxCases: 300, optionalMaxCases: 16 })
  assert.deepEqual(testPlanPolicy({ SELF_TEST_MAX_CASES: '5', SELF_TEST_BATCH_SIZE: '8' }), { batchSize: 5, maxCases: 5, optionalMaxCases: 16 })
  assert.equal(testPlanPolicy({ SELF_TEST_OPTIONAL_MAX_CASES: '0' }).optionalMaxCases, 0)
  assert.throws(() => testPlanPolicy({ SELF_TEST_OPTIONAL_MAX_CASES: '-1' }))
  for (const value of ['0', '-1', '1001', 'no']) assert.throws(() => testPlanPolicy({ SELF_TEST_MAX_CASES: value }), /SELF_TEST_MAX_CASES/)
  assert.throws(() => testPlanPolicy({ SELF_TEST_BATCH_SIZE: '21' }), /SELF_TEST_BATCH_SIZE/)
  assert.deepEqual(batches([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
})

test('coverage planning follows applicable scenarios and ignores invalid evidence', () => {
  const baseline: AcceptanceRequirement[] = [{ id: 'REQ-001', source: 'PRD', criterion: '保存', required: true, scenarios: ['normal', 'negative', 'boundary'] }]
  const valid: SelfTestCase = { id: 'TC-01', title: '保存', source: 'PRD', steps: '保存后查询', expected: '一致', status: 'passed', requirementIds: ['REQ-001'], scenario: 'normal', preconditions: '独立环境', testData: '数据', assertions: ['查询一致'], cleanup: '删除数据' }
  assert.deepEqual(missingCoverage(baseline, [valid]).map((item) => item.scenario), ['negative', 'boundary'])
  assert.equal(missingCoverage(baseline, [{ ...valid, assertions: [] }]).length, 3)
  const optional = { ...baseline[0], id: 'REQ-002', required: false }
  assert.equal(missingCoverage([...baseline, optional], [valid]).length, 2)
  assert.equal(missingCoverage([...baseline, optional], [valid], 'optional').length, 3)
})