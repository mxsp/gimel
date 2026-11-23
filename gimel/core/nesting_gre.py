"""Optional second nesting engine.

Gimel nests with its own engine. An application can bring a heavier one through
``Plugin.nesting_engine``; Alef brings GRE 5.3.0. Without one, ``gre_available()``
is False and ``batch.plan_batch(..., engine="gre")`` refuses loudly instead of
falling back silently.
"""

from __future__ import annotations

from typing import Optional, Sequence

from ..extensions import active
from .types import Position, Product, Rates


def _engine():
    plugin = active()
    return plugin.nesting_engine() if plugin and plugin.nesting_engine else None


def engine_label() -> str:
    engine = _engine()
    return engine.ENGINE_LABEL if engine else "gre-unavailable"


def gre_available() -> bool:
    engine = _engine()
    return bool(engine and engine.gre_available())


def nest_best_gre(positions: Sequence[Position], product: Product, rates: Rates,
                  policy: Optional[dict] = None) -> dict:
    engine = _engine()
    if not engine:
        raise RuntimeError("no GRE nesting engine registered")
    return engine.nest_best_gre(positions, product, rates, policy)


def nest_for_gre(positions: Sequence[Position], product: Product, rates: Rates,
                 sheet_idx: Optional[int] = None, policy: Optional[dict] = None) -> dict:
    engine = _engine()
    if not engine:
        raise RuntimeError("no GRE nesting engine registered")
    return engine.nest_for_gre(positions, product, rates, sheet_idx, policy)
