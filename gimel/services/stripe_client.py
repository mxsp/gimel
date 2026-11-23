"""Stripe-Anbindung des Auftragsbüros — genau eine Stelle, die den Schlüssel liest.

Der Bestellportalserver (server.js, Port 3000) liest STRIPE_SECRET_KEY ohne
Präfix aus .env. Dieses Backend liest seine Einstellungen mit ALPHA_-Präfix;
zwei konkurrierende Konventionen für dasselbe Geheimnis wären eine davon
falsch. Deshalb gilt hier, in dieser einen Datei, die Auflösung:

  1. STRIPE_SECRET_KEY          (wie das Bestellportal — dieselbe .env)
  2. ALPHA_STRIPE_SECRET_KEY    (präfixiert, für dedizierte Backend-Setups)

Das SDK wird erst beim ersten Gebrauch importiert: ohne Schlüssel läuft der
Dienst — Rechnungen sind dann nicht eingerichtet, aber nichts stürzt ab.
"""

from __future__ import annotations
from ..config import API_ROOT as _APP_ROOT
from ..config import ENV_PREFIX

import os
from functools import lru_cache
from pathlib import Path

from ..config import get_settings

API_ROOT = _APP_ROOT                               # apps/api
REPO_ROOT = API_ROOT.parent.parent                 # Projektwurzel (dort liegt .env)


@lru_cache(maxsize=1)
def secret_key() -> str:
    """Der Stripe-Schlüssel — siehe Moduldokumentation für die Auflösung."""
    key = (os.environ.get("STRIPE_SECRET_KEY")
           or os.environ.get(ENV_PREFIX + "STRIPE_SECRET_KEY") or "")
    if key:
        return key
    # .env der Projektwurzel — die Datei, aus der auch das Bestellportal liest.
    for env_file in (API_ROOT / ".env", REPO_ROOT / ".env"):
        if not env_file.is_file():
            continue
        for line in env_file.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if line.startswith("STRIPE_SECRET_KEY="):
                key = line.split("=", 1)[1].strip().strip('"').strip("'")
                if key:
                    return key
    return ""


def webhook_secret() -> str:
    explicit = (os.environ.get("STRIPE_WEBHOOK_SECRET")
                or get_settings().stripe_webhook_secret)
    if explicit:
        return explicit
    for env_file in (API_ROOT / ".env", REPO_ROOT / ".env"):
        if not env_file.is_file():
            continue
        for line in env_file.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if line.startswith("STRIPE_WEBHOOK_SECRET="):
                v = line.split("=", 1)[1].strip().strip('"').strip("'")
                if v:
                    return v
    return ""


class StripeUnavailable(RuntimeError):
    """Rechnungswesen nicht eingerichtet — der Aufrufer antwortet 503."""


def client():
    """Das Stripe-SDK oder eine klare Antwort, warum es keins gibt."""
    key = secret_key()
    if not key:
        raise StripeUnavailable(
            "Rechnungswesen ist nicht eingerichtet (STRIPE_SECRET_KEY fehlt).")
    try:
        import stripe
    except ImportError as exc:                              # pragma: no cover
        raise StripeUnavailable(
            "Das Stripe-Paket ist nicht installiert (pip install stripe).") from exc
    stripe.api_key = key
    return stripe
