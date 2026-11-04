import type { AcceptanceRequirement, SelfTestCase } from '../../shared/task.js'
import { assessAcceptance } from './acceptance.js'

export interface TestPlanPolicy { batchSize: number; maxCases: number; optionalMaxCases?: number }
export interface CoverageTarget { requirementId: string; scenario: NonNullable<SelfTestCase['scenario']> }

export function testPlanPolicy(environment: NodeJS.ProcessEnv = process.env): TestPlanPolicy {
  const integer = (name: string, fallback: number, maximum: number, minimum = 1) => {
    const value = environment[name]
    if (value === undefined) return fallback
    if (!/^\d+$/.test(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(`${name} 必须为 ${minimum} 至 ${maximum} 的整数`)
    return Number(value)
  }
  const maxCases = integer('SELF_TEST_MAX_CASES', 300, 1000)
  return { batchSize: Math.min(integer('SELF_TEST_BATCH_SIZE', 8, 20), maxCases), maxCases, optionalMaxCases: integer('SELF_TEST_OPTIONAL_MAX_CASES', 16, 1000, 0) }
}

export function missingCoverage(baseline: AcceptanceRequirement[], cases: SelfTestCase[], scope: 'required' | 'optional' | 'all' = 'required'): CoverageTarget[] {
  const optionalBaseline = baseline.map((item) => ({ ...item, required: false }))
  const valid = cases.filter((item) => !assessAcceptance(optionalBaseline, [item]).issues.length)
  return baseline.filter((item) => scope === 'all' || item.required === (scope === 'required')).flatMap((item) => item.scenarios
    .filter((scenario) => !valid.some((testCase) => testCase.scenario === scenario && testCase.requirementIds?.includes(item.id)))
    .map((scenario) => ({ requirementId: item.id, scenario })))
}

export function batches<T>(items: T[], size: number): T[][] {
  const result: T[][] = []
  for (let offset = 0; offset < items.length; offset += size) result.push(items.slice(offset, offset + size))
  return result
}