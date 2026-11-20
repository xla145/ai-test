# AIProbe 整体改进方案 — 借鉴 Golutra 架构实践

- 编写日期：2026-11-19
- 基于分析：Golutra（Vue 3 + Tauri/Rust 多 Agent 编排桌面端）
- 适用范围：AIProbe 全项目（桌面端 Electron + React + Python 引擎）

---

## 目录

1. [两个项目的对比](#1-两个项目的对比)
2. [改进一：IPC 层抽象 — 从 window.aitest 到分层桥接](#2-改进一ipc-层抽象--从-windowaitest-到分层桥接)
3. [改进二：编排层拆分 — 从 1353 行的 God Class 到职责单一模块](#3-改进二编排层拆分--从-1353-行的-god-class-到职责单一模块)
4. [改进三：任务执行的实时反馈管道](#4-改进三任务执行的实时反馈管道)
5. [改进四：可扩展的注册表模式 — 页面、执行器和右键菜单](#5-改进四可扩展的注册表模式--页面执行器和右键菜单)
6. [改进五：关键路径诊断追踪](#6-改进五关键路径诊断追踪)
7. [改进六：Agent 任务串行化 — Dispatch Chain 模式](#7-改进六agent-任务串行化--dispatch-chain-模式)
8. [改进七：前端状态管理规范化](#8-改进七前端状态管理规范化)
9. [改进八：主题系统增强](#9-改进八主题系统增强)
10. [实施路线图](#10-实施路线图)

---

## 1. 两个项目的对比

| 维度 | AIProbe 现状 | Golutra 做法 | 差距与机会 |
| --- | --- | --- | --- |
| **IPC 层** | `window.aitest` 单对象暴露 400+ 行接口，无中间层 | `terminalBridge.ts` 独立桥接层，管理缓冲、ACK、订阅生命周期 | AIProbe 缺少对 IPC 调用的统一错误处理、重试和事件订阅 |
| **编排层** | `orchestrator.ts` 1353 行 God Class，包含 UI/API/性能/App 全部逻辑 | 按职责拆分：`dispatch.rs` + `chat_dispatch_batcher.rs` + `chat_outbox.rs`，各 ≤400 行 | 新增功能时 orchestrator 会继续膨胀 |
| **实时反馈** | k6/pytest/Codex 执行中用户只看到 "执行中…"，无中间指标 | 终端输出实时流式推送到 UI，支持缓冲 + 背压 | 长时间任务（回归/性能）的用户体验差 |
| **可扩展性** | 导航 `NAV_SECTIONS` 硬编码，页面在 App.tsx switch-case 分发 | 注册表模式：右键菜单、快捷键、终端目录均可插件式扩展 | 新增页面/执行器需要改多处 |
| **诊断追踪** | 无系统化追踪，错误排查靠 console.log | 声明式调用链 + `logDiagnosticsEvent` 在关键节点埋点 | CI 和用户反馈时缺少上下文 |
| **任务调度** | 全局单任务互斥（性能）或无限制并发（API 回归） | 同 Agent 串行 + 跨 Agent 并行的 dispatch chain | 缺少细粒度调度 |
| **状态管理** | 各页面独立 `useState`，无全局状态共享 | Pinia 分层：domain store + orchestrator store，避免循环依赖 | 跨页面状态（如运行中的任务）需要手动刷新 |
| **主题** | `consoleTheme()` 功能完整，但主题切换没有系统级监听 | `syncTheme()` 监听 `prefers-color-scheme` 变化，LocalStorage 持久化 | 系统主题切换时 AIProbe 不会自动响应 |

---

## 2. 改进一：IPC 层抽象 — 从 window.aitest 到分层桥接

### 2.1 现状问题

当前 `api.ts` 仅一行：

```ts
export const api = (): AitestApi => window.aitest;
```

所有 IPC 调用散落在各页面组件中，错误处理依赖 `useAction` hook 的 try-catch，没有统一的：
- 重试逻辑（偶发的 IPC 断连）
- 请求去重（快速双击触发两次相同请求）
- 加载状态聚合（全局知道"有几个请求在飞"）
- 事件订阅管理（`progress` 事件的监听/取消散落各处）

### 2.2 借鉴 Golutra

Golutra 的 `terminalBridge.ts` 是所有 IPC 的唯一入口：
- 单例初始化（`ensureListeners`），全局事件只注册一次
- 每个事件类型有独立的 listener map，订阅/取消返回 cleanup 函数
- 输出缓冲（无活跃监听时不丢数据）
- ACK 批量确认（降低 IPC 频率）

### 2.3 改进方案

创建 `desktop/src/renderer/bridge.ts`，作为 IPC 中间层：

```ts
// desktop/src/renderer/bridge.ts
import type { AitestApi } from "../shared/ipc";

type Listener<T> = (payload: T) => void;
const listeners = new Map<string, Set<Listener<any>>>();
let initialized = false;

function ensureListeners() {
  if (initialized) return;
  initialized = true;
  // 注册 Electron IPC 事件监听（progress、approval 等）
  if (window.desktopHost) {
    const { ipcRenderer } = require("electron");
    for (const channel of ["progress", "approval-request", "update-state"]) {
      ipcRenderer.on(channel, (_: unknown, payload: unknown) => {
        const set = listeners.get(channel);
        if (set) for (const handler of set) handler(payload);
      });
    }
  }
}

/** 订阅事件，返回取消函数 */
export function subscribe<T>(channel: string, handler: Listener<T>): () => void {
  ensureListeners();
  const set = listeners.get(channel) ?? new Set();
  set.add(handler);
  listeners.set(channel, set);
  return () => { set.delete(handler); if (set.size === 0) listeners.delete(channel); };
}

/** 带去重和错误标准化的 IPC 调用 */
const inflight = new Map<string, Promise<unknown>>();

export function dedupedCall<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const promise = fn().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

/** 统一的 API 入口 */
export const api = (): AitestApi => {
  ensureListeners();
  return window.aitest;
};
```

### 2.4 改动范围

| 文件 | 改动 |
| --- | --- |
| 新建 `desktop/src/renderer/bridge.ts` | IPC 桥接层 |
| `desktop/src/renderer/api.ts` | 改为从 bridge 导出 `api` |
| `desktop/src/renderer/App.tsx` | progress 事件监听改用 `subscribe` |
| 各页面组件 | 逐步迁移，不阻塞当前功能 |

### 2.5 预期收益

- 事件订阅有统一的 cleanup 机制，不再泄漏监听器
- 重复请求自动去重（如快速切换项目时的 `listCases`）
- 为后续的实时反馈（改进三）提供基础设施

---

## 3. 改进二：编排层拆分 — 从 1353 行的 God Class 到职责单一模块

### 3.1 现状问题

`orchestrator.ts` 是一个 1353 行的 Class，包含：

| 职责 | 方法数 | 行数范围 |
| --- | --- | --- |
| 项目管理 | ~5 | project, setSettings, caseTitles |
| API 测试 | ~8 | debugApiRequest, generateApiSuite, runRegression, triage, apiWorkspace |
| UI 测试 | ~12 | exploreUiCase, runUiRegression, healUi, reviseUiScript, uiDebug* |
| App 测试 | ~3 | exploreAppCase, runAppRegression, appEnv |
| 性能测试 | ~5 | runPerformance, performanceHistory, perfSetBaseline, perfGetBaseline, perfTrend |
| 数据管理 | ~3 | prepareData, recordAttributions |
| 任务管理 | ~3 | withUiTask, taskRecords, agentControllers |

任何改动都要打开这个巨大文件，合并冲突频繁，测试难以隔离。

### 3.2 借鉴 Golutra

Golutra 的编排层严格按职责拆分：
- `dispatch.rs`（395 行）：消息到终端的路由
- `chat_dispatch_batcher.rs`（~200 行）：语义刷新门控的批量派发
- `chat_outbox.rs`（~200 行）：持久化 + 重试的发件箱
- 加上 `ports/` 层的 trait 抽象，每个模块可以独立测试

### 3.3 改进方案

将 `Orchestrator` 拆分为多个模块，通过组合而非继承协作：

```
desktop/src/main/
├── orchestrator.ts          # 瘦壳：组合各模块 + 任务管理 + 事件发射
├── orchestrator/
│   ├── apiTesting.ts        # API 回归、调试、套件生成、分类
│   ├── uiTesting.ts         # UI 探索、回归、脚本管理、调试、修复
│   ├── appTesting.ts        # App 探索、回归
│   ├── performanceTesting.ts # 性能测试（已有 performance.ts，补编排逻辑）
│   ├── projectManagement.ts  # 项目配置、环境、凭据
│   └── taskManager.ts       # 任务记录、互斥、AbortController 管理
```

每个子模块接收 `deps: OrchestratorDeps` 注入，不直接依赖 `Orchestrator` 实例：

```ts
// desktop/src/main/orchestrator/apiTesting.ts
export class ApiTestingModule {
  constructor(private deps: OrchestratorDeps) {}

  async runRegression(projectId: string, env: string, opts: ApiRunOptions = {}) {
    // 现有 Orchestrator.runRegression 的逻辑搬到这里
  }

  async triage(projectId: string, runId: string, env?: string) {
    // 现有 Orchestrator.triage 的逻辑
  }
  // ...
}
```

`Orchestrator` 变为组合层：

```ts
// desktop/src/main/orchestrator.ts（瘦壳）
export class Orchestrator extends EventEmitter {
  readonly api: ApiTestingModule;
  readonly ui: UiTestingModule;
  readonly app: AppTestingModule;
  readonly performance: PerformanceTestingModule;
  readonly tasks: TaskManager;

  constructor(deps: OrchestratorDeps) {
    super();
    this.tasks = new TaskManager(this);
    this.api = new ApiTestingModule(deps, this.tasks);
    this.ui = new UiTestingModule(deps, this.tasks);
    this.app = new AppTestingModule(deps, this.tasks);
    this.performance = new PerformanceTestingModule(deps, this.tasks);
  }

  // IPC 方法代理到子模块（保持现有 AitestApi 接口不变）
  runRegression(...args: Parameters<ApiTestingModule["runRegression"]>) {
    return this.api.runRegression(...args);
  }
  // ...
}
```

### 3.4 迁移策略

1. **第一步**：提取 `TaskManager`（任务记录 + 互斥 + abort），这是最独立的部分
2. **第二步**：提取 `PerformanceTestingModule`（已有独立的 `performance.ts`，只需移动编排逻辑）
3. **第三步**：提取 `ApiTestingModule`（方法边界清晰）
4. **第四步**：提取 `UiTestingModule`（最复杂，包含工作流和调试会话）
5. 每一步保持 `AitestApi` 接口不变，前端无感

### 3.5 预期收益

- 单个模块 200-400 行，可独立阅读和测试
- 新增测试类型（如安全测试、压力测试）只需添加新模块
- 合并冲突大幅减少

---

## 4. 改进三：任务执行的实时反馈管道

### 4.1 现状问题

用户启动一个长时间任务（API 回归 / k6 性能测试 / UI 探索）后，UI 只显示"执行中…"的加载状态。唯一的进度信息来自 Codex 的 `progress` 事件（粗粒度的阶段描述），k6 和 pytest 没有中间进度。

### 4.2 借鉴 Golutra

Golutra 每个终端会话都有完整的实时输出管道：

```
PTY 读线程 → sync_channel(256) → 处理线程 → Tauri event → Bridge 缓冲 → xterm.js
```

关键设计：
- **背压**：ACK 确认机制，前端消费不过来时暂停读取
- **缓冲**：后台终端的输出不丢失，切换回来时一次性回放
- **分层处理**：原始输出和语义消息分两路，互不阻塞

### 4.3 改进方案

为 AIProbe 的三类长任务建立实时进度管道：

#### 4.3.1 统一进度协议

```ts
// desktop/src/shared/ipc.ts — 新增
export interface TaskProgress {
  taskId: string;
  projectId: string;
  /** 进度类型 */
  kind: "metric" | "log" | "stage" | "complete" | "error";
  timestamp: number;
  data: unknown;
}
```

#### 4.3.2 k6 性能测试实时指标

在 `runPerformance` 中，使用 `k6 run --out json=...` 将实时指标写入临时文件，主进程 `fs.watch` 监控并推送到渲染进程：

```ts
// 伪代码：main/performance.ts
const jsonOut = join(dir, `${id}.jsonl`);
const child = spawn(k6Executable(), ["run", "--out", `json=${jsonOut}`, script], { ... });

// 实时读取 k6 JSON 输出
const watcher = fs.watch(jsonOut, () => {
  const lines = readNewLines(jsonOut, lastOffset);
  for (const line of lines) {
    const metric = JSON.parse(line);
    if (metric.type === "Point" && metric.metric === "http_req_duration") {
      emit("task-progress", {
        taskId: id, kind: "metric",
        data: { p95: metric.data.value, timestamp: metric.data.time },
      });
    }
  }
});
```

#### 4.3.3 API 回归进度

在 `runRegression` 中解析 pytest 的实时输出（`--tb=line` 模式下每行一个结果），推送每个用例的通过/失败：

```ts
emit("task-progress", {
  taskId, kind: "log",
  data: { caseId: "tc_001", status: "passed", duration: 120 },
});
```

#### 4.3.4 前端消费

在 `bridge.ts` 中订阅 `task-progress` 事件，各页面按 `taskId` 过滤：

```tsx
// 性能页面
const [liveMetrics, setLiveMetrics] = useState<{ p95: number; time: string }[]>([]);

useEffect(() => {
  if (!currentTaskId) return;
  return subscribe<TaskProgress>("task-progress", (p) => {
    if (p.taskId === currentTaskId && p.kind === "metric") {
      setLiveMetrics(prev => [...prev.slice(-60), p.data as any]);
    }
  });
}, [currentTaskId]);
```

### 4.4 预期收益

- 性能测试执行中可以看到实时 P95 / RPS 曲线
- API 回归可以看到逐个用例的通过/失败
- 用户不需要等到全部完成才知道是否有问题

---

## 5. 改进四：可扩展的注册表模式 — 页面、执行器和右键菜单

### 5.1 现状问题

新增页面需要改 4 个地方：`nav.tsx`（菜单项）、`App.tsx`（switch-case 路由）、`projectTypes.ts`（可见性控制）、`ipc.ts`（接口定义）。执行器（k6、pytest、Midscene）的配置散落在不同文件中。

### 5.2 借鉴 Golutra

Golutra 的注册表模式统一了扩展点：

```ts
type Rule = { id, order, mode: 'merge' | 'override', matches(ctx), items(ctx) };
// 右键菜单
registerContextMenuRule(rule);
// 快捷键
registerKeybindRule(rule);
// 终端目录
BASE_TERMINALS.push(newTerminal);
```

### 5.3 改进方案

#### 5.3.1 页面注册表

```ts
// desktop/src/renderer/pageRegistry.ts
export interface PageDefinition {
  key: string;
  label: string;
  icon: ReactNode;
  section: "overview" | "prepare" | "execute" | "analyze" | "config";
  component: React.ComponentType<{ project: Project }>;
  /** 哪些项目类型显示此页面 */
  projectTypes?: ProjectType[];
  /** 排序权重 */
  order?: number;
}

const pages = new Map<string, PageDefinition>();

export function registerPage(definition: PageDefinition) {
  pages.set(definition.key, definition);
}

export function getPages(projectType?: ProjectType): PageDefinition[] {
  return [...pages.values()]
    .filter(p => !p.projectTypes || !projectType || p.projectTypes.includes(projectType))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}
```

每个页面自注册：

```ts
// desktop/src/renderer/pages/PerformancePage.tsx
registerPage({
  key: "performance",
  label: "性能测试",
  icon: <ThunderboltOutlined />,
  section: "execute",
  component: PerformancePage,
  projectTypes: ["web", "api", "multi"],
  order: 20,
});
```

`App.tsx` 和 `nav.tsx` 从注册表动态读取，不再硬编码。

#### 5.3.2 执行器目录

参考 Golutra 的 `terminalCatalog.ts`：

```ts
// desktop/src/shared/executors.ts
export interface ExecutorDefinition {
  id: string;
  name: string;
  /** 可执行文件名或路径 */
  command: string;
  /** 检测是否安装 */
  detect: () => Promise<boolean>;
  /** 版本获取 */
  version?: () => Promise<string>;
}

export const EXECUTORS: ExecutorDefinition[] = [
  { id: "k6", name: "k6 (性能)", command: "k6", detect: () => which("k6") },
  { id: "pytest", name: "pytest (回归)", command: "pytest", detect: () => which("pytest") },
  { id: "midscene", name: "Midscene (UI)", command: "npx", detect: () => which("npx") },
  { id: "maestro", name: "Maestro (App)", command: "maestro", detect: () => which("maestro") },
];
```

工程化页面的"环境检查"可以直接遍历这个目录，不再硬编码每个工具的检测逻辑。

---

## 6. 改进五：关键路径诊断追踪

### 6.1 现状问题

用户报告"性能测试执行失败"时，我们只有最终的 error message。中间经过了哪些步骤、在哪一步失败的、环境变量是否正确注入，全靠猜测。

### 6.2 借鉴 Golutra

Golutra 声明了完整的调用链（`terminalCallChains.ts`），每个关键节点埋入 `logDiagnosticsEvent`，前端批量上报（5000 条缓冲 + 500ms 刷新），支持 run-based 分组和 snapshot 一致性校验。

### 6.3 改进方案

#### 6.3.1 声明调用链

```ts
// desktop/src/shared/diagnostics.ts
export interface DiagnosticStep {
  id: string;
  label: string;
}

export interface DiagnosticChain {
  id: string;
  title: string;
  steps: DiagnosticStep[];
}

export const DIAGNOSTIC_CHAINS: DiagnosticChain[] = [
  {
    id: "performance-run",
    title: "性能测试执行",
    steps: [
      { id: "perf.select-definition", label: "选择接口定义" },
      { id: "perf.bind-definition", label: "绑定定义参数" },
      { id: "perf.orchestrator-validate", label: "编排层校验（环境、互斥）" },
      { id: "perf.inject-secrets", label: "注入凭据" },
      { id: "perf.generate-plan", label: "生成 k6 脚本" },
      { id: "perf.spawn-k6", label: "启动 k6 进程" },
      { id: "perf.parse-summary", label: "解析 k6 汇总" },
      { id: "perf.write-report", label: "写入报告 JSON" },
      { id: "perf.compare-baseline", label: "基线对比" },
    ],
  },
  {
    id: "api-regression",
    title: "接口回归执行",
    steps: [
      { id: "api.load-test-set", label: "加载测试集" },
      { id: "api.prepare-environment", label: "准备环境" },
      { id: "api.spawn-pytest", label: "启动 pytest" },
      { id: "api.collect-results", label: "收集结果" },
      { id: "api.generate-report", label: "生成报告" },
    ],
  },
  // ... UI 测试、App 测试等
];
```

#### 6.3.2 埋点工具

```ts
// desktop/src/main/diagnostics.ts
interface DiagnosticEvent {
  chainId: string;
  stepId: string;
  timestamp: number;
  taskId?: string;
  data?: Record<string, unknown>;
  error?: string;
}

const events: DiagnosticEvent[] = [];

export function logStep(chainId: string, stepId: string, data?: Record<string, unknown>) {
  events.push({ chainId, stepId, timestamp: Date.now(), data });
}

export function logError(chainId: string, stepId: string, error: Error) {
  events.push({ chainId, stepId, timestamp: Date.now(), error: error.message });
}

/** 导出诊断日志用于问题排查 */
export function exportDiagnostics(taskId?: string): DiagnosticEvent[] {
  return taskId ? events.filter(e => e.taskId === taskId) : [...events];
}
```

#### 6.3.3 在关键节点埋入

```ts
// desktop/src/main/orchestrator/performanceTesting.ts
async runPerformance(projectId: string, env: string, options: PerformanceOptions) {
  logStep("performance-run", "perf.orchestrator-validate", { projectId, env });
  // ...校验逻辑...
  logStep("performance-run", "perf.inject-secrets", { hasToken: !!secrets.AITEST_AUTH_TOKEN });
  // ...注入凭据...
  logStep("performance-run", "perf.generate-plan", { method: options.method, path: options.path });
  // ...生成脚本...
  try {
    logStep("performance-run", "perf.spawn-k6");
    const result = await executePerformance(workspace, env, base, merged, signal, secrets);
    logStep("performance-run", "perf.write-report", { status: result.status });
    return result;
  } catch (error) {
    logError("performance-run", "perf.spawn-k6", error as Error);
    throw error;
  }
}
```

### 6.4 预期收益

- 用户反馈问题时可以一键导出诊断日志
- 自动化测试可以断言调用链完整性
- CI 环境的故障排查从"猜"变成"查"

---

## 7. 改进六：Agent 任务串行化 — Dispatch Chain 模式

### 7.1 现状问题

当前任务调度有两个极端：
- 性能测试：全局单任务互斥（`this.taskRecords.some(t => t.source === "performance")`）
- API/UI Agent 任务：无限制，可能同时向同一项目发起多个 Agent 任务

### 7.2 借鉴 Golutra

Golutra 的 `dispatchChains = new Map<string, Promise<void>>()` 实现了同 Agent 串行 + 跨 Agent 并行。

### 7.3 改进方案

```ts
// desktop/src/main/orchestrator/taskManager.ts
export class TaskManager {
  private chains = new Map<string, Promise<void>>();
  private controllers = new Map<string, AbortController>();
  records: UiTaskRecord[] = [];

  /** 在指定通道上串行执行任务。同通道串行，不同通道并行。 */
  async enqueue<T>(
    channel: string,
    fn: (signal: AbortSignal) => Promise<T>,
    meta: Omit<UiTaskRecord, "id" | "status" | "startedAt" | "updatedAt">,
  ): Promise<T> {
    const chain = this.chains.get(channel) ?? Promise.resolve();
    const controller = new AbortController();
    const taskId = `${meta.source}-${Date.now()}`;
    this.controllers.set(taskId, controller);

    const task = chain.then(async () => {
      const record = this.createRecord(taskId, meta);
      try {
        const result = await fn(controller.signal);
        this.completeRecord(taskId, "completed");
        return result;
      } catch (error) {
        this.completeRecord(taskId, controller.signal.aborted ? "stopped" : "failed");
        throw error;
      } finally {
        this.controllers.delete(taskId);
      }
    });

    // 更新链尾：即使本任务失败，后续任务也能继续
    this.chains.set(channel, task.then(() => {}, () => {}));
    return task;
  }

  /** 通道命名约定：performance:{projectId}, api:{projectId}, ui:{projectId}:{env} */
}
```

调用方式：

```ts
// 性能测试：同项目串行
await taskManager.enqueue(`performance:${projectId}`, (signal) => {
  return executePerformance(workspace, env, base, options, signal, secrets);
}, { projectId, env, source: "performance", kind: "k6 性能测试" });

// API 回归：同项目串行
await taskManager.enqueue(`api:${projectId}`, (signal) => {
  return runPytest(workspace, env, testSet, signal);
}, { projectId, env, source: "agent", kind: "接口回归" });
```

### 7.4 预期收益

- 同项目的性能测试不再需要手动互斥检查
- 不同项目的任务可以真正并行
- 测试集内多个目标自然串行
- `stop` 操作精确到具体任务，不影响其他通道

---

## 8. 改进七：前端状态管理规范化

### 8.1 现状问题

各页面用独立的 `useState` + `useLoad` 管理数据，跨页面状态（如"当前有几个任务在运行"、"哪些环境已验证"）无法共享。用户从性能页面切到概览页，看不到正在运行的性能任务状态。

### 8.2 借鉴 Golutra

Golutra 的 Pinia store 分两层：
- **Domain store**：`terminalStore`（标签页）、`chatStore`（消息）、`projectStore`（成员）
- **Orchestrator store**：`terminalOrchestratorStore` 组合多个 domain store，提供跨功能的操作

### 8.3 改进方案

在 React 中用 Context + useReducer 实现类似的分层状态：

```tsx
// desktop/src/renderer/stores/taskStore.tsx
interface TaskState {
  tasks: UiTaskRecord[];
  activeCount: number;
}

const TaskContext = createContext<{
  state: TaskState;
  dispatch: React.Dispatch<TaskAction>;
}>({ state: { tasks: [], activeCount: 0 }, dispatch: () => {} });

export function TaskProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(taskReducer, { tasks: [], activeCount: 0 });

  // 订阅后端的任务状态变化
  useEffect(() => {
    return subscribe<UiTaskRecord[]>("task-records", (tasks) => {
      dispatch({ type: "SYNC", tasks });
    });
  }, []);

  return <TaskContext.Provider value={{ state, dispatch }}>{children}</TaskContext.Provider>;
}

export const useTasks = () => useContext(TaskContext);
```

各页面使用：

```tsx
function PerformancePage() {
  const { state: { tasks } } = useTasks();
  const perfTasks = tasks.filter(t => t.source === "performance");
  // 不需要自己维护任务状态，全局 store 实时同步
}
```

概览页面也能直接展示所有运行中的任务：

```tsx
function HomePage() {
  const { state: { tasks, activeCount } } = useTasks();
  // 展示跨类型的任务摘要
}
```

---

## 9. 改进八：主题系统增强

### 9.1 现状问题

`theme.ts` 的 `consoleTheme(dark)` 功能完整，但系统主题切换时 AIProbe 不会自动响应。用户必须在设置中手动切换。

### 9.2 借鉴 Golutra

Golutra 的 `theme.ts` 监听 `prefers-color-scheme` 变化，`system` 模式下自动跟随：

```ts
const startSystemListener = () => {
  mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  mediaHandler = () => applyThemeToDom('system');
  mediaQuery.addEventListener('change', mediaHandler);
};
```

### 9.3 改进方案

```ts
// desktop/src/renderer/theme.ts — 新增
export function useSystemTheme(preference: "system" | "light" | "dark") {
  const [resolved, setResolved] = useState<boolean>(() =>
    preference === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
      : preference === "dark"
  );

  useEffect(() => {
    if (preference !== "system") {
      setResolved(preference === "dark");
      return;
    }
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => setResolved(e.matches);
    mq.addEventListener("change", handler);
    setResolved(mq.matches);
    return () => mq.removeEventListener("change", handler);
  }, [preference]);

  return resolved;
}
```

在 `App.tsx` 中使用：

```tsx
const dark = useSystemTheme(settings.theme);
// 传入 consoleTheme(dark)
```

改动量极小（约 20 行），但用户体验提升明显。

---

## 10. 实施路线图

### 10.1 分批实施

| 批次 | 改进项 | 预估工作量 | 依赖 | 风险 |
| --- | --- | --- | --- | --- |
| **第一批（快速见效）** | 主题系统增强（§9） | 0.5 天 | 无 | 极低 |
| | 诊断追踪声明 + 埋点（§6） | 1 天 | 无 | 低 |
| | IPC 桥接层（§2） | 1 天 | 无 | 低 |
| **第二批（架构改善）** | TaskManager 提取（§7） | 1 天 | §2 | 中 |
| | 编排层拆分第一步：TaskManager + PerformanceModule（§3） | 1 天 | §7 | 中 |
| | 前端任务 store（§8） | 1 天 | §2 | 低 |
| **第三批（体验提升）** | 实时反馈管道：性能测试（§4） | 2 天 | §2, §7 | 中 |
| | 编排层拆分后续：API + UI 模块（§3） | 2 天 | 第二批 | 中 |
| **第四批（可扩展性）** | 页面注册表 + 执行器目录（§5） | 2 天 | §3 | 低 |
| | 实时反馈管道：API 回归 + UI 测试（§4） | 2 天 | §4 第一步 | 中 |

### 10.2 总预估

- **第一批**：2.5 天，无风险，立即可见效果
- **第二批**：3 天，架构层改善，为后续功能铺路
- **第三批**：4 天，用户体验质变（实时看到执行过程）
- **第四批**：4 天，长期可维护性

**合计约 13.5 天**，建议分两个迭代（2 周 × 2）完成前三批，第四批根据实际反馈决定优先级。

### 10.3 兼容性保证

所有改动遵循以下原则：
- `AitestApi` 接口不变，前端调用方式不变
- 编排层拆分通过代理方法保持向后兼容
- 新增的 bridge / store / diagnostics 是增量引入，不替换现有代码
- 每个改进项可独立合入，不必等待全部完成

## 11. 实际落地记录（2026-11-19）

本节记录按当前代码落地后的实现，前文示例保留为原始设计参考。详细检查项见仓库根目录 `PLAN.md`。

### 11.1 已实现

| 改进项 | 实际入口与行为 |
| --- | --- |
| IPC bridge | `renderer/bridge.ts`：复用 preload 白名单 API，统一订阅、cleanup、错误与在途计数；仅白名单只读请求去重，只有明确的传输断开才重试一次，执行和写入不重试。 |
| 编排拆分 | `main/orchestrator.ts` 保留兼容代理；实现迁移到 `orchestrator/` 下的项目、API、UI、App、性能、Agent、数据准备和调试模块。 |
| 任务串行化 | `TaskManager` 支持同通道 FIFO、跨通道并行、排队可见与即时取消、父子取消传播、失败后继续；保留全部活跃任务与最近 100 条结束历史。共享 UI 浏览器/调试保持互斥，App 执行按设备通道调度。 |
| 实时反馈 | k6 临时 JSONL 增量读取后按 5 秒窗口计算 P95/RPS；pytest 插件在 setup/call/teardown 合并后产生结构化用例结果；已有 UI 步骤进入统一进度协议。 |
| 注册表 | `renderer/pageRegistry.tsx` 统一页面、导航元数据、项目类型可见性、参数适配及保活；`shared/executors.ts` + `main/executors.ts` 统一运行环境目录与本机检测。 |
| 诊断 | 类型化链路声明、任务/项目关联、有界缓冲、失败节点标记；任务面板可导出本地 JSON。诊断只记录字段白名单和符号状态，不记录凭据、请求响应体或 prompt。 |
| 共享状态 | `renderer/stores/taskStore.tsx` 从现有 Context 提取，订阅主动推送并用 revision 拒绝过期快照；15 秒兜底同步。任务列表、概览、接口回归和性能页面共享事实来源。 |
| 主题 | 提取 `useSystemTheme`，稳定 media query 订阅，显式 light/dark 不跟随系统；保留原设置文件，避免启动时旧设置覆盖刚保存的选择。 |

### 11.2 与设计伪代码的差别

- renderer 不引入 Electron / Node；使用既有 `aitest:event` 包装通道传输新任务事件。
- 新增 `taskSnapshot`、`taskProgress`、`exportDiagnostics`，旧接口参数与返回结构保持兼容；任务状态增补 `queued`，任务来源增补 `api` / `app`。
- 不将 k6 单个耗时样本当成 P95。实时值明确标记为滑动窗口值，窗口超限时标记并停止绘制该窗口，不替代最终完整汇总。
- 不使用易受文件创建时序影响的 `fs.watch`；对受限权限临时文件做分块增量读取、UTF-8/半行缓存和退出 drain，并在结束时删除原始指标文件。
- 不复制终端逐字节 ACK 协议；主进程聚合指标后约每秒推送，单任务保留最近 120 条进度并明确截断。完整用例结果仍以持久化报告为准。
- pytest 不解析人类可读的进度文字，使用独立插件并与现有用例选择/版本检查插件共存；Node 引擎保留最终 JSON 协议。
- 跨项目 Agent 并行时审批策略绑定 threadId；未知线程默认拒绝，多审批请求不会互相覆盖。
- 任务历史跨重启保留，未结束任务恢复为 `PROCESS_RESTARTED` 失败，不自动执行；进度和诊断缓冲仅保留在本次主进程内，页面切换/renderer 重载可恢复，整个应用重启不会恢复原事件流。

### 11.3 可重复验收

```bash
# 常规回归（包含新增架构与流式协议测试）
npm run typecheck
npm test
PYTHONPATH="engine:.release/engine-deps" python3 -m pytest engine/tests -q
npm run build

# 显式启用真实 k6 冒烟：只向脚本创建的 loopback HTTP 服务发送短时、1 VU 请求
AITEST_K6_SMOKE=1 npm test -w desktop -- test/performance-live.test.ts

# 真实 Electron：新建临时 appData、数据库、workspace，保留 sandbox/contextIsolation
# 验证接口导入、k6 实时指标、跨页任务恢复/停止、主题、已审核 pytest 回归、诊断导出
AITEST_VALIDATION_OUTPUT=/tmp/aiprobe-architecture-shots node scripts/validation/architecture.mjs

# 浏览器预览：需先运行项目的 preview:web / Vite；不关闭已有服务，不访问外部测试系统
node scripts/validation/browser.mjs
```

浏览器验收优先复用已安装浏览器；可通过 `AITEST_CHROMIUM_BIN` 指定已有 Chromium 可执行文件，不会自动下载安装。Electron 验收自动关闭自己启动的窗口/任务，清理临时数据（设置输出目录时保留截图于该目录）。

**验证边界：** 本轮不调用付费模型，不访问已配置的外部被测系统，不对生产环境压测。真实 App 设备、付费模型后端以及 Windows 进程树分支未做现场验收，相关代码通过类型和契约测试；不能将这些测试当成相应平台的真实通过证明。


### 11.4 本轮验证结果

- 类型检查、生产构建与差异格式检查通过。
- 当前共享工作区：MCP 140 项通过；Desktop 364 项通过、1 项默认跳过；Python 198 项通过、2 项跳过。
- 默认跳过的 k6 冒烟已通过 `AITEST_K6_SMOKE=1` 单独真实执行并通过。
- 最终构建的真实 Electron 验收通过（沙箱和上下文隔离均保持开启），本地 k6 / pytest 的进度成功到达实际页面；诊断 JSON 可导出。
- 浏览器独立上下文的 11 个页面导航、系统主题和窄窗口检查通过，无页面异常。
