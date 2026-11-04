import * as React from 'react'
import { ArrowLeft, CircleAlert, ExternalLink, LoaderCircle } from 'lucide-react'
import type { AutomationRun, SelfTestCase } from '../../../shared/task'
import { ExecutionEvidence, executionEngine, structuredExecutionState, type ExecutionEvidenceSource } from '../testing/execution/TestExecutionResults'

const statusLabel = (status: AutomationRun['status']) => status === 'blocked' ? '需人工验证' : status

export function AutomationExecutionRecord({ taskId, caseId, run, testCase }: { taskId: string; caseId: string; run: AutomationRun & ExecutionEvidenceSource; testCase: SelfTestCase & ExecutionEvidenceSource }) {
  const result = testCase.executionResult || run.executionResult
  const source: ExecutionEvidenceSource = { runner: run.runner, executionResult: result }
  const browserEvidence = executionEngine(source) !== 'Playwright Test'
  const label = result ? structuredExecutionState(result).label : statusLabel(run.status)
  const startedAt = result?.startedAt || run.startedAt
  const finishedAt = result?.finishedAt || run.finishedAt
  const screenshotUrl = `/api/tasks/${encodeURIComponent(taskId)}/automation/${encodeURIComponent(caseId)}/screenshot`
  return <>
    <section className="self-test-section"><div className="content-header"><div><h2>执行记录</h2><p>用例 {caseId} · {label}</p></div></div>
      <div className="automation-body"><p><strong>预期结果</strong>{testCase.expected}</p><p><strong>状态</strong>{label}</p><p>执行引擎：{executionEngine(source)}</p>{result && <ExecutionEvidence result={result} />}{testCase.testFile && <p>测试文件：{testCase.testFile}</p>}{startedAt && <p><strong>开始</strong>{new Date(startedAt).toLocaleString('zh-CN')}</p>}{finishedAt && <p><strong>结束</strong>{new Date(finishedAt).toLocaleString('zh-CN')}</p>}{run.output && <><strong>执行信息</strong><pre>{run.output}</pre></>}</div>
    </section>
    {browserEvidence && <section className="self-test-section"><div className="content-header"><div><h2>Copilot 自动化脚本</h2><p>受控的浏览器操作与页面断言</p></div></div><div className="automation-body">{run.script ? <pre>{run.script}</pre> : <p>{run.status === 'blocked' ? `浏览器环境无法执行：${run.output}` : '脚本尚未生成。'}</p>}</div></section>}
    {browserEvidence && run.screenshot && <section className="self-test-section"><div className="content-header"><div><h2>页面截图</h2><p>执行完成后由无头 Chrome 拍摄</p></div><a href={screenshotUrl} target="_blank" rel="noreferrer" title="打开原始截图"><ExternalLink size={16} />打开原图</a></div><img className="automation-screenshot" src={screenshotUrl} alt={`${caseId} 的无头浏览器截图`} /></section>}
  </>
}

export function AutomationTaskDetail({ taskId, caseId, runs, onBack }: { taskId: string; caseId: string; runs: AutomationRun[]; onBack: () => void }) {
  const [detail, setDetail] = React.useState<{ run: AutomationRun; testCase: SelfTestCase } | null>(null)
  const [error, setError] = React.useState('')
  React.useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/automation/${encodeURIComponent(caseId)}`)
        if (!response.ok) throw new Error(response.status === 404 ? '自动化任务不存在' : '无法读取自动化任务')
        if (active) { setDetail(await response.json()); setError('') }
      } catch (caught) { if (active) setError(caught instanceof Error ? caught.message : '无法读取自动化任务') }
    }
    void load()
    const timer = setInterval(() => void load(), 3000)
    return () => { active = false; clearInterval(timer) }
  }, [taskId, caseId])
  return <div className="page-wrap automation-detail">
    <button type="button" className="automation-back" onClick={onBack}><ArrowLeft size={16} />返回任务详情</button>
    <div className="page-heading"><div><p className="eyebrow">AUTOMATION / {caseId}</p><h1>自动化执行任务</h1><p className="heading-note">{detail?.testCase.title || caseId}</p></div></div>
    <nav className="automation-run-list" aria-label="自动化执行用例">{runs.map((run) => {
      const result = (run as AutomationRun & ExecutionEvidenceSource).executionResult
      return <a className={run.caseId === caseId ? 'selected' : ''} key={run.caseId} href={`/?task=${encodeURIComponent(taskId)}&automation=${encodeURIComponent(run.caseId)}`}><span>{run.caseId}</span><strong>{result ? structuredExecutionState(result).label : statusLabel(run.status)}</strong></a>
    })}</nav>
    {error && <p role="alert" className="self-test-notice self-test-warning"><CircleAlert size={16} />{error}</p>}
    {!detail && !error && <p className="self-test-notice"><LoaderCircle size={16} className="spin" />正在加载…</p>}
    {detail && <AutomationExecutionRecord taskId={taskId} caseId={caseId} run={detail.run} testCase={detail.testCase} />}
  </div>
}