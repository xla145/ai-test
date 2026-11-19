# AIProbe 用例模板体系

> 版本：1.0.0 | 日期：2026-11-19 | 适用分支：feature/optimize+

## 设计目标

1. **消除前置条件缺失**：每个模板强制声明运行时依赖、环境变量、测试数据和鉴权要求
2. **统一结构**：三种测试类型（API / UI / Performance）共享元信息骨架，差异部分按类型扩展
3. **可机器消费**：模板产出的用例既能被 `engine/aitest/runner.py` 直接执行，也能被 `Orchestrator` 调度
4. **失败可归因**：每个用例预声明「失败归因线索」，使 agent 分析和确定性归因规则都能正确工作

## 模板文件索引

| 文件 | 用途 |
|------|------|
| [00-common-meta.md](./00-common-meta.md) | 所有用例共享的元信息字段规范 |
| [01-api-test-template.md](./01-api-test-template.md) | 接口测试用例模板 |
| [02-ui-test-template.md](./02-ui-test-template.md) | UI 测试用例模板 |
| [03-performance-test-template.md](./03-performance-test-template.md) | 性能测试用例模板 |
| [04-precondition-checklist.md](./04-precondition-checklist.md) | 前置条件检查清单（通用 + 分类型） |
| [05-failure-classification.md](./05-failure-classification.md) | 失败归因规则与诊断字段映射 |

## 快速使用

生成用例时，按以下顺序填写：

```
1. 填写 00-common-meta 中的通用字段（id/title/priority/module_path/...）
2. 根据测试类型选择 01/02/03 模板，补充类型专属字段
3. 对照 04-precondition-checklist 检查每个前置条件是否满足
4. 确认 05-failure-classification 中的归因线索已正确声明
```

## 与现有系统的关系

- 模板字段严格对齐 `engine/aitest/schemas/testcase.schema.json`
- API 用例模板的产出可直接被 `templates/test_api.py.tpl` 和 `conftest.py.tpl` 消费
- UI 用例模板的脚本由 Codex Agent 或手写的 Playwright spec 文件实现
- 性能用例模板对齐 `desktop/src/shared/performance.ts` 的 `PerformanceOptions`
- 执行环境要求对齐 `desktop/src/shared/executors.ts` 的 `EXECUTORS` 注册表
