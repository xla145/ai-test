#!/usr/bin/env python3
"""Markdown -> native DOCX through Pandoc and a small OOXML formatting pass.

Requires Python >= 3.10 (standard library only), Pandoc >= 3.
No content rewriting, no source mutation, no shell interpolation.
"""
import argparse
import collections
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unicodedata
import xml.etree.ElementTree as ET
import zipfile

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
NS = {'w': W}
ET.register_namespace('w', W)
# Pandoc copies section references using the standard relationship prefix.
ET.register_namespace('r', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships')
ET.register_namespace('', 'http://schemas.openxmlformats.org/package/2006/relationships')

def tag(name):
    return '{%s}%s' % (W, name)

def ensure(parent, name, **attrs):
    el = parent.find(tag(name))
    if el is None:
        el = ET.SubElement(parent, tag(name))
    for key, val in attrs.items():
        el.set(tag(key), str(val))
    return el

def run(args, **kw):
    p = subprocess.run(args, capture_output=True, **kw)
    if p.returncode:
        raise RuntimeError(p.stderr.decode('utf-8', errors='replace'))
    if p.stderr.strip():
        # Missing images and unsupported elements must not pass unnoticed.
        raise RuntimeError(p.stderr.decode('utf-8', errors='replace'))
    return p.stdout

def walk(value):
    if isinstance(value, dict):
        yield value
        for v in value.values():
            yield from walk(v)
    elif isinstance(value, list):
        for v in value:
            yield from walk(v)

def font(rpr, name, size):
    f = ensure(rpr, 'rFonts', ascii='Times New Roman', hAnsi='Times New Roman', eastAsia=name)
    for k in list(f.attrib):
        if 'Theme' in k or 'theme' in k:
            del f.attrib[k]
    ensure(rpr, 'sz', val=size)
    ensure(rpr, 'szCs', val=size)
    c = ensure(rpr, 'color', val='000000')
    for k in list(c.attrib):
        if k != tag('val'):
            del c.attrib[k]

def format_docx(data, cover):
    with zipfile.ZipFile(data) as z:
        parts = {i.filename: z.read(i.filename) for i in z.infolist()}
    doc = ET.fromstring(parts['word/document.xml'])
    styles = ET.fromstring(parts['word/styles.xml'])
    for style in styles.findall('w:style', NS):
        sid = style.get(tag('styleId'), '')
        if sid in ['Normal', 'BodyText', 'FirstParagraph', 'Title', 'Subtitle'] or sid.startswith('Heading'):
            ppr = ensure(style, 'pPr')
            rpr = ensure(style, 'rPr')
            font(rpr, '宋体', 24)
            ensure(ppr, 'spacing', after=100, line=360, lineRule='auto')
            ensure(ppr, 'widowControl')
            if sid in ['BodyText','FirstParagraph']:
                ensure(ppr, 'ind', firstLine=480)
            if sid == 'Title':
                font(rpr, '黑体', 52)
                ensure(ppr, 'jc', val='center')
                ensure(ppr, 'spacing', before=2400 if cover else 240, after=360)
                border = ppr.find(tag('pBdr'))
                if border is not None:
                    ppr.remove(border)
            elif sid.startswith('Heading'):
                level = int(sid[-1]) if sid[-1].isdigit() else 1
                font(rpr, '黑体', {1:32, 2:28, 3:24}.get(level,24))
                ensure(ppr, 'keepNext')
                ensure(ppr, 'keepLines')
                ensure(ppr, 'spacing', before=220, after=120)

    sect = doc.find('w:body/w:sectPr', NS)
    ensure(sect, 'pgSz', w=11906, h=16838)
    ensure(sect, 'pgMar', top=1440, bottom=1440, left=1474, right=1474, header=850, footer=992, gutter=0)
    body = doc.find('w:body', NS)
    if cover:
        paragraphs = body.findall('w:p', NS)
        title = next((p for p in paragraphs if p.find('w:pPr/w:pStyle', NS) is not None and p.find('w:pPr/w:pStyle', NS).get(tag('val')) == 'Title'), None)
        if title is not None:
            following = list(body)[list(body).index(title)+1]
            if following.tag == tag('p'):
                ensure(ensure(following, 'pPr'), 'pageBreakBefore')
            elif following.tag != tag('sectPr'):
                pagebreak=ET.Element(tag('p'))
                ensure(ET.SubElement(pagebreak,tag('r')),'br',type='page')
                body.insert(list(body).index(title)+1,pagebreak)
    # Existing Markdown TOC remains clickable; do not invent page numbers.
    toc_seen = False
    for p in body.findall('w:p', NS):
        text = ''.join(p.itertext())
        ps = p.find('w:pPr/w:pStyle', NS)
        if text.strip() in ('目录','Table of Contents'):
            toc_seen = True
            ensure(ensure(p, 'pPr'), 'jc', val='center')
        elif toc_seen and ps is not None and ps.get(tag('val')) == 'Heading1':
            ensure(ensure(p,'pPr'), 'pageBreakBefore')
            toc_seen = False

    for table in doc.findall('.//w:tbl', NS):
        pr = ensure(table,'tblPr')
        ensure(pr,'tblW',w=8958,type='dxa')
        ensure(pr,'tblLayout',type='fixed')
        ensure(pr,'jc',val='center')
        borders = ensure(pr,'tblBorders')
        for side in ('top','bottom','left','right','insideH','insideV'):
            ensure(borders,side,val='single',sz=4,color='D9D9D9')
        margins=ensure(pr,'tblCellMar')
        for side in ('top','bottom','left','right'):
            ensure(margins,side,w=80 if side in ('top','bottom') else 100,type='dxa')
        grid=table.find('w:tblGrid',NS)
        cols=list(grid)
        widths=[int(c.get(tag('w'),'1')) for c in cols]
        # Preserve explicit HTML proportions; improve equal-width prose tables.
        if len(cols)==3 and max(widths)-min(widths)<=1:
            lengths=[0,0,0]
            for row in table.findall('w:tr',NS)[1:]:
                for i,cell in enumerate(row.findall('w:tc',NS)[:3]):
                    lengths[i]+=len(''.join(cell.itertext()))
            widths=[22,36,42] if lengths[0] < min(lengths[1:]) else [46,22,32]
        total=sum(widths)
        widths=[round(8958*v/total) for v in widths]
        widths[-1]+=8958-sum(widths)
        for c,v in zip(cols,widths): c.set(tag('w'),str(v))
        for ri,row in enumerate(table.findall('w:tr',NS)):
            rp=ensure(row,'trPr')
            # Allow tall rows to flow over pages rather than clipping them.
            for node in list(rp):
                if node.tag in (tag('cantSplit'),tag('trHeight')): rp.remove(node)
            if ri==0: ensure(rp,'tblHeader')
            ci=0
            estimated_lines=0
            for cell in row.findall('w:tc',NS):
                cp=ensure(cell,'tcPr')
                span=cp.find('w:gridSpan',NS)
                span=int(span.get(tag('val'))) if span is not None else 1
                cell_width=sum(widths[ci:ci+span])
                ensure(cp,'tcW',w=cell_width,type='dxa')
                units=sum(1 if unicodedata.east_asian_width(ch) in ('W','F') else 0.55 for ch in ''.join(cell.itertext()))
                estimated_lines=max(estimated_lines,math.ceil(units/max(1,(cell_width-200)/210))+len(cell.findall('.//w:br',NS)))
                ci+=span
                ensure(cp,'vAlign',val='center')
                if ri==0: ensure(cp,'shd',val='clear',fill='D9D9D9')
                for p in cell.findall('.//w:p',NS):
                    pp=ensure(p,'pPr')
                    ensure(pp,'ind',firstLine=0,left=0,right=0)
                    ensure(pp,'spacing',before=0,after=40,line=280,lineRule='auto')
                    # Keep each header together with the following row only.
                    for k in ('keepNext','keepLines'):
                        x=pp.find(tag(k))
                        if x is not None: pp.remove(x)
                    if ri==0:
                        ensure(pp,'keepNext')
                    for r in p.findall('.//w:r',NS):
                        rr=ensure(r,'rPr')
                        font(rr,'宋体',21)
                        if ri==0: ensure(rr,'b')
            # Keep normal records intact. Very tall rows still flow over pages.
            if estimated_lines <= 30: ensure(rp,'cantSplit')
    parts['word/document.xml']=ET.tostring(doc,encoding='utf-8',xml_declaration=True)
    parts['word/styles.xml']=ET.tostring(styles,encoding='utf-8',xml_declaration=True)
    with zipfile.ZipFile(data,'w',zipfile.ZIP_DEFLATED) as z:
        for name,content in parts.items(): z.writestr(name,content)
    return doc

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('input',type=Path)
    p.add_argument('--output','-o',required=True,type=Path)
    p.add_argument('--profile',choices=['topic-plan'],default='topic-plan',help='专题方案使用 topic-plan')
    p.add_argument('--style-config',type=Path,help='JSON 样式覆盖配置；不改变所选 profile 的内容转换规则')
    p.add_argument('--reference-doc',type=Path,help='Pandoc 参考 DOCX，仅作为样式底稿；最终显式样式以 profile/config 为准')
    p.add_argument('--title',help='专题方案封面标题；默认取 Markdown 标题')
    p.add_argument('--version',default='V1.0',help='专题方案版本')
    p.add_argument('--list-style',choices=['paragraph','short'],default='paragraph',help='专题方案 Markdown 列表转为字面量（1）或 1.；混合样式请在源文中显式书写')
    p.add_argument('--force',action='store_true',help='Replace an existing output explicitly')
    p.add_argument('--report',type=Path,help='Write content and structure verification JSON')
    a=p.parse_args()
    source=a.input.expanduser().resolve(); output=a.output.expanduser().resolve()
    from profile_config import load as load_profile, apply as apply_profile
    cfg=load_profile(a.profile,a.style_config)
    protected={source}
    for supplied in (a.style_config,a.reference_doc):
        if supplied:
            if not supplied.is_file():p.error('Reference/config does not exist: '+str(supplied))
            protected.add(supplied.resolve())
    if output in protected:p.error('Output must not overwrite source/reference/config')
    if source==output or output.suffix.lower()!='.docx': p.error('Output must be a distinct .docx file')
    if output.exists() and not a.force: p.error('Output exists; choose another path or use --force')
    if a.report and a.report.resolve() in protected | {output}: p.error('Report must not overwrite input/output')
    pandoc=shutil.which('pandoc')
    if not pandoc: p.error('Pandoc >= 3 is required; install it before converting')
    lua=Path(__file__).with_name('normalize.lua')
    with tempfile.TemporaryDirectory(prefix='md-to-word-') as tmp:
        tmp=Path(tmp)
        ast_bytes=run([pandoc,str(source),'--from=markdown+gfm_auto_identifiers+raw_html-markdown_in_html_blocks-native_divs-native_spans-smart','--to=json','--lua-filter',str(lua)])
        ast=json.loads(ast_bytes)
        if a.title:
            ast['meta']['title']={'t':'MetaInlines','c':[{'t':'Str','c':a.title}]}
        placeholders=0
        if a.profile=='topic-plan':
            from topic_profile import prepare
            ast,placeholders=prepare(ast,a.title,a.list_style)
            ast_bytes=json.dumps(ast,ensure_ascii=False).encode('utf-8')
        ast_bytes=json.dumps(ast,ensure_ascii=False).encode('utf-8')
        nodes=list(walk(ast))
        if any(n.get('t') in ('RawBlock','RawInline') for n in nodes):
            raise RuntimeError('Unconverted raw markup remains')
        tables=[n for n in nodes if n.get('t')=='Table']
        images=[n['c'][2][0] for n in nodes if n.get('t')=='Image']
        if any(re.match(r'https?://',v) for v in images):
            raise RuntimeError('Download remote images to local files and update a working copy before conversion')
        draft=tmp/'draft.docx'
        run([pandoc,'--from=json','--to=docx','--standalone','--resource-path',str(source.parent),'--output',str(draft)]+(['--reference-doc',str(a.reference_doc.resolve())] if a.reference_doc else []), input=ast_bytes, cwd=source.parent)
        doc=format_docx(draft,False)
        if a.profile=='topic-plan':
            from topic_profile import apply
            doc=apply(draft,a.version,cfg['cover'])
        doc=apply_profile(draft,cfg,a.profile)
        actual=doc.findall('.//w:tbl',NS)
        if len(actual)!=len(tables): raise RuntimeError('Table count changed during conversion')
        def text_nodes(node):
            return ' '.join(n['c'] if n.get('t')=='Str' else n['c'][1]
                            for n in walk(node) if n.get('t') in ('Str','Code','CodeBlock'))
        def compact(s): return re.sub(r'\s+','',s)
        for index,(before,after) in enumerate(zip(tables,actual),1):
            if compact(text_nodes(before)) != compact(''.join(after.itertext())):
                raise RuntimeError(f'Table {index}: text or cell order changed; inspect unsupported content')
        expected=' '.join(n['c'] if n.get('t')=='Str' else n['c'][1]
                          for n in nodes if n.get('t') in ('Str','Code','CodeBlock'))
        # Compare source text nodes, excluding automatic list numbering. This
        # is a coverage check, not a proof of order or exact punctuation.
        content='\n'.join(''.join(p.itertext()) for p in doc.findall('.//w:p',NS))
        with zipfile.ZipFile(draft) as z:
            for name in ('word/footnotes.xml','word/endnotes.xml'):
                if name in z.namelist():
                    root=ET.fromstring(z.read(name))
                    content+='\n'+'\n'.join(''.join(p.itertext()) for p in root.findall('.//w:p',NS))
        for el in doc.iter():
            if el.tag.endswith('}docPr'):
                content+=' '+el.get('descr','')+' '+el.get('title','')
        def tokens(s): return collections.Counter(re.findall(r'[\u3400-\u9fff]|[A-Za-z0-9_]+',s))
        missing=tokens(expected)-tokens(content)
        if missing: raise RuntimeError('Content coverage failed: '+str(dict(missing)))
        names={b.get(tag('name')) for b in doc.findall('.//w:bookmarkStart',NS)}
        dangling=[h.get(tag('anchor')) for h in doc.findall('.//w:hyperlink',NS) if h.get(tag('anchor')) and h.get(tag('anchor')) not in names]
        if dangling: raise RuntimeError('Broken internal anchors: '+str(dangling))
        report={'source':str(source),'output':str(output),'tables':len(actual),'table_rows':[len(t.findall('w:tr',NS)) for t in actual],'table_text_order':'passed','images':len(images),'content_coverage':'passed','internal_links':'passed','visual_review':'pending','profile':'A4 Chinese report; reference-inspired, not exact template cloning'}
        report.update(profile=a.profile,style_config=str(a.style_config.resolve()) if a.style_config else None,reference_doc=str(a.reference_doc.resolve()) if a.reference_doc else None,effective_style=cfg)
        if a.profile=='topic-plan':
            report.update(profile='topic-plan',image_placeholders=placeholders,fields_review='pending: update TOC/PAGE/NUMPAGES in Word and verify pagination',content_coverage='passed against normalized AST; title numbering/list labels/image placeholders are intentional transformations')
        output.parent.mkdir(parents=True,exist_ok=True)
        # Publish only a checked package; avoid partial outputs.
        fd,staged=tempfile.mkstemp(dir=output.parent,suffix='.docx')
        os.close(fd)
        try:
            shutil.copyfile(draft,staged)
            os.replace(staged,output)
        finally:
            if os.path.exists(staged): os.unlink(staged)
        if a.report:
            a.report.parent.mkdir(parents=True,exist_ok=True)
            a.report.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps(report,ensure_ascii=False,indent=2))

if __name__=='__main__':
    main()
