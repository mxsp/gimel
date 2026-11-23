"""Event-Bus für Echtzeit-Benachrichtigungen im Admin-Panel und Werksicht.

Ermöglicht Server-Sent Events (SSE), sodass Änderungen an Aufträgen,
Sammelläufen und Fertigungsständen ohne spürbare Verzögerung im Browser
auftauchen.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any

log = logging.getLogger("alpha.events")


class EventBus:
    def __init__(self) -> None:
        self._listeners: set[asyncio.Queue[str]] = set()

    def subscribe(self) -> asyncio.Queue[str]:
        q: asyncio.Queue[str] = asyncio.Queue(maxsize=100)
        self._listeners.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[str]) -> None:
        self._listeners.discard(q)

    def publish(self, event_type: str, data: dict[str, Any] | None = None) -> None:
        """Ereignis an alle aktiven Hörer verteilen."""
        payload = json.dumps({
            "event": event_type,
            "data": data or {},
            "ts": datetime.now(timezone.utc).isoformat(),
        })
        for q in list(self._listeners):
            try:
                q.put_nowait(payload)
            except (asyncio.QueueFull, Exception):
                pass


bus = EventBus()
