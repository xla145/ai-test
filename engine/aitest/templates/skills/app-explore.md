# 技能：App 探索与脚本生成（Android / iOS）

目标：为一条 App 用例在手机（真机或模拟器）上走通一遍，写成确定性的 Maestro 脚本。之后回归直接跑脚本，不再调用模型。

工具分工：
- **Pinky**（MCP 服务 `pinky`）：看屏幕、点击、滑动、输入、打开 App。付款、删除、发送等关键步骤会在 Pinky 中等待用户确认，
  被拒绝或超时时不要绕过，改为在结论里说明需要人工处理。
- **app**（本客户端的 MCP 服务）：`app.app_info` 查询包名 / Bundle ID 与可用变量，`app.save_app_flow` 保存脚本，
  `app.run_app_flow` 用 Maestro 试跑。

步骤：
1. `case-store.list_cases` 读取用例；`app.app_info`（project_id、env、platform）确认要测的 App 与账号变量。
2. 用 Pinky 打开 App，按用例步骤逐步操作，每一步记下：点了什么（优先可见文字，其次 accessibility id）、输入了什么、看到了什么。
3. 把操作写成 Maestro 脚本（YAML），要求：
   - 文件头 `appId: ${APP_ID}`（不要写死包名，同一份脚本在 Android 和 iOS 上都用），`name:` 写用例 ID；
   - 每个预期结果都要落成断言：`assertVisible` / `assertNotVisible`；需要等待时用 `extendedWaitUntil`；
   - 定位优先级：`id`（accessibility id / resource-id）→ 可见文字 → 位置（`point`，尽量不用）；
   - 账号密码只用变量，如 `inputText: ${ROLE_ADMIN_USERNAME}`（变量名见 `app.app_info`），不要写明文；
   - Android 与 iOS 界面不同时，用 `runFlow` + `when: platform: Android` / `iOS` 分支，不要拆成两份脚本。
4. `app.save_app_flow`（case_id、yaml）保存并登记脚本，再 `app.run_app_flow` 在当前平台试跑；失败则修正后重新保存。
   两个平台都配置了 App 时，分别试跑 Android 和 iOS。
5. 最后输出：脚本路径、各平台试跑结果、仍需人工处理的步骤（如被 Pinky 拦截的确认步骤、验证码）。

示例：

```yaml
appId: ${APP_ID}
name: tc_xxx 标签管理-停用标签
---
- launchApp:
    clearState: true
- tapOn: "登录"
- inputText: ${ROLE_ADMIN_USERNAME}
- tapOn:
    id: "password"
- inputText: ${ROLE_ADMIN_PASSWORD}
- tapOn: "确定"
- tapOn: "标签管理"
- tapOn: "停用"
- assertVisible: "已停用"
```
