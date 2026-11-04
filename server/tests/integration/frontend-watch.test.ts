import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'vite'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'

for (const dataRoot of ['data', 'task-runtime']) {
test(`Vite ignores ${dataRoot} task outputs while keeping frontend hot updates`, { timeout: 20_000 }, async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'codeflow-watch-'))
  const files = [`${dataRoot}/workspaces/task/dist/index.html`, `${dataRoot}/workspaces/task/tsconfig.json`, `${dataRoot}/sessions/task/files/preview.html`, 'data/uploads/task/prd.md', 'server/example.ts', 'src/example.ts']
  const messages: string[] = []
  const changes: string[] = []
  const originalDataDirectory = process.env.DATA_DIR
  process.env.DATA_DIR = join(directory, dataRoot)
  const server = await createServer({
    configFile: resolve('vite.config.ts'), root: directory,
    server: { port: 0 },
    customLogger: { info: message => messages.push(message), warn: () => {}, warnOnce: () => {}, error: () => {}, clearScreen: () => {}, hasErrorLogged: () => false, hasWarned: false },
  }).finally(() => {
    if (originalDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = originalDataDirectory
  })
  try {
    for (const file of files) {
      await mkdir(join(directory, file, '..'), { recursive: true })
      await writeFile(join(directory, file), file.endsWith('.json') ? '{}' : file === 'src/example.ts' ? 'export const value = 1; if (import.meta.hot) import.meta.hot.accept()' : 'initial')
    }
    await server.listen()
    if (!(server.watcher as unknown as { _readyEmitted: boolean })._readyEmitted) await once(server.watcher, 'ready')
    server.watcher.on('change', path => changes.push(path))
    const source = join(directory, 'src/example.ts')
    await server.transformRequest('/src/example.ts')
    const hotUpdated = new Promise<void>((resolveUpdate, reject) => {
      const timer = setTimeout(() => reject(new Error('Frontend hot update was not sent')), 5000)
      context.mock.method(server.ws, 'send', (payload: unknown) => {
        if (payload && typeof payload === 'object' && 'type' in payload && payload.type === 'update') {
          clearTimeout(timer)
          resolveUpdate()
        }
      })
    })
    const sourceChanged = new Promise<void>((resolveChange, reject) => {
      const timer = setTimeout(() => reject(new Error('Frontend change was not detected')), 5000)
      server.watcher.on('change', path => {
        if (path === source) { clearTimeout(timer); resolveChange() }
      })
    })
    for (const file of files) await writeFile(join(directory, file), file.endsWith('.json') ? '{"compilerOptions":{}}' : file === 'src/example.ts' ? 'export const value = 2; if (import.meta.hot) import.meta.hot.accept()' : 'updated')
    await Promise.all([sourceChanged, hotUpdated])
    assert.ok(changes.includes(source))
    assert.ok(changes.every(path => path === source), JSON.stringify(changes))
    assert.ok(messages.every(message => !message.includes('data/workspaces') && !message.includes('data/sessions')))
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }) }
})
}