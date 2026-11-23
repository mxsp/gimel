"""Pydantic-Schemata — die Vertragsfläche der API.

Die Feldnamen folgen der Datenbank (snake_case). Der Prototyp im Browser
spricht camelCase; die Umsetzung passiert an genau einer Stelle, in
routers/products.py bzw. im Admin-Frontend, nicht verstreut.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from .models import Role


# --------------------------------------------------------------------------
# Auth & Benutzer
# --------------------------------------------------------------------------
class Token(BaseModel):
    """Die Antwort jeder Anmeldung — vollständig oder halb.

    Seit dem zweiten Faktor (2026-09) kann eine richtige Passworteingabe noch
    keine Sitzung bedeuten. Statt dafür einen zweiten Antworttyp einzuführen,
    trägt dieser eine ausdrückliche Weiche: ``mfa_required`` heißt „Passwort
    stimmt, Faktor fehlt", ``access_token`` ist dann leer und ``mfa_token``
    das kurzlebige Ticket für ``POST /api/auth/2fa``.

    Warum kein 401 mit Zusatzfeld: 401 heißt für jeden Zwischenlayer
    „abgelehnt", und ein Browser, der darauf seine Anmeldemaske neu zeigt,
    verschluckt den halben Fortschritt. Der Kunde hat sich korrekt
    ausgewiesen — das ist kein Fehler, das ist ein Zwischenstand.
    """

    access_token: str
    token_type: str = "bearer"
    role: Role
    email: str
    name: str = ""
    #: Darf die Betriebs-Bildschirme pflegen (Admin oder PIN-Konto); ``role`` bleibt, was es ist.
    admin_work: bool = False
    #: Zweiter Faktor steht aus. Der Client zeigt die Codeeingabe.
    mfa_required: bool = False
    #: Kurzlebiges Ticket (Minuten), nur für /api/auth/2fa brauchbar.
    mfa_token: str = ""


class PinLogin(BaseModel):
    pin: str


class MfaLogin(BaseModel):
    """Zweiter Schritt der Anmeldung: das Ticket plus der Code.

    ``code`` nimmt beides an — sechs Ziffern aus der App oder einen
    Wiederherstellungscode. Ein eigenes Feld je Art wäre eine Entscheidung,
    die der Kunde nicht treffen muss: was er tippt, sagt schon, was es ist.
    """

    mfa_token: str
    code: str = Field(min_length=4, max_length=40)


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    email: str
    name: str
    company: str
    role: Role
    active: bool
    price_group: str
    discount_pct: float
    payment_terms: str
    customer_no: str
    created_at: datetime
    last_login: Optional[datetime] = None
    email_verified: bool = False
    #: Ob der zweite Faktor an ist. Gehört in dieselbe Antwort wie der Rest der
    #: Stammdaten, damit die Kontoseite nicht zwei Runden braucht, um zu
    #: wissen, was sie anzeigen soll.
    totp_enabled: bool = False
    #: Sperren nach Fehlversuchen — damit die Benutzerverwaltung sie zeigen und aufheben kann.
    locked_until: Optional[datetime] = None
    mfa_locked_until: Optional[datetime] = None
    failed_login_count: int = 0


class UserCreate(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=200)
    name: str = ""
    company: str = ""
    role: Role = Role.customer
    price_group: str = "standard"
    discount_pct: float = Field(default=0.0, ge=0, le=100)
    payment_terms: str = "30 Tage netto"
    customer_no: str = ""


class UserUpdate(BaseModel):
    """Alle Felder optional — ein PATCH ändert nur, was mitgeschickt wird."""

    name: Optional[str] = None
    company: Optional[str] = None
    role: Optional[Role] = None
    active: Optional[bool] = None
    price_group: Optional[str] = None
    discount_pct: Optional[float] = Field(default=None, ge=0, le=100)
    payment_terms: Optional[str] = None
    customer_no: Optional[str] = None


class PasswordSet(BaseModel):
    password: str = Field(min_length=8, max_length=200)


class PasswordChange(BaseModel):
    current_password: str
    #: Siehe RegisterRequest.password — geprüft wird in check_password_strength.
    new_password: str = Field(max_length=400)
    #: Pflicht, sobald am Konto ein zweiter Faktor eingeschaltet ist.
    code: str = Field(default="", max_length=40)


# --------------------------------------------------------------------------
# Werkstoffe
# --------------------------------------------------------------------------
class ProductBase(BaseModel):
    sku: str = ""
    name: str
    short: str = ""
    brand: str = ""
    cat: str
    colour: str = "#888888"
    blurb: str = ""
    eur_m2: float = Field(gt=0, description="Einkaufs-/Kalkulationspreis in €/m²")
    #: Verkaufspreis je Dicke (VK €/m², {"1": …, "1.5": …}) aus der Einkaufsliste.
    #: EK → VK mit ×2 (1,0/1,5/3,0 mm) bzw. ×1,5 (2,0 mm). Ohne Eintrag rechnet
    #: der Kern mit eur_m2.
    eur_m2_thk: Optional[dict[str, float]] = Field(default=None)
    sheets: list[list[float]] = Field(default_factory=list)
    thicknesses: list[float] = Field(default_factory=list)
    t_min: Optional[float] = None
    t_max: Optional[float] = None
    t_peak: Optional[float] = None
    p_max: Optional[float] = None
    media: dict[str, int] = Field(default_factory=dict)
    approvals: list[str] = Field(default_factory=list)
    cnc: str = "check"
    kerf: Optional[float] = None
    web: Optional[float] = None
    #: Mindeststeg im Teil (Loch-/Ringstege). Nicht der Spannrand `web`.
    min_web: Optional[float] = None
    # Werkstoffrichtung — Schranke der Dreh- und Spiegeloption des Rechenkerns
    # (2.9.0-lite). "axis" = Textur/Materialwelle ({0°, 180°}), "directed" =
    # einseitige Beschichtung (nur 0°, keine Spiegelung). Eine gedrehte Lage
    # auf gerichtetem Werkstoff ist Ausschuss, der richtig aussieht.
    grain: str = "none"
    flip_ok: bool = True
    stock: int = 0
    lead_days: int = 0
    url: str = ""
    datasheet_url: str = ""
    active: bool = True
    verified: dict[str, bool] = Field(default_factory=dict)

    @field_validator("grain")
    @classmethod
    def _grain_known(cls, v: str) -> str:
        if v not in ("none", "axis", "directed"):
            raise ValueError("grain muss none, axis oder directed sein.")
        return v

    @field_validator("sheets")
    @classmethod
    def _sheets_shape(cls, v: list[list[float]]) -> list[list[float]]:
        for s in v:
            if len(s) != 2 or s[0] <= 0 or s[1] <= 0:
                raise ValueError(
                    "Jedes Plattenformat braucht Breite und Höhe in mm, beide > 0."
                )
        return v


#: Bekannte Gruppen und Schneidbarkeit (seed_data.json "categories", engine CNC).
PRODUCT_CATS = ("elastomer", "ptfe", "graphit", "faser", "hochtemp")
PRODUCT_CNC = ("confirmed", "likely", "check")


def _check_thicknesses(v):
    if v is None:
        return v
    vals = [float(t) for t in v]
    if any(t <= 0 for t in vals):
        raise ValueError("Dicken müssen größer als 0 mm sein.")
    if len(set(vals)) != len(vals):
        raise ValueError("Jede Dicke nur einmal angeben.")
    return sorted(vals)


def _check_thk_prices(v):
    if v is None:
        return v
    out: dict[str, float] = {}
    for key, value in v.items():
        try:
            t = float(key)
        except (TypeError, ValueError):
            raise ValueError(f"Dickensatz „{key}“: die Dicke muss eine Zahl in mm sein.")
        if t <= 0:
            raise ValueError("Dickensätze brauchen eine Dicke größer als 0 mm.")
        if value is None or float(value) <= 0:
            raise ValueError(f"Dickensatz {t:g} mm: der Preis muss größer als 0 €/m² sein.")
        out[f"{t:g}"] = round(float(value), 4)
    return out


class _ProductInputChecks(BaseModel):
    """Prüfungen für alles, was in den Katalog *hineingeht* (Anlegen und Ändern).

    Bis 2026-10 hatte ProductUpdate keine davon: ein PATCH mit {"grain": "x"}
    oder {"sheets": [[0, 0]]} wurde gespeichert, die Antwort scheiterte danach
    an ProductOut — und ab da lieferte GET /api/products für alle 500.
    """

    @field_validator("cat", check_fields=False)
    @classmethod
    def _cat_known(cls, v):
        if v is not None and v not in PRODUCT_CATS:
            raise ValueError("Gruppe muss eine von " + ", ".join(PRODUCT_CATS) + " sein.")
        return v

    @field_validator("cnc", check_fields=False)
    @classmethod
    def _cnc_known(cls, v):
        if v is not None and v not in PRODUCT_CNC:
            raise ValueError("Schneidbarkeit muss confirmed, likely oder check sein.")
        return v

    @field_validator("thicknesses", check_fields=False)
    @classmethod
    def _thk(cls, v):
        return _check_thicknesses(v)

    @field_validator("eur_m2_thk", check_fields=False)
    @classmethod
    def _thk_prices(cls, v):
        return _check_thk_prices(v)


class ProductCreate(_ProductInputChecks, ProductBase):
    id: str = Field(min_length=2, max_length=60, pattern=r"^[a-z0-9][a-z0-9\-]*$")

    @field_validator("sheets")
    @classmethod
    def _at_least_one_sheet(cls, v):
        # Ohne Format fällt der Werkstoff still aus der Kalkulation; dieselbe
        # Regel gilt beim Ändern (ProductUpdate._sheets_shape).
        if not v:
            raise ValueError("Mindestens ein Plattenformat angeben — ohne Format ist der Werkstoff nicht kalkulierbar.")
        return v


class ProductUpdate(_ProductInputChecks):
    """Alle Felder optional — ein PATCH ändert nur, was mitgeschickt wird.

    Ein ausdrückliches null leert die Felder, die leer sein dürfen
    (``NULLABLE_PRODUCT_FIELDS``); bei allen anderen bedeutet null „unverändert“.
    """

    sku: Optional[str] = Field(default=None, max_length=60)
    name: Optional[str] = Field(default=None, min_length=1, max_length=160)
    short: Optional[str] = Field(default=None, max_length=80)
    brand: Optional[str] = Field(default=None, max_length=80)
    cat: Optional[str] = None
    colour: Optional[str] = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    blurb: Optional[str] = Field(default=None, max_length=2000)
    eur_m2: Optional[float] = Field(default=None, gt=0, le=100000)
    eur_m2_thk: Optional[dict[str, float]] = Field(default=None)
    price_reason: Optional[str] = Field(
        default=None,
        max_length=400,
        description="Grund der Preisänderung — landet im Preisverlauf",
    )
    sheets: Optional[list[list[float]]] = None
    thicknesses: Optional[list[float]] = None
    t_min: Optional[float] = None
    t_max: Optional[float] = None
    t_peak: Optional[float] = None
    p_max: Optional[float] = Field(default=None, ge=0)
    media: Optional[dict[str, int]] = None
    approvals: Optional[list[str]] = None
    cnc: Optional[str] = None
    kerf: Optional[float] = Field(default=None, ge=0, le=50)
    web: Optional[float] = Field(default=None, ge=0, le=500)
    min_web: Optional[float] = Field(default=None, ge=0, le=500)
    grain: Optional[str] = None
    flip_ok: Optional[bool] = None
    stock: Optional[int] = None
    lead_days: Optional[int] = Field(default=None, ge=0, le=365)
    url: Optional[str] = Field(default=None, max_length=400)
    datasheet_url: Optional[str] = Field(default=None, max_length=400)
    active: Optional[bool] = None
    verified: Optional[dict[str, bool]] = None

    @field_validator("grain")
    @classmethod
    def _grain_known(cls, v):
        if v is not None and v not in ("none", "axis", "directed"):
            raise ValueError("grain muss none, axis oder directed sein.")
        return v

    @field_validator("sheets")
    @classmethod
    def _sheets_shape(cls, v):
        if v is None:
            return v
        if not v:
            # Ohne Format fällt der Werkstoff still aus der Kalkulation (catalog.load_products).
            raise ValueError("Mindestens ein Plattenformat angeben — ohne Format ist der Werkstoff nicht kalkulierbar.")
        for s in v:
            if len(s) != 2 or s[0] <= 0 or s[1] <= 0:
                raise ValueError("Jedes Plattenformat braucht Breite und Höhe in mm, beide > 0.")
        return v


NULLABLE_PRODUCT_FIELDS = ("t_min", "t_max", "t_peak", "p_max", "kerf", "web", "min_web")


class ProductOut(ProductBase):
    model_config = ConfigDict(from_attributes=True)

    id: str
    uses: int = 0
    updated_at: Optional[datetime] = None


class PriceHistoryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    product_id: str
    thk: Optional[float] = None
    old_eur_m2: float
    new_eur_m2: float
    reason: str
    changed_by: str
    changed_at: datetime


# --------------------------------------------------------------------------
# Lagermanagement
# --------------------------------------------------------------------------
class StockMovementOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    product_id: str
    delta: int
    balance_after: int
    reason: str
    note: str
    work_order_no: str
    actor: str
    created_at: datetime


class StockRow(BaseModel):
    """Eine Zeile der Lagerübersicht — Bestand plus, was das Personal vor der
    nächsten Bestellung wissen muss."""

    id: str
    name: str
    short: str
    cat: str
    stock: int
    lead_days: int
    sheets: list[list[float]]
    active: bool
    last_movement_at: Optional[datetime] = None
    #: Verfügbare Reststücke dieses Werkstoffs (alle Dicken) — zählen nicht als Platten.
    offcuts: int = 0


class StockAdjust(BaseModel):
    """Manuelle Bestandsänderung — Wareneingang oder Korrektur nach Zählung.
    ``sammellauf`` bleibt dem Sammellauf vorbehalten und ist hier kein
    gültiger Grund, damit im Verlauf System- und Handbuchung unterscheidbar
    bleiben."""

    delta: int = Field(
        description="Platten — positiv Wareneingang, negativ Korrektur nach unten"
    )
    reason: str = Field(default="korrektur", pattern=r"^(einkauf|korrektur)$")
    note: str = Field(default="", max_length=400)

    @field_validator("delta")
    @classmethod
    def _not_zero(cls, v: int) -> int:
        if v == 0:
            raise ValueError("Bestandsänderung darf nicht 0 sein.")
        return v


class BulkPriceChange(BaseModel):
    """Preisrunde über mehrere Werkstoffe — der übliche Fall, wenn der
    Lieferant die Liste anhebt."""

    product_ids: list[str] = Field(
        default_factory=list, description="leer = alle aktiven Werkstoffe"
    )
    category: Optional[str] = None
    pct: Optional[float] = Field(
        default=None, ge=-90, le=200, description="Änderung in Prozent"
    )
    set_eur_m2: Optional[float] = Field(
        default=None, gt=0, description="Fixpreis statt Prozent"
    )
    reason: str = Field(min_length=3, max_length=400)
    dry_run: bool = True


class BulkPriceRow(BaseModel):
    id: str
    name: str
    old_eur_m2: float
    new_eur_m2: float


class BulkPriceResult(BaseModel):
    dry_run: bool
    changed: int
    rows: list[BulkPriceRow]


class MatrixRow(BaseModel):
    """Eine Zeile der Werkstoffmatrix: Werkstoff, Preis, Plattenformate."""

    id: str
    eur_m2: float = Field(gt=0)
    sheets: list[list[float]] = Field(default_factory=list)
    #: Dickensätze (VK €/m² je Dicke). Fehlt das Feld, ziehen vorhandene Sätze
    #: mit einer Änderung von eur_m2 im selben Verhältnis mit.
    eur_m2_thk: Optional[dict[str, float]] = None

    @field_validator("eur_m2_thk")
    @classmethod
    def _thk_prices(cls, v):
        return _check_thk_prices(v)

    @field_validator("sheets")
    @classmethod
    def _shape(cls, v: list[list[float]]) -> list[list[float]]:
        if not v:
            raise ValueError("Ohne Plattenformat lässt sich nichts schachteln.")
        for s in v:
            if len(s) != 2 or s[0] <= 0 or s[1] <= 0:
                raise ValueError(
                    "Jedes Format braucht Breite und Höhe in mm, beide > 0."
                )
        return v


class MatrixSave(BaseModel):
    """Sammeländerung aus der Matrix. Preisänderungen brauchen wie überall
    einen Grund — sonst fällt das Prüf-Häkchen."""

    rows: list[MatrixRow]
    reason: str = ""


class MatrixSaveResult(BaseModel):
    updated: int
    price_changes: int
    sheet_changes: int


# --------------------------------------------------------------------------
# Sätze
# --------------------------------------------------------------------------
class RateOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    key: str
    value: float
    unit: str
    note: str
    verified: bool
    updated_at: Optional[datetime] = None
    updated_by: str = ""


class RateUpdate(BaseModel):
    value: float
    note: Optional[str] = Field(default=None, max_length=400)
    verified: Optional[bool] = None
    #: Grund der Änderung — wie beim Werkstoffpreis: ohne Grund ist der neue
    #: Wert wieder ein Richtwert (verified=False).
    reason: Optional[str] = Field(default=None, max_length=400)


# --------------------------------------------------------------------------
# Kalkulation
# --------------------------------------------------------------------------
class QuoteLine(BaseModel):
    id: int
    kind: str = "gasket"
    mat: str
    #: Höchstmenge je Position. Muss mit MAX_QTY in server/stripe-routes.mjs
    #: übereinstimmen: die Kasse bepreist und kassiert nach ihrer Grenze, die
    #: Übernahme weist nach dieser hier ab — und zwar mit 422, also endgültig.
    #: Standen die beiden auf 999 und 500, war das Ergebnis ein bezahlter
    #: Auftrag ohne Auftragsnummer, den die Werkstatt nie zu sehen bekam.
    q: int = Field(default=1, ge=1, le=1_000_000)
    thk: float = 2.0
    label: str = ""
    od: float = 0.0
    di: float = 0.0
    bn: int = 0
    bd: float = 0.0
    bc: float = 0.0
    cut_len: float = 0.0
    fmt: Optional[list[float]] = None
    #: Beschreibung einer freien Position (kind="custom") — was gefertigt oder
    #: zugekauft wird. Intern: steht auf Laufkarte und in der Fertigung.
    desc: str = ""
    #: Kundenhinweis einer freien Position (kind="custom") — erscheint auf
    #: Rechnung/Beleg und im Kundenportal. Interne Details bleiben außen vor.
    external_note: str = Field(default="", max_length=500)
    #: Bruttopreis je Stück einer freien Position. Nur bei kind="custom"
    #: ausgewertet: der Rechenkern rechnet ihn auf netto zurück und lässt ihn
    #: aus Schachtelung und Rüstanteil heraus (domain/pricing.price_cart).
    price_gross: float = Field(default=0.0, ge=0)
    #: Formfamilie aus dem Konfigurator ("norm", "ring", "rect", "oval",
    #: "dxf", "saved") — bestimmt die Rüststufe der festen Einrichtung
    #: (2.10.0-lite). Leer bei alten Warenkörben: dann entscheidet die Kontur.
    fam: str = ""
    #: Gezeichnete Kontur aus geometry.js — ``{outer, holes, bolts}``.
    #: **Preisrelevant, seit 2.5.0-lite die Fläche und 2.7.0-lite die Lage
    #: daraus nimmt.** Ohne sie rechnet der Kern die Position als volle Scheibe
    #: ihres Umkreises — eine unsymmetrische Dichtung 279 × 216 mm als Ø 353 mm,
    #: also 0,098 m² statt 0,057 m². Genau daran lief die Übernahme
    #: auseinander und sperrte bezahlte Aufträge (services/orders.lines_to_domain).
    #: Stromabwärts hängen ausserdem Laufkarte, Plattenbild und Schnittdatei
    #: daran. Fehlt sie, ist die Position ein Ring aus ``od``/``di``.
    shape: Optional[dict] = None
    #: Form aus der Hausbibliothek, wenn die Position dort übernommen wurde.
    #: Die Kontur reist weiter in ``shape``; diese Kennung hält die Herkunft
    #: fest, damit Form, Auftrag und Innenauftrag aufeinander verweisen können.
    shape_id: Optional[int] = Field(default=None, ge=1)


class QuoteRequest(BaseModel):
    lines: list[QuoteLine]
    cert: str = "2.2"
    plate: dict[str, int] = Field(default_factory=dict)
    vat_rate: Optional[float] = None
    #: Handerfasste Versandkosten (manueller Versand) statt der Pauschale.
    #: Wird nur angenommen, wenn das Personal anfragt — ein Browser des
    #: Kunden darf keine Preisbestandteile vorgeben.
    freight: Optional[float] = Field(default=None, ge=0)
    #: Auftragsbüro: für wen gerechnet wird — damit die Vorschau denselben Rabatt
    #: trägt wie der Auftrag (desk.place_order friert mit user=Kunde ein). Nur
    #: vom Personal angenommen; ein Kunde rechnet immer für sich selbst.
    customer_id: Optional[int] = None
    #: Neuer Kunde im Auftragsbüro, noch ohne Konto: Gruppe und Rabatt, mit denen
    #: er angelegt wird. Ebenfalls nur vom Personal.
    price_group: Optional[str] = Field(default=None, max_length=40)
    discount_pct: Optional[float] = Field(default=None, ge=0, le=100)


class QuoteGroup(BaseModel):
    mat: str
    thk: float
    sheet_idx: int
    fmt: list[float]
    n_sheets: int
    n_rest: int
    waste: float
    used_area: float
    cut_len: float
    leftover_fraction: float
    leftover_credit: float


class QuoteResponse(BaseModel):
    engine_version: str
    mat_c: float
    cut_c: float
    sheet_c: float
    custom_c: float = 0.0
    setup: float
    #: Aufschlüsselung des Rüstens (2.10.0-lite): Anteil + feste Einrichtung
    #: 1× je Auftrag nach der aufwendigsten Position (Stufe 1–3, 0 = keine).
    setup_rate: float = 0.0
    setup_fix: float = 0.0
    setup_tier: int = 0
    discount_pct: float = 0.0
    discount: float = 0.0
    cert: float
    freight: float
    goods: float
    total: float
    vat_rate: float
    vat: float
    gross: float
    leftover_credit: float
    mat_gross: float
    cut_len_m: float = 0.0
    machine_min: float = 0.0
    derived_cut: float = 0.0
    over: list[int]
    per: dict[int, dict[str, Any]]
    groups: list[QuoteGroup]


# --------------------------------------------------------------------------
# Audit
# --------------------------------------------------------------------------
class AuditOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    at: datetime
    actor: str
    action: str
    entity: str
    entity_id: str
    detail: dict


# --------------------------------------------------------------------------
# Registrierung & Konto
# --------------------------------------------------------------------------
class RegisterRequest(BaseModel):
    email: EmailStr
    #: Die Längenprüfung steht bewusst NICHT hier. Pydantic beantwortet sie mit
    #: einer 422 und einem englischen Schema-Fehler; die Kasse zeigt dem Kunden
    #: dann „String should have at least 8 characters". Die Güteprüfung sitzt
    #: in routers/auth.check_password_strength und antwortet mit 400 und einem
    #: deutschen Satz, der sagt, was fehlt.
    password: str = Field(max_length=400)
    name: str = Field(default="", max_length=160)
    company: str = Field(default="", max_length=160)


class AccountUpdate(BaseModel):
    name: Optional[str] = Field(default=None, max_length=160)
    company: Optional[str] = Field(default=None, max_length=160)


class EmailChange(BaseModel):
    """E-Mail wechseln — mit Passwort, und mit Faktor, wenn einer an ist.

    Die Anmeldeadresse zu ändern ist der Übernahmeweg schlechthin: wer sie
    ändern kann, kann sich anschließend ein Passwort zurücksetzen lassen.
    Deshalb hängt sie an denselben Nachweisen wie das Passwort selbst.
    """

    new_email: EmailStr
    current_password: str
    code: str = ""


class MfaStart(BaseModel):
    current_password: str


class MfaConfirm(BaseModel):
    code: str = Field(min_length=4, max_length=40)


class MfaDisable(BaseModel):
    """Passwort plus Code — für Abschalten, neue Codes und Kontoschließung.

    ``code`` darf leer sein: ob ein zweiter Faktor überhaupt verlangt wird,
    entscheidet der Router am Konto (``_require_factor``) und nicht das
    Schema. Ein Pflichtfeld hier würde ein Konto ohne 2FA mit einer 422
    abweisen, für die es keinen Grund gibt.
    """

    current_password: str
    code: str = Field(default="", max_length=40)


class ClaimRequest(BaseModel):
    anon_id: str = Field(min_length=8, max_length=64)


# --------------------------------------------------------------------------
# Passwort vergessen (roadmap task 47 C)
# --------------------------------------------------------------------------
class PasswordResetRequest(BaseModel):
    """Bewusst ``str`` und nicht ``EmailStr``: jede Eingabe bekommt dieselbe
    neutrale Antwort, auch eine, die keine Adresse ist."""

    email: str = Field(max_length=320)


class PasswordResetConfirm(BaseModel):
    email: str = Field(max_length=320)
    code: str = Field(max_length=40)
    #: Siehe RegisterRequest.password — geprüft wird in check_password_strength.
    new_password: str = Field(max_length=400)


# --------------------------------------------------------------------------
# Meine Formen — die Teilebibliothek am Konto (roadmap task 47 C)
#
# Die Feldnamen folgen dem Portal (``t``, ``bn``, ``bc``, ``bd``, ``cutLen``,
# ``fam``), damit ein Eintrag aus dem Browser ohne Umbau hin und zurück
# reist. Abgelegt wird in ``part_geometries`` (``fam`` → ``norm_ref``).
# --------------------------------------------------------------------------
PART_SOURCES = ("NORM", "FREEFORM", "DXF", "MEASURED")


class PartIn(BaseModel):
    t: str = Field(default="", max_length=200)
    source: Optional[str] = Field(default=None, max_length=20)
    fam: Optional[str] = Field(default=None, max_length=80)
    mat: str = Field(default="", max_length=60)
    thk: float = Field(default=2.0, ge=0, le=200)
    od: float = Field(default=0.0, ge=0, le=100_000)
    di: float = Field(default=0.0, ge=0, le=100_000)
    bn: int = Field(default=0, ge=0, le=10_000)
    bc: float = Field(default=0.0, ge=0, le=100_000)
    bd: float = Field(default=0.0, ge=0, le=100_000)
    cutLen: float = Field(default=0.0, ge=0, le=100_000_000)
    shape: Optional[dict[str, Any]] = None

    @field_validator("source")
    @classmethod
    def _known_source(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        v = v.strip().upper()
        if v not in PART_SOURCES:
            raise ValueError("source: NORM, FREEFORM, DXF oder MEASURED")
        return v


class PartPatch(BaseModel):
    """Nur, was mitkommt, ändert sich. ``shape: null`` entfernt die Kontur."""

    t: Optional[str] = Field(default=None, max_length=200)
    source: Optional[str] = Field(default=None, max_length=20)
    fam: Optional[str] = Field(default=None, max_length=80)
    mat: Optional[str] = Field(default=None, max_length=60)
    thk: Optional[float] = Field(default=None, ge=0, le=200)
    od: Optional[float] = Field(default=None, ge=0, le=100_000)
    di: Optional[float] = Field(default=None, ge=0, le=100_000)
    bn: Optional[int] = Field(default=None, ge=0, le=10_000)
    bc: Optional[float] = Field(default=None, ge=0, le=100_000)
    bd: Optional[float] = Field(default=None, ge=0, le=100_000)
    cutLen: Optional[float] = Field(default=None, ge=0, le=100_000_000)
    shape: Optional[dict[str, Any]] = None

    _known_source = field_validator("source")(PartIn._known_source.__func__)


class PartOut(BaseModel):
    id: int
    t: str
    source: str
    fam: str
    mat: str
    thk: float
    od: float
    di: float
    bn: int
    bc: float
    bd: float
    cutLen: float
    shape: Optional[dict[str, Any]] = None
    fingerprint: str
    last_ordered: Optional[datetime] = None
    created_at: Optional[datetime] = None
