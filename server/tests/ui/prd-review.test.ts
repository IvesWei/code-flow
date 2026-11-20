import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5'
import { unzipSync, strFromU8 } from 'fflate'
import { parsePrd, PrdReview } from '../../../src/features/requirements/PrdReview.js'
import { prdSections } from '../../../shared/prd-sections.js'
import type { RequirementProject, StructuredPrd } from '../../../shared/requirements.js'
import { exportRequirementRevision, readRequirementScreenshot, validatePrototypeRevision } from '../../requirements/artifacts.js'
import { PrdTemplateReview } from '../../../src/features/requirements/PrdTemplateReview.js'
import { dualPrdFixture } from '../fixtures/dual-prd.js'

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

test('dual PRD ZIP contains exactly two homologous Word outlines matching both page editions with function-local images', { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dual-prd-outline-'))
  try {
    const prd = dualPrdFixture({
      title: '订单需求文档', summary: 'SUMMARY_HIDDEN',
      blocks: [{ id: 'B1', module: '订单模块', title: 'PAGE_TITLE_HIDDEN', content: 'PAGE_CONTENT_HIDDEN', requirementIds: ['R1', 'R2'], sourceIds: [] }],
      requirements: ['R1', 'R2'].map((id, index) => ({ id, title: index ? '筛选订单' : '检索订单', scenario: '查看当前订单', description: '显示当前订单\n根据输入刷新列表', fields: [{ name: '状态', description: '筛选订单' }], sourceIds: [], acceptance: [{ id: `A${index + 1}`, text: '仅展示匹配订单' }] })),
    })
    prd.requirements[0].specification!.fields[0].options = ['待处理', '已完成']
    prd.requirements[0].specification!.transitions = [{ id: 'TR-01', from: '草稿', to: '已提交', event: '提交', precondition: '填写完整', role: '运营', effects: '记录状态变化' }]
    const project: RequirementProject = { schemaVersion: 1, id: '11111111-1111-4111-8111-111111111111', ownerId: 7, version: 1, title: 'Project', description: '', modelId: 'auto', createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z', status: 'draft', sources: [], evidence: [], questions: [], decisions: [], jobs: [], events: [], revisions: [] }
    const revision = await validatePrototypeRevision(project, {
      id: '22222222-2222-4222-8222-222222222222', createdAt: project.createdAt, prd,
      screens: ['3', '4'].map((digit, index) => ({ id: `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`, title: '订单页', state: index ? '空结果' : '正常', requirementIds: ['R1', 'R2'], acceptanceIds: ['A1', 'A2'], html: `<main><h1 data-requirement-id="R1" data-acceptance-id="A1">检索 ${index}</h1><p data-requirement-id="R2" data-acceptance-id="A2">筛选 ${index}</p></main>` })),
    }, root)
    assert.deepEqual(revision.validation.errors, [])
    project.revisions = [revision]
    const first = revision.screenshots![0], second = revision.screenshots![1]
    const bytes = await readRequirementScreenshot(project, revision, first.screenId, root)
    assert.ok(bytes.equals(await readRequirementScreenshot(project, { ...revision, screenshots: [first, { ...second, sha256: 'bad' }] }, first.screenId, root)))
    await assert.rejects(readRequirementScreenshot(project, revision, 'missing', root), /not found/)
    await assert.rejects(readRequirementScreenshot(project, { ...revision, screenshots: [{ ...first, sha256: 'bad' }] }, first.screenId, root), /integrity/)
    await assert.rejects(readRequirementScreenshot(project, { ...revision, screenshots: [{ ...first, storageKey: '../foreign.png' }] }, first.screenId, root), /ownership/)
    const before = structuredClone(project)
    const artifact = await exportRequirementRevision(project, revision, 'zip', root, 'prd')
    assert.equal(artifact.contentType, 'application/zip')
    assert.match(artifact.filename, /\.zip$/)
    const files = unzipSync(artifact.buffer)
    assert.deepEqual(Object.keys(files), ['业务评审版.docx', '开发规格版.docx'])
    const unprepared = strFromU8(unzipSync(files['业务评审版.docx'])['word/document.xml'])
    assert.match(unprepared, /本修订尚未整理业务变更清单/)
    assert.doesNotMatch(unprepared, /<a:blip\b|检索订单/)
    const unpreparedPage = renderToStaticMarkup(React.createElement(PrdTemplateReview, { prd, edition: 'business', selectedId: '', onSelect() {}, revision, projectId: project.id }))
    assert.match(unpreparedPage, /本修订尚未整理业务变更清单/)
    assert.doesNotMatch(unpreparedPage, /<img\b|检索订单/)
    const text = (node: DefaultTreeAdapterTypes.Node): string => 'value' in node ? node.value : 'childNodes' in node ? node.childNodes.map(text).join('') : ''
    {
      const edition = 'development', filename = '开发规格版.docx'
      const visible: string[] = []
      const html = renderToStaticMarkup(React.createElement(PrdTemplateReview, { prd, edition, selectedId: 'R1', onSelect() {}, revision, projectId: project.id }))
      const visit = (node: DefaultTreeAdapterTypes.Node) => {
        if (!('childNodes' in node)) return
        if ('tagName' in node) {
          if (['h3', 'figcaption'].includes(node.tagName)) visible.push(text(node))
          if (node.tagName === 'section') {
            const title = node.childNodes.find(child => 'tagName' in child && child.tagName === 'strong')
            if (title) visible.push(text(title))
          }
          if (node.tagName === 'li') {
            const label = node.childNodes.filter(child => !('tagName' in child) || !['ul', 'section', 'article', 'figure'].includes(child.tagName)).map(text).join('')
            if (label) visible.push(label)
          }
        }
        node.childNodes.forEach(visit)
      }
      visit(parseFragment(html))
      const entries = unzipSync(files[filename]), xml = strFromU8(entries['word/document.xml'])
      const paragraphs = Array.from(xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g), match => ({ xml: match[1], text: text(parseFragment(match[1].replace(/<w:br\b[^>]*\/>/g, '\n').replace(/<[^>]+>/g, ''))) }))
      assert.deepEqual(paragraphs.map(paragraph => paragraph.text).filter(Boolean), visible, edition)
      assert.doesNotMatch(xml, /SUMMARY_HIDDEN|PAGE_TITLE_HIDDEN|PAGE_CONTENT_HIDDEN|<w:tbl>|Discussion draft|来源记录|Provenance|版本：/)
      assert.equal(Object.keys(entries).some(name => /word\/(?:header|footer)/.test(name)), false)
      assert.equal(xml.match(/<a:blip\b/g)?.length, 4)
      assert.equal(Object.keys(entries).filter(name => /^word\/media\/.*\.png$/.test(name)).length, 2)
      const placements: Record<string, string[]> = {}
      let current = ''
      for (const [index, paragraph] of paragraphs.entries()) {
        if (paragraph.text.includes('功能名称：')) current = paragraph.text.split('功能名称：')[1]
        if (paragraph.text.startsWith('订单页 ·')) {
          assert.match(paragraphs[index + 1].xml, /<a:blip\b/)
          assert.doesNotMatch(paragraphs[index + 1].xml, /<w:numPr>/)
          assert.match(paragraph.xml, /<w:keepNext\/>/)
          ;(placements[current] ||= []).push(paragraph.text)
        }
        if (/^(?:MOD-\d+ )?模块：|功能名称：|^(?:该功能涉及的字段|状态流转|设计稿|业务规则与生成逻辑|异常场景与边界条件|权限|验收标准)：$/.test(paragraph.text)) assert.match(paragraph.xml, /<w:b\/>/)
        if (paragraph.text.startsWith('对应场景：') || paragraph.text === '功能描述：') assert.doesNotMatch(paragraph.xml, /<w:b\/>/)
      }
      assert.deepEqual(placements, { 检索订单: ['订单页 · 正常', '订单页 · 空结果'], 筛选订单: ['订单页 · 正常', '订单页 · 空结果'] })
      const numbering = strFromU8(entries['word/numbering.xml'])
      for (const symbol of ['●', '○', '■']) assert.ok(numbering.includes(symbol))
      const body = paragraphs.map(paragraph => paragraph.text).join('\n')
      for (const expected of ['FR-01-1', 'FR-02', 'FLD-01', 'TR-01', 'BR-01', 'EX-01', 'RM-01', 'AC-01', 'Given ', 'When ', 'Then ']) assert.ok(body.includes(expected), expected)
      const extents = Array.from(xml.matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"\/>/g), match => [Number(match[1]), Number(match[2])])
      assert.equal(extents.length, 4)
      for (const [width, height] of extents) assert.ok(Math.abs(width / height - 1.6) < 0.01)
    }
    assert.deepEqual(project, before)
    const reviewed = { ...revision, businessReview: { revisionId: revision.id, changes: [
      { requirementId: 'R1', kind: '新增' as const, scope: 'ui' as const, text: '增加订单筛选', basis: '根据输入刷新列表', screenIds: [first.screenId] },
      { requirementId: 'R2', kind: '变更' as const, scope: 'ui' as const, text: '调整匹配结果', basis: '仅展示匹配订单', screenIds: [first.screenId] },
      { requirementId: 'R1', kind: '删除' as const, scope: 'logic' as const, text: '取消旧统计口径', basis: '显示当前订单', screenIds: [] },
    ], pending: [] } }
    const scoped = unzipSync((await exportRequirementRevision(project, reviewed, 'zip', root, 'prd')).buffer)
    const notes = renderToStaticMarkup(React.createElement(PrdTemplateReview, { prd, edition: 'business', selectedId: '', onSelect() {}, revision: reviewed, projectId: project.id }))
    assert.equal(notes.match(/<img\b/g)?.length, 1)
    for (const expected of ['新增', '变更', '删除', '增加订单筛选', '调整匹配结果', '取消旧统计口径', '后台逻辑', '见「检索订单」']) assert.ok(notes.includes(expected), expected)
    assert.doesNotMatch(notes, /草稿 → 已提交|订单页 · 空结果|待补图/)
    const businessXml = strFromU8(unzipSync(scoped['业务评审版.docx'])['word/document.xml'])
    assert.equal(businessXml.match(/<a:blip\b/g)?.length, 1)
    for (const expected of ['增加订单筛选', '调整匹配结果', '取消旧统计口径', '见「检索订单」', '14633F', '814D06', 'A63248']) assert.ok(businessXml.includes(expected), expected)
    assert.doesNotMatch(businessXml, /待补图|订单页 · 空结果|草稿 → 已提交/)
    const developmentContent = (document: Uint8Array) => {
      const entries = unzipSync(document), xml = strFromU8(entries['word/document.xml'])
      return { order: xml.match(/<w:t(?:\s[^>]*)?>[^<]*<\/w:t>|<wp:extent [^>]+\/>|<w:drawing>/g), media: Object.entries(entries).filter(([name]) => name.startsWith('word/media/')) }
    }
    assert.deepEqual(developmentContent(scoped['开发规格版.docx']), developmentContent(files['开发规格版.docx']))
    await assert.rejects(exportRequirementRevision(project, revision, 'docx', root, 'prd'), /Unsupported PRD export/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('PRD-only Word follows the actual page outline and places every state image beneath each mapped function', { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'prd-visible-outline-'))
  try {
    const requirement = (id: string, title: string) => ({ id, title, description: `${title}第一行\n\n${title}第二行`, sourceIds: ['SOURCE_HIDDEN'], acceptance: [{ id: `AC-${id}`, text: 'ACCEPTANCE_NOT_DISPLAYED' }] })
    const prd: StructuredPrd = {
      title: '当前 PRD *原文* <内容>', summary: '概述第一行\n概述第二行',
      blocks: [
        { id: 'B1', module: '模块甲', title: '查询页', content: '入口说明\n区域说明', requirementIds: ['R1'], sourceIds: ['SOURCE_HIDDEN'], table: { columns: ['字段', '规则'], rows: [['状态', '正常/无数据']] } },
        { id: 'B2', module: '模块乙', title: '设置页', content: '设置页面说明', requirementIds: ['R3'], sourceIds: [] },
        { id: 'B3', module: '模块甲', title: '维护页', content: '维护页面说明', requirementIds: ['R2', 'R1'], sourceIds: [] },
        { id: 'B4', title: '旧页面', content: '旧页面说明', requirementIds: [], sourceIds: [] },
      ],
      requirements: [
        { ...requirement('R1', '查询'), fields: [{ name: '影响等级', description: 'P0(阻断)\r\nP1(严重)' }] },
        { ...requirement('R2', '维护'), scenario: '维护已有数据', nonVisualReason: '保留审计记录' },
        requirement('R3', '设置'),
        requirement('R4', '旧功能'),
      ],
    }
    const project: RequirementProject = { schemaVersion: 1, id: '11111111-1111-4111-8111-111111111111', ownerId: 7, version: 1, title: 'Project', description: '', modelId: 'auto', createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z', status: 'draft', sources: [], evidence: [], questions: [], decisions: [], jobs: [], events: [], revisions: [] }
    project.sources = [{ id: 'SOURCE_HIDDEN', name: 'Source', kind: 'file', sha256: 'fixture', sizeBytes: 0 }]
    const screen = (digit: string, title: string, state: string, requirementIds: string[]) => ({ id: `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`, title, state, requirementIds, acceptanceIds: requirementIds.map(id => `AC-${id}`), html: `<main>${requirementIds.map(id => `<h1 data-requirement-id="${id}" data-acceptance-id="AC-${id}">${title} ${state} ${id}</h1>`).join('')}</main>` })
    const revision = await validatePrototypeRevision(project, { id: '22222222-2222-4222-8222-222222222222', createdAt: project.createdAt, prd, screens: [screen('3', '综合页', '正常', ['R1', 'R2']), screen('4', '综合页', '无数据', ['R1', 'R2']), screen('5', '设置页', '正常', ['R3']), screen('6', '旧页面', '正常', ['R4'])] }, root)
    assert.deepEqual(revision.validation.errors, [])
    project.revisions = [revision]
    const html = renderToStaticMarkup(React.createElement(PrdReview, { prd, readOnly: true, busy: false, selectedId: '', onSelect() {}, async onSave() {}, onEditing() {} }))
    const text = (node: DefaultTreeAdapterTypes.Node): string => 'value' in node ? node.value : 'childNodes' in node ? node.childNodes.map(text).join('') : ''
    const visible: string[] = []
    const visit = (node: DefaultTreeAdapterTypes.Node) => {
      if (!('childNodes' in node)) return
      if ('tagName' in node) {
        const classes = node.attrs.find(attribute => attribute.name === 'class')?.value.split(' ') || []
        if (classes.includes('requirements-toolbar') || (node.tagName === 'details' && !classes.includes('requirements-page-context'))) return
        if (['h3', 'p', 'summary'].includes(node.tagName)) visible.push(text(node))
        if (node.tagName === 'li') {
          const label = node.childNodes.filter(child => !('tagName' in child) || !['ul', 'section', 'article'].includes(child.tagName)).map(text).join('')
          if (label) visible.push(label)
        }
      }
      node.childNodes.forEach(visit)
    }
    visit(parseFragment(html))
    const artifact = await exportRequirementRevision(project, revision, 'docx', root, 'prd')
    const entries = unzipSync(artifact.buffer)
    const xml = strFromU8(entries['word/document.xml'])
    const paragraphs = Array.from(xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g), match => ({ xml: match[1], text: text(parseFragment(match[1].replace(/<w:br\b[^>]*\/>/g, '\n').replace(/<[^>]+>/g, ''))) }))
    assert.deepEqual(paragraphs.map(paragraph => paragraph.text).filter(value => value && !value.startsWith('设计稿：')), visible)
    assert.doesNotMatch(xml, /ACCEPTANCE_NOT_DISPLAYED|SOURCE_HIDDEN|Completion criteria|对应原型截图|对应需求：/)
    const placements: Record<string, string[]> = {}
    let current = ''
    for (const [index, paragraph] of paragraphs.entries()) {
      if (paragraph.text.startsWith('功能名称：')) current = paragraph.text.slice('功能名称：'.length)
      if (!paragraph.text.startsWith('设计稿：')) continue
      assert.match(paragraphs[index + 1].xml, /<a:blip\b/)
      ;(placements[current] ||= []).push(paragraph.text)
    }
    assert.deepEqual(placements, { 查询: ['设计稿：综合页 · 正常', '设计稿：综合页 · 无数据'], 维护: ['设计稿：综合页 · 正常', '设计稿：综合页 · 无数据'], 设置: ['设计稿：设置页 · 正常'], 旧功能: ['设计稿：旧页面 · 正常'] })
    assert.equal(xml.match(/<a:blip\b/g)?.length, 6)
    assert.equal(Object.keys(entries).filter(name => /^word\/media\/.*\.png$/.test(name)).length, 4)
    assert.match(xml, /<w:ilvl w:val="3"/)
  } finally { await rm(root, { recursive: true, force: true }) }
})