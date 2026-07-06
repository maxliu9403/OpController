from __future__ import annotations

from pathlib import Path
from typing import Any

from app.config import settings
from app.providers.registry import ProviderRegistry
from app.schemas.common import HealthSummary
from app.schemas.system import RuntimePathSummary, SystemCheckResult


class SystemService:
    def __init__(self, registry: ProviderRegistry) -> None:
        self.registry = registry

    def ensure_directories(self) -> None:
        for path in (
            settings.base_dir,
            settings.data_dir,
            settings.log_dir,
            settings.artifact_dir,
            settings.export_dir,
            settings.cache_dir,
            settings.schedule_input_dir,
        ):
            Path(path).mkdir(parents=True, exist_ok=True)

    async def system_check(self) -> SystemCheckResult:
        self.ensure_directories()
        providers = [await provider.describe() for provider in self.registry.list()]
        return SystemCheckResult(
            app_name=settings.app_name,
            runtime_origin=f"http://{settings.host}:{settings.port}",
            paths=RuntimePathSummary(
                base_dir=str(settings.base_dir),
                data_dir=str(settings.data_dir),
                db_path=str(settings.db_path),
                log_dir=str(settings.log_dir),
                artifact_dir=str(settings.artifact_dir),
                export_dir=str(settings.export_dir),
                cache_dir=str(settings.cache_dir),
            ),
            runtime_health=HealthSummary(
                healthy=True,
                message="runtime ready",
                details={"timezone": settings.timezone},
            ),
            providers=providers,
            diagnostics={"python_runtime": "3.12+", "storage": "sqlite"},
        )
