"""Der Transport-Zustandsautomat: erlaubte Wege, Wiederholung und Gründe."""

from __future__ import annotations

from gimel.core import robot_state as state


def test_the_normal_path_is_allowed():
    assert state.can("approve", "proposed")
    assert state.can("assign", "approved")
    assert state.can("start", "assigned")
    assert state.can("done", "running")
    assert [state.target_state(a) for a in ("approve", "assign", "start", "done")] == [
        "approved", "assigned", "running", "done"
    ]


def test_a_job_may_be_reassigned_but_not_while_running():
    assert state.can("assign", "assigned")
    assert not state.can("assign", "running")
    assert "mitten auf dem Weg" in state.guard_reason("assign", "running")


def test_closed_jobs_are_final_but_cancel_and_fail_are_idempotent():
    for closed in ("done", "cancelled", "failed"):
        assert not state.can("assign", closed)
        assert not state.can("done", closed)
    for closed in ("cancelled", "failed"):
        assert "abgeschlossen" in state.guard_reason("done", closed)
    assert state.is_idempotent("done", "done")
    assert state.is_idempotent("cancel", "cancelled")
    assert state.is_idempotent("fail", "failed")
    assert not state.is_idempotent("assign", "assigned")


def test_repeating_an_action_in_its_target_state_is_not_an_error():
    assert state.is_idempotent("approve", "approved")
    assert state.is_idempotent("start", "running")
    assert state.guard_reason("approve", "approved") == ""
    assert state.guard_reason("start", "running") == ""


def test_an_unknown_state_or_action_is_refused():
    assert not state.can("start", "nonsense")
    assert state.normalize(" RUNNING ") == "running"
    assert state.normalize("nonsense") == ""
    assert state.guard_reason("teleport", "running") == "Unbekannte Aktion."
