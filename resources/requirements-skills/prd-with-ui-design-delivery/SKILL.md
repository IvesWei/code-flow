---
name: prd-with-ui-design-delivery
description: '端到端生成或更新产品PRD、关键页面高保真HTML原型、固定视口截图，并把设计稿嵌入Word DOCX后完成内容与视觉交付验证。UI生成阶段强制使用经校验的ui-ux-pro-max设计智能套件，缺失时可按官方方式安装。Use when: 用户要求生成PRD并包含UI设计稿、根据需求和代码制作产品方案与原型、输出带页面截图的Word需求文档、更新PRD及交互设计。涵盖现状取证、需求澄清、权限/状态/数据/异常/验收、ui-ux-pro-max设计检索、HTML原型、Playwright截图、Figma导入和DOCX嵌图。Do not use for: 仅编码实现、只写简短需求摘要、仅做单页视觉稿或只润色现有文字。'
argument-hint: '提供需求材料、代码范围、目标版本、设计页面范围及期望输出文件名'
user-invocable: true
disable-model-invocation: false
---

# PRD With UI Design Delivery

将需求原文、代码现状和用户决策收敛为可评审、可实现、可验收的 PRD，同时交付与 PRD 规则一致的关键页面高保真原型、固定视口截图和内嵌设计稿的 Word 文档。

## 交付目标

默认交付以下文件，文件名可由用户覆盖：

```text
docs/<产品>_<版本>_<主题>_PRD.md
docs/<产品>_<版本>_<主题>_PRD_含UI设计稿.docx
docs/<主题>-prototype/index.html
docs/<主题>-prototype/ui-manifest.json
docs/<主题>-prototype/screenshots/*.png
```

只有 Markdown、DOCX、原型和截图均完成对应门禁，才能声称“完整交付”。若用户明确不要某一产物，可跳过并在最终回复说明。

### DOCX 单独优化模式

当用户只要求优化或重新生成 Word PRD 时，保留已确认的 Markdown 内容和已有 UI 图片，不重复执行需求澄清、代码取证、原型设计与截图阶段。直接执行以下闭环：

1. 检查 Markdown 标题、表格和本地图片引用是否完整。
2. 优先使用用户提供或仓库已有的企业 `.docx` 模板；没有模板时使用渲染器内置的企业 PRD 版式。
3. 生成新的 `.docx`，不得覆盖用户正在编辑的文件；默认在文件名增加版本号或“排版优化版”。
4. 运行 DOCX-only 结构校验；本模式不生成 PDF，也不以 PDF 作为验收依赖。
5. 本机安装 Microsoft Word 时，可直接打开 DOCX 并执行重新分页与字段更新检查，但不得额外导出 PDF。

## 必要输入

至少需要以下两类材料：

- 需求原文、旧 PRD、会议纪要、流程图或原型。
- 当前代码库或明确的页面、接口、模块范围。
- 目标版本、上线范围、明确不做事项。
- 品牌或现有设计系统、关键页面清单、目标视口。
- 文档标题、状态、日期、评审人等元信息。

若缺少会改变数据模型、权限、状态机、跨模块关系或 UI 主流程的信息，必须先澄清；仅缺少可配置参数时可给推荐默认值并放入评审关注项。

## 强制原则

1. **证据分层**：明确区分需求原文、代码现状、用户确认和合理推导。
2. **PRD 与 UI 同源**：页面上的字段、状态、动作、权限和错误提示必须能定位到 PRD 规则或验收标准。
3. **先规则后画面**：P0 决策未闭合时，只能输出讨论稿和探索性原型，不能标记定稿。
4. **关键状态成组设计**：不只画默认页面；至少覆盖正常、空、加载、错误、无权限及关键确认/阻断状态中的适用项。
5. **设计稿必须可验证**：使用固定视口真实渲染并检查像素，不以 HTML 源码存在代替视觉验证。
6. **Word 是正式交付物**：设计稿以本地 PNG 嵌入 DOCX，不使用外链图片。
7. **不虚构验证结果**：未执行视觉预览、浏览器检查或 DOCX 校验时必须明确说明。

## 标准工作流

### 1. 建立边界与决策账本

1. 提取业务目标、角色、对象、主流程、外部系统、成功指标和范围外事项。
2. 判断旧 PRD 是结构参考还是需要继承的需求基线。
3. 对问题分级：
   - P0：数据模型、唯一键、权限、状态机、跨模块关联、快照/实时、迁移。
   - P1：主要业务规则、异常处理、通知和删除影响。
   - P2：文案、阈值、批量上限、视觉偏好等可配置参数。
4. 使用结构化提问工具按 P0、P1、P2 分轮澄清；每题只包含一个决策并给出推荐项。
5. 记录决策账本。后续 PRD 和 UI 只能使用最新已确认规则。

### 2. 定向读取代码现状

从最接近目标行为的页面、服务、类型和调用方开始，按最小充分证据读取：

- 菜单、路由、页面入口和按钮权限。
- 列表、表单、详情、空状态和错误状态。
- API、类型、主键、关联方式、状态字段。
- 提交、撤回、删除、通知、快照、历史记录。
- 邻近测试、接口注释和现有设计系统。

形成内部证据表：需求域、代码锚点、当前行为、目标差距。代码只能证明现状，不能代替目标决策。

### 3. 编写 PRD

按 [PRD 结构与追踪规范](./references/prd-outline.md) 编写 Markdown，至少覆盖：

- 背景、目标、指标、范围和术语。
- 角色职责、权限矩阵、入口和导航。
- 对象关系、字段、唯一性、版本和状态机。
- 主流程、批处理、通知、审计和跨模块关系。
- 异常边界、非功能需求、埋点、迁移、灰度和风险。
- 使用 `AC-01` 连续编号的可执行验收标准。
- UI 页面清单与“页面/状态 → 需求 → AC”的追踪矩阵。

运行内容门禁后再开始高保真 UI。若主流程仍存在 P0 未决项，先回到澄清阶段。

### 4. 定义 UI 画板清单

创建 `ui-manifest.json`，格式见 [画板清单示例](./assets/ui-manifest.example.json)。每个画板必须包含：

- 稳定 `id`、页面标题、URL 或查询参数。
- 关联需求编号和验收标准。
- 该画板要证明的业务状态。
- 截图输出文件名。

选择画板时优先覆盖：核心列表、创建/编辑、关键配置、确认弹窗、影响分析、异步进度、错误/阻断和完成结果。不要为每个轻微交互创建独立画板。

### 5. 执行 UI 设计依赖门禁

生成 UI 前必须确认 `ui-ux-pro-max` 已完整安装。本 Skill 兼容以下布局：

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

依次检查：

1. `SKILL.md` 或兼容的 Prompt 文件存在且可读取。
2. `scripts/search.py` 存在。
3. `data/` 至少包含样式、颜色、字体、UX 指南和目标技术栈数据。
4. Python 3 可运行；该搜索脚本只使用标准库，不需要额外 pip 包。

使用本 Skill 自带的依赖工具检查：

```powershell
py .github/skills/prd-with-ui-design-delivery/scripts/ensure_uiux.py --check
```

若返回未安装，使用官方项目地址 [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) 提供的 GitHub Copilot CLI 安装方式。先预览来源、命令和目标目录，再执行项目级安装：

```powershell
py .github/skills/prd-with-ui-design-delivery/scripts/ensure_uiux.py --dry-run
py .github/skills/prd-with-ui-design-delivery/scripts/ensure_uiux.py --install
```

`--dry-run` 只进行本地预览，不调用安装器。`--install` 执行官方推荐的 `npx --yes ui-ux-pro-max-cli@latest init --ai copilot`，不做全局 npm 安装，不修改操作系统。安装来源、命令和落盘路径必须在过程更新中告知用户；若环境策略要求执行第三方安装前确认，则先获得用户确认。安装完成后工具会重新检查 `SKILL.md`/Prompt、`search.py` 和 `data/`，只有完整通过才能进入下一阶段。若发现部分安装，工具会拒绝自动覆盖；应先向用户报告残缺路径，在获得确认后由用户清理或修复，再重新执行安装。

若 `node`、`npx` 或 Python 3 缺失，不得自行通过 `winget`、`brew`、`apt` 等系统包管理器安装；应提示用户安装对应运行时。网络、权限或官方 CLI 安装失败时，保留错误输出并停止 UI 阶段；PRD 文本部分可以继续，但不能声称“含 UI 完整交付”。不得把通用审美建议冒充 `ui-ux-pro-max` 结果。

### 6. 使用 ui-ux-pro-max 建立设计依据

读取依赖检查工具输出的 `instruction_file`（新版为 `SKILL.md`，兼容布局为 Prompt）并遵循其查询契约；使用输出的 `search_script` 执行命令，不得硬编码安装目录。查询不得包含未脱敏的私有需求、客户数据或源代码，只使用产品类型、用户、平台、交互和视觉关键词。

执行规则：

1. **已有成熟产品设计系统**：先读取现有页面和设计 Token，再使用 `ui-ux-pro-max` 做一个明确的 UX 领域查询和一个目标栈查询；结果只用于补充，不覆盖现有品牌规范。
2. **新产品或缺少设计系统**：必须运行 `--design-system`，生成整体视觉方向、颜色、字体、密度、效果和反模式；根据产品类型设置 density、motion 和 variance。
3. **复杂交互**：针对表单校验、可访问性、数据表格、异步任务、图表或响应式问题追加单一意图的 `--domain` 查询。
4. **实现栈已知**：运行一次 `--stack <stack>` 获取实现约束。结果与仓库现有框架冲突时，以仓库版本和设计系统为准。
5. 对查询结果核验领域、首条结果和适用平台；结果为空或偏题时只允许收窄重试一次。

Windows 示例：

```powershell
$uiux = py .github/skills/prd-with-ui-design-delivery/scripts/ensure_uiux.py --check | ConvertFrom-Json

# 新产品或无现成设计系统
py $uiux.search_script `
  "enterprise test management dense desktop" `
  --design-system --density 8 --motion 2 --variance 4 -p "TMP"

# 已有系统的特定交互补充
py $uiux.search_script `
  "complex form validation error summary" --domain ux

# 技术栈约束
py $uiux.search_script `
  "dense data table modal form" --stack react
```

将经核验的结论整理为内部设计依据：产品类型、目标用户、平台、视觉方向、颜色/字体、信息密度、核心交互、可访问性要求和明确反模式。不要把搜索结果原文大段复制进 PRD。

### 7. 设计高保真 HTML 原型

原型优先复用仓库现有字体、颜色、间距、组件和导航模式，并结合已经核验的 `ui-ux-pro-max` 结果；无现有系统时以 `--design-system` 输出为设计起点，再按 [UI 设计与交互规范](./references/ui-design-standards.md) 收敛为可实现方案。

要求：

1. 默认桌面视口为 1600×1000，除非用户另有要求。
2. 每个画板可通过独立 URL 或 `?screen=<id>` 打开。
3. 提供 `clean=1` 等导出模式，隐藏原型导航、调试面板和说明控件。
4. 页面展示真实业务字段、状态和操作，不用无意义占位文案。
5. 异步流程展示进度、离开后恢复、失败阶段和重试入口。
6. 危险操作展示影响范围、阻断原因和后续处理。
7. 不把功能说明文字当作 UI 主体；复杂规则放在可展开帮助或 PRD 中。
8. Figma 官方 VS Code 扩展若无画布写入能力，不得声称已生成 Figma 文件；可通过 HTML-to-design 类插件导入经过验证的 URL。

### 8. 启动服务并截图验证

若原型引用仓库资源，从能覆盖这些资源的共同根目录启动静态服务，避免图片越出服务根：

```powershell
npx --yes http-server . -p 4173 -c-1
```

使用 [截图工具](./scripts/capture_ui.py) 根据 manifest 批量截图：

```powershell
py .github/skills/prd-with-ui-design-delivery/scripts/capture_ui.py `
  --manifest docs/<主题>-prototype/ui-manifest.json `
  --base-url http://127.0.0.1:4173 `
  --output-dir docs/<主题>-prototype/screenshots `
  --width 1600 --height 1000
```

截图必须使用独立 Playwright CLI，不使用 VS Code 集成浏览器截图桥接。检查每张 PNG 的实际尺寸，并人工查看代表性的列表、表单、抽屉/弹窗、流程和阻断页面。重点检查：横向溢出、操作列、分页、按钮、弹窗边缘、长中文、空状态和资源加载。

### 9. 将设计稿嵌入 PRD

在 Markdown 的 UI 章节使用标准图片语法引用本地截图：

```markdown
## 关键页面设计

### 需求解析

对应：REQ-AI-01、AC-19。

![AI需求解析](case-management-prototype/screenshots/ai-parse.png)
```

图片路径相对 Markdown 文件解析。使用 [DOCX 渲染器](./scripts/render_prd_with_ui.py)：

```powershell
py .github/skills/prd-with-ui-design-delivery/scripts/render_prd_with_ui.py `
  --input docs/<产品>_<版本>_<主题>_PRD.md `
  --output docs/<产品>_<版本>_<主题>_PRD_含UI设计稿.docx `
  --title "<产品> <主题>" `
  --version "V1.0" `
  --date "2026-09-21"
```

存在企业 Word 模板时增加 `--template docs/templates/company-prd-template.docx`。渲染器支持标题、段落、列表、引用、表格、粗体、行内代码和本地 Markdown 图片。图片按版心等比缩放并附带图注。内置版式采用 A4、首封面无页眉、正文页眉页码、自动更新目录、中文字体映射、章节防孤行、一级章节分页、表头跨页重复和表格行防拆分。模板模式继承模板中的主题与结构，并在此基础上应用 PRD 内容样式。

### 10. 执行交付门禁

使用 [交付校验工具](./scripts/validate_delivery.py)：

```powershell
py .github/skills/prd-with-ui-design-delivery/scripts/validate_delivery.py `
  --markdown docs/<产品>_<版本>_<主题>_PRD.md `
  --docx docs/<产品>_<版本>_<主题>_PRD_含UI设计稿.docx `
  --manifest docs/<主题>-prototype/ui-manifest.json `
  --screenshots docs/<主题>-prototype/screenshots `
  --required "权限矩阵" "异常与边界场景" "验收标准"
```

仅交付 DOCX 时省略 `--manifest` 和 `--screenshots`：

```powershell
py .github/skills/prd-with-ui-design-delivery/scripts/validate_delivery.py `
  --markdown docs/<产品>_<版本>_<主题>_PRD.md `
  --docx docs/<产品>_<版本>_<主题>_PRD_排版优化版.docx `
  --required "权限矩阵" "异常与边界场景" "验收标准"
```

门禁必须检查：

- Markdown 和 DOCX 可读取且核心章节存在。
- AC 编号无重复、无断号；manifest 引用的 AC 在 PRD 中存在。
- manifest 中每张设计稿均存在、尺寸正确且已嵌入 DOCX。
- DOCX ZIP 包结构有效，正文和表格可检索，内嵌图片数量符合预期。
- DOCX 使用 A4 页面、标题层级、页眉页脚、自动更新字段和表格跨页规则；封面标题不在正文重复。
- 文件大小、段落数、表格数和图片数非异常。

默认不生成 PDF。环境允许且用户需要时，优先使用 Microsoft Word 直接打开文档，更新目录并检查分页、宽表、长中文、图片清晰度和空白页；无法进行 Word 原生预览时必须在最终回复披露。

## 工具与依赖

| 工具 | 用途 | 获取方式 |
|---|---|---|
| `vscode_askQuestions` | P0/P1 决策澄清 | VS Code 内置工具 |
| 搜索与文件读取工具 | 代码现状取证 | VS Code 内置工具 |
| `apply_patch` | 创建或更新 PRD、原型和 Skill 文件 | VS Code 内置工具 |
| `ui-ux-pro-max` | UI 设计系统、UX、色彩、字体和技术栈检索；UI 阶段强制依赖 | 缺失时由 [依赖工具](./scripts/ensure_uiux.py) 使用官方 `ui-ux-pro-max-cli` 安装 GitHub Copilot 项目 Skill |
| `python-docx` | DOCX 生成、读取和嵌图 | `py -m pip install python-docx` |
| Playwright CLI | 固定视口真实截图 | `npx playwright screenshot`，首次可能下载浏览器 |
| `http-server` | 为原型和资源提供 HTTP 地址 | `npx --yes http-server` |
| 图片查看工具 | 人工像素检查 | VS Code 内置工具 |
| Microsoft Word | 可选 DOCX 原生预览、目录更新与分页检查 | 本机应用 |

安装依赖前先检查是否已存在。缺少 Python 依赖时执行：

```powershell
py -m pip install -r .github/skills/prd-with-ui-design-delivery/requirements.txt
```

不要为截图向业务项目写入 Playwright 依赖，优先使用 `npx` 临时执行。

## 停止条件

以下情况不得继续声称定稿：

- 存在未确认 P0 决策。
- UI 交付范围内未安装或未实际使用 `ui-ux-pro-max`。
- 关键页面没有对应需求或验收标准。
- 截图失败、尺寸不符、主要内容被裁切或资源加载失败。
- DOCX 未通过可打开性、ZIP 包结构或内嵌图片校验。
- 图片仅为外链或本机绝对路径，未真正嵌入 DOCX。

## 最终回复

简洁列出：

- Markdown PRD、含 UI 的 DOCX、HTML 原型、manifest 和截图目录。
- 已覆盖的关键流程与页面状态。
- 实际执行的截图、内容、DOCX 和 HTTP 校验。
- 仍未完成的限制，例如未进行 Word/PDF 视觉预览或未直接写入 Figma。

不要重复整份 PRD，不要把未验证的结果描述为通过。