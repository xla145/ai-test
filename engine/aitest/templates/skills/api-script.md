# 技能：接口脚本生成

1. `doc-parser.parse_openapi` 获取接口定义；`api-runner.generate_api_cases` 生成基线用例。
2. 补充业务场景：接口间依赖用 `extract` 保存变量，后续用例以 `${var}` 引用（先创建再查询）。
3. 关键字段断言写入 `expected_fields`（点号路径，如 `data.status`）。
   写操作类接口（创建、修改、停用）要做入库校验：在 `db_checks` 中写只读 SQL 与预期，可引用 `${var}`
   （如 `SELECT status FROM tags WHERE id = :id`，params `{"id": "${tag_id}"}`）。先用 `env-support.db_query` 了解表结构。
   需要预置数据时写 `db_setup`（只在非生产环境、可写连接上执行）。
4. `api-runner.write_api_suite` 生成 pytest 脚本；`api-runner.run_api_suite` 指定环境名执行。

## 多账号流程（下单 → 支付 → 审核 → 退款）

多个角色配合完成的业务流程写成**一条用例的 `api_flow`**，每步一个请求，按顺序执行，任一步失败整条用例失败：

- 每步写 `name`（如「买家下单」）与 `role`（角色名，与客户端「角色」一致，如 买家 / 运营）；
  不写 `role` 用环境的默认 token，`auth: false` 表示不带鉴权。
- 步骤间用 `extract` 传值：`{"order_id": "data.id"}`，后续步骤在 path / body / expected_fields 中写 `${order_id}`。
- 每步都要有断言：`expected_status`，关键状态写 `expected_fields`（如 `{"data.status": "refunded"}`）。
- 越权与权限校验也写成流程：例如买家尝试审核，预期 `403`。
- 用例的 `steps` / `expected` 按步骤一一对应写成自然语言，便于人工审核。
- 不要在用例里写账号、密码或 token：角色凭据由客户端注入（角色的固定 token，或用账号密码调用环境的接口登录换取）。

示例：

```json
{
  "title": "订单-退款审核流程",
  "type": "api",
  "priority": "P0",
  "steps": ["买家下单", "买家支付", "买家申请退款", "运营审核退款", "买家查看订单"],
  "expected": ["下单成功", "支付成功，状态为已支付", "状态为退款中", "审核通过，状态为已退款", "订单状态为已退款"],
  "api_flow": [
    {"name": "买家下单", "role": "买家", "method": "POST", "path": "/orders", "body": {"sku": "A1", "count": 1},
     "expected_status": [201], "extract": {"order_id": "data.id"}},
    {"name": "买家支付", "role": "买家", "method": "POST", "path": "/orders/${order_id}/pay",
     "expected_status": [200], "expected_fields": {"data.status": "paid"}},
    {"name": "买家申请退款", "role": "买家", "method": "POST", "path": "/orders/${order_id}/refund",
     "expected_status": [200], "expected_fields": {"data.status": "refunding"}},
    {"name": "运营审核退款", "role": "运营", "method": "POST", "path": "/admin/refunds/${order_id}/approve",
     "expected_status": [200]},
    {"name": "买家查看订单", "role": "买家", "method": "GET", "path": "/orders/${order_id}",
     "expected_status": [200], "expected_fields": {"data.status": "refunded"}}
  ]
}
```
