---
name: md-to-word
description: 将 Markdown 按专题方案标准转换为可编辑 Word，生成封面、三级自动目录、标题编号、横线表格、图片占位和页脚。支持 JSON 样式调整及参考 DOCX，检查内容与分页。用于 md 转 Word、专题方案导出；当前仅提供专题方案这一套标准。
---

# Markdown 转 Word · 专题方案标准

当前只有一套内置标准：[专题方案标准](references/topic-plan.md)。不传参数也按该标准转换；`--profile topic-plan` 仅为显式写法。不存在普通报告或正式报告模式。

正文措辞、事实、数字和顺序保持不变；只实施专题标准规定的标题与表题编号、列表字面化、目录和图片占位转换。

## 执行

1. 读取专题方案标准及源 Markdown，检查标题、目录、表格、图片和相对链接。每张表需在工作副本补齐准确表名，按专题标准生成“表章号.章内序号 表名”。父标题与首个下级标题之间有正文时明确其归属，不能擅自删除或移动。
2. 如有额外格式要求，读取 [参考与配置](references/profile-configuration.md)，以专题标准为基础创建工作区 JSON。不要虚构其他标准名称，也不为纯样式变化另写转换脚本。
3. 用 `scripts/convert.py` 转换，需要 Python 3.10+（标准库）和 Pandoc 3+：

   ```bash
   python3 "<skill目录>/scripts/convert.py" "/路径/方案.md" \
     --output "/路径/方案.docx" --report "/临时目录/转换检查.json"
   ```

   自动生成封面和目录，无需 `--cover`。唯一开头 H1 用作封面标题；多个 H1 时以 `--title` 指定封面标题。版本默认 V1.0，可用 `--version` 调整。
4. 自定义样式追加 `--style-config "/路径/样式.json"`；参考 Word 底稿追加 `--reference-doc "/路径/参考.docx"`。显式配置优先，不声称完整复刻参考 Word。保护源文件、参考文件和配置；已有输出默认拒绝覆盖，确认替换生成物才用 `--force`。
5. 核对检查报告的文字覆盖、表格数量/顺序、内部链接及 `effective_style`。内容检查针对专题规则处理后的 AST；不能把图片占位或编号变化描述为逐字等价。
6. 在 Word 更新全部字段和整个目录，保存后用可用渲染器逐页检查。环境提供 documents skill 时按其流程执行；检查封面位置、字体、三级目录、表题编号与同页、表格横线、跨页表头、图注、分页和页脚。没有渲染环境时明确“结构检查通过，视觉和字段验收未完成”。
7. 交付 DOCX 及简短验证结果，不默认交付临时 PDF/PNG/AST。调整布局后重新生成并预览。

## 边界与维护

- Markdown/HTML 表格经 Pandoc AST 转为原生 Word 表格；不能删除 HTML 后继续。复杂 CSS、嵌套表格、Mermaid 等先明确处理方式。
- 图片按标准变成占位文字及图注，不读取或下载图片文件。若用户要求真实图片，这是对当前标准的额外要求，须单独处理并说明差异，不能声称存在另一个内置模式。
- 内部锚点采用 GitHub 风格，失效链接报错。保留外部和本地相对链接；最终输出目录改变时核验本地链接目标。
- 不通过缩小指定字号或删内容解决溢出。TOC/PAGE/NUMPAGES 字段更新、中文字体和真实分页需视觉验收。
- 标准说明在 references，完整参数在 `profiles/topic-plan.json`，配置不再继承其他报告标准。新增真正的参考标准时再扩展，目前不预置未提供的标准。

修改后运行：

```bash
python3 scripts/test_convert.py
python3 scripts/test_topic_profile.py
python3 scripts/test_profiles.py
```

检查涵盖专题默认行为、表格/链接、结构拒绝、配置覆盖、文件保护和旧模式拒绝；不替代实际文档渲染。
