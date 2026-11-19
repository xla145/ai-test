# 04 — 前置条件检查清单

> 本清单是用例模板体系的**防线**。在生成或执行用例之前，逐项检查。
> 目标：让「缺少前置条件导致脚本执行错误」这类问题降到零。

---

## 一、通用检查项（所有测试类型）

### 1.1 项目与环境

| # | 检查项 | 检查方式 | 失败影响 |
|---|--------|---------|----------|
| G-01 | 项目已创建且 `project_id` 有效 | `engine list-projects` 包含该 ID | 所有操作报 "项目不存在" |
| G-02 | 目标环境已在项目 `environments` 中配置 | `project.environments[envName]` 存在 | Orchestrator 拒绝执行 |
| G-03 | `base_url` 非空且格式正确 | URL 解析成功，协议为 http/https | 执行报错 |
| G-04 | 被测环境连通性 | 访问 `base_url/health` 或首页有响应 | 全部用例归因为 `environment` |
| G-05 | workspace 目录存在且可写 | `workspace_path` 存在 | 脚本/报告无法写入 |

### 1.2 鉴权

| # | 检查项 | 检查方式 | 失败影响 |
|---|--------|---------|----------|
| A-01 | 默认 token 已配置（有鉴权接口时） | `secretEnv(projectId, env)` 返回非空 `AITEST_AUTH_TOKEN` | 401/403 → `auth` 归因 |
| A-02 | 多角色 token 已配置（多角色用例时） | `AITEST_ROLE_TOKENS` 包含所需角色 | 角色接口全部 401 |
| A-03 | 接口登录配置正确（无静态 token 时） | `AITEST_API_LOGIN` 的 method/path/body/token_path 有效 | 登录失败，无法换取 token |
| A-04 | 角色账号密码已配置（配合接口登录时） | `AITEST_ROLES` 包含所需角色的 username/password | 角色登录失败 |
| A-05 | token 未过期 | token 的有效期覆盖测试执行时长 | 中途 401，部分用例失败 |

### 1.3 运行时依赖

| # | 检查项 | 检查方式 | 失败影响 |
|---|--------|---------|----------|
| R-01 | Python ≥3.11 可用 | `checkExecutors().python.ok` | 引擎无法启动 |
| R-02 | pytest ≥8.0 可用 | `checkExecutors().pytest.ok` | 接口回归无法执行 |
| R-03 | 引擎依赖已安装 | `PYTHONPATH` 包含 engine 和 deps | 缺少模块报错 |

### 1.4 用例状态

| # | 检查项 | 检查方式 | 失败影响 |
|---|--------|---------|----------|
| C-01 | 用例 `status` = `reviewed` | Schema 校验 | 未审核用例不参与回归 |
| C-02 | 用例 `lint_status` ≠ `blocked` | 规范检查 | 阻断脚本生成 |
| C-03 | `steps` 和 `expected` 均 ≥1 项 | Schema 校验 | 入库失败 |

---

## 二、接口测试专项检查

| # | 检查项 | 检查方式 | 失败影响 |
|---|--------|---------|----------|
| API-01 | `api.path` 以 `/` 开头 | Schema 正则校验 | 入库拒绝 |
| API-02 | `api.method` 在允许枚举内 | Schema 枚举校验 | 入库拒绝 |
| API-03 | `api.expected_status` 非空 | Schema 校验 | 无法判定通过/失败 |
| API-04 | `api.timeout` 在 0.01–300 范围 | Schema 校验 | 超时设置异常 |
| API-05 | 脚本已生成 | `{workspace}/scripts/api/` 目录存在 | runner 报错 "尚未生成接口脚本" |
| API-06 | `api_flow` 中 `extract` 变量无循环依赖 | 步骤间 `${var}` 引用前已被 extract | 变量未定义导致请求路径错误 |
| API-07 | `db_setup` / `db_checks` 的数据库连接可用 | 仅非生产环境 | SQL 执行失败 |
| API-08 | `api_revision` 匹配已审核版本 | `pytest_selection` 插件校验 | 版本不匹配被跳过 |
| API-09 | `encrypt: true` 时 `AITEST_API_CRYPTO` 已配置 | 环境变量检查 | 加密请求无法发送 |
| API-10 | `role` 对应的凭据存在 | `role_auth` fixture 解析 | 角色接口 401 |

---

## 三、UI 测试专项检查

| # | 检查项 | 检查方式 | 失败影响 |
|---|--------|---------|----------|
| UI-01 | Playwright spec 文件存在 | `{workspace}/scripts/ui/{case_id}.spec.ts` | 无脚本则不执行 |
| UI-02 | Playwright Chromium 已安装 | `checkExecutors().playwright.ok` | 浏览器启动失败 |
| UI-03 | Midscene 已配置（视觉定位时） | `checkExecutors().midscene.ok` + 视觉模型已设置 | 视觉定位功能不可用 |
| UI-04 | 登录配置完整 | `environments[env].login` 包含 url/username/password/submit | 自动登录失败 |
| UI-05 | `data_refs` 对应数据已播种 | `seedData` 返回 `seeded=true` | 用例降级到 `degraded` |
| UI-06 | 角色绑定的会话已建立 | CDP endpoint 中 viewMarkers 匹配 | AUTH_REQUIRED 错误 |
| UI-07 | 共享浏览器资源无占用 | 无其他 UI 任务持有浏览器锁 | 排队等待或死锁 |
| UI-08 | 脚本中不含硬编码的 URL/端口 | 代码审查 | 环境切换后失败 |
| UI-09 | 脚本中不含硬编码的测试数据 | 代码审查 | 数据变更后失败 |
| UI-10 | 脚本使用语义选择器 | `getByTestId` / `getByRole` 优先 | 页面改版时 script_error |

---

## 四、性能测试专项检查

| # | 检查项 | 检查方式 | 失败影响 |
|---|--------|---------|----------|
| PERF-01 | k6 已安装且版本支持 handleSummary | `checkExecutors().k6.ok` | 性能测试无法启动 |
| PERF-02 | `vus` 在 1–100 范围 | `validateBase()` | 拒绝执行 |
| PERF-03 | 总时长 ≤ 300 秒 | `rampUp + seconds + rampDown` | 拒绝执行 |
| PERF-04 | `base_url` 不含凭据/查询参数 | URL 解析检查 | 拒绝执行 |
| PERF-05 | 非生产环境 | Orchestrator 环境标记检查 | 拒绝执行 |
| PERF-06 | `p95Ms > 0` 且 `maxFailureRate ∈ [0, 1)` | `validateBase()` | 拒绝执行 |
| PERF-07 | 同项目无并行性能任务 | TaskManager 通道串行 | 排队等待 |
| PERF-08 | 被测接口在正常负载下可响应 | 单次预请求 | k6 启动后全部失败 |
| PERF-09 | 场景步骤的 `extract` 变量链完整 | 步骤间 `${var}` 引用验证 | 场景中间步骤路径错误 |
| PERF-10 | 场景中多角色的 token 均已准备 | `AIPROBE_ROLE_TOKENS` JSON | 部分角色步骤 401 |

---

## 五、执行前自动检查建议

以下是建议在 Orchestrator 层自动执行的检查逻辑，减少人工遗漏：

```typescript
// 伪代码：执行前自动检查
async function preflightCheck(project: Project, env: string, cases: TestCase[]): Promise<PreflightResult> {
  const results: CheckResult[] = [];

  // G-02: 环境存在
  if (!project.environments[env]) {
    results.push({ id: "G-02", ok: false, message: `环境 ${env} 未配置` });
  }

  // G-04: 连通性
  try {
    await fetch(project.environments[env].base_url + "/health", { signal: AbortSignal.timeout(5000) });
    results.push({ id: "G-04", ok: true });
  } catch {
    results.push({ id: "G-04", ok: false, message: "环境不可达" });
  }

  // R-01..R-03: 运行时
  const executors = await checkExecutors(runtime);
  for (const [id, check] of Object.entries(executors)) {
    if (!check.ok) results.push({ id: `R-${id}`, ok: false, message: check.detail });
  }

  // C-01: 用例状态
  const unreviewed = cases.filter(c => c.status !== "reviewed");
  if (unreviewed.length) {
    results.push({ id: "C-01", ok: false, message: `${unreviewed.length} 条用例未审核` });
  }

  // 类型专项...
  return { checks: results, canProceed: results.every(r => r.ok) };
}
```

---

## 六、检查结果处置

| 检查结果 | 处置策略 |
|----------|---------|
| 全部通过 | 正常执行 |
| 仅 WARNING | 记录诊断日志，继续执行 |
| ENV/AUTH 失败 | **阻断执行**，提示用户检查环境配置 |
| RUNTIME 失败 | **阻断执行**，提示安装依赖 |
| DATA 失败 | 相关用例降级，其余继续 |
| STATE 失败 | 记录 WARNING，可能导致部分用例失败但不阻断 |
