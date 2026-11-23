"""Einstellungen des Agent Labors — typisiert, geprüft und getrennt von Gimel.

Die Werte stehen in ``agent_settings``. Das ist absichtlich eine eigene
Tabelle: Gimels Betriebsparameter gehören der Fertigung, nicht dem Assistenten.
Für bestehende Installationen gilt trotzdem ein Rückfall auf ``settings``,
damit ein früher gesetzter ``agent_max_steps`` nicht plötzlich verschwindet.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from gimel.config import ENV_PREFIX
from gimel.services import secretbox

from .models import AgentSetting


@dataclass(frozen=True)
class SettingField:
    key: str
    label: str
    group: str
    kind: str  # bool | int | float | text | secret | select
    default: str
    help: str
    minimum: float | None = None
    maximum: float | None = None
    step: float | None = None
    options: tuple[tuple[str, str], ...] = ()
    secret: bool = False


FIELDS: tuple[SettingField, ...] = (
    # ---- Assistent -------------------------------------------------------
    SettingField(
        "agent_max_steps", "Höchstzahl Werkzeugschritte", "assistant", "int", "20",
        "Nach so vielen Modellrunden endet ein klassischer Lauf (1–100). "
        "Mehr Schritte erlauben tiefere Analyse- und Werkzeugketten.", 1, 100, 1,
    ),
    SettingField(
        "agent_orchestrator_max_steps", "Werkzeugschritte Orchestrator", "assistant", "int", "40",
        "Schrittbudget für Orchestrator-Chats (1–100), damit Wissensgraph, "
        "Subagenten und mehrstufige Auswertungen vollständig durchlaufen.", 1, 100, 1,
    ),
    SettingField(
        "agent_subagent_max_steps", "Werkzeugschritte je Subagent", "assistant", "int", "15",
        "Wie viele Werkzeugrunden ein temporärer Subagent ausführen darf (1–50).", 1, 50, 1,
    ),
    SettingField(
        "agent_temperature", "Temperatur", "assistant", "float", "0.2",
        "0 ist streng und reproduzierbar, höhere Werte formulieren freier. "
        "Für Zahlen und Auftragsdaten sind kleine Werte besser.", 0, 2, 0.05,
    ),
    SettingField(
        "agent_timeout_s", "Zeitlimit je Modellrunde (s)", "assistant", "int", "180",
        "Bricht eine einzelne Modellantwort ab, wenn sie zu lange braucht.",
        15, 900, 5,
    ),
    SettingField(
        "agent_history_messages", "Nachrichten im Verlauf", "assistant", "int", "40",
        "Wie viele der letzten Nachrichten das Modell sieht. Weniger spart "
        "Kontext, mehr erhält ältere Zusammenhänge.", 10, 200, 5,
    ),
    SettingField(
        "agent_auto_title", "Chat automatisch benennen", "assistant", "bool", "true",
        "Der erste Satz wird zum Chattitel, solange der Chat noch keinen hat.",
    ),
    SettingField(
        "agent_system_prompt", "Zusätzliche Anweisung", "assistant", "text", "",
        "Wird an die Systemanweisung angehängt. Keine Geheimnisse eintragen.",
    ),
    SettingField(
        "agent_low_stock_threshold", "Knapper Bestand ab (Platten)", "assistant", "int", "5",
        "Ab diesem Restbestand meldet das Werkzeug „get_low_stock“ einen "
        "Werkstoff als knapp. 0 zeigt nur leere Bestände.", 0, 1000, 1,
    ),
    SettingField(
        "agent_orchestration_enabled", "Orchestrierung aktiv", "assistant", "bool", "false",
        "Erlaubt dem Assistenten, mehrere spezialisierte Agenten und Routinen "
        "in einem Lauf zu orchestrieren. Aus heißt: jeder Agent arbeitet für sich.",
    ),

    # ---- Websuche --------------------------------------------------------
    SettingField(
        "agent_web_enabled", "Websuche aktiv", "web", "bool", "true",
        "Erlaubt dem Modell, im Web zu suchen und einzelne Seiten zu lesen. "
        "Aus heißt: keine Netzwerkwerkzeuge und keine Treffer im Prompt.",
    ),
    SettingField(
        "agent_web_provider", "Suchdienst", "web", "select", "duckduckgo",
        "DuckDuckGo braucht keinen Schlüssel. SearXNG ist eine eigene Instanz. "
        "Tavily und Brave sind Schlüsseldienste mit besserer Trefferqualität.",
        options=(
            ("duckduckgo", "DuckDuckGo (ohne Schlüssel)"),
            ("searxng", "SearXNG (eigene Instanz)"),
            ("tavily", "Tavily (Schlüssel)"),
            ("brave", "Brave Search (Schlüssel)"),
        ),
    ),
    SettingField(
        "agent_web_base_url", "SearXNG-Adresse", "web", "text", "",
        "Nur für SearXNG, z. B. http://127.0.0.1:8080. Die JSON-Schnittstelle "
        "muss in der Instanz freigeschaltet sein.",
    ),
    SettingField(
        "agent_web_api_key", "API-Schlüssel", "web", "secret", "",
        "Für Tavily oder Brave. Wird versiegelt gespeichert und nie "
        "zurückgegeben. Alternativ aus der Umgebung "
        f"({ENV_PREFIX}AGENT_WEB_API_KEY).", secret=True,
    ),
    SettingField(
        "agent_web_max_results", "Treffer je Suche", "web", "int", "5",
        "Mehr Treffer kosten Kontext. Fünf reichen für die meisten Fragen.",
        1, 10, 1,
    ),
    SettingField(
        "agent_web_region", "Region", "web", "text", "de-de",
        "Regionscode für die Suche, z. B. de-de oder en-us.", 2, 20, None,
    ),
    SettingField(
        "agent_web_safesearch", "Sicherheitssuche", "web", "select", "moderate",
        "Steuert die Filterung des Suchdienstes.", options=(
            ("off", "aus"), ("moderate", "moderat"), ("strict", "streng"),
        ),
    ),
    SettingField(
        "agent_web_timeout_s", "Zeitlimit Suche (s)", "web", "int", "12",
        "Gilt je Suchanfrage und je Seitenabruf.", 3, 30, 1,
    ),
    SettingField(
        "agent_web_allow_private", "Lokale Adressen erlauben", "web", "bool", "false",
        "Nötig für eine SearXNG-Instanz im LAN. Aus schützt das Werkzeug "
        "davor, interne Dienste abzufragen (SSRF).",
    ),
    SettingField(
        "agent_web_fetch_chars", "Zeichen je Webseite", "web", "int", "20000",
        "So viel Text wird aus einer abgerufenen Seite an das Modell gegeben.",
        2000, 80000, 1000,
    ),

    # ---- Anhänge und PDF -------------------------------------------------
    SettingField(
        "agent_attach_max_mb", "Größe je Anhang (MB)", "files", "int", "15",
        "Höchstgröße einer hochgeladenen Datei.", 1, 50, 1,
    ),
    SettingField(
        "agent_attach_max_chars", "Zeichen je Anhang", "files", "int", "300000",
        "Obergrenze des extrahierten Texts einer Datei.", 10000, 1000000, 1000,
    ),
    SettingField(
        "agent_attach_per_file_chars", "Zeichen je Datei im Prompt", "files", "int", "60000",
        "So viel Text einer Datei sieht das Modell in einem Lauf.", 5000, 200000, 1000,
    ),
    SettingField(
        "agent_attach_budget_chars", "Zeichen aller Anhänge im Prompt", "files", "int",
        "120000", "Gesamtbudget aller Anhänge einer Nachricht.", 10000, 500000, 1000,
    ),
    SettingField(
        "agent_pdf_max_pages", "PDF-Seiten je Datei", "files", "int", "250",
        "Mehr Seiten werden nicht in einem Durchgang gelesen. Eine Seitenauswahl "
        "beim Hochladen hat Vorrang.", 1, 2000, 1,
    ),
    SettingField(
        "agent_pdf_ocr", "Texterkennung (OCR)", "files", "select", "auto",
        "Scannt eine PDF ohne Textebene. „auto“ liest nur Seiten ohne Text, "
        "„immer“ alle, „aus“ keine. Braucht tesseract und pdftoppm.", options=(
            ("auto", "automatisch"), ("always", "immer"), ("off", "aus"),
        ),
    ),
    SettingField(
        "agent_pdf_ocr_max_pages", "OCR höchstens (Seiten)", "files", "int", "40",
        "Notbremse für Scans: mehr Seiten werden nicht per OCR gelesen.",
        0, 500, 1,
    ),
    SettingField(
        "agent_pdf_ocr_lang", "OCR-Sprache", "files", "text", "deu+eng",
        "Sprachpakete von tesseract, mit + getrennt.", 2, 40, None,
    ),
    # ---- Sprache --------------------------------------------------------
    SettingField(
        "agent_tts_backend", "Sprachausgabe", "voice", "select", "lokal",
        "„lokal“ spricht mit Piper auf diesem Rechner, kein Text verlässt ihn. "
        "„Microsoft“ schickt den Antworttext an Microsofts Vorlesedienst (USA, "
        "inoffizieller Zugang, kein Vertrag mit FyreFly) — nur mit Testdaten.",
        options=(("lokal", "lokal (Piper)"), ("edge", "Microsoft (Cloud, nur Testdaten)")),
    ),
    SettingField(
        "agent_pdf_ocr_dpi", "OCR-Auflösung (dpi)", "files", "int", "200",
        "Höher liest kleine Schrift besser, braucht aber mehr Zeit.", 100, 400, 25,
    ),

    # ---- Container-Sandbox (temporäre Arbeitsumgebung) ------------------
    SettingField(
        "agent_sandbox_enabled", "Container-Sandbox aktiv", "sandbox", "bool", "true",
        "Erlaubt dem Assistenten, pro Chat eine isolierte, temporäre Container-Umgebung "
        "(/workspace) für Python, Skripte, Datenanalysen und Dateiverarbeitung zu erstellen.",
    ),
    SettingField(
        "agent_sandbox_profile", "Leistungsprofil", "sandbox", "select", "standard",
        "Voreinstellung für Container-Ressourcen. „Extensiv (Hard Work)“ richtet viel RAM, "
        "mehrere CPUs, großen Workspace/tmpfs und lange Laufzeiten für schwere Aufgaben ein.",
        options=(
            ("standard", "Standard (leicht: 512 MB · 1 CPU · 30 s)"),
            ("heavy", "Intensiv (Analyse: 2 GB · 2 CPUs · 3 Min.)"),
            ("extensive", "Extensiv / Hard Work (8 GB · 4 CPUs · 10 Min.)"),
            ("custom", "Benutzerdefiniert (Einzelwerte unten)"),
        ),
    ),
    SettingField(
        "agent_sandbox_backend", "Container-Laufzeit", "sandbox", "select", "auto",
        "„auto“ nutzt Docker wenn erreichbar, sonst Bubblewrap (Linux-Namespaces). "
        "Ohne unterstützte Laufzeit wird nie unsicher auf dem Host ausgeführt.",
        options=(
            ("auto", "automatisch (Docker → Bubblewrap)"),
            ("docker", "Docker-Container"),
            ("bwrap", "Bubblewrap (Linux-Namespaces)"),
        ),
    ),
    SettingField(
        "agent_sandbox_image", "Docker-Standardimage", "sandbox", "text", "python:3.11-slim",
        "Basis-Image für temporäre Docker-Container, z. B. python:3.11-slim oder ubuntu:22.04.",
        2, 128, None,
    ),
    SettingField(
        "agent_sandbox_memory_mb", "Speicherlimit je Container (MB)", "sandbox", "int", "512",
        "Arbeitsspeicher-Obergrenze eines temporären Containers (bis 32768 MB für schwere Analysen/Builds).",
        128, 32768, 128,
    ),
    SettingField(
        "agent_sandbox_cpus", "CPU-Kerne je Container", "sandbox", "float", "1.0",
        "Maximale CPU-Zuteilung eines einzelnen Containers (z. B. 4 oder 6 für parallele Berechnungen).",
        0.25, 32.0, 0.25,
    ),
    SettingField(
        "agent_sandbox_timeout_s", "Zeitlimit je Befehl (s)", "sandbox", "int", "30",
        "Bricht einzelne Shell- oder Python-Läufe im Container nach dieser Zeit ab (bis 3600 s = 1 Std.).",
        5, 3600, 5,
    ),
    SettingField(
        "agent_sandbox_ttl_min", "Auto-Bereinigung bei Inaktivität (Min.)", "sandbox", "int", "20",
        "Stoppt und löscht ungenutzte temporäre Container samt /workspace nach dieser Zeit (bis 1440 Min. = 24 Std.).",
        2, 1440, 5,
    ),
    SettingField(
        "agent_sandbox_workspace_mb", "Workspace-Speicherlimit (MB)", "sandbox", "int", "128",
        "Maximale Gesamtgröße aller Dateien in /workspace (bis 16384 MB für große Datensätze/Builds).",
        32, 16384, 64,
    ),
    SettingField(
        "agent_sandbox_tmpfs_mb", "RAM-Tempdir /tmp (MB)", "sandbox", "int", "128",
        "Größe des schnellen /tmp-Speichers im Container (wichtig für Compiler, pip, große Zwischenergebnisse).",
        32, 8192, 64,
    ),
    SettingField(
        "agent_sandbox_pids_limit", "Max. Prozesse / Threads (PIDs)", "sandbox", "int", "256",
        "Obergrenze paralleler Prozesse/Threads (höher setzen für NumPy/OpenBLAS, Multiprocessing oder Builds).",
        32, 4096, 32,
    ),
    SettingField(
        "agent_sandbox_max_files", "Max. Dateien in /workspace", "sandbox", "int", "2000",
        "Dateizahl-Limit pro temporärer Umgebung (höher für Pakete, Build-Artefakte oder große Datenmengen).",
        100, 50000, 100,
    ),
    SettingField(
        "agent_sandbox_output_kb", "Ausgabe-Budget je Befehl (KB)", "sandbox", "int", "64",
        "Maximale erfasste stdout/stderr-Menge pro Befehl (höher für umfangreiche Logs oder Benchmarks).",
        16, 512, 16,
    ),
    SettingField(
        "agent_sandbox_max_concurrent", "Max. gleichzeitige Container", "sandbox", "int", "4",
        "Begrenzt, wie viele Chats parallel eine aktive Container-Umgebung halten dürfen.",
        1, 20, 1,
    ),
    SettingField(
        "agent_sandbox_allow_swap", "Swap-Puffer erlauben (2× RAM)", "sandbox", "bool", "false",
        "Erlaubt bei Lastspitzen bis zum Doppelten des RAM-Limits inkl. Swap statt sofortigem OOM-Abbruch.",
    ),
    SettingField(
        "agent_sandbox_allow_exec_tmp", "Ausführung in /tmp erlauben", "sandbox", "bool", "false",
        "Nötig für schwere Builds, Compiler, Cython/Numba oder pip-Pakete, die Binaries in /tmp entpacken.",
    ),
    SettingField(
        "agent_sandbox_network", "Netzwerk im Container erlauben", "sandbox", "bool", "false",
        "Standardmäßig AUS (--network none). Aktivieren, wenn im Container Pakete (z. B. pip) geladen werden sollen.",
    ),
    SettingField(
        "agent_sandbox_gpu", "GPU-Durchreichung (NVIDIA --gpus all)", "sandbox", "bool", "false",
        "Reicht lokale NVIDIA-GPUs an Docker-Container durch (erfordert NVIDIA Container Toolkit).",
    ),
)

BY_KEY: dict[str, SettingField] = {item.key: item for item in FIELDS}


class SettingsError(ValueError):
    def __init__(self, detail: str, status: int = 422) -> None:
        super().__init__(detail)
        self.detail, self.status = detail, status


def _legacy(db: Session, key: str) -> str | None:
    """Ein alter Wert aus Gimels ``settings`` — nur wenn dort wirklich eine Zeile steht."""
    try:
        from gimel.models import Setting

        row = db.get(Setting, key)
        return row.value if row else None
    except Exception:  # noqa: BLE001 - die Tabelle ist optional
        return None


def raw(db: Session, key: str) -> str:
    field = BY_KEY.get(key)
    if field is None:
        raise SettingsError(f"Unbekannte Einstellung „{key}“.")
    row = db.get(AgentSetting, key)
    if row is not None:
        return row.value
    legacy = _legacy(db, key)
    return field.default if legacy is None else legacy


def read(db: Session, key: str) -> str:
    """Der Wert, wie ihn der Assistent braucht. Geheimnisse werden geöffnet."""
    field = BY_KEY.get(key)
    if field is None:
        raise SettingsError(f"Unbekannte Einstellung „{key}“.")
    value = raw(db, key)
    if field.secret and value:
        return secretbox.open_(value)
    return value


def _env_key() -> str:
    return (
        os.environ.get(f"{ENV_PREFIX}AGENT_WEB_API_KEY")
        or os.environ.get("AGENT_WEB_API_KEY")
        or ""
    )


def web_api_key(db: Session) -> str:
    value = read(db, "agent_web_api_key")
    return value or _env_key()


def has_web_key(db: Session) -> bool:
    return bool(web_api_key(db))


def get(db: Session, key: str) -> str:
    return read(db, key)


def get_bool(db: Session, key: str) -> bool:
    return raw(db, key).strip().lower() in ("1", "true", "yes", "ja", "on")


def get_int(db: Session, key: str) -> int:
    field = BY_KEY[key]
    try:
        return int(float(raw(db, key)))
    except (TypeError, ValueError):
        return int(float(field.default))


def get_float(db: Session, key: str) -> float:
    field = BY_KEY[key]
    try:
        return float(raw(db, key))
    except (TypeError, ValueError):
        return float(field.default)


def _validate(field: SettingField, value: str) -> str:
    value = (value or "").strip()
    if field.kind == "bool":
        return "true" if value.lower() in ("1", "true", "yes", "ja", "on") else "false"
    if field.kind == "int":
        try:
            number = int(float(value))
        except (TypeError, ValueError) as exc:
            raise SettingsError(f"„{field.label}“ braucht eine ganze Zahl.") from exc
        if field.minimum is not None and number < field.minimum:
            raise SettingsError(f"„{field.label}“ ist mindestens {int(field.minimum)}.")
        if field.maximum is not None and number > field.maximum:
            raise SettingsError(f"„{field.label}“ ist höchstens {int(field.maximum)}.")
        return str(number)
    if field.kind == "float":
        try:
            number = float(value.replace(",", "."))
        except (TypeError, ValueError) as exc:
            raise SettingsError(f"„{field.label}“ braucht eine Zahl.") from exc
        if field.minimum is not None and number < field.minimum:
            raise SettingsError(f"„{field.label}“ ist mindestens {field.minimum:g}.")
        if field.maximum is not None and number > field.maximum:
            raise SettingsError(f"„{field.label}“ ist höchstens {field.maximum:g}.")
        return f"{number:g}"
    if field.kind == "select":
        allowed = {key for key, _ in field.options}
        if value not in allowed:
            raise SettingsError(f"„{field.label}“ hat einen unbekannten Wert.")
        return value
    if field.kind == "text":
        if field.minimum is not None and len(value) < field.minimum:
            raise SettingsError(f"„{field.label}“ ist zu kurz.")
        if field.maximum is not None and len(value) > field.maximum:
            raise SettingsError(
                f"„{field.label}“ ist höchstens {int(field.maximum)} Zeichen lang."
            )
        return value[:4000]
    return value[:4000]


def set_value(db: Session, key: str, value: str, actor: str = "") -> None:
    field = BY_KEY.get(key)
    if field is None:
        raise SettingsError(f"Unbekannte Einstellung „{key}“.")
    clean = _validate(field, value)
    try:
        stored = secretbox.seal(clean) if field.secret and clean else clean
    except RuntimeError as exc:
        raise SettingsError(
            "Der Schlüssel kann ohne Betriebsschlüssel nicht gespeichert werden.", 503
        ) from exc
    row = db.get(AgentSetting, key)
    if row is None:
        row = AgentSetting(key=key)
        db.add(row)
    row.value = stored
    row.updated_by = actor[:254]
    row.updated_at = datetime.now(timezone.utc)


def public(db: Session) -> dict:
    """Werte für die Oberfläche: Geheimnisse bleiben draußen."""
    values: dict[str, str] = {}
    for field in FIELDS:
        if field.secret:
            values[field.key] = ""
        else:
            values[field.key] = raw(db, field.key)
    return {
        "values": values,
        "has_web_key": has_web_key(db),
        "web_key_source": (
            "env" if _env_key() else ("database" if read(db, "agent_web_api_key") else "none")
        ),
        "fields": [
            {
                "key": field.key, "label": field.label, "group": field.group,
                "kind": field.kind, "default": field.default, "help": field.help,
                "min": field.minimum, "max": field.maximum, "step": field.step,
                "options": [{"value": k, "label": v} for k, v in field.options],
                "secret": field.secret,
            }
            for field in FIELDS
        ],
    }


def reset(db: Session, keys: list[str] | None = None, actor: str = "") -> None:
    for key in (keys or [item.key for item in FIELDS]):
        row = db.get(AgentSetting, key)
        if row is not None:
            db.delete(row)
