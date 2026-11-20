import { createHash } from 'node:crypto'
import type { RequirementCapturePlan, RequirementProject, RequirementRevision, RequirementScopeBlock, RequirementScopeCheckpoint, StructuredPrd } from '../../shared/requirements.js'
import { RequirementOutputError, validateCaptureMappingPages, validatePrd } from './validation.js'
import { jsonDigest } from '../storage/json-digest.js'

export const sourceFallbackCodes: ReadonlySet<string> = new Set(['PAGE_CAPTURE_TARGET', 'PAGE_CAPTURE_FIELDS', 'PAGE_CAPTURE_NOT_READY', 'PAGE_CAPTURE_HTTP', 'PAGE_CAPTURE_LOGIN', 'PAGE_CAPTURE_RESOURCES', 'PAGE_CAPTURE_BLANK', 'PAGE_CAPTURE_LOAD', 'PAGE_CAPTURE_REDIRECT', 'PAGE_CAPTURE_BROWSER'])

function captureInput(project: RequirementProject, prd: StructuredPrd, blocks: RequirementScopeBlock[] | undefined, policy: string) {
  return {
    policy, preview: project.preview, prd,
    sources: project.sources.map(source => ({ id: source.id, sha256: source.sha256 })),
    ...(blocks ? { blocks, description: project.description, decisions: project.decisions } : {}),
  }
}

export function captureFingerprint(project: RequirementProject, prd: StructuredPrd, blocks?: RequirementScopeBlock[]): string {
  return jsonDigest(captureInput(project, prd, blocks, blocks ? 'classified-scope-v4' : 'prd-first-v2'))
}

export function captureFingerprintMatches(expected: string, project: RequirementProject, prd: StructuredPrd, blocks?: RequirementScopeBlock[]): boolean {
  if (expected === captureFingerprint(project, prd, blocks)) return true
  if (blocks && expected === jsonDigest(captureInput(project, prd, blocks, 'classified-scope-v3'))) return true
  const legacy = (value: StructuredPrd, scope: RequirementScopeBlock[] | undefined) => createHash('sha256').update(JSON.stringify(captureInput(project, value, scope, scope ? 'classified-scope-v2' : 'prd-first-v1'))).digest('hex')
  // Restore legacy writer order after MySQL JSON reordering, retaining all fields and array order.
  const orderedBlocks = blocks?.map(block => Object.assign({ blockId: block.blockId, kind: block.kind, reason: block.reason }, block))
  const matches = (value: StructuredPrd) => expected === legacy(value, blocks) || (!!orderedBlocks && expected === legacy(value, orderedBlocks))
  return matches(prd) || matches(validatePrd(prd, project.sources.map(source => source.id)))
}

function validateClassification(value: unknown, prd: StructuredPrd): RequirementCapturePlan {
  const fail = (): never => { throw new RequirementOutputError('invalid classified capture plan') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  const plan = value as Record<string, unknown>
  if (Object.keys(plan).some(key => !['version', 'fingerprint', 'blocks', 'views', 'sourceFallback'].includes(key)) || plan.version !== 1 || typeof plan.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(plan.fingerprint) || !Array.isArray(plan.blocks) || !plan.blocks.length || plan.blocks.length > 12) return fail()
  const seen = new Set<string>()
  const blocks: RequirementScopeBlock[] = plan.blocks.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
    const block = value as Record<string, unknown>
    if (Object.keys(block).some(key => !['blockId', 'kind', 'reason'].includes(key)) || typeof block.blockId !== 'string' || !prd.blocks.some(entry => entry.id === block.blockId) || seen.has(block.blockId) || (block.kind !== 'existing' && block.kind !== 'new') || typeof block.reason !== 'string' || !block.reason.trim() || block.reason.length > 300) return fail()
    seen.add(block.blockId)
    return { blockId: block.blockId, kind: block.kind, reason: block.reason }
  })
  if (seen.size !== prd.blocks.length) return fail()
  let views: RequirementCapturePlan['views']
  if (plan.views !== undefined) {
    if (!Array.isArray(plan.views) || !plan.views.length || plan.views.length > 12) return fail()
    const seenViews = new Set<string>()
    views = plan.views.map(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
      const view = value as Record<string, unknown>
      if (Object.keys(view).some(key => !['blockId', 'viewId'].includes(key)) || typeof view.blockId !== 'string' || !blocks.some(block => block.blockId === view.blockId && block.kind === 'existing') || typeof view.viewId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(view.viewId)) return fail()
      const key = `${view.blockId}:${view.viewId}`
      if (seenViews.has(key)) return fail()
      seenViews.add(key)
      return { blockId: view.blockId, viewId: view.viewId }
    })
    if (blocks.some(block => block.kind === 'existing' && !views?.some(view => view.blockId === block.blockId))) return fail()
  }
  let sourceFallback: RequirementCapturePlan['sourceFallback']
  if (plan.sourceFallback !== undefined) {
    const raw = plan.sourceFallback as NonNullable<RequirementCapturePlan['sourceFallback']>
    const existing = blocks.filter(block => block.kind === 'existing')
    const labels = (value: unknown) => Array.isArray(value) && value.length <= 960 && value.every(label => typeof label === 'string' && label.trim() && label.length <= 300)
    if (views || !raw || typeof raw !== 'object' || Object.keys(raw).some(key => !['code', 'blocks', 'images'].includes(key)) || !sourceFallbackCodes.has(raw.code) || !existing.length || !Array.isArray(raw.blocks) || raw.blocks.length !== existing.length) return fail()
    const inventories = new Set<string>()
    for (const block of raw.blocks) {
      if (!block || typeof block !== 'object' || Object.keys(block).some(key => !['blockId', 'fields', 'content'].includes(key)) || !existing.some(item => item.blockId === block.blockId) || inventories.has(block.blockId) || !labels(block.fields) || !labels(block.content) || (!block.fields.length && !block.content.length)) return fail()
      inventories.add(block.blockId)
    }
    if (raw.images !== undefined) {
      if (!Array.isArray(raw.images) || raw.images.length !== inventories.size) return fail()
      const ids = new Set<string>()
      for (const entry of raw.images) {
        if (!entry || typeof entry !== 'object' || Object.keys(entry).some(key => !['blockId', 'createdAt', 'image'].includes(key)) || !inventories.delete(entry.blockId) || typeof entry.createdAt !== 'string' || entry.createdAt.length !== 24 || !Number.isFinite(Date.parse(entry.createdAt)) || new Date(entry.createdAt).toISOString() !== entry.createdAt) return fail()
        const image = entry.image
        if (!image || typeof image !== 'object' || Object.keys(image).some(key => !['kind', 'id', 'name', 'sha256', 'sizeBytes', 'storageKey'].includes(key)) || image.kind !== 'file' || typeof image.id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(image.id) || ids.has(image.id) || typeof image.name !== 'string' || !/^source-reconstruction-\d{1,2}\.png$/.test(image.name) || typeof image.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(image.sha256) || !Number.isSafeInteger(image.sizeBytes) || image.sizeBytes < 45 || image.sizeBytes > 10 * 1024 * 1024 || typeof image.storageKey !== 'string' || !image.storageKey.endsWith(`/${image.id}.png`)) return fail()
        ids.add(image.id)
      }
    }
    sourceFallback = raw
  }
  return { version: 1, fingerprint: plan.fingerprint, blocks, ...(views ? { views } : {}), ...(sourceFallback ? { sourceFallback } : {}) }
}

export function validateCapturePlan(value: unknown, prd: StructuredPrd, pages: RequirementRevision['existingPages']): RequirementCapturePlan {
  const plan = validateClassification(value, prd)
  const { blocks } = plan
  const existing = blocks.filter(block => block.kind === 'existing')
  if (plan.sourceFallback) {
    if (pages?.length) throw new RequirementOutputError('source fallback cannot contain runtime captures')
    return plan
  }
  if (plan.views) {
    if (pages?.length !== plan.views.length || plan.views.some(view => pages.filter(page => page.blockId === view.blockId && (page.viewId ?? page.blockId) === view.viewId).length !== 1)) throw new RequirementOutputError('invalid classified capture plan')
  } else if ((pages?.length ?? 0) !== existing.length || existing.some(block => pages?.filter(page => page.blockId === block.blockId).length !== 1) || pages?.some(page => page.viewId !== undefined)) throw new RequirementOutputError('invalid classified capture plan')
  if (pages?.some(page => !existing.some(block => block.blockId === page.blockId) || page.fingerprint !== plan.fingerprint)) throw new RequirementOutputError('invalid classified capture plan')
  return plan
}

export function scopeFingerprint(project: RequirementProject): string {
  return jsonDigest({
    policy: 'functional-scope-checkpoint-v1', title: project.title, description: project.description,
    sources: project.sources, evidence: project.evidence,
    decisions: project.decisions.filter(decision => !decision.question.capture),
  })
}

export function validateScopeCheckpoint(value: unknown, sourceIds: string[]): RequirementScopeCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RequirementOutputError('invalid scope checkpoint')
  const { prd: rawPrd, mapping, ...plan } = value as Record<string, unknown>
  const prd = validatePrd(rawPrd, sourceIds)
  const classification = validateClassification(plan, prd)
  if (classification.sourceFallback) throw new RequirementOutputError('invalid scope checkpoint evidence')
  return { ...classification, prd, ...(mapping !== undefined ? { mapping: validateCaptureMappingPages(mapping, classification.blocks, sourceIds) } : {}) }
}
