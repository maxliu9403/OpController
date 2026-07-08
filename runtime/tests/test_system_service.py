from __future__ import annotations

import pytest

from app.config import settings
from app.providers.registry import ProviderRegistry
from app.services.system_service import SystemService


@pytest.mark.asyncio
async def test_system_check_includes_runtime_and_desktop_versions(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    monkeypatch.setattr(settings, "base_dir", tmp_path)
    monkeypatch.setattr(settings, "runtime_version", "0.2.0")
    monkeypatch.setattr(settings, "desktop_version", "0.2.0")

    service = SystemService(registry=ProviderRegistry())

    result = await service.system_check()

    assert result.runtime_version == "0.2.0"
    assert result.desktop_version == "0.2.0"
    assert result.runtime_health.details["desktop_version"] == "0.2.0"
