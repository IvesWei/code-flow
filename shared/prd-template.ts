import type { PrdFunctionSpecification, StructuredPrd } from './requirements.js'
import { prdSections, prdTextItems } from './prd-sections.js'

export type PrdEdition = 'business' | 'development'
export const prdEditionNames: Record<PrdEdition, string> = { business: '业务评审版', development: '开发规格版' }
export class PrdTemplateError extends Error {}
type Row = Record<string, unknown>
function invalid(message: string): never { throw new PrdTemplateError(`双模板 PRD：${message}`) }
function object(value: unknown, keys: string[]): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid('需要完整对象')
  const row = value as Row
  if (Object.keys(row).some(key => !keys.includes(key))) return invalid('包含未定义字段')
  return row
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 12000 || value.includes('\0')) return invalid('内容为空或超出限制；未知项请明确标注待确认')
  return value
}
function list<T>(value: unknown, parse: (entry: unknown) => T, minimum = 0): T[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > 200) return invalid('条目数量无效')
  for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) return invalid('不能包含空缺条目')
  return value.map(parse)
}
function choice<T extends string>(value: unknown, allowed: readonly T[]): T {
  const result = text(value)
  const match = allowed.find(item => item === result)
  if (match === undefined) return invalid('分类值不符合模板')
  return match
}
function code(value: unknown, prefix: string): string {
  const result = text(value)
  if (!new RegExp(`^${prefix}-[0-9]{2,}$`).test(result)) return invalid(`${prefix} 编号格式无效`)
  return result
}
export function readPrdSpecification(value: unknown): PrdFunctionSpecification {
  const row = object(value, ['fields', 'transitions', 'rules', 'exceptions', 'permissions', 'criteria'])
  return {
    fields: list(row.fields, value => {
      const field = object(value, ['name', 'id', 'type', 'required', 'source', 'change', 'options'])
      return {
        name: text(field.name), id: code(field.id, 'FLD'), type: text(field.type),
        required: choice(field.required, ['是', '否', '待确认'] as const), source: text(field.source),
        ...(field.change === undefined ? {} : { change: choice(field.change, ['新增', '变更', '删除', '既有'] as const) }),
        options: list(field.options, text),
      }
    }),
    transitions: list(row.transitions, value => {
      const entry = object(value, ['id', 'from', 'to', 'event', 'precondition', 'role', 'effects'])
      return { id: code(entry.id, 'TR'), from: text(entry.from), to: text(entry.to), event: text(entry.event), precondition: text(entry.precondition), role: text(entry.role), effects: text(entry.effects) }
    }),
    rules: list(row.rules, value => {
      const entry = object(value, ['id', 'kind', 'business', 'detail', 'validation', 'scope', 'businessVisible'])
      if (entry.businessVisible !== undefined && typeof entry.businessVisible !== 'boolean') return invalid('规则展示标记必须为布尔值')
      return {
        id: code(entry.id, 'BR'), kind: choice(entry.kind, ['校验规则', '计算 / 编号生成规则']),
        business: text(entry.business), detail: text(entry.detail),
        validation: choice(entry.validation, ['双端', '仅后端', '待确认']), scope: text(entry.scope),
        ...(entry.businessVisible === undefined ? {} : { businessVisible: entry.businessVisible }),
      }
    }, 1),
    exceptions: list(row.exceptions, value => {
      const entry = object(value, ['id', 'condition', 'outcome', 'dataImpact'])
      return { id: code(entry.id, 'EX'), condition: text(entry.condition), outcome: text(entry.outcome), dataImpact: choice(entry.dataImpact, ['整体回滚', '部分成功', '只读保留', '待确认']) }
    }, 1),
    permissions: list(row.permissions, value => {
      const entry = object(value, ['id', 'role', 'operation', 'availability', 'scope'])
      const result = { id: code(entry.id, 'RM'), role: text(entry.role), operation: text(entry.operation), availability: choice(entry.availability, ['可用', '仅查看', '不可见', '待确认']), scope: text(entry.scope) }
      if ([result.role, result.operation, result.scope].some(value => value.includes('待确认')) && result.availability !== '待确认') return invalid('权限待确认时不得默认放行')
      return result
    }, 1),
    criteria: list(row.criteria, value => {
      const entry = object(value, ['id', 'acceptanceId', 'given', 'when', 'then', 'example', 'refs'])
      const example = text(entry.example)
      if (!/[0-9０-９]|待确认/.test(example)) return invalid('验收标准必须带具体数值示例，未知时标注待确认')
      return { id: code(entry.id, 'AC'), acceptanceId: text(entry.acceptanceId), given: text(entry.given), when: text(entry.when), then: text(entry.then), example, refs: list(entry.refs, text, 1) }
    }, 1),
  }
}
export const prdFunctionCode = (index: number) => `FR-${String(index + 1).padStart(2, '0')}`

export function validatePrdTemplate(prd: StructuredPrd): void {
  if (prd.templateVersion !== 2) return invalid('新生成的 PRD 必须使用 templateVersion=2')
  if ([prd.title, ...prd.blocks.map(block => block.module || '')].some(value => /\b(?:MOD|FR|FLD|TR|BR|EX|RM|AC)-\d+\b/.test(value))) invalid('标题和模块名称不能夹带开发编号')
  const seen = new Set<string>()
  const register = (id: string) => { if (seen.has(id)) invalid(`重复编号 ${id}`); seen.add(id) }
  for (const [index, requirement] of prd.requirements.entries()) {
    if (!requirement.scenario?.trim()) invalid('每个功能必须包含对应场景，未知时标注待确认')
    if (requirement.capability !== undefined && (!requirement.capability.trim() || requirement.capability.length > 1000)) invalid('功能描述概述不能为空或超出限制')
    const spec = readPrdSpecification(requirement.specification)
    const featureCode = prdFunctionCode(index)
    register(featureCode)
    prdTextItems(requirement.description).forEach((_, index) => register(`${featureCode}-${index + 1}`))
    for (const entry of [...spec.fields, ...spec.transitions, ...spec.rules, ...spec.exceptions, ...spec.permissions, ...spec.criteria]) register(entry.id)
    if (!requirement.fields) invalid('新模板必须显式提供 fields；不涉及字段时使用空数组')
    const fields = requirement.fields
    if (new Set(fields.map(field => field.name)).size !== fields.length || spec.fields.length !== fields.length || fields.some((field, index) => field.name !== spec.fields[index].name)) invalid('字段规格必须按原有字段顺序完整对应，不能遗漏或重复')
    if (spec.criteria.length !== requirement.acceptance.length || new Set(spec.criteria.map(criterion => criterion.acceptanceId)).size !== spec.criteria.length || spec.criteria.some(criterion => !requirement.acceptance.some(item => item.id === criterion.acceptanceId && item.text === criterion.then))) invalid('GWT 验收标准必须完整对应内部验收映射，Then 与验收结果必须一致')
    const wording = [requirement.title, requirement.capability || '', requirement.scenario, requirement.description, requirement.nonVisualReason || '', ...fields.flatMap(field => [field.name, field.description]), ...spec.fields.flatMap(field => field.options), ...spec.transitions.flatMap(entry => [entry.from, entry.to, entry.event, entry.precondition, entry.role, entry.effects]), ...spec.rules.map(rule => rule.business), ...spec.exceptions.flatMap(entry => [entry.condition, entry.outcome])]
    if (wording.some(value => /\b(?:MOD|FR|FLD|TR|BR|EX|RM|AC)-\d+\b/.test(value))) invalid('业务文案不能夹带开发编号')
  }
  for (const [index, requirement] of prd.requirements.entries()) {
    for (const criterion of requirement.specification!.criteria) {
      if (criterion.refs.some(id => !seen.has(id) || !/^(?:FR|FLD|TR|BR|EX)-/.test(id)) || !criterion.refs.some(id => id === prdFunctionCode(index) || id.startsWith(`${prdFunctionCode(index)}-`))) invalid('验收关联必须指向已定义编号，并包含本功能 FR 编号')
      if (new Set(criterion.refs).size !== criterion.refs.length) invalid('验收关联编号重复')
    }
  }
  if (prd.blocks.some(block => !block.module?.trim() || block.table || !block.requirementIds.length)) invalid('页面必须归属模块并关联功能；字段不能使用页面级宽表')
  if (prd.requirements.some(requirement => prd.blocks.filter(block => block.requirementIds.includes(requirement.id)).length !== 1)) invalid('每个功能必须且只能归属一个页面区块')
}

export interface PrdOutlineLine {
  text: string
  bold?: boolean
  children?: PrdOutlineLine[]
  designFor?: string
}
export interface PrdOutlineFunction {
  id: string
  title: string
  scenario: string
  capability?: string
  lines: PrdOutlineLine[]
}
export function prdTemplateOutline(prd: StructuredPrd, edition: PrdEdition) {
  validatePrdTemplate(prd)
  const development = edition === 'development'
  const line = (text: string): PrdOutlineLine => ({ text })
  const section = (text: string, children: PrdOutlineLine[]): PrdOutlineLine => ({ text, bold: true, children })
  const { modules } = prdSections(prd)
  return Array.from(modules, ([name, pages], moduleIndex) => ({
    name,
    title: `${development ? `MOD-${String(moduleIndex + 1).padStart(2, '0')} ` : ''}模块：${name}`,
    functions: pages.flatMap(page => page.requirements).map(requirement => {
      const spec = requirement.specification!
      const featureCode = prdFunctionCode(prd.requirements.indexOf(requirement))
      const lines: PrdOutlineLine[] = prdTextItems(requirement.description).map((text, index) => line(`${development ? `${featureCode}-${index + 1} ` : ''}${text}`))
      const fieldEntries = requirement.fields!.flatMap((field, index) => {
        const metadata = spec.fields[index]
        const change = metadata.change
        if (!development && change === '既有') return []
        const tag = change ? `【${change}】` : ''
        const detail = development
          ? `栏位类型：${metadata.type}；必填：${metadata.required}；来源：${metadata.source}${field.description ? `；${field.description}` : ''}`
          : field.description
        return [{ text: `${development ? `${metadata.id} ` : ''}${tag}${field.name}${detail ? ` —— ${detail}` : ''}`, children: metadata.options.map(line) }]
      })
      if (development) lines.push(section('该功能涉及的字段：', fieldEntries.length ? fieldEntries : [line('本功能不新增或变更业务字段')]))
      else if (fieldEntries.length) lines.push(section('该功能涉及的字段：', fieldEntries))
      if (spec.transitions.length) lines.push(section('状态流转：', spec.transitions.map(entry => line(`${development ? `${entry.id} ` : ''}${entry.from} → ${entry.to}：触发事件：${entry.event}；前置条件：${entry.precondition}；触发角色：${entry.role}；副作用：${entry.effects}`))))
      lines.push({ text: '设计稿：', bold: true, designFor: requirement.id })
      const visibleRules = development ? spec.rules : spec.rules.filter(rule => rule.businessVisible ?? (rule.kind === '计算 / 编号生成规则' || rule.validation === '仅后端'))
      if (visibleRules.length) lines.push(section('业务规则与生成逻辑：', visibleRules.map(rule => line(`${development ? `${rule.id} ` : ''}${rule.kind}：${rule.business}${development ? `；实现要求：${rule.detail}（校验层级：${rule.validation}；适用范围：${rule.scope}）` : ''}`))))
      if (development) {
        lines.push(section('异常场景与边界条件：', spec.exceptions.map(entry => line(`${entry.id} 如果发生${entry.condition}，系统会${entry.outcome}（数据影响：${entry.dataImpact}）`))))
        lines.push(section('权限：', [...spec.permissions.map(entry => line(`${entry.id} 角色：${entry.role} —— 本功能操作：${entry.operation}（${entry.availability}）；数据范围：${entry.scope}`)), line('越权防护：所有权限在服务端接口层强制校验，前端仅做展示控制')]))
        lines.push(section('验收标准：', spec.criteria.map(entry => line(`${entry.id} Given ${entry.given}，When ${entry.when}，Then ${entry.then}（具体数值示例：${entry.example}；关联：${entry.refs.join(' / ')}）`))))
      }
      return {
        id: requirement.id,
        title: `${development ? `${featureCode} ` : ''}功能名称：${requirement.title}`,
        scenario: `对应场景：${requirement.scenario}`,
        ...(requirement.capability ? { capability: requirement.capability } : {}),
        lines,
      }
    }),
  }))
}
