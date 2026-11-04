import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { parsePrd, PrdReview } from '../../../src/features/requirements/PrdReview.js'
import { prdSections } from '../../../shared/prd-sections.js'
import type { StructuredPrd } from '../../../shared/requirements.js'

test('PRD preserves function mappings and legacy content without displaying completion criteria', () => {
  const requirement = { id: 'R1', title: 'Save', description: 'User goal: save a record. UI: show success.', sourceIds: ['S1'], acceptance: [{ id: 'A1', text: 'Saved record is visible' }] }
  const prd: StructuredPrd = { title: 'Product', summary: 'Goal', blocks: [{ id: 'B1', title: 'Record page', content: 'Entry and regions', requirementIds: ['R1'], sourceIds: [] }, { id: 'B2', title: 'Shared page', content: 'Reference record page', requirementIds: ['R1'], sourceIds: [] }], requirements: [requirement, { ...requirement, id: 'R2', title: 'Legacy function' }] }
  const groups = prdSections(prd)
  assert.equal(groups.sections[0].requirements.length, 1)
  assert.equal(groups.sections[1].requirements.length, 0)
  assert.equal(groups.unassigned[0].id, 'R2')
  const html = renderToStaticMarkup(React.createElement(PrdReview, { prd, readOnly: true, busy: false, selectedId: 'R1', onSelect() {}, async onSave() {}, onEditing() {} }))
  assert.equal(html.match(/data-prd-requirement="R1"/g)?.length, 1)
  assert.ok(html.indexOf('>Save</button>') < html.indexOf('Shared page'))
  assert.doesNotMatch(html, />R1|>A1|R1 · Save/)
  assert.doesNotMatch(html, /完成标准|Saved record is visible/)
  assert.equal(prd.requirements[0].acceptance[0].text, 'Saved record is visible')
  assert.ok(html.includes('其他功能'))
  assert.match(html, /<details><summary>需求来源<\/summary>/)
  assert.doesNotMatch(html, /需求与验收标准|未关联资料/)
})

test('PRD renders screenshot-style module/function/scenario outlines with nested fields and internal mapping intact', () => {
  const prd: StructuredPrd = { title: '用例管理', summary: '维护用例', blocks: [{ id: 'B1', module: '用例管理模块', title: '搜索页面', content: '查询和维护用例', requirementIds: ['REQ-1'], sourceIds: [] }], requirements: [{ id: 'REQ-1', title: '搜索', description: '输入条件后查询，可重置筛选条件。', fields: [{ name: '用例名称', description: '支持关键字匹配' }, { name: '用例等级', description: '按等级筛选' }, { name: '用例类型', description: '按类型筛选' }], sourceIds: [], acceptance: [{ id: 'AC-1', text: '仅展示匹配的用例' }] }] }
  const html = renderToStaticMarkup(React.createElement(PrdReview, { prd, readOnly: true, busy: false, selectedId: 'REQ-1', onSelect() {}, async onSave() {}, onEditing() {} }))
  assert.match(html, /<h3>模块：用例管理模块<\/h3>/)
  assert.match(html, /功能名称：<button[^>]*>搜索<\/button>/)
  assert.match(html, /对应场景：--/)
  assert.match(html, /功能描述：<ul class="requirements-description-list">/)
  assert.match(html, /<ul class="requirements-field-list" aria-label="搜索字段"><li>用例名称<ul><li>支持关键字匹配<\/li>/)
  assert.doesNotMatch(html, /<h4>|<h5>/)
  assert.match(html, /data-prd-requirement="REQ-1" data-selected="true"/)
  assert.doesNotMatch(html, />REQ-1|>AC-1/)
  assert.deepEqual(parsePrd(JSON.stringify(prd)), prd)
  assert.throws(() => parsePrd(JSON.stringify({ ...prd, blocks: [{ ...prd.blocks[0], module: 12 }] })))
  assert.throws(() => parsePrd(JSON.stringify({ ...prd, requirements: [{ ...prd.requirements[0], fields: [{ name: '', description: '' }] }] })))
  prd.requirements[0].scenario = '用户进入搜索页'
  prd.requirements[0].description = '填写搜索条件\n点击查询更新列表'
  prd.requirements[0].fields = [{ name: '影响等级', description: 'P0(阻断)\nP1(严重)\nP2(一般)' }]
  const outline = renderToStaticMarkup(React.createElement(PrdReview, { prd, readOnly: true, busy: false, selectedId: '', onSelect() {}, async onSave() {}, onEditing() {} }))
  assert.match(outline, /对应场景：用户进入搜索页/)
  assert.match(outline, /<li>填写搜索条件<\/li><li>点击查询更新列表<\/li>/)
  assert.match(outline, /<li>影响等级<ul><li>P0\(阻断\)<\/li><li>P1\(严重\)<\/li><li>P2\(一般\)<\/li><\/ul><\/li>/)
})