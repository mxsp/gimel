"""Optional bridge from Gimel to the assistant module.

The assistant lives in ``agentlab/`` as its own app. When that package is
installed alongside Gimel, the main portal can expose the same ``/api/agent``
routes and tables, so the assistant popup works in Gimel itself instead of
requiring the separate ``/lab`` server.

The bridge never hard-depends on the package: a plain Gimel installation
without ``agentlab`` simply has no assistant routes and no assistant tables.
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import Any, Callable

log = logging.getLogger("gimel.agent_bridge")


def load() -> tuple[Any | None, Callable[..., dict] | None]:
    """Return ``(router, seed)`` or ``(None, None)`` when agentlab is absent."""
    try:
        # ``gimel`` is normally started from its console script; Python then
        # puts .venv/bin on sys.path, not the checkout. The assistant package
        # sits next to gimel/ in the source tree, so make that explicit.
        root = Path(__file__).resolve().parent.parent
        if (root / "agentlab").is_dir() and str(root) not in sys.path:
            sys.path.insert(0, str(root))
        # Importing the models registers the additive agent_* tables with
        # Gimel's metadata before ``init_db`` runs.
        from agentlab import models as _models  # noqa: F401
        from agentlab.router import router
        from agentlab.seed import seed
    except ImportError as exc:
        if exc.name != "agentlab":
            log.warning("Agent Lab konnte nicht geladen werden: %s", exc, exc_info=True)
        return None, None
    return router, seed


def load_voice() -> tuple[Any | None, Callable[[], None] | None]:
    """Return ``(voice_router, warm_up)`` for local speech recognition, or ``(None, None)``.

    Only for processes bound to this machine (Twin Studio on 127.0.0.1:8009)
    and — as an explicit opt-in — the test portal (``GIMEL_VOICE=1`` in
    ``gimel.app.create_app``): recognition costs CPU and memory per request and
    never belongs in a portal that a tunnel can reach. ``load()`` above stays
    without it on purpose.
    """
    router, _seed = load()
    if router is None:
        return None, None
    try:
        from agentlab import transcribe
        from agentlab.voice_router import voice_router
    except ImportError:
        return None, None
    return voice_router, transcribe.warm_up
