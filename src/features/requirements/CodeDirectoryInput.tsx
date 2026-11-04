import * as React from 'react'
import { Code2, X } from 'lucide-react'
import { codeSnapshotLimits } from '../../../shared/requirement-code'
import { selectCodeFiles, type CodeSelection } from './code-directory'

export function CodeDirectoryInput({ disabled, onAdd }: { disabled: boolean; onAdd: (selection: CodeSelection) => Promise<void> }) {
  const [selection, setSelection] = React.useState(() => selectCodeFiles([]))
  const input = React.useRef<HTMLInputElement>(null)
  const submitting = React.useRef(false)
  const errorId = React.useId()
  const issue = selection.error || (selection.excluded && !selection.files.length ? '所选目录没有符合规则的代码文件' : '')
  function clear() {
    setSelection(selectCodeFiles([]))
    if (input.current) input.current.value = ''
  }
  async function submit() {
    if (disabled || submitting.current || issue || !selection.files.length) return
    submitting.current = true
    try { await onAdd(selection); clear() }
    catch {}
    finally { submitting.current = false }
  }
  return <form aria-label="本地已有项目代码" onSubmit={event => { event.preventDefault(); void submit() }}>
    <fieldset disabled={disabled}>
      <label>项目目录<input ref={input} type="file" multiple {...{ webkitdirectory: '' }} aria-invalid={!!issue} aria-describedby={issue ? errorId : undefined} onChange={event => setSelection(selectCodeFiles(Array.from(event.currentTarget.files || [])))} /></label>
      <p role="status">候选 {selection.files.length} 个文件 · 已排除 {selection.excluded} 个文件</p>
      <small>上限：{codeSnapshotLimits.files} 个文件 · 单文件 {codeSnapshotLimits.fileBytes} 字节 · 总计 {codeSnapshotLimits.totalBytes} 字节（UTF-8）</small>
      {issue && <p id={errorId} className="requirements-error" role="alert">{issue}</p>}
      {selection.files.length > 0 && <details><summary>候选代码清单 · {selection.files.length}</summary><ul aria-label="候选代码文件" style={{ maxHeight: 240, overflowY: 'auto', paddingInlineStart: 24 }}>{selection.files.map((candidate, index) => <li key={`${candidate.path}:${index}`}>{candidate.path} · {candidate.file.size} B</li>)}</ul></details>}
      <div className="requirements-toolbar">
        <button type="submit" disabled={disabled || !!issue || !selection.files.length}><Code2 size={15} />添加代码快照</button>
        <button type="button" disabled={disabled || (!selection.files.length && !selection.excluded)} onClick={() => { clear(); input.current?.focus() }}><X size={15} />取消选择</button>
      </div>
    </fieldset>
  </form>
}