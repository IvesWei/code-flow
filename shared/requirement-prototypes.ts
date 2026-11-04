import type { RequirementRevision } from './requirements.js'

export function prototypeScreens(revision: RequirementRevision, screenId: string) {
  const selected = revision.screens.find(screen => screen.id === screenId)
  if (!selected) return []
  if (selected.prototypeId) return revision.screens.filter(screen => screen.prototypeId === selected.prototypeId)
  const blocks = revision.prd.blocks.filter(block => block.requirementIds.some(id => selected.requirementIds.includes(id)))
  return revision.screens.filter(screen => screen.title === selected.title && (screen.id === selected.id || blocks.some(block => block.requirementIds.some(id => screen.requirementIds.includes(id)))))
}