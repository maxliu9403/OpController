from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models import ProviderConfigRecord


class ProviderConfigStore:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self.session_factory = session_factory

    async def get_values(self, provider_type: str) -> dict[str, Any]:
        async with self.session_factory() as session:
            record = await session.get(ProviderConfigRecord, provider_type)
            return dict(record.values_json or {}) if record else {}

    async def save_values(self, provider_type: str, values: dict[str, Any]) -> dict[str, Any]:
        cleaned = {key: value for key, value in values.items() if value not in (None, "")}
        async with self.session_factory() as session:
            record = await session.get(ProviderConfigRecord, provider_type)
            if not record:
                record = ProviderConfigRecord(provider_type=provider_type, values_json={})
                session.add(record)
            record.values_json = cleaned
            await session.commit()
            await session.refresh(record)
            return dict(record.values_json or {})
