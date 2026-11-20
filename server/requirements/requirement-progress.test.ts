import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RequirementProject } from '../../shared/requirements.js'
import { requirementAnalysisCurrent, requirementPrdClarification, requirementPrdCurrent, requirementPrdResumeReady } from '../../shared/requirement-progress.js'

function project(): RequirementProject {
  const at = '2026-11-05T09:00:00.000Z'
  return {
    schemaVersion: 1, id: 'fixture', ownerId: 7, version: 1, title: 'Scope', description: '', modelId: 'auto',
    createdAt: at, updatedAt: at, status: 'needs_input', sources: [], evidence: [], decisions: [],
    questions: [{ id: 'Q', priority: 'P0', text: 'New or existing?', impact: 'Scope', choices: ['New', 'Existing'], recommendation: 'New' }],
    jobs: [{ id: 'A', stage: 'analyze', status: 'succeeded', startedAt: at, endedAt: at }, { id: 'P', stage: 'prd', status: 'succeeded', startedAt: at, endedAt: at }],
    events: ['analysis:A', 'prd:R', 'clarification:prd:P'].map((text, index) => ({ id: String(index), at, text })),
    revisions: [{ id: 'R', createdAt: at, confirmedAt: at, prd: { title: '', summary: '', blocks: [], requirements: [] }, screens: [] }],
  }
}

test('PRD answers preserve analysis but invalidate confirmed PRD and enable explicit continuation only after all answers', () => {
  const data = project()
  assert.equal(requirementPrdClarification(data), true)
  data.events.push({ id: 'answer', at: data.updatedAt, text: 'prd:inputs_changed' })
  assert.equal(requirementAnalysisCurrent(data), true)
  assert.equal(requirementPrdCurrent(data), false)
  assert.equal(requirementPrdResumeReady(data), false)
  data.decisions.push({ question: data.questions[0], answer: 'New', at: data.updatedAt })
  assert.equal(requirementPrdResumeReady(data), true)
  data.events.push({ id: 'new', at: data.updatedAt, text: 'prd:R' })
  assert.equal(requirementPrdCurrent(data), true)
  assert.equal(requirementPrdResumeReady(data), false)
})

test('historical invalidation markers and ambiguous or non-PRD questions are never reinterpreted as valid analysis', () => {
  const data = project()
  data.events = data.events.filter(event => !event.text.startsWith('clarification:'))
  assert.equal(requirementPrdClarification(data), false)
  data.events.push({ id: 'legacy', at: data.updatedAt, text: 'PRD 范围待确认：请回答澄清问题，补充资料后重新分析；未生成或覆盖 PRD' })
  assert.equal(requirementPrdClarification(data), true)
  data.events.push({ id: 'old-answer', at: data.updatedAt, text: 'inputs:changed' })
  assert.equal(requirementPrdClarification(data), false)
  assert.equal(requirementAnalysisCurrent(data), false)
  assert.equal(requirementPrdResumeReady(data), false)
  data.events.pop()
  data.jobs.at(-1)!.stage = 'analyze'
  assert.equal(requirementPrdClarification(data), false)
})
