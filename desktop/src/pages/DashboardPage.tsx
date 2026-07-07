import { Col, Empty, Row, Space, Spin, Table, Tag, Typography } from "antd";
import dayjs from "dayjs";
import { useMemo } from "react";
import { api } from "../api/client";
import { MetricCard } from "../components/MetricCard";
import { SectionCard } from "../components/SectionCard";
import { usePolling } from "../hooks/usePolling";
import { statusColor, statusLabel } from "../utils/status";

export function DashboardPage() {
  const system = usePolling(api.systemCheck, { intervalMs: 15000, cacheKey: "system:check" });
  const batches = usePolling(api.listBatches, { intervalMs: 7000, cacheKey: "batches:list" });
  const schedules = usePolling(api.listSchedules, { intervalMs: 12000, cacheKey: "schedules:list" });

  const activeProviders = useMemo(
    () => system.data?.providers.filter((item) => item.health.healthy).length ?? 0,
    [system.data],
  );

  if (system.loading || batches.loading || schedules.loading) {
    return <Spin size="large" />;
  }

  return (
    <Space direction="vertical" size={24} style={{ width: "100%" }}>
      <SectionCard
        title="运行总览"
        subtitle="先看系统、Provider 与批次的健康度，再进入编排和复盘。"
      >
        <Row gutter={[16, 16]}>
          <Col xs={24} md={12} xl={6}>
            <MetricCard title="健康 Provider" value={activeProviders} tone="warm" />
          </Col>
          <Col xs={24} md={12} xl={6}>
            <MetricCard title="批次总数" value={batches.data?.length ?? 0} tone="cool" />
          </Col>
          <Col xs={24} md={12} xl={6}>
            <MetricCard title="启用定时任务" value={schedules.data?.filter((item) => item.status === "enabled").length ?? 0} />
          </Col>
          <Col xs={24} md={12} xl={6}>
            <MetricCard title="运行时" value={system.data?.runtime_origin ?? "--"} />
          </Col>
        </Row>
      </SectionCard>

      <Row gutter={[24, 24]}>
        <Col xs={24} xl={12}>
          <SectionCard title="Provider 体检" subtitle="桌面壳启动后先检查本地浏览器接入状态。">
            {system.data?.providers.length ? (
              <Space direction="vertical" size={12} style={{ width: "100%" }}>
                {system.data.providers.map((provider) => (
                  <div key={provider.provider_type} className="provider-health-item">
                    <div>
                      <Typography.Title level={5}>{provider.display_name}</Typography.Title>
                      <Typography.Text type="secondary">{provider.health.message}</Typography.Text>
                    </div>
                    <Tag color={provider.health.healthy ? "green" : "red"}>
                      {provider.health.healthy ? "可用" : "不可用"}
                    </Tag>
                  </div>
                ))}
              </Space>
            ) : (
              <Empty description="还没有检测到 Provider" />
            )}
          </SectionCard>
        </Col>
        <Col xs={24} xl={12}>
          <SectionCard title="最近批次" subtitle="从结果看板回到这里，能快速看到最近执行趋势。">
            <Table
              rowKey="id"
              pagination={false}
              dataSource={(batches.data ?? []).slice(0, 6)}
              columns={[
                { title: "批次", dataIndex: "name" },
                {
                  title: "状态",
                  dataIndex: "status",
                  render: (value: string) => (
                    <Tag color={statusColor(value)}>
                      {statusLabel(value)}
                    </Tag>
                  ),
                },
                {
                  title: "更新时间",
                  dataIndex: "updated_at",
                  render: (value?: string | null) => (value ? dayjs(value).format("MM-DD HH:mm") : "--"),
                },
              ]}
            />
          </SectionCard>
        </Col>
      </Row>
    </Space>
  );
}
