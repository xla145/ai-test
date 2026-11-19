# 03 — 性能测试用例模板

> 适用于性能压测场景。
> 执行路径：`Orchestrator.runPerformance` → `performancePlan()` / `scenarioPlan()` → k6 子进程 → `handleSummary` → JSON 报告 → 历史对比 / 基线退化检测

---

## 单接口性能用例模板

```yaml
# ==== 通用元信息 ====
id: ""                          # 性能用例可关联 caseId 溯源
title: "性能-接口名-场景"        # 如 "性能-创建订单-50VU持续30秒"
project_id: ""
type: "api"                     # 性能用例的来源类型仍为 api
execution_mode: "api"
priority: "P1"
category: "功能测试"
module_path: ["性能测试", "订单接口"]
status: "reviewed"
owner: ""

# ==== 前置条件（⚠️ 关键改进点）====
preconditions:
  # ---- 环境 ----
  - "[ENV] 被测环境 base_url 是 HTTP/HTTPS 且不含凭据/查询参数"
  - "[ENV] 被测环境非生产环境（performance 模块自动拒绝生产环境）"
  - "[ENV] 被测接口 /orders 可达且正常响应"

  # ---- 鉴权 ----
  - "[AUTH] 鉴权 token 有效（auth: true 时必须）"
  - "[AUTH] 若使用角色 role='buyer'，该角色凭据已配置"

  # ---- 运行时 ----
  - "[RUNTIME] k6 已安装且可执行（PATH 或 Homebrew 路径）"
  - "[RUNTIME] k6 版本支持 handleSummary 和 JSONL 输出"

  # ---- 资源限制 ----
  - "[STATE] 当前无其他性能任务在同项目同通道执行（串行排队）"
  - "[STATE] 被测服务有足够容量承受 vus×duration 负载"

# ==== 性能配置（对齐 PerformanceOptions）====
performance:
  # ---- 基础参数 ----
  path: "/orders"               # 接口路径，必须以 / 开头
  method: "POST"                # GET | POST | PUT | DELETE
  body:                         # POST/PUT/DELETE 的 JSON 请求体
    goodsId: 1001
  headers:                      # 自定义请求头（不含鉴权头）
    X-Client-Id: "perf-test"
  auth: true                    # 是否带环境鉴权，默认 true
  role: "buyer"                 # 使用指定角色凭据（空=默认token）

  # ---- 负载参数 ----
  vus: 50                       # 并发虚拟用户数，范围 1–100
  seconds: 30                   # 稳态持续时间（秒），与 rampUp+rampDown 总和 ≤300
  rampUp: 10                    # Ramp-up 秒数（0=不 ramp），默认 min(vus*2, 60)
  rampDown: 10                  # Ramp-down 秒数，默认 10

  # ---- 通过门槛 ----
  p95Ms: 500                    # P95 响应时间门槛（毫秒）
  maxFailureRate: 0.01          # 最大失败率（0–1），超过则 status=failed
  checkBusinessCode: true       # 是否校验业务码（code=0/200 视为成功）

  # ---- 高级参数 ----
  timeoutSeconds: null          # 单次请求超时（null=使用 k6 默认）
  pathParams: {}                # 路径模板参数
  query: {}                     # 查询参数

  # ---- 溯源 ----
  caseId: "tc_create_order"     # 来源用例 ID（从用例派生时记录）
  definitionId: "def_orders_post"
  definitionRevision: 5
  definitionName: "创建订单"

  # ---- 对比基线 ----
  baselineId: ""                # 对比的历史基线 ID（空=不对比）
```

## 场景性能用例模板（多步骤链式场景）

```yaml
id: ""
title: "性能-订单全流程场景-20VU"
project_id: ""
type: "api"
execution_mode: "api"
priority: "P0"
category: "功能测试"
module_path: ["性能测试", "订单全流程"]
status: "reviewed"
preconditions:
  - "[ENV] 被测环境非生产，所有场景步骤的接口均可达"
  - "[AUTH] buyer 和 admin 角色凭据均已配置"
  - "[RUNTIME] k6 已安装"
  - "[STATE] 商品 goodsId=1001 库存充足"

performance:
  # ---- 场景参数 ----
  scenarioId: "tc_order_lifecycle"
  scenarioSteps:                # 由 engine perf.compile_case 编译
    - name: "1-买家下单"
      method: "POST"
      path: "/orders"
      body:
        goodsId: 1001
      extract:
        orderId: "data.orderId"
      role: "buyer"

    - name: "2-查询订单"
      method: "GET"
      path: "/orders/${orderId}"
      role: "buyer"

    - name: "3-管理员取消"
      method: "DELETE"
      path: "/orders/${orderId}"
      role: "admin"

  # ---- 负载参数 ----
  vus: 20
  seconds: 60
  rampUp: 10
  rampDown: 10

  # ---- 门槛 ----
  p95Ms: 800
  maxFailureRate: 0.02
  checkBusinessCode: true
```

## 关键约束

### 1. 负载安全限制（硬编码，不可覆盖）

| 参数 | 限制 | 来源 |
|------|------|------|
| `vus` | 1–100 | `validateBase()` |
| 总时长 | ≤300 秒 | `rampUp + seconds + rampDown ≤ 300` |
| 生产环境 | 禁止执行 | Orchestrator 自动拒绝 |
| `maxFailureRate` | 0–1（不含 1） | `validateBase()` |
| `p95Ms` | > 0 | `validateBase()` |

### 2. k6 脚本生成逻辑

```
performancePlan(base, options)
  → 生成 k6 JS 脚本（code）
  → 凭据通过 __ENV 注入（不写入脚本）
  → handleSummary 导出 JSON 报告
  → 实时 JSONL 输出用于进度采集
```

### 3. 实时指标说明

| 指标 | 计算方式 | 注意 |
|------|---------|------|
| 实时 P95 | **窗口聚合**（非全局 P95） | UI 标注为"窗口 P95" |
| 实时 RPS | 窗口内请求数 / 窗口秒数 | 突发流量可能偏高 |
| 最终 P95 | k6 `handleSummary` 全量统计 | 以此为准，实时值仅参考 |

### 4. 结果状态

```
passed    — P95 和失败率均在门槛内
failed    — P95 或失败率超标
stopped   — 用户手动停止
error     — k6 进程异常（启动失败/超时/崩溃）
degraded  — 通过门槛但比基线退化
```

### 5. 环境变量注入

| 环境变量 | 用途 |
|----------|------|
| `AIPROBE_TARGET` | 完整的被测 URL |
| `AIPROBE_AUTH_TOKEN` | 鉴权 token |
| `AIPROBE_AUTH_HEADER` | 鉴权头名称 |
| `AIPROBE_BODY` | JSON 请求体 |
| `AIPROBE_HEADERS` | 自定义请求头 JSON |
| `AIPROBE_ROLE_TOKENS` | 场景中多角色的 token 映射 |

### 6. 诊断链

```
performance-run:
  validate → inject-secrets → generate-plan → spawn → parse-summary → write-report → complete
```

每一步都会记录到诊断缓冲（`diagnostics.forTask(context).step(stepId, safeData)`），导出时脱敏。

## 完整示例

```yaml
id: "tc_perf_create_order_50vu"
title: "性能-创建订单-50VU持续30秒POST"
project_id: "proj_ecommerce"
type: "api"
execution_mode: "api"
priority: "P1"
category: "功能测试"
module_path: ["性能测试", "订单接口", "创建订单"]
status: "reviewed"
owner: "perf-team"
preconditions:
  - "[ENV] 电商 test 环境可达，非生产"
  - "[ENV] /orders POST 接口正常响应"
  - "[AUTH] buyer 角色 token 已在钥匙串"
  - "[RUNTIME] k6 v0.49+ 已安装"
  - "[STATE] 无并行性能任务占用通道"
  - "[STATE] 商品 goodsId=1001 库存 ≥5000"
data_refs: []
steps:
  - "以 50 VU 并发 POST /orders {goodsId: 1001}"
  - "持续 30 秒稳态（10s ramp-up + 30s 稳态 + 10s ramp-down）"
  - "收集 P95 响应时间和失败率"
expected:
  - "P95 ≤ 500ms"
  - "失败率 ≤ 1%"
  - "业务码校验：code=0 或 code=200 视为成功"
performance:
  path: "/orders"
  method: "POST"
  body:
    goodsId: 1001
  auth: true
  role: "buyer"
  vus: 50
  seconds: 30
  rampUp: 10
  rampDown: 10
  p95Ms: 500
  maxFailureRate: 0.01
  checkBusinessCode: true
  caseId: "tc_create_order"
  definitionId: "def_orders_post"
  definitionRevision: 5
  definitionName: "创建订单"
  baselineId: ""
```
