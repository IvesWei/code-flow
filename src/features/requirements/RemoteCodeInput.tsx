import * as React from 'react'
import { Download, GitBranch } from 'lucide-react'

type RemoteCodeSelection = { repository: string; branch?: string; directory?: string }

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

export function RemoteCodeInput({ disabled, onAdd }: { disabled: boolean; onAdd: (selection: RemoteCodeSelection) => Promise<void> }) {
  const [repository, setRepository] = React.useState('')
  const [branch, setBranch] = React.useState('')
  const [directory, setDirectory] = React.useState('')
  const [pending, setPending] = React.useState(false)
  const submitting = React.useRef(false)
  const issueId = React.useId()
  const issue = repositoryIssue(repository)
  async function submit() {
    if (disabled || submitting.current || issue || !repository.trim()) return
    submitting.current = true; setPending(true)
    try {
      await onAdd({ repository: repository.trim(), ...(branch.trim() ? { branch: branch.trim() } : {}), ...(directory.trim() ? { directory: directory.trim() } : {}) })
      setRepository(''); setBranch(''); setDirectory('')
    } catch {}
    finally { submitting.current = false; setPending(false) }
  }
  return <form aria-label="远程仓库代码" aria-busy={pending} onSubmit={event => { event.preventDefault(); void submit() }} style={{ minWidth: 0 }}>
    <h3 style={{ display: 'flex', alignItems: 'center', gap: 6 }}><GitBranch size={16} aria-hidden="true" />远程仓库代码</h3>
    <fieldset disabled={disabled || pending}>
      <label>仓库地址<input type="url" required value={repository} aria-invalid={!!issue} aria-describedby={issue ? issueId : undefined} onChange={event => setRepository(event.target.value)} /></label>
      {issue && <p id={issueId} className="requirements-error" role="alert">{issue}</p>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', columnGap: 12, minWidth: 0 }}>
        <label>分支（可选）<input value={branch} onChange={event => setBranch(event.target.value)} /></label>
        <label>模块目录（可选）<input value={directory} onChange={event => setDirectory(event.target.value)} /></label>
      </div>
      <button type="submit" disabled={disabled || pending || !!issue || !repository.trim()}><Download size={15} aria-hidden="true" />拉取代码快照</button>
    </fieldset>
  </form>
}