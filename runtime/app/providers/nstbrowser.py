from __future__ import annotations

import asyncio
from typing import Any
from urllib.parse import quote

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


class NstBrowserProvider(BrowserProvider):
    provider_type = "nstbrowser"
    display_name = "NSTBrowser"
    default_port = 8848

    def __init__(self, *, config_store: ProviderConfigStore) -> None:
        self._config_store = config_store
        self._api_gate = asyncio.Semaphore(3)
        self._lifecycle_gate = asyncio.Semaphore(2)

    @property
    def capabilities(self) -> ProviderCapability:
        return ProviderCapability(
            supports_profile_sync=True,
            supports_window_arrange=False,
            supports_group_tag_sync=True,
            supports_cookie_read=False,
            supports_cookie_write=False,
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
                placeholder=settings.nstbrowser_api_base,
                default_value=settings.nstbrowser_api_base,
                help_text="默认 NSTBrowser 本地客户端 API： http://localhost:8848/api/v2",
            ),
            ProviderConfigField(
                key="api_key",
                label="API Key",
                type="password",
                required=True,
                secret=True,
                placeholder="请输入 NSTBrowser API Key",
                help_text="NSTBrowser API 请求头会使用 x-api-key。",
            ),
        ]

    def default_config_values(self) -> dict[str, Any]:
        return {
            "api_base": settings.nstbrowser_api_base,
            "api_key": settings.nstbrowser_api_key,
        }

    async def _runtime_config(self) -> dict[str, Any]:
        values = self.default_config_values()
        stored = await self._config_store.get_values(self.provider_type)
        for key, value in stored.items():
            if value not in (None, ""):
                values[key] = value
        values["api_base"] = str(values.get("api_base") or settings.nstbrowser_api_base).rstrip("/")
        values["api_key"] = str(values.get("api_key") or "").strip()
        return values

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json_payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        config = await self._runtime_config()
        api_key = config["api_key"]
        if not api_key:
            raise RuntimeError("请先配置 NSTBrowser API Key")
        async with self._api_gate:
            async with httpx.AsyncClient(
                base_url=config["api_base"],
                timeout=settings.nstbrowser_api_timeout_sec,
                trust_env=False,
                follow_redirects=True,
            ) as client:
                try:
                    response = await client.request(
                        method,
                        path,
                        params=params,
                        json=json_payload,
                        headers={"x-api-key": api_key},
                    )
                    response.raise_for_status()
                except httpx.ConnectError as exc:
                    raise RuntimeError(
                        "NSTBrowser 本地 API 无法连接，请确认 NSTBrowser 客户端已启动，且本地 API 地址配置正确"
                    ) from exc
                except httpx.TimeoutException as exc:
                    raise RuntimeError(
                        f"NSTBrowser 本地 API 请求超时，请确认客户端可用或适当调大超时时间"
                    ) from exc
                except httpx.HTTPStatusError as exc:
                    status_code = exc.response.status_code
                    if status_code in {401, 403}:
                        raise RuntimeError("NSTBrowser API Key 无效或没有权限，请检查 Provider 配置") from exc
                    raise RuntimeError(f"NSTBrowser API 请求失败：HTTP {status_code}") from exc
        data = response.json()
        if not isinstance(data, dict):
            raise RuntimeError("NSTBrowser API 返回格式异常")
        code = data.get("code")
        error_flag = data.get("err")
        code_failed = code not in (0, "0", 200, "200", None)
        error_flag_failed = error_flag is True
        if code_failed or error_flag_failed:
            raise RuntimeError(str(data.get("msg") or "NSTBrowser API error"))
        return data

    async def _get_all_profiles(self) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        page = 1
        page_size = 100
        while page <= 100:
            data = await self._request(
                "GET",
                "/profiles",
                params={"page": page, "pageSize": page_size, "sortBy": "-createdAt"},
            )
            payload = data.get("data") or {}
            docs = payload.get("docs") if isinstance(payload, dict) else []
            page_rows = [row for row in docs if isinstance(row, dict)] if isinstance(docs, list) else []
            rows.extend(page_rows)
            total = self._safe_int((payload.get("totalDocs") or payload.get("total")) if isinstance(payload, dict) else None)
            if not page_rows or len(page_rows) < page_size or (total is not None and len(rows) >= total):
                break
            page += 1
        return rows

    async def health_check(self) -> ProviderHealth:
        config = await self._runtime_config()
        if not config.get("api_key"):
            return ProviderHealth(
                installed=True,
                healthy=False,
                message="请先配置 NSTBrowser API Key",
                api_base=config.get("api_base"),
                details={"missing_required_fields": ["api_key"]},
            )
        try:
            await self._request("GET", "/browsers")
            return ProviderHealth(
                installed=True,
                healthy=True,
                message="NSTBrowser 本地 API 可访问",
                api_base=config.get("api_base"),
            )
        except Exception as exc:  # noqa: BLE001
            return ProviderHealth(
                installed=False,
                healthy=False,
                message="NSTBrowser 本地 API 无法连接",
                api_base=config.get("api_base"),
                details={"error": str(exc)},
            )

    async def sync_profiles(self) -> ProfileSyncResult:
        rows = await self._get_all_profiles()
        profiles: list[ProviderProfileRef] = []
        for row in rows:
            profile_id = row.get("profileId") or row.get("id") or row.get("_id")
            if profile_id in (None, ""):
                continue
            group = row.get("group") if isinstance(row.get("group"), dict) else {}
            group_id = row.get("groupId") or group.get("groupId") or group.get("_id")
            proxy_config = row.get("proxyConfig") if isinstance(row.get("proxyConfig"), dict) else {}
            profiles.append(
                ProviderProfileRef(
                    provider_type=self.provider_type,
                    external_profile_id=str(profile_id),
                    display_name=str(row.get("name") or f"Profile {profile_id}"),
                    group_summary={
                        "id": str(group_id) if group_id not in (None, "") else None,
                        "name": group.get("name") if group else None,
                    },
                    tag_summary=self._tag_summary(row),
                    proxy_summary={
                        "type": proxy_config.get("proxyType") or proxy_config.get("protocol"),
                        "ip": proxy_config.get("host"),
                        "port": proxy_config.get("port"),
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
        data = await self._request("GET", "/profiles/groups")
        rows = data.get("data") if isinstance(data.get("data"), list) else []
        groups: list[ProviderGroupRef] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            group_id = row.get("groupId") or row.get("_id") or row.get("id")
            if group_id in (None, ""):
                continue
            groups.append(
                ProviderGroupRef(
                    provider_type=self.provider_type,
                    external_group_id=str(group_id),
                    display_name=str(row.get("name") or f"Group {group_id}"),
                    profile_count=None,
                    provider_payload_json=row,
                )
            )
        return groups

    async def list_opened_sessions(self) -> list[ProviderSessionRef]:
        data = await self._request("GET", "/browsers")
        rows = data.get("data") if isinstance(data.get("data"), list) else []
        sessions: list[ProviderSessionRef] = []
        for row in rows:
            if not isinstance(row, dict) or row.get("running") is False:
                continue
            profile_id = row.get("profileId")
            if profile_id in (None, ""):
                continue
            port = row.get("remoteDebuggingPort")
            sessions.append(
                ProviderSessionRef(
                    provider_type=self.provider_type,
                    provider_profile_id=str(profile_id),
                    provider_session_id=str(profile_id),
                    ws_endpoint=row.get("webSocketDebuggerUrl"),
                    debugging_address=f"127.0.0.1:{port}" if port else None,
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
        path = f"/browsers/{quote(str(external_profile_id), safe='')}"
        async with self._lifecycle_gate:
            data = await self._request("POST", path)
        opened = data.get("data") if isinstance(data.get("data"), dict) else {}
        port = opened.get("port") or opened.get("remoteDebuggingPort")
        profile_id = opened.get("profileId") or external_profile_id
        return ProviderSessionRef(
            provider_type=self.provider_type,
            provider_profile_id=str(profile_id),
            provider_session_id=str(profile_id),
            ws_endpoint=opened.get("webSocketDebuggerUrl"),
            debugging_address=f"127.0.0.1:{port}" if port else None,
            metadata=opened | (metadata or {}),
        )

    async def close_profile(self, external_profile_id: str) -> None:
        path = f"/browsers/{quote(str(external_profile_id), safe='')}"
        async with self._lifecycle_gate:
            await self._request("DELETE", path)

    async def reset_open_state(self, external_profile_id: str) -> None:
        await self.close_profile(external_profile_id)

    async def arrange_windows(self, layout: dict[str, Any]) -> None:
        raise NotImplementedError("NSTBrowser 暂不支持 Provider 原生窗口平铺")

    @staticmethod
    def _tag_summary(row: dict[str, Any]) -> list[dict[str, Any]]:
        tags = row.get("tags") or row.get("tag") or []
        if isinstance(tags, list):
            return [
                item if isinstance(item, dict) else {"raw": str(item)}
                for item in tags
            ]
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
