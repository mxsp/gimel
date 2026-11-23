"""Fixtures for the core tests — Alef's material list as a frozen test fixture.

The core tests come from Alef and assert against Alef's materials, so they
run on the same rows here. Gimel itself never ships this file.
"""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from gimel.core.types import Product, Rates  # noqa: E402

SEED = json.loads((Path(__file__).parent / "fixtures" / "alef_materials.json").read_text())


def product_from_seed(row: dict) -> Product:
    return Product(
        id=row["id"],
        eur_m2=float(row["eurM2"]),
        eur_m2_thk={str(k): float(v) for k, v in (row.get("eurM2Thk") or {}).items()},
        sheets=[(float(w), float(h)) for w, h in row["sheets"]],
        kerf=row.get("kerf"),
        web=row.get("web"),
        name=row.get("name", ""),
        grain=row.get("grain", "none"),
        flip_ok=bool(row.get("flipOk", True)),
    )


@pytest.fixture(scope="session")
def seed() -> dict:
    return SEED


@pytest.fixture(scope="session")
def products() -> dict[str, Product]:
    return {r["id"]: product_from_seed(r) for r in SEED["products"] if r.get("active", True)}


@pytest.fixture(scope="session")
def rates() -> Rates:
    r = SEED["rates"]
    return Rates(
        cut=r["cut"], setup_pct=r["setupPct"], gap=r["gap"], margin=r["margin"],
        waste_min=r["wasteMin"], waste_max=r["wasteMax"], cert31=r["cert31"],
        freight=r["freight"], sheet_markup=r["sheetMarkup"], vat=r["vat"],
        leftover_threshold=r["leftoverThreshold"],
        cut_thk1=r["cutThk1"], cut_thk15=r["cutThk15"],
        cut_thk2=r["cutThk2"], cut_thk3=r["cutThk3"],
        setup_fix1=r["setupFix1"], setup_fix2=r["setupFix2"],
        setup_fix3=r["setupFix3"],
    )
