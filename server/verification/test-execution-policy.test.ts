import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AcceptanceRequirement, SelfTestCase } from '../../shared/task.js'
import { casePolicy, createExecutionPlan, executionSummary, requestedCaseIds } from '../../shared/test-policy.js'

const baseline: AcceptanceRequirement[] = [
  { id: 'REQ-001', source: 'SLA', criterion: 'P95 meets SLA', required: true, scenarios: ['normal'] },
  { id: 'REQ-002', source: 'Recommendation', criterion: 'Explore maximum throughput', required: false, scenarios: ['normal'] },
]
const performance: SelfTestCase = {
  id: 'TC-01', title: 'Load', source: 'SLA', steps: 'Run load', expected: 'Threshold met', status: 'pending', requirementIds: ['REQ-001'],
  classification: { testType: 'performance', tags: ['load'], priority: 'P3', riskReason: 'Capacity risk', executionPolicy: 'on_demand' },
}

test('required performance cannot be downgraded by priority or execution suggestion', () => {
  assert.equal(casePolicy(baseline, performance).selected, true)
  assert.equal(casePolicy(baseline, performance).gatePolicy, 'blocking')
  assert.equal(casePolicy(baseline, { ...performance, requirementIds: ['REQ-999'] }).gatePolicy, 'blocking')
  assert.equal(casePolicy(baseline, { ...performance, requirementIds: ['REQ-001', 'REQ-002'] }).gatePolicy, 'blocking')
})

test('optional performance is not selected and cannot count as passed', () => {
  const optional = { ...performance, id: 'TC-02', requirementIds: ['REQ-002'] }
  const cases = [{ ...performance, status: 'passed' as const }, optional]
  const plan = createExecutionPlan(baseline, cases)
  assert.equal(plan.cases[1].selected, false)
  assert.equal(plan.cases[1].gatePolicy, 'advisory')
  assert.deepEqual(executionSummary(cases, plan), { blockingTotal: 1, blockingPassed: 1, advisoryFailed: 0, advisoryUnverified: 1, notSelected: 1, qualified: true })
  assert.equal(executionSummary([{ ...performance, status: 'manual' }], createExecutionPlan(baseline, [performance])).qualified, false)
})

test('legacy cases remain blocking and advisory failures stay visible without blocking', () => {
  assert.equal(casePolicy(baseline, { ...performance, requirementIds: ['REQ-002'], classification: undefined }).gatePolicy, 'blocking')
  const cases = [{ ...performance, status: 'passed' as const }, { ...performance, id: 'TC-02', requirementIds: ['REQ-002'], status: 'failed' as const, classification: { ...performance.classification!, executionPolicy: 'always' as const } }]
  const summary = executionSummary(cases, createExecutionPlan(baseline, cases))
  assert.equal(summary.advisoryFailed, 1)
  assert.equal(summary.qualified, true)
  assert.equal(executionSummary([cases[1]], createExecutionPlan(baseline, [cases[1]])).qualified, false)
})

test('explicit selection adds optional execution without changing its gate or removing mandatory cases', () => {
  const optional = { ...performance, id: 'TC-02', requirementIds: ['REQ-002'] }
  const plan = createExecutionPlan(baseline, [performance, optional], ['TC-02'])
  assert.equal(plan.cases[0].selected, true)
  assert.equal(plan.cases[1].selected, true)
  assert.equal(plan.cases[1].gatePolicy, 'advisory')
  assert.match(plan.cases[1].reason, /用户显式/)
  assert.deepEqual(requestedCaseIds(['TC-02'], [optional]), ['TC-02'])
  assert.throws(() => requestedCaseIds(['TC-99'], [optional]))
  assert.throws(() => requestedCaseIds(['TC-02', 'TC-02'], [optional]))
  assert.throws(() => requestedCaseIds(['TC-02'], [{ ...optional, status: 'passed' }]))
})