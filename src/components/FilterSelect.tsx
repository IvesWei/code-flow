import { useEffect, useId, useLayoutEffect, useState } from 'react'
import * as React from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, ChevronRight } from 'lucide-react'

interface FilterSelectProps {
  label: string
  value: string
  options: { value: string; label: string; group?: string; description?: string; title?: string }[]
  className?: string
  cascade?: boolean
  closeOnSelect?: boolean
  onChange: (value: string) => void
}

export function FilterSelect({ label, value, options, onChange, className = '', cascade = false, closeOnSelect = true }: FilterSelectProps) {
  const id = useId()
  const trigger = React.useRef<HTMLButtonElement>(null)
  const menu = React.useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [position, setPosition] = useState({ top: 0, left: 0, width: 0, maxHeight: 260 })
  const selected = options.findIndex((item) => item.value === value)
  const groups = Array.from(new Set(options.map(item => item.group || '其他页面')))
  const [activeGroup, setActiveGroup] = useState('')
  const group = groups.includes(activeGroup) ? activeGroup : groups[0]
  const visibleIndices = options.flatMap((item, index) => !cascade || (item.group || '其他页面') === group ? [index] : [])
  const changeGroup = (name: string) => {
    setActiveGroup(name)
    setActive(options.findIndex(item => (item.group || '其他页面') === name))
  }

  const show = () => { setActive(Math.max(0, selected)); setActiveGroup(options[selected]?.group || groups[0]); setOpen(true) }
  const close = () => { setOpen(false); trigger.current?.focus() }
  const choose = (index: number) => {
    onChange(options[index].value)
    if (closeOnSelect) close()
    else {
      setActive(index)
      ;(menu.current?.querySelector<HTMLElement>('[role=listbox]') || menu.current)?.focus({ preventScroll: true })
    }
  }

  useLayoutEffect(() => {
    if (!open || !trigger.current) return
    const reposition = () => {
      if (!trigger.current) return
      const box = trigger.current.getBoundingClientRect()
      const below = window.innerHeight - box.bottom - 12
      const above = box.top - 12
      const height = cascade ? 300 : Math.min(260, options.length * 36 + new Set(options.map(item => item.group).filter(Boolean)).size * 32 + 8)
      const upwards = below < height && above > below
      const maxHeight = Math.max(36, Math.min(height, upwards ? above : below))
      const width = Math.min(Math.max(box.width, cascade ? 520 : 176), window.innerWidth - 24)
      setPosition({ top: Math.max(8, Math.min(window.innerHeight - maxHeight - 8, upwards ? box.top - maxHeight - 4 : box.bottom + 4)), left: Math.max(12, Math.min(box.left, window.innerWidth - width - 12)), width, maxHeight })
    }
    reposition()
    ;(menu.current?.querySelector<HTMLElement>('[role=listbox]') || menu.current)?.focus({ preventScroll: true })
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [open, options.length, cascade])

  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false)
    }
    let frame = 0
    const frameFocus = () => {
      frame = requestAnimationFrame(() => {
        if (document.activeElement instanceof HTMLIFrameElement) setOpen(false)
      })
    }
    document.addEventListener('pointerdown', outside)
    if (!closeOnSelect) window.addEventListener('blur', frameFocus)
    return () => {
      document.removeEventListener('pointerdown', outside)
      window.removeEventListener('blur', frameFocus)
      cancelAnimationFrame(frame)
    }
  }, [open, closeOnSelect])

  useEffect(() => {
    if (!open || !menu.current) return
    const option = menu.current.querySelector<HTMLElement>(`[data-index="${active}"]`)
    if (!option) return
    const bounds = option.getBoundingClientRect()
    const scrollContainer = cascade ? option.closest<HTMLElement>('[role=listbox]')! : menu.current
    const viewport = scrollContainer.getBoundingClientRect()
    if (bounds.top < viewport.top) scrollContainer.scrollTop += bounds.top - viewport.top
    else if (bounds.bottom > viewport.bottom) scrollContainer.scrollTop += bounds.bottom - viewport.bottom
  }, [open, active, cascade])

  const optionGroups = Array.from(new Set(options.map(item => item.group || '')))
  const renderOption = (item: FilterSelectProps['options'][number], index: number) => <div key={item.value} id={`${id}-${index}`} role="option" aria-selected={item.value === value} data-index={index} className={`filter-select-option${active === index ? ' active' : ''}`} onPointerMove={() => setActive(index)} onClick={() => choose(index)}><span title={item.title || item.description || item.label}>{item.label}{item.description && <small className="filter-select-description">{item.description}</small>}</span>{item.value === value && <Check size={15} />}</div>

  return <div className={`filter-select ${className}`}>
    <button type="button" ref={trigger} role="combobox" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined} className="filter-select-trigger" onClick={() => open ? close() : show()} onKeyDown={(event) => {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); show() }
    }}><span>{options[selected]?.label || value}</span><ChevronDown size={16} /></button>
    {open && createPortal(<div ref={menu} id={cascade ? undefined : id} role={cascade ? undefined : 'listbox'} aria-label={cascade ? undefined : label} aria-activedescendant={cascade ? undefined : `${id}-${active}`} tabIndex={-1} className={`filter-select-menu${cascade ? ' filter-select-cascade' : ''}`} style={position} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
      else if (event.key === 'Tab') { setOpen(false); trigger.current?.focus() }
      else if (cascade && event.key === 'ArrowLeft') { event.preventDefault(); menu.current?.querySelector<HTMLElement>('[data-module-active=true]')?.focus() }
      else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(active) }
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
        setActive((current) => event.key === 'Home' ? visibleIndices[0] : event.key === 'End' ? visibleIndices.at(-1)! : visibleIndices[(visibleIndices.indexOf(current) + (event.key === 'ArrowDown' ? 1 : -1) + visibleIndices.length) % visibleIndices.length])
      }
    }}>{cascade ? <>
      <div className="filter-select-modules" role="group" aria-label="功能模块">{groups.map((name, index) => <button key={name} type="button" data-module-active={name === group} aria-pressed={name === group} onPointerEnter={() => changeGroup(name)} onClick={() => changeGroup(name)} onKeyDown={event => {
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault(); event.stopPropagation()
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? groups.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + groups.length) % groups.length
          changeGroup(groups[next]); (event.currentTarget.parentElement?.children[next] as HTMLElement)?.focus()
        } else if (['ArrowRight', 'Enter', ' '].includes(event.key)) {
          event.preventDefault(); event.stopPropagation(); menu.current?.querySelector<HTMLElement>('[role=listbox]')?.focus()
        }
      }}><span>{name}</span><ChevronRight size={14} /></button>)}</div>
      <div id={id} role="listbox" aria-label={label} aria-activedescendant={`${id}-${active}`} tabIndex={-1} className="filter-select-pages"><div role="group" aria-label={group}>{visibleIndices.map(index => renderOption(options[index], index))}</div></div>
    </> : optionGroups.map(name => name ? <div key={name} role="group" aria-label={name}><div className="filter-select-group-title">{name}</div>{options.map((item, index) => item.group === name ? renderOption(item, index) : null)}</div> : options.map((item, index) => !item.group ? renderOption(item, index) : null))}</div>, trigger.current?.closest('dialog:modal') || document.body)}
  </div>
}