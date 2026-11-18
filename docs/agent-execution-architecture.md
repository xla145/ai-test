# Agent 执行过程与统一任务中心

日期：2026-11-16（Asia/Taipei）

## 当前实现

右下角人物入口统一展示 UI、接口、App Agent 与性能执行任务。任务来源通过 `source` 区分，保留 `UiTaskRecord` / `uiTasks()` 名称以兼容已有 IPC。

```text
用户动作 → 项目/环境/预算检查 → 创建任务
                                   ↓
               独立 Codex thread 或确定性执行器
                                   ↓
               真实工具事件、状态、用量与产物
                                   ↓
                完成 / 失败 / 停止 → 历史记录
```

- Agent 每个任务独立 thread；UI 转换与探索作为父任务下的子任务，活动数量只计算根任务。
- 任务关联 project、env、caseIds、purpose、threadId、runId、token 和时间戳。没有的信息保持为空，不根据项目名猜测。
- 工具过程按 thread 精确归属，只保存工具名称、成功/失败和上下文压缩事件摘要，不保存原始参数与结果。
- 最近 100 条任务原子保存到应用数据目录的 `execution-tasks.json`。保存失败在任务卡提示；重启遗留的运行任务标记失败并保留 `PROCESS_RESTARTED` 原因，不自动重放写操作。
- `stopExecutionTask(taskId)` 精确选择控制器。Agent 的 AbortSignal 传给 App Server；取消后即使收到迟到的成功响应，也不会继续生成套件。
- 稳定回归直接运行脚本。API 执行后 AI 分析单独开关、单独状态；AI 分析失败不会吞掉已有报告。

状态为 `running → completed/failed`，取消经过 `stopping → stopped`。工具成功、模型返回 completed 与用例通过是不同事实；通过状态来自执行器与门禁校验。

## 主要代码

| 代码 | 职责 |
| --- | --- |
| `desktop/src/main/orchestrator.ts` | 任务、预算、取消、事件关联、持久化与执行编排 |
| `desktop/src/main/codex/appServer.ts` | Codex App Server thread、turn、中断与用量事件 |
| `desktop/src/renderer/components/AgentProcessDock.tsx` | 人物入口、父子任务、阶段、事件与状态 |
| `desktop/src/preload/index.cts` | UI 快照、停止与性能 IPC allowlist |
| `desktop/src/main/performance.ts` | 本地 k6 执行、负载边界、取消、超时和真实汇总 |
| `engine/aitest/traceability.py` | 需求、原始条目、脚本断言与版本证据 |

## 性能任务

工程化 → 性能测试支持测试环境中的 GET 负载。第一版使用本地 PATH 中的 k6，不静默下载安装。可配置 VU（1–100）、时长（1–300 秒）、P95 和失败率阈值；禁止生产环境及跨环境目标，不接受任意脚本。

任务进入同一人物面板并可停止。报告保存在 workspace 的 `reports/performance/`，包含场景参数、脚本哈希、环境指纹、请求数、吞吐、失败率、P95 与原始 k6 汇总。缺失运行时、无完整汇总、取消或超时均不能作为通过证据。

## 证据与审核

报告中的执行快照在运行前冻结，历史记录没有快照时不从当前文件补写。覆盖页保留需求和用例原文；API 的原始条目必须人工关联到实际请求或断言，修改请求或原文后映射失效。

UI 正式试跑使用独立上下文，确认绑定脚本、用例、环境和人工复核。自愈修改分低、中、高风险；高风险不可直接合并，非脚本类故障不得通过修改测试掩盖。所有接受操作检查项目归属与并发修改。

## 验证与尚未完成的边界

固定 40 个本地 fixture 通过 `scripts/benchmarks/regression.py` 运行，至少连续 5 轮、通过率 ≥ 98% 且没有不稳定样本才通过门禁。它只衡量确定性契约与回放，不代表模型业务准确率。

API/App 对等的独立试跑后人工确认门禁、Bruno/Hurl 双向适配、完整发布基线回滚、定位器 provider 协议和首次使用 demo 仍未全部实现。真实模型、Electron/CDP、macOS/Windows、业务数据和 k6 实机负载也需单独验收，不能以本地 mock 成绩代替。
