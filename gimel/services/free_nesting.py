"""Freies Schachteln: Zeichnungen aus der Bibliothek auf Platten legen, ohne Auftrag.

Der Rechenkern ist :mod:`gimel.core.kerf`. Dieser Dienst baut aus den Angaben der
Oberfläche den Kerf-Auftrag, lässt ihn in einem Thread laufen und hält das Ergebnis im
Speicher. Er schreibt nichts in Aufträge, Platten, Lager oder Plan; die Datenbank wird
nur gelesen (Zeichnungen) und beschrieben, wo der Router ein Protokoll anlegt.

Regeln:

* **Ein Lauf zugleich** (``Busy``), im Prozess, wie ``run_jobs``: nach einem Neustart ist er weg.
* **Das Budget sind Schritte, nie Zeit.** Mit gleichem Startwert und gleichen Angaben kommt
  dieselbe Lage heraus. Die 60 Sekunden sind nur der Notanker: ein Lauf, der sie erreicht,
  endet mit dem besten Stand bis dahin (Status ``timeout``) und ist dann nicht
  wiederholbar. Der Anker greift zwischen zwei Schritten; die Rasterung vor dem ersten
  Schritt kann er nicht unterbrechen.
* **Nie ungeprüft.** Jedes Ergebnis geht durch ``kerf.verify``; eine ungültige Lage wird nie
  zum Export angeboten.
* Kappen: 200 Teilearten, 2000 Teile, ``MAX_STEPS`` Schritte, Speicherbedarf der Lagenkarten.
"""

from __future__ import annotations

import json
import math
import threading
import time
import uuid
from collections import OrderedDict
from datetime import datetime, timezone
from typing import Optional
from xml.sax.saxutils import escape

from sqlalchemy.orm import Session

from ..core import kerf
from ..core.nesting_kerf import map_bytes, steps_for
from ..models import Drawing
from ..render import dxf as dxfmod

MAX_TYPES = 200
MAX_INSTANCES = 2000
MAX_STEPS = 1000
HARD_LIMIT_S = 60.0
KEEP = 5
MAX_SHEET_MM = 10000.0
MIN_SHEET_MM = 50.0
MAX_GRID_CELLS = 2.0e7
MAX_EDGES_PER_TYPE = 1500          # Kanten (Eckpunkte) einer Teileart, Außenkontur und Aussparungen
MAX_EDGES_TOTAL = 400_000         # Summe Kanten mal Menge über den ganzen Lauf
MAX_WORK_EDGES = 2_000_000         # Summe über alle Teilearten: Drehungen mal Kanten
MAP_CAP_BYTES = 256 * 1024 * 1024  # Lagenkarten dieses Dienstes; die VM hat 4 GiB und teilt sie
NOTICE = "Freies Schachteln - kein Fertigungsauftrag"
NOTICE_DE = "Freies Schachteln – kein Fertigungsauftrag"

ROTATIONS = {
    "0": [0],
    "180": [0, 180],
    "90": [0, 90, 180, 270],
    "45": [0, 45, 90, 135, 180, 225, 270, 315],
    "15": [i * 15 for i in range(24)],
}
QUALITY = {"draft": 300, "standard": 600, "fine": 1200}
ACTIVE = ("running", "checking")
FINAL = ("done", "stopped", "timeout", "failed")


class Busy(Exception):
    """Es läuft schon ein Lauf."""


class FreeNestingError(ValueError):
    def __init__(self, detail: str, status: int = 422) -> None:
        super().__init__(detail)
        self.detail, self.status = detail, status


class _Abort(Exception):
    def __init__(self, status: str) -> None:
        super().__init__(status)
        self.status = status


_lock = threading.Lock()
_runs: OrderedDict[str, dict] = OrderedDict()


def _clock() -> float:
    return time.perf_counter() * 1000.0


# --------------------------------------------------------------------------
# Auftrag bauen
# --------------------------------------------------------------------------
def _num(spec: dict, key: str, lo: float, hi: float, label: str) -> float:
    v = spec.get(key)
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        raise FreeNestingError(f"{label}: Zahl fehlt.")
    if v < lo or v > hi:
        raise FreeNestingError(f"{label}: zwischen {lo:g} und {hi:g} mm.")
    return float(v)


def _down(ring: list, height: float) -> list:
    """Die Bibliothek zählt wie DXF nach oben, der Lauf wie der Bildschirm nach unten (Ursprung
    oben links, „von oben“ füllt am oberen Rand). Die Teile gehen deshalb gespiegelt in den Kern;
    jede Ausgabe dreht das zurück. Die erlaubten Drehungen sind zu dieser Spiegelung symmetrisch."""
    return [[p[0], round(height - p[1], 4)] for p in ring]


def build_job(db: Session, spec: dict) -> dict:
    """Prüft die Angaben und liefert den Kerf-Auftrag samt ``_meta`` (Namen, Einstellungen)."""
    w = _num(spec, "sheet_w", MIN_SHEET_MM, MAX_SHEET_MM, "Plattenlänge")
    h = _num(spec, "sheet_h", MIN_SHEET_MM, MAX_SHEET_MM, "Plattenbreite")
    spacing = _num(spec, "spacing", 0, 200, "Teileabstand")
    margin = _num(spec, "margin", 0, 500, "Randabstand")
    if 2 * margin >= min(w, h):
        raise FreeNestingError("Der Randabstand lässt von der Platte nichts übrig.")
    stock = int(_num(spec, "stock", 0, 1000, "Platten im Lager"))
    rot_key = str(spec.get("rotations", "90"))
    if rot_key not in ROTATIONS:
        raise FreeNestingError("Drehungen: 0, 180, 90, 45 oder 15 Grad.")
    gravity = spec.get("gravity", "left")
    if gravity not in ("left", "top"):
        raise FreeNestingError("Füllrichtung: von links oder von oben.")
    seed = int(_num(spec, "seed", 1, 2**32 - 1, "Startwert"))
    stall = int(_num(spec, "stall", 0, MAX_STEPS, "Schritte ohne Gewinn"))
    quality = spec.get("quality", "standard")
    if quality in QUALITY:
        cell = kerf.nice_cell(max(w, h), QUALITY[quality])
    elif quality == "mm1":
        cell = 1.0
    elif quality == "manual":
        cell = _num(spec, "cell", 0.25, 100, "Rasterweite")
    else:
        raise FreeNestingError("Rasterauflösung: Entwurf, Standard, Fein, 1 mm oder Manuell.")
    if (w / cell) * (h / cell) > MAX_GRID_CELLS:
        raise FreeNestingError("Das Raster ist für diese Platte zu fein; bitte gröber wählen.")

    wanted = spec.get("parts")
    if not isinstance(wanted, list) or not wanted:
        raise FreeNestingError("Keine Teile gewählt.")
    qty: OrderedDict[int, int] = OrderedDict()
    gap: dict[int, Optional[float]] = {}
    for item in wanted:
        did, q = item.get("drawing_id"), item.get("qty")
        if not isinstance(did, int) or isinstance(did, bool) or not isinstance(q, int) or isinstance(q, bool):
            raise FreeNestingError("Teile: Zeichnung und Menge müssen ganze Zahlen sein.")
        if q < 0 or q > MAX_INSTANCES:
            raise FreeNestingError(f"Menge: 0 bis {MAX_INSTANCES}.")
        g = item.get("gap")
        if g is not None and (isinstance(g, bool) or not isinstance(g, (int, float))
                              or not math.isfinite(g) or g < 0 or g > 200):
            raise FreeNestingError("Eigener Abstand: 0 bis 200 mm oder leer.")
        qty[did] = qty.get(did, 0) + q
        if g is not None:
            gap[did] = float(g)
    qty = OrderedDict((k, v) for k, v in qty.items() if v > 0)
    if not qty:
        raise FreeNestingError("Alle Mengen sind 0.")
    if len(qty) > MAX_TYPES:
        raise FreeNestingError(f"Mehr als {MAX_TYPES} Teilearten.")
    total = sum(qty.values())
    if total > MAX_INSTANCES:
        raise FreeNestingError(f"Mehr als {MAX_INSTANCES} Teile insgesamt ({total}).")
    rows = {d.id: d for d in db.query(Drawing).filter(Drawing.id.in_(list(qty))).all()}
    missing = [i for i in qty if i not in rows]
    if missing:
        raise FreeNestingError("Zeichnung nicht gefunden: " + ", ".join(str(i) for i in missing[:5]), 404)

    rotations = ROTATIONS[rot_key]
    work = 0
    total_edges = 0
    for did in qty:
        d = rows[did]
        edges = len(d.outer) + sum(len(h) for h in d.holes or [])
        if edges > MAX_EDGES_PER_TYPE:
            raise FreeNestingError(f"„{d.name}“ hat {edges} Kanten; erlaubt sind {MAX_EDGES_PER_TYPE}. "
                                   "Bitte die Zeichnung vereinfachen.")
        work += edges * len(rotations)
        total_edges += edges * qty[did]
    if total_edges > MAX_EDGES_TOTAL:
        raise FreeNestingError(f"Die Teile ergeben {total_edges:,} Kanten (Kanten mal Menge); erlaubt sind "
                               f"{MAX_EDGES_TOTAL:,}. Weniger Teile oder einfachere Zeichnungen wählen.".replace(",", "."))
    if work > MAX_WORK_EDGES:
        raise FreeNestingError(f"Die Teile ergeben mit {len(rotations)} Drehungen {work:,} Kanten zu rechnen; "
                               f"erlaubt sind {MAX_WORK_EDGES:,}. Weniger Drehungen oder einfachere Teile wählen.".replace(",", "."))
    parts = []
    for did, q in qty.items():
        d = rows[did]
        part = {"id": str(did), "name": d.name, "outer": _down(d.outer, d.height),
                "holes": [_down(h, d.height) for h in d.holes or []],
                "quantity": q, "rotations": rotations}
        if did in gap:
            part["spacing"] = gap[did]
        parts.append(part)
    max_steps = spec.get("max_steps")
    if max_steps is None:
        max_steps = min(MAX_STEPS, steps_for(total, len(rotations)))
    else:
        max_steps = int(_num({"v": max_steps}, "v", 1, MAX_STEPS, "Schritte"))
    job = {"sheet": {"width": w, "height": h}, "spacing": spacing, "margin": margin,
           "rotations": rotations, "gravity": gravity, "cell": cell, "seed": seed,
           "maxSteps": max_steps, "stallSteps": stall or None, "maxSheets": stock or None,
           "refine": bool(spec.get("refine", True)), "parts": parts}
    if map_bytes(job) > MAP_CAP_BYTES:
        raise FreeNestingError("Zu viele Teile und Drehungen für diese Platte und dieses Raster; "
                               "weniger Drehungen, gröberes Raster oder weniger Teile wählen.")
    return job


# --------------------------------------------------------------------------
# Lauf
# --------------------------------------------------------------------------
def _work(run: dict) -> None:
    job = run["job"]
    t0 = _clock()
    stop: threading.Event = run["_stop"]

    def on_progress(res: dict, _info: dict) -> None:
        with _lock:
            run["layout"] = res
            run["rev"] += 1
            run["phase"] = res["stats"].get("phase", "")
        if stop.is_set():
            raise _Abort("stopped")
        if (_clock() - t0) / 1000.0 > HARD_LIMIT_S:
            raise _Abort("timeout")

    status, result, error = "done", None, ""
    try:
        result = kerf.nest(job, on_progress, _clock)
    except _Abort as a:
        status = a.status
        with _lock:
            result = run["layout"]
    except Exception as exc:                       # die Oberfläche soll den Grund sehen
        status, error = "failed", str(exc)[:300] or exc.__class__.__name__
    verify = None
    if result is not None and status != "failed":
        with _lock:
            run["layout"] = result
            run["rev"] += 1
            run["status"] = "checking"
        try:
            verify = kerf.verify(job, result)
        except Exception as exc:
            status, error = "failed", f"Prüfung fehlgeschlagen: {str(exc)[:200]}"
    with _lock:
        run["verify"] = verify
        run["error"] = error
        run["elapsed_ms"] = round(_clock() - t0)
        run["finished_at"] = datetime.now(timezone.utc).isoformat()
        run["status"] = status


def start(job: dict, actor: str) -> dict:
    with _lock:
        if any(r["status"] in ACTIVE for r in _runs.values()):
            raise Busy
        run = {"id": uuid.uuid4().hex, "status": "running", "actor": actor, "job": job, "rev": 0,
               "layout": None, "verify": None, "error": "", "phase": "",
               "started_at": datetime.now(timezone.utc).isoformat(), "finished_at": None,
               "elapsed_ms": 0, "_stop": threading.Event(), "_t0": _clock()}
        _runs[run["id"]] = run
        while len(_runs) > KEEP:
            _runs.popitem(last=False)
    threading.Thread(target=_work, args=(run,), name="freies-schachteln", daemon=True).start()
    return view(run["id"])


def _get(run_id: str) -> dict:
    run = _runs.get(run_id)
    if not run:
        raise FreeNestingError("Lauf nicht gefunden (nach einem Neustart sind Läufe weg).", 404)
    return run


def stop(run_id: str) -> dict:
    with _lock:
        run = _get(run_id)
        if run["status"] == "running":
            run["_stop"].set()
    return view(run_id)


def exportable(run: dict) -> bool:
    v = run["verify"]
    return bool(run["status"] in ("done", "stopped", "timeout") and run["layout"] is not None
                and v is not None and v["valid"])


def view(run_id: str, rev: Optional[int] = None) -> dict:
    """Der Stand für die Oberfläche. Mit ``rev`` und unveränderter Lage fehlt ``layout``."""
    with _lock:
        run = _get(run_id)
        job = run["job"]
        layout = run["layout"]
        same = rev is not None and rev == run["rev"]
        elapsed = run["elapsed_ms"] if run["status"] in FINAL else round(_clock() - run["_t0"])
        out = {
            "id": run["id"], "status": run["status"], "rev": run["rev"], "phase": run["phase"],
            "started_at": run["started_at"], "finished_at": run["finished_at"],
            "elapsed_ms": elapsed, "max_steps": job["maxSteps"],
            "step": layout["stats"]["iterations"] if layout else 0,
            "error": run["error"], "verify": run["verify"], "exportable": exportable(run),
            "notice": NOTICE_DE,
            "reproducible": run["status"] != "timeout" and run["status"] != "stopped",
            "job": {k: v for k, v in job.items() if k != "parts"},
        }
        if layout is not None and not same:
            out["layout"] = layout
            out["parts"] = [{k: p[k] for k in ("id", "name", "outer", "holes", "quantity")}
                            for p in job["parts"]]
        return out


# --------------------------------------------------------------------------
# Ausgabe
# --------------------------------------------------------------------------
def _sheets(run: dict) -> list[list[dict]]:
    job, layout = run["job"], run["layout"]
    n = max(1, layout["stats"]["sheetsUsed"])
    out: list[list[dict]] = [[] for _ in range(n)]
    for pl in layout["placements"]:
        part = job["parts"][pl["partIndex"]]
        out[pl["sheet"]].append({"part": part, "pl": pl, **kerf.transform_part(part, pl)})
    return out


def _export_run(run_id: str) -> dict:
    with _lock:
        run = _get(run_id)
        if not exportable(run):
            raise FreeNestingError(
                "Dieser Lauf ist nicht zum Export freigegeben: Er ist nicht fertig oder die Prüfung "
                "der Lage ist nicht bestanden.", 409)
        return dict(run)


def export_json(run_id: str) -> tuple[str, str]:
    run = _export_run(run_id)
    body = {"kind": "free-nesting", "notice": NOTICE_DE, "run": run["id"],
            "created_at": run["started_at"], "status": run["status"],
            "coordinates": "Millimeter, Ursprung oben links, y nach unten; die Konturen der Teile sind "
                           "gegenüber der Zeichnung in y gespiegelt (Bildschirmlage).",
            "job": run["job"], "result": run["layout"], "verify": run["verify"]}
    return json.dumps(body, ensure_ascii=False, indent=1), f"freies-schachteln-{run['id'][:8]}.json"


def export_dxf(run_id: str, sheet: int) -> tuple[str, str]:
    run = _export_run(run_id)
    sheets = _sheets(run)
    if sheet < 0 or sheet >= len(sheets):
        raise FreeNestingError("Diese Platte gibt es in dem Lauf nicht.", 404)
    W, H = run["job"]["sheet"]["width"], run["job"]["sheet"]["height"]
    w = dxfmod.DxfWriter(ext_min=(0.0, -100.0), ext_max=(W, H))
    w.rect(0, 0, W, H, dxfmod.LAYER_SHEET)
    for it in sheets[sheet]:
        w.polyline([(p[0], H - p[1]) for p in it["outer"]], dxfmod.LAYER_OUTER)
        for hole in it["holes"]:
            w.polyline([(p[0], H - p[1]) for p in hole], dxfmod.LAYER_HOLE)
    # Unter der Platte, auf der Ebene INFO: wird nicht geschnitten.
    w.text(0, -40, 20, NOTICE.upper(), dxfmod.LAYER_INFO)
    w.text(0, -75, 20, f"Platte {sheet + 1}/{len(sheets)}, {W:g} x {H:g} mm, Lauf {run['id'][:8]}",
           dxfmod.LAYER_INFO)
    return w.render(), f"freies-schachteln-{run['id'][:8]}-platte{sheet + 1}.dxf"


def _d(ring: list) -> str:
    return "M" + "L".join(f"{p[0]:.3f} {p[1]:.3f}" for p in ring) + "Z"


def export_svg(run_id: str) -> tuple[str, str]:
    run = _export_run(run_id)
    sheets = _sheets(run)
    W, H = run["job"]["sheet"]["width"], run["job"]["sheet"]["height"]
    margin = run["job"]["margin"]
    pitch = H + 80.0
    total = 100.0 + len(sheets) * pitch
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W:g} {total:g}" '
           f'width="{W:g}mm" height="{total:g}mm" role="img" aria-label="{escape(NOTICE_DE)}">',
           f"<title>{escape(NOTICE_DE)}</title>",
           f"<desc>Lauf {run['id'][:8]}, Einheit Millimeter. Kein Fertigungsauftrag.</desc>",
           f'<text x="0" y="40" font-size="28" font-family="sans-serif" fill="#1c2127">{escape(NOTICE_DE)}</text>']
    for i, items in enumerate(sheets):
        out.append(f'<g transform="translate(0 {100.0 + i * pitch:g})" data-sheet="{i + 1}">')
        out.append(f'<text x="0" y="-12" font-size="22" font-family="sans-serif" fill="#394b59">'
                   f'Platte {i + 1}/{len(sheets)} · {W:g} × {H:g} mm</text>')
        out.append(f'<rect x="0" y="0" width="{W:g}" height="{H:g}" fill="#ffffff" stroke="#394b59" stroke-width="2"/>')
        if margin > 0:
            out.append(f'<rect x="{margin:g}" y="{margin:g}" width="{W - 2 * margin:g}" height="{H - 2 * margin:g}" '
                       'fill="none" stroke="#6b7885" stroke-width="1" stroke-dasharray="8 6"/>')
        for it in items:
            d = " ".join([_d(it["outer"]), *(_d(h) for h in it["holes"])])
            out.append(f'<path d="{d}" fill="#dcebf7" fill-rule="evenodd" stroke="#1668ac" stroke-width="1.5">'
                       f'<title>{escape(str(it["part"]["name"]))}</title></path>')
        out.append("</g>")
    out.append("</svg>")
    return "\n".join(out), f"freies-schachteln-{run['id'][:8]}.svg"
