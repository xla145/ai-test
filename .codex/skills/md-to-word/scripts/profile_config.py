"""Validated data-only profile overrides and a common final OOXML style pass."""
import copy
import json
import math
from pathlib import Path
import re
import xml.etree.ElementTree as ET
import zipfile
from convert import NS,tag,ensure,font

ROOT=Path(__file__).resolve().parent.parent/'profiles'

def merge(base,patch,path=''):
    if not isinstance(patch,dict):raise ValueError('配置必须是JSON对象: '+path)
    result=copy.deepcopy(base)
    for key,value in patch.items():
        if key=='bold' and 'font' in base and 'size_pt' in base:
            result[key]=value;continue
        if key not in base:raise ValueError('未知配置项: '+path+key)
        if isinstance(base[key],dict):result[key]=merge(base[key],value,path+key+'.')
        else:result[key]=value
    return result

def validate(cfg):
    if type(cfg['schema_version']) is not int or cfg['schema_version']!=1:raise ValueError('仅支持 schema_version=1')
    def number(v,lo,hi,label):
        if isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) or not lo<=v<=hi:raise ValueError('无效数值: '+label)
    def paragraph(p,label):
        allowed={'font','size_pt','align','before_pt','after_pt','line','line_rule','indent_chars','bold'}
        if not isinstance(p,dict) or set(p)-allowed or allowed-{'bold'}-set(p):raise ValueError('段落配置缺失或含未知字段: '+label)
        if not isinstance(p['font'],str) or not p['font'].strip():raise ValueError('字体不能为空')
        if p['align'] not in ('left','right','center','both') or p['line_rule'] not in ('multiple','exact'):raise ValueError('无效对齐/行距模式: '+label)
        for k,lo,hi in [('size_pt',1,100),('before_pt',0,1000),('after_pt',0,1000),('line',0.1,200),('indent_chars',0,20)]:number(p[k],lo,hi,label+'.'+k)
        if 'bold' in p and not isinstance(p['bold'],bool):raise ValueError('bold 必须为布尔值')
    for key in ('base','body','title','toc','toc_title','caption','small_heading','footer'):paragraph(cfg[key],key)
    if not isinstance(cfg['headings'],list) or not 3<=len(cfg['headings'])<=6:raise ValueError('headings 需要3至6项完整段落配置')
    for h in cfg['headings']:paragraph(h,'headings')
    paragraph(cfg['table']['paragraph'],'table.paragraph')
    for k,v in cfg['page'].items():number(v,0 if 'width' not in k and 'height' not in k else 1,40000,k)
    pg=cfg['page']
    if pg['left_twips']+pg['right_twips']>=pg['width_twips'] or pg['top_twips']+pg['bottom_twips']>=pg['height_twips']:raise ValueError('页边距超过纸张大小')
    for c in (cfg['color'],cfg['table']['header_fill'],cfg['table']['border_color']):
        if not isinstance(c,str) or not re.fullmatch('[0-9A-Fa-f]{6}',c):raise ValueError('颜色须为六位十六进制，不带#')
    if not isinstance(cfg['western_font'],str) or not cfg['western_font'].strip():raise ValueError('西文字体不能为空')
    if not isinstance(cfg['table']['vertical'],bool):raise ValueError('vertical 必须为布尔值')
    for k in ('outer_pt','inner_pt'):number(cfg['table'][k],0.125,12,k)
    number(cfg['table']['top_margin_cm'],0,5,'top_margin_cm')
    number(cfg['toc_indent_chars'],0,10,'toc_indent_chars')
    for k,v in cfg['cover'].items():number(v,1,100,k)
    if any(not isinstance(cfg['cover'][k],int) for k in ('title_row','version_row')):raise ValueError('封面行号须为整数')
    gap=(cfg['cover']['version_row']-cfg['cover']['title_row'])*cfg['cover']['grid_pt']
    title_height=cfg['title']['size_pt']*cfg['title']['line'] if cfg['title']['line_rule']=='multiple' else cfg['title']['line']
    if gap<title_height:raise ValueError('封面标题和版本位置重叠')
    return cfg

def load(profile,override=None):
    if profile!='topic-plan':raise ValueError('当前仅支持专题方案标准 topic-plan')
    cfg=json.loads((ROOT/'topic-plan.json').read_text())
    if override:cfg=merge(cfg,json.loads(Path(override).read_text()))
    return validate(cfg)

def apply(path,cfg,profile):
    with zipfile.ZipFile(path) as z:parts={n:z.read(n) for n in z.namelist()}
    doc=ET.fromstring(parts['word/document.xml']);styles=ET.fromstring(parts['word/styles.xml'])
    def runstyle(rp,c):
        font(rp,c['font'],round(c['size_pt']*2))
        ensure(rp,'rFonts',ascii=cfg['western_font'],hAnsi=cfg['western_font'],cs=cfg['western_font'])
        ensure(rp,'color',val=cfg['color'])
        if 'bold' in c:ensure(rp,'b',val=int(c['bold']))
    def pstyle(pp,c):
        ensure(pp,'spacing',before=round(c['before_pt']*20),after=round(c['after_pt']*20),line=round(c['line']*(240 if c['line_rule']=='multiple' else 20)),lineRule='auto' if c['line_rule']=='multiple' else 'exact')
        ind=ensure(pp,'ind')
        for key in list(ind.attrib):del ind.attrib[key]
        ensure(pp,'ind',left=0,right=0,firstLine=0,firstLineChars=round(c['indent_chars']*100))
        ensure(pp,'jc',val=c['align'])
        runstyle(ensure(pp,'rPr'),c)
    def paragraph(p,c):
        pstyle(ensure(p,'pPr'),c)
        for r in p.findall('.//w:r',NS):runstyle(ensure(r,'rPr'),c)
    def heading(level):return cfg['headings'][min(level-1,len(cfg['headings'])-1)]
    def style_config(sid):
        if sid in ('Normal','BodyText','FirstParagraph'):return cfg['body']
        if sid=='Title':return cfg['title']
        if re.fullmatch(r'Heading[1-6]',sid):return heading(int(sid[-1]))
        if re.fullmatch(r'TOC[1-3]',sid):return cfg['toc']
        if sid in ('Caption','ImageCaption'):return cfg['caption']
        if sid=='Footer':return cfg['footer']
    for st in styles.findall('w:style',NS):
        sid=st.get(tag('styleId'),'');c=style_config(sid)
        if c:
            pstyle(ensure(st,'pPr'),c);runstyle(ensure(st,'rPr'),c)
            if sid.startswith('TOC'):
                pp=ensure(st,'pPr');ensure(pp,'ind',firstLineChars=0,left=round(cfg['toc']['size_pt']*20*cfg['toc_indent_chars']*(int(sid[-1])-1)))
                tabs=ensure(pp,'tabs');tabs.clear();ensure(tabs,'tab',val='right',leader='dot',pos=cfg['page']['width_twips']-cfg['page']['left_twips']-cfg['page']['right_twips'])
    if profile=='topic-plan':
        # The base size applies to unspecified content; body is explicitly 12pt.
        st=next(s for s in styles.findall('w:style',NS) if s.get(tag('styleId'))=='Normal')
        runstyle(ensure(st,'rPr'),cfg['base'])
        defaults=ensure(styles,'docDefaults')
        runstyle(ensure(ensure(defaults,'rPrDefault'),'rPr'),cfg['base'])
        pstyle(ensure(ensure(defaults,'pPrDefault'),'pPr'),cfg['base'])
    for p in doc.findall('w:body/w:p',NS):
        ps=p.find('w:pPr/w:pStyle',NS);sid=ps.get(tag('val'),'') if ps is not None else ''
        text=''.join(t.text or '' for t in p.findall('.//w:t',NS))
        c=style_config(sid)
        if profile=='topic-plan':
            # Empty cover spacers are controlled by the cover grid, not body style.
            if not text and not p.findall('.//w:instrText',NS):continue
            c=c or cfg['body']
            if text.startswith('版本：'):c=dict(cfg['title'],size_pt=cfg['cover']['version_size_pt'])
            if re.match(r'^[一二三四五六七八九十百]+、',text):c=cfg['small_heading']
            if re.match(r'^(?:图\d+|表\d+\.\d+)\s',text):c=cfg['caption']
            if text.startswith('此处需替换为'):c=dict(cfg['body'],align='center',indent_chars=0)
        if text=='目录':c=cfg['toc_title']
        if c:paragraph(p,c)
    if profile=='topic-plan':
        title=next(p for p in doc.findall('w:body/w:p',NS) if p.find('w:pPr/w:pStyle',NS) is not None and p.find('w:pPr/w:pStyle',NS).get(tag('val'))=='Title')
        c=cfg['cover'];line=cfg['title']['size_pt']*cfg['title']['line'] if cfg['title']['line_rule']=='multiple' else cfg['title']['line']
        ensure(ensure(title,'pPr'),'spacing',before=0,after=round(((c['version_row']-c['title_row'])*c['grid_pt']-line)*20))
    for table in doc.findall('.//w:tbl',NS):
        tc=cfg['table'];pr=ensure(table,'tblPr');b=ensure(pr,'tblBorders')
        width=cfg['page']['width_twips']-cfg['page']['left_twips']-cfg['page']['right_twips']
        ensure(pr,'tblW',w=width,type='dxa')
        grid=table.find('w:tblGrid',NS)
        widths=[]
        if grid is not None and len(grid):
            old=[int(col.get(tag('w'),'1')) for col in grid];total=sum(old)
            widths=[round(width*v/total) for v in old];widths[-1]+=width-sum(widths)
            for col,w in zip(grid,widths):col.set(tag('w'),str(w))
        for side in ('top','bottom','insideH','left','right','insideV','start','end'):
            vertical=side in ('left','right','insideV','start','end')
            ensure(b,side,val='single' if not vertical or tc['vertical'] else 'nil',sz=round((tc['inner_pt'] if side in ('insideH','insideV') else tc['outer_pt'])*8),color=tc['border_color'])
        ensure(ensure(pr,'tblCellMar'),'top',w=round(tc['top_margin_cm']*1440/2.54),type='dxa')
        for ri,row in enumerate(table.findall('w:tr',NS)):
            ci=0
            for cell in row.findall('w:tc',NS):
                cp=ensure(cell,'tcPr');ensure(cp,'vAlign',val='center')
                sp=cp.find(tag('gridSpan'));span=int(sp.get(tag('val'))) if sp is not None else 1
                if widths:ensure(cp,'tcW',w=sum(widths[ci:ci+span]),type='dxa')
                ci+=span
                borders=cp.find(tag('tcBorders'))
                if borders is not None:cp.remove(borders)
                ensure(ensure(cp,'tcMar'),'top',w=round(tc['top_margin_cm']*1440/2.54),type='dxa')
                if ri==0:ensure(cp,'shd',val='clear',fill=tc['header_fill'])
                for p in cell.findall('.//w:p',NS):paragraph(p,dict(tc['paragraph'],bold=True) if ri==0 else tc['paragraph'])
    for sec in doc.findall('.//w:sectPr',NS):
        pg=cfg['page'];ensure(sec,'pgSz',w=pg['width_twips'],h=pg['height_twips']);ensure(sec,'pgMar',**{k:pg[k+'_twips'] for k in ('top','bottom','left','right')})
    for name in list(parts):
        if re.fullmatch(r'word/footer[^/]*\.xml',name):
            footer=ET.fromstring(parts[name])
            for p in footer.findall('.//w:p',NS):paragraph(p,cfg['footer'])
            parts[name]=ET.tostring(footer,encoding='utf-8',xml_declaration=True)
    parts['word/document.xml']=ET.tostring(doc,encoding='utf-8',xml_declaration=True)
    parts['word/styles.xml']=ET.tostring(styles,encoding='utf-8',xml_declaration=True)
    with zipfile.ZipFile(path,'w',zipfile.ZIP_DEFLATED) as z:
        for n,data in parts.items():z.writestr(n,data)
    return doc
