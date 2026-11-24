# 贡献说明

提交前请阅读 [Developer Certificate of Origin 1.1](https://developercertificate.org/)。如果你有权按项目采用的许可提交改动，用 `git commit -s` 签署自己的每个提交。Git 会根据当前作者姓名和邮箱添加 `Signed-off-by`。DCO 是贡献者对来源和提交权的声明。

GitHub PR 会运行 **DCO sign-off** 检查。开 PR 前也可以在本地检查新增的提交：

```sh
bash scripts/check-dco.sh origin/main HEAD
```

自己的单个未签署提交可以用 `git commit --amend -s` 补签。已共享的提交历史请先与协作者协调。已有的基线提交无需为打开新 PR 而改写，检查只覆盖该 PR 新增的提交。

改动插件功能时，在 [验收记录](ACCEPTANCE.md) 记录插件版本、Cindy 和 Obsidian 版本、测试环境和实际结果。
