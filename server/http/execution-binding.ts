import { createHash } from 'node:crypto'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { Express, Request } from 'express'
import type { CodingTask, SelfTestCase } from '../../shared/task.js'
import { buildAssertionManifest, type AssertionManifest, type PlaywrightExecutionBinding } from '../../shared/test-execution.js'
import { defaultModel } from '../execution/models.js'
import { allowedWorkbenchOrigin, ownsTask } from '../security/access.js'
import type { TaskStore } from '../tasks/store.js'
import { buildCaseExecutionFingerprint } from '../verification/playwright-test.js'
import { caseInputs, fileFingerprint, fingerprint, selfTestRulesVersion, workspaceFingerprint } from '../verification/self-test-artifacts.js'

type Approval = { testFile: string; testTitle: string; project: string; assertionIds: string[]; confirm: true }

export interface ExecutionBindingOptions {
  root: string
  authenticate: (request: Request) => Promise<{ ownerId: number } | undefined>
  isBusy: (id: string) => boolean
}

class BindingError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
}

function validTestPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024
    && !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value)
    && !hasControlCharacters(value) && !value.includes(':')
    && value.split(/[\\/]/).every(part => !!part && part !== '.' && part !== '..' && !/[. ]$/.test(part))
    && /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(value)
}

export function parseExecutionBindingApproval(value: unknown, manifest: AssertionManifest): Approval {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BindingError(400, 'Explicit execution binding approval required')
  const body = value as Record<string, unknown>
  const fields = ['testFile', 'testTitle', 'project', 'assertionIds', 'confirm']
  if (Object.keys(body).some(key => !fields.includes(key)) || body.confirm !== true
    || !validTestPath(body.testFile) || typeof body.testTitle !== 'string' || !body.testTitle.trim() || body.testTitle.length > 2000 || hasControlCharacters(body.testTitle)
    || typeof body.project !== 'string' || body.project.length > 256 || hasControlCharacters(body.project)
    || manifest.assertions.length === 0 || manifest.assertions.some(item => !item.definition.trim())
    || !Array.isArray(body.assertionIds) || JSON.stringify(body.assertionIds) !== JSON.stringify(manifest.assertions.map(item => item.id))) {
    throw new BindingError(400, 'Confirm the test mapping with exactly all ordered manifest assertion IDs; authority fields are not accepted')
  }
  return { testFile: body.testFile, testTitle: body.testTitle, project: body.project, assertionIds: [...body.assertionIds] as string[], confirm: true }
}

function idle(task: CodingTask, options: ExecutionBindingOptions): void {
  if (!['REVIEW', 'SUCCESS', 'ACCEPTED'].includes(task.status) || task.modelInTurn || task.modelTurn?.status === 'running' || options.isBusy(task.id)) {
    throw new BindingError(409, 'Execution binding requires a stable idle task')
  }
}

function timestamp(value: string | undefined, now: number): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN
  if (!Number.isFinite(parsed) || parsed > now) throw new BindingError(409, 'Design review timestamp is missing or stale')
  return parsed
}

async function reviewedWorkspace(task: CodingTask, caseId: string, options: ExecutionBindingOptions): Promise<string> {
  const workspace = path.join(options.root, 'workspaces', task.id)
  if (task.workspace !== workspace || await realpath(workspace) !== workspace) throw new BindingError(409, 'Task workspace unavailable')
  const snapshot = await workspaceFingerprint(workspace)
  const selection = task.acceptanceSelection
  const assessment = selection ? task.executionAssessment : task.acceptanceAssessment
  if (!assessment || !task.acceptanceBaseline?.length) throw new BindingError(409, 'A current completed design review is required')
  const now = Date.now()
  const checkedAt = timestamp(assessment.checkedAt, now)
  let scope = task.selfTests || []
  if (selection) {
    const ids = selection.caseIds
    if (!ids.includes(caseId) || !selection.reason.trim() || new Set(ids).size !== ids.length
      || task.executionAssessment?.readiness !== 'ready' || checkedAt < timestamp(selection.confirmedAt, now)
      || JSON.stringify([...(task.executionAssessment.caseIds || [])].sort()) !== JSON.stringify([...ids].sort())) {
      throw new BindingError(409, 'Custom design review does not match the confirmed scope')
    }
    scope = scope.filter(item => ids.includes(item.id))
    if (scope.length !== ids.length) throw new BindingError(409, 'Custom design review contains missing cases')
  } else if (assessment.status !== 'qualified') throw new BindingError(409, 'Default design review is not qualified')
  const uploads = path.join(options.root, 'uploads', task.id)
  const files = [path.join(uploads, `prd${path.extname(task.prdName).toLowerCase()}`), ...task.designNames.map((name, index) => path.join(uploads, `design-${index}${path.extname(name).toLowerCase()}`))]
  const sourceIdentity = fingerprint({ files: await fileFingerprint(files), instruction: task.instruction, decisions: task.confirmedDecisions || [], rules: selfTestRulesVersion })
  const definitions = scope.map(item => {
    const { executionBinding: _binding, executionResult: _result, ...definition } = item
    return definition
  })
  const expected = fingerprint({ sourceIdentity, baseline: task.acceptanceBaseline, cases: caseInputs(definitions), workspace: snapshot, mode: selection ? 'custom' : 'default', reason: selection?.reason || '', model: task.modelId || defaultModel(), rules: selfTestRulesVersion })
  if (assessment.inputFingerprint !== expected) throw new BindingError(409, 'Design review no longer matches current inputs and workspace')
  return snapshot
}

async function testSourceFingerprint(workspace: string, testFile: string): Promise<string> {
  if (!validTestPath(testFile)) throw new BindingError(400, 'Unsafe test source path')
  try {
    let target = workspace
    for (const part of testFile.split(/[\\/]/)) {
      target = path.join(target, part)
      if ((await lstat(target)).isSymbolicLink()) throw new Error('Symlink')
    }
    if (await realpath(target) !== target) throw new Error('Noncanonical source')
    const handle = await open(target, 'r')
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > 128 * 1024) throw new Error('Invalid source size')
      const buffer = Buffer.alloc(128 * 1024 + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      const latest = await lstat(target)
      if (bytesRead !== info.size || latest.isSymbolicLink() || latest.dev !== info.dev || latest.ino !== info.ino || latest.size !== info.size || latest.mtimeMs !== info.mtimeMs) throw new Error('Source changed')
      return createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex')
    } finally { await handle.close() }
  } catch { throw new BindingError(400, 'Test source must be an existing bounded regular .spec/.test file without symlinks') }
}

export function registerExecutionBindings(app: Express, store: Pick<TaskStore, 'loadTask' | 'get' | 'update' | 'flush' | 'committed'>, options: ExecutionBindingOptions): void {
  const approving = new Set<string>()
  for (const method of ['get', 'post'] as const) {
    app[method]('/api/tasks/:id/execution-bindings/:caseId', async (request, response) => {
      response.set('Cache-Control', 'no-store')
      const id = String(request.params.id)
      const caseId = String(request.params.caseId)
      let locked = false
      try {
        if (method === 'post' && !allowedWorkbenchOrigin(request.get('origin'))) throw new BindingError(403, 'Workbench Origin required')
        const user = await options.authenticate(request)
        if (!user) throw new BindingError(401, 'Authentication required')
        const task = await store.loadTask(id)
        if (!task || !ownsTask(task, user.ownerId)) throw new BindingError(404, 'Task not found')
        const testCase = task.selfTests?.find(item => item.id === caseId)
        if (!testCase) throw new BindingError(404, 'Test case not found')
        idle(task, options)
        if (approving.has(id)) throw new BindingError(409, 'Execution binding approval in progress')
        approving.add(id)
        locked = true
        const manifest = buildAssertionManifest(testCase)
        const approval = method === 'post' ? parseExecutionBindingApproval(request.body, manifest) : undefined
        const expectedWorkspace = path.join(options.root, 'workspaces', task.id)
        if (task.workspace !== expectedWorkspace || await realpath(expectedWorkspace) !== expectedWorkspace) throw new BindingError(409, 'Task workspace unavailable')
        const sourceFingerprint = approval ? await testSourceFingerprint(expectedWorkspace, approval.testFile) : undefined
        const designFingerprint = await reviewedWorkspace(task, caseId, options)
        const caseFingerprint = buildCaseExecutionFingerprint(testCase)
        if (!approval) return response.json({ caseId, testCase: { id: testCase.id, title: testCase.title, testFile: testCase.testFile }, manifest, caseFingerprint, designFingerprint, binding: testCase.executionBinding ?? null })
        if (await reviewedWorkspace(task, caseId, options) !== designFingerprint
          || await testSourceFingerprint(task.workspace!, approval.testFile) !== sourceFingerprint) throw new BindingError(409, 'Approval inputs changed while reading')
        const latest = store.get(id)
        if (!latest || !ownsTask(latest, user.ownerId)) throw new BindingError(404, 'Task not found')
        idle(latest, options)
        if (JSON.stringify(latest) !== JSON.stringify(task)) throw new BindingError(409, 'Task changed while reviewing the binding')
        const now = new Date().toISOString()
        const binding: PlaywrightExecutionBinding = { version: 1, caseFingerprint, designFingerprint, testSourceFingerprint: sourceFingerprint!, testFile: approval.testFile, testTitle: approval.testTitle, project: approval.project, assertionIds: approval.assertionIds, approvedBy: String(user.ownerId), approvedAt: now, reviewedAt: now }
        const previous = testCase.executionBinding
        const changed = !previous || ['caseFingerprint', 'designFingerprint', 'testSourceFingerprint', 'testFile', 'testTitle', 'project', 'assertionIds'].some(key => JSON.stringify(previous[key as keyof PlaywrightExecutionBinding]) !== JSON.stringify(binding[key as keyof PlaywrightExecutionBinding]))
        const cases = latest.selfTests!.map(item => {
          if (item.id !== caseId) return item
          const updated: SelfTestCase = { ...item, executionBinding: binding }
          if (changed) {
            delete updated.executionResult
            delete updated.evidenceInputFingerprint
            if (updated.status === 'passed') updated.status = 'pending'
          }
          return updated
        })
        store.update(id, {
          selfTests: cases,
          ...(changed ? {
            automationRuns: latest.automationRuns?.filter(run => run.caseId !== caseId),
            ...(['SUCCESS', 'ACCEPTED'].includes(latest.status) ? { status: 'REVIEW' as const } : {}),
          } : {}),
        })
        await store.flush()
        const saved = store.committed(id)?.selfTests?.find(item => item.id === caseId)
        if (!saved?.executionBinding) throw new Error('Approval not committed')
        return response.json({ caseId, binding: saved.executionBinding })
      } catch (error) {
        return response.status(error instanceof BindingError ? error.status : 503).json({ error: error instanceof BindingError ? error.message : 'Execution binding unavailable; approval not confirmed' })
      } finally { if (locked) approving.delete(id) }
    })
  }
}