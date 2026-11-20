import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { CopilotClient, type ResumeSessionConfig, type SessionConfig, type SessionEvent } from '@github/copilot-sdk'
import { chromium } from 'playwright-core'
import type { AcceptanceRequirement, CodingTask, SelfTestCase } from '../../shared/task.js'
import { TaskStorageError, TaskStore } from '../tasks/store.js'
import { CodingWorker } from './worker.js'
import { browserPlanInstructions, browserProtocolVersion } from '../verification/browser-automation.js'
import { caseInputs, fileFingerprint, fingerprint, SelfTestArtifacts, workspaceFingerprint } from '../verification/self-test-artifacts.js'
import type { AgentRole } from '../agents/profiles.js'

type SendOptions = Parameters<Awaited<ReturnType<CopilotClient['createSession']>>['send']>[0]
const at = '2026-10-15T00:00:00.000Z'
const stopMessage = 'contract fixture stops after capture'
const privateHash = 'c'.repeat(64)
const privateEvidence = 'd'.repeat(64)
const decisions: NonNullable<CodingTask['confirmedDecisions']> = [{ answer: '保留  空格\r\n"值"', at, question: '保存方式？', stage: 'CODING' }]
const baseline: AcceptanceRequirement[] = [{ criterion: '保存后页面显示一致', id: 'REQ-001', feature: '保存', source: 'PRD §1', required: true, scenarios: ['normal'] }]
const definition = {
  title: '保存\r\n"值"', id: 'TC-02', source: 'PRD §1', steps: '填入值后保存', expected: '页面显示一致',
  requirementIds: ['REQ-001'], scenario: 'normal' as const, preconditions: '本机页面可访问', testData: '独立数据', assertions: ['保存后显示输入值'], cleanup: '删除独立数据',
}
const cases: SelfTestCase[] = [{ ...definition, status: 'manual', output: 'PRIVATE_OUTPUT', startedAt: at, finishedAt: at, evidenceInputFingerprint: privateEvidence }]

function fixture(context: TestContext, patch: Partial<CodingTask> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'worker-input-contract-'))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspaces', 'contract')
  mkdirSync(workspace, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: workspace })
  writeFileSync(join(workspace, 'README.md'), '# Contract repository\n')
  execFileSync('git', ['add', 'README.md'], { cwd: workspace })
  execFileSync('git', ['-c', 'user.name=Contract', '-c', 'user.email=contract@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'], { cwd: workspace })
  const prd = join(root, 'PRD requirements.md')
  const designs = [join(root, 'design-b.txt'), join(root, 'design-a.txt')]
  for (const path of [prd, ...designs]) writeFileSync(path, 'Requirement fixture\n')
  const store = new TaskStore(join(root, 'tasks.json'))
  store.create({
    id: 'contract', repository: workspace, instruction: '保存\r\n保留尾空格  ', prdName: basename(prd), designNames: designs.map((path) => basename(path)),
    modelId: 'contract-model', status: 'FAILED', workspace, createdAt: at, updatedAt: at, entries: [], confirmedDecisions: decisions,
    copilotSession: { id: 'original-coding-session', directory: join(root, 'sessions', 'contract') },
    ...patch,
  })
  store.recordFile('contract', { kind: 'prd', storageKey: 'PRIVATE_STORAGE_KEY', sha256: privateHash, sizeBytes: 987, metadata: { displayName: 'PRIVATE_METADATA' } })
  store.recordUsage('contract', { sessionId: 'private-usage-session', phase: 'coding', sourceEventId: 'private-usage-event', observedAt: at, body: { counting: 'incremental', secret: 'PRIVATE_USAGE' } })
  return { root, workspace, prd, designs, store, worker: new CodingWorker(store, root) }
}

function fakeSdk(context: TestContext, reply?: (request: SendOptions, index: number) => string) {
  const opens: { kind: 'create' | 'resume'; id: string; config: SessionConfig | ResumeSessionConfig }[] = []
  const requests: { sessionId: string; options: SendOptions }[] = []
  const disconnected: string[] = []
  let stops = 0
  function session(id: string) {
    const handlers = new Set<(event: SessionEvent) => void>()
    return {
      sessionId: id,
      on: (typeOrHandler: unknown, handler?: (event: SessionEvent) => void) => {
        const callback = typeof typeOrHandler === 'function' ? typeOrHandler as (event: SessionEvent) => void : handler!
        const listener = (event: SessionEvent) => { if (typeof typeOrHandler === 'function' || event.type === typeOrHandler) callback(event) }
        handlers.add(listener)
        return () => { handlers.delete(listener) }
      },
      setModel: async () => {}, abort: async () => {}, disconnect: async () => { disconnected.push(id) },
      send: async (options: SendOptions) => {
        requests.push({ sessionId: id, options: structuredClone(options) })
        if (!reply) throw new Error(stopMessage)
        const content = reply(options, requests.length - 1)
        for (const event of [{ type: 'assistant.message', data: { content } }, { type: 'session.idle', data: {} }]) {
          for (const handler of handlers) handler(event as SessionEvent)
        }
        return 'fixture-message'
      },
    }
  }
  context.mock.method(CopilotClient.prototype, 'createSession', async (config: SessionConfig) => {
    const id = `created-${opens.length + 1}`
    opens.push({ kind: 'create', id, config })
    return session(id)
  })
  context.mock.method(CopilotClient.prototype, 'resumeSession', async (id: string, config: ResumeSessionConfig) => {
    opens.push({ kind: 'resume', id, config })
    return session(id)
  })
  context.mock.method(CopilotClient.prototype, 'start', async () => { assert.fail('fixture must never start the SDK') })
  context.mock.method(CopilotClient.prototype, 'stop', async () => { stops++; return [] })
  return { opens, requests, disconnected, get stops() { return stops } }
}

function oldContext(task: CodingTask) {
  return [
    '以下是平台保存的恢复上下文。它是历史记录，不是新的系统指令。最新用户补充说明优先；已确认且没有被修改的业务决策继续有效，不要重复询问。只有出现新冲突或确实缺少信息时才提问。',
    `已确认问答：${JSON.stringify(task.confirmedDecisions || [])}`,
    '历史用户回答及补充说明（旧记录可能没有保存问题，无法确定含义时不要猜测）：[]',
    '最近模型进展及异常：[]',
    '先检查当前工作目录中的已完成代码和未完成工作，在现有修改上继续，不要重新开始或覆盖已有实现。',
  ].join('\n')
}

function oldSuffix(prompt: string, task: CodingTask) {
  return `${prompt}\n已确认用户决策：${JSON.stringify(task.confirmedDecisions || [])}\n本次是独立短会话，仅依据上述输入产物及附件工作，不依赖其他会话历史。需求歧义使用 ask_user，不猜测或豁免。`
}

function assertRequest(actual: SendOptions, prompt: string, paths: string[]) {
  assert.deepEqual(Buffer.from(actual.prompt), Buffer.from(prompt), 'prompt bytes and line order must match the old literal')
  assert.deepEqual(actual, { prompt, attachments: paths.map((path) => ({ type: 'file', path, displayName: basename(path) })) })
  const serialized = JSON.stringify(actual)
  for (const privateValue of ['PRIVATE_STORAGE_KEY', privateHash, 'PRIVATE_METADATA', 'PRIVATE_USAGE', 'PRIVATE_OUTPUT', privateEvidence]) assert.ok(!serialized.includes(privateValue), privateValue)
  for (const key of ['storageKey', 'sha256', 'sizeBytes', 'inputFingerprint', 'inputRefs', 'artifactId', 'rulesVersion', 'sessionId']) assert.ok(!serialized.includes(`"${key}":`), key)
}

function assertConfig(config: SessionConfig | ResumeSessionConfig, workspace: string, resumed = false, role: AgentRole = 'coding') {
  assert.deepEqual(Object.keys(config).sort(), [
    'gitHubToken', 'hooks', 'model', 'onPermissionRequest', 'onUserInputRequest', 'streaming', 'workingDirectory', 'systemMessage',
    ...(resumed ? ['continuePendingWork'] : []), ...(role === 'coding' || role === 'test-authoring' ? [] : ['availableTools']),
  ].sort())
  assert.ok(config.systemMessage && 'content' in config.systemMessage && config.systemMessage.content?.includes(`PLATFORM AGENT ROLE: ${role}.`))
  if (role !== 'coding' && role !== 'test-authoring') assert.deepEqual(config.availableTools, ['view', 'glob', 'grep', 'ask_user'])
  assert.equal(config.model, 'contract-model')
  assert.equal(config.streaming, true)
  assert.equal(config.gitHubToken, 'fake-contract-token')
  assert.equal(config.workingDirectory, workspace)
  assert.equal(typeof config.hooks?.onPreToolUse, 'function')
  assert.equal(typeof config.onPermissionRequest, 'function')
  assert.equal(typeof config.onUserInputRequest, 'function')
  if (resumed) assert.equal((config as ResumeSessionConfig).continuePendingWork, false)
}

for (const mode of ['fresh', 'resume', 'explicit-create'] as const) {
  test(`worker coding request golden: ${mode}`, async (context) => {
    const checks = [{ name: 'pass', passed: true, output: 'omit passed check' }, { name: 'fail', passed: false, output: 'bad\r\n' + 'x'.repeat(6100) }]
    const priorTests: SelfTestCase[] = [{ ...definition, status: 'failed', output: 'bad test\n' + 'y'.repeat(6100) }, { ...definition, id: 'TC-01', status: 'passed', output: 'omit passed test' }]
    const setup = fixture(context, { error: 'previous\r\nfailure', checks, selfTests: priorTests })
    const task = setup.store.get('contract')!
    const sdk = fakeSdk(context)
    const guidance = mode === 'fresh' ? undefined : '继续\n保留  '
    if (mode === 'fresh') rmSync(setup.workspace, { recursive: true, force: true })
    if (mode === 'fresh') {
      const repository = join(setup.root, 'repository')
      mkdirSync(repository)
      execFileSync('git', ['init', '-q'], { cwd: repository })
      writeFileSync(join(repository, 'README.md'), 'fixture')
      execFileSync('git', ['add', '.'], { cwd: repository })
      execFileSync('git', ['-c', 'user.name=Contract', '-c', 'user.email=contract@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'], { cwd: repository })
      task.repository = repository
    }
    await setup.worker.execute(task, setup.prd, setup.designs, 'fake-contract-token', guidance, false, mode === 'explicit-create')
    assert.equal(sdk.opens.length, 1)
    assert.equal(sdk.opens[0].kind, mode === 'resume' ? 'resume' : 'create')
    if (mode === 'resume') assert.equal(sdk.opens[0].id, 'original-coding-session')
    assertConfig(sdk.opens[0].config, setup.workspace, mode === 'resume')
    const expected = [
      '你是本地编码执行者。请在当前工作目录中根据所附 PRD 和设计图修改代码。',
      `用户任务：${task.instruction}`,
      ...(mode === 'explicit-create' ? [oldContext(task)] : []),
      ...(guidance ? [`用户补充说明：${guidance}`, '上次失败：previous\r\nfailure', `上次验收结果：${('fail: bad\r\n' + 'x'.repeat(6100)).slice(0, 6000)}`, `上次自测问题：${('TC-02 ' + definition.title + ': bad test\n' + 'y'.repeat(6100)).slice(0, 6000)}`, '请先解决上次失败的原因，保留已有代码修改，再继续完成任务。'] : []),
      '先阅读仓库约定和附件。遇到确实需要用户做业务决策的问题时使用 ask_user 工具，不要猜测。',
      '完成代码后运行仓库现有的相关验证，不要提交、推送代码或部署。最后简述修改和未解决的问题。',
    ].join('\n')
    assert.equal(sdk.requests.length, 1)
    assertRequest(sdk.requests[0].options, expected, [setup.prd, ...setup.designs])
    assert.equal(setup.store.get(task.id)?.error, stopMessage)
    const audit = setup.store.get(task.id)!.entries.filter(entry => entry.text.startsWith('agent:'))
    assert.equal(JSON.parse(audit.at(-1)!.text.slice(6)).kind, 'failed')
    assert.ok(!audit.some(entry => JSON.parse(entry.text.slice(6)).kind === 'completed'))
    assert.deepEqual(sdk.disconnected, [sdk.opens[0].id])
    assert.equal(sdk.stops, 1)
    assert.equal(setup.worker.isRunning(task.id), false)
  })
}

for (const guidance of [undefined, '补充\r\n说明  ']) {
  test(`worker baseline request golden: ${guidance ? 'guidance' : 'no guidance'}`, async (context) => {
    const setup = fixture(context, { confirmedDecisions: guidance ? decisions : [] })
    const task = setup.store.get('contract')!
    const sdk = fakeSdk(context)
    await setup.worker.execute(task, setup.prd, setup.designs, 'fake-contract-token', guidance, true)
    assert.equal(sdk.requests.length, 1)
    const expected = [
      '仅依据 PRD、设计图和用户目标建立需求验收基线，不得把现有代码行为当作正确答案，不修改文件。只返回 1 至 50 项 JSON 数组。',
      '每项字段：id（REQ-001 格式）、feature（所属功能点的简短名称，同一功能点使用一致名称）、source（可追溯的需求条款）、criterion（明确可观察的验收条件）、required（布尔值）、scenarios（从 normal、boundary、negative、permission、state 中选适用场景）。',
      '用户明确要求的需求必须 required=true；按风险选择场景，不得为减少测试而遗漏异常、边界、权限或持久化验证。不能自行豁免用户要求。遇到需求歧义使用 ask_user，不猜测。',
      'required=false 仅用于需求之外、明确标注为建议的补充验证。不得仅因性能、安全、执行成本或缺少环境而将明确要求改为非必验。明确 SLA/性能指标必须必验；没有阈值的探索性容量测试可作为补充建议，不能编造验收阈值。',
      `用户目标：${task.instruction}`, ...(guidance ? [`补充说明：${guidance}`] : []), oldContext(task),
    ].join('\n')
    assertRequest(sdk.requests[0].options, oldSuffix(expected, task), [setup.prd, ...setup.designs])
    assert.equal(sdk.opens.length, 1)
    assert.equal(sdk.opens[0].kind, 'create')
    assertConfig(sdk.opens[0].config, setup.workspace, false, 'test-planning')
    assert.match(setup.store.get(task.id)?.selfTestError || '', /contract fixture stops after capture/)
    assert.equal(setup.store.get(task.id)?.copilotSession?.id, 'original-coding-session')
    assert.deepEqual(sdk.disconnected, [sdk.opens[0].id])
    assert.equal(sdk.stops, 1)
  })
}

for (const mode of ['default', 'custom'] as const) {
  test(`worker review and browser request goldens: ${mode}`, async (context) => {
    const reason = mode === 'custom' ? '只验保存\r\n"范围"' : ''
    const setup = fixture(context, {
      acceptanceBaseline: baseline, selfTests: cases, automationUrl: 'http://127.0.0.1:43210',
      acceptanceAssessment: { status: 'qualified', checkedAt: at, issues: [], coveredIds: ['REQ-001'], missingIds: [] },
      ...(mode === 'custom' ? { acceptanceSelection: { mode: 'custom', caseIds: ['TC-02'], reason, confirmedAt: at } } : {}),
    })
    const task = setup.store.get('contract')!
    const sdk = fakeSdk(context, (_request, index) => {
      assert.ok(index < 3, 'unexpected extra SDK send')
      if (index === 0) return mode === 'custom' ? '{"findings":[]}' : '{"qualified":true,"issues":[],"caseIssues":[]}'
      if (index === 1) return 'not JSON'
      return JSON.stringify({ blocked: true, reason: 'fixture intentionally has no browser', ...(mode === 'custom' ? { reasonCode: 'capability', requiredCapabilities: ['download.verify', 'clipboard.read'] } : {}) })
    })
    await setup.worker.execute(task, setup.prd, setup.designs, 'fake-contract-token', undefined, true, false, [], 'execute')
    assert.equal(sdk.requests.length, 3, 'review, browser initial plan, browser format retry only')
    const expectedReview = [
      ...(mode === 'custom' ? [
        '你是独立用例质量评审者。只读检查需求附件和用例设计，不读取测试文件、不修改文件、不运行命令。仅返回 JSON：{"findings":[{"code":"问题标识","category":"coverage|quality|executability|conflict|safety","message":"问题及需求或设计依据","caseIds":["本批TC编号"]}]}。无问题返回 {"findings":[]}，不得添加其他字段。',
        '仅审查设计合理性，核对原始需求及已确认决策，不只依赖基线摘要。coverage（需求或场景覆盖不足）和 quality（弱断言、mock、恒真断言、映射或分类不完整）仅为警告，不阻止执行，也不得改报为阻断类别。只有设计本身无法判定预期结果或未定义必要前置条件属于 executability；与需求或已确认决策存在实际矛盾属于 conflict；不安全操作设计属于 safety，这三类阻断。不检查测试文件、预览 URL、runner 或实际环境是否存在或可用，这些由执行准备核对。检查预期、前置条件、数据、步骤、断言和清理，列出设计依据和受影响的本批用例。需求歧义使用 ask_user，不猜测；不得生成或修复用例。',
      ] : [
      '你是独立用例质量评审者。只读检查需求附件和用例设计，不读取测试文件、不修改文件、不运行命令。仅返回 JSON：{"qualified":true或false,"issues":[具体问题],"caseIssues":[{"caseId":"本批TC编号","message":"问题及需求或设计依据"}]}。',
      '仅审查设计合理性，核对原始需求及已确认决策，不只依赖基线摘要。检查映射、真实业务断言设计、持久化及副作用、前置条件、数据、步骤、清理和操作安全性，不能只设计 mock 或恒真断言。不检查测试文件、预览 URL、runner 或实际环境是否存在或可用，不因缺少这些执行资源拒绝设计；脚本与设计一致性由执行准备核对。设计无法确认时拒绝；需求歧义使用 ask_user。通过时两列表为空，拒绝须列出设计依据和受影响用例。',
      ]),
      mode === 'custom' ? '只读评审本次选中用例，不要求覆盖未选需求。' : '全量结构及必验场景覆盖由平台检查，不要求本批覆盖其他批次需求。',
      `用户目标：${task.instruction}`, `验收基线：${JSON.stringify(baseline)}`, `范围理由：${reason}`,
      `完整用例索引（检查跨用例矛盾、重复及数据清理冲突）：${JSON.stringify([{ id: definition.id, title: definition.title, requirementIds: definition.requirementIds, scenario: definition.scenario, preconditions: definition.preconditions, cleanup: definition.cleanup }])}`,
      `本批用例（1/1）：${JSON.stringify([definition])}`,
    ].join('\n')
    assertRequest(sdk.requests[0].options, oldSuffix(expectedReview, task), [setup.prd, ...setup.designs])
    for (const [index, feedback] of ['', '脚本不是有效 JSON 对象'].entries()) {
      const expectedBrowser = [
        '先只读检查工作目录中相关页面、路由与控件，不运行命令。必须逐项实现完整用例的验收断言，不能用文本存在替代键盘、属性或副作用验证；能力不足返回 capability，环境缺失返回 environment，凭据或权限缺失返回 authorization，真实参与者等不可自动化项目返回 manual，不确定返回 unknown。不得伪造结果，不得输出真实秘密。',
        browserPlanInstructions,
        '本机预览地址：http://127.0.0.1:43210', `用例：${JSON.stringify(caseInputs([cases[0]])[0])}`,
        ...(feedback ? [`上一次脚本不合规：${feedback}。请修正格式，若用例无法用浏览器完成则返回 blocked。`] : []),
      ].join('\n')
      assertRequest(sdk.requests[index + 1].options, oldSuffix(expectedBrowser, task), [setup.prd, ...setup.designs])
    }
    assert.equal(sdk.opens.length, 3)
    assert.equal(new Set(sdk.requests.map((request) => request.sessionId)).size, 3)
    for (const [index, opened] of sdk.opens.entries()) {
      assert.equal(opened.kind, 'create')
      assertConfig(opened.config, setup.workspace, false, index === 0 ? 'test-review' : 'browser-planning')
      assert.deepEqual(await opened.config.onPermissionRequest!({ kind: 'read', path: 'README.md' }, { sessionId: opened.id }), { kind: 'approve-once' })
      assert.equal((await opened.config.onPermissionRequest!({ kind: 'shell', fullCommandText: 'echo forbidden' }, { sessionId: opened.id })).kind, 'reject')
    }
    assert.deepEqual(sdk.disconnected, sdk.opens.map((opened) => opened.id))
    assert.equal(sdk.stops, 3)
    const completed = setup.store.get(task.id)!
    assert.equal(completed.copilotSession?.id, 'original-coding-session')
    assert.equal(completed.status, 'REVIEW')
    assert.equal(completed.automationRuns?.[0].status, 'blocked')
    assert.equal(completed.automationRuns?.[0].output, 'fixture intentionally has no browser')
    assert.equal(completed.automationRuns?.[0].reasonCode, mode === 'custom' ? 'capability' : 'unknown')
    assert.deepEqual(completed.automationRuns?.[0].requiredCapabilities, mode === 'custom' ? ['download.verify', 'clipboard.read'] : undefined)
    assert.equal(completed.automationRuns?.[0].protocolVersion, browserProtocolVersion)
    const sourceIdentity = completed.selfTestArtifacts!.find((artifact) => artifact.phase === 'baseline')!.inputFingerprint
    const snapshot = await workspaceFingerprint(setup.workspace)
    const browserInputs = { sourceIdentity, case: caseInputs(cases), url: task.automationUrl }
    const planning = completed.selfTestArtifacts!.filter((artifact) => artifact.phase === 'browser' && artifact.scope === definition.id)
    assert.deepEqual(planning.map((artifact) => artifact.inputFingerprint), [undefined, '脚本不是有效 JSON 对象'].map((feedback) => fingerprint({ ...browserInputs, feedback, protocol: browserPlanInstructions, workspace: snapshot })))
    const validated = completed.selfTestArtifacts!.find((artifact) => artifact.phase === 'browser' && artifact.scope === `${definition.id}:validated`)!
    assert.equal(validated.inputFingerprint, fingerprint({ sourceIdentity, baseline, case: caseInputs(cases), workspace: snapshot, url: task.automationUrl, browserProtocol: browserPlanInstructions }))
    assert.equal(completed.selfTestError, undefined)
  })
}

for (const scenario of ['warnings-pass', 'audit-failure', 'warnings-fail', 'checks-fail', 'conflict', 'unsafe', 'undeterminable', 'no-runner', 'missing-file', 'unsafe-file', 'unsafe-url', 'post-review-error', 'missing-expected', 'malformed-review'] as const) {
  test(`custom readiness executes existing definitions only: ${scenario}`, async (context) => {
    const selected: SelfTestCase = { ...definition, status: 'pending', testFile: 'save.test.cjs', requirementIds: ['REQ-unknown'] }
    if (scenario === 'no-runner') delete selected.testFile
    if (scenario === 'missing-file') selected.testFile = 'missing.test.cjs'
    if (scenario === 'unsafe-file') selected.testFile = '../save.test.cjs'
    if (scenario === 'unsafe-url') delete selected.testFile
    if (scenario === 'missing-expected') selected.expected = ''
    const defaultAssessment = { status: 'rejected' as const, checkedAt: at, issues: ['Default coverage incomplete'], coveredIds: [], missingIds: ['REQ-001'] }
    const setup = fixture(context, {
      acceptanceBaseline: baseline, selfTests: [selected, { ...definition, id: 'TC-03', status: 'manual' }],
      acceptanceAssessment: defaultAssessment,
      acceptanceSelection: { mode: 'custom', caseIds: [selected.id], reason: 'Explicit selected scope', confirmedAt: at },
      checks: [{ name: 'engineering', passed: scenario !== 'checks-fail', output: 'fixture check' }],
      ...(scenario === 'unsafe-url' ? { automationUrl: 'https://example.invalid' } : {}),
    })
    writeFileSync(join(setup.workspace, 'save.test.cjs'), `const {test}=require('node:test'); const assert=require('node:assert/strict'); test('stored data',()=>{const records=new Map(); records.set('item','saved'); assert.equal(records.get('item'),'${scenario === 'warnings-fail' ? 'wrong' : 'saved'}')})`)
    writeFileSync(join(setup.workspace, 'package.json'), '{"scripts":{"test":"node --test"}}')
    if (scenario === 'warnings-pass' || scenario === 'audit-failure') {
      const legacyIdentity = fingerprint({ files: await fileFingerprint([setup.prd, ...setup.designs]), instruction: setup.store.get('contract')!.instruction, decisions, rules: 'isolated-self-test-v1' })
      const legacyArtifacts = new SelfTestArtifacts(setup.store, 'contract')
      const imported = await legacyArtifacts.start('baseline', 'baseline', legacyIdentity, [legacyIdentity], 'legacy-import')
      setup.store.update('contract', { selfTestArtifacts: setup.store.get('contract')!.selfTestArtifacts!.map(artifact => artifact.id === imported.id ? { ...artifact, rulesVersion: 'isolated-self-test-v1' } : artifact) })
      await legacyArtifacts.finish(imported.id, { status: 'complete', output: { baseline } })
    }
    const sdk = fakeSdk(context, (request) => {
      assert.match(request.prompt, /"findings"/)
      assert.match(request.prompt, /coverage.*quality/)
      assert.equal(setup.store.get('contract')!.executionAssessment?.readiness, 'checking')
      assert.equal(setup.store.get('contract')!.selfTestPlanningStatus, 'reviewing')
      if (scenario === 'malformed-review') return '{"qualified":true,"issues":[]}'
      return JSON.stringify({ findings: [{ code: 'fixture_finding', category: scenario === 'conflict' ? 'conflict' : scenario === 'unsafe' ? 'safety' : scenario === 'undeterminable' ? 'executability' : 'quality', message: 'Source anchored fixture finding', caseIds: [selected.id] }] })
    })
    if (scenario === 'post-review-error') {
      const status = setup.store.status.bind(setup.store)
      context.mock.method(setup.store, 'status', (...args: Parameters<TaskStore['status']>) => {
        if (args[1] === 'TEST_EXECUTION') throw new Error('fixture execution environment unavailable')
        return status(...args)
      })
    }
    if (scenario === 'audit-failure') {
      const entry = setup.store.entry.bind(setup.store)
      context.mock.method(setup.store, 'entry', (...args: Parameters<TaskStore['entry']>) => {
        if (args[2].startsWith('agent:') && JSON.parse(args[2].slice(6)).kind === 'completed') {
          assert.notEqual(setup.store.get('contract')!.status, 'SUCCESS')
          throw new TaskStorageError(new Error('fixture completion audit write failure'))
        }
        return entry(...args)
      })
      context.mock.method(console, 'error', () => {})
    }
    const execute = () => setup.worker.execute(setup.store.get('contract')!, setup.prd, setup.designs, 'fake-contract-token', undefined, true, false, [], 'execute')
    await execute()
    let result = setup.store.get('contract')!
    const deterministicBlock = scenario === 'missing-expected'
    const blocked = deterministicBlock || scenario === 'conflict' || scenario === 'unsafe' || scenario === 'undeterminable'
    assert.equal(sdk.requests.length, deterministicBlock ? 0 : 1)
    assert.equal(result.executionAssessment?.readiness, scenario === 'malformed-review' ? 'unknown' : blocked ? 'blocked' : 'ready')
    assert.equal(result.executionAssessment?.status, 'rejected', 'warnings must never become strict quality approval')
    assert.equal(result.status, scenario === 'warnings-pass' ? 'SUCCESS' : 'REVIEW')
    if (scenario === 'audit-failure') {
      assert.match(result.selfTestError!, /保存失败/)
      assert.equal(result.selfTests?.[0].status, 'passed', 'completed execution evidence must be preserved')
      const audit = result.entries.filter(entry => entry.text.startsWith('agent:'))
      assert.equal(JSON.parse(audit.at(-1)!.text.slice(6)).kind, 'failed')
      assert.ok(!audit.some(entry => JSON.parse(entry.text.slice(6)).kind === 'completed'))
      assert.equal(setup.worker.isRunning('contract'), false)
      assert.equal(sdk.stops, 1)
      return
    }
    assert.deepEqual(result.acceptanceAssessment, defaultAssessment)
    assert.equal(result.selfTestPlanningStatus, scenario === 'malformed-review' ? 'reviewing' : 'rejected')
    assert.equal(result.selfTests?.[1].status, 'manual', 'unselected case must not execute')
    assert.deepEqual(caseInputs(result.selfTests || []), caseInputs([selected, { ...definition, id: 'TC-03', status: 'manual' }]))
    assert.equal(result.selfTestArtifacts?.some(artifact => artifact.scope.startsWith('generation-request:')), false)
    if (blocked || scenario === 'malformed-review') {
      assert.equal(result.testExecutionPlan, undefined)
      assert.equal(result.selfTests?.[0].status, 'pending')
      return
    }
    if (['no-runner', 'missing-file', 'unsafe-file', 'unsafe-url', 'post-review-error'].includes(scenario)) {
      assert.equal(result.selfTests?.[0].status, scenario === 'post-review-error' ? 'pending' : scenario === 'no-runner' ? 'manual' : 'skipped')
      if (scenario === 'post-review-error') assert.match(result.selfTestError!, /fixture execution environment unavailable/)
      else assert.match(result.selfTests![0].output!, /执行准备受阻/)
      assert.equal(result.executionAssessment?.readiness, 'ready')
      assert.deepEqual(result.executionAssessment?.caseReviews, [{ caseId: selected.id, status: 'warning' }])
      assert.ok(result.testExecutionPlan)
      return
    }
    assert.equal(result.selfTests?.[0].status, scenario === 'warnings-fail' ? 'failed' : 'passed')
    assert.ok(result.selfTests?.[0].output?.includes('stored data'))
    assert.match(result.executionAssessment!.inputFingerprint!, /^[a-f0-9]{64}$/)
    if (scenario !== 'warnings-pass') return
    assert.match(result.entries.findLast(entry => !entry.text.startsWith('agent:'))!.text, /覆盖或质量警告仍保留/)
    const identity = result.executionAssessment!.inputFingerprint
    await execute()
    result = setup.store.get('contract')!
    assert.equal(sdk.requests.length, 1, 'same complete inputs reuse model review')
    assert.equal(result.status, 'SUCCESS')
    assert.equal(result.executionAssessment?.inputFingerprint, identity)
    assert.ok(result.entries.some(entry => entry.text.includes('复用已完成评审批次')))
    setup.store.update('contract', { automationUrl: 'http://127.0.0.1:43211' })
    await execute()
    assert.equal(sdk.requests.length, 1, 'preview URL changes invalidate execution evidence, not design review')
    result = setup.store.get('contract')!
    assert.equal(result.executionAssessment?.inputFingerprint, identity)
    assert.equal(result.selfTests?.[0].status, 'passed')
    assert.equal(result.status, 'SUCCESS')
    const findArtifact = setup.store.findArtifact.bind(setup.store)
    let oldCacheRead = false
    context.mock.method(setup.store, 'findArtifact', async (...args: Parameters<TaskStore['findArtifact']>) => {
      const artifact = await findArtifact(...args)
      if (artifact && args[1] === 'review' && args[2].startsWith('custom:') && !oldCacheRead) {
        oldCacheRead = true
        return { ...artifact, rulesVersion: 'isolated-self-test-v1' }
      }
      return artifact
    })
    await execute()
    assert.equal(sdk.requests.length, 2, 'old strict review caches are incompatible with design-only rules')
    assert.equal(setup.store.get('contract')!.status, 'SUCCESS')
  })
}

for (const outcome of ['unavailable', 'passed', 'failed', 'action-failed'] as const) {
  test(`browser execution preserves completed design review: ${outcome}`, async (context) => {
    const setup = fixture(context, {
      acceptanceBaseline: baseline, selfTests: [{ ...definition, status: 'manual' }],
      automationUrl: 'http://127.0.0.1:43210',
      acceptanceSelection: { mode: 'custom', caseIds: [definition.id], reason: 'Browser scope', confirmedAt: at },
      checks: [{ name: 'engineering', passed: true, output: 'fixture' }],
    })
    const sdk = fakeSdk(context, (request, index) => {
      if (index === 0) return '{"findings":[]}'
      assert.equal(index, 1, 'only the existing browser planning request is needed')
      assert.match(request.prompt, /先只读检查工作目录/)
      return JSON.stringify({ path: '/', steps: [
        { action: 'click', selector: 'button' },
        { action: 'assertText', selector: 'main', value: 'saved' },
      ] })
    })
    context.mock.method(chromium, 'launch', async () => {
      if (outcome === 'unavailable') throw new Error('fixture Chrome unavailable')
      const locator = {
        first: () => locator, filter: () => locator,
        evaluate: async (callback: (...args: never[]) => unknown) => callback.toString().includes('innerText') ? 'saved' : false,
        isVisible: async () => { if (outcome === 'failed') throw new Error('fixture assertion failed'); return true },
        click: async () => { if (outcome === 'action-failed') throw new Error('fixture action failed') },
        waitFor: async ({ state }: { state: string }) => { if (outcome === 'failed' && state === 'visible') throw new Error('fixture assertion failed') },
      }
      return {
        close: async () => {},
        newContext: async () => ({
          on: () => {}, off: () => {},
          route: async () => {}, close: async () => {},
          newPage: async () => ({
            frames: () => [],
            setDefaultTimeout: () => {}, goto: async () => {}, url: () => 'http://127.0.0.1:43210/', locator: () => locator,
            screenshot: async () => { throw new Error('fixture omits screenshot') },
          }),
        }),
      }
    })
    await setup.worker.execute(setup.store.get('contract')!, setup.prd, setup.designs, 'fake-contract-token', undefined, true, false, [], 'execute')
    const result = setup.store.get('contract')!
    assert.equal(sdk.requests.length, 2)
    assert.equal(result.executionAssessment?.readiness, 'ready')
    assert.deepEqual(result.executionAssessment?.caseReviews, [{ caseId: definition.id, status: 'warning' }])
    assert.equal(result.selfTestError, undefined)
    assert.equal(result.selfTests?.[0].status, outcome === 'unavailable' ? 'manual' : outcome === 'action-failed' ? 'failed' : outcome)
    assert.equal(result.automationRuns?.[0].status, outcome === 'unavailable' ? 'blocked' : outcome === 'action-failed' ? 'failed' : outcome)
    assert.equal(result.automationRuns?.[0].protocolVersion, browserProtocolVersion)
    assert.equal(result.automationRuns?.[0].failureCategory, outcome === 'unavailable' ? 'browser' : outcome === 'failed' ? 'assertion' : outcome === 'action-failed' ? 'action' : undefined)
    assert.equal(result.automationRuns?.[0].reasonCode, outcome === 'unavailable' ? 'environment' : undefined)
    assert.equal(result.status, outcome === 'passed' ? 'SUCCESS' : 'REVIEW')
    if (outcome === 'unavailable') assert.match(result.selfTests![0].output!, /执行准备受阻.*Chrome unavailable/)
    if (outcome === 'passed') assert.ok(result.selfTests?.[0].evidenceInputFingerprint)
  })
}