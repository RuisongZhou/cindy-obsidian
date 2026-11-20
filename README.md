# cindy-obsidian (`obsidian-vault`)

参考 OpenAI MCP 与 Google Gemini CLI 的第二大脑连接范式，为 [Cindy](https://github.com/makecindy/cindy) 构建的原生本地 **Obsidian 知识库**插件。

## 目录结构

- `obsidian-vault/` — Cindy 插件完整源码目录（可直接用于 `ghost_forge_pack` / `ghost_forge_install`）
  - `ghost.json` — 插件身份卡与权限最小化清单（`schemaVersion: 3`）
  - `main.js` — 沙箱电子脑入口（工具编排、目录选择器、覆盖/删除前原生确认框绑定）
  - `node/worker.cjs` — 按需 Node 工作进程（严格 Vault 边界与防符号链接逃逸、代码块感知章节切片、YAML Frontmatter 原文无损补丁、原子写盘与并发互斥锁、双链图谱与 Canvas 引擎）
  - `ui/page.html` — 单文件自包含 MCP Apps 交互工作台（浏览双链、消息一键入库、今日日记速记）
  - `settings.html` / `settings.js` — 插件自定义设置页
  - `skills/` — 随包斜杠技能（`/obsidian-capture`、`/obsidian-daily`）
  - `manual/guide/MANUAL.md` — Agent 多工具编排手册
  - `locales/` — 中英文清单与工具参数本地化

## 打包与本地安装

在 Cindy 对话中对该仓库目录执行：

- 校验并打包：`ghost_forge_pack({ dir: "<仓库绝对路径>/obsidian-vault" })`
- 本地安装/更新：`ghost_forge_install({ dir: "<仓库绝对路径>/obsidian-vault" })`
