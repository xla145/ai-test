import { QuestionCircleOutlined } from "@ant-design/icons";
import { Button, Flex, Popover, Typography } from "antd";
import type { ReactNode } from "react";
import type { WorkflowStep } from "./WorkflowGuide";

/** 标题与操作先呈现；流程说明按需展开，给业务内容留出空间。 */
export function PageHeader({ title, description, extra, workflow }: {
  title: string; description?: ReactNode; extra?: ReactNode; workflow?: WorkflowStep[];
}) {
  return (
    <div className="page-header">
      <Flex className="page-header-main" justify="space-between" align="center" gap="12px 20px" wrap>
        <Flex className="page-header-title-row" align="center" gap={8}>
          <Typography.Title level={4} className="page-title" style={{ marginTop: 0 }}>{title}</Typography.Title>
          {workflow && <Popover trigger="click" placement="bottomLeft" title={`${title}操作流程`}
            content={<ol className="page-workflow-help">{workflow.map((step) => (
              <li key={step.title}><strong>{step.title}</strong><span>{step.description}</span></li>
            ))}</ol>}>
            <Button type="text" size="small" className="page-help-button" icon={<QuestionCircleOutlined />}
              aria-label={`查看${title}操作流程`} title="操作流程" />
          </Popover>}
        </Flex>
        {extra && <Flex className="page-header-actions" gap={8} align="center" wrap>{extra}</Flex>}
      </Flex>
      {description && <Typography.Paragraph className="page-description" type="secondary">{description}</Typography.Paragraph>}
    </div>
  );
}
