import { parse, serialize, type DefaultTreeAdapterTypes } from 'parse5'
import type { RequirementPrototype, RequirementRevision, RequirementScreen, StructuredPrd } from '../../shared/requirements.js'
import { prdFunctionCode } from '../../shared/prd-template.js'
import { jsonDigest } from '../storage/json-digest.js'
import { inspectRequirementHtml } from './html-policy.js'
import { RequirementOutputError, validatePrototypeCapture, validateScreens } from './validation.js'

const documentNodeTags = ['html', 'head', 'style', 'script', 'template', 'meta', 'title', 'link', 'base']
export const prototypeNodePolicy = `STATE NODE ELEMENT POLICY: data-prototype-node markers may target only eligible HTML elements such as main, section, div, span, p, input or textarea. Never attach these markers to ${documentNodeTags.join(', ')}, or to SVG/MathML and other non-HTML namespace elements. Static inline SVG is still permitted by the HTML safety policy; to change its visibility, wrap the static SVG in a regular HTML div and place the marker on that wrapper. Keep changing text on HTML leaf elements, not SVG text/tspan. Modify shared CSS directly in the shared HTML, never mark style elements as state nodes.`

function reject(rule = 'invalid shared prototype or state definition'): never { throw new RequirementOutputError(rule) }
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) reject('object expected')
  const result = value as Record<string, unknown>
  if (Object.keys(result).some(key => !keys.includes(key))) reject('shared prototype contains unexpected fields')
  return result
}
function string(value: unknown, maximum: number, empty = false): string {
  if (typeof value !== 'string' || value.length > maximum || (!empty && !value.trim()) || value.includes('\0')) reject('invalid text')
  return value
}
function identifier(value: unknown): string {
  const result = string(value, 80)
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(result) || ['constructor', 'prototype', '__proto__'].includes(result)) reject('invalid id')
  return result
}
function list(value: unknown, maximum: number, minimum = 0): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum || Array.from({ length: value.length }, (_, index) => !Object.hasOwn(value, index)).some(Boolean)) reject('invalid array size')
  return value
}
function references(value: unknown): string[] {
  const result = list(value, 500, 1).map(identifier)
  if (new Set(result).size !== result.length) reject('duplicate id or reference')
  return result
}
function nodes(document: DefaultTreeAdapterTypes.Node) {
  const result = new Map<string, DefaultTreeAdapterTypes.Element>()
  const pending = [document]
  while (pending.length) {
    const node = pending.pop()!
    if ('tagName' in node) {
      if (node.tagName === 'script' || node.attrs.some(attribute => /^on/i.test(attribute.name))) reject('unsafe prototype script or event handler')
      const target = node.attrs.find(attribute => attribute.name === 'data-prototype-node')?.value
      if (target) {
        identifier(target)
        if (result.has(target)) reject('duplicate prototype node')
        if (documentNodeTags.includes(node.tagName) || node.namespaceURI !== 'http://www.w3.org/1999/xhtml') reject('invalid prototype node element')
        result.set(target, node)
      }
    }
    if ('childNodes' in node) pending.push(...node.childNodes)
  }
  return result
}
export function validatePrototypeDesign(value: unknown, prd: StructuredPrd, unchanged: RequirementScreen[] = []): { prototypes: RequirementPrototype[]; screens: RequirementScreen[] } {
  const hasVisualRequirements = prd.requirements.some(requirement => !requirement.nonVisualReason)
  if (Array.isArray(value) && value.length === 0 && hasVisualRequirements) reject('empty prototypes array')
  const knownRequirementIds = new Set(prd.requirements.map(item => item.id))
  const knownAcceptanceIds = new Set(prd.requirements.flatMap(item => item.acceptance.map(criterion => criterion.id)))
  const requirementAliases = new Map<string, string>()
  const acceptanceAliases = new Map<string, string>()
  if (prd.templateVersion === 2) {
    for (const [index, requirement] of prd.requirements.entries()) {
      const code = prdFunctionCode(index)
      if (!knownRequirementIds.has(code)) requirementAliases.set(code, requirement.id)
      for (const criterion of requirement.specification?.criteria ?? []) {
        if (criterion.id && criterion.acceptanceId && !knownAcceptanceIds.has(criterion.id)) acceptanceAliases.set(criterion.id, criterion.acceptanceId)
      }
    }
  }
  const prototypes = list(value, 40, hasVisualRequirements ? 1 : 0).map(entry => {
    const source = record(entry, ['id', 'title', 'mode', 'sourceAnchor', 'html', 'states'])
    const mode = source.mode === undefined ? undefined : string(source.mode, 20)
    if (mode !== undefined && mode !== 'incremental' && mode !== 'redesign') reject('invalid prototype mode')
    let sourceAnchor: RequirementPrototype['sourceAnchor']
    if (source.sourceAnchor !== undefined) {
      const anchor = record(source.sourceAnchor, ['route', 'layout', 'pageFile'])
      sourceAnchor = { route: string(anchor.route, 240), layout: string(anchor.layout, 240), pageFile: string(anchor.pageFile, 240) }
    } else if (mode === 'incremental') reject('incremental prototype requires sourceAnchor')
    const rawHtml = string(source.html, 300000)
    if (!/^\s*<!doctype html>/i.test(rawHtml) || !/<html[\s>]/i.test(rawHtml) || !/<body[\s>]/i.test(rawHtml) || !/<\/html>\s*$/i.test(rawHtml)) reject('standalone HTML required')
    const parsedDocument = parse(rawHtml)
    let aliasRewritten = false
    if (requirementAliases.size || acceptanceAliases.size) {
      const stack: DefaultTreeAdapterTypes.Node[] = [parsedDocument]
      while (stack.length) {
        const node = stack.pop()!
        if ('tagName' in node) {
          for (const attribute of node.attrs) {
            const aliases = /^data-requirement-ids?$/.test(attribute.name) ? requirementAliases : /^data-acceptance-ids?$/.test(attribute.name) ? acceptanceAliases : undefined
            if (!aliases?.size) continue
            let updated = false
            const mapped = [...new Set(attribute.value.trim().split(/\s+/).filter(Boolean).map(token => {
              const canonical = aliases.get(token)
              if (canonical) { updated = true; return canonical }
              return token
            }))]
            if (updated) { attribute.value = mapped.join(' '); aliasRewritten = true }
          }
        }
        if ('childNodes' in node) stack.push(...node.childNodes)
      }
    }
    const html = aliasRewritten ? serialize(parsedDocument) : rawHtml
    const inspection = inspectRequirementHtml(html)
    if (inspection.violation) throw new RequirementOutputError('external or unsafe HTML capability', inspection.violation)
    const targets = nodes(parsedDocument)
    const states = list(source.states, 40, 1).map(entry => {
      const state = record(entry, ['id', 'name', 'proves', 'capture', 'requirementIds', 'acceptanceIds', 'changes'])
      const changes = list(state.changes, 200).map(entry => {
        const change = record(entry, ['node', 'text', 'value', 'hidden'])
        const node = identifier(change.node)
        const target = targets.get(node)
        if (!target) reject('prototype change target missing')
        if (Object.keys(change).length < 2) reject('prototype change has no operation')
        const text = change.text === undefined ? undefined : string(change.text, 12000, true)
        const value = change.value === undefined ? undefined : string(change.value, 12000, true)
        if (text !== undefined && (value !== undefined || target.childNodes.some(child => 'tagName' in child) || ['input', 'textarea', 'select', 'img', 'br', 'hr'].includes(target.tagName))) reject('prototype text change requires a leaf text element')
        if (value !== undefined && !['input', 'textarea'].includes(target.tagName)) reject('prototype value change requires input or textarea')
        if (value !== undefined && target.tagName === 'input' && ['password', 'file', 'hidden', 'checkbox', 'radio', 'submit', 'button', 'image'].includes(target.attrs.find(attribute => attribute.name === 'type')?.value.toLowerCase() || 'text')) reject('unsafe prototype value target')
        if (change.hidden !== undefined && typeof change.hidden !== 'boolean') reject('prototype hidden change requires boolean')
        return { node, ...(text === undefined ? {} : { text }), ...(value === undefined ? {} : { value }), ...(change.hidden === undefined ? {} : { hidden: change.hidden as boolean }) }
      })
      if (new Set(changes.map(change => change.node)).size !== changes.length) reject('duplicate prototype change target')
      const capture = state.capture === undefined ? undefined : validatePrototypeCapture(state.capture)
      const requirementIds = [...new Set(references(state.requirementIds).map(id => requirementAliases.get(id) ?? id))]
      const acceptanceIds = [...new Set(references(state.acceptanceIds).map(id => acceptanceAliases.get(id) ?? id))]
      return {
        id: identifier(state.id),
        name: string(state.name, 300),
        ...(state.proves === undefined ? {} : { proves: string(state.proves, 500) }),
        ...(capture ? { capture } : {}),
        requirementIds,
        acceptanceIds,
        changes,
      }
    })
    if (new Set(states.map(state => state.name)).size !== states.length) reject('duplicate prototype state name')
    return {
      id: identifier(source.id),
      title: string(source.title, 300),
      ...(mode ? { mode: mode as RequirementPrototype['mode'] } : {}),
      ...(sourceAnchor ? { sourceAnchor } : {}),
      html,
      states,
    }
  })
  if (new Set(prototypes.map(prototype => prototype.id)).size !== prototypes.length || new Set(prototypes.map(prototype => prototype.title)).size !== prototypes.length) reject('duplicate prototype id or title')
  if (prototypes.reduce((count, prototype) => count + prototype.states.length, 0) > 40) reject('design screen limit exceeded (maximum 40)')
  if (JSON.stringify(prototypes).length > 3000000) reject('screens too large')
  const rendered = prototypes.flatMap(prototype => prototype.states.map(state => {
    const document = parse(prototype.html)
    const targets = nodes(document)
    for (const change of state.changes) {
      const target = targets.get(change.node)!
      if (change.text !== undefined || (change.value !== undefined && target.tagName === 'textarea')) target.childNodes = [{ nodeName: '#text', value: change.text ?? change.value!, parentNode: target }]
      if (change.value !== undefined && target.tagName === 'input') {
        target.attrs = target.attrs.filter(attribute => attribute.name !== 'value')
        target.attrs.push({ name: 'value', value: change.value })
      }
      if (change.hidden !== undefined) {
        target.attrs = target.attrs.filter(attribute => attribute.name !== 'hidden')
        if (change.hidden) target.attrs.push({ name: 'hidden', value: '' })
      }
    }
    const pending: DefaultTreeAdapterTypes.Node[] = [document]
    while (pending.length) {
      const node = pending.pop()!
      if ('tagName' in node) node.attrs = node.attrs.filter(attribute => {
        const allowed = /^data-requirement-ids?$/.test(attribute.name) ? state.requirementIds : /^data-acceptance-ids?$/.test(attribute.name) ? state.acceptanceIds : undefined
        if (!allowed) return true
        attribute.value = attribute.value.split(/\s+/).filter(value => allowed.includes(value)).join(' ')
        return !!attribute.value
      })
      if ('childNodes' in node) pending.push(...node.childNodes)
    }
    const body = document.childNodes.find(node => 'tagName' in node && node.tagName === 'html')
    const head = body && 'childNodes' in body ? body.childNodes.find(node => 'tagName' in node && node.tagName === 'head') : undefined
    if (head && 'tagName' in head) {
      const style: DefaultTreeAdapterTypes.Element = { nodeName: 'style', tagName: 'style', namespaceURI: head.namespaceURI, attrs: [], childNodes: [], parentNode: head }
      style.childNodes.push({ nodeName: '#text', value: '[hidden]{display:none!important}', parentNode: style })
      head.childNodes.push(style)
    }
    return {
      id: state.id,
      prototypeId: prototype.id,
      title: prototype.title,
      state: state.name,
      ...(state.proves === undefined ? {} : { proves: state.proves }),
      ...(state.capture === undefined ? {} : { capture: state.capture }),
      requirementIds: state.requirementIds,
      acceptanceIds: state.acceptanceIds,
      html: serialize(document),
    }
  }))
  return { prototypes, screens: validateScreens([...unchanged, ...rendered], prd) }
}

export function assertPrototypeSources(revision: RequirementRevision): void {
  if (!revision.prototypes) {
    if (revision.screens.some(screen => screen.prototypeId)) reject()
    return
  }
  const generated = validatePrototypeDesign(revision.prototypes, revision.prd, revision.screens.filter(screen => !screen.prototypeId)).screens
  if (generated.length !== revision.screens.length || revision.screens.some(screen => {
    const expected = generated.find(item => item.id === screen.id)
    const captureMismatch = !expected || (expected.capture === undefined) !== (screen.capture === undefined) || (expected.capture !== undefined && jsonDigest(expected.capture) !== jsonDigest(screen.capture))
    return !expected || expected.prototypeId !== screen.prototypeId || expected.title !== screen.title || expected.state !== screen.state || expected.proves !== screen.proves || captureMismatch || expected.html !== screen.html || JSON.stringify(expected.requirementIds) !== JSON.stringify(screen.requirementIds) || JSON.stringify(expected.acceptanceIds) !== JSON.stringify(screen.acceptanceIds)
  })) reject()
}