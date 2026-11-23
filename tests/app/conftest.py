"""The platform without any application on top: no plugin, ``GIMEL_`` settings."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest

DATA = Path(tempfile.mkdtemp(prefix="gimel-test-"))
os.environ["GIMEL_APP_ROOT"] = str(DATA)
os.environ["GIMEL_SECRET_KEY"] = "test-secret-not-for-production-use-only"
os.environ["GIMEL_MAIL_SILENT"] = "1"
os.environ["STRIPE_SECRET_KEY"] = "sk_test_dummy_key_for_tests_only"
os.environ.pop("GIMEL_ENV_PREFIX", None)
os.environ.pop("GIMEL_VOICE", None)  # das Portal bleibt im Test ohne Spracherkennung


@pytest.fixture(scope="session")
def plant():
    from gimel import demo
    from gimel.db import SessionLocal
    from gimel.seed import init_db

    init_db(verbose=False)
    with SessionLocal() as db:
        return demo.seed(db)


@pytest.fixture(scope="session")
def client(plant):
    from fastapi.testclient import TestClient

    from gimel import demo
    from gimel.app import create_app

    with TestClient(create_app()) as c:
        r = c.post("/api/auth/login", data={"username": demo.ADMIN_EMAIL, "password": plant})
        assert r.status_code == 200, r.text
        c.headers["Authorization"] = f"Bearer {r.json()['access_token']}"
        yield c
