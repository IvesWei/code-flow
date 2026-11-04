import { SessionProgressTimeout } from '../execution/session-progress.js'
import { RequirementOutputError } from './validation.js'
import { htmlViolationDescriptions } from './html-policy.js'

export type RequirementFailurePhase = 'skills' | 'design_search' | 'sources' | 'prompt' | 'session' | 'model' | 'parse' | 'output_validation' | 'prototype_validation' | 'storage'
const descriptions: Record<RequirementFailurePhase, string> = {
  skills: 'Managed requirement skill resources could not be loaded',
  design_search: 'Local design search failed; check the Python launcher and local skill resources',
  sources: 'Source reading or controlled URL retrieval failed',
  prompt: 'Requirement input preparation failed or exceeded its limit',
  session: 'Copilot session initialization failed',
  model: 'Copilot model request failed; no raw SDK error or output was retained',
  parse: 'Model response was not a valid JSON stage result',
  output_validation: 'Generated output failed contract validation',
  prototype_validation: 'Prototype artifact validation failed',
  storage: 'Saving requirement progress or results failed',
}
const rules = new Set([
  'object expected', 'unexpected field', 'invalid text', 'invalid array size', 'sparse array',
  'nonvisual exemption must explain why no UI exists', 'invalid id', 'duplicate id or reference',
  'dangling reference', 'invalid priority', 'recommendation must equal a choice', 'unknown source',
  'missing source evidence', 'requirement missing from blocks', 'PRD too large',
  'standalone HTML required', 'external or unsafe HTML capability', 'HTML requirement mapping mismatch',
  'visual requirement not covered', 'visual acceptance not covered', 'screens too large',
  'design screen limit exceeded (maximum 40)',
  'invalid shared prototype or state definition', 'shared prototype contains unexpected fields',
  'duplicate prototype node', 'invalid prototype node element', 'prototype change target missing',
  'prototype change has no operation', 'prototype text change requires a leaf text element',
  'prototype value change requires input or textarea', 'duplicate prototype change target',
  'unsafe prototype script or event handler', 'unsafe prototype value target',
  'prototype hidden change requires boolean', 'duplicate prototype state name', 'duplicate prototype id or title',
])
export class RequirementDiagnosticError extends Error {
  constructor(readonly phase: RequirementFailurePhase, readonly code: string, detail: string) {
    super(`[${code}] ${detail}`)
    this.name = 'RequirementDiagnosticError'
  }
}
export function requirementDiagnostic(error: unknown, phase: RequirementFailurePhase): RequirementDiagnosticError {
  if (error instanceof RequirementDiagnosticError) return error
  if (error instanceof SessionProgressTimeout) return new RequirementDiagnosticError('model', 'MODEL_TIMEOUT', 'Model first-response or inactivity deadline exceeded; no automatic retry was made')
  if ((phase === 'model' || phase === 'session') && error instanceof Error) {
    const message = error.message
    const categories: [RegExp, string, string][] = [
      [/context_length_exceeded|maximum context|context window|too many tokens|prompt.{0,40}too (?:long|large)|exceed.{0,40}token.{0,20}limit/i, 'MODEL_CONTEXT_LIMIT', '模型上下文超限，请缩小代码快照范围，或选择支持更大上下文的模型；未自动重试'],
      [/\b413\b|payload too large|request (?:entity|body) too large|message.{0,30}(?:size|length).{0,30}exceed/i, 'MODEL_REQUEST_TOO_LARGE', '模型请求正文过大，请使用相关模块的代码快照；未自动重试'],
      [/\b429\b|rate.?limit|too many requests/i, 'MODEL_RATE_LIMIT', '模型请求被限流，请稍后再试；未自动重试'],
      [/\b401\b|\b403\b|unauthorized|authentication failed|invalid (?:token|credentials)|permission denied/i, 'MODEL_AUTH', 'Copilot 认证或模型访问权限失败，请检查登录状态和模型权限'],
      [/model.{0,50}(?:not found|not available|unsupported)|unsupported model/i, 'MODEL_UNAVAILABLE', '所选模型不可用，请重新读取模型目录并选择可用模型'],
      [/ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|socket hang up/i, 'MODEL_NETWORK', 'Copilot 网络请求失败，请检查服务端网络连接；未自动重试'],
    ]
    for (const [pattern, code, description] of categories) if (pattern.test(message)) return new RequirementDiagnosticError(phase, code, description)
  }
  if (error instanceof RequirementOutputError) {
    const rule = rules.has(error.rule) ? error.rule : 'output contract violation'
    const category = error.htmlViolation && Object.hasOwn(htmlViolationDescriptions, error.htmlViolation) ? error.htmlViolation : undefined
    const screen = Number.isInteger(error.screenNumber) && error.screenNumber! >= 1 && error.screenNumber! <= 100 ? `screen ${error.screenNumber}; ` : ''
    const detail = category ? `${screen}${category}: ${htmlViolationDescriptions[category]}` : `${screen}${rule}`
    return new RequirementDiagnosticError('output_validation', 'OUTPUT_VALIDATION', `Generated output rejected: ${detail}`)
  }
  return new RequirementDiagnosticError(phase, phase.toUpperCase(), descriptions[phase])
}