# 前端目录与维护约定

前端采用按业务功能分组的 React + TypeScript 单页应用结构。此次整理仅迁移文件、更新引用和明确命名，不修改 API、业务规则、路由地址或运行数据。

## 目录职责

```text
src/
  main.tsx                    # 浏览器启动与 Provider 装配
  app/
    AppRouter.tsx             # 页面路由、懒加载与加载状态
    navigation.ts             # 供业务操作使用的导航上下文
  components/                 # 共享筛选器、模型选择器、FeatureMenu 功能菜单
  features/
    auth/                     # 登录界面、认证上下文与会话状态
    coding/                   # 编码工作区、任务历史、对话、文件与发布
    automation/               # 自动化任务看板及执行详情
    testing/
      TestingWorkspace.tsx    # 独立规划与执行工作区
      planning/               # 规划用例、编辑、审查范围、进度及问答
      review/                 # 共享设计审查展示与状态计算
      execution/              # 自测设计/选择入口、执行结果与可信绑定
  styles/                     # 应用基础、工作台、测试工作区、登录与共享布局样式
  assets/                     # 静态资源
```

`shared/` 仍位于仓库根目录，承载前后端共同使用的数据契约和纯策略计算；不要在前端复制这些类型。`server/tests/ui/` 保留现有 UI 测试位置，避免拆出另一套测试运行方式。

## 依赖约定

- `main.tsx` 负责启动，`app` 负责路由装配；业务页面不直接写入浏览器 History。
- `components` 只放跨功能复用的控件或导航，不导入业务工作区、服务端模块或具体任务状态。
- 业务组件、专属 hook 和辅助计算优先放在所属 `features` 内，不为单处使用而提取全局 `utils` 或 `hooks`。
- `testing/planning` 和 `testing/execution` 共享的审查逻辑放在 `testing/review`；跨功能引用应明确指向拥有该能力的模块。
- 组件文件使用 PascalCase，hook 使用 `useXxx`，纯逻辑模块使用 kebab-case。文件名应体现职责，例如 `CodingWorkspace.tsx`，不再以泛化的 `App.tsx` 承载业务工作区。
- 使用明确的相对导入，兼容 Vite、TypeScript 和现有 Node/tsx 测试；不增加只有浏览器打包器认识的路径别名，也不增加无必要的桶导出文件。
- 共享样式从浏览器入口导入，保持当前层叠顺序。可被 Node 渲染测试导入的组件不直接导入 CSS。此次不重写 CSS 选择器或改变既有视觉语言。
- 路由保持按工作区懒加载。新增页面应在 `app/AppRouter.tsx` 注册，认证状态保持在路由页面之外。
- `FeatureMenu` 由路由外层共享布局持有，统一提供编码工作流、用例规划、用例执行和自动化任务入口。模块页面保留自己的记录列表与操作，不再重复放置功能菜单；窄屏收为带悬停及键盘焦点提示的图标栏。布局样式集中在 `styles/layout.css`。

现有大型工作区组件暂时保留，以便本次迁移可独立验证；后续拆分表单、数据请求或执行逻辑时，应按具体行为逐步进行，不把文件移动与业务重构混在一起。

## 验证

```text
npm run build
node --import tsx --test --test-concurrency=1 server/tests/ui/*.test.ts server/http/testing-links.test.ts
npm run lint
```

UI 回归使用隔离 Vite/Chrome 和模拟 API，覆盖路由、认证、任务分页、规划/执行、关联、绑定及响应式筛选。不要为了目录整理改写真实任务或重启生产 API。

路由与部署回退配置见 [frontend-routing.md](frontend-routing.md)。