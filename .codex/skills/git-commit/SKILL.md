---
name: git-commit
description: "按主题分组提交：扫描变更 → 分类分组 → 生成中文规范 commit message → 逐组提交"
version: 3.0.0
---

# Git Commit Skill

## 工作流

### 1. 扫描变更
```bash
git status --short
```
- 无变更 → 告知用户并停止
- 列出所有已修改、新增、未跟踪的文件

**自动排除**（永不 stage）：
- 临时/备份：`*.tmp`、`*.bak`、`*.swp`、`*~`、`*.orig`
- 密钥/凭证：`.env`、`*.key`、`*.pem`、credentials 相关文件
- 构建产物：`__pycache__/`、`*.pyc`、`node_modules/`、`dist/`、`.DS_Store`

---

### 2. 分类与分组

按文件路径判断类别，制定提交计划：

| 类别 | 路径特征 | 提交策略 |
|------|---------|---------|
| **文章** | `posts/`、`articles/`、`content/`、`docs/` 下的 `.md` 文件 | 每篇独立一个 commit |
| **技能** | `.claude/skills/*/` | 每个 skill 目录独立一个 commit |
| **代码** | `*.py`、`*.ts`、`*.vue`、`*.js`，各 service 源码 | 按服务/模块分组 |
| **配置** | `*.json`、`*.yaml`、`*.toml`、`*.sh`、`requirements.txt` | 合并为一个 commit |
| **迁移** | `alembic/versions/` | 每个迁移文件独立一个 commit |
| **前端功能** | `front/src/` | 按功能/页面分组 |

**分组规则：**
- 每篇独立文章 → 单独 commit
- 每个改动的 skill 目录 → 单独 commit
- 同一服务/模块的文件 → 合并为一个 commit
- 零散配置/工具类改动 → 合并为一个 commit
- 不确定时 → 询问用户

执行前输出提交计划，例如：
```
提交计划：
  [1] docs(文章): 新增 xxx 技术分享 → posts/my-article.md
  [2] chore(skills): 优化 commit 技能分组逻辑 → .claude/skills/commit/
  [3] feat(workflow-service): 新增项目/需求/Agent 后端服务 → 5 个文件
  [4] chore(配置): 新增 workflow-service 依赖与路由配置 → 4 个文件
```

---

### 3. 逐组提交

对每个分组依次执行：

```bash
# 明确指定文件，绝不使用 git add . 或 git add -A
git add <该分组的具体文件列表>

echo "reviewed" > .claude/hooks/.review-passed

git commit -m "$(cat <<'EOF'
<类型>(<范围>): <中文简述>

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

**Commit 类型（保持英文前缀）：**
`feat` `fix` `refactor` `docs` `style` `test` `chore` `perf`

**Message 规范：**
- 范围和简述用**中文**，简洁可读
- 简述以动词开头（新增 / 修复 / 优化 / 重构 / 删除 / 更新）
- 不超过 72 个字符
- 聚焦"做了什么"，重要时说明"为什么"

示例：
```
feat(workflow-service): 新增项目与需求管理后端服务
fix(auth): 修复 token 过期后未清除本地状态的问题
chore(依赖): 升级 anthropic SDK 并添加 pgvector 支持
docs(技能): 更新 commit 技能支持分组提交
```

---

### 4. 收尾汇报

所有分组提交完成后：
```bash
git log --oneline -<N>   # N = 本次提交的 commit 数量
```

输出：每条 commit 的 hash + message，以及本次共提交多少个分组、涉及多少文件。

---

## 规则
- 永不使用 `git add .` 或 `git add -A`，必须明确指定文件
- 永不 stage 临时文件、备份文件、密钥文件
- 永不 `--force`、`--amend`、`--no-verify`，除非用户明确要求
- 执行前必须展示提交计划
- 不创建空 commit
- 多个聚焦 commit 优于一个大杂烩 commit

## TB 号关联规范（可选）

### Commit 关联 TB 号

Commit message 的 body 或 footer **可以**关联 TB 任务号。仅当用户明确提供 TB 号，或能从当前分支名、Trellis 当前任务等上下文中可靠识别 TB 号时，才自动添加关联；否则不要阻塞提交。

```bash
git commit -m "feat(user): 实现用户登录功能

- 支持手机号+验证码登录
- 支持密码登录

Closes #TB1234"
```

| 关联方式 | 示例 | 说明 |
|----------|------|------|
| Closes | `Closes #TB1234` | 完成该任务 |
| Refs | `Refs #TB1234` | 关联该任务 |

### 提交前检查

- [ ] 当前分支名是否包含 TB 号？如包含，则 commit message 应关联该 TB 号
- [ ] 用户是否明确提供 TB 号？如提供，则 commit message 应关联该 TB 号
- [ ] 是否使用了 wip 类型？（仅限个人分支，MR 前必须清理）
