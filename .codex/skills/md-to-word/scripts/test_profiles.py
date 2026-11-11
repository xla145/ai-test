"""Integration checks for profile routing, overrides and reference protection."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
import zipfile
from convert import NS,tag
from profile_config import load
SCRIPT=Path(__file__).with_name('convert.py')
class Profiles(unittest.TestCase):
    def test_config_rejections(self):
        for patch in ({'body':{'size_pt':0}},{'unknown':1},{'table':{'vertical':'false'}},{'page':{'left_twips':20000}},{'cover':{'title_row':20,'version_row':15}}):
            with self.subTest(patch=patch),tempfile.TemporaryDirectory() as d:
                f=Path(d)/'bad.json';f.write_text(json.dumps(patch))
                with self.assertRaises(ValueError):load('topic-plan',f)
    def test_routing_and_override(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);source=root/'in.md';source.write_text('# 报告\n\n## 方案内容\n\n内容与 **加粗**。\n\n| 项目 | 内容 |\n| --- | --- |\n| A | B |\n')
            config=root/'style.json';config.write_text(json.dumps({'body':{'size_pt':13,'line':1.7,'line_rule':'multiple'},'table':{'header_fill':'EEEEEE','vertical':False},'page':{'left_twips':1700}}))
            for profile in ('topic-plan',):
                out=root/(profile+'.docx')
                r=subprocess.run([sys.executable,str(SCRIPT),str(source),'-o',str(out),'--style-config',str(config)],capture_output=True,text=True)
                self.assertEqual(r.returncode,0,r.stderr)
                report=json.loads(r.stdout);self.assertEqual(report['profile'],profile)
                with zipfile.ZipFile(out) as z:
                    doc=ET.fromstring(z.read('word/document.xml'))
                    para=next(p for p in doc.findall('.//w:p',NS) if '内容与' in ''.join(p.itertext()))
                    self.assertEqual(para.find('w:pPr/w:spacing',NS).get(tag('line')),'408')
                    self.assertTrue(all(s.get(tag('val'))=='26' for s in para.findall('.//w:rPr/w:sz',NS)))
                    self.assertTrue(para.findall('.//w:b',NS))
                    self.assertEqual(doc.find('.//w:shd',NS).get(tag('fill')),'EEEEEE')
                    self.assertEqual(doc.find('.//w:insideV',NS).get(tag('val')),'nil')
                    instructions=[n.text or '' for n in doc.findall('.//w:instrText',NS)]
                    self.assertEqual(any('TOC ' in x for x in instructions),True)
            reference=root/'topic-plan.docx';saved=reference.read_bytes()
            r=subprocess.run([sys.executable,str(SCRIPT),str(source),'-o',str(root/'ref-result.docx'),'--reference-doc',str(reference)],capture_output=True,text=True)
            self.assertEqual(r.returncode,0,r.stderr);self.assertEqual(reference.read_bytes(),saved)
            r=subprocess.run([sys.executable,str(SCRIPT),str(source),'-o',str(reference),'--reference-doc',str(reference),'--force'],capture_output=True,text=True)
            self.assertNotEqual(r.returncode,0);self.assertEqual(reference.read_bytes(),saved)
    def test_removed_modes_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);source=root/'in.md';source.write_text('# 标题\n\n## 内容\n\n正文。\n')
            for mode in ('default','formal-report'):
                out=root/(mode+'.docx')
                r=subprocess.run([sys.executable,str(SCRIPT),str(source),'-o',str(out),'--profile',mode],capture_output=True,text=True)
                self.assertNotEqual(r.returncode,0);self.assertFalse(out.exists())
    def test_toc_content(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);source=root/'in.md';source.write_text('# 标题\n\n## 目录\n\n- [正文](#正文)\n\n## 正文\n\n保留段落。\n')
            r=subprocess.run([sys.executable,str(SCRIPT),str(source),'-o',str(root/'out.docx'),'--profile','topic-plan'],capture_output=True,text=True)
            self.assertEqual(r.returncode,0,r.stderr)
            with zipfile.ZipFile(root/'out.docx') as z:
                doc=ET.fromstring(z.read('word/document.xml'))
                self.assertIn('保留段落。',''.join(doc.itertext()))
                self.assertEqual(sum(''.join(p.itertext())=='目录' for p in doc.findall('.//w:p',NS)),1)

if __name__=='__main__':unittest.main()
