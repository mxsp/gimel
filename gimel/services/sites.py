"""Standorte, Hallen, Ebenen — und wo ein Auftrag gefertigt werden darf.

Die Vorgabe ist eine kurze Zeichenkette, damit sie in einer Spalte, einer URL
und einem Protokolleintrag gleich aussieht:

* ``""``            überall
* ``"site:1,2"``    nur an diesen Standorten
* ``"hall:3"``      nur in diesen Hallen (alle Ebenen)
* ``"floor:5,6"``   nur auf diesen Ebenen
* ``"received"``    nur am Standort, an dem der Auftrag eingegangen ist

Der Rechenkern sieht davon nur die Menge erlaubter Ebenen und einen Satz für
die Begründung. ``received`` wird beim Übergang Auftrag → Teil aufgelöst; ein
Innenauftrag trägt nie ``received``, sonst hinge seine Bedeutung davon ab,
welcher der gebündelten Aufträge gerade gelesen wird.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Optional

from sqlalchemy.orm import Session

from ..models import FactoryFloor, FactoryHall, FactorySite, FactoryStation, Order

KINDS = ("site", "hall", "floor")


class ScopeError(ValueError):
    pass


@dataclass(frozen=True)
class Scope:
    kind: str = ""  # "" | site | hall | floor | received
    ids: tuple[int, ...] = ()

    @property
    def any(self) -> bool:
        return not self.kind

    def __str__(self) -> str:
        if not self.kind:
            return ""
        if self.kind == "received":
            return "received"
        return f"{self.kind}:" + ",".join(str(i) for i in self.ids)


def parse(raw: Optional[str]) -> Scope:
    s = (raw or "").strip()
    if not s or s == "any":
        return Scope()
    if s == "received":
        return Scope("received")
    kind, _, rest = s.partition(":")
    if kind not in KINDS:
        raise ScopeError(f"Unbekannte Vorgabe „{s}“.")
    try:
        ids = tuple(sorted({int(x) for x in rest.split(",") if x.strip()}))
    except ValueError as exc:
        raise ScopeError(f"Ungültige Nummern in „{s}“.") from exc
    if not ids:
        raise ScopeError(f"Vorgabe „{s}“ nennt nichts.")
    return Scope(kind, ids)


def validate(db: Session, raw: Optional[str]) -> str:
    """Vorgabe prüfen und kanonisch zurückgeben; unbekannte Nummern → Fehler."""
    sc = parse(raw)
    model = {"site": FactorySite, "hall": FactoryHall, "floor": FactoryFloor}.get(sc.kind)
    if model is not None:
        missing = [i for i in sc.ids if db.get(model, i) is None]
        if missing:
            raise ScopeError(f"{sc.kind} {', '.join(map(str, missing))} gibt es nicht.")
    return str(sc)


# --------------------------------------------------------------------------
# Grunddaten
# --------------------------------------------------------------------------
def default_floor(db: Session) -> Optional[FactoryFloor]:
    """Die erste Ebene — Heimat aller Stationen ohne ``floor_id``."""
    return db.query(FactoryFloor).order_by(FactoryFloor.id.asc()).first()


def default_site_id(db: Session) -> Optional[int]:
    s = db.query(FactorySite).order_by(FactorySite.id.asc()).first()
    return s.id if s else None


def station_floor_id(s: FactoryStation, default_id: Optional[int]) -> Optional[int]:
    return int(s.floor_id) if s.floor_id else default_id


@dataclass
class Topology:
    """Wer wo hängt — einmal je Anfrage gelesen."""

    floor_hall: dict[int, Optional[int]]
    hall_site: dict[int, Optional[int]]
    floors: dict[int, FactoryFloor]
    halls: dict[int, FactoryHall]
    sites: dict[int, FactorySite]
    default_floor_id: Optional[int]

    def floor_site(self, fid: Optional[int]) -> Optional[int]:
        if fid is None:
            return None
        h = self.floor_hall.get(fid)
        return self.hall_site.get(h) if h is not None else None


def topology(db: Session) -> Topology:
    floors = {f.id: f for f in db.query(FactoryFloor).order_by(FactoryFloor.id).all()}
    halls = {h.id: h for h in db.query(FactoryHall).order_by(FactoryHall.id).all()}
    sites = {s.id: s for s in db.query(FactorySite).order_by(FactorySite.id).all()}
    return Topology(
        floor_hall={i: f.hall_id for i, f in floors.items()},
        hall_site={i: h.site_id for i, h in halls.items()},
        floors=floors,
        halls=halls,
        sites=sites,
        default_floor_id=min(floors) if floors else None,
    )


# --------------------------------------------------------------------------
# Auflösen
# --------------------------------------------------------------------------
def resolve_received(o: Order, db: Session) -> str:
    """Eine Auftragsvorgabe so, wie sie an Teile und Innenaufträge geht."""
    raw = (o.route_scope or "").strip()
    if raw != "received":
        return raw
    sid = o.site_id or default_site_id(db)
    return f"site:{sid}" if sid else ""


def allowed_floors(scope: Scope, topo: Topology) -> Optional[frozenset[int]]:
    """Erlaubte Ebenen; ``None`` = keine Eingrenzung."""
    if scope.any or scope.kind == "received":
        return None
    ids = set(scope.ids)
    if scope.kind == "floor":
        return frozenset(i for i in topo.floors if i in ids)
    if scope.kind == "hall":
        return frozenset(f for f, h in topo.floor_hall.items() if h in ids)
    if scope.kind == "site":
        return frozenset(f for f in topo.floors if topo.floor_site(f) in ids)
    return None


def label(scope: Scope, topo: Topology) -> str:
    if scope.any:
        return "überall"
    if scope.kind == "received":
        return "nur am Eingangsstandort"
    names: list[str] = []
    for i in scope.ids:
        if scope.kind == "site":
            s = topo.sites.get(i)
            names.append(s.name if s else f"Standort {i}")
        elif scope.kind == "hall":
            h = topo.halls.get(i)
            names.append(h.name if h else f"Halle {i}")
        else:
            f = topo.floors.get(i)
            if f is None:
                names.append(f"Ebene {i}")
            else:
                h = topo.halls.get(f.hall_id) if f.hall_id else None
                lvl = f.level_name or f"Ebene {f.level}"
                names.append(f"{h.name} · {lvl}" if h else lvl)
    return "nur " + " / ".join(names)


def intersect(scopes: Iterable[str], topo: Topology) -> str:
    """Mehrere Vorgaben zu einer: die Schnittmenge, als ``floor:``-Liste.

    Gleiche Vorgaben bleiben, wie sie sind. Leer heißt: keine Station darf —
    das wird nicht still zu „überall".
    """
    distinct = sorted({s for s in scopes if s})
    if not distinct:
        return ""
    if len(distinct) == 1:
        return distinct[0]
    allowed: Optional[set[int]] = None
    for raw in distinct:
        fl = allowed_floors(parse(raw), topo)
        if fl is None:
            continue
        allowed = set(fl) if allowed is None else allowed & set(fl)
    if allowed is None:
        return ""
    return "floor:" + ",".join(str(i) for i in sorted(allowed)) if allowed else "floor:0"
