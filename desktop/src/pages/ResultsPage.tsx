import { Button, Card, Col, Empty, Input, Row, Space, Spin, Table, Tag, Typography } from "antd";
import { useCallback, useMemo, useState } from "react";
import { api } from "../api/client";
import { MetricCard } from "../components/MetricCard";
import { SectionCard } from "../components/SectionCard";
import { usePolling } from "../hooks/usePolling";

export function ResultsPage() {
  const batches = usePolling(api.listBatches, 7000);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const batchDetailFetcher = useCallback(
    () => (selectedBatchId ? api.getResultBatch(selectedBatchId) : Promise.resolve(null)),
    [selectedBatchId],
  );
  const batchDetail = usePolling(batchDetailFetcher, 7000);

  const selectedBatch = useMemo(
    () => batches.data?.find((item) => item.id === selectedBatchId) ?? batches.data?.[0] ?? null,
    [batches.data, selectedBatchId],
  );

  if (batches.loading) {
    return <Spin size="large" />;
  }

  return (
    <Space direction="vertical" size={24} style={{ width: "100%" }}>
      <SectionCard title="批次结果看板" subtitle="先从整批成功率、失败分布和导出入口看，再钻进单任务时间线。">
        {selectedBatch ? (
          <Row gutter={[16, 16]}>
            <Col xs={24} md={12} xl={6}>
              <MetricCard title="总任务数" value={selectedBatch.total_rows} tone="warm" />
            </Col>
            <Col xs={24} md={12} xl={6}>
              <MetricCard title="成功数" value={selectedBatch.success_count} tone="cool" />
            </Col>
            <Col xs={24} md={12} xl={6}>
              <MetricCard title="失败数" value={selectedBatch.failure_count} />
            </Col>
            <Col xs={24} md={12} xl={6}>
              <MetricCard
                title="成功率"
                value={selectedBatch.total_rows ? Math.round((selectedBatch.success_count / selectedBatch.total_rows) * 100) : 0}
                suffix="%"
              />
            </Col>
          </Row>
        ) : (
          <Empty description="还没有批次结果" />
        )}
      </SectionCard>

      <Row gutter={[24, 24]}>
        <Col xs={24} xl={10}>
          <SectionCard title="批次列表" subtitle="选择一个批次查看行级输入与结果摘要。">
            <Table
              rowKey="id"
              dataSource={batches.data ?? []}
              pagination={false}
              onRow={(record) => ({ onClick: () => setSelectedBatchId(record.id) })}
              columns={[
                { title: "批次", dataIndex: "name" },
                {
                  title: "状态",
                  dataIndex: "status",
                  render: (value: string) => <Tag color={value === "completed" ? "green" : value === "failed" ? "red" : "gold"}>{value}</Tag>,
                },
                { title: "Provider", dataIndex: "provider_type" },
              ]}
            />
          </SectionCard>
        </Col>
        <Col xs={24} xl={14}>
          <SectionCard title="输入行与导出" subtitle="导出失败明细、关键截图路径、下载文件路径等复盘数据。">
            {batchDetail.loading ? (
              <Spin />
            ) : batchDetail.data ? (
              <Space direction="vertical" size={18} style={{ width: "100%" }}>
                <Space wrap>
                  <Input value={batchDetail.data.id} readOnly style={{ width: 260 }} />
                  <Button>导出 CSV</Button>
                  <Button>导出 Excel</Button>
                  <Button>仅重跑失败任务</Button>
                </Space>
                <Typography.Paragraph type="secondary">
                  当前实现已经把结果和步骤状态持久化到本地 SQLite，下一步可以在这里追加单任务时间线与截图预览联动。
                </Typography.Paragraph>
                <Table
                  rowKey={(item) => `${batchDetail.data?.id}-${item.row_index}`}
                  dataSource={batchDetail.data.rows}
                  columns={[
                    { title: "#", dataIndex: "row_index", width: 72 },
                    { title: "去重键", dataIndex: "dedupe_key" },
                    {
                      title: "数据",
                      render: (_, item) => <pre className="payload-preview">{JSON.stringify(item.payload, null, 2)}</pre>,
                    },
                  ]}
                />
              </Space>
            ) : (
              <Empty description="选择左侧批次查看详情" />
            )}
          </SectionCard>
        </Col>
      </Row>
    </Space>
  );
}
