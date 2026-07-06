import { Card, Space, Typography } from "antd";
import type { ReactNode } from "react";

type SectionCardProps = {
  title: string;
  subtitle?: string;
  extra?: ReactNode;
  children?: ReactNode;
};

export function SectionCard({ title, subtitle, extra, children }: SectionCardProps) {
  return (
    <Card
      className="section-card"
      title={
        <Space className="section-card-title-line" size={10}>
          <Typography.Text className="section-eyebrow">{title}</Typography.Text>
          {subtitle ? <Typography.Text className="section-subtitle">{subtitle}</Typography.Text> : null}
        </Space>
      }
      extra={extra}
    >
      {children}
    </Card>
  );
}
