import {
  Button,
  Checkbox,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Radio,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  TimePicker,
  Typography,
  Upload,
  message,
} from "antd";
import type { UploadProps } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { Plus, Trash2, UploadCloud } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { SectionCard } from "../components/SectionCard";
import { usePolling } from "../hooks/usePolling";
import type { ScheduleRecord } from "../types";

type ScheduleInputRow = {
  id: string;
  payload: Record<string, unknown>;
};

const BEIJING_TIMEZONE = "Asia/Shanghai";
const DEFAULT_INPUT_COLUMNS = ["keyword", "profile_id", "note"];
const INPUT_COLUMN_LABELS: Record<string, string> = {
  keyword: "关键词 keyword",
  profile_id: "Profile ID 可选",
  note: "备注",
};

const WEEKDAY_OPTIONS = [
  { label: "周一", value: "mon" },
  { label: "周二", value: "tue" },
  { label: "周三", value: "wed" },
  { label: "周四", value: "thu" },
  { label: "周五", value: "fri" },
  { label: "周六", value: "sat" },
  { label: "周日", value: "sun" },
];

const WEEKDAY_LABEL_BY_VALUE = Object.fromEntries(
  WEEKDAY_OPTIONS.map((item) => [item.value, item.label]),
) as Record<string, string>;

function defaultScheduleTime() {
  return dayjs().hour(9).minute(30).second(0).millisecond(0);
}

function rowToPayload(row: ScheduleInputRow) {
  return Object.fromEntries(
    Object.entries(row.payload)
      .map(([key, value]) => [key, normalizeCellValue(value)] as const)
      .filter(([, value]) => value !== ""),
  );
}

function createEmptyInputRow() {
  return {
    id: crypto.randomUUID(),
    payload: Object.fromEntries(DEFAULT_INPUT_COLUMNS.map((key) => [key, key === "keyword" ? "Bags" : ""])),
  };
}

function normalizeCellValue(value: unknown) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function normalizeImportedRows(rows: Record<string, unknown>[]) {
  return rows.map((row) => ({
    id: crypto.randomUUID(),
    payload: Object.fromEntries(Object.entries(row).map(([key, value]) => [String(key), normalizeCellValue(value)])),
  }));
}

function formatScheduleType(type: string) {
  if (type === "once") {
    return "一次性";
  }
  if (type === "daily") {
    return "每天";
  }
  if (type === "weekly") {
    return "每周";
  }
  return "自定义";
}

function formatScheduleExpr(record: Pick<ScheduleRecord, "schedule_type" | "schedule_expr">) {
  if (record.schedule_type === "once") {
    const parsed = dayjs(record.schedule_expr);
    return parsed.isValid() ? parsed.format("YYYY-MM-DD HH:mm") : record.schedule_expr;
  }
  if (record.schedule_type === "daily") {
    return `每天 ${record.schedule_expr}`;
  }
  if (record.schedule_type === "weekly") {
    const [daysPart, timePart] = record.schedule_expr.split("|");
    const days = daysPart
      .split(",")
      .map((day) => WEEKDAY_LABEL_BY_VALUE[day] ?? day)
      .join("、");
    return `每周 ${days} ${timePart ?? ""}`.trim();
  }
  return record.schedule_expr;
}

function formatDateTime(value?: string | null) {
  if (!value) {
    return "暂未生成";
  }
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format("YYYY-MM-DD HH:mm") : value;
}

export function SchedulesPage() {
  const providers = usePolling(api.listProviders, 10000);
  const workflows = usePolling(api.listWorkflows, 10000);
  const schedules = usePolling(api.listSchedules, 8000);
  const [form] = Form.useForm();
  const scheduleType = Form.useWatch("schedule_type", form) ?? "daily";
  const [inputRows, setInputRows] = useState<ScheduleInputRow[]>([createEmptyInputRow()]);
  const [importingInput, setImportingInput] = useState(false);
  const [inputFileName, setInputFileName] = useState<string | null>(null);
  const [detectedColumns, setDetectedColumns] = useState<string[]>(DEFAULT_INPUT_COLUMNS);

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

  const inputColumnKeys = useMemo(() => {
    const keys = new Set(detectedColumns.length ? detectedColumns : DEFAULT_INPUT_COLUMNS);
    inputRows.forEach((row) => {
      Object.keys(row.payload).forEach((key) => keys.add(key));
    });
    return Array.from(keys);
  }, [detectedColumns, inputRows]);
  const previewInputRows = useMemo(() => inputRows.slice(0, 5), [inputRows]);

  const updateInputCell = (id: string, key: string, value: string) => {
    setInputRows((rows) =>
      rows.map((row) => (row.id === id ? { ...row, payload: { ...row.payload, [key]: value } } : row)),
    );
  };

  const addInputRow = () => {
    setInputRows((rows) => [
      ...rows,
      {
        id: crypto.randomUUID(),
        payload: Object.fromEntries(inputColumnKeys.map((key) => [key, ""])),
      },
    ]);
  };

  const removeInputRow = (id: string) => {
    setInputRows((rows) => (rows.length > 1 ? rows.filter((row) => row.id !== id) : rows));
  };

  const resetInputRows = () => {
    setInputRows([createEmptyInputRow()]);
    setDetectedColumns(DEFAULT_INPUT_COLUMNS);
    setInputFileName(null);
  };

  const handleImportInputFile = async (file: File) => {
    setImportingInput(true);
    try {
      const result = await api.parseScheduleInputFile(file);
      if (!result.rows.length) {
        throw new Error("文件没有可导入的数据行");
      }
      setInputRows(normalizeImportedRows(result.rows));
      setDetectedColumns(result.detected_columns.length ? result.detected_columns : Object.keys(result.rows[0] ?? {}));
      setInputFileName(file.name);
      message.success(`已导入 ${result.total_rows} 行数据`);
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "导入失败");
    } finally {
      setImportingInput(false);
    }
  };

  const uploadProps: UploadProps = {
    accept: ".csv,.txt,.xlsx,.xlsm",
    beforeUpload: (file) => {
      void handleImportInputFile(file);
      return false;
    },
    maxCount: 1,
    showUploadList: false,
  };

  const buildScheduleExpr = (values: Record<string, unknown>) => {
    const type = String(values.schedule_type ?? "daily");
    const time = values.schedule_time as Dayjs | undefined;
    if (!time) {
      throw new Error("请选择执行时间");
    }
    if (type === "once") {
      const onceDate = values.once_date as Dayjs | undefined;
      if (!onceDate) {
        throw new Error("请选择执行日期");
      }
      return `${onceDate.format("YYYY-MM-DD")}T${time.format("HH:mm")}:00`;
    }
    if (type === "weekly") {
      const days = values.weekly_days as string[] | undefined;
      if (!days?.length) {
        throw new Error("请选择每周执行日期");
      }
      return `${days.join(",")}|${time.format("HH:mm")}`;
    }
    return time.format("HH:mm");
  };

  const handleCreate = async () => {
    try {
      const values = await form.validateFields();
      const inlineRows = inputRows.map(rowToPayload).filter((row) => Object.keys(row).length > 0);
      if (!inlineRows.length) {
        throw new Error("请至少填写一行表格数据");
      }
      await api.createSchedule({
        name: values.name,
        provider_type: values.provider_type,
        workflow_id: values.workflow_id,
        schedule_type: values.schedule_type,
        schedule_expr: buildScheduleExpr(values),
        timezone: BEIJING_TIMEZONE,
        max_concurrency: values.max_concurrency,
        enabled: true,
        profile_policy_snapshot: { selection_mode: "all_profiles", profile_ids: [] },
        input_source: { inline_rows: inlineRows },
        retry_once_on_failure: true,
      });
      message.success("定时任务已创建");
      form.resetFields();
      resetInputRows();
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
      <SectionCard title="轻量本机定时" subtitle="默认北京时间；选择流程、设置节奏、填写表格数据后即可生成计划。">
        <Form
          form={form}
          layout="vertical"
          initialValues={{
            schedule_type: "daily",
            schedule_time: defaultScheduleTime(),
            once_date: dayjs().add(1, "day"),
            weekly_days: ["mon"],
            max_concurrency: 1,
          }}
        >
          <div className="schedule-designer">
            <div className="schedule-panel">
              <div className="schedule-panel-heading">
                <div>
                  <Typography.Text className="section-eyebrow">基础信息</Typography.Text>
                  <Typography.Title level={5}>计划要执行什么</Typography.Title>
                </div>
              </div>
              <div className="schedule-form-grid">
                <Form.Item name="name" label="计划名称" rules={[{ required: true, message: "请输入计划名称" }]}>
                  <Input placeholder="早班巡检" />
                </Form.Item>
                <Form.Item name="provider_type" label="浏览器 Provider" rules={[{ required: true }]}>
                  <Select options={providerOptions} />
                </Form.Item>
                <Form.Item name="workflow_id" label="流程" rules={[{ required: true, message: "请选择流程" }]}>
                  <Select options={workflowOptions} />
                </Form.Item>
                <Form.Item name="max_concurrency" label="并发槽位">
                  <InputNumber min={1} max={10} style={{ width: "100%" }} />
                </Form.Item>
              </div>
            </div>

            <div className="schedule-panel">
              <div className="schedule-panel-heading">
                <div>
                  <Typography.Text className="section-eyebrow">执行时间</Typography.Text>
                  <Typography.Title level={5}>什么时候自动运行</Typography.Title>
                </div>
              </div>
              <div className="schedule-type-switch">
                <Form.Item name="schedule_type" label="类型">
                  <Radio.Group
                    buttonStyle="solid"
                    options={[
                      { value: "once", label: "一次性" },
                      { value: "daily", label: "每天" },
                      { value: "weekly", label: "每周" },
                    ]}
                    optionType="button"
                  />
                </Form.Item>
              </div>
              <div className="schedule-type-row">
                {scheduleType === "once" ? (
                  <Form.Item name="once_date" label="执行日期" rules={[{ required: true }]}>
                    <DatePicker style={{ width: "100%" }} />
                  </Form.Item>
                ) : null}
                <Form.Item name="schedule_time" label="执行时间" rules={[{ required: true }]}>
                  <TimePicker format="HH:mm" minuteStep={5} style={{ width: "100%" }} />
                </Form.Item>
              </div>
              {scheduleType === "weekly" ? (
                <Form.Item name="weekly_days" label="每周哪几天执行" rules={[{ required: true }]}>
                  <Checkbox.Group className="schedule-weekday-grid" options={WEEKDAY_OPTIONS} />
                </Form.Item>
              ) : null}
            </div>

            <div className="schedule-panel">
              <Space className="schedule-panel-heading" wrap>
                <div>
                  <Typography.Text className="section-eyebrow">输入表格数据</Typography.Text>
                  <Typography.Title level={5}>导入 CSV / Excel，或手动补几行</Typography.Title>
                </div>
                <Space wrap>
                  <Upload {...uploadProps}>
                    <Button size="small" loading={importingInput} icon={<UploadCloud size={14} />}>
                      导入表格
                    </Button>
                  </Upload>
                  <Button size="small" icon={<Plus size={14} />} onClick={addInputRow}>
                    新增一行
                  </Button>
                </Space>
              </Space>
              <div className="schedule-input-summary">
                <Typography.Text type="secondary">
                  {inputFileName
                    ? `已导入：${inputFileName}，仅预览前 5 行，保存时会使用全部数据。`
                    : "支持和批次一样的 CSV / Excel 文件；表头会作为 row 字段保存。"}
                </Typography.Text>
                <Tag color="gold">{inputRows.length} 行</Tag>
                <Tag color="cyan">{inputColumnKeys.length} 列</Tag>
                {inputFileName ? (
                  <Button size="small" danger type="text" icon={<Trash2 size={14} />} onClick={resetInputRows}>
                    移除表格
                  </Button>
                ) : null}
              </div>
              <Table
                className="schedule-input-table"
                rowKey="id"
                size="small"
                pagination={false}
                scroll={{ x: 760 }}
                dataSource={previewInputRows}
                columns={[
                  ...inputColumnKeys.map((key) => ({
                    key,
                    title: INPUT_COLUMN_LABELS[key] ?? key,
                    minWidth: 180,
                    render: (_value: unknown, row: ScheduleInputRow) => (
                      <Input
                        value={normalizeCellValue(row.payload[key])}
                        placeholder={key === "keyword" ? "Bags" : "可选"}
                        onChange={(event) => updateInputCell(row.id, key, event.target.value)}
                      />
                    ),
                  })),
                  {
                    title: "操作",
                    width: 90,
                    render: (_value: unknown, row: ScheduleInputRow) => (
                      <Button
                        size="small"
                        danger
                        icon={<Trash2 size={14} />}
                        disabled={inputRows.length <= 1}
                        onClick={() => removeInputRow(row.id)}
                      />
                    ),
                  },
                ]}
              />
            </div>

            <div className="schedule-submit-bar">
              <Typography.Text type="secondary">保存后会到点生成真实批次，并按槽位并发执行。</Typography.Text>
              <Button type="primary" size="large" onClick={() => void handleCreate()}>
                创建计划
              </Button>
            </div>
          </div>
        </Form>
      </SectionCard>

      <SectionCard title="计划列表" subtitle="应用未运行时不会主动唤醒系统；下次启动后会提示错过计划。">
        <Table
          className="schedule-list-table"
          rowKey="id"
          scroll={{ x: 760 }}
          dataSource={schedules.data ?? []}
          columns={[
            { title: "名称", dataIndex: "name" },
            {
              title: "执行节奏",
              render: (_value: unknown, record: ScheduleRecord) => (
                <Space size={8} wrap>
                  <Tag color={record.schedule_type === "weekly" ? "cyan" : record.schedule_type === "daily" ? "gold" : "blue"}>
                    {formatScheduleType(record.schedule_type)}
                  </Tag>
                  <Typography.Text>{formatScheduleExpr(record)}</Typography.Text>
                </Space>
              ),
            },
            { title: "Provider", dataIndex: "provider_type" },
            {
              title: "上次运行",
              dataIndex: "last_run_at",
              render: (value?: string | null) => formatDateTime(value),
            },
            {
              title: "状态",
              dataIndex: "status",
              render: (value: string) => <Tag color={value === "enabled" ? "green" : "default"}>{value === "enabled" ? "启用" : "停用"}</Tag>,
            },
          ]}
        />
      </SectionCard>
    </Space>
  );
}
