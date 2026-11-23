"""Kennzahlen des Assistenten: Modelle, Token und gemeldete Kosten.

Die Zahlen kommen ausschließlich aus ``agent_messages.usage`` — also aus dem,
was der Anbieter je Modellrunde gemeldet hat. Fehlt eine Meldung, bleibt der
Wert leer; geschätzt wird nichts. Das Modell steht seit dem 2026-11-07 an der
Nachricht, ältere Zeilen fallen auf den Chat zurück.

Kosten haben drei Quellen:

* ``usage.cost`` — der tatsächlich abgerechnete Betrag (viele Anbieter, oft 0
  bei einem Abo),
* ``usage.opencode.list_cost`` — der Listenpreis derselben Runde,
* ``usage.opencode.allowance`` — der Verbrauch aus dem Go-Kontingent.

Alle drei werden getrennt ausgewiesen. Es wird nie einer aus dem anderen
gerechnet.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Iterable

from sqlalchemy.orm import Session

from .models import AgentChat, AgentMessage, AgentProvider

CURRENCY = "USD"
MAX_DAYS = 3650


def _int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _float(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def usage_numbers(usage: dict | None) -> dict:
    """Eine ``usage``-Meldung in flache, addierbare Zahlen übersetzen.

    ``prompt_tokens``/``completion_tokens`` sind die Summen; ``cached_tokens``
    und ``reasoning_tokens`` sind Teilmengen davon und werden nie doppelt
    gezählt. Ältere oder fremde Anbieter melden nur einen Teil; dann greifen
    die Ersatzfelder, ohne einen Wert zu erfinden.
    """
    data = usage if isinstance(usage, dict) else {}
    opencode = data.get("opencode") if isinstance(data.get("opencode"), dict) else {}
    oc_tokens = opencode.get("tokens") if isinstance(opencode.get("tokens"), dict) else {}

    prompt = _int(data.get("prompt_tokens") or data.get("input_tokens"))
    completion = _int(data.get("completion_tokens") or data.get("output_tokens"))
    if not prompt and oc_tokens:
        prompt = (
            _int(oc_tokens.get("input"))
            + _int(oc_tokens.get("cache_read"))
            + _int(oc_tokens.get("cache_write_5m"))
            + _int(oc_tokens.get("cache_write_1h"))
        )
    if not completion and oc_tokens:
        completion = _int(oc_tokens.get("output"))
    total = _int(data.get("total_tokens")) or prompt + completion

    prompt_details = data.get("prompt_tokens_details")
    prompt_details = prompt_details if isinstance(prompt_details, dict) else {}
    completion_details = data.get("completion_tokens_details")
    completion_details = completion_details if isinstance(completion_details, dict) else {}

    cached = (
        _int(prompt_details.get("cached_tokens"))
        or _int(data.get("cache_read_input_tokens"))
        or _int(oc_tokens.get("cache_read"))
    )
    reasoning = (
        _int(completion_details.get("reasoning_tokens"))
        or _int(data.get("reasoning_tokens"))
        or _int(oc_tokens.get("reasoning"))
    )

    return {
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "total_tokens": total,
        "cached_tokens": min(cached, prompt) if prompt else cached,
        "reasoning_tokens": reasoning,
        "cost": _float(data.get("cost")),
        "list_cost": _float(opencode.get("list_cost")),
        "allowance": _float(opencode.get("allowance")),
        "has_cost": "cost" in data,
        "has_list_cost": "list_cost" in opencode,
        "has_allowance": "allowance" in opencode,
    }


def _empty_bucket() -> dict:
    return {
        "rounds": 0,
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "total_tokens": 0,
        "cached_tokens": 0,
        "reasoning_tokens": 0,
        "cost": 0.0,
        "list_cost": 0.0,
        "allowance": 0.0,
        "has_cost": False,
        "has_list_cost": False,
        "has_allowance": False,
        "chats": set(),
    }


def _add(bucket: dict, numbers: dict, chat_id: int) -> None:
    bucket["rounds"] += 1
    bucket["chats"].add(chat_id)
    for key in ("prompt_tokens", "completion_tokens", "total_tokens",
                "cached_tokens", "reasoning_tokens"):
        bucket[key] += numbers[key]
    for key in ("cost", "list_cost", "allowance"):
        bucket[key] += numbers[key]
    for key in ("has_cost", "has_list_cost", "has_allowance"):
        bucket[key] = bucket[key] or numbers[key]


def _finish(bucket: dict) -> dict:
    out = {key: value for key, value in bucket.items() if key != "chats"}
    out["chats"] = len(bucket["chats"])
    return out


def _day(value: datetime | None) -> str | None:
    if not isinstance(value, datetime):
        return None
    return value.date().isoformat()


def _fill_series(series: dict[str, dict], *, since: datetime | None,
                 until: datetime) -> list[dict]:
    """Lückenlose Tagesreihe für den gewählten Zeitraum."""
    if since is not None:
        start = since.date()
        end = until.date()
    elif series:
        start = date.fromisoformat(min(series))
        end = date.fromisoformat(max(series))
    else:
        return []
    if end < start:
        return []
    if (end - start).days > MAX_DAYS:
        start = end - timedelta(days=MAX_DAYS)
    out: list[dict] = []
    current = start
    while current <= end:
        key = current.isoformat()
        bucket = series.get(key) or _empty_bucket()
        row = _finish(bucket)
        row["date"] = key
        out.append(row)
        current += timedelta(days=1)
    return out


def collect(db: Session, user_id: int, days: int = 30) -> dict:
    """Kennzahlen eines Kontos; ``days = 0`` bedeutet „alles“."""
    days = max(0, min(_int(days), MAX_DAYS))
    now = datetime.now(timezone.utc)
    if days:
        start_day = now.date() - timedelta(days=days - 1)
        since = datetime.combine(start_day, time.min, tzinfo=timezone.utc)
    else:
        since = None

    query = (
        db.query(AgentMessage, AgentChat)
        .join(AgentChat, AgentChat.id == AgentMessage.chat_id)
        .filter(AgentChat.user_id == user_id)
    )
    if since is not None:
        query = query.filter(AgentMessage.created_at >= since)
    rows: Iterable[tuple[AgentMessage, AgentChat]] = query.order_by(
        AgentMessage.created_at, AgentMessage.id
    ).all()

    providers = {row.id: row.name for row in db.query(AgentProvider).all()}
    totals = _empty_bucket()
    by_model: dict[tuple[str, str], dict] = {}
    by_day: dict[str, dict] = {}
    by_chat: dict[int, dict] = {}

    for message, chat in rows:
        if not (message.usage or {}):
            continue
        numbers = usage_numbers(message.usage)
        model = (message.model or chat.model or "").strip() or "unbekannt"
        provider_id = message.provider_id or chat.provider_id
        provider = providers.get(provider_id, "") or "—"

        _add(totals, numbers, chat.id)
        _add(by_model.setdefault((model, provider), _empty_bucket()), numbers, chat.id)
        day = _day(message.created_at)
        if day:
            _add(by_day.setdefault(day, _empty_bucket()), numbers, chat.id)

        bucket = by_chat.setdefault(chat.id, {
            **_empty_bucket(),
            "id": chat.id,
            "title": chat.title or "Neuer Chat",
            "model": chat.model or model,
            "provider": provider,
            "deleted": chat.deleted_at is not None,
            "last_at": message.created_at,
        })
        _add(bucket, numbers, chat.id)
        if message.created_at and (bucket["last_at"] is None
                                   or message.created_at > bucket["last_at"]):
            bucket["last_at"] = message.created_at

    model_rows = []
    for (model, provider), bucket in by_model.items():
        row = _finish(bucket)
        row.update({"model": model, "provider": provider})
        model_rows.append(row)
    model_rows.sort(key=lambda row: (-row["total_tokens"], row["model"].lower()))

    chat_rows = []
    for bucket in by_chat.values():
        row = _finish(bucket)
        row.update({
            "id": bucket["id"],
            "title": bucket["title"],
            "model": bucket["model"],
            "provider": bucket["provider"],
            "deleted": bucket["deleted"],
            "last_at": bucket["last_at"],
        })
        chat_rows.append(row)
    chat_rows.sort(key=lambda row: (-row["total_tokens"], -row["rounds"]))
    chat_rows = chat_rows[:12]

    return {
        "days": days,
        "since": since,
        "until": now,
        "currency": CURRENCY,
        "totals": _finish(totals),
        "models": model_rows,
        "series": _fill_series(by_day, since=since, until=now),
        "chats": chat_rows,
    }
