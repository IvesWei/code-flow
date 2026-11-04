import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { browserAssertionAttributes, browserCapabilities, browserGeometryMetrics, browserLimits, browserPlanInstructions, browserPressKeys, browserProtocolVersion, browserRequestMethods, browserStyleProperties, executeBrowserScript, generateBrowserPlan, localPreviewUrl, parseBrowserPlan, parseBrowserScript } from './browser-automation.js'
import type { SelfTestCase } from '../../shared/task.js'

test('browser scripts require local addresses and a real assertion', () => {
  assert.throws(() => localPreviewUrl('https://example.com'), /本机/)
  assert.throws(() => localPreviewUrl('http://127.0.0.1.evil.test'), /本机/)
  assert.throws(() => parseBrowserScript(JSON.stringify({ path: '//evil.test', steps: [{ action: 'assertText', selector: 'h1', value: 'OK' }] })), /路径/)
  assert.throws(() => parseBrowserScript(JSON.stringify({ path: '/\\evil.test', steps: [{ action: 'assertText', selector: 'h1', value: 'OK' }] })), /路径/)
  assert.throws(() => parseBrowserScript(JSON.stringify({ path: '/', steps: [{ action: 'click', selector: 'button' }] })), /断言/)
})

test('headless Chrome captures evidence on success and assertion failure', async () => {
  const server = createServer((request, response) => request.url === '/disconnected' ? response.destroy() : response.end('<h1>Welcome</h1>'))
  const directory = mkdtempSync(join(tmpdir(), 'code-flow-browser-'))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No local port')
    const url = `http://127.0.0.1:${address.port}`
    const caseItem = { id: 'TC-01' } as SelfTestCase
    const script = (value: string) => JSON.stringify({ path: '/', steps: [{ action: 'assertText', selector: 'h1', value }] })
    const passed = await executeBrowserScript(url, script('Welcome'), caseItem, directory)
    assert.equal(passed.status, 'passed', passed.output)
    assert.equal(passed.protocolVersion, browserProtocolVersion)
    assert.ok(passed.screenshot && statSync(join(directory, passed.screenshot)).size > 100)
    const failed = await executeBrowserScript(url, script('Not present'), caseItem, directory)
    assert.equal(failed.status, 'failed', failed.output)
    assert.equal(failed.failureKind, 'step')
    assert.equal(failed.failureCategory, 'assertion')
    assert.match(failed.output || '', /第 1 步（assertText）失败.*断言失败/)
    assert.ok(failed.screenshot && statSync(join(directory, failed.screenshot)).size > 100)
    const navigation = await executeBrowserScript(url, JSON.stringify({ path: '/disconnected', steps: [{ action: 'assertText', selector: 'h1', value: 'Welcome' }] }), caseItem, directory)
    assert.equal(navigation.failureKind, 'navigation', navigation.output)
    assert.equal(navigation.failureCategory, 'navigation')
    assert.match(navigation.output || '', /页面加载失败（\/disconnected）/)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(directory, { recursive: true, force: true })
  }
})

test('browser plans distinguish unsupported cases from malformed steps', () => {
  assert.deepEqual(parseBrowserPlan('{"blocked":true,"reason":"需要登录凭据"}'), { kind: 'blocked', reason: '需要登录凭据', reasonCode: 'unknown' })
  assert.throws(() => parseBrowserPlan('{"path":"/","steps":[],"error":"需要登录凭据"}'), /1 至 60 步/)
  assert.throws(() => parseBrowserPlan(JSON.stringify({ path: '/', steps: [{ action: 'assertText', selector: 'h1', value: '' }] })), /第 1 步/)
})

test('invalid browser scripts get one targeted retry, while blocked cases do not retry', async () => {
  const prompts: (string | undefined)[] = []
  const result = await generateBrowserPlan(async (feedback) => {
    prompts.push(feedback)
    return prompts.length === 1 ? '{"path":"/","steps":[]}' : '{"blocked":true,"reason":"需要模拟异常"}'
  })
  assert.equal(result.plan.kind, 'blocked')
  assert.deepEqual(prompts, [undefined, '脚本需要 1 至 60 步'])
  let calls = 0
  await assert.rejects(generateBrowserPlan(async () => { calls++; return '{"path":"/","steps":[]}' }), /已修正一次/)
  assert.equal(calls, 2)
})

test('expanded browser contract strictly validates actions and structured blockers', () => {
  for (const action of browserCapabilities) assert.ok(browserPlanInstructions.includes(action))
  for (const key of browserPressKeys) assert.ok(browserPlanInstructions.includes(key))
  const plan = (step: unknown) => JSON.stringify({ path: '/', steps: [step, { action: 'assertVisible', selector: 'h1' }] })
  for (const step of [
    { action: 'fill', selector: 'input', value: '' }, { action: 'clear', selector: 'input' },
    { action: 'press', selector: 'input', key: 'Shift+Tab' }, { action: 'assertValue', selector: 'input', value: '' },
    { action: 'assertAttribute', selector: 'button', attribute: 'aria-expanded', value: 'false' },
    { action: 'assertUrl', value: '/next' },
  ]) assert.equal(parseBrowserPlan(plan(step)).kind, 'script')
  for (const step of [
    { action: 'press', selector: 'input', key: 'Control+a' }, { action: 'press', selector: 'input', key: 'a' },
    { action: 'assertAttribute', selector: 'input', attribute: 'value', value: 'secret' },
    { action: 'assertAttribute', selector: 'input', attribute: 'onclick', value: '' },
    { action: 'assertUrl', value: 'https://example.com/' }, { action: 'assertUrl', value: '//evil.test' },
    { action: 'assertUrl', value: '/?token=x' }, { action: 'assertUrl', value: '/#hash' },
    { action: 'click', selector: 'button', value: 'ignored' }, { action: 'clear', selector: 'input', extra: true },
    { action: 'fill', selector: 'input', value: 42 }, { action: 'focus', selector: '' },
    { action: 'evaluate', selector: 'body', value: 'alert(1)' }, null,
    { action: 'assertUrl', value: '/%5cevil' }, { action: 'assertUrl', value: '/\nevil' },
    { action: 'fill', selector: 'input', value: 'x'.repeat(browserLimits.maxValueLength + 1) },
    { action: 'focus', selector: 'x'.repeat(browserLimits.maxSelectorLength + 1) },
  ]) assert.throws(() => parseBrowserPlan(plan(step)), /第 1 步/)
  assert.throws(() => parseBrowserPlan(JSON.stringify({ path: '/', steps: [{ action: 'clear', selector: 'input' }] })), /断言/)
  assert.throws(() => parseBrowserPlan(JSON.stringify({ path: '/', steps: Array.from({ length: browserLimits.maxSteps + 1 }, () => ({ action: 'assertVisible', selector: 'h1' })) })), /1 至 60 步/)
  const blocked = { blocked: true, reason: 'No fixture', reasonCode: 'environment', requiredCapabilities: ['fixture.account'] }
  assert.deepEqual(parseBrowserPlan(JSON.stringify(blocked)), { kind: 'blocked', reason: 'No fixture', reasonCode: 'environment', requiredCapabilities: ['fixture.account'] })
  for (const change of [{ reasonCode: 'guess' }, { reasonCode: null }, { requiredCapabilities: ['unsafe capability'] }, { requiredCapabilities: ['x', 'x'] }, { extra: true }]) {
    assert.throws(() => parseBrowserPlan(JSON.stringify({ ...blocked, ...change })))
  }
})

test('isolated Chrome executes keyboard, focus, clear and exact state assertions with a runtime credential guard', async () => {
  let submitted = 0
  const server = createServer((request, response) => {
    if (new URL(request.url ?? '/', 'http://fixture.local').pathname === '/submitted') submitted++
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(`<h1>Fixture</h1><input id="first"><input id="second" value="seed">
      <button id="toggle" aria-expanded="false" onclick="this.setAttribute('aria-expanded','true')">Toggle</button>
      <button id="disabled" disabled>Disabled</button><div id="hidden" hidden>Hidden</div>
      <input id="password" type="password" value="fixture-only"><input id="token" name="access_token">
      <input id="auto" autocomplete="one-time-code"><input id="named" name="clientSecret">
      <input id="receipt" readonly><input id="labelled" aria-label="API key">
      <form action="/submitted"><input id="form-field"><button>Submit</button></form>
      <a id="foreign" href="http://127.0.0.1:1/foreign">Foreign</a>`)
  })
  const directory = mkdtempSync(join(tmpdir(), 'code-flow-browser-expanded-'))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No local port')
    const url = `http://127.0.0.1:${address.port}`
    const caseItem = { id: 'TC-EXPANDED' } as SelfTestCase
    const runSteps = (steps: unknown[]) => executeBrowserScript(url, JSON.stringify({ path: '/', steps }), caseItem, directory)
    const passed = await runSteps([
      { action: 'focus', selector: '#first' }, { action: 'assertFocused', selector: '#first' },
      { action: 'fill', selector: '#first', value: 'trial' }, { action: 'assertValue', selector: '#first', value: 'trial' },
      { action: 'press', selector: '#first', key: 'Tab' }, { action: 'assertFocused', selector: '#second' },
      { action: 'press', selector: '#second', key: 'Shift+Tab' }, { action: 'assertFocused', selector: '#first' },
      { action: 'fill', selector: '#first', value: '' }, { action: 'assertValue', selector: '#first', value: '' },
      { action: 'clear', selector: '#second' }, { action: 'assertValue', selector: '#second', value: '' },
      { action: 'press', selector: '#toggle', key: 'Space' },
      { action: 'assertAttribute', selector: '#toggle', attribute: 'aria-expanded', value: 'true' },
      { action: 'assertVisible', selector: 'h1' }, { action: 'assertHidden', selector: '#hidden' },
      { action: 'assertHidden', selector: '#absent' }, { action: 'assertEnabled', selector: '#toggle' },
      { action: 'assertDisabled', selector: '#disabled' }, { action: 'assertUrl', value: '/' },
    ])
    assert.equal(passed.status, 'passed', passed.output)
    const submittedRun = await runSteps([{ action: 'press', selector: '#form-field', key: 'Enter' }, { action: 'assertUrl', value: '/submitted' }])
    assert.equal(submittedRun.status, 'passed', submittedRun.output)
    assert.equal(submitted, 1)
    const remainingKeys = await runSteps([
      { action: 'fill', selector: '#first', value: 'abc' },
      ...['Home', 'ArrowRight', 'ArrowLeft', 'End', 'ArrowUp', 'ArrowDown', 'Escape'].map((key) => ({ action: 'press', selector: '#first', key })),
      { action: 'assertValue', selector: '#first', value: 'abc' },
    ])
    assert.equal(remainingKeys.status, 'passed', remainingKeys.output)
    for (const selector of ['#password', '#token', '#auto', '#named', '#labelled']) {
      const blocked = await runSteps([{ action: 'fill', selector, value: 'safe-trial' }, { action: 'assertVisible', selector: 'h1' }])
      assert.equal(blocked.status, 'blocked', blocked.output)
      assert.equal(blocked.failureKind, 'step')
      assert.equal(blocked.failureCategory, 'policy')
      assert.equal(blocked.reasonCode, 'authorization')
      assert.equal(blocked.screenshot, undefined)
      assert.doesNotMatch(blocked.output ?? '', /fixture-only|safe-trial/)
    }
    const metadata = await runSteps([
      { action: 'assertAttribute', selector: '#password', attribute: 'type', value: 'password' },
      { action: 'assertAttribute', selector: '#auto', attribute: 'autocomplete', value: 'one-time-code' },
    ])
    assert.equal(metadata.status, 'passed', metadata.output)
    const failedAction = await runSteps([{ action: 'fill', selector: '#receipt', value: 'x' }, { action: 'assertVisible', selector: 'h1' }])
    assert.equal(failedAction.failureCategory, 'action', failedAction.output)
    const foreign = await runSteps([{ action: 'click', selector: '#foreign' }, { action: 'assertUrl', value: '/' }])
    assert.equal(foreign.status, 'failed')
    assert.equal(foreign.failureCategory, 'navigation', foreign.output)
    for (const step of [
      { action: 'assertValue', selector: '#second', value: 'see' },
      { action: 'assertAttribute', selector: '#toggle', attribute: 'aria-expanded', value: 'true' },
      { action: 'assertUrl', value: '/not-current' },
    ]) {
      const failed = await runSteps([step])
      assert.equal(failed.status, 'failed', failed.output)
      assert.equal(failed.failureKind, 'step')
      assert.equal(failed.failureCategory, 'assertion')
      assert.ok(failed.screenshot)
    }
    for (const step of [
      { action: 'clear', selector: '#password' }, { action: 'press', selector: '#password', key: 'Enter' },
      { action: 'assertValue', selector: '#token', value: '' },
    ]) {
      const blocked = await runSteps([step, { action: 'assertVisible', selector: 'h1' }])
      assert.equal(blocked.status, 'blocked', blocked.output)
      assert.equal(blocked.failureCategory, 'policy')
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(directory, { recursive: true, force: true })
  }
})

test('v3 schemas reject unsafe, unbounded, unknown and temporally invalid plans', () => {
  assert.equal(browserProtocolVersion, 'browser-v4')
  for (const item of ['hover', 'assertCount', 'assertTextExact']) assert.ok(browserCapabilities.includes(item as typeof browserCapabilities[number]))
  const basicPlan = (step: unknown) => JSON.stringify({ path: '/', steps: [step, { action: 'assertVisible', selector: 'body' }] })
  const checkBasic = () => {
    for (const step of [
      { action: 'hover', selector: 'button' },
      { action: 'assertCount', selector: '.item', count: 0 },
      { action: 'assertTextExact', selector: 'h1', value: 'Visible text' },
      ...['border-color', 'border-top-color'].map((property) => ({ action: 'assertStyle', selector: 'body', property, value: 'rgb(1, 2, 3)' })),
      { action: 'assertStyle', selector: 'body', property: 'border-width', value: '1px 2px' },
      { action: 'assertStyle', selector: 'body', property: 'border-style', value: 'solid dashed' },
    ]) assert.equal(parseBrowserPlan(basicPlan(step)).kind, 'script')
    for (const step of [
      ...[-1, 0.5, 10001, '1', null, undefined].map((count) => ({ action: 'assertCount', selector: '.item', count })),
      { action: 'hover', selector: 'button', duration: 100000 },
      { action: 'assertTextExact', selector: 'h1', value: '  ' },
      { action: 'assertCount', selector: '.item', count: 1, first: true },
      { action: 'assertStyle', selector: 'body', property: 'border-color', value: 'var(--secret)' },
      { action: 'assertStyle', selector: 'body', property: 'border-left-width', value: '1px 2px' },
      { action: 'assertStyle', selector: 'body', property: 'border-style', value: 'solid;display:none' },
    ]) assert.throws(() => parseBrowserPlan(basicPlan(step)))
    }
    checkBasic()
  for (const item of [...browserAssertionAttributes, ...browserGeometryMetrics, ...browserStyleProperties, ...browserRequestMethods, browserProtocolVersion]) assert.ok(browserPlanInstructions.includes(item), item)
  const observation = { action: 'startNetworkObservation', id: 'save', path: '/api/save', method: 'POST' }
  const plan = (steps: unknown[], viewport?: unknown) => JSON.stringify({ path: '/', ...(viewport === undefined ? {} : { viewport }), steps })
  const visible = { action: 'assertVisible', selector: 'h1' }
  for (const step of [
    ...browserAssertionAttributes.map((attribute) => ({ action: 'assertAttribute', selector: 'input', attribute, value: attribute === 'src' ? '/image.png' : '' })),
    ...browserGeometryMetrics.map((metric) => ({ action: 'assertGeometry', selector: 'body', metric, min: -1.5, max: 200, tolerance: 0.5 })),
    { action: 'assertGeometry', selector: 'body', metric: 'width', min: 0 },
    { action: 'assertGeometry', selector: 'body', metric: 'width', max: 200 },
    { action: 'assertStyle', selector: 'body', property: 'color', value: 'rgb(1, 2, 3)' },
    { action: 'assertStyle', selector: 'body', property: 'background-color', value: 'rgba(0, 0, 0, 0)' },
    { action: 'assertStyle', selector: 'body', property: 'font-family', value: '"Fixture Font", sans-serif' },
    { action: 'assertStyle', selector: 'body', property: 'border-radius', value: '2px 4px' },
    { action: 'assertImageLoaded', selector: 'img' }, { action: 'assertNotObscured', selector: 'button' },
    { action: 'assertNoOverlap', selector: '#first', otherSelector: '#second' },
    { action: 'assertFontLoaded', font: '16px "Fixture Font"' },
  ]) assert.equal(parseBrowserPlan(plan([step])).kind, 'script', JSON.stringify(step))
  assert.equal(parseBrowserPlan(plan([observation, { action: 'assertRequestCount', id: 'save', count: 0, observationMs: 100 }])).kind, 'script')
  assert.equal(parseBrowserPlan(plan(Array.from({ length: 60 }, () => visible), { width: 240, height: 2560 })).kind, 'script')
  for (const viewport of [null, {}, { width: 390 }, { width: 239, height: 800 }, { width: 2561, height: 800 }, { width: 390.5, height: 800 }, { width: '390', height: 800 }, { width: 390, height: 800, scale: 1 }]) assert.throws(() => parseBrowserPlan(plan([visible], viewport)), /viewport/)
  for (const step of [
    { action: 'assertGeometry', selector: 'body', metric: 'width' },
    { action: 'assertGeometry', selector: 'body', metric: 'innerHTML', min: 0 },
    ...[null, '1', 1_000_001].map((min) => ({ action: 'assertGeometry', selector: 'body', metric: 'width', min })),
    { action: 'assertGeometry', selector: 'body', metric: 'width', min: 2, max: 1 },
    { action: 'assertGeometry', selector: 'body', metric: 'width', min: 1, tolerance: -1 },
    { action: 'assertGeometry', selector: 'body', metric: 'width', min: 1, tolerance: 101 },
    { action: 'assertGeometry', selector: 'body', metric: 'width', min: 1, evaluate: '1' },
    ...['url(/secret)', 'expression(alert(1))', 'var(--secret)', 'red; display:none', 'r\\65 d', 'rgb(., +, -)', 'rgb(256, 0, 0)', 'rgba(0, 0, 0, 2)', 'hsl(0, 50, 50)', 'rgb(0, 0)'].map((value) => ({ action: 'assertStyle', selector: 'body', property: 'color', value })),
    { action: 'assertStyle', selector: 'body', property: '--secret', value: 'red' },
    { action: 'assertStyle', selector: 'body', property: 'background-image', value: 'none' },
    { action: 'assertStyle', selector: 'body', property: 'font-family', value: 'url(/font)' },
    ...['16px Missing, Arial', '0px Missing', '201px Missing', '16px url(/font)', '16px "Bad;Family"'].map((font) => ({ action: 'assertFontLoaded', font })),
    ...['/logo?token=secret', '/logo#secret', 'https://example.com/logo', 'data:image/png;base64,secret'].map((value) => ({ action: 'assertAttribute', selector: 'img', attribute: 'src', value })),
    { action: 'assertImageLoaded', selector: 'img', value: 'ignored' },
    { action: 'assertNotObscured', selector: 'button', script: 'true' },
    ...[undefined, '', 'x'.repeat(browserLimits.maxSelectorLength + 1), 42].map((otherSelector) => ({ action: 'assertNoOverlap', selector: '#first', otherSelector })),
    { action: 'assertNoOverlap', selector: '#first', otherSelector: '#second', tolerance: 1 },
    { ...observation, method: 'CONNECT' }, { ...observation, path: '//evil.test' },
    { ...observation, path: '/api/save?token=secret' }, { ...observation, id: 'bad id' },
    { ...observation, headers: {} }, { ...observation, body: 'x' },
  ]) assert.throws(() => parseBrowserPlan(plan([step, visible])), /第 1 步/, JSON.stringify(step))
  for (const step of [
    { action: 'assertRequestCount', id: 'missing', count: 0, observationMs: 100 },
    ...[-1, 1.5, 10_001, '1'].map((count) => ({ action: 'assertRequestCount', id: 'save', count, observationMs: 100 })),
    ...[-1, 99, 3001, 100.5, null].map((observationMs) => ({ action: 'assertRequestCount', id: 'save', count: 0, observationMs })),
    { action: 'assertRequestCount', id: 'save', count: 1 },
    { action: 'assertRequestCount', id: 'save', count: 1, observationMs: 100, reset: true },
    observation,
  ]) assert.throws(() => parseBrowserPlan(plan([observation, step, visible])), /第 2 步/)
  assert.throws(() => parseBrowserPlan('{"path":"/","steps":[{"action":"assertGeometry","selector":"body","metric":"width","min":1e309}]}'))
  assert.throws(() => parseBrowserPlan(plan([observation])), /断言/)
  const waits = Array.from({ length: 10 }, () => ({ action: 'assertRequestCount', id: 'save', count: 1, observationMs: 3000 }))
  assert.equal(parseBrowserPlan(plan([observation, ...waits])).kind, 'script')
  assert.throws(() => parseBrowserPlan(plan([observation, ...waits, { action: 'assertRequestCount', id: 'save', count: 1, observationMs: 1 }])), /总预算/)
})

test('v3 isolated Chrome verifies viewport, geometry, computed styles, images, declared fonts and hit targets', async () => {
  const fontPath = ['C:/Windows/Fonts/arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf'].find((candidate) => existsSync(candidate))
  assert.ok(fontPath, 'A local test font is required; no foreign assets are fetched')
  const font = readFileSync(fontPath)
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://fixture.local').pathname
    if (path === '/font.ttf') {
      response.setHeader('Content-Type', 'font/ttf')
      response.end(font)
    } else if (path === '/image.png') {
      response.setHeader('Content-Type', 'image/png')
      response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64'))
    } else if (path === '/broken.png') {
      response.statusCode = 404
      response.end('not an image')
    } else {
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.end(`<style>
        @font-face {font-family: FixtureFont; src: url('/font.ttf')}
        body {margin:0;font-family:FixtureFont}
        #box {position:absolute;left:20px;top:30px;width:120px;height:40px;overflow:hidden;box-sizing:border-box;color:rgb(1,2,3);background-color:rgb(4,5,6);border-radius:4px}
        #wide {width:240px;height:80px}
        #target {position:absolute;left:20px;top:100px;width:100px;height:40px}
        #covered {position:absolute;left:20px;top:160px;width:100px;height:40px}
        #cover {position:absolute;left:20px;top:160px;width:100px;height:40px;background:red;z-index:2}
        #offscreen {position:absolute;left:3000px;top:0;width:100px;height:40px}
        #viewport {position:fixed;width:1px;height:100vh;right:0;top:0;pointer-events:none}
        #touching {position:absolute;left:120px;top:100px;width:20px;height:40px}
        #partial {position:absolute;left:119px;top:100px;width:20px;height:40px}
      </style><div id="box"><div id="wide">Fixture</div></div>
      <button id="target"><span>Target</span></button><button id="covered">Covered</button><div id="cover"></div>
      <div id="viewport"></div><div id="touching"></div><div id="partial"></div>
      <button id="offscreen">Offscreen</button><button id="hidden" hidden>Hidden</button>
      <div id="hidden-text">Visible label<span hidden>Hidden expectation</span></div>
      <svg id="svg-text" width="100" height="30"><text y="20">SVG label</text><text style="display:none">SVG hidden expectation</text></svg>
      <img id="image" src="/image.png" alt="Fixture"><img id="broken" src="/broken.png">
      <input id="sensitive" type="password" value="fixture-secret" aria-invalid="true" aria-controls="hint" aria-describedby="hint" autocomplete="current-password"><span id="hint">Hint</span>`)
    }
  })
  const directory = mkdtempSync(join(tmpdir(), 'code-flow-browser-v3-'))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No local port')
    const url = `http://127.0.0.1:${address.port}`
    const runSteps = (steps: unknown[], viewport = { width: 390, height: 800 }) => executeBrowserScript(url, JSON.stringify({ path: '/', viewport, steps }), { id: 'TC-V3' } as SelfTestCase, directory)
    const geometry = { width: 120, height: 40, x: 20, y: 30, left: 20, top: 30, right: 140, bottom: 70, scrollWidth: 240, clientWidth: 120, scrollHeight: 80, clientHeight: 40 }
    const steps = [
      ...Object.entries(geometry).map(([metric, value]) => ({ action: 'assertGeometry', selector: '#box', metric, min: value, max: value })),
      { action: 'assertGeometry', selector: 'body', metric: 'width', min: 390, max: 390 },
      { action: 'assertGeometry', selector: '#viewport', metric: 'height', min: 800, max: 800 },
      { action: 'assertGeometry', selector: '#box', metric: 'width', min: 120.5, max: 120.5, tolerance: 0.5 },
      ...Object.entries({ color: 'rgb(1, 2, 3)', 'background-color': 'rgb(4, 5, 6)', 'border-radius': '4px', 'font-family': 'FixtureFont', display: 'block', position: 'absolute', overflow: 'hidden', opacity: '1' }).map(([property, value]) => ({ action: 'assertStyle', selector: '#box', property, value })),
      { action: 'assertImageLoaded', selector: '#image' },
      { action: 'assertAttribute', selector: '#image', attribute: 'src', value: '/image.png' },
      { action: 'assertAttribute', selector: '#image', attribute: 'alt', value: 'Fixture' },
      { action: 'assertFontLoaded', font: '16px FixtureFont' },
      { action: 'assertNotObscured', selector: '#target' },
      { action: 'assertNoOverlap', selector: '#target', otherSelector: '#covered' },
      { action: 'assertNoOverlap', selector: '#target', otherSelector: '#touching' },
      { action: 'assertText', selector: '#svg-text', value: 'SVG label' },
      { action: 'assertVisible', selector: '#sensitive' },
      { action: 'assertEnabled', selector: '#sensitive' },
      ...Object.entries({ type: 'password', 'aria-invalid': 'true', 'aria-controls': 'hint', 'aria-describedby': 'hint', autocomplete: 'current-password' }).map(([attribute, value]) => ({ action: 'assertAttribute', selector: '#sensitive', attribute, value })),
    ]
    while (steps.length < 60) steps.push({ action: 'assertVisible', selector: '#box' })
    const passed = await runSteps(steps)
    assert.equal(passed.status, 'passed', passed.output)
    assert.match(passed.output ?? '', /60\/60/)
    const desktop = await runSteps([
      { action: 'assertGeometry', selector: 'body', metric: 'width', min: 1440, max: 1440 },
      { action: 'assertGeometry', selector: '#viewport', metric: 'height', min: 900, max: 900 },
    ], { width: 1440, height: 900 })
    assert.equal(desktop.status, 'passed', desktop.output)
    for (const step of [
      { action: 'assertGeometry', selector: '#box', metric: 'width', min: 121, max: 121, tolerance: 0.5 },
      { action: 'assertStyle', selector: '#box', property: 'color', value: 'rgb(1, 2, 4)' },
      { action: 'assertImageLoaded', selector: '#broken' },
      { action: 'assertImageLoaded', selector: '#box' },
      { action: 'assertFontLoaded', font: '16px UndeclaredFont' },
      { action: 'assertNotObscured', selector: '#covered' },
      { action: 'assertNotObscured', selector: '#offscreen' },
      { action: 'assertNotObscured', selector: '#hidden' },
      { action: 'assertNoOverlap', selector: '#covered', otherSelector: '#cover' },
      { action: 'assertNoOverlap', selector: '#target', otherSelector: '#partial' },
      { action: 'assertNoOverlap', selector: '#target', otherSelector: '#hidden' },
      { action: 'assertAttribute', selector: '#sensitive', attribute: 'aria-invalid', value: 'false' },
      { action: 'assertText', selector: '#hidden-text', value: 'Hidden expectation' },
      { action: 'assertText', selector: '#svg-text', value: 'SVG hidden expectation' },
    ]) {
      const failed = await runSteps([step])
      assert.equal(failed.status, 'failed', JSON.stringify(step))
      assert.equal(failed.failureCategory, 'assertion', failed.output)
      assert.doesNotMatch(failed.output ?? '', /fixture-secret/)
    }
    for (const step of [
      { action: 'focus', selector: '#sensitive' },
      { action: 'assertValue', selector: '#sensitive', value: 'fixture-secret' },
      { action: 'assertText', selector: '#sensitive', value: 'fixture-secret' },
    ]) {
      const blocked = await runSteps([step, { action: 'assertVisible', selector: '#box' }])
      assert.equal(blocked.status, 'blocked', blocked.output)
      assert.equal(blocked.screenshot, undefined)
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(directory, { recursive: true, force: true })
  }
})

test('v3 isolated request observation counts attempts since start and waits the entire window', async () => {
  let foreignRequests = 0
  const foreign = createServer((_request, response) => { foreignRequests++; response.end('foreign') })
  await new Promise<void>((resolve) => foreign.listen(0, '127.0.0.1', resolve))
  const foreignAddress = foreign.address()
  if (!foreignAddress || typeof foreignAddress === 'string') throw new Error('No local port')
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://fixture.local').pathname
    if (path === '/api/failed') return response.destroy()
    if (path.startsWith('/api/')) return response.end('ok')
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(`<h1>Network fixture</h1><script>fetch('/api/events?token=fixture-query-secret').finally(()=>document.querySelector('h1').textContent='Ready')</script>
      <button id="send" onclick="fetch('/api/events?token=fixture-query-secret',{method:'POST'});fetch('/api/events');fetch('/api/events/child',{method:'POST'})">Send</button>
      <button id="late" onclick="setTimeout(()=>fetch('/api/events',{method:'POST'}),250)">Late</button>
      <button id="extra" onclick="fetch('/api/events',{method:'POST'});setTimeout(()=>fetch('/api/events',{method:'POST'}),250)">Extra</button>
      <button id="failed" onclick="fetch('/api/failed',{method:'POST'}).catch(()=>{})">Failed attempt</button>
      <button id="foreign" onclick="fetch('http://127.0.0.1:${foreignAddress.port}/api/events').catch(()=>{})">Foreign</button>`)
  })
  const directory = mkdtempSync(join(tmpdir(), 'code-flow-browser-network-'))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No local port')
    const url = `http://127.0.0.1:${address.port}`
    const runSteps = (steps: unknown[]) => executeBrowserScript(url, JSON.stringify({ path: '/', steps: [{ action: 'assertText', selector: 'h1', value: 'Ready' }, ...steps] }), { id: 'TC-NETWORK' } as SelfTestCase, directory)
    const start = { action: 'startNetworkObservation', id: 'events', path: '/api/events', method: 'POST' }
    const count = (value: number, observationMs = 350) => ({ action: 'assertRequestCount', id: 'events', count: value, observationMs })
    const initial = await executeBrowserScript(url, JSON.stringify({ path: '/', steps: [
      { action: 'startNetworkObservation', id: 'document', path: '/', method: 'GET' },
      { action: 'startNetworkObservation', id: 'initial', path: '/api/events', method: 'GET' },
      { action: 'startNetworkObservation', id: 'absent', path: '/api/absent', method: 'GET' },
      { action: 'assertText', selector: 'h1', value: 'Ready' },
      { action: 'assertRequestCount', id: 'document', count: 1, observationMs: 100 },
      { action: 'assertRequestCount', id: 'initial', count: 1, observationMs: 100 },
      { action: 'assertRequestCount', id: 'absent', count: 0, observationMs: 100 },
    ] }), { id: 'TC-NAVIGATION-NETWORK' } as SelfTestCase, directory)
    assert.equal(initial.status, 'passed', initial.output)
    assert.match(initial.output ?? '', /7\/7/)
    const passed = await runSteps([
      start,
      { action: 'startNetworkObservation', id: 'initial', path: '/api/events', method: 'GET' },
      { action: 'assertRequestCount', id: 'initial', count: 0, observationMs: 100 },
      count(0, 100),
      { action: 'click', selector: '#send' }, count(1), count(1, 100),
      { action: 'click', selector: '#send' }, count(2),
      { action: 'startNetworkObservation', id: 'failed', path: '/api/failed', method: 'POST' },
      { action: 'click', selector: '#failed' },
      { action: 'assertRequestCount', id: 'failed', count: 1, observationMs: 200 },
      { action: 'click', selector: '#foreign' }, count(2, 200),
    ])
    assert.equal(passed.status, 'passed', passed.output)
    assert.equal(foreignRequests, 0, 'Existing same-origin route must prevent foreign HTTP traffic')
    for (const [selector, expected] of [['#late', 0], ['#extra', 1]] as const) {
      const failed = await runSteps([start, { action: 'click', selector }, count(expected, 600)])
      assert.equal(failed.status, 'failed', failed.output)
      assert.equal(failed.failureCategory, 'assertion')
      assert.doesNotMatch(failed.output ?? '', /fixture-query-secret|token=|http:/)
    }
    const delayed = await runSteps([start, { action: 'click', selector: '#late' }, count(1, 600)])
    assert.equal(delayed.status, 'passed', delayed.output)
    const fresh = await runSteps([start, count(0, 100)])
    assert.equal(fresh.status, 'passed', fresh.output)
  } finally {
    await Promise.all([new Promise<void>((resolve) => server.close(() => resolve())), new Promise<void>((resolve) => foreign.close(() => resolve()))])
    rmSync(directory, { recursive: true, force: true })
  }
})

test('v4 geometry schemas enforce finite bounds, strict fields and bounded earlier snapshots', () => {
  const snapshot = { action: 'snapshotGeometry', id: 'before', selector: '#box', metric: 'width' }
  const comparison = { action: 'assertMetricComparison', selector: '#box', metric: 'width', otherSelector: '#other', otherMetric: 'height', operation: 'ratio', min: 1 }
  const saved = { action: 'assertSnapshotComparison', id: 'before', selector: '#box', metric: 'width', operation: 'difference', max: 10 }
  const visible = { action: 'assertVisible', selector: 'body' }
  const plan = (steps: unknown[], extra = {}) => JSON.stringify({ path: '/', steps, ...extra })
  for (const metric of browserGeometryMetrics) {
    assert.equal(parseBrowserPlan(plan([{ ...comparison, metric, otherMetric: metric }])).kind, 'script')
    assert.equal(parseBrowserPlan(plan([{ ...snapshot, metric }, { ...saved, metric }])).kind, 'script')
  }
  for (const operation of ['ratio', 'difference']) {
    assert.equal(parseBrowserPlan(plan([{ ...comparison, operation, min: -1, max: 2, tolerance: 0.5 }])).kind, 'script')
    assert.equal(parseBrowserPlan(plan([snapshot, { ...saved, operation, min: -2, tolerance: 0 }])).kind, 'script')
  }
  for (const invalid of [
    { metric: 'innerText' }, { operation: 'evaluate' }, { operation: null },
    { min: undefined, max: undefined }, { min: 2, max: 1 }, { min: 1_000_001 },
    { min: -1_000_001 }, { min: '1' }, { min: null }, { min: Infinity },
    { max: null }, { max: Infinity }, { tolerance: -1 }, { tolerance: 101 }, { tolerance: null },
    { tolerance: '1' }, { tolerance: Infinity }, { evaluate: 'document.cookie' },
    { endpoint: { selector: '#box', metric: 'width' } },
  ]) {
    assert.throws(() => parseBrowserPlan(plan([{ ...comparison, ...invalid }])), JSON.stringify(invalid))
    assert.throws(() => parseBrowserPlan(plan([snapshot, { ...saved, min: 0, ...invalid }])), JSON.stringify(invalid))
  }
  for (const invalid of [
    { otherSelector: '' }, { otherSelector: 'x'.repeat(251) }, { otherSelector: null },
    { otherMetric: 'value' }, { otherMetric: undefined }, { otherMetric: { metric: 'width' } },
    { otherSelector: undefined }, { id: 'not-allowed' },
  ]) assert.throws(() => parseBrowserPlan(plan([{ ...comparison, ...invalid }])))
  for (const invalid of [
    { id: '' }, { id: 'bad id' }, { id: 'x'.repeat(41) }, { id: null }, { id: undefined },
    { metric: 'textContent' }, { metric: undefined }, { selector: '' }, { selector: 'x'.repeat(251) },
    { value: 'secret' }, { metrics: ['width'] }, { min: 0 }, { operation: 'ratio' },
  ]) assert.throws(() => parseBrowserPlan(plan([{ ...snapshot, ...invalid }, visible])))
  for (const steps of [
    [saved], [saved, snapshot], [snapshot, snapshot, visible], [snapshot, { ...saved, id: 'missing' }],
    [{ action: 'startNetworkObservation', id: 'before', path: '/', method: 'GET' }, saved],
    [snapshot, { ...saved, otherMetric: 'height' }], [snapshot, { ...saved, id: null }],
  ]) assert.throws(() => parseBrowserPlan(plan(steps)))
  const snapshots = Array.from({ length: browserLimits.maxGeometrySnapshots }, (_, index) => ({ ...snapshot, id: `snap${index}` }))
  assert.equal(parseBrowserPlan(plan([...snapshots, visible])).kind, 'script')
  assert.throws(() => parseBrowserPlan(plan([...snapshots, snapshot, visible])))
  assert.throws(() => parseBrowserPlan(plan([snapshot])), /断言/)
  assert.throws(() => parseBrowserPlan(plan([{ action: 'hover', selector: '#box' }, snapshot])), /断言/)
  assert.equal(parseBrowserPlan(plan([snapshot, saved, ...Array.from({ length: 58 }, () => visible)])).kind, 'script')
  assert.throws(() => parseBrowserPlan(plan([snapshot, saved, ...Array.from({ length: 59 }, () => visible)])), /60/)
  assert.throws(() => parseBrowserPlan(plan([visible], { snapshots: {} })))
  assert.throws(() => parseBrowserPlan(plan([visible], { viewport: { width: 390, height: 800, snapshots: {} } })))
  assert.throws(() => parseBrowserPlan(' {"path":"/","steps":[{"action":"assertMetricComparison","selector":"body","metric":"width","otherSelector":"body","otherMetric":"height","operation":"ratio","min":1e309}]}'))
  for (const phrase of ['assertMetricComparison', 'snapshotGeometry', 'assertSnapshotComparison', 'assertTextExact', 'assertCount', 'native OS tooltips', 'zero ratio denominator', 'ONE execution only', 'Unknown fields rejected at every level']) assert.ok(browserPlanInstructions.includes(phrase), phrase)
})

test('v4 isolated Chrome passes hover, exact counts/text, computed borders and numeric geometry snapshots', async () => {
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(`<style>
      #box {width:100px;height:40px;box-sizing:border-box;border:2px solid rgb(1,2,3)}
      #other {width:50px;height:20px} #zero {width:0;height:0}
      #hover {display:block;width:100px;height:30px} #tooltip {display:none} #hover:hover #tooltip {display:block}
      #outside {position:absolute;left:-1000001px;width:1px;height:1px}
      #sensitive {width:80px;box-sizing:border-box}
    </style>
    <div id="hover">Hover<span id="tooltip">DOM tooltip</span></div>
    <h1>  Hello\n <span>world</span><span hidden>Hidden secret</span></h1>
    <svg id="svg" width="100" height="30"><text y="20">SVG label</text><text style="display:none">Hidden SVG</text></svg>
    <div class="item">One</div><div class="item">Two</div><div class="item" hidden>Three</div>
    <div id="box"></div><div id="other"></div><div id="zero"></div><div id="outside"></div>
    <button id="resize" onclick="document.querySelector('#box').style.width='200px'">Resize</button>
    <input id="sensitive" type="password" value="fixture-secret" title="No native guarantee">`)
  })
  const directory = mkdtempSync(join(tmpdir(), 'code-flow-browser-v4-'))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No local port')
    const url = `http://127.0.0.1:${address.port}`
    const runSteps = (steps: unknown[]) => executeBrowserScript(url, JSON.stringify({ path: '/', steps }), { id: 'TC-V4' } as SelfTestCase, directory)
    const metric = { action: 'assertMetricComparison', selector: '#box', metric: 'width', otherSelector: '#other', otherMetric: 'width', operation: 'ratio', min: 2, max: 2 }
    const snapshot = { action: 'snapshotGeometry', id: 'before', selector: '#box', metric: 'width' }
    const saved = { action: 'assertSnapshotComparison', id: 'before', selector: '#box', metric: 'width', operation: 'difference', min: 100, max: 100 }
    const borders = Object.fromEntries(['', '-top', '-right', '-bottom', '-left'].flatMap((side) => [
      [`border${side}-color`, 'rgb(1, 2, 3)'], [`border${side}-width`, '2px'], [`border${side}-style`, 'solid'],
    ]))
    const passed = await runSteps([
      { action: 'hover', selector: '#hover' }, { action: 'assertVisible', selector: '#tooltip' },
      { action: 'assertTextExact', selector: 'h1', value: ' Hello \t world  ' },
      { action: 'assertTextExact', selector: '#svg', value: 'SVG label' },
      { action: 'assertCount', selector: '.item', count: 3 },
      { action: 'assertCount', selector: '#absent', count: 0 },
      ...Object.entries(borders).map(([property, value]) => ({ action: 'assertStyle', selector: '#box', property, value })),
      metric,
      { ...metric, otherMetric: 'height', min: 5, max: 5 },
      { ...metric, operation: 'difference', min: 50.5, max: 50.5, tolerance: 0.5 },
      { ...metric, operation: 'difference', min: 49.5, max: 49.5, tolerance: 0.5 },
      snapshot, { action: 'click', selector: '#resize' }, saved,
      { ...saved, operation: 'ratio', min: 2, max: 2 },
      { ...saved, min: 100.5, max: 100.5, tolerance: 0.5 },
      { action: 'snapshotGeometry', id: 'passwordSize', selector: '#sensitive', metric: 'width' },
      { action: 'assertSnapshotComparison', id: 'passwordSize', selector: '#sensitive', metric: 'width', operation: 'difference', min: 0, max: 0 },
      { ...metric, selector: '#sensitive', min: 1.6, max: 1.6 },
      { action: 'assertCount', selector: '#sensitive', count: 1 },
    ])
    assert.equal(passed.status, 'passed', passed.output)
    assert.equal(passed.protocolVersion, 'browser-v4')
    assert.ok(passed.screenshot && statSync(join(directory, passed.screenshot)).size > 100)
    assert.doesNotMatch(passed.output ?? '', /fixture-secret|Hidden secret/)
    const fresh = await runSteps([snapshot, { ...saved, operation: 'ratio', min: 1, max: 1 }])
    assert.equal(fresh.status, 'passed', fresh.output)
    for (const steps of [
      [{ action: 'hover', selector: '#absent' }, { action: 'assertVisible', selector: 'h1' }],
      [{ action: 'assertCount', selector: '.item', count: 1 }],
      [{ action: 'assertTextExact', selector: 'h1', value: 'Hello' }],
      [{ action: 'assertTextExact', selector: 'h1', value: 'Hello world Hidden secret' }],
      ...Object.entries({ 'border-color': 'rgb(1, 2, 4)', 'border-width': '3px', 'border-style': 'dashed' }).map(([property, value]) => [{ action: 'assertStyle', selector: '#box', property, value }]),
      [{ ...metric, min: 3, max: 3 }],
      [{ ...metric, otherSelector: '#zero' }],
      [{ ...snapshot, selector: '#absent' }, { action: 'assertVisible', selector: 'h1' }],
      [{ ...snapshot, selector: '#outside', metric: 'x' }, { action: 'assertVisible', selector: 'h1' }],
      [snapshot, saved],
      [{ ...snapshot, selector: '#zero' }, { ...saved, operation: 'ratio', min: 1, max: 1 }],
    ]) {
      const failed = await runSteps(steps)
      assert.equal(failed.status, 'failed', JSON.stringify(steps))
      const failedAction = steps[0].action === 'hover' || (steps[0].action === 'snapshotGeometry' && ['#absent', '#outside'].includes(steps[0].selector)) ? steps[0].action : steps[steps.length - 1].action
      assert.equal(failed.failureCategory, failedAction.startsWith('assert') ? 'assertion' : 'action', failed.output)
      assert.equal(failed.failureKind, 'step')
      assert.ok(failed.finishedAt)
      assert.doesNotMatch(failed.output ?? '', /fixture-secret|Hidden secret|document.cookie/)
    }
    for (const action of ['hover', 'assertTextExact']) {
      const blocked = await runSteps([{ action, selector: '#sensitive', ...(action === 'assertTextExact' ? { value: 'fixture-secret' } : {}) }, { action: 'assertVisible', selector: 'h1' }])
      assert.equal(blocked.status, 'blocked', blocked.output)
      assert.equal(blocked.failureCategory, 'policy')
      assert.equal(blocked.reasonCode, 'authorization')
      assert.equal(blocked.screenshot, undefined)
      assert.doesNotMatch(blocked.output ?? '', /fixture-secret/)
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(directory, { recursive: true, force: true })
  }
})

test('v3 total execution budget cannot pass after its deadline', async (context) => {
  const originalNow = Date.now.bind(Date)
  const server = createServer((request, response) => {
    if (request.url === '/expire') {
      context.mock.method(Date, 'now', () => originalNow() + browserLimits.executionTimeoutMs + 1)
      response.end('expired')
    } else {
      response.end('<button onclick="fetch(\'/expire\').then(()=>this.textContent=\'Expired\')">Expire</button>')
    }
  })
  const directory = mkdtempSync(join(tmpdir(), 'code-flow-browser-deadline-'))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No local port')
    const result = await executeBrowserScript(`http://127.0.0.1:${address.port}`, JSON.stringify({ path: '/', steps: [{ action: 'click', selector: 'button' }, { action: 'assertText', selector: 'button', value: 'Expired' }] }), { id: 'TC-DEADLINE' } as SelfTestCase, directory)
    assert.equal(result.status, 'failed', result.output)
    assert.ok(result.finishedAt)
  } finally {
    context.mock.restoreAll()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(directory, { recursive: true, force: true })
  }
})