import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inspectRequirementHtml } from './html-policy.js'
import { RequirementOutputError, validateEvidence, validatePrd, validateQuestions, validateScreens } from './validation.js'
import { requirementDiagnostic } from './diagnostics.js'

export const prdFixture = {
  title: 'Product', summary: 'Scope',
  requirements: [{ id: 'REQ-1', title: 'List', description: 'List records', sourceIds: ['SRC-1'], acceptance: [{ id: 'AC-1', text: 'Records visible' }] }],
  blocks: [{ id: 'B-1', title: 'Flow', content: 'Show list', requirementIds: ['REQ-1'], sourceIds: ['SRC-1'], table: { columns: ['Field'], rows: [['Name']] } }],
}
test('PRD validates tables, references, unique IDs and prototype safety', () => {
  assert.deepEqual(validatePrd(prdFixture, ['SRC-1']), prdFixture)
  assert.throws(() => validatePrd({ ...prdFixture, constructor: 'bad' }))
  assert.throws(() => validatePrd(prdFixture, []))
  assert.throws(() => validatePrd({ ...prdFixture, requirements: [...prdFixture.requirements, ...prdFixture.requirements] }))
  assert.throws(() => validatePrd({ ...prdFixture, blocks: [{ ...prdFixture.blocks[0], table: { columns: ['One'], rows: [['a', 'b']] } }] }))
})
test('questions and evidence reject unsafe, missing and malformed data', () => {
  assert.deepEqual(validateQuestions([]), [])
  assert.throws(() => validateQuestions(Array(10).fill({})))
  assert.throws(() => validateQuestions([{ id: 'Q1', priority: 'P0', text: 'Which?', impact: 'Data', choices: ['a', 'b'], recommendation: 'c' }]))
  assert.throws(() => validateEvidence([], [{ id: 'SRC-1' } as never]))
  assert.throws(() => validateEvidence([{ sourceId: 'other', summary: 'text', limitations: '' }], []))
})
test('screens require actual mapping, coverage and standalone local content', () => {
  const screen = { id: 'S1', title: 'List', state: 'normal', requirementIds: ['REQ-1'], acceptanceIds: ['AC-1'], html: '<!doctype html><html><body><main data-requirement-id="REQ-1">Records</main><script>document.querySelector("main").onclick = () => {};</script></body></html>' }
  assert.equal(validateScreens([screen], prdFixture).length, 1)
  assert.throws(() => validateScreens([], prdFixture))
  assert.throws(() => validateScreens([{ ...screen, html: screen.html.replace('Records', '<img src="https://evil.test">') }], prdFixture))
  assert.throws(() => validateScreens([{ ...screen, acceptanceIds: ['AC-other'] }], prdFixture))
  assert.throws(() => validateScreens([{ ...screen, html: screen.html.replace('data-requirement-id', 'data-other') }], prdFixture))
  assert.throws(() => validateScreens([{ ...screen, html: '<!doctype html><html><body><!-- <main data-requirement-id="REQ-1">Fake</main> --></body></html>' }], prdFixture))
})
test('nonvisual exemptions need an explanation and IDs cannot collide across PRD namespaces', () => {
  const nonVisual = { ...prdFixture, requirements: [{ ...prdFixture.requirements[0], nonVisualReason: 'Nightly server maintenance; there is no user-facing control or state.' }] }
  assert.deepEqual(validateScreens([], validatePrd(nonVisual)), [])
  assert.throws(() => validatePrd({ ...prdFixture, requirements: [{ ...prdFixture.requirements[0], nonVisualReason: 'N/A' }] }))
  assert.throws(() => validatePrd({ ...prdFixture, blocks: [{ ...prdFixture.blocks[0], id: 'AC-1' }] }))
  assert.throws(() => validateQuestions(new Array(1)))
})

const policyScreen = (content: string) => ({ id: 'S1', title: 'List', state: 'normal', requirementIds: ['REQ-1'], acceptanceIds: ['AC-1'], html: `<!doctype html><html><body><main data-requirement-id="REQ-1">${content}</main></body></html>` })

test('screen count limit is rejected as output validation rather than storage failure', () => {
  const screens = Array.from({ length: 41 }, (_value, index) => ({ ...policyScreen('Records'), id: `S${index}` }))
  assert.equal(validateScreens(screens.slice(0, 40), prdFixture).length, 40)
  assert.throws(() => validateScreens(screens, prdFixture), error => {
    const diagnostic = requirementDiagnostic(error, 'storage')
    assert.equal(diagnostic.code, 'OUTPUT_VALIDATION')
    assert.match(diagnostic.message, /design screen limit exceeded \(maximum 40\)/)
    return true
  })
})

test('HTML policy accepts static URL text, SVG namespaces and self-contained raster assets', () => {
  for (const content of [
    '<p>https://example.test/guide and fetch() are displayed instructions</p>',
    '<!-- https://example.test <iframe src="remote"> -->',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24z" fill="currentColor"/></svg>',
    '<svg><defs><clipPath id="clip"><rect width="10" height="10"/></clipPath></defs><rect clip-path="url(#clip)"/></svg>',
    '<img src="data:image/png;base64,AAAA">',
    '<style>main { background: url("data:image/png;base64,AAAA"); } main::before { content: "https://example.test"; }</style>',
    '<main style="background-image:url(data:image/webp;base64,AAAA)"></main>',
    '<a href="#section">Section</a><script>document.querySelector("main").onclick = () => {};</script>',
  ]) assert.equal(validateScreens([policyScreen(content)], prdFixture).length, 1, content)
})

test('static screenshot policy checks source capabilities, not the presence of controls', () => {
  const violation = (content: string) => inspectRequirementHtml(policyScreen(content).html, 'static-script-disabled').violation
  assert.equal(violation('<form><input><textarea></textarea><select><option>Draft</option></select><button>Save</button></form><a role="tab" tabindex="0" href="#details">Details</a>'), undefined)
  assert.equal(violation('<button onclick="">Save</button>'), 'active_script')
  assert.equal(violation('<script type="application/json">{}</script>'), 'active_script')
  assert.equal(violation('<form action="/save"><button>Save</button></form>'), 'navigation_attribute')
  assert.equal(violation('<noscript><img src="/image.png"></noscript>'), 'resource_attribute')
})

test('HTML policy identifies resource contexts and keeps diagnostics redacted', () => {
  const cases = [
    ['<iframe></iframe>', 'embedded_document'],
    ['<link rel="stylesheet" href="https://SECRET_TOKEN.test">', 'embedded_document'],
    ['<img src="https://SECRET_TOKEN.test">', 'resource_attribute'],
    ['<img src="data:image/svg+xml;base64,AAAA">', 'resource_attribute'],
    ['<img srcset="https://SECRET_TOKEN.test 2x">', 'resource_attribute'],
    ['<a href="&#106;avascript:SECRET_TOKEN()">Go</a>', 'navigation_attribute'],
    ['<svg><use xlink:href="https://SECRET_TOKEN.test#x"/></svg>', 'navigation_attribute'],
    ['<form action="https://SECRET_TOKEN.test"></form>', 'navigation_attribute'],
    ['<meta http-equiv="refresh" content="0;url=https://SECRET_TOKEN.test">', 'metadata_directive'],
    ['<style>@import "https://SECRET_TOKEN.test";</style>', 'css_import'],
    ['<style>@\\69mport "https://SECRET_TOKEN.test";</style>', 'css_import'],
    ['<style>main { background:url(https://SECRET_TOKEN.test); }</style>', 'css_resource'],
    ['<main style="background:url(&#104;ttps://SECRET_TOKEN.test)"></main>', 'css_resource'],
    ['<svg><path fill="url(https://SECRET_TOKEN.test)"/></svg>', 'css_resource'],
    ['<style>main{background:image-set("https://SECRET_TOKEN.test" 1x)}</style>', 'css_capability'],
    ['<style>main{width:expression(SECRET_TOKEN())}</style>', 'css_capability'],
    ['<script>fetch("https://SECRET_TOKEN.test")</script>', 'script_capability'],
    ['<button onclick="localStorage.getItem(\'SECRET_TOKEN\')">Go</button>', 'script_capability'],
  ]
  for (const [content, category] of cases) assert.throws(() => validateScreens([policyScreen(content)], prdFixture), error => {
    assert.ok(error instanceof RequirementOutputError, content)
    assert.equal(error.htmlViolation, category, content)
    const diagnostic = requirementDiagnostic(error, 'parse')
    assert.match(diagnostic.message, /screen 1;/)
    assert.ok(diagnostic.message.includes(category))
    assert.doesNotMatch(diagnostic.message, /SECRET_TOKEN/)
    return true
  })
})

test('HTML mappings are parsed attributes, never comments, script text or inert templates', () => {
  for (const fake of ['<!-- <main data-requirement-id="REQ-1"></main> -->', '<template><main data-requirement-id="REQ-1"></main></template>', '<script data-requirement-id="REQ-1">const text="Records";</script>', '<style data-requirement-id="REQ-1">main{color:red}</style>']) {
    const screen = policyScreen(fake)
    screen.html = screen.html.replace('<main data-requirement-id="REQ-1">', '<main>')
    assert.throws(() => validateScreens([screen], prdFixture), /HTML requirement mapping mismatch/)
  }
  const screen = policyScreen('Records')
  screen.html = screen.html.replace('"REQ-1"', 'REQ-1')
  assert.equal(validateScreens([screen], prdFixture).length, 1)
})
test('PRD module and field metadata round-trip without changing legacy contracts', () => {
  const enriched = { ...prdFixture, blocks: [{ ...prdFixture.blocks[0], module: 'Case management' }], requirements: [{ ...prdFixture.requirements[0], fields: [{ name: 'Case name', description: 'Keyword match' }, { name: 'Type', description: '' }] }] }
  assert.deepEqual(validatePrd(enriched, ['SRC-1']), enriched)
  const withScenario = { ...enriched, requirements: [{ ...enriched.requirements[0], scenario: '复盘节点填写多个问题' }] }
  assert.deepEqual(validatePrd(withScenario, ['SRC-1']), withScenario)
  for (const scenario of [null, 1, 'x'.repeat(4001)]) assert.throws(() => validatePrd({ ...enriched, requirements: [{ ...enriched.requirements[0], scenario }] }))
  assert.deepEqual(validatePrd(prdFixture, ['SRC-1']), prdFixture)
  for (const module of [null, '', 1, 'x'.repeat(301)]) assert.throws(() => validatePrd({ ...enriched, blocks: [{ ...enriched.blocks[0], module }] }))
  for (const fields of [null, {}, [{ name: '', description: '' }], [{ name: 'Name' }], [{ name: 'Name', description: '', unexpected: true }], Array(201).fill({ name: 'Name', description: '' })]) assert.throws(() => validatePrd({ ...enriched, requirements: [{ ...enriched.requirements[0], fields }] }))
  assert.throws(() => validatePrd({ ...enriched, requirements: [{ ...enriched.requirements[0], fields: [{ name: '测试报告', type: '文件上传', required: true, purpose: '说明', SECRET_TOKEN: 'private' }] }] }, ['SRC-1']), error => {
    const diagnostic = requirementDiagnostic(error, 'output_validation')
    assert.equal(diagnostic.code, 'OUTPUT_VALIDATION')
    assert.match(diagnostic.message, /unexpected field \(prd\.requirements\[\]\.fields\[\] allows only name, description/)
    assert.doesNotMatch(diagnostic.message, /SECRET_TOKEN|private/)
    return true
  })
})