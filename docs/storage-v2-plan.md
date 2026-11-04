# 存储拆表落地方案 V2

状态：用户已确认；代码、SQL 与离线验证已实施，实际 MySQL 5.7 结构检查及合成持久化烟测通过；隔离 MySQL 8 DDL 验收和实际切换未完成。更新日期：2026-10-16。

本文保留实施契约并记录交付状态。用户暂停 `dev:api` 后，实际 `5.7.35-log` 上的 `npm run db:check` 通过，包含严格 V2 字段、索引、外键及命名锁检查；此前版本拒绝和锁阻塞已被本次成功检查取代。`npm run db:smoke -- --execute` 通过，合成任务 `c8860bf0-5e05-47ae-a22d-03d1b1c39ea5` 写入 usage 3、files 1、runs 1、snapshots 1、cases 1、artifacts 1、events 2、task 1，共 11 行；重连后精确核对 Unicode、字段/数组顺序、日期及引用，验证真实乐观版本过期拒绝、SQL 前校验及注入后期子表失败的事务回滚。结果 `cleaned: true`，该任务 UUID 的全部行已移除，既有任务未改动。

本次未执行 DDL、清库、回填、真实模型、浏览器、Git 或文件操作，未重启 API。files 仅为合成元数据，没有真实文件资产；证据来自真实 DB 的 repository/storage 路径，不是浏览器/API/OAuth 端到端验收。当前 V2 表无需迁移或 DDL；隔离 MySQL 8 DDL、最小权限、断线及备份恢复验收仍未完成。

## 1. 范围与决策

- 当前为本地测试阶段，用户负责清除历史业务数据；不编写历史数据迁移/双写/兼容读取旧 payload 的逻辑。
- 运行时支持 MySQL 5.7.35+ 或 8.0.16+，不支持 MariaDB；沿用 mysql2、UTC、utf8mb4、参数化 SQL、证书校验及数据库单实例锁。本期不开放多后台实例。MySQL 8.4 LTS 升级仅作为未来规划建议，不是当前使用前提。
- 任务低频配置保留 JSON，高频及无限增长的集合拆为独立行；不把所有业务属性机械转换成列。
- 数据库成为 MySQL 模式的权威数据源。只缓存正在工作的任务，列表走 SQL，历史日志/产物/执行按需分页；禁止启动全量加载历史。
- 保留 JSON 本地开发适配器，使用同一仓储契约和运行时校验，不承诺 JSON 模式具有 MySQL 的容量及查询能力。两模式不自动互相导入。
- 本次不调整模型、提示内容/顺序、附件顺序、批次大小、会话隔离/恢复方式或质量门禁；不为了缓存而隐藏必要业务变化。
- SDK 完整会话仍由 CLI 管理在 DATA_DIR，不导入 MySQL。原文、仓库和截图继续本地存储，本期建立文件元数据，不接入对象存储。

兼容边界：5.7 仍严格核对列、索引和外键，SQL CHECK 被解析但忽略，由应用执行等价业务校验；绕过应用直接写 SQL 不受这些 CHECK 保护。8.0.16+ 另检查 CHECK 名称及启用状态，不比对表达式。运行时共享读锁使用 `LOCK IN SHARE MODE`；此次改造不改变 SQL 表结构。实际 5.7 合成持久化烟测通过不等于所有数据库或端到端验收完成。

### 需求编号

| ID | 验收目标 |
| --- | --- |
| REQ-001 | 新库结构，不回填旧任务，非空旧库禁止直接切换 |
| REQ-002 | 高频集合拆表，一条事件不重写其他任务/历史产物 |
| REQ-003 | 按任务事务、修订并发检查、有限写队列和失败关闭 |
| REQ-004 | 运行时契约校验、版本标记和受控 schema 升级 |
| REQ-005 | 列表摘要、详情按需加载、历史分页和归属校验 |
| REQ-006 | 存储切换不改变 AI 输入及 SDK 会话行为 |
| REQ-007 | AI 用量可观测，区分服务端缓存和平台产物复用 |
| REQ-008 | 文件关联、增长限制、清理及数据库/文件备份边界 |
| REQ-009 | JSON 适配器及自测恢复/质量门禁行为不回退 |

## 2. 数据模型

下列字段为实施清单；确认后再生成完整可执行 SQL。所有业务表使用 InnoDB。UUID 为 VARCHAR(64) ASCII/BINARY，SHA256 为 CHAR(64) ASCII/BINARY，序号/修订为 BIGINT UNSIGNED，时间 DATETIME(3) UTC。业务 JSON 必须校验，不允许仅靠 TypeScript 断言。

### 2.1 codeflow_schema：沿用版本表

- 字段沿用 version、installed_at；新结构版本为 2。
- 最后一步才写 version=2。V2 应用只接受 V2；旧应用只接受 V1，错误版本拒绝启动。
- schema 版本表示数据库结构；JSON body_version 表示内容格式；prompt 版本另行管理，三者不混用。

### 2.2 codeflow_tasks：任务主表，替换旧表结构

- id PK、owner_id BIGINT UNSIGNED NULL、status VARCHAR(32) ASCII/BINARY NOT NULL。
- created_at、updated_at NOT NULL；row_version NOT NULL DEFAULT 1。
- body_version SMALLINT UNSIGNED NOT NULL；state JSON NOT NULL。
- next_event_seq、next_case_ordinal、next_run_seq、next_snapshot_seq NOT NULL DEFAULT 1，用于事务内分配单调序号。
- 索引：(owner_id, created_at, id)、(status, updated_at, id)。
- state 保存 repository、instruction、prdName/designNames、workspace、分支、发布当前状态、模型选择、编码会话引用、当前问答/已确认决策、最新检查、当前验收选择、当前基线/评审/执行计划的快照或产物引用、当前规划/错误/草稿状态。
- state 不保存 entries、selfTestArtifacts、selfTests、automationRuns、acceptanceHistory、acceptanceSelectionHistory、modelHistory 等历史集合。模型变更作为事件，验收选择及历史作为快照。
- status/owner/时间/row_version 以列为准，禁止在 state 保存同名权威副本。保留可选字段缺失与 null 的语义差异。
- state 的当前报告仅保存小型当前结果或引用，不嵌套历史快照。已确认决策仍是 AI 所需完整输入，达到上限时阻止追加并提示，不静默裁剪。

### 2.3 codeflow_task_events：追加式日志/状态审计

- task_id FK -> tasks、seq；联合 PK(task_id, seq)。
- created_at、kind VARCHAR(24)、stage VARCHAR(32) NULL、turn_id VARCHAR(64) NULL、tool_call_id VARCHAR(128) NULL、body_version、body JSON。
- body 保存现有 text/detail/toolEvent/turnEvent 等原有语义，不填入新生成的无关元数据到 AI 恢复摘要。
- 索引：(task_id, turn_id, seq)、(task_id, created_at, seq)。默认按 seq 游标分页，不 OFFSET 扫描。
- 原有每条 text/detail 长度限制保持不变；前端默认显示最近 1000 条，数据库可以保留更多，由明确清理策略管理。

### 2.4 codeflow_self_test_artifacts：一产物一行

- id PK、task_id FK、phase VARCHAR(16)、scope TEXT、scope_hash CHAR(64)、revision、status VARCHAR(16)。
- input_fingerprint CHAR(64)、rules_version VARCHAR(64)、model VARCHAR(128)、session_id VARCHAR(128) NULL。
- created_at、finished_at NULL、body_version、output JSON NULL、error TEXT NULL、input_refs JSON NOT NULL。
- UNIQUE(task_id, phase, scope_hash, revision)；查询索引：(task_id, phase, scope_hash, input_fingerprint, status, revision)。
- scope 可能包含大量用例 ID，不直接使用长字符串作唯一键；scope_hash 来自完整 scope，读取时核对原文。
- input_refs 保存带类型的有序引用：artifact / content_fingerprint / workspace_fingerprint。只有 artifact 引用校验同任务存在，不将哈希误当外键。组装旧内部契约时还原原始 inputRefs 顺序。
- 运行中允许绑定 session_id；finish 使用 WHERE status='running' 条件更新，结束后输出不可改写。同范围重试创建新修订。
- 运行时校验约束 running/complete/failed/blocked，8.0.16+ 另由状态 CHECK 约束，5.7 不执行 CHECK；结束不等于合格，blocked 与拒绝结果不能绕过执行门禁。

### 2.5 codeflow_test_cases：当前用例定义

- task_id FK、case_id VARCHAR(64) ASCII/BINARY；联合 PK(task_id, case_id)。
- ordinal、definition_revision、definition_fingerprint CHAR(64)、body_version、definition JSON、created_at、updated_at。
- UNIQUE(task_id, ordinal)，严格保留原数组顺序，不按 case_id 字符串重新排序。
- definition 只保存 title/source/steps/expected/testFile/requirementIds/scenario/preconditions/testData/assertions/cleanup/classification 等定义，不存执行状态和输出。
- 仅定义改变才更新此行并递增 definition_revision；初始 pending 等状态通过兼容投影计算，执行状态来自执行记录。
- 旧定义历史由已结束的生成产物和验收快照承载，不另建每字段历史表。

### 2.6 codeflow_case_runs：一用例一次执行尝试

- id PK、task_id、case_id、run_seq、definition_revision、input_fingerprint CHAR(64) NULL。
- execution_plan_id VARCHAR(64) NULL、review_artifact_id VARCHAR(64) NULL、executor VARCHAR(24)、status VARCHAR(24)、started_at NULL、finished_at NULL、body_version、body JSON。
- FK(task_id, case_id) -> test_cases；review_artifact_id 使用同任务校验，保留尚无绑定指纹的兼容状态语义但新测试数据必须生成有效绑定。
- UNIQUE(task_id, case_id, run_seq)；索引：(task_id, case_id, run_seq)、(task_id, status, run_seq)。
- body 保存本次 output、browser script、failureKind、截图文件引用和原有时序信息，单文件/browser/manual/blocked 都能明确表示，不把生成脚本当作执行通过。
- 未执行用例不伪造执行记录；当前 UI 用例状态由定义+最新相关尝试投影，保留原有 manual/invalid/skipped 语义。
- 重跑插入新行，不覆写旧证据。断点续跑只更新同一未结束尝试，必须校验输入指纹和状态。

### 2.7 codeflow_acceptance_snapshots：基线/评审/计划/选择快照

- id PK、task_id FK、seq、kind VARCHAR(32)、created_at、input_fingerprint CHAR(64) NULL、body_version、body JSON。
- UNIQUE(task_id, seq)；索引：(task_id, kind, seq)。
- kind：baseline / default_review / scoped_review / execution_plan / selection / acceptance_history。
- 保存当前接口原有 baseline、assessment、caseIds、计划、理由及确认时间等精确结构；历史快照只追加。
- 中途批次的聚合快照也可保存 rejected+未完成；主表当前引用与该快照在同一事务推进。
- 自测产物是模型工作输出，快照是业务验收状态；两者明确引用，不能互相当作合格标志。execution_plan_id 指向 kind=execution_plan 的同任务快照。

### 2.8 codeflow_task_files：文件元数据，不保存二进制

- id PK、task_id FK、kind VARCHAR(24)、storage_key VARCHAR(512)、storage_key_hash CHAR(64)、sha256 CHAR(64) NULL、size_bytes BIGINT UNSIGNED NULL、created_at、body_version、metadata JSON。
- UNIQUE(task_id, storage_key_hash)，读取时验证原 key；kind 表示 prd/design/evidence/test/session_manifest。
- storage_key 使用相对 DATA_DIR 的受控键，拒绝越界和非预期链接；SDK 会话目录仅登记目录/清单信息，不声称一个静态哈希能认证持续写入的整个目录。
- 截图和原文可记录内容摘要；SDK 文件格式保持运行时原样，不重写历史、不改变 SDK 使用的实际路径。
- 文件和数据库无法跨系统原子提交：先临时写文件、原子落位，再提交元数据；失败留下的孤儿可识别，清理只在无活动任务且过宽限期后执行。

### 2.9 codeflow_model_usage：缓存与用量观测

- id PK、task_id FK、turn_id VARCHAR(64)、session_id VARCHAR(128)、artifact_id VARCHAR(64) NULL、model VARCHAR(128)、phase VARCHAR(24)、source_event_id VARCHAR(128)、observed_at、body_version、body JSON。
- UNIQUE(task_id, session_id, source_event_id) 去重；索引：(task_id, turn_id)、(model, observed_at)。
- body 保存 SDK 原始可用的 input/output/cacheRead/cacheWrite/reasoning/cost 等指标和计数口径。缺失保存缺失，不补 0、不直接套用直连供应商价格。
- 同一会话的累计 shutdown 和逐请求 usage 不能相加；选定一套权威聚合口径，原始观察可留存但必须标明累计/增量。
- 产物复用次数由平台独立统计，不与服务端缓存命中混为一谈。回调不得改变 prompt 或触发额外模型请求。

## 3. 写入与并发契约

1. 将 TaskPersistence.save(allTasks) 改为任务级 repository/unit-of-work：createTask、patchState(expectedVersion)、appendEvents、insert/finalizeArtifact、upsertCaseDefinitions、start/finishCaseRun、appendSnapshot、recordFiles、recordUsage。
2. 当前单进程按任务串行写入；不同任务允许独立事务。事务内锁定任务行分配序号，UPDATE tasks WHERE id=? AND row_version=?，影响行数不是 1 则回滚并报告冲突，不静默覆盖或自动重放模型/外部命令。
3. 产物完成、对应定义/验收快照和主表当前引用在同一事务提交。独立日志事件只追加自身并轻量更新必要主表元数据，不重写所有用例、所有产物或其他任务。
4. 以已提交对象作为内存权威快照。未提交变更不向 API 返回成功；失败时使任务缓存失效，保留现有存储故障关闭行为。禁止通过 get() 返回可直接污染权威缓存的共享对象。
5. SDK 开始请求、批次切换、外部测试、发布确认前后的原落库屏障保留；外部副作用不能靠数据库事务回滚，重启仅标中断，不自动重放。
6. 写队列有界，初始上限 200 个待提交操作或 16 MiB 待提交数据，先达到者生效；入口过载返回 503。已开始的关键检查点等待容量或明确失败，不能丢弃；仅 modelTurn 的高频展示进度可短窗合并，起止、问答、产物和审计事件不得合并丢失。
7. 保留命名锁防止旧/新实例并行。任务 row_version 是防覆盖检查，不宣称已实现分布式调度、多实例租约或恰好一次执行。

## 4. 读取与接口

- 启动只读取必要任务摘要及需标中断的活动任务；SQL 条件更新中断状态/运行记录，不反序列化全部历史。
- 列表 SQL 按 owner/status 游标分页；详情仅按 task_id 加载当前 state、用例和最新执行/验收投影，不默认带产物全文、全部历史及 usage。
- worker 开始时加载该任务必需状态，退出后释放完整缓存；产物复用通过参数化 SQL 按 phase/scope_hash/fingerprint/status 查询。
- 新增 events/artifacts/runs/snapshots 的游标查询端点，均先校验任务归属；客户端分页适配与接口调整同时交付，不用旧全量接口兜底绕回内存扫描。
- task-summary 当前会展开整个任务；改为显式 DTO 白名单。浏览器 script/原始产物仅专门详情返回，默认 UI 不改变可见内容和操作语义。
- 相关改造入口：server/tasks/store.ts、server/storage/database.ts、server/storage/storage-runtime.ts、server/tasks/task-summary.ts、server/index.ts、src/features/coding/CodingWorkspace.tsx；所有调用点按类型错误及测试逐项接入。

### 4.1 当前核心实现的分页契约

- `queryTasks` 返回共享 `TaskListProjection` 的 `hasWorkspace/caseCount/automationCount/runnable/runs` 和 `automationUrl`；`runs` 只有 caseId/title/status。MySQL 仅为当前页 ID 查询用例标题、当前定义修订和最新执行状态，不读取脚本、执行输出、事件或产物正文。`runnable` 与 API 摘要函数一致，旧定义修订的测试结果视为当前用例尚未执行。
- MySQL 任务列表按 `(created_at DESC, id DESC)` 排序，游标是服务端生成的 base64url `{at,id}`，下一页严格小于该二元组。JSON 开发模式使用最后一个任务 ID；游标只可原样传回同一存储模式，不跨模式复用。
- `history(..., 'events')` 首次不传 cursor，读取最新 limit 条；SQL 使用 `seq DESC` 选页，响应 `items` 按 seq 升序排列，便于直接显示。`nextCursor` 是已选页最旧事件的序号，下一请求取 `seq < cursor`，返回项应拼接到既有记录之前。JSON 使用同样的 1-based、排他上界语义。
- 例如事件序号 1..7、limit=3，依次返回 `[5,6,7] / cursor=5`、`[2,3,4] / cursor=2`、`[1] / 无游标`。翻页期间追加事件不挤入旧页；刷新最新页需不传游标。这是向旧读取，不是从 cursor 拉取新事件。
- events cursor 只接受正的安全整数十进制字符串，拒绝 0、小数、指数和 SQL 片段。无 `nextCursor` 表示当前方向已到底；空结果不返回游标。
- 此方向调整仅适用于 events。MySQL runs/snapshots 仍按正向序号翻页；artifacts 按 `(created_at,id)` 正向翻页。JSON 其他历史集合仍使用正向数组位置游标。各端点游标不互换；单页 limit 范围 1..1000。

### 4.2 核心审计边界与待验证项

- MySQL 启动仅选择活动任务；仅中断未结束的当前 run，不读取终态 run 正文。列表不走 `TaskStore.list()`、不全库克隆；JSON 列表先筛页再投影。公共任务读取（包括 warm-cache `loadTask`）返回隔离对象。
- 差量以原未完成尝试的开始时间/输入指纹核对身份，同时校验定义修订、计划及评审绑定；执行器返回的新时间和终态证据指纹可更新同次尝试，新重试插入新行。更新失败回滚。`continuation`/`continuationFrom` 是仓储元数据，不进入模型输入。
- `storedJson/decode` 保持原始 JSON 对象字段顺序与数组顺序；元数据不包裹顶层数组。`input_refs` 为有序 typed-reference 数组，`output` 保持对象（缺失写 SQL NULL）；事件、state、定义、run、快照、文件 metadata、usage 及重启中断写入均走同一编码。编码先遵循标准 JSON 的 Date/toJSON、undefined/null 语义，再添加字段顺序元数据；大小限制含元数据开销。
- 现有领域 `inputRefs: string[]` 没有区分 workspace/content 哈希的信息；写入时已存在的同任务 ID 标记 artifact，其余合法 SHA-256 标记 content_fingerprint，不猜测 workspace 类型。读取接受 workspace_fingerprint 并还原原始字符串与顺序，但不承诺 typed kind 经领域对象重写后仍保留。
- GET/HEAD 详情及历史归属检查使用 `readTask`，不读取产物正文、全量模型变更历史或验收历史；用例定义/最新 run 在 SQL 中按当前 ID 限定。工作器与变更请求仍使用完整 `loadTask`，读取非请求 scope 的最新/最新完成产物和模型变更历史；生成请求历史只载最近 32 个 scope，旧产物由精确指纹查询复用。因此不把执行加载描述为完全无历史扫描。当前基线/评审/计划对象仍保留在 state，同时写独立快照，不是纯引用状态。
- JSON/旧 fake 仍需保留并重写整个文件/全任务快照，不能作为 MySQL 容量保证。实际 5.7 已通过严格结构/命名锁检查、合成数据重连往返、乐观版本冲突、SQL 前校验及注入后期子表失败回滚；不据此声称已完成隔离 MySQL 8 的 DDL/约束行为验收。mock SQL 与 schema 静态测试不替代真实数据库证据。隔离 DDL 自动化测试不连接实际业务库；本次未在实际库运行 DDL、未重启实际 API，完整实测范围见本文开头。

## 5. AI 输入稳定性硬约束

- 在拆表前，为编码、原会话继续、明确授权的恢复摘要、基线、生成、修正、默认/自定义评审、浏览器规划及格式修正建立固定样本；通过假 SDK 捕获 send 参数及 create/resume 行为，不调用真实模型。
- 将当前 prompt 构造提取成纯函数和显式 Prompt DTO，先证明重构前后 prompt 字符串完全相等，再接数据库映射。已有 JSON.stringify 的字段顺序、数组顺序、缺失/null、状态/输出字段均按原契约还原，不顺便清理。
- 验收对比 prompt UTF-8 字节、附件 type/path/displayName 与顺序、模型和会话配置。测试在相同路径/固定时钟下进行，避免随机值造成误报；不把新行号、修订号、时间、数据库键或 usage 加入提示。
- 数据库内部可改变结构，但不得自动排序基线/用例/已确认问答，或将 SDK 原会话替换为数据库拼接的全量消息。
- SDK 的 baseDirectory、sessionId、恢复选项 continuePendingWork:false 和独立短会话边界保持原样。数据库删除不意味着 SDK 自动删历史。
- 原文/代码/用户决策确实变化时，仍按现有规则使产物失效；数据库 row_version 等纯存储变化不得进入业务输入指纹。
- 本期不调整固定段落/动态段落顺序，不添加 cache key/breakpoint 等未经当前 SDK 路径验证的参数。提示缓存优化单独决策。
- 上述测试保证应用显式输入不因迁移改变，不保证 Copilot 隐式上下文、远端缓存路由和实际命中率完全不变。

## 6. 校验、容量与保留

- 引入独立的持久化运行时 schema（建议 Zod），校验任务状态、各 phase/kind 输出、关联任务、指纹、修订、可选属性及合法状态转换。schema 约束数据库 DTO，不混入模型提示。
- state JSON 默认最多 1 MiB，单产物/快照/执行 body 默认最多 4 MiB；上限可配置并在序列化后按 UTF-8 计量。超限明确拒绝，不静默截断原文、决策或证据；与 max_allowed_packet 实测对齐。
- JSON 本地模式使用同样的业务大小/队列限制；所有超过阈值的情况带安全错误和指标，不打印凭据/完整敏感响应。
- 默认不自动删除已完成证据。交付只读容量报告（表行数/字节、最大 body、任务体积、文件缺失/孤儿）以及带 dry-run 的手动清理命令；活动任务禁止清理。
- 清理以任务为单位、显式确认并核对任务状态。数据库外键拒绝随意破坏引用；删除由维护命令按子表到主表顺序完成，不依赖清理全库的 CASCADE。
- 备份说明覆盖数据库、uploads/evidence/sessions/workspaces；先停写或停止后台生成一致备份，并执行一次独立目录恢复演练。不宣称仅数据库备份即可恢复 SDK 会话。

## 7. 实施步骤和任务

### P1：冻结契约与新结构 [REQ-001/004/006]

- [x] T001 [Plan:P1] 提取 prompt 构造和固定样本；生成提示 2592 种组合逐字对比，worker 编码/恢复/基线/评审/浏览器请求另有假 SDK golden 测试。
- [x] T002 [Plan:P1] server/storage/contracts.ts 定义数据库 DTO、运行时 schema 和字段顺序还原；未引入新依赖。
- [x] T003 [Plan:P1] 提供 V2 新库 SQL 与空 V1 切换 SQL；静态测试通过，真实 DDL 执行归 T011。

### P2：仓储和写入生命周期 [REQ-002/003/004/009]

- [x] T004 [Plan:P2] V2 按任务事务、版本和子表差量写入；去掉 MySQL 全库字符串缓存。
- [x] T005 [Plan:P2] 隔离 working/committed 对象，有界队列和 JSON 适配器；过载在修改前拒绝。
- [x] T006 [Plan:P2] 工作器接入文件/用量记录、精确产物查找、真实修订与聚合实际证据引用；恢复和超时不重发回归通过。

### P3：查询和观测 [REQ-005/007/008]

- [x] T007 [Plan:P3] 启动活动恢复、列表/历史 SQL 游标、摘要白名单及归属校验；GET/HEAD 轻量详情与完整执行加载分开，冷读取不填工作器缓存，当前定义/run 在 SQL 限定。
- [x] T008 [Plan:P3] 列表、所选详情和事件分页分开；迟到响应、跨任务归属和四视口展开菜单回归通过。
- [x] T009 [Plan:P3] SDK 用量累计/增量去重和平台评审批次复用分开记录；不追加模型调用。
- [x] T010 [Plan:P3] 容量/文件只读检查、明确 taskId 的 dry-run 删除、工作器文件登记和备份手册已交付；没有自动文件删除。

### P4：验证和切换 [REQ-001 至 REQ-009]

- [ ] T011 [Plan:P4] 在隔离 MySQL 8 测试库运行真实 DDL/事务/外键/唯一约束/版本冲突/中文/报文上限测试；凭据直接由用户注入环境，不通过聊天传递，禁止使用实际业务库测试。
- [x] T012 [Plan:P4] 假 SQL/仓储测试验证单事件差量写入、启动活动范围、分页和过载；另有实际 5.7 合成持久化烟测证据，范围见本文开头，不替代 T011 的隔离 DDL 验收。
- [x] T013 [Plan:P4] 完整串行测试、构建和隔离 UI 回归已运行；提示逐字样本、恢复及模型调用次数约束通过；见最新交付结果。
- [x] T014 [Plan:P4] schema 字段/引擎/索引/外键启动检查、用户 SQL 清单和操作手册已更新。

2026-10-15 代码交付验证记录（非此次兼容改造的最新测试总数）：`npm test` 272 项，271 通过、0 失败、1 项真实 MySQL 集成测试跳过；`npm run build` 通过，编辑器无诊断错误。串行测试包含隔离 UI 和四视口展开菜单回归。

2026-10-16 最新补充：实际 `5.7.35-log` 的 `db:check` 和 `db:smoke -- --execute` 通过，合成写入、重连精确还原、版本过期拒绝、SQL 前校验、注入后期子表失败回滚及默认清理均已验证。`npm run build` 通过，编辑器无诊断；完整测试统计由主流程记录，不将上方历史数字冒充最新总数。

尚未完成：T011 的真实隔离 MySQL 8.0.16+ DDL 验收、最小权限、断线、报文上限、备份恢复演练及用户实际切换；本次未运行启用后的隔离 DDL runner。不能以这些复选框或合成烟测替代剩余验收，也未执行任何实际清库。其余明确边界见 4.2 节；8.0.16+ 启动 CHECK 校验仅验证约束存在且启用，不比对表达式等价性；5.7 依赖应用等价校验。

`npm run test:mysql-v2` 保持为独立的 MySQL 8.0.16+ 空隔离库 DDL 套件，会建表、写入、重置和清理，绝不能指向当前实际 5.7 库。无 DDL 的 `npm run db:smoke` 为不加载环境文件、不连接数据库的 dry-run；`npm run db:smoke -- --execute` 写入自动生成 ID 的合成数据并默认清理；`npm run db:smoke -- --execute --keep` 保留该次生成的合成行。执行须停止 API 及同库写入者并取得共用命名锁，不操作既有任务或真实文件资产。操作说明见 [docs/mysql-test-database.md](mysql-test-database.md)。

## 8. 用户操作顺序与回退

1. 用户确认本方案后，助手实现代码、V2 SQL 和验证；实施期间不自行清除当前数据或重启实际服务。
2. 最终交付列出可执行 SQL、预期表结构、测试结果和剩余限制，再安排切换；不要提前用 V1 应用连接 V2 空库写任务。
3. 用户停止 API 及任何同库写入进程，确认无活动模型/测试操作，按需要备份。当前已存在九张 V2 表，不需要清库、迁移或 DDL。仅历史 V1 切换才由用户另行批准清除旧 codeflow_tasks 的数据；不能只删 SDK 目录就认为数据库已清空。
4. 仅空 V1 库执行交付的 V1->V2 脚本；脚本先检查旧表为空，再替换空的旧任务表并新建子表，最后登记 schema=2。fresh install 则执行新版建表脚本。当前已有 V2 表跳过此步，不重跑脚本。不自动删除 uploads/sessions/workspaces。
5. 运行新版 npm run db:check，检查 schema/字段/索引/外键/锁；该命令不写真实任务，不创建或修复表。旧结构或部分建表必须明确报错。
6. API 仍停止时可运行 `npm run db:smoke -- --execute`，核对合成数据往返及默认清理结果；本次已通过，未重启 API。之后由用户明确安排启动新版后台，确认 health.storage=mysql 并触发新的 API/浏览器烟测任务。用量采集不额外发请求，真实模型烟测由用户明确触发；repository/storage 烟测不替代此步。
7. 若失败先停止新版。空库 DDL 重建可按修复手册执行；不能把 schema 版本手工改回 1 冒充回滚。回旧版必须恢复完整 V1 表结构/备份并使用匹配旧程序；V2 新数据不反向迁移，清除须用户再次明确确认。

## 9. 完成标准

- 9 张表（schema + 8 张业务表）在隔离 MySQL 可从空库创建，V1 非空库不会被脚本误清。
- 一条日志不触发任何其他任务和历史大 JSON 写入；任务列表、启动、产物查找不依赖全量历史内存对象。
- 用例/执行/验收/产物引用可追溯，重启/落库失败保持保守门禁，未完成/拒绝缓存不能变成通过。
- 运行时 schema/版本/并发冲突/容量/队列/文件故障都有自动化证据；JSON 开发模式和现有前端交互不回退。
- AI 显式输入固定样本逐字一致，create/resume/send 次数与既定会话策略一致；不声称能保证供应商缓存命中率。
- 不满足真实 MySQL 验证时标记未完成，不用 mock 测试替代数据库证据。无可用隔离库时仅交付代码和明确待验证项，不切换实际库。

## 10. 需求映射

| REQ | 计划 | 验证证据 |
| --- | --- | --- |
| REQ-001 | P1/P4 | 空库 DDL、非空拒绝、schema=2 检查 |
| REQ-002 | P2/P4 | SQL 操作断言、单任务写入及大历史场景 |
| REQ-003 | P2/P4 | 事务回滚、row_version 冲突、队列过载 |
| REQ-004 | P1/P2/P4 | DTO 运行时 schema、错误版本/坏数据测试 |
| REQ-005 | P3/P4 | SQL 分页、归属、摘要白名单和 UI 回归 |
| REQ-006 | P1/P2/P4 | prompt 字节/附件顺序/SDK create-resume-send 固定样本 |
| REQ-007 | P3/P4 | usage 去重/累计口径/无额外调用测试 |
| REQ-008 | P3/P4 | 容量、dry-run、文件失联、备份恢复演练 |
| REQ-009 | P2/P4 | JSON 仓储契约、完整自测与恢复回归 |

确认范围：上述 8 张业务表、MySQL 仓储/读写接口调整、必要前端分页适配、JSON 开发适配、AI 输入冻结和用量观测。不含历史回填、多实例调度、对象存储和提示缓存策略优化。