import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { chromium, type Browser } from 'playwright-core'
import type { RequirementLoginControls } from '../../shared/requirements.js'
import { requirementPreviewOrigin, requirementPreviewPath } from '../../shared/requirement-preview.js'
import { captureExistingPages, parseCaptureTargets } from './page-capture.js'

test('preview configuration allows exact authorized test origins and rejects unsafe origins and routes', () => {
  assert.equal(requirementPreviewOrigin('http://localhost:5173'), 'http://localhost:5173')
  assert.equal(requirementPreviewOrigin('https://tmp.test.sunmi.com'), 'https://tmp.test.sunmi.com')
  assert.equal(requirementPreviewOrigin('https://TMP.TEST.SUNMI.COM:443/'), 'https://tmp.test.sunmi.com')
  for (const value of ['https://example.com', 'http://user:pass@localhost', 'http://localhost/private', 'file:///tmp', 'http://tmp.test.sunmi.com', 'https://tmp.test.sunmi.com:8443', 'https://tmp.test.sunmi.com.evil.invalid', 'https://other.tmp.test.sunmi.com', 'https://tmp.test.sunmi.com@evil.invalid', 'https://user:pass@tmp.test.sunmi.com', 'https://tmp.test.sunmi.com/orders', 'https://tmp.test.sunmi.com?next=admin', 'https://tmp.test.sunmi.com#orders']) assert.throws(() => requirementPreviewOrigin(value))
  for (const value of ['//outside', '/../admin', '/orders?delete=1', '/%2e%2e', 'https://example.com']) assert.throws(() => requirementPreviewPath(value))
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