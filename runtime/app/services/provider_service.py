from __future__ import annotations

import asyncio
from collections import Counter
from datetime import datetime
import logging
import time

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import ProfileRecord, ProviderScopeRecord
from app.providers.base import BrowserProvider
from app.providers.config_store import ProviderConfigStore
from app.providers.registry import ProviderRegistry
from app.schemas.provider import (
    ProfileSyncResult,
    ProviderConfig,
    ProviderConfigSecret,
    ProviderConfigUpdate,
    ProviderCredentialStatus,
    ProviderGroupRef,
    ProviderHealth,
    ProviderInfo,
    ProviderScope,
    ProviderSessionRef,
)


logger = logging.getLogger(__name__)


class ProviderService:
    MASKED_SECRET = "********"

    def __init__(self, registry: ProviderRegistry, config_store: ProviderConfigStore | None = None) -> None:
        self.registry = registry
        self.config_store = config_store
        self._health_cache: dict[str, tuple[float, ProviderHealth]] = {}

    async def list_providers(self) -> list[ProviderInfo]:
        return [self._describe_with_cached_health(provider) for provider in self.registry.list()]

    async def get_config(self, provider_type: str) -> ProviderConfig:
        provider = self.registry.get(provider_type)
        stored_values = await self._stored_config_values(provider_type)
        return self._to_provider_config(provider, stored_values)

    async def save_config(self, provider_type: str, payload: ProviderConfigUpdate) -> ProviderConfig:
        provider = self.registry.get(provider_type)
        existing = await self._stored_config_values(provider_type)
        values = dict(existing)
        fields_by_key = {field.key: field for field in provider.config_fields()}
        for key, raw_value in payload.values.items():
            field = fields_by_key.get(key)
            if not field:
                continue
            if field.secret and raw_value in (None, "", self.MASKED_SECRET):
                continue
            values[key] = raw_value
        if self.config_store:
            await self.config_store.save_values(provider_type, values)
            values = await self.config_store.get_values(provider_type)
        self.invalidate_health(provider_type)
        return self._to_provider_config(provider, values)

    async def reveal_config_secret(self, provider_type: str, key: str) -> ProviderConfigSecret:
        provider = self.registry.get(provider_type)
        fields_by_key = {field.key: field for field in provider.config_fields()}
        field = fields_by_key.get(key)
        if not field:
            raise ValueError(f"未知配置字段：{key}")
        if not field.secret:
            raise ValueError(f"{field.label} 不是密钥字段")

        stored_values = await self._stored_config_values(provider_type)
        merged = {**provider.default_config_values(), **stored_values}
        value = merged.get(key)
        return ProviderConfigSecret(key=key, value=str(value or ""))

    async def health_check(self, provider_type: str) -> ProviderHealth:
        provider = self.registry.get(provider_type)
        return await self._refresh_health(provider, force=True)

    def invalidate_health(self, provider_type: str) -> None:
        self._health_cache.pop(provider_type, None)

    def _describe_with_cached_health(self, provider: BrowserProvider) -> ProviderInfo:
        return ProviderInfo(
            provider_type=provider.provider_type,
            display_name=provider.display_name,
            default_port=provider.default_port,
            capabilities=provider.capabilities,
            health=self._health_snapshot(provider),
        )

    def _health_snapshot(self, provider: BrowserProvider) -> ProviderHealth:
        now = time.monotonic()
        cached = self._health_cache.get(provider.provider_type)
        if cached:
            cached_at, health = cached
            age_sec = max(0.0, now - cached_at)
            if age_sec < settings.provider_health_cache_ttl_sec:
                return health.model_copy(update={"details": {**health.details, "cached": True, "age_sec": round(age_sec, 1)}})

        if cached:
            cached_at, health = cached
            age_sec = max(0.0, now - cached_at)
            return health.model_copy(
                update={
                    "details": {
                        **health.details,
                        "cached": True,
                        "stale": True,
                        "age_sec": round(age_sec, 1),
                    }
                }
            )
        return self._idle_health(provider)

    @staticmethod
    def _idle_health(provider: BrowserProvider) -> ProviderHealth:
        return ProviderHealth(
            installed=False,
            healthy=False,
            message=f"{provider.display_name} 尚未启动检查。点击“启动”后再检测本地指纹浏览器接入状态。",
            details={"status": "idle", "cached": False, "manual_start_required": True},
        )

    async def _refresh_health(self, provider: BrowserProvider, *, force: bool) -> ProviderHealth:
        cached = self._health_cache.get(provider.provider_type)
        if not force and cached:
            cached_at, health = cached
            if time.monotonic() - cached_at < settings.provider_health_cache_ttl_sec:
                return health
        try:
            health = await asyncio.wait_for(provider.health_check(), timeout=settings.provider_health_timeout_sec)
        except asyncio.TimeoutError:
            health = ProviderHealth(
                installed=False,
                healthy=False,
                message=f"{provider.display_name} 体检超时，请确认客户端已启动且 Local API 可访问",
                details={"timeout": True},
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "provider health check failed",
                extra={"provider_type": provider.provider_type, "error": str(exc)},
            )
            health = ProviderHealth(
                installed=False,
                healthy=False,
                message=f"{provider.display_name} 体检失败：{exc}",
                details={"error": str(exc)},
            )
        self._health_cache[provider.provider_type] = (time.monotonic(), health)
        return health

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
                    remark=profile.remark,
                    group_summary=profile.group_summary,
                    tag_summary=profile.tag_summary,
                    proxy_summary=profile.proxy_summary,
                    provider_payload_json=profile.provider_payload_json,
                    last_sync_at=now,
                )
            )
        await session.commit()
        return result

    async def _stored_config_values(self, provider_type: str) -> dict:
        if not self.config_store:
            return {}
        return await self.config_store.get_values(provider_type)

    def _to_provider_config(self, provider: BrowserProvider, stored_values: dict) -> ProviderConfig:
        fields = provider.config_fields()
        defaults = provider.default_config_values()
        merged = {**defaults, **stored_values}
        safe_values: dict[str, str] = {}
        masked_fields: dict[str, str] = {}
        missing_required: list[str] = []

        for field in fields:
            value = merged.get(field.key)
            has_value = value not in (None, "")
            if field.required and not has_value:
                missing_required.append(field.key)
            if field.secret:
                if has_value:
                    masked_fields[field.key] = self._mask_secret(str(value))
                    safe_values[field.key] = self.MASKED_SECRET
                else:
                    safe_values[field.key] = ""
                continue
            safe_values[field.key] = value if value is not None else field.default_value or ""

        return ProviderConfig(
            provider_type=provider.provider_type,
            fields=fields,
            values=safe_values,
            credential_status=ProviderCredentialStatus(
                configured=not missing_required,
                masked_fields=masked_fields,
                missing_required_fields=missing_required,
            ),
        )

    @staticmethod
    def _mask_secret(value: str) -> str:
        if len(value) <= 4:
            return "****"
        return f"{value[:2]}{'*' * max(4, min(10, len(value) - 4))}{value[-2:]}"

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
                    "remark": profile.remark,
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
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "provider group list failed; falling back to cached groups",
                extra={"provider_type": provider_type, "error": str(exc)},
            )
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
                    raise self._missing_debug_endpoint_error(provider_type) from reset_error
            else:
                raise self._missing_debug_endpoint_error(provider_type) from reopen_error

        if self._is_attachable(reopened):
            return reopened

        waited = await self._wait_for_attachable_session(
            provider_type,
            external_profile_id,
            attempts=8,
        )
        if waited:
            return waited

        raise self._missing_debug_endpoint_error(provider_type)

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

    def _missing_debug_endpoint_error(self, provider_type: str) -> RuntimeError:
        try:
            provider_name = self.registry.get(provider_type).display_name
        except Exception:  # noqa: BLE001
            provider_name = provider_type
        return RuntimeError(
            f"Profile 已经打开但 {provider_name} Local API 未返回可附着的调试地址 "
            "(ws/debugging_address)。系统已尝试关闭、重置并重新打开；"
            f"请确认该窗口不是手动残留窗口，必要时先在 {provider_name} 中关闭该 Profile 后重试。"
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
                profile.remark or "",
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
