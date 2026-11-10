# 技能：失败归因

输入：`report.summarize_failures` 中 needs_agent 的失败用例（只含失败步骤的信息）。

输出每条一个结论：
- product_bug：接口返回与需求/接口定义不符，且请求本身正确。
- script_error：用例数据或断言写错、接口契约已变更（页面改版同理），附修改建议或脚本 diff。
- environment：被测环境不可达、数据缺失、依赖服务异常。

产品缺陷不修改脚本；所有脚本修改需用户确认。
