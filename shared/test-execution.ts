import type { SelfTestCase } from './task.js'

export interface AssertionManifest {
  version: 1
  caseId: string
  definitionKey: string
  assertions: { id: string; definition: string }[]
}

export interface PlaywrightExecutionBinding {
  version: 1
  caseFingerprint: string
  designFingerprint: string
  testSourceFingerprint: string
  testFile: string
  testTitle: string
  project: string
  assertionIds: string[]
  approvedBy: string
  approvedAt: string
  reviewedAt: string
}

export interface TestExecutionResult {
  version: 1
  runner: 'playwright-test'
  caseId: string
  caseFingerprint: string
  status: 'passed' | 'failed' | 'incomplete' | 'blocked'
  reason: string
  assertions: { id: string; status: 'passed' | 'failed' | 'missing'; expectCount: number }[]
  startedAt: string
  finishedAt: string
}

export function buildAssertionManifest(testCase: SelfTestCase): AssertionManifest {
  const definitionKey = JSON.stringify({
    version: 1,
    id: testCase.id,
    title: testCase.title,
    source: testCase.source,
    steps: testCase.steps,
    expected: testCase.expected,
    testFile: testCase.testFile ?? '',
    assertions: testCase.assertions ?? [],
    preconditions: testCase.preconditions ?? '',
    testData: testCase.testData ?? '',
    cleanup: testCase.cleanup ?? '',
    requirementIds: testCase.requirementIds ?? [],
    scenario: testCase.scenario ?? null,
    classification: testCase.classification ? {
      testType: testCase.classification.testType,
      tags: testCase.classification.tags,
      priority: testCase.classification.priority,
      riskReason: testCase.classification.riskReason,
      executionPolicy: testCase.classification.executionPolicy,
    } : null,
  })
  return {
    version: 1,
    caseId: testCase.id,
    definitionKey,
    assertions: (testCase.assertions ?? []).map((definition, index) => ({
      id: `${testCase.id}:A${String(index + 1).padStart(3, '0')}`,
      definition,
    })),
  }
}