# 服务端工程管理规范

当前系统分层、主要模块关系、业务流程与受控 Agent 边界见 [HTML 架构图](architecture.html)。涉及架构的变更需同步更新该图和核对日期，并运行 `node --import tsx --test server/tests/ui/architecture.test.ts`；图中展示的是当前实现，不是未来规划。

## 目录与职责

按功能模块归档，保持浅层目录；不为每个功能重复创建 controllers、services、repositories 等层级。

```text
server/
  index.ts
  agents/
  security/
  tasks/
  execution/
  verification/
  git/
  storage/
  http/
  tests/
    integration/
    ui/
```

| 位置 | 职责 | 主要文件 |
| --- | --- | --- |
| index.ts | 组装服务、注册路由、启动与关闭；本轮不拆分现有路由 | index.ts |
| agents | 跨功能共用的角色配置、交接、执行边界及文件权限；不拥有业务状态或流程审批 | profiles.ts、runtime.ts、workspace.ts |
| security | OAuth、登录状态、来源与任务归属控制 | auth.ts、oauth-config.ts、access.ts |
| tasks | 任务状态、变更、重启恢复、展示数据和上传名 | store.ts、task-summary.ts、upload-name.ts |
| execution | 编排编码流程、SDK 会话恢复、历史兼容修复、模型对话、执行环境和工具记录 | worker.ts、copilot-session.ts、session-history.ts、resume-context.ts、model-turn.ts、models.ts、execution-environment.ts、tool-detail.ts |
| verification | 需求验收、测试计划、单文件测试、浏览器自动化及证据 | acceptance.ts、self-test.ts、browser-automation.ts |
| git | 仓库操作、命令保护、文件变更和发布审批执行 | git.ts、git-guard.ts、changes.ts、publish.ts |
| storage | JSON/MySQL 存储初始化、MySQL 适配器、配置和检查工具 | storage-runtime.ts、database.ts、database-config.ts、db-check.ts |
| http | HTTP 专用响应与中间件规则 | storage-response.ts |
| tests/integration | 跨模块工作流和持久化协作测试 | workflow.test.ts、acceptance-worker.test.ts、storage-persistence.test.ts、conversation.test.ts |
| tests/ui | 使用服务端测试工具运行的前端组件渲染测试 | acceptance-ui.test.ts、activity-ui.test.ts |

`tasks/store.ts` 是任务状态的所有者，同时定义持久化接口。它不导入 MySQL 实现；`storage/database.ts` 实现该接口，`storage/storage-runtime.ts` 负责组装。任务业务状态不放进数据库适配器。

## 依赖规则

- `index.ts` 作为组装入口，可以引用各模块；业务模块不得反向引用入口。
- `execution/worker.ts` 是流程编排者，调用任务、验证和 Git 模块；底层模块不得反向依赖 worker。
- HTTP 请求和响应处理放在入口或 `http`；业务函数不新增对 Express Request、Response 的依赖。
- 跨模块确实共用的前后端数据契约保留在根目录 `shared`，不复制类型定义。
- 辅助函数归属使用它的功能模块，不新增泛化 `utils` 或 `common` 收纳目录。
- 直接导入拥有该功能的文件，不默认新增批量转导出的 index.ts，避免依赖关系被隐藏。
- 保持 NodeNext 相对导入的 `.js` 后缀；不在本轮引入路径别名或变更编译方式。

这些规则约束后续新增代码；现有的底层模块间调用保持原样，本轮不增加解耦抽象或改写流程。

## 命名与测试

- 源码使用现有 `kebab-case.ts`，测试使用同名 `*.test.ts`；目录归档不同时批量重命名文件。
- 单模块测试放在实现旁边。`resume-context.test.ts` 保留在 `execution`，涵盖上下文恢复及相关 worker 行为。
- 覆盖多个模块的工作流测试放在 `tests/integration`，组件渲染测试放在 `tests/ui`。
- 目录表示归属，不表示强制更换测试工具。继续使用 Node test runner 和 tsx。
- `npm test` 使用带引号的 `server/**/*.test.ts`，支持 Windows 下递归发现；测试文件数量随功能新增而增长。
- 增加或移动测试时核对发现数量，不能用减少测试范围的方法获得通过结果。

## 运行与构建

- `npm run dev:api`：仍从 `server/index.ts` 启动。
- `npm run dev:web`：在独立终端启动 Vite；`npm run dev` 仅为前端别名，不组合启动后台。
- 前端和后台各自停止；Vite 排除任务数据、SDK 会话及后端目录的文件监听，不因任务产物变化刷新平台。
- `npm run build`：构建前后端；服务端产物由 TypeScript 按目录结构输出。
- `npm start`：仍运行 `dist-server/server/index.js`。
- `npm run db:check`：运行 `server/storage/db-check.ts`，只用于数据库连通性与结构检查。
- `tsconfig.server.json` 已递归包含服务端源码，并排除同目录和嵌套目录中的测试。
- `dist-server` 是生成产物，不手工修改。源码迁移后清除旧服务端产物再重新构建，避免旧目录文件残留。
- `data`、SQL 和附件不随源码归档而移动。工作目录、SDK 会话目录、截图及存储路径保持原有语义。

## 变更约束

新增文件先确定所属功能及测试归属。只有模块规模和实际职责需要时才进一步拆分，不创建空目录或占位层级。

目录整理只调整位置、引用、脚本和路径说明，不同时更改 API、业务逻辑、数据库结构或数据格式。路由提取和 worker 拆分应作为后续独立变更，另行评估和验证。

每次结构调整至少执行聚焦回归、完整测试发现和构建验证；记录已有失败，不能顺便重写无关配置或用户修改。

## 受控 Agent 边界

业务流程仍由平台的 Service / Worker 决定。Agent 不自主协商，不直接调用其他 Agent，不持有审批、发布或任务状态变更权限；本次不引入 LangChain、LangGraph 或额外部署服务。

| Agent | 所属实现 | 职责与权限 |
| --- | --- | --- |
| RequirementAgent | requirements/model.ts | 分析、澄清、生成 PRD；只读快照与临时笔记 |
| DesignAgent | requirements/model.ts、prototype-adjustment.ts | 基于已确认 PRD 生成或调整原型；原型调整继续使用原有专属会话 |
| CodingAgent | execution/coding-agent.ts，由 worker.ts 调度 | 编码会话的角色、工具与预算边界；直接文件权限限定任务工作区及精确的只读附件 |
| TestPlanningAgent | testing/planning-model.ts | 只读需求、参考代码，生成用例定义 |
| test-review | 独立规划与编码自测的全新阶段会话 | 只读原始依据与待评审定义，不能修改或自行批准 |
| test-authoring | worker.ts 的独立生成阶段会话 | 仅编写允许的测试文件，不执行命令或修改业务代码 |
| TestImplementationAgent | testing/execution-model.ts | 只读代码，返回测试文件提案；平台校验后写入 |
| browser-planning | worker.ts 的独立浏览器规划会话 | 只读规划，实际浏览器执行及证据由平台产生 |

原 CopilotRequirementModel、CopilotPlanningModel、CopilotExecutionModel 入口保留兼容；实际任务路由进入上述 Agent。截图、导出、测试执行、依赖安装与 Git 发布仍为确定性工具或平台服务，不为这些操作再增加模型回合。

### 交接、权限与预算

- `agents/runtime.ts` 对输入创建不可变副本，输出复制后才交回平台；交接元数据包含协议版本、角色、运行 ID、资源摘要、输入版本和指纹。不把模型摘要当成完整的跨阶段契约，不共享可变业务对象。
- 需求及设计接收结果前检查语义输入指纹，保存时再次在 CAS 更新中检查；进度事件和会话绑定不算业务输入变化。测试规划校验原始输入和参考代码快照；测试实现校验执行版本、用例包与工作区。已有来源、字段、映射、HTML、用例覆盖和断言校验继续生效。
- 同一资源的 Agent 执行互斥；编码任务继续由 Worker 的活动任务集合互斥，并在执行入口拒绝重复调用。不同任务的工作区保持隔离。
- 编码任务先保存完成审计再标记业务成功；审计写入失败保留已有代码和执行证据，不标记成功、不自动重放。存储持续不可用时记录运维错误，需恢复存储后处理。
- `agents/profiles.ts` 是角色和预算的固定定义。角色约束与原有工具/路径权限取交集，不能用新包装放宽旧限制。模型不能使用任务/Agent 委派工具；只有平台代码能选择允许的后续角色。
- 需求、设计每次执行最多 12 次 SDK `send`、128 次工具调用；独立测试实现最多 1 次 `send`、256 次工具调用。测试规划及编码的根预算为 256 次 `send`，子角色还受各自上限约束。编码各自测阶段共享父预算，重建会话不能重置预算。拒绝的工具尝试也计入工具预算。
- 预算耗尽会产生明确错误，不自动重放。既有格式修正、批次修复和原型校正上限保留，不因 Agent 化增加新重试回路。不截断需求、删除用例或伪造通过来满足预算。
- 生命周期元数据写入既有任务/规划进度事件；需求会话审计同时记录 Agent 交接信息。子角色请求记录真实角色、父角色和请求指纹，使用同一运行 ID 关联。公共元数据不包含原始输入、提示词、凭据或原始错误文本。`completed` 表示该次 Agent 调用结束，不代表 PRD 已确认、测试已通过或发布已获批准。

### 恢复和安全边界

持久化继续使用既有项目、作业、阶段产物与 SDK 历史，不新增数据库结构。重启后按原有规则标记中断，用户显式继续或重试；不会自动重放写文件、命令、审批或发布。阶段产物仍按已有指纹规则复用，不增加仅凭角色或会话 ID 的结果缓存。

这里的互斥是进程内控制，配合现有存储实例锁及运行租约，不是分布式任务队列。直接文件与工具检查也不是 OS 沙箱；编码 Agent 仍沿用已有受控 shell 能力。生产环境如需隔离不可信代码，必须另行提供进程/容器、网络与文件系统隔离。

`send` 预算限制平台提交次数，工具预算限制工具循环，不等于供应商内部推理次数、精确 token 或金额硬上限；现有用量记录仍用于计量。扩大用例规模或缩小批次可能触及预算，系统保留已保存检查点并显式失败，不默默缩减验收范围。