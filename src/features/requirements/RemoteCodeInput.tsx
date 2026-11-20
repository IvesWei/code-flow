import * as React from 'react'
import { Download, GitBranch, LoaderCircle } from 'lucide-react'
import { ExecutionFeedback } from './ExecutionFeedback'
import type { RequirementRemoteCodeConfig } from '../../../shared/requirements'


function repositoryIssue(input: string): string {
  if (!input.trim()) return ''
  try {
    const url = new URL(input.trim())
    const allowedHost = (url.hostname === 'github.com' && url.protocol === 'https:') ||
      (url.hostname === 'code.sunmi.com' && ['http:', 'https:'].includes(url.protocol))
    if (allowedHost && !url.username && !url.password && !url.port && !url.search && !url.hash && /^\/[\w.-]+\/[\w.-]+(?:\.git)?\/?$/.test(url.pathname)) return ''
  } catch {}
  return '请输入 GitHub HTTPS 或 code.sunmi.com 仓库地址'
}

export function RemoteCodeInput({ saved, disabled, onAdd }: { saved?: RequirementRemoteCodeConfig; disabled: boolean; onAdd: (selection: RequirementRemoteCodeConfig) => Promise<void> }) {
  const [repository, setRepository] = React.useState(saved?.repository || '')
  const [branch, setBranch] = React.useState(saved?.branch || '')
  const [directory, setDirectory] = React.useState(saved?.directory || '')
  const [feedback, setFeedback] = React.useState<{ state: 'pending' | 'success' | 'error'; title: string }>()
  const pending = feedback?.state === 'pending'
  const submitting = React.useRef(false)
  const issueId = React.useId()
  const issue = repositoryIssue(repository)
  async function submit() {
    if (disabled || submitting.current || issue || !repository.trim()) return
    submitting.current = true
    setFeedback({ state: 'pending', title: '正在拉取远程仓库代码快照…' })
    try {
      await onAdd({ repository: repository.trim(), ...(branch.trim() ? { branch: branch.trim() } : {}), ...(directory.trim() ? { directory: directory.trim() } : {}) })
      setFeedback({ state: 'success', title: '远程仓库代码快照已添加' })
    } catch (caught) { setFeedback({ state: 'error', title: caught instanceof Error ? caught.message : '远程仓库快照拉取失败，请重试' }) }
    finally { submitting.current = false }
  }
  return <form className="requirements-code-form" aria-label="远程仓库代码" onSubmit={event => { event.preventDefault(); void submit() }}>
    <h3><GitBranch size={16} aria-hidden="true" />远程仓库代码</h3>
    <fieldset disabled={disabled || pending} aria-busy={pending || undefined}>
      <label>仓库地址<input type="url" required placeholder="https://github.com/owner/repo 或 http://code.sunmi.com/team/repo.git" value={repository} aria-invalid={!!issue} aria-describedby={issue ? issueId : undefined} onChange={event => setRepository(event.target.value)} /></label>
      {issue && <p id={issueId} className="requirements-error" role="alert">{issue}</p>}
      <div className="requirements-inline-fields">
        <label>分支（可选）<input placeholder="默认分支" value={branch} onChange={event => setBranch(event.target.value)} /></label>
        <label>模块目录（可选）<input placeholder="如 src/pages/Orders" value={directory} onChange={event => setDirectory(event.target.value)} /></label>
      </div>
      <div className="requirements-toolbar requirements-compact-actions">
        <button type="submit" aria-label="拉取代码快照" disabled={disabled || pending || !!issue || !repository.trim()} aria-busy={pending || undefined}>{pending ? <LoaderCircle size={15} className="requirements-spinner" aria-hidden="true" /> : <Download size={15} aria-hidden="true" />}{pending ? '正在拉取快照…' : '拉取代码快照'}</button>
      </div>
    </fieldset>
    {feedback && <ExecutionFeedback {...feedback} detail={pending ? '仓库读取与快照保存可能需要一些时间，完成后会更新原始资料；请勿重复提交。' : undefined} />}
  </form>
}