from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class ScheduleDefinition(BaseModel):
    name: str
    enabled: bool = True
    workflow_id: str
    provider_type: str
    profile_policy_snapshot: dict[str, Any] = Field(default_factory=dict)
    input_source: dict[str, Any] = Field(default_factory=dict)
    schedule_type: str
    schedule_expr: str
    timezone: str = "Asia/Shanghai"
    max_concurrency: int = 1
    retry_once_on_failure: bool = True


class ScheduleRecordOut(BaseModel):
    id: str
    name: str
    status: str
    workflow_id: str
    provider_type: str
    schedule_type: str
    schedule_expr: str
    timezone: str
    next_run_at: datetime | None = None
    last_run_at: datetime | None = None

