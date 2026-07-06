import { Button, Form, InputNumber, Select, Space, Spin, Table, Tag, Upload, message } from "antd";
import { UploadCloud } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { api } from "../api/client";
import { SectionCard } from "../components/SectionCard";
import { usePolling } from "../hooks/usePolling";

export function BatchesPage() {
  const providers = usePolling(api.listProviders, 12000);
  const workflows = usePolling(api.listWorkflows, 12000);
  const batches = usePolling(api.listBatches, 7000);
  const [uploading, setUploading] = useState(false);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [form] = Form.useForm();

  const providerOptions = useMemo(
    () => (providers.data ?? []).map((item) => ({ value: item.provider_type, label: item.display_name })),
    [providers.data],
  );
  const workflowOptions = useMemo(
    () => (workflows.data ?? []).map((item) => ({ value: item.id, label: item.name })),
    [workflows.data],
  );

  const importProps = {
    maxCount: 1,
    beforeUpload: () => false,
    showUploadList: true,
    onChange: (info: { fileList: Array<{ originFileObj?: File }> }) => {
      setSelectedFile(info.fileList[0]?.originFileObj ?? null);
    },
  };

  const handleUpload = useCallback(async (file?: File) => {
    if (!file) {
      message.warning("先选择一个 CSV 或 Excel 文件");
      return;
    }
    setUploading(true);
    try {
      const result = await api.importBatch(file, form.getFieldValue("provider_type") ?? "ixbrowser");
      setSelectedBatchId(result.batch.id);
      message.success(`已导入 ${result.batch.total_rows} 行数据`);
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "导入失败");
    } finally {
      setUploading(false);
    }
  }, [form]);

  const handleStart = async () => {
    if (!selectedBatchId) {
      message.warning("请先导入一个批次文件");
      return;
    }
    try {
      await api.startBatch(selectedBatchId, {
        workflow_id: form.getFieldValue("workflow_id"),
        provider_type: form.getFieldValue("provider_type"),
        profile_policy_snapshot: {
          selection_mode: "explicit_profiles",
          profile_ids: [],
        },
        runtime_mode: "visual",
        requested_slots: form.getFieldValue("requested_slots"),
      });
      message.success("批次已进入运行队列");
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "启动失败");
    }
  };

  if (providers.loading || workflows.loading || batches.loading) {
    return <Spin size="large" />;
  }

  return (
    <Space direction="vertical" size={24} style={{ width: "100%" }}>
      <SectionCard title="批次导入与启动" subtitle="先导入数据，再绑定流程模板和 Provider，最后配置可视槽位数。">
        <Form
          form={form}
          layout="vertical"
          initialValues={{ provider_type: "ixbrowser", requested_slots: 6 }}
        >
          <Space align="start" size={24} wrap>
            <Form.Item label="Provider" name="provider_type">
              <Select style={{ width: 200 }} options={providerOptions} />
            </Form.Item>
            <Form.Item label="流程模板" name="workflow_id">
              <Select style={{ width: 280 }} options={workflowOptions} />
            </Form.Item>
            <Form.Item label="槽位数" name="requested_slots">
              <InputNumber min={1} max={10} />
            </Form.Item>
            <Form.Item label="批量文件">
              <Upload {...importProps}>
                <Button icon={<UploadCloud size={16} />}>选择 CSV / Excel</Button>
              </Upload>
            </Form.Item>
          </Space>
        </Form>
        <Space>
          <Button
            type="default"
            loading={uploading}
            onClick={() => void handleUpload(selectedFile ?? undefined)}
          >
            导入草稿批次
          </Button>
          <Button type="primary" onClick={() => void handleStart()}>
            启动批次
          </Button>
        </Space>
      </SectionCard>

      <SectionCard title="批次列表" subtitle="Visual Mode 下会按槽位池打开、平铺、执行、关闭，并立即补位。">
        <Table
          rowKey="id"
          dataSource={batches.data ?? []}
          columns={[
            { title: "批次", dataIndex: "name" },
            { title: "Provider", dataIndex: "provider_type" },
            { title: "总行数", dataIndex: "total_rows" },
            {
              title: "状态",
              dataIndex: "status",
              render: (value: string) => <Tag color={value === "completed" ? "green" : value === "failed" ? "red" : "gold"}>{value}</Tag>,
            },
            {
              title: "动作",
              render: (_, item) => (
                <Space>
                  <Button size="small" onClick={() => api.pauseBatch(item.id)}>暂停</Button>
                  <Button size="small" onClick={() => api.resumeBatch(item.id)}>继续</Button>
                  <Button size="small" danger onClick={() => api.cancelBatch(item.id)}>取消</Button>
                </Space>
              ),
            },
          ]}
        />
      </SectionCard>
    </Space>
  );
}
