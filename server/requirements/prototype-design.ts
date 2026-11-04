import { parse, serialize, type DefaultTreeAdapterTypes } from 'parse5'
import type { RequirementPrototype, RequirementRevision, RequirementScreen, StructuredPrd } from '../../shared/requirements.js'
import { inspectRequirementHtml } from './html-policy.js'
import { RequirementOutputError, validateScreens } from './validation.js'

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
        if (['html', 'head', 'style', 'script', 'template', 'meta', 'title', 'link', 'base'].includes(node.tagName) || node.namespaceURI !== 'http://www.w3.org/1999/xhtml') reject('invalid prototype node element')
        result.set(target, node)
      }
    }
    if ('childNodes' in node) pending.push(...node.childNodes)
  }
  return result
}
export function validatePrototypeDesign(value: unknown, prd: StructuredPrd, unchanged: RequirementScreen[] = []): { prototypes: RequirementPrototype[]; screens: RequirementScreen[] } {
  const prototypes = list(value, 40, 1).map(entry => {
    const source = record(entry, ['id', 'title', 'html', 'states'])
    const html = string(source.html, 300000)
    if (!/^\s*<!doctype html>/i.test(html) || !/<html[\s>]/i.test(html) || !/<body[\s>]/i.test(html) || !/<\/html>\s*$/i.test(html)) reject('standalone HTML required')
    const inspection = inspectRequirementHtml(html)
    if (inspection.violation) throw new RequirementOutputError('external or unsafe HTML capability', inspection.violation)
    const targets = nodes(parse(html))
    const states = list(source.states, 40, 1).map(entry => {
      const state = record(entry, ['id', 'name', 'requirementIds', 'acceptanceIds', 'changes'])
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
      return { id: identifier(state.id), name: string(state.name, 300), requirementIds: references(state.requirementIds), acceptanceIds: references(state.acceptanceIds), changes }
    })
    if (new Set(states.map(state => state.name)).size !== states.length) reject('duplicate prototype state name')
    return { id: identifier(source.id), title: string(source.title, 300), html, states }
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
    return { id: state.id, prototypeId: prototype.id, title: prototype.title, state: state.name, requirementIds: state.requirementIds, acceptanceIds: state.acceptanceIds, html: serialize(document) }
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
    return !expected || expected.prototypeId !== screen.prototypeId || expected.title !== screen.title || expected.state !== screen.state || expected.html !== screen.html || JSON.stringify(expected.requirementIds) !== JSON.stringify(screen.requirementIds) || JSON.stringify(expected.acceptanceIds) !== JSON.stringify(screen.acceptanceIds)
  })) reject()
}