---
name: obsidian-capture
description: 把当前对话结论、网页调研或技术方案整理成结构化 Obsidian 笔记，自动搜索相关笔记建立 [[双链]] 与标签后存入知识库。
---

# Obsidian 知识提炼与双链入库 (`/obsidian-capture`)

将当前对话中有价值的调研结论、技术方案、读书笔记或零散想法，按照 Obsidian 知识管理最佳实践整理并写入用户的知识库。

## 执行步骤

1. **定位插件实例与知识库配置**
   - 查看会话花名册中的 `obsidian-vault`（若已知 `namespace` 如 `local` 则在 `ghost_info` / `ghost_call` 中原样带上；不确定时调用 `ghost_list` 确认）。
   - 若 `obsidian-vault` 工具不可用或未启用，直接向用户报告缺失，不要绕过插件写无关目录。
   - 调用 `vault_status` 获取默认保存目录 `summary.defaultFolder`（伙伴对话中为该伙伴的专属文件夹，其他任务为收件箱 `summary.inboxFolder`，缺省 `Inbox`）及写入规则；必要时调用 `list_tags` 参考既有标签体系，并调用 `search_notes` 搜索 3–5 个核心关键词，查找可建立 `[[双链]]` 的既有笔记。

2. **结构化组织笔记正文**
   - **YAML Frontmatter**：新建笔记包含 `title`、`date`（YYYY-MM-DD）、`tags`（优先复用库内已有标签，2–5 个）以及可选的 `aliases` 或 `source`。
   - **双链织网**：在正文中自然引用第 1 步搜到的既有笔记（若存在同名笔记，使用 `[[相对路径|标题]]` 消歧），并在末尾附上简短的 `## 关联笔记` 小节（如有命中）。
   - **善用 Obsidian 语法**：关键结论可用 `> [!summary]` 或 `> [!tip]` Callout 高亮，行动项使用 `- [ ]` 任务列表。

3. **非破坏性写入**
   - 如果用户指定了已有笔记，先调用 `read_note` 查看章节大纲，再用 `write_note` 的 `append-heading` 或 `append` 模式补充（原有 Frontmatter 无损保留）；若需为该已有笔记补充标签，另调 `manage_tags({ path, operation: "add", tags })`。
   - 如果是全新主题：返回了 `summary.companion` 时，除非用户明确指定其他目录，都放入 `summary.defaultFolder`（可在其中建子目录）；否则优先放入贴合库内既有分类的子目录，无匹配分类时放入 `summary.defaultFolder`。调用 `write_note({ mode: "create", path, frontmatter, content })` 创建，并以结果返回的 `path` 为准告知用户。

4. **结果交付**
   - 简明告知用户保存的知识库名、笔记路径、打上的 `#标签` 以及建立的 `[[双链]]` 关系；若用户希望立即查看，可调用 `open_in_obsidian` 在桌面端定位打开。
