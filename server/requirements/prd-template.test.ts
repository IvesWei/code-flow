import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { StructuredPrd } from '../../shared/requirements.js'
import { prdTemplateOutline, PrdTemplateError, validatePrdTemplate } from '../../shared/prd-template.js'
import { businessReviewSections, readBusinessReview } from '../../shared/business-review.js'
import { dualPrdFixture } from '../tests/fixtures/dual-prd.js'
import { validatePrd, RequirementOutputError } from './validation.js'

const legacy: StructuredPrd = {
  title: '订单需求', summary: '内部范围',
  blocks: [{ id: 'B1', title: '订单页', content: '内部页面说明', requirementIds: ['R1'], sourceIds: [] }],
  requirements: [{ id: 'R1', title: '查询订单', description: '根据筛选条件查询\n展示匹配结果', fields: [{ name: '订单状态', description: '筛选订单' }], sourceIds: [], acceptance: [{ id: 'A1', text: '仅展示匹配订单' }] }],
}
const fixture = () => dualPrdFixture(legacy)

test('PRD reports missing field options and invalid acceptance refs together', () => {
  const prd = fixture(), spec = prd.requirements[0].specification!
  Reflect.deleteProperty(spec.fields[0], 'options')
  spec.criteria[0].refs.push('RM-01')
  assert.throws(() => validatePrd(prd, []), error => {
    assert.ok(error instanceof RequirementOutputError)
    assert.match(error.context ?? '', /fields\[0\]\.options/)
    assert.match(error.context ?? '', /订单状态/)
    assert.match(error.context ?? '', /criteria\[0\]\.refs/)
    assert.match(error.context ?? '', /RM-01/)
    return true
  })
})

test('business change list is revision bound, deduplicates figures and never illustrates backend logic', () => {
  const prd = fixture(), before = JSON.stringify(prdTemplateOutline(prd, 'development'))
  const screens = [{ id: 'target', title: '订单', state: '筛选', requirementIds: ['R1'], acceptanceIds: ['A1'], html: '' }]
  const change = { requirementId: 'R1', kind: '新增', scope: 'ui', text: '增加筛选', basis: '根据筛选条件查询', screenIds: ['target'] }
  const body = { changes: [change, { ...change, kind: '变更', text: '展示匹配结果' }, { ...change, kind: '删除', scope: 'logic', text: '不再计入已取消订单', screenIds: [] }], pending: [] }
  const businessReview = { ...readBusinessReview(body, prd, screens), revisionId: 'revision' }
  const revision = { id: 'revision', createdAt: '', prd, screens, businessReview }
  const [{ functions: [feature] }] = businessReviewSections(revision)
  assert.deepEqual(feature.changes.map(entry => entry.pictures.map(picture => picture.owner ?? 'primary')), [['primary'], [prd.requirements[0].title], []])
  assert.deepEqual(businessReviewSections({ ...revision, id: 'other' }), [])
  for (const invalid of [{ scope: 'logic' }, { screenIds: ['foreign'] }, { basis: '不存在的依据' }]) assert.throws(() => readBusinessReview({ changes: [{ ...change, ...invalid }], pending: [] }, prd, screens))
  assert.equal(JSON.stringify(prdTemplateOutline(prd, 'development')), before)
  prd.requirements[0].specification!.fields[0].change = '既有'
  assert.throws(() => readBusinessReview({ changes: [{ ...change, basis: '订单状态' }], pending: [] }, prd, screens))
  assert.throws(() => readBusinessReview({ changes: [change], pending: [{ requirementId: 'R1', text: change.text }] }, prd, screens))
  prd.requirements[0].nonVisualReason = '仅调整计算规则'
  assert.throws(() => readBusinessReview({ changes: [change], pending: [] }, prd, screens))
})

test('dual template normalizes without data loss and leaves legacy PRDs untouched', () => {
  assert.deepEqual(validatePrd(legacy, []), legacy)
  assert.deepEqual(validatePrd(fixture(), []), fixture())
  assert.throws(() => validatePrd({ ...fixture(), templateVersion: 3 }, []), RequirementOutputError)
  const missingVersion = fixture()
  delete missingVersion.templateVersion
  assert.throws(() => validatePrd(missingVersion, []), RequirementOutputError)
})

const invalidCases: [string, (prd: StructuredPrd) => void][] = [
  ['missing scenario', prd => { delete prd.requirements[0].scenario }],
  ['missing specification', prd => { delete prd.requirements[0].specification }],
  ['missing explicit fields', prd => { delete prd.requirements[0].fields }],
  ['wrong field name', prd => { prd.requirements[0].specification!.fields[0].name = '其他字段' }],
  ['sparse field metadata', prd => { delete prd.requirements[0].specification!.fields[0] }],
  ['duplicate display IDs', prd => { prd.requirements[0].specification!.rules.push(prd.requirements[0].specification!.rules[0]) }],
  ['missing GWT', prd => { prd.requirements[0].specification!.criteria = [] }],
  ['mismatched Then', prd => { prd.requirements[0].specification!.criteria[0].then = '不一致' }],
  ['missing numeric example', prd => { prd.requirements[0].specification!.criteria[0].example = '应该成功' }],
  ['dangling reference', prd => { prd.requirements[0].specification!.criteria[0].refs.push('EX-99') }],
  ['reference to permission', prd => { prd.requirements[0].specification!.criteria[0].refs.push('RM-01') }],
  ['reference to acceptance', prd => { prd.requirements[0].specification!.criteria[0].refs.push('AC-01') }],
  ['missing own FR', prd => { prd.requirements[0].specification!.criteria[0].refs = ['BR-01'] }],
  ['unknown permission grant', prd => { prd.requirements[0].specification!.permissions[0].availability = '可用' }],
  ['unknown permission scope', prd => { Object.assign(prd.requirements[0].specification!.permissions[0], { role: '运营', operation: '查询', availability: '仅查看' }) }],
  ['business numbering', prd => { prd.requirements[0].description += '\nFR-01-1 另一行为' }],
  ['numbered module', prd => { prd.blocks[0].module = 'MOD-01 订单' }],
  ['wide table', prd => { prd.blocks[0].table = { columns: ['名称'], rows: [['订单']] } }],
  ['duplicate block ownership', prd => { prd.blocks.push({ ...prd.blocks[0], id: 'B2' }) }],
  ['unknown property', prd => { Object.assign(prd.requirements[0].specification!, { extra: 'unexpected' }) }],
]
for (const [name, change] of invalidCases) test(`dual template rejects ${name}`, () => {
  const prd = fixture()
  change(prd)
  assert.throws(() => validatePrdTemplate(prd), PrdTemplateError)
  assert.throws(() => validatePrd(prd, []), RequirementOutputError)
})

test('both editions preserve business rules, omit non-workflow transitions and expose development-only traceability', () => {
  const prd = fixture(), spec = prd.requirements[0].specification!
  Object.assign(spec.rules[0], { business: '只能查询本部门订单', detail: '根据组织归属过滤', validation: '仅后端' })
  Object.assign(spec.permissions[0], { role: '运营', operation: '查询', availability: '仅查看', scope: '本部门' })
  Object.assign(spec.criteria[0], { given: '本部门有 3 条订单，其他部门有 2 条', when: '查询全部状态', example: '仅返回本部门 3 条，不包含其他部门 2 条' })
  const business = JSON.stringify(prdTemplateOutline(prd, 'business'))
  const development = JSON.stringify(prdTemplateOutline(prd, 'development'))
  for (const body of [business, development]) {
    assert.match(body, /只能查询本部门订单/)
    assert.doesNotMatch(body, /状态流转|内部范围|内部页面说明/)
  }
  assert.doesNotMatch(business, /FR-01|MOD-01|FLD-01|BR-01|EX-01|RM-01|AC-01|权限：|验收标准：|根据组织归属过滤|Given /)
  for (const expected of ['FR-01-1', 'MOD-01', 'FLD-01', 'BR-01', 'EX-01', 'RM-01', 'AC-01', '权限：', '验收标准：', 'Given ', 'When ', 'Then ', '3 条', '根据组织归属过滤', '服务端接口层强制校验']) assert.ok(development.includes(expected), expected)
  spec.transitions.push({ id: 'TR-01', from: '草稿', to: '已提交', event: '提交', precondition: '字段完整', role: '运营', effects: '记录状态变化' })
  for (const edition of ['business', 'development'] as const) {
    const body = JSON.stringify(prdTemplateOutline(prd, edition))
    assert.match(body, /状态流转：|草稿 → 已提交/)
    assert.equal(body.includes('TR-01'), edition === 'development')
  }
})

test('business edition focuses on incremental UI changes and omits exceptions, unchanged fields and UI-obvious rules', () => {
  const prd = fixture()
  prd.requirements[0].capability = '支持按状态与关键词增量检索订单'
  prd.requirements[0].fields = [
    { name: '订单号', description: '既有精确匹配' },
    { name: '审批状态', description: '新增筛选条件' },
  ]
  const spec = prd.requirements[0].specification!
  spec.fields = [
    { name: '订单号', id: 'FLD-01', type: '文本', required: '否', source: '用户输入', change: '既有', options: [] },
    { name: '审批状态', id: 'FLD-02', type: '枚举', required: '否', source: '用户输入', change: '新增', options: ['待审批', '已通过'] },
  ]
  spec.rules = [{ id: 'BR-01', kind: '校验规则', business: '输入长度不超过 50 字符', detail: '前后端统一限制 50 字符', validation: '双端', scope: '本功能', businessVisible: false }]
  const business = JSON.stringify(prdTemplateOutline(prd, 'business'))
  const development = JSON.stringify(prdTemplateOutline(prd, 'development'))
  assert.match(business, /【新增】审批状态 —— 新增筛选条件/)
  assert.doesNotMatch(business, /订单号|异常场景与边界条件|业务规则与生成逻辑|输入长度不超过 50 字符/)
  assert.match(development, /FLD-01 【既有】订单号/)
  assert.match(development, /FLD-02 【新增】审批状态/)
  assert.match(development, /异常场景与边界条件：/)
  assert.match(development, /BR-01 校验规则：输入长度不超过 50 字符/)

  prd.requirements[0].fields = []
  spec.fields = []
  const noFieldBusiness = JSON.stringify(prdTemplateOutline(prd, 'business'))
  const noFieldDevelopment = JSON.stringify(prdTemplateOutline(prd, 'development'))
  assert.doesNotMatch(noFieldBusiness, /该功能涉及的字段|不涉及字段|本功能不新增/)
  assert.match(noFieldDevelopment, /本功能不新增或变更业务字段/)
})
