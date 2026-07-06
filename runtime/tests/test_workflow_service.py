from pathlib import Path

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.db import Base
from app.models import BatchRecord, BatchStatus, WorkflowTemplateRecord
from app.services.workflow_service import WorkflowService


def test_validate_builtin_template() -> None:
    service = WorkflowService(root_dir=Path("."))
    template = """
metadata:
  name: Test
  version: "1.0.0"
profile_policy:
  provider_type: ixbrowser
  selection_mode: explicit_profiles
runtime_policy:
  mode: visual
  min_window_width: 400
  min_window_height: 600
  page_timeout_sec: 10
  step_timeout_sec: 10
steps:
  - id: step-1
    type: goto
    url: https://example.com
"""
    result = service.validate_definition(template)
    assert result.valid is True


@pytest.mark.asyncio
async def test_delete_workflow_blocks_when_batch_references_it() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async_session = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    service = WorkflowService(root_dir=Path("."))
    async with async_session() as session:
        workflow = WorkflowTemplateRecord(
            name="Referenced",
            version="1.0.0",
            folder="未分组",
            target_provider_type="ixbrowser",
            workflow_yaml="metadata: {name: Referenced, version: '1.0.0'}",
            normalized_workflow_json={},
            selector_catalog_json={},
        )
        session.add(workflow)
        await session.flush()
        session.add(
            BatchRecord(
                name="Historical batch",
                provider_type="ixbrowser",
                workflow_id=workflow.id,
                status=BatchStatus.DRAFT,
            )
        )
        await session.commit()

        with pytest.raises(ValueError, match="引用"):
            await service.delete_workflow(session, workflow.id)
