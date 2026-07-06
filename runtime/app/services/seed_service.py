from __future__ import annotations

from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import WorkflowTemplateRecord
from app.services.workflow_service import WorkflowService


class SeedService:
    def __init__(self, workflow_service: WorkflowService, repo_root: Path) -> None:
        self.workflow_service = workflow_service
        self.repo_root = repo_root

    async def seed_builtin_workflows(self, session: AsyncSession) -> None:
        templates_dir = self.repo_root / "shared" / "workflows" / "templates"
        if not templates_dir.exists():
            return
        existing = await session.execute(select(WorkflowTemplateRecord.id).limit(1))
        if existing.first():
            return
        for template_path in sorted(templates_dir.glob("*.yaml")):
            content = template_path.read_text(encoding="utf-8")
            validation = self.workflow_service.validate_definition(content)
            if not validation.valid or not validation.normalized_workflow_json:
                continue
            definition = validation.normalized_workflow_json
            row = WorkflowTemplateRecord(
                name=definition["metadata"]["name"],
                version=definition["metadata"]["version"],
                description=definition["metadata"].get("description"),
                folder="未分组",
                target_provider_type=definition["profile_policy"]["provider_type"],
                workflow_yaml=content,
                normalized_workflow_json=definition,
                selector_catalog_json=definition.get("locators", {}),
                is_builtin=True,
            )
            session.add(row)
        await session.commit()
