from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.db import Base
from app.models import BatchRecord, BatchStatus, WorkflowTemplateRecord
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


class CountingProvider(UnhealthyProvider):
    def __init__(self, provider_type: str, display_name: str, *, healthy: bool) -> None:
        self.provider_type = provider_type
        self.display_name = display_name
        self.healthy = healthy
        self.health_calls = 0

    async def health_check(self) -> ProviderHealth:
        self.health_calls += 1
        return ProviderHealth(
            installed=self.healthy,
            healthy=self.healthy,
            message="ok" if self.healthy else "not ready",
        )


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


def make_multi_provider_service(async_session, providers: list[BrowserProvider], monitor: FakeMonitor) -> BatchService:
    registry = ProviderRegistry()
    for provider in providers:
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
            workflow_id="workflow-health-check",
            status=BatchStatus.FAILED,
            input_source="file",
            result_summary_json={"previous": "result"},
            success_count=1,
            failure_count=2,
        )
        workflow = WorkflowTemplateRecord(
            id="workflow-health-check",
            name="Health workflow",
            folder="未分组",
            target_provider_type="fake",
            workflow_yaml="metadata:\n  name: Health workflow\nprofile_policy:\n  provider_type: fake\n  selection_mode: by_group\n  group_ids: [g1]\nsteps:\n  - id: wait-1\n    type: sleep\n    label: wait\n",
            normalized_workflow_json={
                "metadata": {"name": "Health workflow", "version": "1.0.0"},
                "profile_policy": {
                    "provider_type": "fake",
                    "selection_mode": "by_group",
                    "group_ids": ["g1"],
                    "profile_ids": [],
                    "tag_ids": [],
                },
                "runtime_policy": {},
                "steps": [{"id": "wait-1", "type": "sleep", "label": "wait"}],
                "locators": {},
                "inputs": {},
            },
        )
        session.add(batch)
        session.add(workflow)
        await session.commit()
        await session.refresh(batch)

        with pytest.raises(ValueError, match="Fake Browser 未就绪"):
            await service.start_batch(
                session,
                batch.id,
                StartBatchRequest(workflow_id="workflow-health-check", provider_type="fake"),
            )

        await session.refresh(batch)
        assert batch.status == BatchStatus.FAILED
        assert batch.result_summary_json == {"previous": "result"}
        assert batch.success_count == 1
        assert batch.failure_count == 2
        assert monitor.events[0][0] == "provider.health_failed"
        assert monitor.events[0][1]["provider_type"] == "fake"


@pytest.mark.asyncio
async def test_start_batch_checks_workflow_provider_not_existing_batch_provider() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async_session = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    workflow_provider = CountingProvider("workflow-provider", "Workflow Browser", healthy=False)
    old_batch_provider = CountingProvider("old-provider", "Old Browser", healthy=True)
    monitor = FakeMonitor()
    service = make_multi_provider_service(async_session, [workflow_provider, old_batch_provider], monitor)

    async with async_session() as session:
        workflow = WorkflowTemplateRecord(
            id="workflow-provider-check",
            name="Provider source workflow",
            folder="未分组",
            target_provider_type="workflow-provider",
            workflow_yaml="metadata:\n  name: Provider source workflow\nprofile_policy:\n  provider_type: workflow-provider\n  selection_mode: by_group\n  group_ids: [g1]\nsteps:\n  - id: wait-1\n    type: sleep\n    label: wait\n",
            normalized_workflow_json={
                "metadata": {"name": "Provider source workflow", "version": "1.0.0"},
                "profile_policy": {
                    "provider_type": "workflow-provider",
                    "selection_mode": "by_group",
                    "group_ids": ["g1"],
                    "profile_ids": [],
                    "tag_ids": [],
                },
                "runtime_policy": {},
                "steps": [{"id": "wait-1", "type": "sleep", "label": "wait"}],
                "locators": {},
                "inputs": {},
            },
        )
        batch = BatchRecord(
            name="Provider source batch",
            provider_type="old-provider",
            workflow_id=workflow.id,
            status=BatchStatus.FAILED,
            input_source="file",
        )
        session.add_all([workflow, batch])
        await session.commit()
        await session.refresh(batch)

        with pytest.raises(ValueError, match="Workflow Browser 未就绪"):
            await service.start_batch(
                session,
                batch.id,
                StartBatchRequest(workflow_id=workflow.id, provider_type="workflow-provider"),
            )

    assert workflow_provider.health_calls == 1
    assert old_batch_provider.health_calls == 0
