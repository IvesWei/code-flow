import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import type { SelfTestCase } from '../../shared/task.js'
import { run } from '../git/git.js'
import { toolOutput } from '../execution/tool-detail.js'
import { testPlanPolicy } from './test-plan-policy.js'
import { runPlaywrightTest } from './playwright-test.js'
import { workspaceFingerprint } from './self-test-artifacts.js'

export function parseTestPlan(content: string): SelfTestCase[] {
  const cases = mergeTestPlan(content, [])
  const invalid = cases.find((item) => item.status === 'invalid')
  if (invalid) throw new Error(invalid.output)
  return cases
}

function acceptanceText(value: unknown, field: string, id: string): string {
  let text: string
  if (typeof value === 'string') text = value
  else if (Array.isArray(value) && value.length && value.every((item) => typeof item === 'string' && !!item.trim())) text = value.join('\n')
  else if (field === 'testData' && value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length) text = JSON.stringify(value)
  else {
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
    throw new Error(`用例 ${id} 的 ${field} 类型或内容不合法（实际 ${type}）；须为非空字符串或非空字符串数组${field === 'testData' ? '，testData 也可为非空对象' : ''}`)
  }
  if (!text.trim()) throw new Error(`用例 ${id} 的 ${field} 不能为空；不适用时须说明原因`)
  if (text.length > 2000) throw new Error(`用例 ${id} 的 ${field} 长度 ${text.length} 超过 2000 字符；不得截断验收内容`)
  return text
}

export function mergeTestPlan(content: string, previous: SelfTestCase[], targets?: string[], options: { append?: boolean; maxCases?: number; batchSize?: number; repairManual?: boolean } = {}): SelfTestCase[] {
  const text = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const parsed: unknown = JSON.parse(text)
  const maxCases = options.maxCases ?? testPlanPolicy().maxCases
  const limit = options.batchSize ?? maxCases
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > limit) throw new Error(`自测计划需要包含 1 至 ${limit} 条用例`)
  if (targets && parsed.length !== targets.length) throw new Error('修正用例数量与待修正项不一致')
  if (targets && (new Set(targets).size !== targets.length || targets.some((id) => !previous.some((item) => item.id === id)))) throw new Error('修正目标不存在或重复')
  if (options.append && previous.length + parsed.length > maxCases) throw new Error(`自测用例总量超过安全上限 ${maxCases}，未截断需求`)
  const cases = previous.map((item) => ({ ...item }))
  const offset = options.append ? Math.max(0, ...previous.map((item) => Number(/^TC-(\d+)$/.exec(item.id)?.[1]) || 0)) : 0
  parsed.forEach((item: unknown, index) => {
    const id = targets?.[index] || `TC-${String(offset + index + 1).padStart(2, '0')}`
    const position = cases.findIndex((existing) => existing.id === id)
    if (position >= 0 && (cases[position].status === 'passed' || (cases[position].status === 'manual' && !options.repairManual))) return
    const data = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {}
    const steps = Array.isArray(data.steps) && data.steps.every((step) => typeof step === 'string')
      ? data.steps.join('\n') : data.steps
    const fields = { title: data.title, source: data.source, steps, expected: data.expected }
    const missing = Object.entries(fields).find(([, value]) => typeof value !== 'string' || !value.trim() || value.length > 1000)
    const badFile = data.testFile !== undefined && (typeof data.testFile !== 'string' || !data.testFile.trim() || data.testFile.length > 250)
    const previousCase = position >= 0 ? cases[position] : undefined
    const classification = (data.classification ?? previousCase?.classification) as SelfTestCase['classification']
    if (classification !== undefined) {
      const value = classification as NonNullable<SelfTestCase['classification']>
      if (!value || !['functional', 'performance', 'security', 'compatibility', 'reliability'].includes(value.testType) || !['P0', 'P1', 'P2', 'P3'].includes(value.priority) || !['always', 'on_demand'].includes(value.executionPolicy) || typeof value.riskReason !== 'string' || !value.riskReason.trim() || value.riskReason.length > 2000 || !Array.isArray(value.tags) || value.tags.length > 20 || !value.tags.every((tag) => typeof tag === 'string' && !!tag.trim() && tag.length <= 80)) throw new Error(`用例 ${id} 的分类或执行策略不合法`)
    }
    const error = missing ? `用例 ${id} 缺少有效的 ${missing[0]}` : badFile ? `用例 ${id} 的测试文件路径不合法` : undefined
    const next: SelfTestCase = {
      id, title: typeof data.title === 'string' && data.title.trim() ? data.title : previousCase?.title || '待修正用例',
      source: typeof data.source === 'string' ? data.source : previousCase?.source || '',
      steps: typeof steps === 'string' ? steps : previousCase?.steps || '',
      expected: typeof data.expected === 'string' ? data.expected : previousCase?.expected || '',
      testFile: typeof data.testFile === 'string' ? data.testFile : previousCase?.testFile,
      ...(data.requirementIds !== undefined || previousCase?.requirementIds ? { requirementIds: Array.isArray(data.requirementIds) && data.requirementIds.every((id) => typeof id === 'string') ? data.requirementIds : previousCase?.requirementIds } : {}),
      ...(data.scenario !== undefined || previousCase?.scenario ? { scenario: data.scenario as SelfTestCase['scenario'] ?? previousCase?.scenario } : {}),
      ...(data.preconditions !== undefined || previousCase?.preconditions ? { preconditions: data.preconditions !== undefined ? acceptanceText(data.preconditions, 'preconditions', id) : previousCase?.preconditions } : {}),
      ...(data.testData !== undefined || previousCase?.testData ? { testData: data.testData !== undefined ? acceptanceText(data.testData, 'testData', id) : previousCase?.testData } : {}),
      ...(data.cleanup !== undefined || previousCase?.cleanup ? { cleanup: data.cleanup !== undefined ? acceptanceText(data.cleanup, 'cleanup', id) : previousCase?.cleanup } : {}),
      ...(classification && (!previousCase || previousCase.classification) ? { classification: {
        testType: classification.testType, tags: [...new Set(classification.tags)], priority: classification.priority,
        riskReason: classification.riskReason, executionPolicy: classification.executionPolicy,
      } } : {}),
      ...(data.assertions !== undefined || previousCase?.assertions ? { assertions: Array.isArray(data.assertions) && data.assertions.every((assertion) => typeof assertion === 'string') ? data.assertions : previousCase?.assertions } : {}),
      status: error ? 'invalid' : (typeof data.testFile === 'string' ? data.testFile : previousCase?.testFile) ? 'pending' : 'manual',
      ...(error ? { output: error } : {}),
    }
    if (position >= 0) cases[position] = next
    else cases.push(next)
  })
  if (cases.length > maxCases) throw new Error(`自测用例总量超过安全上限 ${maxCases}，未截断需求`)
  const files = cases.map((item) => item.testFile).filter(Boolean)
  for (const item of cases) {
    if (item.testFile && files.filter((file) => file === item.testFile).length > 1 && item.status !== 'passed') {
      item.status = 'invalid'
      item.output = '每条自动用例需要独立的测试文件'
    }
  }
  return cases
}

export function testCommand(script: string | undefined, file: string): { command: string; args: string[] } | undefined {
  if (typeof script !== 'string' || !script.trim()) return undefined
  if (!/^[a-zA-Z0-9_./-]+$/.test(file)) return undefined
  const match = /^(vitest(?: run)?|jest|playwright test|node --test|tsx --test)$/.exec(script.trim())
  if (!match) return undefined
  const runner = match[1].replace(/ (?:run|test)$/, '')
  if (runner === 'playwright' && !/\.spec\.[cm]?[jt]sx?$/.test(file)) return undefined
  if (runner !== 'playwright' && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) return undefined
  if (runner === 'node --test' || runner === 'tsx --test') {
    if (runner === 'node --test' && !/\.[cm]?js$/.test(file)) return undefined
    return { command: 'node', args: runner === 'tsx --test' ? ['--import', 'tsx', '--test', file] : ['--test', file] }
  }
  const args = runner === 'vitest' ? ['vitest', 'run', file] : runner === 'jest' ? ['jest', '--runInBand', '--runTestsByPath', file] : ['playwright', 'test', file]
  return process.platform === 'win32'
    ? { command: 'cmd.exe', args: ['/d', '/s', '/c', 'npm', 'exec', '--no', '--', ...args] }
    : { command: 'npm', args: ['exec', '--no', '--', ...args] }
}

export async function executeTestCase(workspace: string, testCase: SelfTestCase, script: string | undefined): Promise<SelfTestCase> {
  testCase = { ...testCase, executionResult: undefined, evidenceInputFingerprint: undefined, startedAt: undefined, finishedAt: undefined }
  if (testCase.executionBinding) {
    const executionResult = await runPlaywrightTest({ workspace, testCase, binding: testCase.executionBinding, designFingerprint: await workspaceFingerprint(workspace) })
    return { ...testCase, executionResult, status: executionResult.status === 'passed' ? 'passed' : executionResult.status === 'failed' ? 'failed' : executionResult.status === 'blocked' ? 'manual' : 'skipped', startedAt: executionResult.startedAt, finishedAt: executionResult.finishedAt, output: `${executionResult.status === 'blocked' ? '执行准备受阻：' : ''}${executionResult.reason}` }
  }
  if (!testCase.testFile) return { ...testCase, status: 'manual', output: '执行准备受阻：缺少测试文件，需人工验证' }
  const file = testCase.testFile
  if (isAbsolute(file) || file.split(/[\\/]/).some(part => part === '..' || part === '.git') || file.startsWith('-') || !/^[a-zA-Z0-9_./-]+$/.test(file)) {
    return { ...testCase, status: 'skipped', output: '执行准备受阻：测试文件路径不合法' }
  }
  const command = testCommand(script, file)
  if (!command) return { ...testCase, status: 'manual', output: '执行准备受阻：仓库没有支持单文件执行的测试框架，或 test 脚本包含尚不支持的参数/组合命令；未忽略脚本配置，需人工验证' }
  const invocation = `${command.command} ${command.args.join(' ')}`
  try {
    const root = await realpath(workspace)
    const target = resolve(root, file)
    const inside = relative(root, target)
    if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside) || inside.split(sep).includes('.git')) {
      return { ...testCase, status: 'skipped', output: '执行准备受阻：测试文件不在工作目录内' }
    }
    const info = await lstat(target)
    if (!info.isFile() || await realpath(target) !== target) throw new Error('测试文件不是普通文件')
    if (info.size > 128 * 1024) throw new Error('测试文件过大')
    const source = await readFile(target, 'utf8')
    if (!/\b(?:test|it)\s*\(/.test(source) || !/\b(?:assert|expect)\b/.test(source)) {
      return { ...testCase, status: 'skipped', output: '执行准备受阻：测试文件缺少用例声明或断言，无法认定为有效自测' }
    }
    const runner = script!.trim().split(' ')[0]
    if (runner !== 'node') {
      try {
        createRequire(resolve(root, 'package.json')).resolve(runner)
        if (runner !== 'tsx') await lstat(resolve(root, 'node_modules', '.bin', runner + (process.platform === 'win32' ? '.cmd' : '')))
      } catch {
        return { ...testCase, status: 'manual', output: `执行准备受阻：本地 runner ${runner} 不可用；未安装或下载依赖，需人工验证` }
      }
    }
    const startedAt = new Date().toISOString()
    try {
      const environment = { ...process.env }
      delete environment.NODE_TEST_CONTEXT
      const output = await run(command.command, command.args, root, 120_000, environment)
      if (command.args.includes('--test') && /(?:^|\n)\s*(?:#\s*)?(?:tests|pass)\s+0\b/m.test(output)) {
        return { ...testCase, status: 'skipped', startedAt, finishedAt: new Date().toISOString(), output: `命令：${invocation}\n结果：未执行断言\n${toolOutput(output)?.slice(-4000) || ''}` }
      }
      return { ...testCase, status: 'passed', startedAt, finishedAt: new Date().toISOString(), output: `命令：${invocation}\n退出码：0\n${toolOutput(output)?.slice(-4000) || '测试命令正常退出'}` }
    } catch (error) {
      return { ...testCase, status: 'failed', startedAt, finishedAt: new Date().toISOString(), output: `命令：${invocation}\n结果：执行失败\n${toolOutput(String(error))?.slice(-4000) || '测试运行失败'}` }
    }
  } catch (error) {
    return { ...testCase, status: 'skipped', output: `执行准备受阻：测试文件不可用：${error instanceof Error ? error.message : String(error)}` }
  }
}

export async function supportedTestScript(workspace: string): Promise<string | undefined> {
  try {
    const packageJson = JSON.parse(await readFile(resolve(workspace, 'package.json'), 'utf8')) as { scripts?: { test?: string } }
    return packageJson.scripts?.test
  } catch { return undefined }
}

export function shouldRunBrowserCase(testCase: SelfTestCase, previewUrl: string | undefined): boolean {
  return !!previewUrl && !testCase.testFile && !testCase.executionBinding
}