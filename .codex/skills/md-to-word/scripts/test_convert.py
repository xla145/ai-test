"""Small integration regression: run with the same Python as convert.py."""
from pathlib import Path
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
import zipfile

SCRIPT=Path(__file__).with_name('convert.py')
NS={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}

with tempfile.TemporaryDirectory(prefix='md-to-word-test-') as tmp:
    root=Path(tmp)
    source=root/'样例.md'
    output=root/'result.docx'
    source.write_text('''# 转换测试

## 内容

[跳转](#内容) **加粗**、`code`，90.9%。

1. 第一项
2. 第二项
   - 子项

```python
print("你好")
```

| 字段 | 值 |
| --- | --- |
| A | 第一行<br>第二行 |

<table><thead><tr><th>字段</th><th>值</th></tr></thead><tbody><tr><td><strong>B</strong></td><td>A &amp; B<br>换行</td></tr></tbody></table>
''',encoding='utf-8')
    original=source.read_bytes()
    result=subprocess.run([sys.executable,str(SCRIPT),str(source),'-o',str(output)],capture_output=True,text=True)
    assert result.returncode==0,result.stderr
    assert source.read_bytes()==original
    with zipfile.ZipFile(output) as z:
        doc=ET.fromstring(z.read('word/document.xml'))
        tables=doc.findall('.//w:tbl',NS)
        assert len(tables)==2
        assert [len(t.findall('w:tr',NS)) for t in tables]==[2,2]
        assert len(doc.findall('.//w:tblHeader',NS))==2
        assert len(doc.findall('.//w:br',NS))>=2
        assert 'A & B' in ''.join(doc.itertext())
        assert doc.findall('.//w:hyperlink',NS)
    existing=output.read_bytes()
    result=subprocess.run([sys.executable,str(SCRIPT),str(source),'-o',str(output)],capture_output=True)
    assert result.returncode!=0 and output.read_bytes()==existing
    for name,body in [('inline-image','正文 ![图](missing.png)'),('bad-anchor','[坏链接](#missing)'),('unsupported-html','<script>alert(1)</script>')]:
        bad=root/(name+'.md'); bad.write_text('# 测试\n\n## 内容\n\n'+body,encoding='utf-8')
        target=root/(name+'.docx')
        result=subprocess.run([sys.executable,str(SCRIPT),str(bad),'-o',str(target)],capture_output=True)
        assert result.returncode!=0 and not target.exists(),name
    print('PASS: editable tables, line breaks, internal links, source preservation, overwrite guard, and failure cases')
