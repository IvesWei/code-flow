import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { chromium, type Browser } from 'playwright-core'
import type { RequirementLoginControls } from '../../shared/requirements.js'
import { requirementPreviewEntry, requirementPreviewOrigin, requirementPreviewPath } from '../../shared/requirement-preview.js'
import { captureExistingPages, parseCaptureTargets } from './page-capture.js'

test('preview configuration allows exact authorized test origins and rejects unsafe origins and routes', () => {
  assert.equal(requirementPreviewOrigin('http://localhost:5173'), 'http://localhost:5173')
  assert.equal(requirementPreviewOrigin('https://tmp.test.sunmi.com'), 'https://tmp.test.sunmi.com')
  assert.equal(requirementPreviewOrigin('https://TMP.TEST.SUNMI.COM:443/'), 'https://tmp.test.sunmi.com')
  for (const value of ['https://example.com', 'http://user:pass@localhost', 'http://localhost/private', 'file:///tmp', 'http://tmp.test.sunmi.com', 'https://tmp.test.sunmi.com:8443', 'https://tmp.test.sunmi.com.evil.invalid', 'https://other.tmp.test.sunmi.com', 'https://tmp.test.sunmi.com@evil.invalid', 'https://user:pass@tmp.test.sunmi.com', 'https://tmp.test.sunmi.com/orders', 'https://tmp.test.sunmi.com?next=admin', 'https://tmp.test.sunmi.com#orders']) assert.throws(() => requirementPreviewOrigin(value))
  for (const value of ['//outside', '/../admin', '/orders?delete=1', '/%2e%2e', 'https://example.com']) assert.throws(() => requirementPreviewPath(value))
})

test('query capture routes require supplied concrete context and source-backed keys; repeated field labels retain order', () => {
  const prd = { title: 'Plans', summary: 'Scope', blocks: [{ id: 'B1', title: 'Plans', content: '', requirementIds: ['R1'], sourceIds: [] }], requirements: [{ id: 'R1', title: 'Plan', description: '', sourceIds: [], acceptance: [] }] }
  const snapshots = [{ sourceId: 'S1', name: 'code', text: 'path: "/plans"; new URLSearchParams(location.search).get("projectId");\nModel\nOwner\nModel' }]
  const entry = { blockId: 'B1', kind: 'existing', path: '/plans?projectId=42', sourceId: 'S1', quote: 'path: "/plans";', expectedFields: ['Model', 'Owner', 'Model'] }
  const content = JSON.stringify({ pages: [entry] })
  assert.throws(() => parseCaptureTargets(content, prd, snapshots), /入口/)
  assert.deepEqual(parseCaptureTargets(content, prd, snapshots, undefined, [entry.path]), [{ blockId: 'B1', path: entry.path, expectedFields: entry.expectedFields }])
  assert.throws(() => parseCaptureTargets(content, prd, snapshots, undefined, ['/plans?projectId=43']), /入口/)
  assert.throws(() => parseCaptureTargets(JSON.stringify({ pages: [{ ...entry, path: '/plans' }] }), prd, snapshots, undefined, [entry.path]), /查询上下文/)
  assert.throws(() => parseCaptureTargets(content, prd, [{ ...snapshots[0], text: 'path: "/plans";\nModel\nOwner' }], undefined, [entry.path]), /参数/)
  assert.equal(requirementPreviewEntry('https://tmp.test.sunmi.com/plans?projectId=42', 'https://tmp.test.sunmi.com'), entry.path)
  for (const path of ['/plans?token=secret', '/plans?redirect=https%3A%2F%2Fevil.invalid', '/plans?projectId=1&projectId=2', '/plans?projectId=%0a', '/plans#tab', '/plans?projectId=', '/plans?delete=1']) assert.throws(() => requirementPreviewPath(path))
  assert.throws(() => requirementPreviewEntry('https://example.com/plans?projectId=42', 'https://tmp.test.sunmi.com'))
  for (const path of ['https://tmp.test.sunmi.com/a/../plans?projectId=42', 'https://tmp.test.sunmi.com/plans?projectId=42#tab', 'https://tmp.test.sunmi.com/a\\plans?projectId=42']) assert.throws(() => requirementPreviewEntry(path, 'https://tmp.test.sunmi.com'))
})

test('live query capture keeps concrete context, repeated labels and the read-only request boundary', async () => {
  const visits: string[] = []
  let writes = 0
  const server = createServer((request, response) => {
    if (request.method === 'POST') writes++
    visits.push(request.url!)
    if (request.url === '/moved?projectId=42') { response.writeHead(302, { Location: '/moved?projectId=43' }); response.end(); return }
    response.setHeader('Content-Type', 'text/html')
    response.end('<body><main><label>Model</label><label>Owner</label><label>Model</label></main><script>fetch("/save",{method:"POST"});if(location.pathname==="/changed"){history.replaceState({},"","/changed?projectId=43")}</script></body>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address() as { port: number }
    const captures = await captureExistingPages(`http://127.0.0.1:${address.port}`, [{ blockId: 'B1', path: '/plans?projectId=42', expectedFields: ['Model', 'Owner', 'Model'] }], new AbortController().signal)
    assert.equal(captures.length, 1)
    assert.ok(visits.includes('/plans?projectId=42'))
    assert.deepEqual(captures[0].structure.fields, ['Model', 'Owner', 'Model'])
    assert.equal(writes, 0)
    for (const path of ['/moved?projectId=42', '/changed?projectId=42']) await assert.rejects(captureExistingPages(`http://127.0.0.1:${address.port}`, [{ blockId: 'B1', path }], new AbortController().signal), /\[PAGE_CAPTURE_REDIRECT\]/)
    assert.ok(!visits.includes('/moved?projectId=43'))
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('isolated live page capture renders layout and blocks write requests', async () => {
  let writes = 0
  const server = createServer((request, response) => {
    if (request.method === 'POST') writes++
    response.setHeader('Content-Type', 'text/html')
    response.end('<html><head><title>Orders</title></head><body><nav style="width:208px">Orders</nav><main><table><tr><td>Order</td></tr></table></main><script>fetch("/save",{method:"POST"})</script></body></html>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address() as { port: number }
    const captures = await captureExistingPages(`http://127.0.0.1:${address.port}`, [{ blockId: 'B1', path: '/orders' }], new AbortController().signal)
    assert.equal(captures.length, 1)
    assert.ok(captures[0].png.length > 100)
    assert.equal(captures[0].structure.title, 'Orders')
    assert.ok(captures[0].structure.regions.some(region => region.width === 208))
    assert.equal(writes, 0)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('page mapping rejects invented routes and missing visual-page coverage', () => {
  const prd = { title: 'Orders', summary: 'Scope', blocks: [{ id: 'B1', title: 'Orders', content: '', requirementIds: ['R1'], sourceIds: [] }], requirements: [{ id: 'R1', title: 'List', description: '', sourceIds: [], acceptance: [] }] }
  const sources = [{ sourceId: 'S1', name: 'code', text: 'route="/orders"' }]
  const entry = { blockId: 'B1', kind: 'existing', path: '/orders', sourceId: 'S1', quote: 'route="/orders"' }
  assert.deepEqual(parseCaptureTargets(JSON.stringify({ pages: [entry] }), prd, sources), [{ blockId: 'B1', path: '/orders' }])
  const numbered = [{ ...sources[0], text: '1\tconst routes = [\n2\t  { path: "/orders" },\n3\t]' }]
  const multiline = { ...entry, quote: 'const routes = [\n  { path: "/orders" },\n]' }
  assert.deepEqual(parseCaptureTargets('```json\n' + JSON.stringify({ pages: [multiline] }) + '\n```', prd, numbered), [{ blockId: 'B1', path: '/orders' }])
  assert.throws(() => parseCaptureTargets(JSON.stringify({ pages: [{ ...entry, quote: 'invented' }] }), prd, sources), /源码不匹配/)
  assert.throws(() => parseCaptureTargets(JSON.stringify({ pages: [] }), prd, sources), /未覆盖/)
  const formSources = [{ ...sources[0], text: sources[0].text + '\nCreate plan\nPlan name\nOwner' }]
  const form = { ...entry, openDialog: 'Create plan', expectedFields: ['Plan name', 'Owner'] }
  assert.deepEqual(parseCaptureTargets(JSON.stringify({ pages: [form] }), prd, formSources), [{ blockId: 'B1', path: '/orders', openDialog: 'Create plan', expectedFields: ['Plan name', 'Owner'] }])
  for (const invalid of [{ ...form, expectedFields: [] }, { ...form, openDialog: 'Invented' }, { ...form, expectedFields: ['Missing field'] }]) assert.throws(() => parseCaptureTargets(JSON.stringify({ pages: [invalid] }), prd, formSources), /PAGE_MAPPING/)
  for (const pages of [[], [{ ...entry, path: '/delete' }], [{ ...entry, quote: 'route="/delete"' }], [entry, entry], [{ ...entry, blockId: 'unknown' }]]) assert.throws(() => parseCaptureTargets(JSON.stringify({ pages }), prd, sources), /PAGE_MAPPING/)
})

test('classified scopes allow all-new pages but never downgrade existing pages or omit blocks', () => {
  const prd = { title: 'Reports', summary: 'New report', blocks: [{ id: 'B1', title: 'Report', content: '', requirementIds: ['R1'], sourceIds: [] }], requirements: [{ id: 'R1', title: 'Report', description: '', sourceIds: [], acceptance: [] }] }
  const scope = [{ blockId: 'B1', kind: 'new' as const, reason: 'Confirmed independent report' }]
  assert.deepEqual(parseCaptureTargets('{"pages":[{"blockId":"B1","kind":"new"}]}', prd, [], scope), [])
  assert.throws(() => parseCaptureTargets('{"pages":[]}', prd, [], scope), /B1/)
  assert.throws(() => parseCaptureTargets('{"pages":[{"blockId":"B1","kind":"new","path":"/fake"}]}', prd, [], scope), /新增页面/)
  assert.throws(() => parseCaptureTargets('{"pages":[{"blockId":"B1","kind":"new"}]}', prd, [], [{ ...scope[0], kind: 'existing' }]), /不得改变/)
})

test('existing tabs, dialogs and embedded content map to one host route without independent child routes', () => {
  const prd = { title: 'Orders', summary: 'Scope', blocks: [{ id: 'B1', title: 'Approval settings', content: '', requirementIds: ['R1'], sourceIds: [] }], requirements: [{ id: 'R1', title: 'Approval', description: '', sourceIds: [], acceptance: [] }] }
  const scope = [{ blockId: 'B1', kind: 'existing' as const, reason: 'Modify existing approval tab and dialog' }]
  const snapshots = [{ sourceId: 'S1', name: 'code', text: 'const host = "/workspace";\nApproval settings\nEdit approvers\nApprover\nApproval explanation' }]
  const entry = { blockId: 'B1', kind: 'existing', path: '/workspace', sourceId: 'S1', quote: 'const host = "/workspace";', activate: [{ kind: 'tab', name: 'Approval settings' }, { kind: 'dialog', name: 'Edit approvers' }], expectedFields: ['Approver'] }
  assert.deepEqual(parseCaptureTargets(JSON.stringify({ pages: [entry] }), prd, snapshots, scope), [{ blockId: 'B1', path: '/workspace', activate: entry.activate, expectedFields: ['Approver'] }])
  const { expectedFields: _fields, activate: _actions, ...host } = entry
  assert.deepEqual(parseCaptureTargets(JSON.stringify({ pages: [{ ...host, expectedContent: ['Approval explanation'] }] }), prd, snapshots, scope), [{ blockId: 'B1', path: '/workspace', expectedContent: ['Approval explanation'] }])
  for (const change of [
    { activate: [] }, { activate: Array(7).fill(entry.activate[0]) },
    { activate: [{ kind: 'submit', name: 'Edit approvers' }] }, { activate: [{ kind: 'tab', name: 'Invented tab' }] },
    { activate: [{ kind: 'tab', name: 'Approval settings', selector: 'body' }] },
    { openDialog: 'Edit approvers' }, { expectedContent: ['Unknown content'] },
    { expectedFields: undefined, expectedContent: undefined },
  ]) assert.throws(() => parseCaptureTargets(JSON.stringify({ pages: [{ ...entry, ...change }] }), prd, snapshots, scope), /PAGE_MAPPING/)
  assert.throws(() => parseCaptureTargets('{"pages":[{"blockId":"B1","kind":"new"}]}', prd, snapshots, scope), /不得改变/)
})

test('isolated capture activates existing tabs and dialog/tab combinations and verifies only the target region', { timeout: 90_000 }, async () => {
  let writes = 0
  const visits: string[] = []
  const server = createServer((request, response) => {
    if (!['GET', 'HEAD'].includes(request.method!)) writes++
    if (request.url !== '/workspace') { response.writeHead(404).end(); return }
    visits.push(request.url)
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(`<html><head><title>Workspace</title></head><body><main>
      <div role="tablist"><button type="button" role="tab" aria-selected="true" aria-controls="overview" onclick="selectTab(this)">Overview</button><button type="button" role="tab" aria-selected="false" aria-controls="approval" onclick="selectTab(this)">Approval settings</button></div>
      <section role="tabpanel" id="overview"><h1>Overview only</h1><p>Outside field</p><button type="button" onclick="document.getElementById('settings').showModal()">Settings</button></section>
      <section role="tabpanel" id="approval" hidden><label>Approval mode<input></label><button type="button" onclick="document.getElementById('approvers').showModal()">Edit approvers</button></section>
      <section><h2>Approval explanation</h2></section>
      </main>
      <dialog id="approvers"><form><label>Approver<input></label><button type="submit">Save</button></form></dialog>
      <dialog id="settings"><div role="tablist"><button type="button" role="tab" aria-selected="true" aria-controls="general" onclick="selectTab(this)">General</button><button type="button" role="tab" aria-selected="false" aria-controls="history" onclick="selectTab(this)">History</button></div><section role="tabpanel" id="general">General information</section><section role="tabpanel" id="history" hidden><h2>History explanation</h2></section></dialog>
      <script>function selectTab(tab){const list=tab.closest('[role=tablist]');for(const item of list.querySelectorAll('[role=tab]')){const active=item===tab;item.setAttribute('aria-selected',String(active));document.getElementById(item.getAttribute('aria-controls')).hidden=!active}fetch('/save',{method:'POST'});}</script>
      </body></html>`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const targets = [
      { blockId: 'B1', path: '/workspace', activate: [{ kind: 'tab' as const, name: 'Approval settings' }], expectedFields: ['Approval mode'] },
      { blockId: 'B2', path: '/workspace', activate: [{ kind: 'tab' as const, name: 'Approval settings' }, { kind: 'dialog' as const, name: 'Edit approvers' }], expectedFields: ['Approver'] },
      { blockId: 'B3', path: '/workspace', activate: [{ kind: 'dialog' as const, name: 'Settings' }, { kind: 'tab' as const, name: 'History' }], expectedContent: ['History explanation'] },
      { blockId: 'B4', path: '/workspace', expectedContent: ['Approval explanation'] },
    ]
    const captures = await captureExistingPages(origin, targets, new AbortController().signal)
    assert.equal(captures.length, 4)
    assert.deepEqual(captures.map(capture => capture.path), Array(4).fill('/workspace'))
    for (const [index, capture] of captures.entries()) {
      assert.ok(capture.png.length > 100)
      assert.deepEqual((capture.structure as { fields?: string[] }).fields, targets[index].expectedFields ?? [])
      assert.deepEqual(capture.activate, targets[index].activate)
    }
    await assert.rejects(captureExistingPages(origin, [{ ...targets[0], expectedFields: ['Outside field'] }], new AbortController().signal), /PAGE_CAPTURE_FIELDS/)
    assert.equal(writes, 0)
    assert.ok(visits.every(path => path === '/workspace'))
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('capture identifies an invisible application shell with blocked CDN resources', async () => {
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html')
    response.end('<html><body style="height:0;margin:0"><script src="https://blocked.invalid/application.js"></script></body></html>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address() as { port: number }
    await assert.rejects(captureExistingPages(`http://127.0.0.1:${address.port}`, [{ blockId: 'B1', path: '/orders' }], new AbortController().signal), error => error instanceof Error && error.message.includes('[PAGE_CAPTURE_RESOURCES]') && error.message.includes('未进入登录检查点'))
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('capture classifies blocked login redirects without exposing browser errors', async () => {
  const server = createServer((_request, response) => { response.writeHead(302, { Location: '/user/login' }); response.end() })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address() as { port: number }
    await assert.rejects(captureExistingPages(`http://127.0.0.1:${address.port}`, [{ blockId: 'B1', path: '/orders' }], new AbortController().signal), error => error instanceof Error && error.message.includes('[PAGE_CAPTURE_LOGIN]') && !error.message.includes('net::'))
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('manual login opens visible Chrome once and reuses only its in-memory session for strict capture', async testContext => {
  let writes = 0
  let loginVisits = 0
  let checkpoints = 0
  const launches: { browser: Browser; headless: boolean | undefined }[] = []
  const launch = chromium.launch.bind(chromium)
  testContext.mock.method(chromium, 'launch', async (options: Parameters<typeof chromium.launch>[0]) => {
    const browser = await launch(options)
    launches.push({ browser, headless: options?.headless })
    return browser
  })
  let retainedControls: RequirementLoginControls | undefined
  const server = createServer((request, response) => {
    if (request.method === 'POST') writes++
    response.setHeader('Content-Type', 'text/html')
    if (request.url === '/login') {
      loginVisits++
      response.setHeader('Set-Cookie', 'fixture_session=ready; HttpOnly; SameSite=Strict; Path=/')
      response.end('<html><body><input type="password">Local login fixture</body></html>')
    } else if (!request.headers.cookie?.includes('fixture_session=ready')) {
      response.writeHead(302, { Location: '/login' }); response.end()
    } else {
      response.end('<html><head><title>Authenticated orders</title></head><body><main>Orders</main><script>fetch("/save",{method:"POST"})</script></body></html>')
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address() as { port: number }
    const origin = `http://127.0.0.1:${address.port}`
    const captures = await captureExistingPages(origin, [{ blockId: 'B1', path: '/orders' }, { blockId: 'B2', path: '/orders' }], new AbortController().signal, {
      onLoginRequired: async controls => {
        checkpoints++
        retainedControls = controls
        assert.equal(launches.length, 1)
        assert.equal(launches[0].browser.isConnected(), false)
        assert.equal(controls.origin, origin)
        assert.ok(Date.parse(controls.expiresAt) > Date.now())
        assert.ok(Date.parse(controls.expiresAt) <= Date.now() + 300000)
        await Promise.all([controls.open(), controls.open()])
      },
    })
    assert.equal(checkpoints, 1)
    assert.equal(loginVisits, 1)
    assert.equal(writes, 0)
    assert.equal(captures.length, 2)
    assert.ok(captures.every(capture => capture.structure.title === 'Authenticated orders' && capture.png.length > 100))
    assert.deepEqual(launches.map(entry => entry.headless), [true, false])
    assert.ok(launches.every(entry => !entry.browser.isConnected()))
    await assert.rejects(retainedControls!.open(), /PAGE_CAPTURE_LOGIN/)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('manual auth permits same-origin POST but denies other origins, redirect chains, writes, popups, workers and sockets', async () => {
  let outsideRequests = 0
  let loginPosts = 0
  let forbiddenRequests = 0
  let sockets = 0
  let markReady!: () => void
  const ready = new Promise<void>(resolve => { markReady = resolve })
  const outside = createServer((_request, response) => { outsideRequests++; response.end('Outside') })
  await new Promise<void>(resolve => outside.listen(0, '127.0.0.1', resolve))
  const outsideOrigin = `http://127.0.0.1:${(outside.address() as { port: number }).port}`
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html')
    if (request.url === '/session' && request.method === 'POST') {
      loginPosts++
      response.setHeader('Set-Cookie', 'fixture_session=ready; HttpOnly; SameSite=Strict; Path=/')
      response.end('OK')
    } else if (request.url === '/ready') {
      response.end('Ready'); markReady()
    } else if (request.url === '/hop') {
      response.writeHead(302, { Location: '/hop-again' }); response.end()
    } else if (request.url === '/hop-again') {
      response.writeHead(302, { Location: `${outsideOrigin}/redirect` }); response.end()
    } else if (request.url === '/login') {
      response.end(`<html><body><input type="password">Login fixture<script>
        window.open('/popup');
        new WebSocket(location.origin.replace('http:', 'ws:') + '/socket');
        navigator.serviceWorker.register('/worker.js').catch(() => {});
        Promise.allSettled([
          fetch('/session', { method: 'POST' }),
          fetch('/save', { method: 'POST' }),
          fetch('/denied', { method: 'PUT' }),
          fetch('/denied', { method: 'DELETE' }),
          fetch(${JSON.stringify(outsideOrigin)}),
          fetch('/hop')
        ]).then(() => fetch('/ready'));
      </script></body></html>`)
    } else if (['/popup', '/worker.js', '/denied', '/save'].includes(request.url ?? '')) {
      forbiddenRequests++; response.end('Forbidden')
    } else if (!request.headers.cookie?.includes('fixture_session=ready')) {
      response.writeHead(302, { Location: '/login' }); response.end()
    } else {
      response.end('<html><head><title>Safe orders</title></head><body><main>Orders</main><script>fetch("/save",{method:"POST"})</script></body></html>')
    }
  })
  server.on('upgrade', (_request, socket) => { sockets++; socket.destroy() })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const captures = await captureExistingPages(origin, [{ blockId: 'B1', path: '/orders' }], new AbortController().signal, {
      onLoginRequired: async controls => { await controls.open(); await ready },
    })
    assert.equal(captures[0].structure.title, 'Safe orders')
    assert.equal(loginPosts, 1)
    assert.equal(outsideRequests, 0)
    assert.equal(forbiddenRequests, 0)
    assert.equal(sockets, 0)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await new Promise<void>(resolve => outside.close(() => resolve()))
  }
})

test('manual login is attempted only once and never returns a login screenshot', async () => {
  let checkpoints = 0
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html')
    response.end('<html><body>Sign in<input type="password"></body></html>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    await assert.rejects(captureExistingPages(origin, [{ blockId: 'B1', path: '/orders' }], new AbortController().signal, {
      onLoginRequired: async controls => { checkpoints++; await controls.open() },
    }), /PAGE_CAPTURE_LOGIN/)
    assert.equal(checkpoints, 1)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('resolving a checkpoint without explicit open does not launch a login browser', async testContext => {
  let launches = 0
  const launch = chromium.launch.bind(chromium)
  testContext.mock.method(chromium, 'launch', async (options: Parameters<typeof chromium.launch>[0]) => { launches++; return launch(options) })
  const server = createServer((_request, response) => { response.writeHead(302, { Location: '/login' }); response.end() })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    await assert.rejects(captureExistingPages(origin, [{ blockId: 'B1', path: '/orders' }], new AbortController().signal, {
      onLoginRequired: async () => {},
    }), /PAGE_CAPTURE_LOGIN/)
    assert.equal(launches, 1)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('abort before capture does not launch Chrome', async testContext => {
  const launch = testContext.mock.method(chromium, 'launch', async () => { throw new Error('Unexpected launch') })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(captureExistingPages('http://127.0.0.1:12345', [{ blockId: 'B1', path: '/orders' }], controller.signal), { name: 'AbortError' })
  assert.equal(launch.mock.callCount(), 0)
})

test('abort while visible Chrome launch is pending closes the late browser and invalidates open', async testContext => {
  const controller = new AbortController()
  const launch = chromium.launch.bind(chromium)
  const browsers: Browser[] = []
  let controls: RequirementLoginControls | undefined
  let launchStarted!: () => void
  let releaseLaunch!: () => void
  const started = new Promise<void>(resolve => { launchStarted = resolve })
  const released = new Promise<void>(resolve => { releaseLaunch = resolve })
  testContext.mock.method(chromium, 'launch', async (options: Parameters<typeof chromium.launch>[0]) => {
    const browser = await launch(options)
    browsers.push(browser)
    if (options?.headless === false) { launchStarted(); await released }
    return browser
  })
  const server = createServer((_request, response) => { response.writeHead(302, { Location: '/login' }); response.end() })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const capture = captureExistingPages(origin, [{ blockId: 'B1', path: '/orders' }], controller.signal, {
      onLoginRequired: async checkpoint => { controls = checkpoint; await checkpoint.open() },
    })
    const rejected = assert.rejects(capture, { name: 'AbortError' })
    await started
    controller.abort()
    releaseLaunch()
    await rejected
    assert.equal(browsers.length, 2)
    assert.ok(browsers.every(browser => !browser.isConnected()))
    await assert.rejects(controls!.open(), { name: 'AbortError' })
  } finally { releaseLaunch(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('five-minute login deadline releases an unresolved handler and invalidates late open', async testContext => {
  const schedule = globalThis.setTimeout
  let deadlines = 0
  testContext.mock.method(globalThis, 'setTimeout', (callback: (...args: unknown[]) => void, milliseconds?: number, ...args: unknown[]) => {
    if (milliseconds === 300000) { deadlines++; return schedule(callback, 30, ...args) }
    return schedule(callback, milliseconds, ...args)
  })
  let controls: RequirementLoginControls | undefined
  const server = createServer((_request, response) => { response.writeHead(302, { Location: '/login' }); response.end() })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    await assert.rejects(captureExistingPages(origin, [{ blockId: 'B1', path: '/orders' }], new AbortController().signal, {
      onLoginRequired: async checkpoint => { controls = checkpoint; await new Promise<void>(() => {}) },
    }), /PAGE_CAPTURE_TIMEOUT/)
    assert.equal(deadlines, 1)
    await assert.rejects(controls!.open(), /PAGE_CAPTURE_TIMEOUT/)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('abort closes an opened login context even when its checkpoint handler never resolves', async testContext => {
  const controller = new AbortController()
  const launch = chromium.launch.bind(chromium)
  const browsers: Browser[] = []
  testContext.mock.method(chromium, 'launch', async (options: Parameters<typeof chromium.launch>[0]) => {
    const browser = await launch(options)
    browsers.push(browser)
    return browser
  })
  const server = createServer((request, response) => {
    if (request.url === '/login') response.end('<html><body>Local login fixture</body></html>')
    else response.writeHead(302, { Location: '/login' }).end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    await assert.rejects(captureExistingPages(origin, [{ blockId: 'B1', path: '/orders' }], controller.signal, {
      onLoginRequired: async controls => {
        await controls.open()
        assert.equal(browsers[1].contexts().length, 1)
        controller.abort()
        await new Promise<void>(() => {})
      },
    }), { name: 'AbortError' })
    assert.equal(browsers.length, 2)
    assert.ok(browsers.every(browser => !browser.isConnected()))
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('capture rejects navigation-only loading shells and opens evidenced form without submitting', async () => {
  let writes = 0
  const server = createServer((request, response) => {
    if (request.method !== 'GET') writes++
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    if (request.url === '/loading') return response.end('<body><nav>Projects</nav><main><span class="ant-spin-spinning">Loading</span></main></body>')
    response.end('<body><nav>Projects</nav><main><button type="button" onclick="document.querySelector(\'dialog\').showModal()">Create plan</button></main><dialog><form><label>Plan name<input></label><label>Owner<input></label><button type="submit">Save</button></form></dialog></body>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    await assert.rejects(captureExistingPages(origin, [{ blockId: 'B1', path: '/loading' }], new AbortController().signal), /PAGE_CAPTURE_NOT_READY/)
    const captures = await captureExistingPages(origin, [{ blockId: 'B1', path: '/form', openDialog: 'Create plan', expectedFields: ['Plan name', 'Owner'] }], new AbortController().signal)
    assert.equal(captures.length, 1)
    assert.deepEqual((captures[0].structure as { fields?: string[] }).fields, ['Plan name', 'Owner'])
    await assert.rejects(captureExistingPages(origin, [{ blockId: 'B1', path: '/form', openDialog: 'Create plan', expectedFields: ['Missing field'] }], new AbortController().signal), /PAGE_CAPTURE_FIELDS/)
    assert.equal(writes, 0)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})