import type { StructuredPrd } from './requirements.js'

export function prdSections(prd: StructuredPrd) {
  const assigned = new Set<string>()
  const sections = prd.blocks.map(block => {
    const requirements = prd.requirements.filter(requirement => block.requirementIds.includes(requirement.id) && !assigned.has(requirement.id))
    requirements.forEach(requirement => assigned.add(requirement.id))
    return { block, requirements }
  })
  const modules = new Map<string, typeof sections>()
  for (const section of sections) {
    const name = section.block.module || '未分组功能'
    const pages = modules.get(name) || []
    pages.push(section)
    modules.set(name, pages)
  }
  return { sections, modules, unassigned: prd.requirements.filter(requirement => !assigned.has(requirement.id)) }
}

export function prdTextItems(text: string) {
  return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
}