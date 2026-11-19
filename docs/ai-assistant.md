# AI 测试助手首版

更新日期：2026-11-19

## 使用入口

右下角原 Agent 入口现在包含「对话 / 执行过程」。接口、用例、报告、回归页面提供「交给助手」快捷入口，选中对象在发送时冻结，不因切换项目或页面而改变已提交操作。

对话界面以消息和输入为主：历史与新会话为图标入口；模式、环境为紧凑菜单；日期和来源放在消息详情。每轮模型发送仍需用户勾选同意，完整的数据发送说明可在「详情」查看。

## 已实现范围

- 项目隔离的本地会话、消息和操作历史。
- 问答与报告解读：只读、有限、脱敏的项目摘要；引用报告未明确时使用最近记录并告知。
- 用例草稿：模型返回结构化建议，确认后存为 `draft` 状态、`manual` 执行方式的场景草稿，不直接产生可执行接口配置；需要人工补全和审核。
- 接口回归：明确选择非生产环境和用例/接口范围，服务端生成操作卡，用户确认后调用既有业务编排。按接口选择时沿用单接口范围语义，不自动纳入多接口流程。卡片披露重建本地已审核套件及可能产生本地 commit 的副作用。
- 回归默认按用例的角色/鉴权执行，关闭自动 AI 归因。真实报告先落盘；可另发起报告分析。
- 操作 ID 去重、15 分钟有效期、环境与资源指纹复核、取消及重启不重放。
- 使用既有 TaskManager 的队列、父子任务、状态、停止与快照。

## 模型与用量

首版问答使用现有 Agent 模型配置中的 OpenAI 兼容 `/chat/completions`，需要明确配置模型名和 API key，不读取 Codex 登录凭据。

这是一条独立的**纯文本模型通道**：不挂载 MCP，不开放 shell、SQL 或任意 IPC。服务端执行操作与模型回复完全分离。草稿模式只接受严格 JSON，其他回复支持 Markdown。

请求前检查预算并预留保守额度；模型返回有效 usage 后按实际数结算。请求中断、超时或服务未提供 usage 时保留预留额度，避免无法确认用量时预算被绕过。因此未结算用量不是精确账单。模型请求不自动重试。

## Markdown 显示

- 支持标题、加粗、列表、引用、GFM 表格与任务列表。
- 代码块使用等宽字体、独立滚动和复制按钮；表格仅在自身区域横向滚动。
- 禁用原始 HTML，不自动加载远程图片。
- 只接受无内嵌凭据的 HTTP/HTTPS 链接；回复中的外链提供复制动作，不自动导航或执行。
- 本地用例、接口和报告引用使用服务端校验过的对象卡片导航，不依赖模型生成的链接。

## 主要文件

| 位置 | 职责 |
| --- | --- |
| `desktop/src/shared/assistant.ts` | 会话、消息、操作、上下文与 IPC 契约 |
| `desktop/src/main/assistant/service.ts` | 提案、确认、幂等、任务与结果关联 |
| `desktop/src/main/assistant/context.ts` | 项目归属、摘要裁剪、脱敏、范围和指纹 |
| `desktop/src/main/assistant/repository.ts` | 私有本地 JSON 的原子持久化与重启恢复 |
| `desktop/src/main/assistant/model.ts` | 无工具模型通道、超时、响应限制、用量 |
| `desktop/src/main/assistant/integration.ts` | 复用业务查询与执行服务 |
| `desktop/src/main/assistant/ipc.ts` | 可信工作台 URL 检查，另由 main 检查窗口和 frame |
| `desktop/src/renderer/assistant/` | 上下文注册、对话、确认卡、Markdown 显示 |
| `desktop/src/renderer/assistantDemo.ts` | 明确标注的浏览器演示，无真实模型/测试副作用 |

## 安全与已知边界

- 助手不代替人工确认脚本、接受修复、业务复核或审批生产执行。
- 生产环境不允许从助手启动回归，性能执行仍沿用原有生产禁用约束。
- 取消不能撤销已经发生的网络请求、数据写入或本地脚本更新；部分保存会保留已知成功计数且不自动重试。
- 凭据字段、请求 headers/body 不作为项目摘要发送；仍不保证自由文本中一切敏感信息都能自动识别，用户不应粘贴凭据。
- 前端只经过受限 preload API，不直接访问 Electron 或 Node。
- 会话历史损坏会关闭助手操作，保留原文件供人工处理，不阻断其他测试功能。
- 浏览器预览仅使用合成数据，刷新重置；不能代替真实模型连通、桌面主进程和真实被测系统的验收。

## 验证入口

```bash
npx tsc -p desktop/tsconfig.main.json --noEmit
npx tsc -p desktop/tsconfig.renderer.json --noEmit
npm exec --workspace desktop -- vitest run test/assistant-service.test.ts test/assistant-model.test.ts test/assistant-view.test.ts test/assistant-markdown.test.ts
```

主进程和 preload 改动需要重新启动桌面应用；仅刷新 renderer 不会加载新后端代码。
