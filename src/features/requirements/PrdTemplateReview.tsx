import * as React from 'react'
import type { RequirementRevision, StructuredPrd } from '../../../shared/requirements'
import { prdTemplateOutline, type PrdEdition, type PrdOutlineLine } from '../../../shared/prd-template'
import { businessReviewSections } from '../../../shared/business-review'
import { BusinessNotes } from './BusinessReview'

function PrdScreenshot({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = React.useState(false)
  return failed ? <p role="alert">设计稿截图加载失败，请刷新页面或重新验证该修订。</p> : <img loading="lazy" width={1600} height={1000} src={src} alt={alt} onError={() => setFailed(true)} />
}

export function PrdTemplateReview({ prd, edition, selectedId, onSelect, revision, projectId, focused = false, activeNote, onNote }: {
  prd: StructuredPrd
  edition: PrdEdition
  selectedId: string
  onSelect: (id: string, pointer: boolean) => void
  revision?: RequirementRevision
  projectId?: string
  focused?: boolean
  activeNote?: string
  onNote?(key: string, selectedRequirement?: string): void
}) {
  if (edition === 'business' && revision && revision.businessReview?.revisionId === revision.id) return <BusinessNotes revision={revision} projectId={projectId ?? ''} sections={businessReviewSections(revision)} focused={focused} active={activeNote} onActivate={onNote} />
  if (edition === 'business') return <><h3>{prd.title}</h3><p>本修订尚未整理业务变更清单。</p></>
  const design = (id: string) => {
    const screens = revision?.screens.filter(screen => screen.requirementIds.includes(id)) || []
    if (!screens.length) return <li>{prd.requirements.find(item => item.id === id)?.nonVisualReason || '待生成设计稿'}</li>
    return screens.map(screen => <li key={screen.id}><figure><figcaption>{screen.title} · {screen.state}</figcaption>
      {projectId && revision?.screenshots?.some(shot => shot.screenId === screen.id)
        ? <PrdScreenshot key={revision.id} alt={`${screen.title} · ${screen.state}设计稿`} src={`/api/requirements/projects/${encodeURIComponent(projectId)}/screenshots/${encodeURIComponent(screen.id)}?revision=${encodeURIComponent(revision.id)}`} />
        : <p>该状态尚无截图，请先检查静态设计。</p>}
    </figure></li>)
  }
  const renderLine = (entry: PrdOutlineLine, index: number) => <li key={index}>
    {entry.bold ? <strong>{entry.text}</strong> : entry.text}
    {entry.designFor ? <ul>{design(entry.designFor)}</ul> : !!entry.children?.length && <ul>{entry.children.map(renderLine)}</ul>}
  </li>
  return <>
    <h3>{prd.title}</h3>
    <ul className="requirements-template-outline">{prdTemplateOutline(prd, edition).map(module => <li key={module.name}>
      <section className="requirements-template-module" data-prd-module={module.name} tabIndex={-1} aria-label={module.name}>
        <strong>{module.title}</strong>
        {module.functions.map(item => <article key={item.id} className="requirements-template-function" data-prd-requirement={item.id} data-prd-page={prd.blocks.find(block => block.requirementIds.includes(item.id))?.id} data-selected={selectedId === item.id} tabIndex={-1}>
          <ul className="requirements-template-function-lines">
            <li><button type="button" aria-pressed={selectedId === item.id} onClick={event => onSelect(item.id, event.detail > 0)}>{item.title}</button></li>
            <li>{item.scenario}</li>
            <li>{item.capability ? `功能描述：${item.capability}` : '功能描述：'}<ul>{item.lines.map(renderLine)}</ul></li>
          </ul>
        </article>)}
      </section>
    </li>)}</ul>
  </>
}
