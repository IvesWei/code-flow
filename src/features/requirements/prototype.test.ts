import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { buildPrototypeDocument, needsScreenshot, prototypePolicy, staticPrototypeGuards } from './prototype'

test('active or embedded original content requires a screenshot fallback', () => {
  for (const html of ['<script>location="https://example.com"</script>', '<img onerror="x()">', '<svg><script /></svg>', '<a href="javascript:alert(1)">x</a>', '<iframe src="https://example.com"></iframe>']) assert.equal(needsScreenshot(html), true)
  assert.equal(needsScreenshot('<button data-requirement-id="REQ-1">Confirm</button>'), false)
  assert.equal(needsScreenshot('<svg data-requirement-id="REQ-1" viewBox="0 0 24 24"><path d="M0 0L24 24" /></svg>'), false)
  assert.match(prototypePolicy, /default-src 'none'/)
  assert.match(prototypePolicy, /form-action 'none'/)
})

function staticPreview() {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  let html: string
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => ({ innerHTML: '', content: { querySelectorAll: () => [] } }) },
  })
  try {
    html = buildPrototypeDocument('<button data-requirement-id="REQ-1">Confirm</button>', 'preview_nonce', 'screen-1')
    assert.throws(() => buildPrototypeDocument('', 'invalid nonce', 'screen-1'), /Invalid preview nonce/)
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
    else Reflect.deleteProperty(globalThis, 'document')
  }
  const script = /<script nonce="preview_nonce">([\s\S]*?)<\/script>/.exec(html)?.[1]
  assert.ok(script)
  const listeners = new Map<string, Array<(event: Event) => void>>()
  const messages: Array<{ type: string; nonce: string; screenId: string; height: number }> = []
  const frames: Array<() => void> = []
  const observers: Array<() => void> = []
  const body = {
    getBoundingClientRect: () => ({ bottom: 600 }),
    querySelectorAll: () => [{ getBoundingClientRect: () => ({ bottom: 900 }) }],
  }
  const listen = (type: string, callback: (event: Event) => void) => {
    listeners.set(type, [...(listeners.get(type) || []), callback])
  }
  const runtime = {
    document: { addEventListener: listen, body },
    addEventListener: listen,
    parent: { postMessage: (message: typeof messages[number]) => messages.push(message) },
    innerHeight: 600,
    scrollY: 10,
    getComputedStyle: () => ({ marginBottom: '8' }),
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
    ResizeObserver: class {
      constructor(callback: () => void) { observers.push(callback) }
      observe(element: unknown) { assert.equal(element, body) }
    },
  }
  runInNewContext(script, runtime)
  const dispatch = (type: string, tag = 'div', key = '') => {
    const event = new Event(type, { cancelable: true })
    Object.defineProperties(event, {
      key: { value: key },
      target: { value: { closest: (selector: string) => selector.split(',').includes(tag) ? {} : null } },
    })
    for (const listener of listeners.get(type) || []) listener(event)
    return event.defaultPrevented
  }
  return { html, script, listeners, messages, frames, observers, runtime, dispatch }
}

test('static preview has no selection messages, highlight receiver or generated mask', () => {
  const preview = staticPreview()
  assert.ok(preview.script.includes(staticPrototypeGuards))
  assert.doesNotMatch(preview.script, /requirements:(?:select|highlight)|data-platform-selection|createElementNS|mask|tabindex/)
  assert.equal(preview.listeners.has('message'), false)
  for (const tag of ['a', 'summary', 'form', 'button', 'div']) assert.equal(preview.dispatch('click', tag), true)
  assert.equal(preview.dispatch('keydown', 'div', 'Enter'), false)
  assert.deepEqual(preview.messages, [])
  assert.match(preview.html, /script-src 'nonce-preview_nonce'/)
  assert.match(preview.html, /connect-src 'none'; base-uri 'none'; form-action 'none'/)
  assert.match(preview.html, /animation:none!important;transition:none!important/)
})

test('static preview keeps editing and keyboard guards without blocking page scrolling', () => {
  const { dispatch, listeners } = staticPreview()
  for (const type of ['beforeinput', 'paste', 'cut', 'drop', 'submit', 'reset', 'dblclick', 'contextmenu']) {
    assert.equal(dispatch(type), true)
  }
  for (const tag of ['input', 'textarea', 'select', 'button', 'summary', 'a']) {
    for (const key of ['Enter', ' ', 'ArrowDown', 'x']) assert.equal(dispatch('keydown', tag, key), true)
    for (const key of ['Tab', 'Escape']) assert.equal(dispatch('keydown', tag, key), false)
  }
  for (const tag of ['input', 'select']) {
    assert.equal(dispatch('pointerdown', tag), true)
    assert.equal(dispatch('wheel', tag), true)
  }
  assert.equal(dispatch('pointerdown'), false)
  assert.equal(dispatch('wheel'), false)
  assert.equal(dispatch('scroll'), false)
  assert.equal(dispatch('keydown', 'div', 'PageDown'), false)
  assert.equal(listeners.has('scroll'), false)
  assert.equal(listeners.has('touchmove'), false)
})

test('static preview retains geometric fitting and ignores viewport resize feedback', () => {
  const preview = staticPreview()
  preview.dispatch('DOMContentLoaded')
  assert.equal(preview.observers.length, 1)
  assert.equal(preview.frames.length, 1)
  preview.frames.shift()!()
  assert.equal(preview.messages.length, 1)
  assert.deepEqual({ ...preview.messages[0] }, {
    type: 'requirements:resize', nonce: 'preview_nonce', screenId: 'screen-1', height: 910,
  })
  preview.runtime.innerHeight = 910
  preview.observers[0]()
  assert.equal(preview.frames.length, 0)
  preview.observers[0]()
  preview.dispatch('load')
  assert.equal(preview.frames.length, 1)
  preview.frames.shift()!()
  assert.equal(preview.messages.length, 2)
  assert.ok(preview.messages.every(message => message.type === 'requirements:resize'))
})