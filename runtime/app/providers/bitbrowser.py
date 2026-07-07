from __future__ import annotations

import asyncio
from typing import Any

import httpx

from app.config import settings
from app.providers.base import BrowserProvider
from app.providers.config_store import ProviderConfigStore
from app.schemas.provider import (
    ProfileSyncResult,
    ProviderCapability,
    ProviderConfigField,
    ProviderGroupRef,
    ProviderHealth,
    ProviderProfileRef,
    ProviderSessionRef,
)


class BitBrowserProvider(BrowserProvider):
    provider_type = "bitbrowser"
    display_name = "BitBrowser"
    default_port = 54345

    def __init__(self, *, config_store: ProviderConfigStore) -> None:
        self._config_store = config_store
        self._api_gate = asyncio.Semaphore(3)
        self._lifecycle_gate = asyncio.Semaphore(2)

    @property
    def capabilities(self) -> ProviderCapability:
        return ProviderCapability(
            supports_profile_sync=True,
            supports_window_arrange=True,
            supports_group_tag_sync=True,
            supports_cookie_read=False,
            supports_cookie_write=True,
            supports_proxy_sync=True,
            supports_local_api_port_config=True,
            supports_native_opened_list=True,
            supports_download_dir_control=False,
        )

    def config_fields(self) -> list[ProviderConfigField]:
        return [
            ProviderConfigField(
                key="api_base",
                label="本地 API 地址",
                type="text",
                required=True,
                placeholder=settings.bitbrowser_api_base,
                default_value=settings.bitbrowser_api_base,
                help_text="BitBrowser Local Server 地址，默认常见端口为 http://127.0.0.1:54345。",
            )
        ]

    def default_config_values(self) -> dict[str, Any]:
        return {"api_base": settings.bitbrowser_api_base}

    async def _runtime_config(self) -> dict[str, Any]:
        values = self.default_config_values()
        stored = await self._config_store.get_values(self.provider_type)
        for key, value in stored.items():
            if value not in (None, ""):
                values[key] = value
        values["api_base"] = str(values.get("api_base") or settings.bitbrowser_api_base).rstrip("/")
        return values

    async def _post(self, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        config = await self._runtime_config()
        async with self._api_gate:
            async with httpx.AsyncClient(
                base_url=config["api_base"],
                timeout=settings.bitbrowser_api_timeout_sec,
                trust_env=False,
            ) as client:
                try:
                    response = await client.post(path, json=payload or {})
                    response.raise_for_status()
                except httpx.ConnectError as exc:
                    raise RuntimeError(
                        "BitBrowser 本地 API 无法连接，请确认 BitBrowser 客户端已启动，且 Local Server 地址配置正确"
                    ) from exc
                except httpx.TimeoutException as exc:
                    raise RuntimeError("BitBrowser 本地 API 请求超时，请确认客户端可用") from exc
                except httpx.HTTPStatusError as exc:
                    raise RuntimeError(f"BitBrowser API 请求失败：HTTP {exc.response.status_code}") from exc

        data = response.json()
        if not isinstance(data, dict):
            raise RuntimeError("BitBrowser API 返回格式异常")
        if data.get("success") is not True:
            raise RuntimeError(str(data.get("msg") or "BitBrowser API error"))
        return data

    async def health_check(self) -> ProviderHealth:
        config = await self._runtime_config()
        try:
            await self._post("/health")
            return ProviderHealth(
                installed=True,
                healthy=True,
                message="BitBrowser 本地 API 可访问",
                api_base=config.get("api_base"),
            )
        except Exception as exc:  # noqa: BLE001
            return ProviderHealth(
                installed=False,
                healthy=False,
                message="BitBrowser 本地 API 无法连接",
                api_base=config.get("api_base"),
                details={"error": str(exc)},
            )

    async def sync_profiles(self) -> ProfileSyncResult:
        rows = await self._post_all_rows("/browser/list")
        profiles: list[ProviderProfileRef] = []
        for row in rows:
            profile_id = row.get("id") or row.get("browserId") or row.get("browserID")
            if profile_id in (None, ""):
                continue
            group_id = row.get("groupId") or row.get("groupID")
            profiles.append(
                ProviderProfileRef(
                    provider_type=self.provider_type,
                    external_profile_id=str(profile_id),
                    display_name=str(row.get("name") or row.get("remark") or f"Profile {profile_id}"),
                    group_summary={
                        "id": str(group_id) if group_id not in (None, "") else None,
                        "name": row.get("groupName") or row.get("group_name"),
                    },
                    tag_summary=self._tag_summary(row),
                    proxy_summary={
                        "type": row.get("proxyType"),
                        "ip": row.get("host") or row.get("ip"),
                        "port": row.get("port"),
                    },
                    provider_payload_json=row,
                )
            )
        return ProfileSyncResult(
            provider_type=self.provider_type,
            synced_count=len(profiles),
            profiles=profiles,
        )

    async def list_groups(self) -> list[ProviderGroupRef]:
        rows = await self._post_all_rows("/group/list", {"all": True})
        groups: list[ProviderGroupRef] = []
        for row in rows:
            group_id = row.get("id") or row.get("groupId") or row.get("groupID")
            if group_id in (None, ""):
                continue
            groups.append(
                ProviderGroupRef(
                    provider_type=self.provider_type,
                    external_group_id=str(group_id),
                    display_name=str(row.get("groupName") or row.get("name") or f"Group {group_id}"),
                    profile_count=self._safe_int(
                        row.get("profileCount")
                        or row.get("browserCount")
                        or row.get("browserNum")
                        or row.get("count")
                    ),
                    provider_payload_json=row,
                )
            )
        return groups

    async def list_opened_sessions(self) -> list[ProviderSessionRef]:
        rows = await self._post_all_rows("/browser/list", {"opened": True})
        sessions: list[ProviderSessionRef] = []
        for row in rows:
            profile_id = row.get("id") or row.get("browserId") or row.get("browserID")
            if profile_id in (None, ""):
                continue
            ws_endpoint = row.get("ws") or row.get("webSocketDebuggerUrl")
            debugging_address = self._debugging_address(row)
            sessions.append(
                ProviderSessionRef(
                    provider_type=self.provider_type,
                    provider_profile_id=str(profile_id),
                    provider_session_id=str(row.get("pid")) if row.get("pid") else str(profile_id),
                    browser_pid=self._safe_int(row.get("pid")),
                    ws_endpoint=ws_endpoint,
                    debugging_address=debugging_address,
                    metadata=row,
                )
            )
        return sessions

    async def open_profile(
        self,
        external_profile_id: str,
        *,
        args: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> ProviderSessionRef:
        payload = {
            "id": str(external_profile_id),
            "args": args or [],
            "queue": True,
        }
        if metadata:
            if metadata.get("ignore_default_urls") is not None:
                payload["ignoreDefaultUrls"] = bool(metadata["ignore_default_urls"])
            if metadata.get("new_page_url"):
                payload["newPageUrl"] = str(metadata["new_page_url"])
        async with self._lifecycle_gate:
            data = await self._post("/browser/open", payload)
        opened = data.get("data") if isinstance(data.get("data"), dict) else {}
        return ProviderSessionRef(
            provider_type=self.provider_type,
            provider_profile_id=str(external_profile_id),
            provider_session_id=str(opened.get("pid")) if opened.get("pid") else str(external_profile_id),
            browser_pid=self._safe_int(opened.get("pid")),
            ws_endpoint=opened.get("ws") or opened.get("webSocketDebuggerUrl"),
            debugging_address=self._debugging_address(opened),
            metadata=opened | (metadata or {}),
        )

    async def close_profile(self, external_profile_id: str) -> None:
        async with self._lifecycle_gate:
            await self._post("/browser/close", {"id": str(external_profile_id)})

    async def reset_open_state(self, external_profile_id: str) -> None:
        await self._post("/browser/closing/reset", {"id": str(external_profile_id)})

    async def arrange_windows(self, layout: dict[str, Any]) -> None:
        payload = {
            "type": "box",
            "startX": settings.window_layout_margin_px,
            "startY": settings.window_layout_margin_px,
            "width": max(500, settings.window_layout_default_width),
            "height": max(200, settings.window_layout_default_height),
            "col": max(1, settings.default_slot_limit // 2),
            "spaceX": settings.window_layout_margin_px,
            "spaceY": settings.window_layout_margin_px,
            "offsetX": settings.window_layout_provider_deviation_px,
            "offsetY": settings.window_layout_provider_deviation_px,
            "orderBy": "asc",
            "screenId": settings.window_layout_screen_index,
        }
        if "ids" in layout and layout["ids"]:
            payload["ids"] = [str(item) for item in layout["ids"]]
        if "seqlist" in layout and layout["seqlist"]:
            payload["seqlist"] = layout["seqlist"]
        layout_key_map = {
            "startX": "startX",
            "startY": "startY",
            "width": "width",
            "height": "height",
            "col": "col",
            "spaceX": "spaceX",
            "spaceY": "spaceY",
            "offsetX": "offsetX",
            "offsetY": "offsetY",
            "orderBy": "orderBy",
            "screenId": "screenId",
        }
        for source_key, target_key in layout_key_map.items():
            if source_key in layout and layout[source_key] is not None:
                payload[target_key] = layout[source_key]
        await self._post("/windowbounds", payload)

    async def _post_all_rows(
        self,
        path: str,
        payload: dict[str, Any] | None = None,
        *,
        page_size: int = 100,
    ) -> list[dict[str, Any]]:
        base_payload = payload or {}
        rows: list[dict[str, Any]] = []
        page = 0
        while page < 100:
            data = await self._post(path, {**base_payload, "page": page, "pageSize": page_size})
            page_rows, total = self._page_rows(data)
            rows.extend(page_rows)
            if not page_rows or len(page_rows) < page_size or (total is not None and len(rows) >= total):
                break
            page += 1
        return rows

    @classmethod
    def _page_rows(cls, data: dict[str, Any]) -> tuple[list[dict[str, Any]], int | None]:
        payload = data.get("data", [])
        if isinstance(payload, list):
            return [row for row in payload if isinstance(row, dict)], len(payload)
        if not isinstance(payload, dict):
            return [], None

        rows: list[dict[str, Any]] = []
        for key in ("list", "items", "records", "rows", "data"):
            raw_rows = payload.get(key)
            if isinstance(raw_rows, list):
                rows = [row for row in raw_rows if isinstance(row, dict)]
                break
        if not rows and all(not isinstance(value, list) for value in payload.values()):
            rows = [payload]

        total = None
        for key in ("total", "totalNum", "totalCount", "totalSize", "count"):
            total = cls._safe_int(payload.get(key))
            if total is not None:
                break
        return rows, total

    @staticmethod
    def _debugging_address(row: dict[str, Any]) -> str | None:
        raw = (
            row.get("http")
            or row.get("debugging_address")
            or row.get("debuggingAddress")
            or row.get("debugging_address_ws")
        )
        if raw not in (None, ""):
            return str(raw).removeprefix("http://").removeprefix("https://")
        port = row.get("debugPort") or row.get("remoteDebuggingPort")
        return f"127.0.0.1:{port}" if port not in (None, "") else None

    @staticmethod
    def _tag_summary(row: dict[str, Any]) -> list[dict[str, Any]]:
        tags = row.get("tags") or row.get("tag") or row.get("tagName") or row.get("tagNames") or []
        if isinstance(tags, list):
            return [item if isinstance(item, dict) else {"raw": str(item)} for item in tags]
        if isinstance(tags, dict):
            return [tags]
        if tags:
            return [{"raw": str(tags)}]
        return []

    @staticmethod
    def _safe_int(value: Any) -> int | None:
        try:
            return int(value) if value is not None else None
        except (TypeError, ValueError):
            return None
