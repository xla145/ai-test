"""保守分级：只将可证明局限于定位器的替换列为低风险。"""
import re


def assess(original: str, proposed: str) -> tuple[str, list[str]]:
    # Only string literals and literal role options are accepted. Computed arguments,
    # calls, templates and regexes cannot be proven to be locator-only edits.
    literal = r"(?:'[^'\\\n]*'|\"[^\"\\\n]*\")"
    options = rf"\{{\s*(?:(?:name\s*:\s*{literal}|exact\s*:\s*(?:true|false))\s*,?\s*){{1,2}}\}}"
    selector = re.compile(rf"\.getBy(?:TestId|Role|Label)\(\s*{literal}(?:\s*,\s*{options})?\s*\)(?=\.)")
    # 断言、请求参数、角色和输入值的改变不能被定位器归一化掩盖。
    # Only plain action statements qualify. Never normalize inside strings,
    # comments, assertions, computed expressions or template literals.
    def normalize(code):
        if "`" in code or "/*" in code or "\\\n" in code:
            return code
        def line(value):
            if not re.match(r"^\s*await page\.getBy", value):
                return value
            match = selector.search(value)
            if not match or not re.match(r"\.(?:click|fill|check|uncheck|selectOption|scrollIntoViewIfNeeded)\(", value[match.end():]):
                return value
            return value[:match.start()] + ".getByStableLocator()" + value[match.end():]
        return "\n".join(line(v) for v in code.split("\n"))
    old = normalize(original)
    new = normalize(proposed)
    if old == new and old != original and new != proposed:
        return "low", ["仅稳定定位器表达式变化；仍需人工核对目标并重新试跑"]
    wait = re.compile(r"\bwaitForTimeout\(\d+\)")
    if original != proposed and wait.sub("waitForTimeout(N)", original) == wait.sub("waitForTimeout(N)", proposed):
        return "medium", ["等待时间变化；需人工确认并重新试跑"]
    return "high", ["涉及断言、输入、请求、角色、步骤或无法证明语义不变的代码；需先澄清原用例"]
