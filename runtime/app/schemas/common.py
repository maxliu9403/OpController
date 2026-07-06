from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


class APIMessage(BaseModel):
    code: str = "ok"
    message: str = "success"


class TimestampedModel(BaseModel):
    created_at: datetime | None = None
    updated_at: datetime | None = None


class HealthSummary(BaseModel):
    healthy: bool
    message: str
    details: dict[str, Any] = Field(default_factory=dict)


class ChartMetric(BaseModel):
    label: str
    value: int | float


class RuntimeModeOption(BaseModel):
    mode: Literal["visual", "throughput"]
    label: str
    description: str

