import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import type { RequirementProject, RequirementScopeBlock, StructuredPrd } from '../../shared/requirements.js'
import { captureFingerprint, captureFingerprintMatches, scopeFingerprint, validateCapturePlan, validateScopeCheckpoint } from './capture-plan.js'
import { validatePrd } from './validation.js'
import { jsonDigest } from '../storage/json-digest.js'

function reordered<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.length - right.length || left.localeCompare(right))) : item))
}

function fixture() {
  const at = '2026-11-05T09:00:00.000Z'
  const prd: StructuredPrd = { title: 'Reports', summary: 'New report', blocks: [{ id: 'B1', title: 'Reports', content: 'View report', requirementIds: ['R1'], sourceIds: ['S1'] }], requirements: [{ id: 'R1', title: 'Report', description: 'View report', fields: [{ name: 'Date', description: 'Select date' }], sourceIds: ['S1'], acceptance: [{ id: 'A1', text: 'Report visible' }] }] }
  const blocks: RequirementScopeBlock[] = [{ blockId: 'B1', kind: 'new', reason: 'Confirmed independent report' }]
  const project: RequirementProject = {
    schemaVersion: 1, id: 'fixture', ownerId: 7, version: 1, createdAt: at, updatedAt: at, status: 'prd_review',
    title: 'Reports', description: 'Add report', modelId: 'auto', preview: { origin: 'https://tmp.test.sunmi.com', generation: 1 },
    sources: [{ id: 'S1', name: 'code.md', kind: 'file', sha256: 'a'.repeat(64), sizeBytes: 123 }],
    evidence: [], questions: [], revisions: [], jobs: [], events: [],
    decisions: [{ question: { id: 'Q1', priority: 'P0', text: 'Independent?', impact: 'Scope', choices: ['Yes', 'No'], recommendation: 'Yes' }, answer: 'Yes', at }],
  }

  return { project, prd, blocks }
}

test('scope checkpoints preserve classification across capture answers and settings, not business or source changes', () => {
    const { project, prd, blocks } = fixture()
    blocks[0].kind = 'existing'
    const checkpoint = { version: 1, fingerprint: scopeFingerprint(project), blocks, prd }
    assert.deepEqual(validateScopeCheckpoint(checkpoint, ['S1']), checkpoint)
    project.decisions.push({
      question: { id: 'capture-1', priority: 'P0', text: 'Provide entry', impact: 'Capture only', choices: ['URL', 'Source'], recommendation: 'URL', capture: { fingerprint: checkpoint.fingerprint, blockIds: ['B1'] } },
      answer: 'https://tmp.test.sunmi.com/orders?projectId=42', at: project.updatedAt,
    })
    project.preview!.entryPaths = ['/orders?projectId=42']
    project.preview!.generation++
    assert.equal(scopeFingerprint(project), checkpoint.fingerprint)
    assert.notEqual(scopeFingerprint({ ...project, description: 'Changed business scope' }), checkpoint.fingerprint)
    assert.notEqual(scopeFingerprint({ ...project, sources: [{ ...project.sources[0], sha256: 'b'.repeat(64) }] }), checkpoint.fingerprint)
    assert.throws(() => validateScopeCheckpoint({ ...checkpoint, blocks: [] }, ['S1']))
})

test('capture fingerprints ignore recursive object-key order but preserve meaningful array order', () => {
  const { project, prd, blocks } = fixture()
  const fingerprint = captureFingerprint(project, prd, blocks)
  assert.notEqual(JSON.stringify(prd), JSON.stringify(reordered(prd)))
  assert.equal(captureFingerprint(reordered(project), reordered(prd), reordered(blocks)), fingerprint)
  const changed = structuredClone(prd)
  changed.requirements[0].fields!.push({ name: 'Region', description: 'Select region' })
  const before = captureFingerprint(project, changed, blocks)
  changed.requirements[0].fields!.reverse()
  assert.notEqual(captureFingerprint(project, changed, blocks), before)
})

test('functional classification uses fresh capture fingerprints while confirmed v3 baselines remain readable', () => {
  const { project, prd, blocks } = fixture()
  const saved = jsonDigest({
    policy: 'classified-scope-v3', preview: project.preview, prd,
    sources: project.sources.map(source => ({ id: source.id, sha256: source.sha256 })),
    blocks, description: project.description, decisions: project.decisions,
  })
  assert.notEqual(captureFingerprint(project, prd, blocks), saved)
  const before = structuredClone({ project, prd, blocks })
  assert.equal(captureFingerprintMatches(saved, reordered(project), reordered(prd), reordered(blocks)), true)
  assert.deepEqual({ project, prd, blocks }, before)
  project.preview!.generation++
  assert.equal(captureFingerprintMatches(saved, project, prd, blocks), false)
})

test('legacy MySQL classification fingerprints remain valid without rewriting stored PRD or fingerprints', () => {
  const { project: original, prd, blocks } = fixture()
  const project = reordered(original)
  const generated = validatePrd(prd, ['S1'])
  const saved = createHash('sha256').update(JSON.stringify({
    policy: 'classified-scope-v2', preview: project.preview, prd: generated,
    sources: project.sources.map(source => ({ id: source.id, sha256: source.sha256 })),
    blocks, description: project.description, decisions: project.decisions,
  })).digest('hex')
  const persisted = reordered(generated)
  const rawPlan = reordered({ version: 1, fingerprint: saved, blocks })
  const unchanged = structuredClone(rawPlan)
  assert.equal(captureFingerprintMatches(saved, project, persisted, rawPlan.blocks), true)
  assert.deepEqual(rawPlan, unchanged)
  assert.equal(captureFingerprintMatches(saved, project, persisted, [Object.assign({}, rawPlan.blocks[0], { extra: 'changed scope' })]), false)
  const plan = validateCapturePlan(reordered({ version: 1, fingerprint: saved, blocks }), persisted, [])
  assert.notEqual(saved, captureFingerprint(project, persisted, plan.blocks))
  assert.equal(captureFingerprintMatches(saved, project, persisted, plan.blocks), true)
  assert.equal(plan.fingerprint, saved)
  for (const change of [
    () => { project.preview!.generation++ },
    () => { project.description += ' changed' },
    () => { project.sources[0].sha256 = 'b'.repeat(64) },
    () => { project.decisions[0].answer = 'No' },
    () => { persisted.requirements[0].fields![0].description += ' changed' },
    () => { plan.blocks[0].reason += ' changed' },
    () => { plan.blocks[0].kind = 'existing' },
  ]) {
    const snapshot = structuredClone({ project, persisted, plan })
    change()
    assert.equal(captureFingerprintMatches(saved, project, persisted, plan.blocks), false)
    assert.equal(captureFingerprintMatches(saved, project, persisted, reordered(plan.blocks)), false)
    Object.assign(project, snapshot.project)
    Object.assign(persisted, snapshot.persisted)
    Object.assign(plan, snapshot.plan)
  }
})

test('old unclassified capture fingerprints survive MySQL reordering without accepting source changes', () => {
  const { project, prd } = fixture()
  const generated = validatePrd(prd, ['S1'])
  const saved = createHash('sha256').update(JSON.stringify({
    policy: 'prd-first-v1', preview: project.preview, prd: generated,
    sources: project.sources.map(source => ({ id: source.id, sha256: source.sha256 })),
  })).digest('hex')
  assert.equal(captureFingerprintMatches(saved, reordered(project), reordered(generated)), true)
  project.sources[0].sha256 = 'b'.repeat(64)
  assert.equal(captureFingerprintMatches(saved, reordered(project), reordered(generated)), false)
})
