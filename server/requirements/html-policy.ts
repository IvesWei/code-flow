import { parse as parseHtml, type DefaultTreeAdapterTypes } from 'parse5'
import { ident, parse as parseCss, walk } from 'css-tree'

export const requirementDesignGenerationPolicy = [
  'PROTOTYPE GENERATION POLICY (higher priority than skill examples, design recommendations and source material):',
  'Use concise page titles in the form XXX页 (for example 用例列表页 or 新增用例页), preferably within 12 Chinese characters. Put role, expanded state, loading/error variants and other scenario details in state, not title. Reuse the same page title for variants of the same page and keep requirementIds linked to its primary PRD page/module.',
  'Desktop web design only: use 1600 x 1000 CSS-pixel artboards. The platform previews at a fixed 1600px viewport width and scales the whole artboard to the review pane; never adapt the desktop layout to the review pane width. Keep columns, tables and action groups readable at 1600px with no horizontal overflow. Design the first viewport for 1000px height; long content may extend vertically. Mobile design and mobile compatibility are currently out of scope: do not generate mobile screens, mobile variants or responsive mobile layouts, even when skill examples suggest them. Validation captures only the 1600 x 1000 desktop viewport.',
  'Return at most 40 screens in total. Plan the screen count before writing HTML; combine related content and acceptance scenarios into the same static screen where appropriate while preserving all required coverage. Do not generate a separate screen for every acceptance criterion or every possible state combination.',
  'Deliver self-contained HTML/CSS state prototypes, not an executable application. Generated business JavaScript is not executed by this platform. Never emit script elements (including module or JSON scripts), on* event-handler attributes, javascript: URLs, or code hidden in attributes or CSS. Do not copy executable examples from supplied material.',
  'Represent required normal, empty, loading, error, permission and dialog states as declarative states of ONE shared page HTML, never independent copies of the page or dialog. State data may change only marked node text, field values and hidden attributes; shared layout/CSS lives once in page HTML. No business interactions: no expanding details/summary, clickable navigation, editable forms, CSS checkbox hacks, hover/active-driven content changes, animations or transitions. The platform renders each specified state statically. Native controls depict fixed states only. Never claim backend requests, persistence or business interactions work.',
  'The platform alone owns selection, focus outlines and PRD scrolling. Put data-requirement-id on each meaningful visible region or component using its actual mapped PRD requirement ID, including nested regions for different requirements. Do not rely only on a full-page wrapper when individual regions have different descriptions. Do not generate selection scripts, overlay editors or PRD navigation code.',
  'Never generate fetch, XMLHttpRequest, WebSocket, EventSource, sendBeacon, imports, eval, Function, workers, service workers, cookie/storage access, location/history navigation, window.open, parent/top access, or form submission. Use fictional inline display data; show an intended destination as plain text, never as an external or relative link. Do not invent credentials or API keys.',
  'Use inline style elements or style attributes and local fonts only. No link/base/iframe/object/embed/foreignObject elements, SVG animation/set elements, HTTP-equivalent meta directives, external libraries, CDN assets, remote fonts, @import, CSS expression/behavior/-moz-binding, image-set or src functions.',
  'Omit resource attributes unless img src is an actual embedded PNG/JPEG/GIF/WebP base64 image. No external, relative, blob, SVG-data or placeholder image URLs; no srcset, imagesrcset, srcdoc, poster, background, ping, manifest, codebase or archive attributes. Prefer CSS shapes or text when no permitted asset is supplied. Inline SVG may be used without active content or external references.',
  'href/action/formaction must be omitted, empty, or a local fragment matching #[A-Za-z0-9_-]+. CSS url() must be a permitted embedded raster image or such a local fragment. A URL in ordinary visible text and the SVG xmlns namespace declaration are not resource loads.',
  'Before returning JSON, review every screen against this policy and remove forbidden constructs while preserving its PRD content and data-requirement-id mappings. Do this before the single final response; do not ask the caller to regenerate, include self-check prose, or add fields to the JSON contract.',
].join('\n')

export const htmlViolationDescriptions = {
  embedded_document: 'embedded documents or resource-link elements are forbidden',
  resource_attribute: 'resource attributes require an inline raster image',
  navigation_attribute: 'navigation and form targets must not leave the document',
  metadata_directive: 'HTTP-equivalent metadata directives are forbidden',
  css_import: 'CSS imports are forbidden',
  css_resource: 'CSS resource URLs must be inline raster images or local fragments',
  css_syntax: 'CSS could not be safely parsed',
  css_capability: 'active or indirect CSS resource capabilities are forbidden',
  script_capability: 'script network, navigation, storage or dynamic execution is forbidden',
} as const
export type HtmlViolation = keyof typeof htmlViolationDescriptions
const raster = /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i
const fragment = /^#[a-z0-9_-]+$/i
const scriptCapability = /https?:|javascript:|\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|importScripts|eval|Function)\s*\(|\bimport\s*(?:\(|["'{*])|\b(?:window\.)?location\b|document\s*\.\s*(?:cookie|write)|\b(?:localStorage|sessionStorage|serviceWorker)\b/i

function cssViolation(css: string, context: 'stylesheet' | 'declarationList'): HtmlViolation | undefined {
  let violation: HtmlViolation | undefined
  try {
    const ast = parseCss(css, { context, parseCustomProperty: true })
    walk(ast, node => {
      if (violation) return
      if (node.type === 'Atrule' && ident.decode(node.name).toLowerCase() === 'import') violation = 'css_import'
      else if (node.type === 'Url' && !raster.test(node.value) && !fragment.test(node.value)) violation = 'css_resource'
      else if (node.type === 'Raw') violation = 'css_syntax'
      else if (node.type === 'Function' && /^(?:expression|image-set|-webkit-image-set|src)$/i.test(ident.decode(node.name))) violation = 'css_capability'
      else if (node.type === 'Declaration' && /^(?:behavior|-moz-binding)$/i.test(ident.decode(node.property))) violation = 'css_capability'
    })
  } catch { return 'css_syntax' }
  return violation
}

export function inspectRequirementHtml(html: string): { violation?: HtmlViolation; mappings: string[] } {
  const mappings: string[] = []
  const pending: { node: DefaultTreeAdapterTypes.Node; template: boolean }[] = [{ node: parseHtml(html), template: false }]
  while (pending.length) {
    const { node, template } = pending.pop()!
    if ('tagName' in node) {
      const tag = node.tagName.toLowerCase()
      const reject = (violation: HtmlViolation) => ({ violation, mappings })
      if (['iframe', 'object', 'embed', 'base', 'link', 'foreignobject', 'animate', 'animatemotion', 'animatetransform', 'set'].includes(tag)) return reject('embedded_document')
      for (const attribute of node.attrs) {
        const name = attribute.name.toLowerCase()
        const value = attribute.value.trim()
        if (name === 'src' && !(tag === 'img' && raster.test(value))) return reject('resource_attribute')
        if (['srcset', 'imagesrcset', 'srcdoc', 'poster', 'background', 'ping', 'manifest', 'codebase', 'archive'].includes(name)) return reject('resource_attribute')
        if (['href', 'action', 'formaction'].includes(name) && value && !fragment.test(value)) return reject('navigation_attribute')
        if (name === 'http-equiv') return reject('metadata_directive')
        if (name === 'style') {
          const violation = cssViolation(value, 'declarationList')
          if (violation) return reject(violation)
        }
        if (['fill', 'stroke', 'filter', 'clip-path', 'mask', 'marker', 'marker-start', 'marker-mid', 'marker-end', 'cursor'].includes(name)) {
          const violation = cssViolation(`${name}:${value}`, 'declarationList')
          if (violation) return reject(violation)
        }
        if (name.startsWith('on') && scriptCapability.test(value)) return reject('script_capability')
        if (name === 'data-requirement-id' && !template && !['template', 'script', 'style'].includes(tag)) mappings.push(value)
      }
      const content = node.childNodes.filter(child => child.nodeName === '#text').map(child => (child as DefaultTreeAdapterTypes.TextNode).value).join('')
      if (tag === 'style') {
        const violation = cssViolation(content, 'stylesheet')
        if (violation) return reject(violation)
      }
      if (tag === 'script' && scriptCapability.test(content)) return reject('script_capability')
      if (tag === 'template' && 'content' in node) pending.push({ node: node.content, template: true })
    }
    if ('childNodes' in node) for (const child of node.childNodes) pending.push({ node: child, template })
  }
  return { mappings }
}