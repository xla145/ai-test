import { Flex, Typography } from "antd";
import type { ReactNode } from "react";

export function PageHeader({ title, description, extra }: { title: string; description?: ReactNode; extra?: ReactNode }) {
  return (
    <Flex justify="space-between" align="flex-start" gap={16} style={{ marginBottom: 16 }}>
      <div style={{ minWidth: 0 }}>
        <Typography.Title level={4} className="page-title">{title}</Typography.Title>
        {description && <Typography.Text type="secondary">{description}</Typography.Text>}
      </div>
      {extra && <Flex gap={8} align="center" style={{ flexShrink: 0 }}>{extra}</Flex>}
    </Flex>
  );
}
