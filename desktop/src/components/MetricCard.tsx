import { Card, Statistic } from "antd";
import type { ReactNode } from "react";

type MetricCardProps = {
  title: string;
  value: ReactNode;
  suffix?: ReactNode;
  tone?: "default" | "warm" | "cool";
};

export function MetricCard({ title, value, suffix, tone = "default" }: MetricCardProps) {
  return (
    <Card className={`metric-card metric-card--${tone}`}>
      <Statistic title={title} value={value as never} suffix={suffix as never} />
    </Card>
  );
}

