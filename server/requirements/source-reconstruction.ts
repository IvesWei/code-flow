import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RequirementModelResult, RequirementProject, RequirementRevision, StructuredPrd } from '../../shared/requirements.js'
import { readRequirementScreenshot, validatePrototypeRevision } from './artifacts.js'
import { scopeFingerprint } from './capture-plan.js'
import { preChangeDesignPolicy } from './design-baseline.js'
import { RequirementDiagnosticError } from './diagnostics.js'
import { validatePrototypeDesign } from './prototype-design.js'
import { storeSourceFile } from './sources.js'

export function sourceReconstructionInput(project: RequirementProject, revision: RequirementRevision): RequirementProject {
  const inventories = revision.capturePlan?.sourceFallback?.blocks
  const sources = project.sources.filter(source => source.kind === 'file' && source.name === 'existing-project-code.md')
  if (!inventories?.length || !sources.length) throw new RequirementDiagnosticError('sources', 'SOURCE_RECONSTRUCTION', '缺少已有区块的源码取证依据')
  const sourceIds = sources.map(source => source.id)
  const mappings = project.scopeCheckpoint?.fingerprint === scopeFingerprint(project) ? project.scopeCheckpoint.mapping : undefined
  const requirements = inventories.map((entry, index) => {
    const mapping = mappings?.find(page => page.blockId === entry.blockId)
    const location = mapping && { path: mapping.path.split('?')[0], activate: mapping.activate, dialog: mapping.openDialog, views: mapping.discover?.map(view => ({ path: view.path, tabs: view.tabs, fields: view.expectedFields, content: view.expectedContent })) }
    return { id: `SOURCE-${index + 1}`, title: `Existing view ${index + 1}`, description: JSON.stringify({ location, fields: entry.fields, content: entry.content }), sourceIds, acceptance: [{ id: `OBS-${index + 1}`, text: 'The original labels and source-backed layout are visible.' }] }
  })
  const prd: StructuredPrd = { title: 'Existing system', summary: preChangeDesignPolicy, requirements, blocks: inventories.map((entry, index) => ({ id: entry.blockId, title: requirements[index].title, content: requirements[index].description, sourceIds, requirementIds: [requirements[index].id] })) }
  return {
    schemaVersion: 1, id: project.id, ownerId: project.ownerId, version: project.version, modelId: project.modelId, createdAt: project.createdAt, updatedAt: project.updatedAt,
    status: 'prd_review', title: prd.title, description: preChangeDesignPolicy, sources, evidence: [], decisions: [], questions: [], events: [], jobs: [],
    sourceAnchors: project.sourceAnchors?.filter(anchor => sourceIds.includes(anchor.sourceId)).map(({ sourceId, pageFile, layout, route, position, menu }) => ({ sourceId, pageFile, layout, route, position, menu, domain: pageFile, summary: 'Inspect the existing component and its imports.' })),
    revisions: [{ id: randomUUID(), createdAt: revision.createdAt, prd, screens: [] }],
  }
}

export async function renderSourceReconstruction(input: RequirementProject, original: RequirementRevision, result: RequirementModelResult, root: string, signal: AbortSignal) {
  const revision = input.revisions[0]
  const inventories = original.capturePlan!.sourceFallback!.blocks
  if (!result.prototypes?.length || result.prototypes.some(page => page.mode !== 'incremental' || !page.sourceAnchor)) throw new RequirementDiagnosticError('output_validation', 'SOURCE_RECONSTRUCTION', '原系统复刻缺少源码锚点')
  const design = validatePrototypeDesign(result.prototypes.map(prototype => ({ ...prototype, states: prototype.states.map(state => ({ ...state, id: randomUUID() })) })), revision.prd)
  const screens = revision.prd.requirements.map(requirement => design.screens.filter(screen => screen.requirementIds.length === 1 && screen.requirementIds[0] === requirement.id))
  if (design.screens.length !== inventories.length || screens.some(group => group.length !== 1)) throw new RequirementDiagnosticError('output_validation', 'SOURCE_RECONSTRUCTION', '复刻图必须逐一对应已有源码区块')
  const expected = new Map(screens.map(([screen], index) => [screen.id, [...inventories[index].fields, ...inventories[index].content]]))
  const temporary = await mkdtemp(join(tmpdir(), 'codeflow-source-reconstruction-'))
  try {
    const captured = await validatePrototypeRevision(input, { ...revision, ...design }, temporary, signal, expected)
    if (!captured.validation.allScreensValidated || captured.screenshots?.length !== inventories.length) throw new RequirementDiagnosticError('prototype_validation', 'SOURCE_RECONSTRUCTION', '源码复刻未通过静态检查，或未展示完整的既有字段与内容；未保存为图像证据')
    const createdAt = new Date().toISOString()
    const images = []
    for (const [index, [screen]] of screens.entries()) {
      signal.throwIfAborted()
      const buffer = await readRequirementScreenshot(input, captured, screen.id, temporary)
      const image = await storeSourceFile(root, input.ownerId, input.id, `source-reconstruction-${index + 1}.png`, buffer)
      images.push({ blockId: inventories[index].blockId, createdAt, image })
    }
    return images
  } finally { await rm(temporary, { recursive: true, force: true }) }
}