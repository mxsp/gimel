from __future__ import annotations

from datetime import datetime, timedelta, timezone

from agentlab.models import AgentChat, AgentMessage
from agentlab.stats import usage_numbers
from gimel.db import SessionLocal


def _usage(*, prompt: int, completion: int, cached: int = 0,
           reasoning: int = 0, cost: float = 0.0,
           list_cost: float | None = None, allowance: float | None = None) -> dict:
    usage = {
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "total_tokens": prompt + completion,
        "prompt_tokens_details": {"cached_tokens": cached},
        "completion_tokens_details": {"reasoning_tokens": reasoning},
        "cost": cost,
    }
    if list_cost is not None or allowance is not None:
        usage["opencode"] = {
            "list_cost": list_cost or 0.0,
            "allowance": allowance or 0.0,
            "tokens": {
                "input": prompt - cached,
                "output": completion,
                "reasoning": reasoning,
                "cache_read": cached,
            },
        }
    return usage


def test_usage_numbers_keeps_cost_sources_apart():
    numbers = usage_numbers(_usage(prompt=5142, completion=252, cached=5120,
                                   reasoning=103, list_cost=0.00016986,
                                   allowance=0.00010192))
    assert numbers["prompt_tokens"] == 5142
    assert numbers["completion_tokens"] == 252
    assert numbers["total_tokens"] == 5394
    assert numbers["cached_tokens"] == 5120
    assert numbers["reasoning_tokens"] == 103
    assert numbers["cost"] == 0.0
    assert numbers["list_cost"] == 0.00016986
    assert numbers["allowance"] == 0.00010192
    assert numbers["has_cost"] is True
    assert numbers["has_list_cost"] is True
    assert numbers["has_allowance"] is True


def test_usage_numbers_falls_back_to_opencode_tokens():
    numbers = usage_numbers({
        "opencode": {
            "list_cost": 0.5,
            "tokens": {"input": 100, "output": 40, "reasoning": 12,
                       "cache_read": 25, "cache_write_5m": 5},
        },
    })
    assert numbers["prompt_tokens"] == 130
    assert numbers["completion_tokens"] == 40
    assert numbers["total_tokens"] == 170
    assert numbers["cached_tokens"] == 25
    assert numbers["reasoning_tokens"] == 12
    assert numbers["cost"] == 0.0
    assert numbers["has_cost"] is False


def test_stats_group_by_model_day_and_chat(client, admin):
    now = datetime.now(timezone.utc)
    suffix = now.strftime("%H%M%S%f")
    chat_model = f"fallback-{suffix}"
    model_a = f"modell-a-{suffix}"
    model_old = f"modell-alt-{suffix}"
    chat_id = 0
    with SessionLocal() as db:
        chat = AgentChat(user_id=admin.id, title="Statistiktest", model=chat_model)
        db.add(chat)
        db.flush()
        chat_id = chat.id
        db.add_all([
            AgentMessage(chat_id=chat.id, role="assistant", model=model_a,
                         usage=_usage(prompt=100, completion=40, cached=20,
                                      reasoning=5, cost=0.02, list_cost=0.03,
                                      allowance=0.01),
                         created_at=now),
            # Ohne Modell an der Nachricht: der Chat trägt die Herkunft.
            AgentMessage(chat_id=chat.id, role="assistant", model="",
                         usage=_usage(prompt=10, completion=5),
                         created_at=now - timedelta(days=2)),
            # Außerhalb des 30-Tage-Fensters.
            AgentMessage(chat_id=chat.id, role="assistant", model=model_old,
                         usage=_usage(prompt=1000, completion=100),
                         created_at=now - timedelta(days=40)),
        ])
        db.commit()

    try:
        data = client.get("/api/agent/stats?days=30").json()
        models = {row["model"]: row for row in data["models"]}
        assert models[model_a]["rounds"] == 1
        assert models[model_a]["total_tokens"] == 140
        assert models[model_a]["cost"] == 0.02
        assert models[model_a]["list_cost"] == 0.03
        assert models[model_a]["allowance"] == 0.01
        assert models[chat_model]["rounds"] == 1
        assert models[chat_model]["total_tokens"] == 15
        assert model_old not in models

        # Die Summe der Modelle ist die Summe der Kennzahlen.
        assert sum(row["total_tokens"] for row in data["models"]) == data["totals"]["total_tokens"]
        assert sum(row["rounds"] for row in data["models"]) == data["totals"]["rounds"]

        today = now.date().isoformat()
        day = next(row for row in data["series"] if row["date"] == today)
        assert day["rounds"] >= 1
        assert day["total_tokens"] >= 140

        chat_row = next(row for row in data["chats"] if row["id"] == chat_id)
        assert chat_row["rounds"] == 2
        assert chat_row["total_tokens"] == 155

        everything = client.get("/api/agent/stats?days=0").json()
        assert model_old in {row["model"] for row in everything["models"]}
        assert everything["totals"]["total_tokens"] >= 1155
    finally:
        with SessionLocal() as db:
            db.query(AgentMessage).filter(AgentMessage.chat_id == chat_id).delete()
            db.query(AgentChat).filter(AgentChat.id == chat_id).delete()
            db.commit()
