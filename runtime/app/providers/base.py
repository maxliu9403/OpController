from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from app.schemas.provider import (
    ProviderConfigField,
    ProfileSyncResult,
    ProviderCapability,
    ProviderGroupRef,
    ProviderHealth,
    ProviderInfo,
    ProviderSessionRef,
)


class BrowserProvider(ABC):
    provider_type: str
    display_name: str
    default_port: int | None = None

    @property
    @abstractmethod
    def capabilities(self) -> ProviderCapability:
        raise NotImplementedError

    @abstractmethod
    async def health_check(self) -> ProviderHealth:
        raise NotImplementedError

    async def describe(self) -> ProviderInfo:
        return ProviderInfo(
            provider_type=self.provider_type,
            display_name=self.display_name,
            default_port=self.default_port,
            capabilities=self.capabilities,
            health=await self.health_check(),
        )

    def config_fields(self) -> list[ProviderConfigField]:
        return []

    def default_config_values(self) -> dict[str, Any]:
        return {}

    @abstractmethod
    async def sync_profiles(self) -> ProfileSyncResult:
        raise NotImplementedError

    @abstractmethod
    async def list_groups(self) -> list[ProviderGroupRef]:
        raise NotImplementedError

    @abstractmethod
    async def list_opened_sessions(self) -> list[ProviderSessionRef]:
        raise NotImplementedError

    @abstractmethod
    async def open_profile(
        self,
        external_profile_id: str,
        *,
        args: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> ProviderSessionRef:
        raise NotImplementedError

    @abstractmethod
    async def close_profile(self, external_profile_id: str) -> None:
        raise NotImplementedError

    @abstractmethod
    async def reset_open_state(self, external_profile_id: str) -> None:
        raise NotImplementedError

    @abstractmethod
    async def arrange_windows(self, layout: dict[str, Any]) -> None:
        raise NotImplementedError
