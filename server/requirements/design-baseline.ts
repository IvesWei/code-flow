import { RequirementDiagnosticError } from './diagnostics.js'
import type { WorkspaceSnapshot } from './workspace.js'

export const existingDesignPolicy = 'EXISTING SYSTEM STYLE LOCK: User-supplied brand/design standards and observed neighboring pages take precedence over search recommendations and generic design defaults. Before HTML generation inspect relevant pages, shared layout/navigation, theme tokens, component overrides and typography in the workspace. Preserve evidenced colors, fonts, density, spacing, radii, tables, forms and navigation. Do not invent a new dashboard theme or redesign the application shell. Safety constraints may replace remote assets or executable components with inert equivalents, but must not replace their visual identity. Search results are supplementary UX guidance only. Missing style evidence must block generation rather than silently selecting a new brand.'

export function parseDesignBaseline(content: string, snapshots: WorkspaceSnapshot[]) {
  const fail = () => new RequirementDiagnosticError('output_validation', 'DESIGN_STYLE_EVIDENCE', '现有系统风格证据不足或格式无效，请补充相关页面、主题样式或品牌规范后重新生成设计；未采用通用风格替代')
  if (!content || content.length > 40000) throw fail()
  let result: unknown
  try {
    result = JSON.parse(content, (key, value: unknown) => {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw fail()
      return value
    })
  } catch { throw fail() }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw fail()
  const record = result as Record<string, unknown>
  if (Object.keys(record).some(key => !['status', 'tokens'].includes(key)) || record.status !== 'observed' || !Array.isArray(record.tokens) || record.tokens.length < 2 || record.tokens.length > 24) throw fail()
  const categories = new Set<string>()
  for (const entry of record.tokens) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw fail()
    const token = entry as Record<string, unknown>
    if (Object.keys(token).some(key => !['category', 'value', 'sourceId', 'path', 'quote'].includes(key))) throw fail()
    for (const key of ['category', 'value', 'sourceId', 'path', 'quote']) if (typeof token[key] !== 'string' || !token[key] || (token[key] as string).length > 2000) throw fail()
    if (!['color', 'typography', 'spacing', 'component', 'navigation'].includes(token.category as string)) throw fail()
    const source = snapshots.find(source => source.sourceId === token.sourceId)
    if (!source) throw fail()
    const marker = `Path: ${JSON.stringify(token.path)}`
    const start = source.text.indexOf(marker)
    const next = source.text.indexOf('\nPath: ', start + marker.length)
    const section = start < 0 ? '' : source.text.slice(start, next < 0 ? undefined : next)
    if (!section.includes(token.quote as string) || !(token.quote as string).includes(token.value as string)) throw fail()
    categories.add(token.category as string)
  }
  if (!['color', 'typography'].some(category => categories.has(category)) || !['component', 'navigation'].some(category => categories.has(category))) throw fail()
  return record
}