import type { RequirementRevision } from '../../../shared/requirements'

export function designPageOptions(revision: RequirementRevision) {
  const groups = new Map<string, { value: string; label: string; group: string; description: string; title: string }[]>()
  for (const screen of revision.screens) {
    const block = revision.prd.blocks.map(item => ({ item, count: item.requirementIds.filter(id => screen.requirementIds.includes(id)).length })).sort((first, second) => second.count - first.count)[0]
    const group = block?.count ? block.item.module || block.item.title : '其他页面'
    const base = screen.title.split(/[·；;｜|/]/)[0].trim().replace(/(?:页面|页)$/, '') || '设计'
    const name = Array.from(base).slice(0, 12).join('')
    const label = `${name}页`
    const options = groups.get(group) || []
    options.push({ value: screen.id, label, group, description: screen.state, title: `${screen.title} · ${screen.state}` })
    groups.set(group, options)
  }
  return Array.from(groups.values()).flat()
}