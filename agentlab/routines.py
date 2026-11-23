"""Routinen-Vorlagen, Prompt-Komposition und Serialisierung für Gimel Agent Lab."""

from __future__ import annotations

from typing import Any

from gimel.models import User
from gimel.security import has_admin_work

from .models import AgentRoutine, AgentRoutineRun

VALID_CATEGORIES = ("schicht", "fertigung", "lager", "bericht", "custom")
VALID_SCHEDULES = ("manual", "shift", "daily", "weekly")
VALID_OUTPUTS = ("chat", "html_report", "chart_dashboard", "markdown")

OUTPUT_INSTRUCTIONS: dict[str, str] = {
    "html_report": (
        "Erzeuge am Ende mit `generate_report_html` (oder `create_artifact` mit kind='html') einen "
        "übersichtlichen, druckfertigen HTML-Bericht mit KPI-Karten, Tabellen und klaren Empfehlungen, "
        "damit er sofort in der Seiten-Vorschau erscheint."
    ),
    "chart_dashboard": (
        "Visualisiere die wichtigsten Kennzahlen am Ende mit `generate_chart_artifact` (oder "
        "`create_artifact` mit kind='html') als interaktives Dashboard in der Seiten-Vorschau."
    ),
    "markdown": (
        "Erstelle zusätzlich mit `create_artifact` (kind='markdown') ein strukturiertes Markdown-Protokoll "
        "für die Seiten-Vorschau."
    ),
    "chat": "Antworte kompakt, strukturiert und sachlich direkt im Chat.",
}

ROUTINE_TEMPLATES: list[dict[str, Any]] = [
    {
        "key": "morning_shift_briefing",
        "name": "Frühschicht-Lagebericht",
        "description": "Überfällige und heutige Aufträge, gesperrte Aufträge, Stationslasten, knappe Bestände und offene Sendungen in einem druckfertigen Schichtbericht.",
        "category": "schicht",
        "icon": "flame",
        "schedule": "shift",
        "schedule_time": "06:30",
        "output_format": "html_report",
        "write_mode": False,
        "roles": ["worker", "staff", "admin"],
        "steps": [
            "Rufe `get_daily_briefing` für einen vollständigen Tagesüberblick ab.",
            "Prüfe mit `get_station_load` Engpässe an den Fertigungsstationen.",
            "Prüfe mit `get_shipment_board` offene oder fällige Sendungen.",
            "Fasse die Top-3-Prioritäten für die Schicht zusammen und erstelle einen HTML-Schichtbericht.",
        ],
        "prompt": (
            "Erstelle den aktuellen Frühschicht-Lagebericht für die Fertigung: kritische/überfällige Aufträge, "
            "gesperrte Aufträge, Engpässe an den Stationen, knappe Bestände und Versandlage."
        ),
    },
    {
        "key": "bottleneck_audit",
        "name": "Engpass- & Zwillingsprüfung",
        "description": "Analysiert den digitalen Zwilling, Stationslasten und Dispositionsvorschläge — leitet konkrete Verlagerungen ab (rein lesend).",
        "category": "fertigung",
        "icon": "diagram-tree",
        "schedule": "daily",
        "schedule_time": "08:00",
        "output_format": "html_report",
        "write_mode": False,
        "roles": ["worker", "staff", "admin"],
        "steps": [
            "Starte `analyse_twin` für aktuelle Zwillingsbefunde.",
            "Lies `get_station_load` und vergleiche Wartezeiten/Auslastung.",
            "Schlage zwei konkrete, begründete Entlastungsmaßnahmen vor (nichts ausführen).",
        ],
        "prompt": (
            "Führe eine Engpass- und Zwillingsprüfung der Halle durch. Identifiziere überlastete Stationen, "
            "unnötige Transportwege und nenne konkrete Handlungsempfehlungen ohne Daten zu ändern."
        ),
    },
    {
        "key": "kpi_weekly_dashboard",
        "name": "Wochen-KPI-Dashboard",
        "description": "Vergleicht 7-Tage- und 30-Tage-Kennzahlen (Durchsatz, Termintreue, Durchlaufzeit, Materialausnutzung) als interaktives HTML-Dashboard.",
        "category": "bericht",
        "icon": "grouped-bar-chart",
        "schedule": "weekly",
        "schedule_time": "08:00",
        "output_format": "chart_dashboard",
        "write_mode": False,
        "roles": ["worker", "staff", "admin"],
        "steps": [
            "Rufe `get_kpis` für 7 Tage und 30 Tage ab.",
            "Hole die Stationsauslastung über `get_station_load`.",
            "Baue ein interaktives Dashboard mit KPI-Karten und Balken-/Liniendiagramm in der Seiten-Vorschau.",
        ],
        "prompt": (
            "Erstelle ein interaktives Wochen-KPI-Dashboard: vergleiche die letzten 7 Tage mit dem 30-Tage-Trend "
            "(Durchsatz, Termintreue, Durchlaufzeit, Ausnutzung) und markiere Auffälligkeiten."
        ),
    },
    {
        "key": "low_stock_mrp_check",
        "name": "Lager- & Nachbestell-Check",
        "description": "Prüft knappe Werkstoffe, offenen Plattenbedarf wartender Positionen und MRP-Fehlmengen.",
        "category": "lager",
        "icon": "layers",
        "schedule": "daily",
        "schedule_time": "09:00",
        "output_format": "html_report",
        "write_mode": False,
        "roles": ["worker", "staff", "admin"],
        "steps": [
            "Prüfe `get_low_stock` für kritische Bestände.",
            "Berechne mit `get_material_demand` den Plattenbedarf wartender Aufträge.",
            "Bewerte Dringlichkeit je Werkstoff und gib eine klare Nachbestellempfehlung.",
        ],
        "prompt": (
            "Prüfe alle knappen Werkstoffe und den aktuellen Materialbedarf wartender Positionen. "
            "Priorisiere nach Engpassrisiko."
        ),
    },
    {
        "key": "due_orders_triage",
        "name": "Termin- & Sperraufträge-Triage",
        "description": "Listet fällige Aufträge der nächsten 5 Tage sowie gesperrte Aufträge mit Status und Empfehlung.",
        "category": "fertigung",
        "icon": "calendar",
        "schedule": "daily",
        "schedule_time": "10:00",
        "output_format": "html_report",
        "write_mode": False,
        "roles": ["staff", "admin"],
        "steps": [
            "Rufe `get_due_orders` für die nächsten 5 Tage (inkl. gesperrter Aufträge) ab.",
            "Prüfe kritische Aufträge mit `get_order_trace`.",
            "Ordne nach Risiko und nenne fehlende Freigaben oder Engpässe.",
        ],
        "prompt": (
            "Führe eine Termin- und Sperraufträge-Triage für die nächsten 5 Tage durch. "
            "Welche Aufträge gefährden den Liefertermin und warum?"
        ),
    },
    {
        "key": "shipping_dispatch_board",
        "name": "Versand- & Auslieferungs-Check",
        "description": "Kontrolliert versandbereite Positionen ohne Sendung und offene Sendungen vor dem Nachmittags-Abgang.",
        "category": "schicht",
        "icon": "box",
        "schedule": "daily",
        "schedule_time": "13:30",
        "output_format": "markdown",
        "write_mode": False,
        "roles": ["worker", "staff", "admin"],
        "steps": [
            "Lies `get_shipping_ready` für fertige, noch nicht verpackte Aufträge.",
            "Lies `get_shipment_board` für offene Sendungen und deren Alter.",
            "Erstelle eine kompakte Versand-Checkliste.",
        ],
        "prompt": (
            "Prüfe alle versandbereiten Aufträge und offenen Sendungen für den heutigen Versandabgang "
            "und erstelle eine priorisierte Pack- und Versand-Checkliste."
        ),
    },
    {
        "key": "twin_topology_check",
        "name": "Zwilling-Check: Hallen, Ebenen & Stationen",
        "description": "Prüft Standorte, Hallen und Ebenen auf leere Ebenen, Stationen ohne Koordinaten, Überlappungen und fehlende Zuordnungen — als Bericht mit Aufräumvorschlägen.",
        "category": "fertigung",
        "icon": "layout",
        "schedule": "daily",
        "schedule_time": "07:15",
        "output_format": "html_report",
        "write_mode": False,
        "roles": ["staff", "admin"],
        "steps": [
            "Rufe `get_topology` ab und notiere Standorte, Hallen und Ebenen mit ihren IDs.",
            "Prüfe je Ebene mit `get_floor_layout` Stationen ohne Koordinaten, Überlappungen und Flächen außerhalb des Umrisses.",
            "Lies `get_twin_findings` für Daten- und Layoutbefunde.",
            "Fasse je Halle die Aufräumvorschläge zusammen; lösche nichts, sondern nenne die IDs.",
            "Erstelle einen druckfertigen HTML-Bericht mit Ampelfarben je Ebene.",
        ],
        "prompt": (
            "Führe einen Zwilling-Check durch: Welche Hallen und Ebenen sind leer, welche Stationen "
            "haben keine gültigen Koordinaten, wo überlappen sich Flächen, und welche Daten fehlen? "
            "Nenne konkrete IDs und Aufräumvorschläge, ohne etwas zu löschen."
        ),
    },
    {
        "key": "knowledge_graph_sync",
        "name": "Wissensgraph synchronisieren & verknüpfen",
        "description": "Aktualisiert den plattformweiten Wissensgraphen aus allen Gimel-Modulen (Kunden, Aufträge, Werkstoffe, Fertigung, Stationen, Roboter, Versand) und speichert neue Engpass-Erkenntnisse.",
        "category": "bericht",
        "icon": "graph",
        "schedule": "shift",
        "schedule_time": "06:00",
        "output_format": "chat",
        "write_mode": False,
        "roles": ["worker", "staff", "admin"],
        "steps": [
            "Rufe `rebuild_knowledge_graph` auf, um alle Plattform-Knoten und Kanten neu zu synchronisieren.",
            "Prüfe mit `query_knowledge_graph` kritische Knoten (überfällige Aufträge, knappe Werkstoffe, blockierte Stationen).",
            "Speichere die wichtigsten Querverbindungen als Erkenntnis über `add_knowledge_insight`.",
            "Fasse kurz zusammen, wie viele Knoten/Kanten aktualisiert wurden und welche Zusammenhänge auffallen.",
        ],
        "prompt": (
            "Synchronisiere den plattformweiten Wissensgraphen mit allen aktuellen Gimel-Daten, "
            "analysiere kritische Verknüpfungen zwischen Aufträgen, Werkstoffen, Stationen und Versand "
            "und hinterlege neue Erkenntnisse direkt im Graphen."
        ),
    },
    {
        "key": "custom_html_app",
        "name": "Interaktive HTML-Übersicht erstellen",
        "description": "Erstellt aus aktuellen Gimel-Betriebsdaten eine maßgeschneiderte, interaktive HTML-Seite mit Filter & Suche für die Seiten-Vorschau.",
        "category": "custom",
        "icon": "application",
        "schedule": "manual",
        "schedule_time": "",
        "output_format": "html_report",
        "write_mode": False,
        "roles": ["worker", "staff", "admin"],
        "steps": [
            "Lies `platform_overview` und `get_daily_briefing`.",
            "Erstelle mit `create_artifact` (kind='html') eine eigenständige, interaktive HTML-Webseite mit Suchfeld, Status-Filtern und Hell/Dunkel-Schalter.",
        ],
        "prompt": (
            "Baue aus den aktuellen Gimel-Daten eine moderne, interaktive HTML-Übersichtsseite "
            "mit Live-Filter, KPI-Leiste und Tabellenansicht und öffne sie in der Seiten-Vorschau."
        ),
    },
]

TEMPLATES_BY_KEY: dict[str, dict[str, Any]] = {t["key"]: t for t in ROUTINE_TEMPLATES}


def compile_routine_prompt(
    name: str,
    prompt: str,
    steps: list[str] | None = None,
    output_format: str = "html_report",
) -> str:
    parts = [f"Führe die Routine „{name}“ aus."]
    if prompt.strip():
        parts.append(prompt.strip())
    clean_steps = [str(s).strip() for s in (steps or []) if str(s).strip()]
    if clean_steps:
        numbered = "\n".join(f"{idx}. {step}" for idx, step in enumerate(clean_steps, start=1))
        parts.append(f"Schritte:\n{numbered}")
    out_hint = OUTPUT_INSTRUCTIONS.get(output_format) or OUTPUT_INSTRUCTIONS["chat"]
    parts.append(f"Ausgabe: {out_hint}")
    return "\n\n".join(parts)


def routine_out(row: AgentRoutine, user: User) -> dict[str, Any]:
    admin = has_admin_work(user)
    return {
        "id": row.id,
        "name": row.name,
        "description": row.description or "",
        "category": row.category or "custom",
        "icon": row.icon or "repeat",
        "prompt": row.prompt or "",
        "steps": list(row.steps or []),
        "schedule": row.schedule or "manual",
        "schedule_time": row.schedule_time or "",
        "write_mode": bool(row.write_mode),
        "output_format": row.output_format or "html_report",
        "shared": bool(row.shared),
        "enabled": bool(row.enabled),
        "template_key": row.template_key or "",
        "run_count": int(row.run_count or 0),
        "last_run_at": row.last_run_at,
        "last_chat_id": row.last_chat_id,
        "own": row.user_id == user.id,
        "editable": row.user_id == user.id or (bool(row.shared) and admin),
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }


def routine_run_out(row: AgentRoutineRun) -> dict[str, Any]:
    return {
        "id": row.id,
        "routine_id": row.routine_id,
        "template_key": row.template_key or "",
        "routine_name": row.routine_name or "",
        "chat_id": row.chat_id,
        "status": row.status or "started",
        "summary": row.summary or "",
        "started_at": row.started_at,
    }


def templates_for(user: User) -> list[dict[str, Any]]:
    role = user.role.value if hasattr(user.role, "value") else str(user.role)
    return [
        {k: v for k, v in item.items() if k != "roles"}
        for item in ROUTINE_TEMPLATES
        if role in item["roles"]
    ]
