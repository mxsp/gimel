"""Datenbankanbindung — Engine, Session, Basisklasse."""

from __future__ import annotations

from collections.abc import Iterable, Iterator

from sqlalchemy import create_engine, event, false, or_
from sqlalchemy.orm import DeclarativeBase, sessionmaker
from sqlalchemy.pool import NullPool

from .config import get_settings

settings = get_settings()

_is_sqlite = settings.database_url.startswith("sqlite")
_connect_args = {"check_same_thread": False} if _is_sqlite else {}

_engine_kwargs: dict = dict(
    connect_args=_connect_args,
    pool_pre_ping=True,
    future=True,
)
if _is_sqlite:
    _engine_kwargs["poolclass"] = NullPool
else:
    _engine_kwargs["pool_size"] = settings.database_pool_size
    _engine_kwargs["max_overflow"] = settings.database_max_overflow
    _engine_kwargs["pool_recycle"] = 3600

engine = create_engine(settings.database_url, **_engine_kwargs)

if _is_sqlite:
    @event.listens_for(engine, "connect")
    def _set_sqlite_pragma(dbapi_connection, connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.execute("PRAGMA busy_timeout=10000")
        cursor.execute("PRAGMA foreign_keys=ON")
        # Großdaten-Vorgaben: 64 MiB Seiten-Cache, Temp-Tabellen im RAM,
        # 256 MiB mmap und begrenztes WAL-Journal für Millionen Zeilen.
        cursor.execute("PRAGMA cache_size=-65536")
        cursor.execute("PRAGMA temp_store=MEMORY")
        cursor.execute("PRAGMA mmap_size=268435456")
        cursor.execute("PRAGMA journal_size_limit=67108864")
        cursor.close()


def iter_chunks(values: Iterable, size: int = 500) -> Iterator[list]:
    """Teilt eine Sammlung in feste Blöcke — vermeidet SQLites Parameter-Limit bei IN (...)."""
    buf: list = []
    for item in values:
        buf.append(item)
        if len(buf) >= size:
            yield buf
            buf = []
    if buf:
        yield buf


def chunked_in(column, values: Iterable, chunk_size: int = 500):
    """Sicheres ``column.in_(values)`` für beliebig große Mengen (SQLite-Limit-sicher)."""
    unique = list(dict.fromkeys(values))
    if not unique:
        return false()
    if len(unique) <= chunk_size:
        return column.in_(unique)
    return or_(*(column.in_(chunk) for chunk in iter_chunks(unique, chunk_size)))

SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


class Base(DeclarativeBase):
    pass


def get_db() -> Iterator:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
