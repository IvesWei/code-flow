import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyExecutionReview, applyQualityReview, assessAcceptance, assessExecutionReadiness, parseAcceptanceBaseline } from './acceptance.js'
import type { SelfTestCase } from '../../shared/task.js'
import { mergeTestPlan } from './self-test.js'

const baseline = parseAcceptanceBaseline(JSON.stringify([{ id: 'REQ-001', source: 'PRD 保存', criterion: '保存后重新查询能返回相同数据', required: true, scenarios: ['normal', 'negative'] }]))
const normal: SelfTestCase = { id: 'TC-01', title: '保存', source: 'PRD 保存', steps: '保存后查询', expected: '数据一致', requirementIds: ['REQ-001'], scenario: 'normal', preconditions: '服务已启动', testData: '独立记录', assertions: ['查询数据等于提交数据'], cleanup: '删除测试记录', status: 'pending' }

test('structural review starts valid cases unreviewed and invalid cases rejected', () => {
  assert.deepEqual(assessAcceptance(baseline, [normal, { ...normal, id: 'TC-02', steps: '' }]).caseReviews, [{ caseId: 'TC-01', status: 'unreviewed' }, { caseId: 'TC-02', status: 'rejected' }])
})

test('execution readiness separates quality and coverage warnings from blockers', () => {
  const assessment = assessExecutionReadiness(baseline, [{ ...normal, source: '', requirementIds: [], scenario: undefined }])
  assert.equal(assessment.status, 'rejected')
  assert.equal(assessment.readiness, 'ready')
  assert.equal(assessment.caseReviews?.[0].status, 'unreviewed')
  assert.ok(assessment.findings?.some(item => item.category === 'coverage'))
  assert.ok(assessment.findings?.some(item => item.code === 'invalid_classification'))
  assert.equal(assessExecutionReadiness(baseline, [normal]).readiness, 'ready')
  assert.equal(assessExecutionReadiness(baseline, [{ ...normal, testFile: 'tests/save.test.ts' }]).readiness, 'ready')
  assert.equal(assessExecutionReadiness([], []).readiness, 'blocked')
})

test('design readiness blocks missing reproducibility but ignores test-file resources', () => {
  for (const field of ['title', 'steps', 'expected', 'preconditions', 'testData', 'cleanup'] as const) {
    assert.equal(assessExecutionReadiness(baseline, [{ ...normal, [field]: '  ' }]).readiness, 'blocked', field)
    assert.equal(assessExecutionReadiness(baseline, [{ ...normal, [field]: 'x'.repeat(2001) }]).readiness, 'ready', `format ${field}`)
  }
  for (const assertions of [[], [' ']]) assert.equal(assessExecutionReadiness(baseline, [{ ...normal, assertions }]).readiness, 'blocked')
  assert.equal(assessExecutionReadiness(baseline, [{ ...normal, assertions: ['', 'observe actual state'] }]).readiness, 'ready')
  assert.equal(assessExecutionReadiness(baseline, [{ ...normal, status: 'invalid' }]).readiness, 'blocked')
  for (const testFile of ['../save.test.ts', '/save.test.ts', 'C:/save.test.ts', '..\\save.test.ts', '-save.test.ts', '.git/save.test.ts', 'save.ts']) {
    assert.equal(assessExecutionReadiness(baseline, [{ ...normal, testFile }]).readiness, 'ready', testFile)
  }
})

test('execution review uses categories, not message keywords or model booleans', () => {
  const assessment = assessExecutionReadiness(baseline, [normal, { ...normal, id: 'TC-02' }])
  for (const category of ['coverage', 'quality', 'executability', 'conflict', 'safety'] as const) {
    const result = applyExecutionReview(assessment, JSON.stringify({ findings: [{ code: 'model_check', category, message: category === 'quality' ? 'unsafe blocked missing runner' : 'looks fine', caseIds: [] }] }), ['TC-01', 'TC-02'])
    assert.equal(result.readiness, ['quality', 'coverage'].includes(category) ? 'ready' : 'blocked')
    assert.equal(result.status, 'rejected')
    assert.ok(result.caseReviews?.every(item => item.status === (result.readiness === 'ready' ? 'warning' : 'rejected')))
  }
  const blocked = assessExecutionReadiness(baseline, [{ ...normal, steps: '' }])
  assert.equal(applyExecutionReview(blocked, '{"findings":[]}', ['TC-01']).readiness, 'blocked')
  for (const value of [{ qualified: true, findings: [] }, { findings: [{ code: 'check', category: 'quality', message: 'ok', caseIds: [], blocking: false }] }, { findings: [{ code: 'check', category: 'other', message: 'ok', caseIds: [] }] }, { findings: [{ code: 'check', category: 'quality', message: 'ok', caseIds: ['TC-999'] }] }, { findings: [{ code: '', category: 'quality', message: 'ok', caseIds: [] }] }, { findings: [{ code: 'check', category: 'quality', message: '', caseIds: [] }] }, { findings: [{ code: 'check', category: 'quality', message: 'ok' }] }, [], null]) {
    assert.throws(() => applyExecutionReview(assessment, JSON.stringify(value), ['TC-01']))
  }
  assert.throws(() => applyExecutionReview(assessment, '{"findings":[]}', []))
  assert.throws(() => applyExecutionReview(assessment, '{"findings":[]}', ['TC-01', 'TC-01']))
  const finding = { code: 'check', category: 'quality', message: 'warning', caseIds: ['TC-01'] }
  for (const fields of [{ code: 'x'.repeat(65) }, { message: 'x'.repeat(2001) }, { caseIds: ['TC-01', 'TC-01'] }, { caseIds: [1] }, { category: null }]) {
    assert.throws(() => applyExecutionReview(assessment, JSON.stringify({ findings: [{ ...finding, ...fields }] }), ['TC-01']))
  }
  assert.throws(() => applyExecutionReview(assessment, JSON.stringify({ findings: Array(1001).fill(finding) }), ['TC-01']))
  assert.throws(() => applyExecutionReview(assessment, 'malformed', ['TC-01']))
  const scoped = applyExecutionReview({ ...assessment, findings: [], issues: [], status: 'qualified' }, '{"findings":[]}', ['TC-01'])
  assert.equal(scoped.caseReviews?.find(item => item.caseId === 'TC-01')?.status, 'qualified')
  assert.equal(scoped.caseReviews?.find(item => item.caseId === 'TC-02')?.status, 'unreviewed')
})

test('quality batch outcomes are explicit and preserve completed prior batches', () => {
  const assessment = assessAcceptance(baseline, [normal, { ...normal, id: 'TC-02', scenario: 'negative' }, { ...normal, id: 'TC-03' }])
  const passed = applyQualityReview(assessment, '{"qualified":true,"issues":[]}', ['TC-01'])
  assert.deepEqual(passed.caseReviews?.map(item => item.status), ['qualified', 'unreviewed', 'unreviewed'])
  const rejected = applyQualityReview(passed, '{"qualified":false,"issues":["global issue"],"caseIssues":[{"caseId":"TC-02","message":"bad assertion"}]}', ['TC-02', 'TC-03'])
  assert.deepEqual(rejected.caseReviews?.map(item => item.status), ['qualified', 'rejected', 'unknown'])
  const contradictory = applyQualityReview(assessment, '{"qualified":true,"issues":[],"caseIssues":[{"caseId":"TC-02","message":"bad assertion"}]}', ['TC-02', 'TC-03'])
  assert.equal(contradictory.status, 'rejected')
  assert.deepEqual(contradictory.caseReviews?.map(item => item.status), ['unreviewed', 'rejected', 'unknown'])
  assert.deepEqual(applyQualityReview(assessment, '{"qualified":true,"issues":[]}').caseReviews, assessment.caseReviews)
  const legacyRejected = applyQualityReview(passed, '{"qualified":false,"issues":["global issue"],"caseIssues":[{"caseId":"TC-04","message":"mapped issue"}]}')
  assert.deepEqual(legacyRejected.caseReviews?.map(item => item.status), ['qualified', 'unknown', 'unknown', 'rejected'])
  assert.throws(() => applyQualityReview(assessment, '{"qualified":true,"issues":[]}', ['TC-01', 'TC-01']))
  assert.throws(() => applyQualityReview(assessment, '{"qualified":true,"issues":[]}', ['has space']))
})

test('acceptance requires valid baseline and full required scenario coverage', () => {
  assert.throws(() => parseAcceptanceBaseline('[]'))
  assert.throws(() => parseAcceptanceBaseline(JSON.stringify([...baseline, ...baseline])))
  assert.equal(assessAcceptance(baseline, [normal]).status, 'rejected')
  const complete = [normal, { ...normal, id: 'TC-02', scenario: 'negative' as const }]
  assert.equal(assessAcceptance(baseline, complete).status, 'qualified')
  assert.equal(assessAcceptance(baseline, [{ ...normal, requirementIds: ['REQ-999'] }]).status, 'rejected')
  assert.equal(assessAcceptance(baseline, [{ ...normal, assertions: [] }]).status, 'rejected')
  assert.equal(assessAcceptance([], []).status, 'rejected')
})

test('acceptance reports each description field and its actual validation failure', () => {
  for (const field of ['preconditions', 'testData', 'cleanup'] as const) {
    for (const [value, message] of [[undefined, '缺失'], [null, '缺失'], [[], '类型错误'], [{ key: 'value' }, '类型错误'], ['  ', '为空'], ['x'.repeat(2001), '超过 2000']] as const) {
      const result = assessAcceptance([{ ...baseline[0], scenarios: ['normal'] }], [{ ...normal, [field]: value } as unknown as SelfTestCase])
      assert.equal(result.status, 'rejected')
      assert.ok(result.caseIssues?.some(issue => issue.caseId === 'TC-01' && issue.message.includes(field) && issue.message.includes(message)))
    }
  }
})

test('semantic review can reject structurally qualified cases and cannot override structural failures', () => {
  const assessment = assessAcceptance(baseline, [normal, { ...normal, id: 'TC-02', scenario: 'negative' }])
  assert.equal(applyQualityReview(assessment, '{"qualified":false,"issues":["只检查提示，没有检查持久化"]}').status, 'rejected')
  assert.equal(applyQualityReview(assessAcceptance(baseline, [normal]), '{"qualified":true,"issues":[]}').status, 'rejected')
  assert.throws(() => applyQualityReview(assessment, '{"qualified":false,"issues":[]}'))
})

test('case parsing and targeted repair retain acceptance fields', () => {
  const cases = mergeTestPlan(JSON.stringify([normal]), [])
  assert.deepEqual(cases[0].requirementIds, normal.requirementIds)
  assert.deepEqual(cases[0].assertions, normal.assertions)
  const repaired = mergeTestPlan(JSON.stringify([{ title: normal.title, source: normal.source, steps: normal.steps, expected: normal.expected }]), [{ ...cases[0], status: 'failed' }], ['TC-01'])
  assert.equal(repaired[0].cleanup, normal.cleanup)
  assert.equal(repaired[0].scenario, normal.scenario)
})

test('classification is validated and legacy repairs cannot silently become advisory', () => {
  const classification = { testType: 'performance', tags: ['load'], priority: 'P2', riskReason: 'Capacity', executionPolicy: 'on_demand' }
  const cases = mergeTestPlan(JSON.stringify([{ ...normal, classification }]), [])
  assert.deepEqual(cases[0].classification, classification)
  assert.throws(() => mergeTestPlan(JSON.stringify([{ ...normal, classification: { ...classification, testType: 'unknown' } }]), []), /分类/)
  const repaired = mergeTestPlan(JSON.stringify([{ ...normal, classification }]), [{ ...normal, status: 'failed' }], ['TC-01'])
  assert.equal(repaired[0].classification, undefined)
  assert.equal(assessAcceptance(baseline, [{ ...normal, steps: '' }]).status, 'rejected')
})