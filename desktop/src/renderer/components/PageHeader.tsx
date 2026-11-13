import { Flex, Typography } from "antd";
import type { ReactNode } from "react";

/** 页面标题：操作按钮与标题同一行，宽度不够时整体换到标题下方 */
export function PageHeader({ title, description, extra }: { title: string; description?: ReactNode; extra?: ReactNode }) {
  return (
    <Flex className="page-header" justify="space-between" align="flex-start" gap="16px 24px" wrap>
      <div style={{ flex: "1 1 280px", minWidth: 0 }}>
        <Typography.Title level={4} className="page-title" style={{ marginTop: 0 }}>{title}</Typography.Title>
        {description && <Typography.Paragraph className="page-description" type="secondary">{description}</Typography.Paragraph>}
      </div>
      {extra && <Flex gap={8} align="center" wrap style={{ flex: "0 1 auto" }}>{extra}</Flex>}
    </Flex>
  );
}
