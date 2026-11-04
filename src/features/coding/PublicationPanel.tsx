import { useState } from 'react'
import { ArrowUpRight, CircleAlert, GitBranch, LoaderCircle, RotateCw, SkipForward } from 'lucide-react'
import type { CodingTask } from '../../../shared/task'

interface Props {
  task: CodingTask
  onAction: (action: 'refresh' | 'confirm' | 'skip', snapshot?: string) => Promise<void>
}

export function PublicationPanel({ task, onAction }: Props) {
  const [pending, setPending] = useState<string | null>(null)
  const publication = task.publication

  async function action(kind: 'refresh' | 'confirm' | 'skip') {
    if (kind === 'confirm' && !window.confirm(`确认提交并推送以下 ${publication?.files.length} 个文件到 ${task.repository} 的 ${task.createdBranch} 分支？不会推送到默认分支，也不会创建 PR。`)) return
    if (kind === 'skip' && !window.confirm('确认跳过远端推送，仅在本地保留代码并继续生成用例？')) return
    setPending(kind)
    try { await onAction(kind, publication?.snapshot) } finally { setPending(null) }
  }

  return <section className="publication-panel" aria-label="确认发布编码变更">
    <div className="publication-heading"><GitBranch size={19} /><h2>确认发布编码变更</h2></div>
    <dl><dt>仓库</dt><dd>{task.repository}</dd><dt>目标分支</dt><dd>{task.createdBranch}</dd></dl>
    {publication?.commit && <p className="publication-commit">本地提交：{publication.commit}</p>}
    {publication?.error && <p className="publication-error" role="alert"><CircleAlert size={16} />{publication.error}</p>}
    {publication?.files.length ? <><p className="publication-caption">待推送文件 ({publication.files.length})</p><ul className="publication-files">{publication.files.map((file) => <li key={file}>{file}</li>)}</ul></> : <p className="publication-caption">当前没有可确认的文件清单。请刷新后查看，或跳过推送。</p>}
    <p className="publication-note">仅提交当前清单中的编码变更到新任务分支；后续生成的测试文件留在本地。不会强制推送、修改默认分支或创建 PR。请在确认前检查文件内容和检查结果。</p>
    <div className="publication-actions">
      <button type="button" disabled={!!pending || !!publication?.commit} onClick={() => void action('refresh')}><RotateCw size={16} />刷新清单</button>
      <button type="button" disabled={!!pending || !publication?.snapshot} className="primary-button" onClick={() => void action('confirm')}>{pending === 'confirm' ? <LoaderCircle className="spin" size={16} /> : <ArrowUpRight size={16} />}确认提交并推送</button>
      <button type="button" disabled={!!pending || !!publication?.pushedAt} onClick={() => void action('skip')}><SkipForward size={16} />跳过推送</button>
    </div>
  </section>
}