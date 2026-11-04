import type { RequirementProject, RequirementQuestion, RequirementScreen, RequirementSource, StructuredPrd } from '../../shared/requirements.js'
import { inspectRequirementHtml, type HtmlViolation } from './html-policy.js'

type RecordValue = Record<string, unknown>
export class RequirementOutputError extends Error {
  constructor(readonly rule: string, readonly htmlViolation?: HtmlViolation, readonly screenNumber?: number) { super(`Invalid requirements output: ${rule}`) }
}
function fail(message: string): never { throw new RequirementOutputError(message) }
function object(value: unknown, keys: string[]): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('object expected')
  const record = value as RecordValue
  for (const key of Object.keys(record)) if (!keys.includes(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) fail('unexpected field')
  return record
}
function text(value: unknown, max = 12000, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /\u0000/.test(value)) fail('invalid text')
  return value
}
function array(value: unknown, max: number, min = 0): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail('invalid array size')
  for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) fail('sparse array')
  return value
}
function nonVisualReason(value: unknown): string {
  const reason = text(value, 2000)
  if (reason.trim().length < 12 || /^(?:n\/?a|none|not applicable|non.?visual|backend|\u65e0|\u4e0d\u9002\u7528|\u975e\u53ef\u89c6)[.!\s]*$/i.test(reason)) fail('nonvisual exemption must explain why no UI exists')
  return reason
}
function id(value: unknown): string {
  const result = text(value, 80)
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(result) || ['__proto__', 'constructor', 'prototype'].includes(result)) fail('invalid id')
  return result
}
function unique(values: string[]): string[] {
  if (new Set(values).size !== values.length) fail('duplicate id or reference')
  return values
}
function refs(value: unknown, allowed?: Set<string>, min = 0): string[] {
  const result = unique(array(value, 500, min).map(id))
  if (allowed && result.some(item => !allowed.has(item))) fail('dangling reference')
  return result
}
export function validateQuestions(value: unknown): RequirementQuestion[] {
  const result = array(value, 9).map(item => {
    const record = object(item, ['id', 'priority', 'text', 'impact', 'choices', 'recommendation'])
    if (!['P0', 'P1', 'P2'].includes(String(record.priority))) fail('invalid priority')
    const choices = unique(array(record.choices, 4, 2).map(choice => text(choice, 1000)))
    const recommendation = text(record.recommendation, 1000)
    if (!choices.includes(recommendation)) fail('recommendation must equal a choice')
    return { id: id(record.id), priority: record.priority as RequirementQuestion['priority'], text: text(record.text, 2000), impact: text(record.impact, 2000), choices, recommendation }
  })
  unique(result.map(item => item.id))
  return result
}
export function validateEvidence(value: unknown, sources: RequirementSource[]): RequirementProject['evidence'] {
  const allowed = new Set(sources.map(source => source.id))
  const result = array(value, 100).map(item => {
    const record = object(item, ['sourceId', 'summary', 'limitations'])
    const sourceId = id(record.sourceId)
    if (!allowed.has(sourceId)) fail('unknown source')
    return { sourceId, summary: text(record.summary, 8000), limitations: text(record.limitations, 4000, true) }
  })
  unique(result.map(item => item.sourceId))
  if (result.length !== sources.length) fail('missing source evidence')
  return result
}
export function validatePrd(value: unknown, sourceIds?: string[]): StructuredPrd {
  const record = object(value, ['title', 'summary', 'blocks', 'requirements'])
  const sources = sourceIds ? new Set(sourceIds) : undefined
  const acceptanceIds: string[] = []
  const requirements = array(record.requirements, 300, 1).map(item => {
    const requirement = object(item, ['id', 'title', 'description', 'fields', 'scenario', 'acceptance', 'sourceIds', 'nonVisualReason'])
    const fields = requirement.fields === undefined ? undefined : array(requirement.fields, 200).map(entry => {
      const field = object(entry, ['name', 'description'])
      return { name: text(field.name, 300), description: text(field.description, 4000, true) }
    })
    const acceptance = array(requirement.acceptance, 50, 1).map(entry => {
      const criterion = object(entry, ['id', 'text'])
      const criterionId = id(criterion.id)
      acceptanceIds.push(criterionId)
      return { id: criterionId, text: text(criterion.text, 4000) }
    })
    return { id: id(requirement.id), title: text(requirement.title, 300), description: text(requirement.description), ...(fields === undefined ? {} : { fields }), ...(requirement.scenario === undefined ? {} : { scenario: text(requirement.scenario, 4000, true) }), acceptance, sourceIds: refs(requirement.sourceIds, sources), ...(requirement.nonVisualReason === undefined ? {} : { nonVisualReason: nonVisualReason(requirement.nonVisualReason) }) }
  })
  unique(acceptanceIds)
  const requirementIds = new Set(unique(requirements.map(item => item.id)))
  const blocks = array(record.blocks, 200, 1).map(item => {
    const block = object(item, ['id', 'title', 'module', 'content', 'requirementIds', 'sourceIds', 'table'])
    let table: { columns: string[]; rows: string[][] } | undefined
    if (block.table !== undefined) {
      const raw = object(block.table, ['columns', 'rows'])
      const columns = unique(array(raw.columns, 20, 1).map(column => text(column, 300)))
      const rows = array(raw.rows, 300).map(row => {
        const cells = array(row, columns.length, columns.length).map(cell => text(cell, 4000, true))
        return cells
      })
      table = { columns, rows }
    }
    return { id: id(block.id), title: text(block.title, 300), ...(block.module === undefined ? {} : { module: text(block.module, 300) }), content: text(block.content), requirementIds: refs(block.requirementIds, requirementIds), sourceIds: refs(block.sourceIds, sources), ...(table ? { table } : {}) }
  })
  unique(blocks.map(block => block.id))
  unique([...requirementIds, ...acceptanceIds, ...blocks.map(block => block.id)])
  if (requirements.some(requirement => !blocks.some(block => block.requirementIds.includes(requirement.id)))) fail('requirement missing from blocks')
  const result = { title: text(record.title, 300), summary: text(record.summary), requirements, blocks }
  if (JSON.stringify(result).length > 2_000_000) fail('PRD too large')
  return result
}
export function validateScreens(value: unknown, prd: StructuredPrd): RequirementScreen[] {
  if (Array.isArray(value) && value.length > 40) fail('design screen limit exceeded (maximum 40)')
  const requirements = new Map(prd.requirements.map(requirement => [requirement.id, requirement]))
  const screens = array(value, 40).map((item, index) => {
    const screen = object(item, ['id', 'prototypeId', 'title', 'state', 'requirementIds', 'acceptanceIds', 'html'])
    const requirementIds = refs(screen.requirementIds, new Set(requirements.keys()), 1)
    const allowedAcceptance = new Set(requirementIds.flatMap(requirementId => requirements.get(requirementId)!.acceptance.map(criterion => criterion.id)))
    const acceptanceIds = refs(screen.acceptanceIds, allowedAcceptance, 1)
    const html = text(screen.html, 300_000)
    if (!/^\s*<!doctype html>/i.test(html) || !/<html[\s>]/i.test(html) || !/<body[\s>]/i.test(html) || !/<\/html>\s*$/i.test(html)) fail('standalone HTML required')
    const { violation, mappings } = inspectRequirementHtml(html)
    if (violation) throw new RequirementOutputError('external or unsafe HTML capability', violation, index + 1)
    if (mappings.some(mapping => !requirementIds.includes(mapping)) || requirementIds.some(requirementId => !mappings.includes(requirementId))) throw new RequirementOutputError('HTML requirement mapping mismatch', undefined, index + 1)
    return { id: id(screen.id), ...(screen.prototypeId === undefined ? {} : { prototypeId: id(screen.prototypeId) }), title: text(screen.title, 300), state: text(screen.state, 300), requirementIds, acceptanceIds, html }
  })
  unique(screens.map(screen => screen.id))
  for (const requirement of prd.requirements) {
    if (requirement.nonVisualReason) { nonVisualReason(requirement.nonVisualReason); continue }
    if (!screens.some(screen => screen.requirementIds.includes(requirement.id))) fail('visual requirement not covered')
    if (requirement.acceptance.some(criterion => !screens.some(screen => screen.acceptanceIds.includes(criterion.id)))) fail('visual acceptance not covered')
  }
  if (JSON.stringify(screens).length > 3_000_000) fail('screens too large')
  return screens
}