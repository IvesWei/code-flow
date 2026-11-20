import * as React from 'react'
import { ChevronLeft, ChevronRight, CircleHelp, FileText, ListTree, Minus, PencilLine, Plus } from 'lucide-react'
import { businessChangeColors, type BusinessNote, type BusinessSections } from '../../../shared/business-review'
import type { RequirementRevision, RequirementScreen } from '../../../shared/requirements'

const changeIcons = { 新增: Plus, 变更: PencilLine, 删除: Minus }

function Picture({ revision, projectId, screen }: { revision: RequirementRevision; projectId: string; screen: RequirementScreen }) {
  const [failed, setFailed] = React.useState(false)
  const label = `${screen.title} · ${screen.state}`
  const url = `/api/requirements/projects/${encodeURIComponent(projectId)}/screenshots/${encodeURIComponent(screen.id)}?revision=${encodeURIComponent(revision.id)}`
  if (!revision.screenshots?.some(shot => shot.screenId === screen.id)) return <p role="status">待补图：{label}</p>
  return <figure className="business-picture"><figcaption>{label}</figcaption><a href={url} target="_blank" rel="noopener noreferrer" aria-label={`查看原图：${label}`}>
    {failed ? '查看原图' : <img alt={label} loading="lazy" width={1600} height={1000} src={url} onError={() => setFailed(true)} />}
  </a>{failed && <p role="alert">设计稿截图加载失败。</p>}</figure>
}

export function BusinessPreview({ note, revision, projectId }: { note?: BusinessNote; revision: RequirementRevision; projectId: string }) {
  const [index, setIndex] = React.useState(0)
  const pictures = note && 'pictures' in note ? note.pictures : []
  const current = pictures[index] ?? pictures[0]
  if (!current) return <div className="business-no-design" role="status"><FileText size={22} aria-hidden="true" /><p>{!note ? '暂无业务评审设计稿' : !('scope' in note) ? '变更范围待核对' : note.scope === 'logic' ? '仅调整后台逻辑，无界面设计稿' : '此项界面变更待补图'}</p></div>
  return <div className="business-preview">{pictures.length > 1 && <nav aria-label="变更设计稿"><button type="button" title="上一张设计稿" aria-label="上一张设计稿" disabled={index === 0} onClick={() => setIndex(index - 1)}><ChevronLeft size={16} /></button><span>{index + 1} / {pictures.length}</span><button type="button" title="下一张设计稿" aria-label="下一张设计稿" disabled={index >= pictures.length - 1} onClick={() => setIndex(index + 1)}><ChevronRight size={16} /></button></nav>}
    <Picture key={current.screen.id} revision={revision} projectId={projectId} screen={current.screen} />
  </div>
}

export function BusinessNotes({ sections, revision, projectId, focused, active, onActivate }: { sections: BusinessSections; revision: RequirementRevision; projectId: string; focused: boolean; active?: string; onActivate?(key: string, selectedRequirement?: string): void }) {
  const document = React.useRef<HTMLDivElement>(null)
  const directory = React.useRef<HTMLDetailsElement>(null)
  const pinned = React.useRef('')
  const id = React.useId()
  function activate(key: string, requirementId: string) { pinned.current = key; onActivate?.(key, requirementId) }
  const readNote = React.useEffectEvent((key: string) => onActivate?.(key))
  React.useEffect(() => {
    const pane = document.current?.closest('.requirements-prd-pane')
    if (!pane) return
    let frame = 0
    const measure = () => {
      frame = 0
      const bounds = pane.getBoundingClientRect()
      if (!pane.clientHeight) return
      const visible = Array.from(document.current?.querySelectorAll<HTMLButtonElement>('[data-note-key]') ?? []).filter(button => { const rect = button.getBoundingClientRect(); return rect.bottom > bounds.top && rect.top < bounds.bottom })
      if (visible.some(button => button.dataset.noteKey === pinned.current)) return
      pinned.current = ''
      const target = visible[0]
      if (target?.dataset.noteKey) readNote(target.dataset.noteKey)
    }
    const scroll = () => { if (!frame) frame = requestAnimationFrame(measure) }
    pane.addEventListener('scroll', scroll, { passive: true })
    return () => { pane.removeEventListener('scroll', scroll); cancelAnimationFrame(frame) }
  }, [revision.id])
  return <div className="business-notes" ref={document}><header><h3>{revision.prd.title}</h3>{sections.length > 0 && <details ref={directory}><summary aria-label="业务评审目录" title="业务评审目录"><ListTree size={17} aria-hidden="true" /></summary><nav aria-label="业务变更目录">{sections.map(module => <div key={module.name}><strong>{module.name}</strong>{module.functions.map(item => <button key={item.id} type="button" onClick={() => {
    if (directory.current) directory.current.open = false
    const target = document.current?.ownerDocument.getElementById(`${id}-${item.id}`)
    target?.scrollIntoView({ block: 'nearest' }); target?.focus({ preventScroll: true }); activate((item.changes[0] ?? item.pending[0]).key, item.id)
  }}>{item.title}</button>)}</div>)}</nav></details>}</header>
    {!sections.length && <p>本修订没有已识别的业务变更。</p>}
    {sections.map(module => <section key={module.name} data-prd-module={module.name}><h4>{module.name}</h4>{module.functions.map(item => <article id={`${id}-${item.id}`} key={item.id} tabIndex={-1} data-prd-requirement={item.id}><h5>{item.title}</h5>
      {item.changes.map(change => { const Icon = changeIcons[change.kind]; return <div key={change.key} className="business-note" data-kind={change.kind} style={{ '--note-color': businessChangeColors[change.kind] } as React.CSSProperties}>
        <button data-note-key={change.key} type="button" aria-pressed={active === change.key} onClick={() => activate(change.key, item.id)}><span className="business-note-label"><Icon size={15} aria-hidden="true" />{change.kind}<small>{change.scope === 'logic' ? '后台逻辑' : '界面操作'}</small></span><span className="business-note-text">{change.text}</span></button>
        {change.scope === 'ui' && !change.pictures.length && <small className="business-note-reference">待补图</small>}
        {change.pictures.map(({ owner, screen }) => owner ? <small key={screen.id} className="business-note-reference">见「{owner}」：{screen.title} · {screen.state}</small> : !focused && <Picture key={screen.id} revision={revision} projectId={projectId} screen={screen} />)}
      </div> })}
      {item.pending.map(entry => <div key={entry.key} className="business-note" data-kind="待核对"><button type="button" data-note-key={entry.key} aria-pressed={active === entry.key} onClick={() => activate(entry.key, item.id)}><span className="business-note-label"><CircleHelp size={15} aria-hidden="true" />待核对</span><span className="business-note-text">{entry.text}</span></button></div>)}
    </article>)}</section>)}
  </div>
}