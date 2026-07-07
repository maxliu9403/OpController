from __future__ import annotations

from typing import Any

import pytest

from app.providers.base import BrowserProvider
from app.providers.registry import ProviderRegistry
from app.schemas.provider import (
    ProfileSyncResult,
    ProviderCapability,
    ProviderConfigField,
    ProviderConfigUpdate,
    ProviderGroupRef,
    ProviderHealth,
    ProviderProfileRef,
    ProviderSessionRef,
)
from app.services.provider_service import ProviderService


def make_session(
    profile_id: str = "101",
    *,
    ws: str | None = None,
    debug: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> ProviderSessionRef:
    return ProviderSessionRef(
        provider_type="fake",
        provider_profile_id=profile_id,
        ws_endpoint=ws,
        debugging_address=debug,
        metadata=metadata or {},
    )


class FakeProvider(BrowserProvider):
    provider_type = "fake"
    display_name = "Fake Browser"

    def __init__(
        self,
        *,
        opened_sessions: list[ProviderSessionRef] | None = None,
        open_results: list[ProviderSessionRef] | None = None,
        open_errors: list[RuntimeError] | None = None,
    ) -> None:
        self.opened_sessions = opened_sessions or []
        self.open_results = open_results or []
        self.open_errors = open_errors or []
        self.open_calls = 0
        self.close_calls = 0
        self.reset_calls = 0

    @property
    def capabilities(self) -> ProviderCapability:
        return ProviderCapability()

    async def health_check(self) -> ProviderHealth:
        return ProviderHealth(installed=True, healthy=True, message="ok")

    async def sync_profiles(self) -> ProfileSyncResult:
        return ProfileSyncResult(provider_type=self.provider_type, synced_count=0, profiles=[])

    async def list_groups(self) -> list[ProviderGroupRef]:
        return []

    async def list_opened_sessions(self) -> list[ProviderSessionRef]:
        return self.opened_sessions

    async def open_profile(
        self,
        external_profile_id: str,
        *,
        args: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> ProviderSessionRef:
        self.open_calls += 1
        if self.open_errors:
            raise self.open_errors.pop(0)
        result = self.open_results.pop(0) if self.open_results else make_session(external_profile_id)
        if metadata:
            result = result.model_copy(update={"metadata": result.metadata | metadata})
        self.opened_sessions = [result]
        return result

    async def close_profile(self, external_profile_id: str) -> None:
        self.close_calls += 1
        self.opened_sessions = []

    async def reset_open_state(self, external_profile_id: str) -> None:
        self.reset_calls += 1
        self.opened_sessions = []

    async def arrange_windows(self, layout: dict[str, Any]) -> None:
        return None


class ConfigProvider(FakeProvider):
    def config_fields(self) -> list[ProviderConfigField]:
        return [
            ProviderConfigField(
                key="api_base",
                label="API 地址",
                type="text",
                required=True,
                default_value="http://localhost:8848/api/v2",
            ),
            ProviderConfigField(
                key="api_key",
                label="API Key",
                type="password",
                required=True,
                secret=True,
            ),
        ]

    def default_config_values(self) -> dict[str, Any]:
        return {"api_base": "http://localhost:8848/api/v2"}


class MemoryConfigStore:
    def __init__(self, values: dict[str, Any] | None = None) -> None:
        self.values = values or {}

    async def get_values(self, provider_type: str) -> dict[str, Any]:
        return dict(self.values)

    async def save_values(self, provider_type: str, values: dict[str, Any]) -> dict[str, Any]:
        self.values = dict(values)
        return dict(self.values)


def make_service(provider: FakeProvider) -> ProviderService:
    registry = ProviderRegistry()
    registry.register(provider)
    return ProviderService(registry)


def make_config_service(provider: ConfigProvider, store: MemoryConfigStore) -> ProviderService:
    registry = ProviderRegistry()
    registry.register(provider)
    return ProviderService(registry, config_store=store)  # type: ignore[arg-type]


@pytest.fixture(autouse=True)
def no_provider_service_sleep(monkeypatch: pytest.MonkeyPatch) -> None:
    async def no_sleep(delay: float) -> None:
        return None

    monkeypatch.setattr("app.services.provider_service.asyncio.sleep", no_sleep)


@pytest.mark.asyncio
async def test_open_test_session_returns_existing_attachable_session() -> None:
    provider = FakeProvider(opened_sessions=[make_session(ws="ws://ok")])
    service = make_service(provider)

    session = await service.open_test_session("fake", "101")

    assert session.ws_endpoint == "ws://ok"
    assert provider.open_calls == 0
    assert provider.close_calls == 0


@pytest.mark.asyncio
async def test_open_test_session_reopens_existing_session_without_debug_endpoint() -> None:
    provider = FakeProvider(
        opened_sessions=[make_session()],
        open_results=[make_session(ws="ws://ok")],
    )
    service = make_service(provider)

    session = await service.open_test_session("fake", "101")

    assert session.ws_endpoint == "ws://ok"
    assert session.metadata["reopened_for_debug_attach"] is True
    assert session.metadata["reopen_reason"] == "existing_session_missing_debug_endpoint"
    assert provider.close_calls == 1
    assert provider.open_calls == 1


@pytest.mark.asyncio
async def test_open_test_session_reopens_when_open_returns_no_debug_endpoint() -> None:
    provider = FakeProvider(
        open_results=[
            make_session(),
            make_session(debug="127.0.0.1:9222"),
        ],
    )
    service = make_service(provider)

    session = await service.open_test_session("fake", "101")

    assert session.debugging_address == "127.0.0.1:9222"
    assert session.metadata["reopen_reason"] == "open_profile_missing_debug_endpoint"
    assert provider.close_calls == 1
    assert provider.open_calls == 2


@pytest.mark.asyncio
async def test_open_test_session_reopens_when_provider_reports_already_open() -> None:
    provider = FakeProvider(
        open_errors=[RuntimeError("profile already opened")],
        open_results=[make_session(ws="ws://ok")],
    )
    service = make_service(provider)

    session = await service.open_test_session("fake", "101")

    assert session.ws_endpoint == "ws://ok"
    assert session.metadata["reopen_reason"] == "provider_reported_already_open"
    assert provider.close_calls == 1
    assert provider.open_calls == 2


@pytest.mark.asyncio
async def test_open_test_session_raises_when_reopen_still_has_no_debug_endpoint() -> None:
    provider = FakeProvider(
        opened_sessions=[make_session()],
        open_results=[make_session()],
    )
    service = make_service(provider)

    with pytest.raises(RuntimeError, match="未返回可附着的调试地址"):
        await service.open_test_session("fake", "101")


@pytest.mark.asyncio
async def test_provider_config_secret_can_be_revealed_without_unmasking_default_config() -> None:
    provider = ConfigProvider()
    store = MemoryConfigStore({"api_base": "http://localhost:8848/api/v2", "api_key": "plain-secret"})
    service = make_config_service(provider, store)

    config = await service.get_config("fake")
    assert config.values["api_key"] == ProviderService.MASKED_SECRET
    assert config.credential_status.masked_fields["api_key"] == "pl********et"

    secret = await service.reveal_config_secret("fake", "api_key")
    assert secret.value == "plain-secret"

    await service.save_config("fake", ProviderConfigUpdate(values={"api_key": ProviderService.MASKED_SECRET}))
    secret_after_masked_save = await service.reveal_config_secret("fake", "api_key")
    assert secret_after_masked_save.value == "plain-secret"
