import type { RequirementCaptureMappingPage, RequirementProject, RequirementPrototypeCapture, RequirementQuestion, RequirementScopeBlock, RequirementScreen, RequirementSource, RequirementSourceAnchor, StructuredPrd } from '../../shared/requirements.js'
import { requirementPreviewPath } from '../../shared/requirement-preview.js'
import { parseCaptureDiscoveries } from './capture-discovery.js'
import { codeSnapshotContainsPath } from './code-snapshot.js'
import { inspectRequirementHtml, type HtmlViolation } from './html-policy.js'
import { PrdTemplateError, readPrdSpecification, validatePrdTemplate } from '../../shared/prd-template.js'
import { prdIssueSummary, prdRepairIssues, type PrdRepairIssue } from './prd-repair.js'

type RecordValue = Record<string, unknown>
export class RequirementOutputError extends Error {
  constructor(readonly rule: string, readonly htmlViolation?: HtmlViolation, readonly screenNumber?: number, readonly context?: string, readonly repairs?: PrdRepairIssue[]) { super(`Invalid requirements output: ${rule}`) }
}
function fail(message: string, context?: string): never { throw new RequirementOutputError(message, undefined, undefined, context) }
function object(value: unknown, keys: string[], context?: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('object expected', context)
  const record = value as RecordValue
  for (const key of Object.keys(record)) if (!keys.includes(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) fail('unexpected field', context)
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
    const record = object(item, ['id', 'priority', 'text', 'impact', 'choices', 'recommendation', 'capture'])
    if (!['P0', 'P1', 'P2'].includes(String(record.priority))) fail('invalid priority')
    const choices = unique(array(record.choices, 4, 2).map(choice => text(choice, 1000)))
    const recommendation = text(record.recommendation, 1000)
    if (!choices.includes(recommendation)) fail('recommendation must equal a choice')
    let capture
    if (record.capture !== undefined) {
      const context = object(record.capture, ['fingerprint', 'blockIds'])
      if (typeof context.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(context.fingerprint)) fail('invalid capture scope fingerprint')
      capture = { fingerprint: context.fingerprint, blockIds: refs(context.blockIds, undefined, 1) }
      if (capture.blockIds.length > 12) fail('invalid capture question scope')
    }
    return { id: id(record.id), priority: record.priority as RequirementQuestion['priority'], text: text(record.text, 2000), impact: text(record.impact, 2000), choices, recommendation, ...(capture ? { capture } : {}) }
  })
  unique(result.map(item => item.id))
  return result
}
export function validateCaptureMappingPages(value: unknown, blocks: RequirementScopeBlock[], sourceIds: string[]): RequirementCaptureMappingPage[] {
  const seen = new Set<string>()
  return array(value, 12).map(item => {
    const page = object(item, ['blockId', 'kind', 'path', 'sourceId', 'quote', 'openDialog', 'activate', 'expectedFields', 'expectedContent', 'discover'])
    const blockId = id(page.blockId), sourceId = id(page.sourceId)
    if (page.kind !== 'existing' || !blocks.some(block => block.blockId === blockId && block.kind === 'existing') || !sourceIds.includes(sourceId) || seen.has(blockId)) fail('invalid capture mapping checkpoint')
    seen.add(blockId)
    let path: string
    try { path = requirementPreviewPath(page.path) } catch { return fail('invalid capture mapping checkpoint') }
    const labels = (value: unknown) => array(value, 80, 1).map(label => text(label, 120))
    const expectedFields = page.expectedFields === undefined ? undefined : labels(page.expectedFields)
    const expectedContent = page.expectedContent === undefined ? undefined : unique(labels(page.expectedContent))
    let discover
    try { discover = page.discover === undefined ? undefined : parseCaptureDiscoveries(page.discover) } catch { return fail('invalid capture mapping checkpoint') }
    if (discover?.some(item => !sourceIds.includes(item.sourceId)) || (discover && discover[0].fromPath !== path)) fail('invalid capture mapping checkpoint')
    if (!expectedFields?.length && !expectedContent?.length && !discover?.every(item => item.expectedFields?.length || item.expectedContent?.length)) fail('invalid capture mapping checkpoint')
    const openDialog = page.openDialog === undefined ? undefined : text(page.openDialog, 120)
    const activate = page.activate === undefined ? undefined : array(page.activate, 6, 1).map((item): { kind: 'tab' | 'dialog'; name: string } => {
      const step = object(item, ['kind', 'name'])
      if (step.kind !== 'tab' && step.kind !== 'dialog') return fail('invalid capture mapping checkpoint')
      return { kind: step.kind, name: text(step.name, 120) }
    })
    if (openDialog && (activate || (!expectedFields?.length && !discover?.every(item => item.expectedFields?.length)))) fail('invalid capture mapping checkpoint')
    return { blockId, kind: 'existing', path, sourceId, quote: text(page.quote, 2000), ...(openDialog ? { openDialog } : {}), ...(activate ? { activate } : {}), ...(expectedFields ? { expectedFields } : {}), ...(expectedContent ? { expectedContent } : {}), ...(discover ? { discover } : {}) }
  })
}

export function validateSourceAnchors(value: unknown, sources: RequirementSource[], snapshots?: { sourceId: string; text: string }[]): RequirementSourceAnchor[] {
  const allowed = new Set(sources.map(source => source.id))
  return array(value, 40).map(item => {
    const record = object(item, ['domain', 'sourceId', 'route', 'layout', 'menu', 'pageFile', 'position', 'summary'])
    const sourceId = id(record.sourceId)
    if (!allowed.has(sourceId)) fail('unknown source in sourceAnchor')
    const pageFile = text(record.pageFile, 240)
    if (snapshots) {
      const snapshot = snapshots.find(entry => entry.sourceId === sourceId)
      if (!snapshot || !codeSnapshotContainsPath(snapshot.text, pageFile)) fail('sourceAnchor pageFile missing from code snapshot')
    }
    const position = record.position === undefined ? undefined : text(record.position, 20)
    if (position !== undefined && !['viewport', 'lower', 'dialog', 'drawer', 'tab'].includes(position)) fail('invalid sourceAnchor position')
    return {
      domain: text(record.domain, 200),
      sourceId,
      ...(record.route === undefined ? {} : { route: text(record.route, 240) }),
      ...(record.layout === undefined ? {} : { layout: text(record.layout, 240) }),
      ...(record.menu === undefined ? {} : { menu: text(record.menu, 240) }),
      pageFile,
      ...(position ? { position: position as RequirementSourceAnchor['position'] } : {}),
      summary: text(record.summary, 2000),
    }
  })
}
export function validatePrototypeCapture(value: unknown): RequirementPrototypeCapture {
  const record = object(value, ['mode', 'scrollTo', 'selector', 'padding'])
  const mode = record.mode === undefined ? undefined : text(record.mode, 20)
  if (mode !== undefined && !['viewport', 'element', 'fullPage'].includes(mode)) fail('invalid prototype capture mode')
  const safeSelector = (raw: unknown) => {
    const selector = text(raw, 160)
    if (!/^[#.[A-Za-z0-9_="'\-\s\]:>+~]+$/.test(selector) || /[\r\n]/.test(selector)) fail('invalid prototype capture selector')
    return selector
  }
  const scrollTo = record.scrollTo === undefined ? undefined : safeSelector(record.scrollTo)
  const selector = record.selector === undefined ? undefined : safeSelector(record.selector)
  if (mode === 'element' && !selector) fail('element capture requires selector')
  if (mode !== 'element' && selector !== undefined) fail('selector is only allowed for element capture')
  let padding: number | undefined
  if (record.padding !== undefined) {
    if (typeof record.padding !== 'number' || !Number.isInteger(record.padding) || record.padding < 0 || record.padding > 64) fail('invalid prototype capture padding')
    padding = record.padding
  }
  return {
    ...(mode ? { mode: mode as RequirementPrototypeCapture['mode'] } : {}),
    ...(scrollTo ? { scrollTo } : {}),
    ...(selector ? { selector } : {}),
    ...(padding === undefined ? {} : { padding }),
  }
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
export function validatePrd(value: unknown, sourceIds?: string[], authoring = false): StructuredPrd {
  const record = object(value, ['title', 'summary', 'blocks', 'requirements', 'templateVersion'], 'prd allows only templateVersion, title, summary, blocks, requirements')
  if (record.templateVersion !== undefined && record.templateVersion !== 2) fail('unsupported PRD template version')
  const repairs = prdRepairIssues(record, authoring)
  if (repairs.length) throw new RequirementOutputError('双模板 PRD：字段选项或验收引用无效', undefined, undefined, prdIssueSummary(repairs), repairs)
  const sources = sourceIds ? new Set(sourceIds) : undefined
  const acceptanceIds: string[] = []
  const requirements = array(record.requirements, 300, 1).map(item => {
    const requirement = object(item, ['id', 'title', 'capability', 'description', 'fields', 'scenario', 'acceptance', 'sourceIds', 'nonVisualReason', ...(record.templateVersion === 2 ? ['specification'] : [])], 'prd.requirements[]')
    const fields = requirement.fields === undefined ? undefined : array(requirement.fields, 200).map(entry => {
      const field = object(entry, ['name', 'description'], 'prd.requirements[].fields[] allows only name, description; put type/required/source/change/options in specification.fields[]')
      return { name: text(field.name, 300), description: text(field.description, 4000, true) }
    })
    const acceptance = array(requirement.acceptance, 50, 1).map(entry => {
      const criterion = object(entry, ['id', 'text'], 'prd.requirements[].acceptance[] allows only id, text')
      const criterionId = id(criterion.id)
      acceptanceIds.push(criterionId)
      return { id: criterionId, text: text(criterion.text, 4000) }
    })
    let specification
    if (record.templateVersion === 2) {
      try { specification = readPrdSpecification(requirement.specification) }
      catch (error) { if (error instanceof PrdTemplateError) fail(error.message); throw error }
    }
    return { id: id(requirement.id), title: text(requirement.title, 300), ...(requirement.capability === undefined ? {} : { capability: text(requirement.capability, 1000) }), description: text(requirement.description), ...(fields === undefined ? {} : { fields }), ...(requirement.scenario === undefined ? {} : { scenario: text(requirement.scenario, 4000, true) }), acceptance, sourceIds: refs(requirement.sourceIds, sources), ...(requirement.nonVisualReason === undefined ? {} : { nonVisualReason: nonVisualReason(requirement.nonVisualReason) }), ...(specification ? { specification } : {}) }
  })
  unique(acceptanceIds)
  const requirementIds = new Set(unique(requirements.map(item => item.id)))
  const blocks = array(record.blocks, 200, 1).map(item => {
    const block = object(item, ['id', 'title', 'module', 'content', 'requirementIds', 'sourceIds', 'table'], 'prd.blocks[]')
    let table: { columns: string[]; rows: string[][] } | undefined
    if (block.table !== undefined) {
      const raw = object(block.table, ['columns', 'rows'], 'prd.blocks[].table')
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
  const result: StructuredPrd = { title: text(record.title, 300), summary: text(record.summary), requirements, blocks, ...(record.templateVersion === 2 ? { templateVersion: 2 } : {}) }
  if (record.templateVersion === 2) {
    try { validatePrdTemplate(result) }
    catch (error) { if (error instanceof PrdTemplateError) fail(error.message); throw error }
  }
  if (JSON.stringify(result).length > 2_000_000) fail('PRD too large')
  return result
}
export function validateScreens(value: unknown, prd: StructuredPrd): RequirementScreen[] {
  if (Array.isArray(value) && value.length > 40) fail('design screen limit exceeded (maximum 40)')
  const requirements = new Map(prd.requirements.map(requirement => [requirement.id, requirement]))
  const screens = array(value, 40).map((item, index) => {
    const screen = object(item, ['id', 'prototypeId', 'title', 'state', 'proves', 'capture', 'requirementIds', 'acceptanceIds', 'html'])
    const requirementIds = refs(screen.requirementIds, new Set(requirements.keys()), 1)
    const allowedAcceptance = new Set(requirementIds.flatMap(requirementId => requirements.get(requirementId)!.acceptance.map(criterion => criterion.id)))
    const acceptanceIds = refs(screen.acceptanceIds, allowedAcceptance, 1)
    const html = text(screen.html, 300_000)
    if (!/^\s*<!doctype html>/i.test(html) || !/<html[\s>]/i.test(html) || !/<body[\s>]/i.test(html) || !/<\/html>\s*$/i.test(html)) fail('standalone HTML required')
    const { violation, mappings } = inspectRequirementHtml(html)
    if (violation) throw new RequirementOutputError('external or unsafe HTML capability', violation, index + 1)
    if (mappings.some(mapping => !requirementIds.includes(mapping)) || requirementIds.some(requirementId => !mappings.includes(requirementId))) throw new RequirementOutputError('HTML requirement mapping mismatch', undefined, index + 1)
    const capture = screen.capture === undefined ? undefined : validatePrototypeCapture(screen.capture)
    return {
      id: id(screen.id),
      ...(screen.prototypeId === undefined ? {} : { prototypeId: id(screen.prototypeId) }),
      title: text(screen.title, 300),
      state: text(screen.state, 300),
      ...(screen.proves === undefined ? {} : { proves: text(screen.proves, 500) }),
      ...(capture ? { capture } : {}),
      requirementIds,
      acceptanceIds,
      html,
    }
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