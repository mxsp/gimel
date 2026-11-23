"""Compliance-API (EU Cyber Resilience Act) für alle FyreFly-Produkte.

Öffentlich, ohne Anmeldung (die Compliance-Seite der Website liest und schreibt hier):

    GET  /api/compliance/advisories            veröffentlichte Sicherheitshinweise
    GET  /api/compliance/advisories/{ref}      ein Hinweis
    GET  /api/compliance/support-periods       Supportzeiträume je Produkt
    POST /api/compliance/reports               Schwachstelle melden (CVD-Eingang)

Personal (nur intern über /app bzw. das lokale Netz — Portal-Proxy und Gate lassen
/api/compliance/admin/* bewusst nicht durch):

    GET   /api/compliance/admin/reports        Meldungen sichten
    PATCH /api/compliance/admin/reports/{ref}  Status, Schwere, Notiz, Hinweis
    GET   /api/compliance/admin/advisories     alle Hinweise inkl. Entwürfe
    POST  /api/compliance/admin/advisories     Hinweis anlegen (Entwurf)
    PATCH /api/compliance/admin/advisories/{ref}  bearbeiten / veröffentlichen
    PUT   /api/compliance/admin/support-periods   Supportzeiträume ersetzen (Admin)

Eine Meldung wird immer zuerst gespeichert, dann gemeldet: ein Trockenlauf des
Mailers (kein SMTP) darf keine Meldung verlieren. Kontaktdaten der Meldenden werden
nach Abschluss und Frist gelöscht (purge_reporter_contacts, beim Start).
"""
from __future__ import annotations
from ..config import ENV_PREFIX

import hashlib
import logging
from datetime import datetime, timedelta, timezone
from typing import Annotated, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..models import (
    AuditLog,
    SecurityAdvisory,
    SecuritySeverity,
    SupportPeriod,
    User,
    VulnerabilityReport,
    VulnerabilityReportStatus,
)
from ..security import require_admin, require_staff
from ..extensions import active
from ..services import identity, smtp_client
from ..services.compliance import _aware, purge_reporter_contacts, retention_days  # noqa: F401

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/compliance", tags=["compliance"])

PRODUCTS = ("gimel", "other")
Product = Literal["gimel", "other"]
CLOSED = {VulnerabilityReportStatus.fixed, VulnerabilityReportStatus.rejected, VulnerabilityReportStatus.duplicate}

PER_IP_PER_HOUR = 3
GLOBAL_PER_HOUR = 30


def security_contact() -> str:
    return smtp_client._env(ENV_PREFIX + "SECURITY_CONTACT") or identity.texts().security_contact


def security_recipients() -> list[str]:
    """Wer neue Meldungen bekommt (kommagetrennt); ohne Eintrag die Sicherheitsadresse."""
    raw = smtp_client._env(ENV_PREFIX + "SECURITY_EMAIL") or security_contact()
    return [a.strip() for a in raw.split(",") if a.strip()]


def _next_ref(db: Session, model, letters: str) -> str:
    year = datetime.now(timezone.utc).strftime("%y")
    prefix = f"{letters}-{year}-"
    numbers = (
        int(ref[len(prefix):])
        for (ref,) in db.query(model.ref).filter(model.ref.like(f"{prefix}%")).all()
        if ref.startswith(prefix) and ref[len(prefix):].isdigit()
    )
    return f"{prefix}{max(numbers, default=0) + 1:04d}"


def _ip_hash(request: Request) -> str:
    ip = request.client.host if request.client else ""
    return hashlib.sha256(f"{get_settings().secret_key}|vr|{ip}".encode()).hexdigest()


def _iso(dt: datetime | None) -> str | None:
    dt = _aware(dt)
    return dt.isoformat() if dt else None


def _advisory_out(a: SecurityAdvisory, internal: bool = False) -> dict:
    out = {
        "ref": a.ref, "title": a.title, "product": a.product, "affected": a.affected,
        "fixed_in": a.fixed_in, "severity": a.severity.value, "cve": list(a.cve or []),
        "summary": a.summary, "remediation": a.remediation, "credit": a.credit,
        "published_at": _iso(a.published_at),
    }
    if internal:
        out.update(published=a.published, created_at=_iso(a.created_at), updated_at=_iso(a.updated_at))
    return out


def _report_out(r: VulnerabilityReport) -> dict:
    return {
        "ref": r.ref, "product": r.product, "version": r.version, "title": r.title,
        "description": r.description, "impact": r.impact, "exploited": r.exploited,
        "reporter_name": r.reporter_name, "reporter_email": r.reporter_email, "credit": r.credit,
        "status": r.status.value, "severity": r.severity.value if r.severity else None,
        "triage_note": r.triage_note, "advisory_ref": r.advisory_ref,
        "created_at": _iso(r.created_at), "updated_at": _iso(r.updated_at),
        "closed_at": _iso(r.closed_at), "contact_purged": r.contact_purged_at is not None,
    }


def _support_out(s: SupportPeriod) -> dict:
    return {
        "product": s.product, "component": s.component, "version": s.version, "kind": s.kind,
        "security_support_until": _iso(s.security_support_until),
        "note_de": s.note_de, "note_en": s.note_en,
    }


DEFAULT_SUPPORT = (
    ("gimel", "Gimel", "", "distributed",
     "Sicherheitsupdates entsprechend dem jeweiligen Release-Stand (siehe SECURITY.md).",
     "Security updates according to the respective release policy (see SECURITY.md)."),
)


def _ensure_support_defaults(db: Session) -> None:
    if db.query(SupportPeriod).count():
        return
    # Ohne Anwendung gibt es hier nur Gimel, nicht die Produkte einer fremden Firma.
    rows = DEFAULT_SUPPORT if active() else [r for r in DEFAULT_SUPPORT if r[0] == "gimel"]
    for i, (product, component, version, kind, de, en) in enumerate(rows):
        db.add(SupportPeriod(product=product, component=component, version=version, kind=kind,
                             note_de=de, note_en=en, sort=i, updated_by="system"))
    db.commit()


# --------------------------------------------------------------------------
# Öffentlich
# --------------------------------------------------------------------------
@router.get("/advisories")
def list_advisories(db: Annotated[Session, Depends(get_db)], product: Optional[Product] = None):
    q = db.query(SecurityAdvisory).filter(SecurityAdvisory.published.is_(True))
    if product:
        q = q.filter(SecurityAdvisory.product == product)
    rows = q.order_by(SecurityAdvisory.published_at.desc(), SecurityAdvisory.id.desc()).all()
    return {"advisories": [_advisory_out(a) for a in rows], "contact": security_contact()}


@router.get("/advisories/{ref}")
def get_advisory(ref: str, db: Annotated[Session, Depends(get_db)]):
    a = db.query(SecurityAdvisory).filter(SecurityAdvisory.ref == ref, SecurityAdvisory.published.is_(True)).first()
    if not a:
        raise HTTPException(404, "Sicherheitshinweis nicht gefunden.")
    return _advisory_out(a)


@router.get("/support-periods")
def list_support_periods(db: Annotated[Session, Depends(get_db)]):
    _ensure_support_defaults(db)
    rows = db.query(SupportPeriod).order_by(SupportPeriod.sort, SupportPeriod.id).all()
    return {"support_periods": [_support_out(s) for s in rows]}


class ReportIn(BaseModel):
    product: Product
    version: str = Field(default="", max_length=80)
    title: str = Field(min_length=5, max_length=200)
    description: str = Field(min_length=30, max_length=10000)
    impact: str = Field(default="", max_length=4000)
    exploited: bool = False
    reporter_name: str = Field(default="", max_length=160)
    reporter_email: EmailStr
    credit: bool = False
    consent: bool
    # Honigtopf: Menschen sehen das Feld nicht; wer es füllt, ist ein Bot.
    website: str = Field(default="", max_length=200)


@router.post("/reports", status_code=201)
def submit_report(body: ReportIn, request: Request, db: Annotated[Session, Depends(get_db)]):
    if not body.consent:
        raise HTTPException(422, "Bitte der Verarbeitung Ihrer Angaben zur Bearbeitung der Meldung zustimmen.")
    if body.website:
        log.info("Schwachstellenmeldung verworfen (Honigtopf)")
        return {"status": "received", "reference": None}

    now = datetime.now(timezone.utc)
    hour_ago = now - timedelta(hours=1)
    ip = _ip_hash(request)
    recent = db.query(VulnerabilityReport).filter(VulnerabilityReport.created_at > hour_ago)
    if recent.filter(VulnerabilityReport.ip_hash == ip).count() >= PER_IP_PER_HOUR \
            or recent.count() >= GLOBAL_PER_HOUR:
        raise HTTPException(429, f"Zu viele Meldungen in kurzer Zeit. Bitte später erneut versuchen oder an {security_contact()} schreiben.")

    report = VulnerabilityReport(
        ref=_next_ref(db, VulnerabilityReport, "VR"), product=body.product, version=body.version.strip(),
        title=body.title.strip(), description=body.description.strip(), impact=body.impact.strip(),
        exploited=body.exploited, reporter_name=body.reporter_name.strip(),
        reporter_email=str(body.reporter_email).strip().lower(), credit=body.credit, ip_hash=ip,
    )
    db.add(report)
    db.add(AuditLog(actor="public", action="vr_received", entity="vulnerability_report", entity_id=report.ref,
                    detail={"product": body.product, "exploited": body.exploited}))
    db.commit()
    log.warning("Schwachstellenmeldung %s (%s, ausgenutzt=%s)", report.ref, report.product, report.exploited)

    urgent = "DRINGEND – aktiv ausgenutzt – " if report.exploited else ""
    smtp_client.send(
        to=security_recipients(),
        subject=f"[Security] {urgent}{report.ref}: {report.title}",
        text=(f"Neue Schwachstellenmeldung {report.ref}\n\nProdukt: {report.product} {report.version}\n"
              f"Aktiv ausgenutzt: {'ja' if report.exploited else 'nein'}\n"
              f"Melder: {report.reporter_name or '-'} <{report.reporter_email}>\n\n"
              f"{report.description}\n\nAuswirkung:\n{report.impact or '-'}\n\n"
              "Wird eine aktive Ausnutzung bestätigt: Frühwarnung binnen 24 h über die ENISA "
              "Single Reporting Platform (Art. 14 CRA)."),
        dedupe_key=f"vr:{report.ref}",
    )
    brand = identity.texts(db)
    subject = f"Ihre Sicherheitsmeldung {report.ref} / your security report"
    signature = " · ".join(p for p in (brand.signature, security_contact(), brand.security_url) if p)
    smtp_client.send(
        to=report.reporter_email,
        subject=f"{brand.security_sender}: {subject}" if brand.security_sender else subject,
        text=(f"Vielen Dank für Ihre Meldung. Wir haben sie unter {report.ref} erfasst und melden uns "
              "innerhalb von drei Werktagen.\n\n"
              f"Thank you for your report. We registered it as {report.ref} and will get back to you "
              "within three working days.\n\n"
              f"{signature}"),
        dedupe_key=f"vr-ack:{report.ref}",
    )
    return {"status": "received", "reference": report.ref,
            "message": "Meldung erfasst. Eine Bestätigung geht an Ihre E-Mail-Adresse."}


# --------------------------------------------------------------------------
# Personal
# --------------------------------------------------------------------------
@router.get("/admin/reports", dependencies=[Depends(require_staff)])
def admin_list_reports(db: Annotated[Session, Depends(get_db)],
                       status: Optional[VulnerabilityReportStatus] = None):
    q = db.query(VulnerabilityReport)
    if status:
        q = q.filter(VulnerabilityReport.status == status)
    return {"reports": [_report_out(r) for r in q.order_by(VulnerabilityReport.id.desc()).all()]}


class ReportPatch(BaseModel):
    status: Optional[VulnerabilityReportStatus] = None
    severity: Optional[SecuritySeverity] = None
    triage_note: Optional[str] = Field(default=None, max_length=10000)
    advisory_ref: Optional[str] = Field(default=None, max_length=20)


@router.patch("/admin/reports/{ref}")
def admin_update_report(ref: str, body: ReportPatch, db: Annotated[Session, Depends(get_db)],
                        actor: Annotated[User, Depends(require_staff)]):
    r = db.query(VulnerabilityReport).filter(VulnerabilityReport.ref == ref).first()
    if not r:
        raise HTTPException(404, "Meldung nicht gefunden.")
    # exclude_unset, not exclude_none: an explicit null clears severity or the advisory link.
    changes = body.model_dump(exclude_unset=True)
    if changes.get("status") is None:
        changes.pop("status", None)
    if "advisory_ref" in changes:
        changes["advisory_ref"] = changes["advisory_ref"] or ""
    if "triage_note" in changes:
        changes["triage_note"] = changes["triage_note"] or ""
    if "advisory_ref" in changes and changes["advisory_ref"] and not db.query(SecurityAdvisory).filter(
            SecurityAdvisory.ref == changes["advisory_ref"]).first():
        raise HTTPException(422, "Sicherheitshinweis nicht gefunden.")
    for key, value in changes.items():
        setattr(r, key, value)
    if body.status is not None:
        if body.status not in CLOSED:
            r.closed_at = None
        elif r.closed_at is None:  # moving between closed states keeps the first closing date (retention runs from it)
            r.closed_at = datetime.now(timezone.utc)
    db.add(AuditLog(actor=actor.email, action="vr_update", entity="vulnerability_report", entity_id=r.ref,
                    detail={k: (v.value if hasattr(v, "value") else v) for k, v in changes.items() if k != "triage_note"}))
    db.commit()
    return _report_out(r)


@router.get("/admin/advisories", dependencies=[Depends(require_staff)])
def admin_list_advisories(db: Annotated[Session, Depends(get_db)]):
    rows = db.query(SecurityAdvisory).order_by(SecurityAdvisory.id.desc()).all()
    return {"advisories": [_advisory_out(a, internal=True) for a in rows]}


class AdvisoryIn(BaseModel):
    title: str = Field(min_length=5, max_length=200)
    product: Product
    affected: str = Field(default="", max_length=200)
    fixed_in: str = Field(default="", max_length=80)
    severity: SecuritySeverity = SecuritySeverity.medium
    cve: list[Annotated[str, Field(pattern=r"^CVE-\d{4}-\d{4,}$")]] = Field(default_factory=list, max_length=20)
    summary: str = Field(default="", max_length=10000)
    remediation: str = Field(default="", max_length=10000)
    credit: str = Field(default="", max_length=160)


class AdvisoryPatch(BaseModel):
    title: Optional[str] = Field(default=None, min_length=5, max_length=200)
    product: Optional[Product] = None
    affected: Optional[str] = Field(default=None, max_length=200)
    fixed_in: Optional[str] = Field(default=None, max_length=80)
    severity: Optional[SecuritySeverity] = None
    cve: Optional[list[Annotated[str, Field(pattern=r"^CVE-\d{4}-\d{4,}$")]]] = Field(default=None, max_length=20)
    summary: Optional[str] = Field(default=None, max_length=10000)
    remediation: Optional[str] = Field(default=None, max_length=10000)
    credit: Optional[str] = Field(default=None, max_length=160)
    published: Optional[bool] = None


@router.post("/admin/advisories", status_code=201)
def admin_create_advisory(body: AdvisoryIn, db: Annotated[Session, Depends(get_db)],
                          actor: Annotated[User, Depends(require_staff)]):
    a = SecurityAdvisory(ref=_next_ref(db, SecurityAdvisory, "FSA"), **body.model_dump())
    db.add(a)
    db.add(AuditLog(actor=actor.email, action="advisory_create", entity="security_advisory", entity_id=a.ref))
    db.commit()
    return _advisory_out(a, internal=True)


@router.patch("/admin/advisories/{ref}")
def admin_update_advisory(ref: str, body: AdvisoryPatch, db: Annotated[Session, Depends(get_db)],
                          actor: Annotated[User, Depends(require_staff)]):
    a = db.query(SecurityAdvisory).filter(SecurityAdvisory.ref == ref).first()
    if not a:
        raise HTTPException(404, "Sicherheitshinweis nicht gefunden.")
    changes = {k: v for k, v in body.model_dump(exclude_unset=True).items()
               if v is not None or k in ("affected", "fixed_in", "summary", "remediation", "credit")}
    for key, value in changes.items():
        setattr(a, key, "" if value is None else value)
    if body.published is True and a.published_at is None:
        a.published_at = datetime.now(timezone.utc)
    action = "advisory_publish" if body.published is True else (
        "advisory_unpublish" if body.published is False else "advisory_update")
    db.add(AuditLog(actor=actor.email, action=action, entity="security_advisory", entity_id=a.ref))
    db.commit()
    return _advisory_out(a, internal=True)


class SupportPeriodIn(BaseModel):
    product: Product
    component: str = Field(min_length=2, max_length=120)
    version: str = Field(default="", max_length=40)
    kind: Literal["hosted", "distributed"] = "hosted"
    security_support_until: Optional[datetime] = None
    note_de: str = Field(default="", max_length=400)
    note_en: str = Field(default="", max_length=400)


@router.put("/admin/support-periods")
def admin_replace_support_periods(body: Annotated[list[SupportPeriodIn], Field(max_length=50)],
                                  db: Annotated[Session, Depends(get_db)],
                                  actor: Annotated[User, Depends(require_admin)]):
    db.query(SupportPeriod).delete()
    for i, item in enumerate(body):
        db.add(SupportPeriod(**item.model_dump(), sort=i, updated_by=actor.email))
    db.add(AuditLog(actor=actor.email, action="support_periods_replace", entity="support_period",
                    entity_id=str(len(body))))
    db.commit()
    return list_support_periods(db)
