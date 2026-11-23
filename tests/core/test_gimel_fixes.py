"""Where Gimel's core deliberately differs from Alef @ a54735e6."""

from gimel.core.batch import BatchPart, plan_batch
from gimel.core.geometry import rect_from_params
from gimel.core.types import Product, Rates


def test_a_rectangle_is_nested_by_its_footprint_not_its_circumcircle():
    # 400 × 300 has a 500 mm circumcircle. As a circle, three fit on a
    # 1000 × 1000 sheet at most; by footprint, four fit in two rows.
    part = BatchPart(position_id=1, order_no="G-1", customer="", customer_ref="", label="R",
                     mat="m", thk=2.0, od=500.0, di=0.0, q=4,
                     shape=rect_from_params(400, 300))
    product = Product(id="m", eur_m2=0.0, sheets=[(1000.0, 1000.0)])
    groups, held = plan_batch([part], {"m": product}, Rates(gap=6, margin=12), force=True)
    assert not held
    assert len(groups[0].plates) == 1
    assert groups[0].plates[0].used_h < 700
