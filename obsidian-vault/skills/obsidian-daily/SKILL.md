---
name: obsidian-daily
description: 查看、汇总或更新 Obsidian 今日日记（Daily Note），支持早间待办梳理、随时速记和晚间工作复盘。
---

# Obsidian 每日日记与回顾 (`/obsidian-daily`)

围绕用户的 Obsidian Daily Note 完成每日计划、闪念速记或日终回顾。

## 执行步骤

1. **只读获取今日日记与近期动态**
   - 通过 `ghost_info` / `ghost_list` 确认 `obsidian-vault` 实例身份（保留其真实 `namespace`）。
   - 先调用 `daily_note({ action: "read" })` 只读查看今日日记（若用户只是查询今日安排且日记尚未创建，不要擅自落盘创建空文件）。
   - 调用 `vault_status` 查看近期修改过的笔记（`recentNotes`）与全库未完成待办数。

2. **按用户意图分支处理**
   - **早间梳理 / 纯查看**：汇总今日日记中已有的安排，若有昨日未闭环事项（可传 `date` 只读昨日 `daily_note`）一并温和提示；询问用户是否需要初始化今日日记。
   - **速记 / 加待办 / 明确创建**：用户给了具体事项或要求创建今日日记时，调用 `daily_note({ action: "append" | "add-task" | "ensure", content, heading })` 单次原子写入。
   - **晚间复盘 / 汇总**：把今天对话产生的重要进展或今日在库内新修改的笔记用 `[[双链]]` 汇总，写入今日小结章节。

3. **简洁反馈**
   - 用清晰易扫读的列表展示今日日记最新状态与待办进度。
