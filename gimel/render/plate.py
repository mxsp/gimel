"""Plattenzeichnung und Laufkarte für den Innenauftrag.

Das ist das Blatt, das in der Fertigung neben der Maschine liegt. Es muss zwei
Fragen beantworten, ohne dass jemand nachfragen muss:

  1. Was liegt wo auf der Platte?
  2. Zu welchem Kundenauftrag gehört jedes einzelne Teil?

Deshalb trägt jedes Teil eine Marke (A1, A2 …), die Marke steht im Bild an der
Stelle des Teils *und* in der Tabelle darunter mit Auftragsnummer und Kunde.
Farben folgen der Festlegung aus CLAUDE.md §9: blau = aus der Plattenfläche
geschnitten, grün = aus einer Restfläche, orange = Übergröße / Handarbeit.
"""

from __future__ import annotations

import datetime
import hashlib
import html
import math
from pathlib import Path
from typing import Iterable, Sequence

from ..services import identity
from .dxf import LAYER_HOLE, LAYER_OUTER
from .part import part_svg
from .qr import qr_svg

LAUFKARTE_JS = Path(__file__).resolve().parent.parent / "admin" / "laufkarte.js"

BLUE = "#0088b0"
GREEN = "#1d7a52"
ORANGE = "#b45309"
INK = "#201e1d"
MUTED = "#605d5d"
LINE = "#d7d3d3"
BLUE_TINT = "#e9f8ff"
GREEN_TINT = "#e7f4ee"
PAPER = "#f3f2f2"


def _esc(v) -> str:
    return html.escape(str(v if v is not None else ""), quote=True)


def _barcode_svg(text: str, w: int = 360, h: int = 44) -> str:
    seed = hashlib.sha256(text.encode()).digest()
    bars: list[str] = []
    x = 0
    # Start quiet zone
    x += 8
    for i, ch in enumerate(text):
        code = seed[i % len(seed)] if seed else ord(ch)
        for b in range(5):
            wide = (code >> b) & 1
            bw = 4 if wide else 2
            is_black = b % 2 == 0
            if is_black:
                bars.append(
                    f'<rect x="{x}" y="0" width="{bw}" height="{h - 12}" fill="{INK}"/>'
                )
            x += bw + 1
        x += 2
    # stop pattern
    bars.append(f'<rect x="{x}" y="0" width="3" height="{h - 12}" fill="{INK}"/>')
    inner = "".join(bars)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" '
        f'viewBox="0 0 {w} {h}" role="img" aria-label="Barcode {_esc(text)}">'
        f'<rect width="{w}" height="{h}" fill="#ffffff"/>'
        f"<g>{inner}</g>"
        f'<text x="{w / 2:.0f}" y="{h - 2:.0f}" text-anchor="middle" '
        f'font-family="ui-monospace,monospace" font-size="10" letter-spacing="0.08em" fill="{MUTED}">{_esc(text)}</text>'
        f"</svg>"
    )


def _qr_placeholder(text: str, size: int = 64) -> str:
    """Echter scanbarer QR-Code (ISO/IEC 18004) als kompaktes SVG."""
    try:
        return qr_svg(text, size=size, quiet=2, ink=INK, bg="#ffffff")
    except ValueError:
        return qr_svg(text[:180], size=size, quiet=2, ink=INK, bg="#ffffff")


def _bolt_holes_list(
    shape: dict | None, item: dict
) -> list[tuple[float, float, float]]:
    b = (shape or {}).get("bolts") if isinstance(shape, dict) else None
    if b and isinstance(b, dict):
        n = int(round(float(b.get("n") or 0)))
        d = float(b.get("d") or 0)
        bc = float(b.get("bc") or 0)
        if n > 0 and d > 0 and bc > 0:
            phase = math.radians(float(b.get("phase") or 0))
            return [
                (
                    math.cos(phase + 2 * math.pi * k / n) * bc / 2,
                    math.sin(phase + 2 * math.pi * k / n) * bc / 2,
                    d / 2,
                )
                for k in range(n)
            ]
    bn = int(item.get("bn") or item.get("bolt_count") or 0)
    bd = float(item.get("bd") or item.get("bolt_d") or item.get("bolt_diameter") or 0)
    bc = float(item.get("bc") or item.get("bolt_circle") or 0)
    if bn > 0 and bd > 0 and bc > 0:
        return [
            (
                math.cos(2 * math.pi * k / bn) * bc / 2,
                math.sin(2 * math.pi * k / bn) * bc / 2,
                bd / 2,
            )
            for k in range(bn)
        ]
    return []


def _part_svg(pl: dict, colour: str, fill: str) -> str:
    cx, cy = float(pl["cx"]), float(pl["cy"])
    od = float(pl.get("od") or 0.0)
    di = float(pl.get("di") or 0.0)
    rot = float(pl.get("rot") or pl.get("angle_deg") or pl.get("rotation_deg") or 0.0)
    mirror = bool(pl.get("mirror"))
    shape = pl.get("shape") if isinstance(pl.get("shape"), dict) else None
    outer = shape.get("outer") if shape else None
    # Eine Transform für das ganze Teil: erst gespiegelt (um die eigene
    # Hochachse — rechts in der Liste steht, was zuerst auf den Punkt wirkt),
    # dann gedreht. Löcher und Schraubenbild reisen mit, weil jedes Element
    # dieselbe Transform trägt; ohne sie würde ein gespiegelt gelegtes Teil
    # geschnitten, wie es gezeichnet war — die falsche Hand.
    tfs: list[str] = []
    if abs(rot) > 1e-4:
        tfs.append(f"rotate({rot:.1f} {cx:.2f} {cy:.2f})")
    if mirror:
        tfs.append(f"translate({2 * cx:.2f} 0) scale(-1 1)")
    transform = f' transform="{" ".join(tfs)}"' if tfs else ""
    bits: list[str] = []
    if outer and outer.get("kind") == "rect":
        w, h = float(outer.get("w", 0)), float(outer.get("h", 0))
        rx = float(outer.get("r", 0))
        bits.append(
            f'<rect class="alpha-kontur" data-layer="kontur" x="{cx - w / 2:.2f}" y="{cy - h / 2:.2f}" width="{w:.2f}" '
            f'height="{h:.2f}" rx="{rx:.2f}" fill="{fill}" stroke="{colour}" '
            f'stroke-width="2.5"{transform}/>'
        )
    elif outer and outer.get("kind") == "oval":
        w, h = float(outer.get("w", 0)), float(outer.get("h", 0))
        bits.append(
            f'<ellipse class="alpha-kontur" data-layer="kontur" cx="{cx:.2f}" cy="{cy:.2f}" rx="{w / 2:.2f}" ry="{h / 2:.2f}" '
            f'fill="{fill}" stroke="{colour}" stroke-width="2.5"{transform}/>'
        )
    elif outer and outer.get("kind") == "poly" and outer.get("pts"):
        pts = " ".join(
            f"{cx + float(x):.2f},{cy + float(y):.2f}" for x, y in outer["pts"]
        )
        bits.append(
            f'<polygon class="alpha-kontur" data-layer="kontur" points="{pts}" fill="{fill}" stroke="{colour}" stroke-width="2.5"{transform}/>'
        )
    else:
        bits.append(
            f'<circle class="alpha-kontur" data-layer="kontur" cx="{cx:.2f}" cy="{cy:.2f}" r="{od / 2:.2f}" '
            f'fill="{fill}" stroke="{colour}" stroke-width="2.5"{transform}/>'
        )
    has_concentric_bore = False
    if shape and shape.get("holes"):
        for h in shape["holes"]:
            if isinstance(h, dict):
                hkind = h.get("kind", "circle")
                hx, hy = cx + float(h.get("x", 0)), cy + float(h.get("y", 0))
                if hkind == "circle":
                    hr = float(h.get("d", 0)) / 2.0
                    if (
                        abs(float(h.get("x", 0))) < 0.1
                        and abs(float(h.get("y", 0))) < 0.1
                    ):
                        has_concentric_bore = True
                    bits.append(
                        f'<circle class="alpha-loch" data-layer="loch" cx="{hx:.2f}" cy="{hy:.2f}" r="{hr:.2f}" '
                        f'fill="{PAPER}" stroke="{colour}" stroke-width="1.8" stroke-dasharray="8 6"{transform}/>'
                    )
                elif hkind == "rect":
                    hw, hh = float(h.get("w", 0)), float(h.get("h", 0))
                    hrx = float(h.get("r", 0))
                    bits.append(
                        f'<rect class="alpha-loch" data-layer="loch" x="{hx - hw / 2:.2f}" y="{hy - hh / 2:.2f}" width="{hw:.2f}" '
                        f'height="{hh:.2f}" rx="{hrx:.2f}" fill="{PAPER}" stroke="{colour}" stroke-width="1.8" stroke-dasharray="8 6"{transform}/>'
                    )
                elif hkind == "oval":
                    hw, hh = float(h.get("w", 0)), float(h.get("h", 0))
                    bits.append(
                        f'<ellipse class="alpha-loch" data-layer="loch" cx="{hx:.2f}" cy="{hy:.2f}" rx="{hw / 2:.2f}" ry="{hh / 2:.2f}" '
                        f'fill="{PAPER}" stroke="{colour}" stroke-width="1.8" stroke-dasharray="8 6"{transform}/>'
                    )
                elif hkind == "slot":
                    hw, hh = float(h.get("w", 0)), float(h.get("h", 0))
                    bits.append(
                        f'<rect class="alpha-loch" data-layer="loch" x="{hx - hw / 2:.2f}" y="{hy - hh / 2:.2f}" width="{hw:.2f}" '
                        f'height="{hh:.2f}" rx="{min(hw, hh) / 2:.2f}" fill="{PAPER}" stroke="{colour}" stroke-width="1.8" stroke-dasharray="8 6"{transform}/>'
                    )
            elif isinstance(h, (list, tuple)) and len(h) >= 3:
                pts = " ".join(f"{cx + float(x):.2f},{cy + float(y):.2f}" for x, y in h)
                bits.append(
                    f'<polygon class="alpha-loch" data-layer="loch" points="{pts}" fill="{PAPER}" stroke="{colour}" stroke-width="1.8" stroke-dasharray="8 6"{transform}/>'
                )
    if di > 0 and not has_concentric_bore:
        bits.append(
            f'<circle class="alpha-loch" data-layer="loch" cx="{cx:.2f}" cy="{cy:.2f}" r="{di / 2:.2f}" '
            f'fill="{PAPER}" stroke="{colour}" stroke-width="1.8" stroke-dasharray="8 6"{transform}/>'
        )
    for bx_rel, by_rel, br in _bolt_holes_list(shape, pl):
        bx = cx + bx_rel
        by = cy + by_rel
        bits.append(
            f'<circle class="alpha-loch" data-layer="loch" cx="{bx:.2f}" cy="{by:.2f}" r="{br:.2f}" '
            f'fill="{PAPER}" stroke="{colour}" stroke-width="1.5"{transform}/>'
        )
    return "".join(bits)


def plate_svg(
    fmt: Sequence[float],
    placements: Iterable[dict],
    *,
    title: str = "",
    plate_no: str = "",
    used_h: float | None = None,
    turned: bool = False,
    width_px: int = 900,
) -> str:
    W, H = float(fmt[0]), float(fmt[1])
    pad = 60.0
    vb_w, vb_h = W + 2 * pad, H + 2 * pad + 40
    scale = width_px / vb_w
    height_px = int(vb_h * scale)
    parts = list(placements)
    out: list[str] = []
    out.append(
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{-pad:.0f} {-pad - 40:.0f} '
        f'{vb_w:.0f} {vb_h:.0f}" width="{width_px}" height="{height_px}" '
        # group, nicht img: die Teile darin sind fokussierbare Schaltflächen,
        # und role="img" verbirgt alle Kinder vor Screenreadern.
        f'role="group" aria-label="Plattenbelegung {_esc(plate_no)}">'
    )
    out.append('<rect x="-100%" y="-100%" width="300%" height="300%" fill="#ffffff"/>')
    if title or plate_no:
        out.append(
            f'<text data-layer="info" x="0" y="{-pad - 8:.0f}" font-family="ui-sans-serif,system-ui,sans-serif" '
            f'font-size="30" font-weight="700" fill="{INK}">{_esc(title)}</text>'
        )
        out.append(
            f'<text data-layer="info" x="{W:.0f}" y="{-pad - 8:.0f}" text-anchor="end" '
            f'font-family="ui-monospace,monospace" font-size="26" fill="{MUTED}">'
            f"{_esc(plate_no)} · {W:.0f} × {H:.0f} mm</text>"
        )
    out.append(
        f'<rect data-layer="platte" x="0" y="0" width="{W:.0f}" height="{H:.0f}" fill="{PAPER}" '
        f'stroke="{INK}" stroke-width="3"/>'
    )
    if used_h and 0 < used_h < (W if turned else H):
        if turned:
            # Gedreht verbaute Platte (GRE): das Schnittband läuft über die
            # Plattenbreite, der Rest liegt rechts der Marke.
            out.append(
                f'<rect data-layer="platte" x="0" y="0" width="{used_h:.0f}" height="{H:.0f}" fill="#ffffff"/>'
            )
            out.append(
                f'<line data-layer="platte" x1="{used_h:.0f}" y1="0" x2="{used_h:.0f}" y2="{H:.0f}" '
                f'stroke="{ORANGE}" stroke-width="3" stroke-dasharray="18 12"/>'
            )
            out.append(
                f'<text data-layer="info" x="{used_h - 12:.0f}" y="44" text-anchor="end" '
                f'font-family="ui-sans-serif,system-ui,sans-serif" font-size="24" '
                f'fill="{ORANGE}">Rest rechts ab {used_h:.0f} mm — zurück ins Regal</text>'
            )
        else:
            out.append(
                f'<rect data-layer="platte" x="0" y="0" width="{W:.0f}" height="{used_h:.0f}" fill="#ffffff"/>'
            )
            out.append(
                f'<line data-layer="platte" x1="0" y1="{used_h:.0f}" x2="{W:.0f}" y2="{used_h:.0f}" '
                f'stroke="{ORANGE}" stroke-width="3" stroke-dasharray="18 12"/>'
            )
            out.append(
                f'<text data-layer="info" x="{W - 8:.0f}" y="{used_h + 34:.0f}" text-anchor="end" '
                f'font-family="ui-sans-serif,system-ui,sans-serif" font-size="24" '
                f'fill="{ORANGE}">Rest ab {used_h:.0f} mm — zurück ins Regal</text>'
            )
    for pl in parts:
        colour = GREEN if pl.get("from_remnant") else BLUE
        fill = GREEN_TINT if pl.get("from_remnant") else BLUE_TINT
        tag = str(pl.get("tag", "") or "")
        order_no = str(pl.get("order_no", "") or "")
        customer = str(pl.get("customer", "") or "")
        label = str(pl.get("label", "") or "")
        od = float(pl.get("od") or 0.0)
        di = float(pl.get("di") or 0.0)
        origin = "Restfläche" if pl.get("from_remnant") else "Platte"
        info_parts = [f"Marke {tag}"]
        if order_no:
            info_parts.append(order_no)
        if customer:
            info_parts.append(customer)
        if label:
            info_parts.append(label)
        if od > 0:
            info_parts.append(f"Ø {od:.1f}" + (f"/{di:.1f}" if di > 0 else "") + " mm")
        info_parts.append(f"({origin})")
        tip = " · ".join(info_parts)
        od_val = float(pl.get("od") or 0.0)
        size = max(18.0, min(46.0, od_val / 4.5)) if od_val > 0 else 24.0
        out.append(
            f'<g class="plate-part" data-tag="{_esc(tag)}" data-order="{_esc(order_no)}" '
            f'tabindex="0" role="button" aria-label="{_esc(tip)}">'
        )
        out.append(f"<title>{_esc(tip)}</title>")
        out.append(_part_svg(pl, colour, fill))
        out.append(
            f'<text class="plate-part-tag" data-layer="marke" x="{pl["cx"]:.2f}" y="{pl["cy"] + size / 3:.2f}" text-anchor="middle" '
            f'font-family="ui-monospace,monospace" font-size="{size:.0f}" '
            f'font-weight="700" fill="{colour}">{_esc(tag)}</text>'
        )
        out.append("</g>")
    ly = H + 34
    out.append(
        f'<g data-layer="info" font-family="ui-sans-serif,system-ui,sans-serif" font-size="24" fill="{MUTED}">'
    )
    out.append(
        f'<circle cx="12" cy="{ly - 8:.0f}" r="10" fill="{BLUE_TINT}" stroke="{BLUE}" stroke-width="2.5"/>'
    )
    out.append(f'<text x="32" y="{ly:.0f}">aus der Plattenfläche</text>')
    out.append(
        f'<circle cx="332" cy="{ly - 8:.0f}" r="10" fill="{GREEN_TINT}" stroke="{GREEN}" stroke-width="2.5"/>'
    )
    out.append(
        f'<text x="352" y="{ly:.0f}">aus einer Restfläche (kein Materialverbrauch)</text>'
    )
    out.append("</g>")
    out.append("</svg>")
    return "".join(out)


def _item_row(pl: dict, *, office: bool = True, plate_idx: int = 0) -> str:
    tag = pl.get("tag", "")
    order_no = pl.get("order_no", "")
    ref = pl.get("customer_ref") if office else ""
    ref_html = f'<div class="sub">Best.-Nr.: {_esc(ref)}</div>' if ref else ""
    origin = "Restfläche" if pl.get("from_remnant") else "Platte"
    pill = "green" if pl.get("from_remnant") else "blue"
    customer_cell = f"<td>{_esc(pl.get('customer'))}{ref_html}</td>" if office else ""
    chk_key = f"marke:{plate_idx}:{tag}"
    return (
        f'<tr class="marken-row" data-marke-tag="{_esc(tag)}" data-order-no="{_esc(order_no)}">'
        f'<td class="tag"><span class="mark-pill">{_esc(tag)}</span></td>'
        f'<td class="mono">{_esc(order_no)}</td>'
        f"{customer_cell}"
        f"<td>{_esc(pl.get('label'))}</td>"
        f'<td class="mono r">{pl.get("od", 0):.1f}</td>'
        f'<td class="mono r">{pl.get("di", 0):.1f}</td>'
        f'<td><span class="origin {pill}">{origin}</span></td>'
        f'<td class="chk"><button type="button" class="chk-btn" data-check="{_esc(chk_key)}" '
        f'aria-pressed="false" title="Marke {_esc(tag)} abhaken">☐</button></td></tr>'
    )


def _laufkarte_script(inline: bool) -> str:
    """Das Skript der Laufkarte, als Datei und nur für den Download eingebettet.

    Das Portal schreibt die Karte mit ``document.write`` in ein leeres Fenster. Das
    erbt die CSP des Portals (``script-src 'self'``): ein Inline-Skript bliebe dort
    tot, und ein eigener Header der Antwort hilft nicht, er kommt nie an dem Fenster
    an. Die heruntergeladene Datei öffnet dagegen ohne Server, also ohne ``/static``.
    """
    if inline:
        return f"<script>{LAUFKARTE_JS.read_text(encoding='utf-8')}</script>"
    return '<script src="/static/laufkarte.js"></script>'


_STATUS_LABEL = {
    "open": ("Offen", "neutral"),
    "running": ("Läuft", "active"),
    "done": ("Fertig", "done"),
    "cancelled": ("Storniert", "warn"),
}


def work_order_html(
    work_order: dict,
    plates: Sequence[dict],
    parts: Sequence[dict] = (),
    *,
    orders: Sequence[dict] = (),
    total_net: float = 0.0,
    manual_positions: Sequence[dict] = (),
    inline_script: bool = True,
    office: bool = True,
    public_url: str = "",
    portal_url: str = "",
    station_label: str = "",
    staged: bool = False,
    status: str = "",
) -> str:
    """Die Laufkarte — digital am Arbeitsplatz/Tablet und sauber druckbar auf A4.

    Aufbau für die Maschine: erst das Große (was, wo, wie viel), dann der
    abhakbare Ablauf, dann jede bemaßte Teilekarte, dann jede Platte mit
    Zeichnung und abhakbarer Zuordnungstabelle, dann Prüfung und Unterschrift.
    """
    wo = work_order
    paper_name = identity.texts().paper_name
    maker = f"{paper_name} · " if paper_name else ""
    rows_total = sum(len(p.get("placements", [])) for p in plates)
    now_str = (
        datetime.datetime.now(datetime.timezone.utc)
        .astimezone()
        .strftime("%d.%m.%Y %H:%M")
    )
    has_rush = any(o.get("rush") for o in orders)
    due_str = ""
    if wo.get("due_date"):
        try:
            due_str = str(wo["due_date"])[:10]
        except Exception:
            due_str = ""

    qr_target = (public_url or portal_url or wo["no"]).strip()
    qr_caption = "DIGITAL · NETZ" if public_url else ("PORTAL IA" if portal_url else "SCAN IA")
    barcode = _barcode_svg(wo["no"], w=360, h=48)
    qr_head = _qr_placeholder(qr_target, size=92)

    wo_status = status or str(wo.get("status") or "")
    status_text, status_tone = _STATUS_LABEL.get(wo_status, ("", "neutral"))

    # DXF-Download-Basis: bei Netz-Freigabe über den Token-Pfad, im Portal über /api,
    # bei Offline-Download ohne Netz-Link ausgeblendet (kein toter 401-Link).
    dxf_base = ""
    if public_url:
        dxf_base = public_url.rstrip("/")
    elif not inline_script:
        dxf_base = f"/api/production/work-orders/{_esc(wo['no'])}"

    def head_cell(k, v, cls: str = ""):
        extra = f" {cls}" if cls else ""
        return f'<div class="kv{extra}"><span>{_esc(k)}</span><b>{_esc(v)}</b></div>'

    # ── Platten-Blöcke ───────────────────────────────────────────────
    plates_html_parts: list[str] = []
    for p in plates:
        placements = p.get("placements", [])
        pidx = int(p["idx"])
        svg = plate_svg(
            p["fmt"],
            placements,
            title=f"{wo['mat_name'] or wo['mat']} · {wo['thk']:g} mm",
            plate_no=f"{wo['no']} · Platte {pidx + 1}/{len(plates)}",
            used_h=p.get("used_h"),
            turned=bool(p.get("turned")),
        )
        rows = "".join(_item_row(pl, office=office, plate_idx=pidx) for pl in placements)
        pct_val = p.get("utilisation", 0) * 100
        used_h = p.get("used_h") or 0
        fmt = p["fmt"]
        cut_to = (f"Schnitt quer bis {used_h:.0f} mm" if p.get("turned")
                  else f"Schnitt bis {used_h:.0f} mm")
        plate_qr_target = f"{qr_target}#platte-{pidx + 1}" if (public_url or portal_url) else f"{wo['no']}-P{pidx + 1}"
        plate_qr = _qr_placeholder(plate_qr_target, size=58)
        plate_dxf = (
            f' <a class="dxf-link no-print" href="{_esc(dxf_base)}/plate/{pidx}.dxf" download>Platte DXF</a>'
            if dxf_base else ""
        )
        cust_th = "<th>Kunde</th>" if office else ""
        plates_html_parts.append(f"""
      <section class="plate" id="platte-{pidx + 1}">
        <div class="plate-head">
          <div>
            <h2>Platte {pidx + 1} von {len(plates)}
              <span class="plate-fmt">{fmt[0]:.0f} × {fmt[1]:.0f} mm</span>
              <span class="sub">{len(placements)} Teile · Ausnutzung {pct_val:.0f} % · {cut_to}</span>{plate_dxf}</h2>
            <div class="util-bar"><i style="width:{max(4, pct_val):.0f}%"></i></div>
          </div>
          <div class="plate-qr" title="Scan Platte {pidx + 1}">{plate_qr}</div>
        </div>
        <div class="draw">{svg}</div>
        <div class="plate-legend">
          <span class="legend-dot blue"></span> Platte
          <span class="legend-dot green"></span> Restfläche
          <span class="legend-cut">— {cut_to} → Rest zurück ins Regal</span>
        </div>
        <table class="marken-table">
          <thead><tr><th>Marke</th><th>Auftrag</th>{cust_th}<th>Teil</th>
            <th class="r">Ø außen</th><th class="r">Ø innen</th><th>Herkunft</th><th class="chk">✓</th></tr></thead>
          <tbody>{rows}</tbody>
        </table>
        <div class="plate-check-hint">Beim Entnehmen abhaken — jede Marke genau einmal.</div>
      </section>""")

    # ── Ablauf als interaktive Checkliste ────────────────────────────
    cut_plan = wo.get("cut_plan") or {}
    if cut_plan.get("layered"):
        cut_step = (
            f"Schnittfolge {cut_plan.get('label', '')}: die Vollplatten-DXF ist "
            "geschichtet (PLOTPRO_01_1_LOCH, 01_2_KONTUR, 02_… ). Die Ebenen der "
            "Nummer nach abfahren — nicht in Dateireihenfolge, nicht alles auf "
            "einmal. " + str(cut_plan.get("reason", ""))
        )
    else:
        cut_step = (
            "Schnittfolge: keine vorgegeben, die klassische Datei laden "
            f"({LAYER_OUTER} / {LAYER_HOLE}). " + str(cut_plan.get("reason", ""))
        )

    steps = [
        (
            f"Platte {wo['fmt'][0]:.0f} × {wo['fmt'][1]:.0f} mm in "
            f"{wo['mat_name'] or wo['mat']}, {wo['thk']:g} mm bereitlegen "
            f"({wo['n_plates']}× benötigt). Format am Regal gegen Zeichnung prüfen."
        ),
        (
            "Belegung dieser Laufkarte mit der Platte vergleichen — steht die "
            "Platte richtig herum, liegt das Maß an?"
        ),
        cut_step,
        (
            "Schneiden. Teile auf der Platte liegen lassen, bis alle Schnitte fertig sind. Schutzfolie erst danach abziehen."
        ),
        (
            "Jedes Teil beim Entnehmen nach seiner Marke ablegen — die Marke steht in der Zeichnung an der Stelle des Teils. "
            "Grün = aus Restfläche, blau = aus Plattenfläche."
        ),
        (
            f"Nach Kundenauftrag zusammenstellen: {wo['n_orders']} Aufträge liegen auf dieser Platte. "
            f"Mit den Marken-Bändern unten verpacken, nicht nach Augenmaß."
        ),
        (
            "Laufkarte abzeichnen und Innenauftrag im System fertig melden (oder Platte einzeln abhaken)."
        ),
    ]
    steps_html = ""
    for idx, t in enumerate(steps, 1):
        steps_html += (
            f'<li data-check="step:{idx}" role="checkbox" aria-checked="false" tabindex="0">'
            f'<span class="chkbox" aria-hidden="true"></span>'
            f'<span class="num">{idx}</span><span class="step-text">{_esc(t)}</span></li>'
        )

    # ── Teile-Block ──────────────────────────────────────────────────
    parts_block = ""
    if parts:
        cards = "".join(
            f"""
        <div class="pcard">
          {
                part_svg(
                    od=p["od"],
                    di=p["di"],
                    bolt_count=p.get("bolt_count", 0),
                    bolt_d=p.get("bolt_d", 0),
                    bolt_circle=p.get("bolt_circle", 0),
                    shape=p.get("shape"),
                    label=p["label"],
                    tags=p.get("tags", ()),
                    qty=p.get("qty", 1),
                    thk=p.get("thk", 0),
                    order_no=p.get("order_no", ""),
                    customer=p.get("customer", "") if office else "",
                    width_px=300,
                )
            }
          <div class="pmeta">
            <b>{p.get("qty", 1)}× {_esc(p["label"])}</b>
            <div class="sub">{_esc(" · ".join(x for x in (p.get("order_no", ""), p.get("customer", "") if office else "") if x))}</div>
            <div class="sub">Marken: <span class="mono">{
                _esc(", ".join(p.get("tags", [])))
            }</span></div>
            <div class="sub">Platte {", ".join(str(x) for x in p.get("plates", []))}
              {
                f"· {p['n_from_remnant']}× aus Restfläche"
                if p.get("n_from_remnant")
                else ""
            }</div>
            {
                f'<div class="sub no-print"><a href="{_esc(dxf_base)}/part/{p["position_id"]}.dxf" download class="dxf-link">DXF herunterladen</a></div>'
                if (dxf_base and p.get("position_id"))
                else ""
            }
          </div>
        </div>"""
            for p in parts
        )
        parts_block = f"""<div class="sheet" id="teile">
          <h2>Was geschnitten wird <span class="sub">{len(parts)} verschiedene Teile · je Bestellposition eine Karte</span></h2>
          <p class="sub" style="margin:4px 0 10px">Außenmaß geprüft, Bohrungen bemaßt. Grün markierte Teile werden aus der Restfläche geschnitten — kein zusätzlicher Materialverbrauch.</p>
          <div class="pgrid">{cards}</div>
        </div>"""

    def _fmt_addr(o: dict) -> str:
        parts2 = [o.get("ship_name"), o.get("ship_street")]
        city_line = " ".join(filter(None, [o.get("ship_zip"), o.get("ship_city")]))
        if city_line:
            parts2.append(city_line)
        country = o.get("ship_country", "DE")
        if country and country != "DE":
            parts2.append(country)
        return ", ".join(p for p in parts2 if p) or "—"

    order_overview = ""
    if orders:
        cards_html: list[str] = []
        for o in orders:
            addr = _fmt_addr(o) if office else ""
            ref_line = (
                f'<div class="oref">Bestellzeichen: '
                f"{_esc(o.get('customer_ref') or '—')}</div>"
                if (office and o.get("customer_ref"))
                else ""
            )
            rush_tag = ' <span class="rush">EILT</span>' if o.get("rush") else ""
            part_rows = []
            for pg in o.get("parts", []):
                tags_str = ", ".join(pg.get("tags", []))
                origin_parts: list[str] = []
                if pg.get("n_from_remnant"):
                    origin_parts.append(f"{pg['n_from_remnant']}× Restfläche")
                if pg["qty"] - pg.get("n_from_remnant", 0):
                    origin_parts.append(
                        f"{pg['qty'] - pg.get('n_from_remnant', 0)}× Platte"
                    )
                origin = " · ".join(origin_parts)
                plate_nrs = ", ".join(str(x) for x in pg.get("plates", []))
                part_rows.append(
                    f'<tr><td class="mono">{_esc(tags_str)}</td>'
                    f"<td>{_esc(pg['label'])}</td>"
                    f'<td class="r">{pg["qty"]}</td>'
                    f"<td>{origin}</td>"
                    f"<td>Pl. {plate_nrs}</td></tr>"
                )
            parts_table = ""
            if part_rows:
                parts_table = (
                    '<table class="ptable">'
                    "<thead><tr><th>Marken</th><th>Teil</th>"
                    '<th class="r">Menge</th><th>Herkunft</th>'
                    "<th>Platte(n)</th></tr></thead>"
                    f"<tbody>{''.join(part_rows)}</tbody></table>"
                )
            cards_html.append(f"""
          <div class="ocard">
            <div class="oheader">
              <div class="ono">{_esc(o["order_no"])}{rush_tag}</div>
              {f'<div class="ocustomer">{_esc(o["customer"])}</div>' if (office and o.get("customer")) else ""}
            </div>
            <div class="obody">
              {f'<div class="oaddr">{_esc(addr)}</div>' if addr else ""}
              {ref_line}
              <div class="ostats">
                <span>{o["n_parts"]} Teile</span>
                <span>{len(o.get("tags", []))} Marken</span>
                {f'<span class="mono">{o["net"] / 100:.2f} €</span>' if office else ""}
              </div>
              {parts_table}
            </div>
          </div>""")
        order_cards = "".join(cards_html)
        total_parts = sum(o["n_parts"] for o in orders)
        order_overview = f"""
      <section class="sheet" id="auftraege" style="page-break-before:always">
        <h2>Auftragsübersicht
          <span class="sub">{len(orders)} Kundenauftrag{"e" if len(orders) != 1 else ""}
            · {total_parts} Teile{f" · Gesamtwert {total_net / 100:.2f} €" if office else ""}</span></h2>
        <p class="sub">Teile dieser Platten liegen in folgenden Kundenaufträgen.
          {"Adresse und Teileübersicht dienen der Zuordnung beim Verpacken und in der Rechnungsprüfung."
           if office else "Zuordnung über die Auftragsnummer; Anschrift und Kunde stehen im Versand."}
          Marken-Bänder nach Auftrag trennen.</p>
        <div class="ogrid">{order_cards}</div>
      </section>"""

    manual_block = ""
    if manual_positions:
        rows = ""
        for mp in manual_positions:
            rows += (
                f'<tr><td class="mono">{_esc(mp.get("order_no_raw") or mp.get("order_no", ""))}</td>'
                + (f"<td>{_esc(mp.get('customer', ''))}</td>" if office else "")
                + f"<td><b>{_esc(mp.get('label', ''))}</b></td>"
                f'<td class="mono r">{int(mp.get("qty", 0))}</td>'
                f"<td>{_esc(mp.get('note', '')) or '<span class="sub">—</span>'}</td>"
                + (f'<td class="mono r">{float(mp.get("price_gross", 0)):.2f} €</td>' if office else "")
                + "</tr>"
            )
        manual_block = f"""
      <section class="sheet" style="page-break-before:always">
        <h2>Sonderfertigung / Manuell <span class="sub">{len(manual_positions)} Position(en) — nicht auf der Platte, interne Beschreibung</span></h2>
        <p class="sub">Diese Positionen werden von Hand gefertigt oder zugekauft — sie liegen nicht auf einer Platte.
           Interne Beschreibung unten ist für die Werkstatt; der Kundenhinweis steht auf Beleg/Rechnung, nicht hier.</p>
        <table>
          <thead><tr><th>Auftrag</th>{"<th>Kunde</th>" if office else ""}<th>Bezeichnung</th><th class="r">Menge</th><th>Interne Beschreibung</th>{'<th class="r">Preis brutto</th>' if office else ""}</tr></thead>
          <tbody>{rows}</tbody>
        </table>
      </section>"""

    dxf_links = ""
    if parts and dxf_base:
        links = ""
        for p in parts:
            if not p.get("position_id"):
                continue
            pid = p["position_id"]
            tags_str = ", ".join(p.get("tags", []))
            links += (
                f'<li><a href="{_esc(dxf_base)}/part/{pid}.dxf" download>'
                f"{_esc(p.get('label', ''))} · {_esc(tags_str)} · "
                f"{_esc(p.get('order_no', ''))}</a></li>"
            )
        if links:
            dxf_links = f"""
      <section class="sheet no-print" style="page-break-before:always">
        <h2>Einzel-Downloads</h2>
        <p class="sub">Falls die Vollplatte oder der Bündel-Download nicht funktioniert,
          hier jede Form als eigene DXF-Datei zum Nachschneiden oder Archivieren.</p>
        <ul class="dxf-list">{links}</ul>
      </section>"""

    # Flags & Status-Leiste
    rush_banner = (
        '<div class="rush-banner">⚑ EILT — mindestens ein Auftrag ist als Eilauftrag markiert</div>'
        if has_rush
        else ""
    )
    due_cell = head_cell("Fällig", due_str, "rush" if has_rush else "") if due_str else ""
    fmt_label = f"{wo['fmt'][0]:.0f} × {wo['fmt'][1]:.0f} mm"
    if wo.get("formats"):
        try:
            fmt_label = " + ".join(
                f"{w:.0f}×{h:.0f} ({n}×)" for w, h, n in wo["formats"]
            )
        except Exception:
            pass

    qc_left = [
        "Außenmaß / Innenmaß an 2 Teilen je Position mit Schieblehre geprüft",
        "Bohrbild: Lochzahl, Loch-Ø, Lochkreis — 1 Teil je Position mit Lehre/Dorn",
        "Kanten: keine Ausfransung, kein Grat > 0,2 mm, keine Delamination",
        "Oberfläche sauber, keine Kratzer im Dichtbereich",
    ]
    qc_right = [
        "Stückzahl je Marke mit Tabelle abgeglichen",
        "Zuordnung je Auftrag getrennt abgelegt — kein Vermischen",
        "Reststück oberhalb Schnittlinie ins Regal zurück",
        "Laufkarte liegt der Ware bei bis Versand",
    ]
    qc_left_html = "".join(
        f'<li data-check="qc:l{i}" role="checkbox" aria-checked="false" tabindex="0">'
        f'<span class="chkbox" aria-hidden="true"></span><span>{_esc(txt)}</span></li>'
        for i, txt in enumerate(qc_left, 1)
    )
    qc_right_html = "".join(
        f'<li data-check="qc:r{i}" role="checkbox" aria-checked="false" tabindex="0">'
        f'<span class="chkbox" aria-hidden="true"></span><span>{_esc(txt)}</span></li>'
        for i, txt in enumerate(qc_right, 1)
    )

    nav_links = ['<a href="#uebersicht">Übersicht</a>']
    if parts:
        nav_links.append('<a href="#teile">Teile</a>')
    if plates:
        nav_links.append(f'<a href="#platte-1">Platten ({len(plates)})</a>')
    nav_links.append('<a href="#pruefung">Prüfung</a>')
    if orders:
        nav_links.append('<a href="#auftraege">Aufträge</a>')

    badges_html = []
    if status_text:
        badges_html.append(f'<span class="lk-pill is-{status_tone}">{_esc(status_text)}</span>')
    if station_label:
        badges_html.append(f'<span class="lk-pill is-station">{_esc(station_label)}</span>')
    if staged:
        badges_html.append('<span class="lk-pill is-done">Material bereitgestellt</span>')
    if public_url:
        badges_html.append('<span class="lk-pill is-net">Digital · Netz</span>')

    reload_btn = '<button type="button" class="lk-btn" data-lk-reload>Aktualisieren</button>' if public_url else ""

    return f"""<!doctype html>
<html lang="de"><head><meta charset="utf-8">
<title>Laufkarte {_esc(wo["no"])}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  @page {{ size: A4; margin: 10mm 10mm 12mm 10mm; }}
  :root {{ color-scheme: light; }}
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; padding: 0 16px 28px; background: #f2f4f7; color: {INK};
         font: 13.5px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
         -webkit-print-color-adjust: exact; print-color-adjust: exact; }}
  /* Digitale Kopfzeile (nur Bildschirm, nie auf Papier) */
  .lk-bar {{ position: sticky; top: 0; z-index: 40; margin: 0 -16px 16px;
             background: rgba(255,255,255,.96); backdrop-filter: blur(6px);
             border-bottom: 1px solid #d5d9df; padding: 8px 16px; }}
  .lk-bar-inner {{ max-width: 980px; margin: 0 auto; display: flex; flex-wrap: wrap;
                   align-items: center; gap: 8px 14px; justify-content: space-between; }}
  .lk-bar-left {{ display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }}
  .lk-bar-no {{ font-family: ui-monospace, monospace; font-weight: 800; font-size: 14px; letter-spacing: .02em; }}
  .lk-pill {{ display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 4px;
              font-size: 11px; font-weight: 600; border: 1px solid #d5d9df; background: #f5f7f9; color: {INK}; }}
  .lk-pill.is-active {{ background: #e8f4fa; border-color: #b7dcee; color: #055f80; }}
  .lk-pill.is-done {{ background: #e8f5ee; border-color: #b7dec9; color: #165e3f; }}
  .lk-pill.is-warn {{ background: #fef2f0; border-color: #f5c2b8; color: #b42318; }}
  .lk-pill.is-station {{ background: #f3f4f6; border-color: #cfd5dd; color: #1f2937; }}
  .lk-pill.is-net {{ background: #ecfdf5; border-color: #a7f3d0; color: #065f46; }}
  .lk-nav {{ display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px; }}
  .lk-nav a {{ color: {MUTED}; text-decoration: none; font-weight: 500; }}
  .lk-nav a:hover {{ color: {INK}; text-decoration: underline; }}
  .lk-bar-right {{ display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }}
  .lk-prog {{ display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: {MUTED}; font-variant-numeric: tabular-nums; }}
  .lk-prog-track {{ width: 72px; height: 5px; background: #e5e8ed; border-radius: 3px; overflow: hidden; }}
  .lk-prog-fill {{ display: block; height: 100%; width: 0%; background: {GREEN}; transition: width .2s ease; }}
  .lk-btn {{ appearance: none; border: 1px solid #cfd5dd; background: #fff; color: {INK};
             border-radius: 4px; padding: 4px 10px; font: 600 12px/1.4 inherit; cursor: pointer; }}
  .lk-btn:hover {{ background: #f3f4f6; }}
  .lk-btn.primary {{ background: #14532d; border-color: #14532d; color: #fff; }}
  .lk-btn.primary:hover {{ background: #166534; }}

  .sheet {{ max-width: 980px; margin: 0 auto 16px; background: #fff; padding: 20px 24px 18px;
            border: 1px solid #d5d9df; border-radius: 6px; break-inside: avoid; }}
  h1 {{ font-size: 26px; margin: 0; letter-spacing: -0.02em; line-height: 1.1; }}
  h2 {{ font-size: 15px; margin: 0 0 10px; display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }}
  .sub {{ font-size: 11.5px; font-weight: 400; color: {MUTED}; }}
  .ia-head {{ display: grid; grid-template-columns: 1fr auto; gap: 16px; align-items: start; }}
  .ia-no {{ font-family: ui-monospace, monospace; font-size: 32px; font-weight: 800; letter-spacing: 0.03em; line-height: 1; }}
  .ia-meta {{ font-size: 11.5px; color: {MUTED}; margin-top: 5px; }}
  .barcode {{ margin-top: 8px; }}
  .barcode svg {{ display: block; max-width: 100%; height: auto; }}
  .qr-head {{ border: 1px solid {LINE}; border-radius: 6px; padding: 6px; background: #fff; text-align: center; }}
  .qr-head svg {{ display: block; margin: 0 auto; }}
  .qr-cap {{ font-size: 9px; font-weight: 700; color: {MUTED}; margin-top: 4px; letter-spacing: .06em; }}
  .kvs {{ display: grid; grid-template-columns: repeat(4, minmax(0,1fr));
          gap: 8px; margin: 14px 0 12px; }}
  @media (max-width: 760px) {{ .kvs {{ grid-template-columns: repeat(2, 1fr); }} .ia-head {{ grid-template-columns: 1fr; }} }}
  .kv {{ background: #f8f9fb; border: 1px solid #e6e9ef; border-radius: 5px; padding: 7px 10px; }}
  .kv span {{ display: block; font-size: 10px; text-transform: uppercase;
              letter-spacing: .05em; color: {MUTED}; margin-bottom: 2px; }}
  .kv b {{ font-family: ui-monospace, monospace; font-size: 14.5px; line-height: 1.2; }}
  .kv.rush {{ background: #fef2f0; border-color: #fecaca; }}
  .rush-banner {{ margin: 12px 0 0; padding: 8px 12px; background: #c2410c; color: #fff;
                  border-radius: 5px; font-weight: 700; font-size: 12px; letter-spacing: .02em; }}
  .note {{ margin-top: 12px; padding: 9px 12px; background: #fffbeb;
           border-left: 3px solid {ORANGE}; font-size: 12px; line-height: 1.5; border-radius: 0 5px 5px 0; }}
  .note b {{ color: {INK}; }}
  /* Ablauf Checkliste */
  h2.section-title {{ margin-top: 16px; font-size: 12.5px; text-transform: uppercase; letter-spacing: .05em; color: {INK}; }}
  .steps {{ list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 6px; }}
  .steps li {{ display: grid; grid-template-columns: 22px 22px 1fr; gap: 8px; align-items: start;
               padding: 8px 10px; border: 1px solid #e6e9ef; border-radius: 5px; background: #fafbfc;
               cursor: pointer; user-select: none; transition: background .12s ease, border-color .12s ease; }}
  .steps li:hover {{ background: #f2f6fa; border-color: #cbd5e1; }}
  .steps li.is-checked {{ background: #f0fdf4; border-color: #bbf7d0; }}
  .steps li.is-checked .step-text {{ color: {MUTED}; text-decoration: line-through; }}
  .steps .chkbox {{ width: 18px; height: 18px; border: 2px solid {INK}; border-radius: 3px; background: #fff;
                    margin-top: 2px; display: grid; place-items: center; font-size: 13px; font-weight: 800; line-height: 1; }}
  .steps li.is-checked .chkbox {{ background: {GREEN}; border-color: {GREEN}; color: #fff; }}
  .steps .num {{ flex: 0 0 auto; width: 20px; height: 20px; border-radius: 4px;
                 background: #1f2937; color: #fff; display: grid; place-items: center;
                 font-family: ui-monospace, monospace; font-size: 11px; font-weight: 700; margin-top: 1px; }}
  .steps .step-text {{ font-size: 13px; line-height: 1.45; }}
  /* Platte */
  .plate {{ break-inside: avoid; scroll-margin-top: 64px; }}
  .plate + .plate {{ margin-top: 18px; }}
  .plate-head {{ display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 8px; }}
  .plate-fmt {{ font-family: ui-monospace, monospace; background: #eef6fb; border: 1px solid #d9eaf6; padding: 1px 6px; border-radius: 4px; font-size: 12px; }}
  .plate-qr {{ border: 1px solid {LINE}; border-radius: 5px; padding: 4px; background: #fff; flex: 0 0 auto; }}
  .util-bar {{ height: 5px; background: #eef2f5; border-radius: 3px; overflow: hidden; margin-top: 6px; max-width: 420px; }}
  .util-bar i {{ display: block; height: 100%; background: {BLUE}; }}
  .draw {{ margin: 8px 0 10px; text-align: center; border: 1px solid {LINE}; border-radius: 5px; padding: 8px; background: #fff; }}
  .draw svg {{ max-width: 100%; height: auto; }}
  .plate-legend {{ display: flex; gap: 14px; align-items: center; font-size: 11px; color: {MUTED}; margin-bottom: 8px; flex-wrap: wrap; }}
  .legend-dot {{ width: 10px; height: 10px; border-radius: 2px; display: inline-block; border-width: 2px; border-style: solid; }}
  .legend-dot.blue {{ background: {BLUE_TINT}; border-color: {BLUE}; }}
  .legend-dot.green {{ background: {GREEN_TINT}; border-color: {GREEN}; }}
  .legend-cut {{ color: {ORANGE}; font-weight: 600; }}
  table {{ width: 100%; border-collapse: collapse; font-size: 12px; }}
  th {{ text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .05em;
        color: {MUTED}; border-bottom: 2px solid {LINE}; padding: 7px 8px; white-space: nowrap; }}
  td {{ padding: 7px 8px; border-bottom: 1px solid #eef2f5; vertical-align: middle; }}
  td.sub, .sub {{ color: {MUTED}; }}
  .mono {{ font-family: ui-monospace, monospace; font-variant-numeric: tabular-nums; }}
  .r {{ text-align: right; }}
  .mark-pill {{ display: inline-block; font-family: ui-monospace, monospace; font-weight: 800; font-size: 12.5px;
                background: #e9f8ff; color: {BLUE}; border: 1px solid #cfeaf6; padding: 1px 7px; border-radius: 4px; min-width: 32px; text-align: center; }}
  .origin {{ font-size: 11px; font-weight: 600; padding: 2px 7px; border-radius: 4px; border: 1px solid; }}
  .origin.blue {{ background: {BLUE_TINT}; color: {BLUE}; border-color: #cfeaf6; }}
  .origin.green {{ background: {GREEN_TINT}; color: {GREEN}; border-color: #cce9d9; }}
  th.chk, td.chk {{ text-align: center; width: 42px; }}
  .chk-btn {{ appearance: none; border: 1.5px solid #9ca3af; background: #fff; color: {MUTED};
              border-radius: 4px; width: 28px; height: 28px; display: inline-grid; place-items: center;
              font-size: 15px; font-weight: 800; line-height: 1; cursor: pointer; }}
  .chk-btn:hover {{ border-color: {INK}; color: {INK}; }}
  .chk-btn.is-checked {{ background: {GREEN}; border-color: {GREEN}; color: #fff; }}
  .marken-row.is-checked td:not(.chk) {{ opacity: 0.55; }}
  .marken-table tbody tr:hover {{ background: #f8fafb; }}
  .marken-table td:first-child {{ width: 72px; }}
  .plate-check-hint {{ font-size: 11px; color: {MUTED}; margin-top: 6px; text-align: right; font-style: italic; }}
  /* Teilekarten */
  .pgrid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr));
            gap: 10px; margin-top: 10px; }}
  .pcard {{ border: 1px solid {LINE}; border-radius: 6px; padding: 10px; background: #fff; break-inside: avoid; }}
  .pcard svg {{ max-width: 100%; height: auto; display: block; margin: 0 auto; }}
  .pmeta {{ margin-top: 6px; font-size: 12px; border-top: 1px solid #eef2f5; padding-top: 6px; }}
  /* Auftragsübersicht */
  .ogrid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
            gap: 12px; margin-top: 10px; }}
  @media (max-width: 520px) {{ .ogrid {{ grid-template-columns: 1fr; }} }}
  .ocard {{ border: 1px solid {LINE}; border-radius: 6px; overflow: hidden; break-inside: avoid; }}
  .oheader {{ background: #f7f8fa; padding: 9px 12px; border-bottom: 1px solid {LINE}; }}
  .ono {{ font-family: ui-monospace, monospace; font-weight: 800; font-size: 13px; }}
  .ocustomer {{ font-size: 12px; color: {INK}; margin-top: 2px; }}
  .obody {{ padding: 9px 12px; font-size: 11.5px; }}
  .oaddr {{ color: {MUTED}; margin-bottom: 6px; }}
  .oref {{ color: {MUTED}; font-size: 11px; margin-bottom: 4px; }}
  .ostats {{ display: flex; gap: 12px; margin-bottom: 8px; color: {MUTED}; font-size: 11px; }}
  .ostats .mono {{ font-weight: 700; color: {INK}; }}
  .rush {{ color: #c2410c; font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .05em;
           border: 1px solid #fecaca; background: #fef2f0; padding: 1px 6px; border-radius: 4px; }}
  .ptable th {{ font-size: 10px; padding: 5px 6px; }}
  .ptable td {{ padding: 4px 6px; font-size: 11px; }}
  /* Prüfung & Freigabe */
  .qc {{ display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px; }}
  @media (max-width: 700px) {{ .qc {{ grid-template-columns: 1fr; }} }}
  .qc-card {{ border: 1px solid {LINE}; border-radius: 6px; padding: 12px 14px; background: #fafbfc; }}
  .qc-card h3 {{ font-size: 12px; text-transform: uppercase; letter-spacing: .05em; margin: 0 0 8px; color: {INK}; }}
  .qc-list {{ list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; }}
  .qc-list li {{ display: grid; grid-template-columns: 18px 1fr; gap: 8px; align-items: start; font-size: 12px;
                 cursor: pointer; user-select: none; padding: 3px 4px; border-radius: 4px; }}
  .qc-list li:hover {{ background: #eef2f6; }}
  .qc-list li.is-checked {{ color: {MUTED}; text-decoration: line-through; }}
  .qc-list .chkbox {{ width: 16px; height: 16px; border: 2px solid {INK}; border-radius: 3px; background: #fff;
                      margin-top: 1px; display: grid; place-items: center; font-size: 11px; font-weight: 800; line-height: 1; }}
  .qc-list li.is-checked .chkbox {{ background: {GREEN}; border-color: {GREEN}; color: #fff; }}
  .sig-grid {{ display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px; margin-top: 14px; }}
  @media (max-width: 700px) {{ .sig-grid {{ grid-template-columns: 1fr; }} }}
  .sig {{ border-top: 1px solid {INK}; padding-top: 6px; margin-top: 28px; font-size: 11px; color: {MUTED}; }}
  .sig b {{ display: block; font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: {MUTED}; margin-bottom: 18px; }}
  .sig-line {{ border-bottom: 1px solid {INK}; height: 22px; margin-bottom: 4px; }}
  .footer {{ margin-top: 10px; padding-top: 10px; border-top: 1px solid {LINE}; display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; font-size: 10px; color: {MUTED}; }}
  .dxf-list {{ list-style: none; margin: 10px 0 0; padding: 0; columns: 2; column-gap: 20px; }}
  .dxf-list li {{ break-inside: avoid; padding: 6px 0; border-bottom: 1px solid {LINE}; font-size: 12px; }}
  .dxf-list a {{ color: {BLUE}; text-decoration: none; }}
  .dxf-list a:hover {{ text-decoration: underline; }}
  .dxf-link {{ color: {BLUE}; text-decoration: none; font-size: 11px; border: 1px solid {BLUE}; border-radius: 3px; padding: 1px 6px; display: inline-block; margin-top: 3px; }}
  .dxf-link:hover {{ background: {BLUE}; color: #fff; }}
  /* Interaktiv digital */
  .plate-part {{ cursor: pointer; transition: filter .15s ease, opacity .15s ease; outline: none; }}
  .plate-part:hover, .plate-part.highlighted, .plate-part:focus-visible {{ filter: drop-shadow(0 0 10px rgba(0,136,176,.85)) brightness(1.08); }}
  .plate-part:hover text, .plate-part.highlighted text {{ font-size: 1.22em; font-weight: 900; }}
  .draw.has-highlight .plate-part:not(.highlighted) {{ opacity: 0.35; filter: grayscale(0.2); }}
  .marken-row {{ cursor: pointer; transition: background .12s ease; }}
  .marken-row:hover, .marken-row.highlighted {{ background: #e9f8ff !important; }}
  .marken-row.selected {{ background: #d4effa !important; font-weight: 600; }}
  .ocard.highlighted {{ border-color: {BLUE}; box-shadow: 0 0 0 2px {BLUE}; }}
  .pcard.highlighted {{ border-color: {BLUE}; background: #f0f9fd; }}
  @media print {{
    body {{ background: #fff; padding: 0; font-size: 11px; }}
    .sheet {{ box-shadow: none; border: 1px solid {LINE}; border-radius: 0; max-width: none; page-break-inside: avoid; margin-bottom: 10px; }}
    .plate {{ page-break-inside: avoid; }}
    .pgrid, .ogrid, .qc, .sig-grid {{ break-inside: avoid; }}
    .plate-part {{ filter: none !important; opacity: 1 !important; }}
    .marken-row {{ background: transparent !important; }}
    .marken-row.is-checked td:not(.chk) {{ opacity: 1; }}
    .no-print {{ display: none !important; }}
  }}
</style></head><body data-wo="{_esc(wo['no'])}">
<header class="lk-bar no-print" aria-label="Digitale Laufkarte">
  <div class="lk-bar-inner">
    <div class="lk-bar-left">
      <span class="lk-bar-no">{_esc(wo["no"])}</span>
      {"".join(badges_html)}
    </div>
    <nav class="lk-nav" aria-label="Abschnitte">{"".join(nav_links)}</nav>
    <div class="lk-bar-right">
      <span class="lk-prog">
        <span data-lk-progress></span>
        <span class="lk-prog-track"><i class="lk-prog-fill" data-lk-progress-fill></i></span>
      </span>
      <button type="button" class="lk-btn" data-lk-reset hidden>Zurücksetzen</button>
      {reload_btn}
      <button type="button" class="lk-btn primary" data-lk-print>Drucken</button>
    </div>
  </div>
</header>
<div class="sheet" id="uebersicht">
  <div class="ia-head">
    <div>
      <h1>Innenauftrag <span class="ia-no">{_esc(wo["no"])}</span></h1>
      <div class="ia-meta">{_esc(maker)}Zuschnitt · Sammellauf {_esc(wo.get("run_no", ""))}{f" · Station {_esc(station_label)}" if station_label else ""} · Stand {now_str} · Engine {_esc(wo.get("engine_version", ""))}</div>
      <div class="barcode">{barcode}</div>
    </div>
    <div class="qr-head">{qr_head}<div class="qr-cap">{_esc(qr_caption)}</div></div>
  </div>
  {rush_banner}
  <div class="kvs">
    {head_cell("Werkstoff", wo["mat_name"] or wo["mat"])}
    {head_cell("Dicke", f"{wo['thk']:g} mm")}
    {head_cell("Plattenformat", fmt_label)}
    {head_cell("Platten", wo["n_plates"])}
    {head_cell("Teile gesamt", rows_total)}
    {head_cell("Kundenaufträge", wo["n_orders"])}
    {head_cell("Ausnutzung", f"{wo.get('utilisation', 0) * 100:.0f} %")}
    {due_cell if due_str else head_cell("Station", station_label or "offen")}
  </div>
  <div class="note"><b>Jedes Teil trägt eine Marke.</b> Die Marke steht in der Zeichnung an der
    Stelle des Teils und in der Tabelle darunter{" mit Auftragsnummer und Kunde" if office else " mit Auftragsnummer"}. Teile nach dem
    Schnitt nach Marke ablegen — die Sammelplatte enthält Teile mehrerer Kundenaufträge. Grün = Restfläche (kein Material), blau = Platte.</div>
  <h2 class="section-title">Ablauf — Schritt für Schritt abhaken</h2>
  <ol class="steps">{steps_html}</ol>
  <div class="sub" style="margin-top:8px">Hinweis: Schutzfolie bei PTFE / Graphit erst nach dem Schnitt abziehen, Kanten entgraten falls gefordert. Plattenrest oberhalb der orangen Linie zurück ins Regal.</div>
</div>
{parts_block}
{"".join(f'<div class="sheet">{s}</div>' for s in plates_html_parts)}
{manual_block}
<!-- Prüfung & Freigabe — shop-floor clarity: was der Werker vor dem Verpacken noch prüft -->
<div class="sheet" id="pruefung">
  <h2>Prüfung &amp; Freigabe <span class="sub">vor dem Verpacken abhaken · Mängel = Teil neu planen, nicht drücken</span></h2>
  <div class="qc">
    <div class="qc-card">
      <h3>Sicht- &amp; Maßprüfung</h3>
      <ul class="qc-list">{qc_left_html}</ul>
    </div>
    <div class="qc-card">
      <h3>Vollständigkeit</h3>
      <ul class="qc-list">{qc_right_html}</ul>
    </div>
  </div>
  <div class="sig-grid">
    <div class="sig"><b>Maschine / Anlage</b><div class="sig-line"></div><div class="sub">{_esc(station_label) if station_label else "z. B. Schneidplotter 1 · Waterjet"}</div></div>
    <div class="sig"><b>Werker — Name &amp; Unterschrift</b><div class="sig-line"></div><div class="sub">Druckbuchstaben + Kurzeichen</div></div>
    <div class="sig"><b>Datum / Uhrzeit</b><div class="sig-line"></div><div class="sub">{now_str} · Schicht</div></div>
  </div>
  <div class="footer">
    <span>IA {_esc(wo["no"])} · {rows_total} Teile · {wo["n_plates"]} Platten · {fmt_label} · {wo["mat_name"] or wo["mat"]} {wo["thk"]:g} mm</span>
    <span class="mono">Engine {_esc(wo.get("engine_version", ""))} · {_esc(str(wo.get("nest_options", ""))[:80])} · {_esc(wo.get("release_reason", "") or "")} · Schnittfolge {_esc((wo.get("cut_plan") or {}).get("label", "—"))}</span>
  </div>
</div>
{order_overview}
{dxf_links}
{_laufkarte_script(inline_script)}
</body></html>"""
