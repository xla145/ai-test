# 架构文档与代码对照

设计文档：《AI 测试客户端技术架构实现文档》（Claude Docs）。本文记录每一节在代码中的落点与实现状态。

## 总体架构（第 3 节）

```
界面（desktop/src/renderer）
   │ IPC（preload 暴露 window.aitest）
编排层（desktop/src/main/orchestrator.ts）── 凭据 / 审批 / 调度
   │                         │
   │ stdio JSON-RPC           │ 直接调度（回归不经过 Codex）
Codex App Server             Python 引擎（engine/aitest，JSON CLI）
   │ MCP（stdio）                ▲
MCP Server（mcp-servers）──────┘
```

## 章节对照

| 章节 | 内容 | 代码 | 状态 |
| --- | --- | --- | --- |
| 4 | Codex App Server 接入、会话模型、指令注入、沙箱审批、模型接入 | `desktop/src/main/codex/*`、`approval.ts`、`engine/aitest/templates/AGENTS.md.tpl` | ✅ 协议方法集中在 `protocol.ts`，便于升级 |
| 5 | MCP 工具层 | `mcp-servers/src/servers.ts`、`mcp-servers/src/ui/tools.ts` | ✅ doc-parser / case-store / case-import / api-runner / report / browser（含 midscene 工具）/ env-support |
| 6 | 核心流程（生成 → 审核 → 脚本 → 回归 → 失败归因） | `orchestrator.ts` | ✅ 接口线 |
| 7 | 内嵌浏览器与 UI 测试 | `desktop/src/main/index.ts`（角色视图）、`mcp-servers/src/ui/*`、`engine/aitest/heal.py` | ✅ 探索录制 → 确定性脚本、回归、自愈 diff 审核合并 |
| 8 | 接口测试方案 | `openapi.py`、`apigen.py`、`templates/*.tpl`、`runner.py` | ✅ 正向 / 必填缺失 / 边界值 / 类型错误 / 鉴权 / 幂等；接口依赖 `extract` + `${var}`；企业签名 `aitest_hooks.py` |
| 9 | 用例导入与规范检查 | `importer.py`、`linter.py` | ✅ 10 条结构类规则；语义类规则由 agent 复核 |
| 10 | 执行方式路由 | `router.py` | ✅ 关键词默认判定，agent / 人工可改 |
| 11 | 特殊场景（多角色、测试数据、时间窗口、视觉判定、条件式预期） | `ui/browser.ts`、`ui/envSupport.ts`、`ui/codegen.ts`、`linter.py` | ✅ 角色会话分区 + storageState、造数与降级、Playwright clock + 服务端时间偏移、AI 判定复核队列、条件式预期阻断 |
| 12 | 数据模型与存储 | `models.py`、`store.py`、`workspace.py` | ✅ SQLite + workspace 文件 + git 回滚 |
| 13 | 成本控制 | `appServer.ts`（token 统计、单次任务上限中断）、`orchestrator.ts` | ✅ 回归零模型调用；按 AgentSession 记录 token |
| 15 | 风险对策 | 协议适配层、凭据代理、审批白名单、规范检查阻断 | ✅ |

## UI 测试（二期）

三种运行模式（第 7 节）：

| 模式 | 入口 | 是否耗模型 | 说明 |
| --- | --- | --- | --- |
| 探索 | `Orchestrator.exploreUiCase` → agent 调用 browser 工具 | 是 | 每步操作按选择器规范录制；断言先在页面上验证再录入；`save_ui_script` 生成一个用例一个 spec |
| 回归 | `Orchestrator.runUiRegression` → `runUiSuite` | 否 | 直接跑 Playwright Test，trace + 失败截图；结果经引擎 `save-run` 入库 |
| 自愈 | `Orchestrator.healUi` | 是（只处理失败步骤） | agent 读 trace / 截图归因；改版则 `report.propose_script_fix` 生成 diff，用户确认后 `resolve-proposal` 合并并 git commit；产品缺陷拒绝改脚本 |

浏览器连接：

- 桌面端：Electron 开启 `remote-debugging-port`，browser 服务 `connectOverCDP`。每个「项目 + 角色」一个
  `WebContentsView`（独立 session partition），凭据代理的 `/views` 接口创建视图并返回 URL 标记，browser 服务按标记找到页面。
- 命令行 / CI：browser 服务自行启动 Chromium，每个角色一个 BrowserContext，登录态保存为 `scripts/ui/.auth/<角色>.json`。

Midscene 与 browser 共用一个进程（必须共享页面与 ref 表），以 `ai_locate` / `ai_assert` / `ai_act` 工具提供。
`ai_locate` 把视觉定位结果换算成确定性定位器，因此视觉模型不进入回归主路径。Midscene 为可选依赖：
`npm i @midscene/web` 并设置 `AITEST_MIDSCENE=1` 与 Midscene 的模型环境变量。

workspace 中 UI 脚本的布局：

```
scripts/ui/
  playwright.config.ts    # 客户端模板：baseURL、trace、失败截图、JSON + HTML 报告
  global-setup.ts         # 按 AITEST_ROLES / AITEST_LOGIN 为各角色登录并保存 storageState
  aitest-fixtures.ts      # openAs（多角色）、captureRequests / expectCaptured（埋点）、visualCheck（AI 判定）
  tc_xxx.spec.ts          # 一个用例一个 spec，文件头注释写用例 ID
  .auth/                  # 角色登录态（不入 git）
```

## 规范检查规则（第 9 节）

| 规则 id | 级别 | 说明 |
| --- | --- | --- |
| `required_fields` | 阻断 | 必填字段完整 |
| `steps_expected_mismatch` | 阻断 | 步骤与预期数量一致、编号连续 |
| `conditional_expected` | 阻断脚本生成 | 预期为条件式（若……则……） |
| `expected_is_action` | 警告 | 预期写的是操作而非可判定结果 |
| `undeclared_test_data` | 警告 | 步骤引用的测试数据未在前置条件声明 |
| `title_format` | 警告 | 标题不符合「模块-场景」 |
| `group_not_subdivided` | 警告 | 全部用例同一分组 |
| `precondition_duplicates_step` | 提示 | 前置条件含操作且与第 1 步重复 |
| `p0_ratio` | 提示 | P0 占比超过阈值（默认 25%） |
| `category_other` | 提示 | 类型为「其它」 |

## 迭代状态

- **一期** ✅：接口测试主线、Excel 导入与规范检查、Codex 接入骨架、凭据与审批、桌面端基础界面。
- **二期** ✅：UI 测试（内嵌浏览器 CDP、探索录制生成 Playwright 脚本、回归、自愈 diff 审核合并）、
  browser（含 Midscene）/ env-support MCP Server、多角色会话分区、埋点抓包断言、时间控制、AI 判定复核队列。
- **待真实环境验证**：Codex App Server 真机协议联调、Electron 打包后在 Windows / macOS 上的 CDP 连接、Midscene 接入实际视觉模型。
- **开工前验证**：模型接口在国内的可用性；Codex App Server 在 Windows / macOS 上的嵌入 demo。
- **首期验证（第 17 节）**：用《特征中心 v4.4》用例集全量跑规范检查，抽 30 条生成脚本试跑，
  统计一次生成通过率、失败归因准确率、人工介入次数。
