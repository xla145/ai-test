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
| 13 | 成本控制 | `appServer.ts`（单次任务上限中断）、`engine/aitest/ops.py`（用量、预算）、`orchestrator.ts` | ✅ 回归零模型调用；按用途 / 按天统计用量与成本估算；项目月度预算，超出即拒绝 agent 任务 |
| 4、15 | 国内模型与私有化部署 | `desktop/src/main/models.ts` | ✅ 百炼、DeepSeek、方舟、私有化 OpenAI 兼容预设；agent / 视觉模型分级；连通性检查；key 存钥匙串 |
| 16 | 三期：CI 集成、团队共享 | `engine/aitest/ops.py`（导出 / 导入）、`mcp-servers/src/ci.ts` | ✅ workspace 随 git 共享；`aitest-ci` 无界面回归，输出 JUnit 与摘要；生成 GitHub / GitLab 工作流 |
| 14 | 报告（JUnit XML + Playwright HTML report + 自研汇总页） | `engine/aitest/reports.py`、`desktop/src/renderer/pages/ReportsPage.tsx` | ✅ 执行历史与明细；单文件 HTML 汇总报告（截图内嵌，可合并多次执行）与 Excel 明细；CI 同时产出 |
| 17 | 首期验证指标 | `engine/aitest/ops.py`（metrics、stability、ui_gate） | ✅ 一次生成通过率、失败归因准确率、人工介入次数；门禁「UI 回归稳定」 |
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

## 三期：自愈与工程化

**失败归因闭环。** 规则判定（环境问题、5xx）与 agent 判定都写入 `attribution` 表并回写执行结果，
界面上人工确认后以人工结论为准，同时计入「失败归因准确率」。agent 也可以用 `report.record_attribution` 直接记录。

**指标（第 17 节）。**

| 指标 | 计算方式 |
| --- | --- |
| 一次生成通过率 | 脚本登记（`script_registered` 事件）后的第一次执行即通过的用例占比 |
| 失败归因准确率 | 已人工确认的归因中，自动归因与人工结论一致的比例 |
| 人工介入次数 | 人工事件（回写修改建议、编辑用例、处理自愈 diff、处理复核项、确认归因）÷ 涉及用例数；agent 的修改不计入 |
| 门禁：UI 回归稳定 | 最近 5 次 UI 回归（至少 3 次）平均通过率 ≥ 阈值（默认 95%），且没有不稳定用例；产品缺陷导致的失败不计入 |

不稳定用例：最近 10 次结果中通过 / 失败来回翻转两次以上。

**用量与成本。** 每次 agent 任务的 token 以事件记录（带用途与时间）。`usage-report` 按用途、按天汇总并按
`price_per_mtok` 估算成本；`check-budget` 在 agent 任务开始前检查月度预算，单次任务上限取客户端上限、
项目上限与剩余预算三者的最小值。日常回归不调用模型，不受预算影响。

**团队共享。** `export-workspace` 把项目元数据（环境地址、登录方式、角色名、测试数据、预算设置）写入
`.aitest/project.json`，用例写入 `cases/<id>.json`，脚本登记写入 `.aitest/scripts.json`，并提交 git。
任何看起来像凭据的字段（token、password、secret、api_key 等）都会被去掉；登录方式中的 `password`
是密码框选择器，予以保留。成员 clone 后 `import-workspace`（幂等）即可得到相同的用例库。

**CI。** `aitest-ci run --workspace . --env test` 把 workspace 导入临时数据库，执行接口与 UI 脚本（不调用模型），
写出 `reports/ci/junit.xml` 与 `summary.md`（GitHub 上同时写入 Step Summary），有失败退出码为 1。
凭据只从 CI 密钥变量读取：`AITEST_AUTH_TOKEN`、`AITEST_ROLES`。`aitest-ci init` 生成 GitHub Actions 或 GitLab CI 配置。

**国内模型与私有化部署。** agent 模型经 Codex 的 `model_providers`（OpenAI 兼容）接入，key 以环境变量
`AITEST_AGENT_API_KEY` 注入 Codex 进程；视觉模型只注入 browser 服务（Midscene）。非 GPT 模型效果需实测，
界面提供连通性检查（`/models`，不支持时用 1 token 对话探活）。

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
- **三期** ✅：失败归因闭环与人工确认、验证指标与「UI 回归稳定」门禁、用量统计与预算上限、
  团队共享（workspace 导出 / 导入）、CI 执行器与工作流生成、国内模型与私有化部署配置。
- **待真实环境验证**：Codex App Server 真机协议联调、Electron 打包后在 Windows / macOS 上的 CDP 连接、Midscene 接入实际视觉模型。
- **开工前验证**：模型接口在国内的可用性；Codex App Server 在 Windows / macOS 上的嵌入 demo。
- **首期验证（第 17 节）**：用《特征中心 v4.4》用例集全量跑规范检查，抽 30 条生成脚本试跑，
  统计一次生成通过率、失败归因准确率、人工介入次数。
