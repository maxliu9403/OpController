from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class BatchRowPayload(BaseModel):
    id: str | None = None
    row_index: int
    dedupe_key: str | None = None
    payload: dict[str, Any]
    mapped_profile_id: str | None = None


class BatchSummary(BaseModel):
    id: str
    name: str
    provider_type: str
    workflow_id: str
    status: str
    runtime_mode: str
    total_rows: int
    success_count: int
    failure_count: int
    average_duration_ms: int
    created_at: datetime | None = None
    updated_at: datetime | None = None


class BatchTaskRunSummary(BaseModel):
    id: str
    batch_id: str
    batch_row_id: str
    row_index: int | None = None
    provider_type: str
    provider_profile_id: str
    status: str
    slot_index: int | None = None
    error_code: str | None = None
    error_message: str | None = None
    outputs_json: dict[str, Any] = Field(default_factory=dict)
    started_at: datetime | None = None
    finished_at: datetime | None = None


class BatchDetail(BatchSummary):
    profile_policy_snapshot: dict[str, Any] = Field(default_factory=dict)
    result_summary_json: dict[str, Any] = Field(default_factory=dict)
    rows: list[BatchRowPayload] = Field(default_factory=list)
    tasks: list[BatchTaskRunSummary] = Field(default_factory=list)


class BatchImportResult(BaseModel):
    batch: BatchDetail
    detected_columns: list[str] = Field(default_factory=list)
    preview_rows: list[dict[str, Any]] = Field(default_factory=list)


class InputFileParseResult(BaseModel):
    total_rows: int = 0
    detected_columns: list[str] = Field(default_factory=list)
    preview_rows: list[dict[str, Any]] = Field(default_factory=list)
    rows: list[dict[str, Any]] = Field(default_factory=list)


class InputProfileMappingValidation(BaseModel):
    valid: bool
    total_rows: int = 0
    matched_count: int = 0
    skipped_count: int = 0
    detected_columns: list[str] = Field(default_factory=list)
    preview_rows: list[dict[str, Any]] = Field(default_factory=list)
    rows: list[dict[str, Any]] = Field(default_factory=list)
    missing_profile_ids: list[str] = Field(default_factory=list)
    duplicate_profile_ids: list[str] = Field(default_factory=list)
    out_of_scope_profile_ids: list[str] = Field(default_factory=list)
    invalid_rows: list[dict[str, Any]] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class StartBatchRequest(BaseModel):
    workflow_id: str
    provider_type: str
    profile_policy_snapshot: dict[str, Any] = Field(default_factory=dict)
    runtime_mode: str = "visual"
    requested_slots: int = 6


class StepRunDetail(BaseModel):
    id: str
    step_id: str
    label: str | None = None
    action_type: str
    status: str
    error_code: str | None = None
    error_message: str | None = None
    output_payload_json: dict[str, Any] = Field(default_factory=dict)
    locator_summary_json: dict[str, Any] = Field(default_factory=dict)
    artifact_path: str | None = None


class TaskRunDetail(BaseModel):
    id: str
    batch_id: str
    batch_row_id: str | None = None
    provider_type: str
    provider_profile_id: str
    status: str
    slot_index: int | None = None
    error_code: str | None = None
    error_message: str | None = None
    outputs_json: dict[str, Any] = Field(default_factory=dict)
    step_runs: list[StepRunDetail] = Field(default_factory=list)

