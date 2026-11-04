import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { PlanningProject } from '../../shared/testing.js'
import { CasePlanningService } from './planning-service.js'
import { MemoryTestingRepository } from './repository.js'

test('old clarification recovers only the owned current attempt question without writing logs or records', async context => {
  const root = await mkdtemp(join(tmpdir(), 'planning-question-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const repository = new MemoryTestingRepository()
  const service = new CasePlanningService(repository, root)
  const project: PlanningProject = { id: randomUUID(), ownerId: 7, version: 1, createdAt: '2026-10-21T03:33:00.000Z', updatedAt: '2026-10-21T03:34:00.000Z', status: 'failed', input: { title: 'login', requirements: 'login', instruction: '', modelId: 'auto', sources: [] }, caseSetIds: [], error: 'Planning requires clarification. Update the requirements or instruction and generate again.', events: [{ at: '2026-10-21T03:33:35.000Z', kind: 'info', text: `planning:generation:${randomUUID()}` }] }
  await repository.create('project', project, 7)
  const sessions = join(root, 'testing', 'planning', project.id, 'sessions')
  const directory = join(sessions, '00000000-0000-0000-0000-000000000001', 'session-state', randomUUID())
  await mkdir(directory, { recursive: true })
  await mkdir(join(root, 'testing', 'planning', project.id, 'sessions', '00000000-0000-0000-0000-000000000000'), { recursive: true })
  for (let index = 0; index < 21; index++) {
    const old = join(sessions, `ffffffff-ffff-ffff-ffff-${index.toString(16).padStart(12, '0')}`)
    await mkdir(old)
    await utimes(old, new Date('2026-01-01'), new Date('2026-01-01'))
  }
  const event = (timestamp: string, question: string) => JSON.stringify({ type: 'tool.execution_start', timestamp, data: { toolName: 'ask_user', arguments: { question, choices: ['Clear', 'Keep'], allowFreeform: false } } })
  const content = [event('2026-10-21T03:33:00.000Z', 'Old question'), event('2026-10-21T03:33:56.698Z', 'Clear password? token=secret-value'), event('2026-10-21T03:35:00.000Z', 'Future question'), '{partial'].join('\n')
  const file = join(directory, 'events.jsonl')
  await writeFile(file, content)
  const detail = await service.detail(7, project.id)
  assert.equal(detail.status, 'needs_input')
  assert.match(detail.question!.text, /Clear password/)
  assert.doesNotMatch(detail.question!.text, /secret-value|Old|Future/)
  assert.equal(detail.question!.allowFreeform, false)
  assert.equal((await service.detail(7, project.id)).question!.id, detail.question!.id)
  await assert.rejects(service.detail(8, project.id), /not found/i)
  assert.deepEqual(await repository.get('project', project.id, 7), project)
  assert.equal(await readFile(file, 'utf8'), content)
  const answered = await service.answer(7, project.id, detail.question!.id, 'Clear', detail.version)
  assert.equal(answered.clarifications![0].answer, 'Clear')
  assert.equal(answered.question, undefined)
  assert.equal(answered.status, 'draft')
  assert.equal((await service.detail(7, project.id)).question, undefined)
})