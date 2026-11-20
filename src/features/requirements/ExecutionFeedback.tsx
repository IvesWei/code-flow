import { AlertCircle, CheckCircle2, Clock3, LoaderCircle } from 'lucide-react'

export function ExecutionFeedback({ state, title, detail }: {
  state: 'pending' | 'success' | 'error' | 'waiting'
  title: string
  detail?: string
}) {
  const Icon = state === 'pending' ? LoaderCircle : state === 'success' ? CheckCircle2 : state === 'error' ? AlertCircle : Clock3
  return <div className="requirements-execution-feedback" data-state={state} role={state === 'error' ? 'alert' : 'status'} aria-live={state === 'error' ? 'assertive' : 'polite'} aria-atomic="true">
    {state === 'pending' ? <span role="progressbar" aria-label={title}><Icon size={18} aria-hidden="true" className="requirements-spinner" /></span> : <Icon size={18} aria-hidden="true" />}
    <div><strong>{title}</strong>{detail && <p>{detail}</p>}</div>
  </div>
}
