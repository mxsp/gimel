"""Shared nesting assertions (from Alef tests/test_invariants.py)."""

import math

from gimel.core.nesting import EPS, is_round


def assert_no_collisions(nested):
    for si, sh in enumerate(nested["sheets"]):
        parts = [(p, False) for p in sh.top] + [(p, True) for p in sh.rest]
        for i in range(len(parts)):
            for j in range(i + 1, len(parts)):
                a, a_rest = parts[i]
                b, b_rest = parts[j]
                d = math.hypot(a.cx - b.cx, a.cy - b.cy)
                if is_round(a) and is_round(b):
                    if d + EPS >= (a.od + b.od) / 2:
                        continue
                else:
                    # Unsymmetrische Teile beanspruchen ihre Standfläche, nicht
                    # ihren Umkreis — ein Kreisabstand um einen Streifen herum
                    # wäre keine Prüfung, sondern eine Erlaubnis.
                    dx, dy = abs(a.cx - b.cx), abs(a.cy - b.cy)
                    if dx + EPS >= (a.fw + b.fw) / 2 or dy + EPS >= (a.fh + b.fh) / 2:
                        continue
                # Erlaubt ist genau ein Fall: das kleinere Teil liegt vollständig
                # in der Bohrung des größeren.
                big, small = (a, b) if a.od >= b.od else (b, a)
                inside = big.di and (d + small.od / 2 <= big.di / 2 + EPS)
                assert inside, (
                    f"Kollision auf Platte {si}: "
                    f"Pos {a.pos.id}/{a.seq} und Pos {b.pos.id}/{b.seq}, Abstand {d:.3f}")
