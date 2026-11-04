import type { CodingTask } from './task.js'

export type TestingLinks = NonNullable<CodingTask['testingLinks']>
export const testingLinkFields = ['planningProjectId', 'caseSetId', 'executionRunId'] as const
export type TestingLinkField = typeof testingLinkFields[number]

export function parseTestingLinks(value: unknown): TestingLinks {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a testing links object')
  const body = value as Record<string, unknown>
  if (Object.keys(body).some(key => !testingLinkFields.includes(key as TestingLinkField))) throw new Error('Only testing link IDs are accepted')
  const links: TestingLinks = {}
  for (const field of testingLinkFields) {
    const id = body[field]
    if (id === undefined || id === null) continue
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,190}$/.test(id)) throw new Error('Invalid testing link ID')
    links[field] = id
  }
  return links
}

export function testingLinkHref(field: TestingLinkField, id: string): string {
  const query: Record<string, string> = field === 'executionRunId' ? { view: 'execution', execution: id }
    : field === 'planningProjectId' ? { view: 'planning', planning: id }
      : { view: 'execution', package: id }
  return `?${new URLSearchParams(query)}`
}

export function testingLinksEditable(task: CodingTask): boolean {
  return ['REVIEW', 'SUCCESS', 'ACCEPTED', 'FAILED'].includes(task.status)
    && !task.modelInTurn && task.modelTurn?.status !== 'running'
}