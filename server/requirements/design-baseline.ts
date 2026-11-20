import { RequirementDiagnosticError } from './diagnostics.js'
import type { WorkspaceSnapshot } from './workspace.js'
import { normalizeCodeSnapshotText } from './code-snapshot.js'

export const preChangeDesignPolicy = 'SOURCE RECONSTRUCTION ONLY: draw the existing system BEFORE any requirement changes. Inspect the supplied source files for its host, child components, theme and styles. No live reference image exists. Preserve the observed shell, labels, layout and original states. Never introduce new behavior or design improvements. Render all listed original fields/content inside the capture, with one state per supplied inventory. If a view cannot be established from source, do not invent it.'
export const preChangePrototypeContract = 'Return ONLY {"prototypes":[{"id":"PAGE-1","title":"original page","mode":"incremental","sourceAnchor":{"route":"/source-route","layout":"original layout path","pageFile":"original component path"},"html":"<!doctype html>...","states":[{"id":"STATE-1","name":"original view","requirementIds":["SOURCE-1"],"acceptanceIds":["OBS-1"],"changes":[]}]}]}. Use the exact mapping IDs provided for the existing inventories in both state arrays and visible HTML data-requirement-id/data-acceptance-id. Use standalone static HTML/CSS for a 1600x1000 desktop canvas; no scripts, handlers, navigation, external resources or business execution. Use state.capture with mode fullPage, or viewport with scrollTo, when needed to include the original content. Shared pages may have multiple states; do not combine mutually exclusive states into a single invented view.'

export const existingDesignPolicy = 'EXISTING SYSTEM STYLE LOCK: User-supplied brand/design standards and observed neighboring pages take precedence over search recommendations and generic design defaults. Before HTML generation inspect relevant pages, shared layout/navigation, theme tokens, component overrides and typography in the workspace. Preserve evidenced colors, fonts, density, spacing, radii, tables, forms and navigation. Do not invent a new dashboard theme or redesign the application shell. Safety constraints may replace remote assets or executable components with inert equivalents, but must not replace their visual identity. Search results are supplementary UX guidance only. Missing style evidence must block generation rather than silently selecting a new brand.'

export function parseDesignBaseline(content: string, snapshots: WorkspaceSnapshot[]) {
  const fail = (reason: string) => new RequirementDiagnosticError('output_validation', 'DESIGN_STYLE_EVIDENCE', `${reason}；请补充可核实的页面、主题样式或品牌规范，未采用通用风格替代`)
  if (!content || content.length > 40000) throw fail('STYLE_INPUT_SIZE：样式证据为空或超过长度限制')
  const fenced = /^\s*```(?:json)?\s*\r?\n([\s\S]*?)\r?\n?```\s*$/i.exec(content)
  let result: unknown
  try {
    result = JSON.parse(fenced ? fenced[1] : content, (key, value: unknown) => {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw fail('STYLE_UNSAFE_KEY：样式证据包含禁止的属性')
      return value
    })
  } catch (error) {
    if (error instanceof RequirementDiagnosticError) throw error
    throw fail('STYLE_JSON：样式证据不是有效 JSON')
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw fail('STYLE_SCHEMA：样式证据必须为对象')
  const record = result as Record<string, unknown>
  if (Object.keys(record).some(key => !['status', 'tokens'].includes(key))) throw fail('STYLE_SCHEMA：样式证据包含额外字段')
  if (record.status === 'missing') throw fail('STYLE_STATUS_MISSING：模型报告未找到足够的样式证据')
  if (record.status !== 'observed' || !Array.isArray(record.tokens) || record.tokens.length < 2 || record.tokens.length > 24) throw fail('STYLE_SCHEMA：样式证据状态或条目数量无效')
  const categories = new Set<string>()
  for (const entry of record.tokens) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw fail('STYLE_TOKEN_SCHEMA：样式条目必须为对象')
    const token = entry as Record<string, unknown>
    if (Object.keys(token).some(key => !['category', 'value', 'sourceId', 'path', 'quote'].includes(key))) throw fail('STYLE_TOKEN_SCHEMA：样式条目包含额外字段')
    for (const key of ['category', 'value', 'sourceId', 'path', 'quote']) if (typeof token[key] !== 'string' || !token[key] || (token[key] as string).length > 2000) throw fail('STYLE_TOKEN_SCHEMA：样式条目字段缺失、类型或长度无效')
    if (!['color', 'typography', 'spacing', 'component', 'navigation'].includes(token.category as string)) throw fail('STYLE_TOKEN_SCHEMA：样式类别无效')
    const source = snapshots.find(source => source.sourceId === token.sourceId)
    if (!source) throw fail('STYLE_SOURCE_UNKNOWN：样式引用未关联已提供的源码资料')
    const marker = `Path: ${JSON.stringify(token.path)}`
    const start = source.text.indexOf(marker)
    const next = source.text.indexOf('\nPath: ', start + marker.length)
    const section = start < 0 ? '' : source.text.slice(start, next < 0 ? undefined : next)
    if (start < 0) throw fail('STYLE_PATH_NOT_FOUND：样式引用的原始文件路径不在对应快照中')
    if (!section.includes(token.quote as string) && !normalizeCodeSnapshotText(section).includes(normalizeCodeSnapshotText(token.quote as string))) throw fail('STYLE_QUOTE_MISMATCH：样式引用与对应文件的实际代码不一致')
    if (!(token.quote as string).includes(token.value as string)) throw fail('STYLE_VALUE_MISMATCH：样式值未出现在引用的代码中')
    categories.add(token.category as string)
  }
  if (!['color', 'typography'].some(category => categories.has(category)) || !['component', 'navigation'].some(category => categories.has(category))) throw fail('STYLE_CATEGORIES：必须同时提供颜色或字体、以及组件或导航证据')
  return record
}