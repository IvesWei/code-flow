# MySQL / Schema 2 运维

运行时支持 MySQL 5.7.35+ 或 8.0.16+，不支持 MariaDB；使用 InnoDB、UTC、utf8mb4。当前已有九张 V2 表无需为此次兼容改造迁移或执行 DDL。实际库结构检查及合成数据读写烟测已通过，范围见下文；隔离 MySQL 8 DDL、最小权限、断线及备份恢复验收仍待完成，mock 测试不能代替这些证据。破坏性集成测试不得用于实际业务库。

2026-10-16 实测记录：用户暂停 `dev:api` 后，实际 `5.7.35-log` 上的 `npm run db:check` 通过，完成严格 V2 字段、索引、外键和命名锁检查。此前的版本拒绝与另一实例锁阻塞属于已被本次成功检查取代的历史结果。`npm run db:smoke -- --execute` 通过，任务 ID 为 `c8860bf0-5e05-47ae-a22d-03d1b1c39ea5`；usage 3、files 1、runs 1、snapshots 1、cases 1、artifacts 1、events 2、task 1，共 11 行。重连后精确核对 Unicode、字段/数组顺序、日期及引用；真实乐观版本过期拒绝、SQL 前校验和注入后期子表失败的事务回滚均已验证。结果为 `cleaned: true`，该任务 UUID 的全部行已移除，既有任务未改动。

本次未执行 DDL、真实模型、浏览器、Git 或文件操作，未重启 API。files 行仅为合成文件元数据，没有创建或验证真实文件资产；烟测通过真实数据库验证 repository/storage 路径，不是浏览器/API/OAuth 端到端验收。`npm run build` 通过，编辑器无诊断；完整测试统计由主流程记录。MySQL 8.4 LTS 升级保留为未来规划建议，不要求用户先升级才能使用当前运行时。

### 兼容边界

5.7 路径仍严格检查列、索引和外键；不查询不存在的索引可见性字段，也不要求 CHECK 启用元数据。SQL 脚本中的 CHECK 在 5.7 中被解析但忽略，由应用执行等价业务校验；绕过应用直接写 SQL 不受这些 CHECK 保护，不能认为安全。8.0.16+ 执行数据库 CHECK，启动另检查预期名称及启用状态，但不比对表达式。运行时共享读锁统一使用 `LOCK IN SHARE MODE`。版本支持不等于已完成目标实际库的读写、权限或恢复验收。

## 1. 创建数据库与表

使用具备建库权限的管理账号，先执行 [sql/mysql-create-database.sql](../sql/mysql-create-database.sql)，再在同一个连接中执行 [sql/mysql-schema.sql](../sql/mysql-schema.sql)。若使用不同连接，先选中 `codeflow_test` 或执行 `USE codeflow_test;`。后台 `DB_NAME` 必须为同一个库名；若改库名，需要同步修改创建脚本内的全部 `codeflow_test` 引用。

创建脚本统一使用 `utf8mb4` 字符集及更通用的 `utf8mb4_unicode_ci` 排序规则，与任务表一致，支持中文和 emoji。该排序规则不区分大小写与重音，适合一般文本；任务 ID 与状态列仍显式使用 `ascii_bin` 精确比较，JSON payload 的内容不会被排序规则修改。脚本面向 MySQL 5.7.35+ 或 8.0.16+，不支持 MariaDB；5.7 的 CHECK 限制见上文。以下建库/建表步骤只用于新空库或符合条件的空 V1 库，不要在当前已有 V2 表的实际库重跑。

建库脚本可重复执行，`ALTER DATABASE` 只校正库默认字符集，不转换已有表。V2 建表脚本不是幂等修复脚本：存在任何 CodeFlow 表即拒绝。空 V1 库使用 [sql/mysql-reset-v1-to-v2.sql](../sql/mysql-reset-v1-to-v2.sql)，它检查旧列、版本、任务为空且无 V2 子表；非空 V1 直接拒绝，不迁移、不清理业务数据。历史数据处置由用户单独审批，本维护命令不支持 V1。

先停止 API、SDK/测试子进程和所有同库写入者，保存匹配程序版本的完整备份。以下命令供用户执行；`--login-path` 是用户预先配置的受保护客户端登录配置名，不能把密码写进命令、SQL 或聊天。客户端须支持 `DELIMITER`，不使用 `--force`，遇到错误立即停止。

```powershell
# 新空库
mysql --login-path=codeflow-admin --execute="source sql/mysql-create-database.sql"
mysql --login-path=codeflow-admin codeflow_test --execute="source sql/mysql-schema.sql"
# 或仅对已有、业务数据为空的 V1 库
mysql --login-path=codeflow-admin codeflow_test --execute="source sql/mysql-reset-v1-to-v2.sql"
```

DDL 隐式提交，不是整段可回滚事务。中断后检查 `SHOW TABLES`、九张表的 `SHOW CREATE TABLE` 和 `SELECT * FROM codeflow_schema`；版本 2 最后写入。失败可能留下 helper procedure，须 DBA 检查后处理。不要盲目重跑或只修改版本号。创建脚本最后检查库默认值为 `utf8mb4 / utf8mb4_unicode_ci`。

若遇到 Unknown collation，先执行 `SELECT VERSION(), @@version_comment;` 和 `SHOW COLLATION LIKE 'utf8mb4_unicode_ci';`，确认实际数据库产品、版本和支持的排序规则，再判断是否需要进一步适配。MySQL 5.7 不执行 CHECK 约束，不能通过删除约束来假定获得同等校验能力。

表结构：

- `codeflow_schema`：当前 schema 版本为 2。
- `codeflow_tasks`：权威索引列及当前 state；不含无限增长的历史数组。
- `codeflow_task_events`、`codeflow_self_test_artifacts`、`codeflow_test_cases`、`codeflow_case_runs`、`codeflow_acceptance_snapshots`、`codeflow_task_files`、`codeflow_model_usage`：独立日志、产物、定义、执行尝试、快照、文件元数据和用量行。

九张表使用 UTC、utf8mb4，任务 ID/状态等标识使用 ASCII/BINARY 比较。不要仅修改索引列或手工修改版本号冒充迁移。SDK 历史仍在本地，数据库不保存其完整内容。

### 权限分离

账号、主机来源和 TLS 要求由 DBA 创建和限制。DDL 管理账号需要建库的 CREATE、修改库默认值的 ALTER，以及目标库的 CREATE、DROP、REFERENCES、SELECT、INSERT；**脚本使用存储过程**，还需 CREATE ROUTINE、ALTER ROUTINE（删除 helper）、EXECUTE。不要依赖 `automatic_sp_privileges` 自动赋权，也不要把这些权限授给应用。

后台运行账号的表级权限如下，示例先由 DBA 创建账号，库名和 host 按部署调整，不在 SQL 中填密码：

```sql
GRANT SELECT ON codeflow_test.codeflow_schema TO 'codeflow_app'@'localhost';
GRANT SELECT, INSERT, UPDATE ON codeflow_test.codeflow_tasks TO 'codeflow_app'@'localhost';
GRANT SELECT, INSERT ON codeflow_test.codeflow_task_events TO 'codeflow_app'@'localhost';
GRANT SELECT, INSERT, UPDATE ON codeflow_test.codeflow_self_test_artifacts TO 'codeflow_app'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON codeflow_test.codeflow_test_cases TO 'codeflow_app'@'localhost';
GRANT SELECT, INSERT, UPDATE ON codeflow_test.codeflow_case_runs TO 'codeflow_app'@'localhost';
GRANT SELECT, INSERT ON codeflow_test.codeflow_acceptance_snapshots TO 'codeflow_app'@'localhost';
GRANT SELECT, INSERT, UPDATE ON codeflow_test.codeflow_task_files TO 'codeflow_app'@'localhost';
GRANT SELECT, INSERT, UPDATE ON codeflow_test.codeflow_model_usage TO 'codeflow_app'@'localhost';
```

用例表 DELETE 是当前 core 移除无执行记录定义所需；usage UPDATE 用于去重 no-op。运行账号不需其他表 DELETE、建表、routine、全局管理或 FILE 权限。

只读报告账号仅需九张表 SELECT；专用库可用 `GRANT SELECT ON codeflow_test.* TO 'codeflow_report'@'localhost';`。information_schema 表大小可见范围来自表权限，不需全局 PROCESS；命名锁不需 routine 管理权限。

单独维护账号在八张业务表上需 SELECT、DELETE，在版本表上只需 SELECT，不建议整个库授予 DELETE。delete-task 的 dry-run 也有 FOR UPDATE，因此使用维护账号（不同 MySQL 小版本 locking-read 权限须实测），只读账号只用于 capacity/files。不要将维护账号配置给后台或 SDK。

## 2. 配置本机连接

参考根目录 `.env.example`，在本机创建不提交的 `.env`，或将配置注入后台环境。密码仅在本地填写，不发送到聊天、不写入 SQL、不使用 `VITE_` 前缀。`.env` 已加入忽略规则，测试环境仍应限制文件读取权限。

| 参数 | 含义 |
| --- | --- |
| TASK_STORAGE | `mysql` 启用数据库；默认 `json` 保留原有文件模式 |
| DB_HOST / DB_PORT | MySQL 地址及端口，默认 3306 |
| DB_USER / DB_PASSWORD / DB_NAME | 运行账号、密码和已有数据库名，必填 |
| DB_POOL_SIZE | 连接池上限，默认 5，最少 2；其中一条连接持有单实例锁 |
| DB_CONNECT_TIMEOUT_MS | 连接超时，默认 10000 毫秒 |
| DB_TLS | `true` 开启证书校验；远程测试库建议开启 |
| DB_TLS_CA_FILE | 可选 CA 证书文件路径，仅在 TLS 开启时有效 |
| CODEFLOW_ENV_FILE | 可选显式环境文件路径；优先于默认文件。未设置时，非生产环境自动加载当前工作目录的 `.env`（若存在）；生产环境只读取注入的变量，除非明确指定文件 |

不会禁用 TLS 证书校验。私有 CA 使用 DB_TLS_CA_FILE。仅当数据库不支持 TLS 且处于可信隔离内网时才设 DB_TLS=false。

在项目根目录启动开发后台会自动加载本地 `.env`，已有进程环境变量不会被覆盖。显式环境文件不存在或无法读取时启动失败，不静默改用 JSON。启动后检查 `/api/health` 的 storage 应为 mysql，避免误用另一套 JSON 任务数据。

PowerShell 启动步骤（也可显式指定项目目录之外的受保护文件）：

```powershell
$env:CODEFLOW_ENV_FILE = Join-Path $PWD '.env'
npm run db:check
npm run dev:api
```

或使用构建后的后台：

```powershell
npm run build
npm start
```

`db:check` 成功文案已为 schema v2。它与 API 启动共用连接校验：取得单实例锁并检查版本 2，通过 INFORMATION_SCHEMA 严格核对九张表为 InnoDB 基表、完整预期字段集及其类型、可空性、默认值、排序规则和允许的 EXTRA；检查预期索引的列顺序、唯一性、无前缀、BTREE 类型，以及预期外键的同库引用、列顺序和 RESTRICT 更新/删除规则。8.0.16+ 另检查索引可见性和预期 CHECK 名称存在且已启用；5.7 不查询这些不支持的元数据，应用等价校验不能保护绕过应用的直接 SQL。它不创建表、不恢复或写入任务；这些结构元数据检查不比对 CHECK 表达式，也不拒绝所有额外索引或约束，不能代替真实约束行为、写权限及逐表 SHOW CREATE TABLE 验收。维护命令另要求版本表恰有一行且为 2，也不是完整 DDL 验证器。检查前由用户协调停止旧后台，否则单实例锁拒绝连接；不要绕过或强行释放另一实例的锁。配置变更后需重启后台。

### 无 DDL 的合成数据烟测

```powershell
# dry-run：不加载环境文件、不连接数据库
npm run db:smoke
# 显式写入自动生成 ID 的合成数据，默认清理该次数据
npm run db:smoke -- --execute
# 显式保留该次生成的合成行
npm run db:smoke -- --execute --keep
```

执行模式须先停止 API 及全部同库写入者，并取得与 API 共用的命名锁；不要绕过或强行释放其他实例的锁。由用户在本机提供受保护的连接配置，不在命令、日志或聊天中公开凭据。runner 不执行 DDL，只写入自动生成任务 ID 的合成数据，不修改既有任务；默认清理仅针对该次生成任务 UUID 的数据库行，`--keep` 则保留它们。默认执行后检查 `cleaned: true`；清理失败不能当作无残留成功，应核实该任务 UUID 的行。本次成功结果及逐表行数见本文开头。

文件相关记录仅为元数据，不创建附件、截图、仓库或 SDK 文件；不调用真实模型、浏览器、Git 或 API/OAuth 流程。重连往返、乐观版本冲突、SQL 前校验及注入后期子表失败的回滚证据，不替代隔离 DDL、断线、最小权限或备份恢复测试。

## 3. 验证与故障行为

- `GET http://127.0.0.1:3001/api/health` 正常返回 `{ "ok": true, "storage": "mysql" }`；存储故障返回 HTTP 503。
- 本次合成烟测已验证真实 DB 的 task state、事件、用例、产物、运行等分表持久化及重连读取，不代表 API 已切换或端到端验收完成。实际切换仍须完成所需隔离库验证，再由用户明确触发 API/浏览器烟测；真实模型请求须单独授权。
- 停止并重启后台后，任务从 MySQL 加载；进行中的自测转 REVIEW，其他未完成编码会话按原有规则中断，不会自动重放模型操作或推送。
- 本地 `data/tasks.json` 不会导入、不会在数据库模式下读取或覆盖。切回 TASK_STORAGE=json 会看到原本的本地数据，不会自动合并两个来源。
- 数据库不可用、表未创建或已有后台占用时启动失败，不会悄悄切回 JSON。运行中写入失败后拒绝后续变更和接口成功响应，恢复数据库后需重启后台。
- 按任务事务/版本检查和有界写队列提交，HTTP 成功响应及外部副作用前后保留落库检查点；启动只恢复活动记录，不全量反序列化历史。数据库事务不覆盖 Git、SDK 或浏览器外部操作，进程异常退出仍可能留下未结束记录。

## 当前范围

数据库保存任务数据，不保存 Git 工作目录、PRD 文件或截图二进制；这些仍在 DATA_DIR。OAuth 会话仍在进程内存，重启后需重新登录。当前仅支持单后台实例：MySQL 命名锁用于防止两个内存任务缓存互相覆盖，不是多实例任务租约方案。不要跨机器复用本地工作目录；多实例、共享会话与对象存储需另行设计。

SDK 会话 ID 和目录关联保存在任务 state/阶段产物中，完整历史仍在 DATA_DIR/sessions/<taskId>。仅恢复数据库不能保证 SDK 会话恢复，目录丢失时编码恢复需明确备用会话授权；自测恢复依赖阶段产物，不替换编码会话。

任务命令和 Copilot 子进程不会继承后台 DB_* 配置或 CODEFLOW_ENV_FILE；被测项目若需要自己的数据库，需单独配置测试凭据。这不是文件系统沙箱，同用户进程仍可能读取可访问文件，后台凭据建议放在工作目录之外并限制权限。

## 4. 离线维护

所有维护命令先取得与 API 相同的数据库命名锁，锁不可用即失败。**先停 API、SDK/测试子进程及全部 DB/文件写入者**，只读报告也要求离线窗口。命名锁不是分布式租约，也约束不了不遵守锁的外部客户端。

维护命令只读取用户预先注入的 TASK_STORAGE=mysql、DB_* 环境变量，忽略 CODEFLOW_ENV_FILE，不调用环境文件加载器。API/db:check 的环境文件行为不变。密码由受保护启动器注入，不打印配置。维护命令测试使用假连接，未在实际库执行维护删除；实际连接检查记录见本文开头。维护命令没有恢复任务、模型调用、DDL、自动重试或文件删除功能，失败以非零退出码和不含驱动诊断的通用提示结束。

```powershell
npm run db:maintenance -- capacity
npm run db:maintenance -- capacity --taskId TASK_ID
npm run db:maintenance -- files --data-dir "E:\CodeFlowData"
npm run db:maintenance -- delete-task --taskId TASK_ID
```

- capacity：八张业务表精确行数、JSON/text 总 octets、最大单行 payload 合计、各任务行数和 payload 字节，版本表行数另列。information_schema 的 data/index 字节是全表 InnoDB 估计值，不受 taskId 筛选影响。payload octets 不是完整行大小/磁盘空间或 JSON_STORAGE_SIZE；没有跨表一致快照，需停写，全库统计可能较慢，任务汇总暂不分页。
- files：只扫描显式 DATA_DIR 下 uploads/evidence/sessions/workspaces 的目录项和文件元数据，不打开文件内容或 SDK 状态。验证相对键、storage_key_hash、根范围、Windows 别名/保留名称，拒绝目录链接/越界；DATA_DIR 必须是无链接的规范真实目录。输出 missing、unsafe、unregisteredCandidates。最多检查 100000 个元数据/目录项，超限失败而非输出伪完整报告。不验证内容 sha256/大小变化，不认证整个 SDK 目录，不保证恶意并发替换路径下的无竞态扫描，需停写且限制文件系统写权限。
- **未登记不等于孤儿**：worker 已通过 core `recordFile` 登记 PRD、设计附件、生成阶段获准写入且仍存在的测试文件、浏览器执行返回的截图，以及任务会话目录 `session_manifest`。普通文件记录 DATA_DIR 相对键、SHA-256、大小及关联元数据；会话目录仅记录 `directory: true`，覆盖其子孙（包括自测短会话），不逐文件认证 SDK 内容。这些接线不等于全量扫描或历史回填；旧任务、未经过登记路径的文件及仓库仍可能产生候选，不能自动删除。本工具不提供文件清理宽限期或“可安全删除”结论。

删除 dry-run 只计数并回滚；用户复核输出、备份和 taskId 后才单独执行：

```powershell
npm run db:maintenance -- delete-task --taskId TASK_ID --execute
```

只接受一个显式 taskId，没有全库、按年龄、批量或文件清理选项。终态沿用 core：SUCCESS、FAILED、REVIEW、ACCEPTED、PUBLISH_PENDING，不等于都已验收成功。事务锁住目标任务行，任务不存在/未知状态/任意任务非终态或 modelInTurn=true、modelTurn.status=running/目标有 running 产物或 running、generating、有开始无结束的执行时拒绝；不会自动将任务改为失败来绕过保护。

同一连接持有并复核实例锁，按 usage、runs、events、files、snapshots、artifacts、cases、tasks 顺序参数化删除，逐表计数必须一致，任意失败整段回滚。不禁用外键、不依赖 CASCADE。连接在提交时中断可能有未知提交结果，需核实而非自动重试。

**仅删除数据库行及文件元数据；全部附件、截图、仓库和 SDK 数据继续保留，直到用户另行明确批准独立文件清理方案。本工具没有此批准开关。** 删除会失去 UI 恢复/发布审批入口，保留 SDK 文件不自动重建任务。保留 dry-run、执行结果、备份时间和文件清单，路径可能敏感，须受限保存。

## 5. 一致备份和恢复

数据库和文件系统不能跨系统原子提交。备份覆盖数据库、DATA_DIR 的 uploads/evidence/sessions/workspaces（JSON 模式还包括任务存储文件）、匹配的程序/SQL版本与路径配置说明。凭据不明文打包到普通备份；仅数据库备份不能恢复 SDK 和仓库，仅文件备份不能重建任务引用。

1. 用户协调停止 API、SDK、外部测试及其他 DB/文件写入者，确认无未完成操作。锁空闲不证明非 CodeFlow 写入者已停，备份期间不运行维护删除。
2. 在 DATA_DIR 外创建受限、加密备份位置，记录同一停写窗口、schema 和程序版本。示例由用户按部署修改，备份完成前不启动后台：

```powershell
mysqldump --login-path=codeflow-backup --single-transaction --no-tablespaces --set-gtid-purged=OFF --skip-triggers --result-file="E:\CodeFlowBackup\snapshot\database.sql" codeflow_test
Copy-Item -LiteralPath "E:\CodeFlowData\uploads" -Destination "E:\CodeFlowBackup\snapshot\uploads" -Recurse
Copy-Item -LiteralPath "E:\CodeFlowData\evidence" -Destination "E:\CodeFlowBackup\snapshot\evidence" -Recurse
Copy-Item -LiteralPath "E:\CodeFlowData\sessions" -Destination "E:\CodeFlowBackup\snapshot\sessions" -Recurse
Copy-Item -LiteralPath "E:\CodeFlowData\workspaces" -Destination "E:\CodeFlowBackup\snapshot\workspaces" -Recurse
```

3. 逐条检查退出码和文件复制错误，确认所有启用目录已复制，保留必要 ACL，缺失目录必须记录。此 dump 针对无视图/触发器的专用库，不含 CREATE DATABASE/USE；这些选项避免不必要的 PROCESS/表空间权限，备份账号最小权限仍须 DBA 按服务器配置验证。
4. **至少一次独立恢复演练**：由 DBA 创建全新隔离库 codeflow_restore，不先运行建表脚本；导入 dump，把四个目录恢复到新的受限 DATA_DIR，绝不覆盖实际库/原目录：

```powershell
mysql --login-path=codeflow-recovery codeflow_restore --execute="source E:/CodeFlowBackup/snapshot/database.sql"
```

5. 单独终端由用户注入恢复库和新 DATA_DIR，验证 schema/DDL、行数、外键、缺失文件、会话 ID/路径。state/SDK 可能仍引用旧绝对路径，不直接启动 SDK；先规划隔离挂载或受控重定位，不改写原历史。用匹配程序执行 db:check、capacity、files，读取/恢复烟测仅针对副本，模型请求须另行授权。
6. 记录备份校验、恢复耗时、文件缺失和会话可恢复性后才认定演练成功。当前**尚无真实演练证据**。切换失败先停新版，回 V1 须恢复完整 V1 表结构、文件备份和旧程序，不可只改版本号；V2 不提供反向迁移。

## 6. 验证边界

离线维护测试：`node --import tsx --test server/storage/storage-maintenance.test.ts`，仅假连接和系统临时目录。另有 opt-in 真实库入口 `npm run test:mysql-v2`，实现见 [server/storage/mysql-v2.integration.test.ts](../server/storage/mysql-v2.integration.test.ts)。它仍是**仅面向隔离 MySQL 8.0.16+ 的 DDL 测试套件，不得指向当前实际 5.7 库**，不因运行时支持 5.7 而改变目标范围。默认跳过真实数据库用例；配置守卫和版本守卫测试仍运行。该入口不加载 `.env`，不读取或回退到应用 `DB_*` / `CODEFLOW_ENV_FILE`；只从进程读取以下专用变量，不要在命令、日志或聊天中填写或打印实际凭据：

| 参数 | 要求 |
| --- | --- |
| CODEFLOW_TEST_DB_ENABLE | 仅精确值 `1` 启用真实库用例 |
| CODEFLOW_TEST_DB_HOST / CODEFLOW_TEST_DB_PORT | 显式主机及 1 至 65535 的整数端口，无默认回退；主机不可为空 |
| CODEFLOW_TEST_DB_USER / CODEFLOW_TEST_DB_PASSWORD | 显式测试账号及密码变量；账号不可为空，密码变量必须存在，凭据由受保护环境注入 |
| CODEFLOW_TEST_DB_PREFIX | 必须匹配 `codeflow_test_<12 至 32 位小写字母或数字>_`，每次使用唯一前缀 |
| CODEFLOW_TEST_DB_NAME | 必须以前述前缀开头且另有非空后缀，完整名称仅允许小写字母、数字、下划线，最多 64 字符 |
| CODEFLOW_TEST_DB_TLS | 可选，仅允许 `true` / `false`；`true` 启用证书校验，未设置时不开启 TLS；此 runner 不提供自定义 CA 文件变量 |

必须由用户另行批准并预先创建**唯一、完全空的隔离数据库**，绝不能指向业务库、应用测试库或恢复副本。runner 使用专用命名锁，确认数据库身份、真实 MySQL 8.0.16+（拒绝 MariaDB）、严格 SQL 模式、至少 16 KiB InnoDB 页，以及无表、routine、trigger、event 后才取得清理所有权；它不会创建数据库。账号须在这个专用库具备测试所需 DDL、routine 和读写权限，不使用应用或只读账号。前缀和空库守卫不是安全沙箱，仍须 DBA 限制账号作用域。

**该 runner 会执行建表、写入、DROP 和 V1 重置场景，并在 finally 中尝试删除它拥有的九张 CodeFlow 表及两个 helper procedure。** 进程被强制终止或清理失败可能留下对象，须人工核查，不要把它当作只读检查。用例覆盖新装/拒绝重复安装、JSON 与 Unicode 往返、毫秒时间、历史分页、约束拒绝、事务回滚、并发版本冲突、行锁/实例锁及空/非空 V1 重置。入口和用例存在不等于已在真实库通过。

实际 `5.7.35-log` 的 `db:check` 与 `db:smoke -- --execute` 已通过，验证范围和 11 行合成数据的清理结果见本文开头；未执行启用后的隔离 MySQL 8.0.16+ DDL runner。部分 DDL 故障、真实维护删除顺序/回滚、断线、最小权限、报文上限及备份恢复等仍需隔离库验收；烟测的生成任务清理不等同于离线维护删除命令验收。编译、mock 或默认跳过的测试均不能证明这些完成，也不代表 V2 计划全部完成或已切换环境。离线维护入口不提供 UI/HTTP 历史分页、历史文件回填、JSON 维护或实际环境切换。