"""EN 16931 core UBL invoices for the domestic invoicing workflow.

This is not a Peppol transport or XRechnung profile. Validation below covers
the supported domestic subset; external XSD/Schematron validation remains
necessary when qualifying a recipient-specific profile.
"""
from __future__ import annotations
from ..config import ENV_PREFIX
from . import identity

from decimal import Decimal, ROUND_HALF_UP
from xml.etree import ElementTree as ET

NS = {
    "": "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2",
    "cac": "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
    "cbc": "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
}
for prefix, uri in NS.items():
    ET.register_namespace(prefix, uri)
#: Eine Gutschrift hat ihr eigenes Wurzelelement; das leere Präfix gehört der Rechnung.
CREDIT_NOTE_NS = "urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"
ET.register_namespace("cn", CREDIT_NOTE_NS)


#: Was eine Rechnung vom Verkäufer braucht (§ 14 Abs. 4 Nr. 1 UStG).
SELLER_REQUIRED = (("name", "Name"), ("street", "Straße"), ("zip", "PLZ"), ("city", "Ort"),
                   ("country", "Land"))


def seller(db=None) -> dict:
    return identity.seller(db)


def footer(db=None) -> str:
    s = seller(db)
    head = [s["name"]]
    if s["partners"]:
        head.append(f"Gesellschafter: {s['partners']}")
    head += [s["street"], f"{s['zip']} {s['city']}".strip(), s["country"]]
    if s["taxNumber"]:
        head.append(f"Steuernummer {s['taxNumber']}")
    if s["vatId"]:
        head.append(f"USt-IdNr. {s['vatId']}")
    head += [s["email"], s["website"]]
    return (" · ".join(p for p in head if p) + f". {identity.texts(db).invoice_footer_note}"
            "Vorauszahlung für eine noch auszuführende Lieferung; Liefertermin gemäß Auftragsbestätigung.")


def validate(data: dict) -> list[str]:
    errors = []
    issuer = data["seller"]
    missing = [title for field, title in SELLER_REQUIRED if not str(issuer.get(field) or "").strip()]
    if not str(issuer.get("vatId") or issuer.get("taxNumber") or "").strip():
        missing.append("USt-IdNr. oder Steuernummer")
    if missing:
        errors.append(f"Verkäuferdaten fehlen ({', '.join(missing)}). Ohne sie darf keine Rechnung "
                      f"entstehen: in den Einstellungen eintragen oder {ENV_PREFIX}SELLER_* setzen")
    if str(issuer.get("country") or "").upper() not in ("", "DE"):
        errors.append("Aussteller: Auslandsrechnung erfordert steuerliche Prüfung")
    buyer = data["buyer"]
    for field in ("name", "street", "zip", "city", "country"):
        if not str(buyer.get(field) or "").strip():
            errors.append(f"Rechnungsempfänger: {field} fehlt")
    if buyer.get("country", "").upper() != "DE":
        errors.append("Rechnungsempfänger: Auslandsrechnung erfordert steuerliche Prüfung")
    if data.get("ship_country", "DE").upper() != "DE":
        errors.append("Auslandslieferung erfordert steuerliche Prüfung")
    amounts = [data[k] for k in ("net", "vat", "gross")]
    if any(not isinstance(n, int) or n < 0 for n in amounts):
        errors.append("Ungültige Rechnungsbeträge")
    if data["net"] + data["vat"] != data["gross"]:
        errors.append("Netto + Umsatzsteuer stimmt nicht mit Brutto überein")
    prepaid = data.get("prepaid", 0)
    if type(prepaid) is not int or prepaid < 0 or prepaid > data["gross"]:
        errors.append("Ungültiger bereits gezahlter Betrag")
    if Decimal(str(data["rate"])) != Decimal("0.19"):
        errors.append("Abweichender Steuersatz erfordert Prüfung")
    if int((Decimal(data["net"]) * Decimal("0.19")).quantize(Decimal("1"), rounding=ROUND_HALF_UP)) != data["vat"]:
        errors.append("Umsatzsteuer stimmt nicht mit 19 % des Nettobetrags überein")
    if not data["lines"] or sum(l["amount_cents"] for l in data["lines"]) != data["net"]:
        errors.append("Rechnungspositionen stimmen nicht mit Netto überein")
    if any(l["amount_cents"] < 0 for l in data["lines"]):
        errors.append("Negative Rechnungsposition")
    return errors


def build(data: dict, number: str, issue_date: str, due_date: str | None = None,
          credit_of: str = "") -> str:
    """Ohne ``credit_of`` eine Rechnung (380), sonst eine Gutschrift (381) mit Bezug
    auf diese Nummer, Beträge positiv wie in UBL vorgesehen. Lokale Rechnungen setzen
    zusätzlich ``note``, ``payment_note`` und ``delivery_date``."""
    errors = validate(data)
    if errors or not number or not issue_date:
        raise ValueError("; ".join(errors) or "Rechnungsnummer oder Rechnungsdatum fehlt")
    root = ET.Element(f"{{{CREDIT_NOTE_NS}}}CreditNote" if credit_of else f"{{{NS['']}}}Invoice")

    def add(parent, tag, value=None, **attrs):
        prefix, name = tag.split(":")
        el = ET.SubElement(parent, f"{{{NS[prefix]}}}{name}", attrs)
        if value is not None:
            el.text = str(value)
        return el

    def money(parent, tag, cents):
        return add(parent, "cbc:" + tag, f"{Decimal(cents) / 100:.2f}", currencyID="EUR")

    def tax(parent, tag):
        el = add(parent, tag)
        add(el, "cbc:ID", "S")
        add(el, "cbc:Percent", "19")
        add(add(el, "cac:TaxScheme"), "cbc:ID", "VAT")

    add(root, "cbc:CustomizationID", "urn:cen.eu:en16931:2017")
    add(root, "cbc:ID", number)
    add(root, "cbc:IssueDate", issue_date)
    if due_date and not credit_of:
        add(root, "cbc:DueDate", due_date)
    add(root, "cbc:CreditNoteTypeCode" if credit_of else "cbc:InvoiceTypeCode", "381" if credit_of else "380")
    add(root, "cbc:Note", data.get("note") or "Vorauszahlung für eine noch auszuführende Lieferung; Liefertermin gemäß Auftragsbestätigung.")
    if data['seller'].get('partners'):
        add(root, "cbc:Note", "Gesellschafter: " + data['seller']['partners'])
    add(root, "cbc:DocumentCurrencyCode", "EUR")
    if data.get("buyer_reference"):
        add(root, "cbc:BuyerReference", data["buyer_reference"])
    add(add(root, "cac:OrderReference"), "cbc:ID", data["order_no"])
    if credit_of:
        add(add(add(root, "cac:BillingReference"), "cac:InvoiceDocumentReference"), "cbc:ID", credit_of)
    for key, tag in (("seller", "cac:AccountingSupplierParty"), ("buyer", "cac:AccountingCustomerParty")):
        party = data[key]
        el = add(add(root, tag), "cac:Party")
        add(add(el, "cac:PartyName"), "cbc:Name", party["name"])
        address = add(el, "cac:PostalAddress")
        for field, name in (("street", "StreetName"), ("city", "CityName"), ("zip", "PostalZone")):
            add(address, "cbc:" + name, party[field])
        add(add(address, "cac:Country"), "cbc:IdentificationCode", party["country"].upper())
        if party.get("vatId"):
            scheme = add(el, "cac:PartyTaxScheme")
            add(scheme, "cbc:CompanyID", party["vatId"])
            add(add(scheme, "cac:TaxScheme"), "cbc:ID", "VAT")
        if party.get("taxNumber"):
            scheme = add(el, "cac:PartyTaxScheme")
            add(scheme, "cbc:CompanyID", party["taxNumber"])
            add(add(scheme, "cac:TaxScheme"), "cbc:ID", "FC")
        add(add(el, "cac:PartyLegalEntity"), "cbc:RegistrationName", party.get("legalName") or party["name"])
        if party.get("email"):
            add(add(el, "cac:Contact"), "cbc:ElectronicMail", party["email"])
    if data.get("delivery_date"):
        add(add(root, "cac:Delivery"), "cbc:ActualDeliveryDate", data["delivery_date"])
    iban = str(data["seller"].get("iban") or "").replace(" ", "")
    if iban and not credit_of:
        means = add(root, "cac:PaymentMeans")
        add(means, "cbc:PaymentMeansCode", "58")  # SEPA-Überweisung
        account = add(means, "cac:PayeeFinancialAccount")
        add(account, "cbc:ID", iban)
        add(account, "cbc:Name", data["seller"].get("legalName") or data["seller"]["name"])
    if not due_date:
        add(add(root, "cac:PaymentTerms"), "cbc:Note", data.get("payment_note") or "Zahlbar nach Vereinbarung")
    total = add(root, "cac:TaxTotal")
    money(total, "TaxAmount", data["vat"])
    subtotal = add(total, "cac:TaxSubtotal")
    money(subtotal, "TaxableAmount", data["net"])
    money(subtotal, "TaxAmount", data["vat"])
    tax(subtotal, "cac:TaxCategory")
    legal = add(root, "cac:LegalMonetaryTotal")
    for tag, key in (("LineExtensionAmount", "net"), ("TaxExclusiveAmount", "net"),
                     ("TaxInclusiveAmount", "gross")):
        money(legal, tag, data[key])
    money(legal, "PrepaidAmount", data.get("prepaid", 0))
    money(legal, "PayableAmount", data["gross"] - data.get("prepaid", 0))
    for idx, line in enumerate(data["lines"], 1):
        el = add(root, "cac:CreditNoteLine" if credit_of else "cac:InvoiceLine")
        add(el, "cbc:ID", idx)
        add(el, "cbc:CreditedQuantity" if credit_of else "cbc:InvoicedQuantity", "1", unitCode="C62")
        money(el, "LineExtensionAmount", line["amount_cents"])
        item = add(el, "cac:Item")
        add(item, "cbc:Name", line["description"])
        tax(item, "cac:ClassifiedTaxCategory")
        money(add(el, "cac:Price"), "PriceAmount", line["amount_cents"])
    return ET.tostring(root, encoding="utf-8", xml_declaration=True).decode("utf-8")
