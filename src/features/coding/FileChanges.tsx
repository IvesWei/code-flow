import * as React from 'react'
import { ChevronDown, FileCode2, LoaderCircle } from 'lucide-react'
import type { CodingTask } from '../../../shared/task'
import { taskChangeFiles } from '../../../shared/changes'

export function FileChanges({ task }: { task: CodingTask }) {
  const [selected, setSelected] = React.useState<string | null>(null)
  const [diff, setDiff] = React.useState('')
  const [error, setError] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const files = taskChangeFiles(task)

  React.useEffect(() => {
    if (!selected) return
    setLoading(true)
    setError('')
    const controller = new AbortController()
    fetch(`/api/tasks/${task.id}/diff?path=${encodeURIComponent(selected)}`, { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        const payload = await response.json() as { diff?: string; error?: string }
        if (!response.ok) throw new Error(payload.error || '读取变更失败')
        return payload.diff || '该文件当前没有差异'
      })
      .then((value) => { if (!controller.signal.aborted) { setDiff(value); setLoading(false) } })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return
        setError(caught instanceof Error ? caught.message : '读取变更失败')
        setLoading(false)
      })
    return () => controller.abort()
  }, [selected, task.id, task.publication?.baseCommit, task.publication?.commit])

  return <div className="detail-block file-changes">
    <small>文件变更 · {files.length}</small>
    {files.length === 0 && <p>没有文件变更</p>}
    {files.map((name) => <div className="file-entry" key={name}>
      <button type="button" className="file-change-button" aria-expanded={selected === name} onClick={() => {
        setSelected(selected === name ? null : name)
        setDiff(''); setError(''); setLoading(true)
      }} title={`查看 ${name} 的变更`}>
        <FileCode2 size={15} /><span>{name}</span><ChevronDown size={14} className={selected === name ? 'file-expanded' : ''} />
      </button>
      {selected === name && <div className="file-diff" role="region" aria-label={`${name} 的变更内容`}>
        {loading ? <p className="diff-message"><LoaderCircle className="spin" size={14} /> 正在读取差异…</p> : error ? <p className="diff-message diff-error" role="alert">{error}</p> : <pre>{diff.split('\n').map((line, index) => <span key={index} className={line.startsWith('+') && !line.startsWith('+++') ? 'diff-added' : line.startsWith('-') && !line.startsWith('---') ? 'diff-removed' : line.startsWith('@@') ? 'diff-hunk' : 'diff-context'}>{line || ' '}{'\n'}</span>)}</pre>}
      </div>}
    </div>)}
  </div>
}