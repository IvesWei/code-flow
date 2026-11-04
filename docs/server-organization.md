# 服务端工程管理规范

## 目录与职责

按功能模块归档，保持浅层目录；不为每个功能重复创建 controllers、services、repositories 等层级。

```text
server/
  index.ts
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