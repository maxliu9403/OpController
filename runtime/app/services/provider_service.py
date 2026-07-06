from __future__ import annotations

import asyncio
from collections import Counter
from datetime import datetime

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ProfileRecord, ProviderScopeRecord
from app.providers.registry import ProviderRegistry
from app.schemas.provider import (
    ProfileSyncResult,
    ProviderGroupRef,
    ProviderInfo,
    ProviderScope,
    ProviderSessionRef,
)


class ProviderService:
    def __init__(self, registry: ProviderRegistry) -> None:
        self.registry = registry

    async def list_providers(self) -> list[ProviderInfo]:
        return [await provider.describe() for provider in self.registry.list()]

    async def sync_profiles(
        self,
        session: AsyncSession,
        provider_type: str,
    ) -> ProfileSyncResult:
        provider = self.registry.get(provider_type)
        result = await provider.sync_profiles()

        await session.execute(delete(ProfileRecord).where(ProfileRecord.provider_type == provider_type))
        now = datetime.utcnow()
        for profile in result.profiles:
            session.add(
                ProfileRecord(
                    provider_type=profile.provider_type,
                    external_profile_id=profile.external_profile_id,
                    display_name=profile.display_name,
                    group_summary=profile.group_summary,
                    tag_summary=profile.tag_summary,
                    proxy_summary=profile.proxy_summary,
                    provider_payload_json=profile.provider_payload_json,
                    last_sync_at=now,
                )
            )
        await session.commit()
        return result

    async def list_cached_profiles(
        self,
        session: AsyncSession,
        provider_type: str | None = None,
    ) -> list[ProfileRecord]:
        query = select(ProfileRecord).order_by(ProfileRecord.display_name.asc())
        if provider_type:
            query = query.where(ProfileRecord.provider_type == provider_type)
        result = await session.execute(query)
        return list(result.scalars())

    async def list_profile_views(
        self,
        session: AsyncSession,
        *,
        provider_type: str | None = None,
        group_id: str | None = None,
        q: str | None = None,
        managed_only: bool | None = None,
    ) -> list[dict]:
        profiles = await self.list_cached_profiles(session, provider_type)
        scopes: dict[str, ProviderScope] = {}
        normalized_q = q.strip().lower() if q else ""
        views: list[dict] = []

        for profile in profiles:
            if group_id and self.profile_group_id(profile) != group_id:
                continue
            if normalized_q and normalized_q not in self._profile_search_text(profile):
                continue

            scope = scopes.get(profile.provider_type)
            if not scope:
                scope = await self.get_scope(session, profile.provider_type)
                scopes[profile.provider_type] = scope
            managed, reason = self.evaluate_profile_management(profile, scope)
            if managed_only is True and not managed:
                continue

            views.append(
                {
                    "id": profile.id,
                    "provider_type": profile.provider_type,
                    "external_profile_id": profile.external_profile_id,
                    "display_name": profile.display_name,
                    "group_summary": profile.group_summary or {},
                    "tag_summary": profile.tag_summary or [],
                    "proxy_summary": profile.proxy_summary or {},
                    "enabled": profile.enabled,
                    "managed": managed,
                    "managed_reason": reason,
                    "last_sync_at": profile.last_sync_at,
                }
            )
        return views

    async def get_scope(self, session: AsyncSession, provider_type: str) -> ProviderScope:
        record = await session.get(ProviderScopeRecord, provider_type)
        if not record:
            return ProviderScope(provider_type=provider_type, is_configured=False)
        return ProviderScope(
            provider_type=provider_type,
            managed_group_ids=[str(item) for item in (record.managed_group_ids or [])],
            include_profile_ids=[str(item) for item in (record.include_profile_ids or [])],
            exclude_profile_ids=[str(item) for item in (record.exclude_profile_ids or [])],
            is_configured=True,
        )

    async def save_scope(
        self,
        session: AsyncSession,
        provider_type: str,
        payload: ProviderScope,
    ) -> ProviderScope:
        if not payload.is_configured:
            await session.execute(
                delete(ProviderScopeRecord).where(ProviderScopeRecord.provider_type == provider_type)
            )
            await session.commit()
            return ProviderScope(provider_type=provider_type, is_configured=False)

        record = await session.get(ProviderScopeRecord, provider_type)
        if not record:
            record = ProviderScopeRecord(provider_type=provider_type)
            session.add(record)

        record.managed_group_ids = self._dedupe_str_list(payload.managed_group_ids)
        record.include_profile_ids = self._dedupe_str_list(payload.include_profile_ids)
        record.exclude_profile_ids = self._dedupe_str_list(payload.exclude_profile_ids)
        await session.commit()
        await session.refresh(record)
        return await self.get_scope(session, provider_type)

    async def filter_managed_profiles(
        self,
        session: AsyncSession,
        provider_type: str,
        profiles: list[ProfileRecord],
    ) -> list[ProfileRecord]:
        scope = await self.get_scope(session, provider_type)
        return [
            profile
            for profile in profiles
            if self.evaluate_profile_management(profile, scope)[0]
        ]

    @staticmethod
    def evaluate_profile_management(
        profile: ProfileRecord,
        scope: ProviderScope,
    ) -> tuple[bool, str]:
        profile_id = str(profile.external_profile_id)
        if profile_id in set(scope.exclude_profile_ids):
            return False, "profile_excluded"
        if not scope.is_configured:
            return True, "default_all_profiles"
        if profile_id in set(scope.include_profile_ids):
            return True, "profile_included"
        if ProviderService.profile_group_id(profile) in set(scope.managed_group_ids):
            return True, "group_whitelist"
        return False, "group_not_managed"

    async def list_groups(
        self,
        session: AsyncSession,
        provider_type: str,
    ) -> list[ProviderGroupRef]:
        cached_profiles = await self.list_cached_profiles(session, provider_type)
        cached_groups = self._groups_from_cached_profiles(provider_type, cached_profiles)

        try:
            provider = self.registry.get(provider_type)
            provider_groups = await provider.list_groups()
        except Exception:  # noqa: BLE001
            return cached_groups

        cached_by_id = {item.external_group_id: item for item in cached_groups}
        merged: list[ProviderGroupRef] = []
        seen: set[str] = set()
        for group in provider_groups:
            cached = cached_by_id.get(group.external_group_id)
            merged.append(
                group.model_copy(
                    update={
                        "profile_count": group.profile_count
                        if group.profile_count is not None
                        else cached.profile_count if cached else None
                    }
                )
            )
            seen.add(group.external_group_id)

        merged.extend(group for group in cached_groups if group.external_group_id not in seen)
        return sorted(merged, key=lambda item: (item.display_name.lower(), item.external_group_id))

    async def list_opened_sessions(self, provider_type: str) -> list[ProviderSessionRef]:
        provider = self.registry.get(provider_type)
        return await provider.list_opened_sessions()

    async def get_opened_session(
        self,
        provider_type: str,
        external_profile_id: str,
    ) -> ProviderSessionRef | None:
        sessions = await self.list_opened_sessions(provider_type)
        return next((item for item in sessions if item.provider_profile_id == external_profile_id), None)

    async def open_test_session(
        self,
        provider_type: str,
        external_profile_id: str,
    ) -> ProviderSessionRef:
        provider = self.registry.get(provider_type)
        existing = await self.get_opened_session(provider_type, external_profile_id)
        if self._is_attachable(existing):
            return existing
        if existing:
            return await self._reopen_for_attachable_session(
                provider_type,
                external_profile_id,
                reason="existing_session_missing_debug_endpoint",
            )

        try:
            opened = await provider.open_profile(external_profile_id)
        except RuntimeError as exc:
            if not self._is_already_open_error(exc):
                raise

            return await self._reopen_for_attachable_session(
                provider_type,
                external_profile_id,
                reason="provider_reported_already_open",
            )

        if self._is_attachable(opened):
            return opened

        waited = await self._wait_for_attachable_session(provider_type, external_profile_id)
        if waited:
            return waited

        return await self._reopen_for_attachable_session(
            provider_type,
            external_profile_id,
            reason="open_profile_missing_debug_endpoint",
        )

    async def close_test_session(
        self,
        provider_type: str,
        external_profile_id: str,
    ) -> None:
        provider = self.registry.get(provider_type)
        await provider.close_profile(external_profile_id)

    async def _reopen_for_attachable_session(
        self,
        provider_type: str,
        external_profile_id: str,
        *,
        reason: str,
    ) -> ProviderSessionRef:
        provider = self.registry.get(provider_type)

        waited = await self._wait_for_attachable_session(
            provider_type,
            external_profile_id,
            attempts=4,
        )
        if waited:
            return waited

        try:
            await provider.close_profile(external_profile_id)
        except Exception:  # noqa: BLE001
            try:
                await provider.reset_open_state(external_profile_id)
            except Exception:
                pass

        for _ in range(6):
            await asyncio.sleep(0.5)
            existing = await self.get_opened_session(provider_type, external_profile_id)
            if self._is_attachable(existing):
                return existing
            if not existing:
                break

        try:
            reopened = await provider.open_profile(
                external_profile_id,
                metadata={
                    "reopened_for_debug_attach": True,
                    "reopen_reason": reason,
                },
            )
        except RuntimeError as reopen_error:
            if self._is_already_open_error(reopen_error):
                try:
                    await provider.reset_open_state(external_profile_id)
                    reopened = await provider.open_profile(
                        external_profile_id,
                        metadata={
                            "reopened_for_debug_attach": True,
                            "reopen_reason": f"{reason}_after_reset",
                        },
                    )
                except Exception as reset_error:  # noqa: BLE001
                    raise self._missing_debug_endpoint_error() from reset_error
            else:
                raise self._missing_debug_endpoint_error() from reopen_error

        if self._is_attachable(reopened):
            return reopened

        waited = await self._wait_for_attachable_session(
            provider_type,
            external_profile_id,
            attempts=8,
        )
        if waited:
            return waited

        raise self._missing_debug_endpoint_error()

    async def _wait_for_attachable_session(
        self,
        provider_type: str,
        external_profile_id: str,
        *,
        attempts: int = 6,
        delay_sec: float = 0.5,
    ) -> ProviderSessionRef | None:
        for _ in range(attempts):
            await asyncio.sleep(delay_sec)
            existing = await self.get_opened_session(provider_type, external_profile_id)
            if self._is_attachable(existing):
                return existing
        return None

    @staticmethod
    def _is_attachable(session: ProviderSessionRef | None) -> bool:
        if not session:
            return False
        return bool((session.ws_endpoint or "").strip() or (session.debugging_address or "").strip())

    @staticmethod
    def _is_already_open_error(exc: RuntimeError) -> bool:
        message = str(exc).lower()
        return "已经打开" in str(exc) or "already" in message or "opened" in message

    @staticmethod
    def _missing_debug_endpoint_error() -> RuntimeError:
        return RuntimeError(
            "Profile 已经打开但 ixBrowser Local API 未返回可附着的调试地址 "
            "(ws/debugging_address)。系统已尝试关闭、重置并重新打开；"
            "请确认该窗口不是手动残留窗口，必要时先在 ixBrowser 中关闭该 Profile 后重试。"
        )

    @staticmethod
    def profile_group_id(profile: ProfileRecord) -> str:
        group = profile.group_summary or {}
        raw_id = group.get("id")
        return "__ungrouped__" if raw_id in (None, "") else str(raw_id)

    @staticmethod
    def _groups_from_cached_profiles(
        provider_type: str,
        profiles: list[ProfileRecord],
    ) -> list[ProviderGroupRef]:
        counts: Counter[str] = Counter()
        names: dict[str, str] = {}
        payloads: dict[str, dict] = {}

        for profile in profiles:
            group = profile.group_summary or {}
            raw_id = group.get("id")
            if raw_id in (None, ""):
                raw_id = "__ungrouped__"
            group_id = str(raw_id)
            counts[group_id] += 1
            names[group_id] = str(group.get("name") or ("未分组" if group_id == "__ungrouped__" else f"Group {group_id}"))
            payloads[group_id] = group

        return [
            ProviderGroupRef(
                provider_type=provider_type,
                external_group_id=group_id,
                display_name=names[group_id],
                profile_count=count,
                provider_payload_json=payloads.get(group_id, {}),
            )
            for group_id, count in counts.items()
        ]

    @staticmethod
    def _profile_search_text(profile: ProfileRecord) -> str:
        group = profile.group_summary or {}
        proxy = profile.proxy_summary or {}
        return " ".join(
            [
                profile.display_name,
                profile.external_profile_id,
                str(group.get("name") or ""),
                str(group.get("id") or ""),
                str(proxy.get("ip") or ""),
                str(proxy.get("port") or ""),
            ]
        ).lower()

    @staticmethod
    def _dedupe_str_list(values: list[str]) -> list[str]:
        seen: set[str] = set()
        result: list[str] = []
        for value in values:
            item = str(value)
            if item and item not in seen:
                seen.add(item)
                result.append(item)
        return result
