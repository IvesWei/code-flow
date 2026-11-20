import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertPrototypeSources, validatePrototypeDesign } from './prototype-design.js'
import { prototypeScreens } from '../../shared/requirement-prototypes.js'
import { dualPrdFixture } from '../tests/fixtures/dual-prd.js'
import type { StructuredPrd } from '../../shared/requirements.js'

const prd: StructuredPrd = { title: 'Plans', summary: 'Create plan', blocks: [{ id: 'B1', title: 'Plans', content: 'Create', sourceIds: [], requirementIds: ['R1'] }], requirements: [{ id: 'R1', title: 'Create', description: 'Create plan', sourceIds: [], acceptance: [{ id: 'A1', text: 'Created' }] }] }
const prototype = { id: 'P1', title: 'Plans', html: '<!doctype html><html><head><style>.dialog{width:600px}</style></head><body><main data-requirement-id="R1" data-acceptance-id="A1"><section class="dialog" data-prototype-node="dialog"><input data-prototype-node="name"><p data-prototype-node="error" hidden>Required</p></section><p data-prototype-node="success" hidden>Created</p></main></body></html>', states: [
  { id: 'S1', name: 'Normal', requirementIds: ['R1'], acceptanceIds: ['A1'], changes: [] },
  { id: 'S2', name: 'Invalid', requirementIds: ['R1'], acceptanceIds: ['A1'], changes: [{ node: 'error', hidden: false, text: 'Name required' }] },
  { id: 'S3', name: 'Success', requirementIds: ['R1'], acceptanceIds: ['A1'], changes: [{ node: 'dialog', hidden: true }, { node: 'success', hidden: false, text: 'Plan created' }] },
] }
test('one shared dialog source produces three states and one layout edit changes every rendered state', () => {
  const before = validatePrototypeDesign([prototype], prd)
  const after = validatePrototypeDesign([{ ...prototype, html: prototype.html.replace('width:600px', 'width:720px') }], prd)
  assert.equal(after.prototypes.length, 1)
  assert.equal(after.screens.length, 3)
  assert.ok(after.screens.every(screen => screen.prototypeId === 'P1' && screen.html.includes('width:720px') && !screen.html.includes('width:600px')))
  assert.match(after.screens[1].html, /Name required/)
  assert.match(after.screens[2].html, /data-prototype-node="dialog" hidden/)
  assert.match(before.screens[0].html, /data-prototype-node="error" hidden/)
  assert.match(after.screens[2].html, /Plan created/)
})
test('state changes cannot override styles, inject markup, duplicate nodes or target missing nodes', () => {
  for (const change of [{ node: 'dialog', html: '<script>bad()</script>' }, { node: 'dialog', style: 'width:1px' }, { node: 'missing', hidden: false }, { node: 'dialog', text: 'Replace component' }]) assert.throws(() => validatePrototypeDesign([{ ...prototype, states: [{ ...prototype.states[0], changes: [change] }] }], prd))
  assert.throws(() => validatePrototypeDesign([{ ...prototype, html: prototype.html.replace('<input', '<span data-prototype-node="error"></span><input') }], prd))
  const escaped = validatePrototypeDesign([{ ...prototype, states: [{ ...prototype.states[0], changes: [{ node: 'success', text: '<img src=x onerror=alert(1)>', hidden: false }] }] }], prd)
  assert.match(escaped.screens[0].html, /&lt;img/)
  assert.doesNotMatch(escaped.screens[0].html, /<img/)
})
test('state node markers require eligible HTML elements while unmarked static SVG remains allowed', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="20"><rect width="100" height="20" fill="#123456"></rect></svg>'
  const valid = { ...prototype, html: prototype.html.replace('</main>', `<div data-prototype-node="chart">${svg}</div></main>`) }
  assert.ok(validatePrototypeDesign([valid], prd).screens.every(screen => screen.html.includes('<svg')))
  for (const html of [
    prototype.html.replace('<style>', '<style data-prototype-node="palette">'),
    prototype.html.replace('<html>', '<html data-prototype-node="document">'),
    prototype.html.replace('</main>', `${svg.replace('<svg ', '<svg data-prototype-node="chart" ')}</main>`),
    prototype.html.replace('</main>', `${svg.replace('<rect ', '<rect data-prototype-node="bar" ')}</main>`),
  ]) assert.throws(() => validatePrototypeDesign([{ ...prototype, html }], prd), /invalid prototype node element/)
})

test('derived HTML and state ownership cannot drift from the stored source', () => {
  const design = validatePrototypeDesign([prototype], prd)
  const revision = { id: 'V1', createdAt: '', prd, ...design }
  assert.doesNotThrow(() => assertPrototypeSources(revision))
  for (const patch of [{ html: design.screens[0].html.replace('600px', '900px') }, { prototypeId: 'OTHER' }, { state: 'Different' }]) {
    assert.throws(() => assertPrototypeSources({ ...revision, screens: revision.screens.map((screen, index) => index ? screen : { ...screen, ...patch }) }))
  }
  assert.throws(() => assertPrototypeSources({ ...revision, prototypes: undefined }))
  assert.deepEqual(prototypeScreens({ ...revision, screens: [...revision.screens, { ...revision.screens[0], id: 'OTHER', prototypeId: 'P2' }] }, 'S1').map(screen => screen.id), ['S1', 'S2', 'S3'])
  assert.equal(prototypeScreens(revision, 'missing').length, 0)
})
test('one page can render states with different requirement mappings without copying its layout', () => {
  const second = { id: 'R2', title: 'Validate', description: 'Validate name', sourceIds: [], acceptance: [{ id: 'A2', text: 'Error visible' }] }
  const expanded = { ...prd, blocks: [{ ...prd.blocks[0], requirementIds: ['R1', 'R2'] }], requirements: [...prd.requirements, second] }
  const source = { ...prototype, html: prototype.html.replace('data-prototype-node="error"', 'data-prototype-node="error" data-requirement-id="R2" data-acceptance-id="A2"'), states: [prototype.states[0], { ...prototype.states[1], requirementIds: ['R1', 'R2'], acceptanceIds: ['A1', 'A2'] }] }
  const result = validatePrototypeDesign([source], expanded)
  assert.doesNotMatch(result.screens[0].html, /data-requirement-id="R2"/)
  assert.match(result.screens[1].html, /data-requirement-id="R2"/)
  assert.match(result.screens[1].html, /data-acceptance-id="A2"/)
  assert.equal(result.prototypes[0].html, source.html)
  assert.throws(() => validatePrototypeDesign([prototype, { ...prototype, id: 'DUPLICATE' }], prd))
  assert.throws(() => validatePrototypeDesign([{ ...prototype, html: prototype.html.replace('</body>', '<script>alert(1)</script></body>') }], prd))
  assert.throws(() => validatePrototypeDesign([{ ...prototype, states: [{ ...prototype.states[0], changes: [{ node: 'name', value: 'secret' }] }], html: prototype.html.replace('<input', '<input type="password"') }], prd))
})

test('incremental mode requires sourceAnchor and preserves per-state proves and targeted capture metadata', () => {
  assert.throws(() => validatePrototypeDesign([{ ...prototype, mode: 'incremental' }], prd), /sourceAnchor/)
  assert.throws(() => validatePrototypeDesign([{ ...prototype, states: [{ ...prototype.states[0], capture: { mode: 'element' } }] }], prd), /selector/)
  const valid = validatePrototypeDesign([{
    ...prototype,
    mode: 'incremental',
    sourceAnchor: { route: '/plans', layout: 'src/layouts/BaseLayout.tsx', pageFile: 'src/pages/Plans/index.tsx' },
    states: prototype.states.map((state, index) => ({
      ...state,
      proves: `State ${index + 1} proof`,
      ...(index === 0 ? { capture: { mode: 'viewport', scrollTo: '[data-prototype-node="dialog"]' } } : {}),
    })),
  }], prd)
  assert.equal(valid.prototypes[0].mode, 'incremental')
  assert.equal(valid.screens[0].proves, 'State 1 proof')
  assert.deepEqual(valid.screens[0].capture, { mode: 'viewport', scrollTo: '[data-prototype-node="dialog"]' })
  assert.doesNotThrow(() => assertPrototypeSources({ id: 'V2', createdAt: '', prd, ...valid }))
})

test('dual-template FR/AC specification codes normalize to canonical requirement and acceptance IDs and reject empty visual prototypes', () => {
  const dual = dualPrdFixture(prd)
  assert.throws(() => validatePrototypeDesign([], dual), /empty prototypes array/)
  const nonVisual: StructuredPrd = { ...prd, requirements: [{ ...prd.requirements[0], nonVisualReason: 'Backend batch rule with no UI surface' }] }
  assert.deepEqual(validatePrototypeDesign([], nonVisual), { prototypes: [], screens: [] })

  const aliased = validatePrototypeDesign([{
    id: 'PAGE-1',
    title: '计划列表页',
    mode: 'redesign',
    html: '<!doctype html><html><head><style>main{padding:24px}</style></head><body><main data-requirement-id="FR-01" data-acceptance-id="AC-01"><p data-prototype-node="status">正常</p></main></body></html>',
    states: [{ id: 'STATE-1', name: '默认态', proves: '展示默认状态', requirementIds: ['FR-01'], acceptanceIds: ['AC-01'], changes: [] }],
  }], dual)
  assert.deepEqual(aliased.prototypes[0].states[0].requirementIds, ['R1'])
  assert.deepEqual(aliased.prototypes[0].states[0].acceptanceIds, ['A1'])
  assert.match(aliased.prototypes[0].html, /data-requirement-id="R1"/)
  assert.match(aliased.prototypes[0].html, /data-acceptance-id="A1"/)
  assert.match(aliased.screens[0].html, /data-requirement-id="R1"/)
  assert.match(aliased.screens[0].html, /data-acceptance-id="A1"/)
  assert.doesNotThrow(() => assertPrototypeSources({ id: 'V-DUAL', createdAt: '', prd: dual, ...aliased }))
})