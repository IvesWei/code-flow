# 独立测试工作区

本文记录当前独立实现，不是迁移完成声明。用例规划与执行无需先创建编码任务；它们共用现有登录和 API 进程，但拥有独立记录、接口与工作目录。

## 入口与实现

- 前端同源入口：`/planning`、`/execution`；详情使用 `?planning=<id>`、`?execution=<id>`。旧 `/?view=planning`、`/?view=execution` 链接仍兼容，不需要编码流程先运行。
- [src/app/AppRouter.tsx](../src/app/AppRouter.tsx) 配置路由和懒加载；[src/features/testing/TestingWorkspace.tsx](../src/features/testing/TestingWorkspace.tsx) 提供独立页面、上传、导入导出、审批和执行操作。目录职责见 [frontend-organization.md](frontend-organization.md)。
- [shared/testing.ts](../shared/testing.ts) 定义项目、不可变用例包、执行批次和报告；[server/testing/planning-service.ts](../server/testing/planning-service.ts) 管理规划与发布；[server/testing/execution-service.ts](../server/testing/execution-service.ts) 管理准备、实现、安装、绑定及运行。
- [server/testing/planning-model.ts](../server/testing/planning-model.ts)、[server/testing/execution-model.ts](../server/testing/execution-model.ts) 调用独立模型会话；[server/http/testing.ts](../server/http/testing.ts) 提供 `/api/testing`；[server/testing/runtime.ts](../server/testing/runtime.ts)、[server/testing/repository.ts](../server/testing/repository.ts) 初始化与保存记录。

页面使用相对 `/api/testing` URL，fetch 默认携带同源 cookie，不需要在 URL 或请求正文填写 token。沿用平台 OAuth：管理员配置应用凭据，用户浏览器登录，后台认证用户并按 owner 隔离记录；401/403 需要重新登录或核对 Origin。不要读取、展示或提交实际凭据到文档/聊天。异源前端不是当前支持的入口，不能靠添加 `credentials: include` 宣称接入完成。

## 输入、输出与版本

| 阶段 | 输入 | 持久化输出 |
| --- | --- | --- |
| 上传 | requirements 的 md/txt/pdf 或 design 的 png/jpg/jpeg/webp；每次最多 7 个，每个最多 12 MiB | `TestingSource` 的 ID、名称、种类、SHA-256、大小、owner 范围 storageKey；生成前重新核对实际文件 |
| 规划 | title、requirements、instruction、modelId、sources；可选 referenceRepository/referenceBranch | 有 version 的 `PlanningProject`，草稿 baseline/cases/assessment、状态与事件 |
| 发布 | 当前结构、覆盖与逐条设计审查均合格的草稿 | 不可变 schemaVersion 1 的 `CasePackage`：ID、projectId、revision、时间、source/definition 指纹、rulesVersion、modelId、baseline、cases、assessment |
| 执行 | title、caseSetId、repository、可选 branch/previewUrl、default/custom scope | 有 version 的 `ExecutionRun`，选择范围、工作区/包指纹、设计 readiness、实现映射、人工绑定、逐条结果与事件 |
| 报告 | 当前 owner 的执行 ID | schemaVersion 1 的 `ExecutionReport`：run、casePackage、scope；不是对外部业务环境的认证 |

规划的参考仓库是可选上下文，当前入口仅接受 `https://github.com/<owner>/<repo>[.git]`，不是编码任务入口的完整仓库白名单。按公开 GitHub 仓库准备，不提供私库认证配置；URL 形状校验不等于服务端已核验 GitHub visibility。引用代码不覆盖需求与用户决策，也不是“现有行为必然正确”的依据。

包的 sourceFingerprint 绑定需求/指令、来源元数据及内容哈希、可选参考快照、模型和规则；definitionFingerprint 绑定基线与用例定义，审查指纹再绑定这些输入和规则。发布规则为 `case-planning-v1-design-only`。规划器按白名单重建定义，不把运行状态、输出、绑定、执行结果或旧 passed 当设计权威；运行结果和时间不参与定义指纹。执行另存 packageFingerprint、工作区快照、用例断言指纹及批准脚本源码哈希，不能把不同层级指纹混用。

外部 JSON 经 [server/testing/package-import.ts](../server/testing/package-import.ts) 校验 schema 并重新设计审查，生成新的来源链与指纹，不信任导入的 passed/qualified 标志、审批或指纹。此审查仅能依据包内基线和定义，不能证明它忠实于未提供的原始需求。同 owner 完全相同的已存包可直接返回，不冒充一次新审查。

## 操作与门禁

1. 在规划入口填写需求或上传来源，明确发起新一轮生成；允许 requirements 为空且 sources 非空的纯附件输入，但标题仍必填，只有 instruction 而没有需求/来源不能生成。基线、生成批次和审查批次使用新的独立短 SDK 会话，模型只读输入并返回结构化定义；失败保留草稿，不恢复编码会话、不自动重放。
2. 完成设计审查后明确发布版本包，或导入外部包重新审查。设计审查不认证环境或脚本语义。
3. 在执行入口选择包、仓库、分支、可选本机预览 URL 和范围，创建独立批次。准备操作克隆仓库并记录快照，不启动编码任务。
4. 明确生成测试实现：新会话返回 JSON `{files, mappings}`，只允许新的 `.codeflow-tests/...spec.ts` 及对应 case/file/fullTitle/project 映射。不是模型直接执行代码，不修改业务代码或配置，也不自动批准绑定。
5. 明确确认安装依赖，再逐条完整审阅可信源码、配置及其导入/钩子，确认文件、完整标题、project、全部断言 ID。服务端生成审批人、时间和指纹；模型无审批权，生成成功不等于批准或通过。
6. 全部所选用例绑定后明确启动。实际必需断言执行证据决定结果；失败、blocked、incomplete、取消不伪装 passed，不自动修复脚本或降低断言。终态批次再次执行需新建批次。

显式操作接口为 `POST /api/testing/executions/:id/implement`（生成实现，不要求安装确认正文）和 `POST /api/testing/executions/:id/install`（必须提交 JSON `{"confirm":true}`）。创建、准备或生成实现均不隐式安装依赖；安装不会生成实现或批准绑定。实现模型只有只读工具权限，返回 `{files, mappings}` JSON，由服务端校验后写入新的 spec，不生成配置、不运行 shell 或测试。

不可变包内冻结用例定义和断言顺序；断言 ID 按数组位置生成，如 `TC-1:A001`。审批与报告核对完整有序 ID 及指纹；它们不是跨版本稳定的语义注册表，插入、删除、重排或修改断言后必须重新核对绑定，不能仅按相同 ID 沿用旧证据。

默认严格设计门禁保留，默认范围保留必验及 always 集合，可追加用例，不能通过传 caseIds 删除必验。custom 必须明确非空的精确集合及理由；范围设计的 executability/conflict/safety 仍可阻断，coverage/quality 提示不被删除，readiness 不等于实际运行可用。独立创建执行要求已合格发布的全量包或明确标记的已审查范围包，不能借 custom 将未审查草稿直接执行。范围包只允许按其固定用例集合和理由创建 custom 执行，不能切换为默认全量执行。最终 passed 至少要求存在一个选中的 blocking 项且全部选中 blocking 项实际 passed；未选项不计通过，范围通过不是全量验收。不要把旧编码任务的工程检查/SUCCESS 状态直接套到独立报告。

### 需求基线格式

规划详情会显示当前批次、已保存用例数、最近 SDK 活动及活动时间。SDK 进度使用现有节流策略保存，不记录模型正文或工具参数；发送请求、等待响应、模型已返回等状态与真实批次保存分开。连续两分钟没有新的模型或批次事件时，页面显示等待提醒，不据此认定失败，也不自动重放请求。等待上限来自本轮实际模型超时配置，而非页面自行设置。详情刷新失败时标明当前是上次保存状态，不能作为任务仍在运行的证据；恢复刷新后清除该标记。旧任务没有细粒度事件时仅显示已有记录，不补造 SDK 活动。

中断、失败和取消均保留已保存草稿的可见数量，不会自动续跑。“继续生成并审查”在验证来源后使用已有基线与用例，只补齐缺失场景，再进入审查；“继续全量审查”不生成或修改用例，保留定义不变且已通过的批次，重审未完成或不通过的批次。批次审查按服务端当前批次大小对齐，重试从该批次开始，不恢复旧 SDK 会话。用例设计确实存在问题时，重新审查不保证通过，也不会自动改写断言或豁免问题。“重新生成新草稿”仍明确开启全新一轮。

用例详情支持编号、标题、需求、步骤等搜索，类型与审查状态筛选，10/20 条分页，以及跨页选择。可以选择本页或全部筛选结果，填写范围理由后发起设计审查；范围结果、用例 ID、理由和分批检查点独立保存，可用“继续此范围审查”恢复。选中范围不代表调整全量必验要求，局部通过不能代替全量发布审查。定义变化后旧范围结果只作历史参考，问题定位会清除筛选并跳至对应页面。

页面分为“生成用例库”和“审查工作区”两个独立区域。用例库用于搜索、分组浏览和增减选择；审查工作区只展示已选用例，具有独立搜索、分页、移出、理由与审查提交，也可直接编辑或优化单条用例。组件身份绑定项目而非每次操作标记；选择和理由按账号与项目保存在当前浏览器标签页的 sessionStorage 中，优化、编辑、审查、继续生成和刷新不会清空，删除的用例会移出范围。明确重新生成新草稿时清空旧选择，避免相同编号误套旧范围；不同账号和项目互不复用。

当前选择、理由与定义指纹完全匹配，且每条用例和全部批次均通过设计审查后，可使用“进入执行”。`POST /api/testing/projects/:id/publish-scope` 提交 `{version, caseIds, reason}`，服务端重新验证版本、来源、工作区、指纹、精确范围、理由及完整批次，通过 CAS 预留并发布不可变范围包，重试不重复消耗版本；包写入失败可恢复，未完成预留期间不能修改定义。范围包只有选中用例和关联需求，需求 `required:false` 明确不声称原始全量覆盖，`scope` 记录固定 ID、理由及 `originalDefinitionFingerprint`。项目原全量审查和状态不因此变成通过。

范围包发布后跳转执行创建页，自动带入并锁定已审查用例和理由，用户填写执行标题、目标仓库等后显式创建；跳转不会自动克隆、安装依赖或执行。服务端拒绝扩大、缩小、变更理由或改为默认执行。范围包导出保留 scope，完全相同的当前账号包可重用，外部导入仍须独立设计审查且不能去掉范围边界再当全量包发布。

规划用例按首个映射需求的功能点分组，支持折叠及选择组内全部筛选成员（含其他分页）；多需求映射用例只显示一次，完整映射保留在展开详情中。旧需求没有功能点名称时显示需求编号与验收描述，未找到对应需求的用例单独归入“未映射需求”，不推断或修改历史数据。分页按分组顺序排列，问题定位会同时展开目标功能组与用例。

展开单条用例可编辑设计字段、查看明确关联的审查问题，并针对问题优化或勾选重新生成此用例；优化理由可修改且不能为空。单条优化只请求目标定义及其关联问题，不生成或修改其他用例，不自动复审。可使用“审查此用例”取得新范围结论，或重新发起全量审查。编辑开始时绑定版本，409 等请求失败保留输入，不因后台刷新覆盖未保存内容。

`POST /api/testing/projects/:id/cases/:caseId` 提交 `{version, caseDefinition}`，ID 不可更改；`POST /api/testing/projects/:id/optimize` 提交 `{version, caseIds: [caseId], reason, regenerate?: boolean}`，范围必须恰好一条。接口验证账号、Origin、版本、来源和工作区，拒绝运行中、待确认及不完整发布状态；定义严格校验字段、长度、需求映射、场景与断言，不接受运行结果、脚本或未知字段。修改保留顺序、需求基线、其他用例和已发布包，清除草稿全量/范围审查与缓存，重新计算定义指纹并回到待审查状态；旧通过结果不能为新定义提供发布资格。

自定义设计审查只向模型提供所选用例索引及当前批次，原始需求用作证据，未选用例及范围外覆盖不作为本次拒绝理由。范围结果单独保存，列表以“范围”标记其逐条状态，尚未完成时不回退旧全量状态；全量摘要仍独立保留，局部通过不豁免发布门禁。设计审查中的拒绝问题按阻断展示，不套用执行准备阶段将 `quality` 作为非阻断提示的策略。

审查返回 `qualified: false` 且有合法范围内 `caseIssues`、但顶层 `issues` 为空时，从具体问题补齐摘要后保留不通过结论，不丢弃问题或降级为通过。其余无法校验的返回记录为 `REVIEW_INVALID`，接口和详情提示“审查返回格式校验未通过”，保留已保存草稿和通过批次，不误报模型调用失败；越界用例问题也拒绝接收。

`POST /api/testing/projects/:id/continue` 与 `POST /api/testing/projects/:id/review` 必须提交当前 `version`；范围审查另传非空 `caseIds` 和 `reason`。服务端校验账号、版本、范围、来源文件、工作区、来源与定义指纹后复用检查点，存在待确认问题时不能续跑。新检查点绑定规则与模型；旧无指纹草稿仅在本地需求来源与工作区校验一致、且没有未经证明的参考仓库时允许继续，无法确认一致时拒绝复用。重新回答业务澄清会变更输入，仍要求新一轮生成。所有检查点保存在既有 JSON body 中，不增加表或自动执行 SQL。进度提示不改变覆盖检查、审查或发布门禁。

规划基线明确要求 1 至 50 条 JSON 数组记录，`scenarios` 必须是非空字符串数组，元素仅允许 `normal`、`boundary`、`negative`、`permission`、`state`，不能返回场景描述对象。文本字段长度、唯一需求 ID、必验标记等仍由现有严格解析器校验。

首轮基线格式不合规时，在当前显式生成操作内最多追加一次独立只读模型会话，要求保持需求、必验标记和场景语义，仅修正格式；不是自动重试整个任务，也不自动修复测试脚本。修正后仍不符合契约则以 `BASELINE_INVALID` 保存失败，接口与详情显示“需求基线格式无效”，不误报为“模型调用失败”。修正时的业务澄清仍进入等待确认，真正的 SDK 调用失败仍保留模型错误分类。格式校验通过后仍需完成用例生成、覆盖检查与逐条设计审查，不能据此直接发布。

### 规划问题确认

兼容旧草稿时不会复用无来源/定义指纹的旧审查批次或范围结论，保存的用例必须重新完成设计审查；仅有一个指纹或任一指纹不匹配时拒绝继续。旧参考仓库草稿没有快照指纹时也不能安全续跑。

模型通过 `ask_user` 请求业务确认时，规划保存为 `needs_input`（等待确认），记录具体问题、选项、自由答复权限及问题 ID，不再作为普通失败处理。SDK 会话仍会结束，不保持后台等待进程。详情页复用编码任务的问题确认模式：选择选项或填写允许的自由答复，再点击“提交答复并重新规划”。

`POST /api/testing/projects/:id/answer` 提交 `{questionId, version, answer}`，校验当前账号、Origin、问题 ID、记录修订、非空及 3000 字限制；固定选项问题只接受已提供的选项。答复保存至确认历史，并追加到规划指令，然后启动新的独立规划轮次，清空旧草稿与旧审查结论，重新核验来源和设计门禁；不是恢复原 SDK 会话。重复或过期答复返回 409，接口失败不会在页面清空输入。若答复已保存但生成未启动，可从草稿明确点击生成用例，不重复回答旧问题。

兼容旧 `failed + NEEDS_INPUT` 记录：读取已授权详情时，按最近 `planning:generation` 时间至记录更新时间，在本项目本机 SDK 事件日志中有界查找 `ask_user`，只读恢复问题用于展示和答复；不改写原日志或自动迁移真实记录。最多检查 30 份、每份不超过 16 MiB 的事件文件，拒绝路径越界与符号链接。日志缺失、超限或未保存问题时不会虚构问题；需重新规划以取得新的确认请求。历史答复按输入约束和敏感信息规则处理，不要提交密码或令牌。每次规划最多保存 20 项确认，规划指令合计不超过 50000 字。

本功能含后端修改，需重新加载 API 才能生效。已有 MySQL 8 表若启用了旧 `testing_status` CHECK 约束，管理员应先审核并手动执行 [sql/mysql-testing-clarification-migration.sql](../sql/mysql-testing-clarification-migration.sql)，允许 `needs_input`，再重新加载 API。该升级脚本仅用于存在此 CHECK 的 MySQL 8 表，不适用于未安装表或 MySQL 5.7；MySQL 5.7 不执行 CHECK，新安装使用已更新的建表脚本。本次没有连接真实数据库、执行升级 SQL 或重启活动 API。

### 依赖与可信边界

显式安装动作使用固定 `@playwright/test@1.63.0`，核心参数为 `npm install --ignore-scripts --no-save --package-lock=false @playwright/test@1.63.0`，另指定目标工作区、npm registry、空 user/global 配置、临时 cache、`--no-audit --no-fund --bin-links=false`。这是需确认的网络安装，不是自动环境部署；也可能解析仓库现有依赖，并不能保证业务依赖已完整可用。没有本次实际安装证据。

安装前保存独立于依赖目录的 `sourceFingerprint` 并置 `installComplete=false`；只有安装成功、源码未变且本地工具可用才置 true。失败会在确认源码未变、依赖目录可安全清理后移除本次工作区的 node_modules，刷新工作区指纹并保留未完成状态。仅处于 awaiting_installation、无绑定/结果且源码指纹仍匹配时允许显式重试；残留 CLI 或部分依赖不能视为成功。源码变化或清理不安全会阻断，不会以刷新指纹掩盖变化。

必须另外准备所需业务依赖、浏览器及被测服务。不会自动下载 Chrome/浏览器、启动应用或外部服务、创建账号；runner 禁用配置中的 webServer 自动启动。独立 Playwright Test 不强制 `channel: 'chrome'`，生成器只返回 spec，临时配置也不补 Chrome channel；无显式 channel/executablePath 时使用 Playwright 对应浏览器缓存，已安装系统 Chrome 不代表默认浏览器已就绪。使用 Chrome 必须由可信测试源码/仓库配置显式选择并预先安装；隔离 Chrome fixture 通过不证明默认缓存可用。安装禁用 lifecycle scripts 不等于依赖或随后执行的源码安全。

runner 临时配置将根配置及各 project 的 testDir 指向批准文件所在目录，以精确文件匹配覆盖 testMatch、清空 testIgnore，避免原仓库发现规则漏掉新 spec；仍按绑定的文件、完整标题和 project 运行，不扩大为全仓测试。

previewUrl 仅接受本机 HTTP（localhost、127.0.0.1、[::1]），拒绝 HTTPS、凭据、query 和 fragment。完整规范化 URL（含子路径）通过 `CODEFLOW_BASE_URL` 传入，不再截成 origin；脚本须读取它或显式用作 baseURL。以 `/` 开头的导航仍会按 URL 规则回到站点根路径，需保留子路径时使用适当的相对路径和末尾斜杠。runner 不替脚本注入 baseURL，也不提供强制网络隔离：可信 Playwright 源码/配置能执行任意 Node 代码，不是 DSL 沙箱，不保证同源、凭据或秘密隔离。只能对可信仓库在无生产凭据的隔离环境运行。

## 存储、启动与恢复

- MySQL 需要额外一张 `codeflow_testing_records` 表，安装脚本是 [sql/mysql-testing-schema.sql](../sql/mysql-testing-schema.sql)。既有九张任务表不包含此表；缺表时 testing 模块不可用并返回 503，不表示旧任务模块失效。必须由用户单独批准、手动执行 SQL，再由用户重启 API 才重新初始化；若用户已完成这两步，无需重复执行。本次不核验实际库状态、不自动 DDL、不重启活动服务，也不为启用模块重置旧表。
- [server/index.ts](../server/index.ts) 在既有存储后初始化 testing。MySQL 模式额外创建连接池、读取结构元数据并恢复活动记录，因此“根启动绝不连接数据库”不符合源码。本文核对仅静态读取，没有运行根入口、连接真实库、执行 SQL、重启 API 或改动真实数据。
- testing 缺表/结构或权限失败只让 `/api/testing` 返回 503，不切换 JSON；既有 `/api/tasks` 在原存储健康时继续工作。恢复 testing 需管理员核对后手动安装表并重启，不应绕过校验。
- JSON 只能在用户明确选择/启动既有 JSON 后端时使用独立 testing 数据文件；当前后端由根任务存储配置决定，没有自动 MySQL 故障降级或专用 testing 模式切换。不要撤掉真实库配置来静默改写存储位置。
- testing 初始化在恢复记录前获取数据目录下 `testing/runtime.lock` 进程租约；JSON/MySQL 均使用，活跃 PID 拒绝第二实例，确认 PID 已退出且锁身份未变才回收陈旧锁，失败/关闭时只释放自己的租约。它防止重复进程先恢复别人的活动记录，不是跨主机分布式锁，也不支持多个 API 并行写同一目录。
- 单记录更新使用 expectedVersion CAS；JSON 临时文件 rename 原子替换，MySQL 条件更新防止过期版本覆盖。**不保证跨记录事务原子性**，进程租约也不能把项目和包写入变成一次事务。
- 正常发布先在项目保留包 ID，再创建不可变包，可显式重试发布以补齐同一保留 ID。外部导入将重审后的包快照与保留信息存入 completed 项目；重复导入相同内容时，可校验快照/指纹并幂等补齐缺失包，不再次调用模型。该查找只覆盖当前 owner 列表返回的前 200 条项目，不是全历史扫描；失败/未完成审查的项目不能据此补包，也不宣称跨记录原子提交或所有故障自动恢复。
- 列表每类最多 200 条，响应提供 `X-Result-Limit`，目前没有 cursor/后续页；页面搜索不能找回未加载的旧记录。已知 ID 可走详情读取，不等于完整历史分页。
- 取消先保存 cancelled 再中止活动模型/runner，晚到结果不应覆盖取消。启动恢复把活动规划/执行标为 interrupted，不自动恢复进程、重放命令、安装或测试；中断执行需新建批次。外部安装/进程副作用不能靠状态回滚撤销。

目录以 DATA_DIR（默认 data）为根：上传在 `testing/sources/<ownerId>/`，规划输入与可选参考快照在 `testing/planning/<projectId>/workspace/`，执行克隆与 `.codeflow-tests/` 在 `testing/executions/<executionId>/workspace/`；模型会话目录位于对应 workspace 的同级。JSON 记录使用 `testing/manifest.json` 及记录文件，MySQL 使用独立表，工作区和会话仍留本机。runner 的报告、截图/trace 等临时产物位于系统临时目录 `codeflow-playwright-*`，结束后尽力清理，记录/报告仅保留结构化结果，不提供这些原始文件的持久下载。`CODEFLOW_BASE_URL` 是显式运行环境输入；继承环境的过滤不等于秘密隔离，目录与会话应按敏感数据保护。

## 与旧任务的关系

旧 `/api/tasks`、CodingWorker 和任务自测/可信 Playwright 接线仍存在，属于 legacy adapter 路径，不是已完全切换到独立 planning/execution service。当前复用部分验收与 runner 基础能力，不等于共用完整编排核心；没有迁移真实旧任务、自动导入旧 passed 或改写真实记录。

任务详情已提供可选关联入口，通过 `POST /api/tasks/:id/testing-links` 保存当前用户的规划项目、用例包及执行批次引用；省略字段或 null 会清除相应关联。服务端核对所有者、空闲状态及同时提供的父子关系，只更新 testingLinks，不改变开发状态和测试结果。关联不是创建前提，不恢复编码会话、不迁移历史记录或旧 passed，更不表示 CodingWorker 已改走同一编排核心。

## 验证与限制

安装重试、runner testDir、URL 子路径/HTTP 校验、进程租约和导入补包已按当前源码更新，不再列为未修缺陷。仍需注意继承的平台 Origin 安全边界：[server/security/access.ts](../server/security/access.ts) 默认信任一段本机开发端口且接受缺失 Origin；不是精确单站点 CSRF 隔离，部署前需单独核对允许来源与防护。

本次仅核对源码及文档，不调用生产 API、真实模型、实际数据库或真实任务，不重启活动 API/应用。隔离本机 Chrome、模拟 API、fixture 等证据不能替代真实模型、OAuth、目标仓库或被测业务端到端验证；最终测试统计与产物由主流程汇总，此处不硬编码数量。

## 隔离验证记录

2026-10-20 合并验证：`npm run build` 通过，编辑器无诊断；`node --import tsx --test server/testing/execution-service.test.ts` 正常汇总 37/37，通过临时 Git、假模型和实际 Playwright/Chrome 验证独立执行链与可选失败门禁；`node --import tsx --test server/verification/playwright-test.test.ts` 正常汇总 15/15，包含准确文件发现、完整 URL 路径和取消进程树。

`server/tests/ui/testing-workspace.test.ts` 的 SSR 与模拟 API 浏览器回归 2/2，通过 1440、1367、390、320px 的展开菜单、键盘、边界、错误重试、源码审批、202 轮询及新批次创建。任务关联与相邻旧 UI/存储定向回归 43/43。它们不是实际模型、实际数据库或业务目标的验收。全量回归最终结论由运行结束统计单独确认，不将中间输出计为全量通过。

## 验收清单

方括号只在取得证据后勾选；填写命令/日期/隔离环境/产物路径，不填 token、Cookie 或数据库密码。不以历史测试统计冒充本次结果。

- [ ] 独立入口无编码前置；同源登录/过期、owner 隔离、Origin 拒绝。证据：`待填`。
- [ ] 规划、发布版本与来源变更失效；外部包重审，不继承通过标志。证据：`待填`。
- [ ] default/custom 范围、设计阻断/提示及实际必验结果分别验证。证据：`待填`。
- [ ] 新 spec JSON、显式固定版本安装、源码人工审批、完整断言及拒绝过期指纹。证据：`待填`。
- [ ] 取消晚到结果、重启 interrupted/不重放、CAS 冲突及包保留失败恢复。证据：`待填`。
- [ ] 隔离 MySQL 缺表仅 testing 503、旧接口可用、无自动 DDL/JSON fallback；真实库安装单独审批。证据：`待填`。
- [ ] 列表 200 限制、报告与 runtime 不污染定义指纹；扩展菜单/移动端按项目规则检查。证据：`待填`。
- [ ] 安装失败重试/源码变化阻断、准确 testDir、HTTP 子路径、进程租约及前 200 条导入恢复边界。证据：`由主流程汇总`。
- [ ] 真实 SDK、远程数据库和目标应用端到端验收均单独授权。证据：`待填，本次未运行`。
