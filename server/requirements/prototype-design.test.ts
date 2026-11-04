import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertPrototypeSources, validatePrototypeDesign } from './prototype-design.js'
import { prototypeScreens } from '../../shared/requirement-prototypes.js'
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