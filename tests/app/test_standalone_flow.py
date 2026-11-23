"""F4: order, run, work, ship, paid, invoice, XML, with no plugin and no Stripe."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def test_order_to_e_invoice_without_any_application(tmp_path):
    env = {k: v for k, v in os.environ.items() if "STRIPE" not in k and k != "GIMEL_ENV_PREFIX"}
    env["PYTHONPATH"] = str(Path(__file__).resolve().parents[2])  # this tree, not an installed copy
    env |= {"GIMEL_APP_ROOT": str(tmp_path / "a" / "b" / "data"), "GIMEL_SECRET_KEY": "x" * 40, "GIMEL_MAIL_SILENT": "1"}
    Path(env["GIMEL_APP_ROOT"]).mkdir(parents=True)
    script = Path(__file__).with_name("standalone_flow.py")
    r = subprocess.run([sys.executable, str(script)], env=env, capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stdout[-1500:] + r.stderr[-3000:]
    assert "flow ok" in r.stdout
