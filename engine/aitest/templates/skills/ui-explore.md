# 技能：UI 探索与脚本生成（探索模式）

目标：为一条 UI 用例在内嵌浏览器里走通一遍，录制成确定性的 Playwright 脚本。之后回归直接跑脚本，不再调用模型。

1. `case-store.list_cases` 读取用例；确认前置数据：`env-support.check_data`，缺失则 `env-support.seed_data`。
2. 需要登录时调用 `browser.new_role_context`（只写角色名，账号由客户端注入，登录态保存为 storageState）。
3. `browser.navigate` → `browser.snapshot` 获取元素 ref → `browser.click` / `browser.type` / `browser.select` 逐步操作。
   - snapshot 找不到元素时才用 `midscene.ai_locate` 视觉定位，它同样返回 ref。不要用 `midscene.ai_act`（无法生成确定性脚本）。
4. 每个预期结果都要落成断言：`browser.expect_visible` / `browser.expect_text` / `browser.expect_url`。
   - 埋点：操作前 `browser.start_capture`，操作后 `browser.expect_request` 断言上报字段。
   - 视觉类预期（颜色、遮挡、截断）：`browser.visual_check`，结果进入人工复核队列。
   - 时间窗口：`browser.install_clock` 控制前端时间；服务端时间用 `env-support.set_clock`。
5. `browser.save_ui_script` 生成脚本（一个用例一个 spec，文件头写用例 ID），再 `browser.run_playwright_script` 试跑一次。
6. 选择器优先级：data-testid → role / label → 文本 → CSS，禁用绝对 XPath。不要在脚本里写明文密码。
