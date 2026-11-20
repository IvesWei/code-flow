import type { BusinessReview, BusinessReviewChange, RequirementRevision, RequirementScreen, StructuredPrd } from './requirements.js'
import { prdSections } from './prd-sections.js'

export const businessChangeColors = { 新增: '#14633F', 变更: '#814D06', 删除: '#A63248' } as const

const invalid = (): never => { throw new Error('业务评审清单与当前 PRD 或设计状态不匹配') }
function record(value: unknown, keys: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) return invalid()
  return value as Record<string, unknown>
}
function text(value: unknown, max = 1200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) return invalid()
  return value.trim()
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) return invalid()
  return value
}
export function readBusinessReview(value: unknown, prd: StructuredPrd, screens: RequirementScreen[]): BusinessReview {
  const body = record(value, ['changes', 'pending'])
  const requirement = (id: unknown) => prd.requirements.find(item => item.id === id) ?? invalid()
  const changes = list(body.changes, 200).map((value): BusinessReviewChange => {
    const row = record(value, ['requirementId', 'kind', 'scope', 'text', 'basis', 'screenIds'])
    const item = requirement(row.requirementId), basis = text(row.basis)
    const spec = item.specification
    const fields = (item.fields ?? []).flatMap((field, index) => {
      const metadata = spec?.fields[index]
      return metadata?.change && metadata.change !== row.kind ? [] : [field.name, field.description, ...metadata?.options ?? []]
    })
    const facts = [item.description, item.capability, item.scenario, item.nonVisualReason, ...fields, ...item.acceptance.map(entry => entry.text),
      ...(spec?.rules ?? []).flatMap(rule => [rule.business, rule.detail]),
      ...(spec?.transitions ?? []).flatMap(entry => [entry.event, entry.precondition, entry.effects, entry.from, entry.to]),
      ...(spec?.exceptions ?? []).flatMap(entry => [entry.condition, entry.outcome]), ...(spec?.permissions ?? []).flatMap(entry => [entry.operation, entry.scope]),
      ...(spec?.criteria ?? []).flatMap(entry => [entry.given, entry.when, entry.then, entry.example])]
    if (!facts.some(fact => fact?.includes(basis)) || (row.kind !== '新增' && row.kind !== '变更' && row.kind !== '删除') || (row.scope !== 'logic' && row.scope !== 'ui')) return invalid()
    const screenIds = list(row.screenIds, 40).map(id => text(id, 100))
    if ((row.scope === 'ui' && item.nonVisualReason) || (row.scope === 'logic' && screenIds.length) || new Set(screenIds).size !== screenIds.length || screenIds.some(id => !screens.some(screen => screen.id === id && screen.requirementIds.includes(item.id)))) return invalid()
    return { requirementId: item.id, kind: row.kind, scope: row.scope, text: text(row.text), basis, screenIds }
  })
  const pending = list(body.pending, 200).map(value => {
    const row = record(value, ['requirementId', 'text'])
    return { requirementId: requirement(row.requirementId).id, text: text(row.text) }
  })
  const entries = [...changes, ...pending]
  if (new Set(entries.map(item => `${item.requirementId}\n${item.text}`)).size !== entries.length) return invalid()
  return { changes, pending }
}

export function businessReviewSections(revision: RequirementRevision) {
  const review = revision.businessReview
  if (!review || review.revisionId !== revision.id) return []
  const owners = new Map<string, string>()
  return Array.from(prdSections(revision.prd).modules, ([name, pages]) => ({ name, functions: pages.flatMap(({ requirements }) => requirements.flatMap(item => {
    const changes = review.changes.filter(change => change.requirementId === item.id).map((change, index) => ({ ...change, key: `${item.id}:change:${index}`, pictures: change.screenIds.flatMap(id => {
      const screen = revision.screens.find(screen => screen.id === id && screen.requirementIds.includes(item.id))
      if (!screen) return []
      const owner = owners.get(id)
      if (!owner) owners.set(id, item.title)
      return [{ screen, owner }]
    }) }))
    const pending = review.pending.filter(change => change.requirementId === item.id).map((change, index) => ({ ...change, key: `${item.id}:pending:${index}` }))
    return changes.length || pending.length ? [{ id: item.id, title: item.title, changes, pending }] : []
  })) })).filter(module => module.functions.length)
}

export type BusinessSections = ReturnType<typeof businessReviewSections>
type BusinessFeature = BusinessSections[number]['functions'][number]
export type BusinessNote = BusinessFeature['changes'][number] | BusinessFeature['pending'][number]