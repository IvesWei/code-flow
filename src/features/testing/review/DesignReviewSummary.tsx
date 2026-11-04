import * as React from 'react'
import type { AcceptanceAssessment } from '../../../../shared/task'
import { designReviewState, reviewProblems } from './self-test-review'

const stateLabels = { ready: '设计审查完成', blocked: '设计审查受阻', checking: '设计审查未完成（核对中）', unknown: '设计审查未完成' }

export function DesignReviewSummary({ assessment, custom, progressState, historical = false, planning = false, onLocate }: { assessment?: AcceptanceAssessment; custom: boolean; progressState?: 'checking' | 'unknown'; historical?: boolean; planning?: boolean; onLocate: (id: string) => void }) {
  const headingId = React.useId()
  const problems = reviewProblems(assessment, custom && !planning)
  const blocking = problems.filter(problem => problem.blocking)
  const affected = new Set(blocking.flatMap(problem => problem.caseIds))
  const state = planning && custom
    ? progressState === 'checking' ? 'checking' : progressState === 'unknown' || !assessment ? 'unknown' : assessment.status === 'rejected' ? 'blocked' : !assessment.caseReviews?.length || assessment.caseReviews.some(item => !['qualified', 'warning'].includes(item.status)) ? 'unknown' : assessment.status === 'qualified' && !assessment.issues.length ? 'ready' : 'blocked'
    : designReviewState(assessment, custom, progressState)
  const nextStep = {
    ready: planning ? custom ? '所选范围设计审查完成，全量发布门禁不变；设计完成不代表执行通过。' : '设计审查完成，可发布用例包；设计完成不代表执行通过。' : '下一步：可提交范围进入执行准备；设计完成不代表执行通过。',
    blocked: planning ? custom ? '所选范围存在设计阻断，请修正关联用例后重新审查；全量发布门禁不变。' : '用例设计存在阻断问题，尚未满足发布条件。' : '下一步：先修正用例设计，或调整自定义范围与理由后重新审查。',
    checking: '下一步：等待当前生成或审查完成；已有问题保留供核对。',
    unknown: '下一步：恢复或重新提交审查，取得当前范围的完整结论。',
  }
  return <section className="design-review-summary" aria-labelledby={headingId} data-review-state={state}>
    <h3 id={headingId}>{historical ? '上次审查参考（非当前结论）' : custom ? '本次范围' : '默认质量门禁'} · {stateLabels[state]}</h3>
    <p>{historical ? '范围或理由已调整，当前范围尚未审查。上次问题保留供调整范围，取消选中不会删除历史问题；重新确认并提交后才能取得当前结论。' : nextStep[state]}</p>
    <p className="design-review-counts">阻断 {blocking.length} 项 · 受影响 case {affected.size} 条 · 非阻断提示 {problems.length - blocking.length} 项</p>
    {blocking.some(problem => !problem.caseIds.length) && <p>含全局阻断，具体受影响用例未记录；受影响 case 数仅统计明确关联。</p>}
    {state === 'blocked' && !blocking.length && <p>审查记录为受阻，未记录具体阻断明细，原因待核对。</p>}
    {!assessment && <p>尚无与当前范围及理由一致的审查，旧评审不作为本次结论。</p>}
    {custom && state === 'ready' && blocking.length > 0 && <p>审查记录为完成，仍有未明确分类的阻断记录，原因待核对。</p>}
    {(['blocking', 'advisory'] as const).map(kind => {
      const entries = problems.filter(problem => problem.blocking === (kind === 'blocking'))
      return entries.length > 0 && <details key={kind} className={`design-review-${kind}`} open={kind === 'blocking'}>
        <summary>{kind === 'blocking' ? '阻断问题' : '非阻断提示'} · {entries.length} 项</summary>
        <ul>{entries.map(problem => <li key={problem.message}>
          <div className="review-case-links">{problem.caseIds.length ? problem.caseIds.map(id => <button type="button" key={id} className="review-case-link" aria-label={`定位用例 ${id}`} data-case-target={id} onClick={() => onLocate(id)}>{id}</button>) : <span>全局</span>}</div>
          <p>{problem.message}</p><small>来源：{problem.sources.join(' / ')}</small>
        </li>)}</ul>
      </details>
    })}
  </section>
}