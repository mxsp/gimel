"""Werkzeuge für Seiten-Vorschau, Artefakte, Dateien, Diagramme, Berichte und Analytik.

Artefakte (``agent_artifacts``) gehören ausschließlich zum eigenen Chat und
schreiben niemals in Gimel-Kerntabellen — sie stehen deshalb auch bei
ausgeschaltetem Schreibmodus bereit (analog zu ``propose_*``).
"""

from __future__ import annotations

import csv
import html
import io
import json
import math
import re
import statistics
from datetime import datetime, timedelta, timezone
from typing import Any

from gimel.models import (
    AuditLog,
    Order,
    Product,
    Shipment,
    ShipmentStatus,
    WorkOrder,
    WorkOrderStatus,
)

from . import settings as agent_settings
from .analysis_tools import _readonly
from .models import AgentActionProposal, AgentArtifact, AgentAttachment
from .tools import (
    ALL,
    OFFICE,
    ToolContext,
    ToolError,
    ToolSpec,
    _iso,
    _limit,
    _need,
    _office,
    _order_customer,
    _schema,
)

VALID_KINDS = ("html", "svg", "markdown", "csv", "json", "code", "text")
KIND_EXT = {
    "html": ".html",
    "svg": ".svg",
    "markdown": ".md",
    "csv": ".csv",
    "json": ".json",
    "code": ".txt",
    "text": ".txt",
}
MAX_ARTIFACT_CHARS = 400_000


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _slug(text: str, fallback: str = "artefakt") -> str:
    cleaned = re.sub(r"[^a-z0-9äöüß]+", "-", (text or "").lower()).strip("-")
    return (cleaned[:60] or fallback)


def _default_filename(title: str, kind: str, language: str = "") -> str:
    ext = KIND_EXT.get(kind, ".txt")
    if kind == "code" and language:
        lang_ext = {
            "python": ".py", "py": ".py", "javascript": ".js", "js": ".js",
            "typescript": ".ts", "ts": ".ts", "tsx": ".tsx", "jsx": ".jsx",
            "css": ".css", "sql": ".sql", "yaml": ".yaml", "yml": ".yml",
            "xml": ".xml", "bash": ".sh", "sh": ".sh", "html": ".html",
        }.get(language.lower().strip())
        if lang_ext:
            ext = lang_ext
    return f"{_slug(title)}{ext}"


def artifact_out(row: AgentArtifact, *, include_content: bool = True) -> dict:
    data: dict[str, Any] = {
        "id": row.id,
        "chat_id": row.chat_id,
        "message_id": row.message_id,
        "title": row.title,
        "kind": row.kind,
        "filename": row.filename or _default_filename(row.title, row.kind, row.language),
        "language": row.language or "",
        "version": row.version,
        "chars": len(row.content or ""),
        "created_at": _iso(row.created_at),
        "updated_at": _iso(row.updated_at),
    }
    if include_content:
        data["content"] = row.content or ""
    return data


def _preview_action_for_artifact(row: AgentArtifact) -> dict:
    return {
        "type": "open_preview",
        "source": "artifact",
        "artifact_id": row.id,
        "title": row.title,
        "kind": row.kind,
        "filename": row.filename or _default_filename(row.title, row.kind, row.language),
        "language": row.language or "",
        "version": row.version,
        "content": row.content or "",
    }


# ==========================================================================
# 1. Artefakte & Seiten-Vorschau
# ==========================================================================
def create_artifact(ctx: ToolContext, args: dict) -> dict:
    title = str(_need(args, "title")).strip()[:200]
    content = str(_need(args, "content"))
    if len(content) > MAX_ARTIFACT_CHARS:
        raise ToolError(f"Artefakt ist zu groß (höchstens {MAX_ARTIFACT_CHARS:,} Zeichen).")
    kind = str(args.get("kind") or "html").strip().lower()
    if kind not in VALID_KINDS:
        raise ToolError(f"Unbekannter Artefakt-Typ „{kind}“. Erlaubt: {', '.join(VALID_KINDS)}.")
    language = str(args.get("language") or (kind if kind in ("html", "svg", "markdown", "csv", "json") else "")).strip()[:40]
    filename = str(args.get("filename") or "").strip()[:240] or _default_filename(title, kind, language)
    open_now = bool(args.get("open_preview", True))

    row = AgentArtifact(
        chat_id=ctx.chat.id,
        user_id=ctx.user.id,
        message_id=ctx.message_id,
        title=title,
        kind=kind,
        filename=filename,
        language=language,
        content=content,
        version=1,
    )
    ctx.db.add(row)
    ctx.db.flush()
    out: dict[str, Any] = {
        "summary": f"Artefakt „{row.title}“ ({kind.upper()}, {len(content):,} Zeichen) erstellt.",
        "data": {"artifact": artifact_out(row, include_content=False)},
    }
    if open_now:
        out["client_action"] = _preview_action_for_artifact(row)
    return out


def update_artifact(ctx: ToolContext, args: dict) -> dict:
    artifact_id = args.get("artifact_id")
    title_match = str(args.get("title") or "").strip()
    row: AgentArtifact | None = None
    if artifact_id is not None:
        row = ctx.db.get(AgentArtifact, int(artifact_id))
        if row is None or row.chat_id != ctx.chat.id:
            raise ToolError(f"Artefakt #{artifact_id} in diesem Chat nicht gefunden.")
    elif title_match:
        row = (
            ctx.db.query(AgentArtifact)
            .filter(AgentArtifact.chat_id == ctx.chat.id, AgentArtifact.title == title_match)
            .order_by(AgentArtifact.id.desc())
            .first()
        )
        if row is None:
            raise ToolError(f"Artefakt „{title_match}“ in diesem Chat nicht gefunden.")
    else:
        row = (
            ctx.db.query(AgentArtifact)
            .filter(AgentArtifact.chat_id == ctx.chat.id)
            .order_by(AgentArtifact.updated_at.desc(), AgentArtifact.id.desc())
            .first()
        )
        if row is None:
            raise ToolError("In diesem Chat existiert noch kein Artefakt zum Aktualisieren.")

    new_content = args.get("content")
    find_str = args.get("find")
    replace_str = args.get("replace")
    if new_content is not None:
        updated = str(new_content)
    elif find_str is not None and replace_str is not None:
        current = row.content or ""
        needle = str(find_str)
        if needle not in current:
            raise ToolError("Der gesuchte Textabschnitt wurde im Artefakt nicht gefunden.")
        updated = current.replace(needle, str(replace_str), 1)
    else:
        raise ToolError("Bitte entweder „content“ oder „find“ + „replace“ angeben.")

    if len(updated) > MAX_ARTIFACT_CHARS:
        raise ToolError(f"Artefakt ist zu groß (höchstens {MAX_ARTIFACT_CHARS:,} Zeichen).")

    row.content = updated
    if args.get("new_title"):
        row.title = str(args["new_title"]).strip()[:200] or row.title
    if args.get("kind") and str(args["kind"]).strip().lower() in VALID_KINDS:
        row.kind = str(args["kind"]).strip().lower()
    row.version = (row.version or 1) + 1
    row.updated_at = _now()
    ctx.db.flush()

    out: dict[str, Any] = {
        "summary": f"Artefakt „{row.title}“ aktualisiert (Version {row.version}).",
        "data": {"artifact": artifact_out(row, include_content=False)},
    }
    if bool(args.get("open_preview", True)):
        out["client_action"] = _preview_action_for_artifact(row)
    return out


def list_artifacts(ctx: ToolContext, args: dict) -> dict:
    rows = (
        ctx.db.query(AgentArtifact)
        .filter(AgentArtifact.chat_id == ctx.chat.id)
        .order_by(AgentArtifact.updated_at.desc(), AgentArtifact.id.desc())
        .limit(_limit(args.get("limit"), 30, 100))
        .all()
    )
    return {
        "summary": f"{len(rows)} Artefakt(e) in diesem Chat.",
        "data": {"artifacts": [artifact_out(r, include_content=False) for r in rows]},
    }


def get_artifact(ctx: ToolContext, args: dict) -> dict:
    aid = int(_need(args, "artifact_id"))
    row = ctx.db.get(AgentArtifact, aid)
    if row is None or row.chat_id != ctx.chat.id:
        raise ToolError(f"Artefakt #{aid} in diesem Chat nicht gefunden.")
    max_chars = max(500, min(int(args.get("max_chars") or 60_000), MAX_ARTIFACT_CHARS))
    content = row.content or ""
    truncated = len(content) > max_chars
    data = artifact_out(row, include_content=False)
    data["content"] = content[:max_chars] + ("\n… (gekürzt)" if truncated else "")
    data["truncated"] = truncated
    return {"summary": f"Artefakt „{row.title}“ (v{row.version}, {len(content):,} Zeichen).", "data": data}


def open_preview(ctx: ToolContext, args: dict) -> dict:
    artifact_id = args.get("artifact_id")
    attachment_id = args.get("attachment_id")
    url = str(args.get("url") or "").strip()
    title = str(args.get("title") or "").strip()[:200]

    if artifact_id is not None:
        row = ctx.db.get(AgentArtifact, int(artifact_id))
        if row is None or row.chat_id != ctx.chat.id:
            raise ToolError(f"Artefakt #{artifact_id} nicht gefunden.")
        return {
            "summary": f"Vorschau für Artefakt „{row.title}“ geöffnet.",
            "data": {"source": "artifact", "artifact_id": row.id},
            "client_action": _preview_action_for_artifact(row),
        }

    if attachment_id is not None:
        att = ctx.db.get(AgentAttachment, int(attachment_id))
        if att is None or att.chat_id != ctx.chat.id:
            raise ToolError(f"Anhang #{attachment_id} nicht gefunden.")
        return {
            "summary": f"Datei „{att.filename}“ in der Vorschau geöffnet.",
            "data": {"source": "attachment", "attachment_id": att.id, "filename": att.filename},
            "client_action": {
                "type": "open_preview",
                "source": "attachment",
                "attachment_id": att.id,
                "title": title or att.filename,
                "filename": att.filename,
                "content_type": att.content_type,
            },
        }

    if url:
        if not (url.startswith("https://") or url.startswith("http://") or url.startswith("/")):
            raise ToolError("Nur http://, https:// oder relative Gimel-Pfade (z. B. /app, /twin) sind erlaubt.")
        return {
            "summary": f"Vorschau-Browser geöffnet: {url}",
            "data": {"source": "url", "url": url},
            "client_action": {
                "type": "open_preview",
                "source": "url",
                "url": url,
                "title": title or url,
            },
        }

    raise ToolError("Bitte entweder „artifact_id“, „attachment_id“ oder „url“ angeben.")


# ==========================================================================
# 2. Anhänge gezielt lesen & durchsuchen
# ==========================================================================
def read_attachment(ctx: ToolContext, args: dict) -> dict:
    att_id = args.get("attachment_id")
    filename = str(args.get("filename") or "").strip().lower()
    row: AgentAttachment | None = None
    if att_id is not None:
        row = ctx.db.get(AgentAttachment, int(att_id))
        if row is None or row.chat_id != ctx.chat.id:
            raise ToolError(f"Anhang #{att_id} in diesem Chat nicht gefunden.")
    elif filename:
        rows = (
            ctx.db.query(AgentAttachment)
            .filter(AgentAttachment.chat_id == ctx.chat.id)
            .order_by(AgentAttachment.id.desc())
            .all()
        )
        row = next((r for r in rows if filename in (r.filename or "").lower()), None)
        if row is None:
            raise ToolError(f"Kein Anhang mit „{filename}“ im Namen gefunden.")
    else:
        rows = (
            ctx.db.query(AgentAttachment)
            .filter(AgentAttachment.chat_id == ctx.chat.id)
            .order_by(AgentAttachment.id.desc())
            .all()
        )
        return {
            "summary": f"{len(rows)} Anhang/Anhänge in diesem Chat.",
            "data": {
                "attachments": [
                    {"id": r.id, "filename": r.filename, "content_type": r.content_type,
                     "chars": r.chars, "pages": r.pages}
                    for r in rows
                ]
            },
        }

    text = row.text or ""
    page = args.get("page")
    if page is not None:
        page_num = int(page)
        marker = f"[Seite {page_num}]"
        idx = text.find(marker)
        if idx == -1:
            raise ToolError(f"Seite {page_num} ist in „{row.filename}“ nicht markiert.")
        next_idx = text.find("[Seite ", idx + len(marker))
        chunk = text[idx:next_idx] if next_idx != -1 else text[idx:]
        return {
            "summary": f"„{row.filename}“ Seite {page_num} ({len(chunk)} Zeichen).",
            "data": {"attachment_id": row.id, "filename": row.filename, "page": page_num,
                     "text": chunk[:40_000]},
        }

    start = max(0, int(args.get("start_char") or 0))
    max_chars = max(500, min(int(args.get("max_chars") or 12_000), 40_000))
    chunk = text[start:start + max_chars]
    return {
        "summary": f"„{row.filename}“ Zeichen {start}–{start + len(chunk)} von {len(text)}.",
        "data": {
            "attachment_id": row.id,
            "filename": row.filename,
            "total_chars": len(text),
            "start_char": start,
            "end_char": start + len(chunk),
            "has_more": start + len(chunk) < len(text),
            "text": chunk,
        },
    }


def search_attachments(ctx: ToolContext, args: dict) -> dict:
    query = str(_need(args, "query")).strip()
    att_id = args.get("attachment_id")
    limit = _limit(args.get("limit"), 20, 60)
    q = ctx.db.query(AgentAttachment).filter(AgentAttachment.chat_id == ctx.chat.id)
    if att_id is not None:
        q = q.filter(AgentAttachment.id == int(att_id))
    rows = q.order_by(AgentAttachment.id.desc()).all()
    if not rows:
        return {"summary": "Keine Anhänge in diesem Chat.", "data": {"matches": []}}

    pattern = re.compile(re.escape(query), re.IGNORECASE)
    matches: list[dict] = []
    for row in rows:
        lines = (row.text or "").splitlines()
        for idx, line in enumerate(lines, start=1):
            if pattern.search(line):
                ctx_before = lines[idx - 2].strip()[:140] if idx >= 2 else ""
                ctx_after = lines[idx].strip()[:140] if idx < len(lines) else ""
                matches.append({
                    "attachment_id": row.id,
                    "filename": row.filename,
                    "line": idx,
                    "text": line.strip()[:300],
                    "before": ctx_before,
                    "after": ctx_after,
                })
                if len(matches) >= limit:
                    break
        if len(matches) >= limit:
            break
    return {
        "summary": f"{len(matches)} Treffer für „{query}“ in {len(rows)} Anhang/Anhängen.",
        "data": {"query": query, "matches": matches},
    }


# ==========================================================================
# 3. Interaktive HTML-Charts & Druckberichte (100% offline-fähig)
# ==========================================================================
_PALETTE = ["#0b7a67", "#b65f45", "#1668ac", "#ca9c19", "#6f42c1", "#2f855a", "#c44a34", "#3182ce"]


def _esc(val: Any) -> str:
    return html.escape(str(val if val is not None else ""))


def _build_chart_html(
    title: str,
    subtitle: str,
    chart_type: str,
    labels: list[str],
    series: list[dict],
    unit: str,
    kpis: list[dict],
    notes: str,
) -> str:
    payload = json.dumps(
        {
            "title": title,
            "subtitle": subtitle,
            "chart_type": chart_type,
            "labels": labels,
            "series": series,
            "unit": unit,
            "palette": _PALETTE,
        },
        ensure_ascii=False,
    ).replace("</", "<\\/")

    kpi_html = ""
    if kpis:
        cards = []
        for item in kpis[:8]:
            tone = str(item.get("tone") or "").strip().lower()
            tone_cls = f" tone-{_esc(tone)}" if tone in ("good", "warn", "bad") else ""
            cards.append(
                f'<div class="kpi{tone_cls}">'
                f'<div class="kpi-label">{_esc(item.get("label", ""))}</div>'
                f'<div class="kpi-val">{_esc(item.get("value", ""))}</div>'
                + (f'<div class="kpi-sub">{_esc(item.get("hint", ""))}</div>' if item.get("hint") else "")
                + "</div>"
            )
        kpi_html = f'<section class="kpis">{"".join(cards)}</section>'

    notes_html = f'<footer class="notes">{_esc(notes)}</footer>' if notes else ""

    return f"""<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>{_esc(title)}</title>
<style>
  :root {{
    --bg: #fbfaf7; --card: #ffffff; --ink: #25221c; --muted: #6c665b;
    --line: #e5e1d7; --accent: #0b7a67; --clay: #b65f45; --soft: #f3f1eb;
    --good: #1f7a4c; --warn: #a66c00; --bad: #b4463f;
  }}
  [data-theme="dark"] {{
    --bg: #1b1a17; --card: #25241f; --ink: #f2efe7; --muted: #aba498;
    --line: #3a3832; --accent: #4fd1b8; --clay: #d68a6d; --soft: #2d2b25;
  }}
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--ink); padding: 20px; }}
  .wrap {{ max-width: 1020px; margin: 0 auto; display: grid; gap: 16px; }}
  header {{ display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }}
  h1 {{ margin: 0; font-size: 20px; letter-spacing: -0.02em; }}
  .sub {{ margin: 3px 0 0; color: var(--muted); font-size: 13px; }}
  .controls {{ display: flex; gap: 6px; flex-wrap: wrap; }}
  button {{ border: 1px solid var(--line); background: var(--card); color: var(--ink); border-radius: 8px; padding: 5px 10px; font: 12px inherit; cursor: pointer; }}
  button:hover {{ border-color: var(--accent); color: var(--accent); }}
  button.active {{ background: var(--accent); border-color: var(--accent); color: #fff; }}
  .kpis {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }}
  .kpi {{ background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; }}
  .kpi-label {{ font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }}
  .kpi-val {{ font-size: 22px; font-weight: 700; margin-top: 4px; font-variant-numeric: tabular-nums; }}
  .kpi-sub {{ font-size: 11.5px; color: var(--muted); margin-top: 2px; }}
  .kpi.tone-good .kpi-val {{ color: var(--good); }}
  .kpi.tone-warn .kpi-val {{ color: var(--warn); }}
  .kpi.tone-bad .kpi-val {{ color: var(--bad); }}
  .panel {{ background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 16px; position: relative; }}
  .legend {{ display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 10px; font-size: 12px; color: var(--muted); }}
  .legend span {{ display: inline-flex; align-items: center; gap: 6px; }}
  .swatch {{ width: 10px; height: 10px; border-radius: 3px; display: inline-block; }}
  #chart-stage {{ width: 100%; overflow-x: auto; }}
  svg {{ display: block; width: 100%; height: auto; }}
  .tooltip {{ position: fixed; pointer-events: none; background: var(--ink); color: var(--bg); padding: 6px 10px; border-radius: 8px; font-size: 12px; box-shadow: 0 6px 20px rgb(0 0 0 / 0.25); opacity: 0; transition: opacity 0.1s; z-index: 20; }}
  table {{ width: 100%; border-collapse: collapse; font-size: 12.5px; font-variant-numeric: tabular-nums; }}
  th, td {{ padding: 8px 10px; border-bottom: 1px solid var(--line); text-align: right; }}
  th:first-child, td:first-child {{ text-align: left; }}
  th {{ background: var(--soft); color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }}
  .notes {{ font-size: 12px; color: var(--muted); padding: 4px 2px; }}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>{_esc(title)}</h1>
      {f'<p class="sub">{_esc(subtitle)}</p>' if subtitle else ''}
    </div>
    <div class="controls">
      <button type="button" data-mode="bar">Balken</button>
      <button type="button" data-mode="line">Linie</button>
      <button type="button" data-mode="donut">Donut</button>
      <button type="button" data-mode="table">Tabelle</button>
      <button type="button" id="btn-csv">CSV</button>
      <button type="button" id="btn-theme">Hell/Dunkel</button>
    </div>
  </header>
  {kpi_html}
  <section class="panel">
    <div class="legend" id="legend"></div>
    <div id="chart-stage"></div>
  </section>
  {notes_html}
</div>
<div class="tooltip" id="tip"></div>
<script>
const DATA = {payload};
let mode = DATA.chart_type || "bar";
const stage = document.getElementById("chart-stage");
const legend = document.getElementById("legend");
const tip = document.getElementById("tip");
const fmt = (v) => (typeof v === "number" ? v.toLocaleString("de-DE", {{ maximumFractionDigits: 2 }}) : String(v)) + (DATA.unit ? " " + DATA.unit : "");

function showTip(e, html) {{
  tip.innerHTML = html;
  tip.style.left = Math.min(window.innerWidth - 180, e.clientX + 12) + "px";
  tip.style.top = Math.max(8, e.clientY - 34) + "px";
  tip.style.opacity = "1";
}}
function hideTip() {{ tip.style.opacity = "0"; }}

function renderLegend() {{
  legend.innerHTML = DATA.series.map((s, i) => {{
    const col = s.color || DATA.palette[i % DATA.palette.length];
    return `<span><i class="swatch" style="background:${{col}}"></i>${{s.name || "Serie " + (i + 1)}}</span>`;
  }}).join("");
}}

function renderBarOrLine(asLine) {{
  const W = Math.max(640, DATA.labels.length * 64), H = 310;
  const pad = {{ t: 18, r: 20, b: 56, l: 64 }};
  const cw = W - pad.l - pad.r, ch = H - pad.t - pad.b;
  const vals = DATA.series.flatMap(s => s.values.map(Number).filter(Number.isFinite));
  const maxV = Math.max(1, ...vals, 0);
  const ticks = 4;
  let svg = `<svg viewBox="0 0 ${{W}} ${{H}}">`;
  for (let i = 0; i <= ticks; i++) {{
    const v = (maxV / ticks) * i;
    const y = pad.t + ch - (v / maxV) * ch;
    svg += `<line x1="${{pad.l}}" x2="${{W - pad.r}}" y1="${{y}}" y2="${{y}}" stroke="var(--line)" stroke-dasharray="${{i ? '3 3' : ''}}" />`;
    svg += `<text x="${{pad.l - 8}}" y="${{y + 4}}" text-anchor="end" fill="var(--muted)" font-size="11">${{v.toLocaleString("de-DE", {{ maximumFractionDigits: 1 }})}}</text>`;
  }}
  const n = Math.max(1, DATA.labels.length);
  const step = cw / n;
  DATA.labels.forEach((lbl, idx) => {{
    const x = pad.l + idx * step + step / 2;
    const short = lbl.length > 14 ? lbl.slice(0, 13) + "…" : lbl;
    svg += `<text x="${{x}}" y="${{H - 18}}" text-anchor="middle" fill="var(--muted)" font-size="11">${{short}}</text>`;
  }});
  if (!asLine) {{
    const sn = Math.max(1, DATA.series.length);
    const groupW = Math.min(step * 0.72, 80);
    const barW = Math.max(6, groupW / sn - 3);
    DATA.series.forEach((s, si) => {{
      const col = s.color || DATA.palette[si % DATA.palette.length];
      s.values.forEach((raw, idx) => {{
        const v = Number(raw) || 0;
        const h = Math.max(1, (v / maxV) * ch);
        const x = pad.l + idx * step + (step - groupW) / 2 + si * (barW + 3);
        const y = pad.t + ch - h;
        svg += `<rect x="${{x}}" y="${{y}}" width="${{barW}}" height="${{h}}" rx="4" fill="${{col}}" data-lbl="${{DATA.labels[idx]}}" data-ser="${{s.name}}" data-val="${{v}}" style="cursor:pointer" />`;
      }});
    }});
  }} else {{
    DATA.series.forEach((s, si) => {{
      const col = s.color || DATA.palette[si % DATA.palette.length];
      const pts = s.values.map((raw, idx) => {{
        const v = Number(raw) || 0;
        const x = pad.l + idx * step + step / 2;
        const y = pad.t + ch - (v / maxV) * ch;
        return [x, y, v, idx];
      }});
      const path = pts.map((p, i) => (i ? "L" : "M") + p[0] + " " + p[1]).join(" ");
      if (mode === "area" && pts.length) {{
        const area = path + ` L${{pts[pts.length - 1][0]}} ${{pad.t + ch}} L${{pts[0][0]}} ${{pad.t + ch}} Z`;
        svg += `<path d="${{area}}" fill="${{col}}" fill-opacity="0.14" />`;
      }}
      svg += `<path d="${{path}}" fill="none" stroke="${{col}}" stroke-width="2.5" stroke-linejoin="round" />`;
      pts.forEach(([x, y, v, idx]) => {{
        svg += `<circle cx="${{x}}" cy="${{y}}" r="4.5" fill="${{col}}" stroke="var(--card)" stroke-width="2" data-lbl="${{DATA.labels[idx]}}" data-ser="${{s.name}}" data-val="${{v}}" style="cursor:pointer" />`;
      }});
    }});
  }}
  svg += `</svg>`;
  stage.innerHTML = svg;
  stage.querySelectorAll("[data-val]").forEach(el => {{
    el.addEventListener("mousemove", e => showTip(e, `<strong>${{el.dataset.lbl}}</strong><br/>${{el.dataset.ser}}: ${{fmt(Number(el.dataset.val))}}`));
    el.addEventListener("mouseleave", hideTip);
  }});
}}

function renderDonut() {{
  const s = DATA.series[0] || {{ name: "", values: [] }};
  const total = s.values.reduce((a, b) => a + Math.max(0, Number(b) || 0), 0) || 1;
  const cx = 180, cy = 155, R = 115, r = mode === "pie" ? 0 : 64;
  let angle = -Math.PI / 2;
  let slices = "";
  let list = "";
  DATA.labels.forEach((lbl, i) => {{
    const v = Math.max(0, Number(s.values[i]) || 0);
    const frac = v / total;
    const sweep = frac * Math.PI * 2;
    const col = DATA.palette[i % DATA.palette.length];
    const x1 = cx + R * Math.cos(angle), y1 = cy + R * Math.sin(angle);
    const x2 = cx + R * Math.cos(angle + sweep), y2 = cy + R * Math.sin(angle + sweep);
    const large = sweep > Math.PI ? 1 : 0;
    let d;
    if (r > 0) {{
      const ix1 = cx + r * Math.cos(angle + sweep), iy1 = cy + r * Math.sin(angle + sweep);
      const ix2 = cx + r * Math.cos(angle), iy2 = cy + r * Math.sin(angle);
      d = `M${{x1}} ${{y1}} A${{R}} ${{R}} 0 ${{large}} 1 ${{x2}} ${{y2}} L${{ix1}} ${{iy1}} A${{r}} ${{r}} 0 ${{large}} 0 ${{ix2}} ${{iy2}} Z`;
    }} else {{
      d = `M${{cx}} ${{cy}} L${{x1}} ${{y1}} A${{R}} ${{R}} 0 ${{large}} 1 ${{x2}} ${{y2}} Z`;
    }}
    if (frac >= 0.9999) {{
      slices += `<circle cx="${{cx}}" cy="${{cy}}" r="${{R}}" fill="${{col}}" data-lbl="${{lbl}}" data-val="${{v}}" />`;
      if (r > 0) slices += `<circle cx="${{cx}}" cy="${{cy}}" r="${{r}}" fill="var(--card)" />`;
    }} else if (v > 0) {{
      slices += `<path d="${{d}}" fill="${{col}}" stroke="var(--card)" stroke-width="2" data-lbl="${{lbl}}" data-val="${{v}}" style="cursor:pointer" />`;
    }}
    list += `<div style="display:flex;justify-content:space-between;gap:12px;padding:4px 0;border-bottom:1px solid var(--line);font-size:12.5px"><span><i class="swatch" style="background:${{col}};margin-right:6px"></i>${{lbl}}</span><strong>${{fmt(v)}} (${{(frac*100).toFixed(1)}}%)</strong></div>`;
    angle += sweep;
  }});
  stage.innerHTML = `<div style="display:grid;grid-template-columns:minmax(260px,360px) 1fr;gap:18px;align-items:center"><svg viewBox="0 0 360 310">${{slices}}<text x="${{cx}}" y="${{cy - 4}}" text-anchor="middle" fill="var(--muted)" font-size="11">Gesamt</text><text x="${{cx}}" y="${{cy + 16}}" text-anchor="middle" fill="var(--ink)" font-weight="700" font-size="15">${{fmt(total)}}</text></svg><div>${{list}}</div></div>`;
  stage.querySelectorAll("[data-val]").forEach(el => {{
    el.addEventListener("mousemove", e => showTip(e, `<strong>${{el.dataset.lbl}}</strong>: ${{fmt(Number(el.dataset.val))}}`));
    el.addEventListener("mouseleave", hideTip);
  }});
}}

function renderTable() {{
  const head = `<tr><th>Kategorie</th>${{DATA.series.map(s => `<th>${{s.name}}</th>`).join("")}}</tr>`;
  const rows = DATA.labels.map((lbl, idx) =>
    `<tr><td>${{lbl}}</td>${{DATA.series.map(s => `<td>${{fmt(Number(s.values[idx]) || 0)}}</td>`).join("")}}</tr>`
  ).join("");
  stage.innerHTML = `<table><thead>${{head}}</thead><tbody>${{rows}}</tbody></table>`;
}}

function render() {{
  document.querySelectorAll("[data-mode]").forEach(b => b.classList.toggle("active", b.dataset.mode === (mode === "area" ? "line" : mode === "pie" ? "donut" : mode)));
  renderLegend();
  if (mode === "table") renderTable();
  else if (mode === "donut" || mode === "pie") renderDonut();
  else renderBarOrLine(mode === "line" || mode === "area");
}}

document.querySelectorAll("[data-mode]").forEach(b => b.addEventListener("click", () => {{ mode = b.dataset.mode; render(); }}));
document.getElementById("btn-theme").addEventListener("click", () => {{
  document.documentElement.dataset.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
}});
document.getElementById("btn-csv").addEventListener("click", () => {{
  const cols = ["Kategorie", ...DATA.series.map(s => s.name)];
  const lines = [cols.join(";"), ...DATA.labels.map((l, i) => [l, ...DATA.series.map(s => s.values[i] ?? "")].join(";"))];
  const blob = new Blob([lines.join("\\n")], {{ type: "text/csv;charset=utf-8" }});
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "daten.csv"; a.click();
}});
render();
</script>
</body>
</html>"""


def generate_chart_artifact(ctx: ToolContext, args: dict) -> dict:
    title = str(_need(args, "title")).strip()[:200]
    labels = [str(x) for x in (_need(args, "labels") or [])]
    raw_series = _need(args, "series")
    if not isinstance(labels, list) or not labels:
        raise ToolError("„labels“ muss eine nicht-leere Liste sein.")
    if not isinstance(raw_series, list) or not raw_series:
        raise ToolError("„series“ muss mindestens eine Datenreihe enthalten.")
    series = []
    for idx, item in enumerate(raw_series[:8]):
        if not isinstance(item, dict):
            raise ToolError("Jede Datenreihe in „series“ muss ein Objekt mit „name“ und „values“ sein.")
        values = item.get("values") or []
        if not isinstance(values, list):
            raise ToolError("„values“ einer Datenreihe muss eine Liste von Zahlen sein.")
        series.append({
            "name": str(item.get("name") or f"Serie {idx + 1}"),
            "values": [float(v) if v is not None else 0.0 for v in values[:len(labels)]],
            **({"color": str(item["color"])} if item.get("color") else {}),
        })
    chart_type = str(args.get("chart_type") or "bar").strip().lower()
    if chart_type not in ("bar", "line", "area", "pie", "donut", "table"):
        chart_type = "bar"
    subtitle = str(args.get("subtitle") or "").strip()
    unit = str(args.get("unit") or "").strip()
    kpis = [k for k in (args.get("kpis") or []) if isinstance(k, dict)]
    notes = str(args.get("notes") or "").strip()

    doc = _build_chart_html(title, subtitle, chart_type, labels, series, unit, kpis, notes)
    return create_artifact(
        ctx,
        {
            "title": title,
            "kind": "html",
            "filename": f"{_slug(title, 'diagramm')}.html",
            "content": doc,
            "open_preview": bool(args.get("open_preview", True)),
        },
    )


def generate_report_html(ctx: ToolContext, args: dict) -> dict:
    title = str(_need(args, "title")).strip()[:200]
    subtitle = str(args.get("subtitle") or f"Erstellt am {_now().strftime('%d.%m.%Y %H:%M UTC')}").strip()
    kpis = [k for k in (args.get("kpis") or []) if isinstance(k, dict)]
    sections = [s for s in (args.get("sections") or []) if isinstance(s, dict)]

    kpi_html = ""
    if kpis:
        cards = []
        for item in kpis[:10]:
            tone = str(item.get("tone") or "").strip().lower()
            cls = f" tone-{_esc(tone)}" if tone in ("good", "warn", "bad") else ""
            cards.append(
                f'<div class="kpi{cls}"><div class="kpi-l">{_esc(item.get("label", ""))}</div>'
                f'<div class="kpi-v">{_esc(item.get("value", ""))}</div>'
                + (f'<div class="kpi-h">{_esc(item.get("hint", ""))}</div>' if item.get("hint") else "")
                + "</div>"
            )
        kpi_html = f'<div class="kpis">{"".join(cards)}</div>'

    sec_html: list[str] = []
    for sec in sections:
        heading = _esc(sec.get("heading", ""))
        body = _esc(sec.get("body", "")).replace("\n", "<br/>")
        bullets = sec.get("bullets") or []
        table = sec.get("table")
        callout = sec.get("callout")
        parts = [f'<section class="card">']
        if heading:
            parts.append(f"<h2>{heading}</h2>")
        if callout:
            parts.append(f'<div class="callout">{_esc(callout)}</div>')
        if body:
            parts.append(f"<p>{body}</p>")
        if isinstance(bullets, list) and bullets:
            parts.append("<ul>" + "".join(f"<li>{_esc(b)}</li>" for b in bullets) + "</ul>")
        if isinstance(table, dict):
            cols = table.get("columns") or []
            rows = table.get("rows") or []
            if cols:
                parts.append(
                    '<div class="tbl-wrap"><table><thead><tr>'
                    + "".join(f"<th>{_esc(c)}</th>" for c in cols)
                    + "</tr></thead><tbody>"
                    + "".join(
                        "<tr>" + "".join(f"<td>{_esc(cell)}</td>" for cell in (r if isinstance(r, list) else [])) + "</tr>"
                        for r in rows
                    )
                    + "</tbody></table></div>"
                )
        parts.append("</section>")
        sec_html.append("".join(parts))

    doc = f"""<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>{_esc(title)}</title>
<style>
  :root {{ --bg:#fbfaf7; --card:#fff; --ink:#25221c; --muted:#6b655a; --line:#e6e2d8; --accent:#0b7a67; --soft:#f3f1eb; --good:#1f7a4c; --warn:#a66c00; --bad:#b4463f; }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; padding:24px; background:var(--bg); color:var(--ink); font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }}
  .sheet {{ max-width:960px; margin:0 auto; display:grid; gap:16px; }}
  .head {{ display:flex; align-items:flex-start; justify-content:space-between; gap:14px; border-bottom:2px solid var(--accent); padding-bottom:14px; }}
  .brand {{ font-size:11px; text-transform:uppercase; letter-spacing:0.12em; color:var(--accent); font-weight:700; }}
  h1 {{ margin:4px 0 2px; font-size:24px; letter-spacing:-0.02em; }}
  .sub {{ margin:0; color:var(--muted); font-size:13px; }}
  .print-btn {{ border:1px solid var(--line); background:var(--card); color:var(--ink); border-radius:8px; padding:7px 12px; cursor:pointer; font-size:12.5px; }}
  .print-btn:hover {{ border-color:var(--accent); color:var(--accent); }}
  .kpis {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:10px; }}
  .kpi {{ background:var(--card); border:1px solid var(--line); border-radius:11px; padding:12px 14px; }}
  .kpi-l {{ font-size:10.5px; text-transform:uppercase; letter-spacing:0.06em; color:var(--muted); }}
  .kpi-v {{ font-size:21px; font-weight:700; margin-top:4px; font-variant-numeric:tabular-nums; }}
  .kpi-h {{ font-size:11.5px; color:var(--muted); margin-top:2px; }}
  .kpi.tone-good .kpi-v {{ color:var(--good); }}
  .kpi.tone-warn .kpi-v {{ color:var(--warn); }}
  .kpi.tone-bad .kpi-v {{ color:var(--bad); }}
  .card {{ background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px 18px; }}
  .card h2 {{ margin:0 0 8px; font-size:16px; }}
  .card p {{ margin:0 0 8px; }}
  .card ul {{ margin:6px 0 0; padding-left:20px; }}
  .callout {{ background:#e0f1ed; color:#0a5a4c; border-left:3px solid var(--accent); padding:9px 12px; border-radius:6px; margin-bottom:10px; font-size:13px; }}
  .tbl-wrap {{ overflow-x:auto; margin-top:8px; }}
  table {{ width:100%; border-collapse:collapse; font-size:12.5px; }}
  th, td {{ padding:7px 9px; border-bottom:1px solid var(--line); text-align:left; }}
  th {{ background:var(--soft); color:var(--muted); font-size:11px; text-transform:uppercase; }}
  @media print {{ body {{ background:#fff; padding:0; }} .print-btn {{ display:none; }} .card {{ break-inside:avoid; }} }}
</style>
</head>
<body>
<div class="sheet">
  <header class="head">
    <div>
      <div class="brand">Gimel Agent Lab · Bericht</div>
      <h1>{_esc(title)}</h1>
      <p class="sub">{_esc(subtitle)}</p>
    </div>
    <button type="button" class="print-btn" onclick="window.print()">Drucken / PDF</button>
  </header>
  {kpi_html}
  {"".join(sec_html)}
</div>
</body>
</html>"""

    return create_artifact(
        ctx,
        {
            "title": title,
            "kind": "html",
            "filename": f"{_slug(title, 'bericht')}.html",
            "content": doc,
            "open_preview": bool(args.get("open_preview", True)),
        },
    )


# ==========================================================================
# 4. Strukturierte Datenanalyse, Einheiten, Auftragsvergleich, Lagebericht, Suche
# ==========================================================================
def parse_structured_data(ctx: ToolContext, args: dict) -> dict:
    raw_text = args.get("text")
    att_id = args.get("attachment_id")
    fmt = str(args.get("format") or "auto").strip().lower()
    if att_id is not None:
        att = ctx.db.get(AgentAttachment, int(att_id))
        if att is None or att.chat_id != ctx.chat.id:
            raise ToolError(f"Anhang #{att_id} nicht gefunden.")
        raw_text = att.text or ""
        if fmt == "auto":
            if att.filename.lower().endswith(".json"):
                fmt = "json"
            elif att.filename.lower().endswith(".csv"):
                fmt = "csv"
    if not raw_text or not str(raw_text).strip():
        raise ToolError("Bitte entweder „text“ oder „attachment_id“ mit CSV- oder JSON-Daten angeben.")
    text = str(raw_text).strip()
    if fmt == "auto":
        fmt = "json" if text.startswith(("{", "[")) else "csv"

    rows: list[dict[str, Any]] = []
    if fmt == "json":
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError as exc:
            raise ToolError(f"Ungültiges JSON: {exc}") from exc
        if isinstance(parsed, list):
            rows = [r if isinstance(r, dict) else {"value": r} for r in parsed]
        elif isinstance(parsed, dict):
            list_val = next((v for v in parsed.values() if isinstance(v, list) and v and isinstance(v[0], dict)), None)
            rows = list_val if list_val is not None else [parsed]
    else:
        sample = text[:4096]
        delim = ";" if sample.count(";") > sample.count(",") else ","
        reader = csv.DictReader(io.StringIO(text), delimiter=delim)
        rows = [dict(r) for r in reader]

    if not rows:
        return {"summary": "Keine Datensätze gefunden.", "data": {"row_count": 0, "columns": []}}

    # Optionales Filtern
    fcol = str(args.get("filter_column") or "").strip()
    fval = str(args.get("filter_value") or "").strip().lower()
    if fcol and fval:
        rows = [r for r in rows if fval in str(r.get(fcol, "")).lower()]

    cols = list(dict.fromkeys(k for r in rows[:200] for k in r.keys() if k is not None))
    stats: dict[str, Any] = {}
    for col in cols[:30]:
        nums: list[float] = []
        non_empty = 0
        counts: dict[str, int] = {}
        for r in rows:
            val = r.get(col)
            if val is None or str(val).strip() == "":
                continue
            non_empty += 1
            sval = str(val).strip()
            counts[sval] = counts.get(sval, 0) + 1
            try:
                num = float(sval.replace(",", ".")) if isinstance(val, str) else float(val)
                if math.isfinite(num):
                    nums.append(num)
            except (ValueError, TypeError):
                pass
        col_stat: dict[str, Any] = {"non_empty": non_empty, "distinct": len(counts)}
        if nums and len(nums) >= max(1, int(non_empty * 0.7)):
            col_stat.update({
                "type": "numeric",
                "sum": round(sum(nums), 4),
                "min": round(min(nums), 4),
                "max": round(max(nums), 4),
                "mean": round(statistics.mean(nums), 4),
            })
        else:
            top = sorted(counts.items(), key=lambda kv: -kv[1])[:5]
            col_stat.update({"type": "text", "top_values": [{"value": k, "count": v} for k, v in top]})
        stats[col] = col_stat

    group_by = str(args.get("group_by") or "").strip()
    groups_out = None
    if group_by and group_by in cols:
        agg_col = str(args.get("sum_column") or "").strip()
        grouped: dict[str, dict[str, Any]] = {}
        for r in rows:
            key = str(r.get(group_by) or "(leer)").strip()
            bucket = grouped.setdefault(key, {"group": key, "count": 0, "sum": 0.0})
            bucket["count"] += 1
            if agg_col:
                try:
                    bucket["sum"] += float(str(r.get(agg_col, 0)).replace(",", "."))
                except (ValueError, TypeError):
                    pass
        groups_out = sorted(grouped.values(), key=lambda g: -g["sum" if agg_col else "count"])[:40]
        if agg_col:
            for g in groups_out:
                g["sum"] = round(g["sum"], 4)

    return {
        "summary": f"{len(rows)} Zeilen, {len(cols)} Spalten ausgewertet ({fmt.upper()}).",
        "data": {
            "format": fmt,
            "row_count": len(rows),
            "columns": cols,
            "stats": stats,
            "groups": groups_out,
            "sample": rows[:15],
        },
    }


_UNIT_FACTORS: dict[str, tuple[str, float]] = {
    # Länge -> Meter
    "mm": ("length", 0.001), "cm": ("length", 0.01), "m": ("length", 1.0),
    "km": ("length", 1000.0), "in": ("length", 0.0254), "inch": ("length", 0.0254),
    "ft": ("length", 0.3048),
    # Fläche -> m²
    "mm2": ("area", 1e-6), "cm2": ("area", 1e-4), "m2": ("area", 1.0),
    "in2": ("area", 0.00064516), "ft2": ("area", 0.09290304),
    # Masse -> kg
    "mg": ("mass", 1e-6), "g": ("mass", 0.001), "kg": ("mass", 1.0),
    "t": ("mass", 1000.0), "oz": ("mass", 0.028349523125), "lb": ("mass", 0.45359237),
    # Druck -> Pa
    "pa": ("pressure", 1.0), "kpa": ("pressure", 1000.0), "bar": ("pressure", 100_000.0),
    "mpa": ("pressure", 1_000_000.0), "psi": ("pressure", 6894.757293),
    # Zeit -> Sekunden
    "s": ("time", 1.0), "sec": ("time", 1.0), "min": ("time", 60.0),
    "h": ("time", 3600.0), "d": ("time", 86400.0),
}


def convert_units(ctx: ToolContext, args: dict) -> dict:
    value = float(_need(args, "value"))
    src = str(_need(args, "from_unit")).strip().lower().replace("²", "2").replace("°", "")
    dst = str(_need(args, "to_unit")).strip().lower().replace("²", "2").replace("°", "")
    if src in ("c", "f", "k") and dst in ("c", "f", "k"):
        c_val = value if src == "c" else (value - 32.0) * 5.0 / 9.0 if src == "f" else value - 273.15
        out = c_val if dst == "c" else (c_val * 9.0 / 5.0 + 32.0) if dst == "f" else c_val + 273.15
        rounded = round(out, 4)
        return {
            "summary": f"{value:g} {src.upper()} = {rounded:g} {dst.upper()}",
            "data": {"value": value, "from": src, "to": dst, "result": rounded},
        }
    if src not in _UNIT_FACTORS or dst not in _UNIT_FACTORS:
        raise ToolError(f"Unbekannte Einheit ({src} → {dst}). Unterstützt: mm, cm, m, in, ft, mm2, cm2, m2, g, kg, t, lb, bar, psi, MPa, C, F, K, s, min, h, d.")
    src_dim, src_fac = _UNIT_FACTORS[src]
    dst_dim, dst_fac = _UNIT_FACTORS[dst]
    if src_dim != dst_dim:
        raise ToolError(f"Inkompatible Dimensionen: {src} ({src_dim}) → {dst} ({dst_dim}).")
    result = (value * src_fac) / dst_fac
    rounded = round(result, 6)
    return {
        "summary": f"{value:g} {src} = {rounded:g} {dst}",
        "data": {"value": value, "from": src, "to": dst, "dimension": src_dim, "result": rounded},
    }


def compare_orders(ctx: ToolContext, args: dict) -> dict:
    order_nos = args.get("order_nos") or []
    if not isinstance(order_nos, list) or len(order_nos) < 2 or len(order_nos) > 8:
        raise ToolError("Bitte 2 bis 8 Auftragsnummern in „order_nos“ angeben.")
    office = _office(ctx.user)
    rows: list[dict] = []
    missing: list[str] = []
    for raw_no in order_nos:
        no = str(raw_no).strip()
        order = ctx.db.query(Order).filter(Order.no == no).first()
        if order is None:
            missing.append(no)
            continue
        positions = list(order.positions)
        total_qty = sum(int(p.qty or 0) for p in positions)
        done = sum(1 for p in positions if p.production_status == "done")
        batched = sum(1 for p in positions if p.production_status == "batched")
        pending = sum(1 for p in positions if p.production_status == "pending")
        mats = sorted({p.mat for p in positions if p.mat})
        pct = round((done / len(positions)) * 100, 1) if positions else 0.0
        rows.append({
            "no": order.no,
            "customer": _order_customer(order) if office or (order.kind or "external") == "internal" else "",
            "stage": order.stage,
            "released": order.released,
            "blocked": order.blocked,
            "rush": order.rush,
            "due_date": _iso(order.due_date),
            "n_positions": len(positions),
            "total_qty": total_qty,
            "done": done,
            "batched": batched,
            "pending": pending,
            "progress_pct": pct,
            "materials": mats,
            "gross": order.gross if office else None,
            "paid": order.paid if office else None,
        })
    return {
        "summary": f"{len(rows)} Aufträge verglichen" + (f" ({len(missing)} nicht gefunden)" if missing else "") + ".",
        "data": {"orders": rows, "missing": missing},
    }


def get_daily_briefing(ctx: ToolContext, args: dict) -> dict:
    db = ctx.db
    office = _office(ctx.user)
    now = _now()
    today_end = now.replace(hour=23, minute=59, second=59, microsecond=0)
    soon_end = now + timedelta(days=3)
    low_thresh = max(0, agent_settings.get_int(db, "agent_low_stock_threshold"))

    orders = db.query(Order).all()
    overdue, due_today, due_soon, blocked = [], [], [], []
    for o in orders:
        positions = list(o.positions)
        all_done = bool(positions) and all(p.production_status == "done" for p in positions)
        if o.blocked:
            blocked.append({"no": o.no, "customer": _order_customer(o) if office else "", "due_date": _iso(o.due_date)})
        if all_done or not o.due_date:
            continue
        due = o.due_date if o.due_date.tzinfo else o.due_date.replace(tzinfo=timezone.utc)
        entry = {"no": o.no, "customer": _order_customer(o) if office else "",
                 "due_date": _iso(due), "rush": o.rush, "released": o.released,
                 "n_positions": len(positions)}
        if due < now:
            overdue.append(entry)
        elif due <= today_end:
            due_today.append(entry)
        elif due <= soon_end:
            due_soon.append(entry)

    wo_counts: dict[str, int] = {}
    for wo in db.query(WorkOrder).all():
        st = wo.status.value
        wo_counts[st] = wo_counts.get(st, 0) + 1

    open_shipments = (
        db.query(Shipment)
        .filter(Shipment.status.notin_([ShipmentStatus.shipped, ShipmentStatus.delivered]))
        .count()
    )

    low_stock: list[dict] = []
    for prod in db.query(Product).filter(Product.active.is_(True)).all():
        stock_val = prod.stock
        if isinstance(stock_val, dict):
            for thk, qty in stock_val.items():
                try:
                    q = int(qty)
                except (TypeError, ValueError):
                    continue
                if q <= low_thresh:
                    low_stock.append({"product_id": prod.id, "name": prod.name, "thk": thk, "stock": q})
        else:
            try:
                q = int(stock_val or 0)
            except (TypeError, ValueError):
                continue
            if q <= low_thresh:
                low_stock.append({"product_id": prod.id, "name": prod.name, "stock": q})
    low_stock.sort(key=lambda item: item["stock"])

    pending_proposals = (
        db.query(AgentActionProposal).filter(AgentActionProposal.status == "pending").count()
        if office else 0
    )
    recent_audit = db.query(AuditLog).order_by(AuditLog.id.desc()).limit(8).all() if office else []

    return {
        "summary": (
            f"Lagebericht: {len(overdue)} überfällig, {len(due_today)} heute fällig, "
            f"{len(blocked)} gesperrt, {len(low_stock)} knappe Bestände."
        ),
        "data": {
            "generated_at": _iso(now),
            "counts": {
                "overdue_orders": len(overdue),
                "due_today": len(due_today),
                "due_next_3d": len(due_soon),
                "blocked_orders": len(blocked),
                "open_shipments": open_shipments,
                "low_stock_items": len(low_stock),
                "pending_proposals": pending_proposals,
                "work_orders_by_status": wo_counts,
            },
            "overdue": overdue[:15],
            "due_today": due_today[:15],
            "due_soon": due_soon[:15],
            "blocked": blocked[:15],
            "low_stock": low_stock[:20],
            "recent_activity": [
                {"action": a.action, "entity": a.entity, "entity_id": a.entity_id,
                 "actor": a.actor, "at": _iso(a.at)}
                for a in recent_audit
            ] if office else [],
        },
    }


def discover_tools(ctx: ToolContext, args: dict) -> dict:
    from .analysis_tools import category_of
    from .tools import TOOL_SPECS, allowed

    query = str(args.get("query") or "").strip().lower()
    category = str(args.get("category") or "").strip().lower()
    include_write = args.get("include_write", True)
    limit = _limit(args.get("limit"), 20, 50)
    web_enabled = agent_settings.get_bool(ctx.db, "agent_web_enabled")

    matches: list[dict] = []
    for spec in TOOL_SPECS:
        if not allowed(spec, ctx.user):
            continue
        if spec.network and not web_enabled:
            continue
        if not include_write and spec.write:
            continue
        cat = category_of(spec.name)
        if category and category not in cat.lower():
            continue
        if query:
            hay = f"{spec.name} {spec.description} {cat}".lower()
            if not all(tok in hay for tok in query.split()):
                continue
        matches.append({
            "name": spec.name,
            "category": cat,
            "write": spec.write,
            "reversible": spec.reversible,
            "description": spec.description,
            "required": (spec.parameters or {}).get("required") or [],
            "parameters": list(((spec.parameters or {}).get("properties") or {}).keys()),
        })
    return {
        "summary": f"{len(matches)} passende Werkzeuge gefunden.",
        "data": {"total_matches": len(matches), "tools": matches[:limit]},
    }


ARTIFACT_SPECS: list[ToolSpec] = [
    ToolSpec(
        "create_artifact",
        "Create a rich interactive HTML website, SVG graphic, Markdown document, CSV table, JSON or code file and open it immediately in the user's Side Preview Browser. Safe to use even when write_mode is off.",
        _schema({
            "title": {"type": "string", "description": "Short descriptive title"},
            "kind": {"type": "string", "enum": list(VALID_KINDS), "description": "Artifact type (html, svg, markdown, csv, json, code, text)"},
            "content": {"type": "string", "description": "Complete self-contained content (e.g. full HTML document with CSS/JS)"},
            "filename": {"type": "string", "description": "Optional download filename"},
            "language": {"type": "string", "description": "Optional programming language for kind=code"},
            "open_preview": {"type": "boolean", "description": "Open in Side Preview Browser immediately (default true)"},
        }, ["title", "content"]),
        create_artifact,
        roles=frozenset(ALL),
    ),
    ToolSpec(
        "update_artifact",
        "Update an existing artifact in this chat (replace full content or apply targeted find/replace patch) and live-refresh the Side Preview Browser.",
        _schema({
            "artifact_id": {"type": "integer", "description": "Artifact ID (optional; defaults to latest in chat)"},
            "title": {"type": "string", "description": "Match artifact by title if artifact_id is omitted"},
            "new_title": {"type": "string", "description": "Optional new title"},
            "content": {"type": "string", "description": "Full replacement content"},
            "find": {"type": "string", "description": "Exact snippet to replace (use with replace)"},
            "replace": {"type": "string", "description": "Replacement snippet (use with find)"},
            "open_preview": {"type": "boolean"},
        }),
        update_artifact,
        roles=frozenset(ALL),
    ),
    ToolSpec(
        "list_artifacts",
        "List all saved artifacts (HTML websites, charts, reports, files) in the current chat.",
        _schema({"limit": {"type": "integer"}}),
        _readonly(list_artifacts),
        roles=frozenset(ALL),
    ),
    ToolSpec(
        "get_artifact",
        "Read the content of a saved artifact in this chat so you can inspect or refine it.",
        _schema({"artifact_id": {"type": "integer"}, "max_chars": {"type": "integer"}}, ["artifact_id"]),
        _readonly(get_artifact),
        roles=frozenset(ALL),
    ),
    ToolSpec(
        "open_preview",
        "Open a website URL, local Gimel view (/app, /twin), uploaded file attachment, or saved artifact in the user's Side Preview Browser.",
        _schema({
            "url": {"type": "string", "description": "https:// URL or local Gimel path like /app or /twin"},
            "artifact_id": {"type": "integer", "description": "ID of a saved artifact in this chat"},
            "attachment_id": {"type": "integer", "description": "ID of an uploaded attachment in this chat"},
            "title": {"type": "string", "description": "Optional tab title"},
        }),
        _readonly(open_preview),
        roles=frozenset(ALL),
    ),
    ToolSpec(
        "read_attachment",
        "Read an uploaded file attachment in chunks or by PDF page, or list all attachments in this chat.",
        _schema({
            "attachment_id": {"type": "integer"},
            "filename": {"type": "string"},
            "page": {"type": "integer", "description": "Specific PDF page number"},
            "start_char": {"type": "integer"},
            "max_chars": {"type": "integer"},
        }),
        _readonly(read_attachment),
        roles=frozenset(ALL),
    ),
    ToolSpec(
        "search_attachments",
        "Search inside all uploaded attachments in this chat for a keyword and return matching lines with context.",
        _schema({
            "query": {"type": "string"},
            "attachment_id": {"type": "integer"},
            "limit": {"type": "integer"},
        }, ["query"]),
        _readonly(search_attachments),
        roles=frozenset(ALL),
    ),
    ToolSpec(
        "generate_chart_artifact",
        "Build a self-contained, interactive HTML/SVG chart dashboard (bar, line, area, donut, pie, table with tooltips, theme toggle, CSV export) and open it in the Side Preview Browser.",
        _schema({
            "title": {"type": "string"},
            "subtitle": {"type": "string"},
            "chart_type": {"type": "string", "enum": ["bar", "line", "area", "donut", "pie", "table"]},
            "labels": {"type": "array", "items": {"type": "string"}},
            "series": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "values": {"type": "array", "items": {"type": "number"}},
                        "color": {"type": "string"},
                    },
                    "required": ["name", "values"],
                },
            },
            "unit": {"type": "string"},
            "kpis": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "label": {"type": "string"},
                        "value": {"type": "string"},
                        "hint": {"type": "string"},
                        "tone": {"type": "string", "enum": ["good", "warn", "bad"]},
                    },
                },
            },
            "notes": {"type": "string"},
            "open_preview": {"type": "boolean"},
        }, ["title", "labels", "series"]),
        generate_chart_artifact,
        roles=frozenset(ALL),
    ),
    ToolSpec(
        "generate_report_html",
        "Generate a polished, print-ready Gimel HTML report with KPI cards, narrative sections, bullet lists, callouts and tables, and open it in the Side Preview Browser.",
        _schema({
            "title": {"type": "string"},
            "subtitle": {"type": "string"},
            "kpis": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "label": {"type": "string"},
                        "value": {"type": "string"},
                        "hint": {"type": "string"},
                        "tone": {"type": "string", "enum": ["good", "warn", "bad"]},
                    },
                },
            },
            "sections": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "heading": {"type": "string"},
                        "body": {"type": "string"},
                        "callout": {"type": "string"},
                        "bullets": {"type": "array", "items": {"type": "string"}},
                        "table": {
                            "type": "object",
                            "properties": {
                                "columns": {"type": "array", "items": {"type": "string"}},
                                "rows": {"type": "array", "items": {"type": "array"}},
                            },
                        },
                    },
                },
            },
            "open_preview": {"type": "boolean"},
        }, ["title"]),
        generate_report_html,
        roles=frozenset(ALL),
    ),
    ToolSpec(
        "parse_structured_data",
        "Parse and analyze CSV or JSON data (inline text or uploaded attachment): column stats (min/max/mean/sum/distinct), filtering, and group-by aggregation.",
        _schema({
            "text": {"type": "string", "description": "Inline CSV or JSON text"},
            "attachment_id": {"type": "integer", "description": "Or read directly from an uploaded attachment"},
            "format": {"type": "string", "enum": ["auto", "csv", "json"]},
            "filter_column": {"type": "string"},
            "filter_value": {"type": "string"},
            "group_by": {"type": "string"},
            "sum_column": {"type": "string"},
        }),
        _readonly(parse_structured_data),
        roles=frozenset(ALL),
    ),
    ToolSpec(
        "convert_units",
        "Exact engineering unit conversion for length (mm/cm/m/in/ft), area (mm2/cm2/m2/in2/ft2), mass (mg/g/kg/t/oz/lb), pressure (Pa/kPa/bar/MPa/psi), temperature (C/F/K) and time (s/min/h/d).",
        _schema({
            "value": {"type": "number"},
            "from_unit": {"type": "string"},
            "to_unit": {"type": "string"},
        }, ["value", "from_unit", "to_unit"]),
        _readonly(convert_units),
        roles=frozenset(ALL),
    ),
    ToolSpec(
        "compare_orders",
        "Compare 2 to 8 customer orders side by side: progress, quantities, materials, due dates, blocks, rush status and gross price (office).",
        _schema({
            "order_nos": {"type": "array", "items": {"type": "string"}, "description": "List of order numbers"},
        }, ["order_nos"]),
        _readonly(compare_orders),
        roles=frozenset(ALL),
    ),
    ToolSpec(
        "get_daily_briefing",
        "Single-call shift/daily briefing: overdue orders, due today, due in 3 days, blocked orders, work order status counts, open shipments, low stock alerts and pending proposals.",
        _schema({}),
        _readonly(get_daily_briefing),
        roles=frozenset(ALL),
    ),
    ToolSpec(
        "discover_tools",
        "Search the complete Agent Lab tool catalog by keyword or category to find specialized tools and inspect their required parameters.",
        _schema({
            "query": {"type": "string"},
            "category": {"type": "string"},
            "include_write": {"type": "boolean"},
            "limit": {"type": "integer"},
        }),
        _readonly(discover_tools),
        roles=frozenset(ALL),
    ),
]
