from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from sqlalchemy.ext.asyncio import async_sessionmaker

from app.db import SessionLocal
from app.providers.ixbrowser import IxBrowserProvider
from app.providers.registry import ProviderRegistry
from app.services.batch_service import BatchService
from app.services.execution_service import ExecutionService
from app.services.locator_service import LocatorService
from app.services.monitor_service import MonitorService
from app.services.provider_service import ProviderService
from app.services.schedule_service import ScheduleService
from app.services.seed_service import SeedService
from app.services.system_service import SystemService
from app.services.workflow_service import WorkflowService


@dataclass
class RuntimeContext:
    session_factory: async_sessionmaker = SessionLocal
    registry: ProviderRegistry | None = None
    monitor: MonitorService | None = None
    system_service: SystemService | None = None
    provider_service: ProviderService | None = None
    workflow_service: WorkflowService | None = None
    locator_service: LocatorService | None = None
    execution_service: ExecutionService | None = None
    batch_service: BatchService | None = None
    schedule_service: ScheduleService | None = None
    seed_service: SeedService | None = None

    @classmethod
    def build(cls, repo_root: Path) -> "RuntimeContext":
        registry = ProviderRegistry()
        registry.register(IxBrowserProvider())
        monitor = MonitorService()
        workflow_service = WorkflowService(root_dir=repo_root)
        provider_service = ProviderService(registry=registry)
        execution_service = ExecutionService(
            session_factory=SessionLocal,
            monitor=monitor,
            provider_service=provider_service,
        )
        batch_service = BatchService(
            session_factory=SessionLocal,
            registry=registry,
            provider_service=provider_service,
            workflow_service=workflow_service,
            execution_service=execution_service,
            monitor=monitor,
        )
        schedule_service = ScheduleService(
            session_factory=SessionLocal,
            batch_service=batch_service,
            monitor=monitor,
        )
        return cls(
            registry=registry,
            monitor=monitor,
            system_service=SystemService(registry=registry),
            provider_service=provider_service,
            workflow_service=workflow_service,
            locator_service=LocatorService(),
            execution_service=execution_service,
            batch_service=batch_service,
            schedule_service=schedule_service,
            seed_service=SeedService(workflow_service=workflow_service, repo_root=repo_root),
        )
