import {
  Button,
  Checkbox,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
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
import { Download, Pencil, Trash2, UploadCloud } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { SectionCard } from "../components/SectionCard";
import { StatusBadge } from "../components/StatusBadge";
import { TableActionMenu } from "../components/TableActionMenu";
import { usePolling } from "../hooks/usePolling";
import type { ProfileRecord, ProviderGroupRecord, ScheduleRecord, WorkflowRecord } from "../types";
import type { InputProfileMappingValidation } from "../types";
import { downloadBlob, safeFileName } from "../utils/files";

type ScheduleInputRow = {
  id: string;
  payload: Record<string, unknown>;
};

const BEIJING_TIMEZONE = "Asia/Shanghai";
const DEFAULT_INPUT_COLUMNS = ["profile_id", "keyword", "note"];

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

const SCHEDULE_CREATE_STEPS = [
  { title: "基础信息", description: "选择流程、浏览器和槽位" },
  { title: "执行时间", description: "设置一次性、每天或每周" },
  { title: "Excel 数据", description: "导入 profile_id 参数表" },
  { title: "确认创建", description: "复核后生成计划" },
];

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

function parseTimeValue(value?: string | null) {
  const [hour = "9", minute = "30"] = String(value || "09:30").split(":");
  return dayjs().hour(Number(hour)).minute(Number(minute)).second(0).millisecond(0);
}

function scheduleInitialValues(record: ScheduleRecord) {
  if (record.schedule_type === "once") {
    const parsed = dayjs(record.schedule_expr);
    return {
      name: record.name,
      enabled: record.status === "enabled",
      schedule_type: "once",
      once_date: parsed.isValid() ? parsed : dayjs().add(1, "day"),
      schedule_time: parsed.isValid() ? parsed : defaultScheduleTime(),
      weekly_days: ["mon"],
      max_concurrency: record.max_concurrency,
    };
  }
  if (record.schedule_type === "weekly") {
    const [daysPart, timePart] = record.schedule_expr.split("|");
    return {
      name: record.name,
      enabled: record.status === "enabled",
      schedule_type: "weekly",
      once_date: dayjs().add(1, "day"),
      schedule_time: parseTimeValue(timePart),
      weekly_days: daysPart ? daysPart.split(",").filter(Boolean) : ["mon"],
      max_concurrency: record.max_concurrency,
    };
  }
  return {
    name: record.name,
    enabled: record.status === "enabled",
    schedule_type: "daily",
    once_date: dayjs().add(1, "day"),
    schedule_time: parseTimeValue(record.schedule_expr),
    weekly_days: ["mon"],
    max_concurrency: record.max_concurrency,
  };
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
    return "未绑定指纹窗口组";
  }
  const nameById = new Map((groups ?? []).map((group) => [String(group.external_group_id), group.display_name]));
  return groupIds
    .slice(0, 5)
    .map((id) => nameById.get(id) ?? id)
    .join("、") + (groupIds.length > 5 ? ` 等 ${groupIds.length} 组` : "");
}

function mappingErrorMessage(result: InputProfileMappingValidation) {
  const parts: string[] = [];
  if (result.invalid_rows.length) {
    parts.push("存在空 profile_id 或缺少 profile_id 列");
  }
  if (result.duplicate_profile_ids.length) {
    parts.push(`重复: ${result.duplicate_profile_ids.slice(0, 5).join(", ")}`);
  }
  if (result.out_of_scope_profile_ids.length) {
    parts.push(`不在流程指纹窗口组内: ${result.out_of_scope_profile_ids.slice(0, 5).join(", ")}`);
  }
  if (result.missing_profile_ids.length) {
    parts.push(`缺少: ${result.missing_profile_ids.slice(0, 5).join(", ")}`);
  }
  return parts.join("；") || "表格 profile_id 映射校验失败";
}

export function SchedulesPage() {
  const providers = usePolling(api.listProviders, { intervalMs: 10000, cacheKey: "providers:list" });
  const workflows = usePolling(api.listWorkflows, { intervalMs: 10000, cacheKey: "workflows:list:all" });
  const [scheduleReloadKey, setScheduleReloadKey] = useState(0);
  const schedulesFetcher = useCallback(() => api.listSchedules(), [scheduleReloadKey]);
  const schedules = usePolling(schedulesFetcher, { intervalMs: 8000, cacheKey: "schedules:list" });
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();
  const scheduleType = Form.useWatch("schedule_type", { form, preserve: true }) ?? "daily";
  const editScheduleType = Form.useWatch("schedule_type", editForm) ?? "daily";
  const selectedWorkflowId = Form.useWatch("workflow_id", { form, preserve: true });
  const selectedProviderType = Form.useWatch("provider_type", { form, preserve: true });
  const [inputRows, setInputRows] = useState<ScheduleInputRow[]>([]);
  const [importingInput, setImportingInput] = useState(false);
  const [inputFileName, setInputFileName] = useState<string | null>(null);
  const [selectedInputFile, setSelectedInputFile] = useState<File | null>(null);
  const [detectedColumns, setDetectedColumns] = useState<string[]>(DEFAULT_INPUT_COLUMNS);
  const [mappingValidation, setMappingValidation] = useState<InputProfileMappingValidation | null>(null);
  const [editingSchedule, setEditingSchedule] = useState<ScheduleRecord | null>(null);
  const [scheduleActionLoadingId, setScheduleActionLoadingId] = useState<string | null>(null);
  const [createStep, setCreateStep] = useState(0);
  const watchedScheduleTime = Form.useWatch("schedule_time", { form, preserve: true }) as Dayjs | undefined;
  const watchedOnceDate = Form.useWatch("once_date", { form, preserve: true }) as Dayjs | undefined;
  const watchedWeeklyDays = Form.useWatch("weekly_days", { form, preserve: true }) as string[] | undefined;
  const watchedName = Form.useWatch("name", { form, preserve: true }) as string | undefined;
  const watchedMaxConcurrency = Form.useWatch("max_concurrency", { form, preserve: true }) as number | undefined;

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

  const inputColumnKeys = useMemo(() => {
    const keys = new Set(detectedColumns.length ? detectedColumns : DEFAULT_INPUT_COLUMNS);
    inputRows.forEach((row) => {
      Object.keys(row.payload).forEach((key) => keys.add(key));
    });
    return Array.from(keys);
  }, [detectedColumns, inputRows]);
  const resetInputRows = () => {
    setInputRows([]);
    setDetectedColumns(DEFAULT_INPUT_COLUMNS);
    setInputFileName(null);
    setSelectedInputFile(null);
    setMappingValidation(null);
  };

  const handleImportInputFile = async (file: File) => {
    setImportingInput(true);
    try {
      const workflowId = form.getFieldValue("workflow_id");
      const providerType = form.getFieldValue("provider_type");
      if (!workflowId) {
        throw new Error("请先选择流程，再导入表格");
      }
      const result = await api.validateInputProfileMap(file, workflowId, providerType, true);
      if (!result.valid) {
        throw new Error(mappingErrorMessage(result));
      }
      if (!result.rows.length) {
        throw new Error("文件没有可导入的数据行");
      }
      setInputRows(normalizeImportedRows(result.rows));
      setDetectedColumns(result.detected_columns.length ? result.detected_columns : Object.keys(result.rows[0] ?? {}));
      setInputFileName(file.name);
      setSelectedInputFile(file);
      setMappingValidation(result);
      message.success(`已导入并匹配 ${result.matched_count}/${result.total_rows} 行数据`);
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "导入失败");
    } finally {
      setImportingInput(false);
    }
  };

  const uploadProps: UploadProps = {
    accept: ".xlsx,.xlsm",
    beforeUpload: (file) => {
      void handleImportInputFile(file);
      return false;
    },
    maxCount: 1,
    showUploadList: false,
  };

  const handleDownloadTemplate = async () => {
    if (!selectedWorkflowId || !selectedWorkflow) {
      message.warning("请先选择流程");
      return;
    }
    try {
      const blob = await api.downloadWorkflowInputTemplate(selectedWorkflowId);
      downloadBlob(`${safeFileName(selectedWorkflow.name, "profile_input_template")}_流程参数模板.xlsx`, blob);
      message.success("模板已导出");
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "导出模板失败");
    }
  };

  const handleReplaceScheduleFile = async (schedule: ScheduleRecord, file: File) => {
    try {
      await api.replaceScheduleInputFile(schedule.id, file);
      setScheduleReloadKey((value) => value + 1);
      message.success("定时任务表格已替换");
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "替换表格失败");
    }
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

  const schedulePreviewText = useMemo(() => {
    if (scheduleType === "once") {
      const dateText = watchedOnceDate?.isValid() ? watchedOnceDate.format("YYYY-MM-DD") : "未选日期";
      const timeText = watchedScheduleTime?.isValid() ? watchedScheduleTime.format("HH:mm") : "未选时间";
      return `${dateText} ${timeText}`;
    }
    if (scheduleType === "weekly") {
      const days = (watchedWeeklyDays?.length ? watchedWeeklyDays : ["mon"])
        .map((day) => WEEKDAY_LABEL_BY_VALUE[day] ?? day)
        .join("、");
      return `每周 ${days} ${watchedScheduleTime?.isValid() ? watchedScheduleTime.format("HH:mm") : "未选时间"}`;
    }
    return `每天 ${watchedScheduleTime?.isValid() ? watchedScheduleTime.format("HH:mm") : "未选时间"}`;
  }, [scheduleType, watchedOnceDate, watchedScheduleTime, watchedWeeklyDays]);

  const validateCreateStep = async (step = createStep) => {
    if (step === 0) {
      await form.validateFields(["name", "provider_type", "workflow_id", "max_concurrency"]);
      if (!selectedWorkflow) {
        throw new Error("请先选择流程");
      }
      if (!selectedWorkflowGroupIds.length) {
        throw new Error("当前流程未绑定指纹窗口组，无法创建定时任务。请先到流程列表里点击“关联指纹窗口组”。");
      }
      if (providerProfiles.loading || providerGroups.loading) {
        message.info("正在读取流程绑定的指纹窗口组，请稍等几秒后再继续。");
        return false;
      }
      if (selectedWorkflowProfileCount <= 0) {
        throw new Error("当前流程绑定的指纹窗口组没有命中可管理指纹窗口，请检查 Provider 管理范围。");
      }
    }
    if (step === 1) {
      const fields = ["schedule_type", "schedule_time"];
      if (scheduleType === "once") {
        fields.push("once_date");
      }
      if (scheduleType === "weekly") {
        fields.push("weekly_days");
      }
      await form.validateFields(fields);
    }
    if (step === 2) {
      if (!selectedInputFile || !mappingValidation?.valid) {
        throw new Error("请先导入并校验一个 Excel 表格");
      }
      if (!inputRows.length) {
        throw new Error("Excel 没有可执行数据行");
      }
    }
    return true;
  };

  const goNextCreateStep = async () => {
    try {
      const canContinue = await validateCreateStep(createStep);
      if (canContinue) {
        setCreateStep((step) => Math.min(step + 1, SCHEDULE_CREATE_STEPS.length - 1));
      }
    } catch (cause) {
      if (cause instanceof Error) {
        message.error(cause.message);
      }
    }
  };

  const goPrevCreateStep = () => {
    setCreateStep((step) => Math.max(step - 1, 0));
  };

  const handleCreate = async () => {
    try {
      const requiredFields = ["name", "provider_type", "workflow_id", "schedule_type", "schedule_time", "max_concurrency"];
      const currentScheduleType = form.getFieldValue("schedule_type");
      if (currentScheduleType === "once") {
        requiredFields.push("once_date");
      }
      if (currentScheduleType === "weekly") {
        requiredFields.push("weekly_days");
      }
      const values = await form.validateFields(requiredFields);
      const inlineRows = inputRows.map(rowToPayload).filter((row) => Object.keys(row).length > 0);
      if (!selectedInputFile || !mappingValidation?.valid) {
        throw new Error("请先导入并校验一个 Excel 表格");
      }
      if (!inlineRows.length) {
        throw new Error("Excel 没有可执行数据行");
      }
      if (!selectedWorkflow) {
        throw new Error("请先选择流程");
      }
      if (!selectedWorkflowGroupIds.length) {
        throw new Error("当前流程未绑定指纹窗口组，无法创建定时任务。请先到流程列表里点击“关联指纹窗口组”。");
      }
      if (providerProfiles.loading || providerGroups.loading) {
        message.info("正在读取流程绑定的指纹窗口组，请稍等几秒后再创建计划。");
        return;
      }
      if (selectedWorkflowProfileCount <= 0) {
        throw new Error("当前流程绑定的指纹窗口组没有命中可管理指纹窗口，请检查 Provider 管理范围。");
      }
      const scheduleExpr = buildScheduleExpr(values);
      Modal.confirm({
        title: "确认创建这个定时任务？",
        okText: "确认创建",
        cancelText: "取消",
        content: (
          <Space direction="vertical" size={8}>
            <Typography.Text>流程：{selectedWorkflow.name}</Typography.Text>
            <Typography.Text>指纹浏览器：{selectedWorkflowProviderLabel}</Typography.Text>
            <Typography.Text>指纹窗口组：{selectedWorkflowGroupSummary}</Typography.Text>
            <Typography.Text>可运行指纹窗口：{selectedWorkflowProfileCount} 个</Typography.Text>
            <Typography.Text>并发槽位：{values.max_concurrency}</Typography.Text>
            <Typography.Text>表格数据：{inlineRows.length} 行</Typography.Text>
          </Space>
        ),
        onOk: async () => {
          try {
            const created = await api.createSchedule({
              name: values.name,
              provider_type: values.provider_type,
              workflow_id: values.workflow_id,
              schedule_type: values.schedule_type,
              schedule_expr: scheduleExpr,
              timezone: BEIJING_TIMEZONE,
              max_concurrency: values.max_concurrency,
              enabled: true,
              profile_policy_snapshot: {},
              input_source: { inline_rows: inlineRows },
              retry_once_on_failure: true,
            });
            if (selectedInputFile) {
              await api.replaceScheduleInputFile(created.id, selectedInputFile);
            }
            message.success("定时任务已创建");
            form.resetFields();
            resetInputRows();
            setCreateStep(0);
            setScheduleReloadKey((value) => value + 1);
          } catch (cause) {
            if (cause instanceof Error) {
              message.error(cause.message);
            }
          }
        },
      });
    } catch (cause) {
      if (cause instanceof Error) {
        message.error(cause.message);
      }
    }
  };

  const buildSchedulePayload = (
    record: ScheduleRecord,
    values: Record<string, unknown>,
    options?: { enabled?: boolean },
  ) => ({
    name: values.name ?? record.name,
    provider_type: record.provider_type,
    workflow_id: record.workflow_id,
    schedule_type: values.schedule_type ?? record.schedule_type,
    schedule_expr: buildScheduleExpr({
      schedule_type: values.schedule_type ?? record.schedule_type,
      schedule_time: values.schedule_time,
      once_date: values.once_date,
      weekly_days: values.weekly_days,
    }),
    timezone: BEIJING_TIMEZONE,
    max_concurrency: values.max_concurrency ?? record.max_concurrency,
    enabled: options?.enabled ?? Boolean(values.enabled),
    profile_policy_snapshot: record.profile_policy_snapshot ?? {},
    input_source: record.input_source ?? {},
    retry_once_on_failure: record.retry_once_on_failure ?? true,
  });

  const openEditSchedule = (record: ScheduleRecord) => {
    setEditingSchedule(record);
    editForm.setFieldsValue(scheduleInitialValues(record));
  };

  const handleUpdateSchedule = async () => {
    if (!editingSchedule) {
      return;
    }
    try {
      const values = await editForm.validateFields();
      setScheduleActionLoadingId(editingSchedule.id);
      await api.updateSchedule(editingSchedule.id, buildSchedulePayload(editingSchedule, values));
      setEditingSchedule(null);
      setScheduleReloadKey((value) => value + 1);
      message.success("定时任务已更新");
    } catch (cause) {
      if (cause instanceof Error) {
        message.error(cause.message);
      }
    } finally {
      setScheduleActionLoadingId(null);
    }
  };

  const handleToggleSchedule = async (record: ScheduleRecord) => {
    try {
      setScheduleActionLoadingId(record.id);
      const values = scheduleInitialValues(record);
      await api.updateSchedule(record.id, buildSchedulePayload(record, values, { enabled: record.status !== "enabled" }));
      setScheduleReloadKey((value) => value + 1);
      message.success(record.status === "enabled" ? "定时任务已停用" : "定时任务已启用");
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "操作失败");
    } finally {
      setScheduleActionLoadingId(null);
    }
  };

  const handleDeleteSchedule = async (record: ScheduleRecord) => {
    try {
      setScheduleActionLoadingId(record.id);
      await api.deleteSchedule(record.id);
      setScheduleReloadKey((value) => value + 1);
      message.success("定时任务已删除");
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : "删除失败");
    } finally {
      setScheduleActionLoadingId(null);
    }
  };

  const confirmDeleteSchedule = (record: ScheduleRecord) => {
    Modal.confirm({
      title: "删除这个定时任务？",
      content: "删除后不会再自动触发，已生成的历史批次不会删除。",
      okText: "删除",
      cancelText: "取消",
      okButtonProps: { danger: true },
      onOk: () => void handleDeleteSchedule(record),
    });
  };

  if (providers.loading || workflows.loading || schedules.loading) {
    return <Spin size="large" />;
  }

  return (
    <div className="app-page schedules-page task-subpage">
      <SectionCard title="定时任务" subtitle="默认北京时间；选择流程、设置节奏、导入 Excel 后即可生成计划。">
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
          <div className="schedule-step-workbench">
            <aside className="schedule-step-rail">
              {SCHEDULE_CREATE_STEPS.map((step, index) => (
                <button
                  key={step.title}
                  type="button"
                  className={`schedule-step-item${index === createStep ? " is-active" : ""}${index < createStep ? " is-done" : ""}`}
                  onClick={() => {
                    if (index <= createStep) {
                      setCreateStep(index);
                    }
                  }}
                >
                  <span>{index + 1}</span>
                  <div>
                    <strong>{step.title}</strong>
                    <small>{step.description}</small>
                  </div>
                </button>
              ))}
            </aside>

            <div className="schedule-step-panel">
              <div className="schedule-step-panel__body">
                {createStep === 0 ? (
                  <div className="schedule-step-content">
                    <div className="schedule-step-title">
                      <Typography.Text className="section-eyebrow">基础信息</Typography.Text>
                      <Typography.Title level={5}>先确定计划要执行什么</Typography.Title>
                      <Typography.Paragraph>选择流程后，系统会读取该流程绑定的指纹窗口组，并作为后续运行池。</Typography.Paragraph>
                    </div>
                    <div className="schedule-form-grid">
                      <Form.Item name="name" label="计划名称" rules={[{ required: true, message: "请输入计划名称" }]}>
                        <Input placeholder="例如：早班巡检" />
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
                    <div className={`schedule-profile-card${selectedWorkflowGroupIds.length ? " is-ready" : " is-warning"}`}>
                      <Typography.Text className="section-eyebrow">指纹窗口组</Typography.Text>
                      <Typography.Title level={5}>{selectedWorkflowGroupSummary}</Typography.Title>
                      <Typography.Paragraph>
                        {selectedWorkflowGroupIds.length
                          ? `${selectedWorkflowProviderLabel} 下预计命中 ${selectedWorkflowProfileCount} 个可管理指纹窗口。`
                          : "当前流程还没有绑定指纹窗口组，无法创建定时任务。"}
                      </Typography.Paragraph>
                    </div>
                  </div>
                ) : null}

                {createStep === 1 ? (
                  <div className="schedule-step-content">
                    <div className="schedule-step-title">
                      <Typography.Text className="section-eyebrow">执行时间</Typography.Text>
                      <Typography.Title level={5}>设置自动运行节奏</Typography.Title>
                      <Typography.Paragraph>默认使用北京时间，不展示额外时区参数，减少运营配置成本。</Typography.Paragraph>
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
                    <div className="schedule-preview-card">
                      <span>当前节奏</span>
                      <strong>{schedulePreviewText}</strong>
                    </div>
                  </div>
                ) : null}

                {createStep === 2 ? (
                  <div className="schedule-step-content">
                    <div className="schedule-step-title schedule-step-title--with-actions">
                      <div>
                        <Typography.Text className="section-eyebrow">Excel 数据</Typography.Text>
                        <Typography.Title level={5}>导入流程参数表</Typography.Title>
                        <Typography.Paragraph>每一行必须包含 profile_id，一行对应一个指纹窗口，保存时会使用全部数据。</Typography.Paragraph>
                      </div>
                      <Space wrap>
                        <Button size="small" icon={<Download size={14} />} disabled={!selectedWorkflowId} onClick={() => void handleDownloadTemplate()}>
                          下载流程参数模板
                        </Button>
                        <Upload {...uploadProps}>
                          <Button size="small" loading={importingInput} icon={<UploadCloud size={14} />}>
                            导入 Excel
                          </Button>
                        </Upload>
                      </Space>
                    </div>
                    <div className="schedule-input-summary schedule-input-summary--wizard">
                      <Typography.Text type="secondary">
                        {inputFileName
                          ? `已导入：${inputFileName}`
                          : "请先下载流程参数模板，补齐业务字段后导入 .xlsx / .xlsm 文件。"}
                      </Typography.Text>
                      <Tag color="gold">{inputRows.length} 行</Tag>
                      <Tag color="cyan">{inputColumnKeys.length} 列</Tag>
                      {mappingValidation ? (
                        <Tag color={mappingValidation.valid ? "green" : "red"}>
                          匹配 {mappingValidation.matched_count}/{mappingValidation.total_rows}
                        </Tag>
                      ) : null}
                      {inputFileName ? (
                        <Button size="small" danger type="text" icon={<Trash2 size={14} />} onClick={resetInputRows}>
                          移除表格
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {createStep === 3 ? (
                  <div className="schedule-step-content">
                    <div className="schedule-step-title">
                      <Typography.Text className="section-eyebrow">确认创建</Typography.Text>
                      <Typography.Title level={5}>复核计划配置</Typography.Title>
                      <Typography.Paragraph>点击创建后会保存为本机计划，到点生成真实批次并按槽位并发执行。</Typography.Paragraph>
                    </div>
                    <div className="schedule-confirm-grid">
                      <div><span>计划名称</span><strong>{watchedName || "未填写"}</strong></div>
                      <div><span>流程</span><strong>{selectedWorkflow?.name ?? "未选择"}</strong></div>
                      <div><span>指纹浏览器</span><strong>{selectedWorkflowProviderLabel}</strong></div>
                      <div><span>指纹窗口组</span><strong>{selectedWorkflowGroupSummary}</strong></div>
                      <div><span>运行节奏</span><strong>{schedulePreviewText}</strong></div>
                      <div><span>并发槽位</span><strong>{watchedMaxConcurrency ?? 1}</strong></div>
                      <div><span>Excel 数据</span><strong>{inputRows.length} 行 / {inputColumnKeys.length} 列</strong></div>
                      <div><span>可运行窗口</span><strong>{selectedWorkflowProfileCount} 个</strong></div>
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="schedule-step-actions">
                <Typography.Text type="secondary">
                  {createStep + 1} / {SCHEDULE_CREATE_STEPS.length} · {SCHEDULE_CREATE_STEPS[createStep].description}
                </Typography.Text>
                <Space>
                  <Button disabled={createStep === 0} onClick={goPrevCreateStep}>
                    上一步
                  </Button>
                  {createStep < SCHEDULE_CREATE_STEPS.length - 1 ? (
                    <Button type="primary" onClick={() => void goNextCreateStep()}>
                      下一步
                    </Button>
                  ) : (
                    <Button type="primary" onClick={() => void handleCreate()}>
                      创建计划
                    </Button>
                  )}
                </Space>
              </div>
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
            {
              title: "指纹浏览器",
              dataIndex: "provider_type",
              render: (value: string) => providerNameByType.get(value) ?? value,
            },
            {
              title: "上次运行",
              dataIndex: "last_run_at",
              render: (value?: string | null) => formatDateTime(value),
            },
            {
              title: "状态",
              dataIndex: "status",
              render: (value: string) => <StatusBadge status={value} />,
            },
            {
              title: "槽位",
              dataIndex: "max_concurrency",
              width: 80,
            },
            {
              title: "表格",
              render: (_value: unknown, record: ScheduleRecord) => {
                const originalName = typeof record.input_source?.original_file_name === "string"
                  ? record.input_source.original_file_name
                  : "未上传 Excel";
                const replaceProps: UploadProps = {
                  accept: ".xlsx,.xlsm",
                  beforeUpload: (file) => {
                    void handleReplaceScheduleFile(record, file);
                    return false;
                  },
                  maxCount: 1,
                  showUploadList: false,
                };
                return (
                  <Space size={8} wrap>
                    <Tag color={originalName === "未上传 Excel" ? "default" : "blue"}>{originalName}</Tag>
                    <Upload {...replaceProps}>
                      <Button size="small" icon={<UploadCloud size={14} />}>
                        替换表格
                      </Button>
                    </Upload>
                  </Space>
                );
              },
            },
            {
              title: "操作",
              fixed: "right",
              width: 150,
              render: (_value: unknown, record: ScheduleRecord) => (
                <TableActionMenu
                  loading={scheduleActionLoadingId === record.id}
                  primary={{
                    key: "edit",
                    label: "编辑",
                    icon: <Pencil size={14} />,
                    onClick: () => openEditSchedule(record),
                  }}
                  actions={[
                    {
                      key: "toggle",
                      label: record.status === "enabled" ? "停用" : "启用",
                      onClick: () => void handleToggleSchedule(record),
                    },
                    {
                      key: "delete",
                      label: "删除",
                      icon: <Trash2 size={14} />,
                      danger: true,
                      onClick: () => confirmDeleteSchedule(record),
                    },
                  ]}
                />
              ),
            },
          ]}
        />
      </SectionCard>
      <Modal
        title="编辑定时任务"
        open={Boolean(editingSchedule)}
        okText="保存修改"
        cancelText="取消"
        confirmLoading={Boolean(editingSchedule && scheduleActionLoadingId === editingSchedule.id)}
        onOk={() => void handleUpdateSchedule()}
        onCancel={() => {
          setEditingSchedule(null);
          editForm.resetFields();
        }}
      >
        {editingSchedule ? (
          <Form
            form={editForm}
            layout="vertical"
            initialValues={scheduleInitialValues(editingSchedule)}
          >
            <Form.Item name="name" label="计划名称" rules={[{ required: true, message: "请输入计划名称" }]}>
              <Input />
            </Form.Item>
            <Form.Item name="enabled" label="状态">
              <Radio.Group
                options={[
                  { value: true, label: "启用" },
                  { value: false, label: "停用" },
                ]}
              />
            </Form.Item>
            <Form.Item name="schedule_type" label="类型">
              <Radio.Group
                buttonStyle="solid"
                optionType="button"
                options={[
                  { value: "once", label: "一次性" },
                  { value: "daily", label: "每天" },
                  { value: "weekly", label: "每周" },
                ]}
              />
            </Form.Item>
            {editScheduleType === "once" ? (
              <Form.Item name="once_date" label="执行日期" rules={[{ required: true }]}>
                <DatePicker style={{ width: "100%" }} />
              </Form.Item>
            ) : null}
            <Form.Item name="schedule_time" label="执行时间" rules={[{ required: true }]}>
              <TimePicker format="HH:mm" minuteStep={5} style={{ width: "100%" }} />
            </Form.Item>
            {editScheduleType === "weekly" ? (
              <Form.Item name="weekly_days" label="每周哪几天执行" rules={[{ required: true }]}>
                <Checkbox.Group className="schedule-weekday-grid" options={WEEKDAY_OPTIONS} />
              </Form.Item>
            ) : null}
            <Form.Item name="max_concurrency" label="并发槽位">
              <InputNumber min={1} max={10} style={{ width: "100%" }} />
            </Form.Item>
            <Typography.Paragraph type="secondary">
              当前流程和 Excel 表格不在编辑弹窗中切换；如需更换数据，请在计划列表中点击“替换表格”。
            </Typography.Paragraph>
          </Form>
        ) : null}
      </Modal>
    </div>
  );
}
