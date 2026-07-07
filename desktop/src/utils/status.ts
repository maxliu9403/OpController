export type StatusTone = "default" | "blue" | "cyan" | "gold" | "green" | "red" | "orange";

const STATUS_LABELS: Record<string, string> = {
  draft: "草稿",
  ready: "待运行",
  queued: "排队中",
  opening: "打开窗口",
  running: "运行中",
  paused: "已暂停",
  closing: "关闭窗口",
  completed: "已完成",
  succeeded: "成功",
  success: "成功",
  partial: "部分成功",
  failed: "失败",
  error: "错误",
  cancelled: "已取消",
  lost: "已中断",
  pending: "待执行",
  skipped: "已跳过",
  timed_out: "超时",
  enabled: "启用",
  disabled: "停用",
  healthy: "正常",
  unhealthy: "异常",
  configured: "已配置",
  needs_config: "需要配置",
  not_required: "无需配置",
  editable: "可编辑",
  editing: "编排中",
  locked: "已锁定",
  attachable: "可连接",
  unbound: "未关联",
};

const STATUS_COLORS: Record<string, StatusTone> = {
  draft: "default",
  ready: "blue",
  queued: "blue",
  opening: "cyan",
  running: "gold",
  paused: "orange",
  closing: "cyan",
  completed: "green",
  succeeded: "green",
  success: "green",
  partial: "gold",
  failed: "red",
  error: "red",
  cancelled: "default",
  lost: "red",
  pending: "default",
  skipped: "default",
  timed_out: "red",
  enabled: "green",
  disabled: "default",
  healthy: "green",
  unhealthy: "red",
  configured: "green",
  needs_config: "orange",
  not_required: "default",
  editable: "blue",
  editing: "gold",
  locked: "default",
  attachable: "green",
  unbound: "red",
};

export function statusLabel(status?: string | null) {
  if (!status) {
    return "未知";
  }
  return STATUS_LABELS[status] ?? status;
}

export function statusColor(status?: string | null): StatusTone {
  if (!status) {
    return "default";
  }
  return STATUS_COLORS[status] ?? "default";
}

export function batchResultLabel(value: "all" | "success" | "partial" | "failed") {
  const labels = {
    all: "全部",
    success: "成功",
    partial: "部分成功",
    failed: "失败",
  };
  return labels[value];
}
