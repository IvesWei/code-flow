import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Request, Response } from 'express'
import { authCallback, authStart, authStatus, sessionToken, sessionUser } from './auth.js'

function responseMock() {
  const cookies: Record<string, string> = {}
  let status = 200
  let location = ''
  let body: unknown
  const response = {
    cookie(name: string, value: string) { cookies[name] = value; return response },
    clearCookie(name: string) { delete cookies[name]; return response },
    status(value: number) { status = value; return response },
    json(value: unknown) { body = value; return response },
    send() { return response },
    redirect(value: string) { location = value; return response },
  }
  return { cookies, response: response as unknown as Response, get status() { return status }, get location() { return location }, get body() { return body } }
}

test('unconfigured login cannot start', () => {
  const originalId = process.env.GITHUB_CLIENT_ID
  const originalSecret = process.env.GITHUB_CLIENT_SECRET
  const originalNodeEnv = process.env.NODE_ENV
  delete process.env.GITHUB_CLIENT_ID
  delete process.env.GITHUB_CLIENT_SECRET
  process.env.NODE_ENV = 'production'
  try {
    const mock = responseMock()
    authStart({} as Request, mock.response)
    assert.equal(mock.status, 503)
    assert.equal(mock.location, '')
  } finally {
    if (originalId) process.env.GITHUB_CLIENT_ID = originalId
    if (originalSecret) process.env.GITHUB_CLIENT_SECRET = originalSecret
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = originalNodeEnv
  }
})

test('callback rejects a mismatched OAuth state without exchanging a code', async () => {
  const mock = responseMock()
  await authCallback({ query: { code: 'code', state: 'wrong' }, get: () => '' } as unknown as Request, mock.response)
  assert.equal(mock.status, 400)
  assert.equal(mock.location, '')
})

test('valid callback stores token only on server and redirects without it', async () => {
  const originalId = process.env.GITHUB_CLIENT_ID
  const originalSecret = process.env.GITHUB_CLIENT_SECRET
  const originalFetch = globalThis.fetch
  process.env.GITHUB_CLIENT_ID = 'test-client'
  process.env.GITHUB_CLIENT_SECRET = 'test-secret'
  try {
    const login = responseMock()
    authStart({} as Request, login.response)
    const state = login.cookies.codeflow_oauth_state
    assert.equal(new URL(login.location).hostname, 'github.com')
    assert.equal(new URL(login.location).searchParams.get('redirect_uri'), 'http://127.0.0.1:3001/api/auth/callback')
    globalThis.fetch = async (input) => new Response(JSON.stringify(String(input).includes('/access_token') ? { access_token: 'gho_test_token' } : { id: 123, login: 'test-user' }), { status: 200 })
    const callback = responseMock()
    await authCallback({ query: { code: 'test-code', state }, get: (name: string) => name === 'cookie' ? `codeflow_oauth_state=${state}` : '' } as unknown as Request, callback.response)
    assert.equal(callback.location, 'http://127.0.0.1:5174/')
    assert.doesNotMatch(callback.location, /gho_test_token/)
    assert.notEqual(callback.cookies.codeflow_session, 'gho_test_token')
    const request = { get: (name: string) => name === 'cookie' ? `codeflow_session=${callback.cookies.codeflow_session}` : '' } as unknown as Request
    assert.equal(sessionToken(request), 'gho_test_token')
    assert.equal(sessionUser(request)?.ownerId, 123)
    const secondLogin = responseMock()
    authStart({} as Request, secondLogin.response)
    const secondState = secondLogin.cookies.codeflow_oauth_state
    globalThis.fetch = async (input) => new Response(JSON.stringify(String(input).includes('/access_token') ? { access_token: 'gho_second_user' } : { id: 456, login: 'second-user' }), { status: 200 })
    const secondCallback = responseMock()
    await authCallback({ query: { code: 'second-code', state: secondState }, get: (name: string) => name === 'cookie' ? `codeflow_oauth_state=${secondState}` : '' } as unknown as Request, secondCallback.response)
    const secondRequest = { get: (name: string) => name === 'cookie' ? `codeflow_session=${secondCallback.cookies.codeflow_session}` : '' } as unknown as Request
    assert.equal(sessionUser(secondRequest)?.ownerId, 456)
    assert.equal(sessionUser(request)?.ownerId, 123)
    assert.notEqual(secondCallback.cookies.codeflow_session, callback.cookies.codeflow_session)
    globalThis.fetch = async () => new Response('', { status: 401 })
    const expired = responseMock()
    await authStatus(request, expired.response)
    assert.deepEqual(expired.body, { configured: true, authenticated: false })
    assert.equal(sessionToken(request), undefined)
  } finally {
    globalThis.fetch = originalFetch
    if (originalId === undefined) delete process.env.GITHUB_CLIENT_ID
    else process.env.GITHUB_CLIENT_ID = originalId
    if (originalSecret === undefined) delete process.env.GITHUB_CLIENT_SECRET
    else process.env.GITHUB_CLIENT_SECRET = originalSecret
  }
})