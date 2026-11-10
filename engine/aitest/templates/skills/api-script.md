# 技能：接口脚本生成

1. `doc-parser.parse_openapi` 获取接口定义；`api-runner.generate_api_cases` 生成基线用例。
2. 补充业务场景：接口间依赖用 `extract` 保存变量，后续用例以 `${var}` 引用（先创建再查询）。
3. 关键字段断言写入 `expected_fields`（点号路径，如 `data.status`）。
4. `api-runner.write_api_suite` 生成 pytest 脚本；`api-runner.run_api_suite` 指定环境名执行。
