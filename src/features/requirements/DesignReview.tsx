import * as React from 'react'
import { Pencil, Play, X } from 'lucide-react'
import { FilterSelect } from '../../components/FilterSelect'
import type { RequirementRevision, RequirementScreen } from '../../../shared/requirements'
import { buildPrototypeDocument, needsScreenshot, prototypeArtboardWidth } from './prototype'
import { designPageOptions } from './design-pages'
import { prototypeScreens } from '../../../shared/requirement-prototypes'

function Prototype({ screen, projectId, revisionId, hasScreenshot }: {
  screen: RequirementScreen; projectId: string; revisionId: string; hasScreenshot: boolean
}) {
  const frame = React.useRef<HTMLIFrameElement>(null)
  const artboard = React.useRef<HTMLDivElement>(null)
  const [availableWidth, setAvailableWidth] = React.useState(prototypeArtboardWidth)
  const [contentHeight, setContentHeight] = React.useState(1000)
  const [document, setDocument] = React.useState('')
  const [nonce] = React.useState(() => globalThis.crypto.randomUUID())
  const fallback = needsScreenshot(screen.html)
  React.useLayoutEffect(() => {
    const element = artboard.current
    if (!element) return
    const measure = () => { if (element.clientWidth > 0) setAvailableWidth(element.clientWidth) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [fallback])
  React.useEffect(() => {
    if (!fallback) setDocument(buildPrototypeDocument(screen.html, nonce, screen.id))
  }, [screen.html, screen.id, nonce, fallback])
  const receive = React.useEffectEvent((event: MessageEvent) => {
    const data: unknown = event.data
    if (!frame.current?.contentWindow || event.source !== frame.current.contentWindow || event.origin !== 'null' || !data || typeof data !== 'object') return
    const message = data as Record<string, unknown>
    if (message.type === 'requirements:resize' && message.nonce === nonce && message.screenId === screen.id && typeof message.height === 'number' && Number.isFinite(message.height) && message.height > 0 && message.height <= 100000) {
      setContentHeight(Math.ceil(message.height))
      return
    }
  })
  React.useEffect(() => {
    const listener = (event: MessageEvent) => receive(event)
    window.addEventListener('message', listener)
    return () => window.removeEventListener('message', listener)
  }, [])
  if (fallback) return hasScreenshot ? <img className="requirements-screenshot" src={`/api/requirements/projects/${encodeURIComponent(projectId)}/screenshots/${encodeURIComponent(screen.id)}?revision=${encodeURIComponent(revisionId)}`} alt={`${screen.title} · ${screen.state}截图`} /> : <p role="status">此页面包含活动内容，安全预览需要先验证生成截图。</p>
  const scale = Math.min(1, availableWidth / prototypeArtboardWidth)
  return <div ref={artboard} className="requirements-artboard" style={{ height: contentHeight * scale }}><iframe ref={frame} title={`${screen.title}原型`} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={document || undefined} style={{ width: prototypeArtboardWidth, height: contentHeight, transform: `scale(${scale})` }} /></div>
}

export function DesignReview({ revision, projectId, selectedId, adjustmentDisabled = true, onAdjust, preferredScreen, running = false, taskError, onCancel }: {
  revision: RequirementRevision; projectId: string; selectedId: string; adjustmentDisabled?: boolean
  running?: boolean; taskError?: string; onCancel?(): void
  preferredScreen?: { title: string; state: string }
  onAdjust?(screenId: string, instruction: string): Promise<void>
}) {
  const [adjusting, setAdjusting] = React.useState(false)
  const [instruction, setInstruction] = React.useState('')
  const [error, setError] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [conversation, setConversation] = React.useState<{ role: 'user' | 'status'; text: string }[]>([])
  const dialog = React.useRef<HTMLDialogElement>(null)
  const previousRevision = React.useRef(revision.id)
  const adjustTrigger = React.useRef<HTMLButtonElement>(null)
  const restoreAdjustmentFocus = React.useRef(false)
  const instructionInput = React.useRef<HTMLTextAreaElement>(null)
  React.useLayoutEffect(() => {
    if (adjusting) { restoreAdjustmentFocus.current = true; if (!dialog.current?.open) dialog.current?.showModal(); instructionInput.current?.focus() }
    else { if (dialog.current?.open) dialog.current.close(); if (restoreAdjustmentFocus.current) { restoreAdjustmentFocus.current = false; adjustTrigger.current?.focus() } }
  }, [adjusting])
  React.useEffect(() => () => { dialog.current?.close() }, [])
  const [screenId, setScreenId] = React.useState(revision.screens.find(screen => screen.title === preferredScreen?.title && screen.state === preferredScreen.state)?.id || revision.screens[0]?.id || '')
  const screen = revision.screens.find(item => item.id === screenId) || revision.screens[0]
  const group = screen ? prototypeScreens(revision, screen.id) : []
  const updateRevision = React.useEffectEvent(() => {
    if (previousRevision.current === revision.id) return
    previousRevision.current = revision.id
    const target = revision.screens.find(item => item.title === preferredScreen?.title && item.state === preferredScreen.state)
    if (target) setScreenId(target.id)
    if (adjusting) setConversation(previous => [...previous, { role: 'status', text: '原型和各状态截图已更新。' }])
  })
  React.useEffect(() => { updateRevision() }, [revision.id])
  const initialReading = React.useRef(selectedId)
  const preferAdjustedPage = React.useRef(!!preferredScreen)
  const locateRequirement = React.useEffectEvent(() => {
    if (adjusting || (preferAdjustedPage.current && selectedId === initialReading.current)) return
    preferAdjustedPage.current = false
    if (!selectedId) return
    if (!revision.screens.find(item => item.id === screenId)?.requirementIds.includes(selectedId)) {
      const target = revision.screens.find(item => item.requirementIds.includes(selectedId))
      if (target) {
        if (target.title !== screen?.title) { setInstruction(''); setError(''); setConversation([]) }
        setScreenId(target.id)
      }
    }
  })
  React.useEffect(() => { locateRequirement() }, [selectedId, revision.screens])
  return <div className="requirements-design">
    <div className="requirements-toolbar requirements-design-heading"><h2>设计原型</h2>{screen && <FilterSelect cascade closeOnSelect={false} className="requirements-page-select" label="设计页面" value={screen.id} options={designPageOptions(revision)} onChange={value => { setScreenId(value); setAdjusting(false); setInstruction(''); setError(''); setConversation([]) }} />}{screen && onAdjust && <button ref={adjustTrigger} type="button" disabled={adjustmentDisabled || submitting} aria-haspopup="dialog" onClick={() => setAdjusting(true)}><Pencil size={15} />调整原型</button>}</div>
    {screen ? <>
      <dialog ref={dialog} className="requirements-prototype-editor" aria-label="原型调整" onCancel={event => { event.preventDefault(); setAdjusting(false) }}>
        <header className="requirements-toolbar"><h2>{screen.title} · 原型调整</h2><button type="button" aria-label="关闭原型调整" title="关闭原型调整" onClick={() => setAdjusting(false)}><X size={16} /></button></header>
        <div className="requirements-prototype-editor-body">
          <section aria-label="原型预览"><FilterSelect label="原型状态" value={screen.id} options={group.map(item => ({ value: item.id, label: item.state }))} onChange={setScreenId} /><div className="requirements-preview">{adjusting && <Prototype key={`editor:${revision.id}:${screen.id}`} screen={screen} projectId={projectId} revisionId={revision.id} hasScreenshot={!!revision.screenshots?.some(item => item.screenId === screen.id)} />}</div></section>
          <section className="requirements-prototype-conversation" aria-label="原型修改对话"><ul aria-label="同步调整状态">{group.map(item => <li key={item.id}>{item.state}</li>)}</ul><div role="log" aria-label="调整对话记录">{conversation.map((item, index) => <p key={index}><strong>{item.role === 'user' ? '你：' : '系统：'}</strong>{item.text}</p>)}</div>
          {running && <p role="status">正在调整原型并更新状态截图…{onCancel && <button type="button" onClick={onCancel}>取消任务</button>}</p>}
          {(error || taskError) && <p role="alert">{error || taskError}</p>}
          <form aria-label="原型设计调整" onSubmit={event => {
        event.preventDefault()
        if (!instruction.trim() || submitting || adjustmentDisabled) return
        const request = [...conversation.filter(item => item.role === 'user').map(item => item.text), instruction.trim()].join('\n\n')
        if (request.length > 10000) { setError('本轮对话超过长度限制，请精简修改意见'); return }
        setSubmitting(true); setError('')
        const message = instruction.trim()
        void onAdjust!(screen.id, request).then(() => { setConversation(previous => [...previous, { role: 'user', text: message }]); setInstruction('') }).catch(caught => setError(caught instanceof Error ? caught.message : '提交失败')).finally(() => setSubmitting(false))
      }}><fieldset disabled={adjustmentDisabled || submitting}><label>原型修改意见<textarea ref={instructionInput} aria-label="原型修改意见" required maxLength={10000} rows={4} value={instruction} onChange={event => setInstruction(event.target.value)} /></label><button type="submit" disabled={!instruction.trim()}><Play size={15} />发送并调整原型</button></fieldset></form></section>
        </div>
      </dialog>
      <div className="requirements-preview"><Prototype key={`${revision.id}:${screen.id}:${screen.html}`} screen={screen} projectId={projectId} revisionId={revision.id} hasScreenshot={!!revision.screenshots?.some(item => item.screenId === screen.id)} /></div>
      {selectedId && !revision.screens.some(item => item.requirementIds.includes(selectedId)) && <p role="status">当前需求未关联设计页面。</p>}
    </> : <p>尚未生成设计页面。</p>}
  </div>
}