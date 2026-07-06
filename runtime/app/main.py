from __future__ import annotations

from contextlib import asynccontextmanager
import os
from pathlib import Path

import uvicorn
from fastapi import FastAPI

from app.api import create_app
from app.config import settings
from app.db import SessionLocal, init_db


def _repo_root() -> Path:
    if configured_root := os.getenv("OPCTRL_APP_ROOT"):
        return Path(configured_root).expanduser().resolve()
    return Path(__file__).resolve().parents[2]


@asynccontextmanager
async def lifespan(app: FastAPI):
    runtime = app.state.runtime
    runtime.system_service.ensure_directories()
    await init_db()
    async with SessionLocal() as session:
        await runtime.seed_service.seed_builtin_workflows(session)
    await runtime.batch_service.recover_interrupted_batches()
    runtime.schedule_service.start()
    await runtime.schedule_service.load_existing()
    yield
    await runtime.schedule_service.stop()


app = create_app(_repo_root(), lifespan=lifespan)


if __name__ == "__main__":
    uvicorn.run(
        app,
        host=settings.host,
        port=settings.port,
        reload=False,
    )
