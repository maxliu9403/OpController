import { CheckCircle2, Circle, Info, LockKeyhole, PlayCircle, TriangleAlert, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { statusLabel } from "../utils/status";

export type StatusBadgeTone =
  | "neutral"
  | "info"
  | "processing"
  | "success"
  | "warning"
  | "danger"
  | "locked";

type StatusBadgeProps = {
  status?: string | null;
  label?: ReactNode;
  tone?: StatusBadgeTone;
  icon?: ReactNode;
  className?: string;
};

const STATUS_TONES: Record<string, StatusBadgeTone> = {
  draft: "neutral",
  ready: "info",
  queued: "info",
  opening: "processing",
  running: "processing",
  paused: "warning",
  closing: "processing",
  completed: "success",
  succeeded: "success",
  success: "success",
  partial: "warning",
  failed: "danger",
  error: "danger",
  cancelled: "neutral",
  lost: "danger",
  pending: "neutral",
  skipped: "neutral",
  timed_out: "danger",
  enabled: "success",
  disabled: "neutral",
  healthy: "success",
  unhealthy: "danger",
  configured: "success",
  needs_config: "warning",
  not_required: "neutral",
  editable: "info",
  editing: "processing",
  locked: "locked",
  attachable: "success",
  unbound: "danger",
};

function iconForTone(tone: StatusBadgeTone) {
  if (tone === "success") {
    return <CheckCircle2 size={13} />;
  }
  if (tone === "warning") {
    return <TriangleAlert size={13} />;
  }
  if (tone === "danger") {
    return <XCircle size={13} />;
  }
  if (tone === "processing") {
    return <PlayCircle size={13} />;
  }
  if (tone === "locked") {
    return <LockKeyhole size={13} />;
  }
  if (tone === "info") {
    return <Info size={13} />;
  }
  return <Circle size={10} />;
}

export function statusTone(status?: string | null): StatusBadgeTone {
  if (!status) {
    return "neutral";
  }
  return STATUS_TONES[status] ?? "neutral";
}

export function StatusBadge({ status, label, tone, icon, className }: StatusBadgeProps) {
  const finalTone = tone ?? statusTone(status);
  const finalLabel = label ?? statusLabel(status);
  return (
    <span className={["status-badge", `status-badge--${finalTone}`, className].filter(Boolean).join(" ")}>
      <span className="status-badge__icon">{icon ?? iconForTone(finalTone)}</span>
      <span className="status-badge__label">{finalLabel}</span>
    </span>
  );
}
