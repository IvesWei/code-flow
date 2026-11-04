import * as React from 'react'
import { ExternalLink, Link2, RefreshCw, Save } from 'lucide-react'
import type { CodingTask } from '../../../shared/task'
import type { CasePackage, ExecutionRun, PlanningProject } from '../../../shared/testing'
import { testingLinkFields, testingLinkHref, testingLinksEditable, type TestingLinkField, type TestingLinks as Links } from '../../../shared/testing-links'
import { FilterSelect } from '../../components/FilterSelect'

const labels: Record<TestingLinkField, string> = { planningProjectId: '用例规划', caseSetId: '用例包', executionRunId: '执行批次' }
type Options = Record<TestingLinkField, { value: string; label: string }[]>

async function request<Value>(url: string, signal: AbortSignal, body?: unknown): Promise<Value> {
  const response = await fetch(url, { signal, ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
  const value = await response.json()
  if (!response.ok) throw new Error(typeof value?.error === 'string' ? value.error : `请求失败 (${response.status})`)
  return value as Value
}

export function TestingLinks({ task, onSaved }: { task: CodingTask; onSaved: () => Promise<void> }) {
  const [expanded, setExpanded] = React.useState(false)
  const source = JSON.stringify([task.id, task.testingLinks || {}])
  const [draftState, setDraftState] = React.useState<{ source: string; links: Links }>()
  const draft = draftState?.source === source ? draftState.links : task.testingLinks || {}
  const [options, setOptions] = React.useState<Options>()
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState('')
  const [revision, setRevision] = React.useState(0)
  const saveRequest = React.useRef<AbortController | null>(null)
  React.useEffect(() => () => { saveRequest.current?.abort() }, [task.id])
  React.useEffect(() => {
    if (!expanded) return
    const controller = new AbortController()
    void Promise.all([
      request<PlanningProject[]>('/api/testing/projects', controller.signal),
      request<CasePackage[]>('/api/testing/packages', controller.signal),
      request<ExecutionRun[]>('/api/testing/executions', controller.signal),
    ]).then(([projects, packages, executions]) => {
      if (controller.signal.aborted) return
      setOptions({
        planningProjectId: projects.map(item => ({ value: item.id, label: `${item.input.title} · ${item.id}` })),
        caseSetId: packages.map(item => ({ value: item.id, label: `${item.id} · v${item.revision}` })),
        executionRunId: executions.map(item => ({ value: item.id, label: `${item.input.title} · ${item.id}` })),
      })
    }).catch(caught => { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : '关联选项读取失败') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [expanded, task.id, revision])

  const editable = testingLinksEditable(task)
  return <section aria-label="独立测试关联" style={{ minWidth: 0, marginBottom: 20, paddingBlock: 12, borderBlock: '1px solid var(--line)', fontSize: 12 }}>
    {testingLinkFields.some(field => task.testingLinks?.[field]) && <nav aria-label="已关联测试记录" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 12 }}>
      {testingLinkFields.map(field => task.testingLinks?.[field] && <a key={field} href={testingLinkHref(field, task.testingLinks[field])} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><ExternalLink size={14} />打开{labels[field]}</a>)}
    </nav>}
    <details onToggle={event => {
      const open = event.currentTarget.open
      setExpanded(open)
      if (open) { setLoading(true); setError(''); setOptions(undefined) }
    }}>
      <summary style={{ cursor: 'pointer' }}><Link2 size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />测试关联（可选）</summary>
      {expanded && <form aria-label="编辑测试关联" onSubmit={event => {
        event.preventDefault()
        if (saving || loading || !options || !editable) return
        const controller = new AbortController()
        saveRequest.current = controller
        setSaving(true); setError('')
        const body = Object.fromEntries(testingLinkFields.map(field => [field, draft[field] || null]))
        void request(`/api/tasks/${encodeURIComponent(task.id)}/testing-links`, controller.signal, body)
          .then(async () => { if (!controller.signal.aborted) await onSaved() })
          .catch(caught => { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : '关联保存失败') })
          .finally(() => { if (!controller.signal.aborted) setSaving(false) })
      }}>
        <fieldset disabled={saving || loading || !options || !editable} style={{ minWidth: 0, padding: 0, margin: '12px 0', border: 0 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 12 }}>
            {testingLinkFields.map(field => {
              const choices = options?.[field] || []
              const selected = draft[field] || ''
              return <div key={field} style={{ minWidth: 0 }}>
                <div style={{ marginBottom: 6 }}>{labels[field]}</div>
                <FilterSelect label={`关联${labels[field]}`} value={selected} options={[
                  { value: '', label: '不关联' },
                  ...(selected && !choices.some(item => item.value === selected) ? [{ value: selected, label: `当前关联 · ${selected}` }] : []),
                  ...choices,
                ]} onChange={value => setDraftState({ source, links: { ...draft, [field]: value || undefined } })} />
              </div>
            })}
          </div>
          <button type="submit" className="accept-test-button" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 12 }}><Save size={14} />{saving ? '保存中' : '保存关联'}</button>
        </fieldset>
        {!editable && <p role="status">任务忙碌或尚未稳定，暂不可修改关联。</p>}
        {loading && <p role="status">正在读取关联选项</p>}
        {error && <p role="alert" style={{ overflowWrap: 'anywhere' }}>{error}</p>}
        {!loading && <button type="button" className="accept-test-button" disabled={saving} onClick={() => { setLoading(true); setError(''); setOptions(undefined); setRevision(value => value + 1) }} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><RefreshCw size={14} />刷新关联选项</button>}
      </form>}
    </details>
  </section>
}