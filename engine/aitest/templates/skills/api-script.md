# 技能：接口脚本生成

1. `doc-parser.parse_openapi` 获取接口定义；`api-runner.generate_api_cases` 生成基线用例。
2. 补充业务场景：接口间依赖用 `extract` 保存变量，后续用例以 `${var}` 引用（先创建再查询）。
3. 关键字段断言写入 `expected_fields`（点号路径，如 `data.status`）。
   写操作类接口（创建、修改、停用）要做入库校验：在 `db_checks` 中写只读 SQL 与预期，可引用 `${var}`
   （如 `SELECT status FROM tags WHERE id = :id`，params `{"id": "${tag_id}"}`）。先用 `env-support.db_query` 了解表结构。
   需要预置数据时写 `db_setup`（只在非生产环境、可写连接上执行）。
4. `api-runner.write_api_suite` 生成 pytest 脚本；`api-runner.run_api_suite` 指定环境名执行。
