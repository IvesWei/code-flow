import type { StructuredPrd } from './requirements.js'

export function prdSections(prd: StructuredPrd) {
  const assigned = new Set<string>()
  const sections = prd.blocks.map(block => {
    const requirements = prd.requirements.filter(requirement => block.requirementIds.includes(requirement.id) && !assigned.has(requirement.id))
    requirements.forEach(requirement => assigned.add(requirement.id))
    return { block, requirements }
  })
  return { sections, unassigned: prd.requirements.filter(requirement => !assigned.has(requirement.id)) }
}