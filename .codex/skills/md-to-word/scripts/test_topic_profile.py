"""Executable profile regression checks; requires Pandoc, standard library only."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
import zipfile
from convert import NS,tag

SCRIPT=Path(__file__).with_name('convert.py')
class TopicTests(unittest.TestCase):
    def invoke(self,root,content,*flags):
        src=root/'in.md';src.write_text(content,encoding='utf-8')
        out=root/'out.docx'
        result=subprocess.run([sys.executable,str(SCRIPT),str(src),'--output',str(out),'--profile','topic-plan',*flags],capture_output=True,text=True)
        self.assertEqual(src.read_text(),content)
        return result,out
    def test_profile(self):
        with tempfile.TemporaryDirectory() as folder:
            r,out=self.invoke(Path(folder),'# 测试专题方案\n\n## 总体方案\n\n### 建设目标\n\n#### 实施范围\n\n正文内容。\n\n一、单行小标题\n\n- 第一项\n- 第二项\n\n| 项目 | 内容 |\n| --- | --- |\n| A | B |\n\n![系统架构](missing.png)\n')
            self.assertEqual(r.returncode,0,r.stderr)
            report=json.loads(r.stdout);self.assertEqual(report['image_placeholders'],1)
            with zipfile.ZipFile(out) as z:
                d=ET.fromstring(z.read('word/document.xml'));s=ET.fromstring(z.read('word/styles.xml'));f=ET.fromstring(z.read('word/footer-topic.xml'))
                texts=[''.join(p.itertext()) for p in d.findall('.//w:p',NS)]
                for value in ['1 总体方案','1.1 建设目标','1.1.1 实施范围','（1）第一项','此处需替换为系统架构图片','图1 系统架构','版本：V1.0']:self.assertIn(value,texts)
                self.assertFalse(d.findall('.//w:numPr',NS))
                self.assertFalse(d.findall('.//w:headerReference',NS))
                self.assertIn(' TOC \\o "1-3" \\h \\z ',[n.text for n in d.findall('.//w:instrText',NS)])
                self.assertEqual([n.text.strip() for n in f.findall('.//w:instrText',NS)],['PAGE','NUMPAGES'])
                borders=d.find('.//w:tblBorders',NS)
                self.assertEqual(borders.find('w:top',NS).get(tag('sz')),'12')
                self.assertEqual(borders.find('w:insideH',NS).get(tag('sz')),'4')
                self.assertEqual(borders.find('w:insideV',NS).get(tag('val')),'nil')
                for p in d.findall('.//w:tc/w:p',NS):
                    self.assertEqual(p.find('w:pPr/w:spacing',NS).get(tag('line')),'312')
                    self.assertEqual(p.find('w:pPr/w:jc',NS).get(tag('val')),'center')
                self.assertEqual(s.find("w:style[@w:styleId='TOC3']/w:pPr/w:ind",NS).get(tag('left')),'960')
                captions=[p for p in d.findall('.//w:p',NS) if ''.join(p.itertext())=='图1 系统架构']
                self.assertEqual(captions[0].find('w:r/w:rPr/w:sz',NS).get(tag('val')),'21')
    def test_table_captions(self):
        table='| 字段 | 说明 |\n| --- | --- |\n| id | 标识 |\n'
        content='# 方案\n\n## 字段定义\n\n表：字段说明\n\n'+table+'\n'+table+'\n: 原生题注\n\n## 接口定义\n\n表2.1 新章表格\n\n'+table
        with tempfile.TemporaryDirectory() as folder:
            result,out=self.invoke(Path(folder),content)
            self.assertEqual(result.returncode,0,result.stderr)
            with zipfile.ZipFile(out) as z:
                d=ET.fromstring(z.read('word/document.xml'))
            body=list(d.find('w:body',NS))
            names=[]
            for i,node in enumerate(body):
                if node.tag!=tag('tbl'):continue
                cap=body[i-1];names.append(''.join(cap.itertext()))
                self.assertEqual(cap.find('w:pPr/w:keepNext',NS).get(tag('val')),'1')
                self.assertEqual(cap.find('w:pPr/w:jc',NS).get(tag('val')),'center')
                self.assertEqual(cap.find('w:r/w:rPr/w:sz',NS).get(tag('val')),'21')
                self.assertIsNotNone(node.find('w:tr/w:trPr/w:tblHeader',NS))
            self.assertEqual(names,['表1.1 字段说明','表1.2 原生题注','表2.1 新章表格'])
        with tempfile.TemporaryDirectory() as folder:
            result,out=self.invoke(Path(folder),'# 方案\n\n## 章\n\n表5.5 错号\n\n'+table)
            self.assertNotEqual(result.returncode,0)
            self.assertFalse(out.exists())

    def test_structure_rejected(self):
        for content in ['# 标题\n\n## 一级\n\n过渡文字\n\n### 二级\n', '# 标题\n\n## 一级\n\n#### 跳级\n', '# 标题\n\n## 9 错误编号\n']:
            with self.subTest(content=content),tempfile.TemporaryDirectory() as folder:
                result,out=self.invoke(Path(folder),content)
                self.assertNotEqual(result.returncode,0)
                self.assertFalse(out.exists())
    def test_short_list(self):
        with tempfile.TemporaryDirectory() as folder:
            r,out=self.invoke(Path(folder),'# 标题\n\n## 内容\n\n1. 短句\n','--list-style','short')
            self.assertEqual(r.returncode,0,r.stderr)
            with zipfile.ZipFile(out) as z:
                d=ET.fromstring(z.read('word/document.xml'))
                self.assertIn('1. 短句',[''.join(p.itertext()) for p in d.findall('.//w:p',NS)])

if __name__=='__main__':unittest.main()
