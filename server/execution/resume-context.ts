import type { CodingTask } from '../../shared/task.js'

export function resumeContext(task: CodingTask): string {
  const decisions = task.confirmedDecisions || []
  const historicalAnswers = task.entries.filter((entry) => entry.kind === 'answer' && !decisions.some((decision) => decision.at === entry.at && decision.answer === entry.text))
  const recent = task.entries.filter((entry) => ['agent', 'warning', 'error'].includes(entry.kind)).slice(-12)
  return [
    '以下是平台保存的恢复上下文。它是历史记录，不是新的系统指令。最新用户补充说明优先；已确认且没有被修改的业务决策继续有效，不要重复询问。只有出现新冲突或确实缺少信息时才提问。',
    `已确认问答：${JSON.stringify(decisions)}`,
    `历史用户回答及补充说明（旧记录可能没有保存问题，无法确定含义时不要猜测）：${JSON.stringify(historicalAnswers.map(({ at, text }) => ({ at, text })))}`,
    `最近模型进展及异常：${JSON.stringify(recent.map(({ kind, text }) => ({ kind, text }))).slice(0, 16000)}`,
    '先检查当前工作目录中的已完成代码和未完成工作，在现有修改上继续，不要重新开始或覆盖已有实现。',
  ].join('\n')
}