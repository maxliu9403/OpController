from __future__ import annotations

from typing import Any

import httpx
import pytest

from app.providers.nstbrowser import NstBrowserProvider


class MemoryConfigStore:
    def __init__(self, values: dict[str, Any] | None = None) -> None:
        self.values = values or {}

    async def get_values(self, provider_type: str) -> dict[str, Any]:
        return dict(self.values)


def make_provider(values: dict[str, Any] | None = None) -> NstBrowserProvider:
    return NstBrowserProvider(config_store=MemoryConfigStore(values))  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_nstbrowser_config_fields_and_missing_key_health() -> None:
    provider = make_provider({"api_base": "http://localhost:8848/api/v2"})

    fields = provider.config_fields()
    assert [field.key for field in fields] == ["api_base", "api_key"]
    assert fields[1].secret is True

    health = await provider.health_check()
    assert health.healthy is False
    assert health.message == "请先配置 NSTBrowser API Key"
    assert health.details["missing_required_fields"] == ["api_key"]


@pytest.mark.asyncio
async def test_nstbrowser_request_sends_api_key_header(monkeypatch: pytest.MonkeyPatch) -> None:
    provider = make_provider(
        {
            "api_base": "http://localhost:8848/api/v2",
            "api_key": "secret-key",
        }
    )
    captured: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["x-api-key"] = request.headers.get("x-api-key", "")
        return httpx.Response(200, json={"code": 0, "data": []})

    transport = httpx.MockTransport(handler)
    original_client = httpx.AsyncClient

    def client_factory(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = transport
        return original_client(*args, **kwargs)

    monkeypatch.setattr("app.providers.nstbrowser.httpx.AsyncClient", client_factory)

    await provider._request("GET", "/browsers")

    assert captured["x-api-key"] == "secret-key"


@pytest.mark.asyncio
async def test_nstbrowser_request_accepts_code_200_success(monkeypatch: pytest.MonkeyPatch) -> None:
    provider = make_provider(
        {
            "api_base": "http://localhost:8848/api/v2",
            "api_key": "secret-key",
        }
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"code": 200, "err": False, "msg": "success", "data": None})

    transport = httpx.MockTransport(handler)
    original_client = httpx.AsyncClient

    def client_factory(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = transport
        return original_client(*args, **kwargs)

    monkeypatch.setattr("app.providers.nstbrowser.httpx.AsyncClient", client_factory)

    result = await provider._request("GET", "/browsers")

    assert result["code"] == 200
    assert result["err"] is False


@pytest.mark.asyncio
async def test_nstbrowser_profiles_sync_follows_local_api_redirect(monkeypatch: pytest.MonkeyPatch) -> None:
    provider = make_provider(
        {
            "api_base": "http://localhost:8848/api/v2",
            "api_key": "secret-key",
        }
    )
    seen_paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_paths.append(request.url.path)
        if request.url.path == "/api/v2/profiles":
            return httpx.Response(301, headers={"Location": "/api/v2/profiles/"})
        if request.url.path == "/api/v2/profiles/":
            return httpx.Response(
                200,
                json={
                    "code": 0,
                    "data": {
                        "docs": [
                            {
                                "profileId": "p-redirect",
                                "name": "Redirect Profile",
                                "group": {"groupId": "g-1", "name": "默认组"},
                            }
                        ],
                        "totalDocs": 1,
                    },
                },
            )
        raise AssertionError(f"unexpected path: {request.url.path}")

    transport = httpx.MockTransport(handler)
    original_client = httpx.AsyncClient

    def client_factory(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = transport
        return original_client(*args, **kwargs)

    monkeypatch.setattr("app.providers.nstbrowser.httpx.AsyncClient", client_factory)

    result = await provider.sync_profiles()

    assert seen_paths == ["/api/v2/profiles", "/api/v2/profiles/"]
    assert result.synced_count == 1
    assert result.profiles[0].external_profile_id == "p-redirect"


@pytest.mark.asyncio
async def test_nstbrowser_profile_mapping(monkeypatch: pytest.MonkeyPatch) -> None:
    provider = make_provider({"api_key": "secret-key"})

    async def fake_get_all_profiles() -> list[dict[str, Any]]:
        return [
            {
                "profileId": "p-1",
                "name": "运营账号 1",
                "groupId": "g-1",
                "group": {"groupId": "g-1", "name": "美区账号"},
                "proxyConfig": {"proxyType": "http", "host": "1.2.3.4", "port": 8000},
                "tags": ["vip"],
            }
        ]

    monkeypatch.setattr(provider, "_get_all_profiles", fake_get_all_profiles)

    result = await provider.sync_profiles()

    assert result.provider_type == "nstbrowser"
    assert result.synced_count == 1
    profile = result.profiles[0]
    assert profile.external_profile_id == "p-1"
    assert profile.display_name == "运营账号 1"
    assert profile.group_summary == {"id": "g-1", "name": "美区账号"}
    assert profile.proxy_summary == {"type": "http", "ip": "1.2.3.4", "port": 8000}


@pytest.mark.asyncio
async def test_nstbrowser_group_open_and_session_mapping(monkeypatch: pytest.MonkeyPatch) -> None:
    provider = make_provider({"api_key": "secret-key"})
    calls: list[tuple[str, str]] = []

    async def fake_request(
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json_payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        calls.append((method, path))
        if method == "GET" and path == "/profiles/groups":
            return {"code": 0, "data": [{"groupId": "g-1", "name": "美区账号"}]}
        if method == "POST" and path == "/browsers/p-1":
            return {
                "code": 0,
                "data": {
                    "profileId": "p-1",
                    "port": 9222,
                    "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/browser/abc",
                },
            }
        if method == "GET" and path == "/browsers":
            return {
                "code": 0,
                "data": [
                    {
                        "profileId": "p-1",
                        "running": True,
                        "remoteDebuggingPort": 9222,
                        "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/browser/abc",
                    },
                    {"profileId": "p-2", "running": False, "remoteDebuggingPort": 9333},
                ],
            }
        if method == "DELETE" and path == "/browsers/p-1":
            return {"code": 0, "data": {}}
        raise AssertionError(f"unexpected request: {method} {path}")

    monkeypatch.setattr(provider, "_request", fake_request)

    groups = await provider.list_groups()
    opened = await provider.open_profile("p-1")
    sessions = await provider.list_opened_sessions()
    await provider.close_profile("p-1")

    assert groups[0].external_group_id == "g-1"
    assert groups[0].display_name == "美区账号"
    assert opened.ws_endpoint == "ws://127.0.0.1:9222/devtools/browser/abc"
    assert opened.debugging_address == "127.0.0.1:9222"
    assert len(sessions) == 1
    assert sessions[0].provider_profile_id == "p-1"
    assert sessions[0].debugging_address == "127.0.0.1:9222"
    assert ("DELETE", "/browsers/p-1") in calls
