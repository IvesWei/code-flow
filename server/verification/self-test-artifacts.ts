import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { SelfTestArtifact, SelfTestCase } from '../../shared/task.js'
import type { TaskStore } from '../tasks/store.js'

export const selfTestRulesVersion = 'isolated-self-test-v3-design-review'

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function caseInputs(cases: SelfTestCase[]) {
  return cases.map(({ status, output, startedAt, finishedAt, evidenceInputFingerprint, executionBinding, executionResult, ...definition }) => definition)
}

export async function fileFingerprint(paths: string[]): Promise<string> {
  const digests = await Promise.all(paths.map(async (path) => [path, createHash('sha256').update(await readFile(path)).digest('hex')]))
  return fingerprint(digests)
}

export async function workspaceFingerprint(workspace: string): Promise<string> {
  const { stdout: listed } = await promisify(execFile)('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: workspace, timeout: 15_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true })
  const paths = [...new Set(listed.split('\0').filter(Boolean))].sort()
  const files = await Promise.all(paths.map(async (path) => {
    try { return [path, createHash('sha256').update(await readFile(join(workspace, path))).digest('hex')] }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [path, null]; throw error }
  }))
  return fingerprint(files)
}

export class SelfTestArtifacts {
  constructor(private readonly store: TaskStore, private readonly taskId: string) {}

  find(phase: SelfTestArtifact['phase'], scope: string, inputFingerprint: string): SelfTestArtifact | undefined {
    return this.store.get(this.taskId)?.selfTestArtifacts?.findLast((item) => item.phase === phase && item.scope === scope && item.inputFingerprint === inputFingerprint && item.rulesVersion === selfTestRulesVersion && item.status === 'complete')
  }

  async lookup(phase: SelfTestArtifact['phase'], scope: string, inputFingerprint: string): Promise<SelfTestArtifact | undefined> {
    const artifact = await this.store.findArtifact(this.taskId, phase, scope, inputFingerprint)
    return artifact?.rulesVersion === selfTestRulesVersion ? artifact : undefined
  }

  async start(phase: SelfTestArtifact['phase'], scope: string, inputFingerprint: string, inputRefs: string[], model: string): Promise<SelfTestArtifact> {
    const previous = this.store.get(this.taskId)?.selfTestArtifacts || []
    const artifact: SelfTestArtifact = { id: randomUUID(), revision: previous.filter((item) => item.phase === phase && item.scope === scope).length + 1, schemaVersion: 1, phase, scope, inputFingerprint, inputRefs, status: 'running', createdAt: new Date().toISOString(), model, rulesVersion: selfTestRulesVersion }
    this.store.update(this.taskId, { selfTestArtifacts: [...previous, artifact] })
    await this.store.flush()
    return this.store.get(this.taskId)!.selfTestArtifacts!.find((item) => item.id === artifact.id)!
  }

  async finish(id: string, update: Pick<SelfTestArtifact, 'status'> & Partial<Pick<SelfTestArtifact, 'output' | 'error' | 'sessionId'>>): Promise<void> {
    const artifact = this.store.get(this.taskId)?.selfTestArtifacts?.find((item) => item.id === id)
    if (!artifact || artifact.status !== 'running') throw new Error('Artifact is missing or already finalized')
    this.store.update(this.taskId, { selfTestArtifacts: this.store.get(this.taskId)!.selfTestArtifacts!.map((item) => item.id === id ? { ...item, ...update, finishedAt: new Date().toISOString() } : item) })
    await this.store.flush()
  }

  async bindSession(id: string, sessionId: string): Promise<void> {
    const artifact = this.store.get(this.taskId)?.selfTestArtifacts?.find((item) => item.id === id)
    if (!artifact || artifact.status !== 'running') throw new Error('Artifact is missing or already finalized')
    this.store.update(this.taskId, { selfTestArtifacts: this.store.get(this.taskId)!.selfTestArtifacts!.map((item) => item.id === id ? { ...item, sessionId } : item) })
    await this.store.flush()
  }
}