"""Bestehende Zeilen auf die Feldverschlüsselung bringen (und zurück).

    python -m gimel.fieldmigrate genkey [kennung]   neuer DATA_KEYS-Eintrag auf stdout
    python -m gimel.fieldmigrate                    Probelauf: zählt nur, schreibt nichts
    python -m gimel.fieldmigrate --apply            Klartext und alte Schlüssel → aktiver Schlüssel
    python -m gimel.fieldmigrate --verify           liest jede Zeile zurück, schreibt nichts
    python -m gimel.fieldmigrate --decrypt --apply  Rückweg: alles wieder in Klartext

Läuft über alle Spalten mit ``Encrypted*``-Typ (``--table`` schränkt ein). Idempotent
und wiederaufnehmbar: eine Zeile, die schon mit dem aktiven Schlüssel liegt, wird
übersprungen; jeder Stapel ist eine eigene Transaktion. Erst Datenbank sichern.
Unter Alef: ``cd apps/api && python -m scripts.encrypt_fields`` (setzt den Präfix ALPHA_).
"""

from __future__ import annotations

import argparse
import sys
from collections import Counter

from sqlalchemy import select, type_coerce, update
from sqlalchemy.types import NullType

from . import fieldcrypt as fc
from .db import Base, SessionLocal
from . import models  # noqa: F401  (registriert die Tabellen)


def encrypted_columns(only: set[str] | None = None):
    for table in Base.metadata.sorted_tables:
        if only and table.name not in only:
            continue
        for col in table.columns:
            if isinstance(col.type, fc.ENCRYPTED_TYPES):
                yield table, col


def _is_empty_raw(raw) -> bool:
    if raw is None:
        return True
    if isinstance(raw, (bytes, bytearray, memoryview)):
        return len(bytes(raw)) == 0
    return str(raw).strip() in ("", "{}", "[]", "null", '""')


def _raw_kid(raw) -> str | None:
    """Schlüsselkennung eines Rohwerts aus der Datenbank (JSON-Spalten tragen den String in Anführungszeichen)."""
    if isinstance(raw, str):
        s = raw.strip()
        if s.startswith('"') and s.endswith('"'):
            s = s[1:-1]
        return fc.token_key_id(s)
    return fc.token_key_id(raw)


def classify(raw, target: str | None) -> str:
    """``empty`` · ``current`` (schon im Zielzustand) · ``encrypt`` · ``reseal`` · ``decrypt``."""
    if _is_empty_raw(raw):
        return "empty"
    kid = _raw_kid(raw)
    if target is None:  # Rückweg
        return "decrypt" if kid else "current"
    if kid is None:
        return "encrypt"
    return "current" if kid == target else "reseal"


def run(*, apply: bool, decrypt: bool = False, verify: bool = False, only: set[str] | None = None,
        batch: int = 200, out=print) -> Counter:
    total: Counter = Counter()
    target = None if decrypt else fc.active_key_id()
    if not verify and not decrypt and target is None:
        raise SystemExit("Kein Datenschlüssel gesetzt (DATA_KEYS) — nichts zu verschlüsseln.")
    for table, col in encrypted_columns(only):
        pk = list(table.primary_key.columns)
        if len(pk) != 1:
            out(f"  übersprungen: {table.name} hat keinen einfachen Primärschlüssel")
            continue
        pk = pk[0]
        counts: Counter = Counter()
        last = None
        while True:
            with SessionLocal() as db:
                q = select(pk, type_coerce(col, NullType())).order_by(pk).limit(batch)
                if last is not None:
                    q = q.where(pk > last)
                rows = db.execute(q).all()
                if not rows:
                    break
                last = rows[-1][0]
                todo = []
                for rid, raw in rows:
                    if verify:
                        counts["gelesen"] += 1
                        counts["verschlüsselt"] += 1 if _raw_kid(raw) else 0
                        todo.append(rid)
                        continue
                    state = classify(raw, target)
                    counts[state] += 1
                    if state in ("encrypt", "reseal", "decrypt"):
                        todo.append(rid)
                if not todo:
                    continue
                # Über den Spaltentyp lesen: er entschlüsselt mit jedem Schlüssel des Rings.
                values = dict(db.execute(select(pk, col).where(pk.in_(todo))).all())
                if verify or not apply:
                    continue
                ctx = fc.plaintext_writes() if decrypt else _nullctx()
                with ctx:
                    for rid in todo:
                        db.execute(update(table).where(pk == rid).values({col.name: values[rid]}))
                db.commit()
        out(f"  {table.name}.{col.name}: " + (", ".join(f"{k} {v}" for k, v in sorted(counts.items())) or "leer"))
        total.update(counts)
    return total


class _nullctx:
    def __enter__(self): return self
    def __exit__(self, *a): return False


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="fieldmigrate", description=__doc__.split("\n\n")[0])
    ap.add_argument("command", nargs="?", choices=["genkey"], help="genkey [kennung]")
    ap.add_argument("kid", nargs="?", default="k1")
    ap.add_argument("--apply", action="store_true", help="wirklich schreiben (ohne: Probelauf)")
    ap.add_argument("--decrypt", action="store_true", help="Rückweg: Klartext schreiben")
    ap.add_argument("--verify", action="store_true", help="nur lesen und zählen")
    ap.add_argument("--table", action="append", help="nur diese Tabelle (mehrfach möglich)")
    ap.add_argument("--batch", type=int, default=200)
    a = ap.parse_args(argv)
    if a.command == "genkey":
        print(fc.generate_key(a.kid))
        return 0
    fc.validate()
    if a.apply and a.verify:
        ap.error("--verify schreibt nie")
    mode = "VERIFIZIERT" if a.verify else ("GESCHRIEBEN" if a.apply else "PROBELAUF (nichts geschrieben)")
    print(f"fieldmigrate: {mode}; aktiver Schlüssel: {fc.active_key_id() or '-'}")
    total = run(apply=a.apply, decrypt=a.decrypt, verify=a.verify, only=set(a.table or []), batch=a.batch)
    print("Summe: " + (", ".join(f"{k} {v}" for k, v in sorted(total.items())) or "nichts"))
    if not a.apply and not a.verify:
        print("Mit --apply ausführen, um zu schreiben (vorher die Datenbank sichern).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
