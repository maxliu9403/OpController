from __future__ import annotations

from typing import Any

import httpx
import pytest

from app.providers.bitbrowser import BitBrowserProvider


class MemoryConfigStore:
    def __init__(self, values: dict[str, Any] | None = None) -> None:
        self.values = values or {}

    async def get_values(self, provider_type: str) -> dict[str, Any]:
        return dict(self.values)


def make_provider(values: dict[str, Any] | None = None) -> BitBrowserProvider:
    return BitBrowserProvider(config_store=MemoryConfigStore(values))  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_bitbrowser_config_fields_and_health(monkeypatch: pytest.MonkeyPatch) -> None:
    provider = make_provider({"api_base": "http://127.0.0.1:54345"})

    fields = provider.config_fields()
    assert [field.key for field in fields] == ["api_base"]
    assert fields[0].required is True

    async def fake_post(path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        assert path == "/health"
        return {"success": True}

    monkeypatch.setattr(provider, "_post", fake_post)

    health = await provider.health_check()

    assert health.healthy is True
    assert health.message == "BitBrowser 本地 API 可访问"


@pytest.mark.asyncio
async def test_bitbrowser_request_uses_post_json_and_checks_success(monkeypatch: pytest.MonkeyPatch) -> None:
    provider = make_provider({"api_base": "http://127.0.0.1:54345"})
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["path"] = request.url.path
        captured["body"] = request.content
        return httpx.Response(200, json={"success": True, "data": {"ok": 1}})

    transport = httpx.MockTransport(handler)
    original_client = httpx.AsyncClient

    def client_factory(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = transport
        return original_client(*args, **kwargs)

    monkeypatch.setattr("app.providers.bitbrowser.httpx.AsyncClient", client_factory)

    result = await provider._post("/health", {"hello": "world"})

    assert captured["method"] == "POST"
    assert captured["path"] == "/health"
    assert b"hello" in captured["body"]
    assert result["data"]["ok"] == 1


@pytest.mark.asyncio
async def test_bitbrowser_request_turns_api_failure_into_readable_error(monkeypatch: pytest.MonkeyPatch) -> None:
    provider = make_provider()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"success": False, "msg": "窗口不存在"})

    transport = httpx.MockTransport(handler)
    original_client = httpx.AsyncClient

    def client_factory(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = transport
        return original_client(*args, **kwargs)

    monkeypatch.setattr("app.providers.bitbrowser.httpx.AsyncClient", client_factory)

    with pytest.raises(RuntimeError, match="窗口不存在"):
        await provider._post("/browser/open", {"id": "missing"})


@pytest.mark.asyncio
async def test_bitbrowser_profile_and_group_mapping(monkeypatch: pytest.MonkeyPatch) -> None:
    provider = make_provider()

    async def fake_post_all_rows(
        path: str,
        payload: dict[str, Any] | None = None,
        *,
        page_size: int = 100,
    ) -> list[dict[str, Any]]:
        if path == "/browser/list":
            return [
                {
                    "id": "b-1",
                    "name": "运营账号 1",
                    "groupId": "g-1",
                    "groupName": "美区账号",
                    "proxyType": "socks5",
                    "host": "1.2.3.4",
                    "port": 8000,
                    "tagName": "vip",
                }
            ]
        if path == "/group/list":
            assert payload == {"all": True}
            return [{"id": "g-1", "groupName": "美区账号", "browserCount": 7}]
        raise AssertionError(f"unexpected path: {path}")

    monkeypatch.setattr(provider, "_post_all_rows", fake_post_all_rows)

    result = await provider.sync_profiles()
    groups = await provider.list_groups()

    assert result.provider_type == "bitbrowser"
    assert result.synced_count == 1
    profile = result.profiles[0]
    assert profile.external_profile_id == "b-1"
    assert profile.display_name == "运营账号 1"
    assert profile.group_summary == {"id": "g-1", "name": "美区账号"}
    assert profile.proxy_summary == {"type": "socks5", "ip": "1.2.3.4", "port": 8000}
    assert groups[0].external_group_id == "g-1"
    assert groups[0].profile_count == 7


@pytest.mark.asyncio
async def test_bitbrowser_open_close_sessions_and_arrange(monkeypatch: pytest.MonkeyPatch) -> None:
    provider = make_provider()
    calls: list[tuple[str, dict[str, Any] | None]] = []

    async def fake_post(path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        calls.append((path, payload))
        if path == "/browser/open":
            return {
                "success": True,
                "data": {
                    "ws": "ws://127.0.0.1:53325/devtools/browser/abc",
                    "http": "127.0.0.1:53325",
                    "pid": 31295,
                    "seq": 3474,
                },
            }
        return {"success": True, "data": {}}

    async def fake_post_all_rows(
        path: str,
        payload: dict[str, Any] | None = None,
        *,
        page_size: int = 100,
    ) -> list[dict[str, Any]]:
        assert path == "/browser/list"
        assert payload == {"opened": True}
        return [
            {
                "id": "b-1",
                "ws": "ws://127.0.0.1:53325/devtools/browser/abc",
                "http": "127.0.0.1:53325",
                "pid": 31295,
            }
        ]

    monkeypatch.setattr(provider, "_post", fake_post)
    monkeypatch.setattr(provider, "_post_all_rows", fake_post_all_rows)

    opened = await provider.open_profile("b-1")
    sessions = await provider.list_opened_sessions()
    await provider.close_profile("b-1")
    await provider.reset_open_state("b-1")
    await provider.arrange_windows({"ids": ["b-1"], "col": 1})

    assert opened.ws_endpoint == "ws://127.0.0.1:53325/devtools/browser/abc"
    assert opened.debugging_address == "127.0.0.1:53325"
    assert opened.browser_pid == 31295
    assert sessions[0].provider_profile_id == "b-1"
    assert calls[0] == ("/browser/open", {"id": "b-1", "args": [], "queue": True})
    assert ("/browser/close", {"id": "b-1"}) in calls
    assert ("/browser/closing/reset", {"id": "b-1"}) in calls
    arrange_call = calls[-1]
    assert arrange_call[0] == "/windowbounds"
    assert arrange_call[1]["ids"] == ["b-1"]
    assert arrange_call[1]["col"] == 1


def test_bitbrowser_page_rows_accepts_common_shapes() -> None:
    rows, total = BitBrowserProvider._page_rows(
        {"success": True, "data": {"list": [{"id": "b-1"}], "total": 12}}
    )

    assert rows == [{"id": "b-1"}]
    assert total == 12
