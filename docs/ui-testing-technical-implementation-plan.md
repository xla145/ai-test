# UI 测试智能执行技术实现方案

> 文档状态：分阶段实施中（2026-11-20，首批运行时数据链路已落地）\
> 目标：在保证执行准确率、结果可追溯和失败可归因的前提下，降低 UI 用例生成与探索耗时，减少 Midscene 调用，并让回归阶段完全确定性执行。

## 1. 背景与问题定义

当前 UI 测试流程为：

```text
测试用例
  → Agent 转换执行计划
  → 浏览器探索
  → Midscene 视觉定位
  → 录制 Playwright 脚本
  → 试跑校验
  → UI 回归
```

近期日志和执行计划暴露出以下问题：

1. 动态数据被错误建模为普通数据库前置条件。
2. Agent 能识别“唯一用户名、未注册邮箱、两组不同密码”等语义，但没有表达“生成 → 校验 → 复用”的变量关系。
3. `status: ready` 只表示计划格式可解析，不表示前置条件已经实际通过。
4. 前置条件、运行时数据、业务对象和清理动作混在同一层，导致执行时序不清晰。
5. Midscene 同时承担定位、操作辅助和断言，带来额外耗时和不可控恢复。
6. 任务日志不能明确区分契约失败、数据失败、环境失败、模型失败、脚本失败和清理失败。
7. `browser.open_project` 失败后仍可能继续调用后续浏览器工具，存在上下文未初始化的风险。
8. `Close context` 等清理异常可能覆盖实际的业务执行结果。
9. Midscene 坐标系、内嵌浏览器缩放和高分屏场景缺少校准验证。
10. 当前回归脚本已经趋向确定性，但运行时数据绑定和前置检查尚未完全确定性化。

## 2. 设计目标

### 2.1 准确性目标

- 原始用例的步骤、预期、前置条件和清理要求不丢失、不改写、不缩减。
- 动态数据在一次执行中只生成一次，后续检查、输入、断言和清理使用同一变量。
- UI 操作最终沉淀为稳定的 Playwright 定位器，回归阶段不依赖模型。
- 每个失败都有明确阶段和归因，不把环境问题误判为产品缺陷。
- Midscene 定位结果必须经过 DOM 和目标范围校验后才能录入脚本。

### 2.2 速度目标

- 普通控件优先使用 DOM 定位，不调用视觉模型。
- 回归阶段默认调用模型次数为 0。
- 单个探索用例只在必要目标上调用 Midscene。
- 稳定页面允许使用经过校验的视觉定位缓存。
- 计划生成失败在静态校验阶段发现，不进入浏览器探索。
- 单个目标最多一次视觉恢复，禁止无限改写自然语言重试。

### 2.3 可维护性目标

- 执行契约、运行时数据、浏览器动作、脚本和执行报告之间可追溯。
- 支持旧版 v1 契约兼容，并逐步迁移到 v2。
- 失败日志可直接定位到项目、环境、用例、阶段、步骤和证据。
- Agent、Skill、编译器、执行器和 Midscene 的职责边界清晰。

## 3. 总体架构

```text
┌─────────────────────────────────────────────┐
│ 原始测试用例                                 │
│ steps / expected / preconditions / cleanup   │
└──────────────────────┬──────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────┐
│ Agent Contract Compiler                      │
│ 语义解析 + 结构化输出 + 静态校验 + 一次修复   │
└──────────┬───────────────┬──────────────────┘
           │               │
           ▼               ▼
┌──────────────────┐  ┌──────────────────────┐
│ Runtime Data     │  │ Executable Checks    │
│ 动态数据生成与绑定 │  │ 环境/会话/对象检查     │
└────────┬─────────┘  └──────────┬───────────┘
         │                       │
         └──────────┬────────────┘
                    ▼
┌─────────────────────────────────────────────┐
│ Browser Exploration                          │
│ DOM-first，Midscene fallback，录制确定性步骤  │
└──────────────────────┬──────────────────────┘
                       ▼
┌─────────────────────────────────────────────┐
│ Deterministic Playwright Script              │
│ runtimeData + locator + assertions + cleanup │
└──────────────────────┬──────────────────────┘
                       ▼
┌─────────────────────────────────────────────┐
│ Replay / CI                                  │
│ Playwright + API + DB，不调用模型             │
└─────────────────────────────────────────────┘
```

## 4. 核心数据模型改造

### 4.1 ExecutionContract v2

现有 v1 将大量语义压缩在 `preconditionChecks` 中。建议新增 v2，保留 v1 读取兼容。

```json
{
  "version": 2,
  "status": "ready",
  "issues": [],
  "source": {
    "preconditions": [],
    "steps": [],
    "expected": [],
    "cleanup": []
  },
  "environmentChecks": [],
  "sessionChecks": [],
  "runtimeData": [],
  "businessObjectChecks": [],
  "steps": [],
  "expected": [],
  "cleanup": []
}
```

原始字段仍然必须原样保留，v2 只是增加执行编译结果，不允许用编译结果替换原文。

### 4.2 运行时数据模型

动态数据不再仅作为普通前置条件处理，新增 `runtimeData`：

```json
{
  "runtimeData": [
    {
      "name": "username",
      "type": "username",
      "generator": "unique",
      "scope": "case",
      "constraints": {
        "minLength": 6,
        "maxLength": 32
      },
      "secret": false
    },
    {
      "name": "email",
      "type": "email",
      "generator": "unique",
      "scope": "case",
      "secret": false
    },
    {
      "name": "password",
      "type": "password",
      "generator": "random",
      "constraints": {
        "minLength": 6,
        "maxLength": 32,
        "maxUtf8Bytes": 72
      },
      "secret": true
    },
    {
      "name": "confirmPassword",
      "type": "password",
      "generator": "different_from",
      "source": "password",
      "secret": true
    }
  ]
}
```

动作统一使用 `valueRef`：

```json
{
  "action": "fill",
  "instruction": "填写唯一用户名",
  "targetHint": "注册表单中的用户名输入框",
  "valueRef": "username"
}
```

禁止在动作中写不可执行的自然语言伪变量，例如：

```json
{
  "value": "执行时生成的唯一用户名"
}
```

### 4.3 前置检查模型

前置检查按执行能力拆分：

### 环境检查

```json
{
  "id": "ENV_1",
  "kind": "environment",
  "method": "api",
  "blocking": true,
  "endpoint": "/health",
  "expect": { "status": 200 }
}
```

### 会话检查

```json
{
  "id": "SESSION_1",
  "kind": "session",
  "mode": "anonymous",
  "blocking": true
}
```

### 数据检查

```json
{
  "id": "DATA_1",
  "kind": "runtime_data",
  "valueRef": "username",
  "method": "database",
  "assert": "not_exists",
  "blocking": true
}
```

### 业务对象检查

```json
{
  "id": "OBJECT_1",
  "kind": "business_object",
  "method": "api",
  "query": {
    "type": "project",
    "filter": { "name": "${projectName}" }
  },
  "cardinality": "exactly_one",
  "blocking": true
}
```

### 设计约束检查

“本例不依赖登录角色”“不要在探索前建立角色会话”属于执行策略，不应重复变成多个浏览器断言。可以保留为 `policy`，但不单独消耗浏览器操作：

```json
{
  "id": "POLICY_1",
  "kind": "execution_policy",
  "rule": "anonymous_only",
  "blocking": true
}
```

### 4.4 清理模型

清理独立于业务预期：

```json
{
  "cleanup": [
    {
      "type": "delete_created_data",
      "refs": ["createdUser"]
    },
    {
      "type": "logout"
    }
  ]
}
```

清理失败不能覆盖已经完成的业务结果，应记录为独立的 `cleanup` 状态。

## 5. Agent Contract Compiler

### 5.1 编译流程

```text
1. 读取原始用例
2. Agent 输出 ExecutionContract v2
3. Zod/JSON Schema 校验
4. 语义静态校验
5. 失败时向 Agent 发起一次定向修复
6. 再次校验
7. 仍失败则 status=needs_clarification 或 blocked
8. 只有校验通过才启动浏览器
```

Agent 不应直接决定所有执行细节。Agent 负责语义转换，编译器负责判断结果是否可执行。

### 5.2 必须增加的静态校验

### 变量校验

- `runtimeData.name` 不重复。
- `valueRef` 必须引用已声明变量。
- `different_from` 必须引用已存在的源变量。
- 密码变量必须标记 `secret: true`。
- 清理动作引用的变量必须存在。

### 数据检查校验

- `method: database` 必须有 `valueRef` 或明确固定查询。
- `verificationHint` 中出现“执行时生成”“动态生成”时，必须存在对应 `runtimeData`。
- 禁止出现“在确定输入值后检查”但没有变量名的检查项。
- 唯一性检查必须与后续输入动作引用同一变量。

### 覆盖校验

- 每个原始步骤必须映射到执行步骤。
- 每个原始预期必须映射到断言。
- 每个阻塞型前置检查必须有执行证据。
- `manual` 和 `policy` 检查不能伪装成自动断言证据。
- 前置检查证据必须位于正文步骤之前。

### 冗余校验

- 同一原始前置条件拆出的检查必须互不重复。
- “匿名状态”“不依赖角色”“不建立角色会话”不能生成三个等价的 UI 检查。
- 可由 `runtimeData` 生成器保证的约束，不重复要求用户手工输入。

### 5.3 Agent 修复提示词

在 `desktop/src/main/prompts.ts` 的 UI 契约提示词中增加以下硬性规则：

```text
1. 现场可生成的用户名、邮箱、密码必须放入 runtimeData，不得只写成普通 database 前置检查。
2. 所有动态输入必须声明变量名，后续 fill、database、assertion、cleanup 必须通过 valueRef 引用同一变量。
3. database 检查没有 valueRef 或固定 query 时，计划无效。
4. “在确定输入值后检查”不是可执行计划，必须改成明确的 runtimeData 变量引用。
5. method=manual 表示人工或设计约束，不得伪装成自动验证成功。
6. 执行策略不应重复生成浏览器断言。
7. 不得因为输入值是运行时生成而标记 needs_clarification。
8. 不得为满足可执行性而删减原始步骤、预期或前置条件。
```

## 6. Runtime Data Manager

新增运行时数据管理层，建议放在 UI 编排模块和 MCP UI 工具之间，职责如下：

```text
生成数据
→ 校验数据
→ 脱敏存储
→ 注入浏览器探索
→ 注入 Playwright 脚本
→ 记录创建对象
→ 清理对象
```

#### 6.1 生成策略

- `unique username`：随机串 + 前缀，必要时做 API/DB 唯一性检查。
- `unique email`：随机串邮箱，必要时做 API/DB 唯一性检查。
- `different_from`：生成与源变量不同且满足约束的值。
- `password`：只在内存中保存，不进入普通日志。
- 所有变量绑定到一次 case execution，不绑定到全局任务。

#### 6.2 数据检查失败处理

```text
生成值冲突
  → 自动重新生成一次
  → 再次冲突则返回 data_blocked
```

不要把数据冲突交给 Midscene，也不要让 Agent 自行换数据。

#### 6.3 数据证据

报告只记录：

```json
{
  "name": "username",
  "maskedValue": "ui_********",
  "generator": "unique",
  "verified": true
}
```

密码只记录：

```json
{
  "name": "password",
  "secret": true,
  "verified": true
}
```

## 7. 浏览器探索策略

### 7.1 DOM-first

定位优先级统一为：

```text
data-testid
→ role / label / placeholder
→ 结构化 scope
→ 文本和行上下文
→ Midscene aiLocate
```

现有 `BrowserSession` 已有 snapshot、findText、scope、row identity 和 locator 重绑定能力，应优先利用这些能力。

### 7.2 Midscene 使用边界

Midscene 只负责：

1. 页面结构未知时发现目标。
2. DOM 无法表达的视觉定位。
3. 视觉类结果，例如遮挡、截断、颜色和布局。
4. 探索阶段的辅助判断。

Midscene 不负责：

- 生成或校验唯一业务数据。
- 判断登录态和权限。
- 判断接口返回和数据库结果。
- 普通文本、URL、数量、输入值断言。
- 生成最终回归脚本。
- 在回归阶段自动决定业务结果。

### 7.3 Midscene 定位调用规则

- 每次只定位一个目标。
- 优先传结构化 `target`，包含 page、scope、control、name。
- 同一目标第一次视觉定位失败后，先退回 snapshot/findText。
- 最多允许一次有依据的视觉恢复。
- 禁止通过改写自然语言无限重试。
- 定位结果必须经过 `locateAt`、scope 和 DOM locator 校验。
- 只有校验通过才允许录入 `save_ui_script`。
- 不使用 `ai_act` 直接生成最终脚本。

### 7.4 Midscene 缓存策略

当前 `aiLocate(..., { cacheable: false })` 会牺牲速度换取安全性。建议改为条件缓存：

### 允许缓存

- 页面 URL 稳定。
- target 使用结构化描述。
- 目标经过 DOM 唯一性验证。
- 页面结构 hash 未变化。

### 禁止缓存

- 动态表格中的随机行。
- 目标包含随机文本。
- 当前页面结构发生变化。
- 上次缓存定位结果未通过 scope 或文本校验。

缓存 key 应包含：

```text
project_id
environment
page route
application/page structure hash
testid attribute
structured target
```

不能使用跨项目、跨环境的全局固定 cache id 作为唯一隔离依据。

### 7.5 Midscene 坐标校准

当前 `mcp-servers/src/ui/midscene.ts` 对 Midscene 坐标单位有明确假设，但 Midscene Web API 在不同版本和截图模式下可能返回物理截图坐标或逻辑 CSS 坐标。

必须增加校准测试：

1. 页面渲染一个已知位置的测试按钮。
2. 获取 Playwright `boundingBox`。
3. 调用 `aiLocate` 获取 center、rect、dpr。
4. 在 dpr=1、dpr=2 和 Electron 内嵌缩放下比较坐标。
5. 明确转换公式后再进入生产逻辑。
6. 任何坐标校准失败都不能继续点击。

建议优先使用 Midscene 找到目标后，再由 DOM hit-test 和结构化 locator 完成操作，尽量减少直接按坐标点击。

## 8. 确定性脚本生成

生成的 Playwright 脚本必须包含：

```text
1. runtimeData 初始化
2. 环境/会话前置检查
3. 必要的数据检查
4. 独立入口导航
5. 原始步骤映射
6. 原始预期断言
7. 数据库或 API 结果断言
8. cleanup
```

脚本中禁止：

- 重新调用 Midscene。
- 使用探索现场已有的登录态。
- 使用固定的临时用户名或邮箱。
- 使用明文密码。
- 使用绝对 XPath。
- 重新随机选择业务对象。
- 通过删除断言来绕过覆盖检查。

## 9. 任务状态和日志改造

### 9.1 任务阶段

任务必须显式记录阶段：

```text
contract
runtime-data
precondition
explore
script
replay
cleanup
```

### 9.2 失败类型

```text
data
precondition
auth
environment
model
locator
script
product
cleanup
unknown
```

### 9.3 推荐结果结构

```json
{
  "taskId": "...",
  "caseId": "...",
  "status": "passed",
  "stageResults": {
    "contract": { "status": "passed" },
    "runtimeData": { "status": "passed" },
    "precondition": { "status": "passed" },
    "explore": { "status": "passed" },
    "script": { "status": "passed" },
    "replay": { "status": "passed" },
    "cleanup": { "status": "failed", "failureType": "cleanup" }
  }
}
```

`cleanup` 失败不能把前面的业务结果改成失败，但必须在最终结果中显著提示。

### 9.4 `open_project` 失败处理

`browser.open_project` 是浏览器工具链的初始化门槛。失败后必须：

1. 标记当前任务为 `environment` 或 `precondition` 阻塞。
2. 终止后续 browser 工具调用。
3. 保存失败原因和项目/环境参数。
4. 不允许继续执行 `type`、`click`、`assert` 等动作。
5. 新任务必须创建新的浏览器上下文。

当前日志中出现 `open_project` 失败后仍有后续操作，这种行为必须消除。

## 10. 代码改造范围

### P0 文件

- `desktop/src/main/prompts.ts`
  - 增加 runtimeData、valueRef、数据库检查绑定和禁止重复拆分的提示词。
- `desktop/src/main/uiExecutionContract.ts`
  - 增加 v2 契约解析、版本迁移和静态校验。
- `desktop/src/main/orchestrator/uiTesting.ts`
  - 编排 runtimeData、前置检查、浏览器探索和清理阶段。
- `desktop/src/main/orchestrator/taskManager.ts`
  - 增加阶段化状态和 cleanup 独立结果。
- `mcp-servers/src/ui/contract.ts`
  - 扩展 v2 schema。
- `mcp-servers/src/ui/executionGuard.ts`
  - 区分自动断言、人工检查、执行策略和运行时数据检查。
- `mcp-servers/src/ui/coverage.ts`
  - 支持 runtimeData 和新的前置检查映射。
- `mcp-servers/src/ui/tools.ts`
  - 增加 runtimeData 注入、初始化失败硬阻塞和 valueRef 处理。
- `mcp-servers/src/ui/codegen.ts`
  - 生成变量绑定和脱敏日志。
- `mcp-servers/src/ui/midscene.ts`
  - 增加坐标校准、缓存隔离和失败诊断。
- `mcp-servers/src/ui/browser.ts`
  - 强化 DOM-first、目标校验和恢复次数限制。

### P1 文件

- `engine/aitest/templates/skills/ui-explore.md`
  - 增加 runtimeData 执行顺序和变量复用规则。
- `engine/aitest/templates/skills/ui-heal.md`
  - 增加 cleanup、data、auth、environment 的不可自愈规则。
- `mcp-servers/src/ui/runner.ts`
  - 分离 replay、结果收集和清理状态。
- `desktop/src/renderer/pages/ui/UiWorkbench.tsx`
  - 展示契约校验失败、前置阻塞、模型失败、脚本失败和清理失败。

## 11. 实施顺序

### Phase 0：止血

1. `open_project` 失败后立即终止任务。
2. `Close context` 与业务执行结果分离。
3. 日志增加阶段和 failureType。
4. 记录 `status=ready` 时明确提示“仅表示计划解析通过，尚未验证前置条件”。
5. 增加 Midscene 坐标校准测试。

### Phase 1：契约和数据模型

1. 增加 ExecutionContract v2。
2. 增加 runtimeData 和 valueRef。
3. 增加静态契约校验。
4. 增加一次自动修复流程。
5. 保留 v1 读取兼容。

### Phase 2：运行时数据和前置条件

1. 实现 username/email/password 生成器。
2. 实现变量复用。
3. 实现数据库/API 唯一性检查。
4. 将环境、会话、数据、业务对象检查分层。
5. 将 cleanup 独立建模和执行。

### Phase 3：Midscene 性能和稳定性

1. DOM-first。
2. 条件启用 locate cache。
3. 缓存按项目、环境、页面结构隔离。
4. 限制视觉恢复次数。
5. 增加高分屏和 Electron 缩放测试。
6. 失败时才生成完整视觉报告。

### Phase 4：回归和 CI

1. 回归阶段默认不启用 Midscene。
2. 确定性脚本执行前完成环境和数据检查。
3. 失败结果按阶段和类型归因。
4. 只有 locator 失效才允许进入脚本自愈。
5. 生成稳定的 JUnit、HTML 和 JSON 报告。

## 12. 测试方案

### 12.1 契约测试

- 动态用户名和邮箱生成。
- 两个密码不相等。
- `valueRef` 必须存在。
- 数据库检查必须绑定变量。
- manual/policy 不生成虚假自动证据。
- 原始 source、steps、expected 完整保留。
- v1 契约可以正常迁移到 v2。

### 12.2 编排测试

- 契约校验失败时不启动浏览器。
- 数据生成失败时不进入正文步骤。
- `open_project` 失败时不调用后续浏览器工具。
- cleanup 失败不覆盖 replay 结果。
- stale task 不会永久保持 running。
- 任务取消后浏览器和 Midscene 资源正确释放。

### 12.3 Midscene 测试

- dpr=1 坐标校准。
- dpr=2 坐标校准。
- Electron 内嵌缩放校准。
- scope 不唯一时阻止视觉模型调用。
- 缓存命中后 DOM 校验失败时重新定位。
- 同一目标失败后不允许无限重试。

### 12.4 真实 UI 验收

至少覆盖：

1. 注册成功。
2. 注册密码不一致。
3. 重复邮箱。
4. 匿名访问。
5. member/admin 角色切换。
6. 动态列表行定位。
7. 业务对象创建与清理。
8. 视觉截断和窄屏场景。

## 13. 验收指标

上线前持续采集：

- 契约一次解析通过率。
- 契约静态校验失败率。
- runtimeData 生成成功率。
- 前置条件阻塞率。
- 探索阶段平均 Midscene 调用次数。
- DOM 定位成功率。
- 视觉定位成功率。
- 视觉误定位率。
- 脚本一次试跑通过率。
- 回归阶段模型调用次数。
- cleanup 失败率。
- stale task 率。
- 单用例平均生成耗时。
- 单用例平均回归耗时。

## 14. 最终职责边界

```text
Agent
  负责理解自然语言业务语义，生成结构化计划。

Contract Compiler
  负责校验计划能否执行，不允许不完整计划进入浏览器。

Runtime Data Manager
  负责生成、校验、绑定、脱敏和清理动态数据。

API/Database
  负责环境状态、业务数据和落库结果验证。

Playwright
  负责确定性页面操作、普通断言和回归执行。

Midscene
  只负责视觉定位、视觉判断和探索辅助。

Task Manager
  负责阶段状态、失败归因、证据和资源清理。
```

## 15. 方案结论

要实现“速度快、准确率高”，不应继续让 Agent 或 Midscene 承担所有决策。

推荐的稳定路径是：

```text
Agent 理解语义
→ 编译器校验可执行性
→ RuntimeData 生成并绑定变量
→ API/DB/Session 执行前置检查
→ DOM-first 浏览器探索
→ Midscene 只处理不确定视觉目标
→ 录制确定性 Playwright 脚本
→ 回归阶段零模型调用
→ 阶段化报告和可追溯归因
```

其中优先级最高的三个改造是：

1. `runtimeData + valueRef`，解决动态数据时序和复用问题。
2. 契约静态校验，解决 Agent 输出“看起来正确但无法执行”的问题。
3. DOM-first + Midscene fallback，解决速度和稳定性问题。

仅增加 Prompt 或 Skill 可以减少部分解析错误，但无法解决变量绑定、执行时序、资源清理和坐标系问题。必须同步改造契约、编排器、运行时数据层和 Midscene 适配层。


## 16. 首批落地范围（2026-11-20）

本批保持 ExecutionContract v1 兼容，先解决注册数据在前置验证、输入和回放之间断开的实际问题；完整 v2 的分层 schema 尚未落地。

- 契约 fill 增加 `valueRef`，限四个内置 case 级变量：`username`、`email`、`password`、`other_password`。拒绝未知变量、字面值与引用并存，以及非 fill 动作引用。
- 前置检查增加 `method: runtime` 和 `runtime` 规则，支持长度、UTF-8 字节上限和不同值校验。`expect_runtime_input` 执行已声明规则并录制证据；不能用 UI 可见断言冒充，也不能用该规则证明数据库唯一性。
- `browser.type(value_ref)`、`browser.expect_value(value_ref)`、`browser.expect_db(paramRefs)` 共用一次生成的变量。SQL 使用绑定参数；步骤文件与脚本只保存引用，每次回放生成新的值。旧 `generated` 参数继续兼容。
- 纯数据断言可在导航前执行，不建立额外角色会话；数据库不可用时单步调试明确失败，不能跳过后计作通过。
- `open_project` 初始化失败后拒绝后续浏览器调用。绑定执行计划时禁止不录制的 Midscene `ai_act`，防止探索现场与回放路径分离。沿用已有 DOM 优先、绑定缓存验证与有限恢复机制。
- 更新转换提示词、探索和自愈 Skill 模板，并提升转换缓存 revision 到 8，并把数据配方能力和配方脚本摘要纳入缓存指纹，让旧计划重新转换。

示例：

```json
{
  "id": "P1.1",
  "sourceIndices": [1],
  "sourceQuotes": ["两组不同的合法密码"],
  "statement": "确认密码满足长度约束且与密码不同",
  "expected": "两组不同的合法密码",
  "method": "runtime",
  "runtime": {
    "valueRef": "other_password",
    "minLength": 6,
    "maxLength": 32,
    "maxUtf8Bytes": 72,
    "differentFrom": "password"
  },
  "dependsOn": []
}
```

数据库检查用 `paramRefs: {"username": "username"}`，填写用 `value_ref: "username"`；随机生成不等同于未注册，仍要查询验证。内置生成器采用固定格式，不支持自定义名字、任意密码策略或验证码；超出能力时应明确阻塞。完整 v2、通用生成器、API 参数引用、cleanup 独立结果和线上性能指标仍属后续阶段，不能把本批测试结果视为整个方案已完成。

## 17. 最近执行问题的补充修复（2026-11-20）

- 转换和探索上下文增加项目数据配方目录，只传 key、绑定状态及检查/造数能力，不向模型传脚本。执行计划可用 `dataRefs` 选择真实配置项；未知 key 在探索前拒绝，新增引用必须经过数据准备。邮箱不能充当配方 key，配方名也不能推导出账号值。
- 数据目录和检查/造数脚本摘要参与 revision 8 的计划缓存指纹。目录顺序变化不影响缓存，配方能力或脚本变化会使缓存失效。复用脚本前仍检查依赖数据。
- `needs_clarification` 只保存为版本诊断产物，不保留为活动执行计划；再次生成时重新转换。避免相同澄清结果长期复用，补充数据后无需重新导入用例。
- 缺少前置证据时提前调用 `case_step` 会终止本次执行；阻塞后拒绝定位、覆盖映射、断言、undo 等继续执行尝试，允许状态、录制、截图留档。新任务须重新验证真实状态。
- 提示词和探索模板区分可选诊断手段与真实前置状态，避免把“必要时查看开发者工具”拆成必须抓包的硬检查。策略分类目前仍依赖语义转换提示，尚未新增独立的 policy 契约类型。

验证：桌面端缓存、编排、提示词、工作流及派生相关测试 75 项通过；浏览器门禁、运行时输入与契约相关测试 23 项通过；桌面端主进程/渲染进程类型检查与 MCP 编译通过。尚未重新执行真实 TaskFlow 用例，不能据此声称端到端耗时或成功率已达到目标。重复邮箱场景仍要求真实账号输入及账号未覆盖的可核对证据，缺少时应准确报告阻塞。

## 18. 转换契约与验证能力补全（revision 9）

最近“确认密码不一致”用例在启动浏览器前失败：模型在数据库前置检查和数据库动作中输出 `paramRefs`，转换契约未接受该字段。另外，两项“密码合法”检查只有 `valueRef`，实际上没有任何可执行约束。

本次补全以下执行边界：

1. `paramRefs` 作为数据库前置检查及数据库动作的可选字段，参数值仅允许四个内置变量；拒绝其他方法/动作携带该字段、空映射和未知变量。数据库前置证据必须使用计划指定的参数绑定；UI 可见性、错误变量或字面值覆盖都不能通过该门禁。保存前的覆盖检查使用相同规则。
2. `runtime` 至少包含一项长度、UTF-8 字节数或不同值约束；仅有 `valueRef` 在转换和回放均拒绝。这只能验证已声明的输入约束，不能自动证明全部密码业务规则。规则不明确时仍须页面或业务证据，不能随意补充默认规则。
3. 转换前向 Agent 提供 `database`、`dataApi` 能力标志，不发送连接详情或凭据。转换后如果明确选择 database 检查/动作但环境没有连接，直接在探索前返回缺失能力。该门禁依据明确的计划类型，不通过中文关键词猜测“没有新用户记录”是否必然只能用数据库验证。
4. 完整转换原文及错误保存到 `.aitest/ui-contracts/failures`，使用独立文件和受限文件权限，不进入活动计划缓存。任务详情包含失败产物路径，避免详情截断导致关键上下文丢失。
5. 缓存 revision 升到 9，验证能力参与指纹；既有用例无需重新导入，更新程序后重新生成计划。

后续性能改造应单独验收：由契约 schema 生成模型结构化输出约束，减少手写格式漂移；结构错误允许一次受约束修复，业务条件和环境缺失不自动重试；配方增加可验证事实及可返回值的类型定义，避免把 baseline 检查当成账号唯一性证明。当前尚未实现上述结构化输出、自动修复或通用配方语义，不应通过放宽门禁减少失败数。

## 19. 结构化输出、单次修复及配方事实声明（revision 10）

本批实现承接第 18 节的结构化输出、受限修复及事实声明，通用配方返回值类型仍未实现。

- 从现有 Zod 契约生成严格 outputSchema，通过 Codex `turn/start` 传递。可选字段在传输时使用 null，数据库 paramRefs 使用 parameter/valueRef 条目数组；解析后还原为原有映射并执行完整业务校验。普通探索不附加该 schema。
- JSON 语法错误或纯字段类型/多余字段错误最多修复一次。转换和修复均禁用工具，修复额度扣除首轮 token 消耗；语义、覆盖、运行时规则和能力缺失不触发修复。修复失败保留两轮原文与错误，不启动浏览器。
- 对可解析 JSON，逐字段保护错误路径以外的原始内容，禁止借修复改变验证方式、参数引用或其他有效字段。无法解析的原文没有可靠字段树，只能依靠原用例一致性校验，不能声称已证明与首轮输出逐字段语义一致。
- 测试数据新增 facts 字符串数组，旧数据库自动迁移为 []。CLI 的 `--facts '["会员账号存在"]'` 可新增/更新，省略保留，[] 清空。导入导出保留声明，转换与探索接收声明，事实变化使计划缓存失效。声明不能直接把前置门禁标记为通过，也不能证明本次动态输入唯一。
- 计划 revision 升到 10；不需要重新导入已有用例。更新程序后重新生成计划即可。尚未重跑真实 TaskFlow，因此没有新的端到端耗时或成功率结论；要求数据库证据的用例仍须配置连接或提供等价可执行验证能力。

本批验证：桌面端转换缓存、协议、编排、提示词、工作流和派生测试 90 项通过；MCP 契约输出、执行门禁和运行时输入测试 29 项通过；Python 配方、迁移和导入导出相关测试 16 项通过。桌面端类型检查（含 MCP 编译）与 `git diff --check` 通过。

## 20. DeepSeek 结构化输出兼容修复（revision 11）

2026-11-20 14:49、14:50 两轮生成在转换阶段零 token 失败，最新日志原文为 `Invalid json schema: field anyOf: invalid type: sequence, expected variant identifier`。该接口拒绝旧传输 Schema 的联合类型，浏览器尚未启动。客户端同时遗漏了供应商错误消息，任务详情显示为空。

传输 Schema 现使用单一类型节点：可选字段通过 `{"$optional":[]}` 或 `{"$optional":[实际值]}` 表示；多类型 value 使用 string/boolean/number 数组槽，仅允许一槽有值。固定对象仍要求全部字段并禁止额外字段，不通过空 Schema 放宽类型。解析器还原业务结构后继续执行完整 Zod、覆盖与业务校验；已有业务格式和旧 null 表示仍可解码。缓存 revision 升至 11。

Codex 客户端保留 error 通知及 turn/completed 中的供应商错误，即使完成通知早于启动响应，也可在失败任务中显示具体原因。没有自动切换供应商或取消结构化约束。

验证范围为本地 Schema、完整计划解码、错误通知时序、转换缓存和编排回归；尚未通过当前供应商重新执行真实 TaskFlow 用例，接口兼容和端到端结果仍需更新程序后的实际生成确认。
