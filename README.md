# Cindy × Obsidian

[English](obsidian-vault/README.md) · [简体中文](obsidian-vault/README.zh-CN.md) · [发布说明](RELEASING.md) · [验收记录](ACCEPTANCE.md)

在 [Cindy](https://github.com/makecindy/cindy) 中直接读写本机 Obsidian 知识库——搜索和引用笔记、沿双链浏览、记录今日日记、把对话结论存为 Markdown，以及编辑 Canvas 思维白板。插件直接访问已登记的本地知识库文件，Obsidian 关闭时也可正常使用，无需配置 API Key。

## 安装与试用

1. 在运行 Cindy 的电脑上准备一个 Obsidian 知识库。支持 **Cindy 0.1.143 或更新版本**；桌面端联动支持 **Obsidian 1.15.1 或更新版本**。
2. 克隆本仓库后，在 Cindy 对话中说「把当前仓库的 `obsidian-vault/` 打包并安装为本地开发插件」，并核对客户端显示的权限。也可以直接从 Cindy 的「插件」页导入已打包的 `.cindy` 文件。
3. 打开侧栏的 **Obsidian 知识库**。若列表为空，点击 **添加知识库** 选择存放 Markdown 笔记的文件夹（首次建议先用测试库试用）。
4. 在输入框键入 `@` 引用笔记，或在 AI 回复的正文视图选择 **一键保存到 Obsidian** 直接入库；伙伴对话会存入该伙伴的专属文件夹。

从另一台电脑远程操作任务时，可发送「`$obsidian` 打开知识库工作台」。卡片顶部会显示知识库所在电脑；若保存途中断线，恢复连接后点击 **检查保存结果** 即可核对写入回执。

更多日常用法与故障排查见[中文插件介绍](obsidian-vault/README.zh-CN.md)。

## 开发与接口结构

插件源码位于 [`obsidian-vault/`](obsidian-vault/)：
- [`ghost.json`](obsidian-vault/ghost.json)：声明插件元数据、14 个模型工具（`vault_status`、`list_files`、`search_notes`、`list_tags`、`read_note`、`write_note`、`replace_in_note`、`delete_note`、`manage_tags`、`daily_note`、`graph_links`、`canvas_ops`、`open_in_obsidian`、`open_workbench`）与 4 个工作台专用工具（`complete_notes`、`pick_vault_dir`、`write_receipt`、`set_vault_write_policy`）及权限。
- [`main.js`](obsidian-vault/main.js)：调度工具调用、写入串行化与危险操作的确认卡片。
- [`node/worker.cjs`](obsidian-vault/node/worker.cjs) 与 [`node/write-receipts.cjs`](obsidian-vault/node/write-receipts.cjs)：零外部依赖的 Node 标准库工作进程，负责索引、原子读写与跨进程幂等回执。
- [`ui/page.html`](obsidian-vault/ui/page.html) 与 [`settings.html`](obsidian-vault/settings.html)：工作台与设置页。

运行单元测试：

```bash
node --test tests/worker.test.cjs
```

打包安装包时，在 Cindy 中调用 `ghost_forge_pack({ dir: "<绝对路径>/obsidian-vault" })`。版本、验收与投稿流程见[发布说明](RELEASING.md)。
