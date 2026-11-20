import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { captureExistingPages, parseCaptureTargets } from './page-capture.js'
import { captureDiscoveryPathMatches } from './capture-discovery.js'

const prd = { title: 'Plans', summary: 'Scope', blocks: [{ id: 'B3', title: 'Shared detail', content: '', requirementIds: ['R1'], sourceIds: [] }], requirements: [{ id: 'R1', title: 'Plan', description: '', sourceIds: [], acceptance: [] }] }
const quote = 'const goPlan = id => history.push("/plans/detail?projectId=" + projectId + "&testPlanId=" + id + "&planType=1");'
const testQuote = quote.replace('planType=1', 'planType=0')
const columnQuote = 'title: "Plan name", render: row => <a onClick={() => goPlan(row.id)}>{row.name}</a>'
const snapshots = [{ sourceId: 'S1', name: 'code', text: `const self = "/plans/self"; const test = "/plans/test";\n${quote}\n${testQuote}\n${columnQuote}\nModel\nEdit plan` }]
const entry = { blockId: 'B3', kind: 'existing', path: '/plans/self?projectId=34', sourceId: 'S1', quote: 'const self = "/plans/self";', expectedFields: ['Model'] }
const discovery = { fromPath: entry.path, path: '/plans/detail', column: 'Plan name', queryKeys: ['projectId', 'testPlanId', 'planType'], sourceId: 'S1', quote, columnQuote, handler: 'goPlan' }

test('discovery proposals require approved lists and source-backed record opening, never concrete invented IDs', () => {
  const targets = parseCaptureTargets(JSON.stringify({ pages: [{ ...entry, discover: [discovery, { ...discovery, quote: testQuote, fromPath: '/plans/test?projectId=34' }] }] }), prd, snapshots, undefined, [entry.path, '/plans/test?projectId=34'])
  assert.equal(targets.length, 2)
  assert.deepEqual(targets.map(target => target.viewId), ['B3-view-1', 'B3-view-2'])
  assert.equal(captureDiscoveryPathMatches(discovery, '/plans/detail?projectId=34&testPlanId=731&planType=1', 'http://localhost'), true)
  for (const path of ['/plans/detail?projectId=35&testPlanId=731&planType=1', '/plans/detail?projectId=34&testPlanId=731&planType=0', '/plans/detail?projectId=34&testPlanId=731', '/plans/detail?projectId=34&testPlanId=731&planType=1&token=secret', '/plans/other?projectId=34&testPlanId=731&planType=1']) assert.equal(captureDiscoveryPathMatches(discovery, path, 'http://localhost'), false)
  for (const change of [
    { fromPath: '/plans/self?projectId=99' }, { path: '/invented' }, { path: '/plans/detail?testPlanId=123' },
    { quote: 'invented' }, { columnQuote: 'Plan name' }, { handler: 'deletePlan' }, { column: 'Actions' },
    { queryKeys: ['testPlanId', 'planType'] }, { queryKeys: ['projectId', 'token'] },
  ]) assert.throws(() => parseCaptureTargets(JSON.stringify({ pages: [{ ...entry, discover: [{ ...discovery, ...change }] }] }), prd, snapshots, undefined, [entry.path]), /PAGE_MAPPING/)
})

test('isolated discovery opens real href and SPA records from the name column, preserves both variants and blocks writes', { timeout: 90_000 }, async () => {
  let writes = 0, unwanted = 0
  const visits: string[] = []
  const server = createServer((request, response) => {
    if (!['GET', 'HEAD'].includes(request.method!)) writes++
    visits.push(request.url!)
    if (request.url!.startsWith('/wrong') || request.url!.startsWith('/delete')) unwanted++
    response.setHeader('Content-Type', 'text/html')
    if (request.url!.startsWith('/plans/detail')) { response.end('<main><h1>Plan detail</h1><label>Model</label></main>'); return }
    const spa = request.url!.startsWith('/plans/test')
    response.end(`<main><h1>Plans</h1><div class="ant-table"><div class="ant-table-header"><table><thead><tr><th>Plan name</th><th>Actions</th></tr></thead></table></div><div class="ant-table-body"><table><tbody><tr><td>${spa
      ? `<a onclick="history.pushState({},'', '/plans/detail?projectId=34&testPlanId=902&planType=0');document.querySelector('main').innerHTML='<h1>Plan detail</h1><label>Model</label>';fetch('/delete',{method:'POST'})">Existing test plan</a>`
      : '<a href="/plans/detail?projectId=34&testPlanId=731&planType=1">Existing self plan</a>'}</td><td><a href="/delete">Delete</a></td></tr></tbody></table></div></div></main>`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const targets = parseCaptureTargets(JSON.stringify({ pages: [{ ...entry, discover: [discovery, { ...discovery, quote: testQuote, fromPath: '/plans/test?projectId=34' }] }] }), prd, snapshots, undefined, [entry.path, '/plans/test?projectId=34'])
    const captures = await captureExistingPages(origin, targets, new AbortController().signal)
    assert.deepEqual(captures.map(capture => capture.path), ['/plans/detail?projectId=34&testPlanId=731&planType=1', '/plans/detail?projectId=34&testPlanId=902&planType=0'])
    assert.deepEqual(captures.map(capture => capture.viewId), ['B3-view-1', 'B3-view-2'])
    assert.ok(captures.every(capture => capture.png.length > 100 && capture.structure.fields.includes('Model')))
    assert.ok(visits.includes('/plans/detail?projectId=34&testPlanId=731&planType=1'))
    assert.equal(writes, 0)
    assert.equal(unwanted, 0)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('discovery rejects empty lists, foreign projects, branch changes, redirects and unsafe record links', { timeout: 90_000 }, async () => {
  const visits: string[] = []
  let writes = 0
  const server = createServer((request, response) => {
    visits.push(request.url!)
    if (!['GET', 'HEAD'].includes(request.method!)) writes++
    if (request.url!.startsWith('/plans/detail')) {
      response.writeHead(302, { Location: '/plans/detail?projectId=34&testPlanId=999&planType=1' }).end()
      return
    }
    const route = request.url!.split('?')[0]
    const links: Record<string, string> = {
      '/empty': '',
      '/foreign-project': '<a href="/plans/detail?projectId=35&testPlanId=731&planType=1">Plan</a>',
      '/wrong-branch': '<a href="/plans/detail?projectId=34&testPlanId=731&planType=0">Plan</a>',
      '/javascript': '<a href="javascript:fetch(\'/write\',{method:\'POST\'})">Plan</a>',
      '/redirect': '<a href="/plans/detail?projectId=34&testPlanId=731&planType=1">Plan</a>',
    }
    response.setHeader('Content-Type', 'text/html')
    response.end(`<main><h1>Plans</h1><table><thead><tr><th scope="col">Plan name</th></tr></thead><tbody>${links[route] ? `<tr><td>${links[route]}</td></tr>` : ''}</tbody></table></main>`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    for (const route of ['/empty', '/foreign-project', '/wrong-branch', '/javascript', '/redirect']) {
      const path = `${route}?projectId=34`
      await assert.rejects(captureExistingPages(origin, [{ blockId: 'B3', path, discovery: { ...discovery, fromPath: path }, expectedFields: ['Model'] }], new AbortController().signal), /PAGE_CAPTURE_DISCOVERY_(?:EMPTY|TARGET)/)
    }
    assert.equal(writes, 0)
    assert.ok(!visits.some(path => path.includes('projectId=35') || path.includes('testPlanId=999') || path.includes('/write')))
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})
