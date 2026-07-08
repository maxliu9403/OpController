from __future__ import annotations

from typing import Any

import pytest

from app.providers.ixbrowser import IxBrowserProvider


@pytest.mark.asyncio
async def test_ixbrowser_profile_mapping_includes_remark(monkeypatch: pytest.MonkeyPatch) -> None:
    provider = IxBrowserProvider()

    async def fake_post_all_rows(
        path: str,
        payload: dict[str, Any] | None = None,
        *,
        page_size: int = 100,
    ) -> list[dict[str, Any]]:
        assert path == "/api/v2/profile-list"
        return [
            {
                "profile_id": 101,
                "name": "运营账号 1",
                "remark": "ix 备注账号",
                "group_id": 7,
                "group_name": "美区账号",
                "proxy_type": "http",
                "proxy_ip": "1.2.3.4",
                "proxy_port": 8000,
            }
        ]

    monkeypatch.setattr(provider, "_post_all_rows", fake_post_all_rows)

    result = await provider.sync_profiles()

    assert result.provider_type == "ixbrowser"
    assert result.synced_count == 1
    profile = result.profiles[0]
    assert profile.external_profile_id == "101"
    assert profile.display_name == "运营账号 1"
    assert profile.remark == "ix 备注账号"
    assert profile.group_summary == {"id": 7, "name": "美区账号"}
