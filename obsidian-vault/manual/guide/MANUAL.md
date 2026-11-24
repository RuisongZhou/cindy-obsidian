# Obsidian 知识库插件编排手册

插件通过本机 Markdown 索引读写 Obsidian 知识库。需要把结果打开到 Obsidian 桌面端时，使用 `open_in_obsidian`。

## 1. 安全边界与数据无损原则

1. **仅限已登记 Vault 访问**。工具操作 `obsidian.json` 中已注册或用户在工作台「添加知识库」亲选的目录。普通笔记操作会拦截受保护目录和符号链接。用户从工作台切换知识库时，聊天工具仍使用插件设置中的默认库。用户明确提到另一库时，传其 ID 或精确路径。
2. **未知库结构时先看概览**：首次操作某 Vault 时，先调用 `vault_status` 获取知识库 ID、默认 `inboxFolder`、高频 `#标签`、日记配置及最近编辑列表。
3. **非破坏性编辑保证**：
   - 正文追加（`append` / `prepend`）与章节编辑（`append-heading` / `prepend-heading` / `replace-section`）会自动识别 ``` 与 ~~~ 代码围栏（绝不会误切代码块里的 `#` 注释），并在未传 `frontmatter`/`tags` 时逐字节保留原有 YAML Frontmatter；
   - `replace-section` 替换目标标题行之后直到下一个同级或更高级标题之前的内容（包含其下级子标题），若存在同名章节可使用 `headingPath` 按父标题消歧；
   - 整篇覆盖（`overwrite`）、移入回收站（`delete`）以及白板整板覆盖（`canvas_ops` 的 `overwrite`）会先核验真实目标并弹出 Cindy 宿主确认框，用户取消时请尊重取消结果。

## 2. 常见多工具协作流程

### A. 回答基于个人知识库的问题
1. `search_notes` 用 1–3 个核心词定位候选笔记；
2. 对排名前列的笔记传精确 `path` 调用 `read_note`（长文可传 `heading` 只读相关章节）；
3. 若涉及脉络梳理，调用 `graph_links` 查看 `backlinks`、`unlinkedMentions` 与二跳关联笔记补充背景；
4. 在回复中标明引用的笔记路径或 `[[笔记名]]`。

需要列出具体目录时，调用 `list_notes`。`depth: 1` 返回直接子项，`extension: "md"` 只过滤文件，目录仍返回。`truncated` 表示因扫描上限或不可读目录而未列全。

需要遍历搜索结果时，原样传回 `nextCursor`，保持知识库、查询、筛选和分页参数一致。`STALE_CURSOR` 表示需要从第一页重搜。`truncatedScan` 和 `partialBodyIndex` 描述索引覆盖范围，`matchesTruncated` 描述单篇正文命中是否达到返回上限。

`matches` 的 `line` 和 `column` 从 1 开始，相对于去掉 YAML Frontmatter 的 Markdown 正文。`start`、`end` 为 UTF-16 零基偏移，`end` 不含在内。`body.slice(start, end)` 应等于 `text`。只命中标题、别名或其他元数据时，正文命中数组可能为空。

### 精确编辑标题、块和文本

- `read_note` 的 `headings[].path` 是从文档根标题到目标标题的数组。读取或写入重名章节时，把该数组传给 `headingPath`。完整路径缺失或仍重复时，先请用户核对目标。`heading` 仍适用于唯一标题或可通过井号层级区分的旧调用。
- 读块可用 `path` 加 `blockId`，或将 `[[笔记#^块ID]]` 传给 `title`。块编辑可用 `append-block`、`prepend-block` 和 `replace-block`。修改限于能安全定位的块，保留原标记。围栏代码中的模拟 ID、重复 ID 或会改变引用边界的写入会被拒绝。
- `replace_in_note` 的 `heading`、`headingPath`、`blockId` 最多指定一项。省略时查找整篇正文，Frontmatter 不参与。`find` 按字面及大小写匹配。写入前可以 `dryRun: true` 获取 `matchCount` 和 `mtimeMs`。唯一匹配时可直接替换。确需多个匹配时使用 `replaceAll: true`，并可同时传 `expectedCount` 和 `expectedMtimeMs`。

### 写入范围与标签

- `vault_status` 返回当前库的 `writePolicy`。`readOnly` 为真时禁止写入。`writeFolders: null` 表示全库，空数组表示禁止全部写入，目录数组允许对应目录及其子目录。用户可从工作台保存规则。遇到 `VAULT_READ_ONLY` 或 `WRITE_OUTSIDE_ALLOWED_FOLDERS` 时，报告限制并尊重用户配置。
- 用 `manage_tags({ path, operation, tags })` 处理笔记的 Frontmatter 标签。`list` 仅读取，`add` 或 `remove` 接受完整标签名，可带一个 `#`。结果包含 `tags`、`applied`、`skipped`。匹配忽略大小写和 Unicode 规范形式，仍区分父标签和子标签。正文与其他属性保留，复杂或有歧义的标签属性会拒绝修改。

### B. 构建或更新思维白板 (`.canvas`)
1. 先用 `search_notes` 确认要引用的库内笔记精确路径；
2. 新建白板用 `canvas_ops({ action: "create", path: "主题白板.canvas", nodes, edges })`；向已有白板增改节点用 `action: "upsert"`（按 `id` 无损合并，保留 `group`、`subpath`、`fromEnd`/`toEnd` 等所有既有属性）；
3. 可选调用 `open_in_obsidian` 让用户在桌面端直接查看。

### C. 交互式工作台说明
- 用户口头要求「打开 Obsidian 面板 / 预览笔记界面」时，模型应调用 `open_workbench` 工具；
- `complete_notes` 与 `pick_vault_dir` 仅供宿主 `@` 输入补全与工作台页面内部调用，模型日常读写无需调用它们。
