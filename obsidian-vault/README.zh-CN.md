# Obsidian 知识库 (Obsidian Vault)

参考 OpenAI 与 Google Gemini 对 Obsidian 的深度连接范式，为 Cindy 打造的原生本地知识库插件。无论桌面端 Obsidian 是否正在运行，都能随时检索、遍历双链图谱并安全沉淀笔记。

## 核心亮点

- **输入框 `@` 实时引笔记**：在聊天框输入 `@` 即可按标题、路径或标签检索笔记，一键插入 `[[双链]]` 上下文。
- **真·知识图谱感知**：完整解析 YAML Frontmatter 属性、`#嵌套标签`、`[[双链]]`、反向链接（Backlinks）、未连接提及（Unlinked Mentions）与孤立笔记。
- **非破坏性章节级写入**：支持按 Markdown 标题（Heading）精准追加、前置或替换小节，独立合并更新 Frontmatter 属性；覆盖或移入 `.trash` 前自动弹出系统确认框。
- **消息菜单一键入库 & 侧栏工作台**：在任意 AI 回复菜单点击「保存到 Obsidian」，或从侧栏/输入框下方打开快捷工作台浏览笔记、速记今日日记（Daily Note）。
- **内置斜杠技能**：随包提供 `/obsidian-capture`（对话提炼打双链入库）与 `/obsidian-daily`（每日日记汇总与待办回顾）。

## 快速开始

1. 插件会自动识别本机 Obsidian 已注册的知识库（无需填写任何 API Key）；若你有多个库，可在插件设置或工作台右上角点击「切换库」选择。
2. 在聊天中输入 `@` 搜索笔记，或使用 `$obsidian` 点名让 Cindy 查阅、整理你的知识库，也可以直接运行 `/obsidian-capture` 和 `/obsidian-daily`。
