# UI 执行用例格式实验

独立实验，不接入生产用例库。方案：`docs/ui-case-execution-contract-plan.md`。

## 内容

- `contract.mjs`：Zod Schema、引用/准入检查、Midscene 定位描述编译器。
- `contract.test.mjs`：格式和准入正负例。
- `fixture.mjs`：六类目标、两个同名区域、稳定结果断言、重置页面。
- `run.mjs`：真实 Midscene 对照，或显式的 DOM 坐标控制实验；生成 spec 并独立回放。
- `with-desktop-vision.cjs`：使用现有 Electron safeStorage 加载当前视觉模型，仅通过子进程环境变量注入 key，不输出和落盘明文凭据。

## 重现

从仓库根目录运行，使用已有依赖及浏览器：

```sh
npm run build -w mcp-servers
./node_modules/.bin/tsc -p desktop/tsconfig.main.json
node --test scripts/experiments/ui-case-contract/contract.test.mjs
node scripts/experiments/ui-case-contract/run.mjs --control
```

`--control` 给出已知 DOM 中心，只验证夹具、映射、录制和回放，**不计作真实视觉成功率**。

使用当前桌面端配置进行真实模型实验：

```sh
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/experiments/ui-case-contract/with-desktop-vision.cjs
```

也可在已安全注入 `MIDSCENE_MODEL_*` 环境变量的进程中直接运行 `node scripts/experiments/ui-case-contract/run.mjs`。不要将 key 放入命令行或报告。

单独验证模型族（不会改全局设置）：

```sh
CONTRACT_MODEL_FAMILY=qwen3-vl CONTRACT_OUTPUT_DIR=.release/ui-case-contract/qwen3-vl env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/experiments/ui-case-contract/with-desktop-vision.cjs
```

默认三轮，每轮六类目标 × 简略/结构化两组，共 36 次定位；交替执行顺序。可通过 `CONTRACT_ROUNDS` 和 `CONTRACT_TASK` 缩小复测范围，但报告必须注明。操作成功的结构化样本生成 spec，默认独立回放三轮。所有原始失败仍在 `results.json` 中。

单独执行六步连续流程（不在步骤间重置页面，随后独立回放三次）：

```sh
CONTRACT_FLOW=1 CONTRACT_MODEL_FAMILY=qwen3-vl CONTRACT_OUTPUT_DIR=.release/ui-case-contract/flow env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/experiments/ui-case-contract/with-desktop-vision.cjs
```

验证生产工具新增的原生 `target` 参数时，追加 `CONTRACT_NATIVE_TARGET=1`，并使用独立的 `CONTRACT_OUTPUT_DIR`（例如 `.release/ui-case-contract/implementation-live`）保留旧实验结果。控制流程同样支持该开关。

连续流程的 DOM 控制实验和断言串位反例：

```sh
node scripts/experiments/ui-case-contract/run-flow.mjs --control
node scripts/experiments/ui-case-contract/probe-assertion.mjs
```

反例会分别检查原生成断言和实验中的区域限定断言。进程正常退出仅表示实验执行完成且限定版本能拦截错误，必须查看 JSON 中 `originalRejectsWrongField` 判断原断言是否存在问题。

所有实验结束后可运行 `node scripts/experiments/ui-case-contract/collect-results.mjs` 收集脱敏结果及汇总。尚未完成的实验不会被收集为最终结果。

输出默认在 `.release/ui-case-contract/{control,live}/`：JSON 记录、Schema、六条执行用例、前后截图、SDK 报告及生成脚本和 Playwright 报告。报告没有浏览器业务凭据，但 SDK 报告可能包含服务配置元信息，仅复制经过核对的结果 JSON 和合成页面截图到文档证据目录。

## 解释结果

定位描述中不包含 fixture 的 data-testid、CSS 或 oracle 坐标。评分独立读取目标 DOM 框及操作事件，错误目标上的成功点击计为错误。组件 wrapper 属于对应下拉框的合法目标范围。录制器自行生成确定性选择器；本夹具具备测试标识，不能据此宣称真实业务页面选择器同样稳定。

这些是单目标操作实验，不是自由探索 Agent 的完整业务场景实验。语义转换、真实环境准备、硬性作用域校验、真实 Element Plus 与 Electron 缩放仍需后续验证。
