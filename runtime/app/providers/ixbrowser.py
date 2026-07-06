from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx

from app.config import settings
from app.providers.base import BrowserProvider
from app.schemas.provider import (
    ProfileSyncResult,
    ProviderCapability,
    ProviderGroupRef,
    ProviderHealth,
    ProviderProfileRef,
    ProviderSessionRef,
)


class IxBrowserProvider(BrowserProvider):
    provider_type = "ixbrowser"
    display_name = "ixBrowser"
    default_port = 53200

    def __init__(self) -> None:
        self._client = httpx.AsyncClient(
            base_url=settings.ixbrowser_api_base,
            timeout=settings.ixbrowser_api_timeout_sec,
            trust_env=False,
        )
        self._api_gate = asyncio.Semaphore(3)
        self._lifecycle_gate = asyncio.Semaphore(2)

    @property
    def capabilities(self) -> ProviderCapability:
        return ProviderCapability(
            supports_profile_sync=True,
            supports_window_arrange=True,
            supports_group_tag_sync=True,
            supports_cookie_read=True,
            supports_cookie_write=True,
            supports_proxy_sync=True,
            supports_local_api_port_config=True,
            supports_native_opened_list=True,
            supports_download_dir_control=False,
        )

    async def _post(self, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        async with self._api_gate:
            response = await self._client.post(path, json=payload or {})
            response.raise_for_status()
            data = response.json()
            error = data.get("error", {})
            if error.get("code", 0) not in (0, "0", None):
                raise RuntimeError(error.get("message", "ixBrowser API error"))
            return data

    @staticmethod
    def _page_rows(data: dict[str, Any]) -> tuple[list[dict[str, Any]], int | None]:
        payload = data.get("data", {})
        if isinstance(payload, list):
            return [row for row in payload if isinstance(row, dict)], len(payload)
        if not isinstance(payload, dict):
            return [], None

        raw_rows = payload.get("data") or payload.get("list") or payload.get("items") or []
        rows = [row for row in raw_rows if isinstance(row, dict)] if isinstance(raw_rows, list) else []
        total = payload.get("total")
        try:
            normalized_total = int(total) if total is not None else len(rows)
        except (TypeError, ValueError):
            normalized_total = len(rows)
        return rows, normalized_total

    async def _post_all_rows(
        self,
        path: str,
        payload: dict[str, Any] | None = None,
        *,
        limit: int = 200,
    ) -> list[dict[str, Any]]:
        base_payload = payload or {}
        rows: list[dict[str, Any]] = []
        page = 1
        while page <= 100:
            data = await self._post(path, {**base_payload, "page": page, "limit": limit})
            page_rows, total = self._page_rows(data)
            rows.extend(page_rows)
            if not page_rows or total is None or len(rows) >= total:
                break
            page += 1
        return rows

    async def health_check(self) -> ProviderHealth:
        try:
            await self._post("/api/v2/profile-list", {"page": 1, "limit": 1})
            return ProviderHealth(
                installed=True,
                healthy=True,
                message="ixBrowser Local API reachable",
                api_base=settings.ixbrowser_api_base,
            )
        except Exception as exc:  # noqa: BLE001
            return ProviderHealth(
                installed=False,
                healthy=False,
                message="ixBrowser Local API unreachable",
                api_base=settings.ixbrowser_api_base,
                details={"error": str(exc)},
            )

    async def sync_profiles(self) -> ProfileSyncResult:
        rows = await self._post_all_rows("/api/v2/profile-list")
        profiles: list[ProviderProfileRef] = []
        for row in rows:
            profiles.append(
                ProviderProfileRef(
                    provider_type=self.provider_type,
                    external_profile_id=str(row["profile_id"]),
                    display_name=row.get("name") or f"Profile {row['profile_id']}",
                    group_summary={
                        "id": row.get("group_id"),
                        "name": row.get("group_name"),
                    },
                    tag_summary=[
                        {"raw": row.get("tag_name", ""), "id": row.get("tag_id", "")}
                    ],
                    proxy_summary={
                        "type": row.get("proxy_type"),
                        "ip": row.get("proxy_ip"),
                        "port": row.get("proxy_port"),
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
        rows = await self._post_all_rows("/api/v2/group-list")
        groups: list[ProviderGroupRef] = []
        for row in rows:
            raw_id = (
                row.get("group_id")
                or row.get("id")
                or row.get("groupId")
                or row.get("value")
            )
            if raw_id in (None, ""):
                continue

            display_name = (
                row.get("group_name")
                or row.get("name")
                or row.get("title")
                or row.get("label")
                or f"Group {raw_id}"
            )
            raw_count = (
                row.get("profile_count")
                or row.get("profiles_count")
                or row.get("browser_count")
                or row.get("count")
            )
            try:
                profile_count = int(raw_count) if raw_count is not None else None
            except (TypeError, ValueError):
                profile_count = None

            groups.append(
                ProviderGroupRef(
                    provider_type=self.provider_type,
                    external_group_id=str(raw_id),
                    display_name=str(display_name),
                    profile_count=profile_count,
                    provider_payload_json=row,
                )
            )
        return groups

    async def list_opened_sessions(self) -> list[ProviderSessionRef]:
        opened = await self._post("/api/v2/native-client-profile-opened-list")
        result: list[ProviderSessionRef] = []
        for row in opened.get("data", []):
            result.append(
                ProviderSessionRef(
                    provider_type=self.provider_type,
                    provider_profile_id=str(row.get("profile_id")),
                    provider_session_id=str(row.get("pid")) if row.get("pid") else None,
                    browser_pid=row.get("pid"),
                    ws_endpoint=row.get("ws"),
                    debugging_address=row.get("debugging_address"),
                    open_time=row.get("open_time"),
                    metadata=row,
                )
            )
        return result

    async def open_profile(
        self,
        external_profile_id: str,
        *,
        args: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> ProviderSessionRef:
        payload = {
            "profile_id": int(external_profile_id),
            "args": args or [],
            "load_profile_info_page": False,
            "cookies_backup": False,
        }
        async with self._lifecycle_gate:
            data = await self._post("/api/v2/profile-open", payload)
        opened = data.get("data", {})
        return ProviderSessionRef(
            provider_type=self.provider_type,
            provider_profile_id=external_profile_id,
            provider_session_id=str(opened.get("pid")) if opened.get("pid") else None,
            browser_pid=opened.get("pid"),
            ws_endpoint=opened.get("ws"),
            debugging_address=opened.get("debugging_address"),
            metadata=opened | (metadata or {}),
        )

    async def close_profile(self, external_profile_id: str) -> None:
        async with self._lifecycle_gate:
            await self._post("/api/v2/profile-close", {"profile_id": int(external_profile_id)})

    async def reset_open_state(self, external_profile_id: str) -> None:
        await self._post(
            "/api/v2/profile-open-state-reset",
            {"profile_id": int(external_profile_id)},
        )

    async def arrange_windows(self, layout: dict[str, Any]) -> None:
        payload = {
            "screen": 0,
            "layout": 1,
            "adaptive": 1,
            "starting_position_x": 10,
            "starting_position_y": 10,
            "profile_size_width": 500,
            "profile_size_hight": 500,
            "profile_spacing_horizontal": 10,
            "profile_spacing_vertical": 10,
            "profile_deviaton_x": 50,
            "profile_deviaton_y": 50,
            "per_line_number_of_profiles": 3,
        }
        for key in payload:
            if key in layout and layout[key] is not None:
                payload[key] = layout[key]
        await self._post("/api/v2/profile-opened-list-arrange-tile", payload)

    async def get_cookies(self, external_profile_id: str) -> list[dict[str, Any]]:
        data = await self._post(
            "/api/v2/profile-get-cookies",
            {"profile_id": int(external_profile_id)},
        )
        raw = data.get("data", "[]")
        if isinstance(raw, str):
            return json.loads(raw)
        return raw
