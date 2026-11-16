# AIProbe 竞品调研与改进建议

日期：2026-11-16（Asia/Taipei）  
范围：AIProbe 当前仓库、GitHub 仓库 README/API 元数据和公开文档。GitHub 星数为本次读取值，不能作为质量或可靠性指标。

## 结论

AIProbe 已经有一条比通用浏览器 Agent 更适合测试团队的主线：

```text
需求 / OpenAPI / Excel
        ↓
结构化用例与人工审核
        ↓
AI 探索一次，生成 Playwright / pytest / Maestro
        ↓
脚本回归，不调用模型
        ↓
证据、归因、自愈 diff、人工确认
```

当前最需要补强的是“可信交付闭环”，而不是扩大 AI 操作范围。闭环要能回答四个问题：

1. 这条脚本由哪一版需求、哪一版用例和哪个环境生成？
2. 每个原始预期是否被一个作用域正确的断言覆盖？
3. 这次失败是产品、环境、数据、脚本还是模型问题？
4. 团队能否像管理代码一样审查、复用、回滚和在 CI 中执行？

仓库目前已实现不少基础设施：UI 执行契约、用例哈希、脚本试跑/确认状态、原子前置检查、确定性断言、API 多账号流程、凭据代理、报告、CI 和预算控制。代码和文档中仍明确标记了真实 Electron/CDP、真实模型和真实业务数据验收尚未完成；这些验证应优先于继续扩展功能。

## Agent 执行过程

以下是目标流程及执行约束；“应”“必须”表示验收要求，不代表所有环节已实现。当前落点与待补工作见本节末尾对照表。

Agent 的执行过程应当是“受控状态机”。每次任务创建独立 Codex thread，关联项目、workspace、环境、角色、用例和用途；任务结束后提交结构化结果和证据。转换、探索、归因和修复是任务职责划分，不要求多个 Agent 并行执行。

```text
接收任务
  ↓
预算 / 权限 / 环境检查
  ↓
代码先检查契约/脚本缓存
  ├─ 契约和脚本均有效 → 跳过模型，直接试跑/确认
  └─ 需模型处理 → 创建任务 thread，读取用例及可用记忆
       ↓
生成契约 / 按已有契约探索（两个独立任务）
  ↓
契约校验：步骤、预期、角色、数据、前置检查
  ├─ 不完整 → needs_clarification，停止
  └─ ready
       ↓
  建立会话并验证登录态
       ↓
  AI 探索：observe → locate → action → deterministic assertion
       ↓
  保存步骤、断言、截图和 trace
       ↓
  干净上下文回放
  ├─ 失败 → 分类并进入人工处理 / 受控自愈
  └─ 通过 → validated
       ↓
  人工确认后允许脚本进入回归
       ↓
  日常回归直接运行脚本，不调用模型
```

### 1. 任务接收与隔离

桌面编排器先确定 `project_id`、`workspace`、`env`、`role`、`case_id` 和任务用途（`ui_contract`、`explore`、`triage` 或 `heal`）。随后创建一个新的 Codex thread，并写入 `agent-session`。同一个 thread 只承担一个连贯任务，不能把多个项目或多个环境混在一起。

任务启动时同时固定：

- 用例内容哈希、角色列表和环境配置指纹；
- 当前模型、模型适配族、提示词版本和 token 预算；
- workspace 路径、允许访问的主机和审批策略；
- 是否允许写文件、是否允许调用浏览器/App/数据库工具。

当前 UI 契约转换使用只读沙箱并禁用内置 MCP 服务；探索使用 workspace-write。只读文件沙箱不等于远程工具权限隔离，后续仍需按任务用途控制可调用工具。凭据由凭据代理交给执行工具；禁止模型主动检索 secret，项目外访问按审批策略处理。

### 2. 预算、权限和前置阻断

在首次模型调用前执行预算检查。目标是使任务 token 上限取客户端限制、项目单任务限制和剩余月度预算的最小值；转换和探索共享上限，避免通过拆分任务绕过预算。后台记忆和视觉模型调用也应纳入预算，当前业务 thread 的用量统计不保证覆盖这些调用。

随后检查：

1. 环境是否存在，是否为生产环境；
2. 角色是否已配置并允许访问目标环境；
3. 用例是否已审核，是否有步骤、预期和测试数据；
4. UI 原子前置检查是否已有可验证计划；
5. 执行计划是否仍与用例和环境指纹一致。

任一检查不通过，Agent 不应尝试“猜一个可行对象”继续执行，而是返回明确的 `needs_clarification`、`AUTH_REQUIRED`、`PRECONDITION_BLOCKED` 或 `EXECUTION_PLAN_STALE`。

### 3. 记忆与上下文压缩的使用边界

记忆用于补充稳定的项目工作方式，例如页面入口约定、已确认的组件适配规则和历史失败模式；它不能覆盖当前用例、当前环境或当前页面证据。每次任务仍必须重新读取当前用例和执行契约。

项目已配置轮结束后达到模型上下文的 80% 时允许压缩，轮内使用模型默认阈值；配置经过 Codex 0.167.0 校验，尚未实测真实模型的压缩效果。详见[记忆与压缩配置说明](codex-memory-and-compaction.md)。应用重新构建并重启后生效，记忆生成时机由 Codex 管理，也不提供项目间严格隔离。

建议新增持久化任务检查点，压缩、取消或进程重启后从检查点核对并恢复。不能仅依赖模型的自动摘要。检查点至少保留：

- 当前阶段和允许的下一步；
- 已通过及未通过的前置检查 ID；
- 当前页面/角色/session 标识；
- 已执行动作和对应步骤号；
- 原始预期与断言覆盖关系；
- 失败原因、重试次数和待处理证据路径。

压缩不能重置执行门禁，也不能让 Agent 重新执行有副作用的动作。压缩后先恢复状态摘要，再读取最新快照；如果无法确认页面状态，应停止并返回证据不足。

### 4. UI 探索循环

每个用例步骤采用固定循环：

1. `observe`：获取页面快照、可见区域、当前 URL 和稳定性信号；
2. `locate`：按页面、区域、业务对象、控件和动作意图定位目标；
3. `action`：执行一次点击、输入、选择、滚动或导航；副作用动作要记录请求/响应和结果确认；
4. `wait`：等待页面稳定、目标出现、加载状态消失或网络结果明确；
5. `assert`：优先使用确定性 DOM、URL、数值、状态、集合或数据库断言；只有视觉属性才使用视觉断言；
6. `record`：保存结构化步骤、定位器、断言来源、覆盖索引、角色和证据。

视觉模型可以帮助理解页面和找到控件，但不能决定替换业务对象、删除预期、弱化角色权限或把缺失数据当成通过。一次目标失败最多允许一次不同方法的恢复；第二次失败就阻断当前执行并保留证据。

### 5. 脚本派生与准入

浏览器探索结束后，编排器验证：

- 用例在任务期间没有变化；
- 生成脚本的 `caseHash`、结构化步骤和 spec hash 一致；
- 每个原始步骤都有动作映射；
- 每个预期和原子前置检查都有真实断言覆盖；
- 角色入口、数据引用和环境指纹完整；
- 脚本不是通过预期文本反向筛选出“看起来正确”的元素。

生成并登记脚本后先处于 `pending`。脚本单独试跑及覆盖校验通过后才能进入 `validated`，还不能直接进入回归。用户查看步骤、断言、截图和报告，确认后才变为 `confirmed`。脚本或用例内容变化后，原确认不得继续作为放行依据。

### 6. 回归、失败归因和自愈

脚本执行阶段由 Playwright、pytest 或 Maestro 直接运行，不依赖 Agent 或模型。当前 UI 回归仅在显式 `autoHeal=true` 时继续调用 Agent；API 流程可能在执行后自动调用 Agent 处理未知归因。因此应在界面区分“脚本执行”和“执行后 AI 分析”，后者单独开关、计费和记录状态。UI 当前已有试跑/确认门禁，API/App 不能直接视为已经具备同等门禁。

建议将失败处理顺序统一为：

1. 执行器收集结果、截图、trace、请求摘要、数据库证据和脚本版本；
2. 规则先检查认证、环境、数据、超时及 5xx，结合请求对象和上下文分类；业务 API 的 5xx 不应一律归为环境问题；
3. 只有 `unknown` 或需要上下文的失败才启动 triage Agent；
4. triage 只能输出受限分类和理由，不能直接修改脚本；
5. 页面改版类失败才生成 heal proposal；产品缺陷、数据缺失和权限问题不生成脚本修复；
6. 用户确认 diff 后才写入 workspace 并形成 Git commit；修复后的脚本必须重新干净复跑。

建议统一输出：`failure_type`、`reason_code`、`confidence`、`evidence_paths`、`source_run_id`、`script_hash` 和 `next_action`。没有足够证据时返回 `UNKNOWN`，不能为了提高自动归因率强行分类。

### 7. Agent 结果协议

建议新增统一的任务结果协议，由编排器汇总真实 token 事件、状态和产物哈希；不接受模型自行声称的用量和通过状态。各任务现有的契约 JSON、工具产物和归因结果保留为子结果。下例表示返回值结构，`|` 分隔的文字表示候选值，不是最终 JSON Schema：

```json
{
  "status": "completed|needs_clarification|blocked|failed",
  "purpose": "ui_contract|explore|triage|heal",
  "project_id": "proj_xxx",
  "case_id": "tc_xxx",
  "thread_id": "thread_xxx",
  "model": "configured-agent-model",
  "tokens": 12345,
  "artifacts": [".aitest/ui-contracts/...", "scripts/ui/...steps.json"],
  "coverage": {"steps": "complete", "expected": "complete", "preconditions": "complete"},
  "evidence": ["reports/.../trace.zip", "reports/.../screenshot.png"],
  "failure": null,
  "next_action": "human_review"
}
```

这样可以把 Agent 的自然语言能力限制在“理解、探索和解释”，把执行结果、覆盖关系、脚本版本和准入状态交给确定性代码管理。

### 8. 当前实现与待补工作

| 环节 | 当前实现落点 | 方案要补充的部分 |
| --- | --- | --- |
| 创建任务、预算、token、中断 | `desktop/src/main/orchestrator.ts` 的 `agentTask`；`codex/appServer.ts` 的 `startThread/runTurn` | 后台记忆与视觉用量统一入账；失败/取消任务的统一结束记录 |
| 契约转换、缓存、澄清 | `exploreUiCase`、`uiExecutionContract.ts`；转换和探索使用独立 thread，通过持久化契约交接 | 转换 JSON 之外的任务结果统一协议、变更影响展示 |
| 探索前置门禁、有限恢复 | `mcp-servers/src/ui/tools.ts`、`executionGuard.ts`；每次调用保存检查状态与步骤 | 将现有执行记录扩展为可恢复检查点；恢复前重新验证页面和业务状态，不盲目重放写操作 |
| 覆盖和脚本来源 | `coverage.ts`、`codegen.ts`、`uiWorkflow.ts` | ID/索引完整性不证明业务语义正确，仍需断言身份反例测试和人工审阅 |
| 试跑、确认、回归 | `runUiRegression`、`UiWorkflow`；当前支持复用内嵌会话或无头运行 | 固定干净入口、已知初始业务状态的验收；API/App 对等版本门禁；检查 CI 与桌面放行规则是否一致 |
| 记忆和压缩 | `codex/config.ts` 已配置记忆生成/读取与轮后 80% 压缩阈值 | 真实模型兼容性验证、记忆项目隔离、压缩恢复核验及成本覆盖 |
| 归因、自愈 | `orchestrator.ts`、`engine/aitest/heal.py`；已有 diff、人工接受、并发内容检查与 Git 提交 | 细分数据/认证/模型原因；修复风险分级；定位器修复也不得自动沿用旧校验 |

### 9. 执行过程的验收场景

- 完整命中契约与脚本缓存：本次生成入口模型调用为零，仍需遵守试跑/确认要求。
- 缺业务对象、角色或前置数据：返回缺失项和证据，不替换对象、不制造通过。
- 执行期间修改用例：旧契约不能绑定新脚本，旧确认不能放行新版本。
- 点击保存后网络超时：先检查保存结果，不能直接重复提交。
- 压缩、取消或进程重启：恢复后核对检查点和页面；无法确认时停止，已发生的写操作不能自动重放。
- 模型不可用：已可执行的脚本仍产出报告；执行后 AI 分析单独失败，不覆盖测试原始结果。
- 自愈修改断言或业务步骤：进入高风险人工审阅，不能仅凭“修复后通过”自动合并。

## 竞品观察

| 项目 | 本次读取信息 | 值得学习 | 不应直接照搬 |
| --- | --- | --- | --- |
| [Midscene](https://github.com/web-infra-dev/midscene) | 15,618 星，MIT；2026-11-13 更新 | `observe → act → assert`、步骤级 HTML 报告、截图/定位证据、缓存和跨 Web/移动/桌面适配 | 它是 AI 执行框架，不提供完整用例审核、脚本生命周期和团队测试管理 |
| [MeterSphere](https://github.com/metersphere/metersphere) | 13,635 星；V3 分社区版/企业版；GPLv3 衍生限制 | 用例、评审、接口、场景、报告和团队入口的一体化信息架构 | V3 当前重点不等于 AI UI 回归；其许可证和大型服务端架构也不适合作为桌面端直接方案 |
| [Bruno](https://github.com/usebruno/bruno) | 48,400 星，主要能力开源；2026-11-12 更新 | 本地文件夹、纯文本请求、Git 协作、离线优先、桌面端首次使用流程 | Bruno 的目标是 API 客户端，不负责需求到测试覆盖和 UI/App 回归 |
| [Stagehand](https://github.com/browserbase/stagehand) | 26,063 星，MIT；2026-11-14 更新 | `observe()` 返回真实 selector，`act/observe/extract` 分工，缓存和本地 CLI/云运行路径 | 自愈和云缓存不应进入 AIProbe 的确定性回归主路径；凭据和模型上下文边界要继续由平台控制 |
| [Hurl](https://github.com/Orange-OpenSource/hurl) | 19,325 星，Apache-2.0；2026-11-15 更新 | 文本化请求、变量提取、断言和 CLI 回归的可审查性 | 纯文本 HTTP 格式不能替代 AIProbe 的用例库、数据治理和 UI 证据 |
| [Shortest](https://github.com/antiwork/shortest) | 5,699 星；最新正式 release 为 v0.4.9（2025-04-01） | 用自然语言描述 Playwright E2E，并允许代码回调补充断言 | 依赖运行时模型；不能作为 AIProbe 的生产回归可靠性目标 |
| [TestZeus Hercules](https://github.com/test-zeus-ai/testzeus-hercules) | 1,223 星，AGPL-3.0 | Gherkin/测试意图驱动跨 UI/API 场景 | AGPL 和 Agent 运行方式都需要单独评估，不适合作为核心依赖 |
| [Hoppscotch](https://github.com/hoppscotch/hoppscotch) | 80,820 星，MIT | 请求编辑器、环境变量和低门槛 API 操作 | Web/桌面 API 工具不是测试审核和回归编排产品 |
| [Browser Use](https://github.com/browser-use/browser-use) | 121,114 星，MIT；本次读取日仍在更新 | Agent 任务编排和浏览器抽象 | 任务完成率不能替代可重复、可追责的测试结果 |
| [Skyvern](https://github.com/Skyvern-AI/skyvern) | 23,425 星，AGPL-3.0 | 长流程编排、失败恢复、业务流程抽象 | RPA 的目标是完成任务，不是证明每条测试预期都被覆盖 |

## AIProbe 的优势与短板

### 已形成优势

- **可靠性定位正确**：回归阶段直接运行 Playwright/pytest/Maestro，模型只参与生成、失败归因和受控自愈。
- **安全边界完整**：钥匙串、凭据代理、环境审批、生产写入限制和数据库只读约束已经落地。
- **UI 生成链路比普通 Agent 更严谨**：用例契约、原子前置检查、断言覆盖、脚本哈希、试跑和人工确认已经有代码支撑。
- **接口场景有差异化**：OpenAPI 生成、变量提取、多账号流程、数据库校验、测试集和 CI 适合企业回归。
- **桌面产品形态适合本地和私有化**：本地 workspace 随 Git 共享，符合 Bruno 的离线协作思路。

### 当前短板

- **证据还没有成为统一对象**：UI、API、App、数据库、归因和人工复核的证据格式与关联关系需要统一。
- **需求追踪关系不够显性**：需要从需求条目到用例、脚本、断言、执行结果的可视化覆盖，而不只是用例字段和哈希。
- **版本与分支语义仍偏文件级**：Git 文件共享已有基础，但缺少用例版本、脚本版本、审核意见和可回滚的发布基线。
- **API 工作台的首次体验可继续向 Bruno 靠拢**：导入后立即发送请求、环境变量、集合层级、历史和集合运行应成为单一入口。
- **模型效果需要真实样本补充**：仓库已提供 40 条确定性 fixture、5 轮质量门禁和机器可读报告；模型生成准确率、token/成本仍需接入真实模型样本，不能用确定性基准替代。
- **自愈策略需要更严格的变更风险分级**：定位器修复、断言修复、业务步骤变化和数据问题必须分别处理，不能都归入“修正脚本”。
- **真实环境验收仍是主要不确定性**：需要在 Electron 内嵌浏览器、Windows/macOS、真实登录态和真实数据上跑固定样本。

## 改进优先级

### P0：先把可信回归闭环做完整（建议下一迭代）

1. **建立统一 Test Artifact 模型**

   每个用例、脚本和执行都记录 `source_revision`、`case_revision`、`script_hash`、`environment_fingerprint`、`role`、`session_id`、`evidence[]` 和 `attribution`。UI 已有部分字段，API/App/数据库应复用同一模型。

2. **把需求覆盖图做成可审查页面**

   展示 `需求/接口定义 → 用例 → 步骤 → 预期/前置检查 → 断言 → 最近执行`。缺失覆盖、过期脚本和未确认自愈 diff 直接成为阻断项。保留原始需求文本和人工修改记录，模型不能静默改写原预期。

3. **固定基准集与质量门禁**

   建立 30–50 条跨页面 UI、API 多角色、数据校验和失败归因样本，每次模型/提示词/定位器改动自动运行。至少记录：一次生成通过率、独立复跑通过率、断言身份错误率、回放稳定性、误归因率、人工介入次数、P50/P95 耗时和每条用例成本。

4. **生成后强制干净复跑**

   当前 UI 已有试跑/确认状态，下一步应在产品层明确“探索完成”和“脚本可回归”两个状态；只有新会话、干净入口、明确角色和完整证据通过后，脚本才可进入确认。

5. **统一失败分类与证据包**

   统一 `PRODUCT / ENVIRONMENT / DATA / AUTH / SCRIPT / MODEL / UNKNOWN` 分类。每次失败保存脱敏 URL、请求摘要、截图、trace、DOM/定位器、断言输入输出、重试次数和分类理由；分类变化必须保留历史。

### P1：提升团队效率和产品可用性

1. **API 工作台采用“集合优先”信息架构**

   左侧集合/文件夹，中间请求编辑器，右侧响应与测试结果；环境变量、请求前脚本、响应提取和断言保持可见。支持导入 OpenAPI、导出可读文本格式、Git diff 和集合运行。可以提供 Hurl/Bruno 的导入导出适配器，避免锁定某个专有格式。

2. **用例生命周期和审核能力产品化**

   增加 `draft → needs_clarification → ready → generated → validated → confirmed → deprecated` 状态的批量过滤、审核意见、责任人、时间和变更 diff。把当前 UI 脚本阶段与 API/App 用例状态统一，而不是只在 UI 工作台显示阶段。

3. **自愈变更分级**

   - 低风险：稳定 `data-testid`、role、label 变化的定位器替换，可生成 diff 并复跑。
   - 中风险：组件作用域、等待条件、滚动容器变化，必须人工确认。
   - 高风险：预期、业务对象、角色、请求参数或步骤变化，禁止自动合并，回到待澄清。

4. **模型路由和缓存可解释化**

   在每次 AI 任务上显示模型、适配族、提示版本、是否命中缓存、token、成本、耗时和结果。参考 Stagehand 的 observe/act 分工与 Midscene 的报告结构，但不把云端缓存作为回归凭证。

5. **更短的首条成功路径**

   新项目向导建议直接提供一个本地 demo workspace：导入 OpenAPI 或示例页面后，用户可以在几分钟内完成“生成一条用例 → 试跑 → 确认 → CI 命令”。现有快速开始卡片已经提供基础骨架，应补充可复制命令和失败时的下一步。

### P2：扩大生态而不是扩大核心复杂度

- 提供稳定 CLI：`init / import / generate / validate / run / report`，每个命令输出机器可读 JSON。
- 提供 Playwright、pytest、Maestro、Bruno/Hurl 的导入导出边界；核心 workspace 格式保持平台中立。
- 提供 MCP/插件接口，让 Midscene、Stagehand 或其他视觉定位器成为可替换 provider，核心执行器只依赖统一的 `observe/locate/action/evidence` 协议。
- 后续再评估团队服务器、集中报告和 RBAC。当前本地 Git + CI 已足以验证产品价值，过早引入云服务会模糊核心定位。

## 建议的 6 周交付顺序

| 周期 | 交付 | 验收 |
| --- | --- | --- |
| 第 1 周 | 固定基准集、统一失败分类和 artifact schema | 基准可重复运行，报告可导出 JSON |
| 第 2 周 | 需求→用例→脚本→断言→执行覆盖图 | 任一断言可追溯到原始预期，过期关系可见 |
| 第 3 周 | UI 生成后干净复跑、会话/环境指纹和证据包 | 新上下文复跑通过才可确认，登录失效单独分类 |
| 第 4 周 | API 集合工作台、环境变量和集合运行 | OpenAPI 导入后可编辑、发送、断言、批量运行和导出 |
| 第 5 周 | 自愈风险分级与人工 diff | 高风险变更不可自动合并，低风险变更保留完整 diff |
| 第 6 周 | CI 门禁、成本看板、真实环境验收 | Electron/macOS/Windows 各跑固定样本，结果达到发布阈值 |

## 建议的首批发布门槛

- 固定基准集独立复跑通过率 ≥ 98%，且连续 5 次没有不稳定用例。
- 原始预期到确定性断言的覆盖率 100%；断言不能通过预期文本反向筛选目标元素。
- 生成脚本的首次干净复跑通过率、失败归因准确率和人工介入次数都有历史趋势，不能只展示单次成功。
- 生产环境禁止自动写入；凭据、token、查询参数和模型上下文中的敏感值经过脱敏检查。
- CI 不依赖模型；模型不可用时，已确认脚本仍能完成回归并产出报告。
- 所有自愈修改均可查看、拒绝、回滚，并能定位到原用例和原脚本版本。

## 本轮基于方案的落地记录

本轮先落地 P0 中不会改变既有执行可靠性边界的部分：

- **确定性报告与 AI 分析解耦**：接口脚本执行后，即使 triage Agent 超时、被中断、返回非法 JSON 或只分析了部分用例，原始 `run_id`、通过率和失败明细仍返回并可查看；页面提供“未知失败使用 AI 分析”开关。
- **统一失败分类**：新增 `data`、`auth`、`model` 和 `unknown` 展示与校验；Agent 返回的 case ID、类型和字段会经过编排器校验，重复、越界或非法结论不会污染其他用例。
- **执行版本快照**：接口和 UI 在执行前记录用例指纹、脚本 SHA-256、环境指纹、脚本路径和角色；报告详情展示快照，当前文件变化不会改写历史执行。
- **机器可读报告**：测试报告支持 JSON 导出，包含运行结果、证据、归因和执行版本，便于 CI、基准集和后续质量门禁消费。
- **Agent 过程入口**：右下角人物面板已覆盖接口、UI 和 App Agent；未来性能任务复用相同入口和任务模型。

本轮已落地的工程能力：需求与断言覆盖页面、任务事件与重启状态持久化、精确任务取消、k6 性能执行器及右下角任务入口、自愈风险分级与高风险合并阻断、用例前后版本审计。仍需在真实 Electron/CDP、真实模型、macOS/Windows 和业务数据上完成验收；固定 30–50 条基准样本的业务准确率也必须由团队提供真实 fixture 后运行，仓库不会伪造通过率。历史执行记录没有快照字段时，界面明确显示“历史记录未保存执行版本快照”。性能结果只接受本地 k6 汇总，未安装 k6 或执行被中断时记录为 error/stopped，不作为通过证据。

## 参考资料

- [Midscene GitHub](https://github.com/web-infra-dev/midscene)；[报告与缓存文档](https://midscenejs.com/consume-report-file)
- [MeterSphere GitHub](https://github.com/metersphere/metersphere)
- [Bruno GitHub](https://github.com/usebruno/bruno)；[Bruno 文档](https://docs.usebruno.com/)
- [Stagehand GitHub](https://github.com/browserbase/stagehand)；[缓存文档](https://docs.stagehand.dev/v4/best-practices/caching)
- [Hurl GitHub](https://github.com/Orange-OpenSource/hurl)
- [Shortest GitHub](https://github.com/antiwork/shortest)
- [TestZeus Hercules GitHub](https://github.com/test-zeus-ai/testzeus-hercules)
- [Hoppscotch GitHub](https://github.com/hoppscotch/hoppscotch)
- [Browser Use GitHub](https://github.com/browser-use/browser-use)
- [Skyvern GitHub](https://github.com/Skyvern-AI/skyvern)

## 继续实现记录（2026-11-16）

已实现并可在客户端使用：

- 右下角人物入口统一查看 Agent、UI、接口、App 和性能任务；按 thread 记录工具事件与压缩状态，支持精确取消、父子任务去重、token 展示、最近 100 条任务持久化。重启中断不会自动重放。
- 工程化新增「需求与断言覆盖」：保留原始需求、步骤、预期及前置条件，显示未关联、过期脚本/环境、待审自愈和最近运行。支持责任人、需求关联、审核意见及变更审计。
- API 原始条目必须人工关联到实际请求、状态码、字段、schema、数据库校验或自定义断言；请求或原文变化后映射失效，不按数量或序号自动推断覆盖。
- UI 正式校验使用独立上下文，旧策略下的确认须重新校验；脚本、用例、环境或人工复核变化会使确认失效。
- 自愈分低/中/高风险；高风险变更禁止直接合并，环境、数据、认证、模型和未知失败禁止提出脚本修复；合并检查项目归属和并发内容变化。
- 工程化新增「性能测试」：本地 k6 执行环境内 GET 负载，限制 VU 和时长，禁止生产环境，记录吞吐/失败率/P95、阈值结果和报告，支持取消和超时退出。当前不支持任意用户脚本、写请求和分布式压测。
- 固定 40 条确定性 fixture，输出 JSON、P50/P95、缺失样本和不稳定场景；连续至少 5 轮、通过率 ≥ 98% 且无不稳定项才通过门禁。已接入 GitHub Actions，始终保留基准产物。模型指标未测时为 null。

验证命令：

```bash
npm run typecheck -w desktop
npm exec --workspace desktop -- vitest run
PYTHONPATH="$PWD/.release/engine-deps:$PWD/engine" python -m pytest engine/tests -q
python scripts/benchmarks/regression.py --repeats 5
```

边界与未完成项：API/App 尚未具备与 UI 完全相同的独立试跑后人工确认门禁；Bruno/Hurl 双向适配、完整发布基线回滚、可替换定位器 provider 协议和首次使用 demo 尚未落地。真实模型、Electron/CDP、macOS/Windows、真实业务数据和 k6 实机负载验收尚未完成。因此本记录不表示整个六周方案全部完成。

本地验证结果：桌面全量 186 条通过；引擎全量 144 条通过、2 条外部数据库测试跳过；UI 专项 13 条通过；固定基准连续 5 轮共 200/200 通过，无不稳定样本。原始基准汇总位于 `reports/benchmark-regression/summary.json`。
