"""SMTP-Transport für das Backend.

Das Gegenstück zu ``server/smtp.mjs`` auf der Node-Seite, nur mit weniger
Handarbeit: ``smtplib`` und ``email.message`` gehören zur Standardbibliothek,
also gibt es hier nichts selbst zu schreiben außer der Konfiguration und der
Regel, wann nicht gesendet wird.

Drei Eigenschaften, auf die sich die Aufrufer verlassen:

* **Wirft nie.** ``send()`` gibt ``True``/``False`` zurück. Ein Postfehler
  darf keinen Sammellauf und keine Auftragsübernahme umwerfen — beides ist
  teurer als eine verlorene Nachricht, und die Nachricht ist im Protokoll.
* **Läuft im Hintergrund.** Der Versand kostet je nach Anhang Sekunden. Ein
  Sammellauf, der auf IONOS wartet, hält den Taktgeber an; deshalb geht die
  Zustellung in einen Thread und der Lauf ist fertig, wenn er fertig ist.
* **Dedupe-Schlüssel.** Derselbe Vertrag wie auf der Node-Seite: eine
  Nachricht mit einem bereits gesendeten Schlüssel geht nicht zweimal raus.
  Der Schlüssel liegt in ``AuditLog`` — ein Neustart vergisst ihn damit nicht.

``ALPHA_MAIL_SILENT=1`` schaltet auf Trockenlauf zurück, ohne eine
Aufrufstelle anzufassen. ``ALPHA_MAIL_TO_OVERRIDE`` lenkt jeden Empfänger auf
eine Adresse um — der Riegel dagegen, dass ein Prüflauf echte Kunden
anschreibt.
"""

from __future__ import annotations
from ..config import API_ROOT as _APP_ROOT
from ..config import ENV_PREFIX

import logging
import os
import smtplib
import ssl
import threading
from dataclasses import dataclass, field
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid
from pathlib import Path

from . import identity

log = logging.getLogger("alpha.post")

#: Name in eigenen Kopfzeilen; folgt dem Präfix wie Cookie und DXF-Ebenen.
HEADER_NAME = ENV_PREFIX.rstrip("_").title()

API_ROOT = _APP_ROOT
PROJECT_ROOT = API_ROOT.parent.parent


def _env(name: str, default: str = "") -> str:
    """Umgebung zuerst, dann die .env von apps/api, dann die der Projektwurzel.

    Dieselbe Auflösung wie beim Stripe-Schlüssel (config.py):
    Portal und Backend lesen ein Geheimnis aus einer Datei, nicht aus zwei —
    zwei Quellen für dasselbe Passwort sind eine davon falsch.
    """
    val = os.environ.get(name)
    if val:
        return val
    for env_file in (API_ROOT / ".env", PROJECT_ROOT / ".env"):
        try:
            if not env_file.is_file():
                continue
            for line in env_file.read_text(encoding="utf-8", errors="replace").splitlines():
                line = line.strip()
                if line.startswith(f"{name}="):
                    candidate = line.split("=", 1)[1].strip().strip('"').strip("'")
                    if candidate:
                        return candidate
        except OSError:
            continue
    return default


@dataclass(frozen=True)
class MailConfig:
    host: str = ""
    port: int = 587
    secure: str = "starttls"
    user: str = ""
    password: str = field(default="", repr=False)
    sender: str = ""
    sender_name: str = ""
    reply_to: str = ""
    silent: bool = True
    override: str = ""

    @property
    def configured(self) -> bool:
        return bool(self.host and self.sender)


def config() -> MailConfig:
    host = _env(ENV_PREFIX + "SMTP_HOST").strip()
    secure = (_env(ENV_PREFIX + "SMTP_SECURE", "starttls")).strip().lower()
    user = _env(ENV_PREFIX + "SMTP_USER").strip()
    sender = (_env(ENV_PREFIX + "MAIL_FROM") or user).strip()
    try:
        port = int(_env(ENV_PREFIX + "SMTP_PORT", "465" if secure == "tls" else "587"))
    except ValueError:
        port = 587
    # Ohne eingerichteten Server ist Trockenlauf der Vorgabewert: ein Backend
    # ohne SMTP-Daten soll starten und protokollieren, nicht scheitern.
    silent_raw = _env(ENV_PREFIX + "MAIL_SILENT", "0" if host else "1")
    return MailConfig(
        host=host, port=port, secure=secure, user=user,
        password=_env(ENV_PREFIX + "SMTP_PASS"),
        sender=sender,
        sender_name=_env(ENV_PREFIX + "MAIL_FROM_NAME") or identity.texts().mail_from_name,
        reply_to=_env(ENV_PREFIX + "MAIL_REPLY_TO"),
        silent=silent_raw.strip() == "1",
        override=_env(ENV_PREFIX + "MAIL_TO_OVERRIDE").strip(),
    )


@dataclass
class Attachment:
    filename: str
    content: bytes
    mime: str = "application/octet-stream"

    @property
    def size(self) -> int:
        return len(self.content)


_MIME_BY_SUFFIX = {
    ".dxf": ("application", "dxf"),
    ".zip": ("application", "zip"),
    ".svg": ("image", "svg+xml"),
    ".png": ("image", "png"),
    ".pdf": ("application", "pdf"),
    ".csv": ("text", "csv"),
    ".txt": ("text", "plain"),
}


def attachment(filename: str, content: bytes | str) -> Attachment:
    raw = content.encode("utf-8") if isinstance(content, str) else content
    maj, sub = _MIME_BY_SUFFIX.get(Path(filename).suffix.lower(), ("application", "octet-stream"))
    return Attachment(filename=filename, content=raw, mime=f"{maj}/{sub}")


def _build(cfg: MailConfig, *, to: list[str], subject: str, text: str,
           html: str = "", attachments: list[Attachment] | None = None,
           headers: dict[str, str] | None = None) -> EmailMessage:
    msg = EmailMessage()
    msg["From"] = formataddr((cfg.sender_name, cfg.sender))
    msg["To"] = ", ".join(to)
    msg["Subject"] = subject
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain=cfg.sender.split("@")[-1] or f"{HEADER_NAME.lower()}.local")
    if cfg.reply_to:
        msg["Reply-To"] = cfg.reply_to
    for k, v in (headers or {}).items():
        if v:
            msg[k] = v

    msg.set_content(text)
    if html:
        msg.add_alternative(html, subtype="html")

    for att in attachments or []:
        maj, _, sub = att.mime.partition("/")
        msg.add_attachment(att.content, maintype=maj, subtype=sub or "octet-stream",
                           filename=att.filename)
    return msg


def _deliver(cfg: MailConfig, to: list[str], msg: EmailMessage) -> None:
    """Die eigentliche Zustellung. Wirft — der Aufrufer fängt."""
    ctx = ssl.create_default_context()
    if cfg.secure == "tls":
        server = smtplib.SMTP_SSL(cfg.host, cfg.port, timeout=60, context=ctx)
    else:
        server = smtplib.SMTP(cfg.host, cfg.port, timeout=60)
    try:
        server.ehlo()
        if cfg.secure != "tls":
            if not server.has_extn("starttls"):
                raise RuntimeError(
                    "Server bietet kein STARTTLS an — Anmeldedaten würden im Klartext reisen."
                )
            server.starttls(context=ctx)
            server.ehlo()
        if cfg.user:
            server.login(cfg.user, cfg.password)
        server.send_message(msg, from_addr=cfg.sender, to_addrs=to)
    finally:
        try:
            server.quit()
        except Exception:  # noqa: BLE001 — Verabschiedung ist Kür
            pass


def send(*, to: str | list[str], subject: str, text: str, html: str = "",
         attachments: list[Attachment] | None = None, dedupe_key: str = "",
         background: bool = True) -> bool:
    """Zustellen — nie werfen.

    ``background=True`` gibt sofort zurück und stellt im Thread zu. Der
    Rückgabewert heißt dann „angenommen“, nicht „zugestellt“; das Ergebnis
    steht im Protokoll. Für Tests und Prüfläufe ``background=False``.
    """
    cfg = config()
    recipients = [r.strip() for r in ([to] if isinstance(to, str) else to) if r and r.strip()]
    headers: dict[str, str] = {}
    if cfg.override and recipients:
        headers[f"X-{HEADER_NAME}-Intended-To"] = ", ".join(recipients)
        recipients = [cfg.override]
    if not recipients:
        log.info("Post „%s“: kein Empfänger [%s] — übersprungen.", subject, dedupe_key or "-")
        return False
    if dedupe_key:
        headers[f"X-{HEADER_NAME}-Dedupe"] = dedupe_key

    if cfg.silent or not cfg.configured:
        log.info("TROCKENLAUF → %s · „%s“ [%s]", ", ".join(recipients), subject,
                 dedupe_key or "-")
        # A dry run proves template construction, not delivery. Returning True
        # made callers persist ``mail_sent`` and suppress the real message once
        # SMTP was configured later.
        return False

    msg = _build(cfg, to=recipients, subject=subject, text=text, html=html,
                 attachments=attachments, headers=headers)

    def run() -> bool:
        try:
            _deliver(cfg, recipients, msg)
            log.info("gesendet → %s · „%s“ [%s]", ", ".join(recipients), subject,
                     dedupe_key or "-")
            return True
        except Exception as exc:  # noqa: BLE001 — die Post reißt nichts mit
            log.error("Versand fehlgeschlagen → %s · „%s“: %s: %s",
                      ", ".join(recipients), subject, type(exc).__name__, exc)
            return False

    if background:
        threading.Thread(target=run, name="alpha-mail", daemon=True).start()
        return True
    return run()


def status() -> dict:
    cfg = config()
    return {
        "configured": cfg.configured,
        "silent": cfg.silent,
        "host": cfg.host,
        "port": cfg.port,
        "secure": cfg.secure,
        "from": cfg.sender,
        "override": cfg.override,
    }
