# 性能测试改进方案

- 文档版本：v1.0
- 编写日期：2026-11-19
- 基于评审：`docs/performance-testing-design.md` v1.0 及当前 feature/optimize 分支实现
- 文档状态：改进建议，待评审

## 目录

1. [改进概览](#1-改进概览)
2. [P0：趋势 series key 去除 definitionRevision](#2-p0趋势-series-key-去除-definitionrevision)
3. [P0：迭代间隔可配置，解除 sleep(1) 吞吐瓶颈](#3-p0迭代间隔可配置解除-sleep1-吞吐瓶颈)
4. [P0：统一退化对比逻辑，消除 TS/Python 双份维护](#4-p0统一退化对比逻辑消除-tspython-双份维护)
5. [P1：业务码校验规则可配置](#5-p1业务码校验规则可配置)
6. [P1：表单状态在切换接口时显式处理](#6-p1表单状态在切换接口时显式处理)
7. [P1：buildK6Options 阶梯模式补齐 discardResponseBodies](#7-p1buildk6options-阶梯模式补齐-discardresponsebodies)
8. [P2：接口选择器分组与分行展示](#8-p2接口选择器分组与分行展示)
9. [P2：趋势图网格刻度优化](#9-p2趋势图网格刻度优化)
10. [P2：场景压测 sleep 与单接口压测对齐](#10-p2场景压测-sleep-与单接口压测对齐)
11. [实施排期](#11-实施排期)

## 1. 改进概览

| 编号 | 优先级 | 改动范围 | 核心问题 |
| --- | --- | --- | --- |
| §2 | P0 | performanceView.ts | 趋势历史被 revision 割裂，无法跨版本观察同一目标 |
| §3 | P0 | performance.ts + PerformancePage.tsx + shared types | sleep(1) 硬编码导致 RPS 被人为压低 |
| §4 | P0 | performance.ts + perf.py | 退化检测逻辑两端各写一遍，门槛可能漂移 |
| §5 | P1 | performance.ts + PerformancePage.tsx + shared types | 业务码只认 0/200，不适配多数项目 |
| §6 | P1 | PerformancePage.tsx | 切换接口后负载参数可能残留上次设置 |
| §7 | P1 | performance.ts | 阶梯模式缺少 discardResponseBodies 显式设置 |
| §8 | P2 | PerformancePage.tsx | 接口下拉项信息过密，大列表难以扫读 |
| §9 | P2 | PerformancePage.tsx | 趋势图仅 3 条网格线，刻度可读性有限 |
| §10 | P2 | performance.ts | 场景压测的 sleep 应与单接口对齐 |

P0 建议合入前修正，P1 建议本轮迭代内完成，P2 可排入后续优化。

---

## 2. P0：趋势 series key 去除 definitionRevision

### 问题

`performanceSeriesKey` 把 `definitionRevision` 编进 key：

```ts
// performanceView.ts:7-12
export const performanceSeriesKey = (r: PerformanceResult) => JSON.stringify([
  r.env, r.options.definitionId ?? "", r.options.definitionRevision ?? 0,
  performanceTargetKey(r.options), r.options.vus, r.options.seconds,
  r.options.rampUp ?? 0, r.options.rampDown ?? 0, r.options.auth !== false,
  r.options.role ?? "", r.options.checkBusinessCode ?? false,
]);
```

接口定义任何改动（甚至只改描述）都会产生新 revision，导致同一 `GET /api/orders` 的历史趋势被拆成不连续的多条线。趋势分析的核心价值是 **跨版本观察同一目标的性能变化**，把 revision 编进 key 恰好破坏了这一点。

执行前的 stale 检测（`selected.revision !== selection.definition.revision`）已经确保了参数匹配，不需要在趋势聚合层重复约束。

### 方案

从 series key 中移除 `definitionRevision`，保留其余维度：

```ts
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

同步修改 `performanceSeriesLabel`，不再显示 ` · r${revision}`：

```ts
export function performanceSeriesLabel(r: PerformanceResult): string {
  const o = r.options;
  const target = o.scenarioId ? `场景 ${o.scenarioId}` : `${o.method ?? "GET"} ${o.path}`;
  const load = (o.rampUp ?? 0) + (o.rampDown ?? 0) > 0
    ? `${o.rampUp ?? 0} + ${o.seconds} + ${o.rampDown ?? 0}s` : `${o.seconds}s`;
  return `${o.definitionName ? `${o.definitionName} · ` : ""}${target} · ${o.vus} VU · ${load}`;
}
```

### 改动文件

| 文件 | 改动 |
| --- | --- |
| `desktop/src/renderer/pages/performanceView.ts` | series key 数组移除 revision 元素；label 移除 revision 后缀 |
| `desktop/test/performance-source.test.ts` | 更新 series key 断言 |

### 验收标准

- 同一接口更新定义后重新执行性能测试，趋势图中新旧结果在同一条线上
- 不同接口、不同负载配置仍然是独立的趋势线

---

## 3. P0：迭代间隔可配置，解除 sleep(1) 吞吐瓶颈

### 问题

`performancePlan` 和 `scenarioPlan` 生成的 k6 脚本在每次迭代末尾硬编码 `sleep(1)`。这意味着每个 VU 每秒最多发 1 次请求——10 VU 配 50ms 响应时间的接口，实际 RPS 只有 ~10，远低于理论上限 ~200。用户看到低 RPS 会误以为接口吞吐量差，实际瓶颈在 sleep。

### 方案

#### 3.1 类型扩展

`shared/performance.ts` 的 `PerformanceOptions` 新增 `thinkTime` 字段：

```ts
export interface PerformanceOptions {
  // ...existing fields...

  /** 每次迭代后的思考时间（秒），默认 1。设为 0 表示无间隔连续请求。 */
  thinkTime?: number;
}
```

#### 3.2 k6 脚本生成

`main/performance.ts` 的 `performancePlan` 和 `scenarioPlan`，将硬编码的 `sleep(1)` 替换为：

```ts
const thinkTime = options.thinkTime ?? 1;
if (thinkTime > 0) {
  lines.push(`  sleep(${thinkTime});`);
}
// thinkTime === 0 时不生成 sleep 行，VU 连续发请求
```

#### 3.3 UI 表单

`PerformancePage.tsx` 的负载行新增「间隔」输入：

```tsx
const [thinkTime, setThinkTime] = useState(1);

// 负载行内新增
<Form.Item label="间隔秒" htmlFor="perf-think">
  <InputNumber id="perf-think" min={0} max={10} step={0.1}
    precision={1} value={thinkTime}
    onChange={v => setThinkTime(v ?? 1)} style={{ width: 80 }} />
</Form.Item>
```

调用 `bindPerformanceDefinition` 时传入 `thinkTime`。

#### 3.4 UI 提示

当 `thinkTime` 设为 0 时，在运行按钮旁显示提示：

```tsx
{thinkTime === 0 && <Typography.Text type="warning" style={{ fontSize: 12 }}>
  无间隔模式：VU 将连续发送请求，请确认被测环境可承受
</Typography.Text>}
```

#### 3.5 安全约束

- `thinkTime` 的有效范围：`0 ≤ thinkTime ≤ 10`
- 在 `validateBase` 或 `bindPerformanceDefinition` 中校验

#### 3.6 趋势 series key

`thinkTime` **不加入** series key。理由：同一接口不同 think time 的 P95 本身可比（延迟不受客户端等待影响），RPS 不可比但趋势图已经按指标独立展示。如果用户需要严格对比相同负载模型，`vus + seconds + ramp` 已经足够区分。

### 改动文件

| 文件 | 改动 |
| --- | --- |
| `desktop/src/shared/performance.ts` | `PerformanceOptions` 增加 `thinkTime?: number` |
| `desktop/src/main/performance.ts` | `performancePlan` / `scenarioPlan` 中 `sleep(1)` 改为条件生成；`validateBase` 增加 thinkTime 范围校验 |
| `desktop/src/renderer/pages/PerformancePage.tsx` | 负载行新增间隔输入 + 无间隔提示 |
| `desktop/test/performance.test.ts` | 新增 thinkTime 生成验证 |
| `desktop/test/performance-runtime.test.ts` | 新增 thinkTime=0 脚本验证 |

### 验收标准

- 默认 thinkTime=1，行为与现有一致，不影响历史结果
- thinkTime=0 时 k6 脚本无 sleep 行，实际 RPS 显著高于 VU 数
- thinkTime 超出 0–10 范围时拒绝执行

---

## 4. P0：统一退化对比逻辑，消除 TS/Python 双份维护

### 问题

退化检测存在两份独立实现：

| 位置 | 函数 | 调用方 |
| --- | --- | --- |
| `desktop/src/main/performance.ts:331` | `compareWithBaseline()` | 桌面端执行后自动对比 |
| `engine/aitest/perf.py:101` | `compare_results()` | Python 引擎 / CI |

两者的门槛（P95 > 20%、RPS < 80%、失败率 > 2×）目前一致，但分开维护不可避免地会漂移。同一个基线在桌面端「通过」而在 CI「退化」（或反过来）会严重损害用户信任。

### 方案

**TypeScript 为唯一实现，Python 端通过 JSON 透传。**

理由：
- 桌面端是执行主路径，`runPerformance` 返回 `PerformanceResult` 后直接调用 `compareWithBaseline`，链路最短
- CI 场景（`aitest-ci perf`）同样走 TypeScript 编排层（spawn k6 → 解析 summary）
- Python 端的 `compare_results` 只在 `perf compare` CLI 命令中使用，可以改为读取 TypeScript 写出的退化结果

#### 4.1 Python 端改造

`perf.py` 的 `compare_results` 改为从 JSON 报告中读取已计算的 `degradation` 字段，不再自行计算：

```python
def compare_results(result_path: str) -> dict[str, Any]:
    """读取 TypeScript 层已计算的退化结果，不重复计算。"""
    data = json.loads(Path(result_path).read_text(encoding="utf-8"))
    return data.get("degradation") or {
        "degraded": False, "details": [],
        "baseline": {"p95Ms": None, "rps": None, "failureRate": None},
        "current": {"p95Ms": data.get("p95Ms"), "rps": data.get("requestsPerSecond"),
                     "failureRate": data.get("failureRate")},
    }
```

#### 4.2 退化门槛可配置（可选，建议同步实施）

`PerformanceOptions` 新增可选字段，让用户可以在三期调整门槛：

```ts
export interface DegradationThreshold {
  /** P95 退化百分比，默认 0.2（20%） */
  p95Pct?: number;
  /** RPS 下降百分比，默认 0.2（20%） */
  rpsPct?: number;
  /** 失败率倍数，默认 2 */
  failureMultiple?: number;
}

export interface PerformanceOptions {
  // ...existing fields...
  /** 三期：退化检测门槛，不设则使用默认值 */
  degradeThreshold?: DegradationThreshold;
}
```

`compareWithBaseline` 读取 `options.degradeThreshold`（设计文档 §7.1 已有此字段定义，补齐实现即可）：

```ts
export function compareWithBaseline(
  current: PerformanceResult,
  baseline: PerformanceResult,
): DegradationResult {
  const threshold = current.options.degradeThreshold ?? {};
  const p95Pct = threshold.p95Pct ?? 0.2;
  const rpsPct = threshold.rpsPct ?? 0.2;
  const failureMultiple = threshold.failureMultiple ?? 2;

  // ...existing comparison logic, replacing hardcoded 1.2/0.8/2...
  if (bp95 > 0 && cp95 > bp95 * (1 + p95Pct)) { /* ... */ }
  if (brps > 0 && crps < brps * (1 - rpsPct)) { /* ... */ }
  if ((bfail > 0 && cfail > bfail * failureMultiple) || (bfail === 0 && cfail > 0.01)) { /* ... */ }
  // ...
}
```

### 改动文件

| 文件 | 改动 |
| --- | --- |
| `desktop/src/shared/performance.ts` | 新增 `DegradationThreshold` 接口 |
| `desktop/src/main/performance.ts` | `compareWithBaseline` 读取 threshold 配置 |
| `engine/aitest/perf.py` | `compare_results` 改为读取 JSON 透传结果 |
| `desktop/test/performance.test.ts` | 新增自定义门槛的退化对比测试 |

### 验收标准

- Python `perf compare` 输出与 TypeScript `compareWithBaseline` 结果一致
- 修改 Python 端退化门槛不影响结果（因为不再自行计算）
- 自定义 `degradeThreshold` 时使用自定义值，不设时使用默认值

---

## 5. P1：业务码校验规则可配置

### 问题

`emitResponseCheck` 的业务码判断硬编码为 `code !== '0' && code !== '200'`：

```js
businessFailed = code !== '0' && code !== '200';
```

实际项目中常见的成功码包括 `1`、`"success"`、`"ok"`、`"000000"` 等。当前用户只能选择开启或关闭校验，无法适配自己项目的约定。

### 方案

#### 5.1 类型扩展

```ts
export interface PerformanceOptions {
  // ...existing fields...

  /** 业务成功码列表，匹配 response.code 字段（字符串比较）。
   *  默认 ["0", "200"]。设为空数组则只看 HTTP 状态码。 */
  businessSuccessCodes?: string[];
}
```

#### 5.2 k6 脚本生成

`emitResponseCheck` 改为将成功码列表注入 k6 脚本：

```ts
function emitResponseCheck(lines: string[], checkBusinessCode: boolean, successCodes: string[]): void {
  // ...existing preamble...
  if (checkBusinessCode) {
    const codesJson = JSON.stringify(successCodes);
    lines.push(`      const successCodes = new Set(${codesJson});`);
    lines.push(`      businessFailed = !successCodes.has(String(value.code));`);
    // ...rest unchanged...
  }
}
```

调用时传入：

```ts
const successCodes = options.businessSuccessCodes ?? ["0", "200"];
emitResponseCheck(lines, options.checkBusinessCode !== false, successCodes);
```

#### 5.3 UI 表单

在「请求参数与鉴权」折叠面板底部增加成功码输入（仅在 checkBusinessCode 开启时显示）：

```tsx
{checkBusinessCode && <Input
  aria-label="业务成功码"
  placeholder="0, 200（逗号分隔）"
  defaultValue="0, 200"
  onChange={e => {
    const codes = e.target.value.split(",").map(s => s.trim()).filter(Boolean);
    setRequest({ businessSuccessCodes: codes });
  }}
  style={{ width: 200 }}
/>}
```

### 改动文件

| 文件 | 改动 |
| --- | --- |
| `desktop/src/shared/performance.ts` | `PerformanceOptions` 增加 `businessSuccessCodes?: string[]` |
| `desktop/src/main/performance.ts` | `emitResponseCheck` 接收成功码列表；`performancePlan` 传入 |
| `desktop/src/renderer/pages/PerformancePage.tsx` | 折叠面板内增加成功码输入 |
| `desktop/test/performance.test.ts` | 新增自定义成功码的脚本生成验证 |

### 验收标准

- 默认 `["0", "200"]`，行为与现有一致
- 配置为 `["1", "success"]` 时，k6 脚本只把 code=1 和 code="success" 视为成功
- 空数组时不校验业务码（等同于关闭 checkBusinessCode）

---

## 6. P1：表单状态在切换接口时显式处理

### 问题

`PerformancePage` 中 VU、seconds、p95Ms、maxFailureRate、useRamp 等状态在 `selectDefinition` 时不重置。用户先把某个接口的 VU 调到 50，再切换到另一个接口，VU 仍显示 50。这种行为没有明确标识，容易造成误操作。

### 方案

提供两种策略，推荐 A：

**策略 A（推荐）：保留 + 显示标记**

保留当前的"切换接口不重置负载"行为（方便批量测试同一负载），但在负载行增加"已修改"提示和重置按钮：

```tsx
const defaults = { vus: 5, seconds: 10, p95Ms: 1000, maxFailureRate: 0.01, useRamp: false, thinkTime: 1 };
const isCustomLoad = vus !== defaults.vus || seconds !== defaults.seconds
  || p95Ms !== defaults.p95Ms || maxFailureRate !== defaults.maxFailureRate
  || useRamp !== defaults.useRamp;

// 负载行末尾
{isCustomLoad && <Button size="small" type="link"
  onClick={() => {
    setVus(defaults.vus); setSeconds(defaults.seconds);
    setP95Ms(defaults.p95Ms); setMaxFailureRate(defaults.maxFailureRate);
    setUseRamp(defaults.useRamp);
  }}>重置为默认</Button>}
```

**策略 B：切换时重置**

在 `selectDefinition` 中重置所有负载参数。简单直接，但用户测试多个接口的相同负载时需要反复填写。

### 改动文件

| 文件 | 改动 |
| --- | --- |
| `desktop/src/renderer/pages/PerformancePage.tsx` | 策略 A：增加 defaults 常量 + isCustomLoad 判断 + 重置按钮 |

### 验收标准

- 修改负载参数后切换接口，负载参数保留，同时显示"重置为默认"按钮
- 点击重置后恢复初始值，按钮消失

---

## 7. P1：buildK6Options 阶梯模式补齐 discardResponseBodies

### 问题

`buildK6Options` 函数中：

```ts
// 固定模式
return { vus, duration, maxRedirects: 0, discardResponseBodies: true, thresholds };

// 阶梯模式
return { stages: [...], maxRedirects: 0, thresholds };
// ↑ 缺少 discardResponseBodies
```

固定模式显式设为 `true`，阶梯模式遗漏（k6 默认 `false`）。虽然 `performancePlan` 后续会根据 `checkBusinessCode` 覆盖，但 `scenarioPlan` 自己写了 `discardResponseBodies: false`，两条路径的默认行为不一致。

### 方案

在 `buildK6Options` 内统一设置，让调用方只需按需覆盖：

```ts
function buildK6Options(options: PerformanceOptions): Record<string, unknown> {
  const thresholds = { /* unchanged */ };
  const common = { maxRedirects: 0, discardResponseBodies: true, thresholds };

  if (rampUp > 0 || rampDown > 0) {
    return { stages: [ /* unchanged */ ], ...common };
  }
  return { vus: options.vus, duration: `${options.seconds}s`, ...common };
}
```

`performancePlan` 的覆盖逻辑不变（`checkBusinessCode` 时设为 `false`）；`scenarioPlan` 保持显式 `discardResponseBodies: false`（场景需要读 body 做变量提取）。

### 改动文件

| 文件 | 改动 |
| --- | --- |
| `desktop/src/main/performance.ts` | `buildK6Options` 两个分支统一设置 `discardResponseBodies` |
| `desktop/test/performance-runtime.test.ts` | 验证阶梯模式生成的 options 包含 `discardResponseBodies` |

### 验收标准

- 阶梯模式 + checkBusinessCode=false 时，生成的 k6 options 包含 `discardResponseBodies: true`
- 场景压测仍然为 `false`（需要读 body）

---

## 8. P2：接口选择器分组与分行展示

### 问题

当前下拉项的 label 拼接了四段信息：`未分组 · 查询订单列表 · GET /api/orders（暂不支持…）`

接口超过 20 个时这种单行长字符串难以扫读，模块筛选也不方便。

### 方案

使用 Ant Design Select 的 `optionRender` 自定义渲染，分两行展示：

```tsx
<Select
  // ...existing props...
  optionRender={option => {
    const d = definitions.data?.find(d => d.id === option.value);
    if (!d) return option.label;
    const issue = performanceDefinitionIssue(d);
    return <div className="perf-def-option">
      <div className="perf-def-option-title">
        <Tag className="perf-method-tag">{d.method}</Tag>
        <span>{d.summary || "未命名接口"}</span>
        {issue && <Typography.Text type="danger" style={{ fontSize: 11 }}>（{issue}）</Typography.Text>}
      </div>
      <Typography.Text type="secondary" className="perf-def-option-path mono" style={{ fontSize: 11 }}>
        {d.module || "未分组"} · {d.path}
      </Typography.Text>
    </div>;
  }}
/>
```

CSS：

```css
.perf-def-option { display: flex; flex-direction: column; gap: 1px; padding: 2px 0; }
.perf-def-option-title { display: flex; align-items: center; gap: 4px; }
.perf-def-option-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

如果接口数量很大（50+），可进一步用 `fieldNames` + `options` 做分组：

```tsx
const groupedOptions = [...Map.groupBy(definitions.data ?? [], d => d.module || "未分组")]
  .map(([label, items]) => ({
    label,
    options: items.map(d => ({ value: d.id, label: `${d.summary} · ${d.method} ${d.path}`, disabled: !!performanceDefinitionIssue(d) })),
  }));
```

### 改动文件

| 文件 | 改动 |
| --- | --- |
| `desktop/src/renderer/pages/PerformancePage.tsx` | Select 增加 optionRender 或分组 options |
| `desktop/src/renderer/pages/PerformancePage.css` | 新增 `.perf-def-option` 相关样式 |

---

## 9. P2：趋势图网格刻度优化

### 问题

当前趋势图只有 3 条网格线（0、max/2、max），当数据分布集中在某个区间时（如 P95 在 180–220ms 之间），刻度可读性不足，用户无法准确判断具体数值。

### 方案

使用 "nice numbers" 算法生成 4-6 条刻度线：

```ts
function niceScale(min: number, max: number, targetTicks = 5): number[] {
  if (max <= min) return [min];
  const range = max - min;
  const rough = range / (targetTicks - 1);
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const residual = rough / magnitude;
  const nice = residual <= 1.5 ? 1 : residual <= 3 ? 2 : residual <= 7 ? 5 : 10;
  const step = nice * magnitude;
  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max * 1.05; v += step) {
    ticks.push(Math.round(v * 1000) / 1000);
  }
  return ticks;
}
```

在 `PerformanceChart` 中替换硬编码的 `[0, max/2, max]`：

```tsx
const ticks = niceScale(0, max, 5);
const adjustedMax = ticks[ticks.length - 1];
// y 轴用 adjustedMax 计算比例
```

### 改动文件

| 文件 | 改动 |
| --- | --- |
| `desktop/src/renderer/pages/PerformancePage.tsx` | 新增 `niceScale` 工具函数，`PerformanceChart` 使用动态刻度 |

---

## 10. P2：场景压测 sleep 与单接口压测对齐

### 问题

`scenarioPlan` 也硬编码了 `sleep(1)`。当 §3 实现 thinkTime 可配置后，场景压测应同步使用相同参数，否则单接口设 thinkTime=0 而场景仍然 sleep(1)，行为不一致。

### 方案

在 §3 实施时一并修改 `scenarioPlan`，使用相同的 thinkTime 条件生成逻辑。

### 改动文件

随 §3 一并修改，不单独排期。

---

## 11. 实施排期

| 阶段 | 改动项 | 预估工作量 | 依赖 |
| --- | --- | --- | --- |
| 第一批（合入前） | §2 趋势 key + §4 退化统一 + §7 discardResponseBodies | 0.5 天 | 无 |
| 第二批（本轮迭代） | §3 thinkTime + §10 场景对齐 + §5 业务码 + §6 表单重置 | 1 天 | 第一批完成 |
| 第三批（后续优化） | §8 选择器 + §9 刻度 | 0.5 天 | 无依赖，可穿插 |

第一批改动量小、风险低、影响大（趋势历史一旦被割裂，补救需要迁移数据），建议最先合入。

第二批涉及类型扩展和 UI 新增控件，建议在当前迭代内完成，确保新版本发布时 sleep(1) 不再是隐性瓶颈。

第三批是体验优化，不影响功能正确性，可根据实际反馈调整优先级。
