# 项目架构改造实施计划

> SCOPE LOCK：依据 `docs/project-improvement-plan.md`，完成八项改进的四批实施；保留当前产品功能、已有工作区修改及现有调用兼容性，不改换 Electron / React / Python 技术栈。
>
> 状态：已按批准计划完成八项改造；全量检查、构建及本地真实 Electron / 浏览器验收通过。
> 日期：2026-11-19。

## Research Summary

### 已核对的实现与数据流

- `desktop/src/renderer/api.ts`：89 行，含 `Project`、`TestCase` 等类型；只有 API 获取函数是一行。不能用新 bridge 整体替换该文件。
- `desktop/src/preload/index.cts`：已通过 `contextBridge` 暴露方法白名单；事件订阅已有 cleanup，且剥离 Electron event 对象。renderer bridge 必须建立在此安全边界之上。
- `desktop/src/main/index.ts`：窗口启用 `contextIsolation: true`、`sandbox: true`；进度通过 `aitest:event` 的 `method: "aitest/progress"` 推送，并非裸 `progress` IPC 通道。大量只读接口直接使用 `DirectStore`，不是全部经过 Orchestrator/Python。
- `desktop/src/renderer/main.tsx`：已有 `usePrefersDark`、主题配置加载、设置变更监听、DOM `data-theme` 同步。改进应提取并稳定监听器、补测试，不重复实现另一套主题存储。
- `desktop/src/main/orchestrator.ts`：1353 行；已包含任务记录、原子快照写入、重启恢复、精确停止 Agent、UI 父子任务关联、Agent 工具事件摘要、性能任务取消。拆分必须迁移这些契约，不能退化成文档中的最简 TaskManager。
- `desktop/src/renderer/components/UiTasks.tsx`：已有全局 Context，启动获取任务快照，进度事件触发刷新，另有 1 秒轮询。应提取/升级现有 store，而不是增加第二套事实来源。
- `desktop/src/renderer/components/AgentProcessDock.tsx`：消费上述任务 Context，按父子关系显示执行；任务入口需要同步兼容新增排队状态。
- `desktop/src/main/orchestrator.ts` 的 UI 执行：已有 `onProgress` → `ui-step`；脚本确认依赖当前用例、环境、运行时指纹和审核结果，停止后禁止迟到结果产生成功副作用。
- `desktop/src/renderer/App.tsx`：标签、图标、可见性和页面实例化分散；页面参数不同（概览含 todos，数据库含 onChanged）；项目设置是抽屉，全局设置是独立视图，已访问的 UI 页面按项目保活。这些行为必须进入注册表设计。
- `desktop/src/renderer/projectTypes.ts` 和 `desktop/test/project-types.test.ts`：所有项目类型都允许接口及性能测试；仅 UI/App 页面按项目类型隐藏。不能照示例把 App 项目的性能页面隐藏。
- 性能链路：`PerformancePage` → preload → main IPC → `Orchestrator.runPerformance` → `performance.ts` → k6 → `handleSummary` → JSON 历史。当前 k6 使用 `stdio: ignore`，实时输出缺失；报告生成、业务失败校验、生产禁用、100 VU / 300 秒限制、凭据注入和基线校验已经存在。
- API 链路：`RunPage` → `Orchestrator.runRegression` → `EngineCall` → `mcp-servers/src/engine.ts` → `engine/aitest/cli.py::cmd_run_api_suite` → `runner.run_pytest` → JUnit → SQLite。Python runner 使用 `subprocess.run(capture_output=True)`，Node 在进程结束后解析 stdout 最后一行 JSON。只改 renderer 无法得到实时用例结果。
- `engine/aitest/pytest_selection.py`：已有 pytest 插件，用于收集阶段限制用例和版本验证；新进度插件必须与其共存，不能破坏审核版本和测试范围约束。
- `desktop/src/main/index.ts` 的 `approvalContext` 是共享可变对象，而审批协议含 `threadId`。跨项目 Agent 并行之前必须建立 thread → project/task → approval context 的绑定；否则可能按另一个项目的规则审批。
- 执行环境检查目前硬编码 Python/Codex/Maestro/Pinky；k6 已有环境变量与 Homebrew 路径解析。Midscene 是包依赖，`npx` 存在不代表 Midscene 可运行；pytest 应使用配置中的 Python 检查，不能检查另一个 PATH 上的 pytest。

### 与原方案示例的必要修正

1. renderer 不使用 `require("electron")`，不暴露任意 IPC 通道；复用 preload 安全 API。
2. bridge 的去重/重试只允许明确列入白名单的只读调用；执行、保存、删除、审批、导入等有副作用请求不得自动重放。同步抛错与异步 reject 都必须释放 inflight 状态。
3. k6 单条 `http_req_duration` 是一次请求耗时，不是 P95；实时 P95 必须按时间窗口聚合，最终报告仍以完整 summary 为准。
4. 不直接 watch 尚不存在的指标文件；使用增量读取、半行缓存和结束时 drain，限制缓存并清理资源。不把原始 URL tags/响应/请求体转发到 UI 或诊断日志。
5. pytest 采用结构化插件事件，不解析 `--tb=line` 的人类可读文本来猜用例状态；setup/call/teardown 必须合并，避免 teardown 失败时提前报通过。
6. 任务在入队时即获得唯一 ID 并可见；已取消的排队任务不能启动；失败不能阻塞后继任务；保留活跃任务，不用简单 `slice(0, 100)` 截掉仍在执行的记录。
7. 同通道串行不等于所有资源都能并行。内嵌浏览器与单步调试保留资源互斥；跨项目 Agent 并行以审批隔离完成为前提。
8. 原接口已有调用签名和返回值保持兼容；新增排队状态、进度订阅/快照和诊断导出属于显式、加法式协议扩展，preload、mock、消费方和测试一起更新。

### 现有修改与基线

- 开始时已有 13 个 renderer 文件修改（12 个页面和 styles.css），主要为页面滚动/布局调整；按当前工作树增量修改，不 reset、不覆盖、不顺手格式化整个页面。
- `.golutra/` 与新增 docs 保留，不提交、不上传，不运行其中的第三方代码。
- `npm run typecheck && npm test` 已通过：两个工作区类型检查通过；MCP 28 个测试文件、137 项通过；desktop 35 个测试文件、268 项通过。
- `PYTHONPATH="engine:.release/engine-deps" python3 -m pytest engine/tests -q` 已完成：191 passed、2 skipped；跳过项不计为通过。
- 本地可找到 k6、Node 和 Python；尚未执行真实性能负载或调用付费模型。
- Electron 官方文档已通过 Context7 核对：renderer 仅接收 preload 包装后的 payload，不接收原始 IPC event/ipcRenderer。

---

## Implementation Plan

### Overview

按“基础设施 → 调度与状态 → 模块拆分和实时反馈 → 扩展点”的顺序完成全部范围。每批保持可编译、可测试；不会以完成第一批代替整个方案。

### Constraints (DO NOT VIOLATE)

- 保留现有 `api()` 入口、已存在的 AitestApi 参数和结果；Orchestrator 保留方法代理与已有导出类型/错误类。
- 不关闭 Electron sandbox/context isolation，不向 renderer 暴露 Node 或任意 IPC。
- 不改变生产确认、性能生产禁用、鉴权继承、审核脚本、预算、取消后禁止副作用等安全和业务规则。
- 不将凭据、完整环境变量、Cookie、请求/响应正文、模型 prompt 写入诊断、实时缓存或新日志。
- 主进程任务数据为唯一事实来源；React store 是投影，不把可靠任务状态放 localStorage。
- 不自动恢复执行重启前任务，不自动重试执行/写入操作，不触发真实外部系统压测、付费模型调用、提交、推送或发布。
- 主题与页面导航继续使用现有持久化渠道，尊重显式 light/dark 设置。
- 已有工作区页面结构与 CSS 改动必须保留。

### 第一批：主题、IPC 与诊断基础

#### Step 1：稳定并测试主题跟随行为
- **文件**：`desktop/src/renderer/theme.ts`、`main.tsx`；新增主题测试。
- **变更**：提取 `useSystemTheme(preference)`；稳定 media query 生命周期；显式主题不随系统变化；默认 system、保存设置后即时生效、卸载清理。
- **Sketch**：`useSystemTheme(preference: GeneralSettings["theme"]): boolean`。
- **验收**：模拟系统变更、system/light/dark 切换、重复 render 和卸载；不重复订阅，不引入第二份主题设置。
- [x] done

#### Step 2：引入类型化 renderer bridge
- **文件**：新增 `renderer/bridge.ts`；修改 `api.ts`、`App.tsx`、`main.tsx` 及事件调用方。
- **变更**：统一事件分发和 cleanup；每个底层事件入口只订阅一次；只读白名单去重，key 包含方法及完整参数；统一 IPC 错误和 inflight 计数；可恢复传输失败才允许只读有限重试，业务错误不重试。
- **Sketch**：`createBridge(host: AitestApi)`、`subscribe<K extends keyof BridgeEvents>(type: K, fn: Listener<BridgeEvents[K]>)`。
- **验收**：同参数读请求合并、不同项目请求隔离、有副作用调用不合并不重试、reject/同步异常可再次请求、监听器异常不阻断其他订阅、dispose 后无监听泄漏；浏览器 mock 可用。
- [x] done

#### Step 3：声明诊断链并提供本地脱敏导出
- **文件**：新增 `shared/diagnostics.ts`、`main/diagnostics.ts`；修改 `shared/ipc.ts`、preload、main IPC、任务详情或工程化页面、mock。
- **变更**：声明性能/API/UI/App 链；事件携带 chainId/stepId/taskId/projectId/env、时间和结果；有界缓冲与明确截断标记；字段白名单、敏感键和已知 secret 值遮盖；按 taskId 导出至用户选择的本地 JSON 文件。
- **Sketch**：`diagnostics.forTask(context).step(stepId, safeData)`；`exportDiagnostics(taskId?): Promise<{ path: string } | null>`。
- **验收**：按任务筛选、容量上限、成功/失败链、取消导出、不暴露凭据；不把每个异常都误记成 spawn 失败。
- [x] done

### 第二批：任务管理、性能模块与共享状态

#### Step 4：提取 TaskManager 并建立明确状态机
- **文件**：新增 `main/orchestrator/taskManager.ts`、公共类型/依赖文件；修改 `orchestrator.ts`、`shared/ipc.ts` 和任务状态消费方。
- **变更**：迁移快照持久化、恢复、停止、事件摘要、父子任务、控制器；引入 `queued → running → stopping/终态`；入队即可查询及取消；任务 UUID、通道尾清理、错误后继续；活跃任务不受历史裁剪影响；重启时 queued/running/stopping 变为明确未完成终态，不重放。
- **Sketch**：`enqueue(channel, metadata, async (context: TaskContext) => result)`，context 含 id/signal/emit；任务结果状态由模块显式判定。
- **验收**：同通道 FIFO、跨通道并行、失败不堵塞、取消排队不执行、取消精确命中、父停止传递子任务、晚到成功不改终态、持久化失败提示、100 条以上任务保留活跃项。
- [x] done

#### Step 5：接入细粒度调度并隔离审批上下文
- **文件**：TaskManager、`main/index.ts`、Agent 执行模块、`renderer/App.tsx` 审批展示和相关测试。
- **变更**：性能/API 按项目串行，Agent 按项目通道串行；避免父任务持有同一通道等待子任务造成死锁；共享 UI 浏览器与调试保留独立资源锁；以 threadId 绑定审批上下文，未知 thread 默认拒绝；多审批请求排队展示，不覆盖未决审批；Codex 初始化并发只启动一次。
- **验收**：两个项目并发时任务/事件/预算/审批不串线；UI 与调试不同时占用共享资源；清理线程上下文与待审批项；取消后不开始后续写入。
- [x] done

#### Step 6：提取 PerformanceTestingModule
- **文件**：新增 `main/orchestrator/performanceTesting.ts`；修改 `orchestrator.ts`、`performance.ts`。
- **变更**：迁移接口绑定、环境验证、凭据注入、history/compile/baseline/trend；使用 TaskManager 替代全局性能互斥，排队执行前重新验证定义与环境；保持 facade 代理。
- **验收**：已有性能来源、基线、运行时和停止测试通过；新增同项目排队/跨项目并行/等待期间接口更新测试；production 禁止和门槛保持不变。
- [x] done

#### Step 7：提取统一任务 store，事件驱动并保留恢复能力
- **文件**：新增 `renderer/stores/taskStore.tsx`；修改 `components/UiTasks.tsx`、`AgentProcessDock.tsx`、Home/Performance/Run 页面及主进程任务快照推送。
- **变更**：从现有 UiTasksProvider 提取 Context + reducer；启动订阅后取快照，使用 revision/sequence 防止旧响应覆盖新事件；主进程状态变更主动推送，低频重同步兜底；兼容 `useUiTasks`；任务列表覆盖所有任务类型及 queued。
- **验收**：切页后恢复活跃任务、多个消费者只保留一个底层订阅、快照/事件竞态、断连恢复、过期事件拒绝、页面卸载不中断后台任务；UI 专用 banner 仍可筛选。
- [x] done

### 第三批：性能实时反馈与编排层拆分

#### Step 8：实现端到端实时进度协议与 k6 指标
- **文件**：新增共享 TaskProgress 协议、主进程进度缓冲/指标聚合模块、renderer 进度消费组件；修改 `performance.ts`、任务模块、IPC、bridge、PerformancePage 和 mock。
- **变更**：使用带 taskId/projectId/env/seq/timestamp 的可区分事件类型，避免 `data: any`；采集 k6 JSONL 并增量消费，处理半行、空文件、终止和末尾 drain；按窗口计算 P95、请求数/RPS，实时值明确标注为窗口指标。
- **缓冲策略**：主进程聚合后限频推送，不逐样本跨 IPC；最新指标可合并，日志有界并标记截断，终态不丢；主进程提供有界快照以恢复导航/renderer 重载；无需照搬终端逐字节 ACK 协议。
- **前端**：按明确 taskId 选择任务，显示当前阶段、实时 P95/RPS 曲线、近期事件及精确停止；复用现有图表风格，支持空态、停止态、深浅主题；实时值不替代最终报告。
- **验收**：固定样本 P95/RPS、空窗口、突发流量、分块 JSON/UTF-8、启动失败、阈值失败、停止/超时、无监听者回放、无跨任务混合、有限内存；真实 k6 仅测试本地受控服务，低并发短时运行。
- **实现前要求**：新增图表代码前加载 dataviz；浏览器/桌面验证前加载 run。
- [x] done

#### Step 9：完成组合式编排拆分
- **文件**：新增 `main/orchestrator/apiTesting.ts`、`uiTesting.ts`、`appTesting.ts`、`projectManagement.ts`，按职责增加 `agentTasks.ts`、`dataManagement.ts` 与共享 helpers/types；修改 `orchestrator.ts`。
- **变更**：搬迁现有业务逻辑而非重写规则；模块接收窄依赖/共享服务，不接收整个 Orchestrator；UI 过大时再拆脚本工作流/调试子模块；保留 `UiWorkflow`、`UiExecutionContracts`、`UiDebugSession` 的现有职责。
- **兼容**：保留现有公开方法和导出位置（通过 re-export）；API 归因失败不覆盖已生成报告；UI 脚本版本/复用/确认/复核规则和 App 规则归因保持不变。
- **验收**：每迁移一组运行对应 orchestrator/UI/App/API 测试及 typecheck，避免 import 循环；瘦 facade 不再持有各测试类型业务实现。
- [x] done

### 第四批：注册表与 API/UI 实时反馈

#### Step 10：页面注册表成为唯一页面定义来源
- **文件**：新增 `renderer/pageRegistry.tsx`（元数据/注册工具可独立成无页面依赖模块）；修改 `nav.tsx`、`projectTypes.ts`、`App.tsx`。
- **变更**：集中定义 key/label/icon/section/order/项目类型/render adapter/是否保活；采用启动时显式注册，不依赖页面导入副作用；拒绝重复 key；未知/不可见 key 回退概览。
- **验收**：每个导航项有对应渲染或抽屉动作；不同项目类型与旧项目默认行为一致；概览 todos、数据库 reload、UI 按项目保活、全局设置与项目设置抽屉保持原行为。
- [x] done

#### Step 11：执行器目录统一检测能力
- **文件**：新增 `shared/executors.ts`、`main/executors.ts`；修改 checkRuntime、设置/工程化页和 mock。
- **变更**：shared 仅存声明/类型，探测逻辑在 main；目录覆盖 Python、Codex、pytest、Playwright/Midscene、k6、Maestro、Pinky；配置/环境变量优先级与真实执行路径一致；不自动下载、不调用可能触发安装的 npx。
- **兼容**：保留原 checkRuntime 的四项返回键，新项加法扩展；检测区展示支持/缺失/禁用原因，不把宿主命令存在当成组件就绪。
- **验收**：模拟路径优先级、未安装/无权限/超时/包缺失/浏览器缺失；不得改动用户工具安装。
- [x] done

#### Step 12：打通 pytest 结构化进度并统一 UI 进度
- **文件**：新增 `engine/aitest/pytest_progress.py`；修改 `runner.py`、必要的 CLI 接线、`mcp-servers/src/engine.ts`、EngineCall 类型、API/UI 模块、RunPage、UI 消费方和 mock。
- **变更**：pytest 插件输出带明确标记的结构化事件，仅包含 caseId/status/duration/汇总数量等安全字段；逐用例合并 setup/call/teardown；runner 实时转发，Node 增量解析，不污染最终 JSON 协议；无回调时兼容现有 CLI/MCP 用法。
- **进程生命周期**：取消与超时停止 Python/pytest 子进程树，避免只杀外层引擎后仍持续请求；日志尾部有界；插件、stdout/stderr 读写资源全部清理。
- **UI**：将已有 ui-step/ui-debug 映射到统一进度，同时保留旧进度供未迁移调用方使用；父子任务关联显式传递，不以“当前第一个运行中任务”猜归属。
- **验收**：setup 错误、call 失败、teardown 错误、skip、收集失败、空选择、旧脚本、选择插件共存、分块事件、非进度 stderr、超时/取消及后继任务继续；最终 JUnit/入库汇总保持权威。
- [x] done

#### Step 13：集成验收与更新落地说明
- **文件**：各模块单元/集成测试；`docs/project-improvement-plan.md` 增补实际落地状态；本 PLAN 逐项勾选。
- **自动检查**：`npm run typecheck`、`npm test`、Python engine 全量测试、`npm run build`、`git diff --check`。
- **交互验收**：浏览器 mock 验证导航/主题/队列/实时展示；Electron 验证真实 preload 和事件链；本地受控 API + 短时 k6/pytest 验证开始、进行中、取消、完成、切页恢复及本地诊断导出。
- **边界**：mock 预览不冒充真实引擎验收；不访问用户已配置的真实被测地址，不使用付费模型；若缺少 App 设备或模型环境，明确记录相应真实集成未验证，保留自动化契约测试结果。
- [x] done

### Files to modify / create

| 范围 | 主要文件 | 原因 |
| --- | --- | --- |
| 前端基础 | renderer/bridge.ts、theme.ts、main.tsx、api.ts | 统一订阅/请求及主题生命周期 |
| 共享协议 | shared/ipc.ts、taskProgress.ts、diagnostics.ts、executors.ts | 类型化进度、排队和诊断/检测协议 |
| 安全桥接 | preload/index.cts、main/index.ts、renderer/mock.ts | 事件、快照、导出和新检查能力一致接线 |
| 编排模块 | main/orchestrator.ts、main/orchestrator/* | 组合式模块和任务调度 |
| 实时执行 | main/performance.ts、main/taskProgress.ts、mcp-servers/src/engine.ts、engine/aitest/runner.py、pytest_progress.py | 真实执行中间反馈和取消清理 |
| 前端共享状态 | renderer/stores/taskStore.tsx、components/UiTasks.tsx、AgentProcessDock.tsx | 唯一任务投影和跨页面同步 |
| 页面 | HomePage、PerformancePage、RunPage、UI 相关组件、设置/工程化检测与诊断入口 | 真实进度、停止、恢复和排查 |
| 扩展点 | renderer/pageRegistry.tsx、nav.tsx、projectTypes.ts、App.tsx；main/executors.ts | 页面和执行器单一配置来源 |
| 质量 | desktop/test/*、mcp-servers/test/engine.test.ts、engine/tests/* | 生命周期、兼容与错误路径回归 |

### What will NOT change

- 不迁移框架、不引入 Redux/Zustand/Pinia、不增加动态插件加载/执行能力。
- 不新增原方案未定义交互的通用右键菜单框架；§5 的具体交付为页面注册表和执行器目录。
- 不改变项目/环境/用例/报告的存储格式与业务规则；任务快照新增字段采取向后兼容读取。
- 不改现有模型提供商，不改变自动分析开关与收费行为。
- 不扩大默认性能负载，不移除生产保护，不对外发布代码、报告或用户配置。

### Risks / trade-offs

- 单纯把调度改成按项目 Promise 链会暴露审批上下文和内嵌浏览器资源竞争，必须先隔离/锁定资源再开放并行。
- TaskManager、事件推送和模块拆分要分步验证，不能同时搬代码、改状态机而缺少兼容测试。
- 实时百分位与最终全量百分位口径不同，UI 必须明确显示窗口长度；窗口缓存限制/截断不能无声改变统计口径。
- 压测样本含敏感 URL tags，诊断与事件只保留最小字段；导出前仍做统一脱敏。
- Python 子进程树的取消在 macOS/Linux/Windows 行为不同，平台分支需要测试，不能仅验证主进程 Promise reject。
- 页面已有用户布局修改，注册表及实时区域采用局部编辑，不做整页替换。

## Deferred

- 无主动删减八项改造范围。
- 不在本轮引入分布式任务队列、动态插件市场、终端 PTY/xterm、远程诊断上传等原方案之外的系统。

## Implementation Notes

- Orchestrator 已从 1353 行拆成 129 行兼容门面，AST 对比确认 96 个旧公开方法全部保留，另有 3 个加法式查询方法。
- 已有主题监听和任务 Context 被提取/增强，而非重建第二套存储；新增 bridge 保留所有旧页面的 `api()` 调用方式。
- TaskManager 的排队取消立即结束调用方等待，不需要先等前驱任务退出；运行中任务保留 stopping 直到实际结束，父子 signal 自动传播。
- 新增 `scripts/validation/architecture.mjs`：真实 Electron、临时 appData/DB/workspace、loopback 服务，保留 sandbox/contextIsolation；覆盖真实 k6 与 pytest、页面切换、停止、主题和本地诊断导出。
- 新增 `scripts/validation/browser.mjs`：独立浏览器上下文遍历 11 个注册页面，验证 mock、主题和窄屏；限制网络为 loopback，复用本机 Chrome，不安装浏览器。
- 已实际检查 light/dark/窄窗口与 API 用例进度截图。实时图表缺失/截断窗口断线，数值可通过表格访问。
- 所有真实执行均为本地受控测试，没有访问已有项目的远程被测系统，没有调用付费模型。
- 同工作区存在并行助手开发及新增登录门禁；保留其代码，对新门禁所需的有效登录测试 fixture 作兼容补充，并保留无登录时阻断执行的测试。助手本身不属于本计划的交付范围。
- 未现场验证：真实 App 设备、付费模型服务、Windows 进程树分支。此限制不由 mock/契约测试替代。


## Final Verification

- `npm run typecheck`：MCP + desktop 主进程 / renderer 通过。
- `npm test`：MCP 29 文件 / 140 项通过；desktop 40 文件 / 364 项通过，1 项默认跳过（显式开启的 k6 冒烟）。数字为当前共享工作区全量结果，包含并行功能测试。
- `PYTHONPATH="engine:.release/engine-deps" python3 -m pytest engine/tests -q`：198 passed、2 skipped。
- `AITEST_K6_SMOKE=1 npm test -w desktop -- test/performance-live.test.ts`：1 项真实本地 k6 测试通过，包含运行中指标与停止。
- `npm run build`、`git diff --check`：通过。
- 最终构建的 `scripts/validation/architecture.mjs`：通过；sandbox/contextIsolation 均为 true；本地 4 次请求、11 条首次性能任务进度、1 条 pytest 用例结果、18 条诊断事件；覆盖完成、停止、主题、跨页恢复及导出。
- `scripts/validation/browser.mjs`：11 个页面通过，无 pageerror，窄窗口无横向溢出。
- 验收截图：`/tmp/aiprobe-architecture-shots/`；测试不保留真实凭据，不提交或推送代码。
