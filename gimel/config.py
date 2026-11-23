"""Konfiguration aus der Umgebung.

PostgreSQL ist das Ziel (CLAUDE.md §3). Ohne gesetzte DATABASE_URL läuft die
Anwendung gegen eine lokale SQLite-Datei, damit Tests und ein erster Start ohne
Serverinstallation möglich sind — das Schema bleibt dabei Postgres-tauglich.
"""

from __future__ import annotations

import os
import secrets
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

APP_DIR = Path(__file__).resolve().parent

#: Präfix aller Einstellungen. Eine Anwendung auf Gimel kann ihren eigenen setzen,
#: bevor sie diese Datei lädt (Alef: ``ALPHA_``); die .env im Betrieb bleibt dann
#: unverändert. Allein läuft Gimel mit ``GIMEL_``.
ENV_PREFIX = os.environ.get("GIMEL_ENV_PREFIX", "GIMEL_")
STANDALONE = ENV_PREFIX == "GIMEL_"

#: Wurzel der Anwendung: dort liegen ihre .env und, ohne eigene Einstellung, ihre
#: Datenbank. Allein ist das der Datenordner des Benutzers.
API_ROOT = Path(
    os.environ.get("GIMEL_APP_ROOT")
    or os.environ.get("GIMEL_DATA")
    or Path.home() / ".local/share/gimel"
)


def _env_value(name: str) -> str:
    """Ein Wert aus der .env der Projektwurzel bzw. apps/api — ohne sie in
    die Umgebung zu laden. Für Schlüssel ohne ALPHA_-Präfix, die das
    Bestellportal und dieses Backend gemeinsam lesen."""
    for env_file in (API_ROOT / ".env", API_ROOT.parent.parent / ".env"):
        try:
            if not env_file.is_file():
                continue
            for line in env_file.read_text(
                encoding="utf-8", errors="replace"
            ).splitlines():
                line = line.strip()
                if line.startswith(f"{name}="):
                    candidate = line.split("=", 1)[1].strip().strip('"').strip("'")
                    if candidate:
                        return candidate
        except OSError:
            continue
    return ""


class Settings(BaseSettings):
    # Zuerst die .env des Datenordners (z. B. eine lokale Demo-PIN), dann die
    # .env des Arbeitsverzeichnisses. Spätere Dateien gewinnen; die Umgebung
    # gewinnt immer.
    model_config = SettingsConfigDict(
        env_prefix=ENV_PREFIX,
        env_file=(str(API_ROOT / ".env"), ".env"),
        extra="ignore",
    )

    env: str = "development"
    database_url: str = f"sqlite:///{API_ROOT / ('gimel.db' if STANDALONE else 'alpha.db')}"
    database_pool_size: int = 20
    database_max_overflow: int = 30

    secret_key: str = secrets.token_urlsafe(48)
    #: Nur für den Schlüsselwechsel: der alte ALPHA_SECRET_KEY, mit dem
    #: secretbox gespeicherte Geheimnisse noch ENTschlüsseln darf, bis
    #: scripts/reseal_secrets.py sie neu versiegelt hat. Signiert und prüft
    #: nie ein Token — ein geleakter alter Schlüssel darf keins mehr fälschen.
    #: Nach dem Neuversiegeln wieder entfernen.
    secret_key_previous: str = ""
    access_token_minutes: int = 30
    refresh_token_days: int = 30

    #: Allein liefert Gimel seine Oberfläche selbst aus, also braucht es keinen fremden
    #: Ursprung. Die Liste gilt für eine Anwendung, deren Portal auf einem Nachbar-Port läuft.
    cors_origins: str = "" if STANDALONE else "http://127.0.0.1:3000,http://localhost:3000,http://127.0.0.1:8000,http://localhost:8000,http://127.0.0.1:8001,http://localhost:8001"

    bootstrap_admin_email: str = "" if STANDALONE else "admin@fyreflysystems.de"
    #: Leer = kein Erstzugang; allein legt ``gimel adduser`` das erste Konto an.
    bootstrap_admin_password: str = "" if STANDALONE else "alpha-admin"

    staff_pin: str = "" if STANDALONE else "2468"
    #: Gimel-PIN (routers/auth.py pin_login): bcrypt-Hash, erzeugt mit
    #: ``python -m scripts.set_gimel_pin``. Ist er gesetzt, meldet die PIN nicht
    #: mehr den ersten Admin an (die alte Test-PIN 2468), sondern das
    #: Betriebskonto ``gimel_account`` mit Rolle staff — gedrosselt, mit Sperre
    #: und Protokoll. Leer = keine Gimel-PIN.
    gimel_pin_hash: str = ""
    gimel_account: str = "betrieb@gimel.invalid" if STANDALONE else "betrieb@fyreflysystems.de"
    #: Wie lange eine PIN-Sitzung hält (Refresh). Kürzer als die 30 Tage einer
    #: persönlichen Anmeldung: die PIN teilen sich mehrere Menschen.
    gimel_session_hours: int = 12
    #: Absender, denen X-Forwarded-For geglaubt wird (der Pförtner hinter der
    #: QEMU-Weiterleitung: 10.0.2.2). Dieselbe Variable wie im Portal (server.js).
    trust_proxy: str = ""
    #: Weitere erlaubte Host-Namen (hostguard.py), Komma getrennt; ``*.x.de`` für
    #: Unterdomänen, ``*`` schaltet die Prüfung ab. Immer erlaubt: localhost und
    #: jede IP-Adresse. Nur nötig, wenn ein Dienst die API unter einem Namen
    #: anspricht (z. B. ``ALPHA_API_URL=http://alef-api:8001``).
    allowed_hosts: str = ""
    #: Datenschlüssel für die Feldverschlüsselung (fieldcrypt.py):
    #: ``kennung:base64url(32 Byte)``, mehrere mit Komma, der erste schreibt.
    #: Leer = Klartext wie bisher. Nie aus SECRET_KEY abgeleitet.
    data_keys: str = ""

    portal_token: str = ""
    sap_base_url: str = ""
    sap_user: str = ""
    sap_password: str = ""
    sap_client: str = ""

    # Auftragsbüro / Rechnungen (routers/invoicing.py). Der Schlüssel selbst
    # wird bewusst NICHT hier gelesen, sondern in services/stripe_client.py:
    # die .env des Bestellportals trägt ihn ohne ALPHA_-Präfix, und zwei
    # Quellen für dasselbe Geheimnis wären eine davon falsch.
    stripe_webhook_secret: str = ""
    invoice_due_days: int = 14

    # KI-Angebot (routers/ai_quote.py) — der Schlüssel kommt vom Betreiber
    # und wird als Property gelesen (siehe unten), damit auch die .env der
    # Projektwurzel ohne ALPHA_-Präfix gilt.

    # UPS-Sendungsverfolgung (services/ups_tracking.py). Die Schlüssel werden
    # wie der Gemini-Schlüssel ohne ALPHA_-Präfix gelesen — siehe Properties
    # unten. Nur die Basis-URL ist eine gewöhnliche Einstellung (Testumgebung:
    # ALPHA_UPS_BASE_URL=https://wwwcie.ups.com).
    ups_base_url: str = "https://onlinetools.ups.com"

    @property
    def ups_client_id(self) -> str:
        """UPS-Client-ID — env ohne Präfix vor dem ALPHA_-Präfix."""
        import os as _os

        return (
            _os.environ.get("UPS_CLIENT_ID")
            or _os.environ.get(ENV_PREFIX + "UPS_CLIENT_ID")
            or ""
        )

    @property
    def ups_client_secret(self) -> str:
        """UPS-Client-Secret — env ohne Präfix vor dem ALPHA_-Präfix."""
        import os as _os

        return (
            _os.environ.get("UPS_CLIENT_SECRET")
            or _os.environ.get(ENV_PREFIX + "UPS_CLIENT_SECRET")
            or ""
        )

    @property
    def ups_account_number(self) -> str:
        """UPS-Kontonummer — env ohne Präfix vor dem ALPHA_-Präfix."""
        import os as _os

        return (
            _os.environ.get("UPS_ACCOUNT_NUMBER")
            or _os.environ.get(ENV_PREFIX + "UPS_ACCOUNT_NUMBER")
            or ""
        )

    @property
    def cors_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def gemini_api_key(self) -> str:
        """Der Gemini-Schlüssel — Umgebung vor .env, dieselbe Auflösung wie
        der Stripe-Schlüssel (services/stripe_client.py)."""
        import os as _os

        return (
            _os.environ.get("GEMINI_API_KEY")
            or _os.environ.get(ENV_PREFIX + "GEMINI_API_KEY")
            or _env_value("GEMINI_API_KEY")
            or ""
        )

    @property
    def gemini_model(self) -> str:
        """Modellname: Umgebung vor .env vor dem Standard.

        ``gemini-flash-latest`` ist ein wanderner Alias auf das aktuelle
        Flash-Modell — die festen Namen werden nach eineinhalb Jahren
        abgeschaltet (gemini-2.0-flash: 404 im August 2026), der Alias nicht.
        Wer ein Modell festpinnen will, setzt GEMINI_MODEL.
        """
        import os as _os

        return (
            _os.environ.get("GEMINI_MODEL")
            or _os.environ.get(ENV_PREFIX + "GEMINI_MODEL")
            or _env_value("GEMINI_MODEL")
            or "gemini-flash-latest"
        )

    @property
    def gimel_pin_enabled(self) -> bool:
        return bool(self.gimel_pin_hash)

    def is_production(self) -> bool:
        return self.env.lower() in ("production", "prod")

    def validate_production(self) -> None:
        # Gesetzt heißt: aus der Umgebung ODER aus der .env (pydantic liest
        # beide). Bis 2026-10-25 zählte nur os.environ — die VM-Dienste laden
        # ihre .env aber über pydantic, nicht über systemd, und ALPHA_ENV=
        # production hätte die API beim Start abbrechen lassen. Ohne Wert
        # gälte der Zufallsschlüssel der Voreinstellung, und jeder Neustart
        # entwertete alle Sitzungen und Tickets.
        if self.is_production() and not (os.environ.get(ENV_PREFIX + "SECRET_KEY")
                                         or "secret_key" in self.model_fields_set):
            raise RuntimeError(f"{ENV_PREFIX}SECRET_KEY muss in Produktion gesetzt sein")
        if self.is_production():
            if len(self.secret_key) < 32:
                raise RuntimeError(f"{ENV_PREFIX}SECRET_KEY muss mindestens 32 Zeichen lang sein")
            if self.bootstrap_admin_password == "alpha-admin":
                raise RuntimeError("Produktionsbetrieb mit Standard-Adminpasswort ist nicht erlaubt")
            if "*" in self.cors_list:
                raise RuntimeError("CORS-Ursprünge müssen in Produktion explizit gesetzt sein")
            if len(self.portal_token) < 32:
                raise RuntimeError(f"{ENV_PREFIX}PORTAL_TOKEN muss mindestens 32 Zeichen lang sein")


@lru_cache
def get_settings() -> Settings:
    return Settings()
