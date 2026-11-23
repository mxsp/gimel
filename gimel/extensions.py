"""The seam between Gimel and the application built on it.

Gimel runs on its own. An application (Alef is the first) registers one
:class:`Plugin` before the app is created and adds what only it knows: its
routes, its price formula, its seed data, an extra nesting engine. Gimel never
imports an application; everything crosses this file.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Iterable, Optional, Sequence


@dataclass(frozen=True)
class Identity:
    """Who a document names: the seller, the maker, the brand on paper and in mail.

    Gimel carries no identity of its own. An application supplies its strings
    here; ``gimel.services.identity`` fills what stays empty from the seller.
    ``<PREFIX>SELLER_*`` in the environment wins over the seller fields.
    """

    # Seller, as § 14 UStG asks for it.
    name: str = ""
    street: str = ""
    zip: str = ""
    city: str = ""
    country: str = "DE"
    vat_id: str = ""
    tax_number: str = ""
    partners: str = ""
    email: str = ""
    website: str = ""
    #: Who makes the goods: ``/api/invoicing/config``, the 2FA issuer, the
    #: production mail (short form in its head, full line in its foot).
    manufacturer: str = ""
    manufacturer_short: str = ""
    manufacturer_line: str = ""
    #: Shipping label: mark and name in its head.
    brand_mark: str = ""
    brand_name: str = ""
    #: Head of the route card.
    paper_name: str = ""
    #: Product name and subject prefix of account mail, its signature.
    product: str = ""
    mail_subject: str = ""
    signature: str = ""
    #: Head and foot of customer mail, and the display name of the sender.
    mail_header: str = ""
    mail_footer: str = ""
    mail_from_name: str = ""
    #: Security mail (CRA): who answers, where, and the fallback contact.
    security_sender: str = ""
    security_url: str = ""
    security_contact: str = ""
    #: Stripe texts. The key names a tax rate that already exists at Stripe.
    office_label: str = ""
    invoice_description: str = ""
    invoice_footer_note: str = ""
    tax_rate_description: str = ""
    tax_rate_key: str = ""


@dataclass
class Plugin:
    name: str
    #: Shown on the API docs page; empty keeps Gimel's own.
    title: str = ""
    description: str = ""
    #: Returns FastAPI routers. A callable, so that registering a plugin does
    #: not import the platform before the settings are in place.
    routers: Optional[Callable[[], Iterable[Any]]] = None
    #: Same signature as ``gimel.core.pricing.price_cart``.
    price_cart: Optional[Callable[..., dict]] = None
    #: Runs inside ``init_db`` with an open session; returns figures for the log.
    seed: Optional[Callable[[Any, bool], dict]] = None
    #: Returns a module with ``ENGINE_LABEL``, ``gre_available``, ``nest_best_gre``
    #: and ``nest_for_gre``; see ``gimel.core.nesting_gre``.
    nesting_engine: Optional[Callable[[], Any]] = None
    #: Staff and admin accounts must use this mail domain. Empty = any.
    internal_email_domain: str = ""
    #: Optional screens the web app may show, e.g. ``library``, ``ai_quote``.
    features: Sequence[str] = ()
    #: Seller and branding. None = Gimel's own: empty until an admin fills them in.
    identity: Optional[Identity] = None
    #: Without a Stripe key Gimel issues invoices itself. An application that
    #: bills through Stripe alone turns this off and keeps the 503.
    local_invoicing: bool = True


_active: Optional[Plugin] = None


def use(plugin: Plugin) -> None:
    global _active
    _active = plugin


def active() -> Optional[Plugin]:
    return _active


def price_cart(*args, **kwargs) -> dict:
    """The active price formula: the application's, else Gimel's plain one."""
    if _active and _active.price_cart:
        return _active.price_cart(*args, **kwargs)
    from .core.pricing import price_cart as plain

    return plain(*args, **kwargs)
