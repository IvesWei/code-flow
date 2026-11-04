import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AcceptanceRequirement, SelfTestCase } from '../../shared/task.js'
import { buildTestPlanGenerationPrompt } from '../execution/prompts.js'
import { generateTestBatches } from './test-plan-generation.js'

const baseline: AcceptanceRequirement[] = Array.from({ length: 15 }, (_, index) => ({ id: `REQ-${String(index + 1).padStart(3, '0')}`, source: 'PRD', criterion: `保存 ${index}`, required: true, scenarios: ['normal'] }))
const caseFor = (requirementId: string) => ({ title: requirementId, source: 'PRD', steps: '保存后查询', expected: '一致', requirementIds: [requirementId], scenario: 'normal', preconditions: '独立环境', testData: '数据', assertions: ['真实查询一致'], cleanup: '删除数据' })

test('structured descriptions pass batch validation without wasting retries or losing the raw draft', async () => {
  const raw = JSON.stringify([{ ...caseFor('REQ-001'), preconditions: ['独立环境', '账号已登录'], testData: { name: '记录', count: 1 }, cleanup: ['删除记录'] }])
  let sends = 0
  const drafts: string[] = []
  const cases = await generateTestBatches({ baseline: baseline.slice(0, 1), previous: [], repairIds: [], policy: { batchSize: 5, maxCases: 10 }, instruction: '保存', issues: [],
    send: async () => { sends++; return raw },
    save: async (_items, draft) => { if (draft) drafts.push(draft) }, log: () => {},
  })
  assert.equal(sends, 1)
  assert.deepEqual(drafts, [raw])
  assert.equal(cases[0].preconditions, '独立环境\n账号已登录')
  assert.equal(cases[0].testData, '{"name":"记录","count":1}')
  assert.equal(cases[0].cleanup, '删除记录')
})

test('invalid descriptions produce field-specific retry feedback and cannot commit candidate cases', async () => {
  let sends = 0, validSaves = 0
  const cases = await generateTestBatches({ baseline: baseline.slice(0, 1), previous: [], repairIds: [], policy: { batchSize: 1, maxCases: 10 }, instruction: '保存', issues: [],
    send: async prompt => {
      sends++
      if (sends === 1) return JSON.stringify([{ ...caseFor('REQ-001'), cleanup: [] }])
      assert.match(prompt, /本批上次失败，必须修正：.*cleanup.*array/)
      return JSON.stringify([caseFor('REQ-001')])
    },
    save: async (_items, draft) => { if (!draft) validSaves++ }, log: () => {},
  })
  assert.equal(sends, 2)
  assert.equal(validSaves, 1)
  assert.equal(cases.length, 1)
  sends = 0
  await assert.rejects(generateTestBatches({ baseline: baseline.slice(0, 1), previous: [], repairIds: [], policy: { batchSize: 1, maxCases: 10 }, instruction: '保存', issues: [],
    send: async () => { sends++; return JSON.stringify([{ ...caseFor('REQ-001'), cleanup: '' }]) },
    save: async (_items, draft) => { assert.ok(draft, 'invalid candidates must not be saved') }, log: () => {},
  }), /批次 1生成失败：.*cleanup.*不能为空/)
  assert.equal(sends, 3)
})

test('generation sends the preserved builder output with current retry feedback and first-attempt draft', async () => {
  const requirements = baseline.slice(0, 1)
  const instruction = '保存\r\n用户输入'
  const context = '附件上下文\n保持顺序'
  const testScript = 'node --test'
  const issues = ['原验收问题']
  const draft = 'x'.repeat(24001)
  let sends = 0
  const savedDrafts: string[] = []
  const cases = await generateTestBatches({ baseline: requirements, previous: [], repairIds: [], policy: { batchSize: 1, maxCases: 10 }, instruction, context, testScript, issues, draft,
    send: async (prompt, batch) => {
      const attempt = sends++
      const feedback = attempt === 0 ? '' : prompt.split('本批上次失败，必须修正：')[1]
      if (attempt > 0) {
        assert.ok(feedback)
        assert.ok(!prompt.includes('未解析的上一批草稿'))
      }
      assert.deepEqual(batch, { repairIds: [], coverage: [{ requirementId: 'REQ-001', scenario: 'normal' }] })
      assert.deepEqual(Buffer.from(prompt), Buffer.from(buildTestPlanGenerationPrompt({
        baseline: requirements, cases: [], repairIds: [], coverage: batch.coverage, capacity: 1,
        instruction, context, testScript, issues, draft, feedback, attempt,
      })))
      return attempt === 0 ? 'not JSON' : JSON.stringify([caseFor('REQ-001')])
    },
    save: async (_items, content) => { if (content !== undefined) savedDrafts.push(content) }, log: () => {},
  })
  assert.equal(sends, 2)
  assert.deepEqual(savedDrafts, ['not JSON', JSON.stringify([caseFor('REQ-001')])])
  assert.deepEqual(cases.map((item) => item.requirementIds), [['REQ-001']])
})

test('required coverage consumes budget first and optional shortages do not reject planning', async () => {
  let saved: SelfTestCase[] = []
  const requirements = [{ ...baseline[0], required: false }, baseline[1], { ...baseline[2], required: false }]
  const cases = await generateTestBatches({ baseline: requirements, previous: [], repairIds: [], policy: { batchSize: 1, maxCases: 2, optionalMaxCases: 1 }, instruction: 'Test', issues: [],
    send: async () => JSON.stringify([caseFor(saved.length === 0 ? 'REQ-002' : 'REQ-001')]),
    save: async (items) => { saved = structuredClone(items) }, log: () => {},
  })
  assert.deepEqual(cases.map((item) => item.requirementIds), [['REQ-002'], ['REQ-001']])
})

test('fifteen requirement scenarios generate three batches and persist each without overwriting', async () => {
  let saved: SelfTestCase[] = [], sends = 0
  const snapshots: number[] = []
  const cases = await generateTestBatches({ baseline, previous: [], repairIds: [], policy: { batchSize: 6, maxCases: 30 }, instruction: '保存', issues: [],
    send: async (prompt) => {
      sends++
      assert.match(prompt, /当前批次必须覆盖/)
      return JSON.stringify(baseline.slice(saved.length, saved.length + 6).map((item) => caseFor(item.id)))
    },
    save: async (items, draft) => { saved = structuredClone(items); if (!draft) snapshots.push(items.length) }, log: () => {},
  })
  assert.equal(sends, 3)
  assert.deepEqual(snapshots, [6, 12, 15])
  assert.equal(cases[14].id, 'TC-15')
  assert.equal(new Set(cases.map((item) => item.id)).size, 15)
})

test('interrupted generation resumes uncovered scenarios and retains passed evidence', async () => {
  let saved: SelfTestCase[] = []
  await assert.rejects(generateTestBatches({ baseline, previous: [], repairIds: [], policy: { batchSize: 6, maxCases: 30 }, instruction: '保存', issues: [],
    send: async () => { if (saved.length) throw new Error('interrupted'); return JSON.stringify(baseline.slice(0, 6).map((item) => caseFor(item.id))) },
    save: async (items) => { saved = structuredClone(items) }, log: () => {},
  }), /interrupted/)
  saved[0] = { ...saved[0], status: 'passed', output: 'proof' }
  const first = structuredClone(saved[0])
  const cases = await generateTestBatches({ baseline, previous: saved, repairIds: [], policy: { batchSize: 6, maxCases: 30 }, instruction: '保存', issues: [],
    send: async () => JSON.stringify(baseline.slice(saved.length, saved.length + 6).map((item) => caseFor(item.id))),
    save: async (items) => { saved = structuredClone(items) }, log: () => {},
  })
  assert.equal(cases.length, 15)
  assert.deepEqual(cases[0], first)
})

test('total cap stops explicitly with saved batches and missing coverage rather than truncating', async () => {
  let saved: SelfTestCase[] = [], sends = 0
  await assert.rejects(generateTestBatches({ baseline, previous: [], repairIds: [], policy: { batchSize: 6, maxCases: 10 }, instruction: '保存', issues: [],
    send: async () => { sends++; return JSON.stringify(baseline.slice(saved.length, Math.min(10, saved.length + 6)).map((item) => caseFor(item.id))) },
    save: async (items) => { saved = structuredClone(items) }, log: () => {},
  }), /安全上限 10.*5 个需求场景未覆盖/)
  assert.equal(saved.length, 10)
  assert.equal(sends, 2)
})

test('malformed or incomplete batches are retried locally without discarding earlier results', async () => {
  let sends = 0, saved: SelfTestCase[] = []
  const cases = await generateTestBatches({ baseline: baseline.slice(0, 2), previous: [], repairIds: [], policy: { batchSize: 1, maxCases: 10 }, instruction: '保存', issues: [],
    send: async () => { sends++; return sends === 2 ? 'not JSON' : JSON.stringify([caseFor(baseline[saved.length].id)]) },
    save: async (items) => { saved = structuredClone(items) }, log: () => {},
  })
  assert.equal(sends, 3)
  assert.deepEqual(cases.map((item) => item.id), ['TC-01', 'TC-02'])
})

test('failed cases are repaired in bounded batches and passed cases are never replaced', async () => {
  const previous = baseline.map((item, index) => ({ ...caseFor(item.id), id: `TC-${String(index + 1).padStart(2, '0')}`, status: index === 0 ? 'passed' : 'failed', output: 'proof' } as SelfTestCase))
  let sends = 0
  const cases = await generateTestBatches({ baseline, previous, repairIds: previous.map((item) => item.id), policy: { batchSize: 6, maxCases: 30 }, instruction: '保存', issues: [],
    send: async (prompt) => {
      sends++
      const targets = JSON.parse(prompt.split('只修正下列用例，')[1].split('\n')[0].split('：')[1]) as SelfTestCase[]
      assert.ok(targets.length <= 6)
      return JSON.stringify(targets.map((item) => caseFor(item.requirementIds![0])))
    }, save: async () => {}, log: () => {},
  })
  assert.equal(sends, 3)
  assert.deepEqual(cases[0], previous[0])
  assert.equal(cases.length, 15)
})

test('persistence failure stops without retrying the model or mutating previous cases', async () => {
  let sends = 0
  const original: SelfTestCase[] = []
  await assert.rejects(generateTestBatches({ baseline: baseline.slice(0, 1), previous: original, repairIds: [], policy: { batchSize: 8, maxCases: 30 }, instruction: '保存', issues: [],
    send: async () => { sends++; return JSON.stringify([caseFor('REQ-001')]) },
    save: async (_items, draft) => { if (!draft) throw new Error('storage failed') }, log: () => {},
  }), /storage failed/)
  assert.equal(sends, 1)
  assert.deepEqual(original, [])
})