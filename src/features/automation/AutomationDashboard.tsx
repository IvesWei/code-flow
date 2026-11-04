import * as React from 'react'
import { Activity, ArrowRight, LoaderCircle } from 'lucide-react'
import type { TaskSummary } from '../../../shared/task-summary'
import { executionEngine, structuredExecutionState, type ExecutionEvidenceSource } from '../testing/execution/TestExecutionResults'

export function AutomationDashboard({ tasks, onStart, onOpenRun, startingId, busy, authenticated }: {
  tasks: TaskSummary[]
  onStart: (task: TaskSummary, url: string) => void
  onOpenRun: (taskId: string, caseId: string) => void
  startingId: string | null
  busy: boolean
  authenticated: boolean
}) {
  const [previewUrls, setPreviewUrls] = React.useState<Record<string, string>>({})
  return <div className="page-wrap automation-dashboard">
    <div className="page-heading"><div><p className="eyebrow">AUTOMATION</p><h1>自动化执行任务</h1></div><span className="heading-glyph"><Activity size={25} /></span></div>
    {tasks.length === 0 && <section className="self-test-section"><p className="self-test-notice">暂无编码任务。创建编码任务后可在此执行已生成的用例。</p></section>}
    {tasks.map((task) => {
      const url = previewUrls[task.id] ?? task.automationUrl ?? ''
      const eligible = ['REVIEW', 'SUCCESS', 'ACCEPTED'].includes(task.status) && task.hasWorkspace
      const runs = task.runs
      const runnable = task.runnable
      return <section className="self-test-section" key={task.id}>
        <div className="content-header"><div><h2>{task.repository.split('/').at(-1)?.replace(/\.git$/, '')}</h2><p>{task.caseCount} 条用例 · {task.automationCount} 条自动化记录</p></div><span>{task.status}</span></div>
        <div className="automation-launch"><label htmlFor={`automation-url-${task.id}`}>本机预览地址</label><input id={`automation-url-${task.id}`} type="url" placeholder="http://127.0.0.1:4173" value={url} onChange={(event) => setPreviewUrls((previous) => ({ ...previous, [task.id]: event.target.value }))} disabled={!eligible} />
          <button type="button" className="primary-button" disabled={!eligible || !authenticated || !url.trim() || !runnable || busy || !!startingId} onClick={() => onStart(task, url.trim())}>{startingId === task.id ? <LoaderCircle className="spin" size={16} /> : <ArrowRight size={16} />}执行用例</button>
        </div>
        <p className="automation-hint">{!task.hasWorkspace ? '任务没有可用的工作目录，无法执行用例。' : !eligible ? '编码任务尚未结束，请等待完成后执行用例。' : !authenticated ? '请先登录 Copilot，才能启动自动化执行。' : !url.trim() ? '请填写已启动应用的本机预览地址。' : !runnable ? '当前用例已有执行记录，无待执行项。' : busy ? '请等待当前任务完成。' : '将逐条执行可运行用例并保存执行结果。'}</p>
        {runs.map((run) => {
          const source = run as typeof run & ExecutionEvidenceSource
          const result = source.executionResult
          return <button type="button" className="automation-run-row" key={run.caseId} onClick={() => onOpenRun(task.id, run.caseId)}><span>{run.caseId} · {run.title}<br /><small>执行引擎：{executionEngine(source)}{result && <> · 必验断言 {result.assertions.filter(assertion => assertion.status === 'passed').length}/{result.assertions.length}<br />执行原因：{result.reason || '未记录'}</>}</small></span><strong>{result ? structuredExecutionState(result).label : run.status}</strong><ArrowRight size={15} /></button>
        })}
      </section>
    })}
  </div>
}