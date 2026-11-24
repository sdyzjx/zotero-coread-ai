<p align="center">
  <img src="assets/logo.svg" width="96" height="96" alt="CoRead AI logo" />
</p>

<h1 align="center">CoRead AI · AI 伴读</h1>

<p align="center"><b>和 AI 一起精读论文，每一句都回到原文。</b><br />
Zotero 7–10 插件 · 文章脉络引导注意力 · 在 PDF 里就地提问 · 读懂的内容沉淀为批注</p>

<p align="center">
  <a href="https://coread.doosam.uk">官网与下载</a> ·
  <a href="https://coread.doosam.uk/#install">安装说明</a> ·
  <a href="#模型来源">DeepSeek / Claude Code / Codex / Antigravity</a>
</p>

---

## 为什么需要「协同精读」

把 PDF 丢给 AI、拿回一页摘要，看起来省时间，但一篇论文最有价值的信息往往在这一步丢掉了：

| 传统 AI 读论文 | 丢掉的是什么 |
| --- | --- |
| **压缩**：二十页压成五条要点 | 实验条件、适用范围、限定语与负面结果最先被删掉，你拿到的是别人对结论的转述 |
| **脱离原文**：回答没有页码和原句 | 无法核对，正确的概括与编造的细节混在一起 |
| **截断**：上下文放不下全文 | 附录、消融实验与图表被悄悄截掉，回答照样自信 |
| **留不下来**：理解停在聊天记录里 | 不在 PDF 上，也不在文献库里，下次打开从头开始 |

CoRead AI 不替你读论文，而是陪你读：

- **引导注意力**：「文章脉络」按逻辑角色（背景 → 问题 → Gap → 方法 → 实验 → 结果 → 结论）把论文拆成一棵结构树，每个节点锚定到原文句子，按 Zotero 批注色着色。先看清结构，再决定精读哪里。
- **AI 原生辅助阅读**：选中文字即可解释 / 翻译 / 总结 / 追问，框选图表与公式让 AI 真正"看图"；文章级对话里，Agent 按 概览 → 检索 → 精读 的顺序渐进查阅原文，回答带可点击页码，而不是把全文硬塞进上下文。
- **产出批注**：Agent 在原文上创建高亮与便签、写入批注评论、按需生成结构化子笔记；每次对话自动总结结论，在其他论文的会话中也能查到。读过的东西留在你的文献库里。

## 快速开始

1. 从 [coread.doosam.uk](https://coread.doosam.uk) 下载 `.xpi`（或自行 `npm install && npm run build`）。
2. Zotero → 工具 → 插件 → 齿轮 →「从文件安装插件…」，选择该文件。插件之后会自动从官网检查更新。
3. Zotero 设置 → **CoRead AI**（或 工具 → CoRead AI 设置…）→「模型来源」：填入 DeepSeek API Key，或检测本机已登录的 Claude Code / Codex / Antigravity CLI 并「设为默认来源」。
4. 打开一篇 PDF：左侧点「生成文章脉络」，选中文字用 AI 按钮，`⌘/Ctrl + Shift + L` 打开聊天面板，`⌘/Ctrl + Shift + K` 框图提问。

> 原名 Zotero Pi Agent。直接安装新版即可覆盖，设置、会话与脉络缓存都会保留。

## 功能详解

**辅助阅读（划词）**
- 在 PDF 中选中文字，选择弹窗下方会出现 AI 伴读操作栏：**解释 / 翻译 / 总结 / 问 AI… / 引用到聊天**（可在设置里自定义）。
- 结果显示在选区旁的浮动卡片中，可继续追问、复制，或「保存为高亮批注」。翻译卡片的大小按文本量自适应（不沿用问 AI 卡片记住的大小）。卡片可拖动标题栏移动，拖动任意边或角（右下角有抓手）调整大小，大小会被记住。
- 翻译走快速模型（不开启思考），其余操作在该文章当前会话中由 agent 执行，因此会保留在聊天记录里。

**文章脉络（PDF 左侧常驻悬浮导航）**
- 阅读器左侧常驻一个悬浮的脉络导航卡片。点击「生成文章脉络」才会分析当前论文（不会自动为每篇文章生成）。生成过程是流式的：模型边写，树边"长"出来——每个新节点先从父级引出一小段分支，再从左向右展开，章节编号弹出，摘要随后淡入；已显示的节点不会被刷新或重绘，每段文字写完整才出现；等待第一个节点时，顶部有一个固定高度、可收起的小窗实时显示模型的思考过程（收起状态会记住），第一个节点出现后自动隐藏；顶部显示阶段与耗时，可随时取消；结果缓存在插件数据库中，↻ 可重新分析。
- 思考强度在设置中可选，默认「中」；模型不支持的强度会改用较低一档（DeepSeek Flash 只有 低 / 高 / 最大，「中」按「低」运行）。
- 第一章固定为 **摘要拆解**：把摘要逐句对应到同样的逻辑角色（研究论文：背景 / 问题 / 已有方法 / Gap / 方法 / 实验 / 结果 / 结论；综述：领域 / 动机 / 范围 / 分类框架 / 主要发现 / 挑战与展望），点击即高亮摘要中的那句话。
- 每个角色有一种代表颜色，取自 Zotero 的标准批注色：背景 蓝 · Gap 红 · 方法 紫 · 结果 橙 · 结论 绿（问题 / 传统方法 灰、相关工作 洋红、实验 黄）。导航中的编号与标题、原文高亮框与重点句标注都用该节点的代表色；重点句「划重点」默认也用这个颜色保存，便于在 Zotero 批注侧栏按颜色筛选。
- 研究论文按 **任务背景 → 传统方法及问题 → 近期工作（每条路线：怎么做、还剩什么问题）→ 核心 Gap → 本文方法 → 实验设置 → 数据结果 → 结论** 拆解；综述论文按 **领域与范围 → 发展脉络（按时间分阶段）→ 研究分支（分支 → 子分支 / 代表方法）→ 评测与对比 → 开放问题 → 结论** 拆解，并标出分支之间的关系（演进 / 改进 / 融合 / 对立 / 解决），以左侧弧线和关系标签呈现，悬停可高亮相关分支。
- 以章节编号的可折叠树状图显示在阅读器左侧的独立一栏，PDF 显示区相应右移、不被遮挡；拖动导航右边缘可调整宽度（双击恢复默认），PDF 区域实时跟着变，「适应页宽 / 自动」缩放下页面会随之重新缩放。阅读器太窄时改为悬浮在页面左边缘，鼠标移开会变淡。鼠标移入才显示按钮与页码标签；当前阅读位置所在章节有细色条提示。点 **‹** 收起为左边缘的「脉络」标签，点标签、阅读器工具栏的脉络按钮或 工具 → CoRead AI 文章脉络 重新展开。
- 点击节点 / 页码标签跳转到对应段落或图表，并画出一条从节点指向原文的半透明引导线（约 3 秒后淡出）和柔和的段落框，框内的重点句加深底色并加下划线。高亮会一直保留，直到点击文章其他位置；不会留下批注。
- 导航标题栏的 **重点** 开关：一键在文中显示 / 隐藏脉络里所有节点的重点块（浅色背景）与重点句（加深底色 + 下划线），各用节点的代表色；多个节点指向同一段落时只显示第一个。开关状态会记住；点击文中的重点句会在导航中定位到对应节点。
- Zotero 阅读器自己的弹窗（批注、选区、引用预览等）与导航重叠时，弹窗显示在导航前面：导航只在弹窗所在区域留空（点击直接作用于弹窗），其余部分照常显示和使用；文中的高亮也会在弹窗处留空。
- 鼠标移到重点句上会弹出操作条：划词操作（解释 / 翻译 / 总结 …，与设置中的划词操作一致）、**问 AI**（把这句话引用到右侧 AI 侧栏）和 **划重点**（保存为高亮批注）。
- 阅读区域宽度变化时（调整脉络栏或右侧 AI 侧栏宽度、窗口大小），只调整论文区域与缩放：「适应页宽 / 自动」由阅读器重新适配；固定缩放按比例缩放且不超过页宽，保证每行完整可见，并保持视野中心的内容位置不变、页面水平居中。图表区域根据图注与正文行自动推断。
- 每个节点的锚点由模型给出原文引用，再用 PDF 文字层校正页码，找不到的退化为页码跳转。Agent 的 `paper_overview` 也会附带这份脉络。

**框图提问 / 看图**
- 阅读器工具栏的框图按钮或 `⌘/Ctrl + Shift + K`：在 PDF 上拖框选择图表、公式或表格，卡片中可选「解释这张图 / 转写内容（公式→LaTeX、表格→Markdown）」或直接提问，并可「保存为图片批注」。框选本身不会创建批注。
- 已有的图片（区域）批注：右键 →「AI 伴读 · 问 AI（这张图）」。
- 聊天面板输入框左侧的 📷：框选区域作为图片附件随消息发送（可附多张）。
- Agent 工具 `view_page_image`：agent 可以自己查看某页、某块区域或某个图片批注（先用 `paper_search "Figure 3"` 找页码）。
- 看图需要支持图片输入的模型：DeepSeek V4.1 Flash、Claude Code 或 Codex。纯文本模型（如 V4 Pro）发送图片时会话自动切换到可看图的模型；在纯文本模型的会话里调用 `view_page_image` 时，由可看图的模型看图并把文字描述交回。
- 渲染使用阅读器自带的 pdf.js，按原始颜色输出（不受深色主题影响），长边不超过 1600px。

**文章级聊天面板**
- 拖动标题栏可移动；拖到窗口左右边缘会**自动吸附停靠**（停靠时阅读器会让出空间），拖离边缘恢复浮动。
- 可收起为边缘标签 / 浮动气泡，点击展开；可拖动边缘或四角调整大小。状态会被记住。
- 快捷键 `⌘/Ctrl + Shift + L` 打开 / 关闭；阅读器工具栏的 CoRead AI 按钮、工具菜单中也有入口。
- 聊天记录**以文章为单位**保存（`<Zotero 数据目录>/zoteropi.sqlite`），同一篇文章下可新建、切换、重命名、删除会话。
- 每轮对话后自动生成会话**标题与结论**（📌 按钮查看），其他文章的会话可以查阅这些结论。
- 每轮回复中的思考与工具调用会折叠成一个「处理过程」块：默认折叠，只显示最新一步（运行中的工具会实时更新），标题显示工具调用次数、失败数、耗时，点击展开全部过程。
- 回复全程流式输出；输入框上方的活动条实时显示当前阶段（等待 / 思考 / 准备调用 / 正在执行的工具及耗时 / 输出回答），消息中的工具卡片显示运行状态与耗时，可展开查看参数与结果。
- 支持 Mermaid 图表：```mermaid 代码块渲染为图（流程图、时序图、类图、思维导图等），流式输出结束后渲染；每张图可切换「源码」、复制、「放大」到独立窗口（缩放 / 拖动）。图表以纯图片显示（不执行脚本），Mermaid 库首次用到时才加载。
- 所有消息支持 Markdown 与 LaTeX 公式（`$…$`、`$$…$$`、`\(…\)`、`\[…\]`，KaTeX 渲染）；`[p. 5](page:5)` 形式的页码引用可点击跳转。

**笔记与批注格式**
- Zotero 的批注评论只支持粗体 / 斜体 / 上下标。Agent 写入的批注评论（以及划词卡片「保存为批注」）会把 Markdown 转换为这些格式，LaTeX 公式转为 Unicode（如 `$\hat{A}_t = r_t(\theta)$` → Â<sub>t</sub> = r<sub>t</sub>(θ)）。
- 限制 agent 写过于复杂的内容：批注评论 ≤ 300 字、不含标题 / 表格 / 代码块 / 行间公式 / 嵌套列表；子笔记 ≤ 3000 字、标题最多三级、列表最多两层、表格最多两张、不含 Mermaid 与 HTML。超出时工具会把具体问题返回给 agent 让它改写。

**Agent 工具**

| 类别 | 工具 |
|---|---|
| 当前论文（渐进式披露） | `paper_overview` 结构概览 → `paper_search` 定位 → `paper_read` 按页 / 章节读取（带截断与 offset 续读）、`get_annotations`、`view_page_image`（看页面 / 区域 / 图片批注） |
| 批注 | `create_highlight`（按原文定位到 PDF 字符坐标）、`create_note_annotation`（页边便签）、`update_annotation_comment`、`go_to_page` |
| 文献库 | `library_search`，上述 paper_* 工具均可传 `item_key` 读取其他文献 |
| 历史会话 | `list_sessions`（含结论）、`read_session`、`search_annotations`（全库批注）、`save_conclusion` |
| 笔记 | `create_zotero_note`（Markdown → Zotero 笔记，标题 / 列表 / 表格 / LaTeX 公式由笔记编辑器渲染；过长或过于复杂会被退回让 agent 精简） |
| 网络 | `web_search` / `web_fetch`（默认 DeepSeek Search / Fetch API，失败回退 DuckDuckGo / 本地抓取；可选 Tavily、Brave、SearXNG） |
| 学术 | `arxiv_search`、`arxiv_read`（arXiv HTML 全文，按章节读取，公式转 LaTeX）、`scholar_search`（Google Scholar，被拦截时回退 Semantic Scholar） |

pi 本身只内置了 bash / 读写文件等「电脑操作」类工具（在 `pi-coding-agent` 中），按需求未接入；上表工具均为本插件实现。

## 模型来源

| 来源 | 说明 |
| --- | --- |
| DeepSeek API | DeepSeek V4.1 Flash（`deepseek-flash`，默认）与 V4 Pro，来自 pi-ai 的 DeepSeek provider；可添加其他模型 ID |
| Claude Code | 调用本机 `claude` CLI（使用其登录账号）；模型 ID `claude-code` 或 `claude-code:<model>`（如 `claude-code:sonnet`） |
| Codex | 调用本机 `codex` CLI；`codex` 或 `codex:<model>` |
| Antigravity | 调用本机 `agy` CLI；`agy` 或 `agy:<model>`；需在设置中一键安装 Zotero 工具插件 |

- 设置页「模型来源」以标签页列出各来源：状态、可执行文件检测、可选模型、测试对话，「设为默认来源」会同时把对话和翻译 / 结论指向该来源。「模型分配」集中设置对话 / 思考强度 / 翻译与结论 / 脉络分析所用模型，菜单按来源分组。
- 聊天框下方的模型菜单可以在会话中途切换来源：同一份聊天记录继续，CLI 没见过的轮次会作为上下文交给它。
- 翻译、会话结论、文章脉络、图片描述也可以走 CLI（一次性调用，不持久化会话）；没有 DeepSeek Key 也能使用全部功能（网络搜索回退到 DuckDuckGo）。

### CLI 接入原理（参考 Lattice / Synara 的做法）

- **工具兼容**：插件在 Zotero 本地服务器（`127.0.0.1:23119`）上提供无状态 MCP 端点 `/zoteropi/mcp/<token>`，把上表的全部 pi 工具原样暴露给 CLI（同样的参数校验、顺序执行约束与结果，包括图片）。每轮对话生成一次性 token；工具调用由 MCP 桥执行并生成与内置 Agent 相同的工具卡片。
- **最小权限**：Claude Code 以 `--tools ""` 关闭内置工具、`--strict-mcp-config` 只连 Zotero、`--permission-mode dontAsk` 只放行 `mcp__zotero`；Codex 使用只读沙箱并只批准 zotero MCP；默认「隔离 CLI 配置」不加载 CLI 自己的 hooks / MCP / 用户设置。Antigravity 只读全局 MCP 配置，因此用一个 `zotero-pi` agy 插件指向固定端点，Zotero 把 agy 轮次串行化并路由到当前会话；未在对话时该端点不提供任何工具。
- **工作区管理**：每篇论文一个工作目录 `<Zotero 数据目录>/zoteropi/papers/<库ID>_<条目Key>/`（可在设置中更改根目录），包含 `AGENTS.md`（Agent 说明）、`paper.json` 与随消息发送的图片；CLI 的会话按目录续接，聊天会话与 CLI 会话 ID 的对应关系保存在插件数据库中。设置页可查看各工作区大小、打开 / 删除、清理已删除条目的工作区与旧附件。

## 安装与构建

安装步骤见上文「快速开始」或[官网安装说明](https://coread.doosam.uk/#install)。从源码构建：`npm install && npm run build`，得到 `build/zotero-coread-ai-<version>.xpi`。

**预置 API Key（本地构建）**：复制 `.env.example` 为 `.env`（已在 `.gitignore` 中，不会提交）：

```
DEEPSEEK_API_KEY=sk-...
```

构建时会把它写入插件的默认偏好，安装后无需再填写（设置页中修改会覆盖默认值）。这样生成的 xpi 内含 Key，请勿分享；对外发布请用 `npm run build:public`（不读取 `.env`）。

## 开发

```bash
npm run typecheck   # TypeScript 检查
npm test            # 纯逻辑单元测试（原文定位、标题识别、Markdown 公式、脉络解析与锚点、批注格式、MCP 协议、CLI 命令行与输出解析）
npm run build:dev   # 开发构建（含 sourcemap 与本地调试端点）
```

开发构建会在 Zotero 本地服务器上注册 `POST /zoteropi/eval` 调试端点（仅 `build:dev`，正式构建不包含），用于自动化集成测试。

```bash
npm run site          # 构建官网到 build/site（公开 xpi + Zotero 自动更新用的 updates.json）
npm run deploy:site   # 构建并部署到 Cloudflare（wrangler.jsonc：coread.doosam.uk）
```

为了让旧版用户平滑升级，内部标识保持不变：插件 ID `zotero-pi-agent@zoteropi.local`、偏好前缀 `extensions.zoteropi.`、数据库 `zoteropi.sqlite`、全局对象 `Zotero.ZoteroPi`。

### 结构

```
addon/                 插件静态文件（manifest、bootstrap、prefs、HTML/CSS、图标）
assets/logo.svg        Logo（打开的书 + 高亮句 + AI 星芒）
site/                  官网（coread.doosam.uk）静态页面
scripts/               build.mjs（插件构建）、site.mjs（官网构建）
src/core/              运行在插件沙箱中的核心
  llm.ts               pi-ai 模型 / DeepSeek provider / API Key 注入；CLI 模型的列表与一次性调用路由
  sessions.ts          每个会话一个引擎（pi Agent 或 CLI 引擎，可中途切换）；持久化、快照、自动结论
  mcp/                 MCP 协议（protocol.ts）与 Zotero 本地服务器上的工具桥（bridge.ts）
  agents/              CLI 接入：命令行（providers）、输出解析（parsers）、进程（proc）、运行（runner）、
                       会话引擎（engine）、工作区（workspace）、agy 插件（agy）
  tools/               agent 工具（论文、批注、文献库、网络、学术）
  paper.ts text.ts     全文抽取（PDFWorker，按页）、标题识别、搜索、原文匹配
  annotate.ts          高亮 / 便签写入（Zotero.Annotations.saveFromJSON）
  outline*.ts          文章脉络：数据结构与提示词、锚点校验、图表区域推断、生成队列与缓存
  ui/                  主窗口浮动面板、划词卡片、阅读器钩子、左侧文章脉络（outline-gutter.ts）、品牌标记（mark.ts）
src/web/               聊天界面与设置页（Preact，chrome:// 页面）
src/shared/markdown.ts markdown-it + 数学公式扩展（关闭原始 HTML）
src/shared/note-format.ts  批注评论格式转换（Markdown / LaTeX → Zotero 支持的子集）与笔记复杂度检查
```

## 说明

- API Key 以明文保存在 Zotero 偏好设置（`prefs.js`）中。
- CLI 模型使用各 CLI 自己的登录与计费；首次调用需要启动 CLI，通常比 API 慢几秒。Zotero 本地服务器需保持开启（默认开启，供 Zotero Connector 使用）。
- DeepSeek Search / Fetch 按次计费（约 $0.75 / 千次成功请求），可在设置中改用免费的 DuckDuckGo / 本地抓取。
- 自动创建高亮需要 PDF 附件；agent 会在后台打开阅读器以获取字符坐标。
