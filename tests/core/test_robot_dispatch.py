"""Roboterauswahl: harte Schranken, Nähe, Gleichstand und ehrliche Gründe."""

from __future__ import annotations

from gimel.core.robot_dispatch import RobotOption, rank_robots


def robot(**extra) -> RobotOption:
    base = dict(id=1, name="AGV", x=0.0, y=0.0, battery_pct=80,
                payload_kg=200.0, capabilities=("transport",), state="idle")
    base.update(extra)
    return RobotOption(**base)


def test_the_nearest_suitable_robot_wins():
    near = robot(id=1, name="Nah", x=2.0, y=0.0)
    far = robot(id=2, name="Fern", x=20.0, y=0.0)
    choices, rejected = rank_robots(start=(0.0, 0.0), robots=[far, near])
    assert not rejected
    assert [c.robot_id for c in choices] == [1, 2]
    assert choices[0].distance_m == 2.0


def test_a_low_battery_robot_is_not_chosen():
    choices, rejected = rank_robots(
        start=(0.0, 0.0),
        robots=[robot(id=1, battery_pct=5), robot(id=2, battery_pct=70, x=50.0)],
    )
    assert [c.robot_id for c in choices] == [2]
    assert rejected[0].robot_id == 1
    assert "Reserve" in rejected[0].reason


def test_unknown_battery_does_not_disqualify_but_is_named():
    choices, rejected = rank_robots(start=(0.0, 0.0), robots=[robot(battery_pct=None)])
    assert not rejected
    assert "unbekannt" in choices[0].reason


def test_capability_and_payload_are_hard_limits():
    choices, rejected = rank_robots(
        start=(0.0, 0.0),
        robots=[robot(id=1, capabilities=("arm",)), robot(id=2, payload_kg=50.0)],
        payload_kg=120.0,
        capability="transport",
    )
    assert choices == []
    assert {r.robot_id for r in rejected} == {1, 2}


def test_an_unknown_position_is_not_guessed():
    choices, rejected = rank_robots(start=(0.0, 0.0), robots=[robot(x=None, y=None)])
    assert choices == []
    assert "Position unbekannt" in rejected[0].reason


def test_equal_scores_break_by_id_not_by_input_order():
    a = robot(id=9, x=5.0, y=0.0, battery_pct=80)
    b = robot(id=3, x=5.0, y=0.0, battery_pct=80)
    choices, _ = rank_robots(start=(0.0, 0.0), robots=[a, b])
    assert [c.robot_id for c in choices] == [3, 9]
