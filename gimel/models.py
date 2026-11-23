"""ORM-Modelle — die Domänenobjekte aus CLAUDE.md §4 als Tabellen.

Absichtlich getrennt von den Dataclasses in app/domain: der Rechenkern darf
nichts über SQLAlchemy wissen. Die Router bauen aus diesen Zeilen die reinen
Werttypen und geben sie in den Kern.
"""

from __future__ import annotations

import enum
from datetime import date, datetime, timezone

from sqlalchemy import (
    DDL,
    JSON,
    Boolean,
    Date,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
    event,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base
from .fieldcrypt import EncryptedBytes, EncryptedJSON, EncryptedText


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Role(str, enum.Enum):
    """Vier Rollen: wer bestellt, wer in der Halle arbeitet, wer die Stammdaten
    pflegt, wer alles darf.

    ``worker`` sieht Aufträge und arbeitet sie ab (Produktion, Versand,
    Arbeitsvorrat, Kommissionierung) — keine Preise, keine Kunden, keine
    Planung. ``staff`` darf Werkstoffe und Preise ändern, aber keine Benutzer
    anlegen — Preispflege und Zugangsverwaltung sind verschiedene
    Vertrauensstufen.
    """

    customer = "customer"
    worker = "worker"
    staff = "staff"
    admin = "admin"


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(254), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    name: Mapped[str] = mapped_column(String(160), default="")
    company: Mapped[str] = mapped_column(String(160), default="")
    role: Mapped[Role] = mapped_column(
        Enum(Role, native_enum=False), default=Role.customer
    )
    active: Mapped[bool] = mapped_column(Boolean, default=True)

    # Kundenkonditionen (CLAUDE.md §8.3 — noch offen, deshalb schlicht gehalten)
    price_group: Mapped[str] = mapped_column(String(40), default="standard")
    discount_pct: Mapped[float] = mapped_column(Float, default=0.0)
    payment_terms: Mapped[str] = mapped_column(String(80), default="30 Tage netto")
    customer_no: Mapped[str] = mapped_column(String(40), default="")
    # Buchhaltung: Kreditrahmen und USt-Identifikation je Kunde
    credit_limit: Mapped[float] = mapped_column(Float, default=0.0)
    vat_id: Mapped[str] = mapped_column(String(40), default="")
    #: Auftragssperre (2026-11, Aufgabe 45): das Büro nimmt für diesen Kunden
    #: keine neuen Aufträge an, bis die Sperre aufgehoben ist. Bestehende
    #: Aufträge laufen weiter; das Konto selbst bleibt benutzbar (``active``
    #: ist die Kontosperre, das hier die kaufmännische).
    order_block: Mapped[bool] = mapped_column(Boolean, default=False)
    order_block_reason: Mapped[str] = mapped_column(String(200), default="")
    #: Interne Notiz des Büros zum Kunden — der Kunde sieht sie nie.
    office_note: Mapped[str] = mapped_column(EncryptedText("users.office_note"), default="")

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    last_login: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    failed_login_count: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    email_verified: Mapped[bool] = mapped_column(Boolean, default=False)

    # ---- Zweiter Faktor (TOTP, RFC 6238) --------------------------------
    #: Das Geheimnis, verschlüsselt abgelegt (services/secretbox.py). Es ist
    #: der einzige Wert in dieser Datenbank, der zurückgelesen werden *muss* —
    #: ein Hash würde die Codeprüfung unmöglich machen. Deshalb liegt er als
    #: einziger nicht im Klartext.
    totp_secret_enc: Mapped[str] = mapped_column(Text, default="")
    #: Erst nach der ersten erfolgreichen Codeprüfung. Ein Geheimnis, das
    #: erzeugt, aber nie bestätigt wurde, darf niemanden aussperren.
    totp_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    totp_confirmed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    #: Wiederholungsschutz: die zuletzt verbrauchte Zeitscheibe. Ohne sie ist
    #: eine mitgelesene Ziffernfolge dreißig Sekunden lang ein zweiter Faktor.
    totp_last_slot: Mapped[int] = mapped_column(Integer, default=0)
    #: Eigener Zähler und eigene Sperre — getrennt von der Passwortsperre.
    #: Sechs Stellen sind nur dann genug, wenn nach ein paar Fehlversuchen
    #: Schluss ist, und wer den Faktor errät, hat das Passwort schon.
    mfa_failed_count: Mapped[int] = mapped_column(Integer, default=0)
    mfa_locked_until: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    addresses: Mapped[list["Address"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    # Zwei Wege von Order zu User (Besteller und Bearbeiter) — SQLAlchemy muss
    # wissen, welcher hier gemeint ist.
    orders: Mapped[list["Order"]] = relationship(
        back_populates="user", foreign_keys="Order.user_id"
    )


class Address(Base):
    """Liefer- und Rechnungsanschriften des Kunden (Adressbuch der Kasse)."""

    __tablename__ = "addresses"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    label: Mapped[str] = mapped_column(String(120), default="")
    company: Mapped[str] = mapped_column(EncryptedText("addresses.company"), default="")
    dept: Mapped[str] = mapped_column(EncryptedText("addresses.dept"), default="")
    contact: Mapped[str] = mapped_column(EncryptedText("addresses.contact"), default="")
    street: Mapped[str] = mapped_column(EncryptedText("addresses.street"), default="")
    zip: Mapped[str] = mapped_column(EncryptedText("addresses.zip"), default="")
    city: Mapped[str] = mapped_column(EncryptedText("addresses.city"), default="")
    country: Mapped[str] = mapped_column(String(2), default="DE")
    vat_id: Mapped[str] = mapped_column(EncryptedText("addresses.vat_id"), default="")
    # Rechnungs- und Lieferanschrift sind getrennt: genau eine Rechnungs- und
    # genau eine Standard-Lieferanschrift je Kunde (Arbitration in
    # services.addressbook). Eine Anschrift darf beides zugleich sein.
    is_billing: Mapped[bool] = mapped_column(Boolean, default=False)
    is_delivery: Mapped[bool] = mapped_column(Boolean, default=False)

    user: Mapped[User] = relationship(back_populates="addresses")


class Product(Base):
    """Werkstoff — die Katalogeinheit.

    ``verified`` trägt die Herkunftsflags je Feld. Solange sie nicht gesetzt
    sind, zeigt die Oberfläche den Richtwert-Hinweis. Ein Flag ohne Quelle zu
    setzen ist schlimmer, als es offen zu lassen (CLAUDE.md §7).
    """

    __tablename__ = "products"

    id: Mapped[str] = mapped_column(String(60), primary_key=True)
    sku: Mapped[str] = mapped_column(String(40), default="")
    name: Mapped[str] = mapped_column(String(160))
    short: Mapped[str] = mapped_column(String(80), default="")
    brand: Mapped[str] = mapped_column(String(80), default="")
    cat: Mapped[str] = mapped_column(String(40), index=True)
    colour: Mapped[str] = mapped_column(String(20), default="#888888")
    blurb: Mapped[str] = mapped_column(Text, default="")

    eur_m2: Mapped[float] = mapped_column(Float)
    #: Verkaufspreis je Dicke (VK €/m², {"1": …, "1.5": …}) aus der Einkaufsliste.
    #: EK → VK kalkuliert der Betrieb mit ×2 (1,0/1,5/3,0 mm) bzw. ×1,5 (2,0 mm).
    #: Ohne Eintrag rechnet der Kern mit eur_m2 (2.10.0-lite, wie engine.js).
    eur_m2_thk: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    sheets: Mapped[list] = mapped_column(JSON, default=list)  # [[w, h], …] mm
    thicknesses: Mapped[list] = mapped_column(JSON, default=list)  # mm

    t_min: Mapped[float | None] = mapped_column(Float, nullable=True)
    t_max: Mapped[float | None] = mapped_column(Float, nullable=True)
    t_peak: Mapped[float | None] = mapped_column(Float, nullable=True)
    p_max: Mapped[float | None] = mapped_column(Float, nullable=True)
    media: Mapped[dict] = mapped_column(JSON, default=dict)
    approvals: Mapped[list] = mapped_column(JSON, default=list)

    # Rohdaten aus der Recherche. Nichts rendert sie, nichts filtert darauf —
    # die CNC-Eignungsplakette ist bewusst weg (CLAUDE.md §1.2).
    cnc: Mapped[str] = mapped_column(String(20), default="check")

    kerf: Mapped[float | None] = mapped_column(Float, nullable=True)
    web: Mapped[float | None] = mapped_column(Float, nullable=True)
    #: Mindeststeg im Teil (Loch-/Ringstege) — die Latte für Geometriehinweise
    #: und Maßgrenzen. Ausdrücklich nicht `web`: das ist der Spannrand für die
    #: Schachtelung, keine Teileigenschaft.
    min_web: Mapped[float | None] = mapped_column(Float, nullable=True)

    # Werkstoffrichtung und Wendbarkeit — Schranken der Dreh- und Spiegeloption
    # des Rechenkerns (2.9.0-lite, docs/NESTING-ALGORITHM.md §5.3). "axis"
    # erlaubt {0°, 180°}, "directed" nur 0° ohne Spiegelung; die Richtung ist
    # die härtere Schranke und schlägt jede Bedienervorgabe.
    grain: Mapped[str] = mapped_column(String(20), default="none")
    flip_ok: Mapped[bool] = mapped_column(Boolean, default=True)

    stock: Mapped[int] = mapped_column(Integer, default=0)
    lead_days: Mapped[int] = mapped_column(Integer, default=0)
    uses: Mapped[int] = mapped_column(Integer, default=0)
    url: Mapped[str] = mapped_column(String(400), default="")
    datasheet_url: Mapped[str] = mapped_column(String(400), default="")

    active: Mapped[bool] = mapped_column(Boolean, default=True)
    verified: Mapped[dict] = mapped_column(JSON, default=dict)

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )


class PriceHistory(Base):
    """Jede Preisänderung mit Grund und Urheber.

    Einkaufspreise für Plattenware schwanken; ohne Verlauf lässt sich später
    nicht mehr sagen, mit welchem €/m² ein Angebot gerechnet wurde. Genau das
    ist aber die Frage, wenn ein Kunde ein altes Angebot vorlegt.
    """

    __tablename__ = "price_history"

    id: Mapped[int] = mapped_column(primary_key=True)
    product_id: Mapped[str] = mapped_column(
        ForeignKey("products.id", ondelete="CASCADE"), index=True
    )
    #: Dicke des geänderten Dickensatzes; None = der Bezugspreis ``eur_m2`` (2 mm).
    thk: Mapped[float | None] = mapped_column(Float, nullable=True)
    old_eur_m2: Mapped[float] = mapped_column(Float)
    new_eur_m2: Mapped[float] = mapped_column(Float)
    reason: Mapped[str] = mapped_column(String(400), default="")
    changed_by: Mapped[str] = mapped_column(String(254), default="")
    changed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class StockMovement(Base):
    """Jede Bestandsänderung einer Platte, mit Grund und Urheber — dasselbe
    Prinzip wie ``PriceHistory``. Ohne Verlauf ließe sich später nicht mehr
    unterscheiden, ob ein leeres Lager am Sammellauf lag oder an einer
    Fehlbuchung im Support.

    ``delta`` ist positiv für Wareneingang/Korrektur nach oben, negativ für
    Verbrauch (Sammellauf) oder Korrektur nach unten. ``work_order_no`` steht
    nur bei automatischem Verbrauch — der Rückverweis, welcher Innenauftrag
    die Platten gezogen hat.
    """

    __tablename__ = "stock_movements"

    id: Mapped[int] = mapped_column(primary_key=True)
    product_id: Mapped[str] = mapped_column(
        ForeignKey("products.id", ondelete="CASCADE"), index=True
    )
    delta: Mapped[int] = mapped_column(Integer)
    balance_after: Mapped[int] = mapped_column(Integer)
    reason: Mapped[str] = mapped_column(
        String(20), default="korrektur"
    )  # einkauf|sammellauf|korrektur
    note: Mapped[str] = mapped_column(String(400), default="")
    work_order_no: Mapped[str] = mapped_column(String(30), default="")
    #: Optionale Dicken-, Chargen- und Bestellzuordnung (Lieferkette, additiv).
    thk: Mapped[float | None] = mapped_column(Float, nullable=True)
    lot_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    purchase_order_no: Mapped[str] = mapped_column(String(30), default="")
    actor: Mapped[str] = mapped_column(String(254), default="")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, index=True
    )


class StockLocation(Base):
    """Wo ein Werkstoff liegt: Lagerstation, Fach und Menge.

    ``Product.stock`` ist die Summe, diese Zeilen sind ihre Verteilung. Ohne
    sie sagt die Kommissionierung „hol 12 Platten Alu 2 mm" und lässt den
    Werker suchen. ``thk`` 0 heißt „alle Dicken" (ein Fach, in dem Dicken
    gemischt liegen). Die Zeilen sind eine Auskunft, kein Bestandsbuch: gebucht
    wird weiter über ``StockMovement``; weicht die Summe vom Bestand ab, zeigt
    die Oberfläche den Unterschied statt ihn zu glätten.
    """

    __tablename__ = "stock_locations"

    id: Mapped[int] = mapped_column(primary_key=True)
    product_id: Mapped[str] = mapped_column(
        ForeignKey("products.id", ondelete="CASCADE"), index=True
    )
    thk: Mapped[float] = mapped_column(Float, default=0.0)
    #: Die Lagerstation (Regal, Hochregal, Lager) — leer = Ort unbekannt.
    station_id: Mapped[int | None] = mapped_column(
        ForeignKey("factory_stations.id", ondelete="SET NULL"), nullable=True, index=True
    )
    #: Fach, Ebene, Platz im Regal, frei geschrieben („Fach B2 · unten").
    bin: Mapped[str] = mapped_column(String(80), default="")
    qty: Mapped[int] = mapped_column(Integer, default=0)
    note: Mapped[str] = mapped_column(String(200), default="")
    updated_by: Mapped[str] = mapped_column(String(254), default="")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )


class Offcut(Base):
    """Ein Reststück: der ungenutzte Rest einer geschnittenen Platte.

    Der Sammellauf schneidet in Bändern; was hinter dem Band liegt, ist ein
    sauberes Rechteck und oft groß genug für den nächsten Auftrag. Ohne eigene
    Zeile wandert es in den Schrott oder liegt unsichtbar im Regal, und die
    Kommissionierung zieht für drei kleine Teile eine volle Platte.

    Zustände: ``pending`` (geplant, die Quellplatte ist noch nicht geschnitten),
    ``available`` (liegt im Lager), ``reserved`` (einem offenen Innenauftrag
    zugeteilt), ``used`` (verbraucht), ``scrapped`` (ausgesondert). Ein
    Reststück ist **kein** Teil von ``Product.stock``: der zählt volle Platten.
    """

    __tablename__ = "offcuts"

    id: Mapped[int] = mapped_column(primary_key=True)
    #: Lesbare Marke für Etikett und Kommissionierung („R-0042").
    code: Mapped[str] = mapped_column(String(20), unique=True, index=True)
    product_id: Mapped[str] = mapped_column(
        ForeignKey("products.id", ondelete="CASCADE"), index=True
    )
    thk: Mapped[float] = mapped_column(Float, default=0.0)
    #: Maße in mm — Breite × Länge, so wie es auf dem Tisch liegt.
    w: Mapped[float] = mapped_column(Float, default=0.0)
    h: Mapped[float] = mapped_column(Float, default=0.0)
    status: Mapped[str] = mapped_column(String(12), default="pending", index=True)
    station_id: Mapped[int | None] = mapped_column(
        ForeignKey("factory_stations.id", ondelete="SET NULL"), nullable=True, index=True
    )
    bin: Mapped[str] = mapped_column(String(80), default="")
    note: Mapped[str] = mapped_column(String(200), default="")
    #: Woher: Innenauftrag und Platte, aus deren Rest es stammt.
    source_work_order_no: Mapped[str] = mapped_column(String(30), default="", index=True)
    source_plate_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: Herkunftscharge (``material_lots.id``), falls bekannt.
    lot_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    #: Wohin: der Innenauftrag, der es reserviert bzw. verbraucht hat.
    work_order_no: Mapped[str] = mapped_column(String(30), default="", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    available_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_by: Mapped[str] = mapped_column(String(254), default="")


class Rate(Base):
    """Kalkulationssätze als Schlüssel/Wert, damit neue Sätze keine Migration brauchen."""

    __tablename__ = "rates"

    key: Mapped[str] = mapped_column(String(40), primary_key=True)
    value: Mapped[float] = mapped_column(Float)
    unit: Mapped[str] = mapped_column(String(20), default="")
    note: Mapped[str] = mapped_column(Text, default="")
    verified: Mapped[bool] = mapped_column(Boolean, default=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )
    updated_by: Mapped[str] = mapped_column(String(254), default="")


class Order(Base):
    __tablename__ = "orders"

    id: Mapped[int] = mapped_column(primary_key=True)
    no: Mapped[str] = mapped_column(String(30), unique=True, index=True)
    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id"), nullable=True, index=True
    )
    customer_ref: Mapped[str] = mapped_column(String(80), default="")
    anon_id: Mapped[str] = mapped_column(String(64), default="", index=True)
    claimed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    cert: Mapped[str] = mapped_column(String(10), default="2.2")

    #: Art des Auftrags. ``external`` ist der Kundenauftrag mit Anschrift,
    #: Zahlung und Rechnung. ``internal`` ist ein betriebsinterner Auftrag:
    #: kein Kunde, keine Zahlung, keine Rechnung — dafür steht ein
    #: verantwortlicher Mitarbeiter am Auftrag.
    kind: Mapped[str] = mapped_column(String(10), default="external", index=True)
    internal_owner: Mapped[str] = mapped_column(String(160), default="")

    #: Wo der Auftrag eingegangen ist — der Standort, an den „nur wo
    #: eingegangen" ihn bindet. Leer = erster Standort.
    site_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: Wo gefertigt werden darf: "" überall · "site:1,2" · "hall:3" ·
    #: "floor:5" · "received". Siehe ``services/sites.py``.
    route_scope: Mapped[str] = mapped_column(String(200), default="")

    # Kontakt des Auftrags (auch und gerade beim Gast): Empfänger später
    # Produktionsmeldungen und zweiter Schlüssel der Nummer+E-Mail-Verfolgung.
    # Klartext nur bis ``email_retain_until`` (default ein Monat) — danach
    # streicht der Aufräumgang ihn; die Hash-Prüfung läuft im Portal
    # (server/orders.mjs) gegen seinen eigenen Salt weiter.
    contact_email: Mapped[str] = mapped_column(String(254), default="", index=True)
    email_retain_until: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # Adressen und Steuerstatus werden kopiert, nicht referenziert: eine später
    # geänderte Kundenadresse darf eine ausgestellte Auftragsbestätigung nicht
    # rückwirkend umschreiben.
    ship_address: Mapped[dict] = mapped_column(EncryptedJSON("orders.ship_address"), default=dict)
    bill_address: Mapped[dict] = mapped_column(EncryptedJSON("orders.bill_address"), default=dict)
    tax_status: Mapped[dict] = mapped_column(JSON, default=dict)

    net: Mapped[float] = mapped_column(Float, default=0.0)
    vat: Mapped[float] = mapped_column(Float, default=0.0)
    gross: Mapped[float] = mapped_column(Float, default=0.0)
    price_breakdown: Mapped[dict] = mapped_column(JSON, default=dict)

    # Ein Angebot zeigt nie einen Preis aus einer anderen Engine-Version
    # (CLAUDE.md §8.1) — deshalb steht sie am Auftrag.
    engine_version: Mapped[str] = mapped_column(String(20), default="")

    stage: Mapped[int] = mapped_column(Integer, default=0)
    blocked: Mapped[bool] = mapped_column(Boolean, default=False)
    stages: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    # Die Zusage an den Kunden. Der Sammellauf darf sammeln, solange er sie
    # hält — ohne dieses Datum kann er nur raten, und Materialoptimierung frisst
    # irgendwann eine Lieferung auf.
    due_date: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    #: Eilauftrag — geht am Sammeln vorbei, egal wie leer die Platte bleibt.
    rush: Mapped[bool] = mapped_column(Boolean, default=False)

    #: Darf in die Fertigung. Der Sammellauf sammelt ausschließlich freigegebene
    #: Aufträge ein.
    #:
    #: Bewusst getrennt von ``paid``: über die Kasse ist die Zahlung die
    #: Freigabe (auf unbezahlt bestellte Ware wird kein Material geschnitten),
    #: eine verbindliche Bestellung auf Rechnung ist aber ohne Zahlung
    #: freigegeben — das ist im B2B der Normalfall und der zweite Weg aus der
    #: Kasse (CLAUDE.md §2.3). Ein Boolescher Wert für beides würde eine der
    #: beiden Wahrheiten verfälschen. Das Personal kann jederzeit zurückziehen.
    released: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    release_note: Mapped[str] = mapped_column(String(200), default="")

    #: Angehalten (2026-11, Aufgabe 45): das Büro stoppt den Auftrag mit einem
    #: Grund, ohne Freigabe oder Zahlung anzufassen. Der Sammellauf lässt ihn
    #: liegen, bis er fortgesetzt wird. Leer = läuft.
    held_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    hold_reason: Mapped[str] = mapped_column(String(200), default="")
    #: Storniert: nur vor der Planung möglich, nichts wird gelöscht. Ein
    #: stornierter Auftrag wird nie wieder freigegeben, auch nicht durch einen
    #: späten Zahlungseingang (``services/order_flow.py``).
    cancelled_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    cancel_reason: Mapped[str] = mapped_column(String(200), default="")
    #: Interne Notiz des Büros zum Auftrag — steht auf keinem Beleg.
    office_note: Mapped[str] = mapped_column(EncryptedText("orders.office_note"), default="")
    #: Zähler der Büro-Änderungen (anhalten, stornieren, ändern). Wer mit einem
    #: veralteten Stand schreibt, bekommt 409 statt eine fremde Änderung zu
    #: überschreiben.
    rev: Mapped[int] = mapped_column(Integer, default=0)

    # Zahlungstatsachen aus dem Bestellportal. Über die Kasse gilt: erst das
    # Geld, dann das Material — deshalb steht das am Auftrag und nicht nur bei
    # Stripe.
    paid: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    paid_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    payment_ref: Mapped[str] = mapped_column(String(120), default="")
    payment_method: Mapped[str] = mapped_column(String(20), default="")
    #: Was das Portal kassiert hat gegen das, was dieser Rechenkern rechnet.
    #: Weichen sie ab, wird der Auftrag gesperrt statt still gefertigt.
    price_check: Mapped[dict] = mapped_column(JSON, default=dict)

    # Manueller Versand (Auftragsbüro): Spedition, Sendungsnummer und
    # Versandkosten werden am Auftrag von Hand erfasst. Der Versand liest sie
    # später als Vorgabe — vorausgefüllt, aber editierbar. Leer ({}), wenn der
    # Auftrag nicht als manueller Versand erfasst wurde.
    manual_shipment: Mapped[dict] = mapped_column(EncryptedJSON("orders.manual_shipment"), default=dict)

    # Buchhaltung: Rechnungsbeleg je Auftrag — im B2B ist der Auftrag die Rechnung.
    invoice_no: Mapped[str] = mapped_column(String(40), default="", index=True)
    invoiced_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    invoice_due_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    #: Der Verwendungszweck, den *Stripe* für diese Rechnung ausgibt — der
    #: Referenzcode der Überweisungsanweisung, ersatzweise die
    #: Stripe-Rechnungsnummer. Steht erst nach dem Finalisieren fest und wird
    #: dann hier festgehalten, damit Beleg, Liste und Auftragsansicht denselben
    #: Zweck nennen, ohne für jede Zeile bei Stripe nachzufragen.
    invoice_reference: Mapped[str] = mapped_column(String(140), default="")

    # Auftragsbearbeitung: wer diesen Auftrag betreut. Vorgeschlagen wird nach
    # Kundenbindung (domain/routing.py) — wer den Kunden kennt, kennt seine
    # Zeichnungsstände. Gesetzt wird er trotzdem von Hand oder per Übernahme
    # des Vorschlags; ein Auftrag, der sich selbst jemandem zuteilt, ohne dass
    # es jemand liest, ist eine Zuteilung an niemanden.
    handler_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    handler_reason: Mapped[str] = mapped_column(String(300), default="")
    handler_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    user: Mapped[User | None] = relationship(
        back_populates="orders", foreign_keys=[user_id]
    )
    positions: Mapped[list["OrderPosition"]] = relationship(
        back_populates="order", cascade="all, delete-orphan"
    )


class OrderPosition(Base):
    __tablename__ = "order_positions"

    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(
        ForeignKey("orders.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(String(10), default="gasket")
    label: Mapped[str] = mapped_column(EncryptedText("order_positions.label"), default="")
    mat: Mapped[str] = mapped_column(String(60), default="")
    thk: Mapped[float] = mapped_column(Float, default=2.0)
    qty: Mapped[int] = mapped_column(Integer, default=1)

    od: Mapped[float] = mapped_column(Float, default=0.0)
    di: Mapped[float] = mapped_column(Float, default=0.0)
    bolt_count: Mapped[int] = mapped_column(Integer, default=0)
    bolt_circle: Mapped[float] = mapped_column(Float, default=0.0)
    bolt_d: Mapped[float] = mapped_column(Float, default=0.0)
    cut_len: Mapped[float] = mapped_column(Float, default=0.0)
    fmt: Mapped[list | None] = mapped_column(JSON, nullable=True)
    shape: Mapped[dict | None] = mapped_column(EncryptedJSON("order_positions.shape"), nullable=True)
    #: Herkunft aus der Formenbibliothek. Die Kontur steht in ``shape``; diese
    #: Kennung hält fest, *welche* Form es war. Ohne sie ließe sich später nur
    #: über die Geometrie raten, ob eine Position aus dem Hauskatalog stammt —
    #: und die Verwendung einer Form wäre eine Zahl ohne Auftrag.
    shape_id: Mapped[int | None] = mapped_column(
        ForeignKey("library_shapes.id", ondelete="SET NULL"), nullable=True, index=True
    )
    #: Formfamilie aus dem Konfigurator ("norm", "ring", "rect", "oval",
    #: "dxf", "saved") — bestimmt die Rüststufe der festen Einrichtung.
    #: Leer bei alten Aufträgen: dann entscheidet die Kontur (2.10.0-lite).
    fam: Mapped[str] = mapped_column(String(20), default="")

    #: Freitext einer freien Position (kind="custom") — was gefertigt oder
    #: zugekauft wird. Die Werkstatt liest ihn auf der Laufkarte; ohne ihn
    #: wäre eine Sonderfertigung nur eine Zeile mit einem Preis.
    #: Intern — erscheint auf Laufkarte und in der Fertigung, nicht beim Kunden.
    note: Mapped[str] = mapped_column(EncryptedText("order_positions.note"), default="")
    #: Kundenhinweis einer freien Position (kind="custom") — erscheint auf
    #: Beleg, Rechnung und im Kundenportal. Interne Details bleiben außen vor.
    external_note: Mapped[str] = mapped_column(EncryptedText("order_positions.external_note"), default="")
    #: Vorgegebener Bruttopreis je Stück einer freien Position. Der gerechnete
    #: Nettobetrag steht wie überall in ``mat_cost``; dieses Feld hält fest,
    #: was der Erfasser tatsächlich eingegeben hat.
    price_gross: Mapped[float] = mapped_column(Float, default=0.0)

    mat_cost: Mapped[float] = mapped_column(Float, default=0.0)
    cut_cost: Mapped[float] = mapped_column(Float, default=0.0)

    # Fertigungsstatus — der Sammellauf greift genau die "pending"-Positionen.
    production_status: Mapped[str] = mapped_column(
        String(20), default="pending", index=True
    )

    order: Mapped[Order] = relationship(back_populates="positions")


class AuditLog(Base):
    """Wer hat wann was geändert. Preise und Zugänge ohne Spur zu ändern wäre
    in einem B2B-Portal nicht vertretbar."""

    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(primary_key=True)
    at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, index=True
    )
    actor: Mapped[str] = mapped_column(String(254), default="")
    action: Mapped[str] = mapped_column(String(60))
    entity: Mapped[str] = mapped_column(String(60), default="")
    entity_id: Mapped[str] = mapped_column(String(80), default="")
    detail: Mapped[dict] = mapped_column(EncryptedJSON("audit_log.detail"), default=dict)


class PortalSync(Base):
    """Übernahme aus dem Bestellportal (server/stripe-routes.mjs).

    Stripe stellt Webhooks bei Bedarf erneut zu — ohne Merker würde jede
    erneute Zustellung denselben Auftrag noch einmal in die Fertigung
    schreiben. Der Schlüssel ist die Stripe-Kennung der Zahlung
    (Sitzungs- bzw. Rechnungs-ID), und er ist einmalig.
    """

    __tablename__ = "portal_sync"

    id: Mapped[int] = mapped_column(primary_key=True)
    key: Mapped[str] = mapped_column(String(120), unique=True, index=True)
    order_no: Mapped[str] = mapped_column(String(30), index=True)
    source: Mapped[str] = mapped_column(String(20), default="")  # card|transfer|invoice
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class PunchoutSession(Base):
    """OCI-PunchOut-Sitzung für SAP (2026-09, online resale).

    Der Einkäufer startet im SAP (Ariba/SRM/JAGGAER/Onventis), landet per Setup-
    Request im Shop, stellt dort seinen Warenkorb zusammen und kehrt per
    HOOK_URL-Formular mit OCI-Feldern ins SAP zurück. Der Shop kennt dabei nur
    das Session-Token — nie SAP-Passwörter im Klartext über die Lebensdauer
    hinaus. Lebensdauer 48 h (24–72 h üblich), danach 410.
    """

    __tablename__ = "punchout_sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    token: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    buyer_id: Mapped[str] = mapped_column(String(120), default="", index=True)
    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    hook_url: Mapped[str] = mapped_column(String(500), default="")
    buyer_cookie: Mapped[str] = mapped_column(String(200), default="")
    price_group: Mapped[str] = mapped_column(String(40), default="standard")
    currency: Mapped[str] = mapped_column(String(10), default="EUR")
    status: Mapped[str] = mapped_column(String(20), default="open")  # open|used|expired|revoked
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    cart_returns: Mapped[int] = mapped_column(Integer, default=0)


class PartGeometry(Base):
    """Die Teilebibliothek des Kunden — laut CLAUDE.md §1 der eigentliche Burggraben.

    Deshalb eine eigene Tabelle und nicht nur eine Zeile am Auftrag: die
    Geometrie soll den Auftrag überleben und wiederverwendbar sein.
    """

    __tablename__ = "part_geometries"
    __table_args__ = (
        UniqueConstraint("user_id", "fingerprint", name="uq_part_user_fingerprint"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    label: Mapped[str] = mapped_column(EncryptedText("part_geometries.label"), default="")
    fingerprint: Mapped[str] = mapped_column(String(64), index=True)
    source: Mapped[str] = mapped_column(
        String(20), default="NORM"
    )  # NORM|FREEFORM|DXF|MEASURED
    norm_ref: Mapped[str] = mapped_column(String(80), default="")
    od: Mapped[float] = mapped_column(Float, default=0.0)
    di: Mapped[float] = mapped_column(Float, default=0.0)
    bolt_count: Mapped[int] = mapped_column(Integer, default=0)
    bolt_circle: Mapped[float] = mapped_column(Float, default=0.0)
    bolt_d: Mapped[float] = mapped_column(Float, default=0.0)
    cut_len: Mapped[float] = mapped_column(Float, default=0.0)
    shape: Mapped[dict | None] = mapped_column(EncryptedJSON("part_geometries.shape"), nullable=True)
    mat: Mapped[str] = mapped_column(String(60), default="")
    thk: Mapped[float] = mapped_column(Float, default=2.0)
    last_ordered: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


# ==========================================================================
# Produktion — Sammelschachtelung und Innenaufträge
#
# CLAUDE.md §8.2 fragte, ob die Schachtelung über Aufträge hinweg läuft. Die
# Antwort ist jetzt getroffen: kalkuliert wird je Auftrag (der Kunde bekommt
# einen nachvollziehbaren Preis für seine Positionen), geschachtelt wird über
# alle offenen Aufträge eines Werkstoffs. Die bessere Ausnutzung bleibt als
# Marge im Haus. Genau deshalb darf ein Sammellauf niemals rückwirkend den
# Kundenpreis verändern — er erzeugt nur Fertigungspapiere.
# ==========================================================================
class LibraryShape(Base):
    """Formenbibliothek des Hauses — Normteile und dauerhaft abgelegte DXF.

    Das Gegenstück zum Werkstoffkatalog: dort steht, *woraus* geschnitten wird,
    hier, *was* geschnitten wird. Und aus demselben Grund eine eigene Tabelle
    statt einer Zeile am Auftrag — laut CLAUDE.md §1 ist die gehaltene
    Kundengeometrie der eigentliche Burggraben, und eine Geometrie, die mit
    ihrem Auftrag verschwindet, hält gar nichts.

    Unterschied zu ``PartGeometry``: das ist die *private* Bibliothek eines
    Kunden (``user_id`` + Fingerabdruck). Diese hier gehört dem Haus, wird vom
    Personal gepflegt und ist für alle Aufträge da.

    Die hochgeladene Datei bleibt im Original liegen (``dxf_blob``). Aus der
    geparsten ``shape`` liesse sich zwar jederzeit eine neue DXF schreiben,
    aber nicht dieselbe: was der Kunde geschickt hat, ist im Zweifel das
    Beweisstück — Layer, Kommentare und alles, was der Parser nicht liest.
    """

    __tablename__ = "library_shapes"

    id: Mapped[int] = mapped_column(primary_key=True)
    key: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    label: Mapped[str] = mapped_column(String(200))
    cat: Mapped[str] = mapped_column(
        String(20), default="dxf", index=True
    )  # norm|dxf|frei
    norm_ref: Mapped[str] = mapped_column(String(120), default="")
    size_label: Mapped[str] = mapped_column(String(80), default="")

    od: Mapped[float] = mapped_column(Float, default=0.0)
    di: Mapped[float] = mapped_column(Float, default=0.0)
    bolt_count: Mapped[int] = mapped_column(Integer, default=0)
    bolt_circle: Mapped[float] = mapped_column(Float, default=0.0)
    bolt_d: Mapped[float] = mapped_column(Float, default=0.0)
    cut_len: Mapped[float] = mapped_column(Float, default=0.0)
    shape: Mapped[dict | None] = mapped_column(EncryptedJSON("library_shapes.shape"), nullable=True)

    thk_default: Mapped[float] = mapped_column(Float, default=2.0)
    mat_default: Mapped[str] = mapped_column(String(60), default="")
    tags: Mapped[list | None] = mapped_column(JSON, default=list)
    note: Mapped[str] = mapped_column(Text, default="")

    dxf_name: Mapped[str] = mapped_column(String(200), default="")
    dxf_blob: Mapped[bytes | None] = mapped_column(EncryptedBytes("library_shapes.dxf_blob"), nullable=True)
    dxf_size: Mapped[int] = mapped_column(Integer, default=0)

    active: Mapped[bool] = mapped_column(Boolean, default=True)
    uses: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )
    created_by: Mapped[str] = mapped_column(String(200), default="")


class Drawing(Base):
    """Zeichnungsbibliothek des freien Schachtelns (Roadmap-Aufgabe 29).

    Nur die Kontur in Millimetern: ``outer`` und ``holes`` sind Polygone, auf den
    Nullpunkt verschoben (y nach oben, wie DXF). Die hochgeladene Datei wird nicht
    aufgehoben, anders als bei ``LibraryShape``; was hier steht, reicht, um zu
    schachteln und eine Schnittdatei zu schreiben. Keine Kundenbindung, kein Auftrag.
    Die Tabelle legt ``create_all`` an.
    """

    __tablename__ = "drawings"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120), index=True)
    note: Mapped[str] = mapped_column(String(500), default="")
    source: Mapped[str] = mapped_column(String(10))  # dxf|svg|points
    outer: Mapped[list] = mapped_column(JSON)
    holes: Mapped[list] = mapped_column(JSON, default=list)
    width: Mapped[float] = mapped_column(Float)
    height: Mapped[float] = mapped_column(Float)
    area: Mapped[float] = mapped_column(Float)      # mm², Außenkontur minus Aussparungen
    cut_len: Mapped[float] = mapped_column(Float)   # mm, Außen- und Innenkonturen
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    created_by: Mapped[str] = mapped_column(String(254), default="")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )


class InvoiceDocument(Base):
    """Die abgelegte Rechnung — das Haus-Exemplar.

    Bisher lag die einzige Fassung bei Stripe, und jeder Blick darauf war ein
    Netzaufruf gegen einen fremden Dienst. Das ist zwei Mal falsch: die
    Buchhaltung braucht ihr Exemplar auch dann, wenn Stripe gerade nicht
    erreichbar ist, und eine ausgestellte Rechnung ist ein Beleg — der gehört
    ins Haus und nicht ausschliesslich zum Zahlungsdienstleister.

    Abgelegt wird das PDF beim Ausstellen und danach bei jedem Abruf, den es
    noch nicht kennt. Die Kennung der Rechnung steht dabei, damit ein Storno
    und eine Neuausstellung zwei unterscheidbare Belege bleiben.
    """

    __tablename__ = "invoice_documents"
    __table_args__ = (UniqueConstraint("invoice_no", name="uq_invoice_document"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    order_no: Mapped[str] = mapped_column(String(40), index=True)
    invoice_no: Mapped[str] = mapped_column(String(60), index=True)
    number: Mapped[str] = mapped_column(String(60), default="")
    total_cents: Mapped[int] = mapped_column(Integer, default=0)
    recipient: Mapped[str] = mapped_column(EncryptedText("invoice_documents.recipient"), default="")
    hosted_url: Mapped[str] = mapped_column(Text, default="")
    pdf: Mapped[bytes | None] = mapped_column(EncryptedBytes("invoice_documents.pdf"), nullable=True)
    pdf_size: Mapped[int] = mapped_column(Integer, default=0)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class StructuredInvoiceDocument(Base):
    """Immutable XML snapshot; separate table keeps existing PDF archives intact."""

    __tablename__ = "structured_invoice_documents"
    id: Mapped[int] = mapped_column(primary_key=True)
    invoice_no: Mapped[str] = mapped_column(String(60), unique=True, index=True)
    order_no: Mapped[str] = mapped_column(String(40), index=True)
    number: Mapped[str] = mapped_column(String(60))
    xml: Mapped[str] = mapped_column(EncryptedText("structured_invoice_documents.xml"))
    sha256: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class LocalInvoice(Base):
    """Eine von Gimel selbst ausgestellte Rechnung oder ihr Storno (GoBD).

    Nur anhängen: was hier steht, ändert sich nie und wird nie gelöscht. Eine
    Korrektur ist eine neue Zeile ``kind="storno"`` mit eigener Nummer, die über
    ``refers_to`` die Rechnung nennt. ``data`` ist der Stand beim Ausstellen, damit
    ein Beleg nie aus inzwischen geänderten Auftragsdaten neu entsteht.

    Unter Alef legt ``create_all`` die Tabelle an, sie bleibt dort leer
    (``Plugin.local_invoicing=False``); bestehende Tabellen ändern sich nicht.
    """

    __tablename__ = "local_invoices"
    __table_args__ = (UniqueConstraint("year", "seq", name="uq_local_invoice_seq"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    number: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    year: Mapped[int] = mapped_column(Integer)
    seq: Mapped[int] = mapped_column(Integer)
    kind: Mapped[str] = mapped_column(String(10), default="invoice")
    order_no: Mapped[str] = mapped_column(String(40), index=True)
    refers_to: Mapped[str] = mapped_column(String(40), default="", index=True)
    issue_date: Mapped[date] = mapped_column(Date)
    due_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    delivery_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    net_cents: Mapped[int] = mapped_column(Integer)
    vat_cents: Mapped[int] = mapped_column(Integer)
    gross_cents: Mapped[int] = mapped_column(Integer)
    data: Mapped[dict] = mapped_column(EncryptedJSON("local_invoices.data"), default=dict)
    xml: Mapped[str] = mapped_column(EncryptedText("local_invoices.xml"))
    sha256: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    created_by: Mapped[str] = mapped_column(String(254), default="")


class LocalInvoiceCounter(Base):
    """Der letzte vergebene Rechnungszähler je Jahr. Das Hochzählen läuft in der
    Transaktion der Rechnung: scheitert sie, ist die Nummer nie vergeben worden."""

    __tablename__ = "local_invoice_counters"

    year: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    last: Mapped[int] = mapped_column(Integer, default=0)


def _immutable(mapper, connection, target) -> None:
    raise ValueError(f"Rechnung {target.number} ist ausgestellt und unveränderlich: "
                     "Korrektur nur per Storno.")


event.listen(LocalInvoice, "before_update", _immutable)
event.listen(LocalInvoice, "before_delete", _immutable)
# Auch gegen rohes SQL. ``data`` und ``xml`` bleiben frei, weil fieldmigrate ihren
# Klartext neu versiegelt; ``sha256`` hält den Inhalt fest.
for _name, _when in (("no_update", "UPDATE OF number, year, seq, kind, order_no, refers_to, issue_date, "
                                   "due_date, delivery_date, net_cents, vat_cents, gross_cents, sha256"),
                     ("no_delete", "DELETE")):
    event.listen(LocalInvoice.__table__, "after_create", DDL(
        f"CREATE TRIGGER local_invoices_{_name} BEFORE {_when} ON local_invoices "
        "BEGIN SELECT RAISE(ABORT, 'Ausgestellte Rechnung ist unveränderlich'); END"
    ).execute_if(dialect="sqlite"))


class ProductionStatus(str, enum.Enum):
    pending = "pending"  # bestellt, wartet auf den nächsten Sammellauf
    batched = "batched"  # einem Innenauftrag zugeteilt
    done = "done"  # geschnitten
    manual = "manual"  # Übergröße o. Ä. — geht an die Technik, nie automatisch


class WorkOrderStatus(str, enum.Enum):
    open = "open"
    running = "running"
    done = "done"
    cancelled = "cancelled"


class VisionConfirmation(Base):
    """Ein am Sortiertisch erkanntes und bestätigtes Teil. Das Bild wird nie gespeichert."""

    __tablename__ = "vision_confirmations"

    id: Mapped[int] = mapped_column(primary_key=True)
    work_order_no: Mapped[str] = mapped_column(String(30), index=True)
    position_id: Mapped[int] = mapped_column(Integer, index=True)
    actor: Mapped[str] = mapped_column(String(255), default="")
    confidence: Mapped[float] = mapped_column(Float, default=0.0)
    x_mm: Mapped[float] = mapped_column(Float, default=0.0)
    y_mm: Mapped[float] = mapped_column(Float, default=0.0)
    angle_deg: Mapped[float] = mapped_column(Float, default=0.0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class Setting(Base):
    """Betriebsparameter, die im Admin-Panel umgestellt werden — Taktung des
    Sammellaufs zum Beispiel. Schlüssel/Wert, damit ein neuer Parameter keine
    Migration braucht."""

    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(60), primary_key=True)
    value: Mapped[str] = mapped_column(String(400), default="")
    note: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )
    updated_by: Mapped[str] = mapped_column(String(254), default="")


class BatchPolicy(Base):
    """Freigaberegel für einen Werkstoff — die Freiheit des Betriebs.

    Nicht jeder Werkstoff verdient dieselbe Regel. Graphitfolie läuft in Menge
    und sammelt sich in Stunden; ein exotischer FKM kommt zweimal im Quartal und
    darf nicht auf einen zweiten Kunden warten, den es nicht gibt. Deshalb je
    Werkstoff (und optional je Dicke) eine eigene Zeile.

    ``thk = NULL`` gilt für alle Dicken des Werkstoffs. Die genauere Zeile
    gewinnt; gibt es keine, gelten die globalen Betriebsparameter aus
    ``settings``.
    """

    __tablename__ = "batch_policies"
    __table_args__ = (UniqueConstraint("mat", "thk", name="uq_batch_policy_mat_thk"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    mat: Mapped[str] = mapped_column(String(60), index=True)
    thk: Mapped[float | None] = mapped_column(Float, nullable=True)
    mode: Mapped[str] = mapped_column(String(20), default="sammel")  # sammel|sofort
    min_parts: Mapped[int | None] = mapped_column(Integer, nullable=True)
    min_utilisation: Mapped[float | None] = mapped_column(Float, nullable=True)
    max_age_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    due_lead_hours: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Deckel je Innenauftrag — 0/NULL = ohne Deckel, >0 = harte Grenze.
    # Ein Kundenauftrag wandert dabei nie auseinander (Auftrags-Atomarität).
    max_orders_per_group: Mapped[int | None] = mapped_column(Integer, nullable=True)
    max_plates_per_group: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Geometrie der Schachtelung — gilt nur für die Fertigung, nie für den
    # Preis (siehe domain/batch.py, NestOptions).
    nest_gap: Mapped[float | None] = mapped_column(Float, nullable=True)
    nest_margin: Mapped[float | None] = mapped_column(Float, nullable=True)
    nest_trim_w: Mapped[float | None] = mapped_column(Float, nullable=True)
    nest_trim_h: Mapped[float | None] = mapped_column(Float, nullable=True)

    note: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )
    updated_by: Mapped[str] = mapped_column(String(254), default="")


class NestRun(Base):
    """Ein Sammellauf: nimmt alle wartenden Positionen, schachtelt sie je
    Werkstoff und Dicke und legt daraus Innenaufträge an."""

    __tablename__ = "nest_runs"

    id: Mapped[int] = mapped_column(primary_key=True)
    no: Mapped[str] = mapped_column(String(30), unique=True, index=True)
    trigger: Mapped[str] = mapped_column(
        String(20), default="interval"
    )  # interval|manual
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, index=True
    )
    finished_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    engine_version: Mapped[str] = mapped_column(String(20), default="")
    n_orders: Mapped[int] = mapped_column(Integer, default=0)
    n_positions: Mapped[int] = mapped_column(Integer, default=0)
    n_parts: Mapped[int] = mapped_column(Integer, default=0)
    n_plates: Mapped[int] = mapped_column(Integer, default=0)
    n_work_orders: Mapped[int] = mapped_column(Integer, default=0)
    # Was die Sammelschachtelung gegenüber der Einzelschachtelung je Auftrag
    # eingespart hat — die Zahl, die die Entscheidung aus §8.2 rechtfertigt.
    solo_area_m2: Mapped[float] = mapped_column(Float, default=0.0)
    batch_area_m2: Mapped[float] = mapped_column(Float, default=0.0)
    note: Mapped[str] = mapped_column(Text, default="")

    work_orders: Mapped[list["WorkOrder"]] = relationship(
        back_populates="run", cascade="all, delete-orphan"
    )


class WorkOrder(Base):
    """Innenauftrag — ein Rüstvorgang: ein Werkstoff, eine Dicke, n Platten.

    Der Werker lädt einmal die Platte und schneidet alles, was darauf liegt.
    Deshalb ist die Schnittmenge (Werkstoff, Dicke) die Einheit, nicht der
    Kundenauftrag.
    """

    __tablename__ = "work_orders"

    id: Mapped[int] = mapped_column(primary_key=True)
    no: Mapped[str] = mapped_column(String(30), unique=True, index=True)
    run_id: Mapped[int] = mapped_column(
        ForeignKey("nest_runs.id", ondelete="CASCADE"), index=True
    )
    mat: Mapped[str] = mapped_column(String(60), index=True)
    mat_name: Mapped[str] = mapped_column(String(160), default="")
    thk: Mapped[float] = mapped_column(Float, default=2.0)
    fmt: Mapped[list] = mapped_column(JSON, default=list)  # [w, h] mm — erste Platte
    # Ein Innenauftrag darf Formate mischen: derselbe Werkstoff liegt in
    # mehreren Größen im Regal, und ein großes Teil braucht eine andere Platte
    # als die dreißig kleinen daneben. [[w, h, Anzahl], …]
    formats: Mapped[list] = mapped_column(JSON, default=list)
    status: Mapped[WorkOrderStatus] = mapped_column(
        Enum(WorkOrderStatus, native_enum=False),
        default=WorkOrderStatus.open,
        index=True,
    )
    n_plates: Mapped[int] = mapped_column(Integer, default=0)
    n_parts: Mapped[int] = mapped_column(Integer, default=0)
    n_orders: Mapped[int] = mapped_column(Integer, default=0)
    used_area_m2: Mapped[float] = mapped_column(Float, default=0.0)
    plate_area_m2: Mapped[float] = mapped_column(Float, default=0.0)
    utilisation: Mapped[float] = mapped_column(Float, default=0.0)
    engine_version: Mapped[str] = mapped_column(String(20), default="")
    due_date: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    #: Warum dieser Auftrag freigegeben wurde — im Klartext, so wie ihn die
    #: Freigaberegel formuliert hat. Eine Regel, deren Entscheidung man nicht
    #: nachlesen kann, wird beim ersten Zweifel abgeschaltet.
    release_reason: Mapped[str] = mapped_column(String(200), default="")
    policy_mode: Mapped[str] = mapped_column(String(20), default="sammel")
    #: Abstand, Rand und Beschnitt, mit denen dieser Plan gerechnet wurde.
    #: Gespeichert und nicht neu gelesen: sonst wird ein alter Plan mit neuen
    #: Werten interpretiert, sobald jemand die Einstellung ändert.
    nest_options: Mapped[dict] = mapped_column(JSON, default=dict)
    #: Die automatische Lage, solange von Hand geändert: Marken und Koordinaten,
    #: keine Kundennamen. ``None`` heißt: die Lage ist die des Rechenkerns.
    auto_layout: Mapped[dict | None] = mapped_column(JSON, nullable=True, default=None)
    layout_edited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    layout_edited_by: Mapped[str] = mapped_column(String(160), default="")
    #: Stand der Lage: jede gespeicherte Änderung zählt eins hoch. Daran hängt das
    #: Speichern (wer zuerst kommt, gewinnt) und die Marke auf DXF und Zeichnung.
    layout_rev: Mapped[int] = mapped_column(Integer, default=0)
    #: Wann eine Schnittdatei dieses Innenauftrags zum ersten Mal das Haus verließ:
    #: Download oder Fertigungsmeldung. Speichern bleibt erlaubt, der Editor warnt.
    cut_files_issued_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    #: Welche Kundenaufträge in diesem Innenauftrag als fertig markiert sind.
    #: Schlüssel = Auftragsnummer, Wert = Zeitpunkt der Fertigmeldung (ISO).
    #: Wird über die Fertigungsobfläche per Häkchen gesetzt, nicht über den
    #: globaleinnstatus des Innenauftrags.
    order_done: Mapped[dict] = mapped_column(JSON, default=dict)

    #: Welche Station diesen Innenauftrag schneidet. Die Zuordnung ist eine
    #: Werkstattentscheidung und bewegt keinen Preis (CLAUDE.md §5.5) — sie
    #: darf sich ändern, solange nicht angefangen wurde.
    station_id: Mapped[int | None] = mapped_column(
        ForeignKey("factory_stations.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    #: Wie die Zuordnung zustande kam: auto | suggest | manual.
    assign_mode: Mapped[str] = mapped_column(String(12), default="")
    #: Punktwert und Klartextbegründung des Vorschlags — nachlesbar, sonst
    #: wird die Regel beim ersten Zweifel abgeschaltet.
    assign_score: Mapped[float] = mapped_column(Float, default=0.0)
    assign_reason: Mapped[str] = mapped_column(String(400), default="")
    assigned_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    assigned_by: Mapped[str] = mapped_column(String(254), default="")
    #: Geschätzte Belegzeit in Minuten, mit den Werten der zugeordneten
    #: Station gerechnet. Gespeichert, nicht neu gerechnet: sonst zeigt die
    #: Warteschlange andere Zahlen, sobald jemand die Maschine umparametriert.
    planned_min: Mapped[float] = mapped_column(Float, default=0.0)
    #: Fertigungsort-Vorgabe, aufgelöst (nie "received"): aus den Aufträgen
    #: übernommen oder von Hand gesetzt. "" = jede Station.
    route_scope: Mapped[str] = mapped_column(String(200), default="")

    #: Materialbereitstellung — der eigene Schritt zwischen Zuordnung und
    #: Schnittstart: jemand hat die Platten aus dem Regal geholt und an der
    #: Maschine abgelegt. Zeitpunkt und Wer schrieb es, damit die Liste der
    #: noch nicht bereitgestellten Innenaufträge eine Liste bleibt und keine
    #: Vermutung.
    material_staged_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    material_staged_by: Mapped[str] = mapped_column(String(254), default="")
    #: Aus welchem Lagerort die Platten geholt wurden. Die Kennung zeigt auf
    #: ``stock_locations``; der Klartext daneben ist die Abschrift für die
    #: Liste, damit ein später gelöschter Ort die Buchung nicht leert.
    material_staged_location_id: Mapped[int | None] = mapped_column(
        ForeignKey("stock_locations.id", ondelete="SET NULL"), nullable=True
    )
    material_staged_location: Mapped[str] = mapped_column(String(200), default="")

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    started_by: Mapped[str] = mapped_column(String(254), default="")
    done_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    done_by: Mapped[str] = mapped_column(String(254), default="")
    machine: Mapped[str] = mapped_column(String(60), default="")
    note: Mapped[Text] = mapped_column(Text, default="")

    run: Mapped[NestRun] = relationship(back_populates="work_orders")
    plates: Mapped[list["WorkPlate"]] = relationship(
        back_populates="work_order",
        cascade="all, delete-orphan",
        order_by="WorkPlate.idx",
    )


class WorkPlate(Base):
    """Eine physische Platte im Innenauftrag, mit der Lage jedes Teils.

    ``placements`` trägt die Koordinaten aus dem Rechenkern — daraus wird die
    Plattenzeichnung erzeugt. Gespeichert und nicht neu gerechnet, damit das
    Papier in der Fertigung und das Bild am Bildschirm dasselbe zeigen, auch
    wenn der Nester später besser wird.
    """

    __tablename__ = "work_plates"

    id: Mapped[int] = mapped_column(primary_key=True)
    work_order_id: Mapped[int] = mapped_column(
        ForeignKey("work_orders.id", ondelete="CASCADE"), index=True
    )
    idx: Mapped[int] = mapped_column(Integer, default=0)
    fmt: Mapped[list] = mapped_column(JSON, default=list)
    used_h: Mapped[float] = mapped_column(Float, default=0.0)
    #: Gedreht verbaut (GRE) — ``used_h`` misst dann über die Plattenbreite,
    #: und Zeichnung/Schnittdatei stellen das Schnittband quer dar.
    turned: Mapped[bool] = mapped_column(Boolean, default=False)
    n_parts: Mapped[int] = mapped_column(Integer, default=0)
    utilisation: Mapped[float] = mapped_column(Float, default=0.0)
    placements: Mapped[list] = mapped_column(JSON, default=list)
    status: Mapped[WorkOrderStatus] = mapped_column(
        Enum(WorkOrderStatus, native_enum=False), default=WorkOrderStatus.open
    )
    #: Geschnitten aus einem Reststück statt aus einer vollen Platte
    #: (``offcuts.id``). Dann zieht der Sammellauf keine Platte vom Bestand ab.
    offcut_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: Zugeordnete Materialcharge (``material_lots.id``) für Rückverfolgung bis zum Lieferanten.
    lot_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)

    work_order: Mapped[WorkOrder] = relationship(back_populates="plates")
    items: Mapped[list["WorkItem"]] = relationship(
        back_populates="plate", cascade="all, delete-orphan"
    )


class WorkItem(Base):
    """Ein Teil auf einer Platte — und zu welchem Kundenauftrag es gehört.

    Das ist das Papier, das die Verwechslung in der Fertigung verhindert:
    jedes geschnittene Teil trägt eine Marke, und die Marke steht auf der
    Plattenzeichnung genau an der Stelle, an der das Teil liegt.
    """

    __tablename__ = "work_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    plate_id: Mapped[int] = mapped_column(
        ForeignKey("work_plates.id", ondelete="CASCADE"), index=True
    )
    work_order_id: Mapped[int] = mapped_column(
        ForeignKey("work_orders.id", ondelete="CASCADE"), index=True
    )
    position_id: Mapped[int | None] = mapped_column(
        ForeignKey("order_positions.id"), nullable=True, index=True
    )
    tag: Mapped[str] = mapped_column(String(20), default="")  # Marke, z. B. "A3"
    order_no: Mapped[str] = mapped_column(String(30), default="", index=True)
    customer: Mapped[str] = mapped_column(EncryptedText("work_items.customer"), default="")
    customer_ref: Mapped[str] = mapped_column(String(80), default="")
    label: Mapped[str] = mapped_column(String(200), default="")
    od: Mapped[float] = mapped_column(Float, default=0.0)
    di: Mapped[float] = mapped_column(Float, default=0.0)
    qty: Mapped[int] = mapped_column(Integer, default=1)
    from_remnant: Mapped[bool] = mapped_column(Boolean, default=False)
    shape: Mapped[dict | None] = mapped_column(EncryptedJSON("work_items.shape"), nullable=True)

    plate: Mapped[WorkPlate] = relationship(back_populates="items")


class RecoveryCode(Base):
    """Ein Wiederherstellungscode — einmal verwendbar, nur als Hash.

    Der Grund für die eigene Tabelle statt einer JSON-Liste am Benutzer: ein
    Code ist ein Anmeldegeheimnis und wird wie ein Passwort behandelt, also
    bcrypt-gehasht und einzeln entwertet. In einer JSON-Spalte müsste man die
    ganze Liste neu schreiben, um einen Code zu verbrauchen — und ein
    gleichzeitiger zweiter Versuch würde ihn wieder gültig machen.

    Sie sind der Ausweg aus dem Fall, der ein 2FA-Konto sonst tötet: Telefon
    weg, App weg, Konto weg. Deshalb werden sie *vor* dem Einschalten
    angezeigt und genau einmal.
    """

    __tablename__ = "recovery_codes"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    code_hash: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    used_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    user: Mapped["User"] = relationship()


class PasswordReset(Base):
    """Ein per E-Mail verschickter Code zum Zurücksetzen des Passworts.

    Nur der bcrypt-Hash liegt hier, wie bei ``RecoveryCode``. Ein Code gilt
    kurz, einmal und nur für wenige Versuche; ``attempts`` wird *vor* dem
    Vergleich hochgezählt (``routers/auth.reset_confirm``), damit zwei
    gleichzeitige Versuche nicht beide den letzten bekommen. Additive Tabelle,
    ``create_all`` legt sie an; alte Zeilen räumt ``reset_request`` ab.
    """

    __tablename__ = "password_resets"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    code_hash: Mapped[str] = mapped_column(String(255))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    used_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class AuthSession(Base):
    """Refresh-Token-Sitzung — nur der SHA-256 des Tokens liegt in der DB."""

    __tablename__ = "auth_sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    refresh_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    ip: Mapped[str] = mapped_column(String(64), default="")
    user_agent: Mapped[str] = mapped_column(String(300), default="")

    user: Mapped["User"] = relationship()


class ShipmentStatus(str, enum.Enum):
    packing = "packing"
    shipped = "shipped"
    delivered = "delivered"
    returned = "returned"


class Shipment(Base):
    """Ein Versandvorgang — ein Paket oder Speditionspaket mit Tracking."""

    __tablename__ = "shipments"

    id: Mapped[int] = mapped_column(primary_key=True)
    no: Mapped[str] = mapped_column(String(30), unique=True, index=True)
    status: Mapped[ShipmentStatus] = mapped_column(
        Enum(ShipmentStatus, native_enum=False), default=ShipmentStatus.packing
    )
    carrier: Mapped[str] = mapped_column(String(80), default="")
    tracking: Mapped[str] = mapped_column(String(120), default="")
    #: Versandkosten, von Hand erfasst (z. B. am Auftragsbüro als manueller
    #: Versand vereinbart). 0 heißt „nicht erfasst" — kein Preis ist kein
    #: nuller Preis.
    price: Mapped[float] = mapped_column(Float, default=0.0)
    ship_to: Mapped[dict] = mapped_column(EncryptedJSON("shipments.ship_to"), default=dict)
    note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    shipped_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    delivered_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    packed_by: Mapped[str] = mapped_column(String(254), default="")
    shipped_by: Mapped[str] = mapped_column(String(254), default="")

    items: Mapped[list["ShipmentItem"]] = relationship(
        back_populates="shipment", cascade="all, delete-orphan"
    )


class ShipmentItem(Base):
    """Eine Order-Position in einem Versand — Zuordnung Auftrag → Paket."""

    __tablename__ = "shipment_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    shipment_id: Mapped[int] = mapped_column(
        ForeignKey("shipments.id", ondelete="CASCADE"), index=True
    )
    order_id: Mapped[int] = mapped_column(
        ForeignKey("orders.id", ondelete="CASCADE"), index=True
    )
    order_no: Mapped[str] = mapped_column(String(30), default="", index=True)
    position_id: Mapped[int | None] = mapped_column(
        ForeignKey("order_positions.id", ondelete="SET NULL"), nullable=True, index=True
    )
    work_order_no: Mapped[str] = mapped_column(String(30), default="")
    tag: Mapped[str] = mapped_column(String(20), default="")
    label: Mapped[str] = mapped_column(String(200), default="")
    mat: Mapped[str] = mapped_column(String(60), default="")
    thk: Mapped[float] = mapped_column(Float, default=0.0)
    qty: Mapped[int] = mapped_column(Integer, default=1)
    note: Mapped[str] = mapped_column(Text, default="")

    shipment: Mapped[Shipment] = relationship(back_populates="items")


class FactorySite(Base):
    """Ein Standort: eine Anschrift, eine Lage auf der Karte, eine oder mehr Hallen.

    Zwei Hallen am selben Standort teilen Anschrift und Lager-Erreichbarkeit;
    eine Halle an einem anderen Standort ist ein eigener Standort. Zwischen
    Standorten rechnet Gimel keinen Weg — der wäre geraten.
    """

    __tablename__ = "factory_sites"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120), default="Standort")
    code: Mapped[str] = mapped_column(String(20), default="")
    address: Mapped[str] = mapped_column(String(300), default="")
    #: WGS84. 0/0 = nicht erfasst.
    lat: Mapped[float] = mapped_column(Float, default=0.0)
    lon: Mapped[float] = mapped_column(Float, default=0.0)
    note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )


class FactoryHall(Base):
    """Eine Halle an einem Standort, mit ihren Ebenen (``FactoryFloor.level``).

    Der Kartenanker legt den Ursprung des Grundrisses (0/0 in Metern) auf
    einen Punkt der Erde; ``rotation_deg`` dreht die x-Achse von Osten
    gegen den Uhrzeigersinn. Die Karte ist aus, bis jemand sie einschaltet:
    jede Kachel geht an einen fremden Server und verrät dort die Lage.
    """

    __tablename__ = "factory_halls"

    id: Mapped[int] = mapped_column(primary_key=True)
    site_id: Mapped[int | None] = mapped_column(
        ForeignKey("factory_sites.id", ondelete="SET NULL"), nullable=True, index=True
    )
    name: Mapped[str] = mapped_column(String(120), default="Halle")
    code: Mapped[str] = mapped_column(String(20), default="")
    sort: Mapped[int] = mapped_column(Integer, default=0)
    lat: Mapped[float] = mapped_column(Float, default=0.0)
    lon: Mapped[float] = mapped_column(Float, default=0.0)
    rotation_deg: Mapped[float] = mapped_column(Float, default=0.0)
    map_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )


class FactoryFloor(Base):
    """Grundriss der Halle — Umriss, Flächen, Hindernisse, Gänge, Tore.

    Alle Koordinaten in **Metern**, durchgehend, auch die Stationen. Der
    Maßstab ``scale`` ist reine Darstellung und geht in keine Rechnung ein.

    ``aisles`` ist der einzige Teil, mit dem gerechnet wird: das Gangnetz
    trägt die Entfernung Lager → Maschine, und die geht in die
    Maschinenzuordnung ein (``domain/routing.py``). Ohne Gänge rechnet der
    Kern mit Luftlinie und sagt es dazu — eine Schätzung, die wie eine
    Messung aussieht, ist schlimmer als keine.
    """

    __tablename__ = "factory_floors"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120), default="Halle")
    outline: Mapped[list] = mapped_column(JSON, default=list)
    #: Benannte Flächen: [{name, kind, colour, points: [[x,y], …]}, …]
    zones: Mapped[list] = mapped_column(JSON, default=list)
    #: Was den Weg versperrt: [{name, points: [[x,y], …]}, …]
    obstacles: Mapped[list] = mapped_column(JSON, default=list)
    #: Förderbänder (core/conveyor.py): Mittellinie mit Höhe, Breite, von/zu Station.
    conveyors: Mapped[list] = mapped_column(JSON, default=list)
    #: Tore und Türen: [{name, x, y, width, kind}, …]
    doors: Mapped[list] = mapped_column(JSON, default=list)
    #: Transportnetz: {"nodes": [[x,y], …], "edges": [[i,j], …]}
    aisles: Mapped[dict] = mapped_column(JSON, default=dict)
    scale: Mapped[float] = mapped_column(Float, default=40.0)
    #: Raster- und Fangweite des Editors, in Metern.
    grid: Mapped[float] = mapped_column(Float, default=1.0)
    snap: Mapped[float] = mapped_column(Float, default=0.25)
    bg: Mapped[str] = mapped_column(String(20), default="#f5f5f0")
    #: Zu welcher Halle diese Ebene gehört, und welche Ebene sie ist
    #: (0 = Erdgeschoss, 1 = 1. OG, -1 = Keller).
    hall_id: Mapped[int | None] = mapped_column(
        ForeignKey("factory_halls.id", ondelete="SET NULL"), nullable=True, index=True
    )
    level: Mapped[int] = mapped_column(Integer, default=0)
    level_name: Mapped[str] = mapped_column(String(60), default="")
    #: Fußbodenhöhe über dem Erdgeschoss und lichte Höhe, in Metern — nur Darstellung.
    elevation_m: Mapped[float] = mapped_column(Float, default=0.0)
    height_m: Mapped[float] = mapped_column(Float, default=6.0)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )
    updated_by: Mapped[str] = mapped_column(String(254), default="")


class FactoryStationType(str, enum.Enum):
    accounting = "accounting"
    production = "production"
    shipping = "shipping"
    warehouse = "warehouse"


class StationRouting(str, enum.Enum):
    pull = "pull"
    smart_suggest = "smart_suggest"
    smart_auto = "smart_auto"


class StationVisibility(str, enum.Enum):
    collapse = "collapse"
    hide = "hide"


class MachineKind(str, enum.Enum):
    """Womit geschnitten wird. Bestimmt nichts allein — die Maschinenwerte
    darunter tun es —, aber es sortiert die Halle für den, der sie ansieht."""

    none = ""
    plotter = "plotter"
    punch = "punch"
    waterjet = "waterjet"
    manual = "manual"


class TwinView(Base):
    """Gespeicherte Kamera im Twin Studio — ein Lesezeichen je Ebene.

    Reine Darstellung: Position, Ziel und Blickart. Nichts davon geht in eine
    Planung ein. Additive Tabelle, ``create_all`` legt sie an.
    """

    __tablename__ = "twin_views"

    id: Mapped[int] = mapped_column(primary_key=True)
    floor_id: Mapped[int | None] = mapped_column(
        ForeignKey("factory_floors.id", ondelete="CASCADE"), nullable=True, index=True
    )
    name: Mapped[str] = mapped_column(String(80))
    #: {"position": [x,y,z], "target": [x,y,z], "mode": "orbit"|"walk", "view": "three"|"iso"|"2d"}
    camera: Mapped[dict] = mapped_column(JSON, default=dict)
    created_by: Mapped[str] = mapped_column(String(200), default="")
    #: Wer sie angelegt hat, als Konto-Id: eine geänderte oder neu vergebene
    #: E-Mail-Adresse übernimmt so kein Löschrecht.
    created_by_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class FactoryStation(Base):
    """Ein Arbeitsplatz auf dem Grundriss.

    Die Maschinenwerte (Vorschub, Rüsten, Tischgröße, Kapazität) sind die
    Eingabe der Zuordnung in ``domain/routing.py``. **0 heißt überall
    „unbekannt", nicht „null"**: ein fehlender Wert schaltet seinen Faktor ab,
    statt eine erfundene Zahl in eine Entscheidung zu tragen. Alle diese
    Werte gehören auf die Prüfliste in CLAUDE.md §7, bevor irgendjemand
    seine Fertigungsplanung darauf stützt.
    """

    __tablename__ = "factory_stations"

    id: Mapped[int] = mapped_column(primary_key=True)
    label: Mapped[str] = mapped_column(String(120))
    type: Mapped[FactoryStationType] = mapped_column(
        Enum(FactoryStationType, native_enum=False), index=True
    )
    subtype: Mapped[str] = mapped_column(String(80), default="")
    x: Mapped[float] = mapped_column(Float, default=0.0)
    y: Mapped[float] = mapped_column(Float, default=0.0)
    w: Mapped[float] = mapped_column(Float, default=120.0)
    h: Mapped[float] = mapped_column(Float, default=80.0)
    rotation: Mapped[float] = mapped_column(Float, default=0.0)
    colour: Mapped[str] = mapped_column(String(20), default="#0a5b9c")
    materials: Mapped[list] = mapped_column(JSON, default=list)
    thicknesses: Mapped[list] = mapped_column(JSON, default=list)
    assigned_users: Mapped[list] = mapped_column(JSON, default=list)
    routing: Mapped[StationRouting] = mapped_column(
        Enum(StationRouting, native_enum=False), default=StationRouting.pull
    )
    visibility: Mapped[StationVisibility] = mapped_column(
        Enum(StationVisibility, native_enum=False), default=StationVisibility.collapse
    )
    active: Mapped[bool] = mapped_column(Boolean, default=True)

    # ---- Maschine ---------------------------------------------------------
    machine_kind: Mapped[str] = mapped_column(String(20), default="")
    #: Schnittvorschub in mm/s. 0 = unbekannt → Zeitfaktor entfällt.
    speed_mm_s: Mapped[float] = mapped_column(Float, default=0.0)
    #: Anstechen und Positionieren je Teil, in Sekunden.
    pierce_s: Mapped[float] = mapped_column(Float, default=0.0)
    #: Rüsten je Innenauftrag, in Minuten.
    setup_min: Mapped[float] = mapped_column(Float, default=0.0)
    #: Aufschlag, wenn Werkstoff oder Dicke wechseln.
    changeover_min: Mapped[float] = mapped_column(Float, default=0.0)
    #: Platte auflegen und abräumen, je Platte.
    handling_min_per_plate: Mapped[float] = mapped_column(Float, default=0.0)
    #: Größte Platte, die auf den Tisch geht, in mm. 0 = keine Grenze bekannt.
    max_sheet_w: Mapped[float] = mapped_column(Float, default=0.0)
    max_sheet_h: Mapped[float] = mapped_column(Float, default=0.0)
    #: Dickenbereich in mm. 0 = keine Grenze bekannt.
    thk_min: Mapped[float] = mapped_column(Float, default=0.0)
    thk_max: Mapped[float] = mapped_column(Float, default=0.0)
    #: Maschinenstundensatz — nur Anzeige und Vergleich, nie ein Kundenpreis.
    cost_per_h: Mapped[float] = mapped_column(Float, default=0.0)
    #: Verfügbare Minuten je Arbeitstag. 0 = unbekannt → Lastfaktor gedämpft.
    capacity_min_per_day: Mapped[float] = mapped_column(Float, default=0.0)
    #: Diese Station ist ein Lager — von hier wird die Entfernung gemessen.
    is_storage: Mapped[bool] = mapped_column(Boolean, default=False)

    # ---- Zeiten der nicht schneidenden Stationen -------------------------
    # Ein Packtisch, ein Regal und ein Schreibtisch haben keinen Vorschub in
    # mm/s, aber sie haben ein Aufsetzen und ein Pro-Stück. Ohne diese beiden
    # Zahlen können sie so wenig eine Fertigstellung versprechen wie ein
    # Plotter ohne Vorschub — 0 heißt auch hier „unbekannt", nicht „null".
    #: Grundzeit je Vorgang, in Minuten.
    task_min: Mapped[float] = mapped_column(Float, default=0.0)
    #: Zeit je Einheit (Platte, Position, Sendungsposten), in Minuten.
    unit_min: Mapped[float] = mapped_column(Float, default=0.0)
    note: Mapped[str] = mapped_column(Text, default="")

    # ---- 3D-Modell -------------------------------------------------------
    #: Dateiname im Datenordner ``factory-models``. Leer = kein eigenes Modell;
    #: der Leitstand zeichnet dann den neutralen Stationskörper.
    model_file: Mapped[str] = mapped_column(String(180), default="")
    #: Größenfaktor und eigene Drehung; die Stationsdrehung kommt zusätzlich.
    model_scale: Mapped[float] = mapped_column(Float, default=1.0)
    model_rotation: Mapped[float] = mapped_column(Float, default=0.0)
    #: Welches eingebaute Modell gezeichnet wird, wenn keine Datei hinterlegt ist.
    #: Leer = passend zu Typ und Maschinenart; ``box`` = nur ein Quader (vorläufig);
    #: sonst eine Art aus ``MODEL_KINDS`` (Router). Eine hochgeladene Datei gilt immer zuerst.
    model_kind: Mapped[str] = mapped_column(String(16), default="")
    #: Ein Mitarbeiter arbeitet an dieser Station — die 3D-Ansicht zeigt eine Figur.
    #: Reine Darstellung der Planung, keine Ortung und kein Maschinensignal.
    staffed: Mapped[bool] = mapped_column(Boolean, default=False)
    #: Auf welcher Ebene die Station steht. Leer = erste Ebene (Bestand).
    floor_id: Mapped[int | None] = mapped_column(
        ForeignKey("factory_floors.id", ondelete="SET NULL"), nullable=True, index=True
    )

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )


class RobotAsset(Base):
    """Eine mobile Transportressource — kein Arbeitsplatz, keine Aufgabe.

    Der Roboter ist bewusst **keine** ``FactoryStation``: er hat keinen
    Werkstoff, keine Tabelle und keine Stationswarteschlange. Er fährt Wege,
    die aus dem Gangnetz kommen, und seine Aufgabe ist ein Transport. Diese
    Trennung hält die Zuordnung und den Arbeitsvorrat unverändert, wenn später
    eine echte Flotte dazukommt.

    ``gateway_id == "sim"`` heißt: die Position wird aus ``route``, ``speed``
    und der verstrichenen Zeit gerechnet (``services.robot_fleet``). Eine echte
    Flotte schreibt ``x``/``y``/``heading_deg``; fehlende Werte bleiben
    ``NULL``. Für Batterie und Position gilt **nicht** die 0-ist-unbekannt-
    Regel: 0 % ist leer, (0, 0) ist ein echter Punkt. Deshalb sind beide
    Spalten nullable und werden nie mit einer erfundenen Null gefüllt.
    """

    __tablename__ = "robot_assets"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120), default="Roboter")
    #: agv | amr | arm — nur Anzeige und Filter, keine Rechenlogik.
    kind: Mapped[str] = mapped_column(String(20), default="agv")
    floor_id: Mapped[int | None] = mapped_column(
        ForeignKey("factory_floors.id", ondelete="SET NULL"), nullable=True, index=True
    )
    #: Weg in Metern: [[x, y], …]. Leer = keine Simulation, keine Position.
    route: Mapped[list] = mapped_column(JSON, default=list)
    #: loop = Rundkurs, pingpong = hin und zurück.
    route_mode: Mapped[str] = mapped_column(String(12), default="pingpong")
    speed_m_s: Mapped[float] = mapped_column(Float, default=0.8)
    #: NULL = unbekannt. 0 ist ein leerer Akku, kein fehlender Wert.
    battery_pct: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: idle | moving | charging | blocked | error | offline
    state: Mapped[str] = mapped_column(String(20), default="idle")
    #: sim oder die Kennung des Flotten-Gateways.
    gateway_id: Mapped[str] = mapped_column(String(60), default="sim")
    capabilities: Mapped[list] = mapped_column(JSON, default=list)
    payload_kg: Mapped[float] = mapped_column(Float, default=0.0)
    #: Von Hand gesetzt, damit ein Demo-Lauf nicht mitten im Weg beginnt.
    sim_started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    #: Letzte gemeldete Position einer echten Flotte. NULL = unbekannt.
    x: Mapped[float | None] = mapped_column(Float, nullable=True)
    y: Mapped[float | None] = mapped_column(Float, nullable=True)
    heading_deg: Mapped[float | None] = mapped_column(Float, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )


class RobotGateway(Base):
    """Ein Flotten-Gateway mit seinen Endpunkten — die Naht zur echten Halle.

    ``code`` ist derselbe Name, den ``RobotAsset.gateway_id`` trägt. ``kind``
    entscheidet, wer den Auftrag ausführt: ``sim`` rechnet nur, ``http`` ruft
    die eingetragenen Pfade auf, ``vda5050`` ist der Platz für einen lokalen
    MQTT-Adapter (noch nicht verdrahtet). Die Pfade sind **relativ zur
    Basisadresse** oder vollständige lokale URLs; Gimel ruft nie einen fremden
    Cloud-Endpunkt auf. Das Token ist zugleich Ausgangsgeheimnis und der
    Schlüssel, mit dem ein Gateway Telemetrie meldet.
    """

    __tablename__ = "robot_gateways"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(60), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120), default="Gateway")
    #: sim | http | vda5050
    kind: Mapped[str] = mapped_column(String(20), default="sim")
    base_url: Mapped[str] = mapped_column(String(300), default="")
    #: {"health": "/health", "deploy": "/robots/deploy", "command": "/robots/orders",
    #:  "cancel": "/robots/orders/cancel"} — fehlende Schlüssel werden nicht geraten.
    endpoints: Mapped[dict] = mapped_column(JSON, default=dict)
    token: Mapped[str] = mapped_column(EncryptedText("robot_gateways.token"), default="")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    note: Mapped[Text] = mapped_column(Text, default="")
    last_seen_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )


class RobotProgram(Base):
    """Ein versionsfähiges Roboterprogramm — Mission, Treiber oder Konfiguration.

    Der Text wird **gespeichert und ausgeliefert**, nie ausgewertet. Ausführen
    darf ihn allein das Flotten-Gateway; Gimel kennt weder Syntax noch
    Sicherheitsregeln einer Robotersteuerung. Jede Änderung ist eine neue
    Version mit eigenem SHA-256; eine deployte Version bleibt unverändert.
    """

    __tablename__ = "robot_programs"
    __table_args__ = (
        UniqueConstraint("name", "version", name="uq_robot_program_name_version"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120), index=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    #: mission | driver | config
    kind: Mapped[str] = mapped_column(String(20), default="mission")
    #: python | vda5050 | json | text
    language: Mapped[str] = mapped_column(String(20), default="json")
    body: Mapped[str] = mapped_column(Text, default="")
    checksum: Mapped[str] = mapped_column(String(64), default="")
    #: draft | approved | deployed | retired
    status: Mapped[str] = mapped_column(String(20), default="draft", index=True)
    robot_id: Mapped[int | None] = mapped_column(
        ForeignKey("robot_assets.id", ondelete="SET NULL"), nullable=True, index=True
    )
    gateway_id: Mapped[str] = mapped_column(String(60), default="")
    notes: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[str] = mapped_column(String(254), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    approved_by: Mapped[str] = mapped_column(String(254), default="")
    approved_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    deployed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class RobotDeployment(Base):
    """Ein Auslieferungsversuch eines Programms an genau einen Roboter.

    ``state`` ist ``queued``, ``accepted``, ``rejected`` oder ``failed``.
    ``message`` ist die Antwort des Gateways, gekürzt und ohne Geheimnis.
    ``rollback_of_id`` zeigt auf den Versuch, der damit zurückgenommen wird.
    """

    __tablename__ = "robot_deployments"

    id: Mapped[int] = mapped_column(primary_key=True)
    program_id: Mapped[int | None] = mapped_column(
        ForeignKey("robot_programs.id", ondelete="SET NULL"), nullable=True, index=True
    )
    robot_id: Mapped[int | None] = mapped_column(
        ForeignKey("robot_assets.id", ondelete="SET NULL"), nullable=True, index=True
    )
    gateway_id: Mapped[str] = mapped_column(String(60), default="")
    state: Mapped[str] = mapped_column(String(20), default="queued", index=True)
    message: Mapped[str] = mapped_column(String(500), default="")
    actor: Mapped[str] = mapped_column(String(254), default="")
    rollback_of_id: Mapped[int | None] = mapped_column(
        ForeignKey("robot_deployments.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    finished_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class FleetScenario(Base):
    """Ein gespeichertes Was-wäre-wenn für geplante Roboter (Twin Studio).

    Nur Eingaben, keine Ergebnisse: die Rechnung ist gesät und wiederholbar,
    ein gespeichertes Szenario rechnet beim Öffnen neu gegen den aktuellen
    Fluss. Geplante Roboter sind hier JSON, nie ``RobotAsset`` — sie bekommen
    keinen Transport und erscheinen in keiner Zuteilung. Additive Tabelle.
    """

    __tablename__ = "fleet_scenarios"

    id: Mapped[int] = mapped_column(primary_key=True)
    floor_id: Mapped[int | None] = mapped_column(
        ForeignKey("factory_floors.id", ondelete="CASCADE"), nullable=True, index=True
    )
    name: Mapped[str] = mapped_column(String(80))
    params: Mapped[dict] = mapped_column(JSON, default=dict)
    created_by: Mapped[str] = mapped_column(String(200), default="")
    created_by_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)


class RobotJob(Base):
    """Ein Transportauftrag mit Auftragskontext — die Arbeit, die ein Roboter tut.

    Die Zeile ist die Brücke zwischen Fertigung und Flotte: sie nennt den
    Innenauftrag, den Kundenauftrag und die Aufgabe, aus der sie entstanden
    ist, dazu Start, Ziel, geplanten Weg und den Roboter. Der Kontext ist ein
    Schnappschuss; ändert sich der Auftrag später, bleibt nachlesbar, wofür
    der Transport gedacht war.
    """

    __tablename__ = "robot_jobs"

    id: Mapped[int] = mapped_column(primary_key=True)
    ref: Mapped[str] = mapped_column(String(30), unique=True, index=True)
    #: pickup | delivery | transfer | return
    kind: Mapped[str] = mapped_column(String(16), default="transfer", index=True)
    #: proposed | approved | assigned | running | done | failed | cancelled
    state: Mapped[str] = mapped_column(String(16), default="proposed", index=True)
    #: 1 = eilig, 5 = normal, 9 = darf warten.
    priority: Mapped[int] = mapped_column(Integer, default=5)

    order_id: Mapped[int | None] = mapped_column(
        ForeignKey("orders.id", ondelete="SET NULL"), nullable=True, index=True
    )
    order_no: Mapped[str] = mapped_column(String(30), default="", index=True)
    work_order_id: Mapped[int | None] = mapped_column(
        ForeignKey("work_orders.id", ondelete="SET NULL"), nullable=True, index=True
    )
    work_order_no: Mapped[str] = mapped_column(String(30), default="", index=True)
    station_task_id: Mapped[int | None] = mapped_column(
        ForeignKey("station_tasks.id", ondelete="SET NULL"), nullable=True
    )
    task_kind: Mapped[str] = mapped_column(String(16), default="")
    task_ref: Mapped[str] = mapped_column(String(30), default="")

    from_station_id: Mapped[int | None] = mapped_column(
        ForeignKey("factory_stations.id", ondelete="SET NULL"), nullable=True
    )
    to_station_id: Mapped[int | None] = mapped_column(
        ForeignKey("factory_stations.id", ondelete="SET NULL"), nullable=True
    )
    robot_id: Mapped[int | None] = mapped_column(
        ForeignKey("robot_assets.id", ondelete="SET NULL"), nullable=True, index=True
    )
    floor_id: Mapped[int | None] = mapped_column(
        ForeignKey("factory_floors.id", ondelete="SET NULL"), nullable=True, index=True
    )
    #: Geplanter Weg in Metern: [[x, y], …] — was das Gateway fährt.
    route: Mapped[list] = mapped_column(JSON, default=list)
    route_m: Mapped[float] = mapped_column(Float, default=0.0)
    route_exact: Mapped[bool] = mapped_column(Boolean, default=False)
    route_note: Mapped[str] = mapped_column(String(300), default="")
    #: Geschätzte Fahrzeit in Sekunden; 0 = unbekannt, nicht sofort da.
    eta_s: Mapped[float] = mapped_column(Float, default=0.0)

    #: Was transportiert wird: {material, thickness, parts, weight_kg, note}.
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    #: Schnappschuss des Auftragskontexts (Nummern, Frist, Positionen).
    context: Mapped[dict] = mapped_column(JSON, default=dict)
    note: Mapped[Text] = mapped_column(Text, default="")

    created_by: Mapped[str] = mapped_column(String(254), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    approved_by: Mapped[str] = mapped_column(String(254), default="")
    approved_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    assigned_by: Mapped[str] = mapped_column(String(254), default="")
    assigned_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    finished_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    finished_by: Mapped[str] = mapped_column(String(254), default="")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )


class RobotJobRestore(Base):
    """Was ein Roboter vor einem Transport war — für die Rückkehr danach.

    Bis 2026-11-05 lag dieser Schnappschuss als ``_robot_before`` im
    ``context`` des Auftrags. Das war ein privater Zustand in einem Feld, das
    nur Auftragsdaten zeigen soll. Die Zeile ist additiv (``create_all``) und
    wird beim Start angelegt; ``done``/``cancel``/``fail`` stellen daraus wieder
    her und löschen sie. Ein alter Auftrag mit ``_robot_before`` im Kontext
    bleibt lesbar.
    """

    __tablename__ = "robot_job_restore"

    id: Mapped[int] = mapped_column(primary_key=True)
    job_id: Mapped[int] = mapped_column(
        ForeignKey("robot_jobs.id", ondelete="CASCADE"), nullable=False,
        unique=True, index=True,
    )
    robot_id: Mapped[int | None] = mapped_column(
        ForeignKey("robot_assets.id", ondelete="SET NULL"), nullable=True, index=True
    )
    route: Mapped[list] = mapped_column(JSON, default=list)
    route_mode: Mapped[str] = mapped_column(String(12), default="pingpong")
    sim_started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    state: Mapped[str] = mapped_column(String(20), default="idle")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class RobotEvent(Base):
    """Telemetrie und Zustandswechsel einer Flotte — höchstens ein Herzschlag.

    Die Zeile ist kein Historiker: das Gateway schickt Zustandswechsel und
    einen Takt, nicht jeden Sensorwert. ``idempotency_key`` macht einen
    Wiederholungsversuch folgenlos. ``quality`` trennt gemessen, gemeldet und
    geschätzt, damit die Halle nicht drei verschiedene Wahrheiten als eine
    zeigt.
    """

    __tablename__ = "robot_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    robot_id: Mapped[int | None] = mapped_column(
        ForeignKey("robot_assets.id", ondelete="CASCADE"), nullable=True, index=True
    )
    gateway_id: Mapped[str] = mapped_column(String(60), default="", index=True)
    type: Mapped[str] = mapped_column(String(40), default="telemetry", index=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    #: measured | reported | estimated | unknown
    quality: Mapped[str] = mapped_column(String(20), default="reported")
    idempotency_key: Mapped[str] = mapped_column(String(160), default="", index=True)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)


class StationTask(Base):
    """Eine Aufgabe im Arbeitsvorrat einer Station — die Abarbeitungsliste.

    Bis hierher hatte nur die Fertigung eine Warteschlange, und die war eine
    Sortierung nach Anlagedatum. Diese Zeile gibt **jeder** Station einen
    Arbeitsvorrat mit Reihenfolge, Priorität und Begründung: dem Regal
    (``pick``), der Maschine (``cut``), dem Packtisch (``pack``) und dem
    Schreibtisch (``process``).

    **Die Zeile ist abgeleitet, nicht führend.** Was es zu tun gibt, steht
    weiterhin in den Innenaufträgen und Kundenaufträgen; ``reconcile`` in
    ``services/worklist.py`` gleicht ab und legt an, was fehlt. Was hier und
    nur hier steht, ist die *Disposition*: an welcher Station, an welcher
    Stelle, mit welcher Begründung. Deshalb ist ``(kind, ref)`` eindeutig —
    eine Aufgabe zweimal in der Liste wäre eine Aufgabe, die zweimal gemacht
    wird.

    Für ``cut`` bleibt ``WorkOrder.station_id`` die maßgebliche Zuordnung
    (Laufkarte, Schnittdateien und das Produktionsmodul lesen sie); die
    Aufgabenzeile schreibt beim Zuordnen durch, statt eine zweite Wahrheit
    aufzumachen. Genauso setzt eine fertiggemeldete ``pick``-Aufgabe die
    Bereitstellung am Innenauftrag — der Haken und der Zeitstempel sind
    dieselbe Tatsache.
    """

    __tablename__ = "station_tasks"
    __table_args__ = (UniqueConstraint("kind", "ref", name="uq_station_task_kind_ref"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    #: pick | cut | pack | process — siehe domain/worklist.KIND_STATION_TYPE.
    kind: Mapped[str] = mapped_column(String(16), index=True)
    #: Innenauftragsnummer (pick/cut) oder Auftragsnummer (pack/process).
    ref: Mapped[str] = mapped_column(String(30), index=True)
    label: Mapped[str] = mapped_column(String(200), default="")

    # Abzug der Quelle, bei jedem Abgleich aufgefrischt. Bewusst denormalisiert:
    # die Rüstfamilie (Werkstoff + Dicke) und das Mengengerüst werden bei jeder
    # Darstellung *und* bei jeder Reihenfolgeberechnung gebraucht, und ein Join
    # je Aufgabe wäre der Preis dafür, dieselbe Zahl zweimal an derselben
    # Stelle zu haben.
    mat: Mapped[str] = mapped_column(String(60), default="", index=True)
    mat_name: Mapped[str] = mapped_column(String(160), default="")
    thk: Mapped[float] = mapped_column(Float, default=0.0)
    #: Was die Station wirklich anfasst: Platten, Positionen, Sendungsposten.
    units: Mapped[int] = mapped_column(Integer, default=1)

    station_id: Mapped[int | None] = mapped_column(
        ForeignKey("factory_stations.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    #: Ziel der Kommissionierung: die Maschine, an der die Platten stehen
    #: sollen. Der Weg dorthin ist die Arbeit, also gehört er an die Aufgabe.
    to_station_id: Mapped[int | None] = mapped_column(
        ForeignKey("factory_stations.id", ondelete="SET NULL"), nullable=True
    )
    #: Platz in der Abarbeitungsliste, 1-basiert. 0 = noch nicht einsortiert.
    seq: Mapped[int] = mapped_column(Integer, default=0)
    #: Von Hand gesetzte Reihenfolge wird beim Neuplanen nicht überschrieben —
    #: sonst wäre das Verschieben eine Geste ohne Wirkung.
    seq_pinned: Mapped[bool] = mapped_column(Boolean, default=False)
    #: Punktwert und Klartext der Priorität, wie sie zuletzt gerechnet wurde.
    priority: Mapped[float] = mapped_column(Float, default=0.0)
    priority_reason: Mapped[str] = mapped_column(String(300), default="")
    #: Warum die Aufgabe an dieser Stelle steht.
    seq_reason: Mapped[str] = mapped_column(String(300), default="")

    #: Wie die Zuordnung zustande kam: auto | suggest | manual.
    assign_mode: Mapped[str] = mapped_column(String(12), default="")
    assign_reason: Mapped[str] = mapped_column(String(400), default="")
    assigned_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    assigned_by: Mapped[str] = mapped_column(String(254), default="")
    #: Geschätzte Belegzeit in Minuten, mit den Werten der zugeordneten
    #: Station gerechnet und festgeschrieben — sonst verschiebt eine
    #: Parameteränderung von heute die Warteschlange von gestern.
    planned_min: Mapped[float] = mapped_column(Float, default=0.0)

    #: waiting = wartet auf Zuordnung/Vorgänger, ready = kann gemacht werden,
    #: running = angefangen, done = fertig, cancelled = entfallen.
    state: Mapped[str] = mapped_column(String(12), default="ready", index=True)
    started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    started_by: Mapped[str] = mapped_column(String(254), default="")
    done_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    done_by: Mapped[str] = mapped_column(String(254), default="")

    due_date: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    rush: Mapped[bool] = mapped_column(Boolean, default=False)
    note: Mapped[Text] = mapped_column(Text, default="")

    #: Eine vom Menschen geschlossene Aufgabe bleibt geschlossen, auch wenn die
    #: Quelle (ein Auftrag mit fertigen, aber noch nicht versandten Teilen)
    #: weiterlebt. ``closed_key`` ist der Stand der Quelle beim Schließen:
    #: ändert er sich, wird die Aufgabe bewusst wieder geöffnet. Ohne diesen
    #: Riegel meldet der Packer „fertig" und der 30-Sekunden-Abgleich holt die
    #: Aufgabe zurück.
    closed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    closed_by: Mapped[str] = mapped_column(String(254), default="")
    closed_key: Mapped[str] = mapped_column(String(120), default="")
    closed_reason: Mapped[str] = mapped_column(String(200), default="")

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )


class RuntimeLock(Base):
    """Eine prozessübergreifende Sperre für lange Hintergrundarbeit.

    Der Thread-Lock in ``batch_runner`` schützt nur einen Prozess. Zwei
    uvicorn-Worker oder ein zweiter CLI-Aufruf würden dieselben wartenden
    Positionen sonst doppelt einplanen. Die Zeile lebt in der Datenbank, damit
    alle Prozesse dieselbe Sperre sehen; ``expires_at`` räumt einen Absturz
    auf, ohne dass jemand von Hand eingreifen muss.
    """

    __tablename__ = "runtime_locks"

    key: Mapped[str] = mapped_column(String(60), primary_key=True)
    owner: Mapped[str] = mapped_column(String(120), default="")
    acquired_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class NumberSequence(Base):
    """Fortlaufende Nummern je Präfix — atomar statt ``COUNT(*) + 1``.

    Die Zählung nach Zeilen ist unter zwei Schreibern falsch und vergibt nach
    einem Löschen dieselbe Nummer erneut. Die Sequenzzeile wird per ``UPDATE``
    erhöht; SQLite serialisiert den Schreibzugriff, Postgres sperrt die Zeile.
    """

    __tablename__ = "number_sequences"

    key: Mapped[str] = mapped_column(String(120), primary_key=True)
    value: Mapped[int] = mapped_column(Integer, default=0)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )


class FactorySetting(Base):
    __tablename__ = "factory_settings"

    key: Mapped[str] = mapped_column(String(60), primary_key=True)
    value: Mapped[str] = mapped_column(String(400), default="")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )
    updated_by: Mapped[str] = mapped_column(String(254), default="")


# ---------------------------------------------------------------------------
# Compliance (EU Cyber Resilience Act): Schwachstellenmeldungen, Sicherheits-
# hinweise und Supportzeiträume. Öffentlich gelesen von der Compliance-Seite
# der Website (/scientific/compliance/), gepflegt vom Personal. Gilt für alle
# FyreFly-Produkte (Phonos, Alef, Website), nicht nur für Alef.
# ---------------------------------------------------------------------------
class SecuritySeverity(str, enum.Enum):
    low = "low"
    medium = "medium"
    high = "high"
    critical = "critical"


class VulnerabilityReportStatus(str, enum.Enum):
    new = "new"
    triaged = "triaged"
    confirmed = "confirmed"
    fixed = "fixed"
    rejected = "rejected"
    duplicate = "duplicate"


class VulnerabilityReport(Base):
    __tablename__ = "vulnerability_reports"

    id: Mapped[int] = mapped_column(primary_key=True)
    ref: Mapped[str] = mapped_column(String(20), unique=True, index=True)
    product: Mapped[str] = mapped_column(String(40))
    version: Mapped[str] = mapped_column(String(80), default="")
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text)
    impact: Mapped[str] = mapped_column(Text, default="")
    exploited: Mapped[bool] = mapped_column(Boolean, default=False)
    reporter_name: Mapped[str] = mapped_column(EncryptedText("vulnerability_reports.reporter_name"), default="")
    reporter_email: Mapped[str] = mapped_column(EncryptedText("vulnerability_reports.reporter_email"), default="")
    credit: Mapped[bool] = mapped_column(Boolean, default=False)
    # Nur ein gesalzener Hash der IP, für die Begrenzung — nie die Adresse selbst.
    ip_hash: Mapped[str] = mapped_column(String(64), default="", index=True)
    status: Mapped[VulnerabilityReportStatus] = mapped_column(
        Enum(VulnerabilityReportStatus, native_enum=False), default=VulnerabilityReportStatus.new
    )
    severity: Mapped[SecuritySeverity | None] = mapped_column(
        Enum(SecuritySeverity, native_enum=False), nullable=True
    )
    triage_note: Mapped[str] = mapped_column(Text, default="")
    advisory_ref: Mapped[str] = mapped_column(String(20), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    contact_purged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class SecurityAdvisory(Base):
    __tablename__ = "security_advisories"

    id: Mapped[int] = mapped_column(primary_key=True)
    ref: Mapped[str] = mapped_column(String(20), unique=True, index=True)
    title: Mapped[str] = mapped_column(String(200))
    product: Mapped[str] = mapped_column(String(40))
    affected: Mapped[str] = mapped_column(String(200), default="")
    fixed_in: Mapped[str] = mapped_column(String(80), default="")
    severity: Mapped[SecuritySeverity] = mapped_column(
        Enum(SecuritySeverity, native_enum=False), default=SecuritySeverity.medium
    )
    cve: Mapped[list] = mapped_column(JSON, default=list)
    summary: Mapped[str] = mapped_column(Text, default="")
    remediation: Mapped[str] = mapped_column(Text, default="")
    credit: Mapped[str] = mapped_column(String(160), default="")
    published: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)


class SupportPeriod(Base):
    __tablename__ = "support_periods"

    id: Mapped[int] = mapped_column(primary_key=True)
    product: Mapped[str] = mapped_column(String(40))
    component: Mapped[str] = mapped_column(String(120))
    version: Mapped[str] = mapped_column(String(40), default="")
    kind: Mapped[str] = mapped_column(String(20), default="hosted")  # hosted | distributed
    security_support_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    note_de: Mapped[str] = mapped_column(String(400), default="")
    note_en: Mapped[str] = mapped_column(String(400), default="")
    sort: Mapped[int] = mapped_column(Integer, default=0)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)
    updated_by: Mapped[str] = mapped_column(String(254), default="")


# ==========================================================================
# Lieferkette — Lieferanten, Bestellungen, Wareneingang, Chargen, Verluste,
# Warnungen (additiv, bestehende Tabellen bleiben unangetastet).
# ==========================================================================
class PurchaseOrderStatus(str, enum.Enum):
    draft = "draft"
    proposed = "proposed"
    ordered = "ordered"
    confirmed = "confirmed"
    partial = "partial"
    received = "received"
    cancelled = "cancelled"


class Supplier(Base):
    """Lieferant für Plattenmaterial und Zukaufteile."""

    __tablename__ = "suppliers"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(160), index=True)
    email: Mapped[str] = mapped_column(String(254), default="")
    phone: Mapped[str] = mapped_column(String(80), default="")
    country: Mapped[str] = mapped_column(String(4), default="DE")
    city: Mapped[str] = mapped_column(String(120), default="")
    region: Mapped[str] = mapped_column(String(40), default="")
    lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    lon: Mapped[float | None] = mapped_column(Float, nullable=True)
    #: Transitkorridore/Engpässe (z. B. ["hamburg_port", "rhine_corridor", "suez_canal"]).
    transit_corridors: Mapped[list] = mapped_column(JSON, default=list)
    #: Rohstoff-/Branchenstichworte für Weltlage-Korrelation (z. B. ["ptfe", "fluoropolymer"]).
    materials_tags: Mapped[list] = mapped_column(JSON, default=list)
    currency: Mapped[str] = mapped_column(String(10), default="EUR")
    payment_terms: Mapped[str] = mapped_column(String(80), default="30 Tage netto")
    incoterms: Mapped[str] = mapped_column(String(40), default="DAP")
    default_lead_days: Mapped[int] = mapped_column(Integer, default=7)
    #: Optionaler manueller Zuverlässigkeitswert (0..1); None = aus Historie rechnen.
    reliability_override: Mapped[float | None] = mapped_column(Float, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    office_note: Mapped[str] = mapped_column(EncryptedText("suppliers.office_note"), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)


class SupplierMaterial(Base):
    """Zuordnung Lieferant ↔ Werkstoff (inkl. Dicke, Format, MOQ, EK und Lieferzeit)."""

    __tablename__ = "supplier_materials"

    id: Mapped[int] = mapped_column(primary_key=True)
    supplier_id: Mapped[int] = mapped_column(
        ForeignKey("suppliers.id", ondelete="CASCADE"), index=True
    )
    product_id: Mapped[str] = mapped_column(
        ForeignKey("products.id", ondelete="CASCADE"), index=True
    )
    #: 0.0 bedeutet „alle Dicken dieses Werkstoffs“.
    thk: Mapped[float] = mapped_column(Float, default=0.0)
    supplier_sku: Mapped[str] = mapped_column(String(80), default="")
    sheet_w: Mapped[float] = mapped_column(Float, default=0.0)
    sheet_h: Mapped[float] = mapped_column(Float, default=0.0)
    #: Einkaufspreis in €/m² (0 = unbekannt, nie als 0 € rechnen).
    unit_eur_m2: Mapped[float] = mapped_column(Float, default=0.0)
    moq_sheets: Mapped[int] = mapped_column(Integer, default=1)
    quoted_lead_days: Mapped[int] = mapped_column(Integer, default=7)
    #: 1 = Hauptlieferant, >1 = Ausweichlieferant.
    preferred_rank: Mapped[int] = mapped_column(Integer, default=1)
    active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)


class PurchaseOrder(Base):
    """Bestellung an einen Lieferanten (Inbound Supply)."""

    __tablename__ = "purchase_orders"

    id: Mapped[int] = mapped_column(primary_key=True)
    no: Mapped[str] = mapped_column(String(30), unique=True, index=True)
    supplier_id: Mapped[int] = mapped_column(
        ForeignKey("suppliers.id", ondelete="RESTRICT"), index=True
    )
    status: Mapped[PurchaseOrderStatus] = mapped_column(
        Enum(PurchaseOrderStatus, native_enum=False),
        default=PurchaseOrderStatus.draft,
        index=True,
    )
    currency: Mapped[str] = mapped_column(String(10), default="EUR")
    order_date: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    requested_eta: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    confirmed_eta: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    received_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    total_net: Mapped[float] = mapped_column(Float, default=0.0)
    note: Mapped[str] = mapped_column(EncryptedText("purchase_orders.note"), default="")
    created_by: Mapped[str] = mapped_column(String(254), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)

    lines: Mapped[list["PurchaseOrderLine"]] = relationship(
        back_populates="purchase_order", cascade="all, delete-orphan"
    )


class PurchaseOrderLine(Base):
    """Bestellposition für Plattenware."""

    __tablename__ = "purchase_order_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    purchase_order_id: Mapped[int] = mapped_column(
        ForeignKey("purchase_orders.id", ondelete="CASCADE"), index=True
    )
    product_id: Mapped[str] = mapped_column(
        ForeignKey("products.id", ondelete="RESTRICT"), index=True
    )
    thk: Mapped[float] = mapped_column(Float, default=2.0)
    sheet_w: Mapped[float] = mapped_column(Float, default=0.0)
    sheet_h: Mapped[float] = mapped_column(Float, default=0.0)
    qty_ordered: Mapped[int] = mapped_column(Integer, default=1)
    qty_received: Mapped[int] = mapped_column(Integer, default=0)
    #: Einkaufspreis je Platte (€ netto).
    unit_price_eur: Mapped[float] = mapped_column(Float, default=0.0)
    requested_eta: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    confirmed_eta: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    note: Mapped[str] = mapped_column(String(300), default="")

    purchase_order: Mapped[PurchaseOrder] = relationship(back_populates="lines")


class GoodsReceipt(Base):
    """Wareneingang — verknüpft Lieferschein, Bestellung und Materialchargen."""

    __tablename__ = "goods_receipts"

    id: Mapped[int] = mapped_column(primary_key=True)
    no: Mapped[str] = mapped_column(String(30), unique=True, index=True)
    purchase_order_id: Mapped[int | None] = mapped_column(
        ForeignKey("purchase_orders.id", ondelete="SET NULL"), nullable=True, index=True
    )
    supplier_id: Mapped[int | None] = mapped_column(
        ForeignKey("suppliers.id", ondelete="SET NULL"), nullable=True, index=True
    )
    delivery_note_no: Mapped[str] = mapped_column(String(80), default="")
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)
    received_by: Mapped[str] = mapped_column(String(254), default="")
    station_id: Mapped[int | None] = mapped_column(
        ForeignKey("factory_stations.id", ondelete="SET NULL"), nullable=True, index=True
    )
    note: Mapped[str] = mapped_column(String(400), default="")


class MaterialLot(Base):
    """Materialcharge mit Zeugnisbezug (EN 10204 2.2 / 3.1) für Ende-zu-Ende-Rückverfolgung."""

    __tablename__ = "material_lots"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(30), unique=True, index=True)
    product_id: Mapped[str] = mapped_column(
        ForeignKey("products.id", ondelete="CASCADE"), index=True
    )
    thk: Mapped[float] = mapped_column(Float, default=2.0)
    sheet_w: Mapped[float] = mapped_column(Float, default=0.0)
    sheet_h: Mapped[float] = mapped_column(Float, default=0.0)
    supplier_id: Mapped[int | None] = mapped_column(
        ForeignKey("suppliers.id", ondelete="SET NULL"), nullable=True, index=True
    )
    purchase_order_no: Mapped[str] = mapped_column(String(30), default="", index=True)
    goods_receipt_id: Mapped[int | None] = mapped_column(
        ForeignKey("goods_receipts.id", ondelete="SET NULL"), nullable=True, index=True
    )
    supplier_batch: Mapped[str] = mapped_column(String(80), default="")
    cert_type: Mapped[str] = mapped_column(String(10), default="")  # "" | "2.2" | "3.1"
    cert_ref: Mapped[str] = mapped_column(String(120), default="")
    qty_initial: Mapped[int] = mapped_column(Integer, default=0)
    qty_remaining: Mapped[int] = mapped_column(Integer, default=0)
    unit_eur_m2: Mapped[float] = mapped_column(Float, default=0.0)
    station_id: Mapped[int | None] = mapped_column(
        ForeignKey("factory_stations.id", ondelete="SET NULL"), nullable=True, index=True
    )
    bin: Mapped[str] = mapped_column(String(80), default="")
    status: Mapped[str] = mapped_column(String(20), default="available", index=True)  # available|consumed|quarantined
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)
    created_by: Mapped[str] = mapped_column(String(254), default="")
    note: Mapped[str] = mapped_column(String(400), default="")


class ScrapEvent(Base):
    """Erfasster Ausschuss — schließt die Lücke „Ausschuss“ in den Kennzahlen."""

    __tablename__ = "scrap_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    work_order_no: Mapped[str] = mapped_column(String(30), default="", index=True)
    plate_id: Mapped[int | None] = mapped_column(
        ForeignKey("work_plates.id", ondelete="SET NULL"), nullable=True, index=True
    )
    station_id: Mapped[int | None] = mapped_column(
        ForeignKey("factory_stations.id", ondelete="SET NULL"), nullable=True, index=True
    )
    product_id: Mapped[str | None] = mapped_column(
        ForeignKey("products.id", ondelete="SET NULL"), nullable=True, index=True
    )
    thk: Mapped[float] = mapped_column(Float, default=0.0)
    lot_id: Mapped[int | None] = mapped_column(
        ForeignKey("material_lots.id", ondelete="SET NULL"), nullable=True, index=True
    )
    qty_parts: Mapped[int] = mapped_column(Integer, default=0)
    area_m2: Mapped[float] = mapped_column(Float, default=0.0)
    reason: Mapped[str] = mapped_column(String(30), default="sonstiges")  # schnittfehler|materialfehler|ruestfehler|handling|sonstiges
    note: Mapped[str] = mapped_column(String(400), default="")
    recorded_by: Mapped[str] = mapped_column(String(254), default="")
    recorded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)


class StationDowntime(Base):
    """Erfasster Maschinenstillstand — schließt die Lücke „Maschinenstillstand“."""

    __tablename__ = "station_downtimes"

    id: Mapped[int] = mapped_column(primary_key=True)
    station_id: Mapped[int] = mapped_column(
        ForeignKey("factory_stations.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(String(20), default="unplanned")  # unplanned|planned|maintenance|material_wait
    reason: Mapped[str] = mapped_column(String(200), default="")
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    duration_min: Mapped[float] = mapped_column(Float, default=0.0)
    note: Mapped[str] = mapped_column(String(400), default="")
    recorded_by: Mapped[str] = mapped_column(String(254), default="")


class SupplyAlert(Base):
    """Deterministische Lieferketten-Warnung (dedupliziert über ``dedup_key``)."""

    __tablename__ = "supply_alerts"

    id: Mapped[int] = mapped_column(primary_key=True)
    dedup_key: Mapped[str] = mapped_column(String(160), unique=True, index=True)
    kind: Mapped[str] = mapped_column(String(30), index=True)  # stockout|overdue_po|single_source|due_risk|margin_drift|erp_delta|downtime|scrap_spike
    severity: Mapped[str] = mapped_column(String(16), default="warning", index=True)  # danger|warning|info
    title: Mapped[str] = mapped_column(String(200))
    detail: Mapped[str] = mapped_column(Text, default="")
    metric: Mapped[str] = mapped_column(String(120), default="")
    entity_type: Mapped[str] = mapped_column(String(40), default="")
    entity_id: Mapped[str] = mapped_column(String(80), default="")
    station_id: Mapped[int | None] = mapped_column(
        ForeignKey("factory_stations.id", ondelete="SET NULL"), nullable=True, index=True
    )
    product_id: Mapped[str | None] = mapped_column(
        ForeignKey("products.id", ondelete="SET NULL"), nullable=True, index=True
    )
    status: Mapped[str] = mapped_column(String(20), default="open", index=True)  # open|acknowledged|resolved|snoozed
    snapshot: Mapped[dict] = mapped_column(JSON, default=dict)
    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    resolved_by: Mapped[str] = mapped_column(String(254), default="")


class WorldEvent(Base):
    """Externes Weltlage-Ereignis (öffentliche APIs/Feeds), korreliert mit Lieferanten & Aufträgen."""

    __tablename__ = "world_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    external_id: Mapped[str] = mapped_column(String(180), unique=True, index=True)
    source: Mapped[str] = mapped_column(String(40), index=True)
    category: Mapped[str] = mapped_column(String(30), default="geopolitical", index=True)
    severity: Mapped[str] = mapped_column(String(16), default="medium", index=True)
    title: Mapped[str] = mapped_column(String(300))
    summary: Mapped[str] = mapped_column(Text, default="")
    url: Mapped[str] = mapped_column(String(500), default="")
    region: Mapped[str] = mapped_column(String(60), default="")
    country: Mapped[str] = mapped_column(String(8), default="", index=True)
    corridor: Mapped[str] = mapped_column(String(60), default="", index=True)
    lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    lon: Mapped[float | None] = mapped_column(Float, nullable=True)
    tags: Mapped[list] = mapped_column(JSON, default=list)
    impact_score: Mapped[int] = mapped_column(Integer, default=0, index=True)
    suggested_delay_days: Mapped[int] = mapped_column(Integer, default=0)
    revenue_at_risk_eur: Mapped[float] = mapped_column(Float, default=0.0)
    impacted_supplier_ids: Mapped[list] = mapped_column(JSON, default=list)
    impacted_po_nos: Mapped[list] = mapped_column(JSON, default=list)
    impacted_order_nos: Mapped[list] = mapped_column(JSON, default=list)
    impacted_products: Mapped[list] = mapped_column(JSON, default=list)
    exposure_reasons: Mapped[list] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(20), default="active", index=True)  # active|monitoring|mitigated|dismissed
    copilot_brief: Mapped[str] = mapped_column(Text, default="")
    raw_meta: Mapped[dict] = mapped_column(JSON, default=dict)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)


class MacroSnapshot(Base):
    """Zwischenspeicher für öffentliche Makro-, Wechselkurs- und Korridor-Wetterdaten."""

    __tablename__ = "macro_snapshots"

    id: Mapped[int] = mapped_column(primary_key=True)
    key: Mapped[str] = mapped_column(String(60), unique=True, index=True)  # e.g. "fx_ecb" | "chokepoints_weather" | "feed_status"
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)
