import * as React from 'react'
import { ListTree, Pencil, Save, X } from 'lucide-react'
import type { StructuredPrd } from '../../../shared/requirements'
import { prdSections } from '../../../shared/prd-sections'

export function parsePrd(text: string): StructuredPrd {
  const value = JSON.parse(text) as StructuredPrd
  const strings = (items: unknown): items is string[] => Array.isArray(items) && items.every(item => typeof item === 'string')
  if (!value || typeof value.title !== 'string' || typeof value.summary !== 'string' || !Array.isArray(value.blocks) || !Array.isArray(value.requirements)) throw new Error('PRD 必须包含 title、summary、blocks 和 requirements')
  const ids = new Set<string>()
  for (const item of value.requirements) {
    if (!item || typeof item.id !== 'string' || !item.id.trim() || ids.has(item.id) || typeof item.title !== 'string' || typeof item.description !== 'string' || !strings(item.sourceIds) || !Array.isArray(item.acceptance) || item.acceptance.some(criterion => !criterion || typeof criterion.id !== 'string' || typeof criterion.text !== 'string') || (item.nonVisualReason !== undefined && typeof item.nonVisualReason !== 'string')) throw new Error('需求 ID 必须唯一，且需求、验收标准和来源字段必须完整')
    ids.add(item.id)
    if (item.scenario !== undefined && typeof item.scenario !== 'string') throw new Error('对应场景必须为文本')
    if (item.fields !== undefined && (!Array.isArray(item.fields) || item.fields.some(field => !field || typeof field.name !== 'string' || !field.name.trim() || typeof field.description !== 'string'))) throw new Error('字段信息必须包含名称和描述')
  }
  const blockIds = new Set<string>()
  for (const block of value.blocks) {
    if (!block || typeof block.id !== 'string' || !block.id.trim() || blockIds.has(block.id) || typeof block.title !== 'string' || typeof block.content !== 'string' || !strings(block.requirementIds) || block.requirementIds.some(id => !ids.has(id)) || !strings(block.sourceIds)) throw new Error('章节字段不完整，或引用了未知需求 ID')
    blockIds.add(block.id)
    if (block.module !== undefined && (typeof block.module !== 'string' || !block.module.trim())) throw new Error('功能模块名称不能为空')
    if (block.table && (!strings(block.table.columns) || !Array.isArray(block.table.rows) || block.table.rows.some(row => !strings(row) || row.length !== block.table!.columns.length))) throw new Error('表格行必须与 columns 列数一致')
  }
  return value
}

export function PrdReview({ prd, readOnly, busy, selectedId, selectionVersion = 0, reviewMode = false, onRead, onSelect, onSave, onEditing }: {
  prd: StructuredPrd
  readOnly: boolean
  busy: boolean
  selectedId: string
  selectionVersion?: number
  reviewMode?: boolean
  onRead?: (id: string) => void
  onSelect: (id: string) => void
  onSave: (prd: StructuredPrd) => Promise<void>
  onEditing: (editing: boolean) => void
}) {
  const [editing, setEditing] = React.useState(false)
  const [text, setText] = React.useState('')
  const [error, setError] = React.useState('')
  const content = React.useRef<HTMLDivElement>(null)
  const editor = React.useRef<HTMLTextAreaElement>(null)
  const [directoryOpen, setDirectoryOpen] = React.useState(false)
  const [directoryTarget, setDirectoryTarget] = React.useState('')
  const directoryId = React.useId()
  const directoryTrigger = React.useRef<HTMLButtonElement>(null)
  const reportReading = React.useEffectEvent((id: string) => onRead?.(id))
  React.useEffect(() => {
    const pane = content.current?.closest<HTMLElement>('.requirements-prd-pane')
    if (!pane || editing) return
    let frame = 0
    let previous = ''
    const measure = () => {
      frame = 0
      const bounds = pane.getBoundingClientRect()
      if (!pane.clientHeight || bounds.bottom <= 0 || bounds.top >= innerHeight) return
      const top = Math.max(0, bounds.top) + 32
      const bottom = Math.min(innerHeight, bounds.bottom)
      const visible = Array.from(content.current?.querySelectorAll<HTMLElement>('[data-prd-requirement]') || []).filter(element => {
        const rect = element.getBoundingClientRect()
        return rect.bottom > top && rect.top < bottom
      })
      const current = visible[0]?.dataset.prdRequirement
      if (current && current !== previous) { previous = current; reportReading(current) }
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure) }
    pane.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('scroll', schedule, { passive: true, capture: true })
    window.addEventListener('resize', schedule)
    const observer = new ResizeObserver(schedule)
    observer.observe(pane)
    if (content.current) observer.observe(content.current)
    schedule()
    return () => {
      cancelAnimationFrame(frame)
      pane.removeEventListener('scroll', schedule)
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      observer.disconnect()
    }
  }, [prd, editing, reviewMode])
  const { sections, unassigned } = prdSections(prd)
  const modules = new Map<string, typeof sections>()
  for (const section of sections) {
    const name = section.block.module || '未分组功能'
    const pages = modules.get(name) || []
    pages.push(section)
    modules.set(name, pages)
  }
  const locate = (attribute: string, value: string) => {
    const element = Array.from(content.current?.querySelectorAll<HTMLElement>(`[${attribute}]`) || []).find(item => item.getAttribute(attribute) === value)
    const pane = element?.closest<HTMLElement>('.requirements-prd-pane')
    if (!element || !pane) return
    pane.scrollTo({ top: pane.scrollTop + element.getBoundingClientRect().top - pane.getBoundingClientRect().top - 16, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
    element.focus({ preventScroll: true })
    setDirectoryTarget(`${attribute}:${value}`)
  }
  React.useEffect(() => { setDirectoryOpen(false); setDirectoryTarget('') }, [reviewMode, prd, editing])
  const directoryNode = (label: string, attribute: string, value: string) => <button type="button" aria-current={directoryTarget === `${attribute}:${value}` ? 'location' : undefined} onClick={() => locate(attribute, value)}>{label}</button>
  const textItems = (text: string) => text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const renderRequirement = (item: StructuredPrd['requirements'][number]) => <li key={item.id} className="requirements-prd-function"><article tabIndex={-1} data-prd-requirement={item.id} data-selected={selectedId === item.id}>
    <ul className="requirements-function-outline">
      <li>功能名称：<button aria-pressed={selectedId === item.id} onClick={() => onSelect(item.id)}>{item.title}</button></li>
      <li>对应场景：{item.scenario || '--'}</li>
      <li>功能描述：<ul className="requirements-description-list">
        {textItems(item.description).map((text, index) => <li key={index}>{text}</li>)}
        {!!item.fields?.length && <li>包含以下字段<ul className="requirements-field-list" aria-label={`${item.title}字段`}>{item.fields.map((field, index) => <li key={index}>{field.name}{field.description && <ul>{textItems(field.description).map((text, detailIndex) => <li key={detailIndex}>{text}</li>)}</ul>}</li>)}</ul></li>}
        {item.nonVisualReason && <li>非视觉需求：{item.nonVisualReason}</li>}
      </ul></li>
    </ul>
    {item.sourceIds.length > 0 && <details><summary>需求来源</summary><small>{item.sourceIds.join('、')}</small></details>}
  </article></li>
  React.useEffect(() => {
    if (!selectedId) return
    const element = Array.from(content.current?.querySelectorAll<HTMLElement>('[data-prd-requirement]') || []).find(item => item.dataset.prdRequirement === selectedId)
    const pane = element?.closest<HTMLElement>('.requirements-prd-pane')
    if (element && pane) {
      const target = element.getBoundingClientRect()
      const bounds = pane.getBoundingClientRect()
      pane.scrollTo({ top: pane.scrollTop + target.top - bounds.top - 16, behavior: 'smooth' })
    }
    element?.focus({ preventScroll: true })
  }, [selectedId, selectionVersion])
  React.useEffect(() => { if (editing) editor.current?.focus() }, [editing])
  function finish() { setEditing(false); onEditing(false); setError('') }
  return <div className="requirements-prd" ref={content}>
    {reviewMode && !editing && <div className="requirements-prd-directory" data-open={directoryOpen} onPointerEnter={event => { if (event.pointerType === 'mouse') setDirectoryOpen(true) }} onPointerLeave={event => { if (event.pointerType === 'mouse') setDirectoryOpen(false) }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget) && !event.currentTarget.matches(':hover')) setDirectoryOpen(false) }} onKeyDown={event => {
      if (event.key === 'Escape' && directoryOpen) { event.preventDefault(); event.stopPropagation(); setDirectoryOpen(false); directoryTrigger.current?.focus() }
    }}>
      <button ref={directoryTrigger} type="button" className="requirements-directory-trigger" aria-label="PRD 目录" title="PRD 目录" aria-expanded={directoryOpen} aria-controls={directoryId} onClick={() => setDirectoryOpen(open => !open)}><ListTree size={16} /></button>
      <nav id={directoryId} aria-label="PRD 目录" className="requirements-directory-drawer" inert={!directoryOpen}>
        <h3>PRD 目录</h3>
        <ul>{Array.from(modules, ([name, pages]) => <li key={name}>{directoryNode(name, 'data-prd-module', name)}<ul>{pages.map(({ block, requirements }) => <li key={block.id}>{directoryNode(block.title, 'data-prd-page', block.id)}<ul>{requirements.map(item => <li key={item.id}>{directoryNode(item.title, 'data-prd-requirement', item.id)}</li>)}</ul></li>)}</ul></li>)}
        {unassigned.length > 0 && <li>{directoryNode('其他功能', 'data-prd-unassigned', 'true')}<ul>{unassigned.map(item => <li key={item.id}>{directoryNode(item.title, 'data-prd-requirement', item.id)}</li>)}</ul></li>}</ul>
      </nav>
    </div>}
    <div className="requirements-toolbar"><h2>PRD</h2>{!readOnly && !editing && <button disabled={busy} onClick={() => { setText(JSON.stringify(prd, null, 2)); setEditing(true); onEditing(true) }}><Pencil size={15} />编辑 JSON</button>}</div>
    {editing ? <form onSubmit={event => {
      event.preventDefault(); setError('')
      void (async () => { try { await onSave(parsePrd(text)); finish() } catch (caught) { setError(caught instanceof Error ? caught.message : '保存失败') } })()
    }}>
      <label>PRD JSON<textarea ref={editor} spellCheck={false} rows={25} value={text} disabled={busy} onChange={event => setText(event.target.value)} /></label>
      {error && <p role="alert" className="requirements-error">{error}</p>}
      <div className="requirements-toolbar"><button disabled={busy} type="submit"><Save size={15} />保存 PRD</button><button type="button" disabled={busy} onClick={finish}><X size={15} />放弃编辑</button></div>
    </form> : <>
      <h3>{prd.title}</h3><p className="requirements-prewrap">{prd.summary}</p>
      <ul className="requirements-module-outline">{Array.from(modules, ([name, pages]) => <li key={name}><section className="requirements-prd-module" aria-label={name} data-prd-module={name} tabIndex={-1}>
        <h3>模块：{name}</h3>
        {pages.map(({ block, requirements }) => <section key={block.id} className="requirements-prd-page" aria-label={block.title} data-prd-page={block.id} tabIndex={-1}>
        <ul className="requirements-function-list">{requirements.map(renderRequirement)}</ul>
        <details className="requirements-page-context"><summary>页面说明：{block.title}</summary><p className="requirements-prewrap">{block.content}</p>
        {block.table && <ul className="requirements-field-list" aria-label={`${block.title}字段`}>{block.table.rows.map((row, index) => <li key={index}>{block.table!.columns[0]}：{row[0]}<ul>{row.slice(1).map((cell, cellIndex) => <li key={cellIndex}>{block.table!.columns[cellIndex + 1]}：{cell}</li>)}</ul></li>)}</ul>}
        </details>
        {block.sourceIds.length > 0 && <details><summary>页面来源</summary><small>{block.sourceIds.join('、')}</small></details>}
        </section>)}
      </section></li>)}
      {unassigned.length > 0 && <li><section className="requirements-prd-module" aria-label="其他功能" data-prd-unassigned="true" tabIndex={-1}><h3>模块：其他功能</h3><ul className="requirements-function-list">{unassigned.map(renderRequirement)}</ul></section></li>}</ul>
    </>}
  </div>
}