# 05 — 失败归因规则与诊断字段映射

> 本文档定义了用例失败后的归因体系。用例模板中声明的前置条件类型直接对应归因分类。
> 目标：每次失败都能快速定位根因，区分「环境问题」「测试问题」「产品缺陷」。

---

## 一、失败类型枚举

```python
class FailureType(str, Enum):
    PRODUCT_BUG = "product_bug"     # 被测产品缺陷
    SCRIPT_ERROR = "script_error"   # 用例/脚本错误或页面改版
    ENVIRONMENT = "environment"     # 环境连接/配置问题
    DATA = "data"                   # 测试数据缺失或不一致
    AUTH = "auth"                   # 鉴权/认证问题
    MODEL = "model"                 # AI 模型调用失败（探索/自愈场景）
    UNKNOWN = "unknown"             # 待 Agent 判定
```

## 二、确定性归因规则（`runner.classify_failure`）

以下规则由引擎自动判定，不需要 Agent 介入：

### 2.1 environment 归因

```python
# 匹配模式（runner._ENV_PATTERNS）
_ENV_PATTERNS = re.compile(
    r"(ConnectError|ConnectTimeout|ReadTimeout|"
    r"Name or service not known|Connection refused|"
    r"net::ERR_|未设置 AITEST_BASE_URL|"
    r"No devices? (found|connected)|device offline|"
    r"App .{0,60}not installed|Unable to launch app)"
)
```

| 触发条件 | 对应的前置条件缺失 | 诊断链步骤 |
|----------|-------------------|-----------|
| `ConnectError` / `ConnectTimeout` | `[ENV]` 被测环境不可达 | `validate` |
| `ReadTimeout` | `[ENV]` 环境响应超时 | `spawn` |
| `Connection refused` | `[ENV]` 服务未启动 | `validate` |
| `net::ERR_*` | `[ENV]` UI 页面无法加载 | `execute` |
| `未设置 AITEST_BASE_URL` | `[ENV]` 环境变量未注入 | `validate` |
| `No devices found` | `[RUNTIME]` App 设备未连接 | `validate` |
| `App not installed` | `[RUNTIME]` App 未安装 | `validate` |

### 2.2 auth 归因

```python
# 匹配模式（runner._AUTH_ERROR）
_AUTH_ERROR = re.compile(
    r"(?:业务码|状态码|HTTP(?: status)?)\s*[:：]?\s*(?:401|403)\b|"
    r"未授权|未登录|登录失效|认证失败|"
    r"未配置接口登录|没有接口凭据|AUTH_REQUIRED",
    re.IGNORECASE
)
```

| 触发条件 | 对应的前置条件缺失 | 诊断链步骤 |
|----------|-------------------|-----------|
| HTTP 401/403 | `[AUTH]` token 无效或过期 | `collect-results` |
| `未授权` / `未登录` | `[AUTH]` 未配置鉴权 | `prepare-environment` |
| `AUTH_REQUIRED` | `[AUTH]` UI 角色会话缺失 | `execute` |
| `没有接口凭据` | `[AUTH]` 角色 token 未配置 | `prepare-environment` |

### 2.3 product_bug 归因

```python
# 匹配模式（runner._SERVER_ERROR）
_SERVER_ERROR = re.compile(r"状态码 5\d\d")
```

| 触发条件 | 说明 |
|----------|------|
| HTTP 5xx | 服务端错误，大概率产品缺陷 |

### 2.4 unknown → Agent 判定

所有不匹配上述规则的失败，归类为 `unknown`，交给 Agent：

```
Agent 判定路径：
  1. Orchestrator 收集失败用例（needs_agent 列表）
  2. 创建 Agent 线程（startThread）
  3. 传入用例信息 + 失败消息 + 证据
  4. Agent 返回 JSON：[{case_id, failure_type, reason}]
```

---

## 三、前置条件类型 → 失败类型映射

```
precondition [ENV]     → failure_type: environment
precondition [AUTH]    → failure_type: auth
precondition [DATA]    → failure_type: data
precondition [RUNTIME] → failure_type: environment（运行时不满足视为环境问题）
precondition [STATE]   → failure_type: unknown（需要 Agent 判断是数据还是产品问题）
```

## 四、诊断链与失败归因的关系

### 4.1 诊断链定义

```typescript
// desktop/src/shared/diagnostics.ts
export const DIAGNOSTIC_CHAINS = [
  { id: "performance-run",
    steps: ["validate", "inject-secrets", "generate-plan", "spawn",
            "parse-summary", "write-report", "complete"] },
  { id: "api-regression",
    steps: ["validate", "prepare-environment", "spawn",
            "collect-results", "generate-report", "complete"] },
  { id: "ui-testing",
    steps: ["validate", "execute", "collect-results", "complete"] },
  { id: "app-testing",
    steps: ["validate", "execute", "collect-results", "complete"] },
  { id: "agent",
    steps: ["validate", "start-thread", "execute", "complete"] },
];
```

### 4.2 步骤失败 → 归因推导

| 诊断步骤 | 失败时最可能的归因 | 用例模板应声明的前置条件 |
|----------|-------------------|------------------------|
| `validate` | environment / auth | `[ENV]` + `[AUTH]` + `[RUNTIME]` |
| `prepare-environment` | auth / data | `[AUTH]` + `[DATA]` |
| `inject-secrets` | auth | `[AUTH]` |
| `generate-plan` | environment（配置错误） | `[ENV]` |
| `spawn` | environment / runtime | `[RUNTIME]` |
| `execute` | unknown / script_error | `[STATE]` |
| `collect-results` | environment（部分）/ 各类 | 依赖具体失败消息 |
| `parse-summary` | environment（进程异常） | `[RUNTIME]` |
| `complete` | — | 通常不失败 |

---

## 五、用例模板中的失败归因辅助字段

### 5.1 failure_hints（建议声明）

```yaml
# 在用例模板中声明，帮助 Agent 更准确归因
failure_hints:
  # 如果失败消息匹配这些模式，直接归为对应类型（不需要 Agent）
  environment_patterns:
    - "ECONNREFUSED"
    - "ETIMEDOUT"
    - "net::ERR_"
  auth_patterns:
    - "401"
    - "403"
    - "token expired"
  data_patterns:
    - "not found"               # 测试数据不存在
    - "列表为空"                 # 数据未播种
  script_error_patterns:
    - "getByTestId"             # 选择器变了
    - "timeout waiting for"     # 元素不存在
  product_bug_patterns:
    - "500"                     # 服务端错误
    - "预期值与实际值不匹配"      # 业务逻辑错误
```

### 5.2 UI 用例特有的归因辅助

```yaml
# UI 用例额外的归因线索
ui_failure_context:
  # 脚本路径（Agent 分析时需要）
  script_path: "scripts/ui/{case_id}.spec.ts"

  # 证据路径
  trace_path: "reports/{run_id}/trace.zip"
  screenshot_path: "reports/{run_id}/screenshot.png"

  # 自愈模式标记
  auto_heal: true               # 是否允许 Agent 修复脚本

  # 页面信息（帮助 Agent 判断是页面改版还是脚本错误）
  target_page: "/users"
  critical_selectors:
    - "data-testid='user-table'"
    - "data-testid='edit-dialog'"
```

---

## 六、归因结果的流转

```
1. 用例执行完毕
   ↓
2. runner.classify_failure(message) → 确定性归因
   ├── environment / auth / product_bug → 直接入库
   └── unknown → needs_agent 列表
       ↓
3. Orchestrator.summarizeFailures / healUi
   ├── environment 类型不送 Agent
   └── unknown → Agent 线程分析
       ↓
4. Agent 返回 [{case_id, failure_type, reason}]
   ↓
5. 结果入库 + UI 展示
```

---

## 七、用例模板生成时的归因检查

生成用例时，确保以下对应关系：

```
✅ 每个 precondition [ENV]  → 有对应的 failure_hints.environment_patterns
✅ 每个 precondition [AUTH] → 有对应的 failure_hints.auth_patterns
✅ 每个 precondition [DATA] → 有对应的 failure_hints.data_patterns
✅ 每个 data_refs 条目      → preconditions 中有 [DATA] 声明
✅ api.role 非空时           → preconditions 中有对应角色的 [AUTH] 声明
✅ api.encrypt: true 时      → preconditions 中有加密配置的 [ENV] 声明
✅ api.db_setup 非空时       → preconditions 中有数据库的 [ENV] 声明
```

这些对应关系可以在入库时通过 lint 规则自动检查（扩展现有的 `lint_status` 机制）。
