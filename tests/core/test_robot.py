"""Reine Roboterbewegung: Weg, Richtung, Rundkurs und Hin und Zurück."""

from __future__ import annotations

from gimel.core.robot import pose_on_route, route_length_m


def test_length_is_the_sum_of_the_segments():
    assert route_length_m([[0, 0], [3, 4]]) == 5
    assert route_length_m([[0, 0], [3, 4], [3, 14]]) == 15


def test_a_loop_closes_the_last_gap_once():
    square = [[0, 0], [10, 0], [10, 10], [0, 10]]
    assert route_length_m(square, loop=True) == 40
    assert route_length_m(square) == 30


def test_a_two_point_loop_is_an_out_and_back_route():
    route = [[0, 0], [10, 0]]
    assert route_length_m(route, loop=True) == 20
    pose = pose_on_route(route, 15, loop=True)
    assert pose is not None
    assert (pose.x, pose.y) == (5, 0)
    assert pose.heading_deg == 180


def test_pose_follows_the_segment_and_heading():
    pose = pose_on_route([[0, 0], [10, 0], [10, 10]], 15)
    assert pose is not None
    assert (pose.x, pose.y) == (10, 5)
    assert pose.heading_deg == 90


def test_pingpong_turns_around_at_the_end():
    route = [[0, 0], [10, 0], [20, 0]]
    back = pose_on_route(route, 25)
    assert back is not None
    assert (back.x, back.y) == (15, 0)
    assert back.heading_deg == 180
    again = pose_on_route(route, 35)
    assert again is not None
    assert again.x == 5 and again.heading_deg == 180
    start = pose_on_route(route, 40)
    assert start is not None
    assert start.x == 0 and start.heading_deg == 0


def test_negative_distance_is_the_mirror_of_the_positive_one():
    pose = pose_on_route([[0, 0], [10, 0]], -5)
    assert pose is not None
    assert (pose.x, pose.y) == (5, 0)
    assert pose.heading_deg == 180


def test_a_single_point_or_bad_input_has_no_pose():
    assert pose_on_route([[1, 2]], 3) is None
    assert pose_on_route([], 0) is None
    assert pose_on_route([["x", 1], [2, 3]], 0) is None


def test_an_empty_route_has_no_length():
    assert route_length_m([], loop=True) == 0
    assert route_length_m([[1, 1]], loop=True) == 0
