import { Check, Circle, CircleAlert, LoaderCircle } from 'lucide-react'
import * as React from 'react'
import type { PlanningProject } from '../../../../shared/testing'

const phases = ['提取需求基线', '生成用例', '设计审查']
function activity(text: string): { phase: string; summary: string; firstResponseMs: number; inactivityMs: number } | undefined {
  const prefix = 'Model progress: Planning activity: '
  if (!text.startsWith(prefix)) return undefined
  try {
    const value = JSON.parse(text.slice(prefix.length))
    if (['baseline', 'generation', 'review'].includes(value.phase) && typeof value.summary === 'string' && Number.isFinite(value.firstResponseMs) && Number.isFinite(value.inactivityMs)) return value
  } catch { return undefined }
}

export function planningFeedback(project: PlanningProject, currentTime = Date.now()) {
  const start = project.events.findLastIndex(event => /^planning:generation:/.test(event.text))
  const events = project.events.slice(Math.max(0, start))
  const sessionStart = events.findLastIndex(event => /Planning (baseline|generation|review): fresh read-only session\./.test(event.text))
  const sessionEvents = events.slice(Math.max(0, sessionStart))
  const latest = sessionEvents.at(-1)
  const latestActivity = sessionEvents.findLast(event => !!activity(event.text))
  const details = latestActivity ? activity(latestActivity.text) : undefined
  const batch = events.findLast(event => /用例批次 \d+/.test(event.text))
  const at = latest?.at || project.updatedAt
  const elapsed = Math.max(0, Math.floor((currentTime - Date.parse(at)) / 1000))
  const silent = project.status === 'running' && Number.isFinite(elapsed) && elapsed >= 120
  return { at, elapsed, silent, batch: batch ? planningMessage(batch.text) : undefined, summary: details?.summary || (latest ? planningMessage(latest.text) : '等待规划进展'), limits: details }
}

function duration(seconds: number) {
  if (!Number.isFinite(seconds)) return '未知'
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}

export function planningProgress(project: PlanningProject) {
  const start = project.events.findLastIndex(event => /^planning:generation:/.test(event.text))
  const events = project.events.slice(Math.max(0, start))
  const progress = events.findLast(event => /Planning (baseline|generation|review):/.test(event.text))
  const phase = progress?.text.match(/Planning (baseline|generation|review):/)?.[1]
  const index = phase === 'review' ? 2 : phase === 'generation' ? 1 : 0
  const needsInput = project.status === 'needs_input' || project.status === 'failed' && /Planning requires clarification|请补充需求或规划指令/.test(project.error || '')
  const state = needsInput ? 'needs-input' : project.status
  const reviewInvalid = project.error === 'Planning review response format invalid; saved draft checkpoints remain available.'
  const title = needsInput ? project.question ? '等待你的确认' : '需要补充需求' : project.status === 'running' ? `正在${phases[index]}` : project.status === 'completed' ? '用例生成完成' : project.status === 'failed' ? reviewInvalid ? '审查结果格式无效' : '用例生成失败' : project.status === 'interrupted' ? '用例规划已中断' : project.status === 'cancelled' ? '用例规划已取消' : '等待生成用例'
  return { index, state, title }
}

export function planningMessage(text: string, hasQuestion = false): string {
  const details = activity(text)
  if (details) return details.summary
  if (text.startsWith('Model progress: 用例批次 ') || text.startsWith('Model progress: 补充用例预算')) return text.slice('Model progress: '.length)
  if (/^planning:generation:/.test(text)) return '开始新一轮用例规划'
  if (/^planning:publish:/.test(text)) return '保存用例包发布记录'
  const phase = text.match(/^(?:Model progress: )?Planning (baseline|generation|review): fresh read-only session\.$/)?.[1]
  if (phase) return phase === 'baseline' ? '正在提取需求基线' : phase === 'generation' ? '正在生成用例' : '正在进行设计审查'
  const messages: Record<string, string> = {
    'Planning requires clarification. Update the requirements or instruction and generate again.': hasQuestion ? '规划暂停，等待用户确认具体问题。' : '需求信息需要补充，当前规划尚未完成。模型未保存具体澄清问题。',
    'Planning model failed; saved draft checkpoints remain available.': '模型调用失败，已保存的用例草稿仍然保留。',
    'Planning review response format invalid; saved draft checkpoints remain available.': '审查返回格式校验未通过，未取得有效结论；已保存草稿与通过的审查批次保留，可继续审查。',
    'Planning baseline output is invalid after one format correction.': '模型返回的需求基线格式无效，一次格式修正后仍未通过校验，尚未进入用例生成。',
    'Model progress: Planning baseline output format invalid; requesting one format correction.': '需求基线格式不符合约定，正在进行一次格式修正。',
    'Planning was cancelled.': '规划已取消。',
    'Planning sources changed; generate a new draft.': '需求来源已变化，需要重新生成草稿。',
    'Planning storage operation failed.': '规划记录保存失败。',
    'Invalid planning input or source.': '规划输入或来源无效。',
  }
  return messages[text] || text
}

export function PlanningProgress({ project, syncError = false }: { project: PlanningProject; syncError?: boolean }) {
  const [currentTime, setCurrentTime] = React.useState(Date.now)
  React.useEffect(() => {
    if (project.status !== 'running') return
    setCurrentTime(Date.now())
    const timer = window.setInterval(() => setCurrentTime(Date.now()), 10_000)
    return () => window.clearInterval(timer)
  }, [project.status, project.id])
  const progress = planningProgress(project)
  const feedback = planningFeedback(project, currentTime)
  const running = project.status === 'running'
  const stopped = ['failed', 'interrupted', 'cancelled', 'needs_input'].includes(project.status)
  const Icon = running ? LoaderCircle : stopped ? CircleAlert : project.status === 'completed' ? Check : Circle
  return <section className="planning-progress" aria-label="用例生成进度" data-planning-state={progress.state}>
    <div className="planning-progress-heading"><h3>{React.createElement(Icon, { size: 17, className: running ? 'spin' : undefined })}{progress.title}</h3><span>记录修订 {project.version} · 已发布 {project.caseSetIds.length} 版</span></div>
    <ol className="planning-stages">{phases.map((phase, index) => {
      const done = project.status === 'completed' || (project.status !== 'draft' && index < progress.index)
      const current = project.status !== 'draft' && project.status !== 'completed' && index === progress.index
      const StageIcon = done ? Check : current && running ? LoaderCircle : current && stopped ? CircleAlert : Circle
      return <li key={phase} data-stage-state={done ? 'done' : current ? stopped ? 'stopped' : 'current' : 'pending'} aria-current={current ? 'step' : undefined}><StageIcon size={16} className={current && running ? 'spin' : undefined} /><span>{phase}</span></li>
    })}</ol>
    <dl className="planning-counts"><div><dt>需求基线</dt><dd>{project.draft?.baseline.length || 0} 项</dd></div><div><dt>已生成用例</dt><dd>{project.draft?.cases.length || 0} 条</dd></div><div><dt>设计审查</dt><dd>{running ? progress.index === 2 ? '审查中' : '待审查' : project.status !== 'completed' ? '未完成' : project.draft?.assessment?.status === 'qualified' ? '审查通过' : project.draft?.assessment?.status === 'rejected' ? '审查不通过' : '未完成'}</dd></div></dl>
    <div className="planning-live" data-waiting={running && feedback.silent ? 'long' : undefined}>
      {syncError ? <p role="alert">状态刷新失败，以下为上次保存状态，无法确认任务是否仍在运行。</p> : <p role="status">{running ? feedback.summary : progress.title}</p>}
      {feedback.batch && <p className="planning-batch">{feedback.batch}</p>}
      <p className="planning-last-activity">最近活动：<time dateTime={feedback.at}>{Number.isNaN(Date.parse(feedback.at)) ? '未知' : new Date(feedback.at).toLocaleString('zh-CN', { hour12: false })}</time>{running && <> · 距今 {duration(feedback.elapsed)}</>}</p>
      {running && feedback.silent && !syncError && <p className="planning-wait-warning" role="status">已 {duration(feedback.elapsed)} 未收到新的模型或批次进展，仍在等待响应，尚不能判定失败。已保存 {project.draft?.cases.length || 0} 条用例，本批尚未保存新结果。</p>}
      {running && feedback.limits && <p className="planning-last-activity">首次响应等待上限 {duration(Math.round(feedback.limits.firstResponseMs / 1000))}；收到响应后连续无进展上限 {duration(Math.round(feedback.limits.inactivityMs / 1000))}。不会自动重放请求。</p>}
      {['interrupted', 'cancelled', 'failed'].includes(project.status) && <p>已保存 {project.draft?.cases.length || 0} 条用例草稿，草稿尚不具备发布资格。{project.status === 'interrupted' ? '任务已中断，不会自动续跑。' : '本轮规划已停止。'}可继续生成或审查已保存草稿；重新生成会开启新一轮规划，不是从当前条数断点续跑。</p>}
    </div>
    {project.error && !project.question && <p className="testing-notice" role="alert">{planningMessage(project.error)}</p>}
  </section>
}

export function PlanningActivity({ project }: { project: PlanningProject }) {
  return <section aria-label="进度记录" className="planning-activity"><details><summary>进度记录 · {project.events.length} 条</summary><ol>{project.events.map((event, index) => <li key={index} data-event-kind={event.kind}><time dateTime={event.at}>{Number.isNaN(Date.parse(event.at)) ? event.at : new Date(event.at).toLocaleString('zh-CN', { hour12: false })}</time><span>{planningMessage(event.text, !!project.question || !!project.clarifications?.length)}</span></li>)}</ol></details><details><summary>原始诊断记录</summary><pre>{JSON.stringify({ error: project.error, events: project.events }, null, 2)}</pre></details></section>
}