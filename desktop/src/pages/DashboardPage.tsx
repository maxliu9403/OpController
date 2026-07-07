import { Col, Empty, Row, Space, Spin, Table, Typography } from "antd";
import dayjs from "dayjs";
import { useMemo } from "react";
import { api } from "../api/client";
import { MetricCard } from "../components/MetricCard";
import { ProviderIcon } from "../components/ProviderIcon";
import { SectionCard } from "../components/SectionCard";
import { StatusBadge } from "../components/StatusBadge";
import { usePolling } from "../hooks/usePolling";
import type { ProviderInfo } from "../types";

const CAPABILITY_LABELS: Array<[keyof ProviderInfo["capabilities"], string]> = [
  ["supports_profile_sync", "Profile 同步"],
  ["supports_group_tag_sync", "分组同步"],
  ["supports_window_arrange", "窗口平铺"],
  ["supports_native_opened_list", "会话对账"],
  ["supports_local_api_port_config", "端口配置"],
  ["supports_cookie_read", "Cookie 读取"],
];

function providerApiText(provider: ProviderInfo) {
  if (provider.health.api_base) {
    return provider.health.api_base;
  }
  if (provider.default_port) {
    return `本地端口 ${provider.default_port}`;
  }
  return "默认本地配置";
}

function providerCapabilityLabels(provider: ProviderInfo) {
  return CAPABILITY_LABELS
    .filter(([key]) => provider.capabilities[key])
    .map(([, label]) => label);
}

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
    <Space direction="vertical" size={24} style={{ width: "100%" }} className="dashboard-page">
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
          <SectionCard
            title="Provider 体检"
            subtitle="桌面壳启动后先检查本地浏览器接入状态。"
            extra={
              <StatusBadge
                status={activeProviders === (system.data?.providers.length ?? 0) ? "healthy" : "unhealthy"}
                label={`${activeProviders}/${system.data?.providers.length ?? 0} 可用`}
              />
            }
          >
            {system.data?.providers.length ? (
              <div className="dashboard-provider-grid">
                {system.data.providers.map((provider) => {
                  const capabilityLabels = providerCapabilityLabels(provider);
                  return (
                    <article
                      key={provider.provider_type}
                      className={`dashboard-provider-card${provider.health.healthy ? " is-healthy" : " is-unhealthy"}`}
                    >
                      <div className="dashboard-provider-card__top">
                        <ProviderIcon providerType={provider.provider_type} displayName={provider.display_name} />
                        <div className="dashboard-provider-card__identity">
                          <Typography.Title level={5}>{provider.display_name}</Typography.Title>
                          <Typography.Text type="secondary">{provider.provider_type}</Typography.Text>
                        </div>
                        <StatusBadge
                          status={provider.health.healthy ? "healthy" : "unhealthy"}
                          label={provider.health.healthy ? "可用" : "不可用"}
                        />
                      </div>
                      <Typography.Paragraph className="dashboard-provider-card__message">
                        {provider.health.message}
                      </Typography.Paragraph>
                      <div className="dashboard-provider-card__meta">
                        <span>接入地址</span>
                        <strong>{providerApiText(provider)}</strong>
                      </div>
                      <div className="dashboard-provider-card__capabilities">
                        {capabilityLabels.slice(0, 4).map((label) => (
                          <span key={label}>{label}</span>
                        ))}
                        {capabilityLabels.length > 4 ? <span>+{capabilityLabels.length - 4}</span> : null}
                      </div>
                    </article>
                  );
                })}
              </div>
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
                  render: (value: string) => <StatusBadge status={value} />,
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
