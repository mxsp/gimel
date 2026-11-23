"""What CLAUDE.md says about gimel/core, as a check: rules in, nothing else."""

from __future__ import annotations

import ast
from datetime import datetime, timezone
from pathlib import Path

import pytest

from gimel.core.batch import ReleasePolicy, decide_release

CORE = Path(__file__).resolve().parents[2] / "gimel" / "core"
FILES = sorted(CORE.glob("*.py"))

#: Standard library the rules may use. No os, pathlib, socket, datetime.now, random.
ALLOWED = {"__future__", "dataclasses", "datetime", "enum", "functools", "heapq", "itertools",
           "json", "math", "typing", "collections"}
#: The exceptions, each in one named file.
EXCEPTIONS = {"time": ("nesting.py",), "extensions": ("nesting_gre.py",),
              "numpy": ("kerf.py", "vision.py", "robot_traffic.py")}


def _imports(path: Path) -> set[str]:
    names: set[str] = set()
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8-sig"))):
        if isinstance(node, ast.Import):
            names |= {a.name.split(".")[0] for a in node.names}
        elif isinstance(node, ast.ImportFrom):
            if node.level > 1:
                names.add((node.module or "").split(".")[0])
            elif not node.level:
                names.add((node.module or "").split(".")[0])
    return names


@pytest.mark.parametrize("path", FILES, ids=lambda p: p.name)
def test_core_imports_only_rules_and_the_named_exceptions(path):
    extra = _imports(path) - ALLOWED
    assert extra <= {k for k, where in EXCEPTIONS.items() if path.name in where}, extra


@pytest.mark.parametrize("path", FILES, ids=lambda p: p.name)
def test_core_never_asks_for_the_time_of_day(path):
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8-sig"))):
        if isinstance(node, ast.Attribute):
            assert node.attr not in ("now", "utcnow", "today"), f"{path.name}:{node.lineno}"


def test_an_ordinary_release_decision_without_now_is_refused():
    with pytest.raises(ValueError):
        decide_release([], [], ReleasePolicy())


def test_a_forced_run_needs_no_clock():
    assert decide_release([], [], ReleasePolicy(), force=True)[0]
    assert decide_release([], [], ReleasePolicy(), force=True,
                          now=datetime(2026, 1, 1, tzinfo=timezone.utc))[0]
