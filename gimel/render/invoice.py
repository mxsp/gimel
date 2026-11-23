"""Die lokale Rechnung als druckbare Seite, immer aus dem Stand beim Ausstellen.

Ein PDF-Renderer gehört nicht zu den Abhängigkeiten; die Seite ist für den
Browserdruck gesetzt und trägt jede Pflichtangabe des § 14 UStG. Kein Skript:
die CSP lässt keins zu.
"""

from __future__ import annotations

from html import escape

from ..models import LocalInvoice


def _eur(cents: int) -> str:
    text = f"{cents / 100:,.2f}".replace(",", " ").replace(".", ",").replace(" ", ".")
    return f"{text} €"


def _date(value) -> str:
    return value.strftime("%d.%m.%Y") if value else "—"


def _party(p: dict) -> str:
    return "<br>".join(escape(str(v)) for v in (
        p.get("legalName") or p.get("name"), p.get("street"),
        f"{p.get('zip', '')} {p.get('city', '')}".strip(), p.get("country")) if v)


def invoice_html(row: LocalInvoice) -> str:
    d = row.data
    s, b = d["seller"], d["buyer"]
    storno = row.kind == "storno"
    sign = -1 if storno else 1
    title = "Stornorechnung" if storno else "Rechnung"
    lines = "".join(
        f'<tr><td>{i}</td><td>{escape(l["description"])}</td>'
        f'<td class="n">{_eur(sign * l["amount_cents"])}</td></tr>'
        for i, l in enumerate(d["lines"], 1))
    facts = [("Rechnungsnummer", row.number), ("Rechnungsdatum", _date(row.issue_date)),
             ("Lieferdatum", _date(row.delivery_date)), ("Auftrag", row.order_no)]
    if d.get("buyer_reference"):
        facts.append(("Ihre Bestell-Nr.", d["buyer_reference"]))
    if storno:
        facts.insert(1, ("Storno zu Rechnung", row.refers_to))
    rate = f'{float(d["rate"]) * 100:g}'.replace(".", ",")
    prepaid = int(d.get("prepaid") or 0)
    totals = [("Summe netto", sign * row.net_cents), (f"Umsatzsteuer {rate} %", sign * row.vat_cents),
              ("Summe brutto", sign * row.gross_cents)]
    if prepaid:
        totals += [("Bereits bezahlt", -prepaid), ("Zahlbetrag", row.gross_cents - prepaid)]
    if storno:
        pay = escape(d.get("note") or "")
    elif row.due_date:
        pay = f"Zahlbar bis {_date(row.due_date)} ohne Abzug."
    else:
        pay = "Der Betrag ist bereits bezahlt."
    ident = [f"Steuernummer {escape(s['taxNumber'])}" if s.get("taxNumber") else "",
             f"USt-IdNr. {escape(s['vatId'])}" if s.get("vatId") else "",
             f"Gesellschafter: {escape(s['partners'])}" if s.get("partners") else "",
             f"Geschäftsführung: {escape(s['managers'])}" if s.get("managers") else "",
             escape(s.get("register") or ""),
             " ".join(x for x in (escape(s.get("bank") or ""), f"IBAN {escape(s['iban'])}" if s.get("iban") else "",
                                  f"BIC {escape(s['bic'])}" if s.get("bic") else "") if x),
             escape(s.get("email") or ""), escape(s.get("website") or "")]
    return f"""<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title} {escape(row.number)}</title>
<style>
  @page {{ size: A4; margin: 18mm; }}
  body {{ font: 11pt/1.45 system-ui, sans-serif; color: #1a1a1a; max-width: 180mm; margin: 0 auto; padding: 16px; }}
  h1 {{ font-size: 18pt; margin: 28px 0 12px; }}
  table {{ border-collapse: collapse; width: 100%; }}
  th, td {{ text-align: left; padding: 5px 6px; border-bottom: 1px solid #ccc; vertical-align: top; }}
  .n {{ text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }}
  .head {{ display: flex; justify-content: space-between; gap: 24px; flex-wrap: wrap; }}
  .facts {{ margin: 14px 0; }} .facts td {{ border: 0; padding: 1px 12px 1px 0; }}
  .totals {{ width: 60%; margin: 12px 0 0 auto; }} .totals tr:last-child td {{ font-weight: 700; }}
  footer {{ margin-top: 28px; font-size: 9pt; color: #444; border-top: 1px solid #999; padding-top: 6px; }}
</style></head><body>
<div class="head"><div>{_party(b)}</div><div>{_party(s)}</div></div>
<h1>{title} {escape(row.number)}</h1>
<table class="facts">{"".join(f"<tr><td>{escape(k)}</td><td>{escape(str(v))}</td></tr>" for k, v in facts)}</table>
<table><thead><tr><th>Pos.</th><th>Menge und Bezeichnung</th><th class="n">Betrag netto</th></tr></thead>
<tbody>{lines}</tbody></table>
<table class="totals">{"".join(f'<tr><td>{escape(k)}</td><td class="n">{_eur(v)}</td></tr>' for k, v in totals)}</table>
<p>{pay}</p>
<footer>{" · ".join(p for p in ident if p)}<br>
Elektronische Rechnung: maßgeblich ist die XML-Datei zu dieser Nummer, diese Seite ist ihre Ansicht.</footer>
</body></html>"""
