# AIProbe 性能测试实现方案

- 文档版本：v1.0
- 编写日期：2026-11-16
- 文档状态：设计建议，待评审；不代表功能已实现
- 适用范围：接口性能测试（单接口压测、场景级压测、性能趋势与 CI）

## 目录

1. [现状分析](#1-现状分析)
2. [目标与原则](#2-目标与原则)
3. [整体架构](#3-整体架构)
4. [一期：多方法 + 鉴权 + 基础指标](#4-一期多方法--鉴权--基础指标)
5. [二期：场景级压测 + 阶梯负载 + 报告](#5-二期场景级压测--阶梯负载--报告)
6. [三期：趋势分析 + CI + 基线退化检测](#6-三期趋势分析--ci--基线退化检测)
7. [数据模型](#7-数据模型)
8. [界面设计](#8-界面设计)
9. [边界与待确认事项](#9-边界与待确认事项)

## 1. 现状分析

性能测试能力已有骨架，落在桌面端 TypeScript 层：

| 位置 | 现有内容 |
| --- | --- |
| `desktop/src/shared/performance.ts` | `PerformanceOptions` / `PerformanceResult` 类型（路径、VU、秒数、P95、失败率） |
| `desktop/src/main/performance.ts` | `performancePlan()` 生成 k6 GET 脚本；`runPerformance()` spawn k6、解析 summary、写 JSON 报告；`listPerformance()` 读历史 |
| `desktop/src/main/orchestrator.ts` | `runPerformance()` 编排：环境校验、生产拒绝、任务互斥、abort 支持 |
| `desktop/src/renderer/pages/OpsPage.tsx` | 工程化页「性能测试」页签：表单 + 历史表格 |

已实现的能力与约束：

- 仅支持 **GET、无鉴权、无请求体** 的单接口压测；
- k6 以 `spawn("k6", ...)` 本地执行，`--summary-export` 输出 JSON 指标；
- 结果写入 `reports/performance/perf-*.json`（workspace 内），保留 scriptHash 与环境指纹；
- 安全边界已经建立：生产环境拒绝、VU 1–100、时长 1–300 秒、目标路径必须是环境内相对路径且不含查询参数、单任务互斥、可中断；
- Agent 不参与执行（`source: "performance"` 只显示任务状态）。

### 缺口

| 维度 | 当前 | 需要 |
| --- | --- | --- |
| HTTP 方法 | 仅 GET | GET / POST / PUT / DELETE，可带 JSON body |
| 鉴权 | 无 | 复用项目环境的 Token / 接口登录 / 角色凭据 |
| 场景 | 单接口 | 从功能用例（`api` / `api_flow`）派生性能场景 |
| 负载模型 | 固定 VU | ramp-up → 稳态 → ramp-down 阶梯负载 |
| 指标 | P95 + 失败率 | P50 / P90 / P95 / P99、吞吐量、每接口分段统计 |
| 趋势 | 无 | 跨次对比、性能基线与退化检测 |
| 报告 | JSON 裸数据 | HTML 可视化报告（延迟分布、分步统计、负载曲线） |
| CI | 无 | `aitest-ci perf` 无界面执行，与功能回归同流水线 |

## 2. 目标与原则

核心目标：

1. **复用功能用例**：从已有的单接口用例 / `api_flow` 场景一键派生性能配置，不重新手写请求。
2. **确定性执行**：性能脚本由引擎确定性生成，执行不消耗模型，延续「AI 写、不跑」原则。
3. **可观测**：每次执行产出结构化指标 + HTML 报告 + 趋势，门槛判定可追溯。
4. **CI 友好**：`aitest-ci perf` 无界面执行性能回归，输出 JUnit 与摘要，与功能回归同一套凭据注入方式。

设计原则：

- **不建设通用压测平台**。性能测试服务于接口测试主线——验证已有接口在预期负载下的响应时间和稳定性。分布式压测、流量录制回放、协议级压测（gRPC / WebSocket）不在本方案范围。
- **安全边界不放松**：生产环境禁止、VU / 时长有硬上限、k6 脚本由引擎生成而非用户自由编写、凭据只经环境变量注入不落盘。
- **语义与功能测试一致**：鉴权、加密 headers、变量渲染沿用 `api_runtime.py` 的语义；场景压测的变量隔离对应 `variable_scope: "case"`。

## 3. 整体架构

```text
桌面端 UI（OpsPage 性能页签）/ aitest-ci perf
        │ IPC / CLI
编排层 orchestrator.runPerformance()
        │
        ├── TypeScript：performance.ts
        │     · performancePlan() 生成 k6 脚本（多方法 / 场景 / 阶梯）
        │     · spawn k6、超时与中断管理、解析 handleSummary JSON
        │
        └── Python 引擎：engine/aitest/perf.py（二期新增）
              · compile / compile-scenario：用例 → 场景 JSON / k6 脚本
              · save-result / report / compare：入库、HTML 报告、对比
              · 复用 api_runtime 的鉴权与加密配置语义
                    │
                    ▼
              k6（本地执行，Go 协程并发）
```

### 关键决策：继续使用 k6

| 备选 | 结论 |
| --- | --- |
| **k6（推荐，现状延续）** | 已有代码基础；Go 协程并发性能远优于 Python；内置百分位、阶梯负载、threshold；summary JSON 标准化。 |
| Python httpx + asyncio | 无需额外依赖、可直接复用 `api_runtime.py`；但受 GIL / asyncio 限制，需自行实现百分位与阶梯，不适合大并发。 |

**桥接策略**：Python 引擎负责「编译」——把功能用例的请求配置 + 鉴权信息编译为结构化场景；TypeScript 层负责「调度」——生成最终 k6 脚本、spawn k6、流式读取指标。两端通过场景 JSON 和 summary JSON 通信，不引入新 IPC 协议。

## 4. 一期：多方法 + 鉴权 + 基础指标

优先级 P0。目标：覆盖「单接口带鉴权的性能验证」这一最高频场景。

### 4.1 功能范围

1. **支持 GET / POST / PUT / DELETE + JSON Body**
   扩展 `performancePlan()`，接收 `method` 和 `body`。k6 脚本按 method 调用对应 http API，body 作为 JSON payload。
2. **复用项目鉴权**
   - Token 通过环境变量（如 `AIPROBE_AUTH_TOKEN`）注入 k6 进程，**不写入脚本文件**；
   - 接口登录场景：在 k6 `setup()` 中发一次登录请求，token 返回给所有 VU 共享；
   - 支持自定义鉴权头名（`auth_header`）、Bearer 前缀、角色选择（从钥匙串取角色 token 注入）；
   - 加密接口的固定 headers（如 clientid）注入脚本默认 headers。
3. **丰富指标采集**
   用 k6 `handleSummary()` 输出完整 JSON：请求总数、RPS、失败率、P50/P90/P95/P99、avg/min/max、data_sent / data_received。
4. **从功能用例派生性能配置**
   用例详情页增加「性能测试」入口：读取用例 `ApiSpec`（method、path、headers、body、auth）自动填入性能面板，用户只设定 VU / 时长 / 阈值。

### 4.2 代码改造点

| 文件 | 改动 |
| --- | --- |
| `shared/performance.ts` | `PerformanceOptions` 增加 `method`、`body`、`headers`、`auth`、`role`、`caseId`；`PerformanceResult` 增加 `p50Ms/p90Ms/p99Ms/avgMs/minMs/maxMs/dataSentBytes/dataReceivedBytes` |
| `main/performance.ts` | `performancePlan()` 按 method 生成脚本；`runPerformance()` 注入鉴权环境变量；解析完整 summary |
| `main/orchestrator.ts` | `runPerformance()` 从钥匙串取环境默认 token / 角色 token 注入；沿用生产拒绝与任务互斥 |
| `renderer/pages/OpsPage.tsx` | 表单增加 method / body / headers / 鉴权配置；历史表增加 P50/P90/P99 列 |
| `shared/ipc.ts` | IPC 类型跟随扩展 |

### 4.3 生成的 k6 脚本示例

```javascript
import http from 'k6/http';
import { sleep } from 'k6';

export const options = {
  vus: 10,
  duration: '30s',
  maxRedirects: 0,
  discardResponseBodies: true,
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<=0.01'],
  },
};

export default function () {
  const params = {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': __ENV.AIPROBE_AUTH_TOKEN, // 环境变量注入，不落盘
    },
    timeout: '10s',
  };
  http.post(__ENV.AIPROBE_TARGET, JSON.stringify({ goodsId: 1001, quantity: 1 }), params);
  sleep(1);
}

export function handleSummary(data) {
  return { [__ENV.AIPROBE_SUMMARY]: JSON.stringify(data) };
}
```

### 4.4 验收标准

- 可对 POST 接口执行性能测试，请求体与功能用例一致；
- 鉴权 Token 正确注入，受保护接口不出现全量 401/403；
- 结果面板展示 P50 / P90 / P95 / P99 及失败率；
- 从单接口用例页可一键跳转性能面板并自动填入配置；
- 生产环境仍然拒绝执行，VU / 时长上限不变。

## 5. 二期：场景级压测 + 阶梯负载 + 报告

优先级 P1。价值取决于实际项目中 `api_flow` 的使用率，建议一期交付后评估。

### 5.1 场景级性能测试

从 `api_flow` 用例派生性能场景：一个场景包含多个有序步骤，每个 VU 独立执行完整步骤序列（如：创建订单 → 查询 → 取消），步骤间变量传值。

```text
功能用例 (api_flow)
    │  引擎编译 perf compile-scenario
场景 JSON（步骤、变量提取、鉴权配置、脱敏）
    │  TypeScript 生成 performance.ts
k6 脚本（group 分步、extract 传值、每步分段统计）
    │  k6 run
按 group 分段的指标（每组独立的 count/p95/failureRate）
```

k6 场景脚本结构（示意）：

```javascript
import http from 'k6/http';
import { group, sleep } from 'k6';

export default function (data) {
  let vars = {}; // 每个 VU 独立，互不串值
  group('1-创建订单', () => {
    const res = http.post(`${__ENV.AIPROBE_BASE}/orders`,
      JSON.stringify({ goodsId: 1001, quantity: 1 }),
      { headers: { Authorization: data.token, 'Content-Type': 'application/json' } });
    vars.orderId = JSON.parse(res.body).data.orderId;
  });
  group('2-查询订单', () => {
    http.get(`${__ENV.AIPROBE_BASE}/orders/${vars.orderId}`,
      { headers: { Authorization: data.token } });
  });
  group('3-取消订单', () => {
    http.del(`${__ENV.AIPROBE_BASE}/orders/${vars.orderId}`,
      null, { headers: { Authorization: data.token } });
  });
  sleep(1);
}
```

**变量隔离**：每个 VU 独立 `vars` 对象，与功能测试 `variable_scope: "case"` 语义一致；不同 VU 创建的订单 ID 不会串用。

**注意事项**：场景压测对有副作用的接口（下单、支付）会产生大量真实数据，界面上必须醒目提示；清理步骤不进入压测路径（压测期间不执行 db_setup / cleanup，只保留业务步骤）。

### 5.2 阶梯负载（Ramping VUs）

```javascript
export const options = {
  stages: [
    { duration: '20s', target: 50 }, // ramp-up
    { duration: '60s', target: 50 }, // steady
    { duration: '10s', target: 0 },  // ramp-down
  ],
  thresholds: { /* 同前 */ },
};
```

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `rampUp` | 秒 | min(VU × 2, 60) | 线性增加到目标 VU |
| `steady` | 秒 | `seconds` 参数 | 目标 VU 持续时间 |
| `rampDown` | 秒 | 10 | 线性降到 0 |

总时长上限仍受 300 秒硬约束（三段合计校验）。

### 5.3 HTML 性能报告

新增 `engine/aitest/perf_report.py`，复用 `reports.py` 的设计语言生成单文件 HTML：

- 概览卡片：总请求数、RPS、失败率、P95、传输量；
- 延迟分布：P50 / P90 / P95 / P99 标注；
- 分步骤统计：场景中每个 group 单独的延迟与失败率；
- 负载曲线：VU 数 × 时间 vs 响应时间；
- 门槛判定明细：每条 threshold 的通过/失败与实际值；
- 敏感信息脱敏：沿用 `_SENSITIVE` 规则，报告中不出现 token。

### 5.4 引擎层新增模块 `engine/aitest/perf.py`

| CLI 命令 | 功能 | 输入 | 输出 |
| --- | --- | --- | --- |
| `perf compile` | 编译单接口性能配置 | 用例 ID + 压测参数 | k6 脚本路径 |
| `perf compile-scenario` | 编译 api_flow 场景 | 场景用例 ID + 压测参数 | k6 脚本路径 |
| `perf save-result` | 存储执行结果 | k6 summary JSON | 结构化 PerformanceResult |
| `perf report` | 生成 HTML 报告 | 结果 ID(s) | HTML 文件路径 |
| `perf compare` | 两次结果对比 | 两个结果 ID | 对比摘要 JSON |

### 5.5 验收标准

- 4 步 `api_flow` 场景可一键派生为性能脚本，每步独立统计；
- 阶梯负载按配置执行，总时长校验生效；
- HTML 报告包含延迟分布与分步统计；
- 不同 VU 间变量不串值；
- 副作用提示在执行前明确展示。

## 6. 三期：趋势分析 + CI + 基线退化检测

优先级 P1，工程化收尾。

### 6.1 性能基线与退化检测

每个接口 / 场景可设定基线（手动指定某次结果，或自动取最近 N 次通过执行的均值），后续执行自动对比：

| 检测项 | 默认门槛 | 动作 |
| --- | --- | --- |
| P95 退化 | > 基线 20% | 标记 `degraded`，报告高亮 |
| RPS 下降 | < 基线 80% | 标记 `degraded` |
| 失败率上升 | > 基线 2× | 标记 `degraded` |

退化不算「失败」（与 threshold 失败区分开），但在报告与 CI 摘要中单独列出。

### 6.2 趋势图

性能面板增加趋势视图：同一目标的最近 N 次 P95 / RPS 折线，基线水平虚线标注，退化点红色标记可跳转报告。

### 6.3 CI 集成

```bash
# 单接口
aitest-ci perf --workspace . --env test \
  --path /api/orders --method POST --body '{"goodsId":1001}' \
  --vus 20 --seconds 30 --p95 500 --max-failure-rate 0.01

# 场景
aitest-ci perf --workspace . --env test --scenario tc_abc123 --vus 20 --seconds 30
```

输出：

- `reports/ci/perf-summary.md`（GitHub Step Summary / GitLab section）
- `reports/ci/perf-junit.xml`（每条 threshold 一个 testcase）
- `reports/ci/perf-report.html`（完整报告）

CI 行为：凭据只从 CI 密钥读取（与功能回归一致的 `AITEST_AUTH_TOKEN` / `AITEST_ROLES`）；与基线对比退化超门槛时 exit 1。

### 6.4 性能测试集

多个接口 / 场景的性能配置保存为测试集：串行独立执行、独立统计、汇总对比表、一条 CI 命令跑完。

### 6.5 验收标准

- 设定基线后自动对比并标记退化；
- 趋势图展示最近 20 次执行变化；
- `aitest-ci perf` 在 GitHub Actions 可执行，退化时 exit 1；
- 测试集可保存、加载、一次执行多目标。

## 7. 数据模型

### 7.1 `PerformanceOptions`（渐进扩展）

```typescript
interface PerformanceOptions {
  // 一期已有
  path: string;
  vus: number;
  seconds: number;
  p95Ms: number;
  maxFailureRate: number;
  // 一期新增
  method: "GET" | "POST" | "PUT" | "DELETE"; // 默认 GET
  body?: unknown;
  headers?: Record<string, string>;
  auth?: boolean;      // 默认 true
  role?: string;
  caseId?: string;     // 来源用例
  // 二期新增
  scenarioId?: string;
  rampUp?: number;
  rampDown?: number;
  // 三期新增
  baselineId?: string;
  degradeThreshold?: { p95Pct: number; rpsPct: number; failureMultiple: number };
}
```

### 7.2 `PerformanceResult`（渐进扩展）

```typescript
interface PerformanceResult {
  /* 一期已有字段不变 */
  status: "passed" | "failed" | "stopped" | "error" | "degraded"; // degraded 三期新增
  // 一期新增
  p50Ms: number | null; p90Ms: number | null; p99Ms: number | null;
  avgMs: number | null; minMs: number | null; maxMs: number | null;
  dataSentBytes: number | null; dataReceivedBytes: number | null;
  // 二期新增
  steps?: { name: string; requests: number; p95Ms: number; avgMs: number; failureRate: number }[];
  htmlReportPath?: string;
  // 三期新增
  baselineId?: string;
  degradation?: { baseline: {...}; current: {...}; degraded: boolean; details: string[] };
}
```

### 7.3 存储

| 阶段 | 方式 | 说明 |
| --- | --- | --- |
| 一期 | JSON 文件（现状延续） | `reports/performance/perf-*.json` |
| 二期 | JSON + event_log | 结果摘要以 `kind='performance'` 事件写 SQLite，directStore 可查 |
| 三期 | `perf_baseline` 表 | `project_id, target_key, result_id, set_at` |

## 8. 界面设计

一期（OpsPage 性能页签增强）：

```text
环境 [test ▾]   方法 [POST ▾]   路径 [/api/orders        ]
请求体  { "goodsId": 1001, "quantity": 1 }
鉴权 [✓ 使用环境凭据]   角色 [默认 ▾]
VU [10]   时长 [30] 秒   P95 阈值 [500] ms   失败率 [0.01]
[从用例填入 ▾]                              [开始测试]
────────────────────────────────────────────
历史结果：环境 / 方法 / 状态 / 请求数 / RPS / P95 / 失败率 / 时间
```

二期：增加「场景压测」子页签（从 api_flow 用例选择）、阶梯负载配置与 VU 曲线预览、结果行「查看报告」按钮。
三期：增加「趋势」子页签（P95 / RPS 折线 + 基线虚线）、结果行「设为基线」操作、退化高亮。

## 9. 边界与待确认事项

### 9.1 安全边界（不可突破）

- 生产环境一律拒绝；
- VU ≤ 100、总时长 ≤ 300 秒（阶梯模式校验三段合计）；
- k6 脚本由引擎生成，不提供用户自定义脚本入口；
- 凭据只经环境变量注入 k6 进程，脚本文件与报告中不出现；
- 目标必须是当前环境内相对路径（沿用现有校验）。

### 9.2 不做的事情

| 能力 | 原因 | 替代 |
| --- | --- | --- |
| 分布式压测 | 桌面工具定位 | 导出 k6 脚本到 k6 Cloud / 自建集群 |
| gRPC / WebSocket 压测 | 当前接口线仅 HTTP REST | 后续按需 |
| 流量录制回放 | 复杂度高、与用例复用策略冲突 | 场景编译覆盖主需求 |
| 自定义 k6 脚本 | 任意代码执行风险 | 用例配置 + 引擎编译 |
| 实时指标流 | stdout 解析复杂、收益有限 | 三期可评估 `--out json` |

### 9.3 待确认事项

1. **k6 分发**：当前依赖用户自装 k6（ENOENT 时有提示）。是否随安装包按平台分发 k6 二进制？k6 为 Go 单文件，打包可行，但会增大安装包体积。
2. **多 VU 鉴权策略**：所有 VU 共享一个 Token 是否足够？若目标系统对单 Token 限流，二期需支持多角色 Token 池轮转。
3. **迭代间隔**：当前固定 `sleep(1)`。是否需要可配置间隔或随机间隔（`sleep(Math.random() * 2)`）以模拟更真实的节奏？
4. **数据保留**：perf JSON / HTML 报告的保留条数与自动清理策略。
5. **阈值扩展**：是否需要支持用户自定义多条 threshold（如同时限制 P99 < 2s）？
6. **场景压测的数据副作用**：`api_flow` 压测会在被测环境产生大量业务数据，是否需要增加「压测专用环境标记」或执行前二次确认的强提示？

### 9.4 实施排期建议

| 阶段 | 预估工作量 | 依赖 | 交付物 |
| --- | --- | --- | --- |
| 一期 | 3–5 天 | 无外部依赖 | 多方法 + 鉴权 + 丰富指标 + 用例派生 |
| 二期 | 5–7 天 | 一期完成；api_flow 用例可用 | 场景压测 + 阶梯负载 + HTML 报告 |
| 三期 | 4–6 天 | 二期完成；aitest-ci 基础设施 | 趋势图 + 基线退化 + CI 集成 |

**建议优先级**：一期覆盖 80% 的使用场景（单接口带鉴权性能验证），先交付并收集反馈，再决定二、三期的优先级与细节；二期（场景级压测）的价值取决于实际项目中 `api_flow` 的使用率。
