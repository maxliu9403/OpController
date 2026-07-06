from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import BatchRecord, ScheduleRecord, WorkflowFolderRecord, WorkflowTemplateRecord
from app.schemas.workflow import (
    WorkflowActionCard,
    WorkflowDefinition,
    WorkflowFolderRecord as WorkflowFolderRecordOut,
    WorkflowRecord,
    WorkflowValidationResult,
)


class WorkflowService:
    def __init__(self, root_dir: Path) -> None:
        self.root_dir = root_dir

    @staticmethod
    def action_cards() -> list[WorkflowActionCard]:
        return [
            WorkflowActionCard(type="goto", label="打开页面", description="导航到指定页面", category="页面"),
            WorkflowActionCard(type="click", label="点击按钮", description="点击元素或按钮", category="交互"),
            WorkflowActionCard(type="fill", label="输入内容", description="输入文本或变量", category="交互"),
            WorkflowActionCard(type="select", label="选择下拉项", description="选择下拉框的值", category="交互"),
            WorkflowActionCard(type="wait_visible", label="等待出现", description="等待元素显示", category="等待"),
            WorkflowActionCard(type="wait", label="等待页面就绪", description="智能等待页面加载、网络空闲和 DOM 稳定", category="等待"),
            WorkflowActionCard(type="sleep", label="停留等待", description="暂停几秒，便于观察页面或等待异步动作", category="等待"),
            WorkflowActionCard(type="scroll", label="滚动页面", description="慢速分段滚动，随机停留并轻微回看", category="交互"),
            WorkflowActionCard(type="for_each", label="循环表格", description="遍历列表或表格行", category="控制"),
            WorkflowActionCard(type="if", label="条件判断", description="根据条件分支", category="控制"),
            WorkflowActionCard(type="screenshot", label="截图", description="记录当前页面", category="诊断"),
            WorkflowActionCard(type="download_wait", label="下载文件", description="等待并记录下载", category="文件"),
            WorkflowActionCard(type="extract_text", label="提取文本", description="提取文本到变量", category="数据"),
        ]

    async def list_workflows(
        self,
        session: AsyncSession,
        *,
        folder: str | None = None,
        provider_type: str | None = None,
        q: str | None = None,
    ) -> list[WorkflowRecord]:
        query = select(WorkflowTemplateRecord).order_by(WorkflowTemplateRecord.updated_at.desc())
        if folder:
            query = query.where(WorkflowTemplateRecord.folder == folder)
        if provider_type:
            query = query.where(WorkflowTemplateRecord.target_provider_type == provider_type)
        if q:
            pattern = f"%{q.strip()}%"
            query = query.where(
                WorkflowTemplateRecord.name.like(pattern)
                | WorkflowTemplateRecord.description.like(pattern)
            )
        result = await session.execute(query)
        workflows = []
        for row in result.scalars():
            workflows.append(self._to_record(row))
        return workflows

    async def get_workflow(self, session: AsyncSession, workflow_id: str) -> WorkflowTemplateRecord:
        result = await session.execute(
            select(WorkflowTemplateRecord).where(WorkflowTemplateRecord.id == workflow_id)
        )
        workflow = result.scalar_one_or_none()
        if not workflow:
            raise ValueError(f"workflow not found: {workflow_id}")
        return workflow

    async def get_workflow_record(self, session: AsyncSession, workflow_id: str) -> WorkflowRecord:
        return self._to_record(await self.get_workflow(session, workflow_id))

    def validate_definition(self, payload: str | dict[str, Any]) -> WorkflowValidationResult:
        try:
            if isinstance(payload, str):
                raw = yaml.safe_load(payload)
            else:
                raw = payload
            workflow = WorkflowDefinition.model_validate(raw)
            warnings: list[str] = []
            selector_keys = {step.selector_key for step in workflow.steps if step.selector_key}
            missing_locators = [
                key for key in selector_keys if key and key not in workflow.locators
            ]
            if missing_locators:
                warnings.append(
                    "Workflow references selector_key values without locator definitions: "
                    + ", ".join(sorted(missing_locators))
                )
            return WorkflowValidationResult(
                valid=True,
                warnings=warnings,
                normalized_workflow_json=workflow.model_dump(mode="json"),
            )
        except Exception as exc:  # noqa: BLE001
            return WorkflowValidationResult(valid=False, errors=[str(exc)])

    async def save_workflow(
        self,
        session: AsyncSession,
        *,
        workflow_id: str | None,
        workflow_yaml: str,
        folder: str | None = None,
    ) -> WorkflowRecord:
        validation = self.validate_definition(workflow_yaml)
        if not validation.valid or not validation.normalized_workflow_json:
            raise ValueError("; ".join(validation.errors or ["invalid workflow"]))

        definition = WorkflowDefinition.model_validate(validation.normalized_workflow_json)
        normalized_folder = self._normalize_folder(folder)
        await self.ensure_folder(session, normalized_folder)
        if workflow_id:
            row = await self.get_workflow(session, workflow_id)
            row.name = definition.metadata.name
            row.version = definition.metadata.version
            row.description = definition.metadata.description
            row.folder = normalized_folder
            row.target_provider_type = definition.profile_policy.provider_type
            row.workflow_yaml = workflow_yaml
            row.normalized_workflow_json = validation.normalized_workflow_json
            row.selector_catalog_json = {
                key: value.model_dump(mode="json") for key, value in definition.locators.items()
            }
        else:
            row = WorkflowTemplateRecord(
                name=definition.metadata.name,
                version=definition.metadata.version,
                description=definition.metadata.description,
                folder=normalized_folder,
                target_provider_type=definition.profile_policy.provider_type,
                workflow_yaml=workflow_yaml,
                normalized_workflow_json=validation.normalized_workflow_json,
                selector_catalog_json={
                    key: value.model_dump(mode="json") for key, value in definition.locators.items()
                },
            )
            session.add(row)
        await session.commit()
        await session.refresh(row)
        return self._to_record(row)

    async def delete_workflow(self, session: AsyncSession, workflow_id: str) -> None:
        workflow = await self.get_workflow(session, workflow_id)
        batch_refs = await session.scalar(
            select(func.count()).select_from(BatchRecord).where(BatchRecord.workflow_id == workflow_id)
        )
        schedule_refs = await session.scalar(
            select(func.count()).select_from(ScheduleRecord).where(ScheduleRecord.workflow_id == workflow_id)
        )
        if batch_refs or schedule_refs:
            raise ValueError("流程已被历史批次或定时任务引用，不能硬删除。请先清理相关计划。")
        await session.delete(workflow)
        await session.commit()

    async def duplicate_workflow(self, session: AsyncSession, workflow_id: str) -> WorkflowRecord:
        source = await self.get_workflow(session, workflow_id)
        new_name = await self._next_copy_name(session, source.name)
        raw = yaml.safe_load(source.workflow_yaml) or {}
        raw.setdefault("metadata", {})
        raw["metadata"]["name"] = new_name
        workflow_yaml = yaml.safe_dump(raw, allow_unicode=True, sort_keys=False)
        return await self.save_workflow(
            session,
            workflow_id=None,
            workflow_yaml=workflow_yaml,
            folder=source.folder,
        )

    async def list_folders(self, session: AsyncSession) -> list[WorkflowFolderRecordOut]:
        await self.ensure_folder(session, "未分组")
        folder_rows = await session.execute(select(WorkflowFolderRecord).order_by(WorkflowFolderRecord.name.asc()))
        count_rows = await session.execute(
            select(WorkflowTemplateRecord.folder, func.count(WorkflowTemplateRecord.id)).group_by(WorkflowTemplateRecord.folder)
        )
        counts = {folder or "未分组": count for folder, count in count_rows.all()}
        seen: set[str] = set()
        result: list[WorkflowFolderRecordOut] = []
        for folder in folder_rows.scalars():
            seen.add(folder.name)
            result.append(
                WorkflowFolderRecordOut(
                    id=folder.id,
                    name=folder.name,
                    description=folder.description,
                    workflow_count=counts.get(folder.name, 0),
                )
            )
        for name, count in sorted(counts.items()):
            if name not in seen:
                result.append(WorkflowFolderRecordOut(name=name, workflow_count=count))
        return result

    async def ensure_folder(
        self,
        session: AsyncSession,
        name: str,
        description: str | None = None,
    ) -> WorkflowFolderRecord:
        normalized = self._normalize_folder(name)
        existing = await session.execute(select(WorkflowFolderRecord).where(WorkflowFolderRecord.name == normalized))
        row = existing.scalar_one_or_none()
        if row:
            return row
        row = WorkflowFolderRecord(name=normalized, description=description)
        session.add(row)
        await session.flush()
        return row

    @staticmethod
    def _to_record(row: WorkflowTemplateRecord) -> WorkflowRecord:
        return WorkflowRecord(
            id=row.id,
            name=row.name,
            version=row.version,
            description=row.description,
            folder=row.folder or "未分组",
            target_provider_type=row.target_provider_type,
            workflow_yaml=row.workflow_yaml,
            normalized_workflow_json=row.normalized_workflow_json,
            selector_catalog_json=row.selector_catalog_json or {},
            is_builtin=row.is_builtin,
        )

    @staticmethod
    def _normalize_folder(folder: str | None) -> str:
        return (folder or "未分组").strip() or "未分组"

    async def _next_copy_name(self, session: AsyncSession, base_name: str) -> str:
        existing = await session.execute(select(WorkflowTemplateRecord.name))
        names = {row[0] for row in existing.all()}
        candidate = f"{base_name} 副本"
        index = 2
        while candidate in names:
            candidate = f"{base_name} 副本 {index}"
            index += 1
        return candidate
