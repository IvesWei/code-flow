import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { parse, type DefaultTreeAdapterTypes } from 'parse5'
import ts from 'typescript'
import { chromium } from 'playwright-core'
import { agentProfiles } from '../../agents/profiles.js'
import { executionEnvironment } from '../../execution/execution-environment.js'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const diagram = join(root, 'docs', 'architecture.html')
type HtmlNode = DefaultTreeAdapterTypes.Node
type HtmlElement = DefaultTreeAdapterTypes.Element
interface RoleSnapshot {
  label: string
  scope: string
  source: string
  tools: string[] | null
  permissions: string[]
  children: string[]
  maxRequests: number
  maxTools: number
}
interface ArchitectureSnapshot {
  routes: string[]
  apiRegistrations: string[]
  components: Record<string, string>
  frameworks: Record<string, number>
  roles: Record<string, RoleSnapshot>
}

function elements(node: HtmlNode): HtmlElement[] {
  return [...('attrs' in node ? [node] : []), ...('childNodes' in node ? node.childNodes.flatMap(elements) : [])]
}
function attribute(node: HtmlElement, name: string) { return node.attrs.find(item => item.name === name)?.value }
function text(node: HtmlNode): string { return 'value' in node ? node.value : 'childNodes' in node ? node.childNodes.map(text).join('') : '' }
function collect(source: ts.Node, select: (node: ts.Node) => string | undefined): string[] {
  const found: string[] = []
  function visit(node: ts.Node) {
    const value = select(node)
    if (value) found.push(value)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found.sort()
}

test('architecture snapshot stays aligned with live routes, API modules, framework majors and role boundaries', async () => {
  const html = await readFile(diagram, 'utf8')
  const nodes = elements(parse(html))
  const script = nodes.find(node => attribute(node, 'id') === 'architecture-snapshot')
  assert.ok(script, 'architecture snapshot is required')
  const snapshot: ArchitectureSnapshot = JSON.parse(text(script))
  const router = ts.createSourceFile('AppRouter.tsx', await readFile(join(root, 'src', 'app', 'AppRouter.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const routes = collect(router, node => {
    if (!ts.isJsxSelfClosingElement(node) || node.tagName.getText(router) !== 'Route') return
    const path = node.attributes.properties.find(property => ts.isJsxAttribute(property) && property.name.getText(router) === 'path')
    if (path && ts.isJsxAttribute(path) && path.initializer && ts.isStringLiteral(path.initializer) && path.initializer.text !== '*') return path.initializer.text
  })
  assert.deepEqual([...snapshot.routes].sort(), routes, 'Update docs/architecture.html when application routes change')
  const index = ts.createSourceFile('index.ts', await readFile(join(root, 'server', 'index.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
  const registrations = collect(index, node => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && /^register[A-Z]/.test(node.expression.text) ? node.expression.text : undefined)
  assert.deepEqual([...snapshot.apiRegistrations].sort(), registrations, 'Update the architecture when API module registrations change')
  const visibleText = nodes.filter(node => ['h3', 'p', 'td', 'code'].includes(node.tagName)).map(text).join('\n')
  for (const [component, file] of Object.entries(snapshot.components)) {
    const source = ts.createSourceFile(file, await readFile(join(root, ...file.split('/')), 'utf8'), ts.ScriptTarget.Latest, true)
    const classes = collect(source, node => ts.isClassDeclaration(node) ? node.name?.text : undefined)
    assert.ok(classes.includes(component), `Update the architecture for renamed component ${component}`)
    assert.ok(visibleText.includes(component), `The diagram must identify ${component}`)
  }
  const manifest: { dependencies: Record<string, string>; devDependencies: Record<string, string> } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  for (const [name, major] of Object.entries(snapshot.frameworks)) {
    const version = manifest.dependencies[name] ?? manifest.devDependencies[name]
    assert.ok(version, `${name} no longer exists in package.json`)
    assert.equal(Number(version.match(/\d+/)?.[0]), major, `Update the architecture for ${name}`)
  }
  assert.deepEqual(Object.keys(snapshot.roles).sort(), Object.keys(agentProfiles).sort(), 'Update the architecture when roles change')
  for (const [role, profile] of Object.entries(agentProfiles)) {
    const actual = snapshot.roles[role]
    assert.deepEqual({
      tools: actual.tools, permissions: actual.permissions, children: actual.children,
      maxRequests: actual.maxRequests, maxTools: actual.maxTools,
    }, {
      tools: profile.tools ?? null, permissions: profile.permissions, children: profile.children,
      maxRequests: profile.maxRequests, maxTools: profile.maxTools,
    }, `Update the architecture for ${role} permission, delegation or budget changes`)
    assert.ok((await stat(join(root, ...actual.source.split('/')))).isFile())
  }
  for (const node of nodes.filter(node => attribute(node, 'data-source') !== undefined)) {
    const href = attribute(node, 'href')
    assert.ok(href && !/^[a-z]+:/i.test(href), 'Source links must be portable local paths')
    assert.ok((await stat(resolve(dirname(diagram), ...href.split('/')))).isFile(), href)
  }
  assert.match(await readFile(join(root, 'AGENTS.md'), 'utf8'), /docs\/architecture\.html/)
  assert.match(await readFile(join(root, 'README.md'), 'utf8'), /docs\/architecture\.html/)
})

test('architecture HTML opens offline with keyboard navigation, printable roles and readable bounds at four widths', async () => {
  const screenshots = await mkdtemp(join(tmpdir(), 'codeflow-architecture-ui-'))
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true, env: executionEnvironment() })
    const context = await browser.newContext({ offline: true })
    const page = await context.newPage()
    const errors: string[] = []
    const network: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route(/^https?:/, async route => { network.push(route.request().url()); await route.abort() })
    await page.goto(pathToFileURL(diagram).href)
    assert.equal(await page.title(), 'Code/Flow · 系统架构图')
    assert.equal(await page.locator('[data-role]').count(), Object.keys(agentProfiles).length)
    for (const [role, profile] of Object.entries(agentProfiles)) {
      const card = page.locator(`[data-role="${role}"]`)
      assert.match(await card.innerText(), new RegExp(`${profile.maxRequests} 次`))
      assert.match(await card.innerText(), new RegExp(`${profile.maxTools} 次`))
    }
    for (const width of [1440, 1367, 390, 320]) {
      await page.setViewportSize({ width, height: 900 })
      await page.getByRole('link', { name: '系统总览', exact: true }).click()
      await page.getByRole('link', { name: 'Agent 边界', exact: true }).focus()
      await page.keyboard.press('Enter')
      assert.equal(new URL(page.url()).hash, '#agents')
      assert.equal(await page.getByRole('heading', { name: /受控 Agent 边界/ }).isVisible(), true)
      assert.equal(await page.evaluate(() => {
        const heading = document.getElementById('agents-title')!.getBoundingClientRect()
        return heading.top >= document.querySelector('header')!.getBoundingClientRect().bottom && heading.bottom < innerHeight
      }), true, 'Anchor navigation must not place the heading behind the sticky header')
      assert.deepEqual(await page.evaluate(() => {
        const outOfBounds = [...document.querySelectorAll<HTMLElement>('.node, .role-card, .flow li, .maintenance, nav a, .print')]
          .filter(element => { const rect = element.getBoundingClientRect(); return rect.left < -1 || rect.right > innerWidth + 1 })
          .map(element => element.textContent?.trim().slice(0, 70))
        const clippedContent = [...document.querySelectorAll<HTMLElement>('.node h3, .node p, .node code, .role-card dd, .flow strong, .flow span, nav a, .print')]
          .filter(element => element.scrollWidth > element.clientWidth + 1)
          .map(element => element.textContent?.trim().slice(0, 70))
        return { overflow: document.documentElement.scrollWidth > innerWidth, outOfBounds, clippedContent }
      }), { overflow: false, outOfBounds: [], clippedContent: [] }, `Layout at ${width}px`)
      await page.screenshot({ path: join(screenshots, `architecture-${width}.png`), fullPage: true })
      await page.getByRole('link', { name: '维护约定', exact: true }).click()
      assert.equal(new URL(page.url()).hash, '#maintenance')
    }
    await page.evaluate(() => { window.print = () => { document.body.dataset.printRequested = 'true' } })
    await page.getByRole('button', { name: '打印 / PDF', exact: true }).click()
    assert.equal(await page.locator('body').getAttribute('data-print-requested'), 'true')
    await page.emulateMedia({ media: 'print' })
    assert.equal(await page.locator('nav').isVisible(), false)
    assert.equal(await page.locator('[data-role]').count(), Object.keys(agentProfiles).length)
    for (const card of await page.locator('[data-role]').all()) assert.equal(await card.isVisible(), true)
    assert.deepEqual(errors, [], 'No script errors')
    assert.deepEqual(network, [], 'The diagram must not depend on network services')
  } finally {
    await browser?.close()
    if (process.env.KEEP_UI_SCREENSHOTS === '1') console.log(`Architecture screenshots: ${screenshots}`)
    else await rm(screenshots, { recursive: true, force: true })
  }
})
