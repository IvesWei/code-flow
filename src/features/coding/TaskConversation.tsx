import * as React from 'react'
import { Check, CircleAlert, Clock3, Code2, MessageSquareText, Terminal } from 'lucide-react'
import type { CodingTask, TaskEntry } from '../../../shared/task'
import { conversationItems, focusedConversationItems } from '../../../shared/conversation'

function time(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value))
}

export function TaskConversation({ entries, task, showPrompt = false }: { entries: TaskEntry[]; task: CodingTask; showPrompt?: boolean }) {
  const [view, setView] = React.useState<'focus' | 'all'>('focus')
  const items = conversationItems(entries)
  const focused = focusedConversationItems(items)
  const visible = view === 'focus' ? focused : items
  const completedTools = items.filter(({ entry, result }) => entry.toolEvent === 'start' && result && !['error', 'warning'].includes(result.kind)).length
  const running = ['CODING', 'NEEDS_INPUT', 'SELF_TEST', 'TEST_EXECUTION'].includes(task.status)
  return <div className="conversation">
    <div className="conversation-controls"><div className="conversation-modes" aria-label="执行记录视图"><button type="button" className={view === 'focus' ? 'selected' : ''} aria-pressed={view === 'focus'} onClick={() => setView('focus')}>重点</button><button type="button" className={view === 'all' ? 'selected' : ''} aria-pressed={view === 'all'} onClick={() => setView('all')}>全部</button></div><span>{view === 'focus' ? `收起 ${items.length - focused.length} 条常规记录（含 ${completedTools} 次成功工具调用）` : `当前已加载 ${items.length} 条记录`}</span></div>
    {showPrompt && <div className="conversation-turn user-turn"><div className="turn-heading"><MessageSquareText size={16} /><strong>你</strong><time>{time(task.createdAt)}</time></div><p>{task.instruction}</p><small>{task.prdName}{task.designNames.length ? ` · ${task.designNames.length} 张设计图` : ''}</small></div>}
    {view === 'focus' && !focused.length && <p className="conversation-empty">暂无需要关注的记录。可切换“全部”查看执行过程。</p>}
    {visible.map(({ entry, result }, index) => entry.turnEvent === 'start' ?
      <div className={`conversation-turn system-turn ${result?.kind || 'info'}`} key={`${entry.at}-${index}`}>
        <div className="turn-heading"><Clock3 size={16} /><strong>{entry.text}</strong><time>{time(entry.at)}</time></div>
        <p>{result ? result.text : task.modelTurn && task.modelTurn.id === entry.turnId && task.modelTurn.status === 'running' && running ? task.status === 'NEEDS_INPUT' ? '等待你的回答（超时计时已暂停）' : '运行中' : '已中断'}</p>
        {task.modelTurn && task.modelTurn.id === entry.turnId && <p>最后活动：{task.modelTurn.summary} · {time(task.modelTurn.lastActivityAt)}{task.modelTurn.finishedAt ? ` · 结束 ${time(task.modelTurn.finishedAt)}` : ''}</p>}
        <small>{entry.detail}</small>
        {result?.detail && <details className="conversation-detail" open><summary>超时或失败详情</summary><pre>{result.detail}</pre></details>}
      </div> : entry.toolEvent === 'start' ?
      <div className="conversation-tool" key={`${entry.at}-${index}`}><details><summary><Terminal size={16} /><span>{entry.text.replace(/^Copilot 正在执行 /, '')}{entry.detail && <em>{entry.detail.split('\n')[0].replace(/^(command|cmd|filePath|file_path|path|query|pattern):\s*/, '').slice(0, 120)}</em>}{result?.kind === 'error' && <em className="tool-failure-preview">{(result.detail || result.text).split('\n').find((line) => line.trim())?.slice(0, 160)}</em>}</span><small className={result ? result.kind === 'error' || result.kind === 'warning' ? 'tool-error' : 'tool-ok' : ''}>{result ? result.kind === 'error' || result.kind === 'warning' ? '失败' : '完成' : running ? '运行中' : '已中断'}</small><time>{time(entry.at)}</time></summary><div className="tool-transcript"><div><strong>执行指令</strong><pre>{entry.detail || '此工具未提供可展示的指令'}</pre></div><div><strong>返回信息</strong><pre>{result ? result.detail || result.text : running ? '等待工具返回…' : '任务已结束，工具未返回完成结果'}</pre></div></div></details></div> :
      <div className={`conversation-turn ${entry.kind === 'answer' ? 'user-turn' : entry.kind === 'agent' ? 'agent-turn' : 'system-turn'} ${entry.kind} ${/根据你的补充说明|补跑编码自测|正在定点修正/.test(entry.text) ? 'round-divider' : ''}`} key={`${entry.at}-${index}`}><div className="turn-heading">{entry.kind === 'agent' ? <Code2 size={16} /> : entry.kind === 'answer' ? <MessageSquareText size={16} /> : entry.kind === 'error' || entry.kind === 'warning' ? <CircleAlert size={16} /> : entry.stage === 'SUCCESS' ? <Check size={16} /> : <Clock3 size={16} />}<strong>{entry.kind === 'agent' ? 'Copilot' : entry.kind === 'answer' ? '你' : entry.kind === 'warning' ? '检查提示' : entry.kind === 'error' ? '执行错误' : '工作流'}</strong><time>{time(entry.at)}</time></div>{view === 'focus' && entry.kind === 'agent' && entry.text.length > 350 ? <details className="agent-message"><summary>{entry.text.slice(0, 280).trimEnd()}… <strong>展开完整回复</strong></summary><p>{entry.text}</p></details> : <p>{entry.text}</p>}{entry.detail && <details className="conversation-detail"><summary>查看返回信息</summary><pre>{entry.detail}</pre></details>}</div>
    )}
  </div>
}