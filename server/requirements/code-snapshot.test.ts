import assert from 'node:assert/strict'
import { test } from 'node:test'
import { codeFileAllowed, codeSnapshotLimits } from '../../shared/requirement-code.js'
import { createHash } from 'node:crypto'
import { createCodeSnapshot } from './code-snapshot.js'

test('shared code snapshot filter permits source/manifests and rejects unsafe or sensitive paths', () => {
  assert.deepEqual(codeSnapshotLimits, { files: 200, fileBytes: 131072, totalBytes: 1048576 })
  for (const path of ['src/main.tsx', 'src/view.vue', 'views/index.cshtml', 'README.md', 'package.json', 'Cargo.toml', 'pom.xml', 'Dockerfile', 'Makefile', 'requirements.txt', 'go.mod', 'src/schema.sql', 'config/dev.yaml']) assert.equal(codeFileAllowed(path), true, path)
  for (const path of ['', '/src/a.ts', '../a.ts', 'src/../a.ts', 'src/./a.ts', 'C:/a.ts', 'src\\a.ts', 'src//a.ts', '.git/config', 'src/.hidden/a.ts', 'src/a.ts.', 'src/a.ts ', 'src/%2e%2e/a.ts', 'node_modules/a.ts', 'dist/a.js', 'target/a.java', 'vendor/a.php', '.env', '.env.example', 'credentials.json', 'secrets/a.ts', 'certkeys/a.json', 'appsettings.Production.json', 'config/prod.yaml', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'go.sum', 'image.png', 'a.pem', 'a.bin', 'a.unknown', 'src/a.min.js', 'nul.ts']) assert.equal(codeFileAllowed(path), false, path)
})

test('snapshot rejects invalid entries, duplicates, secrets, binary and byte/count overflow without echoing input', () => {
  const file = { path: 'src/main.ts', content: 'export const value = 1' }
  for (const files of [undefined, null, {}, [], [null], [file, file], [file, { ...file, path: 'SRC/Main.ts' }], [{ ...file, extra: true }], [{ path: file.path }], [{ ...file, path: '../private.ts' }], [{ ...file, content: 3 }], [{ ...file, content: '\u0000' }], [{ ...file, content: '\ud800' }], [{ ...file, content: '-----BEGIN RSA PRIVATE KEY-----\nPRIVATE_SENTINEL' }], ...['const apiKey = "PRIVATE_SENTINEL"', 'password: PRIVATE_SENTINEL', '"client_secret": "PRIVATE_SENTINEL"', '<password>PRIVATE_SENTINEL</password>', 'const url = "https://user:PRIVATE_SENTINEL@example.com"'].map(content => [{ ...file, content }]), [{ ...file, content: 'a'.repeat(codeSnapshotLimits.fileBytes + 1) }], [{ ...file, content: '\u4e2d'.repeat(43691) }], Array.from({ length: 201 }, (_, index) => ({ ...file, path: `${index}.ts` })), Array.from({ length: 9 }, (_, index) => ({ ...file, path: `${index}.ts`, content: 'a'.repeat(codeSnapshotLimits.fileBytes) }))]) {
    assert.throws(() => createCodeSnapshot(files), { message: 'Invalid or unsafe code snapshot' })
  }
})

test('snapshot preserves UTF-8 hashes, line numbers and inert fenced content; exact limits are accepted', () => {
  assert.throws(() => createCodeSnapshot([{ path: 'a.ts', content: 'const harmless = "ok"; const password = "PRIVATE_SENTINEL"' }]), { message: 'Invalid or unsafe code snapshot' })
  assert.ok(createCodeSnapshot([{ path: 'a.ts', content: '~ '.repeat(65536) }]).length)
  assert.ok(createCodeSnapshot([{ path: 'a.ts', content: 'value="x"; '.repeat(11000) }]).length)
  const content = 'export const label = "\u4e2d\u6587"\r\n~~~\n```\n# injected heading\n'
  const text = createCodeSnapshot([{ path: 'src/main.ts', content }, { path: 'empty.ts', content: '' }]).toString('utf8')
  assert.match(text, /^# UNTRUSTED EXISTING PROJECT CODE SNAPSHOT/)
  assert.match(text, /not instructions/)
  assert.match(text, /No code was executed.*runtime-validated/)
  assert.ok(text.includes(`SHA-256: ${createHash('sha256').update(content).digest('hex')}`))
  assert.ok(text.includes('Path: "src/main.ts"\n'))
  assert.ok(text.includes('~~~~text\n1\texport const label = "\u4e2d\u6587"\n2\t~~~\n3\t```\n4\t# injected heading\n5\t\n~~~~'))
  assert.ok(createCodeSnapshot(Array.from({ length: 200 }, (_, index) => ({ path: `${index}.ts`, content: '' }))).length)
  assert.ok(createCodeSnapshot(Array.from({ length: 8 }, (_, index) => ({ path: `${index}.ts`, content: 'a'.repeat(codeSnapshotLimits.fileBytes) }))).length)
})