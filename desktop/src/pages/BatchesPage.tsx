import { Alert, Button, Form, InputNumber, Modal, Select, Space, Spin, Table, Tag, Typography, Upload, message } from "antd";
import { Download, UploadCloud } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { SectionCard } from "../components/SectionCard";
import { usePolling } from "../hooks/usePolling";
import type { BatchSummary, ProfileRecord, ProviderGroupRecord, WorkflowRecord } from "../types";
import { statusColor, statusLabel } from "../utils/status";

function safeFileName(value: string) {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "_")
    .slice(0, 80) || "profile_input_template";
}

function downloadBlob(fileName: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function profileGroupId(profile: ProfileRecord) {
  const raw = profile.group_summary?.id;
  return raw === null || raw === undefined || raw === "" ? "__ungrouped__" : String(raw);
}

function workflowRunGroupIds(workflow: WorkflowRecord | null | undefined) {
  const policy = workflow?.normalized_workflow_json?.profile_policy;
  if (!policy || typeof policy !== "object") {
    return [];
  }
  const groupIds = (policy as Record<string, unknown>).group_ids;
  return Array.isArray(groupIds) ? groupIds.map(String).filter(Boolean) : [];
}

function countProfilesInGroups(profiles: ProfileRecord[] | null | undefined, groupIds: string[]) {
  const groupSet = new Set(groupIds);
  return (profiles ?? []).filter((profile) => groupSet.has(profileGroupId(profile))).length;
}

function groupSummaryLabel(groups: ProviderGroupRecord[] | null | undefined, groupIds: string[]) {
  if (!groupIds.length) {
    return "未关联 Profile 组";
  }
  const nameById = new Map((groups ?? []).map((group) => [String(group.external_group_id), group.display_name]));
  return groupIds
    .slice(0, 5)
    .map((id) => nameById.get(id) ?? id)
    .join("、") + (groupIds.length > 5 ? ` 等 ${groupIds.length} 组` : "");
}

export function BatchesPage() {
  const providers = usePolling(api.listProviders, 12000);
  const workflows = usePolling(api.listWorkflows, 12000);
  const [batchReloadKey, setBatchReloadKey] = useState(0);
  const batchesFetcher = useCallback(() => api.listBatches(), [batchReloadKey]);
  const batches = usePolling(batchesFetcher, 7000);
  const [uploading, setUploading] = useState(false);
  const [batchActionLoadingId, setBatchActionLoadingId] = useState<string | null>(null);
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
  const selectedWorkflowId = Form.useWatch("workflow_id", form);
  const selectedProviderType = Form.useWatch("provider_type", form);
  const selectedWorkflow = useMemo(
    () => (workflows.data ?? []).find((workflow) => workflow.id === selectedWorkflowId) ?? null,
    [selectedWorkflowId, workflows.data],
  );
  const selectedWorkflowProviderType = selectedWorkflow?.target_provider_type ?? selectedProviderType;
  const groupsFetcher = useCallback(
    () => (selectedWorkflowProviderType ? api.listProviderGroups(selectedWorkflowProviderType) : Promise.resolve([])),
    [selectedWorkflowProviderType],
  );
  const profilesFetcher = useCallback(
    () =>
      selectedWorkflowProviderType
        ? api.listProfiles(selectedWorkflowProviderType, { managed_only: true })
        : Promise.resolve([]),
    [selectedWorkflowProviderType],
  );
  const providerGroups = usePolling(groupsFetcher, 12000);
  const providerProfiles = usePolling(profilesFetcher, 12000);
  const selectedWorkflowGroupIds = useMemo(() => workflowRunGroupIds(selectedWorkflow), [selectedWorkflow]);
  const selectedWorkflowProfileCount = useMemo(
    () => countProfilesInGroups(providerProfiles.data, selectedWorkflowGroupIds),
    [providerProfiles.data, selectedWorkflowGroupIds],
  );
  const selectedWorkflowGroupSummary = useMemo(
    () => groupSummaryLabel(providerGroups.data, selectedWorkflowGroupIds),
    [providerGroups.data, selectedWorkflowGroupIds],
  );

  useEffect(() => {
    if (!form.getFieldValue("provider_type") && providers.data?.length) {
      form.setFieldValue("provider_type", providers.data[0].provider_type);
    }
  }, [form, providers.data]);

  useEffect(() => {
    if (selectedWorkflow?.target_provider_type && selectedWorkflow.target_provider_type !== form.getFieldValue("provider_type")) {
      form.setFieldValue("provider_type", selectedWorkflow.target_provider_type);
    }
  }, [form, selectedWorkflow]);

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
      const providerType = form.getFieldValue("provider_type");
      const workflowId = form.getFieldValue("workflow_id");
      if (!providerType) {
        throw new Error("请先选择 Provider");
      }
      if (!workflowId) {
        throw new Error("请先选择流程模板");
      }
      const result = await api.importBatch(file, providerType, workflowId);
      setSelectedBatchId(result.batch.id);
      setBatchReloadKey((value) => value + 1);
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
    if (!selectedWorkflow) {
      message.warning("请先选择流程模板");
      return;
    }
    if (!selectedWorkflowGroupIds.length) {
      message.error("当前流程未关联 Profile 组，无法启动批次。请先到流程列表里点击“关联 Profile 组”。");
      return;
    }
    if (providerProfiles.loading || providerGroups.loading) {
      message.info("正在读取流程绑定的 Profile 组，请稍等几秒后再启动。");
      return;
    }
    if (selectedWorkflowProfileCount <= 0) {
      message.error("当前流程绑定的 Profile 组没有命中可管理 Profile，请检查 Provider 管理范围。");
      return;
    }
    Modal.confirm({
      title: "确认启动这个批次？",
      okText: "确认启动",
      cancelText: "取消",
      content: (
        <Space direction="vertical" size={8}>
          <Typography.Text>流程：{selectedWorkflow.name}</Typography.Text>
          <Typography.Text>Profile 组：{selectedWorkflowGroupSummary}</Typography.Text>
          <Typography.Text>可运行 Profile：{selectedWorkflowProfileCount} 个</Typography.Text>
          <Typography.Text>并发槽位：{form.getFieldValue("requested_slots") ?? 6}</Typography.Text>
        </Space>
      ),
      onOk: async () => {
        try {
          await api.startBatch(selectedBatchId, {
            workflow_id: form.getFieldValue("workflow_id"),
            provider_type: form.getFieldValue("provider_type"),
            profile_policy_snapshot: {},
            runtime_mode: "visual",
            requested_slots: form.getFieldValue("requested_slots"),
          });
          setBatchReloadKey((value) => value + 1);
          message.success("批次已进入运行队列");
        } catch (cause) {
          message.error(cause instanceof Error ? cause.message : "启动失败");
        }
      },
    });
  };

  const handleDownloadTemplate = async () => {
    if (!selectedWorkflowId || !selectedWorkflow) {
      message.warning("请先选择流程模板");
      return;
    }
    try {
      const blob = await api.downloadWorkflowInputTemplate(selectedWorkflowId);
      downloadBlob(`${safeFileName(selectedWorkflow.name)}_流程参数模板.xlsx`, blob);
      message.success("模板已导出");
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "导出模板失败");
    }
  };

  const handleCancelBatch = (batch: BatchSummary) => {
    Modal.confirm({
      title: "确认取消这个批次？",
      content: "取消后正在运行的窗口会尽快收口，未完成任务会标记为已取消。",
      okText: "确认取消",
      cancelText: "再想想",
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          setBatchActionLoadingId(batch.id);
          await api.cancelBatch(batch.id);
          setBatchReloadKey((value) => value + 1);
          message.success("批次已取消");
        } catch (cause) {
          message.error(cause instanceof Error ? cause.message : "取消失败");
        } finally {
          setBatchActionLoadingId(null);
        }
      },
    });
  };

  const handleRetryBatch = async (batch: BatchSummary) => {
    try {
      setBatchActionLoadingId(batch.id);
      let workflow = (workflows.data ?? []).find((item) => item.id === batch.workflow_id) ?? null;
      if (!workflow) {
        workflow = await api.getWorkflow(batch.workflow_id);
      }
      const groupIds = workflowRunGroupIds(workflow);
      if (!groupIds.length) {
        throw new Error("当前流程未关联 Profile 组，无法重试。请先到流程列表里关联 Profile 组。");
      }
      const [groups, profiles] = await Promise.all([
        api.listProviderGroups(batch.provider_type),
        api.listProfiles(batch.provider_type, { managed_only: true }),
      ]);
      const profileCount = countProfilesInGroups(profiles, groupIds);
      if (profileCount <= 0) {
        throw new Error("当前流程绑定的 Profile 组没有命中可管理 Profile，请检查 Provider 管理范围。");
      }
      Modal.confirm({
        title: "确认重试这个失败批次？",
        okText: "确认重试",
        cancelText: "取消",
        content: (
          <Space direction="vertical" size={8}>
            <Typography.Text>流程：{workflow.name}</Typography.Text>
            <Typography.Text>Profile 组：{groupSummaryLabel(groups, groupIds)}</Typography.Text>
            <Typography.Text>可运行 Profile：{profileCount} 个</Typography.Text>
            <Typography.Text>表格数据：{batch.total_rows} 行</Typography.Text>
            <Typography.Text type="secondary">重试会清理该批次旧的运行记录，并按当前流程和原表格重新执行。</Typography.Text>
          </Space>
        ),
        onOk: async () => {
          try {
            await api.startBatch(batch.id, {
              workflow_id: batch.workflow_id,
              provider_type: batch.provider_type,
              profile_policy_snapshot: {},
              runtime_mode: "visual",
              requested_slots: form.getFieldValue("requested_slots") ?? 6,
            });
            setBatchReloadKey((value) => value + 1);
            message.success("批次已重新进入运行队列");
          } catch (cause) {
            message.error(cause instanceof Error ? cause.message : "重试失败");
          } finally {
            setBatchActionLoadingId(null);
          }
        },
        onCancel: () => setBatchActionLoadingId(null),
      });
    } catch (cause) {
      setBatchActionLoadingId(null);
      message.error(cause instanceof Error ? cause.message : "重试失败");
    }
  };

  if (providers.loading || workflows.loading || batches.loading) {
    return <Spin size="large" />;
  }

  return (
    <Space direction="vertical" size={24} style={{ width: "100%" }}>
      <SectionCard title="批次导入与启动" subtitle="先导入数据，再绑定流程模板和 Provider，最后配置可视槽位数。">
        <Alert
          showIcon
          type="info"
          style={{ marginBottom: 14 }}
          message="Excel 必须包含 profile_id 列"
          description="每一行 profile_id 会绑定一个指纹浏览器窗口，槽位数只控制同时打开数量。模板可在批量文件区域下载。"
        />
        <Form
          form={form}
          layout="vertical"
          initialValues={{ requested_slots: 6 }}
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
              <Space direction="vertical" size={6}>
                <Upload {...importProps}>
                  <Button icon={<UploadCloud size={16} />}>选择 CSV / Excel</Button>
                </Upload>
                <Button
                  type="text"
                  size="small"
                  icon={<Download size={14} />}
                  disabled={!selectedWorkflowId}
                  onClick={() => void handleDownloadTemplate()}
                >
                  下载流程参数模板
                </Button>
              </Space>
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
              render: (value: string) => <Tag color={statusColor(value)}>{statusLabel(value)}</Tag>,
            },
            {
              title: "动作",
              render: (_, item: BatchSummary) => {
                if (["ready", "running", "paused"].includes(item.status)) {
                  return (
                    <Button
                      size="small"
                      danger
                      loading={batchActionLoadingId === item.id}
                      onClick={() => handleCancelBatch(item)}
                    >
                      取消
                    </Button>
                  );
                }
                if (item.status === "failed") {
                  return (
                    <Button
                      size="small"
                      loading={batchActionLoadingId === item.id}
                      onClick={() => void handleRetryBatch(item)}
                    >
                      重试
                    </Button>
                  );
                }
                return null;
              },
            },
          ]}
        />
      </SectionCard>
    </Space>
  );
}
