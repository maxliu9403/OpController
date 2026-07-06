from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from app.schemas.workflow import LocatorSpec, WorkflowStep


class LocatorLivePreviewRequest(BaseModel):
    provider_type: str
    external_profile_id: str
    locator: LocatorSpec


class LocatorPickOnceRequest(BaseModel):
    provider_type: str
    external_profile_id: str
    timeout_sec: int = Field(default=30, ge=5, le=180)


class StepLivePreviewRequest(BaseModel):
    provider_type: str
    external_profile_id: str
    step: WorkflowStep
    locator: LocatorSpec | None = None
    row_payload: dict[str, Any] = Field(default_factory=dict)


class WorkflowDryRunRequest(BaseModel):
    provider_type: str
    external_profile_id: str
    workflow_yaml: str
    row_payload: dict[str, Any] = Field(default_factory=dict)
    stop_on_failure: bool = True


class LocatorLivePreviewResult(BaseModel):
    success: bool
    selector_used: str | None = None
    match_count: int = 0
    matched_texts: list[str] = Field(default_factory=list)
    current_url: str | None = None
    page_title: str | None = None
    error_code: str | None = None
    error_message: str | None = None


class PickedElementSummary(BaseModel):
    tag_name: str
    text: str | None = None
    attributes: dict[str, str] = Field(default_factory=dict)
    frame_path: list[str] = Field(default_factory=list)
    neighbor_anchor: dict[str, Any] = Field(default_factory=dict)
    list_context: dict[str, Any] = Field(default_factory=dict)
    bounding_box: dict[str, float] = Field(default_factory=dict)
    screenshot_data_url: str | None = None


class LocatorPickOnceResult(BaseModel):
    success: bool
    element: PickedElementSummary | None = None
    locator: LocatorSpec | None = None
    warnings: list[str] = Field(default_factory=list)
    uniqueness_score: float = 0
    stability_score: float = 0
    live_preview: LocatorLivePreviewResult | None = None
    current_url: str | None = None
    page_title: str | None = None
    error_code: str | None = None
    error_message: str | None = None


class StepLivePreviewResult(BaseModel):
    success: bool
    current_url: str | None = None
    page_title: str | None = None
    selector_used: str | None = None
    locator_count: int = 0
    matched_texts: list[str] = Field(default_factory=list)
    outputs: dict[str, Any] = Field(default_factory=dict)
    artifact_path: str | None = None
    error_code: str | None = None
    error_message: str | None = None


class WorkflowDryRunStepResult(BaseModel):
    step_id: str
    label: str | None = None
    action_type: str
    status: str
    elapsed_ms: int = 0
    selector_used: str | None = None
    locator_count: int = 0
    matched_texts: list[str] = Field(default_factory=list)
    outputs: dict[str, Any] = Field(default_factory=dict)
    current_url: str | None = None
    page_title: str | None = None
    artifact_path: str | None = None
    error_code: str | None = None
    error_message: str | None = None


class WorkflowDryRunResult(BaseModel):
    success: bool
    total_steps: int
    succeeded_steps: int
    failed_steps: int
    elapsed_ms: int = 0
    current_url: str | None = None
    page_title: str | None = None
    outputs: dict[str, Any] = Field(default_factory=dict)
    steps: list[WorkflowDryRunStepResult] = Field(default_factory=list)
    error_code: str | None = None
    error_message: str | None = None
