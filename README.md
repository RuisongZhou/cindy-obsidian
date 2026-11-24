# Cindy × Obsidian

[English](obsidian-vault/README.md) · [简体中文](obsidian-vault/README.zh-CN.md) · [发布说明](RELEASING.md) · [验收记录](ACCEPTANCE.md)

在 [Cindy](https://github.com/makecindy/cindy) 中搜索本机 Obsidian 笔记、沿双链查资料，把对话里的结论保存成 Markdown，或顺手写进今日日记。插件直接读写已登记的知识库文件，Obsidian 关闭时也可以使用。

## 安装与试用

1. 在运行 Cindy 的电脑上准备一个 Obsidian 知识库。支持 **Cindy 0.1.143 或更新版本**。使用 Obsidian 桌面端时，支持 **Obsidian 1.15.1 或更新版本**。
2. 克隆本仓库后，在 Cindy 对话中说「把当前仓库的 `obsidian-vault/` 打包并安装为本地开发插件」，并检查客户端显示的权限。已有 `.cindy` 文件也可从 Cindy 的「插件」页导入。
3. 打开侧栏的 **Obsidian 知识库**。若列表为空，点击 **添加知识库**，选择存放 Markdown 笔记的文件夹。建议第一次用测试库试写。
4. 在输入框键入 `@` 选择笔记，再向 Cindy 提问。也可以在 AI 回复的正文视图选择 **保存到 Obsidian**，核对路径和正文后保存。

从另一台电脑查看远程任务时，可以在该任务里发送「`$obsidian` 打开知识库工作台」。卡片显示知识库所在电脑。保存途中断线时，恢复连接后点 **检查保存结果**，查看原请求的回执。

更多操作和故障排查见[插件介绍](obsidian-vault/README.zh-CN.md)。

## 开发

插件源码在 [`obsidian-vault/`](obsidian-vault/)。`ghost.json` 定义宿主入口、工具和权限，`main.js` 调度工具与原生确认，`node/worker.cjs` 读写本地知识库，`ui/page.html` 和 `settings.html` 分别是工作台和设置页。Node 工作进程只使用标准库。

在 Cindy 中可使用 `ghost_forge_pack` 检查并生成安装包，参数 `dir` 传 `obsidian-vault/` 的绝对路径。版本、验收与投稿步骤见[发布说明](RELEASING.md)。
