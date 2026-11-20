---
name: prd-with-ui-design-delivery
description: '基于需求规则与现有代码回溯，产出关键页面多状态高保真HTML原型、画板契约（ui-manifest.json）和经真实浏览器验证的PNG设计图，支持独立出图或供prd-from-requirements-and-code嵌入PRD。UI生成阶段强制使用经校验的ui-ux-pro-max设计智能套件，缺失时可按官方方式安装。Use when: 用户要求制作页面设计稿、交互原型、多状态UI截图，或在编写含UI设计稿的PRD时联用生成设计图；涵盖源码壳子回溯、ui-ux-pro-max设计检索、HTML原型、Playwright精准截图与Figma导入。Do not use for: 单独编写无UI的纯文本PRD（使用prd-from-requirements-and-code）、直接渲染Word文档或生产业务代码实现。'
argument-hint: '提供需求或已确认PRD规则、目标代码模块/路由范围、设计页面范围及期望原型目录名'
user-invocable: true
disable-model-invocation: false
---

# UI Prototype & Design Asset Delivery

将已确认的业务规则与代码库真实页面基线转化为**可交互的高保真多状态 HTML 原型、结构化画板契约和像素级验证通过的 PNG 设计图**。

> **职责边界**：本 Skill **专注产出 UI 设计资产（原型、Manifest、设计图）**，不直接编写 PRD 正文，也不生成 Word `.docx` 文档。当用户需要输出 PRD 文档（含带 UI 设计稿的业务评审版与开发规格版 PRD）时，文档编写、图片嵌入与 DOCX 渲染统一由 [prd-from-requirements-and-code](../prd-from-requirements-and-code/SKILL.md) 负责。

## 交付目标

默认交付以下 UI 设计资产（目录名可由用户指定或按主题命名）：

```text
docs/<主题>-prototype/index.html
docs/<主题>-prototype/ui-manifest.json
docs/<主题>-prototype/screenshots/*.png
```

只有 HTML 原型、`ui-manifest.json` 和 `screenshots/*.png` 全部通过浏览器渲染、像素检视与契约校验门禁，才能声称“UI 设计图完整交付”。

### 两种协作模式

1. **独立出图模式（仅需原型与设计稿）**：
   - 用户只需要交互原型、页面设计图或状态截图，不需要生成 PRD 文档。
   - 本 Skill 独立完成：关键交互歧义澄清 → 源码页面基线回溯 → `ui-manifest.json` 定义 → `ui-ux-pro-max` 设计检索 → HTML 原型 → Playwright 精准截图与 `validate_ui.py` 校验。
   - 此模式下 `ui-manifest.json` 中的 `requirements` 与 `acceptanceCriteria` 为选填。
2. **PRD 联用供图模式（与 `prd-from-requirements-and-code` 协同）**：
   - 用户要求生成“含 UI 设计稿的 PRD（Markdown / Word）”。
   - **单次共享取证与澄清**：与 `prd-from-requirements-and-code` 共享同一次代码回溯和 P0/P1 提问结果，禁止向用户重复提问或二次泛读代码。
   - **先定规则编号，再出设计图，最后嵌回文档**：先由 `prd-from-requirements-and-code` 收敛功能划分及开发版 `FR-xx` / `AC-xx` 编号 → 再由本 Skill 生成原型与 `screenshots/*.png`（此模式下 `ui-manifest.json` 必须绑定对应的 `requirements` 和 `acceptanceCriteria`）→ 最后交回 `prd-from-requirements-and-code` 写入双版 `■ **设计稿：**` 小节并渲染校验双版 `.docx`。

## 必要输入

至少需要以下信息：

- 需求描述、交互说明、流程图，或上游已收敛的功能/规则清单。
- 当前代码库范围（存量改造须能定位目标路由、Layout 与页面组件；全新产品说明目标端与品牌偏好）。
- 需要覆盖的关键页面范围与目标视口（默认桌面 `1600×1000`）。

若缺少会改变主界面布局、核心字段显隐、角色按钮权限或阻断交互的关键规则，必须先使用结构化提问工具澄清；联用模式下若上游已完成澄清，直接复用决策账本。

## 强制原则

1. **规则驱动画面**：页面上的每个字段、状态标签、操作按钮、权限显隐和报错提示都必须有明确业务规则依据；P0 规则未确认时只能输出探索性讨论原型，不得标记定稿。
2. **存量保真优先**：存量页面局部改动（`mode: "incremental"`）必须严格复用真实路由绑定的 Layout 壳子、菜单树、弹窗承载方式与非改动区结构，禁止凭印象脑补导航外壳、抄错历史原型或用通用审美重排非本期区域。
3. **关键状态成组设计**：不只画默认正常态；按业务实际成组覆盖列表/表单正常态、新建/编辑弹窗、确认/影响阻断、异步加载/进度、空数据、失败恢复与无权限/只读状态中的适用项。
4. **设计稿必须精准入镜且经像素验证**：真实渲染并等待字体/图表就绪，按目标位置使用滚动聚焦（`scrollTo`）、元素特写（`element`）或预交互（`actions`），截图后必须逐类看图检查，不以 HTML 源码存在代替视觉验证。
5. **契约与截图一一对应**：`screenshots/` 目录只保留 `ui-manifest.json` 声明的定稿 PNG，不留存探针图或 `final2.png` 等临时废图。
6. **不虚构外部交付**：未执行浏览器截图检查或未具备 Figma 画布写入能力时必须如实说明。

## 标准工作流

### 1. 确认交互边界与源码页面基线

1. 若为独立出图模式且存在影响页面主流程、权限或关键状态分支的未决项，使用结构化提问工具一次问清并给出基于代码的推荐项；联用模式直接消费已确认决策账本。
2. 从目标路由出发，按完整页面定位链路取证，禁止跳过父级壳子只读局部子组件：
   - **路由与壳子回溯链**：路由配置（如 `src/config/routes.tsx`）→ 绑定的 Layout 组件（明确有无顶栏、侧栏宽度与主题、是否无侧栏路由组）→ 菜单配置（如 `menuSider.tsx`）与当前高亮项。
   - **页面承载与区块坐标**：确认目标界面是独立路由页还是挂载在列表页之上的全宽弹窗/抽屉（如 `TaskDetail` Modal）→ 页面分栏/Tab → 目标改动区在整页中的纵向位置（首屏或中下屏）、存量字段顺序、样式文件（`.less`）与静态资产（如 `src/assets/*.svg`、`config/fonts/*`）。
   - **运行态基线采集（可用时优先）**：若本地开发服务已运行或用户提供了可访问环境 URL / 登录态（`storageState`），优先访问真实页面核对计算样式或截取现状基线。

### 2. 定义 UI 画板契约（`ui-manifest.json`）

在编写原型前先创建 `docs/<主题>-prototype/ui-manifest.json`，格式见 [画板清单示例](./assets/ui-manifest.example.json)：

- 清单级标明 `mode`：
  - `"incremental"`：存量页面局部改动，**必须**填写 `sourceAnchor`（`route`、`layout`、`pageFile`，指向仓库真实文件）；
  - `"redesign"`：全新页面或整页重设计。
- 每个画板必须包含：
  - 稳定唯一 `id`、`title`、带导出态的 `path`（如 `?screen=list&clean=1`）、纯 PNG 文件名 `file`；
  - `proves`：一句话说明该画板证明的业务状态与交互规则；
  - `requirements` / `acceptanceCriteria`：与 PRD Skill 联用时必填（对齐开发规格版 `FR-xx` / `AC-xx`）；独立出图模式选填；
  - 精准截图参数（按需）：
    - `captureMode`：`"viewport"`（默认固定视口）、`"element"`（按 `selector` 截取弹窗/局部模块特写，可配 `padding`）或 `"fullPage"`（全页长图）；
    - `scrollTo`：视口截图前滚动聚焦的目标选择器（用于中下屏区块）；
    - `waitForSelector` / `waitMs`：异步渲染等待；
    - `actions`：截图前自动执行的交互序列（`click`、`hover`、`fill`、`select`、`press`、`scroll`、`wait`）。

选择画板时聚焦**本次实际发生界面或状态变化**的关键业务流与阻断/异常态；禁止为“未发生变动的其他模块/任务类型维持原逻辑”单独创建无变更对照画板，也不为细微 hover 拆冗余废图。

### 3. 执行 UI 设计依赖门禁

生成 UI 前确认 `ui-ux-pro-max` 已完整安装，兼容以下布局：

```text
# 官方 CLI 生成的项目级 Skill（优先）
.github/skills/ui-ux-pro-max/SKILL.md
.github/skills/ui-ux-pro-max/scripts/search.py
.github/skills/ui-ux-pro-max/data/

# 用户级 Skill
~/.copilot/skills/ui-ux-pro-max/SKILL.md

# 旧版项目 Prompt 布局（兼容）
.github/prompts/ui-ux-pro-max.prompt.md
.github/prompts/ui-ux-pro-max/scripts/search.py
.github/prompts/ui-ux-pro-max/data/
```

使用自带依赖工具检查（Windows 中文工作区路径下建议先声明 UTF-8 编码）：

```powershell
$env:PYTHONUTF8 = '1'
py .github/skills/prd-with-ui-design-delivery/scripts/ensure_uiux.py --check
```

若未安装，先 `--dry-run` 预览来源与目标目录并告知用户，再按环境确认策略执行项目级安装：

```powershell
py .github/skills/prd-with-ui-design-delivery/scripts/ensure_uiux.py --dry-run
py .github/skills/prd-with-ui-design-delivery/scripts/ensure_uiux.py --install
```

`--install` 执行官方 `npx --yes ui-ux-pro-max-cli@latest init --ai copilot` 并在完成后复检。发现残缺目录时工具拒绝自动覆盖，须报告路径并经用户确认后再处理。若 `node`、`npx` 或 Python 3 缺失，提示用户安装对应运行时，不得调用系统包管理器；安装失败时停止 UI 生成并如实说明，不得拿通用审美建议冒充检索结果。

### 4. 使用 ui-ux-pro-max 建立设计依据

读取检查结果输出的 `instruction_file` 并使用 `search_script` 查询（脱敏关键词，不含私有业务机密）：

1. **存量页面局部改动（`incremental`）**：冻结现有 Layout 壳子、菜单与非改动区结构；仅对本次新增/变更的局部组件或交互执行单一意图的 `--domain` 与 `--stack` 查询，**严禁用检索建议重排存量非改动区域**。
2. **已有设计系统的全新页面（`redesign`）**：复用仓库真实 Layout 壳子、字体与品牌 Token，执行 `--domain` 和 `--stack` 查询规划主体内容区。
3. **新产品或无设计系统**：运行 `--design-system`（指定 `density`、`motion`、`variance`）建立整体视觉规范。
4. 结果为空或偏题时最多收窄重试一次；与仓库现有技术栈/品牌规范冲突时以仓库规范为准。

### 5. 编写高保真多状态 HTML 原型

按 [UI 设计与交互规范](./references/ui-design-standards.md) 编写 `docs/<主题>-prototype/index.html`：

1. 默认桌面视口 `1600×1000`（用户另有指定或需补充移动端 `390×844` 除外）。
2. 直接复用仓库真实静态资产（如 SVG Logo、本地字体）与对应 `.less` 色值/圆角/边框样式。
3. 通过 `?screen=<id>` 切换各业务状态画板；`clean=1` 参数必须隐藏所有画板切换栏和调试浮层。
4. 使用真实业务术语、字段与状态数据，禁止 `Lorem Ipsum` 占位文案。
5. 异步流程体现进度与失败恢复；危险或阻断操作在主操作附近明确展示原因与影响范围。
6. 若需在单屏同时呈现顶部步骤条与中下部多张记录卡，合理控制容器内边距避免内层滚动把关键上下文挤出视口；遮罩弹窗使用 `element` 特写时建议 `padding: 0` 防止边缘漏出底层阴影。

### 6. 启动静态服务、精准截图与像素自检

从能覆盖原型及所引用仓库静态资源的共同根目录启动 HTTP 服务：

```powershell
npx --yes http-server . -p 4173 -c-1
```

运行 [截图工具](./scripts/capture_ui.py) 批量渲染出图（支持 `--strict-overflow`，若截需登录的本地真实服务可传 `--storage-state`）：

```powershell
py .github/skills/prd-with-ui-design-delivery/scripts/capture_ui.py `
  --manifest docs/<主题>-prototype/ui-manifest.json `
  --base-url http://127.0.0.1:4173 `
  --output-dir docs/<主题>-prototype/screenshots `
  --strict-overflow
```

截图完成后，**必须使用图片查看工具逐张人工检视生成的 PNG**：确认壳子与真实系统一致、目标改动区域完整入镜无裁切、无横向滚动溢出、字体图标与图表渲染完整、干净态无调试条。发现瑕疵必须修改原型或 manifest 参数后重拍。

### 7. 执行 UI 产物校验门禁

按 [UI 交付质量门禁](./references/quality-gates.md) 检查，并运行纯标准库 [UI 校验工具](./scripts/validate_ui.py)：

```powershell
# 独立出图模式
py .github/skills/prd-with-ui-design-delivery/scripts/validate_ui.py `
  --manifest docs/<主题>-prototype/ui-manifest.json `
  --screenshots docs/<主题>-prototype/screenshots `
  --prototype docs/<主题>-prototype/index.html

# 与 prd-from-requirements-and-code 联用模式（强制校验需求与 AC 关联元数据）
py .github/skills/prd-with-ui-design-delivery/scripts/validate_ui.py `
  --manifest docs/<主题>-prototype/ui-manifest.json `
  --screenshots docs/<主题>-prototype/screenshots `
  --prototype docs/<主题>-prototype/index.html `
  --require-prd-links
```

校验通过后：
- **独立出图模式**：直接向用户交付原型路径、画板契约与截图清单；
- **PRD 联用供图模式**：将通过校验的 `ui-manifest.json` 与 `screenshots/*.png` 交由 [prd-from-requirements-and-code](../prd-from-requirements-and-code/SKILL.md) 嵌入双版 PRD 并执行文档及 DOCX 门禁。

## 工具与依赖

| 工具 | 用途 | 获取方式 |
|---|---|---|
| 结构化提问工具 | 独立模式下关键交互分支澄清 | VS Code 内置工具 |
| 搜索与文件读取工具 | 路由、Layout、组件与样式取证 | VS Code 内置工具 |
| 文件编辑工具 | 编写 HTML 原型与 `ui-manifest.json` | VS Code 内置工具 |
| `ui-ux-pro-max` | UI 设计系统、UX 与技术栈检索（强制依赖） | 缺失时由 [ensure_uiux.py](./scripts/ensure_uiux.py) 调用官方 CLI 安装 |
| Playwright | 独立浏览器渲染、字体就绪等待、预交互与精准截图 | 由 [capture_ui.py](./scripts/capture_ui.py) 通过 `npx --yes -p playwright` 驱动（支持自动回退本机 Chrome/Edge） |
| `http-server` / Python `http.server` | 为原型和仓库静态资产提供本地 HTTP 服务 | `npx --yes http-server` 或 Python 标准库 |
| 图片查看工具 | 截图后人工像素级视觉检查 | VS Code 内置工具 |

本 Skill 下所有 Python 脚本（`ensure_uiux.py`、`capture_ui.py`、`validate_ui.py`）均只依赖 Python 3 标准库，无需额外安装 pip 包，也不向业务项目的 `package.json` 写入依赖。

## 停止条件

以下任一情况成立时，不得声称 UI 设计图已完成定稿交付：

- 存在影响主界面结构或关键交互的未确认 P0 问题。
- 未安装或未实际执行 `ui-ux-pro-max` 检索。
- `incremental` 存量改动未声明真实存在的 `sourceAnchor`，或篡改了真实 Layout 壳子与非改动存量区域。
- 截图失败、资源加载 4xx/5xx、像素尺寸不符，或目标改动区被首屏裁切。
- 未对生成的 PNG 执行视觉查看检查，或 `screenshots/` 残留未在 `ui-manifest.json` 注册的临时图片。

## 最终回复（独立出图模式）

简洁列出：

- HTML 原型、`ui-manifest.json` 与 `screenshots/*.png` 的可点击路径。
- 回溯命中的真实路由、Layout 壳子与已覆盖的页面业务状态。
- 实际执行的 `ui-ux-pro-max` 检索、`capture_ui.py` 截图、像素检查与 `validate_ui.py` 校验结果。
- 明确限制说明（如未连接本地真实后端接口、未直接写入 Figma 画布等）。
