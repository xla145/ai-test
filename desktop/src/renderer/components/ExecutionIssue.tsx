import { CheckOutlined, CloseOutlined, CopyOutlined, ExclamationCircleFilled } from '@ant-design/icons';
import { Button, Collapse, Popover, Tag, Typography } from 'antd';
import React, { useMemo, useState } from 'react';

interface IssueSection { title: string; lines: string[] }

function parseIssue(message: string): { intro: string; sections: IssueSection[]; meta: string[] } {
  const intro: string[] = [], sections: IssueSection[] = [], meta: string[] = [];
  let current: IssueSection | undefined;
  for (const raw of message.split(/\r?\n/).map(line => line.trim()).filter(Boolean)) {
    const heading = raw.match(/^\*\*(.+?)\*\*$/) ?? raw.match(/^#{1,6}\s+(.+)$/);
    if (heading) { current = { title: heading[1], lines: [] }; sections.push(current); continue; }
    if (/^(?:[-*]\s*)?(计划产物|脚本路径|截图)：/.test(raw) || /^中间计划(?:命中|已转换)/.test(raw) || raw.includes('.aitest/')) { meta.push(raw.replace(/`/g, '')); continue; }
    const line = raw.replace(/^[-*]\s+/, '').replace(/^\d+[.)]\s+/, '');
    if (current) current.lines.push(line); else intro.push(line);
  }
  return { intro: intro.join(' '), sections, meta };
}

function inlineText(text: string) {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, i) => part.startsWith('`') && part.endsWith('`')
    ? <code key={i}>{part.slice(1, -1)}</code>
    : part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part);
}

/** Detailed execution output stays available without occupying the case workspace. */
export function ExecutionIssue({ title, message }: { title: string; message: string }) {
  const [open, setOpen] = useState(false);
  const parsed = useMemo(() => parseIssue(message), [message]);
  return <Popover trigger="click" placement="bottomLeft" open={open} onOpenChange={setOpen}
    title={<div className="execution-issue-title"><Typography.Text strong>{title}</Typography.Text><div className="execution-issue-actions">
      <Tag color="error">未完成</Tag><Typography.Text copyable={{ text: message, icon: [<span key="copy"><CopyOutlined />复制详情</span>, <span key="copied"><CheckOutlined />已复制</span>] }} className="execution-issue-copy" />
      <Button type="text" size="small" className="execution-issue-close" icon={<CloseOutlined />} aria-label="关闭问题详情" onClick={() => setOpen(false)} />
    </div></div>}
    content={<div className="execution-issue-content" tabIndex={0} aria-label="执行问题详情">
      {parsed.intro && <Typography.Paragraph className="execution-issue-intro">{inlineText(parsed.intro)}</Typography.Paragraph>}
      {parsed.sections.map((section, i) => <section key={`${section.title}-${i}`} className="execution-issue-section">
        <Typography.Text strong>{section.title}</Typography.Text>
        <ul>{section.lines.map((line, j) => <li key={j}>{inlineText(line)}</li>)}</ul>
      </section>)}
      {parsed.meta.length > 0 && <Collapse ghost size="small" items={[{ key: 'meta', label: '运行产物与证据', children: <ul>{parsed.meta.map((line, i) => <li className="mono" key={i}>{line}</li>)}</ul> }]} />}
    </div>}>
    <Button type="text" size="small" className="execution-issue-trigger"
      icon={<ExclamationCircleFilled />} aria-label="查看执行失败或阻断原因" title="执行未完成，点击查看问题" />
  </Popover>;
}
