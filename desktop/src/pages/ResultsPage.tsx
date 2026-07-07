import { Button, Empty, Input, Select, Space, Spin, Table, Tag, Typography } from "antd";
import dayjs from "dayjs";
import { Download } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { api } from "../api/client";
import { MetricCard } from "../components/MetricCard";
import { SectionCard } from "../components/SectionCard";
import { usePolling } from "../hooks/usePolling";
import type { BatchDetail, BatchSummary } from "../types";
import { batchResultLabel, statusColor, statusLabel } from "../utils/status";

type BatchResultFilter = "all" | "success" | "partial" | "failed";
type RowStatusFilter = "all" | "succeeded" | "failed" | "running" | "pending";

function batchResultKind(batch: BatchSummary): Exclude<BatchResultFilter, "all"> | "running" {
  if (batch.success_count > 0 && batch.failure_count > 0) {
    return "partial";
  }
  if (batch.failure_count > 0 || batch.status === "failed" || batch.status === "cancelled") {
    return "failed";
  }
  if (batch.status === "completed" && batch.success_count >= batch.total_rows) {
    return "success";
  }
  return "running";
}

function rowStatusKind(status?: string | null): Exclude<RowStatusFilter, "all"> {
  if (status === "succeeded") {
    return "succeeded";
  }
  if (status === "failed" || status === "lost" || status === "cancelled") {
    return "failed";
  }
  if (status === "running" || status === "opening" || status === "closing") {
    return "running";
  }
  return "pending";
}

function safeFileName(value: string) {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "_")
    .slice(0, 80) || "batch_results";
}

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function downloadTextFile(fileName: string, content: string, type = "text/csv;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function buildTaskRows(batch: BatchDetail | null) {
  if (!batch) {
    return [];
  }
  const taskByRowId = new Map(batch.tasks.map((task) => [task.batch_row_id, task]));
  const taskByRowIndex = new Map(batch.tasks.map((task) => [task.row_index, task]));
  return batch.rows.map((row) => {
    const task = (row.id ? taskByRowId.get(row.id) : null) ?? taskByRowIndex.get(row.row_index) ?? null;
    return {
      key: `${batch.id}-${row.row_index}`,
      row,
      task,
      status: task?.status ?? "pending",
      profileId: task?.provider_profile_id ?? row.mapped_profile_id ?? "",
      error: task?.error_message || task?.error_code || "",
      outputs: task?.outputs_json ?? {},
    };
  });
}

export function ResultsPage() {
  const batches = usePolling(api.listBatches, { intervalMs: 7000, cacheKey: "batches:list" });
  const workflows = usePolling(api.listWorkflows, { intervalMs: 12000, cacheKey: "workflows:list:all" });
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [batchResultFilter, setBatchResultFilter] = useState<BatchResultFilter>("all");
  const [workflowQuery, setWorkflowQuery] = useState("");
  const [rowStatusFilter, setRowStatusFilter] = useState<RowStatusFilter>("all");

  const workflowNameById = useMemo(
    () => new Map((workflows.data ?? []).map((workflow) => [workflow.id, workflow.name])),
    [workflows.data],
  );

  const filteredBatches = useMemo(() => {
    const query = workflowQuery.trim().toLowerCase();
    return (batches.data ?? []).filter((batch) => {
      if (batchResultFilter !== "all" && batchResultKind(batch) !== batchResultFilter) {
        return false;
      }
      if (query) {
        const workflowName = workflowNameById.get(batch.workflow_id) ?? "";
        if (!workflowName.toLowerCase().includes(query)) {
          return false;
        }
      }
      return true;
    });
  }, [batchResultFilter, batches.data, workflowNameById, workflowQuery]);

  const effectiveBatchId = selectedBatchId && filteredBatches.some((batch) => batch.id === selectedBatchId)
    ? selectedBatchId
    : filteredBatches[0]?.id ?? null;
  const batchDetailFetcher = useCallback(
    () => (effectiveBatchId ? api.getResultBatch(effectiveBatchId) : Promise.resolve(null)),
    [effectiveBatchId],
  );
  const batchDetail = usePolling(batchDetailFetcher, {
    intervalMs: 7000,
    cacheKey: effectiveBatchId ? `results:batch:${effectiveBatchId}` : "results:batch:none",
    enabled: Boolean(effectiveBatchId),
  });
  const selectedBatch = useMemo(
    () => filteredBatches.find((item) => item.id === effectiveBatchId) ?? null,
    [effectiveBatchId, filteredBatches],
  );
  const taskRows = useMemo(() => buildTaskRows(batchDetail.data), [batchDetail.data]);
  const filteredTaskRows = useMemo(
    () =>
      taskRows.filter((row) => {
        if (rowStatusFilter === "all") {
          return true;
        }
        return rowStatusKind(row.status) === rowStatusFilter;
      }),
    [rowStatusFilter, taskRows],
  );

  const handleExportCsv = () => {
    if (!batchDetail.data) {
      return;
    }
    const headers = ["行号", "Profile ID", "状态", "错误码/信息", "输入参数", "输出结果"];
    const lines = [
      headers.map(csvCell).join(","),
      ...filteredTaskRows.map((item) =>
        [
          item.row.row_index,
          item.profileId,
          statusLabel(item.status),
          item.error,
          item.row.payload,
          item.outputs,
        ].map(csvCell).join(","),
      ),
    ];
    downloadTextFile(`${safeFileName(batchDetail.data.name)}_执行结果.csv`, lines.join("\n"));
  };

  if (batches.loading || workflows.loading) {
    return <Spin size="large" />;
  }

  return (
    <div className="app-page results-page">
      <SectionCard
        title="批次结果看板"
        subtitle="按流程、结果状态和输入行状态快速定位失败原因。"
        extra={
          <Space className="results-filter-strip" wrap>
            <Input.Search
              allowClear
              placeholder="按流程名称搜索"
              value={workflowQuery}
              onChange={(event) => setWorkflowQuery(event.target.value)}
              style={{ width: 260 }}
            />
            <Select
              value={batchResultFilter}
              onChange={setBatchResultFilter}
              style={{ width: 150 }}
              options={[
                { value: "all", label: batchResultLabel("all") },
                { value: "success", label: batchResultLabel("success") },
                { value: "partial", label: batchResultLabel("partial") },
                { value: "failed", label: batchResultLabel("failed") },
              ]}
            />
          </Space>
        }
      >
        {selectedBatch ? (
          <div className="results-metric-grid">
            <MetricCard title="总任务数" value={selectedBatch.total_rows} tone="warm" />
            <MetricCard title="成功数" value={selectedBatch.success_count} tone="cool" />
            <MetricCard title="失败数" value={selectedBatch.failure_count} />
            <MetricCard
              title="成功率"
              value={selectedBatch.total_rows ? Math.round((selectedBatch.success_count / selectedBatch.total_rows) * 100) : 0}
              suffix="%"
            />
          </div>
        ) : (
          <Empty description="当前筛选下没有批次结果" />
        )}
      </SectionCard>

      <div className="results-workbench">
        <SectionCard title="批次列表">
          <div className="results-panel-scroll">
            <Table
              rowKey="id"
              size="small"
              dataSource={filteredBatches}
              pagination={false}
              onRow={(record) => ({ onClick: () => setSelectedBatchId(record.id) })}
              rowClassName={(record) => (record.id === effectiveBatchId ? "result-row-active" : "")}
              columns={[
                {
                  title: "批次 / 流程",
                  render: (_value: unknown, record: BatchSummary) => (
                    <Space direction="vertical" size={2}>
                      <Typography.Text strong>{record.name}</Typography.Text>
                      <Typography.Text type="secondary">
                        {workflowNameById.get(record.workflow_id) ?? "未知流程"}
                      </Typography.Text>
                    </Space>
                  ),
                },
                {
                  title: "结果",
                  width: 110,
                  render: (_value: unknown, record: BatchSummary) => {
                    const kind = batchResultKind(record);
                    const label = kind === "partial" ? "部分成功" : kind === "success" ? "成功" : kind === "failed" ? "失败" : statusLabel(record.status);
                    const color = kind === "success" ? "green" : kind === "partial" ? "gold" : kind === "failed" ? "red" : statusColor(record.status);
                    return <Tag color={color}>{label}</Tag>;
                  },
                },
                {
                  title: "更新时间",
                  dataIndex: "updated_at",
                  width: 116,
                  render: (value?: string | null) => (value ? dayjs(value).format("MM-DD HH:mm") : "--"),
                },
              ]}
            />
          </div>
        </SectionCard>

        <SectionCard
          title="输入行与导出"
          extra={
            <Space wrap>
              <Select
                value={rowStatusFilter}
                onChange={setRowStatusFilter}
                style={{ width: 130 }}
                options={[
                  { value: "all", label: "全部" },
                  { value: "succeeded", label: "成功" },
                  { value: "failed", label: "失败" },
                  { value: "running", label: "运行中" },
                  { value: "pending", label: "未开始" },
                ]}
              />
              <Button icon={<Download size={15} />} disabled={!batchDetail.data} onClick={handleExportCsv}>
                导出当前筛选 CSV
              </Button>
            </Space>
          }
        >
          <div className="results-panel-scroll">
            {batchDetail.loading ? (
              <Spin />
            ) : batchDetail.data ? (
              <Table
                rowKey="key"
                size="small"
                dataSource={filteredTaskRows}
                pagination={false}
                scroll={{ x: 960 }}
                expandable={{
                  expandedRowRender: (item) => (
                    <div className="results-row-detail">
                      <div>
                        <Typography.Text className="section-eyebrow">输入参数</Typography.Text>
                        <pre className="payload-preview">{JSON.stringify(item.row.payload, null, 2)}</pre>
                      </div>
                      <div>
                        <Typography.Text className="section-eyebrow">输出结果</Typography.Text>
                        <pre className="payload-preview">{JSON.stringify(item.outputs, null, 2)}</pre>
                      </div>
                    </div>
                  ),
                }}
                columns={[
                  { title: "#", dataIndex: ["row", "row_index"], width: 66 },
                  {
                    title: "Profile",
                    dataIndex: "profileId",
                    width: 150,
                    render: (value: string) => value || "--",
                  },
                  {
                    title: "状态",
                    dataIndex: "status",
                    width: 110,
                    render: (value: string) => <Tag color={statusColor(value)}>{statusLabel(value)}</Tag>,
                  },
                  {
                    title: "执行结果",
                    render: (_value: unknown, item) =>
                      item.error ? (
                        <Typography.Text type="danger">{item.error}</Typography.Text>
                      ) : (
                        <Typography.Text type="secondary">
                          {item.status === "succeeded" ? "执行成功" : "暂无错误"}
                        </Typography.Text>
                      ),
                  },
                  {
                    title: "关键输入",
                    width: 240,
                    render: (_value: unknown, item) => {
                      const entries = Object.entries(item.row.payload).slice(0, 3);
                      return entries.length ? (
                        <Space size={[4, 4]} wrap>
                          {entries.map(([key, value]) => (
                            <Tag key={key}>
                              {key}: {String(value)}
                            </Tag>
                          ))}
                        </Space>
                      ) : "--";
                    },
                  },
                ]}
              />
            ) : (
              <Empty description="选择左侧批次查看详情" />
            )}
          </div>
        </SectionCard>
      </div>
    </div>
  );
}
