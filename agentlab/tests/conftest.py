"""Eigene Datenbank für die Labortests — nie die des laufenden Gimel."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest

DATA = Path(tempfile.mkdtemp(prefix="gimel-agentlab-test-"))
os.environ["GIMEL_APP_ROOT"] = str(DATA)
os.environ["GIMEL_SECRET_KEY"] = "agentlab-test-secret-not-for-production"
os.environ["GIMEL_MAIL_SILENT"] = "1"
os.environ.pop("GIMEL_ENV_PREFIX", None)


@pytest.fixture(scope="session")
def password() -> str:
    from agentlab import models  # noqa: F401  (Tabellen vor init_db anmelden)
    from gimel import demo
    from gimel.db import SessionLocal
    from gimel.seed import init_db

    init_db(verbose=False)
    with SessionLocal() as db:
        return demo.seed(db)


@pytest.fixture(scope="session")
def client(password: str):
    from fastapi.testclient import TestClient

    from agentlab.app import create_lab_app
    from gimel import demo

    with TestClient(create_lab_app()) as c:
        r = c.post("/api/auth/login", data={"username": demo.ADMIN_EMAIL,
                                           "password": password})
        assert r.status_code == 200, r.text
        c.headers["Authorization"] = f"Bearer {r.json()['access_token']}"
        yield c


@pytest.fixture()
def admin():
    from gimel import demo
    from gimel.db import SessionLocal
    from gimel.models import User

    with SessionLocal() as db:
        return db.query(User).filter(User.email == demo.ADMIN_EMAIL).one()
