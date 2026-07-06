from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any


class MonitorService:
    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue[dict[str, Any]]] = set()

    async def publish(self, event_type: str, payload: dict[str, Any]) -> None:
        for queue in list(self._subscribers):
            await queue.put({"type": event_type, "payload": payload})

    async def subscribe(self) -> AsyncIterator[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._subscribers.add(queue)
        try:
            while True:
                yield await queue.get()
        finally:
            self._subscribers.discard(queue)

