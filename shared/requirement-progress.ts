import type { RequirementProject } from './requirements.js'

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().filter(key => record[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function signatureDigest(value: unknown): string {
  const input = canonical(value)
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f, 0x165667b1, 0xd3a2646c, 0xfd7046c5]
  return seeds.map((seed, lane) => {
    let hash = seed >>> 0
    for (let index = 0; index < input.length; index++) {
      hash ^= input.charCodeAt(index) + lane * 31
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    return hash.toString(16).padStart(8, '0')
  }).join('')
}

export function requirementAnalysisSignature(project: Pick<RequirementProject, 'description' | 'sources' | 'decisions'>): string {
  return signatureDigest({
    description: project.description,
    sources: project.sources.map(source => ({ id: source.id, sha256: source.sha256 })),
    decisions: project.decisions.filter(decision => !decision.question.capture).map(decision => ({ questionId: decision.question.id, answer: decision.answer })),
  })
}

export function requirementPrdSignature(project: Pick<RequirementProject, 'description' | 'sources' | 'decisions'>): string {
  return signatureDigest({
    description: project.description,
    sources: project.sources.map(source => ({ id: source.id, sha256: source.sha256 })),
    decisions: project.decisions.map(decision => ({ questionId: decision.question.id, answer: decision.answer })),
  })
}

export function requirementAnalysisCurrent(project: RequirementProject): boolean {
  const job = project.jobs.findLast(item => item.stage === 'analyze' && item.status === 'succeeded')
  if (!job) return false
  const eventsCurrent = project.events.findLastIndex(event => event.text === `analysis:${job.id}`) > project.events.findLastIndex(event => event.text === 'inputs:changed')
  if (!eventsCurrent) return false
  return !project.stageState?.analysisFingerprint || project.stageState.analysisFingerprint === requirementAnalysisSignature(project)
}

export function requirementPrdCurrent(project: RequirementProject): boolean {
  const revision = project.revisions.at(-1)
  if (!revision) return false
  const eventsCurrent = project.events.findLastIndex(event => event.text === `prd:${revision.id}`) > project.events.findLastIndex(event => ['inputs:changed', 'prd:inputs_changed'].includes(event.text))
  if (!eventsCurrent) return false
  return !project.stageState?.prdRevisionId || (project.stageState.prdRevisionId === revision.id && project.stageState.prdInputFingerprint === requirementPrdSignature(project))
}

export function requirementPrdClarification(project: RequirementProject): boolean {
  const job = project.jobs.at(-1)
  if (!requirementAnalysisCurrent(project) || !project.questions.length || job?.stage !== 'prd' || job.status !== 'succeeded') return false
  const index = project.events.findLastIndex(event => event.text === `clarification:prd:${job.id}` || (
    event.text.startsWith('PRD 范围待确认：') && event.at >= job.startedAt && !!job.endedAt && event.at <= job.endedAt
  ))
  const eventsMatch = index > project.events.findLastIndex(event => event.text === 'inputs:changed') &&
    index > project.events.findLastIndex(event => event.text.startsWith('analysis:'))
  if (!eventsMatch) return false
  return !project.stageState?.prdClarificationJobId || project.stageState.prdClarificationJobId === job.id
}

export function requirementPrdResumeReady(project: RequirementProject): boolean {
  const allAnswered = !project.questions.some(question => !project.decisions.some(decision => decision.question.id === question.id))
  const eventsReady = project.events.findLastIndex(event => event.text === 'prd:inputs_changed') > project.events.findLastIndex(event => event.text === 'inputs:changed')
  return requirementAnalysisCurrent(project) && !requirementPrdCurrent(project) && allAnswered && (!!project.stageState?.prdClarificationJobId || eventsReady)
}
