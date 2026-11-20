import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { CopilotSession, SessionConfig, SessionEvent } from '@github/copilot-sdk'
import type { RequirementConversationEntry, RequirementModel, RequirementProject, RequirementPrototype } from '../../shared/requirements.js'
import { CopilotRequirementModel, type RequirementModelOptions } from './model.js'
import { buildPrototypeAdjustmentInput } from './prototype-adjustment.js'
import { validatePrototypeDesign } from './prototype-design.js'
import { captureFingerprint } from './capture-plan.js'
import { readSourceFile, storeSourceFile } from './sources.js'
import { JsonRequirementRepository } from './repository.js'
import { RequirementService } from './service.js'
import type { validatePrototypeRevision } from './artifacts.js'
import { validatePrd } from './validation.js'

function fixture() {
  const prototype: RequirementPrototype = {
    id: 'PAGE-1', title: 'Reports',
    html: '<!doctype html><html><body><main data-prototype-node="report" data-requirement-id="R1" data-acceptance-id="A1">Report</main></body></html>',
    states: [{ id: 'S1', name: 'normal', requirementIds: ['R1'], acceptanceIds: ['A1'], changes: [] }],
  }
  const prd = {
    title: 'Product', summary: 'UNRELATED_PROJECT_SUMMARY',
    blocks: [{ id: 'B1', title: 'Reports', content: 'Report page', requirementIds: ['R1'], sourceIds: [] }, { id: 'B2', title: 'Unrelated', content: 'UNRELATED_PAGE', requirementIds: ['R2'], sourceIds: [] }],
    requirements: [{ id: 'R1', title: 'Reports', description: 'Report rules', fields: [{ name: 'Month', description: 'Required' }], sourceIds: [], acceptance: [{ id: 'A1', text: 'Report visible' }] }, { id: 'R2', title: 'Unrelated', description: 'UNRELATED_RULE', sourceIds: [], acceptance: [{ id: 'A2', text: 'Other page' }] }],
  }
  const project: RequirementProject = {
    schemaVersion: 1, id: randomUUID(), ownerId: 7, version: 1, title: 'Product', description: 'UNRELATED_PROJECT_DESCRIPTION',
    modelId: 'auto', createdAt: '', updatedAt: '', status: 'draft', sources: [], evidence: [], questions: [], decisions: [], jobs: [], events: [],
    revisions: [{ id: 'v1', createdAt: '', prd, ...validatePrototypeDesign([prototype], prd, [
      { id: 'S2', title: 'Unrelated', state: 'normal', requirementIds: ['R2'], acceptanceIds: ['A2'], html: '<!doctype html><html><body><main data-requirement-id="R2" data-acceptance-id="A2">UNRELATED_HTML</main></body></html>' },
    ]) }],
  }
  const blocks = prd.blocks.map(block => ({ blockId: block.id, kind: 'new' as const, reason: 'Confirmed independent new page' }))
  project.revisions[0].capturePlan = { version: 1, fingerprint: captureFingerprint(project, prd, blocks), blocks }
  project.revisions[0].existingPages = []
  return { project, prototype }
}
function sdk() {
  const configs: SessionConfig[] = []
  const resumed: string[] = []
  const prompts: string[] = []
  let answer = ''
  let failRestore = false
  let onSend: ((config: SessionConfig) => Promise<void>) | undefined
  let activeHandlers = new Set<(event: SessionEvent) => void>()
  const factory: NonNullable<RequirementModelOptions['clientFactory']> = () => {
    const open = (id: string, config: SessionConfig) => {
      const handlers = new Set<(event: SessionEvent) => void>()
      activeHandlers = handlers
      return {
        sessionId: id,
        on(handler: (event: SessionEvent) => void) { handlers.add(handler); return () => handlers.delete(handler) },
        async send(options: Parameters<CopilotSession['send']>[0]) {
          prompts.push(options.prompt)
          await onSend?.(config)
          setImmediate(() => {
            for (const handler of handlers) handler({ type: 'assistant.message', data: { content: answer } } as SessionEvent)
            for (const handler of handlers) handler({ type: 'session.idle', data: {} } as SessionEvent)
          })
          return randomUUID()
        },
        async disconnect() {},
        async abort() {},
      } as CopilotSession
    }
    return {
      async createSession(config) { configs.push(config); return open(config.sessionId!, config) },
      async resumeSession(id, config) {
        resumed.push(id)
        assert.equal(config.continuePendingWork, false)
        if (failRestore) throw new Error('Session not found: private error')
        return open(id, config)
      },
      async stop() { return [] },
    }
  }
  return { factory, configs, resumed, prompts, setAnswer(value: RequirementPrototype) { answer = JSON.stringify({ prototypes: [value] }) }, failRestore() { failRestore = true }, onSend(fn: typeof onSend) { onSend = fn }, emit(event: SessionEvent) { for (const handler of activeHandlers) handler(event) } }
}
function context(root: string, project: RequirementProject, entries: RequirementConversationEntry[]): Parameters<RequirementModel['generate']>[2] {
  return {
    root, token: 'private-token', signal: new AbortController().signal, onProgress: async () => {},
    designAdjustment: { screenId: project.revisions[0].screens.find(screen => screen.prototypeId === 'PAGE-1')!.id, instruction: 'Align report columns and improve spacing' },
    recordConversation: async entry => { entries.push(entry) },
    savePrototypeConversation: async binding => {
      project.prototypeConversations = [...(project.prototypeConversations ?? []).filter(item => item.prototypeId !== binding.prototypeId), structuredClone(binding)]
    },
  }
}
test('UI adjustment input contains only the target prototype and all its linked requirements', () => {
  const { project } = fixture()
  const input = buildPrototypeAdjustmentInput(project, 'S1')
  assert.equal(input.prd.requirements.length, 1)
  assert.equal(input.prd.requirements[0].fields?.[0].name, 'Month')
  assert.deepEqual(input.prd.requirements[0].acceptance, [{ id: 'A1', text: 'Report visible' }])
  assert.equal(input.originalPages.length, 0)
  assert.doesNotMatch(JSON.stringify(input), /UNRELATED_/)
})
test('UI adjustment supports multi-view discovery existingPages baselines on the same block', () => {
  const { project } = fixture()
  const revision = project.revisions[0]
  const blocks = [{ blockId: 'B1', kind: 'existing' as const, reason: 'Shared detail branches' }, { blockId: 'B2', kind: 'new' as const, reason: 'Unrelated' }]
  const hash = captureFingerprint(project, revision.prd, blocks)
  revision.capturePlan = { version: 1, fingerprint: hash, blocks, views: [{ blockId: 'B1', viewId: 'B1-self' }, { blockId: 'B1', viewId: 'B1-test' }] }
  revision.existingPages = ['B1-self', 'B1-test'].map((viewId, index) => ({
    blockId: 'B1', viewId, path: `/plans/detail?planId=${index + 1}`, capturedAt: revision.createdAt, fingerprint: hash, structure: '{}',
    image: { id: `IMG-${index}`, name: `${viewId}.png`, kind: 'file', sizeBytes: 32, sha256: 'c'.repeat(64), storageKey: `requirements/${viewId}.png` },
  }))
  const input = buildPrototypeAdjustmentInput(project, 'S1')
  assert.equal(input.originalPages.length, 2)
  assert.deepEqual(input.originalPages.map(page => page.viewId), ['B1-self', 'B1-test'])
})
test('UI adjustment accepts unmodified legacy classification after MySQL reorders scope keys, without rewriting history', () => {
  const { project } = fixture()
  const revision = project.revisions[0]
  revision.prd = validatePrd(revision.prd, [])
  const plan = revision.capturePlan!
  plan.fingerprint = createHash('sha256').update(JSON.stringify({
    policy: 'classified-scope-v2', preview: project.preview, prd: revision.prd,
    sources: project.sources.map(source => ({ id: source.id, sha256: source.sha256 })),
    blocks: plan.blocks, description: project.description, decisions: project.decisions,
  })).digest('hex')
  const persisted: RequirementProject = JSON.parse(JSON.stringify(project, (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.length - right.length || left.localeCompare(right))) : value))
  const before = structuredClone(persisted)
  assert.deepEqual(Object.keys(persisted.revisions[0].capturePlan!.blocks[0]), ['kind', 'reason', 'blockId'])
  const input = buildPrototypeAdjustmentInput(persisted, 'S1')
  assert.equal(input.originalPages.length, 0)
  assert.equal(input.scope[0].kind, 'new')
  assert.deepEqual(persisted, before)
  persisted.revisions[0].prd.requirements[0].description += ' changed business rule'
  assert.throws(() => buildPrototypeAdjustmentInput(persisted, 'S1'), /PAGE_CAPTURE_BASELINE/)
})
test('UI adjustment rejects missing classification and stale or missing existing-page baselines', () => {
  const { project } = fixture()
  delete project.revisions[0].capturePlan
  assert.throws(() => buildPrototypeAdjustmentInput(project, 'S1'), /DESIGN_ADJUSTMENT_SCOPE/)
  const value = fixture().project
  value.revisions[0].capturePlan!.blocks[0].kind = 'existing'
  assert.throws(() => buildPrototypeAdjustmentInput(value, 'S1'), /PAGE_CAPTURE_BASELINE/)
  const fallback = fixture().project
  const blocks = [{ blockId: 'B1', kind: 'existing' as const, reason: 'Existing page reconstructed from source' }, { blockId: 'B2', kind: 'new' as const, reason: 'Unrelated' }]
  fallback.revisions[0].capturePlan = { version: 1, fingerprint: captureFingerprint(fallback, fallback.revisions[0].prd, blocks), blocks, sourceFallback: { code: 'PAGE_CAPTURE_TARGET', blocks: [{ blockId: 'B1', fields: ['Report'], content: [] }] } }
  delete fallback.revisions[0].existingPages
  const input = buildPrototypeAdjustmentInput(fallback, 'S1')
  assert.equal(input.originalPages.length, 0)
  assert.deepEqual(input.sourceFallback, [{ blockId: 'B1', fields: ['Report'], content: [] }])
})
test('UI adjustment excludes all PRD writing resources and duplicate derived HTML; resumes across jobs and model instances', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ui-adjustment-session-'))
  const { project, prototype } = fixture()
  const fake = sdk()
  const entries: RequirementConversationEntry[] = []
  fake.setAnswer({ ...prototype, html: prototype.html.replace('Report</main>', 'Aligned report</main>') })
  try {
    let options = context(root, project, entries)
    const result = await new CopilotRequirementModel({ clientFactory: fake.factory }).generate('design', project, options)
    const first = fake.prompts[0]
    assert.match(first, /ui-ux-pro-max/)
    assert.match(first, /Query Contract/)
    assert.match(first, /Align report columns/)
    assert.doesNotMatch(first, /RESOURCE prd-|USER-FACING PRD POLICY|UNRELATED_|prd-outline|quality-gates/)
    assert.equal(first.split(prototype.html.replaceAll('"', '\\"')).length - 1, 1)
    assert.doesNotMatch(JSON.stringify(fake.configs[0].systemMessage), /USER-FACING PRD POLICY|prd-outline/)
    assert.deepEqual(fake.configs[0].availableTools, ['ui_ux_search'])
    project.revisions[0].prototypes = result.prototypes
    project.revisions[0].screens = result.screens!
    project.revisions[0].prototypes![0].states[0].id = 'S-NEW'
    project.revisions[0].screens.find(screen => screen.prototypeId === 'PAGE-1')!.id = 'S-NEW'
    fake.setAnswer({ ...project.revisions[0].prototypes![0], html: result.prototypes![0].html.replace('Aligned report', 'Aligned report again') })
    options = context(root, project, entries)
    await new CopilotRequirementModel({ clientFactory: fake.factory }).generate('design', structuredClone(project), options)
    assert.equal(fake.configs.length, 1)
    assert.deepEqual(fake.resumed, [project.prototypeConversations![0].sdkSessionId])
    assert.doesNotMatch(fake.prompts[1], /Query Contract|<html>|Report rules/)
    assert.match(fake.prompts[1], /S-NEW/)
    assert.equal(new Set(entries.map(entry => entry.conversationId)).size, 1)
    assert.ok(entries.some(entry => entry.kind === 'session.resumed'))
    assert.doesNotMatch(JSON.stringify(entries), /private-token/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('static validation feedback continues the same SDK session without re-sending a known failed candidate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ui-adjustment-retry-'))
  const { project, prototype } = fixture()
  const fake = sdk()
  const entries: RequirementConversationEntry[] = []
  const candidate = { ...prototype, html: prototype.html.replace('Report</main>', 'Candidate</main>') }
  fake.setAnswer(candidate)
  try {
    const options = context(root, project, entries)
    await new CopilotRequirementModel({ clientFactory: fake.factory }).generate('design', project, options)
    options.designAdjustment!.validationFeedback = { reason: 'Missing visible mapping', candidate: { prototypes: [candidate] }, states: [{ screenId: 'S1', state: 'normal', viewports: [{ width: 1600, height: 1000, errors: ['Missing visible mapping: A1'] }] }] }
    fake.setAnswer({ ...candidate, html: candidate.html.replace('Candidate', 'Fixed candidate') })
    await new CopilotRequirementModel({ clientFactory: fake.factory }).generate('design', project, options)
    assert.equal(fake.configs.length, 1)
    assert.equal(fake.resumed.length, 1)
    assert.match(fake.prompts[1], /STATIC VALIDATION RETRY \(1\/1\)|Missing visible mapping: A1/)
    assert.doesNotMatch(fake.prompts[1], /<html>|Query Contract/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('session restore failure never opens a replacement session or sends another request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ui-adjustment-restore-failure-'))
  const { project, prototype } = fixture()
  const fake = sdk()
  fake.setAnswer(prototype)
  try {
    const options = context(root, project, [])
    await new CopilotRequirementModel({ clientFactory: fake.factory }).generate('design', project, options)
    fake.failRestore()
    await assert.rejects(new CopilotRequirementModel({ clientFactory: fake.factory }).generate('design', project, options), /PROTOTYPE_SESSION_RESTORE/)
    assert.equal(fake.configs.length, 1)
    assert.equal(fake.prompts.length, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('SDK compaction refreshes authoritative UI context on the next turn without changing sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ui-adjustment-compaction-'))
  const { project, prototype } = fixture()
  const fake = sdk()
  fake.setAnswer(prototype)
  fake.onSend(async () => { fake.emit({ type: 'session.compaction_complete', data: { success: true } } as SessionEvent) })
  try {
    const options = context(root, project, [])
    await new CopilotRequirementModel({ clientFactory: fake.factory }).generate('design', project, options)
    assert.equal(project.prototypeConversations![0].prototypeFingerprint, undefined)
    fake.onSend(undefined)
    await new CopilotRequirementModel({ clientFactory: fake.factory }).generate('design', project, options)
    assert.equal(fake.configs.length, 1)
    assert.equal(fake.resumed.length, 1)
    assert.match(fake.prompts[1], /Report rules|Query Contract/)
    assert.match(fake.prompts[1], /<html>/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('existing-page adjustments attach only the original target page, while new pages carry no original screenshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ui-adjustment-original-page-'))
  const { project, prototype } = fixture()
  const fake = sdk()
  const entries: RequirementConversationEntry[] = []
  try {
    const image = await storeSourceFile(root, project.ownerId, project.id, 'original.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'))
    const revision = project.revisions[0]
    revision.capturePlan!.blocks[0].kind = 'existing'
    revision.capturePlan!.fingerprint = captureFingerprint(project, revision.prd, revision.capturePlan!.blocks)
    revision.existingPages = [{ blockId: 'B1', path: '/reports', capturedAt: '2026-11-06T00:00:00.000Z', fingerprint: revision.capturePlan!.fingerprint, image, structure: '{"regions":[{"width":1600,"height":1000}]}' }]
    const input = buildPrototypeAdjustmentInput(project, 'S1')
    assert.equal(input.originalPages[0].image.id, image.id)
    fake.setAnswer(prototype)
    await new CopilotRequirementModel({ clientFactory: fake.factory }).generate('design', project, context(root, project, entries))
    const request = entries.find(entry => entry.kind === 'request')!
    const attachments = request.body.attachments as { displayName: string; sha256: string }[]
    assert.equal(attachments.length, 1)
    assert.equal(attachments[0].sha256, image.sha256)
    assert.match(attachments[0].displayName, /ORIGINAL PLATFORM PAGE B1 \/reports/)
    assert.match(fake.prompts[0], /BEFORE REQUIREMENT CHANGES/)
    assert.equal(buildPrototypeAdjustmentInput(project, 'S2').originalPages.length, 0)
    const chunks = entries.filter(entry => entry.kind === 'attachment.chunk')
    assert.equal(Buffer.from(String(chunks[0].body.content), 'base64').toString('base64'), (await readSourceFile(root, project.ownerId, project.id, image)).buffer.toString('base64'))
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('UI skill uses actual local query results and blocks tools during structural correction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ui-adjustment-skill-'))
  const { project, prototype } = fixture()
  const fake = sdk()
  let queried = false
  fake.setAnswer(prototype)
  fake.onSend(async config => {
    const tool = config.tools![0]
    const args = { query: 'table alignment spacing', domain: 'ux' }
    const result = await tool.handler!(args, { sessionId: config.sessionId!, toolCallId: 'search', toolName: tool.name, arguments: args })
    assert.ok(result && typeof result === 'object' && 'domain' in result && result.domain === 'ux')
    assert.ok('results' in result && Array.isArray(result.results) && result.results.length > 0)
    queried = true
    assert.equal((await config.hooks!.onPreToolUse!({ toolName: 'shell' } as never, {} as never))?.permissionDecision, 'deny')
  })
  try {
    await new CopilotRequirementModel({ clientFactory: fake.factory }).generate('design', project, context(root, project, []))
    assert.equal(queried, true)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('binding and audit failures stop UI requests; missing session files never cause a silent replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ui-adjustment-fail-closed-'))
  try {
    for (const kind of ['binding', 'request', 'assistant.message', 'session.finish']) {
      const { project, prototype } = fixture()
      const fake = sdk()
      fake.setAnswer(prototype)
      const options = context(root, project, [])
      if (kind === 'binding') options.savePrototypeConversation = async () => { throw new Error('private database details') }
      else options.recordConversation = async entry => { if (entry.kind === kind) throw new Error('private database details') }
      await assert.rejects(new CopilotRequirementModel({ clientFactory: fake.factory }).generate('design', project, options), /CONVERSATION_STORAGE/)
      assert.equal(fake.prompts.length, ['binding', 'request'].includes(kind) ? 0 : 1)
    }
    const { project, prototype } = fixture()
    const fake = sdk()
    fake.setAnswer(prototype)
    const options = context(root, project, [])
    await new CopilotRequirementModel({ clientFactory: fake.factory }).generate('design', project, options)
    const path = join(root, 'requirements', 'prototype-sessions', '7', project.id, project.prototypeConversations![0].conversationId)
    await rm(path, { recursive: true })
    await assert.rejects(new CopilotRequirementModel({ clientFactory: fake.factory }).generate('design', project, options), /PROTOTYPE_SESSION_RESTORE/)
    assert.equal(fake.configs.length, 1)
    assert.equal(fake.resumed.length, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('UI adjustment reports SDK progress summaries and fails explicitly if progress cannot be saved', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ui-adjustment-progress-'))
  try {
    for (const failProgress of [false, true]) {
      const { project, prototype } = fixture()
      const fake = sdk()
      fake.setAnswer(prototype)
      fake.onSend(async () => { fake.emit({ type: 'assistant.message_delta', data: { deltaContent: 'PRIVATE_MODEL_CONTENT' } } as SessionEvent) })
      const entries: RequirementConversationEntry[] = []
      const options = context(root, project, entries)
      const progress: string[] = []
      options.onProgress = async text => {
        progress.push(text)
        if (failProgress && text.includes('模型正在响应')) throw new Error('private database details')
      }
      const work = new CopilotRequirementModel({ clientFactory: fake.factory }).generate('design', project, options)
      if (failProgress) {
        await assert.rejects(work, /STORAGE/)
        assert.equal(entries.at(-1)?.body.status, 'failed')
        assert.equal(project.prototypeConversations?.[0].contextFingerprint, undefined)
      } else {
        await work
        assert(progress.some(text => text.includes('正在发送请求')))
        assert(progress.some(text => text.includes('模型正在响应')))
        assert(progress.some(text => text.includes('模型已返回消息')))
        assert.doesNotMatch(progress.join('\n'), /PRIVATE_MODEL_CONTENT/)
      }
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('cancellation and rejected skill operations settle promptly without waiting for the inactivity timer', { timeout: 5000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ui-adjustment-cancel-'))
  try {
    for (const cancelled of [true, false]) {
      const { project, prototype } = fixture()
      const fake = sdk()
      const entries: RequirementConversationEntry[] = []
      const controller = new AbortController()
      fake.setAnswer(prototype)
      fake.onSend(async config => {
        if (cancelled) controller.abort()
        else await config.tools![0].handler!({ query: 'spacing', domain: 'ux', path: 'unavailable' }, { sessionId: config.sessionId!, toolCallId: 'invalid', toolName: 'ui_ux_search', arguments: {} })
      })
      const options = { ...context(root, project, entries), signal: controller.signal }
      await assert.rejects(new CopilotRequirementModel({ clientFactory: fake.factory }).generate('design', project, options), cancelled ? /cancelled/ : /DESIGN_SEARCH/)
      assert.equal(entries.at(-1)?.body.status, cancelled ? 'cancelled' : 'failed')
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})
for (const exhaustedCorrection of [false, true]) {
  test(`service persists the same prototype session across static retry and restart; exhausted correction=${exhaustedCorrection}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'ui-adjustment-service-'))
    const fake = sdk()
    const actual = new CopilotRequirementModel({ clientFactory: fake.factory })
    const seed = fixture()
    const prd = { ...seed.project.revisions[0].prd, blocks: seed.project.revisions[0].prd.blocks.slice(0, 1), requirements: seed.project.revisions[0].prd.requirements.slice(0, 1) }
    let turns = 0, checks = 0, generations = 0
    let candidate = seed.prototype
    fake.onSend(async () => {
      turns++
      fake.setAnswer(exhaustedCorrection && [1, 3].includes(turns) ? { ...candidate, html: candidate.html.replace('data-requirement-id="R1"', '') } : candidate)
    })
    const model: RequirementModel = { generate: async (stage, project, options) => {
      if (stage === 'analyze') return { evidence: [], questions: [] }
      if (stage === 'prd') {
        const blocks = [{ blockId: 'B1', kind: 'new' as const, reason: 'Confirmed new report' }]
        return { prd, existingPages: [], capturePlan: { version: 1, blocks, fingerprint: captureFingerprint(project, prd, blocks) } }
      }
      const screen = project.revisions.at(-1)!.screens[0]
      candidate = { ...seed.prototype, html: seed.prototype.html.replace('Report</main>', `Aligned report ${++generations}</main>`), states: [{ id: screen.id, name: screen.state, requirementIds: screen.requirementIds, acceptanceIds: screen.acceptanceIds, changes: [] }] }
      return actual.generate(stage, project, options)
    } }
    const validate: typeof validatePrototypeRevision = async (_project, revision) => {
      const rejected = ++checks === 1
      return { ...revision, screenshots: revision.screens.map(screen => ({ screenId: screen.id, storageKey: 'fixture', sha256: 'a'.repeat(64) })), validation: {
        at: new Date().toISOString(), artifactVersion: 1, inputSha256: 'a'.repeat(64), allScreensValidated: !rejected,
        interactionVerified: false, mode: 'static-script-disabled', limitations: [],
        errors: rejected ? [`${revision.screens[0].id} (1600x1000): Missing visible mapping: A1`] : [],
        screens: revision.screens.map(screen => ({ screenId: screen.id, visual: rejected ? 'failed' : 'passed', interaction: 'not_verified', interactionErrors: [], viewports: [{ width: 1600, height: 1000, errors: rejected ? ['Missing visible mapping: A1'] : [] }] })),
      } }
    }
    let service: RequirementService | undefined
    try {
      const repository = new JsonRequirementRepository(root)
      await repository.verify()
      service = new RequirementService(repository, root, { model, validatePrototype: validate })
      let project = await service.create(7, { title: 'Reports', description: 'Report page', modelId: 'auto' }, 'fixture')
      for (const stage of ['analyze', 'prd'] as const) {
        await service.launch(7, project.id, { stage, expectedVersion: project.version }, 'fixture')
        await service.wait(project.id)
        project = await service.detail(7, project.id)
      }
      project = await service.confirm(7, project.id, { target: 'prd', expectedVersion: project.version })
      const { prototypeId: _prototypeId, ...legacyScreen } = seed.project.revisions[0].screens.find(screen => screen.id === 'S1')!
      project = await service.editDesign(7, project.id, { expectedVersion: project.version, screens: [legacyScreen] })
      const original = structuredClone(project.revisions.at(-1))
      await service.launch(7, project.id, { stage: 'design', screenId: project.revisions.at(-1)!.screens[0].id, instruction: 'Align columns', expectedVersion: project.version }, 'fixture')
      await service.wait(project.id)
      project = await service.detail(7, project.id)
      assert.equal(project.jobs.at(-1)?.status, exhaustedCorrection ? 'failed' : 'succeeded', project.jobs.at(-1)?.error)
      assert.equal(fake.configs.length, 1)
      assert.equal(fake.resumed.length, 1)
      if (exhaustedCorrection) {
        assert.equal(turns, 3)
        assert.deepEqual(project.revisions.at(-1), original)
      } else {
        assert.equal(project.prototypeConversations![0].prototypeId, 'PAGE-1')
        const sdkId = project.prototypeConversations![0].sdkSessionId
        const firstJob = project.jobs.at(-1)!
        const directory = join(root, 'requirements', 'conversations', project.id, firstJob.id)
        const files = await readdir(directory)
        assert.equal(files.length, 1)
        const entries = (await readFile(join(directory, files[0]), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as RequirementConversationEntry)
        assert.deepEqual(entries.map(entry => entry.sequence), entries.map((_entry, index) => index + 1))
        assert.deepEqual(entries.filter(entry => entry.kind === 'request').map(entry => entry.requestIndex), [1, 2])
        await service.close()
        const restoredRepository = new JsonRequirementRepository(root)
        await restoredRepository.verify()
        service = new RequirementService(restoredRepository, root, { model, validatePrototype: validate })
        await service.launch(7, project.id, { stage: 'design', screenId: project.revisions.at(-1)!.screens[0].id, instruction: 'Improve heading', expectedVersion: project.version }, 'fixture')
        await service.wait(project.id)
        project = await service.detail(7, project.id)
        assert.equal(project.jobs.at(-1)?.status, 'succeeded', project.jobs.at(-1)?.error)
        assert.equal(project.prototypeConversations![0].sdkSessionId, sdkId)
        assert.equal(fake.configs.length, 1)
        assert.equal(fake.resumed.length, 2)
        assert.doesNotMatch(fake.prompts.at(-1)!, /<html>|Query Contract|Report rules/)
      }
    } finally { await service?.close(); await rm(root, { recursive: true, force: true }) }
  })
}
