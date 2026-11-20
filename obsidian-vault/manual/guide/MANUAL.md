# Obsidian 知识库插件编排手册

本插件遵循 OpenAI MCP 与 Gemini CLI 对 Obsidian 的结构化连接理念，采用「本地安全边界索引 + Obsidian 官方 CLI / 精确路径 URI 协同」双引擎工作。

## 1. 安全边界与数据无损原则

1. **仅限已登记 Vault 访问**：所有工具仅操作 `obsidian.json` 已注册或用户在插件工作台「添加库」亲选授权的知识库；未登记目录、`.obsidian`/`.git`/`.trash` 受保护目录以及库内符号链接均会被安全层拦截。
2. **未知库结构时先看概览**：首次操作某 Vault 时，先调用 `vault_status` 获取知识库 ID、默认 `inboxFolder`、高频 `#标签`、日记配置及最近编辑列表。
3. **非破坏性编辑保证**：
   - 正文追加（`append` / `prepend`）与章节编辑（`append-heading` / `prepend-heading` / `replace-section`）会自动识别 ``` 与 ~~~ 代码围栏（绝不会误切代码块里的 `#` 注释），并在未传 `frontmatter`/`tags` 时逐字节保留原有 YAML Frontmatter；
   - `replace-section` 替换目标标题行之后直到下一个同级或更高级标题之前的内容（包含其下级子标题），若存在同名章节请传入带井号层级的标题（如 `## 待办`）消歧；
   - 整篇覆盖（`overwrite`）、移入回收站（`delete`）以及白板整板覆盖（`canvas_ops` 的 `overwrite`）会先核验真实目标并弹出 Cindy 宿主确认框，用户取消时请尊重取消结果。

## 2. 常见多工具协作流程

### A. 回答基于个人知识库的问题
1. `search_notes` 用 1–3 个核心词定位候选笔记；
2. 对排名前列的笔记传精确 `path` 调用 `read_note`（长文可传 `heading` 只读相关章节）；
3. 若涉及脉络梳理，调用 `graph_links` 查看 `backlinks`、`unlinkedMentions` 与二跳关联笔记补充背景；
4. 在回复中标明引用的笔记路径或 `[[笔记名]]`。

### B. 构建或更新思维白板 (`.canvas`)
1. 先用 `search_notes` 确认要引用的库内笔记精确路径；
2. 新建白板用 `canvas_ops({ action: "create", path: "主题白板.canvas", nodes, edges })`；向已有白板增改节点用 `action: "upsert"`（按 `id` 无损合并，保留 `group`、`subpath`、`fromEnd`/`toEnd` 等所有既有属性）；
3. 可选调用 `open_in_obsidian` 让用户在桌面端直接查看。

### C. 交互式工作台说明
- 用户口头要求「打开 Obsidian 面板 / 预览笔记界面」时，模型应调用 `open_workbench` 工具；
- `complete_notes` 与 `pick_vault_dir` 仅供宿主 `@` 输入补全与工作台页面内部调用，模型日常读写无需调用它们。
