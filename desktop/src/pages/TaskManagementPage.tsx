import { Segmented, Space, Typography } from "antd";
import dayjs from "dayjs";
import { CalendarClock, Clock3, PlayCircle, TimerReset } from "lucide-react";
import { lazy, Suspense, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { usePolling } from "../hooks/usePolling";
import type { BatchSummary } from "../types";

type TaskTab = "instant" | "scheduled";

const BatchesPage = lazy(() => import("./BatchesPage").then((module) => ({ default: module.BatchesPage })));
const SchedulesPage = lazy(() => import("./SchedulesPage").then((module) => ({ default: module.SchedulesPage })));

const TAB_OPTIONS = [
  { label: "即时任务", value: "instant" },
  { label: "定时任务", value: "scheduled" },
];

function normalizeTab(value: string | null): TaskTab {
  return value === "scheduled" ? "scheduled" : "instant";
}

function batchRemainingRows(batch: BatchSummary) {
  return Math.max(0, batch.total_rows - batch.success_count - batch.failure_count);
}

export function TaskManagementPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = normalizeTab(searchParams.get("tab"));
  const batches = usePolling(api.listBatches, { intervalMs: 7000, cacheKey: "batches:list" });
  const schedules = usePolling(api.listSchedules, { intervalMs: 12000, cacheKey: "schedules:list" });

  const runningBatches = useMemo(
    () => (batches.data ?? []).filter((batch) => ["ready", "running", "paused"].includes(batch.status)),
    [batches.data],
  );
  const runningRows = useMemo(
    () => runningBatches.reduce((total, batch) => total + batchRemainingRows(batch), 0),
    [runningBatches],
  );
  const enabledSchedules = useMemo(
    () => (schedules.data ?? []).filter((schedule) => schedule.status === "enabled").length,
    [schedules.data],
  );
  const completedToday = useMemo(
    () =>
      (batches.data ?? []).filter((batch) => {
        const updatedAt = dayjs(batch.updated_at);
        return batch.status === "completed" && updatedAt.isValid() && updatedAt.isSame(dayjs(), "day");
      }).length,
    [batches.data],
  );

  const handleTabChange = (value: string | number) => {
    setSearchParams({ tab: String(value) }, { replace: true });
  };

  return (
    <div className="app-page task-management-page">
      <section className="task-management-hero">
        <div className="task-management-hero__copy">
          <Typography.Text className="section-eyebrow">任务管理</Typography.Text>
          <Typography.Title level={3}>即时执行与定时计划</Typography.Title>
          <Typography.Paragraph>
            把一次性批量执行和周期计划放在同一个工作台里管理，启动前确认流程、指纹窗口组、Excel 参数和槽位。
          </Typography.Paragraph>
        </div>
        <Segmented
          className="task-management-tabs"
          options={TAB_OPTIONS}
          value={activeTab}
          onChange={handleTabChange}
        />
      </section>

      <div className="task-management-stat-grid">
        <div className="task-management-stat-card">
          <span><PlayCircle size={15} /> 当前执行</span>
          <strong>{runningRows}</strong>
          <small>{runningBatches.length} 个批次正在运行或排队</small>
        </div>
        <div className="task-management-stat-card">
          <span><CalendarClock size={15} /> 已启用计划</span>
          <strong>{enabledSchedules}</strong>
          <small>到点后自动生成真实批次</small>
        </div>
        <div className="task-management-stat-card">
          <span><TimerReset size={15} /> 今日完成</span>
          <strong>{completedToday}</strong>
          <small>已完成的即时或定时批次</small>
        </div>
        <div className="task-management-stat-card">
          <span><Clock3 size={15} /> 当前模式</span>
          <strong>{activeTab === "instant" ? "即时" : "定时"}</strong>
          <small>{activeTab === "instant" ? "导入表格后立即执行" : "保存计划后按时间执行"}</small>
        </div>
      </div>

      <div className="task-management-content">
        <Space direction="vertical" size={0} style={{ width: "100%", minHeight: 0 }}>
          <Suspense fallback={<div className="page-loading">任务模块加载中...</div>}>
            {activeTab === "instant" ? <BatchesPage /> : <SchedulesPage />}
          </Suspense>
        </Space>
      </div>
    </div>
  );
}
