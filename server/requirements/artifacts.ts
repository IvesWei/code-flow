import { prdSections, prdTextItems } from '../../shared/prd-sections.js'
import { prdTemplateOutline, type PrdEdition, type PrdOutlineLine } from '../../shared/prd-template.js'
import { businessChangeColors, businessReviewSections } from '../../shared/business-review.js'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { inflateSync } from 'node:zlib'
import { chromium, type Browser } from 'playwright-core'
import { executionEnvironment } from '../execution/execution-environment.js'
import { jsonDigest } from '../storage/json-digest.js'
import type { RequirementProject, RequirementRevision } from '../../shared/requirements.js'
import { htmlViolationDescriptions, inspectRequirementHtml } from './html-policy.js'
import { assertPrototypeSources, validatePrototypeDesign } from './prototype-design.js'
import { validatePrd } from './validation.js'

type ScreenCheck = {
  screenId: string
  visual: 'passed' | 'failed'
  interaction: 'not_verified'
  interactionErrors: string[]
  viewports: { width: number; height: number; errors: string[] }[]
}
export class RequirementPrdExportError extends Error {}
export type ValidatedRequirementRevision = RequirementRevision & {
  validation: NonNullable<RequirementRevision['validation']> & {
    artifactVersion: 1
    inputSha256: string
    allScreensValidated: boolean
    interactionVerified: false
    mode: 'static-script-disabled'
    screens: ScreenCheck[]
    limitations: string[]
  }
}

const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i
const limitations = [
  'Static visual evidence only; JavaScript is disabled and interactions are not verified.',
  'Requests are aborted and browser credentials are absent; this is not an OS network isolation guarantee.',
  'HTML export is a sandboxed screenshot prototype, not executable application code.',
]
const csp = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; worker-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; media-src 'none'; manifest-src 'none'"
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
const mdText = (value: string) => value.replace(/\r\n?/g, '\n').replace(/[\\`*_{}\[\]<>#!|~]/g, '\\$&')
const mdCell = (value: string) => mdText(value).replace(/\n/g, ' / ')

function identity(project: RequirementProject, revision: RequirementRevision) {
  assertPrototypeSources(revision)
  if (![project.id, revision.id, ...revision.screens.map((screen) => screen.id)].every((id) => uuid.test(id))) {
    throw new Error('Artifact project, revision and screen IDs must be UUIDs')
  }
  if (revision.screens.length > 40 || revision.screens.some((screen) => Buffer.byteLength(screen.html) > 1024 * 1024)) {
    throw new Error('Prototype exceeds artifact limits (40 screens, 1 MiB per screen)')
  }
}

function fingerprintInput(project: RequirementProject, revision: RequirementRevision, prd = revision.prd, screens = revision.screens, prototypes = revision.prototypes) {
  return { projectId: project.id, revisionId: revision.id, prd, screens, ...(prototypes ? { prototypes } : {}), sources: project.sources, decisions: project.decisions }
}

export function validationInputFingerprint(project: RequirementProject, revision: RequirementRevision) {
  return jsonDigest(fingerprintInput(project, revision))
}

export function validationInputMatches(expected: string | undefined, project: RequirementProject, revision: RequirementRevision): boolean {
  if (!expected) return false
  try { assertPrototypeSources(revision) } catch { return false }
  if (expected === validationInputFingerprint(project, revision) || expected === hash(JSON.stringify(fingerprintInput(project, revision)))) return true
  if (!revision.prototypes) return false
  try {
    const rebuilt = validatePrototypeDesign(revision.prototypes, revision.prd, revision.screens.filter((screen) => !screen.prototypeId))
    if (expected === hash(JSON.stringify(fingerprintInput(project, revision, revision.prd, rebuilt.screens, rebuilt.prototypes)))) return true
    const normalizedPrd = validatePrd(revision.prd, project.sources.map((source) => source.id))
    return expected === hash(JSON.stringify(fingerprintInput(project, revision, normalizedPrd, rebuilt.screens, rebuilt.prototypes)))
  } catch { return false }
}

function mappingErrors(project: RequirementProject, revision: RequirementRevision): string[] {
  const errors: string[] = []
  const unique = (values: string[], kind: string) => {
    if (new Set(values).size !== values.length || values.some((value) => !value.trim())) errors.push(`Duplicate or empty ${kind} IDs`)
    return new Set(values)
  }
  const sources = unique(project.sources.map((source) => source.id), 'source')
  const requirements = unique(revision.prd.requirements.map((requirement) => requirement.id), 'requirement')
  const acceptances = unique(revision.prd.requirements.flatMap((requirement) => requirement.acceptance.map((acceptance) => acceptance.id)), 'acceptance')
  unique(revision.screens.map((screen) => screen.id), 'screen')
  unique(revision.prd.blocks.map((block) => block.id), 'block')
  const check = (values: string[], allowed: Set<string>, owner: string) => {
    for (const value of values) if (!allowed.has(value)) errors.push(`${owner}: dangling reference ${value}`)
  }
  for (const block of revision.prd.blocks) {
    check(block.requirementIds, requirements, block.id)
    check(block.sourceIds, sources, block.id)
  }
  for (const requirement of revision.prd.requirements) {
    check(requirement.sourceIds, sources, requirement.id)
    if (!requirement.nonVisualReason && !revision.screens.some((screen) => screen.requirementIds.includes(requirement.id))) errors.push(`${requirement.id}: no screen mapping or non-visual reason`)
    for (const acceptance of requirement.acceptance) {
      if (!requirement.nonVisualReason && !revision.screens.some((screen) => screen.requirementIds.includes(requirement.id) && screen.acceptanceIds.includes(acceptance.id))) errors.push(`${acceptance.id}: no screen mapping`)
    }
  }
  for (const screen of revision.screens) {
    check(screen.requirementIds, requirements, screen.id)
    check(screen.acceptanceIds, acceptances, screen.id)
    if (!screen.requirementIds.length) errors.push(`${screen.id}: no requirement mappings`)
    const allowed = new Set(revision.prd.requirements.filter((requirement) => screen.requirementIds.includes(requirement.id)).flatMap((requirement) => requirement.acceptance.map((acceptance) => acceptance.id)))
    check(screen.acceptanceIds, allowed, `${screen.id} acceptance ownership`)
  }
  for (const evidence of project.evidence) check([evidence.sourceId], sources, 'evidence')
  return errors
}

async function ownedDirectory(root: string, parts: string[], create = false): Promise<string> {
  let directory = resolve(root)
  for (const part of ['', ...parts]) {
    if (part) directory = join(directory, part)
    if (create && part) await mkdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
    const info = await lstat(directory)
    if (info.isSymbolicLink() || !info.isDirectory() || resolve(await realpath(directory)).toLowerCase() !== directory.toLowerCase()) throw new Error('Unsafe artifact directory')
  }
  return directory
}

function storageKey(project: RequirementProject, revision: RequirementRevision, screenId: string) {
  return ['requirements', 'artifacts', project.id, revision.id, `${screenId}.png`].join('/')
}

async function saveScreenshot(root: string, key: string, buffer: Buffer) {
  const parts = key.split('/')
  const filename = parts.pop()!
  const directory = await ownedDirectory(root, parts, true)
  const target = join(directory, filename)
  const previous = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined })
  if (previous && (!previous.isFile() || previous.isSymbolicLink() || previous.nlink !== 1)) throw new Error('Unsafe screenshot target')
  const temporary = join(directory, `${randomUUID()}.tmp`)
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600)
  try {
    await handle.writeFile(buffer)
    await handle.close()
    await rename(temporary, target)
  } finally {
    await handle.close().catch(() => {})
    await rm(temporary, { force: true })
  }
}

async function readScreenshots(project: RequirementProject, revision: RequirementRevision, root: string) {
  const images = new Map<string, Buffer>()
  for (const shot of revision.screenshots || []) {
    const screen = revision.screens.find((item) => item.id === shot.screenId)
    if (images.has(shot.screenId) || !screen || shot.storageKey !== storageKey(project, revision, shot.screenId)) throw new Error('Invalid screenshot ownership or storage key')
    const directory = await ownedDirectory(root, ['requirements', 'artifacts', project.id, revision.id])
    const path = join(directory, `${shot.screenId}.png`)
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || info.size > 16 * 1024 * 1024) throw new Error('Unsafe screenshot file')
    const canonical = await realpath(path)
    if (relative(directory, canonical).startsWith(`..${sep}`) || dirname(canonical).toLowerCase() !== directory.toLowerCase()) throw new Error('Screenshot escapes artifact directory')
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    try {
      const current = await handle.stat()
      if (current.ino !== info.ino || current.dev !== info.dev || current.nlink !== 1 || current.size > 16 * 1024 * 1024) throw new Error('Screenshot changed while opening')
      const buffer = await handle.readFile()
      const mode = screen.capture?.mode ?? 'viewport'
      if (hash(buffer) !== shot.sha256 || !pngHasContent(buffer, mode)) throw new Error('Screenshot integrity or blank-image check failed')
      images.set(shot.screenId, buffer)
    } finally { await handle.close() }
  }
  return images
}

export async function readRequirementScreenshot(project: RequirementProject, revision: RequirementRevision, screenId: string, root: string) {
  identity(project, revision)
  const screenshot = revision.screenshots?.find(shot => shot.screenId === screenId)
  if (!screenshot) throw new Error('Screenshot not found in selected revision')
  const images = await readScreenshots(project, { ...revision, screenshots: [screenshot] }, root)
  const image = images.get(screenId)
  if (!image) throw new Error('Screenshot could not be read')
  return image
}

function pngHasContent(buffer: Buffer, mode: 'viewport' | 'element' | 'fullPage' = 'viewport'): boolean {
  if (!buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  const channels = buffer[25] === 2 ? 3 : buffer[25] === 6 ? 4 : 0
  const validSize = mode === 'fullPage'
    ? width === 1600 && height >= 1000 && height <= 16000
    : mode === 'element'
      ? width >= 80 && width <= 1600 && height >= 48 && height <= 8000
      : width === 1600 && height === 1000
  if (!validSize || buffer[24] !== 8 || !channels || buffer[28] !== 0) return false
  const chunks: Buffer[] = []
  for (let offset = 8; offset + 12 <= buffer.length;) {
    const size = buffer.readUInt32BE(offset)
    if (size > buffer.length - offset - 12) return false
    if (buffer.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(buffer.subarray(offset + 8, offset + 8 + size))
    offset += size + 12
  }
  const stride = width * channels
  const decoded = inflateSync(Buffer.concat(chunks), { maxOutputLength: (stride + 1) * height })
  if (decoded.length !== (stride + 1) * height) return false
  let previous = Buffer.alloc(stride)
  let changed = 0
  let first: number[] | undefined
  for (let row = 0; row < height; row++) {
    const filter = decoded[row * (stride + 1)]
    if (filter > 4) return false
    const current = Buffer.from(decoded.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1)))
    for (let column = 0; column < stride; column++) {
      const left = column >= channels ? current[column - channels] : 0
      const up = previous[column]
      const upperLeft = column >= channels ? previous[column - channels] : 0
      const prediction = left + up - upperLeft
      const distances = [Math.abs(prediction - left), Math.abs(prediction - up), Math.abs(prediction - upperLeft)]
      const paeth = distances[0] <= distances[1] && distances[0] <= distances[2] ? left : distances[1] <= distances[2] ? up : upperLeft
      current[column] = (current[column] + (filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : filter === 4 ? paeth : 0)) & 255
    }
    first ??= [...current.subarray(0, 3)]
    for (let pixel = 0; pixel < stride; pixel += channels) if (first.some((color, channel) => Math.abs(color - current[pixel + channel]) > 8)) changed++
    previous = current
  }
  return changed > 16
}

export async function validatePrototypeRevision(project: RequirementProject, revision: RequirementRevision, root: string, signal?: AbortSignal, sourceLabels?: ReadonlyMap<string, string[]>): Promise<ValidatedRequirementRevision> {
  identity(project, revision)
  signal?.throwIfAborted()
  const errors = mappingErrors(project, revision)
  if (!revision.screens.length) errors.push('No prototype screens to validate')
  const screens: ScreenCheck[] = []
  const screenshots: NonNullable<RequirementRevision['screenshots']> = []
  let browser: Browser | undefined
  let stopped = false
  const stop = () => { stopped = true; if (browser) void browser.close().catch(() => {}) }
  const deadline = setTimeout(stop, 60_000)
  deadline.unref()
  signal?.addEventListener('abort', stop, { once: true })
  try {
    if (errors.length) return result()
    const allowed = /^(?:PATH|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|HOME|USERPROFILE|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\))$/i
    const env = Object.fromEntries(Object.entries(executionEnvironment()).filter(([key]) => allowed.test(key)))
    browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true, env, timeout: 15_000, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'] })
    if (stopped || signal?.aborted) throw new Error('Prototype validation cancelled or timed out')
    const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block', acceptDownloads: false, permissions: [], storageState: { cookies: [], origins: [] } })
    await context.route('**/*', (route) => route.abort('blockedbyclient'))
    await context.routeWebSocket('**/*', (socket) => socket.close())
    context.setDefaultTimeout(5000)
    context.setDefaultNavigationTimeout(5000)
    for (const screen of revision.screens) {
      signal?.throwIfAborted()
      if (stopped) throw new Error('Prototype validation timed out')
      const check: ScreenCheck = { screenId: screen.id, visual: 'failed', interaction: 'not_verified', interactionErrors: [], viewports: [] }
      screens.push(check)
      const { violation } = inspectRequirementHtml(screen.html, 'static-script-disabled')
      if (violation) errors.push(`${screen.id}: Unsafe prototype source: ${htmlViolationDescriptions[violation]}`)
      for (const width of [1600]) {
        const view = { width, height: 1000, errors: [] as string[] }
        check.viewports.push(view)
        const page = await context.newPage()
        page.on('pageerror', () => view.errors.push('Prototype page error'))
        try {
          const captureMode = screen.capture?.mode ?? 'viewport'
          await page.setViewportSize({ width, height: view.height })
          await page.setContent(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}"><meta name="viewport" content="width=device-width,initial-scale=1">${screen.html}`, { waitUntil: 'load', timeout: 5000 })
          await page.evaluate(() => document.fonts?.ready).catch(() => {})
          const focusSelector = screen.capture?.scrollTo ?? (captureMode === 'element' ? screen.capture?.selector : undefined)
          if (focusSelector) {
            const focused = await page.evaluate((selector) => {
              const target = document.querySelector(selector)
              if (!target) return false
              target.scrollIntoView({ block: 'center', inline: 'nearest' })
              return true
            }, focusSelector)
            if (!focused) view.errors.push('Capture target element missing')
          }
          const observed = await page.evaluate(({ requirementIds, acceptanceIds, fullPage, elementSelector, padding }) => {
            const body = document.body
            const probes = { visible(element: Element) {
              const rect = element.getBoundingClientRect()
              const style = getComputedStyle(element)
              const vertical = fullPage ? rect.height > 0 : rect.top < innerHeight && rect.bottom > 0
              return rect.width > 0 && rect.height > 0 && vertical && rect.left < innerWidth && rect.right > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0
            }, mapped(id: string, kind: string): boolean { return [...document.querySelectorAll(`[data-${kind}-id], [data-${kind}-ids], [id]`)].some((element) => probes.visible(element) && (element.id === id || (element.getAttribute(`data-${kind}-id`) || '').split(/\s+/).includes(id) || (element.getAttribute(`data-${kind}-ids`) || '').split(/\s+/).includes(id))) },
            declared(kind: string): string[] { return [...document.querySelectorAll(`[data-${kind}-id], [data-${kind}-ids]`)].flatMap((element) => `${element.getAttribute(`data-${kind}-id`) || ''} ${element.getAttribute(`data-${kind}-ids`) || ''}`.trim().split(/\s+/).filter(Boolean)) } }
            let clip: { x: number; y: number; width: number; height: number } | undefined
            if (elementSelector) {
              const target = document.querySelector(elementSelector)
              if (target && probes.visible(target)) {
                const rect = target.getBoundingClientRect()
                const left = Math.max(0, Math.floor(rect.left - padding))
                const top = Math.max(0, Math.floor(rect.top - padding))
                const right = Math.min(innerWidth, Math.ceil(rect.right + padding))
                const bottom = Math.min(Math.max(innerHeight, document.documentElement.scrollHeight), Math.ceil(rect.bottom + padding))
                if (right - left >= 80 && bottom - top >= 48) clip = { x: left + scrollX, y: top + scrollY, width: right - left, height: bottom - top }
              }
            }
            return {
              blank: !body || ![...body.querySelectorAll('*')].some((element) => probes.visible(element) && ((element.textContent || '').trim().length > 0 || element.tagName === 'IMG')),
              overflow: document.documentElement.scrollWidth > innerWidth + 1 || !!body && body.scrollWidth > innerWidth + 1 || [...document.querySelectorAll('body *')].some((element) => probes.visible(element) && (element.getBoundingClientRect().right > innerWidth + 1 || element.getBoundingClientRect().left < -1)),
              images: [...document.images].some((image) => !image.complete || !image.naturalWidth),
              missing: [...requirementIds.filter((id) => !probes.mapped(id, 'requirement')), ...acceptanceIds.filter((id) => !probes.mapped(id, 'acceptance'))],
              dangling: [...probes.declared('requirement').filter((id) => !requirementIds.includes(id)), ...probes.declared('acceptance').filter((id) => !acceptanceIds.includes(id))],
              clip,
            }
          }, { requirementIds: screen.requirementIds, acceptanceIds: screen.acceptanceIds, fullPage: captureMode === 'fullPage', elementSelector: captureMode === 'element' ? screen.capture?.selector : undefined, padding: screen.capture?.padding ?? 0 })
          if (observed.blank) view.errors.push('Blank or invisible body')
          if (observed.overflow) view.errors.push('Horizontal geometry overflow')
          if (observed.images) view.errors.push('Broken or blocked image')
          const labels = sourceLabels?.get(screen.id)
          if (labels?.length && !await page.evaluate(({ labels, clip, fullPage }) => {
            const left = clip ? clip.x - scrollX : 0, right = left + (clip?.width ?? innerWidth)
            const top = clip ? clip.y - scrollY : fullPage ? -scrollY : 0, bottom = top + (clip?.height ?? (fullPage ? document.documentElement.scrollHeight : innerHeight))
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
            const range = document.createRange(), parts: string[] = []
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              if (!node.textContent?.trim() || !node.parentElement?.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue
              range.selectNodeContents(node)
              if ([...range.getClientRects()].some(rect => rect.width && rect.height && rect.right > left && rect.left < right && rect.bottom > top && rect.top < bottom)) parts.push(node.textContent)
            }
            const text = parts.join('').replace(/\s+/g, '')
            return labels.every(label => text.includes(label.replace(/\s+/g, '')))
          }, { labels, clip: observed.clip, fullPage: captureMode === 'fullPage' })) view.errors.push('Missing visible source evidence')
          if (captureMode === 'element' && !observed.clip) view.errors.push('Capture target element missing')
          for (const id of observed.missing) view.errors.push(`Missing visible mapping: ${id}`)
          for (const id of observed.dangling) view.errors.push(`Dangling DOM mapping: ${id}`)
          const buffer = await page.screenshot({
            type: 'png',
            fullPage: captureMode === 'fullPage',
            ...(captureMode === 'element' && observed.clip ? { clip: observed.clip } : {}),
            animations: 'disabled',
            timeout: 5000,
          })
          if (!pngHasContent(buffer, captureMode)) view.errors.push('Blank screenshot pixels')
          const key = storageKey(project, revision, screen.id)
          signal?.throwIfAborted()
          if (stopped) throw new Error('Prototype validation timed out')
          await saveScreenshot(root, key, buffer)
          screenshots.push({ screenId: screen.id, storageKey: key, sha256: hash(buffer) })
        } catch (error) {
          signal?.throwIfAborted()
          const diagnostic = error instanceof Error ? error.message.split('\n')[0].replace(/[\r\n<>]/g, '').slice(0, 180) : 'unknown failure'
          view.errors.push(`Prototype rendering failed: ${diagnostic}`)
        } finally { await page.close().catch(() => {}) }
      }
      check.visual = check.viewports.every((view) => !view.errors.length) ? 'passed' : 'failed'
      for (const view of check.viewports) errors.push(...view.errors.map((error) => `${screen.id} (${view.width}x${view.height}): ${error}`))
    }
  } catch {
    signal?.throwIfAborted()
    errors.push(stopped ? 'Prototype validation timed out' : 'Isolated Chromium validation unavailable or failed')
  } finally {
    clearTimeout(deadline)
    signal?.removeEventListener('abort', stop)
    await browser?.close().catch(() => {})
  }
  signal?.throwIfAborted()
  return result()

  function result(): ValidatedRequirementRevision {
    return { ...revision, screenshots, validation: { at: new Date().toISOString(), errors: [...new Set(errors)], artifactVersion: 1, inputSha256: validationInputFingerprint(project, revision), mode: 'static-script-disabled', allScreensValidated: errors.length === 0 && screens.length === revision.screens.length && screens.length > 0 && screens.every((screen) => screen.visual === 'passed'), interactionVerified: false, screens, limitations: [...limitations] } }
  }
}

const sourceFallbackNotice = '基于源码复刻 · 真实运行态未验证'

function delivery(project: RequirementProject, revision: RequirementRevision, images: Map<string, Buffer>) {
  const validation = revision.validation as ValidatedRequirementRevision['validation'] | undefined
  const complete = !!revision.confirmedAt && !!revision.designConfirmedAt && validation?.artifactVersion === 1 && validationInputMatches(validation.inputSha256, project, revision) && validation.allScreensValidated === true && !validation.errors.length && validation.screens.length === revision.screens.length && revision.screens.length > 0 && revision.screens.every((screen) => images.has(screen.id) && validation.screens.some((check) => check.screenId === screen.id && check.visual === 'passed' && check.viewports.length === 1 && check.viewports.some((view) => view.width === 1600 && view.height === 1000 && !view.errors.length))) && !mappingErrors(project, revision).length
  const label = complete ? 'Complete delivery (static visual validation only; interactions not verified)' : 'Discussion draft - not a complete delivery'
  return revision.capturePlan?.sourceFallback ? `${sourceFallbackNotice} · ${label}` : label
}

function markdown(project: RequirementProject, revision: RequirementRevision, label: string) {
  const lines = [`# ${mdText(revision.prd.title)}`, '', `**${label}**`, '', `Project: ${project.id}`, `Revision: ${revision.id}`, `Created: ${mdText(revision.createdAt)}`, `PRD confirmed: ${mdText(revision.confirmedAt || 'not confirmed')}`, `Design confirmed: ${mdText(revision.designConfirmedAt || 'not confirmed')}`, '', mdText(revision.prd.summary), '', '## Sources', '']
  for (const source of project.sources) lines.push(`- ${mdText(source.id)}: ${mdText(source.name)} (${source.kind}; SHA-256 ${mdText(source.sha256)}; ${source.sizeBytes} bytes)${source.url ? `; URL: ${mdText(source.url)}` : ''}`)
  lines.push('', '## Evidence', '')
  for (const evidence of project.evidence) lines.push(`- Source ${mdText(evidence.sourceId)}: ${mdText(evidence.summary)}; limitations: ${mdText(evidence.limitations)}`)
  lines.push('', '## Decisions', '')
  for (const decision of project.decisions) lines.push(`### ${mdText(decision.question.id)}: ${mdText(decision.question.text)}`, '', `Priority: ${decision.question.priority}; impact: ${mdText(decision.question.impact)}`, `Choices: ${decision.question.choices.map(mdText).join('; ')}`, `Recommendation: ${mdText(decision.question.recommendation)}`, `Answer: ${mdText(decision.answer)}`, `Recorded: ${mdText(decision.at)}`, '')
  const provenance = lines.splice(lines.indexOf('## Sources') - 1)
  const { sections, unassigned } = prdSections(revision.prd)
  const appendRequirement = (requirement: RequirementRevision['prd']['requirements'][number]) => {
    lines.push(`### ${mdText(requirement.id)}: ${mdText(requirement.title)}`, '', mdText(requirement.description), '')
    if (requirement.scenario) lines.push(`Scenario: ${mdText(requirement.scenario)}`, '')
    if (requirement.fields?.length) {
      lines.push('Fields:')
      for (const field of requirement.fields) lines.push(`- ${mdText(field.name)}: ${mdText(field.description)}`)
      lines.push('')
    }
    lines.push('Completion criteria:')
    if (requirement.nonVisualReason) lines.push(`Non-visual: ${mdText(requirement.nonVisualReason)}`)
    for (const acceptance of requirement.acceptance) lines.push(`- ${mdText(acceptance.id)}: ${mdText(acceptance.text)}`)
    lines.push('')
  }
  for (const { block, requirements } of sections) {
    lines.push(`## ${mdText(block.title)} (${mdText(block.id)})`, '', mdText(block.content), '')
    if (block.module) lines.push(`Module: ${mdText(block.module)}`, '')
    if (block.table?.columns.length) {
      lines.push(`| ${block.table.columns.map(mdCell).join(' | ')} |`, `| ${block.table.columns.map(() => '---').join(' | ')} |`)
      for (const row of block.table.rows) lines.push(`| ${block.table.columns.map((_, index) => mdCell(row[index] || '')).join(' | ')} |`)
      lines.push('')
    }
    requirements.forEach(appendRequirement)
  }
  if (unassigned.length) {
    lines.push('## Other functions', '')
    unassigned.forEach(appendRequirement)
  }
  lines.push('## Screen Mapping', '', '| Screen | State | Requirements | Acceptance | Screenshot |', '| --- | --- | --- | --- | --- |')
  for (const screen of revision.screens) lines.push(`| ${mdCell(screen.title)} (${screen.id}) | ${mdCell(screen.state)} | ${screen.requirementIds.map(mdCell).join(', ')} | ${screen.acceptanceIds.map(mdCell).join(', ')} | ${revision.screenshots?.some((shot) => shot.screenId === screen.id) ? `screenshots/${screen.id}.png` : 'unavailable'} |`)
  lines.push('', '## Validation', '', `Checked: ${mdText(revision.validation?.at || 'not validated')}`)
  for (const error of revision.validation?.errors || []) lines.push(`- ${mdText(error)}`)
  for (const limitation of limitations) lines.push(`- ${limitation}`)
  lines.push('', '## Provenance appendix', ...provenance)
  for (const block of revision.prd.blocks) lines.push(`- ${mdText(block.id)} sources: ${block.sourceIds.map(mdText).join(', ')}`)
  for (const requirement of revision.prd.requirements) lines.push(`- ${mdText(requirement.id)} sources: ${requirement.sourceIds.map(mdText).join(', ')}`)
  return `${lines.join('\n')}\n`
}

function htmlPrototype(revision: RequirementRevision, md: string, images: Map<string, Buffer>, label: string) {
  const frames = revision.screens.map((screen, index) => {
    const image = images.get(screen.id)
    const content = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}img{display:block;width:100%;height:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style>${image ? `<img alt="${escapeHtml(screen.title)}" src="data:image/png;base64,${image.toString('base64')}">` : '<p>No validated screenshot available.</p>'}`
    return `<input type="radio" name="screen" id="screen-${index}"${index === 0 ? ' checked' : ''}><label for="screen-${index}">${escapeHtml(screen.title)} (${escapeHtml(screen.state)})</label><section class="screen"><iframe sandbox="" referrerpolicy="no-referrer" title="${escapeHtml(screen.title)}" srcdoc="${escapeHtml(content)}"></iframe><details><summary>Prototype source (non-executable)</summary><pre>${escapeHtml(screen.html)}</pre></details></section>`
  }).join('\n')
  const outerCsp = csp.replace("frame-src 'none'", "frame-src 'self' about:").replace("child-src 'none'", "child-src 'self' about:")
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeHtml(outerCsp)}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(revision.prd.title)}</title><style>body{font:16px sans-serif;margin:16px;color:#182321;background:#f6f8f7}h1{font-size:24px}label{display:inline-block;padding:8px;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere}iframe{display:block;width:100%;height:1000px;border:0}.screen{display:none}input:checked+label+.screen{display:block}</style></head><body><h1>${escapeHtml(revision.prd.title)}</h1><p>${escapeHtml(label)}</p>${frames}<details><summary>Requirements and provenance</summary><pre>${escapeHtml(md)}</pre></details></body></html>`
}

async function docxBuffer(revision: RequirementRevision, md: string, images: Map<string, Buffer>) {
  const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, ImageRun, HeadingLevel } = await import('docx')
  const children: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = []
  let currentBlock: RequirementRevision['prd']['blocks'][number] | undefined
  let tableInserted = false
  for (const line of md.split('\n')) {
    if (line.startsWith('## ')) {
      currentBlock = revision.prd.blocks.find(block => line === `## ${mdText(block.title)} (${mdText(block.id)})`)
      tableInserted = false
    }
    if (line.startsWith('| ')) {
      const table = currentBlock?.table
      if (table?.columns.length && !tableInserted) {
        const rows = [table.columns, ...table.rows]
        children.push(new Table({ rows: rows.map(row => new TableRow({ children: row.map(text => new TableCell({ children: [new Paragraph(text)] })) })) }))
        tableInserted = true
      }
      continue
    }
    children.push(new Paragraph({ children: [new TextRun(line.replace(/^#{1,3} /, ''))], ...(line.startsWith('# ') ? { heading: HeadingLevel.TITLE } : line.startsWith('## ') ? { heading: HeadingLevel.HEADING_1 } : line.startsWith('### ') ? { heading: HeadingLevel.HEADING_2 } : {}), bidirectional: false }))
  }
  children.push(new Table({ rows: [new TableRow({ children: ['Screen', 'Requirements', 'Acceptance'].map((text) => new TableCell({ children: [new Paragraph(text)] })) }), ...revision.screens.map((screen) => new TableRow({ children: [screen.title, screen.requirementIds.join(', '), screen.acceptanceIds.join(', ')].map((text) => new TableCell({ children: [new Paragraph(text)] })) }))] }))
  for (const screen of revision.screens) {
    const image = images.get(screen.id)
    if (image) children.push(new Paragraph(screen.title), new Paragraph({ children: [new ImageRun({ data: image, type: 'png', transformation: { width: 560, height: 350 } })] }))
  }
  return Packer.toBuffer(new Document({ creator: 'Code/Flow', title: revision.prd.title, sections: [{ children }] }))
}

async function prdDocxBuffer(revision: RequirementRevision, images: Map<string, Buffer>, label: string) {
  const { Document, Packer, Paragraph, TextRun, ImageRun, HeadingLevel, Footer } = await import('docx')
  const runs = (text: string) => text.split(/\r\n?|\n/).map((line, index) => new TextRun({ text: line, ...(index ? { break: 1 } : {}) }))
  const paragraph = (text: string) => new Paragraph({ children: runs(text) })
  const bullet = (text: string, level: number) => new Paragraph({ children: runs(text), bullet: { level } })
  const children = [new Paragraph({ text: revision.prd.title, heading: HeadingLevel.TITLE }), paragraph(revision.prd.summary)]
  const appendRequirement = (requirement: RequirementRevision['prd']['requirements'][number]) => {
    children.push(new Paragraph({ text: `功能名称：${requirement.title}`, heading: HeadingLevel.HEADING_2, keepNext: true }), bullet(`对应场景：${requirement.scenario || '--'}`, 0), bullet('功能描述：', 0))
    for (const text of prdTextItems(requirement.description)) children.push(bullet(text, 1))
    if (requirement.fields?.length) {
      children.push(bullet('包含以下字段', 1))
      for (const field of requirement.fields) {
        children.push(bullet(field.name, 2))
        for (const text of prdTextItems(field.description)) children.push(bullet(text, 3))
      }
    }
    if (requirement.nonVisualReason) children.push(bullet(`非视觉需求：${requirement.nonVisualReason}`, 1))
    for (const screen of revision.screens.filter(screen => screen.requirementIds.includes(requirement.id))) {
      const image = images.get(screen.id)
      if (!image) throw new RequirementPrdExportError('当前修订缺少完整的原型截图，请先生成或验证设计后再导出 PRD。')
      children.push(new Paragraph({ text: `设计稿：${screen.title} · ${screen.state}`, heading: HeadingLevel.HEADING_3, keepNext: true }), new Paragraph({ children: [new ImageRun({ data: image, type: 'png', transformation: { width: 560, height: 350 } })] }))
    }
  }
  const { modules, unassigned } = prdSections(revision.prd)
  for (const [name, pages] of modules) {
    children.push(new Paragraph({ text: `模块：${name}`, heading: HeadingLevel.HEADING_1 }))
    for (const { block, requirements } of pages) {
      requirements.forEach(appendRequirement)
      children.push(new Paragraph({ children: [new TextRun({ text: `页面说明：${block.title}`, bold: true })], keepNext: true }), paragraph(block.content))
      if (block.table) for (const row of block.table.rows) {
        children.push(bullet(`${block.table.columns[0]}：${row[0]}`, 0))
        row.slice(1).forEach((cell, index) => children.push(bullet(`${block.table!.columns[index + 1]}：${cell}`, 1)))
      }
    }
  }
  if (unassigned.length) {
    children.push(new Paragraph({ text: '模块：其他功能', heading: HeadingLevel.HEADING_1 }))
    unassigned.forEach(appendRequirement)
  }
  const footer = new Footer({ children: [label, limitations[0]].map(text => new Paragraph({ children: [new TextRun({ text, size: 18 })] })) })
  return Packer.toBuffer(new Document({ creator: 'Code/Flow', title: revision.prd.title, sections: [{ children, footers: { default: footer } }] }))
}

async function dualPrdDocxBuffer(revision: RequirementRevision, images: Map<string, Buffer>, edition: PrdEdition) {
  const { Document, Packer, Paragraph, TextRun, ImageRun, LevelFormat, AlignmentType, Footer } = await import('docx')
  const pageWidth = 11906, margin = 1134, indent = 240
  const children = [new Paragraph({ style: 'PrdTitle', children: [new TextRun(revision.prd.title)] })]
  const paragraph = (text: string, level: number, bold = false, keepNext = false, color?: string) => new Paragraph({
    style: 'PrdBody', numbering: { reference: 'prd-outline', level }, keepNext, widowControl: true,
    children: text.split(/\r\n?|\n/).flatMap((line, index) => [new TextRun({ text: line, bold, color, ...(index ? { break: 1 } : {}) })]),
  })
  const appendPicture = (screen: RequirementRevision['screens'][number], level: number) => {
    const image = images.get(screen.id)
    if (!image) throw new RequirementPrdExportError('当前修订缺少完整的原型截图，请先生成或验证设计后再导出 PRD。')
    children.push(paragraph(`${screen.title} · ${screen.state}`, level, false, true))
    const width = Math.floor((pageWidth - margin * 2 - indent * (level + 1)) / 15)
    children.push(new Paragraph({ style: 'PrdBody', indent: { left: indent * (level + 1) }, children: [new ImageRun({ data: image, type: 'png', transformation: { width, height: Math.round(width * image.readUInt32BE(20) / image.readUInt32BE(16)) } })] }))
  }
  const appendLine = (entry: PrdOutlineLine, level: number) => {
    children.push(paragraph(entry.text, level, entry.bold, !!entry.children?.length || !!entry.designFor))
    if (entry.designFor) {
      const screens = revision.screens.filter(screen => screen.requirementIds.includes(entry.designFor!))
      if (!screens.length) {
        const requirement = revision.prd.requirements.find(item => item.id === entry.designFor)!
        if (!requirement.nonVisualReason) throw new RequirementPrdExportError(`功能“${requirement.title}”缺少对应设计稿，无法导出完整双版本 PRD。`)
        children.push(paragraph(requirement.nonVisualReason, level + 1))
      }
      for (const screen of screens) appendPicture(screen, level + 1)
    } else entry.children?.forEach(child => appendLine(child, level + 1))
  }
  if (edition === 'business') {
    const modules = businessReviewSections(revision)
    if (!modules.length) children.push(paragraph(revision.businessReview?.revisionId === revision.id ? '本修订没有已识别的业务变更。' : '本修订尚未整理业务变更清单。', 0))
    for (const module of modules) {
      children.push(paragraph(module.name, 0, true, true))
      for (const item of module.functions) {
        children.push(paragraph(item.title, 1, true, true))
        for (const change of item.changes) {
          children.push(paragraph(`${change.kind} · ${change.scope === 'logic' ? '后台逻辑' : '界面操作'}：${change.text}`, 2, false, false, businessChangeColors[change.kind].slice(1)))
          if (change.scope === 'ui' && !change.pictures.length) children.push(paragraph('待补图', 3))
          for (const { screen, owner } of change.pictures) {
            if (owner) children.push(paragraph(`见「${owner}」：${screen.title} · ${screen.state}`, 3))
            else appendPicture(screen, 3)
          }
        }
        for (const entry of item.pending) children.push(paragraph(`待核对：${entry.text}`, 2))
      }
    }
  } else for (const module of prdTemplateOutline(revision.prd, edition)) {
    children.push(paragraph(module.title, 0, true, true))
    for (const item of module.functions) {
      children.push(paragraph(item.title, 1, true, true), paragraph(item.scenario, 1), paragraph('功能描述：', 1, false, true))
      item.lines.forEach(entry => appendLine(entry, 2))
    }
  }
  return Packer.toBuffer(new Document({
    creator: 'Code/Flow', title: revision.prd.title,
    styles: { default: { document: { run: { font: 'Microsoft YaHei', size: 22, color: '182321' }, paragraph: { spacing: { after: 80, line: 330 } } } }, paragraphStyles: [
      { id: 'PrdTitle', name: 'PRD title', basedOn: 'Normal', next: 'PrdBody', run: { bold: true, size: 40 }, paragraph: { spacing: { after: 240 }, keepNext: true } },
      { id: 'PrdBody', name: 'PRD outline', basedOn: 'Normal', next: 'PrdBody' },
    ] },
    numbering: { config: [{ reference: 'prd-outline', levels: Array.from({ length: 9 }, (_, level) => ({ level, format: LevelFormat.BULLET, text: level === 0 ? '●' : level === 1 ? '○' : '■', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: indent * (level + 1), hanging: 160 } }, run: { font: 'Microsoft YaHei', size: 18 } } })) }] },
    sections: [{ properties: { page: { size: { width: pageWidth, height: 16838 }, margin: { top: margin, bottom: margin, left: margin, right: margin } } }, children, ...(revision.capturePlan?.sourceFallback ? { footers: { default: new Footer({ children: [new Paragraph({ children: [new TextRun({ text: sourceFallbackNotice, size: 18 })] })] }) } } : {}) }],
  }))
}

export async function exportRequirementRevision(project: RequirementProject, revision: RequirementRevision, format: 'md' | 'docx' | 'html' | 'zip', root: string, scope: 'full' | 'prd' = 'full'): Promise<{ buffer: Buffer; contentType: string; filename: string }> {
  identity(project, revision)
  if (!['md', 'docx', 'html', 'zip'].includes(format)) throw new Error('Unsupported requirement export format')
  if (!['full', 'prd'].includes(scope) || (scope === 'prd' && format !== (revision.prd.templateVersion === 2 ? 'zip' : 'docx'))) throw new Error('Unsupported PRD export format or scope')
  const images = await readScreenshots(project, revision, root)
  const needsScreens = revision.prd.templateVersion !== 2 || revision.prd.requirements.some(requirement => !requirement.nonVisualReason)
  if (scope === 'prd' && ((needsScreens && !revision.screens.length) || images.size !== revision.screens.length)) throw new RequirementPrdExportError('当前修订缺少完整的原型截图，请先生成或验证设计后再导出 PRD。')
  if (scope === 'prd') {
    const requirementIds = new Set(revision.prd.requirements.map(requirement => requirement.id))
    if (revision.screens.some(screen => !screen.requirementIds.length || screen.requirementIds.some(id => !requirementIds.has(id)))) throw new RequirementPrdExportError('部分设计稿未关联有效功能，无法放入对应功能下，请先检查设计稿与 PRD 的关联。')
  }
  const label = delivery(project, revision, images)
  const filename = `${scope === 'prd' ? 'prd' : 'requirements'}-${project.id}-${revision.id}.${format}`
  if (scope === 'prd' && revision.prd.templateVersion === 2) {
    const { zipSync } = await import('fflate')
    const business = await dualPrdDocxBuffer(revision, images, 'business')
    const development = await dualPrdDocxBuffer(revision, images, 'development')
    return { buffer: Buffer.from(zipSync({ '业务评审版.docx': business, '开发规格版.docx': development }, { level: 6, mtime: new Date('2000-01-01T00:00:00Z') })), contentType: 'application/zip', filename }
  }
  if (scope === 'prd') return { buffer: await prdDocxBuffer(revision, images, label), contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', filename }
  const md = markdown(project, revision, label)
  if (format === 'md') return { buffer: Buffer.from(md), contentType: 'text/markdown; charset=utf-8', filename }
  const html = htmlPrototype(revision, md, images, label)
  if (format === 'html') return { buffer: Buffer.from(html), contentType: 'text/html; charset=utf-8', filename }
  const docx = await docxBuffer(revision, md, images)
  if (format === 'docx') return { buffer: docx, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', filename }
  const { zipSync, strToU8 } = await import('fflate')
  const manifest = { schemaVersion: 1, projectId: project.id, revisionId: revision.id, label, confirmedAt: revision.confirmedAt || null, designConfirmedAt: revision.designConfirmedAt || null, inputSha256: validationInputFingerprint(project, revision), validation: revision.validation || null, limitations, sources: project.sources, decisions: project.decisions, screens: revision.screens.map(({ html: _html, ...screen }) => screen), screenshots: [...images].map(([screenId, buffer]) => ({ screenId, path: `screenshots/${screenId}.png`, sha256: hash(buffer) })) }
  const entries: Record<string, Uint8Array> = { 'requirements.md': strToU8(md), 'requirements.docx': docx, 'manifest.json': strToU8(`${JSON.stringify(manifest, null, 2)}\n`), 'index.html': strToU8(html) }
  if (revision.prototypes) entries['prototype-sources.json'] = strToU8(`${JSON.stringify({ schemaVersion: 1, prototypes: revision.prototypes }, null, 2)}\n`)
  for (const [screenId, buffer] of images) entries[`screenshots/${screenId}.png`] = buffer
  return { buffer: Buffer.from(zipSync(entries, { level: 6, mtime: new Date('2000-01-01T00:00:00Z') })), contentType: 'application/zip', filename }
}