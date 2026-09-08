from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest

from app.api import pick_locator_once
from app.providers.bitbrowser import BitBrowserProvider
from app.providers.registry import ProviderRegistry
from app.schemas.preview import LocatorLivePreviewResult, LocatorPickOnceRequest
from app.services.locator_service import LocatorService
from app.services.provider_service import ProviderService


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
                    "remark": "店铺 A 主账号",
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
    assert profile.remark == "店铺 A 主账号"
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
        if path == "/browser/pids/all":
            return {"success": True, "data": {"b-1": 31295}}
        if path == "/browser/ports":
            return {"success": True, "data": {"b-1": "53325"}}
        return {"success": True, "data": {}}

    monkeypatch.setattr(provider, "_post", fake_post)

    opened = await provider.open_profile("b-1")
    sessions = await provider.list_opened_sessions()
    await provider.close_profile("b-1")
    await provider.reset_open_state("b-1")
    await provider.arrange_windows(
        {
            "ids": ["b-1"],
            "starting_position_x": 10,
            "starting_position_y": 40,
            "profile_size_width": 420,
            "profile_size_hight": 400,
            "per_line_number_of_profiles": 3,
            "screen": 0,
        }
    )

    assert opened.ws_endpoint == "ws://127.0.0.1:53325/devtools/browser/abc"
    assert opened.debugging_address == "127.0.0.1:53325"
    assert opened.browser_pid == 31295
    assert sessions[0].provider_profile_id == "b-1"
    assert sessions[0].debugging_address == "127.0.0.1:53325"
    assert sessions[0].browser_pid == 31295
    assert calls[0] == ("/browser/open", {"id": "b-1", "args": [], "queue": True})
    assert ("/browser/close", {"id": "b-1"}) in calls
    assert ("/browser/closing/reset", {"id": "b-1"}) in calls
    arrange_call = calls[-1]
    assert arrange_call[0] == "/windowbounds"
    assert arrange_call[1]["ids"] == ["b-1"]
    assert arrange_call[1]["startX"] == 10
    assert arrange_call[1]["startY"] == 40
    assert arrange_call[1]["width"] == 420
    assert arrange_call[1]["height"] == 400
    assert arrange_call[1]["col"] == 3


def test_bitbrowser_page_rows_accepts_common_shapes() -> None:
    rows, total = BitBrowserProvider._page_rows(
        {"success": True, "data": {"list": [{"id": "b-1"}], "total": 12}}
    )

    assert rows == [{"id": "b-1"}]
    assert total == 12


@pytest.mark.asyncio
async def test_bitbrowser_pick_after_test_open_with_profile_list_without_debug_address(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider = make_provider()
    opened = False
    endpoint = "ws://127.0.0.1:53325/devtools/browser/abc"

    async def fake_post(path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        nonlocal opened
        if path == "/browser/open":
            opened = True
            return {"success": True, "data": {"ws": endpoint, "http": "127.0.0.1:53325", "pid": 31295}}
        if path == "/browser/list":
            return {"success": True, "data": {"list": [{"id": "b-1", "name": "Test browser"}] if opened else []}}
        if path == "/browser/pids/all":
            return {"success": True, "data": {"b-1": 31295} if opened else {}}
        if path == "/browser/ports":
            return {"success": True, "data": {"b-1": 53325} if opened else {}}
        raise AssertionError(f"unexpected path: {path}")

    monkeypatch.setattr(provider, "_post", fake_post)
    registry = ProviderRegistry()
    registry.register(provider)
    service = ProviderService(registry)
    session = await service.open_test_session("bitbrowser", "b-1")
    assert session.ws_endpoint == endpoint
    assert (await service.list_opened_sessions("bitbrowser"))[0].provider_profile_id == "b-1"

    execution = SimpleNamespace(
        pick_locator_once=AsyncMock(return_value={"tag_name": "button", "text": "Continue", "attributes": {"id": "continue"}}),
        preview_locator=AsyncMock(return_value=LocatorLivePreviewResult(success=True, match_count=1)),
    )
    runtime = SimpleNamespace(provider_service=service, execution_service=execution, locator_service=LocatorService())
    result = await pick_locator_once(
        LocatorPickOnceRequest(provider_type="bitbrowser", external_profile_id="b-1"), runtime
    )

    assert result["success"] is True
    execution.pick_locator_once.assert_awaited_once_with(endpoint="127.0.0.1:53325", timeout_sec=30)


@pytest.mark.asyncio
async def test_bitbrowser_sessions_follow_external_open_restart_and_close(monkeypatch: pytest.MonkeyPatch) -> None:
    provider = make_provider()
    pids: dict[str, Any] = {"b-1": "31295", "closed": 0}
    ports: dict[str, Any] = {"b-1": "53325", "closed": "53326"}

    async def fake_post(path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        if path == "/browser/pids/all":
            return {"success": True, "data": dict(pids)}
        if path == "/browser/ports":
            return {"success": True, "data": dict(ports)}
        raise AssertionError(f"Session discovery must not open or close profiles: {path}")

    monkeypatch.setattr(provider, "_post", fake_post)
    registry = ProviderRegistry()
    registry.register(provider)
    service = ProviderService(registry)

    # Reuse a window opened outside OpController without restarting it.
    session = await service.open_test_session("bitbrowser", "b-1")
    assert session.debugging_address == "127.0.0.1:53325"
    assert session.browser_pid == 31295
    assert len(await service.list_opened_sessions("bitbrowser")) == 1

    pids["b-1"] = 40000
    ports["b-1"] = "54444"
    restarted = await service.get_opened_session("bitbrowser", "b-1")
    assert restarted is not None
    assert restarted.debugging_address == "127.0.0.1:54444"
    assert restarted.browser_pid == 40000

    # A stale port alone must not keep a closed window listed as open.
    pids.clear()
    assert await service.get_opened_session("bitbrowser", "b-1") is None


@pytest.mark.asyncio
@pytest.mark.parametrize("port", [None, "", "invalid", "0", -1, 65536])
async def test_bitbrowser_live_session_without_valid_port_is_not_attachable(
    monkeypatch: pytest.MonkeyPatch, port: Any,
) -> None:
    provider = make_provider()

    async def fake_post(path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        if path == "/browser/pids/all":
            return {"success": True, "data": {"b-1": 31295}}
        assert path == "/browser/ports"
        return {"success": True, "data": {"b-1": port} if port is not None else {}}

    monkeypatch.setattr(provider, "_post", fake_post)
    sessions = await provider.list_opened_sessions()

    assert len(sessions) == 1
    assert sessions[0].browser_pid == 31295
    assert sessions[0].ws_endpoint is None
    assert sessions[0].debugging_address is None


@pytest.mark.asyncio
@pytest.mark.parametrize("envelope", [True, False])
@pytest.mark.parametrize("pids", [{}, {"b-1": 31295}])
async def test_bitbrowser_live_pid_response_accepts_documented_envelopes(
    monkeypatch: pytest.MonkeyPatch, envelope: bool, pids: dict[str, int],
) -> None:
    provider = make_provider()

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/browser/pids/all"
        return httpx.Response(200, json={"success": True, "data": pids} if envelope else pids)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://bitbrowser.test") as client:
        monkeypatch.setattr(provider, "_client_for_config", AsyncMock(return_value=client))
        response = await provider._post("/browser/pids/all")

    assert response["data"] == pids


@pytest.mark.asyncio
async def test_bitbrowser_session_lookup_preserves_provider_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    provider = make_provider()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"success": False, "msg": "Local Server unavailable"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://bitbrowser.test") as client:
        monkeypatch.setattr(provider, "_client_for_config", AsyncMock(return_value=client))
        with pytest.raises(RuntimeError, match="Local Server unavailable"):
            await provider.list_opened_sessions()
