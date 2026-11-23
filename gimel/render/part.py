"""Einzelteilzeichnung.

Die Plattenzeichnung sagt, *wo* ein Teil liegt. Diese hier sagt, *was* es ist:
Außenmaß, Bohrung, Lochbild, Dicke, Stückzahl und die Marken, unter denen es auf
der Platte zu finden ist. Der Auftragsbearbeiter braucht beides nebeneinander —
sonst muss er aus einer Tabelle zurückrechnen, was er vor sich hat.

Bewusst bemaßt und nicht nur hübsch: eine Zeichnung ohne Maß ist in der
Fertigung wertlos.
"""

from __future__ import annotations

import html
import math
from typing import Optional, Sequence

INK = "#201e1d"
MUTED = "#605d5d"
BLUE = "#0088b0"
GREEN = "#1d7a52"
DIM = "#9b9797"
BLUE_TINT = "#e9f8ff"
GREEN_TINT = "#e7f4ee"


def _esc(v) -> str:
    return html.escape(str(v if v is not None else ""), quote=True)


def _outline(shape: Optional[dict], od: float) -> tuple[str, float, float]:
    """Umriss plus Hüllmaß. Freie Konturen kommen aus ``shape``; ohne shape
    ist es ein Kreis mit Durchmesser ``od``."""
    outer = (shape or {}).get("outer") if isinstance(shape, dict) else None
    if outer:
        kind = outer.get("kind")
        if kind == "rect":
            w, h = float(outer.get("w", 0)), float(outer.get("h", 0))
            if w > 0 and h > 0:
                r = float(outer.get("r", 0))
                return (f'<rect x="{-w / 2:.2f}" y="{-h / 2:.2f}" width="{w:.2f}" '
                        f'height="{h:.2f}" rx="{r:.2f}"'), w, h
        if kind == "oval":
            w, h = float(outer.get("w", 0)), float(outer.get("h", 0))
            if w > 0 and h > 0:
                return f'<ellipse cx="0" cy="0" rx="{w / 2:.2f}" ry="{h / 2:.2f}"', w, h
        if kind == "poly" and outer.get("pts"):
            pts = outer["pts"]
            xs = [float(p[0]) for p in pts]
            ys = [float(p[1]) for p in pts]
            path = " ".join(f"{float(x):.2f},{float(y):.2f}" for x, y in pts)
            return f'<polygon points="{path}"', max(xs) - min(xs), max(ys) - min(ys)
    return f'<circle cx="0" cy="0" r="{od / 2:.2f}"', od, od


def _holes(shape: Optional[dict]) -> list[str]:
    """Aussparungen aus der freien Kontur — ohne sie fehlt dem Werker die halbe
    Information über das Teil."""
    out: list[str] = []
    for h in ((shape or {}).get("holes") or []) if isinstance(shape, dict) else []:
        x, y = float(h.get("x", 0)), float(h.get("y", 0))
        kind = h.get("kind")
        if kind == "circle" and h.get("d"):
            out.append(f'<circle cx="{x:.2f}" cy="{y:.2f}" r="{float(h["d"]) / 2:.2f}"')
        elif kind in ("rect", "slot") and h.get("w") and h.get("h"):
            w, hh = float(h["w"]), float(h["h"])
            r = (min(w, hh) / 2) if kind == "slot" else float(h.get("r", 0))
            out.append(f'<rect x="{x - w / 2:.2f}" y="{y - hh / 2:.2f}" width="{w:.2f}" '
                       f'height="{hh:.2f}" rx="{r:.2f}"')
        elif kind == "oval" and h.get("w") and h.get("h"):
            out.append(f'<ellipse cx="{x:.2f}" cy="{y:.2f}" rx="{float(h["w"]) / 2:.2f}" '
                       f'ry="{float(h["h"]) / 2:.2f}"')
    return out


def part_svg(*, od: float, di: float = 0.0, bolt_count: int = 0, bolt_d: float = 0.0,
             bolt_circle: float = 0.0, shape: Optional[dict] = None,
             label: str = "", tags: Sequence[str] = (), qty: int = 1,
             thk: float = 0.0, order_no: str = "", customer: str = "",
             width_px: int = 320) -> str:
    """Bemaßte Zeichnung eines einzelnen Teils."""
    outline, w, h = _outline(shape, od)
    span = max(w, h, od, 1.0)
    pad = span * 0.30 + 24
    vb = span + 2 * pad
    stroke = max(span / 220, 0.6)
    fs = span / 16
    height_px = int(width_px * (vb + span * 0.20) / vb)

    o: list[str] = []
    o.append(f'<svg xmlns="http://www.w3.org/2000/svg" '
             f'viewBox="{-vb / 2:.2f} {-vb / 2:.2f} {vb:.2f} {vb + span * 0.20:.2f}" '
             f'width="{width_px}" height="{height_px}" role="img" '
             f'aria-label="Teilzeichnung {_esc(label)}">')
    o.append('<rect x="-100%" y="-100%" width="300%" height="300%" fill="#ffffff"/>')

    # Mittellinien — machen Konzentrizität sofort erkennbar
    half = span / 2 + pad * 0.4
    o.append(f'<g stroke="{DIM}" stroke-width="{stroke * 0.7:.2f}" stroke-dasharray="'
             f'{span / 28:.2f} {span / 55:.2f} {span / 90:.2f} {span / 55:.2f}">'
             f'<line x1="{-half:.2f}" y1="0" x2="{half:.2f}" y2="0"/>'
             f'<line x1="0" y1="{-half:.2f}" x2="0" y2="{half:.2f}"/></g>')

    o.append(f'{outline} fill="{BLUE_TINT}" stroke="{BLUE}" stroke-width="{stroke * 2.2:.2f}"/>')

    holes = _holes(shape)
    if holes:
        for hp in holes:
            o.append(f'{hp} fill="#ffffff" stroke="{BLUE}" stroke-width="{stroke * 1.6:.2f}"/>')
    elif di > 0:
        o.append(f'<circle cx="0" cy="0" r="{di / 2:.2f}" fill="#ffffff" stroke="{BLUE}" '
                 f'stroke-width="{stroke * 2.2:.2f}"/>')

    # Lochbild
    if bolt_count > 0 and bolt_d > 0 and bolt_circle > 0:
        o.append(f'<circle cx="0" cy="0" r="{bolt_circle / 2:.2f}" fill="none" stroke="{DIM}" '
                 f'stroke-width="{stroke:.2f}" stroke-dasharray="{span / 30:.2f} {span / 50:.2f}"/>')
        for k in range(int(bolt_count)):
            a = math.tau * k / bolt_count + math.pi / bolt_count
            cx, cy = math.cos(a) * bolt_circle / 2, math.sin(a) * bolt_circle / 2
            o.append(f'<circle cx="{cx:.2f}" cy="{cy:.2f}" r="{bolt_d / 2:.2f}" fill="#ffffff" '
                     f'stroke="{BLUE}" stroke-width="{stroke * 1.4:.2f}"/>')

    # Bemaßung: Außenmaß unten, Bohrung darunter
    def dim_line(y: float, length: float, text: str) -> None:
        x0, x1 = -length / 2, length / 2
        t = stroke * 1.2
        o.append(f'<g stroke="{MUTED}" stroke-width="{t:.2f}" fill="none">'
                 f'<line x1="{x0:.2f}" y1="{y:.2f}" x2="{x1:.2f}" y2="{y:.2f}"/>'
                 f'<line x1="{x0:.2f}" y1="{y - fs * .35:.2f}" x2="{x0:.2f}" y2="{y + fs * .35:.2f}"/>'
                 f'<line x1="{x1:.2f}" y1="{y - fs * .35:.2f}" x2="{x1:.2f}" y2="{y + fs * .35:.2f}"/></g>')
        o.append(f'<text x="0" y="{y - fs * .5:.2f}" text-anchor="middle" fill="{MUTED}" '
                 f'font-family="ui-monospace,monospace" font-size="{fs:.2f}">{_esc(text)}</text>')

    dim_line(span / 2 + pad * 0.35, w if w else od, f"Ø {od:.1f}" if w == od else f"{w:.1f} × {h:.1f}")
    if di > 0 and not holes:
        dim_line(span / 2 + pad * 0.72, di, f"Ø {di:.1f}")

    # Kopfzeile im Bild — die Zeichnung wird einzeln ausgedruckt und muss
    # ohne den umgebenden Bildschirm auskommen.
    top = -vb / 2 + fs * 1.4
    o.append(f'<text x="{-vb / 2 + fs * .6:.2f}" y="{top:.2f}" fill="{INK}" '
             f'font-family="ui-sans-serif,system-ui,sans-serif" font-size="{fs * 1.1:.2f}" '
             f'font-weight="700">{_esc(label[:44])}</text>')
    meta = []
    if qty:
        meta.append(f"{qty} Stück")
    if thk:
        meta.append(f"{thk:g} mm")
    if bolt_count and bolt_d and bolt_circle:
        meta.append(f"{int(bolt_count)}× Ø{bolt_d:g} auf LK Ø{bolt_circle:g}")
    if meta:
        o.append(f'<text x="{-vb / 2 + fs * .6:.2f}" y="{top + fs * 1.25:.2f}" fill="{MUTED}" '
                 f'font-family="ui-sans-serif,system-ui,sans-serif" font-size="{fs * .9:.2f}">'
                 f'{_esc(" · ".join(meta))}</text>')
    if order_no or customer:
        o.append(f'<text x="{vb / 2 - fs * .6:.2f}" y="{top:.2f}" text-anchor="end" fill="{MUTED}" '
                 f'font-family="ui-monospace,monospace" font-size="{fs * .9:.2f}">'
                 f'{_esc(order_no)}</text>')
        o.append(f'<text x="{vb / 2 - fs * .6:.2f}" y="{top + fs * 1.25:.2f}" text-anchor="end" '
                 f'fill="{MUTED}" font-family="ui-sans-serif,system-ui,sans-serif" '
                 f'font-size="{fs * .85:.2f}">{_esc(customer[:34])}</text>')

    # Marken: unter welchen Kennungen das Teil auf der Platte liegt
    if tags:
        shown = ", ".join(tags[:14]) + (" …" if len(tags) > 14 else "")
        o.append(f'<text x="0" y="{vb / 2 + span * 0.11:.2f}" text-anchor="middle" fill="{GREEN}" '
                 f'font-family="ui-monospace,monospace" font-size="{fs * .95:.2f}" '
                 f'font-weight="700">{_esc(shown)}</text>')

    o.append("</svg>")
    return "".join(o)
