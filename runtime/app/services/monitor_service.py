from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
import logging
from typing import Any

from app.config import settings


logger = logging.getLogger(__name__)


class MonitorService:
    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue[dict[str, Any]]] = set()

    async def publish(self, event_type: str, payload: dict[str, Any]) -> None:
        for queue in list(self._subscribers):
            event = {"type": event_type, "payload": payload}
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                try:
                    queue.get_nowait()
                    queue.put_nowait(event)
                except asyncio.QueueEmpty:
                    logger.debug("monitor queue reported full but had no item to drop")

    async def subscribe(self) -> AsyncIterator[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=settings.monitor_queue_maxsize)
        self._subscribers.add(queue)
        try:
            while True:
                yield await queue.get()
        finally:
            self._subscribers.discard(queue)
