import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { agentFileAccess } from './workspace.js'

test('coding file permissions stay inside the assigned workspace or exact read-only attachments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workspace-'))
  const workspace = join(root, 'workspace')
  try {
    await mkdir(workspace)
    await mkdir(join(workspace, '.git'))
    await writeFile(join(workspace, 'safe.ts'), 'export {}')
    await writeFile(join(workspace, '.env'), 'fixture')
    await writeFile(join(workspace, '.env.example'), 'EXAMPLE=')
    const attachment = join(root, 'prd.md')
    await writeFile(attachment, 'fixture')
    assert.equal(await agentFileAccess(workspace, 'safe.ts', 'read'), true)
    assert.equal(await agentFileAccess(workspace, '.env.example', 'read'), true)
    assert.equal(await agentFileAccess(workspace, 'new\\file.ts', 'write'), true)
    assert.equal(await agentFileAccess(workspace, attachment, 'read', [attachment]), true)
    for (const [file, mode] of [[attachment, 'write'], ['..\\other.txt', 'write'], ['.git\\config', 'write'], ['.env', 'read'], ['.env.local', 'write']] as const) {
      assert.equal(await agentFileAccess(workspace, file, mode, [attachment]), false, file)
    }
    await symlink(root, join(workspace, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal(await agentFileAccess(workspace, 'link\\other.txt', 'write'), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
