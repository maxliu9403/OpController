from __future__ import annotations

from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy import text

from app.config import settings


class Base(DeclarativeBase):
    pass


engine = create_async_engine(
    f"sqlite+aiosqlite:///{settings.db_path}",
    echo=False,
    future=True,
)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


async def init_db() -> None:
    from app import models  # noqa: F401

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await _run_lightweight_migrations(conn)


async def _run_lightweight_migrations(conn) -> None:
    result = await conn.execute(text("PRAGMA table_info(workflow_templates)"))
    columns = {row[1] for row in result.fetchall()}
    if "folder" not in columns:
        await conn.execute(
            text("ALTER TABLE workflow_templates ADD COLUMN folder VARCHAR(255) DEFAULT '未分组'")
        )
    await conn.execute(
        text("UPDATE workflow_templates SET folder = '未分组' WHERE folder IS NULL OR folder = ''")
    )


async def get_session() -> AsyncIterator[AsyncSession]:
    async with SessionLocal() as session:
        yield session
