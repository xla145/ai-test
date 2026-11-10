# 技能：测试用例设计

输入：`doc-parser.list_sections` 返回的需求章节（只取相关章节）。

1. 按功能点拆分需求，每个功能点至少覆盖：正向、异常输入、边界值、权限、状态流转。
2. 接口类功能优先生成 api 用例；页面展示与交互生成 ui 用例；埋点上报生成 capture 用例。
3. 每条用例：标题「模块-场景」、priority（P0 只给核心链路，整体占比不超过 25%）、
   preconditions（只写状态，不写操作）、steps 与 expected 一一对应。
4. 调用 `case-store.create_case` 写入，`case-import.lint_cases` 自检，修复阻断级问题。
