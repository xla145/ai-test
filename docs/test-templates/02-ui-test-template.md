# 02 — UI 测试用例模板

> 适用于 `type: "ui"`, `execution_mode: "ui"` 的用例。
> 执行路径：`Orchestrator.runUiRegression` → `ui.seedData` → `ui.runUiSuite` → Playwright spec → 结果入库 → `healUi`（可选 agent 自愈）

---

## UI 用例模板

```yaml
# ==== 通用元信息（见 00-common-meta.md）====
id: ""                          # tc_{uuid12}
title: "模块-功能-场景"
project_id: ""
type: "ui"
execution_mode: "ui"
priority: "P1"
category: "功能测试"
module_path: ["用户管理", "用户列表"]
status: "reviewed"              # ⚠️ 只有 reviewed 且有脚本的用例才参与回归
owner: ""

# ==== 前置条件（⚠️ 核心改进点）====
preconditions:
  # ---- 环境 ----
  - "[ENV] 被测环境 base_url 可达，/health 返回 200"
  - "[ENV] 登录页面 login.url 可正常加载"

  # ---- 鉴权 ----
  - "[AUTH] 环境已配置登录信息（username/password/submit 选择器）"
  - "[AUTH] admin 角色凭据已配置在钥匙串"

  # ---- 测试数据 ----
  - "[DATA] 测试数据 DEM-1002 已通过 seedData 注入或已存在"
  - "[DATA] 用户 '测试管理员' 账号可用且有管理权限"

  # ---- 运行时 ----
  - "[RUNTIME] Playwright Chromium 浏览器已安装或 Electron 内嵌浏览器可用"
  - "[RUNTIME] Midscene 组件已安装且视觉模型已配置（若使用视觉定位）"

  # ---- 系统状态 ----
  - "[STATE] 用户列表页有至少 1 条记录"

# ==== 测试数据引用 ====
data_refs:
  - "DEM-1002"                  # 通过 seedData 注入的数据 key

# ==== 步骤与期望 ====
steps:
  - "打开用户列表页面 /users"
  - "点击第一条用户的「编辑」按钮"
  - "修改用户名为「已修改」"
  - "点击「保存」按钮"
  - "验证列表中第一条用户名已更新"
expected:
  - "用户列表页正常加载，显示表格"
  - "编辑弹窗/页面打开，显示原始用户信息"
  - "用户名输入框值变为「已修改」"
  - "保存成功，弹出成功提示"
  - "列表中第一条用户名显示为「已修改」"
```

## UI 用例执行上下文

### 环境登录配置

UI 用例执行前，Orchestrator 从项目环境中读取登录配置并注入为 `AITEST_LOGIN`：

```json
{
  "url": "/login",
  "username": "#username",
  "password": "#password",
  "submit": "#login",
  "success": "/dashboard"
}
```

| 字段 | 说明 | 必需 |
|------|------|------|
| `url` | 登录页路径 | ✅ |
| `username` | 用户名输入框 CSS 选择器 | ✅ |
| `password` | 密码输入框 CSS 选择器 | ✅ |
| `submit` | 登录按钮 CSS 选择器 | ✅ |
| `success` | 登录成功后的 URL 路径（用于 `waitForURL`） | ✅ |

### 角色与会话绑定

```yaml
# 多角色用例需要声明角色绑定
# 对应 runUiSuite 的 roleBindings 参数
role_binding: "admin"           # 本用例使用 admin 角色的浏览器会话

# 执行时 runner 会：
# 1. 在 CDP host 浏览器中找到 admin 角色的 marker page
# 2. 恢复该角色的 cookie / sessionStorage / localStorage
# 3. 在隔离上下文中执行 Playwright spec
# 4. 执行后还原 session（不污染其他角色）
```

### 测试数据播种

```yaml
data_refs:
  - "DEM-1002"    # → ui.seedData(env, ["DEM-1002"], roles, workspace, signal)
  - "U1003"       # → 若 seedData 返回 seeded=false → 用例降级，不参与本次执行

# ⚠️ 关键约束：
# - seedData 返回 seeded=false 的 data_ref → 用例进入 degraded 列表
# - degraded 用例从本次 runUiSuite 的 caseIds 中移除
# - 在结果中标注 missingData 字段
```

## Playwright 脚本规范

### 脚本文件位置

```
{workspace}/scripts/ui/{case_id}.spec.ts
```

### 脚本模板

```typescript
// scripts/ui/tc_xxx.spec.ts
import { test, expect } from '@playwright/test';

// 用例标题作为 test name，case_id 作为标记
test('用户列表-编辑用户名 [tc_xxx]', async ({ page }) => {
  // ---- 1. 导航 ----
  await page.goto('/users');
  await page.waitForLoadState('networkidle');

  // ---- 2. 前置状态验证（防止前置条件不满足时浪费时间）----
  await expect(page.getByTestId('user-table')).toBeVisible({ timeout: 10000 });
  const rowCount = await page.getByTestId('user-row').count();
  expect(rowCount).toBeGreaterThan(0);  // ← 对应 precondition [STATE]

  // ---- 3. 操作 ----
  await page.getByTestId('user-row').first().getByRole('button', { name: '编辑' }).click();
  await expect(page.getByTestId('edit-dialog')).toBeVisible();

  const nameInput = page.getByTestId('edit-name');
  await nameInput.clear();
  await nameInput.fill('已修改');
  await page.getByRole('button', { name: '保存' }).click();

  // ---- 4. 验证 ----
  await expect(page.getByText('保存成功')).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('user-row').first()).toContainText('已修改');
});
```

### 脚本编写要点

| 要点 | 说明 | 违反后果 |
|------|------|----------|
| 使用 `getByTestId` / `getByRole` | 优先语义选择器，抗改版 | `script_error` 归因 |
| 显式 `waitForLoadState` | 等待网络空闲再操作 | 间歇性超时失败 |
| 操作前验证可见性 | `expect(...).toBeVisible()` | 操作不到元素 |
| 不硬编码等待时间 | 用 `expect` 断言的 timeout | 环境慢时不稳定 |
| 不直接操作 URL 中的端口 | 使用相对路径 `/users` | 环境切换失败 |
| 不内联测试数据 | 数据来自 `data_refs` 播种 | 数据不存在时失败 |

## UI 用例的证据采集

```yaml
# 执行结果中的证据路径
evidence_paths:
  - "reports/{run_id}/trace.zip"      # Playwright trace
  - "reports/{run_id}/screenshot.png"  # 失败截图

# ⚠️ 证据路径由 runner 自动生成，用例模板不需要指定
# 但需要确保 workspace 有写入权限（precondition [ENV]）
```

## 自愈流程集成

```yaml
# 当 UI 用例失败且 failure_type = "unknown" 时：
# 1. Orchestrator 收集失败用例的 evidence_paths + 脚本路径
# 2. 交给 Agent (autoHeal: true) 分析
# 3. Agent 返回归因：script_error / product_bug / environment / data
# 4. script_error 时 Agent 可尝试修复脚本

# 用例模板中的 failure_hint 帮助 agent 更准确归因：
failure_hints:
  script_error_patterns:
    - "getByTestId 找不到"       # → 页面改版，testid 变了
    - "timeout waiting for"      # → 页面加载过慢或元素不存在
  product_bug_patterns:
    - "文本内容不匹配"            # → 业务逻辑变更
    - "HTTP 500"                 # → 服务端错误
  data_patterns:
    - "列表为空"                  # → 测试数据未播种
    - "账号被禁用"                # → 测试账号状态异常
```

## 完整示例

```yaml
id: "tc_user_edit_name"
title: "用户管理-编辑用户-修改用户名"
project_id: "proj_web_admin"
type: "ui"
execution_mode: "ui"
priority: "P1"
category: "功能测试"
module_path: ["用户管理", "编辑用户"]
status: "reviewed"
owner: "qa-team"
requirement_ids: ["req_user_edit"]
preconditions:
  - "[ENV] 管理后台 test 环境可达"
  - "[ENV] 登录页配置正确（#username / #password / #login → /dashboard）"
  - "[AUTH] admin 角色凭据已配置"
  - "[DATA] 至少存在一条用户记录（DEM-USER-001）"
  - "[RUNTIME] Playwright Chromium 可用"
  - "[STATE] admin 有编辑用户权限"
data_refs: ["DEM-USER-001"]
steps:
  - "以 admin 角色登录"
  - "导航至用户列表 /users"
  - "点击第一条用户的编辑按钮"
  - "修改用户名为「已修改-{timestamp}」"
  - "点击保存"
  - "验证列表更新"
expected:
  - "登录成功，跳转到 /dashboard"
  - "用户列表页加载，表格可见"
  - "编辑弹窗打开，显示原始信息"
  - "用户名输入框更新"
  - "保存成功提示出现"
  - "列表第一行显示修改后的用户名"
```
