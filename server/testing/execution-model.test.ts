import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { SessionConfig, SessionEvent } from '@github/copilot-sdk'
import type { SelfTestCase } from '../../shared/task.js'
import { CopilotExecutionModel, executionReadPath, parseExecutionImplementation } from './execution-model.js'

const response = () => ({ files: [{ path: '.codeflow-tests/state.spec.ts', content: 'exact source\r\n' }],
  mappings: [{ caseId: 'TC-1', testFile: '.codeflow-tests/state.spec.ts', testTitle: 'State', project: '' }] })
const testCase: SelfTestCase = { id: 'TC-1', title: 'State', source: 'requirements', steps: 'Observe', expected: 'State correct',
  assertions: ['Correct state'], status: 'pending' }

test('implementation JSON is strict, spec-only, bounded per file and bounded in aggregate', () => {
  assert.deepEqual(parseExecutionImplementation(JSON.stringify(response())), response())
  const invalid = [null, {}, { ...response(), approvedBy: 'model' }, { ...response(), mappings: [{ ...response().mappings[0], approvedBy: 'model' }] },
    { ...response(), mappings: [response().mappings[0], response().mappings[0]] },
    ...['.codeflow-tests/../escape.spec.ts', '.codeflow-tests/secret.test.ts', 'business.spec.ts', '.codeflow-tests/.env.spec.ts', '.codeflow-tests/package.json', '.codeflow-tests\\escape.spec.ts'].map(path => ({ files: [{ path, content: 'source' }], mappings: [{ ...response().mappings[0], testFile: path }] })),
    { ...response(), files: [{ path: '.codeflow-tests/state.spec.ts', content: 'x'.repeat(128 * 1024 + 1) }] },
    { files: Array.from({ length: 41 }, (_, index) => ({ path: `.codeflow-tests/file-${index}.spec.ts`, content: 'x'.repeat(128 * 1024) })), mappings: response().mappings },
  ]
  for (const value of invalid) assert.throws(() => parseExecutionImplementation(JSON.stringify(value)))
  assert.throws(() => parseExecutionImplementation('```json\n{}\n```'))
})

test('read boundary rejects directories, secrets, symlinks, external paths and oversized files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'execution-model-path-'))
  try {
    await writeFile(join(root, 'safe.ts'), 'export {}')
    await writeFile(join(root, '.env'), 'SECRET')
    await writeFile(join(root, 'large.ts'), 'x'.repeat(128 * 1024 + 1))
    await mkdir(join(root, 'node_modules'))
    await writeFile(join(root, 'node_modules', 'secret.ts'), 'SECRET')
    await mkdir(join(root, 'real'))
    await writeFile(join(root, 'real', 'safe.ts'), 'export {}')
    await symlink(join(root, 'real'), join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal(await executionReadPath(root, 'safe.ts'), true)
    assert.equal(await executionReadPath(root, join(root, 'safe.ts')), true)
    for (const path of ['.', '.env', 'large.ts', 'node_modules/secret.ts', 'linked/safe.ts', '../outside.ts']) assert.equal(await executionReadPath(root, path), false, path)
  } finally { await rm(root, { recursive: true, force: true }) }
})

type ClientFactory = NonNullable<ConstructorParameters<typeof CopilotExecutionModel>[0]>
function fakeClient(answer?: string) {
  const listeners = new Set<(event: SessionEvent) => void>()
  const configs: SessionConfig[] = []
  const options: Parameters<ClientFactory>[0][] = []
  const prompts: string[] = []
  let aborted = 0, disconnected = 0, stopped = 0
  let entered!: () => void
  const sent = new Promise<void>(resolve => { entered = resolve })
  const factory: ClientFactory = input => {
    options.push(input)
    return {
      createSession: async config => {
        configs.push(config)
        return {
          on: (listener: (event: SessionEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
          send: async ({ prompt }: { prompt: string }) => {
            prompts.push(prompt)
            entered()
            if (answer !== undefined) queueMicrotask(() => {
              for (const listener of listeners) listener({ type: 'assistant.message', data: { content: answer } } as SessionEvent)
              for (const listener of listeners) listener({ type: 'session.idle', data: {} } as SessionEvent)
            })
            return 'fake-message'
          },
          abort: async () => { aborted++ }, disconnect: async () => { disconnected++ },
        } as unknown as Awaited<ReturnType<ReturnType<ClientFactory>['createSession']>>
      },
      stop: async () => { stopped++ },
    }
  }
  return { factory, configs, options, prompts, sent, counts: () => ({ aborted, disconnected, stopped, listeners: listeners.size }) }
}

test('fresh isolated model sessions request JSON with exact native assertion steps and deny writes/shell/secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'execution-model-session-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  await writeFile(join(workspace, 'safe.ts'), 'export {}')
  await writeFile(join(workspace, '.env'), 'NEVER_READ')
  const fake = fakeClient(JSON.stringify(response()))
  const progress: string[] = []
  try {
    const model = new CopilotExecutionModel(fake.factory)
    const context = { workspace, token: 'ephemeral-token', signal: new AbortController().signal, onProgress: async (text: string) => { progress.push(text) } }
    for (let index = 0; index < 2; index++) assert.deepEqual(await model.generate({ modelId: 'test-model', cases: [testCase] }, context), response())
    assert.equal(fake.configs.length, 2)
    assert.notEqual(fake.options[0]?.baseDirectory, fake.options[1]?.baseDirectory)
    assert.equal(fake.options[0]?.mode, 'empty')
    assert.equal(fake.options[0]?.useLoggedInUser, false)
    assert.ok(!JSON.stringify(fake.options[0]?.env).includes('ephemeral-token'))
    assert.ok(!fake.prompts[0].includes('ephemeral-token'))
    assert.ok(!fake.prompts[0].includes('NEVER_READ'))
    assert.match(fake.prompts[0], /TC-1:A001/)
    assert.match(fake.prompts[0], /test\.step/)
    assert.match(fake.prompts[0], /native Playwright expect/)
    assert.match(fake.prompts[0], /safe\.ts/)
    assert.deepEqual(fake.configs[0].availableTools, ['view'])
    const hook = fake.configs[0].hooks!.onPreToolUse!
    for (const request of [{ toolName: 'bash', toolArgs: { command: 'npm install' } }, { toolName: 'write', toolArgs: { path: 'safe.ts' } },
      { toolName: 'grep', toolArgs: { path: '.' } }, { toolName: 'view', toolArgs: { path: '.env' } }]) {
      const result = await hook(request as Parameters<typeof hook>[0], {} as Parameters<typeof hook>[1])
      assert.equal(result?.permissionDecision, 'deny')
    }
    const permit = fake.configs[0].onPermissionRequest!
    for (const request of [{ kind: 'write', fileName: 'safe.ts' }, { kind: 'shell' }, { kind: 'read', path: '.env' },
      { kind: 'read', path: 'safe.ts', requestSandboxBypass: true }]) {
      assert.equal((await permit(request as Parameters<typeof permit>[0], {} as Parameters<typeof permit>[1])).kind, 'reject')
    }
    assert.equal((await permit({ kind: 'read', path: 'safe.ts' } as unknown as Parameters<typeof permit>[0], {} as Parameters<typeof permit>[1])).kind, 'approve-once')
    assert.ok(progress.length >= 4)
    assert.deepEqual(fake.counts(), { aborted: 0, disconnected: 2, stopped: 2, listeners: 0 })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('model cancellation invokes SDK abort and cleans listeners without requiring SDK idle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'execution-model-cancel-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const fake = fakeClient()
  const controller = new AbortController()
  try {
    const pending = new CopilotExecutionModel(fake.factory).generate({ modelId: 'test', cases: [testCase] },
      { workspace, token: 'secret-token', signal: controller.signal, onProgress: async () => {} })
    await fake.sent
    controller.abort()
    await assert.rejects(pending, error => error instanceof Error && !error.message.includes('secret-token'))
    assert.ok(fake.counts().aborted >= 1)
    assert.deepEqual({ ...fake.counts(), aborted: 0 }, { aborted: 0, disconnected: 1, stopped: 1, listeners: 0 })
  } finally { await rm(root, { recursive: true, force: true }) }
})