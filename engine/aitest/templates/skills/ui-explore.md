# 技能：UI 探索与脚本生成（探索模式）

目标：为一条 UI 用例在内嵌浏览器里走通一遍，录制成确定性的 Playwright 脚本。之后回归直接跑脚本，不再调用模型。

1. `case-store.list_cases` 读取用例；确认前置数据：`env-support.check_data`，缺失则 `env-support.seed_data`。
2. 需要登录时调用 `browser.new_role_context`（只写角色名，账号由客户端注入，登录态保存为 storageState）。
   角色名用项目里已配置的角色；用例里的身份描述（如「运营管理员」）选最接近的已配置角色（如「管理员」）。
   返回 `loggedIn=false` 并带 `hint` 时说明登录未配置：立即停止，在结论中写明 hint，不要在代码库或文件里查找账号。
3. 开始每个用例步骤前调用 `browser.case_step`（index 为用例步骤序号，从 1 开始），之后录制的操作与断言都归到这一步，界面据此对照显示。
   `browser.navigate` → `browser.snapshot` 获取元素 ref → `browser.click` / `browser.type` / `browser.select` 逐步操作。
   - `navigate` / `click` / `select` / `press` 的返回值已带操作后的页面快照，不要每次操作后再调 `snapshot`；连续按键用 `press` 一次传数组。
   - 表格单元格、状态徽标、统计文字等非交互文字不在快照的元素列表里：用 `browser.find_text` 按文本取 ref（确定性、毫秒级）。
   - snapshot 与 find_text 都找不到元素时才用 `browser.ai_locate` 视觉定位（仅在配置了视觉模型时提供，每次要数秒且可能定位偏），它同样返回 ref。
     目标上有文字时传 `text`（该元素应包含的文字）让它校验结果；报「视觉定位不准」时按提示改用 `find_text`，不要换说法反复重试。不要用 `browser.ai_act`（无法生成确定性脚本）。
   - 看页面优先用 snapshot；截图默认只截可见区域，确有必要再传 full_page=true。
4. 每个预期结果都要落成断言：`browser.expect_visible` / `browser.expect_text` / `browser.expect_no_text` / `browser.expect_value` / `browser.expect_url`。
   - 断言要落在显示结果的那个元素上：某一行的状态、数量文字用 `find_text` 取该单元格 / 文字的 ref（按 context 挑对的行）再 `expect_text`，不要对整个列表区、整页主体断言「包含」；对整块区域断言时会自动收窄到显示该文字的元素。
   - 不要对「按这段文字找到的元素」再断言包含这段文字（如对按钮「全部 19」断言包含「全部 19」）：它等于断言可见，会被录成 `expect_visible`。同一断言不要重复做。
   - 「列表中不再出现某记录」用 `expect_no_text` 对列表区断言。
   - 输入框、下拉框的取值（如「关键词已清空」「端恢复全部」）用 `browser.expect_value`。
   - 埋点：操作前 `browser.start_capture`，操作后 `browser.expect_request` 断言上报字段。
   - 视觉类预期（颜色、遮挡、截断）：`browser.visual_check`，结果进入人工复核队列。
   - 时间窗口：`browser.install_clock` 控制前端时间；服务端时间用 `env-support.set_clock`。
   - 入库校验：页面操作会改数据时，用 `browser.expect_db` 断言数据库中的结果（只读，入库延迟会自动重试）。
     不要用时间戳等每次都变化的字段做断言。
5. `browser.save_ui_script` 生成脚本（一个用例一个 spec，文件头写用例 ID），再 `browser.run_playwright_script` 试跑一次。
   - 脚本只能由 `save_ui_script` 生成：不要手工编辑 `scripts/ui` 下的 spec 或 steps 文件（界面按步骤文件调试，手改会失去对照）。
     保存后发现缺断言，继续用 browser 工具录制，再 `save_ui_script`（append=true）追加。
   - 试跑因环境缺失失败（如浏览器未安装）时不要安装任何软件，在结论中说明即可，用户会在内嵌浏览器中试跑校验。
6. 选择器优先级：data-testid → role / label → 文本 → 限定到行内 → CSS，禁用绝对 XPath；录制时自动避开生成的 id / class 和行号。不要在脚本里写明文密码。
