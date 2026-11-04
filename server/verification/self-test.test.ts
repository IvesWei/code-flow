import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { executeTestCase, mergeTestPlan, parseTestPlan, testCommand, shouldRunBrowserCase } from './self-test.js'

const example = { title: '登录成功', source: 'PRD 登录流程', steps: '输入有效账号并提交', expected: '进入首页', testFile: 'login.test.cjs' }

test('acceptance descriptions normalize structured model output without dropping or truncating content', () => {
  const input = { ...example, preconditions: ['服务启动', '独立账号'], testData: { zebra: { name: '中文', enabled: false }, alpha: [1, 2] }, cleanup: ['删除记录', '退出账号'] }
  const parsed = mergeTestPlan(JSON.stringify([input]), [])[0]
  assert.equal(parsed.preconditions, '服务启动\n独立账号')
  assert.equal(parsed.testData, JSON.stringify(input.testData))
  assert.equal(parsed.cleanup, '删除记录\n退出账号')
  for (const field of ['preconditions', 'testData', 'cleanup']) {
    for (const value of [null, [], [''], ['valid', 1], {}, 0, false, ' ', 'x'.repeat(2001)]) {
      assert.throws(() => mergeTestPlan(JSON.stringify([{ ...example, [field]: value }]), []), new RegExp(field))
    }
    assert.equal(mergeTestPlan(JSON.stringify([{ ...example, [field]: 'x'.repeat(2000) }]), [])[0][field as 'preconditions'], 'x'.repeat(2000))
  }
  const original = { ...parsed, status: 'failed' as const }
  const repaired = mergeTestPlan(JSON.stringify([example]), [original], ['TC-01'])[0]
  assert.equal(repaired.testData, parsed.testData)
  assert.throws(() => mergeTestPlan(JSON.stringify([{ ...example, cleanup: null }]), [original], ['TC-01']), /cleanup/)
  assert.deepEqual(mergeTestPlan(JSON.stringify([{ ...example, cleanup: null }]), [{ ...parsed, status: 'passed' }], ['TC-01'])[0], { ...parsed, status: 'passed' })
})

test('self-test plans require evidence fields and independent files', () => {
  assert.deepEqual(parseTestPlan(JSON.stringify([example]))[0], { id: 'TC-01', ...example, status: 'pending' })
  assert.equal(parseTestPlan(JSON.stringify([{ ...example, testFile: undefined }]))[0].status, 'manual')
  assert.throws(() => parseTestPlan(JSON.stringify([example, example])), /独立/)
  assert.throws(() => parseTestPlan(JSON.stringify([{ ...example, expected: '' }])), /expected/)
  assert.throws(() => parseTestPlan('[]'), /1 至/)
})

test('only known test runners can execute an individual file', () => {
  assert.equal(testCommand('echo test', 'login.test.cjs'), undefined)
  assert.deepEqual(testCommand('node --test', 'login.test.cjs'), { command: 'node', args: ['--test', 'login.test.cjs'] })
  assert.equal(testCommand('node --test', 'login.test.ts'), undefined)
  for (const script of ['echo node --test', 'node --test && echo ok', 'node --test --import tsx', 'vitest run --config other.ts', 'jest --passWithNoTests']) assert.equal(testCommand(script, 'login.test.cjs'), undefined, script)
  assert.ok(testCommand('vitest run', 'login.test.ts'))
  assert.ok(testCommand('playwright test', 'login.spec.ts'))
})

test('self-test runner records actual pass/fail and declines unsafe paths', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'code-flow-test-'))
  try {
    writeFileSync(join(workspace, 'login.test.cjs'), "const {test}=require('node:test'); test('case',()=>{require('node:assert/strict').equal(2,2)})")
    const caseItem = parseTestPlan(JSON.stringify([example]))[0]
    const passed = await executeTestCase(workspace, caseItem, 'node --test')
    assert.equal(passed.status, 'passed')
    assert.ok(passed.startedAt && passed.finishedAt)
    assert.match(passed.output || '', /命令：node --test login\.test\.cjs\n退出码：0/)
    writeFileSync(join(workspace, 'login.test.cjs'), "const {test}=require('node:test'); test('case',()=>{require('node:assert/strict').equal(2,3)})")
    const failed = await executeTestCase(workspace, caseItem, 'node --test')
    assert.equal(failed.status, 'failed', failed.output)
    assert.match(failed.output || '', /命令：node --test login\.test\.cjs\n结果：执行失败/)
    assert.equal((await executeTestCase(workspace, caseItem, 'echo test')).status, 'manual')
    assert.equal((await executeTestCase(workspace, { ...caseItem, testFile: '../login.test.cjs' }, 'node --test')).status, 'skipped')
    for (const file of ['.git/login.test.cjs', '-login.test.cjs', '/login.test.cjs', '..\\login.test.cjs']) assert.equal((await executeTestCase(workspace, { ...caseItem, testFile: file }, 'node --test')).status, 'skipped', file)
    const missingRunner = await executeTestCase(workspace, caseItem, 'vitest run')
    assert.equal(missingRunner.status, 'manual')
    assert.match(missingRunner.output!, /执行准备受阻.*runner/)
    assert.equal((await executeTestCase(workspace, { ...caseItem, testFile: 'missing.test.cjs' }, 'node --test')).status, 'skipped')
    const noWorkspace = await executeTestCase(join(workspace, 'missing-workspace'), caseItem, 'node --test')
    assert.equal(noWorkspace.status, 'skipped')
    assert.match(noWorkspace.output!, /执行准备受阻/)
    writeFileSync(join(workspace, 'login.test.cjs'), "const {test}=require('node:test'); const assert=require('node:assert/strict'); test('not executed',{skip:true},()=>assert.equal(1,1))")
    const skipped = await executeTestCase(workspace, caseItem, 'node --test')
    assert.equal(skipped.status, 'skipped')
    assert.match(skipped.output!, /未执行断言/)
    writeFileSync(join(workspace, 'login.test.cjs'), '')
    assert.equal((await executeTestCase(workspace, caseItem, 'node --test')).status, 'skipped')
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('partial plan retains valid cases and repairs only invalid cases', () => {
  const draft = mergeTestPlan(JSON.stringify([example, { title: '错误输入', source: 'PRD', steps: null, expected: '提示错误' }]), [])
  assert.equal(draft[0].status, 'pending')
  assert.equal(draft[1].status, 'invalid')
  const completed = [{ ...draft[0], status: 'passed' as const, output: 'passed' }, draft[1]]
  const repaired = mergeTestPlan(JSON.stringify([{ title: '错误输入', source: 'PRD', steps: ['输入错误账号', '提交'], expected: '提示错误' }]), completed, ['TC-02'])
  assert.deepEqual(repaired[0], completed[0])
  assert.equal(repaired[1].steps, '输入错误账号\n提交')
  assert.equal(repaired[1].status, 'manual')
})

test('repair keeps a successful case and reuses the failed case test file', () => {
  const original = mergeTestPlan(JSON.stringify([example, { ...example, title: '错误输入', testFile: 'invalid.test.cjs' }]), [])
  const previous = [{ ...original[0], status: 'passed' as const, output: 'passed' }, { ...original[1], status: 'failed' as const, output: 'assertion failed' }]
  const repaired = mergeTestPlan(JSON.stringify([{ title: '错误输入', source: 'PRD', steps: ['输入错误账号', '提交'], expected: '提示错误' }]), previous, ['TC-02'])
  assert.deepEqual(repaired[0], previous[0])
  assert.equal(repaired[1].testFile, 'invalid.test.cjs')
  assert.equal(repaired[1].status, 'pending')
})

test('a browser preview does not override a runnable test file', () => {
  const testCase = parseTestPlan(JSON.stringify([example]))[0]
  assert.equal(shouldRunBrowserCase(testCase, 'http://127.0.0.1:4173'), false)
  assert.equal(shouldRunBrowserCase({ ...testCase, testFile: undefined }, 'http://127.0.0.1:4173'), true)
  assert.equal(shouldRunBrowserCase(testCase, undefined), false)
  assert.equal(shouldRunBrowserCase({ ...testCase, testFile: undefined }, undefined), false)
})

test('appended batches exceed twelve without replacing earlier cases and enforce total limits', () => {
  const first = mergeTestPlan(JSON.stringify(Array.from({ length: 8 }, (_, index) => ({ ...example, testFile: `case-${index}.test.cjs` }))), [], undefined, { append: true, maxCases: 20, batchSize: 8 })
  first[0] = { ...first[0], status: 'passed', output: 'proof' }
  const second = JSON.stringify(Array.from({ length: 8 }, (_, index) => ({ ...example, testFile: `case-${index + 8}.test.cjs` })))
  const combined = mergeTestPlan(second, first, undefined, { append: true, maxCases: 20, batchSize: 8 })
  assert.equal(combined.length, 16)
  assert.deepEqual(combined[0], first[0])
  assert.equal(combined[8].id, 'TC-09')
  assert.equal(combined[15].id, 'TC-16')
  assert.throws(() => mergeTestPlan(second, combined, undefined, { append: true, maxCases: 20, batchSize: 8 }), /安全上限/)
  assert.throws(() => mergeTestPlan(second, first, undefined, { append: true, maxCases: 20, batchSize: 4 }), /1 至 4/)
})