import type { AcceptanceRequirement } from '../../shared/task.js'
import type { CaseDefinition, PlanningDraft } from '../../shared/testing.js'
import { PlanningError, planningDigest } from './planning-model.js'

const fields = ['id', 'title', 'source', 'steps', 'expected', 'requirementIds', 'scenario', 'preconditions', 'testData', 'assertions', 'cleanup', 'classification']
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 2000
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.length <= 1000 && value.every(text) && new Set(value).size === value.length

export function validatePlanningCase(value: unknown, caseId: string, baseline: AcceptanceRequirement[]): CaseDefinition {
  if (!record(value) || Object.keys(value).some(key => !fields.includes(key)) || value.id !== caseId || !/^TC-\d{1,6}$/.test(caseId)) throw new PlanningError('INVALID_INPUT')
  if (!['title', 'source', 'steps', 'expected', 'preconditions', 'testData', 'cleanup'].every(key => text(value[key])) || !strings(value.assertions) || !strings(value.requirementIds)) throw new PlanningError('INVALID_INPUT')
  if (!['normal', 'boundary', 'negative', 'permission', 'state'].includes(value.scenario as string) || value.requirementIds.some(id => !baseline.some(requirement => requirement.id === id && requirement.scenarios.includes(value.scenario as NonNullable<CaseDefinition['scenario']>)))) throw new PlanningError('INVALID_INPUT')
  if (value.classification !== undefined) {
    const classification = value.classification
    if (!record(classification) || Object.keys(classification).some(key => !['testType', 'tags', 'priority', 'riskReason', 'executionPolicy'].includes(key)) ||
      !['functional', 'performance', 'security', 'compatibility', 'reliability'].includes(classification.testType as string) ||
      !['P0', 'P1', 'P2', 'P3'].includes(classification.priority as string) || !text(classification.riskReason) ||
      !['always', 'on_demand'].includes(classification.executionPolicy as string) || !Array.isArray(classification.tags) || classification.tags.length > 1000 || !classification.tags.every(text) || new Set(classification.tags).size !== classification.tags.length) throw new PlanningError('INVALID_INPUT')
  }
  return structuredClone(value) as unknown as CaseDefinition
}

export function replacePlanningCase(draft: PlanningDraft, caseId: string, value: unknown): PlanningDraft {
  if (!draft.cases.some(item => item.id === caseId)) throw new PlanningError('INVALID_INPUT')
  const replacement = validatePlanningCase(value, caseId, draft.baseline)
  const cases = draft.cases.map(item => item.id === caseId ? replacement : structuredClone(item))
  return { baseline: structuredClone(draft.baseline), cases, sourceFingerprint: draft.sourceFingerprint, definitionFingerprint: planningDigest({ baseline: draft.baseline, cases }), reviewBatches: [] }
}