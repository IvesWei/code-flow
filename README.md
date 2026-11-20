# Code/Flow

本地 GitHub Copilot 编码工作台。输入仓库地址、可选源分支、编码目标、PRD 文档和设计截图，后台克隆代码、创建本地任务分支并使用 Copilot SDK 在克隆目录中执行编码。Copilot 需要业务确认时会在界面提问；编码检查后等待用户审核并选择是否推送任务分支，再生成并逐条运行自测用例，工作目录、用例及执行证据保留在本机。

## 启动

要求 Node.js 22、npm、Git，以及拥有 Copilot 权限的 GitHub 账号。平台管理员只需创建**一个** GitHub OAuth App，设置回调 URL 为 `http://127.0.0.1:3001/api/auth/callback`。本地开发时，在当前用户的 `%LOCALAPPDATA%\CodeFlow\oauth.local.json` 中填写平台凭据：

```json
{
	"clientId": "你的 OAuth App Client ID",
	"clientSecret": "你的 OAuth App Client Secret"
}
```

文件位于项目目录之外，仅由后台读取；在 Windows 上应只允许运行后台的用户与 SYSTEM 访问该目录和文件。此机器已创建空模板并收紧 ACL，请直接在本机编辑，**不要将实际 Secret 发到聊天中**。修改后刷新页面即可重新检查配置状态。生产环境（`NODE_ENV=production`）不读取本地文件，必须设置 `GITHUB_CLIENT_ID` 和 `GITHUB_CLIENT_SECRET` 环境变量（由部署平台的 Secret 管理注入）；完整环境变量配置优先于本地文件，若只设置其中一个则不会混用另一个来源。不要将凭据提交到仓库。

使用平台的人**无需配置 OAuth App 或填写 token**：未登录或登录失效时显示独立登录界面，由用户点击按钮前往 GitHub 授权自己的账号。GitHub 返回一次性授权码到后台，后台换取该用户的 token 并存入各自的服务端会话；浏览器只收到 HttpOnly 会话 cookie，跳回 `http://127.0.0.1:5174/` 的 URL 中不包含 token。任务按 GitHub 用户 ID 隔离；不带归属信息的旧任务不对任何登录用户展示。页面首次加载时确认登录状态，站内切换复用共享状态，不进行 30 秒或焦点轮询；主动退出或接口返回 401 时回到登录页。重启后台会清除内存中的登录状态，需要重新授权。私有仓库的克隆依赖本机 Git Credential Manager / Git 凭据配置，GitHub OAuth 登录不会自动为内网 Git 仓库提供凭据；请不要把令牌放在仓库 URL 中。

```powershell
npm install
```

前后端分别在两个终端启动，不再使用组合进程：

终端一（后台）：

```powershell
npm run dev:api
```

终端二（前端）：

```powershell
npm run dev:web
```

`npm run dev` 仅为前端命令的别名，不再启动后台。各终端使用 Ctrl+C 独立停止对应服务；停止前端不会连带终止后台，停止后台会中断进行中的任务。每种服务只启动一个实例，不要在运行 `dev:web` 时重复执行 `dev`。

Vite 不监听默认 `data` 目录、自定义 `DATA_DIR`、后端源码、文档和后端编译产物，任务仓库、附件和 SDK 会话文件变化不触发平台热更新；平台前端源码与共享代码仍正常更新。前端的自定义 `DATA_DIR` 必须与后台一致（进程变量或项目 `.env`），修改配置后重启前端。平台 `.env` 或 Vite 配置本身变化仍可能触发前端重启。

浏览器访问 Vite 输出的本机地址，默认是 `http://127.0.0.1:5174`，端口占用时会自动递增。后台监听 `127.0.0.1:3001`，前端通过 Vite 代理访问 `/api`。提交接口默认允许 `127.0.0.1`、`localhost`、`[::1]` 的 HTTP 4 至 5199 端口；可在启动后台前设置 `WORKBENCH_ORIGINS` 为逗号分隔的完整本机 HTTP 来源白名单，例如 `$env:WORKBENCH_ORIGINS = 'http://127.0.0.1:5176,http://localhost:5176'`，设置后替代默认端口范围。OAuth 回调仍固定为 3001，登录成功后的跳转仍为 5174；使用自动递增端口时可在登录后返回实际的 Vite 地址。要指定模型，可在启动前设置 `COPILOT_MODEL`；默认使用 `auto`。`npm run build` 构建前后端，`npm run start` 启动构建后的 API，`npm test` 运行后端测试。

## 工程结构

当前系统分层、模块关系、业务流程和受控 Agent 边界见 [HTML 架构图](docs/architecture.html)，可直接用浏览器离线打开，也可打印为 PDF。每次架构变更须在同一变更中更新该图及核对日期；维护规则见 [AGENTS.md](AGENTS.md)，一致性与浏览器检查命令为 `node --import tsx --test server/tests/ui/architecture.test.ts`。

前端按业务功能组织：`src/main.tsx` 为浏览器入口，`src/app` 管理路由与导航，`src/features` 按认证、编码、测试和自动化分组，`src/components` 存放共享控件，`src/styles` 管理全局样式。完整目录和依赖约定见 [docs/frontend-organization.md](docs/frontend-organization.md)，SPA 路由与部署说明见 [docs/frontend-routing.md](docs/frontend-routing.md)。

服务端按功能模块组织，启动入口保留在 `server/index.ts`：`security` 管理认证与访问控制，`tasks` 管理任务状态，`execution` 管理 Copilot 执行与会话，`verification` 管理验收与自动化，`git` 管理仓库与发布，`storage` 管理持久化，`http` 管理 HTTP 中间件。单模块测试与源码同目录，跨模块和 UI 测试分别放在 `server/tests/integration`、`server/tests/ui`；`npm test` 递归发现全部服务端测试。

完整目录、依赖和维护规则见 [docs/server-organization.md](docs/server-organization.md)。源码目录与运行数据目录分离，目录整理不改变 API、数据结构或 SDK 会话位置。

独立用例规划/执行入口、存储安装与验收边界见 [docs/testing-workspaces.md](docs/testing-workspaces.md)。

独立入口为 `/planning` 和 `/execution`，旧 `/?view=planning` 和 `/?view=execution` 链接仍兼容，无需先建编码任务；支持仅上传来源后明确生成新的规划，发布不可变包后创建独立执行批次。实现与安装分开确认：`POST /api/testing/executions/:id/implement` 由只读模型返回 spec JSON，`POST /api/testing/executions/:id/install` 必须提交 `{"confirm":true}` 才安装固定工具链，之后仍需人工审批绑定并明确执行。安装以 sourceFingerprint 核对源码，installComplete 仅在完整成功后为 true；失败残留不能当作安装成功。runner 精确设置批准文件的 testDir，完整本机 HTTP 预览 URL 的子路径保留，HTTPS 不支持。Playwright Test 默认浏览器依赖匹配版本的缓存；系统 Chrome 仅在可信源码/配置显式选择 channel/executablePath 时使用，不自动下载浏览器或启动被测应用。

独立记录/工作区与模型会话位于 DATA_DIR 下的 testing 目录，runner 临时报告/产物结束后尽力清理，仅持久化结构化结果；显式环境输入 CODEFLOW_BASE_URL 不提供秘密隔离。进程租约先于恢复获取；导入补包仅在 owner 列表前 200 条项目内幂等查找，不是全历史恢复或跨记录事务。包内断言 ID 按冻结定义的数组位置生成，不是跨版本稳定语义注册表。可选任务关联仅为引用，不迁移历史任务；旧 CodingWorker 仍走 legacy 路径，不据此宣称同一编排核心。具体接口、目录、前提和限制见上述手册；本次文档核对没有调用生产接口/真实模型或重启活动服务，最终隔离测试统计由主流程汇总。

## 测试数据库

支持可选 MySQL 5.7.35+ 或 8.0.16+、schema 2，不支持 MariaDB，默认仍使用本地 JSON。当前已有的九张 V2 表无需为此次兼容改造迁移或执行 DDL。仅新空库先执行 [sql/mysql-create-database.sql](sql/mysql-create-database.sql)，再执行 [sql/mysql-schema.sql](sql/mysql-schema.sql)；只有已清空的 V1 库才能使用 [sql/mysql-reset-v1-to-v2.sql](sql/mysql-reset-v1-to-v2.sql)，非空库拒绝，不迁移旧 payload。停写后由用户注入连接配置，运行 `npm run db:check`。该命令与 API 启动共用结构元数据校验，严格检查九张 InnoDB 基表、字段集/类型/默认值/可空性/排序规则/EXTRA、预期索引、同库外键及 RESTRICT 规则，并持有单实例锁；8.0.16+ 另检查预期 CHECK 名称及启用状态，但不比对表达式。兼容边界：5.7 解析但忽略 SQL 脚本中的 CHECK，由应用执行等价业务校验，绕过应用直接写 SQL 无此保护；运行时共享读锁使用 `LOCK IN SHARE MODE`。结构检查不能替代真实约束和写权限验收。完整命令、routine/运行账号权限、切换及备份恢复见 [docs/mysql-test-database.md](docs/mysql-test-database.md)。

独立 testing 模块另需 `codeflow_testing_records`，不包含在上述九张任务表中。缺表时仅 `/api/testing` 返回 503，不自动建表、不回退 JSON。用户需另行批准并手动执行 [sql/mysql-testing-schema.sql](sql/mysql-testing-schema.sql)，然后自行重启 API；已由用户完成后无需重复执行。本次不执行 DDL、不核验真实表状态，也不重启当前服务。

2026-10-16，用户暂停 `dev:api` 后，实际 `5.7.35-log` 上的 `npm run db:check` 通过，包含严格 V2 字段、索引、外键和命名锁检查。`npm run db:smoke -- --execute` 也通过：合成任务 `c8860bf0-5e05-47ae-a22d-03d1b1c39ea5` 写入 usage 3、files 1、runs 1、snapshots 1、cases 1、artifacts 1、events 2、task 1，共 11 行；重连后精确核对 Unicode、字段/数组顺序、日期及引用，并验证真实乐观版本过期拒绝、SQL 前校验和注入后期子表失败时的事务回滚。结果为 `cleaned: true`，该任务 UUID 的全部行已移除，既有任务未改动。未执行 DDL、真实模型、浏览器、Git 或文件操作，也未重启 API；files 仅为合成元数据，不代表真实文件资产。此证据覆盖真实数据库上的 repository/storage 路径，不是浏览器/API/OAuth 端到端验收。

`npm run db:smoke` 为不加载环境文件、不连接数据库的 dry-run；`npm run db:smoke -- --execute` 显式写入自动生成 ID 的合成数据并默认清理；`npm run db:smoke -- --execute --keep` 保留该次生成的合成行。实际执行前须停止 API 及同库写入者，并取得与 API 共用的命名锁。配置和清理边界见 [docs/mysql-test-database.md](docs/mysql-test-database.md)。

`npm run test:mysql-v2` 是 opt-in 的隔离 MySQL 8.0.16+ DDL 集成测试，**不得指向当前实际 5.7 库**，也不是 5.7 运行时兼容烟测。本次未启用运行该 DDL 套件。默认跳过真实库用例；仅 `CODEFLOW_TEST_DB_ENABLE=1` 配合显式 `CODEFLOW_TEST_DB_HOST`、`CODEFLOW_TEST_DB_PORT`、`CODEFLOW_TEST_DB_USER`、`CODEFLOW_TEST_DB_PASSWORD`、`CODEFLOW_TEST_DB_NAME`、`CODEFLOW_TEST_DB_PREFIX` 才启用，另可设置 `CODEFLOW_TEST_DB_TLS`。不加载 `.env`，不回退到应用连接配置。它要求唯一前缀的完全空隔离库，会执行 DDL、写入、重置及清理，须用户单独批准；命名规则、清理风险与权限见运维手册，不要公开实际凭据。备份恢复、最小权限及断线测试仍待完成，不能据本次烟测宣告计划全部完成或环境切换成功。构建通过、编辑器无诊断；完整测试统计由主流程记录。MySQL 8.4 LTS 升级保留为后续规划建议，不是当前运行前提。

离线维护入口为 `npm run db:maintenance -- capacity`、`npm run db:maintenance -- files --data-dir "E:\CodeFlowData"` 和 `npm run db:maintenance -- delete-task --taskId TASK_ID`。先停 API/全部写入者；维护命令复用单实例锁，只读取已注入的连接环境变量，不自动加载环境文件。容量及文件缺失/未登记候选检查只读；删除默认 dry-run，仅追加 `--execute` 才按任务事务删除终态任务的数据库行，存在活动任务或目标未完成执行时拒绝。worker 已登记 PRD、设计附件、生成阶段获准写入且仍存在的测试文件、浏览器截图及任务会话目录清单；文件保留相对键、哈希、大小与关联信息，会话目录不逐文件认证。全部文件、仓库和 SDK 目录保留，不提供文件删除选项；未登记候选不等于可删除孤儿，当前接线不做全量扫描或历史回填。数据库模式不导入旧本地任务，不支持多个后台实例共享任务缓存。

## 工作流

详细执行手册：[测试执行全流程与约束](docs/test-execution-process.md)。覆盖草稿与保存计划、身份/输入校验、execute/repair、默认/自定义设计门禁、文件与浏览器路由、精确限制、模型超时、证据复用及中断恢复，并区分自动化原语与完整业务验收。

1. 提交 GitHub HTTPS 或 `code.sunmi.com` HTTP/HTTPS 仓库地址、可选源分支、编码目标以及 `.md`、`.txt` 或 `.pdf` PRD；可另附最多六张 PNG、JPG 或 WebP 设计图。每个文件最大 12 MB。浏览器自动化需填写可访问的本机 HTTP 预览地址，并提前启动被测应用。
2. 后台克隆到 `data/workspaces/<taskId>`，并从克隆后的分支创建 `copilot/task-<taskId前8位>` 本地分支；附件保存在 `data/uploads/<taskId>`。任务数据默认保存在 `data/tasks.json`；MySQL schema 2 的当前状态保存在 `codeflow_tasks`，日志、用例、产物及执行等分表存储。本地数据路径均被 Git 忽略。
3. Copilot 在仓库中编辑代码。如果调用 `ask_user`，任务变为 `NEEDS_INPUT`；在任务详情回答后继续当前会话。
4. Copilot 结束后，后台检查 Git 变更。如仓库根目录的 `package.json` 提供 `test` 或 `build` 脚本，后台执行对应的 `npm run`，并保留这些工程检查的结果。
5. 任务进入 `PUBLISH_PENDING`，显示仓库、目标任务分支、待提交文件和工程检查。用户可刷新清单后明确确认提交并非强制推送，或选择跳过推送直接继续；平台不会静默推送，也不会推送默认分支、创建 PR 或部署。编码会话的工具权限会阻止直接运行 Git 提交、推送及创建 PR 命令。若工作目录、文件内容、Git origin / push URL、任务分支已变化，推送会被拒绝；继续修复同一任务时只允许基于上次已推送提交快进更新任务分支。推送失败保留本地提交和审批状态，可重试；服务重启不会替用户自动推送。Git 凭据需由本机 Git Credential Manager 提供。请检查文件内容是否含敏感数据；平台会拒绝常见凭据文件名，但不能替代人工审查。
6. 确认推送成功或明确跳过后，Copilot 根据需求生成验收基线，按适用场景分批生成自测用例；不再固定最多 12 条。每批默认最多 8 条，保存后继续补齐未覆盖场景，汇总清单经过全量覆盖检查及分批质量评审后才执行。有测试文件时优先运行受支持单文件测试；没有测试文件且配置本机预览地址时，生成 JSON 浏览器脚本（站内路径、CSS 选择器、点击/填写/文本断言），校验后用无头 Chrome 执行并尝试截图。不运行任意模型 JavaScript，无法执行的用例标记为需人工确认。脚本、结果、时间及截图引用保存在当前任务存储（JSON 或 MySQL），截图保存在 `data/evidence/<taskId>`。推送仅包含确认时的编码变更，之后生成的测试文件不会自动推送。
7. 默认用例设计门禁 qualified 后进入执行准备，全部默认必验及工程检查通过时标记 `SUCCESS`，严格规则不变。用户也可勾选已有用例作为自定义必验集合，填写理由并确认风险；完整只读设计核对后 `executionAssessment.readiness=ready` 仅表示设计审查完成，不代表环境可执行。还须全部选中项实际 passed 及工程检查通过，才产生范围限定的 SUCCESS。范围质量 status 仍可 rejected，警告、默认拒绝及未选证据保留，只表示“自定义范围通过”，不是全量验收。必验未通过或需人工确认时为 `REVIEW`；接受风险为 `ACCEPTED`，不等价于成功。编码阶段无法完成则为 `FAILED`。

在加入自测功能之前已完成、但尚无自测用例的任务，任务详情会显示“开始编码自测”。该操作仅使用原分支工作目录和附件生成并运行用例，不重新克隆或执行编码阶段；需由任务所有者登录后启动。

用例数量按验收基线的需求与适用场景确定，单条用例可覆盖多个需求，必要的不同验证方式可以拆分，不要求凑满批次。后台环境变量 `SELF_TEST_BATCH_SIZE` 默认 8（允许 1 至 20），`SELF_TEST_MAX_CASES` 默认 300（允许 1 至 1000），`SELF_TEST_OPTIONAL_MAX_CASES` 默认 16（允许 0 至 1000）；优先保障必验覆盖，再在独立预算内生成补充项，补充项也受总上限约束。修改后需重新加载后台。达到总上限仍有必验缺项时转为 REVIEW；补充预算不足只记录缺项，不阻断必验覆盖。无效批次最多局部尝试 3 次，中断保留有效批次与已通过证据；质量评审拒绝即停止，等待用户明确发起 repair 后定点修正，再统一验收。

用例区分为纵向独立的“生成用例”和“用例执行”模块，不增加标签切换。生成模块始终保留功能点分组、关键字、类别、10/20 条分页及设计审查形式；审核状态只读取显式逐条记录：默认使用 `acceptanceAssessment.caseReviews`，自定义使用与当前提交范围及理由匹配的 `executionAssessment.caseReviews`；未选中项标记未纳入范围，旧记录缺失时为 unknown（审查未完成），不能由聚合结果、未列入问题或运行 passed 推断单条通过。顶部明确阻断与非阻断提示数量，阻断展开、提示折叠，支持仅看阻断及点击编号跨页定位，调整范围后保留历史问题参考。执行模块集中放置启动操作、预览地址及执行结果，只按已保存计划展示选中用例，修改待提交范围不改变该清单；运行筛选和分页独立，输出及证据折叠，可定位设计用例或打开自动化详情。无执行计划时不生成待运行清单，有实际证据的旧数据标注为非完整历史记录，不提供虚构的多轮历史。自测区分生成用例、审查用例与核对自定义范围，不新增顶层阶段。新基线保存功能点名称；旧基线按需求 ID 和验收条件分组，旧未分类用例明确标记，不猜测类别。跨需求用例保留全部映射，自定义可跨页选择或批选当前过滤功能组。

新用例保存类别、标签、优先级、风险与执行建议。模型不得因性能类别或低优先级自动豁免明确要求；默认策略下旧用例仍全部必验。用户可显式自定义本次集合，保存理由、确认时间及历史；编码变更后当前范围清除。执行与修正分开：点击执行不重写用例，默认门禁未通过时提示修正或选择自定义；质量问题只修正明确关联 TC 项。自测阶段和每个批次使用独立短会话，不恢复或替换编码会话；阶段产物与评审检查点绑定来源、用例、代码和规则版本，相同输入恢复时仅请求未完成批次。完整实现和兼容限制见 [自测实现链路](docs/self-test-flow.md)，策略见 [测试策略规则](docs/test-policy.md) 和 [验收规范](docs/acceptance-standard.md)。

`POST /api/tasks/:id/self-test` 通过 `intent: "execute"` 核对并执行勾选的已有用例（未传 intent 也默认 execute），不自动生成、补齐或修复；通过 `intent: "repair"` 明确生成或修正。自定义传 `acceptanceSelection: { "mode": "custom", "caseIds": ["TC-01"], "reason": "本次仅验收核心功能" }`；传 `acceptanceSelection: null` 恢复默认。非空选择、有效 ID 和理由由服务端独立检查，未选项不计为通过。单独的 `selectedCaseIds` 仍用于默认模式追加补充执行，不等同于自定义阻断集合。

设计审查与执行准备分开。自定义 `readiness` 是设计审查结论：ready 显示“设计审查完成”，blocked 显示“设计审查受阻”，executability 显示“设计可判定性”。coverage / quality 警告包括覆盖缺口、映射或分类不完整、较弱断言，允许 rejected + ready，但仍须有可观察、可判定的断言。设计没有说明必要前置条件、数据或清理，没有有意义预期或可观察断言，以及需求/决策冲突或不安全操作，属于 executability / conflict / safety 并阻断设计审查；checking / blocked / unknown 不能进入执行准备。默认严格设计门禁不变，范围通过不消除警告。

设计审查依据需求、用户决策和用例定义，不读取测试文件来认证脚本与断言一致性，也不因缺少文件、URL、runner 或实际环境而拒绝设计。文件、URL、runner 和实际环境条件由执行阶段检查或在运行中暴露；已有测试文件无需属于本次 Git 变更。旧文件路径仅做结构、用例/断言声明及 runner 等检查；下述 Phase 1 增加人工绑定及必需断言报告核验，仍没有完整脚本语义一致性认证，也没有通用的环境、测试数据或账号自动预检。平台不会自动启动服务、安装依赖或配置账号；manual/skipped 不更改设计结果，也不算执行通过，必验项未通过仍阻止 SUCCESS。

### Phase 1：可信 Playwright Test

保留生成、设计审查和默认/custom 门禁。在“用例执行”打开“绑定可信 Playwright”或“审阅可信绑定”，人工审阅可信脚本后确认精确文件、完整标题（describe + test 的 fullTitle）、project 及全部必需断言映射；保存绑定不启动执行、不代表通过。每项 assertions 按顺序生成如 `TC-1:A001` 的 ID，必须实际执行 `test.step('[assertion:TC-1:A001]', async () => { await expect(...) })`，每项至少包含一个真实 Playwright 原生 expect，空步骤/跳过/缺项不计通过。完整可运行写法及限制见 [执行手册 Phase 1](docs/test-execution-process.md#phase-1可信-playwright-test-绑定与必需断言)。

`GET/POST /api/tasks/:id/execution-bindings/:caseId` 提供清单读取与审批；POST 只接受 `testFile`、`testTitle`、`project`、完整有序 `assertionIds`、`confirm: true`。登录、任务归属、Origin、空闲状态及当前设计版本由服务端校验，审批身份/时间、用例指纹、设计工作区快照和源码 SHA-256 均由服务端生成，不信任客户端权威字段。显式 executionBinding 优先，失败/受阻/不完整不回退旧文件或 DSL；无绑定仍走原路径，旧 passed 不升级为语义认证。

可信操作者须在目标仓库手动准备本地 `@playwright/test`、浏览器及可信配置，提前启动被测服务；平台不自动安装任意依赖或下载浏览器，适配器临时覆盖 `webServer: undefined`，不改原配置。源码、配置及其导入/钩子仍是任意可信代码，**不是沙箱**；继承环境过滤部分数据库/配置变量不等于秘密隔离。只在无生产凭据的隔离环境运行，不提供跨源认证/账号授权，不自动改脚本或降低断言修到绿色。

新结果保留 `passed` / `failed` / `incomplete` / `blocked`、原因及逐项 expect 计数；用例执行和自动化看板/详情均区分 Playwright Test、DSL、legacy。仅持久化结构化摘要，不保留新 runner 的 trace/截图/原始报告供下载，临时产物尽力清理，旧 DSL 截图不变。`npm run build` 会复制 reporter 到编译目录，部署缺少此资产会 blocked。隔离测试包含真实 CLI/reporter/本机 Chrome 的点击、布局、网络三类 fixture，网络为本地拦截合成响应，不是生产验证；本轮文档修改不新增 UI、真实任务或运行时通过结论。

相同输入可复用并继续显示同一拒绝，重复 execute 不是修复授权；质量拒绝等待明确 repair，不自动反复修到合格。当前规则版本为 `isolated-self-test-v3-design-review`，旧规则缓存不复用，但不会即时修好旧任务，仍需后续明确操作和版本核对。新增字段沿用现有版本化 JSON 存储，不新增表或列，不需要 DDL 或数据库 schema 升级，不改写真实任务。测试证据以隔离检查记录为准，最终测试统计由主流程记录，此处不声明本次完整测试数量或通过总数。

任务接口：`GET /api/tasks`、`GET /api/tasks/:id`、`POST /api/tasks`（multipart：`repository`、`branch`、`instruction`、`prd`、`designs`、可选 `automationUrl`）、`POST /api/tasks/:id/publication/refresh`（刷新清单）、`POST /api/tasks/:id/publication/confirm`（JSON：`{ "snapshot": "已展示的快照摘要" }`）、`POST /api/tasks/:id/publication/skip`（JSON：`{ "skip": true }`）、`POST /api/tasks/:id/self-test`（可选 JSON：`{ "automationUrl": "http://127.0.0.1:4173", "selectedCaseIds": ["TC-16"] }`）、`GET /api/tasks/:id/automation/:caseId`（脚本及详细结果）、`GET /api/tasks/:id/automation/:caseId/screenshot`（截图，仅任务所有者可访问）、`POST /api/tasks/:id/answer`、`POST /api/tasks/:id/resume`、`POST /api/tasks/:id/accept`。发布操作要求登录和任务归属，失败必验用例可定点修正，已通过的浏览器任务不会重跑。脚本和截图可能包含被测页面数据，均只保存在本机并应按敏感数据管理。

## 当前边界

- 模型请求使用 SDK `send` 和事件等待，不使用固定总时限的 `sendAndWait`。短评审与浏览器脚本规划默认首次响应 10 分钟、后续无进展 5 分钟；编码与用例生成默认两者均为 20 分钟。可通过 `MODEL_FIRST_RESPONSE_TIMEOUT_MS`、`MODEL_INACTIVITY_TIMEOUT_MS` 分别全局覆盖，范围均为 10000 至 3600000 毫秒，未设置时使用对应阶段默认值。模型或工具进展切换到并刷新后续窗口，等待用户回答期间暂停；SDK 接收、回合启动、上下文压缩/截断只更新状态，不延长计时。超时不自动重试或重放命令。上下文压缩由 Copilot SDK 运行时处理，不是平台实现。详细流程、重试边界及恢复限制见 [自测实现链路](docs/self-test-flow.md)。修改后台配置需重新加载后台，已开始的请求仍使用原窗口。
- 仅接受 `github.com` 的 HTTPS 仓库和 `code.sunmi.com` 的 HTTP/HTTPS 仓库。HTTP 传输未加密，只应在可信内网使用。只有用户明确确认时才会提交并推送新任务分支；不支持创建 PR、部署。任务存储可接入配置的 MySQL 测试库。
- 当前服务仅绑定本机环回地址，虽可区分不同浏览器的用户身份，但还不能直接供其他机器或公网用户访问。正式多用户部署还需 HTTPS、可信的会话存储、访问控制和隔离的任务执行环境。Copilot 工具执行使用自动单次授权，**只在你信任输入仓库和文档、且本机具备隔离措施时运行**。
- 任务数据可跨重启读取，但进行中的 Copilot 会话不会自动恢复；等待确认推送的任务仍保持 `PUBLISH_PENDING`，中断的自测进入 `REVIEW`，其他中断任务标为 `FAILED`。
- 新任务的 SDK 会话 ID 立即保存到任务存储，完整 SDK 状态位于 `data/sessions/<taskId>`。继续编码优先调用 `resumeSession` 恢复原编码会话，重新注册权限及提问回调，设置 `continuePendingWork=false`，不会自动重放中断命令。编码恢复失败或旧任务没有 ID 时会明确提示，只有用户勾选“使用历史记录开启新会话”后才创建备用会话并注入历史问答摘要，不静默降级，也不猜测关联最近会话。自测不恢复或替换编码会话，各阶段/批次独立短会话，依靠版本产物与检查点续接。SDK 数据目录必须保留，DATA_DIR 应保持一致；会话文件含敏感对话，应与任务数据一起保护和备份。恢复对话不等于恢复被中断的进程，模型仍需核对代码实际状态。
- 旧 DSL 浏览器自动化依赖本机已安装的 Google Chrome 和已运行的被测 HTTP 服务；可信 Playwright Test 则依赖仓库配置所选的缓存浏览器或显式 Chrome/channel/executablePath，二者不能混同。平台不会自动下载浏览器、部署、启动外部依赖或创建测试账号。DSL 浏览器脚本只允许同源请求，可信 Test 源码没有这一沙箱保证；截图证明的是当时页面状态与脚本断言，不等于视觉稿一致性。无预览地址时原有 Node/tsx/Vitest/Jest/Playwright 单文件测试仍可运行，但不会伪造浏览器截图。请仅对可信仓库和本机服务执行，留意日志及截图中的敏感数据。
