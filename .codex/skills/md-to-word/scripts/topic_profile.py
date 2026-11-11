"""专题方案 profile: Pandoc AST normalization + standard-library OOXML styling."""
import copy
import re
import xml.etree.ElementTree as ET
import zipfile
from convert import NS, tag, ensure, font, walk

R='http://schemas.openxmlformats.org/officeDocument/2006/relationships'
REL='http://schemas.openxmlformats.org/package/2006/relationships'
CT='http://schemas.openxmlformats.org/package/2006/content-types'

def inline_text(inlines):
    return ''.join(n['c'] if n.get('t')=='Str' else ' ' if n.get('t') in ('Space','SoftBreak') else '' for n in walk(inlines))

def text_inlines(s):
    return [{'t':'Str','c':s}]

def prepare(ast, title=None, list_style='paragraph'):
    ast=copy.deepcopy(ast)
    if title:
        ast['meta']['title']={'t':'MetaInlines','c':text_inlines(title)}
    if not ast.get('meta',{}).get('title'):
        raise ValueError('专题方案需要封面标题：使用唯一开头 H1 或 --title；多个 H1 时用 --title 指定封面标题。')
    blocks=ast['blocks']
    # Remove only an identifiable heading followed by pure internal-link lists.
    for i,b in enumerate(blocks):
        if b.get('t')=='Header' and inline_text(b['c'][2]).strip() in ('目录','Table of Contents'):
            end=i+1
            while end<len(blocks) and blocks[end].get('t')!='Header':
                node=blocks[end]
                links=[n for n in walk(node) if n.get('t')=='Link']
                if node.get('t') not in ('BulletList','OrderedList') or not links or any(not n['c'][2][0].startswith('#') for n in links):
                    raise ValueError('现有目录含非纯内部链接列表，请在工作副本中明确目录范围后重试。')
                labels=[n for link in links for n in walk(link['c'][1]) if n.get('t')=='Str']
                if len(labels)!=sum(n.get('t')=='Str' for n in walk(node)):
                    raise ValueError('目录中含额外文字，不能自动删除。')
                end+=1
            blocks=blocks[:i]+blocks[end:]
            break
    headers=[(i,b['c'][0]) for i,b in enumerate(blocks) if b.get('t')=='Header']
    if not headers or headers[0][1]!=1:
        raise ValueError('专题方案正文需从一级标题开始。')
    if any(b.get('t') not in ('Null',) for b in blocks[:headers[0][0]]):
        raise ValueError('正文一级标题前有内容；请明确归属，不自动丢弃或移动。')
    for (i,level),(j,nextlevel) in zip(headers,headers[1:]):
        if nextlevel>level and j!=i+1:
            raise ValueError('父标题与首个下级标题之间有内容：'+inline_text(blocks[i]['c'][2]))
    counts=[0,0,0]
    for _,b in [(i,b) for i,b in enumerate(blocks) if b.get('t')=='Header']:
        level=b['c'][0]
        if level>3:
            raise ValueError('专题方案只使用三级结构标题；更低层请改为普通段落式单行小标题。')
        if level>1 and not counts[level-2]:
            raise ValueError('标题层级跳级，请补齐父标题。')
        counts[level-1]+=1
        counts[level:]=[0]*(3-level)
        number='.'.join(map(str,counts[:level]))
        label=inline_text(b['c'][2]).strip()
        match=re.match(r'^(\d+(?:\.\d+)*)(?:[.、．])?\s+',label)
        if match:
            if match.group(1)!=number:
                raise ValueError(f'已有标题编号 {match.group(1)} 与结构编号 {number} 不一致，请先核对正文引用。')
        elif re.match(r'^(第[一二三四五六七八九十百\d]+[章节]|[一二三四五六七八九十]+、)',label):
            raise ValueError('已有中文章节编号需在工作副本中确认转换并同步正文引用：'+label)
        else:
            b['c'][2]=text_inlines(number+' ')+b['c'][2]
    image_index=0
    chapter=0
    table_index=0
    section_name=''

    def transform(seq):
        nonlocal image_index, chapter, table_index, section_name
        out=[]
        for b in seq:
            kind=b.get('t')
            if kind=='Header':
                label=inline_text(b['c'][2]).strip()
                section_name=re.sub(r'^\d+(?:\.\d+)*\s+', '', label)
                if b['c'][0]==1:
                    chapter=int(label.split()[0]);table_index=0
                out.append(b)
            elif kind in ('BulletList','OrderedList'):
                items=b['c'] if kind=='BulletList' else b['c'][1]
                start=1 if kind=='BulletList' else b['c'][0][0]
                for index,item in enumerate(items,start):
                    if not item or item[0].get('t') not in ('Para','Plain'):
                        raise ValueError('复杂列表需要先明确段落与编号关系。')
                    prefix=f'（{index}）' if list_style=='paragraph' else f'{index}. '
                    head=copy.deepcopy(item[0]);head['t']='Para';head['c']=text_inlines(prefix)+head['c']
                    out.extend(transform([head]+item[1:]))
            elif kind in ('Para','Plain') and any(n.get('t')=='Image' for n in walk(b)):
                if len(b['c'])!=1 or b['c'][0].get('t')!='Image':
                    raise ValueError('图片须独占段落；请先把行内图片拆成独立段落。')
                name=inline_text(b['c'][0]['c'][1]).strip()
                if not name:raise ValueError('图片需要非空替代文字，供占位和图注使用。')
                image_index+=1
                out.extend([{'t':'Para','c':text_inlines('此处需替换为'+name+'图片')}, {'t':'Para','c':text_inlines(f'图{image_index} {name}')}])
            elif kind=='Figure':
                out.extend(transform(b['c'][2]))
            elif kind=='Table':
                if any(n.get('t')=='Image' for n in walk(b)):
                    raise ValueError('专题方案图片须独立放在表格外。')
                table_index+=1
                number=f'{chapter}.{table_index}'
                # Native Pandoc captions or an explicit preceding caption paragraph.
                caption=b['c'][1]
                name=inline_text(caption[1]).strip()
                previous=out[-1] if out else None
                explicit=inline_text(previous['c']).strip() if previous and previous.get('t') in ('Para','Plain') else ''
                if re.match(r'^表(?:\d+\.\d+\s+|[：:])', explicit):
                    if name:raise ValueError('表格同时存在原生题注和前置表题，请保留一个。')
                    name=explicit;out.pop()
                match=re.match(r'^表(\d+\.\d+)\s+(.+)$',name)
                if match:
                    if match.group(1)!=number:raise ValueError(f'表题编号 {match.group(1)} 与结构编号 {number} 不一致，请核对正文引用。')
                    name=match.group(2)
                else:name=re.sub(r'^表[：:]\s*','',name)
                name=name or section_name+'说明'
                b['c'][1]=[None,[]]
                out.append({'t':'Para','c':text_inlines(f'表{number} {name}')})
                out.append(b)
            elif kind in ('BlockQuote','Div'):
                raise ValueError('专题方案暂不自动排版引用块/Div，请先在工作副本明确其正文层级。')
            else:out.append(b)
        return out
    ast['blocks']=transform(blocks)
    return ast, image_index

def ptext(p):return ''.join(t.text or '' for t in p.findall('.//w:t',NS))

def style_paragraph(p, size=24, east='宋体', align='both', indent=200, line=360, bold=None):
    pp=ensure(p,'pPr')
    # Remove prior indentation, list numbering and explicit page breaks.
    for key in ('ind','numPr','spacing','tabs'):
        node=pp.find(tag(key))
        if node is not None:pp.remove(node)
    ensure(pp,'spacing',before=0,after=0,line=line,lineRule='auto')
    ensure(pp,'ind',left=0,right=0,firstLine=0,firstLineChars=indent)
    ensure(pp,'jc',val=align)
    ensure(pp,'keepNext',val=0);ensure(pp,'keepLines',val=0)
    ensure(pp,'pageBreakBefore',val=0)
    font(ensure(pp,'rPr'),east,size)
    for r in p.findall('.//w:r',NS):
        rp=ensure(r,'rPr');font(rp,east,size)
        if bold is not None:ensure(rp,'b',val=int(bold))
    return pp

def paragraph(text='',style=None):
    p=ET.Element(tag('p'))
    if style:ensure(ensure(p,'pPr'),'pStyle',val=style)
    if text:
        r=ET.SubElement(p,tag('r'));ET.SubElement(r,tag('t')).text=text
    return p

def field(p,instruction,placeholder=''):
    r=ET.SubElement(p,tag('r'));ensure(r,'fldChar',fldCharType='begin',dirty='true')
    r=ET.SubElement(p,tag('r'));t=ET.SubElement(r,tag('instrText'));t.set('{http://www.w3.org/XML/1998/namespace}space','preserve');t.text=' '+instruction+' '
    r=ET.SubElement(p,tag('r'));ensure(r,'fldChar',fldCharType='separate')
    if placeholder:
        r=ET.SubElement(p,tag('r'));ET.SubElement(r,tag('t')).text=placeholder
    r=ET.SubElement(p,tag('r'));ensure(r,'fldChar',fldCharType='end')

def apply(path, version='V1.0', cover_config=None):
    cover_config=cover_config or {'title_row':7,'grid_pt':18}
    with zipfile.ZipFile(path) as z:parts={n:z.read(n) for n in z.namelist()}
    doc=ET.fromstring(parts['word/document.xml']);styles=ET.fromstring(parts['word/styles.xml'])
    body=doc.find('w:body',NS)
    defaults=ensure(styles,'docDefaults');font(ensure(ensure(defaults,'rPrDefault'),'rPr'),'宋体',18)
    dp=ensure(ensure(defaults,'pPrDefault'),'pPr');ensure(dp,'spacing',before=0,after=0,line=360,lineRule='auto');ensure(dp,'jc',val='both')
    for st in styles.findall('w:style',NS):
        font(ensure(st,'rPr'),'宋体',18)
        if st.get(tag('type'))=='paragraph':
            pp=ensure(st,'pPr');ensure(pp,'spacing',before=0,after=0,line=360,lineRule='auto')
            ensure(pp,'jc',val='both')
    for level in (1,2,3):
        for sid in (f'Heading{level}',f'TOC{level}'):
            st=next((s for s in styles.findall('w:style',NS) if s.get(tag('styleId'))==sid),None)
            if st is None:
                st=ET.SubElement(styles,tag('style'),{tag('type'):'paragraph',tag('styleId'):sid});ensure(st,'name',val=f'toc {level}' if sid.startswith('TOC') else f'heading {level}')
            pp=ensure(st,'pPr');ensure(pp,'spacing',before=0,after=0,line=360,lineRule='auto')
            font(ensure(st,'rPr'),'宋体' if sid.startswith('TOC') else '黑体',24 if sid.startswith('TOC') else {1:32,2:28,3:24}[level])
            ensure(pp,'ind',left=480*(level-1) if sid.startswith('TOC') else 0,firstLine=0)
            if sid.startswith('TOC'):
                ensure(pp,'outlineLvl',val=9);tabs=ensure(pp,'tabs');ensure(tabs,'tab',val='right',leader='dot',pos=8958)
            else:ensure(pp,'outlineLvl',val=level-1)
    title=None
    for p in body.findall('w:p',NS):
        sid=p.find('w:pPr/w:pStyle',NS);sid=sid.get(tag('val'),'') if sid is not None else ''
        if sid=='Title':title=p;continue
        pp=style_paragraph(p)
        if sid.startswith('Heading'):
            level=int(sid[-1]);style_paragraph(p,{1:32,2:28,3:24}[level],'黑体',indent=0)
            ensure(pp,'keepNext',val=1);ensure(pp,'keepLines',val=1)
        elif re.match(r'^[一二三四五六七八九十百]+、',ptext(p)):
            style_paragraph(p,24,'黑体')
        elif ptext(p).startswith('此处需替换为') and ptext(p).endswith('图片'):
            style_paragraph(p,align='center',indent=0);ensure(pp,'keepNext',val=1)
        elif re.match(r'^表\d+\.\d+\s',ptext(p)):
            style_paragraph(p,21,'黑体','center',0,bold=True)
            ensure(pp,'keepNext',val=1);ensure(pp,'keepLines',val=1)
            ensure(pp,'outlineLvl',val=9)
        elif re.match(r'^图\d+\s',ptext(p)):
            style_paragraph(p,21,'黑体','center',0,bold=True)
    if title is None:raise ValueError('Pandoc 未生成 Title 段落。')
    # 18pt baseline rows: title starts at row 7, version at row 15 for one-line title.
    title_pp=style_paragraph(title,52,'黑体','center',0,bold=False)
    # 一号 is 26pt (52 half-points), 1.5 spacing is 39pt.
    ensure(title_pp,'spacing',before=0,after=2100,line=360,lineRule='auto')
    ensure(title_pp,'keepNext',val=1)
    title_pos=list(body).index(title)
    for _ in range(cover_config['title_row']-1):
        blank=paragraph();bp=style_paragraph(blank,24,indent=0)
        ensure(bp,'spacing',before=0,after=0,line=round(cover_config['grid_pt']*20),lineRule='exact')
        ensure(bp,'keepNext',val=1)
        body.insert(title_pos,blank);title_pos+=1
    v=paragraph('版本：'+version);style_paragraph(v,28,'黑体','center',0,bold=False)
    body.insert(title_pos+1,v)
    toc_title=paragraph('目录');pp=style_paragraph(toc_title,32,'黑体','center',0);ensure(pp,'pageBreakBefore',val=1);ensure(pp,'keepNext',val=1)
    body.insert(title_pos+2,toc_title)
    toc=paragraph(style='TOC1');field(toc,'TOC \\o "1-3" \\h \\z','请在 Word 中更新目录');style_paragraph(toc,indent=0)
    body.insert(title_pos+3,toc)
    first=next(p for p in body.findall('w:p',NS) if p.find('w:pPr/w:pStyle',NS) is not None and p.find('w:pPr/w:pStyle',NS).get(tag('val'))=='Heading1')
    ensure(ensure(first,'pPr'),'pageBreakBefore',val=1)
    for table in doc.findall('.//w:tbl',NS):
        pr=ensure(table,'tblPr');borders=ensure(pr,'tblBorders')
        for side in ('top','bottom','insideH','left','right','insideV','start','end'):
            ensure(borders,side,val='single' if side in ('top','bottom','insideH') else 'nil',sz=12 if side in ('top','bottom') else 4,color='000000')
        ensure(ensure(pr,'tblCellMar'),'top',w=85,type='dxa')
        for ri,row in enumerate(table.findall('w:tr',NS)):
            if ri==0:ensure(ensure(row,'trPr'),'tblHeader',val=1)
            for cell in row.findall('w:tc',NS):
                cp=ensure(cell,'tcPr');ensure(cp,'vAlign',val='center')
                for key in ('tcBorders','shd'):
                    old=cp.find(tag(key))
                    if old is not None:cp.remove(old)
                ensure(ensure(cp,'tcMar'),'top',w=85,type='dxa')
                if ri==0:ensure(cp,'shd',val='clear',fill='D9D9D9')
                for p in cell.findall('.//w:p',NS):
                    style_paragraph(p,24,align='center',indent=0,line=312,bold=True if ri==0 else None)
    # One shared footer, no headers, continuous page numbers including cover.
    rels=ET.fromstring(parts['word/_rels/document.xml.rels'])
    ids={e.get('Id') for e in rels};i=1
    while f'rIdTopic{i}' in ids:i+=1
    rid=f'rIdTopic{i}'
    ET.SubElement(rels,'{%s}Relationship'%REL,Id=rid,Type=R+'/footer',Target='footer-topic.xml')
    footer=ET.Element(tag('ftr'));fp=ET.SubElement(footer,tag('p'))
    for value,instruction in [('第',None),('', 'PAGE'),('页 / 共',None),('', 'NUMPAGES'),('页',None)]:
        if instruction:field(fp,instruction)
        else:r=ET.SubElement(fp,tag('r'));ET.SubElement(r,tag('t')).text=value
    style_paragraph(fp,18,align='center',indent=0)
    for sect in doc.findall('.//w:sectPr',NS):
        for el in list(sect):
            if el.tag in (tag('headerReference'),tag('footerReference'),tag('titlePg'),tag('pgNumType')):sect.remove(el)
        ref=ET.Element(tag('footerReference'),{tag('type'):'default','{%s}id'%R:rid});sect.insert(0,ref)
    ct=ET.fromstring(parts['[Content_Types].xml']);ET.SubElement(ct,'{%s}Override'%CT,PartName='/word/footer-topic.xml',ContentType='application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml')
    settings=ET.fromstring(parts['word/settings.xml']);ensure(settings,'updateFields',val='true')
    for name,root in [('word/document.xml',doc),('word/styles.xml',styles),('word/settings.xml',settings),('word/footer-topic.xml',footer),('word/_rels/document.xml.rels',rels),('[Content_Types].xml',ct)]:parts[name]=ET.tostring(root,encoding='utf-8',xml_declaration=True)
    with zipfile.ZipFile(path,'w',zipfile.ZIP_DEFLATED) as z:
        for name,data in parts.items():z.writestr(name,data)
    return doc
