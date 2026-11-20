import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseCaptureMapping } from './capture-mapping.js'
import type { RequirementScopeBlock, StructuredPrd } from '../../shared/requirements.js'

const prd: StructuredPrd = {
  title: 'Plans', summary: 'Existing plan changes',
  blocks: ['B1', 'B2', 'B3'].map(id => ({ id, title: id, content: '', requirementIds: [id.replace('B', 'R')], sourceIds: ['S1'] })),
  requirements: ['R1', 'R2', 'R3'].map(id => ({ id, title: id, description: 'Change model selection', sourceIds: ['S1'], acceptance: [] })),
}
const scope: RequirementScopeBlock[] = prd.blocks.map(block => ({ blockId: block.id, kind: 'existing', reason: 'Existing plan interface' }))
const snapshots = [{ sourceId: 'S1', name: 'code', text: 'const list = "/plans/list";\nconst detail = "/plans/detail";\nparams.get("projectId"); params.get("testPlanId"); params.get("planType");\nModel\nOwner\nCreate self plan\nCreate test plan' }]
const listPath = '/plans/list?projectId=17'
const detailPath = '/plans/detail?projectId=17&testPlanId=41&planType=2'
const pages = ['B1', 'B2'].map(blockId => ({
  blockId, kind: 'existing', path: listPath, sourceId: 'S1', quote: 'const list = "/plans/list";',
  activate: [{ kind: 'dialog', name: blockId === 'B1' ? 'Create self plan' : 'Create test plan' }],
  expectedFields: ['Model', 'Owner', 'Model'],
}))
const gap = {
  blockId: 'B3', code: 'entry_context', reason: 'Detail reads a concrete plan identifier and plan type',
  entry: { path: '/plans/detail', queryKeys: ['testPlanId', 'planType'], sourceId: 'S1', quote: 'const detail = "/plans/detail";' },
}

test('partial capture mapping retains two valid list mappings and reports only the missing detail context', () => {
  const result = parseCaptureMapping(JSON.stringify({ pages, gaps: [gap] }), prd, snapshots, scope, [listPath])
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.pages.map(page => page.blockId), ['B1', 'B2'])
  assert.deepEqual(result.targets.map(target => target.path), [listPath, listPath])
  assert.deepEqual(result.gaps, [gap])
  assert.deepEqual(result.pages[0].expectedFields, ['Model', 'Owner', 'Model'])
})

test('mapping correction and retry merge source-verified pages without losing earlier valid blocks', () => {
  const initial = parseCaptureMapping(JSON.stringify({ pages, gaps: [gap] }), prd, snapshots, scope, [listPath])
  const empty = parseCaptureMapping('{"pages":[]}', prd, snapshots, scope, [listPath], initial.pages)
  assert.deepEqual(empty.pages, initial.pages)
  assert.deepEqual(empty.errors.map(issue => issue.blockId), ['B3'])
  const retainedGap = parseCaptureMapping('{"pages":[]}', prd, snapshots, scope, [listPath], initial.pages, initial.gaps)
  assert.deepEqual(retainedGap.gaps, [gap])
  assert.deepEqual(retainedGap.errors, [])
  const invalidReplacement = parseCaptureMapping(JSON.stringify({ pages: [{ ...pages[0], path: '/invented' }] }), prd, snapshots, scope, [listPath], initial.pages, initial.gaps)
  assert.deepEqual(invalidReplacement.pages, initial.pages)
  assert.deepEqual(invalidReplacement.errors.map(issue => issue.blockId), ['B1'])
  const detail = { blockId: 'B3', kind: 'existing', path: detailPath, sourceId: 'S1', quote: gap.entry.quote, expectedContent: ['Model'] }
  const finished = parseCaptureMapping(JSON.stringify({ pages: [detail] }), prd, snapshots, scope, [listPath, detailPath], initial.pages)
  assert.deepEqual(finished.errors, [])
  assert.deepEqual(finished.gaps, [])
  assert.deepEqual(finished.targets.map(target => target.blockId), ['B1', 'B2', 'B3'])
  const changed = parseCaptureMapping('{"pages":[]}', prd, snapshots, scope, ['/plans/list?projectId=99'], initial.pages)
  assert.equal(changed.pages.length, 0)
  assert.deepEqual(changed.errors.map(issue => issue.blockId), ['B1', 'B2', 'B3'])
})

test('invented evidence, unsafe context and already supplied detail entries cannot become valid user gaps', () => {
  for (const change of [
    { entry: { ...gap.entry, path: '/invented' } },
    { entry: { ...gap.entry, queryKeys: ['inventedKey'] } },
    { entry: { ...gap.entry, queryKeys: ['token'] } },
    { entry: undefined },
  ]) {
    const result = parseCaptureMapping(JSON.stringify({ pages, gaps: [{ ...gap, ...change }] }), prd, snapshots, scope, [listPath])
    assert.equal(result.pages.length, 2)
    assert.deepEqual(result.gaps, [])
    assert.deepEqual(result.errors.map(issue => issue.blockId), ['B3'])
  }
  const supplied = parseCaptureMapping(JSON.stringify({ pages, gaps: [gap] }), prd, snapshots, scope, [listPath, detailPath])
  assert.match(supplied.errors[0].error.message, /已提供/)
  assert.throws(() => parseCaptureMapping('{"pages":[],"__proto__":{}}', prd, snapshots, scope, []))
})

test('bounded mapping payloads preserve maximum per-page field inventories across multiple blocks', () => {
  const label = 'Model'.repeat(24)
  const largeSnapshots = snapshots.map(source => ({ ...source, text: `${source.text}\n${label}` }))
  const content = JSON.stringify({ pages: scope.map(block => ({ ...pages[0], blockId: block.blockId, expectedFields: Array.from({ length: 80 }, () => label) })) })
  assert.ok(content.length > 30000)
  const result = parseCaptureMapping(content, prd, largeSnapshots, scope, [listPath])
  assert.deepEqual(result.errors, [])
  assert.equal(result.pages.length, 3)
  assert.equal(result.pages[0].expectedFields?.length, 80)
  assert.throws(() => parseCaptureMapping('{"pages":[]}'.padEnd(200001, ' '), prd, snapshots, scope, []))
})
