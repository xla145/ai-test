# 技能：UI 脚本自愈

输入：失败用例的错误信息、脚本路径、trace 与失败截图路径（只含失败步骤）。

1. 先归因：product_bug（页面行为与需求不符）/ script_error（页面改版、定位器失效）/ environment（环境不可用、数据缺失）。
2. 只有 script_error 才自愈：在内嵌浏览器里复现到失败步骤（`browser.navigate`、`browser.snapshot`），找到新的稳定定位器。
3. 只修改失败步骤相关的行，保持其余脚本不变；用 `report.propose_script_fix` 提交完整的新脚本内容，由用户审核 diff 后合并。
4. product_bug 不修改脚本，只在结论中说明。
