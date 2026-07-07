from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.db import Base
from app.models import BatchRecord, BatchStatus
from app.providers.base import BrowserProvider
from app.providers.registry import ProviderRegistry
from app.schemas.batch import StartBatchRequest
from app.schemas.provider import (
    ProfileSyncResult,
    ProviderCapability,
    ProviderGroupRef,
    ProviderHealth,
    ProviderSessionRef,
)
from app.services.batch_service import BatchService
from app.services.workflow_service import WorkflowService


class FakeMonitor:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, Any]]] = []

    async def publish(self, event: str, payload: dict[str, Any]) -> None:
        self.events.append((event, payload))


class UnhealthyProvider(BrowserProvider):
    provider_type = "fake"
    display_name = "Fake Browser"

    @property
    def capabilities(self) -> ProviderCapability:
        return ProviderCapability()

    async def health_check(self) -> ProviderHealth:
        return ProviderHealth(
            installed=False,
            healthy=False,
            message="Local API unreachable",
            api_base="http://127.0.0.1:9999",
        )

    async def sync_profiles(self) -> ProfileSyncResult:
        return ProfileSyncResult(provider_type=self.provider_type, synced_count=0, profiles=[])

    async def list_groups(self) -> list[ProviderGroupRef]:
        return []

    async def list_opened_sessions(self) -> list[ProviderSessionRef]:
        return []

    async def open_profile(
        self,
        external_profile_id: str,
        *,
        args: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> ProviderSessionRef:
        return ProviderSessionRef(provider_type=self.provider_type, provider_profile_id=external_profile_id)

    async def close_profile(self, external_profile_id: str) -> None:
        return None

    async def reset_open_state(self, external_profile_id: str) -> None:
        return None

    async def arrange_windows(self, layout: dict[str, Any]) -> None:
        return None


def make_service(async_session, provider: BrowserProvider, monitor: FakeMonitor) -> BatchService:
    registry = ProviderRegistry()
    registry.register(provider)
    return BatchService(
        session_factory=async_session,
        registry=registry,
        provider_service=None,
        workflow_service=WorkflowService(root_dir=Path(".")),
        execution_service=None,
        monitor=monitor,
    )


@pytest.mark.asyncio
async def test_start_batch_blocks_when_provider_health_check_fails() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async_session = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    monitor = FakeMonitor()
    service = make_service(async_session, UnhealthyProvider(), monitor)
    async with async_session() as session:
        batch = BatchRecord(
            name="Health gated batch",
            provider_type="fake",
            workflow_id="workflow-not-read-before-health-check",
            status=BatchStatus.FAILED,
            input_source="file",
            result_summary_json={"previous": "result"},
            success_count=1,
            failure_count=2,
        )
        session.add(batch)
        await session.commit()
        await session.refresh(batch)

        with pytest.raises(ValueError, match="Fake Browser 未就绪"):
            await service.start_batch(
                session,
                batch.id,
                StartBatchRequest(workflow_id="workflow-not-read-before-health-check", provider_type="fake"),
            )

        await session.refresh(batch)
        assert batch.status == BatchStatus.FAILED
        assert batch.result_summary_json == {"previous": "result"}
        assert batch.success_count == 1
        assert batch.failure_count == 2
        assert monitor.events[0][0] == "provider.health_failed"
        assert monitor.events[0][1]["provider_type"] == "fake"
