from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.db import Base
from app.models import WorkflowTemplateRecord
from app.services.seed_service import SeedService
from app.services.workflow_service import WorkflowService


@pytest.mark.asyncio
async def test_seed_service_removes_builtin_workflows_without_creating_defaults() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async_session = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    service = SeedService(workflow_service=WorkflowService(root_dir=Path(".")), repo_root=Path("."))
    async with async_session() as session:
        session.add(
            WorkflowTemplateRecord(
                name="登录并进入工作台",
                version="1.0.0",
                folder="未分组",
                target_provider_type="ixbrowser",
                workflow_yaml="metadata: {name: 登录并进入工作台, version: '1.0.0'}",
                normalized_workflow_json={},
                selector_catalog_json={},
                is_builtin=True,
            )
        )
        session.add(
            WorkflowTemplateRecord(
                name="运营自定义流程",
                version="1.0.0",
                folder="未分组",
                target_provider_type="ixbrowser",
                workflow_yaml="metadata: {name: 运营自定义流程, version: '1.0.0'}",
                normalized_workflow_json={},
                selector_catalog_json={},
                is_builtin=False,
            )
        )
        await session.commit()

        await service.seed_builtin_workflows(session)

        result = await session.execute(select(WorkflowTemplateRecord).order_by(WorkflowTemplateRecord.name.asc()))
        workflows = list(result.scalars())
        assert [workflow.name for workflow in workflows] == ["运营自定义流程"]
        assert workflows[0].is_builtin is False
