import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { TaskStore } from '../tasks/store.js'
import { caseInputs, fingerprint, SelfTestArtifacts, workspaceFingerprint } from './self-test-artifacts.js'
import type { SelfTestCase } from '../../shared/task.js'

test('case identity ignores execution results but detects changed assertions', () => {
  const item: SelfTestCase = { id: 'TC-01', title: 'Save', source: 'PRD', steps: 'Save', expected: 'Saved', status: 'pending', assertions: ['Saved'] }
  assert.equal(fingerprint(caseInputs([item])), fingerprint(caseInputs([{ ...item, status: 'passed', output: 'proof' }])))
  assert.notEqual(fingerprint(caseInputs([item])), fingerprint(caseInputs([{ ...item, assertions: ['Other'] }])))
})

test('workspace snapshot detects untracked changes and checkpoint revisions survive reload', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'artifacts-'))
  try {
    execFileSync('git', ['init', '-q'], { cwd: directory })
    const before = await workspaceFingerprint(directory)
    writeFileSync(join(directory, 'test.cjs'), 'first')
    const first = await workspaceFingerprint(directory)
    assert.notEqual(before, first)
    writeFileSync(join(directory, 'test.cjs'), 'second')
    assert.notEqual(first, await workspaceFingerprint(directory))
    const store = new TaskStore(join(directory, 'tasks.json'))
    const now = new Date().toISOString()
    store.create({ id: 'task', repository: 'repo', instruction: 'Save', prdName: 'prd.md', designNames: [], status: 'REVIEW', entries: [], createdAt: now, updatedAt: now })
    const artifacts = new SelfTestArtifacts(store, 'task')
    const input = fingerprint({ input: 'original' }), changed = fingerprint({ input: 'changed' })
    const artifact = await artifacts.start('review', 'default:TC-01', input, [], 'auto')
    assert.equal(artifacts.find('review', 'default:TC-01', input), undefined)
    await artifacts.finish(artifact.id, { status: 'complete', output: { content: 'result' } })
    await assert.rejects(artifacts.finish(artifact.id, { status: 'failed', error: 'overwrite' }), /already finalized/)
    await assert.rejects(artifacts.bindSession(artifact.id, 'replacement'), /already finalized/)
    const second = await artifacts.start('review', 'default:TC-01', changed, [], 'auto')
    assert.equal(second.revision, 2)
    await artifacts.finish(second.id, { status: 'failed', error: 'timeout' })
    const restored = new SelfTestArtifacts(new TaskStore(join(directory, 'tasks.json')), 'task')
    assert.equal(restored.find('review', 'default:TC-01', input)?.output?.content, 'result')
    assert.equal(restored.find('review', 'default:TC-01', changed), undefined)
    store.create({ ...store.get('task')!, id: 'cold-task', selfTestArtifacts: [{ ...store.get('task')!.selfTestArtifacts!.find((item) => item.id === second.id)!, revision: 12 }] })
    const cold = new SelfTestArtifacts(store, 'cold-task')
    const next = await cold.start('review', 'default:TC-01', input, [], 'auto')
    assert.equal(next.revision, 13, 'returns the actual persisted revision after partial-history loading')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})