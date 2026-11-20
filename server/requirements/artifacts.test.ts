import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { chromium } from 'playwright-core'
import type { RequirementProject, RequirementRevision } from '../../shared/requirements.js'
import { exportRequirementRevision, validatePrototypeRevision } from './artifacts.js'
import { validatePrototypeDesign } from './prototype-design.js'
import { renderSourceReconstruction, sourceReconstructionInput } from './source-reconstruction.js'
import { readSourceFile } from './sources.js'

function fixture() {
  const revision: RequirementRevision = {
    id: '22222222-2222-4222-8222-222222222222', createdAt: '2026-10-29T00:00:00.000Z',
    prd: { title: 'Example <script>alert(1)</script>', summary: 'A deterministic specification', blocks: [{ id: 'B1', title: 'Scope', content: 'Owned documents', requirementIds: ['R1'], sourceIds: ['S1'], table: { columns: ['Name', 'Value'], rows: [['Pipe | cell', '<unsafe>']] } }], requirements: [{ id: 'R1', title: 'Inspect', description: 'Inspect the screen', sourceIds: ['S1'], acceptance: [{ id: 'A1', text: 'Visible content' }] }] },
    screens: [{ id: '33333333-3333-4333-8333-333333333333', title: 'Overview', state: 'default', requirementIds: ['R1'], acceptanceIds: ['A1'], html: '<main data-requirement-id="R1"><h1 data-acceptance-id="A1">Requirement overview</h1><p>Visible static evidence</p></main>' }],
  }
  const project: RequirementProject = { schemaVersion: 1, id: '11111111-1111-4111-8111-111111111111', ownerId: 1, version: 1, title: 'Project', description: '', modelId: 'test', createdAt: revision.createdAt, updatedAt: revision.createdAt, status: 'draft', sources: [{ id: 'S1', name: 'Source', kind: 'file', sha256: 'abc', sizeBytes: 3 }], evidence: [{ sourceId: 'S1', summary: 'Read source', limitations: 'Example only' }], questions: [], decisions: [{ question: { id: 'Q1', priority: 'P1', text: 'Which view?', impact: 'Layout', choices: ['Overview'], recommendation: 'Overview' }, answer: 'Overview', at: revision.createdAt }], revisions: [revision], jobs: [], events: [] }
  return { project, revision }
}

test('pre-change source evidence excludes the target design and saves only mapped, visible originals as separate PNGs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'requirement-before-'))
  try {
    const { project, revision } = fixture()
    project.sources[0].name = 'existing-project-code.md'
    project.title = 'TARGET_ONLY'
    revision.screens[0].html = '<main>TARGET_ONLY</main>'
    revision.capturePlan = { version: 1, fingerprint: 'f'.repeat(64), blocks: [{ blockId: 'B1', kind: 'existing', reason: 'TARGET_ONLY' }], sourceFallback: { code: 'PAGE_CAPTURE_TARGET', blocks: [{ blockId: 'B1', fields: ['Original field'], content: [] }] } }
    const input = sourceReconstructionInput(project, revision)
    assert.doesNotMatch(JSON.stringify(input), /TARGET_ONLY|Inspect the screen/)
    const result = { prototypes: [{ id: 'EDITOR', title: 'Original', mode: 'incremental' as const, sourceAnchor: { route: '/editor', layout: 'Layout.tsx', pageFile: 'Editor.tsx' }, html: '<!doctype html><html><body><main data-requirement-id="SOURCE-1" data-acceptance-id="OBS-1">Original field</main></body></html>', states: [{ id: 'OLD', name: 'Existing', requirementIds: ['SOURCE-1'], acceptanceIds: ['OBS-1'], changes: [] }] }] }
    const signal = new AbortController().signal
    const [replica] = await renderSourceReconstruction(input, revision, result, root, signal)
    assert.equal(replica.blockId, 'B1')
    assert.equal((await readSourceFile(root, project.ownerId, project.id, replica.image)).buffer.readUInt32BE(16), 1600)
    assert.equal(revision.existingPages, undefined)
    assert.equal(revision.screenshots, undefined)
    result.prototypes[0].html = result.prototypes[0].html.replace('Original field', 'Something else<span hidden>Original field</span>')
    await assert.rejects(renderSourceReconstruction(input, revision, result, root, signal), /SOURCE_RECONSTRUCTION/)
    result.prototypes[0].html = result.prototypes[0].html.replace('<span hidden>', '<span style="position:absolute;top:1400px">')
    await assert.rejects(renderSourceReconstruction(input, revision, result, root, signal), /SOURCE_RECONSTRUCTION/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Markdown is deterministic, structured, traceable and explicitly a discussion draft', async () => {
  const { project, revision } = fixture()
  const first = await exportRequirementRevision(project, revision, 'md', 'not-used')
  const pageDocument = first.buffer.toString()
  assert.ok(pageDocument.indexOf('## Scope') < pageDocument.indexOf('### R1: Inspect'))
  assert.ok(pageDocument.indexOf('### R1: Inspect') < pageDocument.indexOf('## Screen Mapping'))
  assert.ok(pageDocument.indexOf('## Screen Mapping') < pageDocument.indexOf('## Provenance appendix'))
  assert.ok(pageDocument.indexOf('## Provenance appendix') < pageDocument.indexOf('## Sources'))
  assert.doesNotMatch(pageDocument, /## Requirements\n/)
  const second = await exportRequirementRevision(project, revision, 'md', 'not-used')
  assert.deepEqual(first, second)
  const text = first.buffer.toString()
  for (const expected of ['Discussion draft', '## Sources', 'S1', '## Decisions', 'Q1', '## Screen Mapping', 'R1', 'A1', 'Pipe \\| cell', 'interactions are not verified']) assert.ok(text.includes(expected), expected)
  assert.equal(first.contentType, 'text/markdown; charset=utf-8')
})

test('module names and field lists survive Markdown and Word export', async () => {
  const { project, revision } = fixture()
  revision.prd.blocks[0].module = 'Case management'
  revision.prd.requirements[0].fields = [{ name: 'Case name', description: 'Keyword matching' }, { name: 'Case type', description: 'Filter by type' }]
  const markdown = await exportRequirementRevision(project, revision, 'md', 'not-used')
  assert.match(markdown.buffer.toString(), /Module: Case management/)
  assert.match(markdown.buffer.toString(), /Fields:\n- Case name: Keyword matching\n- Case type: Filter by type/)
  const word = await exportRequirementRevision(project, revision, 'docx', 'not-used')
  const { unzipSync, strFromU8 } = await import('fflate')
  const xml = strFromU8(unzipSync(word.buffer)['word/document.xml'])
  for (const text of ['Case management', 'Case name', 'Keyword matching', 'Case type', 'Filter by type']) assert.ok(xml.includes(text), text)
})

test('PRD-only Word requires screenshots and never silently falls back to a text-only export', async () => {
  const { project, revision } = fixture()
  await assert.rejects(exportRequirementRevision(project, revision, 'docx', 'not-used', 'prd'), /缺少完整的原型截图/)
  await assert.rejects(exportRequirementRevision(project, { ...revision, screens: [] }, 'docx', 'not-used', 'prd'), /缺少完整的原型截图/)
  await assert.rejects(exportRequirementRevision(project, revision, 'md', 'not-used', 'prd'), /Unsupported PRD export/)
  assert.ok((await exportRequirementRevision(project, revision, 'docx', 'not-used')).buffer.length)
})

test('PRD-only Word embeds every selected-revision state screenshot and omits process records', { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'requirement-prd-export-'))
  try {
    const { project, revision } = fixture()
    revision.prd.blocks[0].module = 'Case management'
    revision.prd.requirements[0].scenario = 'Inspect the default and empty views'
    revision.prd.requirements[0].fields = [{ name: 'Case name', description: 'Keyword matching' }]
    revision.screens.push({ ...revision.screens[0], id: '44444444-4444-4444-8444-444444444444', state: 'empty', html: '<main data-requirement-id="R1"><h1 data-acceptance-id="A1">Empty overview</h1><p>HTML_SOURCE_SENTINEL</p></main>' })
    const captured = await validatePrototypeRevision(project, revision, root)
    assert.deepEqual(captured.validation.errors, [])
    assert.equal(captured.screenshots!.length, 2)
    const latest = { ...structuredClone(revision), id: '55555555-5555-4555-8555-555555555555', prd: { ...revision.prd, summary: 'LATEST_REVISION_SENTINEL' } }
    project.revisions = [captured, latest]
    const before = structuredClone(project)
    const document = await exportRequirementRevision(project, captured, 'docx', root, 'prd')
    assert.equal(document.filename, `prd-${project.id}-${captured.id}.docx`)
    assert.equal(document.contentType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    const { unzipSync, strFromU8 } = await import('fflate')
    const entries = unzipSync(document.buffer)
    const xml = strFromU8(entries['word/document.xml'])
    for (const text of ['A deterministic specification', '模块：Case management', '功能名称：Inspect', '对应场景：Inspect the default and empty views', '功能描述：', 'Inspect the screen', '包含以下字段', 'Case name', 'Keyword matching', '设计稿：Overview · default', '设计稿：Overview · empty', '页面说明：Scope', 'Name：Pipe | cell', 'Value：&lt;unsafe&gt;']) assert.ok(xml.includes(text), text)
    assert.ok(xml.indexOf('功能名称：Inspect') < xml.indexOf('设计稿：Overview · default') && xml.indexOf('设计稿：Overview · empty') < xml.indexOf('页面说明：Scope'))
    assert.doesNotMatch(xml, /<w:tbl>|Visible content|对应原型截图|对应需求：|Provenance appendix|Sources|Evidence|Decisions|Validation|Project:|Revision:|Read source|Which view|Q1|HTML_SOURCE_SENTINEL|LATEST_REVISION_SENTINEL/)
    const footers = Object.entries(entries).filter(([name]) => /^word\/footer\d+\.xml$/.test(name)).map(([, bytes]) => strFromU8(bytes)).join('')
    assert.match(footers, /Discussion draft/)
    assert.match(footers, /interactions are not verified/)
    const media = Object.entries(entries).filter(([name]) => name.startsWith('word/media/') && name.endsWith('.png')).map(([, bytes]) => Buffer.from(bytes))
    assert.equal(media.length, captured.screens.length)
    for (const screenshot of captured.screenshots!) assert.ok(media.some(image => createHash('sha256').update(image).digest('hex') === screenshot.sha256))
    assert.deepEqual(project, before)
    for (const requirementIds of [[], ['UNKNOWN'], ['R1', 'UNKNOWN']]) await assert.rejects(exportRequirementRevision(project, { ...captured, screens: captured.screens.map((screen, index) => index ? screen : { ...screen, requirementIds }) }, 'docx', root, 'prd'), /未关联有效功能/)
    await assert.rejects(exportRequirementRevision(project, { ...captured, screenshots: captured.screenshots!.slice(0, 1) }, 'docx', root, 'prd'), /缺少完整的原型截图/)
    await assert.rejects(exportRequirementRevision(project, { ...captured, screenshots: captured.screenshots!.map(screenshot => ({ ...screenshot, sha256: 'bad' })) }, 'docx', root, 'prd'), /integrity/)
    await assert.rejects(exportRequirementRevision(project, { ...captured, screenshots: captured.screenshots!.map(screenshot => ({ ...screenshot, storageKey: screenshot.storageKey.replace(captured.id, latest.id) })) }, 'docx', root, 'prd'), /ownership/)
    await rm(join(root, captured.screenshots![0].storageKey))
    await assert.rejects(exportRequirementRevision(project, captured, 'docx', root, 'prd'), /ENOENT/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('HTML uses per-screen opaque sandbox, escaped text and a no-network policy without executable source', async () => {
  const { project, revision } = fixture()
  revision.screens[0].html += '<script>fetch("https://example.invalid/secret")</script>'
  const { buffer } = await exportRequirementRevision(project, revision, 'html', 'not-used')
  const html = buffer.toString()
  assert.ok(html.includes('sandbox=""'))
  assert.ok(html.includes('connect-src &#39;none&#39;'))
  assert.ok(html.includes('worker-src &#39;none&#39;'))
  assert.ok(html.includes('&lt;script&gt;'))
  assert.ok(!html.includes('<script>'))
  assert.ok(!html.includes('allow-scripts'))
  assert.ok(html.includes('type="radio"'))
})

test('invalid IDs, dangling mappings and cancellation fail closed without starting Chromium', async () => {
  const { project, revision } = fixture()
  await assert.rejects(exportRequirementRevision({ ...project, id: '../escape' }, revision, 'zip', '.'), /UUID/)
  revision.screens[0].acceptanceIds = ['unknown']
  const result = await validatePrototypeRevision(project, revision, '.')
  assert.equal(result.validation.allScreensValidated, false)
  assert.ok(result.validation.errors.some((error) => error.includes('dangling reference')))
  assert.deepEqual(result.screenshots, [])
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(validatePrototypeRevision(project, revision, '.', controller.signal), { name: 'AbortError' })
})

test('screenshot reads reject foreign, traversal, missing and hash-mismatched paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'requirement-artifact-'))
  try {
    const { project, revision } = fixture()
    const screenId = revision.screens[0].id
    revision.screenshots = [{ screenId, storageKey: '../secret.png', sha256: 'bad' }]
    await assert.rejects(exportRequirementRevision(project, revision, 'md', root), /ownership/)
    const key = `requirements/artifacts/${project.id}/${revision.id}/${screenId}.png`
    revision.screenshots[0].storageKey = key
    const path = join(root, key)
    await mkdir(join(root, 'requirements', 'artifacts', project.id, revision.id), { recursive: true })
    await assert.rejects(exportRequirementRevision(project, revision, 'md', root), /ENOENT/)
    await writeFile(path, 'not a PNG')
    await assert.rejects(exportRequirementRevision(project, revision, 'md', root), /integrity/)
    await rm(path)
    const outside = join(root, 'outside.png')
    await writeFile(outside, 'private')
    try { await symlink(outside, path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') return; throw error }
    await assert.rejects(exportRequirementRevision(project, revision, 'md', root), /Unsafe/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('isolated Chromium captures desktop-only evidence without requiring mobile compatibility and refuses stale complete labels', { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'requirement-browser-'))
  try {
    const { project, revision } = fixture()
    revision.screens[0].html = `<!doctype html><html><head><style>body{min-width:1200px}</style></head><body>${revision.screens[0].html}</body></html>`
    const result = await validatePrototypeRevision(project, revision, root)
    assert.deepEqual(result.validation.errors, [])
    assert.equal(result.validation.allScreensValidated, true)
    assert.equal(result.validation.interactionVerified, false)
    assert.equal(revision.screenshots, undefined)
    const shot = result.screenshots![0]
    const png = await readFile(join(root, shot.storageKey))
    assert.equal(png.readUInt32BE(16), 1600)
    assert.equal(png.readUInt32BE(20), 1000)
    assert.equal(createHash('sha256').update(png).digest('hex'), shot.sha256)
    await assert.rejects(readFile(join(root, shot.storageKey.replace('.png', '.mobile.png'))), { code: 'ENOENT' })
    assert.deepEqual(result.validation.screens[0].viewports, [{ width: 1600, height: 1000, errors: [] }])
    const confirmed = { ...result, confirmedAt: revision.createdAt, designConfirmedAt: revision.createdAt }
    assert.match((await exportRequirementRevision(project, confirmed, 'md', root)).buffer.toString(), /Complete delivery/)
    const { unzipSync, strFromU8 } = await import('fflate')
    const document = await exportRequirementRevision(project, confirmed, 'docx', root)
    const documentEntries = unzipSync(document.buffer)
    const xml = strFromU8(documentEntries['word/document.xml'])
    assert.ok(xml.includes('<w:tbl>'))
    assert.ok(xml.includes('R1'))
    assert.ok(Object.keys(documentEntries).some((name) => name.startsWith('word/media/')))
    const archive = await exportRequirementRevision(project, confirmed, 'zip', root)
    const entries = unzipSync(archive.buffer)
    assert.deepEqual(Object.keys(entries).sort(), ['index.html', 'manifest.json', 'requirements.docx', 'requirements.md', `screenshots/${shot.screenId}.png`].sort())
    assert.deepEqual(Buffer.from(entries[`screenshots/${shot.screenId}.png`]), png)
    assert.ok(Object.keys(entries).every((name) => !name.includes('..') && !name.startsWith('/')))
    const manifest = JSON.parse(strFromU8(entries['manifest.json']))
    assert.match(manifest.label, /Complete delivery/)
    assert.equal(manifest.validation.interactionVerified, false)
    confirmed.screens = confirmed.screens.map((screen) => ({ ...screen, html: `${screen.html}<p>changed</p>` }))
    assert.match((await exportRequirementRevision(project, confirmed, 'md', root)).buffer.toString(), /Discussion draft/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('scriptless native controls pass static validation without certifying interactions', { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'requirement-static-controls-'))
  try {
    const { project, revision } = fixture()
    const screen = revision.screens[0]
    Object.assign(revision, validatePrototypeDesign([{
      id: 'PAGE', title: screen.title,
      html: `<!doctype html><html><body>${screen.html}<label>Reason<textarea>Keep the task</textarea></label><button type="button">Finish</button></body></html>`,
      states: [{ id: screen.id, name: screen.state, requirementIds: screen.requirementIds, acceptanceIds: screen.acceptanceIds, changes: [] }],
    }], revision.prd))
    const result = await validatePrototypeRevision(project, revision, root)
    assert.deepEqual(result.validation.errors, [])
    assert.equal(result.validation.allScreensValidated, true)
    assert.equal(result.validation.interactionVerified, false)
    const [check] = result.validation.screens
    assert.equal(check.visual, 'passed')
    assert.equal(check.interaction, 'not_verified')
    assert.deepEqual(check.interactionErrors, [])
    assert.deepEqual(result.screenshots?.map((shot) => shot.screenId), [screen.id])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('scripts never execute or reach a local canary; static visuals and unverified interactions remain distinct', { timeout: 90_000 }, async () => {
  let requests = 0
  const server = createServer((_request, response) => { requests++; response.end('unexpected') })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const root = await mkdtemp(join(tmpdir(), 'requirement-hostile-'))
  try {
    const { project, revision } = fixture()
    revision.screens[0].html += `<button>Save</button><script>fetch('http://127.0.0.1:${address.port}/secret');while(true){}</script>`
    const result = await validatePrototypeRevision(project, revision, root)
    assert.equal(requests, 0)
    assert.equal(result.validation.screens[0].visual, 'passed')
    assert.equal(result.validation.screens[0].interaction, 'not_verified')
    assert.equal(result.validation.allScreensValidated, false)
    assert.deepEqual(result.validation.screens[0].interactionErrors, [])
    assert.match(result.validation.errors.join('\n'), /Unsafe prototype source: script elements and event handlers/)
    revision.screens[0].html = `<main data-requirement-id="R1"><h1 data-acceptance-id="A1">Visible</h1><div style="width:2000px">Overflow</div><img src="http://127.0.0.1:${address.port}/image"></main>`
    const broken = await validatePrototypeRevision(project, revision, root)
    assert.match(broken.validation.errors.join('\n'), /Unsafe prototype source: resource attributes/)
    assert.match(broken.validation.errors.join('\n'), /Horizontal geometry overflow/)
    assert.match(broken.validation.errors.join('\n'), /Broken or blocked image/)
    assert.equal(requests, 0)
    revision.screens[0].html = '<main data-requirement-id="R1" data-acceptance-id="A1"></main>'
    const blank = await validatePrototypeRevision(project, revision, root)
    assert.match(blank.validation.errors.join('\n'), /Blank/)
    revision.screens[0].html = '<main data-requirement-id="R1" data-acceptance-id="UNKNOWN"><h1>Unmapped</h1></main>'
    const unmapped = await validatePrototypeRevision(project, revision, root)
    assert.match(unmapped.validation.errors.join('\n'), /Missing visible mapping: A1/)
    assert.match(unmapped.validation.errors.join('\n'), /Dangling DOM mapping: UNKNOWN/)
  } finally {
    await rm(root, { recursive: true, force: true })
    await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()))
  }
})

test('standalone HTML chooser switches isolated frames by keyboard without executing prototype source', { timeout: 30_000 }, async () => {
  const { project, revision } = fixture()
  revision.screens.push({ ...revision.screens[0], id: '44444444-4444-4444-8444-444444444444', title: 'Second screen' })
  const { buffer } = await exportRequirementRevision(project, revision, 'html', '.')
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && /^(?:PATH|SYSTEMROOT|WINDIR|TEMP|TMP|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\))$/i.test(entry[0])))
  const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true, env })
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 1000 }, serviceWorkers: 'block' })
    await context.route('**/*', (route) => route.abort())
    const page = await context.newPage()
    await page.setContent(buffer.toString())
    assert.equal(await page.locator('.screen').nth(0).isVisible(), true)
    assert.equal(await page.locator('.screen').nth(1).isVisible(), false)
    await page.locator('#screen-0').focus()
    await page.keyboard.press('ArrowRight')
    assert.equal(await page.locator('.screen').nth(1).isVisible(), true)
    assert.equal(await page.locator('.screen').nth(0).isVisible(), false)
    assert.equal(await page.locator('iframe').nth(1).getAttribute('sandbox'), '')
    assert.equal(await page.locator('script').count(), 0)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  } finally { await browser.close() }
})
test('ZIP retains one shared source plus declarative states and refuses a drifted derived screen', async () => {
  const { project, revision } = fixture()
  const source = { id: 'PAGE', title: 'Overview', html: `<!doctype html><html><body>${revision.screens[0].html}</body></html>`, states: [{ id: revision.screens[0].id, name: 'default', requirementIds: ['R1'], acceptanceIds: ['A1'], changes: [] }] }
  Object.assign(revision, validatePrototypeDesign([source], revision.prd))
  const exported = await exportRequirementRevision(project, revision, 'zip', 'not-used')
  const { unzipSync, strFromU8 } = await import('fflate')
  const entries = unzipSync(exported.buffer)
  assert.deepEqual(JSON.parse(strFromU8(entries['prototype-sources.json'])), { schemaVersion: 1, prototypes: [source] })
  assert.equal(JSON.parse(strFromU8(entries['manifest.json'])).screens[0].prototypeId, 'PAGE')
  revision.screens[0].html += '<p>Independent drift</p>'
  await assert.rejects(exportRequirementRevision(project, revision, 'zip', 'not-used'), /shared prototype/)
})

test('targeted scrollTo, element and fullPage capture modes validate off-fold and dialog regions cleanly', { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'requirement-targeted-capture-'))
  try {
    const { project, revision } = fixture()
    revision.screens = [
      {
        id: '33333333-3333-4333-8333-333333333333', title: 'Lower fold', state: 'scroll',
        capture: { mode: 'viewport', scrollTo: '#target-fold' },
        requirementIds: ['R1'], acceptanceIds: ['A1'],
        html: '<!doctype html><html><body style="margin:0"><div style="height:1300px;background:#eef4f0">Header</div><section id="target-fold" data-requirement-id="R1" data-acceptance-id="A1" style="height:260px;background:#1d5c3f;color:#fff;padding:24px">Lower section visible after scrollTo</section></body></html>',
      },
      {
        id: '44444444-4444-4444-8444-444444444444', title: 'Modal close-up', state: 'element',
        capture: { mode: 'element', selector: '#impact-modal', padding: 8 },
        requirementIds: ['R1'], acceptanceIds: ['A1'],
        html: '<!doctype html><html><body style="margin:0;background:#dde5e0;padding:120px"><div id="impact-modal" data-requirement-id="R1" data-acceptance-id="A1" style="width:520px;height:260px;background:#ffffff;border:2px solid #1d5c3f;padding:24px;color:#182321">Impact dialog close-up</div></body></html>',
      },
      {
        id: '55555555-5555-4555-8555-555555555555', title: 'Long report', state: 'fullPage',
        capture: { mode: 'fullPage' },
        requirementIds: ['R1'], acceptanceIds: ['A1'],
        html: '<!doctype html><html><body style="margin:0"><div style="height:1250px;background:#f4f7f5">Top</div><footer data-requirement-id="R1" data-acceptance-id="A1" style="height:240px;background:#244c3c;color:#fff;padding:24px">Bottom report</footer></body></html>',
      },
    ]
    const validated = await validatePrototypeRevision(project, revision, root)
    assert.deepEqual(validated.validation.errors, [])
    assert.equal(validated.validation.allScreensValidated, true)
    assert.equal(validated.screenshots?.length, 3)
    const elementPng = await readFile(join(root, validated.screenshots![1].storageKey))
    assert.ok(elementPng.readUInt32BE(16) < 1600 && elementPng.readUInt32BE(16) >= 520)
    const fullPng = await readFile(join(root, validated.screenshots![2].storageKey))
    assert.equal(fullPng.readUInt32BE(16), 1600)
    assert.ok(fullPng.readUInt32BE(20) >= 1490)
    const exported = await exportRequirementRevision(project, validated, 'docx', root, 'prd')
    assert.ok(exported.buffer.length > 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})