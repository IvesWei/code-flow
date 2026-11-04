# 测试执行全流程与约束

本文描述当前平台从提交执行请求到保存结论的实际链路，不是未来能力清单。设计审查通过、协议解析通过、脚本退出成功和完整业务验收是不同层次的证据。自定义范围通过不代表全部需求通过。

相关文档：[验收规范](acceptance-standard.md)、[测试策略](test-policy.md)、[自测阶段与产物](self-test-flow.md)、[项目入口](../README.md)。

## 1. 入口与界面中的三个范围

生成用例与用例执行为纵向独立模块，不使用标签切换。生成模块保存设计、审查与选择操作；执行模块独立展示运行状态、筛选、分页和证据。

| 对象 | 输入与输出 | 硬约束及失败分支 |
| --- | --- | --- |
| 本地选择草稿 | 勾选用例、编辑理由、确认风险 | 仅是前端状态；改集合或理由撤销确认，不会修改已经保存的执行清单 |
| 已确认验收范围 | 提交 acceptanceSelection，服务端记录集合、理由、确认时间和历史 | custom 必须非空；恢复默认显式传 null。不是修改需求基线或豁免合规要求 |
| 已保存执行计划 | testExecutionPlan 的 cases、selected、gatePolicy、reason、时间及版本引用 | 执行模块只以 selected === true 展示正式范围，不把草稿或当前过滤结果当执行范围 |
| 历史运行 | 没有计划时保留有证据的旧结果 | 明确是范围不完整的历史记录，不推导全部选中项，不虚构多轮历史 |

实现：[设计与选择模块](../src/features/testing/execution/SelfTestResults.tsx)、[执行模块](../src/features/testing/execution/TestExecutionResults.tsx)、[策略计算](../shared/test-policy.ts)。计划中的未知用例 ID 仍需显示为缺失定义，不应静默消失或算通过。

## 2. 请求、身份与输入校验

入口为 `POST /api/tasks/:id/self-test`，不是直接执行模型返回的命令。实现：[HTTP 入口](../server/index.ts)、[策略输入解析](../shared/test-policy.ts)。

| 步骤 | 输入 → 输出 | 必须满足的条件 | 失败分支 |
| --- | --- | --- | --- |
| 请求边界 | 本地工作台请求 → 可接受请求体 | 非 GET API 校验工作台 Origin；JSON 上限 32 KiB | 非法来源或过大请求被拒绝 |
| 身份与归属 | 当前登录会话、taskId → 本人任务 | Copilot 登录有效；任务属于当前 ownerId | 未登录 401；任务不存在或不属于本人 404 |
| 生命周期 | 已保存任务 → 允许启动 | 状态为 SUCCESS / REVIEW / ACCEPTED，任务未运行，无其他 busy task；repair 还须可重试 | 返回错误，不并发开启另一执行流程 |
| 工作区与附件 | 任务目录、分支、PRD → 可继续处理的输入 | 原任务目录和分支一致，附件有效 | 停止，不重新克隆替代，不静默切分支 |
| intent | execute 或 repair → 显式意图 | HTTP 省略时为 execute，其他值拒绝 | 不因地址存在或重复点击隐式修正 |
| selectedCaseIds | 默认策略的追加执行 ID → 追加选择 | 最多 1000 个、不重复、已保存且状态 pending 或 manual | 未知、重复、已执行 ID 拒绝；不取消必验、不把 advisory 改为 blocking |
| acceptanceSelection | custom 的 caseIds 与 reason → 本次阻断集合 | 至少一项、最多 1000 项、不重复、已有且非 invalid；理由 trim 后非空，原长度不超过 2000 字符 | 不接受空范围、未知 ID 或无理由；可选择已有 passed 或失败项 |
| automationUrl | 本机预览地址 → origin | 仅 HTTP，localhost / 127.0.0.1 / [::1]；无用户名、密码、query、hash | 拒绝非法地址；执行器使用 origin，页面路径来自协议 path |

工作台 GitHub 身份不等于被测系统账号，也不授权浏览器填写密码。不要向聊天、接口示例或文档提交真实令牌。`allowNewSession === true` 是编码恢复的明确备用会话授权，自测自身使用独立短会话，不依赖恢复编码会话。

## 3. execute 与 repair

| 意图 | 行为与输出 | 禁止事项 / 停止点 |
| --- | --- | --- |
| execute | 读取已有基线、用例和评审，核对版本；必要时只读评审选中范围，再执行 | 不生成、补齐或修复用例，不授权模型写文件；默认门禁未通过或仍有 draft，HTTP 409 |
| repair | 明确授权生成缺项或定点修正，再设计评审与执行 | 外层最多 3 轮；设计质量拒绝立即 REVIEW，不在同次调用里反复修到通过 |
| 发布后内部自测 | worker 内部默认 repair，HTTP 入口会明确传 intent | 不可把 worker 默认值解释为旧 HTTP 请求也会自动修正 |

repair 无基线时提取 1 至 50 项需求；按明确问题 ID 修正，先覆盖必验场景，再补充非必验项。生成批次默认 8（1 至 20），总量默认 300（1 至 1000），补充预算默认 16（0 至 1000）。对应变量为 `SELF_TEST_BATCH_SIZE`、`SELF_TEST_MAX_CASES`、`SELF_TEST_OPTIONAL_MAX_CASES`，非法值停止，不静默回退。补充预算耗尽不能豁免必验缺口。

生成批次仅在收到内容但解析、结构或覆盖不合格时最多尝试 3 次（含首次）；发送异常、超时、空响应及保存失败不走内容重试。有效批次立即保存，原始响应和无效 draft 保留审计，不视为合格用例。标题、来源、步骤和预期各最多 1000 字符，前置条件、测试数据、清理各最多 2000 字符，testFile 最多 250 字符；规范格式及兼容归一化见验收规范。

生成模型仅允许仓库内合法 `.test.*` / `.spec.*` 写入，不授权 shell、业务代码、配置或 sandbox bypass；排除 .git、node_modules、.env 路径段和符号链接。已有文件仅明确修正目标或同批部分输出可以覆盖。生成可写路径不意味着运行器一定支持该扩展名。实现：[worker](../server/execution/worker.ts)、[批次生成](../server/verification/test-plan-generation.ts)、[生成预算](../server/verification/test-plan-policy.ts)、[写权限](../server/verification/self-test-permissions.ts)。

## 4. 设计门禁与来源版本

| 步骤 | 输入 → 输出 | 硬约束 | 失败分支 |
| --- | --- | --- | --- |
| 默认确定性检查 | 全量用例、基线 → 结构及覆盖结果 | 必验需求适用场景覆盖，字段/映射/断言/数据/清理有效，文件独立 | 拒绝则不调用默认模型质量评审 |
| 默认模型评审 | 原始附件、用户决策、完整基线、本批定义和全量索引 → qualified / issues / caseIssues | 全部批次完成且 qualified；逐条 caseReviews 只采显式值 | 任一拒绝或未完成阻止默认执行，转 REVIEW |
| 自定义范围评审 | 确认集合与理由、需求和完整选中定义 → executionAssessment | coverage / quality 为警告；executability / conflict / safety 为设计阻断 | checking / blocked / unknown 不进入执行准备；允许质量 rejected + readiness ready，保留警告 |
| 来源校验 | 附件、目标、决策、基线、用例定义、代码、模型、规则及范围 → 指纹 | 完成产物需匹配 phase、scope、指纹、规则版本 | 来源变化时 execute 不沿用旧基线；需明确 repair。评审期间/执行前后版本变化阻止验收 |
| 计划保存 | 通过的评审、选择及版本引用 → testExecutionPlan | 保存后才执行；默认必验来自需求映射，custom 仅选中集合为 blocking | 无计划不推断正式范围；未选项不改成 passed/skipped |

设计审查检查可判定性，不读取测试文件认证脚本语义，也不因缺 URL、runner 或运行环境拒绝设计。ready 只表示“设计审查完成”，不是环境就绪。默认旧未分类、未知映射或关联必验需求的用例保守 blocking；补充 always 会运行但 advisory，on_demand 默认不选。优先级与类别不会自动豁免或重排执行顺序。

当前自测规则为 `isolated-self-test-v3-design-review`。代码快照覆盖 Git 管理和未忽略文件的内容；忽略文件、外部依赖及远端状态没有完整认证。变化保守失效相关评审，不是细粒度影响分析。评审身份不以预览 URL 作为设计判断条件；执行与浏览器证据另绑定目标 URL 和协议。实现：[版本产物](../server/verification/self-test-artifacts.ts)、[设计校验](../server/verification/acceptance.ts)、[策略](../shared/test-policy.ts)。

## 5. 证据复用与执行分流

worker 按现有清单顺序逐条处理选中项，不并发、不按优先级自动排序。已有 passed 且证据指纹一致时跳过重跑；新证据指纹不一致则回到 pending。无指纹的历史 passed 兼容保留并告警“无法认证代码版本”，不能描述成已补做版本认证。

| 顺序 | 输入 / 输出 | 约束和失败分支 |
| --- | --- | --- |
| 1 | 未选项 → 保留原状态 | 不执行、不改成 skipped、不计通过 |
| 2 | 有效 passed → 复用证据 | 必须应用上述版本规则；不保证每次提交都真实重跑 |
| 3 | 有 executionBinding → 可信 Playwright Test；否则有 testFile → 旧单文件 runner | 显式绑定优先；准备受阻、失败或报告不完整均不回退旧文件 runner 或浏览器 DSL |
| 4 | 无 testFile、有预览 URL → 浏览器规划与运行 | 有脚本且协议/输入版本相符可复用，否则规划；服务须预先启动 |
| 5 | 无 testFile、无 URL → manual | 不能以工程 build 成功代替用例通过 |

准备受阻 manual/skipped 不反写设计审查。可信 Playwright Test 保留独立结构化结果（见下节）；旧文件 runner 的 manual/skipped 与浏览器 run 的 blocked 不同。实现：[逐条执行](../server/execution/worker.ts)、[单文件执行器](../server/verification/self-test.ts)。

### Phase 1：可信 Playwright Test 绑定与必需断言

本阶段保留现有生成、设计审查及默认/custom 门禁，仅为显式人工审批的测试增加执行路径，不自动把生成脚本认证为可信。未绑定的旧文件 runner 和 browser DSL 仍保留，但其 passed 不是新架构的逐项断言认证，更不是完整语义认证。

共享 [执行契约](../shared/test-execution.ts) 按用例 assertions 顺序生成必需清单：例如 TC-1 的第一项为 `TC-1:A001`。每项都必须用精确标记的 `test.step` 包裹，并在其中实际执行至少一个 Playwright 原生 `expect`，例如：

```ts
import { test, expect } from '@playwright/test'

test('checkout submits', async ({ page }) => {
	await page.goto('http://127.0.0.1:4173/checkout')
	await test.step('[assertion:TC-1:A001]', async () => {
		await expect(page.getByRole('button', { name: '提交订单' })).toBeEnabled()
	})
})
```

示例仅演示一项映射，不代表完整结账验收。须逐项实现清单的全部要求；空步骤、日志、只有动作、跳过的步骤或未实际执行的 expect 不计通过。reporter 统计原生 expect 叶步骤，嵌套的其他断言标记不替外层凑数；缺项、重复或未知 ID、命中多项测试及身份不匹配不能得到 passed。即使全部 expect 运行成功，也仍需人工判断它们是否真正覆盖需求，不能用无关恒真断言替代业务要求。

在“用例执行”中打开“绑定可信 Playwright”或“审阅可信绑定”，填写相对文件路径、完整测试标题和 project，核对全部断言 ID，明确勾选人工审阅并信任后保存。保存不执行测试，也不表示通过。标题对应 reporter 的 fullTitle，即 describe 层级与测试标题拼接，不含 project/文件路径；project 必须精确匹配，空字符串仅对应无名项目，不是任意项目。入口受当前设计审查和空闲状态约束，最终以服务端校验为准。实现：[绑定编辑器](../src/features/testing/execution/ExecutionBindingEditor.tsx)、[执行界面](../src/features/testing/execution/TestExecutionResults.tsx)。

`GET /api/tasks/:id/execution-bindings/:caseId` 读取当前清单及绑定；同路径 `POST` 仅接收 `testFile`、`testTitle`、`project`、按清单顺序的完整 `assertionIds` 和 `confirm: true`。服务端检查登录、归属、POST Origin、空闲任务、当前默认 qualified 或精确 custom 范围的 ready 评审，以及附件/定义/工作区版本。服务端生成 `approvedBy`、`approvedAt`、`reviewedAt`、`caseFingerprint`、`designFingerprint`（工作区快照指纹）及 `testSourceFingerprint`（文件 SHA-256），拒绝客户端指定这些权威字段；审批读取文件但不运行它，也不自动验证映射语义。绑定目标须为仓库内不含符号链接、最大 128 KiB 的普通 .spec/.test 文件。绑定内容变化会清除该项旧证据并撤销旧绿色结论；来源或设计版本不匹配须重新审阅，不能靠重复执行绕过。实现：[审批路由](../server/http/execution-binding.ts)。

运行前须由可信操作者在**目标仓库**手动安装/核对本地 `@playwright/test`，准备浏览器、可信 Playwright 配置、隔离测试数据，并手动启动被测服务。平台自身的依赖不代替目标仓库依赖；新 runner 不自动安装任意包、下载浏览器或启动应用。适配器导入现有配置生成临时 wrapper，覆盖 `webServer: undefined`，不改原配置；多份根配置会受阻。执行固定单 worker、零重试、单次运行、禁用 project dependencies，并在报告中再次核对精确文件/fullTitle/project。它不依赖旧 scripts.test 匹配规则。实现：[适配器](../server/verification/playwright-test.ts)、[reporter](../server/verification/playwright-reporter.cjs)。

**这是可信代码执行，不是沙箱。** 测试源码、导入模块及 Playwright 配置/钩子都可执行任意代码；关闭 webServer 不阻止配置或测试自行启动进程、访问网络或文件。继承环境仅过滤 `DB_*`、`TASK_STORAGE`、`CODEFLOW_ENV_FILE`，不是秘密隔离；其他环境变量及本机资源仍可能可达。只能在无生产凭据的隔离环境运行可信代码，不提供生产账号、跨源认证或凭据授权流程。新 runner 不继承 DSL 的同源/敏感字段守卫，不应把其任意代码能力当成安全授权。执行失败或不完整不自动修改脚本、降低断言或 repair-to-green；修正仍须独立明确授权，改变输入后重新审阅。

结构化 `executionResult` 保存 runner、用例指纹、起止时间、原因及每项断言的 passed/failed/missing 和 expectCount；总体状态为 `passed` / `failed` / `incomplete` / `blocked`。仅精确命中一项正常成功的测试、退出成功且全部必需断言真实通过才 passed；实际测试/断言失败为 failed，缺失或不完整报告等不能算通过，准备/报告不可用为 blocked。为兼容原状态，incomplete 映射 skipped、blocked 映射 manual，但结构化值保留。“用例执行”及自动化看板/详情均区分 Playwright Test、DSL、legacy，并展示结构化状态及断言摘要，不升级旧证据。实现：[执行结果](../src/features/testing/execution/TestExecutionResults.tsx)、[自动化看板](../src/features/automation/AutomationDashboard.tsx)、[自动化详情](../src/features/automation/AutomationTaskDetail.tsx)。

新 runner **仅持久化结构化摘要**，不登记或保留 trace、截图及原始 JSON 报告供 UI 下载；临时 wrapper、报告和输出目录在 finally 尽力清理。配置可能在临时目录产生附件，这不构成持久化证据；任意可信代码自行写到其他位置的文件也不在清理保证内。旧 DSL 截图链路不变。`npm run build` 通过 [复制脚本](../scripts/copy-playwright-reporter.mjs) 将 reporter 复制到 dist-server/server/verification/playwright-reporter.cjs，编译部署须携带此资产，缺失时 blocked，不回退执行。

验证范围：[适配器测试](../server/verification/playwright-test.test.ts) 包含真实 Playwright CLI + reporter + 本机 Chrome 的点击、几何布局、网络三类隔离 fixture；网络 fixture 用 `page.route` 本地拦截并合成响应，不请求真实生产服务。缺本地 @playwright/test 时这些测试会跳过，不自动安装；fixture 成功不证明真实任务、生产网络、账号或完整需求通过。本轮文档修改不重跑这些 fixture，也不新增 UI/运行时验收结论。

## 6. 单文件执行的精确支持范围

本节仅描述**无 executionBinding 的旧单文件路径**，不是上述可信 Playwright Test 契约。只有仓库根 package.json 的 `scripts.test` 完整匹配下列形式才执行。额外 flags、环境前缀、组合命令等不做静默删改，不推测其语义。

| scripts.test | 实际单文件形式 | 文件要求 |
| --- | --- | --- |
| vitest / vitest run | npm exec --no -- vitest run FILE | .test 或 .spec，JS/TS 系列后缀 |
| jest | npm exec --no -- jest --runInBand --runTestsByPath FILE | 同上 |
| playwright test | npm exec --no -- playwright test FILE | 仅 .spec，JS/TS 系列后缀 |
| node --test | node --test FILE | .test 或 .spec，仅 js / cjs / mjs |
| tsx --test | node --import tsx --test FILE | .test 或 .spec，JS/TS 系列后缀 |

JS/TS 系列后缀的匹配为 `[cm]?[jt]sx?`。Windows 的 npm exec 通过 cmd.exe 启动。除 Node 内建 runner 外，依赖必须能从工作区解析，tsx 以外还需本地 node_modules/.bin；不自动安装、下载或启动服务。

路径只允许 ASCII 字母、数字、下划线、点、斜线、连字符，拒绝绝对路径、`..`、`.git`、危险的 `-` 起始文件名和工作区外路径。必须为普通文件、规范 realpath 与目标一致，不接受符号链接；最大 128 KiB。已有测试无需属于本次 Git 变更。

源码文本须匹配 test/it 声明及 assert/expect 声明，否则 skipped。这只是文本检查，不是 AST/业务语义认证，也不证明断言确实执行。单文件超时 120000 ms，非零退出或超时 failed；零退出通常 passed。仅 Node/tsx 额外识别 `tests 0` 或 `pass 0` 为 skipped，其他框架尚无通用结构化报告核验。

底层 stdout/stderr 合并缓冲保留末尾 12000 字符；记录脱敏后最多 8000 字符，单用例输出取末尾 4000。截断日志不等于完整执行报告。实现：[runner 和安全检查](../server/verification/self-test.ts)、[子进程](../server/git/git.ts)、[输出处理](../server/execution/tool-detail.ts)。受限浏览器协议不提供任意 JS，但仓库测试本身是可执行代码，现有检查不是操作系统沙箱，必须使用可信仓库和隔离环境。

## 7. 浏览器模型规划与等待

浏览器规划不是只发送标题。worker 传完整 caseInputs（需求映射、场景、前置条件、测试数据、步骤、预期、断言、清理等定义）、目标 URL、共享协议与限制，携带来源/代码/评审引用形成规划指纹。不能为了协议能跑而删除完整用例要求，也不能用标题或元素存在替代业务预期。

基线、每次生成尝试、每个评审批次和每次浏览器规划都开独立 SDK 短会话；完成或失败后清理连接，不替换编码会话。sessionId、模型、指纹、输出及状态保存在阶段产物。短会话不代表固定 120 秒模型总期限。

| 请求类型 | 首次模型或工具响应 | 后续无进展窗口 |
| --- | --- | --- |
| 基线、默认/范围评审、浏览器规划 | 600000 ms | 300000 ms |
| 编码、生成用例 | 1200000 ms | 1200000 ms |

`MODEL_FIRST_RESPONSE_TIMEOUT_MS` / `MODEL_INACTIVITY_TIMEOUT_MS` 全局覆盖，整数范围各 10000 至 3600000 ms。发送 RPC 也在首响应窗口内；消息、推理和工具进展刷新后续窗口，ask_user 等用户回答暂停。SDK 接收、turn start、压缩/截断仅更新状态，不续期；压缩由 SDK 运行时负责。持续有效进展可使整个模型请求长于窗口，不能把后续无进展窗口误称硬总时限。实现：[超时配置](../server/execution/model-timeouts.ts)、[进展等待](../server/execution/session-progress.ts)。

模型内容须先严格解析。只在收到格式不合法内容时反馈修正一次，总共最多 2 次；blocked 为有效协议结果，不自动改写成可执行脚本。SDK 失败、超时或空响应不自动重发。没有确定性的“所有能力在调用模型前一次判完”分类器。浏览器规划/运行失败逐用例捕获，继续其他用例；同次 worker 调用中的失败浏览器集合不再规划/重跑，不等于首次模型超时就终止整个任务。

## 8. 当前浏览器协议与安全

浏览器模块与 worker 运行记录统一引用 browserProtocolVersion，2026-10-20 已升级为 browser-v4，新增能力见下节。隔离验证不代表真实任务已重跑或所有原用例均可执行。证据指纹包含 browserPlanInstructions，故协议内容变化会使有指纹的脚本/证据失效；不能仅凭历史 protocolVersion 字符串推断能力。实现：[共享协议、解析及执行](../server/verification/browser-automation.ts)、[worker 的协议指纹与运行记录](../server/execution/worker.ts)。

| 项目 | 当前契约 | 不满足时 |
| --- | --- | --- |
| JSON | `{path, viewport?, steps}` 或 `{blocked:true, reason, reasonCode?, requiredCapabilities?}`；拒绝未知字段，可去除包裹的 JSON 代码围栏 | 格式反馈修正一次，仍不合法则失败 |
| 路径 | path/URL 断言为同源 pathname，最多 251 字符，无 query/hash、跨站、反斜线、空白或危险控制/编码路径 | 解析拒绝，不通过导航绕过 |
| 步骤预算 | 1 至 60 步，至少一个 assert；selector 最多 250 字符，value 最多 1000 | 不缩减完整业务断言来凑预算 |
| 操作 | click、fill、clear、focus、press；目标取首个匹配元素 | 不开放任意 JS；选择器不唯一仍可能选错，模型须给可靠定位 |
| 键盘 | Tab、Shift+Tab、Enter、Space、Escape、四方向、Home、End | 不支持任意快捷键/组合键 |
| 断言 | assertText 包含可见文本；assertVisible/Hidden、Enabled/Disabled、Focused、Value、Attribute、Url | Hidden 包含不存在；Value/Attribute/Url 精确相等；空 fill/Value/Attribute 允许，空文本断言不允许 |
| 属性白名单 | id、role、title、aria-label、aria-expanded、aria-checked、aria-selected、aria-disabled、aria-hidden、data-testid、aria-controls、aria-invalid、aria-describedby、autocomplete、type、src、alt | src 预期仅同源绝对 pathname，无 query/hash；不开放 value/href 等任意属性，输出不含实际属性值 |
| blocked | reason 非空且不超过 1000 字符；reasonCode 为 capability/environment/authorization/manual/unknown | 缺分类为 unknown；不从旧日志关键词猜测 |
| 能力标识 | requiredCapabilities 可选，最多 20 个、唯一，每项匹配 `[A-Za-z][A-Za-z0-9_.:-]{0,79}` | 不合法则协议错误；它是缺项记录，不是能力授权 |
| 浏览器与视口 | 本机 Chrome、headless、新 context；默认 1280×800，可设整数 width/height，各 240 至 2560；无授予权限、禁用 service worker | 一份脚本一个视口，不支持步骤中动态切换；不自动下载浏览器，不自动使用已有登录上下文 |
| 请求边界 | 只允许目标 origin；跨源资源阻止，跨源导航失败 | 外部字体、图片或 CDN 也可能加载失败，不能承诺页面完整资源 |
| 等待 | action 10000 ms、初始导航 20000 ms，均受剩余预算限制；总执行预算 120000 ms，从 Chrome 启动前开始，包含导航、步骤和证据，不含模型规划 | 到期关闭浏览器并停止，不承诺操作系统清理绝对在该毫秒完成；与单文件及模型超时分别计算 |
| 敏感字段 | 拦截可识别 password/hidden 及密码、令牌、密钥、凭据等敏感描述的交互、文本/值读取 | 元数据断言可检查敏感元素的安全元数据，但不读取秘密值；策略受阻为 authorization/policy，不截图，不接受“已授权密码”绕过 |

### v3 测量原语的精确边界

### v4 增量能力

以下原语与原有步骤共用 60 步及 120 秒总预算，拒绝未知参数，不开放任意 JavaScript。

| 原语 | 输入及判定 | 边界 |
| --- | --- | --- |
| hover | selector，受限 Playwright 悬停 | 遵守动作超时及敏感字段守卫；不保证原生操作系统 Tooltip |
| assertCount | selector、整数 count（0 至 10000） | 统计全部匹配，含隐藏项；不是只取首项，不证明可见数量 |
| assertTextExact | selector、非空 value | 实际可见文本及预期均折叠连续空白并 trim 后精确相等；不证明实际行数或像素一致 |
| assertStyle 边框扩展 | border-color/width/style 及四个方向的对应属性 | 颜色、非负 px 宽度及样式白名单；仍按 computed CSS 字符串精确比较，不自动转换等价写法 |
| assertMetricComparison | selector/metric、otherSelector/otherMetric、operation（ratio/difference）、min/max/tolerance | 当前值除以或减去另一元素值；沿用几何指标和数值约束，分母为零失败，不支持任意公式 |
| snapshotGeometry | id、selector、metric | 仅存一个有限数字，最多 20 个唯一快照；只在单次执行有效、不持久化，不是断言 |
| assertSnapshotComparison | 先前 id、selector/metric、operation、min/max/tolerance | 当前值与保存值求比例或差；未知/前向引用、重复定义拒绝，不支持跨运行比较 |

快照 id 匹配 `[A-Za-z][A-Za-z0-9_-]{0,39}`；测量值及比较边界绝对值最多 1000000，至少一个 min/max 且 min 不大于 max，tolerance 为 0 至 100。记录前后数值差不能证明连续动画阶段、动画时长或所有中间帧正确。

这批能力补充元素唯一性、文本和布局状态等子断言。TC-01/02 等完整视觉用例仍可能需要视觉判断；TC-08/14 等仍可能需要原生浏览器或可访问性专项；TC-28/29 等仍受敏感字段、事件编排或其他预期约束。不得宣称原受阻用例全部解锁。受控响应释放、多上下文、存储审计、脱敏载荷、凭据授权、跨源认证、实际字体/视觉语义及原生密码管理器尚未补齐。

### 原有测量原语

| 原语 | 参数、判定与限制 | 不能推导的结论 |
| --- | --- | --- |
| assertGeometry | metric 为 width/height/x/y/top/right/bottom/left/scrollWidth/clientWidth/scrollHeight/clientHeight；min/max 至少一个，有限数且在 -1000000 至 1000000，min ≤ max；tolerance 默认 0，范围 0 至 100；闭区间比较 | rect 是视口 CSS 像素，scroll/client 是元素尺寸；没有任意两元素比较或全页布局证明 |
| assertStyle | 白名单 color、background-color、border-radius、font-family、font-size、font-weight、display、visibility、overflow/overflow-x/overflow-y、position、opacity、text-align；与 computed CSS 字符串精确相等 | #hex 与浏览器 rgb 序列化不自动等价；不支持任意 CSS、url()/var()、自定义属性、注入或视觉稿比对 |
| assertImageLoaded | HTMLImageElement complete 且 naturalWidth/naturalHeight 都大于 0 | 不证明图片内容、像素或与设计稿一致；不覆盖 CSS 背景图 |
| assertFontLoaded | font 总长最多 120，1 至 200px 加单一 ASCII 字体家族；存在同名 FontFace 且 loaded，同时 document.fonts.check 为真 | 未声明系统字体不能据 check 单独通过，不证明每个字形实际渲染结果，不注入字体 |
| assertNotObscured | 可见、尺寸为正、中心在视口内；elementFromPoint 命中自身或后代 | 仅中心点，不滚动，不证明整个控件无覆盖、所有点击位置或可访问性均合格 |
| startNetworkObservation | id 唯一，匹配 `[A-Za-z][A-Za-z0-9_-]{0,39}`；按同源 pathname + method 计数，方法限 GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS | 必须先开始再触发；没有追溯请求、响应成功、响应内容或数据库副作用认证 |
| assertRequestCount | 引用先前 observation id，count 整数 0 至 10000；observationMs 整数 0 至 3000，count=0 时至少 100；从断言开始完整等待该窗口，再比较自观测开始的累计请求尝试数 | 失败/中止尝试也计数，重复断言不重置；窗口后流量不在结论内；忽略 query，不读取/输出 body、query、header 或凭据，不 mock/注入 |

样式安全值仅接受有限颜色格式、受限枚举和数值：圆角为 1 至 4 个非负 px/% 或 0；字号 px；字重 normal/bold 或 100 至 900 的百位值；字体为 ASCII 名称列表（最多 200 字符）；opacity 为 0 至 1。几何、请求计数、样式和字体都采用明确参数，不开放模型任意 evaluate。

字段守卫不能识别所有未标注秘密，普通点击也可能有业务副作用。仅在可信本地服务、隔离测试数据上运行。协议没有网络注入、跨站、任意 evaluate、视觉基线比对、密码管理器、账号创建或生产安全绕过授权。

## 9. 能力与真实用例要求对照

本次不访问真实任务、SDK 日志或数据库。唯一由本次请求明确关联的编号是布局类 TC-01（原描述 TC01）；其余类别编号未提供，不能根据标题猜编号或宣称“原 34 条全部解锁”。表中是能力到完整验收条件的差距，不是对这些用例的重跑结果或通过判定。

| 日志类别 / 已知编号 | 已核实的当前执行器原语能证明什么 | 完整用例仍缺什么 / 不可声称什么 |
| --- | --- | --- |
| 布局 TC-01 | 指定视口下的几何上下界、白名单 computed style、显隐和中心点命中 | 须按需求提供数值与容差；没有全页关系/视觉基线，不因新增原语自动判该用例通过 |
| 输入清空、焦点、键盘（编号待核对） | clear/空 fill、Value、Focused、受限 press | 复杂快捷键、系统输入法、原生密码管理器不支持；必须验证完整预期 |
| 图片、字体（编号待核对） | 图片完成且有自然尺寸；指定已声明字体 loaded + fonts.check | 不证明图片内容、全部字形或视觉正确，外站资源仍阻止 |
| 点击命中、遮挡（编号待核对） | 中心点命中与交互后状态 | 不证明整个区域无遮挡；仍需完成用例全部交互与预期 |
| 重复提交、请求次数（编号待核对） | 触发前观测、窗口内精确累计同源请求尝试数 | 不证明请求成功、幂等性、服务端仅写一次或窗口外无重复 |
| 表单校验、显隐、路由（编号待核对） | 文本、状态、值及同源 pathname | 不证明服务端持久化、副作用、权限隔离或 query/hash 要求 |
| 登录、令牌与授权（编号待核对） | 识别部分敏感字段并停止 | 不输入密码/token、不共享 GitHub 登录、不自动获得被测系统账号 |
| 性能、可靠性、真实参与者（编号待核对） | 普通交互或单文件可执行测试 | 无负载/P95/SLA 专项引擎、长期调度、真实用户研究或人工证据认证 |

上述 v3 原语已通过 parser、runner 隔离测试与 worker 接入契约验证。新增原语不自动证明完整业务断言、数据库副作用、账号授权或全部原有用例均可执行。规划模型仍可返回缺能力或缺环境，新增原语也不是让弱脚本通过的许可。

## 10. 运行、持久化与证据

| 步骤 | 输入 → 输出 | 硬约束与失败分支 |
| --- | --- | --- |
| 开始用例 | 选中且未复用项 → running 与开始时间 | 顺序执行；准备受阻单独记录，不伪装为 running 成功 |
| 可信 Playwright Test | 人工绑定 → passed/failed/incomplete/blocked 的结构化摘要 | 全部必需断言须真实执行；不回退旧 runner/DSL，不持久化 trace/截图 |
| 文件执行 | 安全文件与本地 runner → passed/failed/manual/skipped、输出 | 超时/非零失败，准备拒绝不回退浏览器 |
| 浏览器规划 | 完整定义 → 受限脚本或 blocked | 原始响应、解析结果、指纹和阶段会话可追溯；blocked 不算执行通过 |
| 浏览器运行 | 合法协议 → AutomationRun | 保存 script、起止时间、输出、状态及 failureKind/failureCategory；逐项失败继续其他用例 |
| 截图 | 非 policy 运行 → 截图引用（尽力） | 截图可能失败，策略拦截不截图；截图不是视觉验收或完整安全证明 |
| 保存与登记 | 用例状态、run、阶段产物、证据 → 持久化 | 阶段/批次 flush；登记截图文件与关联元数据，不扫描/认证所有历史文件 |
| 回读 | 任务、自动化详情、截图 API → 当前用户可见记录 | 详情与截图仍校验任务归属；历史按分页/投影读取，不代表一次加载全部历史 |

浏览器失败类别为 action / assertion / navigation / browser / policy，受阻原因与失败阶段分别保存，不由未知文本猜“断言失败”。文件证据、设计 caseReviews 与 browser run status 不是同一状态域。旧记录缺字段则显示未知或历史，不凭 passed 推导设计合格。

JSON 适配器保存版本化状态；MySQL schema 2 分开保存用例、执行尝试、验收快照及 self-test artifacts。已完成阶段产物不可覆盖，phase/scope 下产生新 revision；会话关闭不等于删除 SDK 目录。截图通常在 DATA_DIR/evidence/taskId，短会话在 DATA_DIR/sessions/taskId/self-test/artifactId；历史产物失效不会自动删除文件。实现：[阶段产物](../server/verification/self-test-artifacts.ts)、[存储说明](storage-v2-plan.md)。

## 11. 结论与工程检查

| 结论 | 必须满足的条件 | 不代表什么 |
| --- | --- | --- |
| 默认 SUCCESS | 默认设计 qualified，至少一条 blocking，全部 blocking passed，工程 checks 全部通过 | advisory 失败/未验证可保留，不是“所有测试通过” |
| 自定义 SUCCESS | 确认非空范围，完整设计核对 readiness ready，所有选中 blocking passed，工程 checks 全部通过 | 仅范围通过，保留 coverage/quality 警告、默认拒绝及未选结果，不是全量需求验收 |
| REVIEW | 必验 failed/manual/skipped、缺少有效必验、设计拒绝/未完成、版本或执行受阻等 | 不是默认可放行；实际失败与质量问题应分开处理 |
| ACCEPTED | 用户明确接受当前风险 | 不修改失败证据，不等于 SUCCESS，不认证人工证据为 passed |

工程检查有一个重要时序：编码阶段仅在根 package.json 有相应脚本时执行 `npm run test` / `npm run build`，保存 checks；**单独启动自测的 selfTestOnly 路径沿用已有 task.checks，不重新运行这些工程检查**。当前成功判断是已有 checks 全部 passed，没有“所有项目必须提供 test 与 build”的强制要求。需结合时间与代码版本理解证据，不将重试自测描述为工程检查已重跑。实现：[worker 结论判断](../server/execution/worker.ts)、[阻断统计](../shared/test-policy.ts)。

当前没有人工证据录入并认证必验 passed 的流程，没有完整脚本语义一致性认证、通用账号/测试数据/环境预检、跨 runner 的完整结构化报告解析、偶发失败统计或完整外部环境版本认证。Phase 1 仅核验绑定 Playwright Test 的必需断言报告，人工绑定不是人工证据认证。自动化只验证用例部分要求时不能合法宣称整条用例通过；需要完整断言或明确受阻与补充证据路径。

## 12. 取消、中断、重试和缓存

| 情形 | 当前行为 | 用户下一步与限制 |
| --- | --- | --- |
| 关闭前端 | 不等于停止后台任务 | 不把浏览器页面关闭当取消确认 |
| 停止后台 / 进程中断 | 活跃自测恢复时进入 REVIEW，未完成阶段不可作为完成缓存 | 重新登录后明确操作；不会自动重放模型请求或中断命令 |
| 模型超时 / SDK 错误 | 记录 failed/timed_out，清理会话 | 无平台超时自动重发；已完成批次保留 |
| 同输入重新执行 | 仅匹配 complete、scope、指纹和规则的批次可复用 | 拒绝缓存仍拒绝，不是绕过门禁；失败/中断批次重新请求 |
| 输入变化 | 失效旧评审、脚本或有指纹的执行证据 | 重新核对设计及执行；来源变化需明确 repair，不隐式生成 |
| repair 的执行失败 | 满足条件才进入剩余轮次，最多 3 轮 | 浏览器失败集合在同次 worker 内排除重跑；质量拒绝立即停止 |
| 人工修正与风险接受 | repair / accept 为独立意图 | 重复 execute、填 URL 或“接受风险”都不授权修复、不把失败改为通过 |

当前未提供自测专用 cancel HTTP 接口，也没有承诺跨进程立即终止整棵测试子进程的用户级取消契约。不要把模型 abort、单命令超时或后台退出混称为完整取消功能。运行环境与外部副作用需另行确认；自动重跑可能有风险，平台不会用超时重发代替显式决策。

## 13. 阅读与验证入口

- 流程控制与最终结论：[server/execution/worker.ts](../server/execution/worker.ts)。
- HTTP 身份、意图、输入校验：[server/index.ts](../server/index.ts)。
- 单文件匹配及准备：[server/verification/self-test.ts](../server/verification/self-test.ts)。
- 浏览器能力、解析、安全和运行：[server/verification/browser-automation.ts](../server/verification/browser-automation.ts)。
- 超时与事件等待：[server/execution/model-timeouts.ts](../server/execution/model-timeouts.ts)、[server/execution/session-progress.ts](../server/execution/session-progress.ts)。
- 阶段缓存与版本：[server/verification/self-test-artifacts.ts](../server/verification/self-test-artifacts.ts)。
- 需求策略：[shared/test-policy.ts](../shared/test-policy.ts)。

本文的源码核对不包含真实任务重放、数据库写入、模型请求、账号凭据读取或生产 API 重启。能力对照表不是实际用例通过报告；并行实现的最终能力和测试结果应以最后核对的源码与隔离回归记录为准。