"""Versandmarke (Packing List) als HTML.

Sortiert nach Auftragsnummer, nicht nach Innenauftrag — die Auftragsnummer
bleibt stabil, auch wenn Innenaufträge abgebrochen und neu vergeben werden.
"""

from __future__ import annotations

from datetime import datetime, timezone
from html import escape

from ..services import identity


def shipment_label(shipment) -> str:
    """Erzeugt eine druckbare Versandmarke als HTML-String."""
    s = shipment
    ship_to = s.ship_to or {}
    now = datetime.now(timezone.utc).strftime("%d.%m.%Y %H:%M")
    brand = identity.texts()
    mark = f'<span class="mark">{escape(brand.brand_mark)}</span> ' if brand.brand_mark else ""

    # Gruppiere Items nach Auftragsnummer
    groups: dict[str, list] = {}
    for it in (s.items or []):
        groups.setdefault(it.order_no, []).append(it)

    order_rows = ""
    for order_no in sorted(groups.keys()):
        items = groups[order_no]
        first = True
        for it in items:
            n = f"{it.qty}×" if it.qty > 1 else ""
            order_rows += f"""
            <tr>
              {"<td rowspan=\"" + str(len(items)) + "\" class=\"order-cell\"><b>{order_no}</b></td>".format(order_no=escape(order_no)) if first else ""}
              <td class="mono">{escape(it.tag)}</td>
              <td>{escape(it.label)}</td>
              <td>{escape(it.mat)}</td>
              <td class="num">{it.thk:g} mm</td>
              <td class="num">{n or '—'}</td>
              <td class="sub">{escape(it.work_order_no)}</td>
            </tr>"""
            first = False

    total_qty = sum(it.qty for it in (s.items or []))

    return f"""<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<title>Versandmarke {escape(s.no)}</title>
<style>
  @page {{ margin: 15mm; size: A4; }}
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  body {{ font-family: "Source Serif 4", Georgia, serif; color: #201e1d;
         font-size: 11pt; line-height: 1.4; }}
  .header {{ display: flex; justify-content: space-between; align-items: flex-start;
             margin-bottom: 16pt; border-bottom: 3px double #201e1d; padding-bottom: 8pt; }}
  .brand {{ font-size: 16pt; font-weight: 700; }}
  .brand .mark {{ color: #0a5b9c; }}
  .meta {{ text-align: right; font-size: 9pt; color: #666; }}
  .meta .no {{ font-size: 14pt; font-weight: 700; color: #201e1d; }}
  .addr {{ display: flex; gap: 30pt; margin-bottom: 16pt; }}
  .addr-box {{ flex: 1; }}
  .addr-label {{ font-size: 8pt; text-transform: uppercase; letter-spacing: 0.05em;
                 color: #999; margin-bottom: 2pt; }}
  .addr-val {{ font-size: 11pt; }}
  .addr-val b {{ font-size: 12pt; }}
  table {{ width: 100%; border-collapse: collapse; margin-bottom: 12pt; font-size: 10pt; }}
  th {{ text-align: left; border-bottom: 2px solid #201e1d; padding: 4pt 6pt;
        font-size: 8pt; text-transform: uppercase; letter-spacing: 0.05em; color: #666; }}
  td {{ padding: 3pt 6pt; border-bottom: 1px solid #ddd; vertical-align: top; }}
  .num {{ text-align: right; font-variant-numeric: tabular-nums; }}
  .mono {{ font-family: "JetBrains Mono", "Fira Code", monospace; }}
  .sub {{ font-size: 8pt; color: #999; }}
  .order-cell {{ font-weight: 700; border-right: 2px solid #201e1d; padding-right: 8pt; }}
  .footer {{ margin-top: 20pt; border-top: 1px solid #ccc; padding-top: 8pt;
             display: flex; justify-content: space-between; font-size: 9pt; color: #666; }}
  .track {{ font-size: 10pt; }}
  .track b {{ color: #0a5b9c; }}
  @media print {{
    body {{ -webkit-print-color-adjust: exact; print-color-adjust: exact; }}
  }}
</style>
</head>
<body>
  <div class="header">
    <div class="brand">{mark}{escape(brand.brand_name)}</div>
    <div class="meta">
      <div class="no">{escape(s.no)}</div>
      <div>{now}</div>
    </div>
  </div>

  <div class="addr">
    <div class="addr-box">
      <div class="addr-label">Empfänger / Lieferadresse</div>
      <div class="addr-val">
        <b>{escape(ship_to.get("company", "") or "—")}</b><br>
        {escape(ship_to.get("street", ""))}<br>
        {escape(ship_to.get("zip", ""))} {escape(ship_to.get("city", ""))}<br>
        {escape(ship_to.get("country", "DE"))}
      </div>
    </div>
    <div class="addr-box">
      <div class="addr-label">Versand</div>
      <div class="addr-val track">
        {"Spedition: <b>" + escape(s.carrier) + "</b><br>" if s.carrier else ""}
        {"Tracking: <b>" + escape(s.tracking) + "</b><br>" if s.tracking else ""}
        {"Teile: <b>" + str(total_qty) + "</b><br>" if total_qty else ""}
        {"Aufträge: <b>" + str(len(groups)) + "</b>"}
      </div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>Auftrag</th>
        <th>Marke</th>
        <th>Teil</th>
        <th>Werkstoff</th>
        <th class="num">Dicke</th>
        <th class="num">Menge</th>
        <th>Innenauftrag</th>
      </tr>
    </thead>
    <tbody>
      {order_rows}
    </tbody>
  </table>

  {"<p style='font-size:9pt;color:#666'>Notiz: " + escape(s.note) + "</p>" if s.note else ""}

  <div class="footer">
    <div>Versandt: {escape(s.shipped_by or "—")}</div>
    <div>Packt: {escape(s.packed_by or "—")}</div>
  </div>
</body>
</html>"""
