from __future__ import annotations

from typing import Any

import pytest

from app.config import settings
from app.providers.base import BrowserProvider
from app.providers.ixbrowser import IxBrowserProvider
from app.schemas.provider import (
    ProfileSyncResult,
    ProviderCapability,
    ProviderGroupRef,
    ProviderHealth,
    ProviderSessionRef,
)
from app.services.batch_service import BatchService
from app.services.execution_service import ExecutionError, ExecutionService
from app.services.window_layout import (
    MacOsWindowLayoutDriver,
    ScreenBounds,
    SlotLayoutCalculator,
    SlotWindow,
    WindowsWindowLayoutDriver,
)


def test_build_provider_tile_layout_uses_ixbrowser_adaptive_payload() -> None:
    layout = BatchService._build_provider_tile_layout(
        active_count=6,
        slot_limit=6,
        runtime_policy={"min_window_width": 420, "min_window_height": 720},
        screen_bounds=(0, 0, 1440, 900),
    )

    assert layout["layout"] == 1
    assert layout["adaptive"] == 1
    assert layout["profile_size_width"] == 420
    assert layout["profile_size_hight"] == 400
    assert layout["per_line_number_of_profiles"] == 3


def test_slot_layout_uses_stable_slot_positions() -> None:
    plan = SlotLayoutCalculator.build_plan(
        slot_limit=6,
        runtime_policy={"min_window_width": 420, "min_window_height": 720},
        screen_bounds=ScreenBounds(0, 0, 1440, 900),
    )

    assert (plan.columns, plan.rows) == (3, 2)
    assert plan.rects[0].x == 10
    assert plan.rects[0].y == 40
    assert plan.rects[5].x > plan.rects[3].x
    assert plan.rects[5].y > plan.rects[2].y


def test_build_macos_layout_script_targets_slot_pids() -> None:
    plan = SlotLayoutCalculator.build_plan(
        slot_limit=6,
        runtime_policy={"min_window_width": 420, "min_window_height": 720},
        screen_bounds=ScreenBounds(0, 0, 1440, 900),
    )
    script = MacOsWindowLayoutDriver.build_script(
        windows=[SlotWindow(slot_index=0, pid=123), SlotWindow(slot_index=5, pid=456)],
        plan=plan,
    )

    assert "set targetPids to {123, 456}" in script
    assert "set targetPositions" in script
    assert "unix id of p" in script
    assert "set position of targetWindow" in script


def test_build_windows_layout_script_uses_win32_and_slot_rects() -> None:
    plan = SlotLayoutCalculator.build_plan(
        slot_limit=6,
        runtime_policy={"min_window_width": 420, "min_window_height": 720},
        screen_bounds=ScreenBounds(0, 0, 1440, 900),
    )
    script = WindowsWindowLayoutDriver.build_script(
        windows=[SlotWindow(slot_index=0, pid=123), SlotWindow(slot_index=5, pid=456)],
        plan=plan,
    )

    assert "SetWindowPos" in script
    assert "Pid = 123" in script
    assert "Pid = 456" in script
    assert "W = 420" in script


@pytest.mark.asyncio
async def test_ixbrowser_arrange_windows_sends_documented_tile_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    provider = IxBrowserProvider()
    sent: dict[str, Any] = {}

    async def fake_post(path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        sent["path"] = path
        sent["payload"] = payload or {}
        return {"error": {"code": 0}, "data": {}}

    monkeypatch.setattr(provider, "_post", fake_post)

    await provider.arrange_windows({"adaptive": 1, "per_line_number_of_profiles": 4})

    assert sent["path"] == "/api/v2/profile-opened-list-arrange-tile"
    assert sent["payload"]["adaptive"] == 1
    assert sent["payload"]["layout"] == 1
    assert sent["payload"]["profile_size_hight"] == 500
    assert sent["payload"]["per_line_number_of_profiles"] == 4


class SlowProvider(BrowserProvider):
    provider_type = "slow"
    display_name = "Slow"

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
        return []

    async def open_profile(
        self,
        external_profile_id: str,
        *,
        args: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> ProviderSessionRef:
        import asyncio

        await asyncio.sleep(1)
        return ProviderSessionRef(provider_type=self.provider_type, provider_profile_id=external_profile_id)

    async def close_profile(self, external_profile_id: str) -> None:
        return None

    async def reset_open_state(self, external_profile_id: str) -> None:
        return None

    async def arrange_windows(self, layout: dict[str, Any]) -> None:
        return None


@pytest.mark.asyncio
async def test_open_provider_session_timeout_becomes_execution_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "provider_open_timeout_sec", 0.01)
    monkeypatch.setattr(settings, "profile_open_retry_attempts", 1)

    with pytest.raises(ExecutionError, match="打开 Profile 101 超过"):
        await ExecutionService(session_factory=None, monitor=None)._open_provider_session(SlowProvider(), "101")
