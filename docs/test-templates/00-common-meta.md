# 00 — 通用元信息字段规范

> 所有测试用例（API / UI / Performance）共享的骨架。生成任何类型的用例前，先填满本节。

## 必填字段

```yaml
# ---- 身份 ----
id: ""                      # 格式：tc_{uuid12}，由 models.new_id("tc") 自动生成
title: ""                   # ≤200 字符，格式："模块-功能-场景"，如"用户-创建用户-name为空"
project_id: ""              # 所属项目 ID，格式 proj_{uuid12}

# ---- 分类 ----
type: "api"                 # api | ui | app
execution_mode: "api"       # api | ui | app | capture | doc | manual
priority: "P2"              # P0=阻断 P1=核心 P2=一般 P3=低优
category: "功能测试"         # 功能测试 | 安全相关 | 兼容性 | 其它
module_path: []             # 层级路径，如 ["用户管理", "创建用户"]

# ---- 状态 ----
status: "draft"             # draft → reviewed → deprecated；只有 reviewed 可参与回归
lint_status: "unchecked"    # unchecked | passed | warned | blocked
```

## 可选但建议填写的字段

```yaml
# ---- 溯源 ----
owner: ""                   # 用例负责人
requirement_ids: []         # 关联的需求 ID，如 ["req_abc123"]
coverage_links: []          # 步骤/期望 → 需求的精确映射

# ---- 前置与数据 ----
preconditions: []           # 人可读的前置条件描述（至少列出非空列表！）
data_refs: []               # 测试数据引用 key，如 ["DEM-1002", "U1003"]

# ---- 步骤与期望 ----
steps: []                   # 至少 1 项；人可读操作步骤
expected: []                # 至少 1 项；与 steps 一一对应的期望结果
```

## 字段约束（硬性）

| 字段 | 约束 | 违反后果 |
|------|------|----------|
| `title` | 1–200 字符 | Schema 校验失败，`lint_status` = blocked |
| `steps` | ≥1 项 | Schema 校验失败 |
| `expected` | ≥1 项 | Schema 校验失败 |
| `priority` | 枚举值 | 入库拒绝 |
| `execution_mode` | 枚举值 | 执行时类型分发错误 |
| `status` | 必须为 `reviewed` | **非 reviewed 用例不参与回归执行** |

## 前置条件声明规范

> 这是本模板体系的**核心改进点**。过去生成的用例经常缺少前置条件，导致脚本在执行时因环境/数据/鉴权问题失败。

```yaml
preconditions:
  # 格式：[类型] 描述
  # 类型枚举：ENV（环境）/ AUTH（鉴权）/ DATA（数据）/ RUNTIME（运行时依赖）/ STATE（系统状态）

  - "[ENV] 被测环境 base_url 可达且响应 /health 200"
  - "[AUTH] 环境已配置有效的鉴权 token 或接口登录凭据"
  - "[DATA] 测试数据 DEM-1002 已通过 seedData 注入"
  - "[RUNTIME] Python ≥3.11 已安装且 pytest ≥8.0 可用"
  - "[STATE] 用户列表为空（或已知初始状态）"
```

### 类型说明

| 类型 | 含义 | 自动检查方式 |
|------|------|-------------|
| `ENV` | 环境连通性、base_url 配置 | `EnvConfig.to_env()` + 连通性探测 |
| `AUTH` | 鉴权 token / 角色账号 / 接口登录 | `secretEnv()` + `role_auth` fixture |
| `DATA` | 测试数据注入 / 数据库状态 | `ui.seedData()` / `db_setup` |
| `RUNTIME` | 执行器依赖（python/k6/playwright/...） | `checkExecutors()` |
| `STATE` | 被测系统的业务状态前置 | 用例脚本的 setup 阶段 |

## 用例 ID 生成规则

```python
# 自动生成，不要手写
from aitest.models import new_id
case_id = new_id("tc")  # → "tc_a1b2c3d4e5f6"
```

## module_path 命名规范

```yaml
# ✅ 推荐：中文业务语义 + 层级清晰
module_path: ["用户管理", "创建用户"]
module_path: ["订单", "退款", "全额退款"]

# ❌ 避免：纯技术术语或过深层级
module_path: ["api", "v1", "users", "post"]
module_path: ["第一层", "第二层", "第三层", "第四层", "第五层"]
```
