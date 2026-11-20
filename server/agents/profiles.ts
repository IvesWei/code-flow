export type AgentRole = 'requirements' | 'design' | 'coding' | 'test-planning' | 'test-review' | 'test-authoring' | 'test-implementation' | 'browser-planning'

interface AgentProfile {
  purpose: string
  tools?: readonly string[]
  permissions: readonly string[]
  children: readonly AgentRole[]
  maxRequests: number
  maxTools: number
}

const workspaceTools = ['workspace_list', 'workspace_search', 'workspace_read', 'workspace_write_notes']
const readTools = ['view', 'glob', 'grep', 'ask_user']
export const agentProfiles: Readonly<Record<AgentRole, AgentProfile>> = {
  requirements: {
    purpose: 'Analyze supplied evidence, clarify material uncertainty and produce the requested PRD. Do not design prototypes, code, execute tests or approve work.',
    tools: workspaceTools, permissions: [], children: [], maxRequests: 12, maxTools: 128,
  },
  design: {
    purpose: 'Design or adjust only the supplied confirmed requirement scope. Preserve requirement IDs and decisions. Do not redefine requirements, edit application code or approve work.',
    tools: [...workspaceTools, 'ui_ux_search'], permissions: [], children: [], maxRequests: 12, maxTools: 128,
  },
  coding: {
    purpose: 'Implement the supplied task in its assigned workspace. Business decisions, publication, workflow transitions and approvals belong to the platform.',
    permissions: ['read', 'write', 'shell'], children: ['test-planning', 'test-authoring', 'test-review', 'browser-planning'], maxRequests: 256, maxTools: 4096,
  },
  'test-planning': {
    purpose: 'Extract acceptance criteria and design test definitions from original requirements. Do not redefine expected behavior, execute tests or approve publication.',
    tools: readTools, permissions: ['read'], children: ['test-review'], maxRequests: 256, maxTools: 2048,
  },
  'test-review': {
    purpose: 'Independently assess the supplied definitions against original evidence. Return findings, not approval authority. Do not change requirements, cases, application code or scripts.',
    tools: readTools, permissions: ['read'], children: [], maxRequests: 128, maxTools: 1024,
  },
  'test-authoring': {
    purpose: 'Generate only the explicitly assigned test files and definitions. Do not modify business code, execute commands or change expected behavior to make tests pass.',
    permissions: ['read', 'write'], children: [], maxRequests: 128, maxTools: 1024,
  },
  'test-implementation': {
    purpose: 'Return proposed test implementations as structured output. Only the platform may validate and write files, install dependencies, approve bindings or run tests.',
    tools: ['view'], permissions: ['read'], children: [], maxRequests: 1, maxTools: 256,
  },
  'browser-planning': {
    purpose: 'Plan browser verification from the supplied requirements and evidence. Do not execute commands, edit files, fabricate observations or claim a test passed.',
    tools: readTools, permissions: ['read'], children: [], maxRequests: 128, maxTools: 512,
  },
}
