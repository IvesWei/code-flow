import * as React from 'react'
import { LoaderCircle, MessageSquareText, Send } from 'lucide-react'
import type { PlanningProject } from '../../../../shared/testing'

export function PlanningQuestion({ project, busy, onAnswer }: { project: PlanningProject; busy: boolean; onAnswer: (answer: string) => Promise<void> }) {
  const [answer, setAnswer] = React.useState('')
  const question = project.question
  if (project.status !== 'needs_input' || !question) return null
  return <section className="planning-question" aria-label="需要你的确认">
    <h3><MessageSquareText size={18} />需要你的确认</h3>
    <p className="planning-question-text">{question.text}</p>
    <form aria-label="规划问题答复" onSubmit={event => { event.preventDefault(); if (!busy && answer.trim()) void onAnswer(answer.trim()) }}>
      <fieldset disabled={busy}>
        {question.choices.length > 0 && <div className="planning-question-choices" role="radiogroup" aria-label="确认选项">{question.choices.map((choice, index) => <label className="testing-check" key={index}><input type="radio" name={`question-${question.id}`} value={choice} checked={answer === choice} onChange={() => setAnswer(choice)} /><span>{choice}</span></label>)}</div>}
        {question.allowFreeform && <label>回复 Copilot<textarea rows={3} value={answer} maxLength={3000} onChange={event => setAnswer(event.target.value)} /></label>}
        <button className="planning-answer-submit" type="submit" disabled={busy || !answer.trim()}>{busy ? <LoaderCircle size={16} className="spin" /> : <Send size={16} />}提交答复并重新规划</button>
      </fieldset>
    </form>
  </section>
}