import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, LoaderCircle } from 'lucide-react'

export interface ModelOption {
  id: string
  name: string
  policy?: string
  vision: boolean
  multiplier?: number
}

interface ModelPickerProps {
  value: string
  models?: ModelOption[]
  hasImages: boolean
  disabled?: boolean
  loading?: boolean
  onSelect: (modelId: string) => void
  label: string
}

export function ModelPicker({ value, models, hasImages, disabled, loading, onSelect, label }: ModelPickerProps) {
  const menu = useRef<HTMLDetailsElement>(null)
  const [openUp, setOpenUp] = useState(false)
  const selected = models?.find((model) => model.id === value)

  useEffect(() => {
    function closeOutside(event: PointerEvent) {
      if (menu.current && !menu.current.contains(event.target as Node)) menu.current.open = false
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [])

  return <details className={`model-picker${openUp ? ' open-up' : ''}`} ref={menu} onToggle={(event) => {
    if (event.currentTarget.open) {
      const box = event.currentTarget.getBoundingClientRect()
      setOpenUp(window.innerHeight - box.bottom < Math.min(270, window.innerHeight / 2) && box.top > window.innerHeight - box.bottom)
    }
  }} onKeyDown={(event) => {
    if (event.key === 'Escape') { menu.current?.removeAttribute('open'); menu.current?.querySelector('summary')?.focus() }
  }}>
    <summary aria-label={label} aria-disabled={disabled || undefined} onClick={(event) => { if (disabled) event.preventDefault() }}>
      <span>{value === 'auto' ? '自动选择' : selected?.name || value}</span>
      {loading ? <LoaderCircle className="spin" size={15} /> : <ChevronDown size={16} />}
    </summary>
    <div className="model-picker-options" role="group" aria-label={label}>
      {[{ id: 'auto', name: '自动选择', vision: true }, ...(models || []).filter((model) => model.id !== 'auto')].map((model) => {
        const unavailable = (model.policy === 'disabled' || model.policy === 'unconfigured') ? '不可用' : hasImages && !model.vision ? '不支持图片' : ''
        return <button type="button" key={model.id} disabled={!!unavailable || disabled} className={value === model.id ? 'selected' : ''} onClick={() => {
          menu.current?.removeAttribute('open')
          if (model.id !== value) onSelect(model.id)
        }}>
          <span className="model-option-name">{model.name}</span>
          {model.multiplier !== undefined && <small>{model.multiplier}x</small>}
          {unavailable && <small>{unavailable}</small>}
          {value === model.id && <Check size={14} />}
        </button>
      })}
    </div>
  </details>
}