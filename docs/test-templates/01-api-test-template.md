# 01 — 接口测试用例模板

> 适用于 `type: "api"`, `execution_mode: "api"` 的用例。
> 执行路径：`Orchestrator.runRegression` → `EngineCall("run-api-suite")` → `runner.run_pytest` → pytest + `conftest.py.tpl` + `test_api.py.tpl`

---

## 单接口用例模板

```yaml
# ==== 通用元信息（见 00-common-meta.md）====
id: ""                          # tc_{uuid12}
title: "模块-功能-场景"           # 如 "用户-创建用户-正常创建"
project_id: ""
type: "api"
execution_mode: "api"
priority: "P2"
category: "功能测试"
module_path: ["用户管理", "创建用户"]
status: "reviewed"              # ⚠️ 必须 reviewed 才能参与回归
owner: ""
preconditions:                  # ⚠️ 必填！
  - "[ENV] 被测环境可达"
  - "[AUTH] 鉴权 token 有效"
data_refs: []                   # 若依赖测试数据，列出 key
steps:
  - "POST /users 请求体 {name: '测试', age: 25}"
expected:
  - "HTTP 201，返回体包含 id 和 name"

# ==== API 专属字段 ====
api:
  method: "POST"                # GET | POST | PUT | PATCH | DELETE | HEAD | OPTIONS
  path: "/users"                # 必须以 / 开头
  path_params: {}               # 路径参数，如 {id: "${user_id}"}
  query: {}                     # 查询参数
  headers: {}                   # 自定义请求头（不含鉴权头）
  body:                         # JSON 请求体
    name: "测试用户"
    age: 25
  auth: true                    # 是否带鉴权，默认 true
  encrypt: false                # 是否加密
  role: ""                      # 空 = 环境默认 token；非空 = 使用指定角色凭据
  timeout: 30                   # 请求超时秒数，范围 0.01–300

  # ---- 断言 ----
  expected_status: [201]        # 预期 HTTP 状态码列表
  expected_fields:              # 预期响应字段值
    name: "测试用户"
  response_schema: null         # JSON Schema 校验（可选）
  assertions:                   # 高级断言（可选，补充 expected_fields 不能覆盖的场景）
    - path: "data.id"
      operator: "exists"
    - path: "data.age"
      operator: "eq"
      value: 25
    - path: "data.name"
      operator: "not_empty"

  # ---- 变量提取（供后续用例引用）----
  extract:                      # 从响应中提取变量
    new_user_id: "data.id"      # 后续用例以 ${new_user_id} 引用

  # ---- 数据库操作（可选）----
  db_setup:                     # 请求前的数据准备（仅非生产环境）
    - db: "default"
      sql: "DELETE FROM users WHERE name = '测试用户'"
  db_checks:                    # 请求后的入库校验（只读）
    - db: "default"
      sql: "SELECT name, age FROM users WHERE id = ${new_user_id}"
      expect:
        name: "测试用户"
        age: 25
      timeout_ms: 3000
      description: "校验用户已入库"

  # ---- 溯源 ----
  definition_id: ""             # 关联的接口定义 ID
  definition_revision: 0        # 接口定义版本
  operation_id: ""              # OpenAPI operationId
```

## 接口流程用例模板（多步骤链式调用）

```yaml
id: ""
title: "订单-创建后查询后删除"
project_id: ""
type: "api"
execution_mode: "api"
priority: "P1"
category: "功能测试"
module_path: ["订单管理", "订单生命周期"]
status: "reviewed"
preconditions:
  - "[ENV] 被测环境可达"
  - "[AUTH] buyer 和 admin 角色凭据已配置"
  - "[DATA] 商品 goodsId=1001 存在"
  - "[STATE] 订单无残留数据干扰"
data_refs: ["GOODS-1001"]
steps:
  - "买家创建订单"
  - "查询订单"
  - "管理员取消订单"
expected:
  - "创建成功，返回 orderId"
  - "查询到刚创建的订单"
  - "取消成功，HTTP 204"

# ==== 流程步骤 ====
api_flow:
  - name: "买家下单"
    method: "POST"
    path: "/orders"
    body:
      goodsId: 1001
    expected_status: [201]
    expected_fields:
      status: "created"
    extract:
      orderId: "data.orderId"   # ← 供后续步骤引用
    role: "buyer"               # ← 使用买家角色

  - name: "查询订单"
    method: "GET"
    path: "/orders/${orderId}"  # ← 引用上一步提取的变量
    expected_status: [200]
    expected_fields:
      orderId: "${orderId}"

  - name: "管理员取消"
    method: "DELETE"
    path: "/orders/${orderId}"
    expected_status: [204]
    role: "admin"               # ← 切换到管理员角色

# ==== 清理步骤（失败也执行）====
api_cleanup:
  - name: "清理残留订单"
    method: "DELETE"
    path: "/orders/${orderId}"
    expected_status: [204, 404]  # 允许已不存在
    role: "admin"
```

## 接口用例的关键约束

### 1. 环境变量注入

用例脚本运行时，以下环境变量由 `conftest.py.tpl` → `aitest_env` fixture 自动读取：

| 环境变量 | 来源 | 必需 |
|----------|------|------|
| `AITEST_BASE_URL` | Orchestrator 从项目环境配置注入 | ✅ |
| `AITEST_AUTH_TOKEN` | `secretEnv()` 从系统钥匙串读取 | 有鉴权接口时 ✅ |
| `AITEST_AUTH_HEADER` | 环境配置，默认 `Authorization` | ❌ |
| `AITEST_TIMEOUT` | 环境配置，默认 `30` | ❌ |
| `AITEST_ROLE_TOKENS` | 多角色时，角色→token 映射 JSON | 多角色时 ✅ |
| `AITEST_ROLES` | 多角色账号密码 JSON | 配合接口登录时 ✅ |
| `AITEST_API_LOGIN` | 接口登录配置 JSON | 无静态 token 时 ✅ |
| `AITEST_API_CRYPTO` | 加解密配置 JSON | `encrypt: true` 时 ✅ |

### 2. extract 变量作用域

- `extract` 的变量通过 `shared_vars` fixture（`scope="session"`）在用例间传递
- 单接口用例的 `extract` 供同一执行批次的后续用例使用
- `api_flow` 中的 `extract` 在流程内各步骤间自动传递
- **注意**：`api_variable_scope: "case"` 时，变量限制在单条用例内

### 3. 断言优先级

```
1. expected_status    — HTTP 状态码（必检）
2. expected_fields    — 响应字段精确匹配
3. assertions         — 高级断言（exists / contains / gt / lt / ...）
4. response_schema    — JSON Schema 结构校验
5. db_checks          — 数据库落库校验
```

### 4. 失败归因线索

在前置条件中声明的类型直接影响自动归因（`runner.classify_failure`）：

```
ConnectError / ConnectTimeout  → environment   ← precondition [ENV] 未满足
状态码 401/403 / 未授权         → auth          ← precondition [AUTH] 未满足
状态码 5xx                      → product_bug   ← 被测服务问题
其余                            → unknown       ← 交给 agent 判断
```

## 完整示例

```yaml
id: "tc_demo_create_user"
title: "用户-创建用户-正常创建返回201"
project_id: "proj_petstore"
type: "api"
execution_mode: "api"
priority: "P1"
category: "功能测试"
module_path: ["用户管理", "创建用户"]
status: "reviewed"
owner: "test-team"
requirement_ids: ["req_user_crud"]
preconditions:
  - "[ENV] petstore 测试环境 http://127.0.0.1:PORT 可达"
  - "[AUTH] Bearer token 已配置在钥匙串"
  - "[RUNTIME] Python ≥3.11, pytest ≥8.0"
  - "[STATE] users 表无同名用户"
data_refs: []
steps:
  - "POST /users 请求体 {name: '链路', age: 3}"
expected:
  - "HTTP 201，返回体 name='链路'，id 存在"
api:
  method: "POST"
  path: "/users"
  body:
    name: "链路"
    age: 3
  auth: true
  expected_status: [201]
  expected_fields:
    name: "链路"
  assertions:
    - path: "id"
      operator: "exists"
  extract:
    new_id: "id"
  db_setup:
    - sql: "DELETE FROM users WHERE name = '链路'"
  db_checks:
    - sql: "SELECT name FROM users WHERE id = ${new_id}"
      expect:
        name: "链路"
      timeout_ms: 2000
      description: "新建用户已入库"
  definition_id: "def_create_user"
  definition_revision: 3
  operation_id: "createUser"
  timeout: 15
```
