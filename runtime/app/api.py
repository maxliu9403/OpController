from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, FastAPI, File, Form, HTTPException, Query, Request, UploadFile, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.runtime_context import RuntimeContext
from app.schemas.batch import StartBatchRequest
from app.schemas.preview import LocatorLivePreviewRequest, LocatorPickOnceRequest, StepLivePreviewRequest, WorkflowDryRunRequest
from app.schemas.provider import ProviderScope
from app.schemas.schedule import ScheduleDefinition

router = APIRouter(prefix="/local/v1")


def get_runtime(request: Request) -> RuntimeContext:
    return request.app.state.runtime


DbSession = Annotated[AsyncSession, Depends(get_session)]


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/system/check")
async def system_check(runtime: Annotated[RuntimeContext, Depends(get_runtime)]):
    return await runtime.system_service.system_check()


@router.get("/providers")
async def list_providers(runtime: Annotated[RuntimeContext, Depends(get_runtime)]):
    return await runtime.provider_service.list_providers()


@router.post("/providers/{provider_type}/profiles/sync")
async def sync_profiles(
    provider_type: str,
    session: DbSession,
    runtime: Annotated[RuntimeContext, Depends(get_runtime)],
):
    return await runtime.provider_service.sync_profiles(session, provider_type)


@router.get("/providers/{provider_type}/groups")
async def list_provider_groups(
    provider_type: str,
    session: DbSession,
    runtime: Annotated[RuntimeContext, Depends(get_runtime)],
):
    return await runtime.provider_service.list_groups(session, provider_type)


@router.get("/providers/{provider_type}/scope")
async def get_provider_scope(
    provider_type: str,
    session: DbSession,
    runtime: Annotated[RuntimeContext, Depends(get_runtime)],
):
    return await runtime.provider_service.get_scope(session, provider_type)


@router.put("/providers/{provider_type}/scope")
async def update_provider_scope(
    provider_type: str,
    payload: ProviderScope,
    session: DbSession,
    runtime: Annotated[RuntimeContext, Depends(get_runtime)],
):
    normalized = payload.model_copy(update={"provider_type": provider_type})
    return await runtime.provider_service.save_scope(session, provider_type, normalized)


@router.get("/providers/{provider_type}/sessions")
async def list_provider_sessions(
    provider_type: str,
    runtime: Annotated[RuntimeContext, Depends(get_runtime)],
):
    return await runtime.provider_service.list_opened_sessions(provider_type)


@router.post("/providers/{provider_type}/profiles/{external_profile_id}/test-open")
async def open_test_profile(
    provider_type: str,
    external_profile_id: str,
    runtime: Annotated[RuntimeContext, Depends(get_runtime)],
):
    try:
        session_ref = await runtime.provider_service.open_test_session(provider_type, external_profile_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await runtime.monitor.publish(
        "provider.test_session_opened",
        {
            "provider_type": provider_type,
            "external_profile_id": external_profile_id,
            "debug_endpoint": session_ref.ws_endpoint or session_ref.debugging_address,
        },
    )
    return session_ref


@router.post("/providers/{provider_type}/profiles/{external_profile_id}/test-close")
async def close_test_profile(
    provider_type: str,
    external_profile_id: str,
    runtime: Annotated[RuntimeContext, Depends(get_runtime)],
):
    await runtime.provider_service.close_test_session(provider_type, external_profile_id)
    await runtime.monitor.publish(
        "provider.test_session_closed",
        {
            "provider_type": provider_type,
            "external_profile_id": external_profile_id,
        },
    )
    return {"status": "closed"}


@router.get("/profiles")
async def list_profiles(
    session: DbSession,
    runtime: Annotated[RuntimeContext, Depends(get_runtime)],
    provider_type: str | None = None,
    group_id: str | None = None,
    managed_only: bool | None = Query(default=None),
    q: str | None = None,
):
    return await runtime.provider_service.list_profile_views(
        session,
        provider_type=provider_type,
        group_id=group_id,
        managed_only=managed_only,
        q=q,
    )


@router.post("/locators/pick/start")
async def start_locator_pick(payload: dict[str, Any]):
    return {
        "status": "scaffolded",
        "message": "Picker session contract created. Use browser-attached injector in the desktop shell to drive overlay selection.",
        "payload": payload,
    }


@router.post("/locators/pick/stop")
async def stop_locator_pick(payload: dict[str, Any]):
    return {"status": "stopped", "payload": payload}


@router.post("/locators/pick/once")
async def pick_locator_once(
    payload: LocatorPickOnceRequest,
    runtime: Annotated[RuntimeContext, Depends(get_runtime)],
):
    session_ref = await runtime.provider_service.get_opened_session(
        payload.provider_type,
        payload.external_profile_id,
    )
    if not session_ref or not (session_ref.ws_endpoint or session_ref.debugging_address):
        raise HTTPException(status_code=400, detail="测试 Profile 尚未打开，无法从真实页面点选元素")

    try:
        picked = await runtime.execution_service.pick_locator_once(
            endpoint=session_ref.ws_endpoint or session_ref.debugging_address or "",
            timeout_sec=payload.timeout_sec,
        )
        locator = runtime.locator_service.build_locator_spec(
            tag_name=picked.get("tag_name", "button"),
            text=picked.get("text"),
            attributes=picked.get("attributes", {}),
            neighbors=picked.get("neighbor_anchor"),
            list_context=picked.get("list_context"),
            frame_path=picked.get("frame_path"),
            candidate_selectors=picked.get("candidate_selectors"),
        )
        validation = runtime.locator_service.validate_locator(locator)
        live_preview = await runtime.execution_service.preview_locator(
            endpoint=session_ref.ws_endpoint or session_ref.debugging_address or "",
            locator=validation.normalized_locator,
        )
        warnings = list(validation.warnings)
        if live_preview.error_message:
            warnings.append(f"真实页面复测失败: {live_preview.error_message}")
        elif live_preview.match_count != 1:
            warnings.append(f"真实页面复测命中 {live_preview.match_count} 个元素，建议重新点选更稳定的元素或补充邻近锚点。")

        return {
            "success": True,
            "element": {
                "tag_name": picked.get("tag_name", ""),
                "text": picked.get("text"),
                "attributes": picked.get("attributes", {}),
                "frame_path": picked.get("frame_path", []),
                "neighbor_anchor": picked.get("neighbor_anchor", {}),
                "list_context": picked.get("list_context", {}),
                "bounding_box": picked.get("bounding_box", {}),
                "screenshot_data_url": picked.get("screenshot_data_url"),
            },
            "locator": validation.normalized_locator,
            "warnings": warnings,
            "uniqueness_score": validation.uniqueness_score,
            "stability_score": validation.stability_score,
            "live_preview": live_preview,
            "current_url": picked.get("current_url"),
            "page_title": picked.get("page_title"),
        }
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/locators/validate")
async def validate_locator(
    payload: dict[str, Any],
    runtime: Annotated[RuntimeContext, Depends(get_runtime)],
):
    try:
        locator = runtime.locator_service.build_locator_spec(
            tag_name=payload.get("tag_name", "button"),
            text=payload.get("text"),
            attributes=payload.get("attributes", {}),
            neighbors=payload.get("neighbors"),
            list_context=payload.get("list_context"),
            frame_path=payload.get("frame_path"),
        )
        result = runtime.locator_service.validate_locator(locator)
        return {
            "valid": result.valid,
            "warnings": result.warnings,
            "uniqueness_score": result.uniqueness_score,
            "stability_score": result.stability_score,
            "locator": result.normalized_locator,
        }
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/locators/live-preview")
async def live_preview_locator(
    payload: LocatorLivePreviewRequest,
    runtime: Annotated[RuntimeContext, Depends(get_runtime)],
):
    session_ref = await runtime.provider_service.get_opened_session(
        payload.provider_type,
        payload.external_profile_id,
    )
    if not session_ref or not (session_ref.ws_endpoint or session_ref.debugging_address):
        raise HTTPException(status_code=400, detail="测试 Profile 尚未打开，无法做真实页面定位预览")
    return await runtime.execution_service.preview_locator(
        endpoint=session_ref.ws_endpoint or session_ref.debugging_address or "",
        locator=payload.locator,
    )


@router.get("/workflows")
async def list_workflows(
    session: DbSession,
    runtime: Annotated[RuntimeContext, Depends(get_runtime)],
    folder: str | None = None,
    provider_type: str | None = None,
    q: str | None = None,
):
    return await runtime.workflow_service.list_workflows(
        session,
        folder=folder,
        provider_type=provider_type,
        q=q,
    )


@router.get("/workflows/action-cards")
async def list_action_cards(runtime: Annotated[RuntimeContext, Depends(get_runtime)]):
    return runtime.workflow_service.action_cards()


@router.get("/workflow-folders")
async def list_workflow_folders(
    session: DbSession,
    runtime: Annotated[RuntimeContext, Depends(get_runtime)],
):
    return await runtime.workflow_service.list_folders(session)


@router.post("/workflow-folders")
async def create_workflow_folder(
    payload: dict[str, Any],
    session: DbSession,
    runtime: Annotated[RuntimeContext, Depends(get_runtime)],
):
    name = payload.get("name")
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    row = await runtime.workflow_service.ensure_folder(
        session,
        str(name),
        payload.get("description"),
    )
    await session.commit()
    return {
        "id": row.id,
        "name": row.name,
        "description": row.description,
        "workflow_count": 0,
    }


@router.get("/workflows/{workflow_id}")
async def get_workflow(
    workflow_id: str,
    session: DbSession,
    runtime: Annotated[RuntimeContext, Depends(get_runtime)],
):
    try:
        return await runtime.workflow_service.get_workflow_record(session, workflow_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/workflows")
async def create_workflow(
    payload: dict[str, Any],
    session: DbSession,
    runtime: Annotated[RuntimeContext, Depends(get_runtime)],
):
    workflow_yaml = payload.get("workflow_yaml")
    if not workflow_yaml:
        raise HTTPException(status_code=400, detail="workflow_yaml is required")
    try:
        return await runtime.workflow_service.save_workflow(
            session,
            workflow_id=None,
            workflow_yaml=workflow_yaml,
            folder=payload.get("folder"),
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.put("/workflows/{workflow_id}")
async def update_workflow(
    workflow_id: str,
    payload: dict[str, Any],
    session: DbSession,
    runtime: Annotated[RuntimeContext, Depends(get_runtime)],
):
    workflow_yaml = payload.get("workflow_yaml")
    if not workflow_yaml:
        raise HTTPException(status_code=400, detail="workflow_yaml is required")
    try:
        return await runtime.workflow_service.save_workflow(
            session,
            workflow_id=workflow_id,
            workflow_yaml=workflow_yaml,
            folder=payload.get("folder"),
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete("/workflows/{workflow_id}")
async def delete_workflow(
    workflow_id: str,
    session: DbSession,
    runtime: Annotated[RuntimeContext, Depends(get_runtime)],
):
    try:
        await runtime.workflow_service.delete_workflow(session, workflow_id)
        return {"status": "deleted"}
    except ValueError as exc:
        message = str(exc)
        status_code = 409 if "引用" in message else 404
        raise HTTPException(status_code=status_code, detail=message) from exc


@router.post("/workflows/{workflow_id}/duplicate")
async def duplicate_workflow(
    workflow_id: str,
    session: DbSession,
    runtime: Annotated[RuntimeContext, Depends(get_runtime)],
):
    try:
        return await runtime.workflow_service.duplicate_workflow(session, workflow_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/workflows/{workflow_id}/validate")
async def validate_workflow(
    workflow_id: str,
    payload: dict[str, Any],
    runtime: Annotated[RuntimeContext, Depends(get_runtime)],
):
    workflow_yaml = payload.get("workflow_yaml")
    if workflow_yaml:
        return runtime.workflow_service.validate_definition(workflow_yaml)
    return runtime.workflow_service.validate_definition(payload)


@router.post("/workflows/{workflow_id}/dry-run")
async def dry_run_workflow(
    workflow_id: str,
    payload: WorkflowDryRunRequest,
    runtime: Annotated[RuntimeContext, Depends(get_runtime)],
):
    validation = runtime.workflow_service.validate_definition(payload.workflow_yaml)
    if not validation.valid or not validation.normalized_workflow_json:
        raise HTTPException(status_code=400, detail="; ".join(validation.errors or ["流程 YAML 校验失败"]))
    session_ref = await runtime.provider_service.get_opened_session(
        payload.provider_type,
        payload.external_profile_id,
    )
    if not session_ref or not (session_ref.ws_endpoint or session_ref.debugging_address):
        raise HTTPException(status_code=400, detail="测试 Profile 尚未打开，无法做整条流程试运行")
    try:
        return await runtime.execution_service.preview_workflow(
            endpoint=session_ref.ws_endpoint or session_ref.debugging_address or "",
            workflow_payload=validation.normalized_workflow_json,
            row_payload=payload.row_payload,
            stop_on_failure=payload.stop_on_failure,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/workflows/step-preview")
async def preview_workflow_step(
    payload: StepLivePreviewRequest,
    runtime: Annotated[RuntimeContext, Depends(get_runtime)],
):
    session_ref = await runtime.provider_service.get_opened_session(
        payload.provider_type,
        payload.external_profile_id,
    )
    if not session_ref or not (session_ref.ws_endpoint or session_ref.debugging_address):
        raise HTTPException(status_code=400, detail="测试 Profile 尚未打开，无法做单步试跑")
    return await runtime.execution_service.preview_step(
        endpoint=session_ref.ws_endpoint or session_ref.debugging_address or "",
        step=payload.step,
        locator=payload.locator,
        row_payload=payload.row_payload,
    )


@router.post("/batches/import")
async def import_batch(
    session: DbSession,
    runtime: Annotated[RuntimeContext, Depends(get_runtime)],
    file: UploadFile = File(...),
    provider_type: str = Form("ixbrowser"),
):
    content = await file.read()
    return await runtime.batch_service.import_batch(
        session,
        file_name=file.filename or "input.csv",
        content=content,
        provider_type=provider_type,
    )


@router.get("/batches")
async def list_batches(
    session: DbSession,
    runtime: Annotated[RuntimeContext, Depends(get_runtime)],
):
    return await runtime.batch_service.list_batches(session)


@router.get("/batches/{batch_id}")
async def get_batch(
    batch_id: str,
    session: DbSession,
    runtime: Annotated[RuntimeContext, Depends(get_runtime)],
):
    return await runtime.batch_service.get_batch_detail(session, batch_id)


@router.post("/batches/{batch_id}/start")
async def start_batch(
    batch_id: str,
    payload: StartBatchRequest,
    session: DbSession,
    runtime: Annotated[RuntimeContext, Depends(get_runtime)],
):
    return await runtime.batch_service.start_batch(session, batch_id, payload)


@router.post("/batches/{batch_id}/pause")
async def pause_batch(
    batch_id: str,
    session: DbSession,
    runtime: Annotated[RuntimeContext, Depends(get_runtime)],
):
    return await runtime.batch_service.pause_batch(session, batch_id)


@router.post("/batches/{batch_id}/resume")
async def resume_batch(
    batch_id: str,
    session: DbSession,
    runtime: Annotated[RuntimeContext, Depends(get_runtime)],
):
    return await runtime.batch_service.resume_batch(session, batch_id)


@router.post("/batches/{batch_id}/cancel")
async def cancel_batch(
    batch_id: str,
    session: DbSession,
    runtime: Annotated[RuntimeContext, Depends(get_runtime)],
):
    return await runtime.batch_service.cancel_batch(session, batch_id)


@router.get("/task-runs/{task_run_id}")
async def get_task_run(
    task_run_id: str,
    session: DbSession,
    runtime: Annotated[RuntimeContext, Depends(get_runtime)],
):
    return await runtime.batch_service.get_task_detail(session, task_run_id)


@router.post("/schedules")
async def create_schedule(
    payload: ScheduleDefinition,
    session: DbSession,
    runtime: Annotated[RuntimeContext, Depends(get_runtime)],
):
    return await runtime.schedule_service.save_schedule(session, payload, schedule_id=None)


@router.put("/schedules/{schedule_id}")
async def update_schedule(
    schedule_id: str,
    payload: ScheduleDefinition,
    session: DbSession,
    runtime: Annotated[RuntimeContext, Depends(get_runtime)],
):
    return await runtime.schedule_service.save_schedule(session, payload, schedule_id=schedule_id)


@router.get("/schedules")
async def list_schedules(
    session: DbSession,
    runtime: Annotated[RuntimeContext, Depends(get_runtime)],
):
    return await runtime.schedule_service.list_schedules(session)


@router.get("/results/batches/{batch_id}")
async def batch_results(
    batch_id: str,
    session: DbSession,
    runtime: Annotated[RuntimeContext, Depends(get_runtime)],
):
    return await runtime.batch_service.get_batch_detail(session, batch_id)


@router.websocket("/monitor/stream")
async def monitor_stream(websocket: WebSocket):
    await websocket.accept()
    runtime: RuntimeContext = websocket.app.state.runtime
    async for event in runtime.monitor.subscribe():
        await websocket.send_json(event)


def create_app(repo_root: Path, lifespan: Callable | None = None) -> FastAPI:
    app = FastAPI(title="OpController Runtime", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(router)
    app.state.runtime = RuntimeContext.build(repo_root)
    return app
