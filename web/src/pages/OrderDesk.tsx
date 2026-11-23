import { Button, Checkbox, Dialog, FormGroup, HTMLSelect, HTMLTable, InputGroup, Menu, MenuItem, Radio, RadioGroup, Tag } from "@blueprintjs/core";
import Callout from "../components/Callout";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, apiUpload, canAdminWork, fmtEur, getUser } from "../api";
import { toastError, toastSuccess } from "../toast";
import MaterialSelect, { useMaterials } from "../components/MaterialSelect";
import ShapePicker from "../components/ShapePicker";
import type { PickedShape } from "../components/ShapePicker";
import { plural } from "../plural";
import { useVersion } from "../useVersion";
import { scopeMatters, scopeOptions, useTopology } from "../sites";
import { navigate } from "../router";
import { InfoHint, PageFrame, Toolbar } from "../ui";

// --------------------------------------------------------------------------
// Typen
// --------------------------------------------------------------------------
interface Customer {
  id: number;
  email: string;
  name: string;
  company: string;
  price_group: string;
  discount_pct: number;
  payment_terms: string;
  customer_no: string;
  credit_limit: number;
  n_orders: number;
  open_net: number;
  // Stand des Kunden (Aufgabe 45)
  open_gross?: number;
  credit_free?: number | null;
  credit_pct?: number | null;
  order_block?: boolean;
  order_block_reason?: string;
}

interface Address {
  id: number;
  label: string;
  company: string;
  contact: string;
  street: string;
  zip: string;
  city: string;
  country: string;
  is_billing: boolean;
  is_delivery: boolean;
  vat_id?: string;
  dept?: string;
}

interface DeskLine {
  id: number;
  kind: string;        // gasket | custom
  label: string;
  desc: string;        // nur freie Position — interne Beschreibung (Werkstatt/Laufkarte)
  external_note: string; // nur freie Position — Kundenhinweis (Rechnung/Beleg/Portal)
  price_gross: number; // nur freie Position — € brutto je Stück
  mat: string;
  thk: number;
  q: number;
  od: number;
  di: number;
  bn: number;
  bd: number;
  bc: number;
  cut_len: number;
  shape: Record<string, unknown> | null;
  /*: Hausform aus der Bibliothek — nur dort gesetzt, nicht bei DXF/KI/Hand. */
  shape_id: number | null;
  fmt: number[] | null;
  source: string;      // dxf | ki | lib | hand | frei
}

interface Quote {
  total: number;
  vat: number;
  gross: number;
  mat_c: number;
  cut_c: number;
  custom_c: number;
  setup: number;
  cert: number;
  freight: number;
  vat_rate: number;
  per: Record<string, Record<string, number>>;
}

interface OrderResult {
  no: string;
  kind: string;
  internal_owner: string;
  net: number;
  gross: number;
  released: boolean;
  release_note: string;
  paid: boolean;
  invoice_no: string;
}

interface DxfResult {
  shape: Record<string, unknown>;
  od: number;
  di: number;
  cut_len: number;
  w: number;
  h: number;
  filename: string;
  skipped: string[];
}

interface AiDraft {
  source: string;
  lines: Array<Record<string, any>>;
  price: Record<string, any> | null;
  warnings: string[];
  filename: string;
}

const SOURCE: Record<string, { label: string; intent: any }> = {
  dxf: { label: "DXF", intent: "success" },
  ki: { label: "KI", intent: "warning" },
  lib: { label: "Bibliothek", intent: "primary" },
  frei: { label: "frei", intent: "danger" },
  hand: { label: "Hand", intent: "none" },
};

let nextLineId = 1;

const baseLine = (): DeskLine => ({
  id: nextLineId++, kind: "gasket", label: "", desc: "", external_note: "", price_gross: 0,
  mat: "", thk: 3, q: 1, od: 0, di: 0, bn: 0, bd: 0, bc: 0, cut_len: 0,
  shape: null, shape_id: null, fmt: null, source: "hand",
});

const emptyLine = (mat: string): DeskLine =>
  ({ ...baseLine(), label: "Ring", mat, od: 100, di: 50 });

/* Eine freie Position: Sonderfertigung, Zukauf, Handarbeit. Sie hat keine
   Geometrie, die der Nester schachteln könnte — der Erfasser setzt den
   Bruttopreis, und der Rechenkern rechnet ihn nur auf netto zurück. */
const customLine = (): DeskLine =>
  ({ ...baseLine(), kind: "custom", label: "Sonderfertigung", thk: 0, source: "frei" });

const isCustom = (l: DeskLine) => l.kind === "custom";

export default function OrderDesk() {
  // Formen-Bibliothek und KI-Auswertung bringt nur eine Anwendung mit.
  const features = useVersion()?.features ?? null;
  const has = (feature: string) => !features || features.includes(feature);
  const [activeStep, setActiveStep] = useState<number | null>(1);
  const stepHeaders = useRef<Array<HTMLButtonElement | null>>([]);
  // Auftragsart: extern ist der Kundenauftrag. Intern bleibt im Haus — kein
  // Kunde, keine Lieferanschrift, keine Zahlung und keine Rechnung, dafür ein
  // verantwortlicher Mitarbeiter.
  const [kind, setKind] = useState<"external" | "internal">("external");
  const [internalOwner, setInternalOwner] = useState(() => getUser()?.name ?? "");
  // Schritt 1 — Kunde
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerQuery, setCustomerQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [selected, setSelected] = useState<Customer | null>(null);
  // Auftragssperre des Kunden für diesen einen Auftrag übergehen (nur Admin).
  const [overrideBlock, setOverrideBlock] = useState(false);
  useEffect(() => { setOverrideBlock(false); }, [selected?.id]);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [newCustomer, setNewCustomer] = useState({
    email: "", name: "", company: "", price_group: "standard",
    discount_pct: 0, payment_terms: "30 Tage netto", credit_limit: 0, vat_id: "",
  });

  // Schritt 2 — Positionen
  const materials = useMaterials();
  const [lines, setLines] = useState<DeskLine[]>([]);
  const [quoteState, setQuoteState] = useState<{ input: string; data?: Quote; error?: string } | null>(null);
  const [quoteRetry, setQuoteRetry] = useState(0);
  const [cert, setCert] = useState("2.2");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiWarnings, setAiWarnings] = useState<string[]>([]);
  const [lastUpload, setLastUpload] = useState("");
  const [showLibrary, setShowLibrary] = useState(false);

  // Schritt 3 — Versand und Rechnung
  const [ship, setShip] = useState({ company: "", contact: "", street: "", zip: "", city: "", country: "DE" });
  const [shipSource, setShipSource] = useState<"temp" | "saved" | "new">("temp");
  const [shipSavedId, setShipSavedId] = useState<number | null>(null);
  const [saveNewAddress, setSaveNewAddress] = useState(false);
  const [saveLabel, setSaveLabel] = useState("");
  // Rechnungsanschrift getrennt von der Lieferanschrift: Vorgabe ist
  // „wie Lieferanschrift“, gewählt werden kann auch jede gespeicherte
  // Anschrift des Kunden — etwa bei abweichender Rechnungsadresse der Zentrale.
  const [billMode, setBillMode] = useState<"ship" | "saved">("ship");
  const [billSavedId, setBillSavedId] = useState<number | null>(null);
  const [email, setEmail] = useState("");
  const [rush, setRush] = useState(false);
  const sites = useTopology();
  const [routeScope, setRouteScope] = useState("");
  const [siteId, setSiteId] = useState<number | null>(null);
  const [paymentMode, setPaymentMode] = useState("invoice");
  const [customerRef, setCustomerRef] = useState("");
  // Manueller Versand: Spedition, Tracking und Versandkosten kennt der Erfasser
  // schon — der Versand bekommt die Angaben später als Vorgabe vorausgefüllt.
  const [manualShip, setManualShip] = useState(false);
  const [manualShipment, setManualShipment] = useState({ carrier: "", tracking: "", price: 0, note: "" });

  const [busy, setBusy] = useState(false);
  const [invoiceConfigured, setInvoiceConfigured] = useState(true);
  const [result, setResult] = useState<OrderResult | null>(null);
  const [invoiceBusy, setInvoiceBusy] = useState(false);

  const dxfInput = useRef<HTMLInputElement>(null);
  const pdfInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<Customer[]>("/api/customers").then(setCustomers).catch(() => {});
    api<{ configured: boolean }>("/api/invoicing/config")
      .then((c) => setInvoiceConfigured(c.configured))
      .catch(() => setInvoiceConfigured(false));
  }, []);

  // Live-Preis: jede Änderung an Positionen wird sofort gerechnet —
  // derselbe Rechenkern, der später den Auftrag einfriert. Mit manuellem
  // Versand ersetzt der handerfasste Preis die Versandpauschale, damit
  // Vorschau und Rechnung denselben Betrag zeigen.
  // Die Vorschau rechnet für den Kunden, für den der Auftrag gleich angelegt
  // wird — sonst fehlt sein Rabatt, und Vorschau und Rechnung liefen auseinander.
  const quoteInput = useMemo(() => lines.length ? JSON.stringify({
    lines: lines.map((l) => ({ ...l })), cert,
    // Interne Aufträge werden ohne Umsatzsteuer geführt — die Vorschau muss
    // denselben Satz rechnen wie später der eingefrorene Auftrag.
    ...(kind === "internal" ? { vat_rate: 0 } : {}),
    ...(kind === "external" && manualShip ? { freight: manualShipment.price } : {}),
    ...(kind === "external" && mode === "existing" && selected ? { customer_id: selected.id } : {}),
    ...(kind === "external" && mode === "new" ? { price_group: newCustomer.price_group, discount_pct: newCustomer.discount_pct } : {}),
  }) : "", [lines, cert, kind, manualShip, manualShipment.price, mode, selected, newCustomer.price_group, newCustomer.discount_pct]);
  // Der Eingabeschlüssel blendet alte Preise schon vor dem nächsten Effect aus.
  const quote = quoteState?.input === quoteInput ? quoteState.data : undefined;
  const quoteError = quoteState?.input === quoteInput ? quoteState.error : undefined;
  const quoteLoading = Boolean(quoteInput && !quote && !quoteError);

  useEffect(() => {
    if (!quoteInput) { setQuoteState(null); return; }
    const controller = new AbortController();
    const t = setTimeout(() => {
      api<Quote>("/api/quote", {
        method: "POST",
        body: quoteInput,
        signal: controller.signal,
      }).then((data) => {
        if (!controller.signal.aborted) setQuoteState({ input: quoteInput, data });
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) setQuoteState({
          input: quoteInput,
          error: error instanceof Error ? error.message : "Preis konnte nicht berechnet werden.",
        });
      });
    }, 250);
    return () => { clearTimeout(t); controller.abort(); };
  }, [quoteInput, quoteRetry]);

  const defaultMat = () => materials[0]?.id ?? "";

  // ---------- Kunde ----------
  /* Bestandskunde und Neuanlage waren zwei Masken hinter einem Umschalter,
     und wer den Kunden nicht fand, musste erst umschalten und dann alles noch
     einmal tippen. Es ist ein Vorgang: den Kunden benennen. Gefunden heisst
     übernehmen, nicht gefunden heisst anlegen — mit dem, was schon getippt
     wurde. */
  const matches = useMemo(() => {
    const q = customerQuery.trim().toLowerCase();
    const rows = !q ? customers : customers.filter((c) =>
      `${c.company} ${c.name} ${c.email} ${c.customer_no}`.toLowerCase().includes(q));
    return rows.slice(0, 7);
  }, [customers, customerQuery]);

  useEffect(() => { setHighlight(0); }, [customerQuery]);

  const selectCustomer = async (c: Customer) => {
    setSelected(c);
    setMode("existing");
    setEmail(c.email);
    setShip((s) => ({ ...s, company: c.company || s.company, contact: c.name || s.contact }));
    setShipSource("temp");
    setShipSavedId(null);
    setSaveNewAddress(false);
    setSaveLabel("");
    setBillMode("ship");
    setBillSavedId(null);
    try {
      const rows = await api<Address[]>(`/api/customers/${c.id}/addresses`);
      setAddresses(rows);
      // Lieferstandard zuerst, dann die erste Nicht-Rechnungsanschrift —
      // genau die Reihenfolge, in der der Server den Standard vergibt.
      const preferred = rows.find((a) => a.is_delivery) ?? rows.find((a) => !a.is_billing) ?? rows[0];
      const billing = rows.find((a) => a.is_billing) ?? rows[0];
      if (billing && billing.id !== preferred?.id) {
        setBillMode("saved");
        setBillSavedId(billing.id);
      }
      if (preferred) {
        applyAddress(preferred, c);
        setShipSavedId(preferred.id);
        setShipSource("saved");
      }
    } catch { setAddresses([]); }
  };

  const applyAddress = (a: Address, fallback?: Customer | null) => {
    const cust = fallback ?? selected;
    setShip({
      company: a.company || cust?.company || "", contact: a.contact || cust?.name || "", street: a.street || "",
      zip: a.zip || "", city: a.city || "", country: a.country || "DE",
    });
    setShipSavedId(a.id);
    setShipSource("saved");
    setSaveNewAddress(false);
  };

  const startNewCustomer = () => {
    const q = customerQuery.trim();
    setNewCustomer((n) => ({
      ...n,
      email: q.includes("@") ? q : n.email,
      company: q && !q.includes("@") ? q : n.company,
    }));
    setSelected(null);
    setAddresses([]);
    setBillMode("ship");
    setBillSavedId(null);
    setMode("new");
  };

  const clearCustomer = () => {
    setSelected(null);
    setAddresses([]);
    setShipSource("temp");
    setShipSavedId(null);
    setSaveNewAddress(false);
    setSaveLabel("");
    setBillMode("ship");
    setBillSavedId(null);
    setMode("existing");
    setCustomerQuery("");
  };

  const onCustomerKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const n = matches.length + 1;   // die Neuanlage ist der letzte Eintrag
    if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => (h + 1) % n); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => (h - 1 + n) % n); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (highlight < matches.length) selectCustomer(matches[highlight]);
      else startNewCustomer();
    }
  };

  // ---------- DXF ----------
  const onDxf = async (file: File) => {
    try {
      const r = await apiUpload<DxfResult>("/api/desk/dxf", file);
      setLastUpload(`DXF „${r.filename}“ gelesen: Ø ${r.od} / ${r.di} mm`);
      setLines((ls) => [...ls, {
        ...baseLine(), label: file.name.replace(/\.dxf$/i, ""),
        mat: defaultMat(), od: r.od, di: r.di,
        cut_len: r.cut_len, shape: r.shape, source: "dxf",
      }]);
    } catch (e: any) {
      toastError(e.message);
    }
  };

  // ---------- KI (PDF / Vektor) ----------
  const onPdf = async (file: File) => {
    setAiBusy(true);
    setAiWarnings([]);
    try {
      const draft = await apiUpload<AiDraft>("/api/ai/quote", file, { cert });
      setAiWarnings(draft.warnings ?? []);
      setLastUpload(`KI-Analyse von „${draft.filename}“: ${plural(draft.lines?.length ?? 0, "Position", "Positionen")} erkannt`);
      const imported: DeskLine[] = (draft.lines ?? []).map((l) => ({
        ...baseLine(), label: l.label || "Erkanntes Teil",
        mat: l.mat || defaultMat(), thk: l.thk || 3, q: l.q || 1,
        od: l.od || 0, di: l.di || 0, bn: l.bn || 0, bd: l.bd || 0, bc: l.bc || 0,
        cut_len: l.cut_len || 0, shape: l.shape ?? null, source: "ki",
      }));
      setLines((ls) => [...ls, ...imported]);
      if (draft.price) toastSuccess(`Vorschau gerechnet: ${fmtEur(draft.price.gross)} brutto`);
    } catch (e: any) {
      toastError(e.message);
    } finally {
      setAiBusy(false);
    }
  };

  // ---------- Bibliothek ----------
  const takeShape = (s: PickedShape) => setLines((ls) => [...ls, {
    ...baseLine(), label: s.label, mat: s.mat || defaultMat(), thk: s.thk, q: s.q,
    od: s.od, di: s.di, bn: s.bn, bd: s.bd, bc: s.bc, cut_len: s.cut_len,
    shape: s.shape, shape_id: s.shape_id, source: "lib",
  }]);

  const updateLine = (id: number, patch: Partial<DeskLine>) =>
    setLines((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));

  const updateLineBolts = (l: DeskLine, patch: Partial<Pick<DeskLine, "bn" | "bd" | "bc">>) => {
    const nextBn = Math.max(0, Math.min(200, Math.round(patch.bn ?? l.bn)));
    const nextBd = Math.max(0, patch.bd ?? l.bd);
    const nextBc = Math.max(0, patch.bc ?? l.bc);
    const nextPatch: Partial<DeskLine> = { bn: nextBn, bd: nextBd, bc: nextBc };
    if (l.shape && typeof l.shape === "object") {
      nextPatch.shape = {
        ...l.shape,
        bolts: nextBn > 0 && nextBd > 0 && nextBc > 0
          ? { n: nextBn, d: nextBd, bc: nextBc, phase: 0 }
          : null,
      };
    }
    updateLine(l.id, nextPatch);
  };

  const removeLine = (id: number) => setLines((ls) => ls.filter((l) => l.id !== id));

  // ---------- Auftrag anlegen ----------
  /* Die Rechnungsanschrift als Momentaufnahme aus dem Adressbuch — dieselben
     Schlüssel wie die Lieferanschrift, damit Lieferschein und Rechnung denselben
     Vertrag erfüllen. */
  const billAddress = (): Record<string, string> => {
    if (billMode !== "saved") return ship;
    const a = addresses.find((x) => x.id === billSavedId);
    if (!a) return ship;
    return {
      company: a.company || "", contact: a.contact || "", dept: a.dept || "",
      street: a.street || "", zip: a.zip || "", city: a.city || "",
      country: a.country || "DE", vat_id: a.vat_id || "",
    };
  };

  const createOrder = async () => {
    if (!canCreate || busy || result) return;
    setBusy(true);
    try {
      if (kind === "external" && selected && saveNewAddress && ship.street && ship.zip && ship.city) {
        try {
          const created = await api<Address>(`/api/customers/${selected.id}/addresses`, {
            method: "POST",
            body: JSON.stringify({
              label: saveLabel || `Auftrag ${new Date().toLocaleDateString()}`,
              company: ship.company, contact: ship.contact,
              street: ship.street, zip: ship.zip, city: ship.city, country: ship.country,
              is_billing: false,
            }),
          });
          setAddresses((a) => [...a, created]);
          toastSuccess(`Anschrift „${created.label || created.street}“ gespeichert.`);
        } catch (e: any) {
          toastError(`Anschrift speichern fehlgeschlagen: ${e.message}`);
        }
      }
      const body: Record<string, unknown> = {
        kind,
        lines: lines.map((l) => ({ ...l })),
        cert,
        rush,
        route_scope: routeScope,
        site_id: siteId,
      };
      if (kind === "internal") {
        body.internal_owner = internalOwner.trim();
      } else {
        body.ship_address = ship;
        body.bill_address = billAddress();
        body.payment_mode = paymentMode;
        body.customer_ref = customerRef;
        if (manualShip) body.manual_shipment = manualShipment;
        if (mode === "existing") {
          body.customer_id = selected?.id;
          if (selected?.order_block && overrideBlock) body.override_block = true;
        }
        else body.new_customer = newCustomer;
        if (email) body.contact_email = email;
      }
      const order = await api<OrderResult>("/api/desk/orders", {
        method: "POST", body: JSON.stringify(body),
      });
      toastSuccess(`Auftrag ${order.no} angelegt (${fmtEur(order.gross)} brutto).`);
      setResult(order);
    } catch (e: any) {
      toastError(e.message);
    } finally {
      setBusy(false);
    }
  };

  // ---------- Rechnung senden ----------
  // Die Erfassung legt die Rechnung an, verschickt sie aber nicht (desk.py,
  // send=False). Bis 2026-10 stand hier trotzdem „versendet … unterwegs“.
  const [invoiceSent, setInvoiceSent] = useState(false);
  const resendInvoice = async () => {
    if (!result) return;
    setInvoiceBusy(true);
    try {
      const r = await api<{ sent: boolean; send_error?: string }>(
        `/api/invoicing/orders/${result.no}/invoice/send`, { method: "POST" });
      if (r.sent) { setInvoiceSent(true); toastSuccess(`Rechnung an ${email} versendet.`); }
      else toastError(r.send_error || "Versand fehlgeschlagen — Zahllink in der Buchhaltung.");
    } catch (e: any) {
      toastError(e.message);
    } finally {
      setInvoiceBusy(false);
    }
  };

  const sendInvoice = async () => {
    if (!result) return;
    setInvoiceBusy(true);
    try {
      const inv = await api<{ invoice_id: string; sent: boolean }>(
        `/api/invoicing/orders/${result.no}/invoice`, {
          method: "POST",
          body: JSON.stringify({ send: true, due_days: 14 }),
        });
      toastSuccess(inv.sent
        ? `Rechnung ${inv.invoice_id} an ${email} versendet.`
        : `Rechnung ${inv.invoice_id} als Entwurf erstellt.`);
      setInvoiceSent(inv.sent);
      setResult({ ...result, invoice_no: inv.invoice_id });
    } catch (e: any) {
      toastError(e.message);
    } finally {
      setInvoiceBusy(false);
    }
  };

  const resetAll = () => {
    setInvoiceSent(false);
    setActiveStep(1);
    setResult(null);
    setKind("external");
    setInternalOwner(getUser()?.name ?? "");
    setLines([]);
    setQuoteState(null);
    clearCustomer();
    setAiWarnings([]);
    setLastUpload("");
    setShip({ company: "", contact: "", street: "", zip: "", city: "", country: "DE" });
    setBillMode("ship");
    setBillSavedId(null);
    setEmail("");
    setManualShip(false);
    setManualShipment({ carrier: "", tracking: "", price: 0, note: "" });
  };

  // Eine freie Position ohne Bezeichnung ist keine Position. Im Kundenauftrag
  // braucht sie zusätzlich einen Preis — sonst stünde „0,00 €" auf der Rechnung.
  // Ein interner Auftrag wird nicht berechnet und darf ohne Preis bleiben.
  const customsComplete = lines.every((l) =>
    !isCustom(l) || (l.label.trim() && (kind === "internal" || l.price_gross > 0)));

  const customerComplete = kind === "internal"
    ? internalOwner.trim().length > 0
    : mode === "new"
      ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newCustomer.email.trim())
      // Gesperrter Kunde: Schritt 1 ist erst mit dem (Admin-)Übergehen fertig.
      : selected !== null && (!selected.order_block || overrideBlock);
  const linesComplete = lines.length > 0 && customsComplete && lines.every((l) =>
    Number.isInteger(l.q) && l.q > 0
    && (isCustom(l) ? Number.isFinite(l.price_gross) : Boolean(l.mat) && Number.isFinite(l.thk) && l.thk > 0));
  const shippingComplete = kind === "internal" || (
    Boolean(ship.street.trim() && ship.city.trim())
    && (billMode !== "saved" || addresses.some((a) => a.id === billSavedId))
    && (!manualShip || (Number.isFinite(manualShipment.price) && manualShipment.price >= 0)));
  const canCreate = customerComplete && linesComplete && shippingComplete && Boolean(quote) && !aiBusy;
  const customerSummary = kind === "internal"
    ? `Verantwortlich: ${internalOwner.trim() || "Mitarbeiter fehlt"}`
    : selected
      ? [selected.company || selected.name || selected.email, selected.customer_no].filter(Boolean).join(" · ")
      : mode === "new" ? `Neuer Kunde: ${newCustomer.company || newCustomer.email || "E-Mail fehlt"}`
      : "Kunden suchen oder neu anlegen";
  const linesSummary = lines.length
    ? `${plural(lines.length, "Position", "Positionen")} · ${lines.reduce((sum, l) => sum + l.q, 0)} Stück`
    : "Noch keine Positionen";
  const shippingSummary = kind === "internal"
    ? `Intern · ${cert}${rush ? " · Eilauftrag" : ""}`
    : [ship.street, [ship.zip, ship.city].filter(Boolean).join(" "),
      paymentMode === "invoice" ? "Rechnung per E-Mail" : "Offenrechnung"].filter(Boolean).join(" · ");
  const billing = billAddress();

  const goToStep = (step: number) => {
    setActiveStep(step);
    stepHeaders.current[step]?.focus();
  };
  const changeKind = (next: "external" | "internal") => {
    setKind(next);
    setActiveStep(1);
    // Ein interner Auftrag wird nicht versendet; alte Versandangaben dürfen
    // beim Zurückschalten nicht als Vorgabe weiterleben.
    if (next === "internal") setManualShip(false);
  };
  const stepHeader = (step: number, title: string, summary: string, complete: boolean) => (
    <h2 className="desk-step-heading">
      <button type="button" className="desk-step-toggle" id={`desk-step-${step}`}
              ref={(node) => { stepHeaders.current[step] = node; }}
              aria-expanded={activeStep === step} aria-controls={`desk-panel-${step}`}
              onClick={() => setActiveStep(activeStep === step ? null : step)}>
        <span className="desk-step-number">{step}</span>
        <span className="desk-step-copy">
          <span className="desk-step-title">{title}</span>
          <span className="desk-step-summary">{summary}</span>
        </span>
        <Tag minimal intent={complete ? "success" : "none"}>
          {complete ? (step === 4 ? "Bereit" : "Vollständig") : "Offen"}
        </Tag>
        <span aria-hidden="true">{activeStep === step ? "-" : "+"}</span>
      </button>
    </h2>
  );

  return (
    <PageFrame className="order-desk" title="Auftragserfassung"
               sub="Auftrag schrittweise erfassen und am Ende prüfen."
               help={[{ title: "Erfassung", text: "Alle Schritte lassen sich jederzeit wieder öffnen; Eingaben bleiben erhalten. Erst „Auftrag anlegen“ im letzten Schritt speichert den Auftrag." }]}>
      <Toolbar>
        <RadioGroup inline label="Auftragsart" selectedValue={kind}
                    onChange={(e) => changeKind(e.currentTarget.value as "external" | "internal")}>
          <Radio value="external" label="Extern — Kunde, Lieferung und Rechnung" />
          <Radio value="internal" label="Intern — ohne Kunde und Zahlung, mit verantwortlichem Mitarbeiter" />
        </RadioGroup>
      </Toolbar>
      <div className="desk-quote-status" role="status" aria-live="polite" aria-atomic="true">
        {quoteLoading && <Callout icon="time">Preis wird neu berechnet. Bitte vor dem Anlegen abwarten.</Callout>}
        {quoteError && <Callout intent="danger" icon="error" title="Preisberechnung fehlgeschlagen">
          <p>{quoteError}</p>
          <Button icon="refresh" onClick={() => { setQuoteState(null); setQuoteRetry((n) => n + 1); }}>
            Erneut berechnen
          </Button>
        </Callout>}
      </div>

      <div className="desk-split">
      <div className="desk-split-main">
      {/* ---------- Schritt 1: Kunde ---------- */}
      <section className="desk-step">
      {stepHeader(1, kind === "internal" ? "Verantwortlicher" : "Kunde", customerSummary, customerComplete)}
      <div id="desk-panel-1" className="desk-step-body" role="region" aria-labelledby="desk-step-1" hidden={activeStep !== 1}>

      {kind === "internal" ? (
        <div className="desk-panel" style={{ maxWidth: 720 }}>
          <div className="ui-inline-actions" style={{ alignItems: "flex-start", gap: 8 }}>
            <FormGroup label="Verantwortlicher Mitarbeiter (Pflicht)" labelFor="desk-internal-owner">
              <InputGroup id="desk-internal-owner" autoFocus value={internalOwner}
                          placeholder="Name des Mitarbeiters"
                          onChange={(e) => setInternalOwner(e.target.value)} />
            </FormGroup>
            <InfoHint label="Hinweis zum internen Auftrag" title="Interner Auftrag" text="Steht auf Laufkarte und in der Fertigung. Interne Aufträge werden nicht berechnet: keine Lieferanschrift, keine Rechnung, kein Zahlungseingang. Freigegeben werden sie sofort." />
          </div>
        </div>
      ) : selected ? (
        <div className="desk-panel" style={{ maxWidth: 560 }}>
          <b>{selected.company || selected.name || selected.email}</b>
          <div>{selected.email}</div>
          <div>
            Preisgruppe {selected.price_group}
            {selected.discount_pct ? ` · ${selected.discount_pct} % Rabatt` : ""}
            {selected.customer_no ? ` · Kd-Nr. ${selected.customer_no}` : ""}
            {` · ${selected.payment_terms}`}
          </div>
          <div className="sub">
            {plural(selected.n_orders, "Auftrag", "Aufträge")}
            {selected.open_net ? ` · offen netto ${fmtEur(selected.open_net)}` : ""}
            {selected.credit_limit ? ` · Kreditrahmen ${fmtEur(selected.credit_limit)}` : ""}
            {selected.credit_pct != null ? ` (${selected.credit_pct} % belegt)` : ""}
          </div>
          {selected.order_block && (
            <Callout intent="warning" icon="disable" title="Auftragssperre">
              <b>Grund: {selected.order_block_reason || "nicht angegeben"}.</b> Für diesen Kunden wird kein neuer Auftrag angenommen,
              bis die Sperre in der Kundenkarte aufgehoben ist.
              {canAdminWork(getUser()) && (
                <Checkbox checked={overrideBlock} style={{ marginTop: 8, marginBottom: 0 }}
                          label="Sperre für diesen einen Auftrag übergehen (wird protokolliert)"
                          onChange={(e) => setOverrideBlock(e.currentTarget.checked)} />
              )}
            </Callout>
          )}
          {!selected.order_block && selected.credit_pct != null && selected.credit_pct >= 100 && (
            <Callout intent="warning" icon="warning-sign">
              Der Kreditrahmen ist ausgeschöpft. Ein Auftrag auf Rechnung wartet auf die Freigabe von Hand.
            </Callout>
          )}
          <Button small minimal icon="exchange" text="anderer Kunde"
                  style={{ marginTop: 6 }} onClick={clearCustomer} />
        </div>
      ) : mode === "new" ? (
        <div className="desk-panel" style={{ maxWidth: 720 }}>
          <div className="toolbar" style={{ marginBottom: 8 }}>
            <b>Neuer Kunde</b>
            <span style={{ flex: 1 }} />
            <Button small minimal icon="arrow-left" text="zurück zur Suche"
                    onClick={() => setMode("existing")} />
          </div>
          <div className="desk-form-grid">
            <FormGroup label="E-Mail (Pflicht)" labelFor="desk-customer-email">
              <InputGroup id="desk-customer-email" type="email" value={newCustomer.email}
                          onChange={(e) => setNewCustomer({ ...newCustomer, email: e.target.value })} />
            </FormGroup>
            <FormGroup label="Firma">
              <InputGroup aria-label="Firma" value={newCustomer.company}
                          onChange={(e) => setNewCustomer({ ...newCustomer, company: e.target.value })} />
            </FormGroup>
            <FormGroup label="Ansprechpartner">
              <InputGroup aria-label="Ansprechpartner" value={newCustomer.name}
                          onChange={(e) => setNewCustomer({ ...newCustomer, name: e.target.value })} />
            </FormGroup>
            <FormGroup label="Zahlungsziel">
              <InputGroup aria-label="Zahlungsziel" value={newCustomer.payment_terms}
                          onChange={(e) => setNewCustomer({ ...newCustomer, payment_terms: e.target.value })} />
            </FormGroup>
            <FormGroup label="Preisgruppe">
              <InputGroup aria-label="Preisgruppe" value={newCustomer.price_group}
                          onChange={(e) => setNewCustomer({ ...newCustomer, price_group: e.target.value })} />
            </FormGroup>
            <FormGroup label="Rabatt %">
              <InputGroup aria-label="Rabatt %" type="number" value={String(newCustomer.discount_pct)}
                          onChange={(e) => setNewCustomer({ ...newCustomer, discount_pct: Number(e.target.value) })} />
            </FormGroup>
            <FormGroup label="Kreditrahmen € (0 = unbegrenzt)">
              <InputGroup aria-label="Kreditrahmen € (0 = unbegrenzt)" type="number" value={String(newCustomer.credit_limit)}
                          onChange={(e) => setNewCustomer({ ...newCustomer, credit_limit: Number(e.target.value) })} />
            </FormGroup>
            <FormGroup label="USt-IdNr.">
              <InputGroup aria-label="USt-IdNr." value={newCustomer.vat_id}
                          onChange={(e) => setNewCustomer({ ...newCustomer, vat_id: e.target.value })} />
            </FormGroup>
          </div>
        </div>
      ) : (
        <div className="desk-picker">
          <InputGroup leftIcon="search" autoFocus aria-label="Kunde suchen" aria-controls="desk-customer-list"
                      placeholder="Kunde suchen — Firma, Name, E-Mail oder Kd-Nr. …"
                      value={customerQuery} onKeyDown={onCustomerKey}
                      onChange={(e) => setCustomerQuery(e.target.value)}
                      rightElement={customerQuery
                        ? <Button aria-label="Kundensuche leeren" minimal icon="cross" onClick={() => setCustomerQuery("")} />
                        : undefined} />
          {/* Eine Auswahlliste, kein Menü: role="listbox" mit Optionen. Die
              Zusatzzeile steht im Text — als Kind würde MenuItem sie zu einem
              Untermenü machen, das beim Überfahren aufklappt. */}
          <Menu className="desk-picker-list" role="listbox" id="desk-customer-list" aria-label="Kunden">
            {matches.map((c, i) => (
              <MenuItem key={c.id} active={i === highlight} selected={false} roleStructure="listoption"
                        icon="person" onClick={() => selectCustomer(c)}
                        onMouseEnter={() => setHighlight(i)}
                        text={<>
                          {c.company || c.name || c.email}
                          <span className="sub desk-picker-sub">
                            {c.email}
                            {c.customer_no ? ` · Kd-Nr. ${c.customer_no}` : ""}
                            {c.n_orders ? ` · ${plural(c.n_orders, "Auftrag", "Aufträge")}` : ""}
                          </span>
                        </>}
                        label={c.payment_terms} />
            ))}
            {matches.length === 0 && (
              <MenuItem disabled roleStructure="listoption"
                        text={customerQuery ? "Kein Kunde passt dazu." : "Noch keine Kunden erfasst."} />
            )}
            <MenuItem icon="add" intent="primary" roleStructure="listoption" className="desk-picker-new"
                      active={highlight === matches.length}
                      onMouseEnter={() => setHighlight(matches.length)}
                      onClick={startNewCustomer}
                      text={customerQuery.trim()
                        ? `„${customerQuery.trim()}“ als neuen Kunden anlegen`
                        : "Neuen Kunden anlegen"} />
          </Menu>
        </div>
      )}
      {!customerComplete && <p className="sub">
        {kind === "internal"
          ? "Bitte den verantwortlichen Mitarbeiter eintragen."
          : selected?.order_block
            ? "Für diesen Kunden besteht eine Auftragssperre — erst aufheben oder (als Admin) übergehen."
            : "Bitte einen Kunden wählen oder eine gültige E-Mail für den neuen Kunden eintragen."}
      </p>}
      <div className="desk-step-actions">
        <Button intent="primary" rightIcon="arrow-right" disabled={!customerComplete} onClick={() => goToStep(2)}>
          Weiter zu Positionen
        </Button>
      </div>
      </div>
      </section>

      {/* ---------- Schritt 2: Positionen ---------- */}
      <section className="desk-step">
      {stepHeader(2, "Positionen", `${linesSummary}${quote ? ` · ${fmtEur(quote.gross)} brutto` : ""}`, linesComplete)}
      <div id="desk-panel-2" className="desk-step-body" role="region" aria-labelledby="desk-step-2" hidden={activeStep !== 2}>
      <div style={{ display: "flex", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
        {has("library") && <Button icon="folder-open" onClick={() => setShowLibrary(true)}
                disabled={!materials.length}>Aus Formen-Bibliothek</Button>}
        <Button icon="import" onClick={() => dxfInput.current?.click()}
                disabled={!materials.length}>DXF hochladen</Button>
        {has("ai_quote") && <Button icon="flash" onClick={() => pdfInput.current?.click()}
                loading={aiBusy} disabled={!materials.length}>
          PDF / Zeichnung mit KI auswerten
        </Button>}
        <Button icon="add" onClick={() => setLines((ls) => [...ls, emptyLine(defaultMat())])}
                disabled={!materials.length}>
          Ring von Hand
        </Button>
        <Button icon="manually-entered-data" onClick={() => setLines((ls) => [...ls, customLine()])}>
          Freie Position
        </Button>
        <input ref={dxfInput} type="file" accept=".dxf,.txt" style={{ display: "none" }}
               onChange={(e) => { const f = e.target.files?.[0]; if (f) onDxf(f); e.target.value = ""; }} />
        <input ref={pdfInput} type="file" accept=".pdf,.dxf" style={{ display: "none" }}
               onChange={(e) => { const f = e.target.files?.[0]; if (f) onPdf(f); e.target.value = ""; }} />
      </div>

      {lastUpload && <p style={{ color: "var(--g-muted)", marginBottom: 8 }}>{lastUpload}</p>}
      {aiWarnings.length > 0 && (
        <Callout intent="warning" icon="warning-sign" title="Hinweise der KI-Analyse" style={{ marginBottom: 10 }}>
          <ul style={{ margin: "4px 0 0 16px" }}>
            {aiWarnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </Callout>
      )}

      {lines.length === 0 ? (
        <div className="ui-inline-actions">
          <span className="sub">Noch keine Positionen.</span>
          <InfoHint label="Hinweis zu Positionen" title="Positionen" text="Eine Form aus der Bibliothek übernehmen, DXF hochladen, eine PDF-Zeichnung auswerten lassen, einen Ring von Hand erfassen — oder eine freie Position für Sonderfertigung und Zukauf." />
        </div>
      ) : (
        <div className="table-scroll desk-line-table" role="region" aria-label="Positionen, horizontal scrollbar" tabIndex={0}>
        <HTMLTable className="data-table" striped compact>
          <thead>
            <tr>
              <th>Bezeichnung</th><th>Werkstoff</th><th className="num">Dicke mm</th>
              <th className="num">Stück</th><th className="num">Außen Ø / B</th>
              <th className="num">Bohrung / H</th><th>Bohrungen (Anz. × Ø @ LK)</th><th>Quelle</th>
              <th className="num">Preis netto</th><th><span className="sr-only">Aktion</span></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const per = quote?.per?.[String(l.id)];
              const lineNet = per ? (per.mat ?? 0) + (per.cut ?? 0) : 0;
              const src = SOURCE[l.source] ?? SOURCE.hand;
              const price = (
                <td className="num">{per ? fmtEur(lineNet) : "…"}</td>
              );
              const drop = (
                <td><Button small minimal icon="cross" aria-label={`Position ${l.label || l.id} entfernen`} onClick={() => removeLine(l.id)} /></td>
              );

              if (isCustom(l)) {
                return (
                  <tr key={l.id} className="row-custom">
                    <td>
                      <InputGroup small value={l.label} placeholder="Bezeichnung"
                                  intent={l.label.trim() ? "none" : "warning"}
                                  onChange={(e) => updateLine(l.id, { label: e.target.value })} />
                    </td>
                    <td>
                      <InputGroup small value={l.desc}
                                  placeholder="Interne Beschreibung — Werkstatt/Laufkarte"
                                  title="Intern: erscheint auf Laufkarte und in der Fertigung, nicht beim Kunden"
                                  onChange={(e) => updateLine(l.id, { desc: e.target.value })} />
                    </td>
                    <td>
                      <InputGroup small value={l.external_note}
                                  placeholder="Kundenhinweis — erscheint auf Beleg & Rechnung"
                                  title="Extern: erscheint auf Rechnung/Beleg und im Kundenportal"
                                  onChange={(e) => updateLine(l.id, { external_note: e.target.value })} />
                    </td>
                    <td className="num">
                      <input className="bp5-input" type="number" min="1" max="999"
                             style={{ width: 56 }} value={l.q}
                             onChange={(e) => updateLine(l.id, { q: Number(e.target.value) })} />
                    </td>
                    <td className="num" colSpan={3}>
                      <span className="sub" style={{ marginRight: 6 }}>brutto je Stück</span>
                      <input className="bp5-input" type="number" min="0" step="0.01"
                             style={{ width: 100 }} value={l.price_gross}
                             title="Bruttopreis je Stück"
                             onChange={(e) => updateLine(l.id, { price_gross: Number(e.target.value) })} />
                      <span className="sub" style={{ marginLeft: 4 }}>€</span>
                    </td>
                    <td><Tag minimal intent={src.intent}>{src.label}</Tag></td>
                    {price}
                    {drop}
                  </tr>
                );
              }

              return (
                <tr key={l.id}>
                  <td><InputGroup small value={l.label}
                                  onChange={(e) => updateLine(l.id, { label: e.target.value })} /></td>
                  <td style={{ minWidth: 190 }}>
                    <MaterialSelect fill small value={l.mat}
                                    onChange={(id) => updateLine(l.id, { mat: id })} />
                  </td>
                  <td className="num">
                    <input className="bp5-input" type="number" step="0.5" min="0.2"
                           style={{ width: 64 }} value={l.thk}
                           onChange={(e) => updateLine(l.id, { thk: Number(e.target.value) })} />
                  </td>
                  <td className="num">
                    <input className="bp5-input" type="number" min="1" max="999"
                           style={{ width: 56 }} value={l.q}
                           onChange={(e) => updateLine(l.id, { q: Number(e.target.value) })} />
                  </td>
                  <td className="num">
                    <input className="bp5-input" type="number" style={{ width: 80 }} value={l.od}
                           onChange={(e) => updateLine(l.id, { od: Number(e.target.value) })} />
                  </td>
                  <td className="num">
                    <input className="bp5-input" type="number" style={{ width: 80 }} value={l.di}
                           onChange={(e) => updateLine(l.id, { di: Number(e.target.value) })} />
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <input className="bp5-input" type="number" min="0" max="200" step="1"
                           style={{ width: 46 }} value={l.bn}
                           title="Anzahl Bohrungen" aria-label="Anzahl Bohrungen" placeholder="Anz."
                           onChange={(e) => updateLineBolts(l, { bn: Number(e.target.value) })} />
                    <span className="sub" style={{ margin: "0 4px" }}>× Ø</span>
                    <input className="bp5-input" type="number" min="0" step="0.5"
                           style={{ width: 54 }} value={l.bd}
                           title="Bohrungs-Ø (mm)" aria-label="Bohrungs-Ø (mm)" placeholder="Ø"
                           onChange={(e) => updateLineBolts(l, { bd: Number(e.target.value) })} />
                    <span className="sub" style={{ margin: "0 4px" }}>@ LK</span>
                    <input className="bp5-input" type="number" min="0" step="1"
                           style={{ width: 60 }} value={l.bc}
                           title="Lochkreis-Ø (mm)" aria-label="Lochkreis-Ø (mm)" placeholder="LK"
                           onChange={(e) => updateLineBolts(l, { bc: Number(e.target.value) })} />
                  </td>
                  <td><Tag minimal intent={src.intent}>{src.label}</Tag></td>
                  {price}
                  {drop}
                </tr>
              );
            })}
          </tbody>
        </HTMLTable>
        </div>
      )}

      {lines.some(isCustom) && !customsComplete && (
        <Callout intent="warning" icon="warning-sign" style={{ marginTop: 10, maxWidth: 560 }}>
          Jede freie Position braucht eine Bezeichnung
          {kind === "external" ? " und einen Bruttopreis größer als null" : ""}.
        </Callout>
      )}
      {lines.length > 0 && !linesComplete && <p className="sub">
        Bitte je Position eine positive ganze Stückzahl, bei Dichtungen Werkstoff und positive Dicke prüfen.
      </p>}

      {quote && (
        <div className="sub" style={{ marginTop: 12, maxWidth: 480 }}>
          <b>Preis (live gerechnet):</b><br />
          Material {fmtEur(quote.mat_c)} · Zuschnitt {fmtEur(quote.cut_c)} ·
          Rüsten {fmtEur(quote.setup)}
          {quote.custom_c ? ` · freie Positionen ${fmtEur(quote.custom_c)}` : ""}
          {quote.cert ? ` · Zeugnis ${fmtEur(quote.cert)}` : ""}
          {quote.freight ? ` · Versand ${fmtEur(quote.freight)}` : ""}<br />
          <b>Netto {fmtEur(quote.total)}</b> · USt {fmtEur(quote.vat)} ·{" "}
          <b>Brutto {fmtEur(quote.gross)}</b>
        </div>
      )}

      <div className="desk-step-actions">
        <Button icon="arrow-left" onClick={() => goToStep(1)}>
          {kind === "internal" ? "Zurück zum Verantwortlichen" : "Zurück zu Kunde"}
        </Button>
        <Button intent="primary" rightIcon="arrow-right" disabled={!linesComplete || aiBusy} onClick={() => goToStep(3)}>
          {kind === "internal" ? "Weiter zu Fertigung" : "Weiter zu Lieferanschrift & Rechnung"}
        </Button>
      </div>
      </div>
      </section>

      {/* ---------- Schritt 3: Versand und Rechnung ---------- */}
      <section className="desk-step">
      {stepHeader(3, kind === "internal" ? "Fertigung" : "Lieferanschrift & Rechnung", shippingSummary, shippingComplete)}
      <div id="desk-panel-3" className="desk-step-body" role="region" aria-labelledby="desk-step-3" hidden={activeStep !== 3}>
      <div className="desk-panel" style={{ maxWidth: 720 }}>
        {kind === "internal" && (
          <p className="sub" style={{ marginBottom: 12 }}>
            <b>Interner Auftrag</b> — kein Kunde, keine Lieferanschrift, keine Zahlung und keine Rechnung.
            Verantwortlich: <b>{internalOwner.trim() || "noch nicht eingetragen"}</b>.
          </p>
        )}
        {kind === "external" && (<>
        {selected && addresses.length > 0 && (
          <FormGroup label="Lieferanschrift">
            <HTMLSelect aria-label="Lieferanschrift" fill
                        value={shipSource === "saved" && shipSavedId ? String(shipSavedId) : shipSource}
                        onChange={(e) => {
                          const v = e.currentTarget.value;
                          if (v === "temp") {
                            setShipSource("temp"); setShipSavedId(null); setSaveNewAddress(false);
                          } else if (v === "new") {
                            setShipSource("new"); setShipSavedId(null); setShip({ company: selected.company || "", contact: selected.name || "", street: "", zip: "", city: "", country: "DE" }); setSaveNewAddress(true);
                          } else {
                            const a = addresses.find((x) => String(x.id) === v);
                            if (a) applyAddress(a);
                          }
                        }}>
              <option value="temp">Temporäre Anschrift (nicht speichern)</option>
              {addresses.map((a) => (
                <option key={a.id} value={String(a.id)}>
                  {[a.label || a.company, a.street, `${a.zip} ${a.city}`.trim()]
                    .filter(Boolean).join(" · ")}
                  {a.is_billing ? " (Rechnung)" : ""}
                  {a.is_delivery ? " (Lieferung)" : ""}
                </option>
              ))}
              <option value="new">+ Neue Anschrift …</option>
            </HTMLSelect>
          </FormGroup>
        )}
        {selected && addresses.length > 0 && (
          <>
            <FormGroup label="Rechnungsanschrift">
              <HTMLSelect aria-label="Rechnungsanschrift" fill
                          value={billMode === "saved" && billSavedId ? String(billSavedId) : "ship"}
                          onChange={(e) => {
                            const v = e.currentTarget.value;
                            if (v === "ship") {
                              setBillMode("ship"); setBillSavedId(null);
                            } else {
                              setBillMode("saved"); setBillSavedId(Number(v));
                            }
                          }}>
                <option value="ship">Wie Lieferanschrift</option>
                {addresses.map((a) => (
                  <option key={a.id} value={String(a.id)}>
                    {[a.label || a.company, a.street, `${a.zip} ${a.city}`.trim()]
                      .filter(Boolean).join(" · ")}
                    {a.is_billing ? " (Rechnung)" : ""}
                  </option>
                ))}
              </HTMLSelect>
            </FormGroup>
            {billMode === "saved" && (() => {
              const a = addresses.find((x) => x.id === billSavedId);
              return a ? (
                <div className="sub" style={{ margin: "-4px 0 10px" }}>
                  {[a.company, a.contact, a.street, [a.zip, a.city].filter(Boolean).join(" "), a.country]
                    .filter(Boolean).join(" · ")}
                  {a.vat_id ? ` · USt: ${a.vat_id}` : ""}
                </div>
              ) : null;
            })()}
          </>
        )}
        {selected && (shipSource === "temp" || shipSource === "new" || (shipSource === "saved" && shipSavedId)) && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
            <Checkbox
              checked={saveNewAddress}
              label="Anschrift im Kundenstamm speichern"
              onChange={(e) => setSaveNewAddress((e.target as HTMLInputElement).checked)}
            />
            {saveNewAddress && (
              <InputGroup small placeholder="Bezeichnung z. B. Werk 2" value={saveLabel} onChange={(e) => setSaveLabel(e.target.value)} style={{ width: 200 }} />
            )}
            {shipSource === "saved" && <Tag minimal intent="primary">aus Stamm</Tag>}
            {shipSource === "temp" && <Tag minimal>temporär</Tag>}
            {shipSource === "new" && <Tag minimal intent="success">neu</Tag>}
          </div>
        )}
        <div className="desk-form-grid">
          <FormGroup label="Firma">
            <InputGroup aria-label="Firma" value={ship.company} onChange={(e) => setShip({ ...ship, company: e.target.value })} />
          </FormGroup>
          <FormGroup label="Ansprechpartner">
            <InputGroup aria-label="Ansprechpartner" value={ship.contact} onChange={(e) => setShip({ ...ship, contact: e.target.value })} />
          </FormGroup>
          <FormGroup label="Straße & Nr. (Pflicht)" labelFor="desk-ship-street">
            <InputGroup id="desk-ship-street" value={ship.street} onChange={(e) => setShip({ ...ship, street: e.target.value })} />
          </FormGroup>
          <div className="desk-postal-grid">
            <FormGroup label="PLZ">
              <InputGroup aria-label="PLZ" value={ship.zip} onChange={(e) => setShip({ ...ship, zip: e.target.value })} />
            </FormGroup>
            <FormGroup label="Ort (Pflicht)" labelFor="desk-ship-city">
              <InputGroup id="desk-ship-city" value={ship.city} onChange={(e) => setShip({ ...ship, city: e.target.value })} />
            </FormGroup>
          </div>
          <FormGroup label="Rechnung geht an (E-Mail)">
            <InputGroup aria-label="Rechnung geht an (E-Mail)" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </FormGroup>
          <FormGroup label="Bestellreferenz des Kunden">
            <InputGroup aria-label="Bestellreferenz des Kunden" value={customerRef} onChange={(e) => setCustomerRef(e.target.value)} />
          </FormGroup>
        </div>
        </>)}

        <FormGroup label="Zeugnis">
          <HTMLSelect aria-label="Zeugnis" value={cert} onChange={(e) => setCert(e.currentTarget.value)}>
            <option value="2.2">Werkszeugnis 2.2 (kostenlos)</option>
            <option value="3.1">Abnahmeprüfzeugnis 3.1 (+ 45 €)</option>
          </HTMLSelect>
        </FormGroup>

        <Checkbox checked={rush} onChange={(e) => setRush(e.currentTarget.checked)}
                  label="Eilauftrag (Fertigung am nächsten Werktag)" />

        {scopeMatters(sites.topo) && (
          <div className="form-grid form-grid-2">
            <FormGroup label="Fertigen in" labelFor="desk-scope"
              helperText="Der Sammellauf legt nur Aufträge mit derselben Vorgabe auf eine Platte.">
              <HTMLSelect id="desk-scope" fill value={routeScope} onChange={(e) => setRouteScope(e.currentTarget.value)}
                options={scopeOptions(sites.topo)} />
            </FormGroup>
            {(sites.topo?.sites.length ?? 0) > 1 && (
              <FormGroup label="Eingegangen in" labelFor="desk-site">
                <HTMLSelect id="desk-site" fill value={siteId ?? ""} onChange={(e) => setSiteId(Number(e.currentTarget.value) || null)}
                  options={[{ value: "", label: "Erster Standort" }, ...(sites.topo?.sites ?? []).map((x) => ({ value: x.id, label: x.name }))]} />
              </FormGroup>
            )}
          </div>
        )}

        {kind === "external" && (<>
        <RadioGroup label="Zahlungsweg" selectedValue={paymentMode}
                    onChange={(e) => setPaymentMode(e.currentTarget.value)}>
          <Radio value="invoice" label="Rechnung per E-Mail (Stripe — Kunde zahlt per Karte oder Überweisung)" />
          <Radio value="account" label="Offenrechnung / auf Rechnung (Freigabe ab Auftrag)" />
        </RadioGroup>

        {!invoiceConfigured && paymentMode === "invoice" && (
          <Callout intent="warning" icon="warning-sign">
            Stripe-Rechnungen sind noch nicht eingerichtet (STRIPE_SECRET_KEY fehlt im Backend).
            Der Auftrag kann angelegt werden, die Rechnung muss dann über das Stripe-Dashboard laufen.
          </Callout>
        )}

        <Checkbox checked={manualShip}
                  onChange={(e) => setManualShip(e.currentTarget.checked)}
                  label="Manueller Versand — Spedition, Sendungsnummer und Versandkosten jetzt erfassen" />
        {manualShip && (
          <div className="desk-panel" style={{ margin: "8px 0 12px" }}>
            <div className="ui-inline-actions" style={{ marginBottom: 8 }}>
              <span className="sub">Gilt als Vorgabe für den Versand.</span>
              <InfoHint label="Hinweis zum manuellen Versand" title="Manueller Versand" text="Der Versand bekommt diese Angaben später als Vorgabe vorausgefüllt — dort editierbar, nicht noch einmal zu erfragen." />
            </div>
            <div className="desk-form-grid">
              <FormGroup label="Spedition">
                <InputGroup aria-label="Spedition" value={manualShipment.carrier} placeholder="z. B. UPS, DHL, Abholung"
                            onChange={(e) => setManualShipment({ ...manualShipment, carrier: e.target.value })} />
              </FormGroup>
              <FormGroup label="Sendungsnummer / Tracking">
                <InputGroup aria-label="Sendungsnummer / Tracking" value={manualShipment.tracking} placeholder="z. B. 1Z…"
                            onChange={(e) => setManualShipment({ ...manualShipment, tracking: e.target.value })} />
              </FormGroup>
              <FormGroup label="Versandkosten €">
                <InputGroup aria-label="Versandkosten €" type="number" min="0" step="0.01" value={String(manualShipment.price)}
                            onChange={(e) => setManualShipment({ ...manualShipment, price: Number(e.target.value) })} />
              </FormGroup>
              <FormGroup label="Notiz (optional)">
                <InputGroup aria-label="Notiz (optional)" value={manualShipment.note}
                            onChange={(e) => setManualShipment({ ...manualShipment, note: e.target.value })} />
              </FormGroup>
            </div>
          </div>
        )}
        </>)}

      </div>
      {!shippingComplete && <p className="sub">
        Bitte Straße und Ort, die gewählte Rechnungsanschrift sowie nicht negative manuelle Versandkosten prüfen.
      </p>}
      <div className="desk-step-actions">
        <Button icon="arrow-left" onClick={() => goToStep(2)}>Zurück zu Positionen</Button>
        <Button intent="primary" rightIcon="arrow-right" disabled={!shippingComplete} onClick={() => goToStep(4)}>
          Weiter zur Prüfung
        </Button>
      </div>
      </div>
      </section>

      <section className="desk-step">
      {stepHeader(4, "Prüfen & Auftrag anlegen", canCreate
        ? `${linesSummary} · ${fmtEur(quote?.gross)} brutto`
        : "Angaben und aktuellen Preis vor dem Anlegen prüfen", canCreate)}
      <div id="desk-panel-4" className="desk-step-body" role="region" aria-labelledby="desk-step-4" hidden={activeStep !== 4}>
        <dl className="desk-review">
          <dt>Auftragsart</dt><dd>{kind === "internal"
            ? "Intern — ohne Kunde, Zahlung und Rechnung"
            : "Extern — Kunde, Lieferung und Rechnung"}</dd>
          <dt>{kind === "internal" ? "Verantwortlich" : "Kunde"}</dt><dd>{customerSummary}</dd>
          <dt>Positionen</dt><dd>{linesSummary}
            <ul>{lines.map((l) => <li key={l.id}>
              {l.q} × {l.label || "Ohne Bezeichnung"}
              {isCustom(l) ? ` · ${fmtEur(l.price_gross)} brutto / Stück` : ` · ${l.mat}, ${l.thk} mm`}
              {l.external_note && ` · ${l.external_note}`}
            </li>)}</ul>
          </dd>
          {kind === "external" && <>
            <dt>Lieferanschrift</dt><dd>{[ship.company, ship.contact, ship.street, `${ship.zip} ${ship.city}`.trim(), ship.country].filter(Boolean).join(" · ")}</dd>
            <dt>Rechnungsanschrift</dt><dd>{[billing.company, billing.contact, billing.dept, billing.street, `${billing.zip} ${billing.city}`.trim(), billing.country, billing.vat_id].filter(Boolean).join(" · ")}</dd>
            <dt>Rechnung an</dt><dd>{email || (mode === "new" ? newCustomer.email : selected?.email) || "Keine E-Mail hinterlegt"}</dd>
            <dt>Zahlungsweg</dt><dd>{paymentMode === "invoice" ? "Rechnung per E-Mail (Stripe)" : "Offenrechnung / auf Rechnung"}</dd>
            <dt>Bestellreferenz</dt><dd>{customerRef || "Keine"}</dd>
          </>}
          <dt>Zeugnis / Fertigung</dt><dd>{cert} · {rush ? "Eilauftrag" : "Regulär"}</dd>
          {kind === "external" && <>
            <dt>Versand</dt><dd>{manualShip
              ? ["Manuell", manualShipment.carrier, manualShipment.tracking, fmtEur(manualShipment.price), manualShipment.note].filter(Boolean).join(" · ")
              : "Standardversand"}</dd>
            {saveNewAddress && selected && <><dt>Adressbuch</dt><dd>Lieferanschrift zusätzlich speichern{saveLabel ? `: ${saveLabel}` : ""}</dd></>}
          </>}
        </dl>
        {quote && <div className="sub" style={{ marginTop: 12 }}>
          <b>Aktueller Gesamtpreis</b><br />
          Material {fmtEur(quote.mat_c)} · Zuschnitt {fmtEur(quote.cut_c)} · Rüsten {fmtEur(quote.setup)}
          {quote.custom_c ? ` · freie Positionen ${fmtEur(quote.custom_c)}` : ""}
          {` · Zeugnis ${fmtEur(quote.cert)}`}
          {kind === "external" ? ` · Versand ${fmtEur(quote.freight)}` : ""}<br />
          Netto {fmtEur(quote.total)} · USt {fmtEur(quote.vat)} · <b>Brutto {fmtEur(quote.gross)}</b>
        </div>}
        {!canCreate && <Callout intent="warning" icon="warning-sign" title="Noch nicht bereit" className="section-gap">
          <ul>
            {!customerComplete && <li>Schritt 1: {kind === "internal"
              ? "verantwortlichen Mitarbeiter eintragen."
              : selected?.order_block ? "Auftragssperre des Kunden aufheben oder übergehen."
              : "Kunde wählen oder gültige E-Mail eintragen."}</li>}
            {!linesComplete && <li>Schritt 2: Positionen vervollständigen.</li>}
            {!shippingComplete && <li>Schritt 3: Lieferanschrift und Versandangaben vervollständigen.</li>}
            {aiBusy && <li>Die KI-Analyse ist noch nicht abgeschlossen.</li>}
            {!quote && <li>{quoteError ? "Preisberechnung fehlgeschlagen. Bitte erneut berechnen." : "Ein aktueller Preis wird benötigt."}</li>}
          </ul>
        </Callout>}
        <div className="ui-inline-actions" style={{ marginTop: 4 }}>
          <InfoHint label="Hinweis zum Anlegen" title="Auftrag anlegen" text={kind === "internal"
            ? "Erst „Auftrag anlegen“ speichert den Auftrag. Er geht ohne Rechnung und ohne Zahlung direkt in die Fertigung."
            : "Erst „Auftrag anlegen“ speichert den Auftrag. Die Rechnung kann anschließend im Ergebnisdialog versendet werden."} />
        </div>
        <div className="desk-step-actions">
          <Button icon="arrow-left" onClick={() => goToStep(3)}>
            {kind === "internal" ? "Zurück zur Fertigung" : "Zurück zu Lieferanschrift & Rechnung"}
          </Button>
          <Button intent="primary" icon="tick" large loading={busy} disabled={!canCreate || result !== null} onClick={createOrder}>
            Auftrag anlegen
          </Button>
        </div>
      </div>
      </section>
      </div>

      <aside className="desk-live-summary" aria-label="Live-Zusammenfassung">
        <div className="desk-live-head">
          <h3>Live-Zusammenfassung</h3>
          <Tag minimal intent={canCreate ? "success" : "none"}>{canCreate ? "Bereit" : "In Arbeit"}</Tag>
        </div>
        <dl className="desk-live-dl">
          <div>
            <dt>{kind === "internal" ? "Verantwortlich" : "Kunde"}</dt>
            <dd>{customerSummary}</dd>
          </div>
          <div>
            <dt>Positionen</dt>
            <dd>{linesSummary}</dd>
          </div>
          <div>
            <dt>Zeugnis &amp; Priorität</dt>
            <dd>{cert || "Kein Zeugnis (—)"} · {rush ? "Eilauftrag" : "Regulär"}</dd>
          </div>
          {kind === "external" && (
            <div>
              <dt>Lieferung &amp; Zahlung</dt>
              <dd>{shippingSummary || "Noch offen"}</dd>
            </div>
          )}
          <div className="desk-live-total">
            <dt>Brutto</dt>
            <dd className="mono">{quote ? fmtEur(quote.gross) : "—"}</dd>
          </div>
        </dl>
        {activeStep !== 4 && (
          <div className="desk-live-actions">
            <Button small fill intent={canCreate ? "primary" : "none"} icon="tick"
                    text="Zu Schritt 4: Prüfen"
                    onClick={() => goToStep(4)} />
          </div>
        )}
      </aside>
      </div>

      <ShapePicker isOpen={showLibrary} onClose={() => setShowLibrary(false)}
                   onTake={takeShape} defaultMat={defaultMat()} />

      {/* ---------- Ergebnis ---------- */}
      <Dialog isOpen={result !== null} onClose={resetAll} title="Auftrag angelegt">
        {result && (
          <div className="bp5-dialog-body">
            <p>
              Auftrag <b className="mono">{result.no}</b> über{" "}
              <b>{fmtEur(result.gross)}</b> brutto wurde angelegt.
            </p>
            <p>
              {result.released
                ? <Tag intent="success" icon="arrow-right">Fertigung freigegeben</Tag>
                : <Tag intent="warning" icon="pause">
                    {result.release_note || "Wartet auf Freigabe"}
                  </Tag>}
            </p>

            {result.kind === "internal" ? (
              <Callout intent="success" icon="briefcase" title="Interner Auftrag">
                Kein Kunde, keine Zahlung und keine Rechnung. Verantwortlich:{" "}
                <b>{result.internal_owner}</b>.{" "}
                {result.released
                  ? "Der Auftrag ist für die Fertigung freigegeben."
                  : "Er wartet noch auf die Freigabe."}
              </Callout>
            ) : paymentMode === "invoice" && (
              result.invoice_no && invoiceSent ? (
                <Callout intent="success" icon="tick-circle" title="Rechnung versendet">
                  Rechnung <span className="mono">{result.invoice_no}</span> ist an {email} unterwegs.
                  Sobald der Kunde zahlt, erscheint hier und in der Buchhaltung das grüne Häkchen
                  „Rechnung bezahlt“.
                  <InvoicePaidCheck orderNo={result.no} />
                </Callout>
              ) : result.invoice_no ? (
                <Callout intent="warning" icon="envelope" title="Rechnung erstellt, noch nicht versendet">
                  Rechnung <span className="mono">{result.invoice_no}</span> liegt bereit, ist aber
                  noch nicht beim Kunden.{" "}
                  <Button intent="primary" icon="send-message" loading={invoiceBusy}
                          disabled={!invoiceConfigured} onClick={resendInvoice}>
                    Jetzt an {email || "den Kunden"} senden
                  </Button>
                </Callout>
              ) : (
                <Callout intent="primary" icon="send-message" title="Rechnung senden">
                  <Button intent="primary" icon="send-message" loading={invoiceBusy}
                          disabled={!invoiceConfigured} onClick={sendInvoice}>
                    Rechnung jetzt per E-Mail senden (Stripe)
                  </Button>
                </Callout>
              )
            )}
          </div>
        )}
        <div className="bp5-dialog-footer">
          <div className="bp5-dialog-footer-actions">
            {result && result.released && (
              <Button icon="time" text="Zur Disposition" onClick={() => { resetAll(); navigate("disposition"); }} />
            )}
            {result && (
              <Button intent="primary" icon="inbox" text="Auftrag öffnen" onClick={() => { const no = result.no; resetAll(); navigate(`auftraege/${encodeURIComponent(no)}`); }} />
            )}
            <Button onClick={resetAll}>Schließen</Button>
          </div>
        </div>
      </Dialog>
    </PageFrame>
  );
}

// Pollt den Zahlungszustand — der grüne Haken kommt, wenn Stripe das Geld gemeldet hat.
function InvoicePaidCheck({ orderNo }: { orderNo: string }) {
  const [paid, setPaid] = useState(false);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const o = await api<{ paid: boolean }>(`/api/desk/orders/${orderNo}`);
        if (!alive) return;
        setPaid(o.paid);
      } catch { /* still */ }
    };
    tick();
    const iv = setInterval(tick, 8000);
    return () => { alive = false; clearInterval(iv); };
  }, [orderNo]);
  if (!paid) return <p style={{ color: "var(--g-muted)", marginTop: 8 }}>Warte auf Zahlungseingang …</p>;
  return (
    <p style={{ marginTop: 10 }}>
      <Tag large intent="success" icon="tick">Rechnung bezahlt</Tag>
    </p>
  );
}
