from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.date import DateTrigger
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models import BatchRecord, BatchRowRecord, BatchStatus, ScheduleRecord, ScheduleStatus
from app.schemas.batch import StartBatchRequest
from app.schemas.schedule import ScheduleDefinition, ScheduleRecordOut
from app.services.batch_service import BatchService
from app.services.monitor_service import MonitorService


class ScheduleService:
    def __init__(
        self,
        *,
        session_factory: async_sessionmaker[AsyncSession],
        batch_service: BatchService,
        monitor: MonitorService,
    ) -> None:
        self.session_factory = session_factory
        self.batch_service = batch_service
        self.monitor = monitor
        self.scheduler = AsyncIOScheduler()
        self._running_schedule_ids: set[str] = set()
        self._active_schedule_batches: dict[str, str] = {}

    def start(self) -> None:
        if not self.scheduler.running:
            self.scheduler.start()

    async def stop(self) -> None:
        if self.scheduler.running:
            self.scheduler.shutdown(wait=False)

    async def load_existing(self) -> None:
        async with self.session_factory() as session:
            result = await session.execute(select(ScheduleRecord).where(ScheduleRecord.status == ScheduleStatus.ENABLED))
            for row in result.scalars():
                self._register_job(row)

    async def list_schedules(self, session: AsyncSession) -> list[ScheduleRecordOut]:
        result = await session.execute(select(ScheduleRecord).order_by(ScheduleRecord.created_at.desc()))
        return [self._to_out(item) for item in result.scalars()]

    async def save_schedule(
        self,
        session: AsyncSession,
        payload: ScheduleDefinition,
        schedule_id: str | None = None,
    ) -> ScheduleRecordOut:
        if schedule_id:
            row = await session.get(ScheduleRecord, schedule_id)
            if not row:
                raise ValueError(f"schedule not found: {schedule_id}")
            row.name = payload.name
            row.status = ScheduleStatus.ENABLED if payload.enabled else ScheduleStatus.DISABLED
            row.workflow_id = payload.workflow_id
            row.provider_type = payload.provider_type
            row.profile_policy_snapshot = payload.profile_policy_snapshot
            row.input_source = payload.input_source
            row.schedule_type = payload.schedule_type
            row.schedule_expr = payload.schedule_expr
            row.timezone = payload.timezone
            row.max_concurrency = payload.max_concurrency
            row.retry_once_on_failure = payload.retry_once_on_failure
        else:
            row = ScheduleRecord(
                name=payload.name,
                status=ScheduleStatus.ENABLED if payload.enabled else ScheduleStatus.DISABLED,
                workflow_id=payload.workflow_id,
                provider_type=payload.provider_type,
                profile_policy_snapshot=payload.profile_policy_snapshot,
                input_source=payload.input_source,
                schedule_type=payload.schedule_type,
                schedule_expr=payload.schedule_expr,
                timezone=payload.timezone,
                max_concurrency=payload.max_concurrency,
                retry_once_on_failure=payload.retry_once_on_failure,
            )
            session.add(row)
        await session.commit()
        await session.refresh(row)
        if row.status == ScheduleStatus.ENABLED:
            self._register_job(row)
        else:
            try:
                self.scheduler.remove_job(row.id)
            except Exception:  # noqa: BLE001
                pass
        return self._to_out(row)

    def _register_job(self, schedule: ScheduleRecord) -> None:
        trigger = self._build_trigger(schedule.schedule_type, schedule.schedule_expr, schedule.timezone)
        self.scheduler.add_job(
            self._fire_schedule,
            trigger=trigger,
            id=schedule.id,
            replace_existing=True,
            kwargs={"schedule_id": schedule.id},
        )

    def _build_trigger(self, schedule_type: str, expr: str, timezone: str):
        if schedule_type == "once":
            return DateTrigger(run_date=datetime.fromisoformat(expr), timezone=timezone)
        if schedule_type == "daily":
            hour, minute = expr.split(":")
            return CronTrigger(hour=int(hour), minute=int(minute), timezone=timezone)
        if schedule_type == "weekly":
            day, hm = expr.split("|")
            hour, minute = hm.split(":")
            return CronTrigger(day_of_week=day, hour=int(hour), minute=int(minute), timezone=timezone)
        return CronTrigger.from_crontab(expr, timezone=timezone)

    async def _fire_schedule(self, schedule_id: str) -> None:
        if schedule_id in self._running_schedule_ids:
            await self.monitor.publish(
                "schedule.skipped",
                {"schedule_id": schedule_id, "reason": "previous_run_still_active"},
            )
            return

        self._running_schedule_ids.add(schedule_id)
        try:
            async with self.session_factory() as session:
                schedule = await session.get(ScheduleRecord, schedule_id)
                if not schedule or schedule.status != ScheduleStatus.ENABLED:
                    return
                active_batch_id = self._active_schedule_batches.get(schedule_id)
                if active_batch_id:
                    active_batch = await session.get(BatchRecord, active_batch_id)
                    if active_batch and active_batch.status in {BatchStatus.READY, BatchStatus.RUNNING, BatchStatus.PAUSED}:
                        await self.monitor.publish(
                            "schedule.skipped",
                            {
                                "schedule_id": schedule_id,
                                "batch_id": active_batch_id,
                                "reason": "previous_batch_still_active",
                            },
                        )
                        return
                    self._active_schedule_batches.pop(schedule_id, None)
                batch = await self._create_batch_from_schedule(session, schedule)
                start_request = StartBatchRequest(
                    workflow_id=schedule.workflow_id,
                    provider_type=schedule.provider_type,
                    profile_policy_snapshot=schedule.profile_policy_snapshot,
                    runtime_mode="visual",
                    requested_slots=schedule.max_concurrency,
                )
                await self.batch_service.start_batch(session, batch.id, start_request)
                self._active_schedule_batches[schedule.id] = batch.id
                schedule.last_run_at = datetime.utcnow()
                await session.commit()
                await self.monitor.publish("schedule.triggered", {"schedule_id": schedule.id, "batch_id": batch.id})
        finally:
            self._running_schedule_ids.discard(schedule_id)

    async def _create_batch_from_schedule(
        self,
        session: AsyncSession,
        schedule: ScheduleRecord,
    ) -> BatchRecord:
        batch = BatchRecord(
            name=f"{schedule.name} @ {datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')}",
            provider_type=schedule.provider_type,
            workflow_id=schedule.workflow_id,
            status=BatchStatus.DRAFT,
            input_source="schedule",
            profile_policy_snapshot=schedule.profile_policy_snapshot,
        )
        session.add(batch)
        await session.flush()
        rows = await self._resolve_input_rows(schedule.input_source)
        for index, payload in enumerate(rows, start=1):
            session.add(
                BatchRowRecord(
                    batch_id=batch.id,
                    row_index=index,
                    row_payload_json=payload,
                    dedupe_key=str(payload.get("id") or index),
                )
            )
        batch.total_rows = len(rows)
        await session.commit()
        return batch

    async def _resolve_input_rows(self, input_source: dict[str, Any]) -> list[dict[str, Any]]:
        if "inline_rows" in input_source:
            return list(input_source["inline_rows"])
        if "file_path" in input_source:
            file_path = Path(input_source["file_path"])
            return self.batch_service._parse_input_file(file_path.name, file_path.read_bytes())
        if "source_batch_id" in input_source:
            async with self.session_factory() as session:
                result = await session.execute(
                    select(BatchRowRecord).where(BatchRowRecord.batch_id == input_source["source_batch_id"])
                )
                return [row.row_payload_json for row in result.scalars()]
        return []

    @staticmethod
    def _to_out(row: ScheduleRecord) -> ScheduleRecordOut:
        return ScheduleRecordOut(
            id=row.id,
            name=row.name,
            status=row.status.value,
            workflow_id=row.workflow_id,
            provider_type=row.provider_type,
            schedule_type=row.schedule_type,
            schedule_expr=row.schedule_expr,
            timezone=row.timezone,
            next_run_at=row.next_run_at,
            last_run_at=row.last_run_at,
        )
