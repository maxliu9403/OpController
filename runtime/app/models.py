from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any
from uuid import uuid4

from sqlalchemy import JSON, Boolean, DateTime, Enum, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


def _uuid() -> str:
    return uuid4().hex


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )


class BatchStatus(StrEnum):
    DRAFT = "draft"
    READY = "ready"
    RUNNING = "running"
    PAUSED = "paused"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class TaskRunStatus(StrEnum):
    QUEUED = "queued"
    OPENING = "opening"
    RUNNING = "running"
    CLOSING = "closing"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"
    LOST = "lost"


class StepRunStatus(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    SKIPPED = "skipped"
    TIMED_OUT = "timed_out"


class ScheduleStatus(StrEnum):
    ENABLED = "enabled"
    DISABLED = "disabled"


class ProfileRecord(TimestampMixin, Base):
    __tablename__ = "profiles"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    provider_type: Mapped[str] = mapped_column(String(50), index=True)
    external_profile_id: Mapped[str] = mapped_column(String(128), index=True)
    display_name: Mapped[str] = mapped_column(String(255))
    group_summary: Mapped[dict[str, Any] | None] = mapped_column(JSON, default=dict)
    tag_summary: Mapped[list[dict[str, Any]] | None] = mapped_column(JSON, default=list)
    proxy_summary: Mapped[dict[str, Any] | None] = mapped_column(JSON, default=dict)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    last_sync_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    provider_payload_json: Mapped[dict[str, Any] | None] = mapped_column(JSON, default=dict)


class ProviderScopeRecord(TimestampMixin, Base):
    __tablename__ = "provider_scopes"

    provider_type: Mapped[str] = mapped_column(String(50), primary_key=True)
    managed_group_ids: Mapped[list[str] | None] = mapped_column(JSON, default=list)
    include_profile_ids: Mapped[list[str] | None] = mapped_column(JSON, default=list)
    exclude_profile_ids: Mapped[list[str] | None] = mapped_column(JSON, default=list)


class ProviderConfigRecord(TimestampMixin, Base):
    __tablename__ = "provider_configs"

    provider_type: Mapped[str] = mapped_column(String(50), primary_key=True)
    values_json: Mapped[dict[str, Any] | None] = mapped_column(JSON, default=dict)


class WorkflowFolderRecord(TimestampMixin, Base):
    __tablename__ = "workflow_folders"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)


class WorkflowTemplateRecord(TimestampMixin, Base):
    __tablename__ = "workflow_templates"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    version: Mapped[str] = mapped_column(String(50), default="1.0.0")
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    folder: Mapped[str] = mapped_column(String(255), default="未分组", index=True)
    target_provider_type: Mapped[str] = mapped_column(String(50), index=True)
    required_capabilities_json: Mapped[dict[str, Any] | None] = mapped_column(JSON, default=dict)
    workflow_yaml: Mapped[str] = mapped_column(Text)
    normalized_workflow_json: Mapped[dict[str, Any]] = mapped_column(JSON)
    selector_catalog_json: Mapped[dict[str, Any] | None] = mapped_column(JSON, default=dict)
    is_builtin: Mapped[bool] = mapped_column(Boolean, default=False)


class BatchRecord(TimestampMixin, Base):
    __tablename__ = "batches"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(255))
    provider_type: Mapped[str] = mapped_column(String(50), index=True)
    workflow_id: Mapped[str] = mapped_column(ForeignKey("workflow_templates.id"))
    status: Mapped[BatchStatus] = mapped_column(Enum(BatchStatus), default=BatchStatus.DRAFT)
    input_source: Mapped[str] = mapped_column(String(50), default="csv")
    runtime_mode: Mapped[str] = mapped_column(String(32), default="visual")
    total_rows: Mapped[int] = mapped_column(Integer, default=0)
    success_count: Mapped[int] = mapped_column(Integer, default=0)
    failure_count: Mapped[int] = mapped_column(Integer, default=0)
    average_duration_ms: Mapped[int] = mapped_column(Integer, default=0)
    profile_policy_snapshot: Mapped[dict[str, Any] | None] = mapped_column(JSON, default=dict)
    result_summary_json: Mapped[dict[str, Any] | None] = mapped_column(JSON, default=dict)

    workflow: Mapped["WorkflowTemplateRecord"] = relationship()
    rows: Mapped[list["BatchRowRecord"]] = relationship(back_populates="batch")


class BatchRowRecord(TimestampMixin, Base):
    __tablename__ = "batch_rows"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    batch_id: Mapped[str] = mapped_column(ForeignKey("batches.id"), index=True)
    row_index: Mapped[int] = mapped_column(Integer)
    dedupe_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
    row_payload_json: Mapped[dict[str, Any]] = mapped_column(JSON)
    mapped_profile_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    batch: Mapped["BatchRecord"] = relationship(back_populates="rows")


class TaskRunRecord(TimestampMixin, Base):
    __tablename__ = "task_runs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    batch_id: Mapped[str] = mapped_column(ForeignKey("batches.id"), index=True)
    batch_row_id: Mapped[str] = mapped_column(ForeignKey("batch_rows.id"), index=True)
    provider_type: Mapped[str] = mapped_column(String(50), index=True)
    provider_profile_id: Mapped[str] = mapped_column(String(128))
    provider_session_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    provider_debug_endpoint: Mapped[str | None] = mapped_column(String(512), nullable=True)
    slot_index: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status: Mapped[TaskRunStatus] = mapped_column(Enum(TaskRunStatus), default=TaskRunStatus.QUEUED)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    outputs_json: Mapped[dict[str, Any] | None] = mapped_column(JSON, default=dict)


class StepRunRecord(TimestampMixin, Base):
    __tablename__ = "step_runs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    task_run_id: Mapped[str] = mapped_column(ForeignKey("task_runs.id"), index=True)
    step_id: Mapped[str] = mapped_column(String(128))
    label: Mapped[str | None] = mapped_column(String(255), nullable=True)
    action_type: Mapped[str] = mapped_column(String(64))
    status: Mapped[StepRunStatus] = mapped_column(Enum(StepRunStatus), default=StepRunStatus.PENDING)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    input_payload_json: Mapped[dict[str, Any] | None] = mapped_column(JSON, default=dict)
    output_payload_json: Mapped[dict[str, Any] | None] = mapped_column(JSON, default=dict)
    locator_summary_json: Mapped[dict[str, Any] | None] = mapped_column(JSON, default=dict)
    error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    artifact_path: Mapped[str | None] = mapped_column(String(512), nullable=True)


class ScheduleRecord(TimestampMixin, Base):
    __tablename__ = "schedules"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(255))
    status: Mapped[ScheduleStatus] = mapped_column(Enum(ScheduleStatus), default=ScheduleStatus.ENABLED)
    workflow_id: Mapped[str] = mapped_column(ForeignKey("workflow_templates.id"))
    provider_type: Mapped[str] = mapped_column(String(50))
    profile_policy_snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    input_source: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    schedule_type: Mapped[str] = mapped_column(String(32))
    schedule_expr: Mapped[str] = mapped_column(String(255))
    timezone: Mapped[str] = mapped_column(String(64), default="Asia/Shanghai")
    max_concurrency: Mapped[int] = mapped_column(Integer, default=1)
    retry_once_on_failure: Mapped[bool] = mapped_column(Boolean, default=True)
    next_run_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class ArtifactRecord(TimestampMixin, Base):
    __tablename__ = "artifacts"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    batch_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    task_run_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    step_run_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    artifact_type: Mapped[str] = mapped_column(String(50))
    path: Mapped[str] = mapped_column(String(512))
    metadata_json: Mapped[dict[str, Any] | None] = mapped_column(JSON, default=dict)


class AuditLogRecord(TimestampMixin, Base):
    __tablename__ = "audit_logs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    category: Mapped[str] = mapped_column(String(50), index=True)
    actor: Mapped[str] = mapped_column(String(128), default="local-user")
    provider_type: Mapped[str | None] = mapped_column(String(50), nullable=True)
    message: Mapped[str] = mapped_column(Text)
    details_json: Mapped[dict[str, Any] | None] = mapped_column(JSON, default=dict)
