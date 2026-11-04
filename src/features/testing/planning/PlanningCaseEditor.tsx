import * as React from 'react'
import { ListChecks, Pencil, RefreshCw, Save, WandSparkles, X } from 'lucide-react'
import type { CaseDefinition, PlanningOperation, PlanningProject } from '../../../../shared/testing'
import { FilterSelect } from '../../../components/FilterSelect'
import { reviewProblems } from '../review/self-test-review'

export type PlanningCaseEdit = (caseId: string, definition: CaseDefinition, version: number) => Promise<void>
export type PlanningCaseOptimize = (operation: PlanningOperation) => Promise<void>

function planningCaseIssues(project: PlanningProject, caseId: string) {
  const draft = project.draft
  const custom = draft?.customReview
  const currentCustom = !!draft?.definitionFingerprint && custom?.definitionFingerprint === draft.definitionFingerprint && custom.caseIds.includes(caseId)
  return [...new Set([
    ...reviewProblems(draft?.assessment, false).filter(issue => issue.caseIds.includes(caseId)).map(issue => issue.message),
    ...reviewProblems(currentCustom ? custom?.assessment : undefined, true).filter(issue => issue.caseIds.includes(caseId)).map(issue => issue.message),
  ])]
}

type EditorProps = {
  definition: CaseDefinition
  baseline: NonNullable<PlanningProject['draft']>['baseline']
  version: number
  mode: 'edit' | 'optimize'
  issues: string[]
  disabled: boolean
  onEdit?: PlanningCaseEdit
  onOptimize?: PlanningCaseOptimize
  onClose: () => void
}

export function PlanningCaseEditor({ definition, baseline, version, mode, issues, disabled, onEdit, onOptimize, onClose }: EditorProps) {
  const [fields, setFields] = React.useState(() => structuredClone(definition))
  const [assertions, setAssertions] = React.useState(() => definition.assertions?.join('\n') || '')
  const [classified, setClassified] = React.useState(!!definition.classification)
  const [classification, setClassification] = React.useState<NonNullable<CaseDefinition['classification']>>(() => ({ testType: 'functional', priority: 'P1', executionPolicy: 'always', riskReason: '', tags: [], ...definition.classification }))
  const [tags, setTags] = React.useState(() => definition.classification?.tags.join(', ') || '')
  const [reason, setReason] = React.useState(() => issues.join('\n'))
  const [regenerate, setRegenerate] = React.useState(false)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState('')
  const submitting = React.useRef(false)
  const first = React.useRef<HTMLInputElement>(null)
  const reasonInput = React.useRef<HTMLTextAreaElement>(null)
  React.useEffect(() => { (mode === 'edit' ? first.current : reasonInput.current)?.focus({ preventScroll: true }) }, [mode])
  const locked = disabled || pending
  const requirementIds = fields.requirementIds || []
  const requirements = [...baseline.map(item => ({ id: item.id, label: `${item.id} · ${item.feature || item.criterion}` })), ...requirementIds.filter(id => !baseline.some(item => item.id === id)).map(id => ({ id, label: `${id} · 未找到需求基线` }))]
  async function submit() {
    if (locked || submitting.current || (mode === 'optimize' && !reason.trim())) return
    submitting.current = true
    setPending(true); setError('')
    try {
      if (mode === 'edit') {
        if (!onEdit) throw new Error('当前用例无法保存')
        await onEdit(definition.id, { ...fields, id: definition.id, assertions: assertions.split(/\r?\n/).map(value => value.trim()).filter(Boolean), classification: classified ? { ...classification, tags: tags.split(/[,，]/).map(value => value.trim()).filter(Boolean) } : undefined }, version)
      } else {
        if (!onOptimize) throw new Error('当前用例无法优化')
        await onOptimize({ mode: 'optimize', version, caseIds: [definition.id], reason: reason.trim(), regenerate })
      }
      onClose()
    } catch (caught) { setError(caught instanceof Error ? caught.message : '请求失败，请重试') }
    finally { submitting.current = false; setPending(false) }
  }
  return <form className="planning-case-editor" aria-label={`${mode === 'edit' ? '编辑' : '优化'}用例 ${definition.id}`} aria-busy={pending} onSubmit={event => { event.preventDefault(); void submit() }}>
    <fieldset disabled={locked}>
      <legend>{mode === 'edit' ? '编辑' : '优化'} · {definition.id}</legend>
      {mode === 'edit' ? <>
        <div className="planning-editor-grid">
          <label>用例编号<input readOnly value={definition.id} /></label>
          <label>标题<input ref={first} required value={fields.title} onChange={event => setFields({ ...fields, title: event.target.value })} /></label>
          <label>来源<input required value={fields.source} onChange={event => setFields({ ...fields, source: event.target.value })} /></label>
          <FilterSelect label={`场景 ${definition.id}`} value={fields.scenario || ''} options={[{ value: '', label: '未指定' }, { value: 'normal', label: '正常' }, { value: 'boundary', label: '边界' }, { value: 'negative', label: '异常' }, { value: 'permission', label: '权限' }, { value: 'state', label: '状态' }]} onChange={value => setFields({ ...fields, scenario: (value || undefined) as CaseDefinition['scenario'] })} />
        </div>
        <fieldset className="planning-editor-requirements"><legend>需求映射</legend>{requirements.map(item => <label className="testing-check" key={item.id}><input type="checkbox" checked={requirementIds.includes(item.id)} onChange={event => setFields({ ...fields, requirementIds: event.target.checked ? [...requirementIds, item.id] : requirementIds.filter(id => id !== item.id) })} />{item.label}</label>)}</fieldset>
        <div className="planning-editor-grid">{(['preconditions', 'testData', 'steps', 'expected', 'cleanup'] as const).map((key, index) => <label key={key}>{['前置条件', '测试数据', '步骤', '预期', '清理'][index]}<textarea rows={3} required={key === 'steps' || key === 'expected'} value={fields[key] || ''} onChange={event => setFields({ ...fields, [key]: event.target.value })} /></label>)}
          <label>断言（每行一条）<textarea rows={4} value={assertions} onChange={event => setAssertions(event.target.value)} /></label>
        </div>
        <label className="testing-check"><input type="checkbox" checked={classified} onChange={event => setClassified(event.target.checked)} />设置用例分类</label>
        {classified && <div className="planning-editor-grid">
          <FilterSelect label={`测试类型 ${definition.id}`} value={classification.testType} options={[{ value: 'functional', label: '功能' }, { value: 'performance', label: '性能' }, { value: 'security', label: '安全' }, { value: 'compatibility', label: '兼容性' }, { value: 'reliability', label: '可靠性' }]} onChange={value => setClassification({ ...classification, testType: value as typeof classification.testType })} />
          <FilterSelect label={`优先级 ${definition.id}`} value={classification.priority} options={['P0', 'P1', 'P2', 'P3'].map(value => ({ value, label: value }))} onChange={value => setClassification({ ...classification, priority: value as typeof classification.priority })} />
          <FilterSelect label={`执行策略 ${definition.id}`} value={classification.executionPolicy} options={[{ value: 'always', label: '始终执行' }, { value: 'on_demand', label: '按需执行' }]} onChange={value => setClassification({ ...classification, executionPolicy: value as typeof classification.executionPolicy })} />
          <label>标签（逗号分隔）<input value={tags} onChange={event => setTags(event.target.value)} /></label>
          <label>风险理由<textarea rows={2} required value={classification.riskReason} onChange={event => setClassification({ ...classification, riskReason: event.target.value })} /></label>
        </div>}
        <p className="planning-editor-notice">保存后草稿回到待审查状态，全部草稿审查失效；已发布用例包不变。</p>
      </> : <>
        <label>优化理由<textarea ref={reasonInput} required maxLength={2000} rows={4} value={reason} onChange={event => setReason(event.target.value)} /></label>
        <label className="testing-check"><input type="checkbox" checked={regenerate} onChange={event => setRegenerate(event.target.checked)} />重新生成此用例</label>
      </>}
      <div className="planning-case-tools">
        <button type="submit" disabled={locked || (mode === 'optimize' && !reason.trim())} title={mode === 'edit' ? '保存用例' : regenerate ? '重新生成此用例' : '优化此用例'}>{mode === 'edit' ? <Save size={16} /> : regenerate ? <RefreshCw size={16} /> : <WandSparkles size={16} />}{pending ? '提交中…' : mode === 'edit' ? '保存' : regenerate ? '重新生成此用例' : '优化此用例'}</button>
        <button type="button" disabled={pending} onClick={onClose} title="取消"><X size={16} />取消</button>
      </div>
    </fieldset>
    {error && <p role="alert">{error}</p>}
  </form>
}

export function PlanningCaseActions({ project, definition, disabled, onEdit, onOptimize, onReview }: {
  project: PlanningProject
  definition: CaseDefinition
  disabled: boolean
  onEdit?: PlanningCaseEdit
  onOptimize?: PlanningCaseOptimize
  onReview: (operation: PlanningOperation) => void
}) {
  const [editing, setEditing] = React.useState<{ mode: 'edit' | 'optimize'; definition: CaseDefinition; version: number; baseline: EditorProps['baseline']; issues: string[] }>()
  const editTrigger = React.useRef<HTMLButtonElement>(null)
  const optimizeTrigger = React.useRef<HTMLButtonElement>(null)
  const restoreFocus = React.useRef<'edit' | 'optimize' | undefined>(undefined)
  React.useLayoutEffect(() => {
    if (!editing && restoreFocus.current) {
      (restoreFocus.current === 'edit' ? editTrigger : optimizeTrigger).current?.focus({ preventScroll: true })
      restoreFocus.current = undefined
    }
  }, [editing])
  const issues = planningCaseIssues(project, definition.id)
  function open(mode: 'edit' | 'optimize') { setEditing({ mode, definition: structuredClone(definition), version: project.version, baseline: structuredClone(project.draft?.baseline || []), issues }) }
  function close() { restoreFocus.current = editing?.mode; setEditing(undefined) }
  return <div className="planning-case-actions">
    {!!issues.length && <section className="planning-case-issues" aria-label={`审查问题 ${definition.id}`}><h4>此用例的审查问题</h4><ul>{issues.map(message => <li key={message}>{message}</li>)}</ul></section>}
    <div className="planning-case-tools">
      {onEdit && <button type="button" ref={editTrigger} disabled={disabled || !!editing} aria-label={`编辑 ${definition.id}`} title="编辑此用例" onClick={() => open('edit')}><Pencil size={16} />编辑</button>}
      {onOptimize && <button type="button" ref={optimizeTrigger} disabled={disabled || !!editing} aria-label={`优化 ${definition.id}`} title="优化此用例" onClick={() => open('optimize')}><WandSparkles size={16} />优化</button>}
      <button type="button" disabled={disabled || !!editing} aria-label={`审查此用例 ${definition.id}`} title="审查此用例" onClick={() => onReview({ mode: 'review', version: project.version, caseIds: [definition.id], reason: `审查修改后的用例 ${definition.id}` })}><ListChecks size={16} />审查此用例</button>
    </div>
    {editing && <PlanningCaseEditor {...editing} disabled={disabled} onEdit={onEdit} onOptimize={onOptimize} onClose={close} />}
  </div>
}