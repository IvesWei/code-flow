import type { RequirementCaptureMappingPage, RequirementScopeBlock, StructuredPrd } from '../../shared/requirements.js'
import { requirementPreviewPath } from '../../shared/requirement-preview.js'
import { normalizeCodeSnapshotText } from './code-snapshot.js'
import { RequirementDiagnosticError } from './diagnostics.js'
import { parseCaptureTargets, type CaptureTarget } from './page-capture.js'
import { validateCaptureMappingPages } from './validation.js'
import type { WorkspaceSnapshot } from './workspace.js'

export interface CaptureMappingGap {
  blockId: string
  code: 'entry_context' | 'source_evidence' | 'activation' | 'content'
  reason: string
  entry?: { path: string; queryKeys: string[]; sourceId: string; quote: string }
}
export interface CaptureMappingResult {
  pages: RequirementCaptureMappingPage[]
  targets: CaptureTarget[]
  gaps: CaptureMappingGap[]
  errors: { blockId: string; error: RequirementDiagnosticError }[]
}
const failure = (blockId: string, reason: string) => new RequirementDiagnosticError('output_validation', 'PAGE_MAPPING', `[${blockId}] ${reason}`)
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('mapping', '取证映射必须是对象')
  return value as Record<string, unknown>
}
function parseGap(value: Record<string, unknown>, snapshots: WorkspaceSnapshot[], entries: readonly string[]): CaptureMappingGap {
  const blockId = String(value.blockId)
  const fail = (reason: string): never => { throw failure(blockId, reason) }
  if (Object.keys(value).some(key => !['blockId', 'code', 'reason', 'entry'].includes(key)) || typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 300) return fail('缺口说明格式无效')
  const code = value.code
  if (code !== 'entry_context' && code !== 'source_evidence' && code !== 'activation' && code !== 'content') return fail('缺口类型无效')
  let entry: CaptureMappingGap['entry']
  if (value.entry !== undefined) {
    const proof = record(value.entry)
    if (Object.keys(proof).some(key => !['path', 'queryKeys', 'sourceId', 'quote'].includes(key)) || typeof proof.sourceId !== 'string' || typeof proof.quote !== 'string' || !proof.quote.trim() || proof.quote.length > 2000 || !Array.isArray(proof.queryKeys) || !proof.queryKeys.length || proof.queryKeys.length > 8) return fail('缺失入口需要宿主路径、参数名和源码依据')
    const path = requirementPreviewPath(proof.path)
    if (path.includes('?')) return fail('缺失入口只能声明已核实的 pathname，不得猜测参数值')
    const quote = proof.quote
    if (!snapshots.some(source => source.sourceId === proof.sourceId && normalizeCodeSnapshotText(source.text).includes(normalizeCodeSnapshotText(quote))) || !quote.includes(path)) return fail('缺失入口的宿主路径没有源码依据')
    const queryKeys = proof.queryKeys.map(key => {
      if (typeof key !== 'string') return fail('缺失参数名无效')
      requirementPreviewPath(`/?${new URLSearchParams({ [key]: 'sample' })}`)
      if (!snapshots.some(source => [`"${key}"`, `'${key}'`, `?${key}=`, `&${key}=`].some(literal => source.text.includes(literal)))) return fail('缺失参数名没有源码依据')
      return key
    })
    if (new Set(queryKeys).size !== queryKeys.length) return fail('缺失参数名重复')
    if (code === 'entry_context' && entries.some(value => {
      const url = new URL(value, 'http://localhost')
      return url.pathname === path && queryKeys.every(key => url.searchParams.has(key))
    })) throw new RequirementDiagnosticError('output_validation', 'PAGE_MAPPING_CONTEXT', `[${blockId}] 所需入口及参数已提供，请使用已有入口核实内容，不重复要求用户补充`)
    entry = { path, queryKeys, sourceId: proof.sourceId, quote }
  }
  if (code === 'entry_context' && !entry) return fail('入口缺口必须说明具体宿主路径、所需参数和源码依据')
  return { blockId, code, reason: value.reason, ...(entry ? { entry } : {}) }
}

export function parseCaptureMapping(content: string, prd: StructuredPrd, snapshots: WorkspaceSnapshot[], scope: RequirementScopeBlock[], approvedEntries: readonly string[], saved: RequirementCaptureMappingPage[] = [], previousGaps: CaptureMappingGap[] = []): CaptureMappingResult {
  let response: Record<string, unknown>
  try {
    if (content.length > 200000) throw new Error('size')
    const fenced = /^\s*```(?:json)?\s*\r?\n([\s\S]*?)\r?\n?```\s*$/i.exec(content)
    response = record(JSON.parse(fenced ? fenced[1] : content, (key, value: unknown) => {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('key')
      return value
    }))
    if (Object.keys(response).some(key => !['pages', 'gaps'].includes(key)) || !Array.isArray(response.pages) || response.pages.length > 12 || (response.gaps !== undefined && (!Array.isArray(response.gaps) || response.gaps.length > 12))) throw new Error('schema')
  } catch { throw failure('mapping', '模型必须返回 pages 和可选 gaps；不能用空数组隐藏所有区块的具体缺口') }
  const pages = new Map<string, RequirementCaptureMappingPage>()
  const targets = new Map<string, CaptureTarget[]>()
  const errors = new Map<string, RequirementDiagnosticError>()
  const gaps = new Map<string, CaptureMappingGap>()
  const inspectPage = (value: unknown) => {
    const page = record(value)
    const block = scope.find(block => block.blockId === page.blockId)
    const prdBlock = prd.blocks.find(block => block.id === page.blockId)
    if (!block || !prdBlock) throw failure('mapping', '模型返回未知区块')
    try {
      const pageTargets = parseCaptureTargets(JSON.stringify({ pages: [page] }), { ...prd, blocks: [prdBlock] }, snapshots, [block], approvedEntries)
      if (block.kind === 'new') return
      if (pageTargets.some(target => !target.expectedFields?.length && !target.expectedContent?.length)) throw new RequirementDiagnosticError('output_validation', 'PAGE_CAPTURE_FIELDS', `[${block.blockId}] 取证映射缺少已有字段或业务内容，请补查源码`)
      const [validated] = validateCaptureMappingPages([page], [block], snapshots.map(source => source.sourceId))
      pages.set(block.blockId, validated)
      targets.set(block.blockId, pageTargets)
      gaps.delete(block.blockId)
      errors.delete(block.blockId)
    } catch (error) {
      errors.set(block.blockId, error instanceof RequirementDiagnosticError ? error : failure(block.blockId, '区块映射未通过路径、来源或内容校验'))
    }
  }
  for (const page of saved) inspectPage(page)
  for (const gap of previousGaps) {
    if (pages.has(gap.blockId)) continue
    try { gaps.set(gap.blockId, parseGap(record(gap), snapshots, approvedEntries)) }
    catch (error) { errors.set(gap.blockId, error instanceof RequirementDiagnosticError ? error : failure(gap.blockId, '旧缺口需要重新核实')) }
  }
  const seen = new Set<string>()
  for (const value of response.pages as unknown[]) {
    const page = record(value)
    if (typeof page.blockId !== 'string' || seen.has(page.blockId)) throw failure('mapping', '区块映射重复或无效')
    seen.add(page.blockId)
    inspectPage(page)
  }
  for (const value of (response.gaps ?? []) as unknown[]) {
    const gap = record(value)
    const block = scope.find(block => block.blockId === gap.blockId && block.kind === 'existing')
    if (!block || seen.has(block.blockId)) throw failure('mapping', '缺口区块重复、未知或改变已确认分类')
    seen.add(block.blockId)
    if (pages.has(block.blockId)) continue
    try { gaps.set(block.blockId, parseGap(gap, snapshots, approvedEntries)); errors.delete(block.blockId) }
    catch (error) { errors.set(block.blockId, error instanceof RequirementDiagnosticError ? error : failure(block.blockId, '缺口路径或参数格式无效')) }
  }
  for (const block of scope.filter(block => block.kind === 'existing')) {
    if (!pages.has(block.blockId) && !gaps.has(block.blockId) && !errors.has(block.blockId)) errors.set(block.blockId, new RequirementDiagnosticError('output_validation', 'PAGE_MAPPING_INCOMPLETE', `[${block.blockId}] 模型未返回此区块的映射或具体缺口；请逐块补查，不清空其他区块`))
  }
  const orderedTargets = scope.flatMap(block => targets.get(block.blockId) ?? [])
  if (orderedTargets.length > 12) throw failure('mapping', '全部区块展开后超过 12 个取证视图，请收敛取证范围')
  return { pages: scope.flatMap(block => pages.has(block.blockId) ? [pages.get(block.blockId)!] : []), targets: orderedTargets, gaps: [...gaps.values()], errors: [...errors].map(([blockId, error]) => ({ blockId, error })) }
}
