from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, model_validator


class LocatorCandidate(BaseModel):
    kind: str
    value: str
    score: float
    note: str | None = None


class LocatorSpec(BaseModel):
    primary_selector: str
    fallback_selectors: list[str] = Field(default_factory=list)
    frame_path: list[str] = Field(default_factory=list)
    tag_name: str | None = None
    text_signature: dict[str, Any] = Field(default_factory=dict)
    attribute_signature: dict[str, Any] = Field(default_factory=dict)
    neighbor_anchor_signature: dict[str, Any] = Field(default_factory=dict)
    list_context_signature: dict[str, Any] = Field(default_factory=dict)
    stability_score: float = 0.0
    candidates: list[LocatorCandidate] = Field(default_factory=list)


class WorkflowStep(BaseModel):
    id: str
    type: str
    label: str | None = None
    selector_key: str | None = None
    selector: str | None = None
    url: str | None = None
    value: Any = None
    text: str | None = None
    timeout_sec: int | None = None
    save_as: str | None = None
    click_target_mode: str = "unique"
    random_click_count: int = Field(default=1, ge=1, le=100)
    wait_mode: str | None = None
    on_timeout: str = "fail"
    min_count: int = Field(default=1, ge=0)
    stable_ms: int = Field(default=1200, ge=300, le=10000)
    optional: bool = False
    scroll_direction: str = "down"
    scroll_distance: int = Field(default=320, ge=1, le=50000)
    scroll_repeat: int = Field(default=4, ge=1, le=100)
    scroll_pause_ms: int = Field(default=1200, ge=0, le=10000)
    steps: list["WorkflowStep"] = Field(default_factory=list)


class WorkflowMetadata(BaseModel):
    name: str
    description: str | None = None
    version: str = "1.0.0"


class WorkflowProfilePolicy(BaseModel):
    provider_type: str
    selection_mode: str
    profile_ids: list[str] = Field(default_factory=list)
    group_ids: list[str] = Field(default_factory=list)
    tag_ids: list[str] = Field(default_factory=list)


class WorkflowRuntimePolicy(BaseModel):
    mode: str = "visual"
    min_window_width: int = 420
    min_window_height: int = 720
    page_timeout_sec: int = 30
    step_timeout_sec: int = 15
    retry_once_on_failure: bool = True
    screenshot_on_failure: bool = True
    keep_window_on_failure: bool = False
    keep_window_seconds: int = Field(default=0, ge=0, le=600)
    keep_window_on_success: bool = False
    keep_window_on_success_seconds: int = Field(default=0, ge=0, le=600)
    download_policy: str = "default"


class WorkflowDefinition(BaseModel):
    metadata: WorkflowMetadata
    inputs: dict[str, Any] = Field(default_factory=dict)
    profile_policy: WorkflowProfilePolicy
    runtime_policy: WorkflowRuntimePolicy
    steps: list[WorkflowStep]
    locators: dict[str, LocatorSpec] = Field(default_factory=dict)

    @model_validator(mode="after")
    def ensure_steps(self) -> "WorkflowDefinition":
        if not self.steps:
            raise ValueError("workflow must define at least one step")
        return self


class WorkflowRecord(BaseModel):
    id: str
    name: str
    version: str
    description: str | None = None
    folder: str = "未分组"
    target_provider_type: str
    workflow_yaml: str
    normalized_workflow_json: dict[str, Any]
    selector_catalog_json: dict[str, Any] = Field(default_factory=dict)
    is_builtin: bool = False


class WorkflowValidationResult(BaseModel):
    valid: bool
    errors: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    normalized_workflow_json: dict[str, Any] | None = None


class WorkflowActionCard(BaseModel):
    type: str
    label: str
    description: str
    category: str


class WorkflowFolderRecord(BaseModel):
    id: str | None = None
    name: str
    description: str | None = None
    workflow_count: int = 0


WorkflowStep.model_rebuild()
