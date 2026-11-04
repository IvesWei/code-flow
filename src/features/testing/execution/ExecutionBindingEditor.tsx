import * as React from 'react'
import { Link2, LoaderCircle, Save, X } from 'lucide-react'
import type { CodingTask } from '../../../../shared/task'
import type { AssertionManifest, PlaywrightExecutionBinding } from '../../../../shared/test-execution'
import { currentScopeAssessment } from '../review/self-test-review'

type BindingDetail = {
  caseId: string
  testCase: { id: string; title: string; testFile?: string }
  manifest: AssertionManifest
  binding: PlaywrightExecutionBinding | null
}

export function canEditExecutionBinding(task: CodingTask, caseId: string): boolean {
  if (!['REVIEW', 'SUCCESS', 'ACCEPTED'].includes(task.status) || task.modelInTurn || task.modelTurn?.status === 'running'
    || task.automationRuns?.some(run => run.status === 'running' || run.status === 'generating')
    || !task.acceptanceBaseline?.length || !task.selfTests?.some(item => item.id === caseId)) return false
  const selection = task.acceptanceSelection
  const assessment = selection ? currentScopeAssessment(task, selection.caseIds, selection.reason) : task.acceptanceAssessment
  const checkedAt = Date.parse(assessment?.checkedAt || '')
  if (!assessment?.inputFingerprint || !Number.isFinite(checkedAt) || checkedAt > Date.now()) return false
  return selection
    ? !!selection.reason.trim() && new Set(selection.caseIds).size === selection.caseIds.length
      && selection.caseIds.includes(caseId) && selection.caseIds.every(id => task.selfTests?.some(item => item.id === id))
      && assessment.readiness === 'ready'
    : assessment.status === 'qualified' && !['generating', 'reviewing'].includes(task.selfTestPlanningStatus || '')
}

export function ExecutionBindingEditor({ taskId, caseId, onSaved, onClose }: {
  taskId: string; caseId: string; onSaved?: () => void | Promise<void>; onClose: () => void
}) {
  const [detail, setDetail] = React.useState<BindingDetail>()
  const [testFile, setTestFile] = React.useState('')
  const [testTitle, setTestTitle] = React.useState('')
  const [project, setProject] = React.useState('')
  const [confirmed, setConfirmed] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [saved, setSaved] = React.useState(false)
  const [error, setError] = React.useState('')
  const controller = React.useRef<AbortController | null>(null)
  const heading = React.useRef<HTMLHeadingElement>(null)
  const endpoint = `/api/tasks/${encodeURIComponent(taskId)}/execution-bindings/${encodeURIComponent(caseId)}`
  React.useEffect(() => {
    const request = new AbortController()
    controller.current = request
    heading.current?.focus({ preventScroll: true })
    async function load() {
      try {
        const response = await fetch(endpoint, { signal: request.signal })
        const body = await response.json()
        if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
        const value = body as BindingDetail
        if (value.caseId !== caseId || value.testCase?.id !== caseId || !Array.isArray(value.manifest?.assertions)) throw new Error('绑定清单与当前用例不匹配')
        if (request.signal.aborted) return
        setDetail(value)
        setTestFile(value.binding?.testFile || value.testCase.testFile || '')
        setTestTitle(value.binding?.testTitle || '')
        setProject(value.binding?.project || '')
      } catch (caught) {
        if (!request.signal.aborted) setError(`无法读取可信绑定：${caught instanceof Error ? caught.message : '请求失败'}`)
      } finally { if (!request.signal.aborted) setLoading(false) }
    }
    void load()
    return () => request.abort()
  }, [endpoint, caseId])
  const changed = () => { setConfirmed(false); setSaved(false); setError('') }
  const assertions = detail?.manifest.assertions || []
  const canSave = !!detail && assertions.length > 0 && assertions.every(item => !!item.id && !!item.definition.trim())
    && !!testFile.trim() && !!testTitle.trim() && confirmed && !saving && !saved
  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!canSave) return
    setSaving(true); setError('')
    try {
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.current?.signal,
        body: JSON.stringify({ testFile, testTitle, project, assertionIds: assertions.map(item => item.id), confirm: true }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
      if (!body.binding || body.caseId !== caseId) throw new Error('服务端未确认绑定保存')
      if (controller.current?.signal.aborted) return
      setSaved(true); setConfirmed(false)
      try { await onSaved?.() } catch { setError('绑定已保存，但任务刷新失败；请刷新任务后核对。') }
    } catch (caught) {
      if (!controller.current?.signal.aborted) {
        setConfirmed(false)
        setError(`绑定未保存：${caught instanceof Error ? caught.message : '请求失败'}`)
      }
    } finally { if (!controller.current?.signal.aborted) setSaving(false) }
  }
  return <section className="execution-binding-editor" aria-label={`可信 Playwright 绑定 ${caseId}`} aria-busy={loading || saving}>
    <div className="execution-binding-heading"><h3 ref={heading} tabIndex={-1}><Link2 size={16} />可信 Playwright 绑定 · {caseId}</h3><button type="button" title="关闭绑定编辑" aria-label="关闭绑定编辑" disabled={saving} onClick={onClose}><X size={16} /></button></div>
    <p>仅绑定已人工审阅且可信的测试脚本；执行时将运行该脚本。保存绑定不启动执行，也不代表用例通过。</p>
    {loading && <p role="status"><LoaderCircle size={15} className="spin" />正在读取断言清单…</p>}
    {error && <p role="alert">{error}</p>}
    {detail && <form onSubmit={event => void save(event)}>
      <fieldset disabled={saving}>
        <legend>{detail.testCase.title}</legend>
        <div className="execution-binding-fields">
          <label>测试文件<input required maxLength={1024} value={testFile} placeholder="tests/example.spec.ts" onChange={event => { setTestFile(event.target.value); changed() }} /></label>
          <label>完整测试标题<input required maxLength={2000} value={testTitle} onChange={event => { setTestTitle(event.target.value); changed() }} /></label>
          <label>Playwright 项目（可留空）<input maxLength={256} value={project} onChange={event => { setProject(event.target.value); changed() }} /></label>
        </div>
        <p>断言映射：以上测试必须覆盖以下全部断言（按清单顺序）。</p>
        <ol aria-label="全部断言映射">{assertions.map(item => <li key={item.id}><code>{item.id}</code><span>{item.definition}</span></li>)}</ol>
        {!assertions.length && <p role="alert">断言清单为空，无法确认绑定。</p>}
        <label className="execution-binding-confirm"><input type="checkbox" checked={confirmed} disabled={!assertions.length || saved} onChange={event => setConfirmed(event.target.checked)} /><span>我已人工审阅并信任此脚本，确认测试文件、完整标题、项目及以上全部断言 ID 的映射。</span></label>
        <button type="submit" disabled={!canSave}>{saving ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}保存可信绑定</button>
      </fieldset>
    </form>}
    {saved && <p role="status">可信绑定已保存，尚未启动执行。</p>}
  </section>
}