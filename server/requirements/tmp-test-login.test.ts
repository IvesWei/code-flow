import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chromium } from 'playwright-core'
import { allowedTmpRequest, loginTmp } from './tmp-test-login.js'

test('TMP login grants exact dependencies without granting arbitrary origins or writes', () => {
  assert.equal(allowedTmpRequest(new URL('https://static-test.cdn.sunmi.com/app.js'), 'GET', 'script'), true)
  assert.equal(allowedTmpRequest(new URL('https://tmp-defender.test.sunmi.com/tmpdefender/login'), 'POST', 'xhr'), true)
  assert.equal(allowedTmpRequest(new URL('https://tmp-defender.test.sunmi.com/tmpdefender/login'), 'OPTIONS', 'other'), true)
  assert.equal(allowedTmpRequest(new URL('https://tmp-defender.test.sunmi.com/read'), 'GET', 'xhr'), true)
  for (const [url, method, type] of [
    ['https://tmp-defender.test.sunmi.com/delete', 'POST', 'xhr'],
    ['https://tmp.test.sunmi.com/save', 'POST', 'xhr'],
    ['https://static-test.cdn.sunmi.com/app.js', 'GET', 'fetch'],
    ['https://static-test.cdn.sunmi.com.evil.invalid/app.js', 'GET', 'script'],
    ['https://user:password@tmp.test.sunmi.com/', 'GET', 'document'],
    ['http://127.0.0.1:59128/', 'GET', 'script'],
    ['https://tools-center-server.test.sunmi-inc.com/toolscenter/addTracking', 'POST', 'xhr'],
  ]) assert.equal(allowedTmpRequest(new URL(url), method, type), false)
})

test('automatic LDAP login submits fixture credentials only to the auth endpoint and retains the isolated session', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    let posts = 0
    let forbidden = 0
    await context.route('**/*', async route => {
      const request = route.request()
      const url = new URL(request.url())
      const headers = { 'Access-Control-Allow-Origin': 'https://tmp.test.sunmi.com', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }
      if (url.origin === 'https://tmp-defender.test.sunmi.com' && url.pathname === '/tmpdefender/login') {
        if (request.method() === 'POST') {
          posts++
          assert.deepEqual(request.postDataJSON(), { username: 'fixture-user', password: 'fixture-secret' })
        }
        return route.fulfill({ status: 200, headers, contentType: 'application/json', body: '{}' })
      }
      if (url.origin !== 'https://tmp.test.sunmi.com') { forbidden++; return route.abort() }
      if (url.pathname !== '/user/login') return route.fulfill({ contentType: 'text/html', body: '<main>Projects</main>' })
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<button onclick="document.querySelector('form').hidden=false">更多登录方式</button><form hidden onsubmit="event.preventDefault(); fetch('https://tmp-defender.test.sunmi.com/tmpdefender/login', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:this.username.value,password:this.password.value})}).then(() => {localStorage.setItem('fixture-session','ready'); location.href='/dashboard/projects/star'})"><label>LDAP 账号<input name="username"></label><label>密码<input type="password" name="password"></label><button>LDAP 账号登录</button></form><script>fetch('https://blocked.invalid/tracking',{method:'POST'}).catch(() => {})</script>` })
    })
    await loginTmp(context, { origin: 'https://tmp.test.sunmi.com', username: 'fixture-user', password: 'fixture-secret' }, new AbortController().signal)
    assert.equal(posts, 1)
    assert.equal(forbidden, 0)
    assert.equal(context.pages().length, 0)
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<main>Projects</main>' }))
    const page = await context.newPage()
    await page.goto('https://tmp.test.sunmi.com/dashboard/projects/star')
    assert.equal(await page.evaluate(() => localStorage.getItem('fixture-session')), 'ready')
  } finally { await browser.close() }
})