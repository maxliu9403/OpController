from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from app.schemas.common import HealthSummary
from app.schemas.provider import ProviderInfo


class RuntimePathSummary(BaseModel):
    base_dir: str
    data_dir: str
    db_path: str
    log_dir: str
    artifact_dir: str
    export_dir: str
    cache_dir: str


class SystemCheckResult(BaseModel):
    app_name: str
    runtime_origin: str
    paths: RuntimePathSummary
    runtime_health: HealthSummary
    providers: list[ProviderInfo] = Field(default_factory=list)
    diagnostics: dict[str, Any] = Field(default_factory=dict)

