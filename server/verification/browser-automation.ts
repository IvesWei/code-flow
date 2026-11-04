import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, type Locator, type Page, type Request } from 'playwright-core'
import type { AutomationRun, SelfTestCase } from '../../shared/task.js'
import { executionEnvironment } from '../execution/execution-environment.js'

export const browserProtocolVersion = 'browser-v4'
export const browserLimits = Object.freeze({ maxSteps: 60, maxSelectorLength: 250, maxValueLength: 1000, maxPathLength: 251, maxRequiredCapabilities: 20, actionTimeoutMs: 10_000, navigationTimeoutMs: 20_000, executionTimeoutMs: 120_000, minViewportSize: 240, maxViewportSize: 2560, maxObservationMs: 3000, maxTotalObservationMs: 30_000, minZeroObservationMs: 100, maxRequestCount: 10_000, maxGeometryMagnitude: 1_000_000, maxGeometryTolerance: 100, maxElementCount: 10_000, maxGeometrySnapshots: 20 })
export const browserPressKeys = ['Tab', 'Shift+Tab', 'Enter', 'Space', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'] as const
export const browserAssertionAttributes = ['id', 'role', 'title', 'aria-label', 'aria-expanded', 'aria-checked', 'aria-selected', 'aria-disabled', 'aria-hidden', 'data-testid', 'aria-controls', 'aria-invalid', 'aria-describedby', 'autocomplete', 'type', 'src', 'alt'] as const
export const browserGeometryMetrics = ['width', 'height', 'x', 'y', 'top', 'right', 'bottom', 'left', 'scrollWidth', 'clientWidth', 'scrollHeight', 'clientHeight'] as const
export const browserStyleProperties = ['color', 'background-color', 'border-color', 'border-width', 'border-style', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style', 'border-radius', 'font-family', 'font-size', 'font-weight', 'display', 'visibility', 'overflow', 'overflow-x', 'overflow-y', 'position', 'opacity', 'text-align'] as const
export const browserRequestMethods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const
export const browserBlockedReasonCodes = ['capability', 'environment', 'authorization', 'manual', 'unknown'] as const
export type BrowserBlockedReasonCode = typeof browserBlockedReasonCodes[number]
type GeometryBounds = { min?: number; max?: number; tolerance?: number }
type GeometryMetric = typeof browserGeometryMetrics[number]
type GeometryOperation = 'ratio' | 'difference'
export type BrowserStep =
  | { action: 'click' | 'clear' | 'focus' | 'hover' | 'assertVisible' | 'assertHidden' | 'assertEnabled' | 'assertDisabled' | 'assertFocused'; selector: string }
  | { action: 'fill' | 'assertText' | 'assertTextExact' | 'assertValue'; selector: string; value: string }
  | { action: 'assertCount'; selector: string; count: number }
  | { action: 'press'; selector: string; key: typeof browserPressKeys[number] }
  | { action: 'assertAttribute'; selector: string; attribute: typeof browserAssertionAttributes[number]; value: string }
  | { action: 'assertUrl'; value: string }
  | { action: 'assertGeometry'; selector: string; metric: typeof browserGeometryMetrics[number]; min?: number; max?: number; tolerance?: number }
  | ({ action: 'assertMetricComparison'; selector: string; metric: GeometryMetric; otherSelector: string; otherMetric: GeometryMetric; operation: GeometryOperation } & GeometryBounds)
  | { action: 'snapshotGeometry'; id: string; selector: string; metric: GeometryMetric }
  | ({ action: 'assertSnapshotComparison'; id: string; selector: string; metric: GeometryMetric; operation: GeometryOperation } & GeometryBounds)
  | { action: 'assertStyle'; selector: string; property: typeof browserStyleProperties[number]; value: string }
  | { action: 'assertImageLoaded' | 'assertNotObscured'; selector: string }
  | { action: 'assertNoOverlap'; selector: string; otherSelector: string }
  | { action: 'assertFontLoaded'; font: string }
  | { action: 'startNetworkObservation'; id: string; path: string; method: typeof browserRequestMethods[number] }
  | { action: 'assertRequestCount'; id: string; count: number; observationMs: number }
export type BrowserScript = { path: string; viewport?: { width: number; height: number }; steps: BrowserStep[] }
export type BrowserPlan = { kind: 'script'; script: BrowserScript } | { kind: 'blocked'; reason: string; reasonCode: BrowserBlockedReasonCode; requiredCapabilities?: string[] }
export type BrowserAutomationRun = AutomationRun & {
  failureCategory?: 'action' | 'assertion' | 'navigation' | 'browser' | 'policy'
  reasonCode?: BrowserBlockedReasonCode
}

const selectorActions = ['click', 'clear', 'focus', 'hover', 'assertVisible', 'assertHidden', 'assertEnabled', 'assertDisabled', 'assertFocused'] as const
export const browserCapabilities = [...selectorActions, 'fill', 'assertText', 'assertTextExact', 'assertCount', 'assertValue', 'press', 'assertAttribute', 'assertUrl', 'assertGeometry', 'assertMetricComparison', 'snapshotGeometry', 'assertSnapshotComparison', 'assertStyle', 'assertImageLoaded', 'assertFontLoaded', 'assertNotObscured', 'assertNoOverlap', 'startNetworkObservation', 'assertRequestCount'] as const
export const browserPlanInstructions = `Protocol ${browserProtocolVersion}. Return only JSON: {"path":"/","viewport":{"width":390,"height":800},"steps":[{"action":"assertVisible","selector":"h1"}]} or {"blocked":true,"reason":"specific reason","reasonCode":"capability|environment|authorization|manual|unknown","requiredCapabilities":["safe-capability-id"]}. Missing reasonCode means unknown; never infer capability support from prose.
Exact schemas (all fields required unless marked optional): ${selectorActions.join(', ')}: {action,selector}; fill/assertText/assertTextExact/assertValue: {action,selector,value}; press: {action,selector,key}; assertAttribute: {action,selector,attribute,value}; assertUrl: {action,value} (same-origin pathname, no query/hash). Keys: ${browserPressKeys.join(', ')}. Attributes: ${browserAssertionAttributes.join(', ')}. Attribute/value/pathname equality is exact; assertText matches visible text containing value; assertTextExact requires equality of visible text after BOTH actual and expected whitespace runs collapse to one space and edges trim. Both text expectations must be nonblank. src expected value must be a same-origin absolute pathname, no query/hash, credentials, data URLs or foreign URLs; actual attribute values are never included in output. Empty fill/assertValue/other assertAttribute values allowed. clear empties a field. Hidden includes absent elements. Steps target the first matching element EXCEPT assertCount, which counts ALL matches including hidden ones: {action,selector,count}, integer count 0..${browserLimits.maxElementCount}; absent selector matches count as zero. Metadata-only assertions (all except assertText/assertTextExact/assertValue) and geometry snapshots may inspect sensitive elements, never their text/values. click/fill/clear/focus/hover/press and text/value reads on sensitive fields remain forbidden. hover is a normal bounded Playwright hover using the action timeout; no custom duration, forced interaction or guarantee of native OS tooltips.
assertGeometry: {action,selector,metric,min?,max?,tolerance?}; metrics ${browserGeometryMetrics.join(', ')}; at least one finite min/max required in [-${browserLimits.maxGeometryMagnitude},${browserLimits.maxGeometryMagnitude}], min<=max; tolerance optional 0..${browserLimits.maxGeometryTolerance} default 0; inclusive min-tolerance <= actual <= max+tolerance. Rect metrics use getBoundingClientRect in viewport CSS pixels; scroll/client metrics use element dimensions. assertStyle: {action,selector,property,value}; properties ${browserStyleProperties.join(', ')}; exact computed CSS string equality (use computed rgb(), not equivalent hex). Safe values only: colors #hex/named black white red green blue transparent/currentcolor or comma-separated numeric rgb/rgba/hsl/hsla (RGB channels 0..255 or 0..100%, HSL hue -1000000..1000000 and saturation/lightness 0..100%, alpha 0..1 or 0..100%); border-radius 1..4 nonnegative px/% lengths; font-size px; lengths 0..1000000; font-weight normal/bold or 100..900; font-family <=200 characters, comma-separated bare/quoted ASCII names matching [A-Za-z][A-Za-z0-9 -]*; display none/block/inline/inline-block/flex/inline-flex/grid/inline-grid/contents/table/table-row/table-cell/list-item/flow-root; visibility visible/hidden/collapse; overflow[-x/-y] visible/hidden/clip/scroll/auto; position static/relative/absolute/fixed/sticky; opacity 0..1; text-align left/right/center/justify/start/end. No url(), var(), expressions, escapes, CSS injection or custom properties.
Border assertStyle values: border-color permits 1..4 safe colors from the color grammar; border-width permits 1..4 nonnegative px values <=${browserLimits.maxGeometryMagnitude}; border-style permits 1..4 of none/hidden/dotted/dashed/solid/double/groove/ridge/inset/outset. border-top/right/bottom/left-color/width/style accept ONE corresponding value. Exact computed strings only, including shorthand serialization; no CSS equivalence conversion.
assertMetricComparison: {action,selector,metric,otherSelector,otherMetric,operation,min?,max?,tolerance?}. snapshotGeometry: {action,id,selector,metric}. assertSnapshotComparison: {action,id,selector,metric,operation,min?,max?,tolerance?}. Metrics use the assertGeometry allowlist. operation is ratio (current metric / other or saved metric) or difference (current metric - other or saved metric). Comparison bounds follow assertGeometry exactly, including at least one min/max, finite bounds in [-${browserLimits.maxGeometryMagnitude},${browserLimits.maxGeometryMagnitude}], min<=max, tolerance 0..${browserLimits.maxGeometryTolerance} default 0; result must be finite. Every measured value must be finite with absolute value <=${browserLimits.maxGeometryMagnitude}; zero ratio denominator fails at runtime. Snapshot ids match [A-Za-z][A-Za-z0-9_-]{0,39}, unique in the snapshot namespace, maximum ${browserLimits.maxGeometrySnapshots}; comparisons require an EARLIER snapshot id (no unknown, forward or duplicate ids). Each snapshot saves exactly ONE numeric metric, immutable for ONE execution only; no text, values, DOM, secrets, persistence or cross-run state. Snapshot creation is NOT an assertion. All steps, including snapshots and hover, count toward the same ${browserLimits.maxSteps}-step budget. No user-defined JavaScript, formulas, nested endpoints or extra fields.
assertImageLoaded/assertNotObscured: {action,selector}. Image requires HTMLImageElement complete AND naturalWidth/naturalHeight>0 (broken images fail). NotObscured requires visible positive-size element, center inside viewport, and elementFromPoint at center returning it or a descendant; no scrolling or custom evaluation. assertFontLoaded: {action,font}; font <=120 characters is 1..200px followed by ONE bare/quoted ASCII family (e.g. 16px "FixtureFont"); requires a matching declared FontFace with status loaded AND document.fonts.check(font). Unknown or undeclared system fonts fail; no arbitrary JS or font injection. Screenshots mask input/textarea/contenteditable regions, including frames, and policy-blocked runs produce no screenshot.
assertNoOverlap: {action,selector,otherSelector}; both first matches must be visible with positive-size bounding rectangles in viewport CSS pixels; passes only when rectangles have no positive-area intersection (touching edges pass). No tolerance, scrolling or hidden-element shortcuts. This checks rectangle intersection, not visual pixel overlap; assertNotObscured separately checks the center hit target.
startNetworkObservation: {action,id,path,method}; id matches [A-Za-z][A-Za-z0-9_-]{0,39}, unique; path is an exact same-origin pathname without query/hash; methods ${browserRequestMethods.join(', ')}. Consecutive startNetworkObservation steps at the beginning are installed BEFORE initial page navigation; later starts are installed at that step before subsequent actions; no retroactive requests. assertRequestCount: {action,id,count,observationMs}; requires earlier observation id; count integer 0..${browserLimits.maxRequestCount}; observationMs integer 0..${browserLimits.maxObservationMs} and >=${browserLimits.minZeroObservationMs} when count=0. Sum of ALL observationMs in a plan must be <=${browserLimits.maxTotalObservationMs}ms. Wait the FULL observationMs starting at the assertion, then compare cumulative request attempts since start (including failed/aborted attempts); repeated assertions do not reset counts. Match origin+pathname+method only; queries ignored, never exposed; no bodies, query strings, headers, credentials, mocking, interception mutations, or network injection. Service workers disabled. Observation does not assert response success; traffic after the window is outside the assertion.
Limits: 1..${browserLimits.maxSteps} steps, selector ${browserLimits.maxSelectorLength}, value ${browserLimits.maxValueLength} characters; optional viewport requires integer width AND height ${browserLimits.minViewportSize}..${browserLimits.maxViewportSize}, default 1280x800. At least one assert action required. Unknown fields rejected at every level. Action timeout ${browserLimits.actionTimeoutMs}ms, navigation ${browserLimits.navigationTimeoutMs}ms, total execution ${browserLimits.executionTimeoutMs}ms including browser launch/evidence (excluding model generation); no unlimited waits. No credentials/authentication, authorization bypass, foreign traffic, arbitrary JavaScript, visual baseline comparisons or network injection. requiredCapabilities is optional, at most ${browserLimits.maxRequiredCapabilities} unique identifiers matching [A-Za-z][A-Za-z0-9_.:-]{0,79}.`

function finiteRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

function validGeometryBounds(bounds: Record<string, unknown>): boolean {
  return (bounds.min !== undefined || bounds.max !== undefined) && (bounds.min === undefined || finiteRange(bounds.min, -browserLimits.maxGeometryMagnitude, browserLimits.maxGeometryMagnitude)) && (bounds.max === undefined || finiteRange(bounds.max, -browserLimits.maxGeometryMagnitude, browserLimits.maxGeometryMagnitude)) && !(typeof bounds.min === 'number' && typeof bounds.max === 'number' && bounds.min > bounds.max) && (bounds.tolerance === undefined || finiteRange(bounds.tolerance, 0, browserLimits.maxGeometryTolerance))
}

function geometryBounds(bounds: Record<string, unknown>): GeometryBounds {
  return { ...(bounds.min === undefined ? {} : { min: bounds.min as number }), ...(bounds.max === undefined ? {} : { max: bounds.max as number }), ...(bounds.tolerance === undefined ? {} : { tolerance: bounds.tolerance as number }) }
}

function safeFamily(value: string): boolean {
  return value.length <= 200 && value.split(',').every((family) => /^(?:[A-Za-z][A-Za-z0-9 -]*|"[A-Za-z][A-Za-z0-9 -]*"|'[A-Za-z][A-Za-z0-9 -]*')$/.test(family.trim()))
}

function safeFont(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 120) return false
  const match = /^(\d+(?:\.\d+)?)px (.+)$/.exec(value)
  return !!match && finiteRange(Number(match[1]), 1, 200) && !match[2].includes(',') && safeFamily(match[2])
}

function safeStyle(property: string, value: string): boolean {
  if (/^border(?:-(?:top|right|bottom|left))?-color$/.test(property)) {
    if (safeStyle('color', value)) return true
    const colors = value.match(/(?:rgba?|hsla?)\([^()]*\)|\S+/gi) ?? []
    return property === 'border-color' && colors.length >= 1 && colors.length <= 4 && colors.join(' ') === value && colors.every((color) => safeStyle('color', color))
  }
  if (/^border(?:-(?:top|right|bottom|left))?-(?:width|style)$/.test(property)) {
    const parts = value.split(' ')
    return parts.length >= 1 && parts.length <= (property === 'border-width' || property === 'border-style' ? 4 : 1) && parts.every((part) => property.endsWith('-width') ? /^\d+(?:\.\d+)?px$/.test(part) && finiteRange(Number.parseFloat(part), 0, browserLimits.maxGeometryMagnitude) : /^(?:none|hidden|dotted|dashed|solid|double|groove|ridge|inset|outset)$/.test(part))
  }
  if (['color', 'background-color'].includes(property)) {
    if (/^(?:#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|black|white|red|green|blue|transparent|currentcolor)$/i.test(value)) return true
    const color = /^(rgb|rgba|hsl|hsla)\(([^()]+)\)$/i.exec(value)
    if (!color) return false
    const parts = color[2].split(',').map((part) => part.trim())
    const kind = color[1].toLowerCase()
    if (parts.length !== (kind.endsWith('a') ? 4 : 3)) return false
    return parts.every((part, index) => {
      if (!/^[+-]?\d+(?:\.\d+)?%?$/.test(part)) return false
      const percent = part.endsWith('%')
      const numeric = Number(percent ? part.slice(0, -1) : part)
      if (index === 3) return finiteRange(numeric, 0, percent ? 100 : 1)
      if (kind.startsWith('hsl')) return index === 0 ? !percent && finiteRange(numeric, -1_000_000, 1_000_000) : percent && finiteRange(numeric, 0, 100)
      return finiteRange(numeric, 0, percent ? 100 : 255)
    })
  }
  if (property === 'font-family') return safeFamily(value)
  if (property === 'border-radius') return /^(?:0|\d+(?:\.\d+)?(?:px|%))(?: (?:0|\d+(?:\.\d+)?(?:px|%))){0,3}$/.test(value) && value.split(' ').every((length) => finiteRange(Number.parseFloat(length), 0, 1_000_000))
  if (property === 'font-size') return /^\d+(?:\.\d+)?px$/.test(value) && finiteRange(Number.parseFloat(value), 0, 1_000_000)
  if (property === 'font-weight') return /^(?:normal|bold|[1-9]00)$/.test(value)
  if (property === 'opacity') return /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value)
  const enums: Record<string, readonly string[]> = {
    display: ['none', 'block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid', 'contents', 'table', 'table-row', 'table-cell', 'list-item', 'flow-root'],
    visibility: ['visible', 'hidden', 'collapse'], position: ['static', 'relative', 'absolute', 'fixed', 'sticky'],
    overflow: ['visible', 'hidden', 'clip', 'scroll', 'auto'], 'text-align': ['left', 'right', 'center', 'justify', 'start', 'end'],
  }
  return (enums[property.startsWith('overflow-') ? 'overflow' : property] ?? []).includes(value)
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function onlyFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).every((field) => fields.includes(field))
}

function pathname(value: unknown): value is string {
  return typeof value === 'string' && value.length <= browserLimits.maxPathLength && /^\/(?!\/)[^?#\\\s]*$/.test(value) && !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) && !/%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)
}

export function localPreviewUrl(input: string): string {
  const url = new URL(input)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new Error('浏览器预览地址只能是本机 HTTP 地址')
  }
  return url.origin
}

export function parseBrowserPlan(content: string): BrowserPlan {
  let parsed: unknown
  try { parsed = JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) }
  catch { throw new Error('脚本不是有效 JSON 对象') }
  if (!record(parsed)) throw new Error('自动化脚本不是 JSON 对象')
  if (parsed.blocked === true) {
    const { reason, requiredCapabilities } = parsed
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 1000) throw new Error('无法执行时需提供明确原因')
    const reasonCode = parsed.reasonCode === undefined ? 'unknown' : parsed.reasonCode
    if (!browserBlockedReasonCodes.some((code) => code === reasonCode) || !onlyFields(parsed, ['blocked', 'reason', 'reasonCode', 'requiredCapabilities'])) throw new Error('无效的 blocked 原因分类或未知字段')
    if (requiredCapabilities !== undefined && (!Array.isArray(requiredCapabilities) || requiredCapabilities.length > browserLimits.maxRequiredCapabilities || !requiredCapabilities.every((item) => typeof item === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(item)) || new Set(requiredCapabilities).size !== requiredCapabilities.length)) throw new Error('requiredCapabilities 需要安全的能力标识列表')
    const code = browserBlockedReasonCodes.find((item) => item === reasonCode)!
    return { kind: 'blocked', reason: reason.trim(), reasonCode: code, ...(requiredCapabilities === undefined ? {} : { requiredCapabilities }) }
  }
  const script = parsed
  if (!pathname(script.path)) throw new Error('脚本路径需要是本机站点内的路径')
  if (!Array.isArray(script.steps) || script.steps.length < 1 || script.steps.length > browserLimits.maxSteps) throw new Error(`脚本需要 1 至 ${browserLimits.maxSteps} 步`)
  if (!onlyFields(script, ['path', 'steps', 'viewport'])) throw new Error('脚本包含未知字段')
  let viewport: BrowserScript['viewport']
  if (script.viewport !== undefined) {
    const size = script.viewport
    if (!record(size) || !onlyFields(size, ['width', 'height']) || !finiteRange(size.width, browserLimits.minViewportSize, browserLimits.maxViewportSize) || !Number.isInteger(size.width) || !finiteRange(size.height, browserLimits.minViewportSize, browserLimits.maxViewportSize) || !Number.isInteger(size.height)) throw new Error('viewport 需要有界整数 width/height')
    viewport = { width: size.width, height: size.height }
  }
  const steps: BrowserStep[] = []
  const observations = new Set<string>()
  const snapshots = new Set<string>()
  let totalObservationMs = 0
  for (const [index, step] of script.steps.entries()) {
    const invalid: () => never = () => { throw new Error(`第 ${index + 1} 步缺少有效的操作、选择器、值或包含未知字段`) }
    if (!record(step) || !browserCapabilities.some((action) => action === step.action)) invalid()
    if (!record(step)) invalid()
    if (step.action === 'startNetworkObservation') {
      const method = browserRequestMethods.find((method) => method === step.method)
      if (!onlyFields(step, ['action', 'id', 'path', 'method']) || typeof step.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(step.id) || observations.has(step.id) || !pathname(step.path) || !method) invalid()
      observations.add(step.id)
      steps.push({ action: step.action, id: step.id, path: step.path, method })
      continue
    }
    if (step.action === 'assertRequestCount') {
      if (!onlyFields(step, ['action', 'id', 'count', 'observationMs']) || typeof step.id !== 'string' || !observations.has(step.id) || !finiteRange(step.count, 0, browserLimits.maxRequestCount) || !Number.isInteger(step.count) || !finiteRange(step.observationMs, step.count === 0 ? browserLimits.minZeroObservationMs : 0, browserLimits.maxObservationMs) || !Number.isInteger(step.observationMs)) invalid()
      totalObservationMs += step.observationMs
      if (totalObservationMs > browserLimits.maxTotalObservationMs) throw new Error('请求观察累计等待超过总预算')
      steps.push({ action: step.action, id: step.id, count: step.count, observationMs: step.observationMs })
      continue
    }
    if (step.action === 'assertFontLoaded') {
      if (!onlyFields(step, ['action', 'font']) || !safeFont(step.font)) invalid()
      steps.push({ action: step.action, font: step.font })
      continue
    }
    if (step.action === 'assertUrl') {
      if (!onlyFields(step, ['action', 'value'])) invalid()
      if (!pathname(step.value)) invalid()
      steps.push({ action: 'assertUrl', value: step.value })
      continue
    }
    if (typeof step.selector !== 'string' || !step.selector.trim() || step.selector.length > browserLimits.maxSelectorLength) invalid()
    const selector = step.selector
    if (step.action === 'assertCount') {
      if (!onlyFields(step, ['action', 'selector', 'count']) || !finiteRange(step.count, 0, browserLimits.maxElementCount) || !Number.isInteger(step.count)) invalid()
      steps.push({ action: step.action, selector, count: step.count })
      continue
    }
    if (step.action === 'snapshotGeometry' || step.action === 'assertSnapshotComparison' || step.action === 'assertMetricComparison') {
      const metric = browserGeometryMetrics.find((metric) => metric === step.metric)
      if (!metric) invalid()
      if (step.action === 'snapshotGeometry') {
        if (!onlyFields(step, ['action', 'id', 'selector', 'metric']) || typeof step.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(step.id) || snapshots.has(step.id) || snapshots.size >= browserLimits.maxGeometrySnapshots) invalid()
        snapshots.add(step.id)
        steps.push({ action: step.action, id: step.id, selector, metric })
        continue
      }
      if ((step.operation !== 'ratio' && step.operation !== 'difference') || !validGeometryBounds(step)) invalid()
      if (step.action === 'assertSnapshotComparison') {
        if (!onlyFields(step, ['action', 'id', 'selector', 'metric', 'operation', 'min', 'max', 'tolerance']) || typeof step.id !== 'string' || !snapshots.has(step.id)) invalid()
        steps.push({ action: step.action, id: step.id, selector, metric, operation: step.operation, ...geometryBounds(step) })
      } else {
        const otherMetric = browserGeometryMetrics.find((metric) => metric === step.otherMetric)
        if (!onlyFields(step, ['action', 'selector', 'metric', 'otherSelector', 'otherMetric', 'operation', 'min', 'max', 'tolerance']) || !otherMetric || typeof step.otherSelector !== 'string' || !step.otherSelector.trim() || step.otherSelector.length > browserLimits.maxSelectorLength) invalid()
        steps.push({ action: step.action, selector, metric, otherSelector: step.otherSelector, otherMetric, operation: step.operation, ...geometryBounds(step) })
      }
      continue
    }
    if (step.action === 'assertNoOverlap') {
      if (!onlyFields(step, ['action', 'selector', 'otherSelector']) || typeof step.otherSelector !== 'string' || !step.otherSelector.trim() || step.otherSelector.length > browserLimits.maxSelectorLength) invalid()
      steps.push({ action: step.action, selector, otherSelector: step.otherSelector })
      continue
    }
    if (step.action === 'assertGeometry') {
      const metric = browserGeometryMetrics.find((metric) => metric === step.metric)
      if (!onlyFields(step, ['action', 'selector', 'metric', 'min', 'max', 'tolerance']) || !metric || (step.min === undefined && step.max === undefined) || (step.min !== undefined && !finiteRange(step.min, -browserLimits.maxGeometryMagnitude, browserLimits.maxGeometryMagnitude)) || (step.max !== undefined && !finiteRange(step.max, -browserLimits.maxGeometryMagnitude, browserLimits.maxGeometryMagnitude)) || (typeof step.min === 'number' && typeof step.max === 'number' && step.min > step.max) || (step.tolerance !== undefined && !finiteRange(step.tolerance, 0, browserLimits.maxGeometryTolerance))) invalid()
      steps.push({ action: step.action, selector, metric, ...(step.min === undefined ? {} : { min: step.min as number }), ...(step.max === undefined ? {} : { max: step.max as number }), ...(step.tolerance === undefined ? {} : { tolerance: step.tolerance as number }) })
      continue
    }
    if (step.action === 'assertStyle') {
      const property = browserStyleProperties.find((property) => property === step.property)
      if (!onlyFields(step, ['action', 'selector', 'property', 'value']) || !property || typeof step.value !== 'string' || step.value.length > browserLimits.maxValueLength || !safeStyle(property, step.value)) invalid()
      steps.push({ action: step.action, selector, property, value: step.value })
      continue
    }
    const selectorAction = ([...selectorActions, 'assertImageLoaded', 'assertNotObscured'] as const).find((action) => action === step.action)
    if (selectorAction) {
      if (!onlyFields(step, ['action', 'selector'])) invalid()
      steps.push({ action: selectorAction, selector })
    } else if (step.action === 'press') {
      const key = browserPressKeys.find((key) => key === step.key)
      if (!onlyFields(step, ['action', 'selector', 'key']) || !key) invalid()
      steps.push({ action: 'press', selector, key })
    } else {
      if (!onlyFields(step, step.action === 'assertAttribute' ? ['action', 'selector', 'attribute', 'value'] : ['action', 'selector', 'value']) || typeof step.value !== 'string' || step.value.length > browserLimits.maxValueLength || ((step.action === 'assertText' || step.action === 'assertTextExact') && !step.value.trim())) invalid()
      const value = step.value
      if (step.action === 'assertAttribute') {
        const attribute = browserAssertionAttributes.find((attribute) => attribute === step.attribute)
        if (!attribute || (attribute === 'src' && !pathname(value))) invalid()
        steps.push({ action: 'assertAttribute', selector, attribute, value })
        } else if (step.action === 'fill' || step.action === 'assertText' || step.action === 'assertTextExact' || step.action === 'assertValue') {
        steps.push({ action: step.action, selector, value })
      } else invalid()
    }
  }
  if (!steps.some((step) => step.action.startsWith('assert'))) throw new Error('自动化脚本必须包含实际页面断言')
  return { kind: 'script', script: { path: script.path, ...(viewport ? { viewport } : {}), steps } }
}

export function parseBrowserScript(content: string): BrowserScript {
  const plan = parseBrowserPlan(content)
  if (plan.kind === 'blocked') throw new Error(`浏览器用例无法执行：${plan.reason}`)
  return plan.script
}

class BrowserPolicyError extends Error {}

async function guardSensitiveField(locator: Locator): Promise<void> {
  const sensitive = await locator.evaluate((element) => {
    const field = element.closest('input, textarea, [contenteditable]') ?? element
    const type = field.getAttribute('type') ?? ''
    const description = ['name', 'id', 'autocomplete', 'placeholder', 'aria-label'].map((attribute) => field.getAttribute(attribute) ?? '').join(' ')
    return /^(password|hidden)$/i.test(type) || /password|passwd|pwd|token|secret|credential|authorization|api[\s_-]*key|one[\s_-]*time[\s_-]*code|(?:^|\s)(?:otp|cc-[a-z-]+|cvv|cvc|username)(?:\s|$)/i.test(description)
  })
  if (sensitive) throw new BrowserPolicyError('安全策略禁止操作或读取密码、令牌及其他敏感字段；本执行器不接受凭据授权')
}

async function assertEventually(check: () => Promise<boolean>, executionDeadline: number): Promise<void> {
  const deadline = Math.min(executionDeadline, Date.now() + browserLimits.actionTimeoutMs)
  while (true) {
    if (await check()) {
      if (Date.now() >= executionDeadline) throw new Error('执行超时')
      return
    }
    if (Date.now() >= deadline) throw new Error('断言失败：页面状态不符合预期')
    await delay(50)
  }
}

type NetworkObservation = { path: string; method: string; count: number }

async function readGeometry(locator: Locator, metric: GeometryMetric): Promise<number> {
  const value = await locator.evaluate((element, metric) => {
    const rect = element.getBoundingClientRect()
    return metric in rect ? rect[metric as keyof DOMRect] : element[metric as 'scrollWidth' | 'clientWidth' | 'scrollHeight' | 'clientHeight']
  }, metric)
  if (!finiteRange(value, -browserLimits.maxGeometryMagnitude, browserLimits.maxGeometryMagnitude)) throw new Error('Geometry measurement outside bounds')
  return value
}

function compareGeometry(current: number, reference: number, operation: GeometryOperation, bounds: GeometryBounds): boolean {
  if (operation === 'ratio' && reference === 0) throw new Error('Zero geometry denominator')
  const actual = operation === 'ratio' ? current / reference : current - reference
  return Number.isFinite(actual) && (bounds.min === undefined || actual >= bounds.min - (bounds.tolerance ?? 0)) && (bounds.max === undefined || actual <= bounds.max + (bounds.tolerance ?? 0))
}

async function executeStep(page: Page, step: BrowserStep, origin: string, observations: Map<string, NetworkObservation>, snapshots: Map<string, number>, deadline: number): Promise<void> {
  const eventually = (check: () => Promise<boolean>) => assertEventually(check, deadline)
  if (step.action === 'startNetworkObservation') {
    observations.set(step.id, { path: step.path, method: step.method, count: 0 })
    return
  }
  if (step.action === 'assertRequestCount') {
    if (Date.now() + step.observationMs >= deadline) throw new Error('执行超时')
    await delay(step.observationMs)
    if (observations.get(step.id)?.count !== step.count) throw new Error('请求次数不符合预期')
    return
  }
  if (step.action === 'assertFontLoaded') {
    await eventually(() => page.evaluate((font) => {
      const family = font.replace(/^\d+(?:\.\d+)?px /, '').replace(/^["']|["']$/g, '').toLowerCase()
      return Array.from(document.fonts).some((face) => face.family.replace(/^["']|["']$/g, '').toLowerCase() === family && face.status === 'loaded') && document.fonts.check(font)
    }, step.font))
    return
  }
  if (step.action === 'assertUrl') {
    await eventually(async () => {
      const current = new URL(page.url())
      return current.origin === origin && current.pathname === step.value
    })
    return
  }
  if (step.action === 'assertCount') {
    await eventually(async () => await page.locator(step.selector).count() === step.count)
    return
  }
  const locator = page.locator(step.selector).first()
  if (step.action === 'assertHidden') {
    await locator.waitFor({ state: 'hidden' })
    return
  }
  await locator.waitFor({ state: 'attached' })
  if (step.action === 'snapshotGeometry') {
    snapshots.set(step.id, await readGeometry(locator, step.metric))
    return
  }
  if (step.action === 'assertMetricComparison' || step.action === 'assertSnapshotComparison') {
    await eventually(async () => {
      const current = await readGeometry(locator, step.metric)
      let reference: number | undefined
      if (step.action === 'assertMetricComparison') {
        const other = page.locator(step.otherSelector).first()
        await other.waitFor({ state: 'attached' })
        reference = await readGeometry(other, step.otherMetric)
      } else reference = snapshots.get(step.id)
      if (reference === undefined) throw new Error('Missing geometry snapshot')
      return compareGeometry(current, reference, step.operation, step)
    })
    return
  }
  if (['click', 'fill', 'clear', 'focus', 'hover', 'press', 'assertText', 'assertTextExact', 'assertValue'].includes(step.action)) await guardSensitiveField(locator)
  switch (step.action) {
    case 'click': await locator.click(); break
    case 'hover': await locator.hover(); break
    case 'fill': await locator.fill(step.value); break
    case 'clear': await locator.fill(''); break
    case 'focus': await locator.focus(); break
    case 'press': {
      const focused = page.locator(':focus').first()
      if (await focused.count()) await guardSensitiveField(focused)
      await locator.press(step.key)
      break
    }
    case 'assertText':
    case 'assertTextExact': await eventually(async () => {
      if (!await locator.isVisible()) return false
      await guardSensitiveField(locator)
      const text = await locator.evaluate((element) => {
        if (element instanceof HTMLElement) return element.innerText
        const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        let text = ''
        while (walker.nextNode()) {
          let parent: Element | null = walker.currentNode.parentElement
          let visible = true
          while (parent) {
            const style = parent.ownerDocument.defaultView!.getComputedStyle(parent)
            if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') { visible = false; break }
            if (parent === element) break
            parent = parent.parentElement
          }
          if (visible) text += walker.currentNode.textContent ?? ''
        }
        return text
      })
      const actual = text.replace(/\s+/g, ' ').trim()
      const expected = step.value.replace(/\s+/g, ' ').trim()
      return step.action === 'assertTextExact' ? actual === expected : actual.includes(expected)
    }); break
    case 'assertVisible': await locator.waitFor({ state: 'visible' }); break
    case 'assertEnabled': await eventually(() => locator.isEnabled()); break
    case 'assertDisabled': await eventually(() => locator.isDisabled()); break
    case 'assertFocused': await eventually(() => locator.evaluate((element) => element === element.ownerDocument.activeElement)); break
    case 'assertValue': await eventually(async () => {
      await guardSensitiveField(locator)
      return await locator.inputValue() === step.value
    }); break
    case 'assertAttribute': await eventually(async () => {
      return await locator.getAttribute(step.attribute) === step.value
    }); break
    case 'assertGeometry': await eventually(() => locator.evaluate((element, bounds) => {
      const rect = element.getBoundingClientRect()
      const actual = bounds.metric in rect ? rect[bounds.metric as keyof DOMRect] : element[bounds.metric as 'scrollWidth' | 'clientWidth' | 'scrollHeight' | 'clientHeight']
      return typeof actual === 'number' && Number.isFinite(actual) && (bounds.min === undefined || actual >= bounds.min - (bounds.tolerance ?? 0)) && (bounds.max === undefined || actual <= bounds.max + (bounds.tolerance ?? 0))
    }, step)); break
    case 'assertStyle': await eventually(() => locator.evaluate((element, expected) => element.ownerDocument.defaultView!.getComputedStyle(element).getPropertyValue(expected.property) === expected.value, step)); break
    case 'assertImageLoaded': await eventually(() => locator.evaluate((element) => element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0 && element.naturalHeight > 0)); break
    case 'assertNoOverlap': await eventually(async () => {
      const other = page.locator(step.otherSelector).first()
      if (!await locator.isVisible() || !await other.isVisible()) return false
      const firstBox = await locator.boundingBox()
      const otherBox = await other.boundingBox()
      return !!firstBox && !!otherBox && firstBox.width > 0 && firstBox.height > 0 && otherBox.width > 0 && otherBox.height > 0 && (firstBox.x + firstBox.width <= otherBox.x || otherBox.x + otherBox.width <= firstBox.x || firstBox.y + firstBox.height <= otherBox.y || otherBox.y + otherBox.height <= firstBox.y)
    }); break
    case 'assertNotObscured': await eventually(async () => await locator.isVisible() && await locator.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      const centerX = rect.x + rect.width / 2
      const centerY = rect.y + rect.height / 2
      const view = element.ownerDocument.defaultView!
      if (rect.width <= 0 || rect.height <= 0 || centerX < 0 || centerY < 0 || centerX >= view.innerWidth || centerY >= view.innerHeight) return false
      const hit = element.ownerDocument.elementFromPoint(centerX, centerY)
      return hit !== null && (hit === element || element.contains(hit))
    })); break
  }
}

export async function executeBrowserScript(url: string, content: string, testCase: SelfTestCase, directory: string): Promise<BrowserAutomationRun> {
  const script = parseBrowserScript(content)
  const origin = localPreviewUrl(url)
  const destination = new URL(script.path, origin)
  if (destination.origin !== origin) throw new Error('脚本不得跳转到其他站点')
  const startedAt = new Date().toISOString()
  const screenshot = `${testCase.id}-${randomUUID()}.png`
  const run: BrowserAutomationRun = { caseId: testCase.id, status: 'running', script: JSON.stringify(script, null, 2), protocolVersion: browserProtocolVersion, startedAt }
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  const deadline = Date.now() + browserLimits.executionTimeoutMs
  let expired = false
  const timer = setTimeout(() => {
    expired = true
    void browser?.close().catch(() => undefined)
  }, browserLimits.executionTimeoutMs)
  const remaining = (limit: number) => {
    const budget = Math.min(limit, deadline - Date.now())
    if (budget <= 0 || expired) throw new Error('浏览器执行超过总时限')
    return budget
  }
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true, env: executionEnvironment(), timeout: remaining(browserLimits.executionTimeoutMs) })
    remaining(browserLimits.executionTimeoutMs)
    const context = await browser.newContext({ viewport: script.viewport ?? { width: 1280, height: 800 }, permissions: [], serviceWorkers: 'block' })
    let foreignNavigation = false
    await context.route('**/*', (route) => {
      if (new URL(route.request().url()).origin === origin) return route.continue()
      if (route.request().isNavigationRequest()) foreignNavigation = true
      return route.abort()
    })
    const page = await context.newPage()
    const observations = new Map<string, NetworkObservation>()
    const snapshots = new Map<string, number>()
    const observe = (request: Request) => {
      const target = new URL(request.url())
      if (target.origin !== origin) return
      for (const observation of observations.values()) {
        if (target.pathname === observation.path && request.method() === observation.method) observation.count++
      }
    }
    context.on('request', observe)
    let completed = 0
    let navigationComplete = false
    try {
      while (script.steps[completed]?.action === 'startNetworkObservation') {
        await executeStep(page, script.steps[completed], origin, observations, snapshots, deadline)
        completed++
      }
      await page.goto(destination.href, { waitUntil: 'domcontentloaded', timeout: remaining(browserLimits.navigationTimeoutMs) })
      navigationComplete = true
      for (const step of script.steps.slice(completed)) {
        if (foreignNavigation || new URL(page.url()).origin !== origin) throw new Error('禁止跨站导航')
        page.setDefaultTimeout(remaining(browserLimits.actionTimeoutMs))
        await executeStep(page, step, origin, observations, snapshots, deadline)
        remaining(browserLimits.executionTimeoutMs)
        if (foreignNavigation || new URL(page.url()).origin !== origin) throw new Error('禁止跨站导航')
        completed++
      }
      run.status = 'passed'
      run.output = `已执行 ${completed}/${script.steps.length} 步，页面断言通过`
    } catch (error) {
      const policy = error instanceof BrowserPolicyError
      const assertion = script.steps[completed]?.action.startsWith('assert')
      run.status = policy ? 'blocked' : 'failed'
      run.failureKind = !navigationComplete || foreignNavigation ? 'navigation' : 'step'
      run.failureCategory = policy ? 'policy' : run.failureKind === 'navigation' ? 'navigation' : assertion ? 'assertion' : 'action'
      if (policy) run.reasonCode = 'authorization'
      const message = policy ? error.message : run.failureCategory === 'assertion' ? '断言失败：页面状态不符合预期' : run.failureCategory === 'navigation' ? '页面加载失败或禁止跨站导航' : '页面操作失败'
      run.output = `${navigationComplete ? `第 ${completed + 1} 步（${script.steps[completed]?.action}）失败，已完成 ${completed}/${script.steps.length} 步` : `页面加载失败（${destination.pathname}）`}：${message}`
    }
    if (run.failureCategory !== 'policy' && !expired) {
      await mkdir(directory, { recursive: true })
      try {
        await page.screenshot({ path: join(directory, screenshot), fullPage: true, mask: page.frames().map((frame) => frame.locator('input, textarea, [contenteditable]')), timeout: remaining(browserLimits.actionTimeoutMs) })
        run.screenshot = screenshot
      } catch {
        run.output += '；截图失败'
      }
    }
    context.off('request', observe)
    observations.clear()
    snapshots.clear()
    remaining(browserLimits.executionTimeoutMs)
    await context.close()
    remaining(browserLimits.executionTimeoutMs)
  } catch (error) {
    run.status = 'failed'
    run.failureKind = 'browser'
    run.failureCategory = 'browser'
    run.output = `浏览器启动失败：${error instanceof Error ? error.message : String(error)}`.slice(0, 4000)
  } finally {
    clearTimeout(timer)
    await browser?.close()
    run.finishedAt = new Date().toISOString()
  }
  return run
}

export async function generateBrowserPlan(generate: (feedback?: string) => Promise<string | undefined>): Promise<{ content: string; plan: BrowserPlan }> {
  let feedback: string | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    const content = await generate(feedback)
    if (!content) throw new Error('Copilot 没有返回浏览器脚本')
    try { return { content, plan: parseBrowserPlan(content) } }
    catch (error) {
      feedback = error instanceof Error ? error.message : String(error)
      if (attempt === 1) throw new Error(`浏览器脚本格式错误（已修正一次）：${feedback}`)
    }
  }
  throw new Error('浏览器脚本格式错误')
}