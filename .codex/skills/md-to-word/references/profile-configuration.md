# 专题方案的参考与配置

当前仅提供 [专题方案标准](topic-plan.md)，完整参数位于 [topic-plan.json](../profiles/topic-plan.json)，不继承其他报告配置。

- 参考说明定义结构、内容转换与验收要求。
- JSON 定义字体、字号、行距、缩进、页面和表格等参数。
- 转换脚本处理 Markdown、封面、目录、编号和图片占位。纯样式变化不增加脚本。

## 使用

```bash
python3 scripts/convert.py 方案.md --output 方案.docx
```

可选的显式写法为 `--profile topic-plan`。`default` 和 `formal-report` 均不接受；不传参数就是专题方案标准。

用户对当前标准提出样式调整时，可提供工作区 JSON：

```json
{
  "schema_version": 1,
  "body": {"size_pt": 12, "line": 1.5, "line_rule": "multiple"},
  "page": {"top_twips": 1440, "bottom_twips": 1440}
}
```

```bash
python3 scripts/convert.py 方案.md --style-config 客户调整.json \
  --output 方案.docx --report /临时目录/检查.json
```

优先级：完整专题配置 → 用户 JSON 覆盖。对象按字段合并，数组整体替换；修改 headings 时提供各级完整段落参数。报告 `effective_style` 记录最终配置。用户调整不代表新增一套内置标准；未要求的参数沿用专题规范。

## 参数

- 字体：`font` 为中文字体，`western_font` 为西文字体；实际环境需要可用字体。
- `size_pt/before_pt/after_pt` 和表格 `outer_pt/inner_pt` 单位为磅。
- `line_rule=multiple` 时 `line` 为倍数；`line_rule=exact` 时为固定磅值。覆盖行距时同时指定模式。
- `indent_chars/toc_indent_chars` 为字符数；`align` 为 left/right/center/both。
- `page.*_twips`：1磅=20 twips，1英寸=1440 twips。表格按原列宽比例适配正文宽度，目录制表位同步调整。
- `color/header_fill/border_color` 为不带 # 的六位十六进制颜色。
- `cover` 定义18磅基准行、标题及版本行号、版本字号；按单行标题定位，长标题仍需渲染调整。
- `bold` 可选，未指定时保留原文加粗；`base` 用于未单独定义的基础内容，其余对象用自己的配置覆盖。

未知键、错误类型、无效数值、超出纸张的边距和封面位置重叠会拒绝转换。JSON不允许执行代码，也不会关闭结构检查或改变图片占位策略。

## 参考 Word

`--reference-doc 参考.docx` 将文件只读传入 Pandoc 作为样式底稿。先检查其样式、页边距和分节，明确需要继承的内容，再提取为 JSON；显式专题/用户配置优先。

该选项不会复制参考正文、封面文字、内容控件和完整分节布局，不等于完整模板复刻。专题标准仍移除页眉，建立“第x页 / 共x页”页脚和三级目录。输出和报告不能覆盖 Markdown、参考 Word 或配置，即使指定 `--force`。

内容、XML及配置测试不证明字段页码、字体替代和视觉分页正确；最终需更新字段并渲染检查。
