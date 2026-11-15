# UI 用例中间模板：Midscene 解析 + DOM 回放

## 结论

可行，并且应作为 UI 测试的默认编译链路：

```text
原始用例
  → UI Execution Plan（稳定中间层）
  → 页面观察与目标解析（Midscene / DOM）
  → 绑定后的 UI Script
  → Playwright / DOM 确定性回放
```

Midscene 适合把“页面上的业务描述”解析为当前页面目标；DOM/Playwright 适合执行点击、输入、选择和读取，并负责确定性断言。回放阶段不再次调用模型改写动作，目标失效或不唯一就失败并报告。

## 1. 中间模板的职责

模板必须保留原始用例，不把业务语义藏进选择器；同时把每个动作、目标、输入、前置检查、预期和证据拆成可校验结构。

```ts
interface UiExecutionPlan {
  version: 1;
  caseId: string;
  source: {
    title: string;
    preconditions: string[];
    steps: string[];
    expected: string[];
    dataRefs: string[];
    caseHash: string;
  };
  roles: { name: string; required: boolean }[];
  preconditionChecks: PreconditionCheck[];
  steps: PlanStep[];
}

interface PreconditionCheck {
  id: string;                    // P1.1，仅用于追溯
  sourceIndices: number[];       // 原始前置条件索引
  sourceQuotes: string[];       // 必须来自原文
  statement: string;             // 一个可判定事实
  expected: unknown;              // 有类型的要求
  method: "session" | "ui" | "api" | "database" | "manual";
  target?: TargetHint;
  dependsOn: string[];
}

interface PlanStep {
  id: string;                    // S1、S2，仅用于追溯
  sourceStep: number;
  role: string;
  action: "navigate" | "click" | "fill" | "select" | "check" | "press" | "read" | "assert" | "capture";
  target: TargetHint;
  value?: unknown;
  expectedIndices: number[];
  preconditionCheckIds: string[];
}

interface TargetHint {
  page?: string;
  scope?: { kind: "region" | "dialog" | "row" | "form_item" | "list"; name: string; key?: string }[];
  control?: "button" | "textbox" | "checkbox" | "combobox" | "option" | "text" | "row";
  name?: string;
  text?: string;
  placeholder?: string;
  dom?: { strategy: "testid" | "role" | "label" | "placeholder" | "text" | "css"; value: string };
  midscene?: { prompt: string };
}
```

`dom` 和 `midscene` 是目标解析方式，不是业务规则。计划可以只有自然语言 `scope`，等页面观察后再补绑定结果。

## 2. 编译职责

### A. 用例 → 计划

只做结构化，不访问页面：

- 原文步骤、预期、前置条件必须逐字保留。
- 复合前置条件拆成原子检查项；不按逗号机械拆分。
- 每个检查项引用原文，不能新增默认值。
- 每个动作只表达一个操作；不要把点击、等待、断言合成一个自然语言动作。
- 页面未知时用 `TargetHint`，不能虚构 CSS、DOM 或业务 ID。

### B. 计划 → 页面绑定

在探索浏览器中执行：

1. 恢复指定角色会话。
2. 只读执行前置检查并保存实际值、证据和页面快照。
3. 对每个新目标优先尝试已有 DOM 提示；没有稳定 DOM 时调用 Midscene 定位。
4. Midscene 返回候选后，用 DOM 唯一性、范围和控件类型校验；失败则停止，不通过改写 prompt 反复猜测。
5. 将最终 DOM locator、Midscene 诊断和页面身份保存为 binding artifact。
6. 录制结构化动作和断言，覆盖矩阵引用原始步骤、预期和前置检查 ID。

Midscene 的输出是“候选目标 + 诊断”，不是最终脚本代码。候选目标必须经过 DOM 校验才能进入回放脚本。

### C. 绑定计划 → 脚本

脚本编译器只接受已绑定目标：

- 优先 `getByTestId / getByRole / getByLabel / getByPlaceholder`，再使用受范围约束的 CSS。
- 绑定的页面、区域、行身份、角色和目标唯一性写入 steps.json。
- 生成 Playwright 动作和确定性读取器；数值、布尔、集合比较使用统一实现。
- 每个正文步骤和前置检查都有来源索引；缺任一映射就不能保存。
- 脚本执行时不调用 Midscene；DOM 目标不存在或不唯一就失败。

## 3. 运行模式

| 模式 | Midscene | DOM/Playwright | 用途 |
| --- | --- | --- | --- |
| 探索绑定 | 定位和解释候选 | 校验范围、唯一性并执行 | 生成脚本 |
| 确定性回放 | 不调用 | 全部执行和断言 | 回归、确认 |
| 视觉回放 | 可调用 | 能力不足处只产生视觉证据 | 人工复核，不直接通过 |
| 调试 | 可选重新定位 | 单步执行 | 定位脚本问题，不计入确认 |

模型服务错误、候选歧义、DOM 不匹配、断言失败和产品环境错误必须分别归因，不能自动在模式之间切换后覆盖原始结果。

## 4. 为什么比直接 Midscene 脚本稳定

- 模型只参与页面绑定，模型升级不会直接改变回放动作。
- DOM 断言避免同义词、截图误判和视觉格式差异造成假通过。
- 计划保留原文，能对照检查模型是否漏掉预期或前置条件。
- 绑定 artifact 可缓存和复用，页面改版时能精确标记失效目标。
- 失败可以判断发生在计划、绑定、回放、数据或环境哪个阶段。

## 5. 不能自动化的边界

- 没有可观察证据的后台行为不能由页面文字替代。
- 页面内存态、IndexedDB 或跨系统状态必须由环境适配器提供，不能从 DOM 猜测。
- 原文没有给出选择规则时，多个候选不能自动选择第一项。
- Midscene 找到的目标不能绕过 DOM 唯一性和角色权限校验。
- 业务词典、默认渠道、默认模型和兜底对象不进入通用模板。

## 6. 逐步落地

1. 将现有 `ExecutionContract` 兼容扩展为 `UiExecutionPlan`，先落 `preconditionChecks`、`TargetHint` 和 `preconditionCheckIds`。
2. BrowserSession 增加“前置检查阶段 / 正文阶段”状态机和检查证据。
3. `locator.ts` 增加 DOM 绑定结果校验，Midscene 结果只作为候选。
4. `codegen.ts` 只从绑定计划生成脚本，并在 steps.json 保存 binding artifact。
5. runner、store、报告和工作台显示计划、绑定和本次结果三层状态。
6. 旧脚本标记为 legacy，需重新绑定后才能确认；不按旧脚本的断言数量猜测迁移。

第一阶段先实现 schema、校验、保存和页面对照；第二阶段再接入前置检查状态机；最后切换脚本生成器。每阶段都保留原始用例和失败证据。

## 7. 实施记录：持久化与定位复用

已实现：

- 执行合同缓存规则升级到 revision 4。当前计划继续保存在 `.aitest/ui-contracts/<项目环境用例哈希>.json`；按内容指纹保存到 `versions/<fingerprint>.json`，含保存时间和合同内容摘要。写入采用权限 0600 的临时文件和原子替换。
- 同一用例恢复历史内容时可复用对应历史计划；转换后探索中断，也不重复调用转换模型。用例/数据引用/角色/环境变化按指纹隔离。完整脚本已存在且摘要一致时复用脚本，实际登录态与数据仍需回放验证。
- 结构化目标的 DOM 绑定保存在 `.aitest/ui-bindings/<identity-hash>.json`。身份键包含项目、环境、页面 URL、角色、目标语义、操作意图和 testid 属性；不同目标或页面不共用绑定。
- ai_locate 先读绑定，在当前 DOM 中检查唯一性、可见性、范围、控件类型和节点身份。通过才返回新会话 ref 并跳过 Midscene；失效时重新定位并更新产物。纯自然语言 prompt 不复用缓存。
- 工具返回 hit/miss/rebound 与原因。工作台生成结论显示中间计划复用状态及产物路径。缓存不保存坐标、会话 ref 或断言通过结果。

仍未交付：逐项前置检查的工具级阶段门禁、检查结果存储与专门的计划/绑定历史浏览页。本批缓存能力不意味着这些阶段已经实现。
