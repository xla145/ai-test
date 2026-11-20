# 性能测试改进 — 技术实现方案

- 文档版本：v1.0
- 编写日期：2026-11-19
- 前置文档：`docs/performance-testing-design.md`（原设计）、`docs/performance-testing-improvements.md`（改进方向）
- 文档状态：技术实现方案，待评审

---

## 目录

1. [改动总览与文件清单](#1-改动总览与文件清单)
2. [改动一：趋势 series key 去除 definitionRevision](#2-改动一趋势-series-key-去除-definitionrevision)
3. [改动二：迭代间隔 thinkTime 可配置](#3-改动二迭代间隔-thinktime-可配置)
4. [改动三：统一退化对比逻辑至 TypeScript](#4-改动三统一退化对比逻辑至-typescript)
5. [改动四：buildK6Options 阶梯模式补齐 discardResponseBodies](#5-改动四buildk6options-阶梯模式补齐-discardresponsebodies)
6. [改动五：业务码校验规则可配置](#6-改动五业务码校验规则可配置)
7. [改动六：切换接口时表单状态显式处理](#7-改动六切换接口时表单状态显式处理)
8. [改动七：接口选择器分组分行展示](#8-改动七接口选择器分组分行展示)
9. [改动八：趋势图网格刻度优化](#9-改动八趋势图网格刻度优化)
10. [测试计划](#10-测试计划)
11. [实施顺序与风险评估](#11-实施顺序与风险评估)

---

## 1. 改动总览与文件清单

### 1.1 涉及文件矩阵

| 文件路径 | 改动一 | 改动二 | 改动三 | 改动四 | 改动五 | 改动六 | 改动七 | 改动八 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `desktop/src/shared/performance.ts` | | ✦ | ✦ | | ✦ | | | |
| `desktop/src/shared/performanceSource.ts` | | ✧ | | | | | | |
| `desktop/src/main/performance.ts` | | ✦ | ✦ | ✦ | ✦ | | | |
| `desktop/src/renderer/pages/performanceView.ts` | ✦ | | | | | | | |
| `desktop/src/renderer/pages/PerformancePage.tsx` | | ✦ | | | ✦ | ✦ | ✦ | ✦ |
| `desktop/src/renderer/pages/PerformancePage.css` | | | | | | | ✦ | |
| `desktop/src/renderer/performanceDemo.ts` | | | | | | | | |
| `engine/aitest/perf.py` | | | ✦ | | | | | |
| `desktop/test/performance.test.ts` | | ✦ | ✦ | ✦ | ✦ | | | |
| `desktop/test/performance-source.test.ts` | ✦ | | | | | | | |
| `desktop/test/performance-runtime.test.ts` | | ✦ | | ✦ | | | | |

✦ = 修改  ✧ = 校验逻辑新增

### 1.2 不改动的文件

以下文件经评审后确认无需改动：

- `desktop/src/main/orchestrator.ts` — 编排层透传 `PerformanceOptions`，新增字段自动透传，无需修改
- `desktop/src/shared/ipc.ts` — IPC 类型为 `PerformanceOptions`，新增可选字段后 IPC 契约自动兼容
- `desktop/src/renderer/performanceDemo.ts` — 演示数据使用默认值，不受新字段影响

---

## 2. 改动一：趋势 series key 去除 definitionRevision

### 2.1 当前代码

```ts
// desktop/src/renderer/pages/performanceView.ts:7-12
export const performanceSeriesKey = (r: PerformanceResult) => JSON.stringify([
  r.env, r.options.definitionId ?? "", r.options.definitionRevision ?? 0,
  performanceTargetKey(r.options), r.options.vus, r.options.seconds,
  r.options.rampUp ?? 0, r.options.rampDown ?? 0, r.options.auth !== false, r.options.role ?? "",
  r.options.checkBusinessCode ?? false,
]);
```

```ts
// desktop/src/renderer/pages/performanceView.ts:14-20
export function performanceSeriesLabel(r: PerformanceResult): string {
  const o = r.options;
  const target = o.scenarioId ? `场景 ${o.scenarioId}` : `${o.method ?? "GET"} ${o.path}`;
  const load = (o.rampUp ?? 0) + (o.rampDown ?? 0) > 0
    ? `${o.rampUp ?? 0} + ${o.seconds} + ${o.rampDown ?? 0}s` : `${o.seconds}s`;
  return `${o.definitionName ? `${o.definitionName} · ` : ""}${target} · ${o.vus} VU · ${load}${o.definitionRevision ? ` · r${o.definitionRevision}` : ""}`;
}
```

### 2.2 目标代码

```ts
// desktop/src/renderer/pages/performanceView.ts — performanceSeriesKey
export const performanceSeriesKey = (r: PerformanceResult) => JSON.stringify([
  r.env,
  r.options.definitionId ?? "",
  performanceTargetKey(r.options),
  r.options.vus,
  r.options.seconds,
  r.options.rampUp ?? 0,
  r.options.rampDown ?? 0,
  r.options.auth !== false,
  r.options.role ?? "",
  r.options.checkBusinessCode ?? false,
]);
```

```ts
// desktop/src/renderer/pages/performanceView.ts — performanceSeriesLabel
export function performanceSeriesLabel(r: PerformanceResult): string {
  const o = r.options;
  const target = o.scenarioId ? `场景 ${o.scenarioId}` : `${o.method ?? "GET"} ${o.path}`;
  const load = (o.rampUp ?? 0) + (o.rampDown ?? 0) > 0
    ? `${o.rampUp ?? 0} + ${o.seconds} + ${o.rampDown ?? 0}s` : `${o.seconds}s`;
  return `${o.definitionName ? `${o.definitionName} · ` : ""}${target} · ${o.vus} VU · ${load}`;
}
```

### 2.3 测试修改

```ts
// desktop/test/performance-source.test.ts
// 测试用例 "sorts oldest first and never joins different targets, environments or loads"
// 现有断言不受影响：它用 performanceSeriesKey(product) 生成 key 再去过滤，
// 只要同一接口不同 revision 的数据能归到同一条线即可。
// 新增断言：
it("joins results across definition revisions into one trend line", async () => {
  const demo = createPerformanceDemo(catalogue().listApiDefinitions);
  const rows = await demo.performanceHistory("p");
  const target = rows.find(r => r.status === "passed")!;
  const key = performanceSeriesKey(target);
  // 模拟定义更新后的新执行：revision 变了，其余配置不变
  const updatedRevision = {
    ...target,
    id: "revised",
    options: { ...target.options, definitionRevision: (target.options.definitionRevision ?? 0) + 1 },
  };
  const points = performanceTrend([...rows, updatedRevision], key);
  expect(points.some(r => r.id === "revised")).toBe(true);
});
```

### 2.4 兼容性

历史 JSON 报告中 `definitionRevision` 字段保留不删除，只是不再作为趋势聚合维度。已有的历史数据在改动后会自动合并到同一趋势线中，这正是预期行为。

---

## 3. 改动二：迭代间隔 thinkTime 可配置

### 3.1 类型层：`shared/performance.ts`

在 `PerformanceOptions` 接口中新增字段（位于 `rampDown` 之后、`baselineId` 之前）：

```ts
// desktop/src/shared/performance.ts — PerformanceOptions 新增字段
/** 每次迭代后的思考时间（秒），默认 1。设为 0 表示无间隔连续请求。 */
thinkTime?: number;
```

### 3.2 校验层：`main/performance.ts`

在 `validateBase` 函数末尾（`return url` 之前）新增校验：

```ts
// desktop/src/main/performance.ts — validateBase 函数内
const thinkTime = options.thinkTime ?? 1;
if (!Number.isFinite(thinkTime) || thinkTime < 0 || thinkTime > 10)
  throw new Error("迭代间隔应为 0–10 秒");
```

### 3.3 脚本生成：`main/performance.ts`

#### 3.3.1 `performancePlan` 函数

找到当前的：

```ts
// desktop/src/main/performance.ts — performancePlan 内，约第 195 行
lines.push(`  sleep(1);`);
```

替换为：

```ts
const thinkTime = options.thinkTime ?? 1;
if (thinkTime > 0) {
  lines.push(`  sleep(${thinkTime});`);
}
```

如果 `thinkTime` 为 0，同时不再需要 `import { sleep } from 'k6';`。但为了简单起见（sleep 是 k6 内置），保留 import 不做条件移除——未使用的 import 在 k6 中不产生副作用。

#### 3.3.2 `scenarioPlan` 函数

找到当前的：

```ts
// desktop/src/main/performance.ts — scenarioPlan 内，约第 319 行
lines.push(`  sleep(1);`);
```

替换为相同逻辑：

```ts
const thinkTime = options.thinkTime ?? 1;
if (thinkTime > 0) {
  lines.push(`  sleep(${thinkTime});`);
}
```

### 3.4 绑定层：`shared/performanceSource.ts`

`bindPerformanceDefinition` 函数的返回对象已经使用 `...options` 展开，新增的 `thinkTime` 字段会自动透传，无需额外处理。确认 `thinkTime` 不在函数末尾的清除列表中即可。

### 3.5 UI 层：`renderer/pages/PerformancePage.tsx`

#### 3.5.1 新增 state

在现有 `const [rampDown, setRampDown] = useState(10);` 之后新增：

```tsx
const [thinkTime, setThinkTime] = useState(1);
```

#### 3.5.2 传入 options

在 `start` 函数的 `bindPerformanceDefinition` 调用中，`...(useRamp ? { rampUp, rampDown } : {})` 之后新增：

```tsx
const options = bindPerformanceDefinition(selected, {
  // ...existing fields...
  ...(useRamp ? { rampUp, rampDown } : {}),
  thinkTime,
});
```

#### 3.5.3 负载行 UI

在 `perf-load-row` 中，`rampDown` 输入之后、`perf-load-total` 之前，新增间隔输入：

```tsx
<Form.Item label="间隔秒" htmlFor="perf-think">
  <InputNumber id="perf-think" min={0} max={10} step={0.5} precision={1}
    value={thinkTime} onChange={v => setThinkTime(v ?? 1)} style={{ width: 72 }} />
</Form.Item>
```

#### 3.5.4 无间隔提示

在 `perf-run-actions` 的 `Typography.Text` 之后新增条件提示：

```tsx
{thinkTime === 0 && <Typography.Text type="warning" style={{ fontSize: 12 }}>
  无间隔模式：VU 将连续发送请求，请确认被测环境可承受。
</Typography.Text>}
```

### 3.6 测试

```ts
// desktop/test/performance.test.ts — "performance plan" describe 内新增

it("uses configurable think time in sleep", () => {
  const plan = performancePlan(base, { ...defaults, thinkTime: 0.5 });
  expect(plan.code).toContain("sleep(0.5)");
  expect(plan.code).not.toContain("sleep(1)");
});

it("omits sleep when thinkTime is 0", () => {
  const plan = performancePlan(base, { ...defaults, thinkTime: 0 });
  expect(plan.code).not.toContain("sleep(");
});

it("defaults to sleep(1) when thinkTime is not set", () => {
  const plan = performancePlan(base, defaults);
  expect(plan.code).toContain("sleep(1)");
});

it("rejects thinkTime out of range", () => {
  expect(() => performancePlan(base, { ...defaults, thinkTime: -1 })).toThrow("间隔");
  expect(() => performancePlan(base, { ...defaults, thinkTime: 11 })).toThrow("间隔");
});
```

```ts
// desktop/test/performance.test.ts — "scenario plan" describe 内新增

it("uses configurable think time in scenario", () => {
  const plan = scenarioPlan(base, {
    ...defaults, thinkTime: 0,
    scenarioSteps: [{ name: "ping", method: "GET", path: "/ping" }],
  });
  expect(plan.code).not.toContain("sleep(");
});
```

```ts
// desktop/test/performance-runtime.test.ts — 新增

it("generated script with thinkTime=0 has no sleep call", () => {
  const plan = performancePlan("http://localhost:3000", {
    ...options, thinkTime: 0,
  });
  const hasNoSleep = !plan.code.includes("sleep(");
  expect(hasNoSleep).toBe(true);
});
```

---

## 4. 改动三：统一退化对比逻辑至 TypeScript

### 4.1 TypeScript 侧：`main/performance.ts`

#### 4.1.1 新增 `DegradationThreshold` 类型

在 `shared/performance.ts` 的 `PerformanceOptions` 之前新增：

```ts
// desktop/src/shared/performance.ts — 新增接口
export interface DegradationThreshold {
  /** P95 退化百分比门槛，默认 0.2 表示 20%。 */
  p95Pct?: number;
  /** RPS 下降百分比门槛，默认 0.2 表示 20%。 */
  rpsPct?: number;
  /** 失败率倍数门槛，默认 2。 */
  failureMultiple?: number;
}
```

在 `PerformanceOptions` 中新增字段（`baselineId` 之后）：

```ts
/** 三期：退化检测自定义门槛 */
degradeThreshold?: DegradationThreshold;
```

#### 4.1.2 修改 `compareWithBaseline`

当前代码（`performance.ts:331-361`）：

```ts
export function compareWithBaseline(current: PerformanceResult, baseline: PerformanceResult): DegradationResult {
  const bp95 = baseline.p95Ms ?? 0;
  const brps = baseline.requestsPerSecond ?? 0;
  const bfail = baseline.failureRate ?? 0;
  const cp95 = current.p95Ms ?? 0;
  const crps = current.requestsPerSecond ?? 0;
  const cfail = current.failureRate ?? 0;

  const details: string[] = [];
  if (bp95 > 0 && cp95 > bp95 * 1.2) {
    details.push(`P95 延迟退化：${cp95.toFixed(1)}ms > 基线 ${bp95.toFixed(1)}ms 的 120%`);
  }
  if (brps > 0 && crps < brps * 0.8) {
    details.push(`RPS 下降：${crps.toFixed(1)} < 基线 ${brps.toFixed(1)} 的 80%`);
  }
  if ((bfail > 0 && cfail > bfail * 2) || (bfail === 0 && cfail > 0.01)) {
    details.push(`失败率上升：${(cfail * 100).toFixed(2)}% vs 基线 ${(bfail * 100).toFixed(2)}%`);
  }
  // ...return
}
```

替换为：

```ts
export function compareWithBaseline(current: PerformanceResult, baseline: PerformanceResult): DegradationResult {
  const threshold = current.options.degradeThreshold ?? {};
  const p95Pct = threshold.p95Pct ?? 0.2;
  const rpsPct = threshold.rpsPct ?? 0.2;
  const failureMultiple = threshold.failureMultiple ?? 2;

  const bp95 = baseline.p95Ms ?? 0;
  const brps = baseline.requestsPerSecond ?? 0;
  const bfail = baseline.failureRate ?? 0;
  const cp95 = current.p95Ms ?? 0;
  const crps = current.requestsPerSecond ?? 0;
  const cfail = current.failureRate ?? 0;

  const details: string[] = [];
  if (bp95 > 0 && cp95 > bp95 * (1 + p95Pct)) {
    const pct = ((cp95 - bp95) / bp95 * 100).toFixed(0);
    details.push(`P95 延迟退化 ${pct}%：${cp95.toFixed(1)}ms > 基线 ${bp95.toFixed(1)}ms 的 ${((1 + p95Pct) * 100).toFixed(0)}%`);
  }
  if (brps > 0 && crps < brps * (1 - rpsPct)) {
    const drop = ((brps - crps) / brps * 100).toFixed(0);
    details.push(`RPS 下降 ${drop}%：${crps.toFixed(1)} < 基线 ${brps.toFixed(1)} 的 ${((1 - rpsPct) * 100).toFixed(0)}%`);
  }
  if ((bfail > 0 && cfail > bfail * failureMultiple) || (bfail === 0 && cfail > 0.01)) {
    details.push(`失败率上升：${(cfail * 100).toFixed(2)}% vs 基线 ${(bfail * 100).toFixed(2)}%（门槛 ${failureMultiple}×）`);
  }

  return {
    baselineId: baseline.id,
    baseline: { p95Ms: bp95, rps: brps, failureRate: bfail },
    current: { p95Ms: cp95, rps: crps, failureRate: cfail },
    degraded: details.length > 0,
    details,
  };
}
```

### 4.2 Python 侧：`engine/aitest/perf.py`

将 `compare_results` 函数（第 101-148 行）替换为读取 TypeScript 层已写入 JSON 报告的退化结果：

```python
def compare_results(result_path: str | Path) -> dict[str, Any]:
    """读取 TypeScript 层已计算的退化结果。

    TypeScript 的 runPerformance() 在写出 JSON 报告时已包含 degradation 字段，
    此函数直接读取，不重复计算，确保桌面端与 CI 的退化判定完全一致。
    """
    data = json.loads(Path(result_path).read_text(encoding="utf-8"))
    degradation = data.get("degradation")
    if degradation:
        return degradation
    return {
        "degraded": False,
        "details": [],
        "baseline": {"p95Ms": None, "rps": None, "failureRate": None},
        "current": {
            "p95Ms": data.get("p95Ms"),
            "rps": data.get("requestsPerSecond"),
            "failureRate": data.get("failureRate"),
        },
    }
```

同时在函数上方保留原始函数签名的 deprecation 注释：

```python
# 旧签名 compare_results(current: dict, baseline: dict) 已废弃。
# 二期前的调用方如仍需传入两个 dict，请迁移到读取 JSON 报告路径。
```

### 4.3 测试

```ts
// desktop/test/performance.test.ts — "compareWithBaseline" describe 内新增

it("uses custom degradation threshold from options", () => {
  const strictBase: PerformanceResult = {
    ...base,
    options: { ...base.options, degradeThreshold: { p95Pct: 0.1, rpsPct: 0.1, failureMultiple: 1.5 } },
  };
  // P95: 250 → 280 = 12% 退化，默认门槛 20% 不触发，自定义 10% 触发
  const current: PerformanceResult = {
    ...strictBase, id: "run-strict", p95Ms: 280,
  };
  const result = compareWithBaseline(current, base);
  expect(result.degraded).toBe(true);
  expect(result.details.some(d => d.includes("P95"))).toBe(true);
});

it("uses default threshold when degradeThreshold is not set", () => {
  // P95: 250 → 280 = 12% 退化，默认 20% 门槛不触发
  const current: PerformanceResult = { ...base, id: "run-default", p95Ms: 280 };
  const result = compareWithBaseline(current, base);
  expect(result.degraded).toBe(false);
});
```

---

## 5. 改动四：buildK6Options 阶梯模式补齐 discardResponseBodies

### 5.1 当前代码

```ts
// desktop/src/main/performance.ts:26-52
function buildK6Options(options: PerformanceOptions): Record<string, unknown> {
  const thresholds: Record<string, string[]> = {
    http_req_duration: [`p(95)<${options.p95Ms}`],
    http_req_failed: [`rate<=${options.maxFailureRate}`],
  };
  const rampUp = options.rampUp ?? 0;
  const rampDown = options.rampDown ?? 0;
  if (rampUp > 0 || rampDown > 0) {
    return {
      stages: [
        ...(rampUp > 0 ? [{ duration: `${rampUp}s`, target: options.vus }] : []),
        { duration: `${options.seconds}s`, target: options.vus },
        ...(rampDown > 0 ? [{ duration: `${rampDown}s`, target: 0 }] : []),
      ],
      maxRedirects: 0,
      thresholds,
    };
  }
  return {
    vus: options.vus,
    duration: `${options.seconds}s`,
    maxRedirects: 0,
    discardResponseBodies: true,
    thresholds,
  };
}
```

### 5.2 目标代码

```ts
function buildK6Options(options: PerformanceOptions): Record<string, unknown> {
  const thresholds: Record<string, string[]> = {
    http_req_duration: [`p(95)<${options.p95Ms}`],
    http_req_failed: [`rate<=${options.maxFailureRate}`],
  };
  const rampUp = options.rampUp ?? 0;
  const rampDown = options.rampDown ?? 0;
  const common = { maxRedirects: 0, discardResponseBodies: true, thresholds };
  if (rampUp > 0 || rampDown > 0) {
    return {
      stages: [
        ...(rampUp > 0 ? [{ duration: `${rampUp}s`, target: options.vus }] : []),
        { duration: `${options.seconds}s`, target: options.vus },
        ...(rampDown > 0 ? [{ duration: `${rampDown}s`, target: 0 }] : []),
      ],
      ...common,
    };
  }
  return { vus: options.vus, duration: `${options.seconds}s`, ...common };
}
```

调用方行为不变：
- `performancePlan` 中 `checkBusinessCode` 为 true 时覆盖 `discardResponseBodies: false` → 不受影响
- `scenarioPlan` 显式 `{ ...buildK6Options(options), discardResponseBodies: false }` → 不受影响

### 5.3 测试

```ts
// desktop/test/performance-runtime.test.ts — 新增

it("includes discardResponseBodies in ramping mode", () => {
  const plan = performancePlan("http://localhost:3000", {
    ...options, rampUp: 10, rampDown: 5,
  });
  expect(plan.code).toContain('"discardResponseBodies"');
});
```

---

## 6. 改动五：业务码校验规则可配置

### 6.1 类型层：`shared/performance.ts`

在 `PerformanceOptions` 中 `checkBusinessCode` 之后新增：

```ts
/** 业务成功码列表（字符串比较），默认 ["0", "200"]。设为空数组则只看 HTTP 状态码。 */
businessSuccessCodes?: string[];
```

### 6.2 脚本生成：`main/performance.ts`

#### 6.2.1 修改 `emitResponseCheck` 签名与实现

当前签名：

```ts
function emitResponseCheck(lines: string[], checkBusinessCode: boolean): void {
```

修改为：

```ts
function emitResponseCheck(lines: string[], checkBusinessCode: boolean, successCodes: string[] = ["0", "200"]): void {
```

在函数体内，将硬编码的判断：

```ts
lines.push(`      businessFailed = code !== '0' && code !== '200';`);
```

替换为：

```ts
const codesJson = JSON.stringify(successCodes);
lines.push(`      const successCodes = new Set(${codesJson});`);
lines.push(`      businessFailed = !successCodes.has(String(value.code));`);
```

#### 6.2.2 修改 `performancePlan` 中的调用

当前调用（约第 194 行）：

```ts
emitResponseCheck(lines, options.checkBusinessCode !== false);
```

修改为：

```ts
const successCodes = options.businessSuccessCodes ?? ["0", "200"];
emitResponseCheck(lines, options.checkBusinessCode !== false, successCodes);
```

### 6.3 UI 层：`renderer/pages/PerformancePage.tsx`

#### 6.3.1 新增 state

在 `checkBusinessCode` state 之后新增：

```tsx
const [businessSuccessCodes, setBusinessSuccessCodes] = useState("0, 200");
```

#### 6.3.2 折叠面板 UI

在 `请求参数与鉴权` 折叠面板内，`Checkbox` 的 `校验业务码` 之后新增：

```tsx
{checkBusinessCode && <Input
  aria-label="业务成功码"
  value={businessSuccessCodes}
  onChange={e => setBusinessSuccessCodes(e.target.value)}
  placeholder="0, 200"
  style={{ width: 160 }}
  size="small"
/>}
```

#### 6.3.3 传入 options

在 `start` 函数的 options 中新增：

```tsx
businessSuccessCodes: checkBusinessCode
  ? businessSuccessCodes.split(",").map(s => s.trim()).filter(Boolean)
  : undefined,
```

#### 6.3.4 参数说明更新

修改 `perf-parameter-note` 的文字：

```
参数来自接口定义，可调整为本次压测数据，不改接口目录。业务码校验默认 0/200 为成功，可自定义；401/403 不记为通过。
```

### 6.4 测试

```ts
// desktop/test/performance.test.ts — "performance plan" describe 内新增

it("uses custom business success codes", () => {
  const plan = performancePlan(base, {
    ...defaults, method: "POST", body: {},
    businessSuccessCodes: ["1", "success"],
  });
  expect(plan.code).toContain('new Set(["1","success"])');
  expect(plan.code).not.toContain("'0'");
  expect(plan.code).not.toContain("'200'");
});

it("uses default success codes when not specified", () => {
  const plan = performancePlan(base, { ...defaults, method: "POST", body: {} });
  expect(plan.code).toContain('new Set(["0","200"])');
});
```

---

## 7. 改动六：切换接口时表单状态显式处理

### 7.1 实现方案

采用「保留 + 显示标记 + 重置按钮」策略。

#### 7.1.1 新增默认值常量

在 `PerformancePanel` 函数体顶部新增：

```tsx
const LOAD_DEFAULTS = { vus: 5, seconds: 10, p95Ms: 1000, maxFailureRate: 0.01, useRamp: false, thinkTime: 1 } as const;
```

#### 7.1.2 计算是否为自定义配置

在 `total` 计算之后新增：

```tsx
const isCustomLoad = vus !== LOAD_DEFAULTS.vus || seconds !== LOAD_DEFAULTS.seconds
  || p95Ms !== LOAD_DEFAULTS.p95Ms || maxFailureRate !== LOAD_DEFAULTS.maxFailureRate
  || useRamp !== LOAD_DEFAULTS.useRamp || thinkTime !== LOAD_DEFAULTS.thinkTime;
```

#### 7.1.3 重置按钮

在 `perf-load-row` 末尾（`perf-load-total` 之后）新增：

```tsx
{isCustomLoad && <Button size="small" type="link" onClick={() => {
  setVus(LOAD_DEFAULTS.vus); setSeconds(LOAD_DEFAULTS.seconds);
  setP95Ms(LOAD_DEFAULTS.p95Ms); setMaxFailureRate(LOAD_DEFAULTS.maxFailureRate);
  setUseRamp(LOAD_DEFAULTS.useRamp); setThinkTime(LOAD_DEFAULTS.thinkTime);
}}>重置为默认</Button>}
```

---

## 8. 改动七：接口选择器分组分行展示

### 8.1 Select 改造

将当前的 `options` 属性改为按模块分组，并使用 `optionRender` 自定义渲染：

```tsx
<Select id="perf-definition" size="middle" showSearch optionFilterProp="label"
  loading={definitions.loading} value={selected?.id}
  placeholder="搜索接口名称、方法、路径或模块"
  onSelect={id => {
    const d = definitions.data?.find(d => d.id === id);
    if (d) selectDefinition(d);
  }}
  options={(definitions.data ?? []).map(d => ({
    value: d.id,
    label: `${d.module || "未分组"} ${d.summary || "未命名接口"} ${d.method} ${d.path}`,
    disabled: !!performanceDefinitionIssue(d),
  }))}
  optionRender={option => {
    const d = definitions.data?.find(d => d.id === option.value);
    if (!d) return option.label;
    const issue = performanceDefinitionIssue(d);
    return <div className="perf-def-option">
      <div className="perf-def-option-main">
        <Tag className="perf-method-tag">{d.method}</Tag>
        <span>{d.summary || "未命名接口"}</span>
        {issue && <Typography.Text type="danger" style={{ fontSize: 11 }}>
          （{issue}）
        </Typography.Text>}
      </div>
      <Typography.Text type="secondary" className="mono" style={{ fontSize: 11 }}>
        {d.module || "未分组"} · {d.path}
      </Typography.Text>
    </div>;
  }}
/>
```

注意 `label` 保持为纯文本字符串（包含模块、名称、方法、路径），以支持 `showSearch` + `optionFilterProp="label"` 的搜索功能。`optionRender` 只影响下拉菜单中的展示。

### 8.2 CSS

在 `PerformancePage.css` 中新增：

```css
/* ── definition option ── */
.perf-def-option { display: flex; flex-direction: column; gap: 1px; padding: 2px 0; line-height: 1.4; }
.perf-def-option-main { display: flex; align-items: center; gap: 4px; }
```

---

## 9. 改动八：趋势图网格刻度优化

### 9.1 新增工具函数

在 `PerformancePage.tsx` 文件底部（`PerformanceChart` 组件之前）新增：

```tsx
function niceScale(dataMax: number, targetTicks = 5): number[] {
  if (dataMax <= 0) return [0];
  const rough = dataMax / (targetTicks - 1);
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const residual = rough / magnitude;
  const nice = residual <= 1.5 ? 1 : residual <= 3 ? 2 : residual <= 7 ? 5 : 10;
  const step = nice * magnitude;
  const ticks: number[] = [];
  for (let v = 0; v <= dataMax * 1.1 + step * 0.5; v += step) {
    ticks.push(Math.round(v * 1000) / 1000);
    if (ticks.length >= targetTicks + 1) break;
  }
  return ticks;
}
```

### 9.2 修改 PerformanceChart

当前的刻度渲染代码：

```tsx
const max = Math.max(...points.map(r => r[metric]!), 1) * 1.15;
// ...
{[0, max / 2, max].map(v => <g key={v}>
  <line x1={left} x2={W - right} y1={y(v)} y2={y(v)} className="perf-chart-grid" />
  <text x={left - 8} y={y(v) + 4} textAnchor="end" className="perf-chart-label">
    {v.toFixed(metric === "p95Ms" ? 0 : 1)}
  </text>
</g>)}
```

替换为：

```tsx
const rawMax = Math.max(...points.map(r => r[metric]!), 1);
const ticks = niceScale(rawMax);
const max = ticks[ticks.length - 1] || rawMax * 1.15;
// ...
{ticks.map(v => <g key={v}>
  <line x1={left} x2={W - right} y1={y(v)} y2={y(v)} className="perf-chart-grid" />
  <text x={left - 8} y={y(v) + 4} textAnchor="end" className="perf-chart-label">
    {v.toFixed(metric === "p95Ms" ? 0 : 1)}
  </text>
</g>)}
```

---

## 10. 测试计划

### 10.1 单元测试新增/修改汇总

| 测试文件 | 新增用例 | 修改用例 |
| --- | --- | --- |
| `desktop/test/performance.test.ts` | thinkTime 生成 ×4、自定义退化门槛 ×2、自定义成功码 ×2 | — |
| `desktop/test/performance-source.test.ts` | revision 合并趋势 ×1 | — |
| `desktop/test/performance-runtime.test.ts` | thinkTime=0 脚本 ×1、阶梯 discardResponseBodies ×1 | — |

共新增约 11 个测试用例，无需修改现有断言（向后兼容）。

### 10.2 验证命令

```bash
cd desktop && npx vitest run test/performance.test.ts test/performance-source.test.ts test/performance-runtime.test.ts
```

### 10.3 手工验证清单

| 场景 | 验证点 |
| --- | --- |
| 浏览器演示模式 | 页面正常渲染，趋势图刻度合理，接口选择器分行展示 |
| 切换接口 | 负载参数保留，显示"重置为默认"按钮 |
| 修改 thinkTime → 0 | 显示无间隔警告 |
| 修改业务成功码 | 折叠面板内输入框正常工作 |
| 趋势图 | 同接口不同 revision 的结果显示在同一条趋势线 |

---

## 11. 实施顺序与风险评估

### 11.1 建议实施顺序

```text
第一步 → 改动四（buildK6Options 补齐）→ 改动一（series key）→ 改动三（退化统一）
         ↑ 无依赖，改动最小，优先消除不一致            ↑ 类型层新增 DegradationThreshold

第二步 → 改动二（thinkTime）→ 改动五（业务码）→ 改动六（表单重置）
         ↑ 类型扩展 + 脚本 + UI                    ↑ 类型扩展 + 脚本 + UI

第三步 → 改动七（选择器）→ 改动八（刻度）
         ↑ 纯 UI，无类型变更
```

### 11.2 风险评估

| 改动 | 风险等级 | 风险点 | 缓解措施 |
| --- | --- | --- | --- |
| 改动一 | 低 | 历史数据合并后趋势线可能出现参数不完全一致的点 | series key 仍含 `(vus, seconds, ramp, auth, role, checkBusinessCode)`，区分度足够 |
| 改动二 | 低 | thinkTime=0 可能对被测环境造成较大压力 | UI 显示黄色警告；VU ≤ 100 和时长 ≤ 300s 的硬限制仍然生效 |
| 改动三 | 中 | Python 端 `compare_results` 签名变更可能影响 CLI 调用方 | 旧签名已标注 deprecation，Python 端改为读取 JSON 文件路径 |
| 改动四 | 低 | buildK6Options 返回值变化 | 调用方均有显式覆盖，不受影响 |
| 改动五 | 低 | 自定义成功码为空时等同关闭业务码校验 | 文档和 UI 提示说明 |
| 改动六 | 低 | 纯 UI 展示逻辑 | — |
| 改动七 | 低 | optionRender 不影响搜索功能 | label 保持纯文本 |
| 改动八 | 低 | 刻度算法可能在极端数据下生成过多/过少线 | 加了 `targetTicks + 1` 上限保护 |

### 11.3 向后兼容性

所有类型层新增字段均为 `可选`（带 `?`），默认值与当前行为一致：

| 字段 | 默认值 | 当前行为 |
| --- | --- | --- |
| `thinkTime` | `1` | `sleep(1)` |
| `businessSuccessCodes` | `["0", "200"]` | `code !== '0' && code !== '200'` |
| `degradeThreshold` | `{ p95Pct: 0.2, rpsPct: 0.2, failureMultiple: 2 }` | 硬编码 1.2/0.8/2 |

历史 JSON 报告不含这些字段时，代码使用默认值，结果与改动前完全一致。
