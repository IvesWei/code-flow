import assert from 'node:assert/strict'
import { test } from 'node:test'
import { designPageOptions } from '../../../src/features/requirements/design-pages.js'
import type { RequirementRevision } from '../../../shared/requirements.js'

test('page labels are short while module grouping preserves full scenario details and unclassified pages', () => {
  const screen = { id: 'S1', title: '项目用例工作台 · 编辑角色；目录展开', state: '正常列表', requirementIds: ['R1'], acceptanceIds: [], html: '' }
  const revision: RequirementRevision = { id: 'V1', createdAt: '', prd: { title: '', summary: '', requirements: [], blocks: [{ id: 'B1', title: '用例管理', content: '', requirementIds: ['R1'], sourceIds: [] }, { id: 'B2', title: '系统设置', content: '', requirementIds: ['R2'], sourceIds: [] }] }, screens: [screen, { ...screen, id: 'S2', title: '设置页面', requirementIds: ['R2'] }, { ...screen, id: 'S3', state: '加载中' }, { ...screen, id: 'S4', requirementIds: [] }] }
  const options = designPageOptions(revision)
  assert.deepEqual(options.map(item => item.value), ['S1', 'S3', 'S2', 'S4'])
  assert.equal(options[0].label, '项目用例工作台页')
  assert.equal(options[2].label, '设置页')
  assert.equal(options[3].group, '其他页面')
  assert.ok(options[0].title.includes('编辑角色'))
  assert.ok(options[1].description.includes('加载中'))
  revision.prd.blocks[0].module = '质量管理'
  revision.prd.blocks[1].module = '质量管理'
  assert.deepEqual(designPageOptions(revision).map(item => item.group), ['质量管理', '质量管理', '质量管理', '其他页面'])
})