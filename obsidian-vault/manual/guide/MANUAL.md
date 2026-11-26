# Obsidian 知识库插件编排手册

插件通过本机 Markdown 索引直接读写已登记的 Obsidian 知识库，无需启动 Obsidian。

## 1. 工具选用速查表（一件事一个首选入口）

| 任务意图 | 首选工具 | 说明与边界 |
| :--- | :--- | :--- |
| 摸底知识库、查写入规则/收件箱/日记配置 | `vault_status` | 首次进库先调用，返回 `writePolicy`、统计摘要与近期修改笔记 |
| 按文件夹浏览目录树或非 `.md` 文件 | `list_files` | 仅扫目录元数据，支持 `folder`/`depth`/`extension` |
| 按关键词、目录、标签或属性检索笔记 | `search_notes` | 返回相关性排序、游标 `nextCursor` 及正文命中行列 |
| 统计全库所有标签与使用频次 | `list_tags` | 覆盖 Frontmatter 与正文 `#标签`，支持 `prefix` 前缀过滤 |
| 读取单篇笔记、指定章节或 `^块ID` | `read_note` | 同时返回 `frontmatter`、`tags`、`headings[].path`、直接出链与反链 |
| 新建、整篇覆盖、追加/前置、整节/整块改写、改非标签属性 | `write_note` | 覆盖已有笔记需用户确认；**不用于删除或修改已有笔记标签** |
| 在已有正文、章节或块中精确字面替换片段 | `replace_in_note` | 保留 Frontmatter，默认唯一命中，支持 `dryRun` 与 `expectedMtimeMs` |
| 将已有笔记移入知识库回收站（`.trash`） | `delete_note` | 安全移入 `.trash`，执行前需 Cindy 弹窗确认 |
| 查看、添加或移除单篇笔记的 Frontmatter 标签 | `manage_tags` | 完整标签名大小写不敏感匹配，不误删子标签，保留正文与其他属性 |
| 读写或向每日日记追加时间戳记录/待办 | `daily_note` | 自动遵循 `.obsidian/daily-notes.json` 或插件设置的目录、日期格式与模板 |
| 查未连接提及、二跳关联、全库核心枢纽或孤立笔记 | `graph_links` | 仅 `note` / `hubs` / `orphans` 三种纯图谱模式 |
| 列出、读取、新建、合并或替换 `.canvas` 白板 | `canvas_ops` | 仅 `list` / `read` / `create` / `upsert` / `overwrite`；`overwrite` 需确认 |
| 在桌面端 Obsidian 应用打开文件或知识库 | `open_in_obsidian` | 库已在 Obsidian 中打开且官方 CLI 可用时用 CLI，否则精确路径 `obsidian://` URI |
| 在 Cindy 内打开可视化交互工作台 | `open_workbench` | 用于让用户图形化浏览、保存笔记、记录日记或调整写入规则 |

内部专用工具：`complete_notes`、`pick_vault_dir`、`write_receipt`、`set_vault_write_policy` 仅供宿主 `@` 补全与工作台页面调用（`visibility: ["app"]`），模型日常任务无需也不应调用。

## 2. 安全边界与数据无损原则

0. **官方 CLI 只用于查询**：Obsidian 正在运行、已开启命令行界面且该库已打开时，`graph_links` 的反向链接与链接解析、`list_tags` 的计数、`daily_note` 的今日路径改由 Obsidian 回答，结果分别带 `linkSource` / `tagSource` / `pathSource`（`obsidian-cli` 或本地来源）；CLI 不可用时自动退回本地索引并在 `cliFallbackReason` 说明原因。所有写入都直接写文件，不经过 CLI（CLI 会把正文中的 `\n`、`\t` 改成换行和制表符）。`vault_status.obsidianCli.activeVaultQueries` 显示当前库能否使用 CLI。

1. **仅限已登记 Vault 访问**：工具只访问 `obsidian.json` 中已注册或用户在工作台「添加知识库」亲选的目录，拦截 `.obsidian`/`.git`/`.trash` 与符号链接。用户明确指定另一库时，传其 ID 或精确路径。
2. **尊重按库写入规则**：`vault_status` 返回当前库的 `writePolicy`。`readOnly: true` 禁止所有写入与移入回收站；`writeFolders: null` 表示全库可写，空数组表示全库禁写，目录数组只允许对应目录及子目录。遇到 `VAULT_READ_ONLY` 或 `WRITE_OUTSIDE_ALLOWED_FOLDERS` 时如实向用户报告，不要绕过。
3. **伙伴专属文件夹**：在伙伴的主对话中，`vault_status` 返回 `summary.companion` 与 `summary.defaultFolder`。`write_note` 的 `create` 若只给文件名或路径在收件箱下，会自动放进该伙伴的文件夹，结果带 `redirectedFrom`；明确写了其他目录时保持原路径。其他写入模式不改路径。伙伴文件夹由用户在工作台「伙伴专属文件夹」中设置，模型无需也不能自行传入。
4. **非破坏性编辑与确认弹窗**：
   - `write_note` 的追加、前置与章节编辑自动识别 ``` 与 ~~~ 代码围栏，绝不误切代码块内的 `#` 注释，并在未传 `frontmatter` 时逐字节保留原 YAML Frontmatter；
   - `write_note(mode="overwrite")`、`delete_note` 以及 `canvas_ops(action="overwrite")` 会先核验真实目标并弹出 Cindy 确认框；用户取消时请尊重取消结果。

## 3. 常见多工具协作流程

### A. 检索与回答知识库问题
1. 首次了解目录或文件类型时调用 `list_files`（`depth: 1` 列直接子项，`extension` 只过滤文件不隐藏子目录；`truncated` 表示未列全）。
2. 用 `search_notes` 检索 1–3 个核心词；需要翻页时原样传回 `nextCursor` 并保持查询与分页参数一致，遇到 `STALE_CURSOR` 从第一页重搜。`matches` 的 `line`/`column` 为去掉 YAML Frontmatter 后正文的 1 基位置，`start`/`end` 为 UTF-16 零基偏移。
3. 对高相关结果传精确 `path` 调用 `read_note`（长文可传 `heading` / `headingPath` / `blockId`）。
4. 若需梳理脉络、找未连接提及或二跳关联，再调用 `graph_links`；需要了解全库标签体系时调用 `list_tags`。
5. 回复中清晰标注引用的笔记路径或 `[[笔记名]]`。

### B. 精准编辑章节、块、局部文本与标签
- **重名标题**：先看 `read_note` 返回的 `headings[].path`，读写重名章节时将其传给 `headingPath`；`heading` 适用于唯一标题或不存在时自动新建二级标题的场景。
- **块读写**：读块传 `path` + `blockId`（或用 `title: "[[笔记#^块ID]]"`）；写块用 `write_note` 的 `append-block` / `prepend-block` / `replace-block`，保留原块 ID，拒绝重复 ID、代码围栏伪 ID 或会破坏块边界的写入。
- **字面替换**：优先用 `replace_in_note`（`heading`/`headingPath`/`blockId` 最多指定一项，Frontmatter 不参与）。建议先 `dryRun: true` 核对 `matchCount` 与 `mtimeMs`，写入时传入 `expectedMtimeMs`；确需批量替换时显式传 `replaceAll: true` 与 `expectedCount`。
- **标签管理**：新建或整篇覆盖笔记时可在 `write_note` 的 `frontmatter.tags` 初始化标签；对已有笔记查看、添加或移除 Frontmatter 标签一律使用 `manage_tags({ path, operation, tags })`（忽略大小写与 Unicode 规范形式，区分父子标签，复杂或带注释的标签属性会安全拒绝）。

### C. 构建或更新思维白板（`.canvas`）
1. 先用 `search_notes` 确认要引用的库内笔记精确路径；
2. 新建白板用 `canvas_ops({ action: "create", path, nodes, edges })`；向已有白板增删改节点或不确定是否存在时用 `action: "upsert"`（按 `id` 无损合并，保留既有 `group`、`subpath`、`fromEnd`/`toEnd` 等扩展字段）；仅在需要整板重写时使用 `overwrite`（会弹确认框）；
3. 可选调用 `open_in_obsidian` 在桌面端直接打开查看。
