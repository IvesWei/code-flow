import * as React from 'react'
import { Activity, Check, CircleAlert, ClipboardList, Code2, FolderGit2, GitBranch, Plus, RefreshCw } from 'lucide-react'
import type { CodingTask, TaskEntry } from '../../../shared/task'
import { createExecutionPlan, executionSummary } from '../../../shared/test-policy'
import { TaskConversation } from './TaskConversation'
import { useTaskHistory } from './useTaskHistory'
import { selfTestStageLabel } from '../testing/execution/SelfTestResults'

const phases = [
  { id: 'CLONING', title: '拉取代码', icon: FolderGit2 },
  { id: 'CODING', title: 'Copilot 编码', icon: Code2 },
  { id: 'PUBLISH_PENDING', title: '确认推送', icon: GitBranch },
  { id: 'SELF_TEST', title: '用例规划', icon: ClipboardList },
  { id: 'TEST_EXECUTION', title: '自动执行', icon: Activity },
  { id: 'SUCCESS', title: '验收结果', icon: Check },
] as const

function phaseEntries(entries: TaskEntry[]) {
  let stage: TaskEntry['stage'] = 'CLONING'
  return entries.reduce<Record<string, TaskEntry[]>>((groups, entry) => {
    if (entry.stage) stage = entry.stage
    else if (/仓库已拉取|正在编码|Copilot 正在/.test(entry.text)) stage = 'CODING'
    else if (/正在检查代码变更|npm run|仓库自带的测试|没有代码变更/.test(entry.text)) stage = 'CODING'
    else if (/编码完成/.test(entry.text)) stage = 'SUCCESS'
    ;(groups[stage === 'VERIFYING' ? 'CODING' : stage === 'REVIEW' || stage === 'ACCEPTED' ? groups.TEST_EXECUTION?.length ? 'TEST_EXECUTION' : 'SELF_TEST' : stage || 'CLONING'] ||= []).push(entry)
    return groups
  }, {})
}

function phaseSummary(id: typeof phases[number]['id'], task: CodingTask, entries: TaskEntry[]): string {
  if (!entries.length && id !== 'CODING' && !(id === 'SELF_TEST' && (task.status === 'SELF_TEST' || task.selfTestPlanningStatus))) return '尚未开始'
  const errors = entries.filter((entry) => entry.kind === 'error' || entry.kind === 'warning').length
  const problems = errors ? ` · ${errors} 条异常` : ''
  const tests = task.selfTests || []
  const plan = task.testExecutionPlan || createExecutionPlan(task.acceptanceBaseline || [], tests, [], task.acceptanceSelection)
  const summary = executionSummary(tests, plan)
  const custom = plan.mode === 'custom' || (!plan.mode && !!task.acceptanceSelection)
  switch (id) {
    case 'CLONING': return `${task.createdBranch ? '已创建任务分支' : '拉取中'}${problems}`
    case 'CODING': {
      const checks = task.checks || []
      const failures = checks.filter((check) => !check.passed).length
      const changes = task.publication?.files.length || task.changes?.length || 0
      return `${changes} 个变更文件${checks.length ? ` · ${checks.length - failures}/${checks.length} 项检查通过` : ''}${problems}`
    }
    case 'PUBLISH_PENDING': return `${entries.some((entry) => /已推送/.test(entry.text)) ? '已推送任务分支' : entries.some((entry) => /跳过/.test(entry.text)) ? '已跳过推送' : '等待确认'}${problems}`
    case 'SELF_TEST': return `${task.status === 'SELF_TEST' ? selfTestStageLabel(task) : task.selfTestPlanningStatus === 'qualified' ? '审查通过' : task.selfTestPlanningStatus === 'rejected' ? '审查不通过' : task.selfTestPlanningStatus === 'reviewing' ? '审查未完成' : task.selfTestPlanningStatus === 'generating' ? '生成未完成' : '审查状态未记录'} · ${tests.length} 条用例${problems}`
    case 'TEST_EXECUTION': return `${custom ? '本次必验' : '必验'} ${summary.blockingPassed}/${summary.blockingTotal} 条通过 · 补充失败 ${summary.advisoryFailed} 条 · 未选中 ${summary.notSelected} 条${problems}`
    case 'SUCCESS': return `${task.status === 'SUCCESS' ? custom ? '自定义范围及工程检查通过，不代表全部需求通过' : '必验及工程检查通过' : task.status === 'ACCEPTED' ? '已接受风险' : task.status === 'REVIEW' ? '待验收' : '查看结果'}${problems}`
  }
}

function PhaseRow({ phase, task, entries, failed, hasWarning, active }: {
  phase: typeof phases[number]; task: CodingTask; entries: TaskEntry[]; failed: boolean; hasWarning: boolean; active: boolean
}) {
  const [expanded, setExpanded] = React.useState(failed || hasWarning || (entries.length > 0 && active))
  const PhaseIcon = phase.icon
  return <details className={`phase-group ${failed ? 'phase-failed' : ''}`} open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}><summary><PhaseIcon size={18} /><strong>{phase.title}</strong><span>{phaseSummary(phase.id, task, entries)}</span></summary>{(entries.length > 0 || phase.id === 'CODING') && <TaskConversation entries={entries} task={task} showPrompt={phase.id === 'CODING'} />}{phase.id === 'CODING' && task.checks && <div className="phase-checks">{task.checks.map((check) => <details key={check.name} open={!check.passed}><summary className={check.passed ? 'check-ok' : 'check-fail'}>{check.passed ? <Check size={14} /> : <CircleAlert size={14} />}{check.name}</summary><pre>{check.output || '已完成'}</pre></details>)}</div>}</details>
}

function HistoryRecords({ task, kind, title }: { task: CodingTask; kind: 'artifacts' | 'runs' | 'snapshots'; title: string }) {
  const [expanded, setExpanded] = React.useState(false)
  const history = useTaskHistory<Record<string, unknown>>(task.id, kind, task.updatedAt, expanded)
  return <details className="phase-group" onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary><ClipboardList size={18} /><strong>{title}</strong><span>{expanded ? `${history.items.length} 条已加载` : ''}</span></summary>
    <div className="phase-checks">
      {history.items.map((record, index) => <details className="conversation-detail" key={String(record.id ?? record.seq ?? index)}><summary>{[record.phase, record.kind, record.caseId, record.scope, record.status].filter((value) => typeof value === 'string').join(' · ') || `记录 ${index + 1}`}</summary><pre>{JSON.stringify(record, null, 2)}</pre></details>)}
      {history.loading && <p role="status">正在加载...</p>}
      {history.error && <p role="alert">{history.error}<button type="button" title={`重试加载${title}`} aria-label={`重试加载${title}`} onClick={history.retry}><RefreshCw size={16} /></button></p>}
      {!history.loading && !history.error && expanded && history.items.length === 0 && <p>暂无记录</p>}
      {history.nextCursor && <button type="button" className="secondary-button" disabled={history.loading} onClick={history.loadMore}><Plus size={16} />更多{title}</button>}
    </div>
  </details>
}

export function ActivitySection({ task, history }: { task: CodingTask; history?: { loading: boolean; error: string; nextCursor?: string; loadMore: () => void; retry: () => void } }) {
  const grouped = phaseEntries(task.entries)
  const last = task.entries.at(-1)
  const reviewStage = task.entries.some((entry) => entry.stage === 'TEST_EXECUTION') ? 'TEST_EXECUTION' : 'SELF_TEST'
  const activeStage = task.status === 'NEEDS_INPUT' ? last?.stage || 'CODING' : task.status === 'VERIFYING' ? 'CODING' : task.status === 'REVIEW' ? reviewStage : task.status
  return <section className="activity-section"><div className="content-header"><div><h2>执行记录</h2><p>先看关键事件，需要时切换至全部记录</p></div><span>{task.entries.length} 条原始记录</span></div><div className="phase-list">{phases.map((phase) => {
    const entries = grouped[phase.id] || []
    const failed = task.status === 'FAILED' && (last?.stage === 'CLONING' ? 'CLONING' : last?.stage === 'SELF_TEST' ? 'SELF_TEST' : 'CODING') === phase.id
    const hasWarning = phase.id === 'CODING' && task.checks?.some((check) => !check.passed)
    return <PhaseRow phase={phase} task={task} entries={entries} failed={failed} hasWarning={!!hasWarning} active={phase.id === activeStage} key={`${task.id}-${phase.id}-${phase.id === activeStage ? 'active' : 'idle'}`} />
  })}</div>{history?.error && <p role="alert">{history.error}<button type="button" title="重试加载执行记录" aria-label="重试加载执行记录" onClick={history.retry}><RefreshCw size={16} /></button></p>}{history?.loading && <p role="status">正在加载执行记录...</p>}{history?.nextCursor && <button type="button" className="secondary-button" disabled={history.loading} onClick={history.loadMore}><Plus size={16} />更多执行记录</button>}{history && <div className="phase-list"><HistoryRecords key={`${task.id}-artifacts`} task={task} kind="artifacts" title="自测产物历史" /><HistoryRecords key={`${task.id}-runs`} task={task} kind="runs" title="用例执行历史" /><HistoryRecords key={`${task.id}-snapshots`} task={task} kind="snapshots" title="验收快照历史" /></div>}</section>
}