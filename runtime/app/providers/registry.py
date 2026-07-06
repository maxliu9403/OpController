from __future__ import annotations

from app.providers.base import BrowserProvider


class ProviderRegistry:
    def __init__(self) -> None:
        self._providers: dict[str, BrowserProvider] = {}

    def register(self, provider: BrowserProvider) -> None:
        self._providers[provider.provider_type] = provider

    def get(self, provider_type: str) -> BrowserProvider:
        if provider_type not in self._providers:
            raise KeyError(f"unknown provider: {provider_type}")
        return self._providers[provider_type]

    def list(self) -> list[BrowserProvider]:
        return list(self._providers.values())

