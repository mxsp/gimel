"""Der Schnittplan: welche Maschine bekommt welche Datei, und warum.

Geprüft werden die *Aussagen* des Betreibers, nicht die Zahlen dahinter —
so wie ``test_worklist.py`` es hält. Der Werkstattbefund war:

    Am Plotter schneidet die Umwandlung von außen nach innen und sieht die
    ganze Auslage als ein Teil. Bei glatten Werkstoffen muss es umgekehrt
    sein, sonst reicht die Ansaugkraft nicht und runde Dichtungen sehen aus
    wie Eier. Am Wasserstrahl gibt es das Problem nicht.

Jeder Test hier ist einer dieser Sätze. Ein Gewicht zu ändern darf keinen
Test brechen; eine Regel umzudrehen muss.
"""

from __future__ import annotations

import pytest

from gimel.core.cutting import (CONVERSION_STRATEGY, GRIP_SMOOTH, MODE_AUTO,
                                MODE_CLASSIC, SAFE_STRATEGY, grip_of, plan_cut)


# --------------------------------------------------------------------------
# Die Regel
# --------------------------------------------------------------------------
def test_a_plotter_on_smooth_material_gets_the_layered_file_and_it_is_mandatory():
    """Der Kernsatz. Glatt am Plotter heißt geschichtet, innen nach außen."""
    plan = plan_cut("plotter", "elastomer")
    assert plan.layered
    assert plan.strategy == SAFE_STRATEGY == "inside_out"
    assert plan.mandatory
    assert plan.reason, "eine Regel ohne nachlesbaren Grund wird abgeschaltet"


def test_the_waterjet_gets_the_classic_file_because_it_has_no_such_problem():
    """Betreiber wörtlich: dort wird in der Vorbereitung programmiert und das
    System erkennt jedes Teil einzeln."""
    plan = plan_cut("waterjet", "elastomer")
    assert not plan.layered
    assert not plan.mandatory
    assert "Wasserstrahl" in plan.reason


def test_an_unassigned_work_order_still_gets_the_safe_sequence():
    """Die Datei wird oft geholt, bevor eine Station zugeordnet ist. Dann ist
    die sichere Folge die Vorgabe — die andere Wahl wäre der Schaden."""
    plan = plan_cut("", "elastomer")
    assert plan.layered and plan.strategy == SAFE_STRATEGY
    assert plan.mandatory


def test_an_unknown_material_group_counts_as_smooth():
    """Der ungünstigere Fall gewinnt: eine unbekannte Platte wie eine griffige
    zu behandeln riskiert genau den Schaden, den das Modul verhindert."""
    assert grip_of("gibtsnicht") == GRIP_SMOOTH
    assert plan_cut("plotter", "gibtsnicht").mandatory


def test_a_rough_material_is_layered_too_but_not_under_duress():
    """Die Folge kostet nichts, also bleibt sie die Vorgabe — nur ist eine
    Abweichung dort keine Warnung wert."""
    plan = plan_cut("plotter", "faser")
    assert plan.layered and plan.strategy == SAFE_STRATEGY
    assert not plan.mandatory


# --------------------------------------------------------------------------
# Die Wahl des Bedieners
# --------------------------------------------------------------------------
def test_the_operator_may_override_and_is_never_blocked():
    """Der Mensch an der Maschine sieht mehr als diese Funktion. Er bekommt
    die Warnung, nicht ein Nein."""
    plan = plan_cut("plotter", "elastomer", want=MODE_CLASSIC)
    assert not plan.layered
    assert plan.chosen
    assert plan.warning, "eine Abweichung auf glattem Werkstoff darf nicht stumm sein"


def test_choosing_the_conversion_default_on_smooth_material_warns():
    """„Außen → innen" ist genau das, was ohne PlotPro passiert."""
    plan = plan_cut("plotter", "elastomer", want=CONVERSION_STRATEGY)
    assert plan.layered and plan.strategy == CONVERSION_STRATEGY
    assert plan.warning


def test_the_same_choice_on_rough_material_does_not_warn():
    """Eine Warnung, die immer kommt, wird nicht gelesen."""
    assert not plan_cut("plotter", "faser", want=CONVERSION_STRATEGY).warning


def test_size_strategies_warn_on_smooth_material_because_they_ignore_nesting():
    """Sie können einen Gast vor oder nach seinem Wirt schneiden — auf glattem
    Werkstoff ist das die Frage, um die es geht."""
    assert plan_cut("plotter", "ptfe", want="largest_first").warning
    assert plan_cut("plotter", "ptfe", want="smallest_first").warning


def test_auto_is_the_default_and_carries_no_warning():
    """Bei „Automatisch" ist die Wahl die Regel — es gibt nichts zu warnen."""
    for want in (None, "", MODE_AUTO):
        plan = plan_cut("plotter", "elastomer", want=want)
        assert plan.layered and plan.strategy == SAFE_STRATEGY
        assert not plan.warning
        assert not plan.chosen


def test_an_unknown_choice_is_refused_rather_than_guessed():
    with pytest.raises(ValueError):
        plan_cut("plotter", "elastomer", want="irgendwas")


def test_dxf_strategy_translates_the_plan_for_the_renderer():
    """``plate_dxf`` will die Folge oder None — nicht zwei Felder."""
    assert plan_cut("plotter", "elastomer").dxf_strategy == SAFE_STRATEGY
    assert plan_cut("waterjet", "elastomer").dxf_strategy is None
