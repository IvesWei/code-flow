import type { AcceptanceRequirement, SelfTestCase } from '../../shared/task.js'
import { buildTestPlanGenerationPrompt } from '../execution/prompts.js'
import { assessAcceptance } from './acceptance.js'
import { mergeTestPlan } from './self-test.js'
import { batches, missingCoverage, type TestPlanPolicy } from './test-plan-policy.js'

interface GenerationOptions {
  baseline: AcceptanceRequirement[]
  previous: SelfTestCase[]
  repairIds: string[]
  policy: TestPlanPolicy
  instruction: string
  testScript?: string
  context?: string
  issues: string[]
  draft?: string
  send(prompt: string, batch: { repairIds: string[]; coverage: ReturnType<typeof missingCoverage> }): Promise<string | undefined>
  save(cases: SelfTestCase[], draft?: string): Promise<void>
  log(message: string): void
}

export async function generateTestBatches(options: GenerationOptions): Promise<SelfTestCase[]> {
  const { baseline, policy } = options
  let cases = [...options.previous]
  if (cases.length > policy.maxCases) throw new Error(`现有用例 ${cases.length} 条超过安全上限 ${policy.maxCases}，请调整 SELF_TEST_MAX_CASES；未删除已有用例`)
  let batchNumber = 0
  const generate = async (repairIds: string[], coverage: ReturnType<typeof missingCoverage>, optionalCapacity?: number) => {
    batchNumber++
    const capacity = repairIds.length ? policy.batchSize : Math.min(policy.batchSize, policy.maxCases - cases.length, optionalCapacity ?? policy.maxCases)
    if (!capacity) throw new Error(`已达到用例安全上限 ${policy.maxCases}，仍有 ${missingCoverage(baseline, cases).length} 个需求场景未覆盖；未截断需求，请调整 SELF_TEST_MAX_CASES`)
    let feedback = ''
    for (let attempt = 0; attempt < 3; attempt++) {
      options.log(`用例批次 ${batchNumber}：${repairIds.length ? `修正 ${repairIds.length} 条用例` : `补齐 ${coverage.length} 个需求场景`}，已保存 ${cases.length} 条（第 ${attempt + 1} 次尝试）`)
      const prompt = buildTestPlanGenerationPrompt({
        baseline, cases, repairIds, coverage, capacity, feedback, attempt,
        instruction: options.instruction, testScript: options.testScript, context: options.context,
        issues: options.issues, draft: options.draft,
      })
      const content = await options.send(prompt, { repairIds, coverage })
      if (!content) throw new Error('Copilot 没有返回当前批次用例清单')
      await options.save(cases, content)
      let candidate: SelfTestCase[]
      try {
        candidate = mergeTestPlan(content, cases, repairIds.length ? repairIds : undefined, { append: !repairIds.length, maxCases: policy.maxCases, batchSize: capacity, repairManual: true })
        const affected = candidate.filter((item) => repairIds.length ? repairIds.includes(item.id) : !cases.some((previous) => previous.id === item.id))
        const structural = assessAcceptance(baseline.map((item) => ({ ...item, required: false })), affected)
        if (structural.issues.length) throw new Error(structural.issues.join('\n'))
        const remaining = missingCoverage(baseline, candidate, 'all')
        if (coverage.some((target) => remaining.some((item) => item.requirementId === target.requirementId && item.scenario === target.scenario))) throw new Error('本批指定需求场景未全部覆盖，不允许忽略或豁免')
      } catch (error) {
        feedback = error instanceof Error ? error.message : String(error)
        if (attempt === 2) throw new Error(`用例批次 ${batchNumber}生成失败：${feedback}`)
        continue
      }
      await options.save(candidate)
      cases = candidate
      options.log(`用例批次 ${batchNumber}已保存，累计 ${cases.length} 条`)
      return
    }
  }
  const repairs = options.repairIds.filter((id) => cases.some((item) => item.id === id && item.status !== 'passed'))
  for (const repairIds of batches(repairs, policy.batchSize)) await generate(repairIds, [])
  while (true) {
    const missing = missingCoverage(baseline, cases)
    if (!missing.length) break
    const capacity = Math.min(policy.batchSize, policy.maxCases - cases.length)
    await generate([], missing.slice(0, Math.max(1, capacity)))
  }
  const optionalIds = new Set(baseline.filter((item) => !item.required).map((item) => item.id))
  while (true) {
    const missing = missingCoverage(baseline, cases, 'optional')
    if (!missing.length) break
    const optionalCount = cases.filter((item) => item.requirementIds?.length && item.requirementIds.every((id) => optionalIds.has(id))).length
    const capacity = Math.min(policy.batchSize, policy.maxCases - cases.length, (policy.optionalMaxCases ?? 16) - optionalCount)
    if (capacity <= 0) {
      options.log(`补充用例预算已用尽，${missing.length} 个非必验需求场景未生成；不缩减必验覆盖、不阻断验收`)
      break
    }
    await generate([], missing.slice(0, capacity), capacity)
  }
  return cases
}