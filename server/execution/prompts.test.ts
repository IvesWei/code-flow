import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appendSerializedDecisionSuffix, buildTestPlanGenerationPrompt, type TestPlanGenerationPromptInput } from './prompts.js'

function previousGenerationExpression(options: TestPlanGenerationPromptInput): string {
  const { baseline, cases, repairIds, coverage, capacity, feedback, attempt } = options
  return [
    '你是验收测试设计者。按当前批次生成或修正用例，不修改业务代码、不执行测试命令。数量由需求场景与验证方式决定，不要为凑数重复用例。',
    `用户目标：${options.instruction}`,
    `验收基线：${JSON.stringify(baseline)}`,
    ...(options.context ? [options.context] : []),
    `仓库现有 test 脚本：${options.testScript || '无'}`,
    repairIds.length
      ? `只修正下列用例，按所列 ID 顺序返回恰好 ${repairIds.length} 条，不重写已通过的用例：${JSON.stringify(cases.filter((item) => repairIds.includes(item.id)))}`
      : `当前批次必须覆盖的需求场景：${JSON.stringify(coverage)}。只为本批场景生成 1 至 ${capacity} 条用例；单条可关联多个需求，但只能有一个 scenario。必要的不同验证方式可以拆分用例。`,
    `已存在用例摘要（不得复用其他用例文件或重复已有场景）：${JSON.stringify(cases.map(({ id, title, requirementIds, scenario, testFile, status }) => ({ id, title, requirementIds, scenario, testFile, status })))}`,
    '每条必须包含 title、source（需求出处）、steps（字符串或字符串数组）、expected、requirementIds（有效需求 ID 数组）、scenario（normal/boundary/negative/permission/state）、preconditions、testData、assertions（非空断言数组）、cleanup，可选 testFile（仓库相对路径）。预期来自需求而非当前代码。',
    '新用例必须包含 classification：testType（functional/performance/security/compatibility/reliability）、tags（最多20个短标签，例如 smoke/regression/load/stress/soak）、priority（P0/P1/P2/P3）、riskReason（业务风险及优先级理由）、executionPolicy（always/on_demand）。场景、类别、优先级是独立维度。',
    '关联任何 required=true 需求的用例必须执行，平台强制阻断验收，不得通过优先级、标签或 on_demand 降级。仅关联非必验建议的补充用例不阻断：补充性能/稳定性专项默认 on_demand，轻量功能补充默认 always。不得凭空增加 SLA 或阈值；明确性能验收须描述阈值出处、负载、环境、数据规模、持续时间和指标。旧用例缺少分类时保持原必验策略。',
    '断言必须验证真实业务结果及需求要求的持久化和副作用，不得只检查元素存在、mock、恒真断言或命令退出。前置条件、数据、步骤和清理必须可复现。',
    '已有 Node test、tsx test、Vitest、Jest 或 Playwright 框架可用时，为每条可自动化用例编写独立 .test.* 或 .spec.* 文件。不得安装依赖、提交、推送或部署。',
    '需要服务、外部依赖、凭据或人工判断的用例保留完整描述，不编造结果，不填 testFile。单文件测试和真实页面验证应拆成不同用例。只返回本批 JSON 数组，不输出 Markdown 或解释。',
    ...(options.issues.length ? [`上次验收问题：${JSON.stringify(options.issues)}`] : []),
    ...(feedback ? [`本批上次失败，必须修正：${feedback}`] : []),
    ...(options.draft && attempt === 0 ? [`未解析的上一批草稿，仅作修复参考：${options.draft.slice(0, 24000)}`] : []),
  ].join('\n')
}

const canonicalFieldsInstruction = 'preconditions、testData、cleanup 三个字段必须各自生成为非空字符串，每个不超过 2000 字符，不得使用数组或对象；多项内容在字符串内使用换行，JSON 中换行须转义为 \\n。不需要测试数据或清理时必须在对应字符串中说明原因。字段 JSON 示例：{"preconditions":"已登录测试账号\\n已打开设置页","testData":"显示名称：验收用户","cleanup":"恢复原显示名称"}。'

function previousGenerationWithAuthorizedInstruction(options: TestPlanGenerationPromptInput): string {
  return previousGenerationExpression(options).replace('\n新用例必须包含 classification：', `\n${canonicalFieldsInstruction}\n新用例必须包含 classification：`)
}

const input: TestPlanGenerationPromptInput = {
  baseline: [{ criterion: '保存\r\n"值"', id: 'REQ-001', required: true, source: 'PRD', scenarios: ['normal', 'boundary'] }],
  cases: [
    { status: 'failed', title: '保存', id: 'TC-02', expected: '一致', source: 'PRD', steps: ['保存'], requirementIds: ['REQ-001'], scenario: 'normal', testFile: 'save.test.ts', output: '原始输出' },
    { id: 'TC-01', title: '边界', source: '设计', steps: '查询', expected: '一致', status: 'passed' },
  ],
  repairIds: [], coverage: [{ scenario: 'boundary', requirementId: 'REQ-001' }], capacity: 8,
  instruction: '用户目标\n保留空格  ', issues: [], feedback: '', attempt: 0,
}

test('generation prompt differs from the literal previous expression only by the authorized canonical-field instruction across conditional branches', () => {
  for (const repairIds of [[], ['TC-01', 'TC-02'], ['missing']]) {
    for (const context of [undefined, '', '上下文\r\n附件']) {
      for (const testScript of [undefined, '', 'node --test "*.test.ts"']) {
        for (const issues of [[], ['问题一', '问题二\n"引号"']]) {
          for (const feedback of ['', '失败\r\n重试']) {
            for (const attempt of [0, 1, 2]) {
              for (const draft of [undefined, '', '草稿\n', 'x'.repeat(23999) + '😀尾']) {
                const options = { ...input, repairIds, context, testScript, issues, feedback, attempt, draft }
                const before = structuredClone(options)
                assert.deepEqual(Buffer.from(buildTestPlanGenerationPrompt(options)), Buffer.from(previousGenerationWithAuthorizedInstruction(options)))
                assert.deepEqual(options, before)
              }
            }
          }
        }
      }
    }
  }
})

test('generation preserves source object order, repair filtering order and fixed summary key order with the authorized canonical-field instruction', () => {
  const prompt = buildTestPlanGenerationPrompt({ ...input, repairIds: ['TC-01', 'TC-02'] })
  assert.ok(prompt.includes(`验收基线：${JSON.stringify(input.baseline)}`))
  assert.ok(prompt.includes(`返回恰好 2 条，不重写已通过的用例：${JSON.stringify(input.cases)}`))
  assert.ok(prompt.includes('[{"id":"TC-02","title":"保存","requirementIds":["REQ-001"],"scenario":"normal","testFile":"save.test.ts","status":"failed"},{"id":"TC-01","title":"边界","status":"passed"}]'))
  assert.deepEqual(Buffer.from(buildTestPlanGenerationPrompt({ ...input, baseline: [], cases: [], coverage: [], capacity: 1 })), Buffer.from(previousGenerationWithAuthorizedInstruction({ ...input, baseline: [], cases: [], coverage: [], capacity: 1 })))
})

test('canonical-field instruction includes one valid JSON example with string fields and escaped newlines', () => {
  const prompt = buildTestPlanGenerationPrompt(input)
  assert.equal(prompt.split('\n').filter((line) => line === canonicalFieldsInstruction).length, 1)
  const example = JSON.parse(canonicalFieldsInstruction.split('字段 JSON 示例：')[1].slice(0, -1)) as Record<string, unknown>
  assert.deepEqual(Object.keys(example), ['preconditions', 'testData', 'cleanup'])
  for (const value of Object.values(example)) {
    assert.equal(typeof value, 'string')
    assert.ok((value as string).trim().length > 0 && (value as string).length <= 2000)
  }
  assert.equal(example.preconditions, '已登录测试账号\n已打开设置页')
  assert.equal(example.testData, '显示名称：验收用户')
})

test('serialized decision suffix matches the literal worker expression without reserializing', () => {
  for (const prompt of ['', '提示\r\n保留尾部\n']) {
    for (const decisions of ['[]', '[{"answer":"是","question":"确认？"}]', '[ { "question": "保留空格" } ]']) {
      const previous = `${prompt}\n已确认用户决策：${decisions}\n本次是独立短会话，仅依据上述输入产物及附件工作，不依赖其他会话历史。需求歧义使用 ask_user，不猜测或豁免。`
      assert.deepEqual(Buffer.from(appendSerializedDecisionSuffix(prompt, decisions)), Buffer.from(previous))
    }
  }
})