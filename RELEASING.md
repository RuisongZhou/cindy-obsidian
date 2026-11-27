# 发布 Obsidian 知识库

`obsidian-vault/` 是可独立打包的源码目录。常规第三方公开市场投稿走 Cindy 客户端，官方源码收录走 GitHub。当前包保留 `/obsidian-capture` 和 `/obsidian-daily`。

发布基线为 **Cindy 0.1.143 或更新版本**，已写入插件清单。桌面集成支持 **Obsidian 1.15.1 或更新版本**。直接读写知识库文件仍可在 Obsidian 关闭时使用。已完成的结果见[验收记录](ACCEPTANCE.md)。

## 第三方公开市场

1. 检查 `obsidian-vault/ghost.json`。保留已使用的插件 ID，更新版本号。后续提审须在顶层 `releaseNotes` 用纯文本说明相对上一已上架版本的变化。
2. 用 `ghost_forge_pack({ dir: "<源码绝对路径>/obsidian-vault" })` 生成 `.cindy`。同版本内容有修改时重新打包。Forge 生成的是本地未签名安装包。
3. 在实际运行 Cindy 的电脑上安装这个版本，用临时知识库完成下方验收。在安装确认里核对 Node 工作进程、目录选择、覆盖确认、工作台任务上下文和草稿、随包 Skill 等声明。
4. 对确切的本地开发实例运行 `ghost_contribution_prepare({ ghost_id: "obsidian-vault", namespace: "local" })`，核对版本、来源、更新说明和阻塞项。它只做预检。预检通过后，由发布账号在 Cindy 提交审核，再从「发布插件」查看状态。服务端受理后占用版本号，同一插件同时只能有一个待审版本。
5. 确认审核通过且市场已能找到目标版本后，再更新 README 的安装说明。

源码许可和图标素材来源需由维护者确认后再对外发布。本仓当前未声明许可证。确认已有 `assets/icon.png` 的来源与公开分发权，并核对是否可用作插件图标。

## 官方插件仓投稿

按 [官方仓贡献指南](https://github.com/makecindy/cindy-official-plugins/blob/main/CONTRIBUTING.md) 准备 `feat(obsidian-vault): …` PR。把本仓 [`provisioning.json`](provisioning.json) 中的插件条目合并到官方仓对应文件。当前范围是用户主动安装（`{ "emails": [] }`）。按[贡献说明](CONTRIBUTING.md)对每个新增提交做 DCO 签署，填写实际作者，运行官方仓的本地化和包契约校验，提供生产版 Cindy 的实机验收记录。合入后由官方仓流水线提交市场审核。

[官方仓审核规则](https://github.com/makecindy/cindy-official-plugins/blob/main/.greptile/rules.md) 对 public 包的随包 Skill 有例外名单，当前 `obsidian-vault` 未列入。走官方仓前，先确认如何处理两个斜杠入口，再准备与待投版本一致的包和介绍。直接投稿以 Cindy 对确切安装包给出的预检和审核结果为准。

## 桌面验收

使用两个包含同名 Markdown 文件的临时知识库，并记录 Cindy 版本、系统、插件版本和结果。

- [ ] 初次没有知识库时显示添加入口。取消目录选择可回到工作台，选择有效目录后可以搜索。同名库在下拉列表可区分。
- [ ] 侧栏和输入框入口都能打开工作台。窄窗口以及浅色、深色模式下可以完成搜索、预览和保存。
- [ ] 测试按标题和 `#标签` 搜索、`@` 补全、点击出链与反向链接、从任务入口插入草稿，以及在 Obsidian 打开正确的笔记。
- [ ] 从 AI 回复的正文视图切换器打开保存页并确认正文预填成功。切换库后，文本仍在且保存目标指向新库。制造同路径冲突，确认可改路径重试。成功后的回执可打开实际写入的笔记。
- [ ] 逐项测试新建、末尾追加、章节追加。取消整篇覆盖和移入回收站后，比对原文件。验证读取和写入不能越过已登记库的目录边界。
- [ ] 浏览今日日记时文件不落盘。第一次添加待办按日记配置创建文件，重复点击保存只提交一次，追加记录保留原内容。
- [ ] 在未安装插件的控制端打开另一台已安装插件的电脑上的任务卡片。核对来源主机名和 Obsidian 窗口。让笔记或日记保存后丢失响应，恢复连接并查询回执，核对实际文件中只有一份追加内容。支持卡片状态时，再关闭并重开原卡片查询。确认全局工作台显示其入口对应的电脑。
- [ ] 在另一台控制端电脑上打开执行电脑的任务，分别发起移入回收站、覆盖笔记和替换白板。确认卡片出现在控制端，点击前文件不变，点击后执行一次，卡片随之变为结果状态。再核对工作台里的写入规则确认和按路径添加知识库。
- [ ] 保存设置、重开工作台，验证收件箱、日记路径和默认库。检查插件详情中的 README 和现有两个斜杠技能。

## 实现参考

- 官方 Web Search 的设置页用同源存储、按需写入和明确的保存反馈。 [Web Search 设置源码](https://github.com/makecindy/cindy-official-plugins/blob/main/cindy-web-search/settings.js)
- 官方 OpenDesign 在插件清单里说明任务归属、打开方式和执行设备。 [OpenDesign 插件清单](https://github.com/makecindy/cindy-official-plugins/blob/main/opendesign-trial/ghost.json)
