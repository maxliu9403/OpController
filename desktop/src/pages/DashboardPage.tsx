import { Button, Col, Empty, Progress, Row, Space, Spin, Tag, Typography, message } from "antd";
import dayjs from "dayjs";
import { useMemo, useState } from "react";
import { api } from "../api/client";
import { MetricCard } from "../components/MetricCard";
import { ProviderIcon } from "../components/ProviderIcon";
import { SectionCard } from "../components/SectionCard";
import { StatusBadge } from "../components/StatusBadge";
import { usePolling } from "../hooks/usePolling";
import type { BatchSummary, ProviderInfo, ScheduleRecord, WorkflowRecord } from "../types";

const CAPABILITY_LABELS: Array<[keyof ProviderInfo["capabilities"], string]> = [
  ["supports_profile_sync", "指纹窗口同步"],
  ["supports_group_tag_sync", "分组同步"],
  ["supports_window_arrange", "窗口平铺"],
  ["supports_native_opened_list", "会话对账"],
  ["supports_local_api_port_config", "端口配置"],
  ["supports_cookie_read", "Cookie 读取"],
];

function providerApiText(provider: ProviderInfo, health: ProviderInfo["health"]) {
  if (health.api_base) {
    return health.api_base;
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

const WEEKDAY_LABEL_BY_VALUE: Record<string, string> = {
  mon: "周一",
  tue: "周二",
  wed: "周三",
  thu: "周四",
  fri: "周五",
  sat: "周六",
  sun: "周日",
};

const WEEKDAY_INDEX_BY_VALUE: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

function workflowRunPolicy(workflow: WorkflowRecord) {
  return workflow.normalized_workflow_json?.profile_policy as
    | { group_ids?: unknown[]; profile_ids?: unknown[] }
    | undefined;
}

function isManagedWorkflow(workflow: WorkflowRecord) {
  const policy = workflowRunPolicy(workflow);
  return Boolean((policy?.group_ids?.length ?? 0) > 0 || (policy?.profile_ids?.length ?? 0) > 0);
}

function workflowRunTargetCount(workflow: WorkflowRecord) {
  const policy = workflowRunPolicy(workflow);
  return (policy?.group_ids?.length ?? 0) + (policy?.profile_ids?.length ?? 0);
}

function batchRemainingRows(batch: BatchSummary) {
  return Math.max(0, batch.total_rows - batch.success_count - batch.failure_count);
}

function batchProgressPercent(batch: BatchSummary) {
  if (!batch.total_rows) {
    return 0;
  }
  return Math.min(100, Math.round(((batch.success_count + batch.failure_count) / batch.total_rows) * 100));
}

function parseScheduleTime(value?: string | null) {
  const [hour = "9", minute = "30"] = String(value || "09:30").split(":");
  return { hour: Number(hour) || 0, minute: Number(minute) || 0 };
}

function scheduleOccurrences(schedule: ScheduleRecord, days: number) {
  if (schedule.status !== "enabled") {
    return [];
  }
  const now = dayjs();
  const end = now.add(days, "day");
  const occurrences: dayjs.Dayjs[] = [];

  if (schedule.schedule_type === "once") {
    const at = dayjs(schedule.schedule_expr);
    return at.isValid() && at.isAfter(now) && at.isBefore(end) ? [at] : [];
  }

  if (schedule.schedule_type === "daily") {
    const { hour, minute } = parseScheduleTime(schedule.schedule_expr);
    for (let offset = 0; offset <= days; offset += 1) {
      const at = now.add(offset, "day").hour(hour).minute(minute).second(0).millisecond(0);
      if (at.isAfter(now) && at.isBefore(end)) {
        occurrences.push(at);
      }
    }
    return occurrences;
  }

  if (schedule.schedule_type === "weekly") {
    const [daysPart, timePart] = schedule.schedule_expr.split("|");
    const enabledDays = new Set(daysPart.split(",").map((item) => WEEKDAY_INDEX_BY_VALUE[item]).filter((item) => item !== undefined));
    const { hour, minute } = parseScheduleTime(timePart);
    for (let offset = 0; offset <= days; offset += 1) {
      const candidateDay = now.add(offset, "day");
      if (!enabledDays.has(candidateDay.day())) {
        continue;
      }
      const at = candidateDay.hour(hour).minute(minute).second(0).millisecond(0);
      if (at.isAfter(now) && at.isBefore(end)) {
        occurrences.push(at);
      }
    }
  }
  return occurrences;
}

function scheduleReadableTime(schedule: ScheduleRecord) {
  if (schedule.schedule_type === "once") {
    const at = dayjs(schedule.schedule_expr);
    return at.isValid() ? at.format("MM-DD HH:mm") : schedule.schedule_expr;
  }
  if (schedule.schedule_type === "daily") {
    return `每天 ${schedule.schedule_expr}`;
  }
  if (schedule.schedule_type === "weekly") {
    const [daysPart, timePart] = schedule.schedule_expr.split("|");
    const days = daysPart
      .split(",")
      .map((day) => WEEKDAY_LABEL_BY_VALUE[day] ?? day)
      .join("、");
    return `${days} ${timePart ?? ""}`.trim();
  }
  return schedule.schedule_expr;
}

export function DashboardPage() {
  const system = usePolling(api.systemCheck, { intervalMs: 15000, cacheKey: "system:check" });
  const batches = usePolling(api.listBatches, { intervalMs: 7000, cacheKey: "batches:list" });
  const schedules = usePolling(api.listSchedules, { intervalMs: 12000, cacheKey: "schedules:list" });
  const workflows = usePolling(api.listWorkflows, { intervalMs: 12000, cacheKey: "workflows:list:all" });
  const [providerHealth, setProviderHealth] = useState<Record<string, ProviderInfo["health"]>>({});
  const [checkingProvider, setCheckingProvider] = useState<string | null>(null);

  const activeProviders = useMemo(
    () =>
      system.data?.providers.filter((item) => (providerHealth[item.provider_type] ?? item.health).healthy).length ?? 0,
    [providerHealth, system.data],
  );

  const managedWorkflows = useMemo(() => (workflows.data ?? []).filter(isManagedWorkflow), [workflows.data]);
  const unmanagedWorkflows = Math.max(0, (workflows.data?.length ?? 0) - managedWorkflows.length);
  const managedProviderStats = useMemo(() => {
    const counts = new Map<string, number>();
    for (const workflow of managedWorkflows) {
      counts.set(workflow.target_provider_type, (counts.get(workflow.target_provider_type) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [managedWorkflows]);

  const runningBatches = useMemo(
    () => (batches.data ?? []).filter((batch) => ["ready", "running", "paused"].includes(batch.status)),
    [batches.data],
  );
  const activeTaskRows = useMemo(
    () => runningBatches.reduce((total, batch) => total + batchRemainingRows(batch), 0),
    [runningBatches],
  );
  const completedToday = useMemo(
    () =>
      (batches.data ?? []).filter((batch) => {
        const updatedAt = dayjs(batch.updated_at);
        return batch.status === "completed" && updatedAt.isValid() && updatedAt.isSame(dayjs(), "day");
      }).length,
    [batches.data],
  );

  const enabledSchedules = useMemo(
    () => (schedules.data ?? []).filter((schedule) => schedule.status === "enabled"),
    [schedules.data],
  );
  const nextDayOccurrences = useMemo(
    () => enabledSchedules.flatMap((schedule) => scheduleOccurrences(schedule, 1).map((at) => ({ schedule, at }))).sort((a, b) => a.at.valueOf() - b.at.valueOf()),
    [enabledSchedules],
  );
  const nextWeekOccurrences = useMemo(
    () => enabledSchedules.flatMap((schedule) => scheduleOccurrences(schedule, 7).map((at) => ({ schedule, at }))).sort((a, b) => a.at.valueOf() - b.at.valueOf()),
    [enabledSchedules],
  );
  const nextSchedule = nextWeekOccurrences[0] ?? null;

  const handleStartProvider = async (provider: ProviderInfo) => {
    setCheckingProvider(provider.provider_type);
    try {
      const result = await api.providerHealthCheck(provider.provider_type);
      setProviderHealth((current) => ({ ...current, [provider.provider_type]: result }));
      if (result.healthy) {
        message.success(`${provider.display_name} 已连通`);
      } else {
        message.warning(result.message);
      }
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "Provider 启动检查失败");
    } finally {
      setCheckingProvider(null);
    }
  };

  if (system.loading || batches.loading || schedules.loading || workflows.loading) {
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
            <MetricCard title="已管理流程" value={managedWorkflows.length} tone="cool" />
          </Col>
          <Col xs={24} md={12} xl={6}>
            <MetricCard title="执行中任务" value={activeTaskRows} />
          </Col>
          <Col xs={24} md={12} xl={6}>
            <MetricCard title="未来 24h 计划" value={nextDayOccurrences.length} />
          </Col>
        </Row>
      </SectionCard>

      <Row gutter={[24, 24]}>
        <Col xs={24} xl={14}>
          <SectionCard
            title="Provider 启动"
            subtitle="不会默认检查所有指纹浏览器。选择需要接入的 Provider 后，手动启动检测。"
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
                  const health = providerHealth[provider.provider_type] ?? provider.health;
                  return (
                    <article
                      key={provider.provider_type}
                      className={`dashboard-provider-card${health.healthy ? " is-healthy" : " is-unhealthy"}`}
                    >
                      <div className="dashboard-provider-card__top">
                        <ProviderIcon providerType={provider.provider_type} displayName={provider.display_name} />
                        <div className="dashboard-provider-card__identity">
                          <Typography.Title level={5}>{provider.display_name}</Typography.Title>
                          <Typography.Text type="secondary">{provider.provider_type}</Typography.Text>
                        </div>
                        <StatusBadge
                          status={health.healthy ? "healthy" : "pending"}
                          label={health.healthy ? "可用" : "未启动"}
                        />
                      </div>
                      <Typography.Paragraph className="dashboard-provider-card__message">
                        {health.message}
                      </Typography.Paragraph>
                      <div className="dashboard-provider-card__meta">
                        <span>接入地址</span>
                        <strong>{providerApiText(provider, health)}</strong>
                      </div>
                      <div className="dashboard-provider-card__capabilities">
                        {capabilityLabels.slice(0, 4).map((label) => (
                          <span key={label}>{label}</span>
                        ))}
                        {capabilityLabels.length > 4 ? <span>+{capabilityLabels.length - 4}</span> : null}
                      </div>
                      <Button
                        size="small"
                        type={health.healthy ? "default" : "primary"}
                        loading={checkingProvider === provider.provider_type}
                        onClick={() => void handleStartProvider(provider)}
                      >
                        {health.healthy ? "重新检查" : "启动"}
                      </Button>
                    </article>
                  );
                })}
              </div>
            ) : (
              <Empty description="还没有检测到 Provider" />
            )}
          </SectionCard>
        </Col>
        <Col xs={24} xl={10}>
          <SectionCard title="运营概览" subtitle="关注可运行流程、正在执行的任务和未来计划。">
            <div className="dashboard-ops-board">
              <article className="dashboard-glass-card dashboard-glass-card--workflows">
                <div className="dashboard-glass-card__head">
                  <span>编排流程</span>
                  <StatusBadge status={managedWorkflows.length ? "configured" : "unbound"} label={managedWorkflows.length ? "已管理" : "待绑定"} />
                </div>
                <div className="dashboard-glass-card__metric">
                  <strong>{managedWorkflows.length}</strong>
                  <small>条流程已关联指纹窗口组</small>
                </div>
                <div className="dashboard-flow-list">
                  {managedWorkflows.slice(0, 4).map((workflow) => (
                    <div key={workflow.id} className="dashboard-flow-item">
                      <div>
                        <Typography.Text strong>{workflow.name}</Typography.Text>
                        <Typography.Text type="secondary">{workflow.folder || "未分组"} · {workflow.target_provider_type}</Typography.Text>
                      </div>
                      <Tag>{workflowRunTargetCount(workflow)} 个运行池</Tag>
                    </div>
                  ))}
                  {!managedWorkflows.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有绑定指纹窗口组的流程" /> : null}
                </div>
                <div className="dashboard-chip-row">
                  {managedProviderStats.slice(0, 3).map(([providerType, count]) => (
                    <span key={providerType}>{providerType} · {count}</span>
                  ))}
                  {unmanagedWorkflows ? <span>未绑定 · {unmanagedWorkflows}</span> : null}
                </div>
              </article>

              <article className="dashboard-glass-card dashboard-glass-card--tasks">
                <div className="dashboard-glass-card__head">
                  <span>当前执行任务</span>
                  <StatusBadge status={runningBatches.length ? "running" : "pending"} label={runningBatches.length ? "运行中" : "空闲"} />
                </div>
                <div className="dashboard-glass-card__metric">
                  <strong>{activeTaskRows}</strong>
                  <small>行任务正在等待或执行</small>
                </div>
                <div className="dashboard-task-stack">
                  {runningBatches.slice(0, 3).map((batch) => (
                    <div key={batch.id} className="dashboard-task-item">
                      <div className="dashboard-task-item__title">
                        <Typography.Text strong>{batch.name}</Typography.Text>
                        <StatusBadge status={batch.status} />
                      </div>
                      <Progress percent={batchProgressPercent(batch)} showInfo={false} size="small" />
                      <Typography.Text type="secondary">
                        剩余 {batchRemainingRows(batch)} / 总计 {batch.total_rows}
                      </Typography.Text>
                    </div>
                  ))}
                  {!runningBatches.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前没有运行中的批次任务" /> : null}
                </div>
                <div className="dashboard-chip-row">
                  <span>今日完成 · {completedToday}</span>
                  <span>累计批次 · {batches.data?.length ?? 0}</span>
                </div>
              </article>

              <article className="dashboard-glass-card dashboard-glass-card--schedules">
                <div className="dashboard-glass-card__head">
                  <span>定时任务</span>
                  <StatusBadge status={enabledSchedules.length ? "enabled" : "disabled"} label={enabledSchedules.length ? "已启用" : "未启用"} />
                </div>
                <div className="dashboard-schedule-metrics">
                  <div>
                    <strong>{nextDayOccurrences.length}</strong>
                    <small>未来 24 小时</small>
                  </div>
                  <div>
                    <strong>{nextWeekOccurrences.length}</strong>
                    <small>未来 7 天</small>
                  </div>
                </div>
                {nextSchedule ? (
                  <div className="dashboard-next-schedule">
                    <span>下一次执行</span>
                    <strong>{nextSchedule.at.format("MM-DD HH:mm")}</strong>
                    <Typography.Text type="secondary">
                      {nextSchedule.schedule.name} · {scheduleReadableTime(nextSchedule.schedule)}
                    </Typography.Text>
                  </div>
                ) : (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未来一周暂无计划触发" />
                )}
                <div className="dashboard-schedule-timeline">
                  {nextWeekOccurrences.slice(0, 7).map((item, index) => (
                    <span key={`${item.schedule.id}-${item.at.valueOf()}-${index}`}>
                      <i style={{ height: `${Math.max(18, 44 - index * 3)}px` }} />
                      {item.at.format("MM-DD")}
                    </span>
                  ))}
                </div>
              </article>
            </div>
          </SectionCard>
        </Col>
      </Row>
    </Space>
  );
}
