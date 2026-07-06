import { Button, Form, Input, InputNumber, Select, Space, Spin, Table, Tag, message } from "antd";
import { useEffect, useMemo } from "react";
import { api } from "../api/client";
import { SectionCard } from "../components/SectionCard";
import { usePolling } from "../hooks/usePolling";

export function SchedulesPage() {
  const providers = usePolling(api.listProviders, 10000);
  const workflows = usePolling(api.listWorkflows, 10000);
  const schedules = usePolling(api.listSchedules, 8000);
  const [form] = Form.useForm();
  const defaultTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";

  const providerOptions = useMemo(
    () => (providers.data ?? []).map((item) => ({ value: item.provider_type, label: item.display_name })),
    [providers.data],
  );
  const workflowOptions = useMemo(
    () => (workflows.data ?? []).map((item) => ({ value: item.id, label: item.name })),
    [workflows.data],
  );

  useEffect(() => {
    if (!form.getFieldValue("provider_type") && providers.data?.length) {
      form.setFieldValue("provider_type", providers.data[0].provider_type);
    }
  }, [form, providers.data]);

  const handleCreate = async () => {
    try {
      const values = await form.validateFields();
      const { input_rows_json: inputRowsJson, ...scheduleValues } = values;
      let inlineRows: unknown;
      try {
        inlineRows = JSON.parse(inputRowsJson || "[]");
      } catch {
        throw new Error("输入行 JSON 格式不正确，请填写数组，例如 [{\"keyword\":\"Bags\"}]");
      }
      if (!Array.isArray(inlineRows)) {
        throw new Error("输入行必须是 JSON 数组，例如 [{\"keyword\":\"Bags\"}]");
      }
      await api.createSchedule({
        ...scheduleValues,
        enabled: true,
        profile_policy_snapshot: { selection_mode: "all_profiles", profile_ids: [] },
        input_source: { inline_rows: inlineRows },
        retry_once_on_failure: true,
      });
      message.success("定时任务已创建");
      form.resetFields();
    } catch (cause) {
      if (cause instanceof Error) {
        message.error(cause.message);
      }
    }
  };

  if (providers.loading || workflows.loading || schedules.loading) {
    return <Spin size="large" />;
  }

  return (
    <Space direction="vertical" size={24} style={{ width: "100%" }}>
      <SectionCard title="轻量本机定时" subtitle="一次性、每天、每周和 Cron 都由 sidecar 内的 APScheduler 驱动。">
        <Form
          form={form}
          layout="vertical"
          initialValues={{
            schedule_type: "daily",
            schedule_expr: "09:30",
            timezone: defaultTimezone,
            max_concurrency: 1,
            input_rows_json: '[{"keyword":"Bags"}]',
          }}
        >
          <Form.Item name="name" label="名称" rules={[{ required: true }]}>
            <Input placeholder="早班巡检" />
          </Form.Item>
          <Form.Item name="provider_type" label="Provider" rules={[{ required: true }]}>
            <Select style={{ width: 240 }} options={providerOptions} />
          </Form.Item>
          <Form.Item name="workflow_id" label="流程模板" rules={[{ required: true }]}>
            <Select style={{ width: 240 }} options={workflowOptions} />
          </Form.Item>
          <Form.Item name="schedule_type" label="类型">
            <Select
              style={{ width: 140 }}
              options={[
                { value: "once", label: "一次性" },
                { value: "daily", label: "每天" },
                { value: "weekly", label: "每周" },
                { value: "cron", label: "Cron" },
              ]}
            />
          </Form.Item>
          <Form.Item name="schedule_expr" label="表达式" rules={[{ required: true }]}>
            <Input placeholder="09:30 / mon|09:30 / 0 30 9 * * ?" />
          </Form.Item>
          <Form.Item name="timezone" label="时区">
            <Input style={{ width: 160 }} />
          </Form.Item>
          <Form.Item name="max_concurrency" label="并发槽位">
            <InputNumber min={1} max={10} />
          </Form.Item>
          <Form.Item name="input_rows_json" label="输入行 JSON" rules={[{ required: true }]}>
            <Input.TextArea
              rows={3}
              style={{ width: 360 }}
              placeholder='[{"keyword":"Bags","profile_id":"可选"}]'
            />
          </Form.Item>
          <Button type="primary" onClick={() => void handleCreate()}>
            创建计划
          </Button>
        </Form>
      </SectionCard>

      <SectionCard title="计划列表" subtitle="应用未运行时不会主动唤醒系统，重启后会提示错过的计划。">
        <Table
          rowKey="id"
          dataSource={schedules.data ?? []}
          columns={[
            { title: "名称", dataIndex: "name" },
            { title: "表达式", dataIndex: "schedule_expr" },
            { title: "类型", dataIndex: "schedule_type" },
            { title: "Provider", dataIndex: "provider_type" },
            {
              title: "状态",
              dataIndex: "status",
              render: (value: string) => <Tag color={value === "enabled" ? "green" : "default"}>{value}</Tag>,
            },
          ]}
        />
      </SectionCard>
    </Space>
  );
}
