import * as React from 'react'
import { Code2, LoaderCircle, X } from 'lucide-react'
import { codeSnapshotLimits } from '../../../shared/requirement-code'
import { selectCodeFiles, type CodeSelection } from './code-directory'
import { ExecutionFeedback } from './ExecutionFeedback'

export function CodeDirectoryInput({ disabled, onAdd }: { disabled: boolean; onAdd: (selection: CodeSelection) => Promise<void> }) {
  const [selection, setSelection] = React.useState(() => selectCodeFiles([]))
  const input = React.useRef<HTMLInputElement>(null)
  const submitting = React.useRef(false)
  const [feedback, setFeedback] = React.useState<{ state: 'pending' | 'success' | 'error'; title: string }>()
  const pending = feedback?.state === 'pending'
  const errorId = React.useId()
  const issue = selection.error || (selection.excluded && !selection.files.length ? '所选目录没有符合规则的代码文件' : '')
  function clear() {
    setSelection(selectCodeFiles([]))
    if (input.current) input.current.value = ''
  }
  async function submit() {
    if (disabled || submitting.current || issue || !selection.files.length) return
    submitting.current = true
    setFeedback({ state: 'pending', title: '正在读取并保存本地代码快照…' })
    try { await onAdd(selection); clear(); setFeedback({ state: 'success', title: '本地代码快照已添加' }) }
    catch (caught) { setFeedback({ state: 'error', title: caught instanceof Error ? caught.message : '本地代码快照添加失败，请重试' }) }
    finally { submitting.current = false }
  }
  return <form className="requirements-code-form" aria-label="本地已有项目代码" onSubmit={event => { event.preventDefault(); void submit() }}>
    <h4><Code2 size={15} aria-hidden="true" />本地目录代码快照</h4>
    <fieldset disabled={disabled || pending} aria-busy={pending || undefined}>
      <label className="requirements-upload-drop">
        <span>项目目录</span>
        <input ref={input} type="file" multiple {...{ webkitdirectory: '' }} aria-label="项目目录" aria-invalid={!!issue} aria-describedby={issue ? errorId : undefined} onChange={event => { setSelection(selectCodeFiles(Array.from(event.currentTarget.files || []))); setFeedback(undefined) }} />
        <strong aria-hidden="true">{selection.files.length > 0 ? `已选目录 · ${selection.files.length} 个候选代码文件` : '选择本地已有项目或模块目录'}</strong>
        <small aria-hidden="true">自动排除 node_modules、构建产物与隐藏目录 · 上限 {codeSnapshotLimits.files} 文件 / 1 MiB</small>
      </label>
      <p className="requirements-code-stats" role="status">候选 {selection.files.length} 个文件 · 已排除 {selection.excluded} 个文件</p>
      {issue && <p id={errorId} className="requirements-error" role="alert">{issue}</p>}
      {selection.files.length > 0 && <details className="requirements-candidate-details"><summary>候选代码清单 · {selection.files.length}</summary><ul aria-label="候选代码文件" className="requirements-candidate-list">{selection.files.map((candidate, index) => <li key={`${candidate.path}:${index}`}><code>{candidate.path}</code><span>{candidate.file.size} B</span></li>)}</ul></details>}
      <div className="requirements-toolbar requirements-compact-actions">
        <button type="submit" aria-label="添加代码快照" disabled={disabled || pending || !!issue || !selection.files.length} aria-busy={pending || undefined}>{pending ? <LoaderCircle size={15} className="requirements-spinner" aria-hidden="true" /> : <Code2 size={15} aria-hidden="true" />}{pending ? '正在添加代码快照…' : '添加代码快照'}</button>
        <button type="button" disabled={disabled || pending || (!selection.files.length && !selection.excluded)} onClick={() => { clear(); setFeedback(undefined); input.current?.focus() }}><X size={15} />取消选择</button>
      </div>
    </fieldset>
    {feedback && <ExecutionFeedback {...feedback} detail={pending ? `正在处理 ${selection.files.length} 个候选文件，完成后会更新原始资料；请勿重复提交。` : undefined} />}
  </form>
}