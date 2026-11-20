import type { RequirementModelResult, RequirementPrdAudit, RequirementPrdCheckpoint, RequirementPrdGrounding, RequirementProject, StructuredPrd } from '../../shared/requirements.js'
import { jsonDigest } from '../storage/json-digest.js'
import { captureFingerprint, scopeFingerprint, sourceFallbackCodes, validateCapturePlan } from './capture-plan.js'
import { parseCaptureMapping } from './capture-mapping.js'
import { normalizeFieldLabel } from './code-snapshot.js'
import { RequirementDiagnosticError } from './diagnostics.js'
import type { WorkspaceSnapshot } from './workspace.js'

function verifyGrounding(project: RequirementProject, scope: StructuredPrd, grounding: RequirementPrdGrounding) {
  const { blocks, pages, sourceFallback } = grounding
  if (!Array.isArray(pages) || sourceFallback?.images || pages.some(page => !(JSON.parse(page.structure) as { regions?: { width: number; height: number }[] }).regions?.some(region => region.width > 0 && region.height > 0))) throw new RequirementDiagnosticError('output_validation', 'PAGE_CAPTURE_BASELINE', 'PRD 前置取证缺少可见业务区域或混入复刻图片，已停止生成')
  const fingerprint = captureFingerprint(project, scope, blocks)
  const views = pages.some(page => page.viewId) ? pages.map(page => ({ blockId: page.blockId, viewId: page.viewId ?? page.blockId })) : undefined
  return validateCapturePlan({ version: 1, fingerprint, blocks, ...(views ? { views } : {}), ...(sourceFallback ? { sourceFallback } : {}) }, scope, pages)
}

export function finishGroundedPrd(project: RequirementProject, prd: StructuredPrd, grounding: RequirementPrdGrounding): RequirementModelResult {
  const { blocks, pages, sourceFallback } = grounding
  if (jsonDigest(prd.blocks.map(block => block.id).sort()) !== jsonDigest(blocks.map(block => block.blockId).sort())) throw new RequirementDiagnosticError('output_validation', 'PAGE_MAPPING', 'PRD 页面区块与前置取证范围不一致，已停止保存')
  for (const inventory of sourceFallback?.blocks ?? pages.map(page => ({ blockId: page.blockId, fields: (JSON.parse(page.structure) as { fields?: string[] }).fields ?? [] }))) {
    const block = prd.blocks.find(block => block.id === inventory.blockId)!
    const declared = new Set(prd.requirements.filter(item => block.requirementIds.includes(item.id)).flatMap(item => item.fields?.map(field => normalizeFieldLabel(field.name)) ?? []))
    if (inventory.fields.some(field => !declared.has(normalizeFieldLabel(field)))) throw new RequirementDiagnosticError('output_validation', 'PAGE_CAPTURE_FIELDS', 'PRD 遗漏已取证的现有字段，未保存不完整 PRD')
  }
  const fingerprint = captureFingerprint(project, prd, blocks), existingPages = pages.map(page => ({ ...page, fingerprint }))
  return { prd, ...(sourceFallback ? {} : { existingPages }), capturePlan: verifyGrounding(project, prd, { ...grounding, pages: existingPages }) }
}

export function restorePrdCheckpoint(project: RequirementProject, audit: RequirementPrdAudit, fingerprint: string, snapshots: WorkspaceSnapshot[], entries: string[]): RequirementPrdCheckpoint | undefined {
  const scope = project.scopeCheckpoint
  try {
    const validScope = scope && scope.fingerprint === scopeFingerprint(project) ? scope : undefined
    if (audit.checkpoint) {
      const saved = audit.checkpoint as unknown as RequirementPrdCheckpoint
      if (saved.version !== 1 || saved.fingerprint !== fingerprint || (saved.candidate !== undefined && (typeof saved.candidate !== 'string' || !saved.candidate.trim() || saved.candidate.length > 2000000))) return
      if (!!project.preview !== !!saved.grounding) return
      if (saved.grounding) {
        if (!validScope || jsonDigest(saved.grounding.blocks) !== jsonDigest(validScope.blocks)) return
        verifyGrounding(project, validScope.prd, saved.grounding)
      }
      return saved
    }
    const legacy = audit.legacy, prior = project.jobs.at(-2)
    if (!legacy || !prior || prior.stage !== 'prd' || prior.status !== 'failed' || !prior.error?.startsWith('[OUTPUT_VALIDATION]') || !prior.endedAt || !project.preview || !validScope?.mapping || project.sources.some(source => source.kind !== 'file')) return
    if (!project.events.at(-1)?.text.startsWith(`failure:${prior.id} `) || project.events.at(-1)!.at > prior.endedAt || legacy.start.stage !== 'prd' || legacy.start.purpose !== 'prd-authoring' || legacy.start.model !== project.modelId || legacy.start.prdRevisionId !== project.revisions.at(-1)?.id) return
    if (!legacy.candidate.trim() || legacy.candidate.length > 2000000 || legacy.prompt.length > 2000000) return
    const sources = project.sources.map(({ id, name, kind, sha256, sizeBytes }) => ({ id, name, kind, sha256, sizeBytes }))
    if (jsonDigest(legacy.start.sources) !== jsonDigest(sources)) return
    const marker = '\nUNTRUSTED INPUT DATA:\n', offset = legacy.prompt.lastIndexOf(marker)
    if (offset < 0) return
    const [input, notice] = legacy.prompt.slice(offset + marker.length).split('\n', 2)
    const data = JSON.parse(input)
    if (data.title !== project.title || data.description !== project.description || ['questions', 'decisions', 'evidence', 'sourceAnchors'].some(key => jsonDigest(data[key] ?? null) !== jsonDigest(project[key as 'questions' | 'decisions' | 'evidence' | 'sourceAnchors'] ?? null))) return
    const fallbackEvents = project.events.filter(event => event.at >= prior.startedAt && event.at <= prior.endedAt! && event.text.startsWith('真实页面取证未通过（'))
    const code = fallbackEvents.length === 1 && /^真实页面取证未通过（(PAGE_CAPTURE_[A-Z_]+)）；使用已核实源码继续生成，复刻原型不代表真实运行态。$/.exec(fallbackEvents[0].text)?.[1]
    if (!code || !sourceFallbackCodes.has(code)) return
    const mapping = parseCaptureMapping('{"pages":[]}', validScope.prd, snapshots, validScope.blocks, entries, validScope.mapping)
    if (mapping.errors.length || mapping.gaps.length) return
    const sourceFallback = { code, blocks: validScope.blocks.filter(block => block.kind === 'existing').map(({ blockId }) => {
      const targets = mapping.targets.filter(target => target.blockId === blockId)
      return { blockId, fields: [...new Set(targets.flatMap(target => target.expectedFields ?? []))], content: [...new Set(targets.flatMap(target => target.expectedContent ?? []))] }
    }) }
    if (!notice?.startsWith(`GENERATE PRD FROM VERIFIED SOURCE ONLY: Live capture failed (${code}). Use the inspected source inventory ${JSON.stringify(sourceFallback.blocks)} mapped to scope blocks `)) return
    const grounding = { blocks: validScope.blocks, pages: [], sourceFallback }
    verifyGrounding(project, validScope.prd, grounding)
    return { version: 1, fingerprint, grounding, candidate: legacy.candidate }
  } catch { return undefined }
}