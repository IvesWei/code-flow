import assert from 'node:assert/strict'
import { test } from 'node:test'
import { codeSnapshotLimits } from '../../../shared/requirement-code.js'
import { codeRelativePath, readCodeSnapshot, selectCodeFiles, type DirectoryFile } from '../../../src/features/requirements/code-directory.js'

function file(path: string, content = 'export const value = 1', size = Buffer.byteLength(content)): DirectoryFile {
  return { webkitRelativePath: path, size, text: async () => content }
}

test('directory paths remove exactly the selected root and reject non-relative paths', () => {
  assert.equal(codeRelativePath('project/src/main.ts'), 'src/main.ts')
  assert.equal(codeRelativePath('项目/src/中文.ts'), 'src/中文.ts')
  assert.equal(codeRelativePath('project/package.json'), 'package.json')
  for (const path of ['main.ts', '/project/main.ts', 'C:/project/main.ts', 'project\\main.ts', 'project/../secret.ts', 'project/./main.ts', 'project//main.ts', 'project/main\x00.ts']) assert.equal(codeRelativePath(path), undefined)
})

test('selection filters before reading, reports all candidates and excluded files', async () => {
  let reads = 0
  const excluded = ['project/node_modules/lib/index.ts', 'project/.git/config', 'project/.env', 'project/image.png'].map(path => ({ ...file(path), text: async () => { reads++; throw new Error('Excluded files must not be read') } }))
  const selection = selectCodeFiles([file('project/src/main.ts', '中文'), ...excluded])
  assert.equal(reads, 0)
  assert.equal(selection.error, '')
  assert.equal(selection.excluded, 4)
  assert.deepEqual(selection.files.map(candidate => candidate.path), ['src/main.ts'])
  assert.deepEqual(await readCodeSnapshot(selection, new AbortController().signal), [{ path: 'src/main.ts', content: '中文' }])
  assert.equal(reads, 0)
})

test('file count, per-file and total size limits fail explicitly without truncating or reading', async () => {
  const cases = [
    Array.from({ length: codeSnapshotLimits.files + 1 }, (_, index) => file(`project/src/file${index}.ts`)),
    [file('project/large.ts', '', codeSnapshotLimits.fileBytes + 1)],
    Array.from({ length: Math.floor(codeSnapshotLimits.totalBytes / codeSnapshotLimits.fileBytes) + 1 }, (_, index) => file(`project/src/file${index}.ts`, '', codeSnapshotLimits.fileBytes)),
    [file('project/src/main.ts'), file('project/src/main.ts')],
  ]
  for (const inputs of cases) {
    let reads = 0
    const selection = selectCodeFiles(inputs.map(input => ({ ...input, text: async () => { reads++; return '' } })))
    assert.equal(selection.files.length, inputs.length)
    assert.ok(selection.error)
    await assert.rejects(readCodeSnapshot(selection, new AbortController().signal))
    assert.equal(reads, 0)
  }
})

test('actual UTF-8 bytes are checked, including replacement expansion and total size', async () => {
  const content = '中'.repeat(Math.floor(codeSnapshotLimits.fileBytes / 3) + 1)
  await assert.rejects(readCodeSnapshot(selectCodeFiles([file('project/main.ts', content, 1)]), new AbortController().signal), /UTF-8/)
  const chunk = '中'.repeat(Math.floor(codeSnapshotLimits.fileBytes / 3))
  const inputs = Array.from({ length: Math.ceil(codeSnapshotLimits.totalBytes / Buffer.byteLength(chunk)) + 1 }, (_, index) => file(`project/file${index}.ts`, chunk, 1))
  await assert.rejects(readCodeSnapshot(selectCodeFiles(inputs), new AbortController().signal), /UTF-8 总大小/)
  const boundary = 'x'.repeat(codeSnapshotLimits.fileBytes)
  assert.equal((await readCodeSnapshot(selectCodeFiles([file('project/main.ts', boundary)]), new AbortController().signal))[0].content, boundary)
})

test('empty/cancelled selection and abort before/during reads never return partial snapshots', async () => {
  const empty = selectCodeFiles([])
  assert.deepEqual(empty, { files: [], excluded: 0, error: '' })
  await assert.rejects(readCodeSnapshot(empty, new AbortController().signal), /没有可添加/)
  const controller = new AbortController()
  let reads = 0
  const selection = selectCodeFiles([{ ...file('project/main.ts'), text: async () => { reads++; controller.abort(); return 'partial' } }, file('project/next.ts')])
  await assert.rejects(readCodeSnapshot(selection, controller.signal), { name: 'AbortError' })
  assert.equal(reads, 1)
  await assert.rejects(readCodeSnapshot(selection, controller.signal), { name: 'AbortError' })
  assert.equal(reads, 1)
})