import { Button, Form, InputNumber, Modal, Select, Space, Spin, Table, Typography, Upload, message } from "antd";
import type { UploadProps } from "antd";
import { UploadCloud } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { SectionCard } from "../components/SectionCard";
import { StatusBadge } from "../components/StatusBadge";
import { TableActionMenu } from "../components/TableActionMenu";
import { usePolling } from "../hooks/usePolling";
import type { BatchSummary, ProfileRecord, ProviderGroupRecord, WorkflowRecord } from "../types";

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
    return "未绑定指纹窗口组";
  }
  const nameById = new Map((groups ?? []).map((group) => [String(group.external_group_id), group.display_name]));
  return groupIds
    .slice(0, 5)
    .map((id) => nameById.get(id) ?? id)
    .join("、") + (groupIds.length > 5 ? ` 等 ${groupIds.length} 组` : "");
}

export function BatchesPage() {
  const providers = usePolling(api.listProviders, { intervalMs: 12000, cacheKey: "providers:list" });
  const workflows = usePolling(api.listWorkflows, { intervalMs: 12000, cacheKey: "workflows:list:all" });
  const [batchReloadKey, setBatchReloadKey] = useState(0);
  const batchesFetcher = useCallback(() => api.listBatches(), [batchReloadKey]);
  const batches = usePolling(batchesFetcher, { intervalMs: 7000, cacheKey: "batches:list" });
  const [uploading, setUploading] = useState(false);
  const [batchActionLoadingId, setBatchActionLoadingId] = useState<string | null>(null);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [importedFileName, setImportedFileName] = useState("");
  const [form] = Form.useForm();

  const providerOptions = useMemo(
    () => (providers.data ?? []).map((item) => ({ value: item.provider_type, label: item.display_name })),
    [providers.data],
  );
  const providerNameByType = useMemo(
    () => new Map((providers.data ?? []).map((item) => [item.provider_type, item.display_name])),
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
  const providerGroups = usePolling(groupsFetcher, {
    intervalMs: 12000,
    cacheKey: `provider:${selectedWorkflowProviderType || "none"}:groups`,
    enabled: Boolean(selectedWorkflowProviderType),
  });
  const providerProfiles = usePolling(profilesFetcher, {
    intervalMs: 12000,
    cacheKey: `provider:${selectedWorkflowProviderType || "none"}:profiles:managed`,
    enabled: Boolean(selectedWorkflowProviderType),
  });
  const selectedWorkflowGroupIds = useMemo(() => workflowRunGroupIds(selectedWorkflow), [selectedWorkflow]);
  const selectedWorkflowProfileCount = useMemo(
    () => countProfilesInGroups(providerProfiles.data, selectedWorkflowGroupIds),
    [providerProfiles.data, selectedWorkflowGroupIds],
  );
  const selectedWorkflowGroupSummary = useMemo(
    () => groupSummaryLabel(providerGroups.data, selectedWorkflowGroupIds),
    [providerGroups.data, selectedWorkflowGroupIds],
  );
  const selectedWorkflowProviderLabel =
    providerNameByType.get(selectedWorkflowProviderType ?? "") ?? selectedWorkflowProviderType ?? "未选择";

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

  const handleUpload = useCallback(async (file: File) => {
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
      setImportedFileName(file.name);
      setBatchReloadKey((value) => value + 1);
      message.success(`已导入 ${result.batch.total_rows} 行数据`);
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "导入失败");
    } finally {
      setUploading(false);
    }
  }, [form]);

  const importProps: UploadProps = {
    maxCount: 1,
    beforeUpload: (file) => {
      void handleUpload(file);
      return false;
    },
    showUploadList: false,
    disabled: uploading,
  };

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
      message.error("当前流程未绑定指纹窗口组，无法启动批次。请先到流程列表里点击“关联指纹窗口组”。");
      return;
    }
    if (providerProfiles.loading || providerGroups.loading) {
      message.info("正在读取流程绑定的指纹窗口组，请稍等几秒后再启动。");
      return;
    }
    if (selectedWorkflowProfileCount <= 0) {
      message.error("当前流程绑定的指纹窗口组没有命中可管理指纹窗口，请检查 Provider 管理范围。");
      return;
    }
    Modal.confirm({
      title: "确认启动这个批次？",
      okText: "确认启动",
      cancelText: "取消",
      content: (
        <Space direction="vertical" size={8}>
          <Typography.Text>流程：{selectedWorkflow.name}</Typography.Text>
          <Typography.Text>指纹浏览器：{selectedWorkflowProviderLabel}</Typography.Text>
          <Typography.Text>指纹窗口组：{selectedWorkflowGroupSummary}</Typography.Text>
          <Typography.Text>可运行指纹窗口：{selectedWorkflowProfileCount} 个</Typography.Text>
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
        throw new Error("当前流程未绑定指纹窗口组，无法重试。请先到流程列表里关联指纹窗口组。");
      }
      const [groups, profiles] = await Promise.all([
        api.listProviderGroups(batch.provider_type),
        api.listProfiles(batch.provider_type, { managed_only: true }),
      ]);
      const profileCount = countProfilesInGroups(profiles, groupIds);
      if (profileCount <= 0) {
        throw new Error("当前流程绑定的指纹窗口组没有命中可管理指纹窗口，请检查 Provider 管理范围。");
      }
      Modal.confirm({
        title: "确认重试这个失败批次？",
        okText: "确认重试",
        cancelText: "取消",
        content: (
          <Space direction="vertical" size={8}>
            <Typography.Text>流程：{workflow.name}</Typography.Text>
            <Typography.Text>指纹浏览器：{providerNameByType.get(batch.provider_type) ?? batch.provider_type}</Typography.Text>
            <Typography.Text>指纹窗口组：{groupSummaryLabel(groups, groupIds)}</Typography.Text>
            <Typography.Text>可运行指纹窗口：{profileCount} 个</Typography.Text>
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
    <div className="app-page batches-page task-subpage">
      <SectionCard title="即时任务" subtitle="导入 Excel 后立即生成批次，系统按槽位打开并执行指纹窗口。">
        <Form
          form={form}
          layout="vertical"
          initialValues={{ requested_slots: 6 }}
        >
          <div className="instant-task-designer">
            <div className="task-config-card task-config-card--wide">
              <div className="task-config-card__head">
                <div>
                  <Typography.Text className="section-eyebrow">执行对象</Typography.Text>
                  <Typography.Title level={5}>选择要运行的流程</Typography.Title>
                </div>
              </div>
              <div className="task-form-grid">
                <Form.Item label="指纹浏览器" name="provider_type">
                  <Select options={providerOptions} />
                </Form.Item>
                <Form.Item label="流程模板" name="workflow_id">
                  <Select options={workflowOptions} />
                </Form.Item>
                <Form.Item label="并发槽位" name="requested_slots">
                  <InputNumber min={1} max={10} style={{ width: "100%" }} />
                </Form.Item>
              </div>
            </div>

            <div className={`task-profile-summary${selectedWorkflowGroupIds.length ? " is-ready" : " is-warning"}`}>
              <Typography.Text className="section-eyebrow">指纹窗口组</Typography.Text>
              <Typography.Title level={5}>{selectedWorkflowGroupSummary}</Typography.Title>
              <Typography.Paragraph>
                {selectedWorkflowGroupIds.length
                  ? `${selectedWorkflowProviderLabel} 下预计命中 ${selectedWorkflowProfileCount} 个可管理指纹窗口。`
                  : "当前流程还没有绑定指纹窗口组，无法启动即时任务。"}
              </Typography.Paragraph>
            </div>

            <div className="task-config-card">
              <div className="task-config-card__head">
                <div>
                  <Typography.Text className="section-eyebrow">参数表格</Typography.Text>
                  <Typography.Title level={5}>一行对应一个指纹窗口</Typography.Title>
                </div>
              </div>
              <div className="task-upload-zone">
                <Upload {...importProps}>
                  <Button icon={<UploadCloud size={16} />} loading={uploading}>
                    选择并导入 CSV / Excel
                  </Button>
                </Upload>
                <Typography.Text type="secondary">
                  {importedFileName || "Excel 必须包含 profile_id 列；如需模板，请使用任务管理顶部的“下载流程参数模板”。"}
                </Typography.Text>
              </div>
            </div>
          </div>
        </Form>

        <div className="task-submit-bar">
          <div>
            <Typography.Text strong>启动前系统会再次校验 Provider、指纹窗口组和 Excel 映射。</Typography.Text>
            <Typography.Paragraph>槽位只控制同时打开窗口数量，全部合法行都会依次执行完成。</Typography.Paragraph>
          </div>
          <Button type="primary" size="large" onClick={() => void handleStart()}>
            启动批次
          </Button>
        </div>
      </SectionCard>

      <SectionCard title="即时任务列表" subtitle="Visual Mode 下会按槽位池打开、平铺、执行、关闭，并立即补位。">
        <Table
          className="task-list-table"
          rowKey="id"
          dataSource={batches.data ?? []}
          pagination={{ pageSize: 8, showSizeChanger: true }}
          columns={[
            { title: "批次", dataIndex: "name" },
            {
              title: "指纹浏览器",
              dataIndex: "provider_type",
              render: (value: string) => providerNameByType.get(value) ?? value,
            },
            { title: "总行数", dataIndex: "total_rows" },
            {
              title: "状态",
              dataIndex: "status",
              render: (value: string) => <StatusBadge status={value} />,
            },
            {
              title: "动作",
              render: (_, item: BatchSummary) => {
                if (["ready", "running", "paused"].includes(item.status)) {
                  return (
                    <TableActionMenu
                      loading={batchActionLoadingId === item.id}
                      primary={{
                        key: "cancel",
                        label: "取消",
                        danger: true,
                        onClick: () => handleCancelBatch(item),
                      }}
                    />
                  );
                }
                if (item.status === "failed") {
                  return (
                    <TableActionMenu
                      loading={batchActionLoadingId === item.id}
                      primary={{
                        key: "retry",
                        label: "重试",
                        onClick: () => void handleRetryBatch(item),
                      }}
                    />
                  );
                }
                return null;
              },
            },
          ]}
        />
      </SectionCard>
    </div>
  );
}
