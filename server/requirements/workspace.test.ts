import assert from 'node:assert/strict'
import { mkdtemp, rm, symlink, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRequirementWorkspace } from './workspace.js'

test('workspace scopes reads, literal searches and mutable notes, preserves sources and bounds output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'requirements-workspace-test-'))
  const updates: string[] = []
  try {
    const text = 'Repository: "test"\n# UNTRUSTED EXISTING PROJECT CODE SNAPSHOT\nPath: "src/orders.ts"\n1\texport const order = true\n' + 'order\n'.repeat(500)
    const workspace = await createRequirementWorkspace(root, [{ sourceId: 'source-1', name: 'existing-project-code.md', text }], new AbortController().signal, async message => { updates.push(message) })
    const invoke = async (name: string, args: unknown) => workspace.tools.find(tool => tool.name === name)!.handler!(args, { sessionId: 'test', toolCallId: 'test', toolName: name, arguments: args }) as Promise<any>
    assert.equal(workspace.manifests[0].sourceId, 'source-1')
    assert.ok(!JSON.stringify(workspace.manifests).includes('export const'))
    assert.equal((await invoke('workspace_list', {})).files.length, 1)
    const read = await invoke('workspace_read', { path: 'sources/snapshot-1.md', startLine: 3, count: 2 })
    assert.equal(read.lines[1].text, '1\texport const order = true')
    assert.equal(read.sourceId, 'source-1')
    const search = await invoke('workspace_search', { query: 'ORDER' })
    assert.equal(search.matches.length, 40)
    assert.equal(search.nextOffset, 40)
    assert.ok((await invoke('workspace_search', { query: '.*' })).matches.length === 0)
    for (const path of ['../outside.md', '/etc/passwd', 'C:/private.md', 'sources/../notes/test.md', 'sources\\snapshot-1.md', 'sources/unknown.md']) assert.ok((await invoke('workspace_read', { path })).error)
    assert.ok((await invoke('workspace_write_notes', { path: 'sources/snapshot-1.md', text: 'replace' })).error)
    assert.ok((await invoke('workspace_read', { path: 'sources/snapshot-1.md', count: 201 })).error)
    assert.equal((await invoke('workspace_write_notes', { path: 'notes/analysis.md', text: 'observed fact' })).saved, true)
    assert.equal((await invoke('workspace_read', { path: 'notes/analysis.md' })).lines[0].text, 'observed fact')
    assert.equal(await readFile(join(root, 'sources/snapshot-1.md'), 'utf8'), text)
    assert.ok((await invoke('workspace_write_notes', { path: 'notes/large.md', text: 'a'.repeat(65537) })).error)
    assert.ok(updates.every(message => !message.includes('observed fact') && !message.includes('export const')))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('workspace blocks linked directory escapes and stops tools on cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'requirements-workspace-link-'))
  const outside = await mkdtemp(join(tmpdir(), 'requirements-workspace-outside-'))
  const controller = new AbortController()
  try {
    const workspace = await createRequirementWorkspace(root, [{ sourceId: 'source-1', name: 'snapshot.md', text: 'original' }], controller.signal, async () => {})
    const read = workspace.tools.find(tool => tool.name === 'workspace_read')!
    const invocation = { sessionId: 'test', toolCallId: 'test', toolName: read.name, arguments: {} }
    await rm(join(root, 'sources'), { recursive: true, force: true })
    await symlink(outside, join(root, 'sources'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.ok((await read.handler!({ path: 'sources/snapshot-1.md' }, invocation) as any).error)
    controller.abort()
    await assert.rejects(Promise.resolve().then(() => read.handler!({ path: 'sources/snapshot-1.md' }, invocation)), /abort/i)
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
})

test('workspace serializes concurrent note quotas, paginates long lines and enforces call budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'requirements-workspace-budget-'))
  try {
    const text = 'a'.repeat(5000) + 'lastNeedle'
    const workspace = await createRequirementWorkspace(root, [{ sourceId: 'source-1', name: 'snapshot.md', text }], new AbortController().signal, async () => {})
    const invoke = async (name: string, args: unknown) => workspace.tools.find(tool => tool.name === name)!.handler!(args, { sessionId: 'test', toolCallId: 'test', toolName: name, arguments: args }) as Promise<any>
    const search = await invoke('workspace_search', { query: 'lastNeedle' })
    assert.match(search.matches[0].text, /lastNeedle/)
    const first = await invoke('workspace_read', { path: 'sources/snapshot-1.md', count: 1 })
    assert.equal(first.lines[0].nextCharacterOffset, 2000)
    const last = await invoke('workspace_read', { path: 'sources/snapshot-1.md', count: 1, characterOffset: 4000 })
    assert.match(last.lines[0].text, /lastNeedle/)
    assert.equal(last.lines[0].nextCharacterOffset, null)
    const writes = await Promise.all(Array.from({ length: 5 }, (_, index) => invoke('workspace_write_notes', { path: `notes/large-${index}.md`, text: 'a'.repeat(65536) })))
    assert.equal(writes.filter(result => result.saved).length, 4)
    assert.equal(writes.filter(result => result.error).length, 1)
    while (workspace.coverage().calls < 128) await invoke('workspace_list', {})
    assert.match((await invoke('workspace_list', {})).error, /budget exhausted/)
  } finally { await rm(root, { recursive: true, force: true }) }
})