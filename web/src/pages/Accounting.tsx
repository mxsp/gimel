import SellerPanel from "../components/SellerPanel";
import { RefLink } from "../components/RefLink";
import { Button, Dialog, DialogBody, DialogFooter, HTMLSelect, HTMLTable, InputGroup, Menu, MenuDivider, MenuItem, NumericInput, Spinner } from "@blueprintjs/core";
import KeyPopover from "../ui/KeyPopover";
import NonIdealState from "../components/NonIdealState";
import Callout from "../components/Callout";
import { useCallback, useEffect, useState } from "react";
import { api, apiDownload, apiWithCount, canAdminWork, fmtDate, fmtEur, getUser } from "../api";
import { useHashRoute } from "../router";
import { paymentWays } from "../constants";
import { toastError, toastSuccess } from "../toast";
import { undoable } from "../undo";
import { plural } from "../plural";
import {
  FilterGroup, FilterPopover, FilterTag, HintDetails, KpiStrip, PageFrame, PaginationBar, SortControl, StatusChip,
  Toolbar, ViewMenu, readStore, sortRows, useHiddenColumns, useSortPref, writeStore,
} from "../ui";
import type { SortField, ViewColumn } from "../ui";

/* Buchhaltung — Rechnungen stellen, verfolgen und in der Hand behalten.

   Der Stripe-Mailversand hängt am Zustand des Kontos und bleibt regelmässig
   aus. Darauf zu warten, wäre der falsche Bau: die Rechnung *existiert* auch
   dann, mit Nummer, Zahlseite und PDF. Deshalb holt diese Seite das PDF durch
   das Portal hindurch, zeigt den Zahllink zum Weitergeben, lässt den Versand
   wiederholen — und erlaubt, den Zahlungseingang von Hand zu buchen, weil
   Überweisungen aufs Hauskonto an Stripe vorbeilaufen.

   Die Liste kommt aus der eigenen Datenbank, nicht aus Stripe: sie muss auch
   dastehen, wenn Stripe gerade nicht erreichbar ist.

   Die Kennzahlen beantworten die drei Fragen der Buchhaltung: wie viel steht
   offen, wie viel ist überfällig und in welchem Alter (Altersstruktur), und
   wie schnell zahlt der Kunde im Mittel (Ø Zahlungsdauer). Die CSV holt die
   Liste dorthin, wo sie weiterverarbeitet wird — mit deutschem Format, damit
   Excel sie ohne Importdialog öffnet. */

interface Invoice {
  order_no: string; invoice_no: string; customer: string; email: string;
  net: number; vat: number; gross: number; tax_rate: number; has_einvoice: boolean;
  invoiced_at: string | null; due_at: string | null;
  paid: boolean; paid_at: string | null;
  days_overdue: number; status: string;
  verwendungszweck: string;
  has_copy: boolean; copy_number: string;
}
interface Config {
  configured: boolean; webhook_configured: boolean; seller?: string;
  test_mode: boolean; default_due_days: number;
  /** Was die Rechnung dem Kunden anbietet — wie die Kasse des Bestellportals. */
  payment_methods: string[]; transfer_country: string;
}
interface OpenOrder {
  no: string; kind?: string; created_at: string; customer_name?: string; customer_email?: string;
  customer_ref?: string; cancelled_at?: string | null;
  gross: number; paid: boolean; invoice_no: string;
}
interface InvoiceResult {
  order_no: string; invoice_id: string; status: string; sent: boolean;
  hosted_url: string; pdf_url: string; send_error: string;
  total_cents: number; customer_email: string;
  verwendungszweck: string; payment_methods: string[];
  email_source: string; email_alternatives: Array<{ source: string; email: string }>;
}
interface BillingCheck {
  ready: boolean; errors: string[]; net: number; vat: number; gross: number; format: string;
  local?: boolean; delivery_date?: string | null;
}

const DAY = 86_400_000;

/* Die Altersstruktur der Forderungen — die fünf Buckets, wie die Buchhaltung
   sie kennt. Dieselbe Regel filtert auch die Liste, damit die Leiste und die
   Tabelle nie verschieden antworten. */
const AGING: Array<{ key: string; label: string; test: (r: Invoice) => boolean }> = [
  { key: "a1", label: "noch nicht fällig", test: (r) => r.days_overdue <= 0 },
  { key: "a2", label: "1–30 Tage", test: (r) => r.days_overdue >= 1 && r.days_overdue <= 30 },
  { key: "a3", label: "31–60 Tage", test: (r) => r.days_overdue >= 31 && r.days_overdue <= 60 },
  { key: "a4", label: "61–90 Tage", test: (r) => r.days_overdue >= 61 && r.days_overdue <= 90 },
  { key: "a5", label: "über 90 Tage", test: (r) => r.days_overdue > 90 },
];

const inBucket = (r: Invoice, key: string): boolean => {
  const b = AGING.find((x) => x.key === key);
  return b ? b.test(r) : false;
};

const FILTERS: Array<[string, string]> = [
  ["offen", "offene"],
  ["demnaechst", "fällig in 7 Tagen"],
  ["ueberfaellig", "überfällige"],
  ["a1", "noch nicht fällige"],
  ["a2", "1–30 Tage überfällig"],
  ["a3", "31–60 Tage überfällig"],
  ["a4", "61–90 Tage überfällig"],
  ["a5", "über 90 Tage überfällig"],
  ["bezahlt", "bezahlte"],
  ["ohne_xml", "ohne archivierte E-Rechnung"],
  ["alle", "alle"],
];

const INVOICE_COLUMNS_KEY = "gimel-accounting-columns";
const INVOICE_COLUMNS: ViewColumn[] = [
  { id: "verwendungszweck", label: "Verwendungszweck" },
  { id: "email", label: "Empfänger" },
  { id: "net", label: "Netto" },
  { id: "vat", label: "USt" },
  { id: "invoiced", label: "Gestellt" },
];
const INVOICE_COLUMNS_HIDDEN = INVOICE_COLUMNS.map((column) => column.id);
const INVOICE_SORT_FIELDS: SortField[] = [
  { id: "invoice_no", label: "Rechnung" },
  { id: "customer", label: "Kunde" },
  { id: "invoiced_at", label: "Gestellt" },
  { id: "due_at", label: "Fällig" },
  { id: "gross", label: "Brutto" },
  { id: "days_overdue", label: "Tage überfällig" },
];

/* Zusatzspalten starten zugeklappt; der Merker hält auch „alle Spalten an"
   fest, wenn die Auswahl leer ist und der Spalteneintrag gelöscht wird. */
function useDefaultHidden(key: string, defaults: string[]) {
  const marker = `${key}-init`;
  const { hidden, toggle, reset, setHidden } = useHiddenColumns(key);
  const [ready, setReady] = useState(() => readStore(marker) !== null);
  useEffect(() => {
    if (readStore(marker) === null) {
      writeStore(marker, "1");
      setHidden(defaults);
    }
    setReady(true);
  }, [defaults, marker, setHidden]);
  return { hidden, toggle, reset, ready };
}

export default function Accounting() {
  const route = useHashRoute();
  const wantedOrder = decodeURIComponent(route.split("/")[1] ?? "");
  const [rows, setRows] = useState<Invoice[] | null>(null);
  const [open, setOpen] = useState<OpenOrder[]>([]);
  const [filter, setFilter] = useState(() => (wantedOrder ? "alle" : "offen"));
  const [query, setQuery] = useState(() => wantedOrder);
  const { sort, setSort } = useSortPref("gimel-accounting-sort", INVOICE_SORT_FIELDS);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<{ order: OpenOrder; email: string; due: number; deliveryDate: string } | null>(null);
  const [result, setResult] = useState<InvoiceResult | null>(null);
  const [cfg, setCfg] = useState<Config | null>(null);
  const [check, setCheck] = useState<BillingCheck | null>(null);
  const [checkError, setCheckError] = useState("");
  const { hidden, toggle, reset, ready } = useDefaultHidden(INVOICE_COLUMNS_KEY, INVOICE_COLUMNS_HIDDEN);
  const showColumn = (id: string) => ready && !hidden.includes(id);
  const adminWork = canAdminWork(getUser());

  useEffect(() => {
    if (!wantedOrder) return;
    setQuery(wantedOrder);
    setFilter("alle");
  }, [wantedOrder]);

  useEffect(() => {
    let active = true;
    setCheck(null); setCheckError("");
    if (draft) api<BillingCheck>(`/api/invoicing/orders/${encodeURIComponent(draft.order.no)}/billing-check`)
      .then(r => {
        if (!active) return;
        setCheck(r);
        if (r.delivery_date) setDraft((d) => (d ? { ...d, deliveryDate: d.deliveryDate || r.delivery_date || "" } : d));
      })
      .catch(e => { if (active) setCheckError(e.message); });
    return () => { active = false; };
  }, [draft?.order.no]);

  const [invTotal, setInvTotal] = useState(0);
  const [invOffset, setInvOffset] = useState(0);
  const [invLimit, setInvLimit] = useState(100);
  const [invLoading, setInvLoading] = useState(false);
  const [summary, setSummary] = useState<{
    total: number; open_count: number; overdue_count: number; paid_count: number;
    open_sum: number; overdue_sum: number; paid_30d_sum: number;
    aging: { "0_14": number; "15_30": number; "31_60": number; "60_plus": number };
  } | null>(null);

  const load = useCallback(async (nextOffset = invOffset, nextLimit = invLimit) => {
    setInvLoading(true);
    try {
      const [invRes, sumRes, openRes] = await Promise.all([
        apiWithCount<Invoice[]>(`/api/invoicing/invoices?limit=${nextLimit}&offset=${nextOffset}`),
        api<typeof summary>("/api/invoicing/summary").catch(() => null),
        api<OpenOrder[]>("/api/desk/orders?uninvoiced=true&limit=100"),
      ]);
      setRows(invRes.data);
      setInvTotal(invRes.total ?? invRes.data.length);
      if (sumRes && typeof sumRes.total === "number") setSummary(sumRes);
      // Interne und stornierte Aufträge werden nie berechnet — sie gehören nicht
      // in die offenen Forderungen.
      setOpen(openRes.filter((o) => o.kind !== "internal" && !o.cancelled_at && !o.paid && !o.invoice_no));
    } catch (e: any) { toastError(e.message); } finally { setInvLoading(false); }
  }, [invOffset, invLimit]);
  useEffect(() => { load(invOffset, invLimit); }, [invOffset, invLimit, load]);
  useEffect(() => {
    api<Config>("/api/invoicing/config").then(setCfg).catch(() => setCfg(null));
  }, []);

  const syncOpen = async () => {
    setBusy(true);
    try {
      const r = await api<{ checked: number; booked: string[]; errors: Array<{ order_no: string; detail: string }> }>(
        "/api/invoicing/invoices/sync-open", { method: "POST" });
      toastSuccess(r.booked.length
        ? `Zahlungseingang gebucht: ${r.booked.join(", ")}`
        : `${plural(r.checked, "Rechnung", "Rechnungen")} geprüft — nichts Neues.`);
      r.errors.forEach((e) => toastError(`${e.order_no}: ${e.detail}`));
      load();
    } catch (e: any) { toastError(e.message); } finally { setBusy(false); }
  };

  const createInvoice = async () => {
    if (!draft || !check?.ready) return;
    if (check.local && !draft.deliveryDate) {
      toastError("Bitte ein Lieferdatum (§ 14 UStG) angeben.");
      return;
    }
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { send: true, due_days: draft.due, email: draft.email.trim() };
      if (draft.deliveryDate) payload.delivery_date = draft.deliveryDate;
      const r = await api<InvoiceResult>(`/api/invoicing/orders/${draft.order.no}/invoice`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setDraft(null);
      setResult(r);
      load();
    } catch (e: any) { toastError(e.message); } finally { setBusy(false); }
  };

  const pdf = async (i: Invoice, refresh = false) => {
    try {
      await apiDownload(`/api/invoicing/orders/${i.order_no}/invoice.pdf?refresh=${refresh}`,
                        `Rechnung-${i.copy_number || i.order_no}.pdf`);
      toastSuccess(refresh ? "PDF neu von Stripe geholt und abgelegt."
                           : (i.has_copy ? "PDF aus der Ablage." : "PDF von Stripe geholt und abgelegt."));
      if (!i.has_copy || refresh) load();
    } catch (e: any) { toastError(e.message); }
  };

  const resend = async (i: Invoice) => {
    setBusy(true);
    try {
      const r = await api<{ sent: boolean; send_error: string; hosted_url: string }>(
        `/api/invoicing/orders/${i.order_no}/invoice/send`, { method: "POST" });
      if (r.sent) toastSuccess(cfg?.test_mode
        ? `Stripe hat den Versand angenommen — im Testmodus kommt bei ${i.email} nichts an.`
        : `Rechnung an ${i.email} verschickt.`);
      else toastError(`Stripe verschickt nicht: ${r.send_error} — PDF herunterladen und selbst senden.`);
    } catch (e: any) { toastError(e.message); } finally { setBusy(false); }
  };

  const markPaid = (i: Invoice) =>
    undoable({
      run: () => api(`/api/invoicing/orders/${i.order_no}/invoice/paid`,
                     { method: "POST", body: JSON.stringify({ note: "von Hand gebucht" }) }),
      done: `${i.order_no} als bezahlt gebucht.`,
      after: load,
    });

  const voidInvoice = (i: Invoice) =>
    undoable({
      run: () => api(`/api/invoicing/orders/${i.order_no}/invoice/void`, { method: "POST" }),
      done: `Rechnung zu ${i.order_no} storniert — der Auftrag ist wieder frei.`,
      after: load,
    });

  /* Der Zweck wandert von hier ins Onlinebanking, wenn ein Eingang von Hand
     zugeordnet wird — abtippen ist die Stelle, an der sich Ziffern vertauschen. */
  const copyZweck = async (zweck: string) => {
    try {
      await navigator.clipboard.writeText(zweck);
      toastSuccess(`Verwendungszweck „${zweck}" kopiert.`);
    } catch { toastError(`Kopieren ging nicht — der Zweck lautet: ${zweck}`); }
  };

  const all = rows ?? [];
  const q = query.trim().toLowerCase();
  const shown = sortRows(all.filter((r) => {
    const byFilter =
      filter === "alle" ? true
      : filter === "offen" ? !r.paid
      : filter === "ueberfaellig" ? !r.paid && r.days_overdue > 0
      : filter === "demnaechst"
        ? !r.paid && r.days_overdue <= 0 && !!r.due_at
          && new Date(r.due_at).getTime() > Date.now()
          && new Date(r.due_at).getTime() - Date.now() <= 7 * DAY
      : filter === "bezahlt" ? r.paid
      : filter === "ohne_xml" ? !r.has_einvoice
      : !r.paid && inBucket(r, filter);
    const bySearch = !q || [r.order_no, r.invoice_no, r.copy_number, r.customer, r.email, r.verwendungszweck]
      .some((v) => (v || "").toLowerCase().includes(q));
    return byFilter && bySearch;
  }), sort, (r, field) => (r as unknown as Record<string, unknown>)[field]);

  const openRows = all.filter((r) => !r.paid);
  const overdue = openRows.filter((r) => r.days_overdue > 0);
  const openSum = summary ? summary.open_sum : openRows.reduce((a, r) => a + r.gross, 0);
  const overdueSum = summary ? summary.overdue_sum : overdue.reduce((a, r) => a + r.gross, 0);

  /* Was in den letzten 30 Tagen wirklich angekommen ist — nicht was gefordert
     wurde. Die Zahl, mit der sich Liquidität abschätzen lässt. */
  const since30 = Date.now() - 30 * DAY;
  const paid30 = all.filter(
    (r) => r.paid && r.paid_at && new Date(r.paid_at).getTime() >= since30);
  const paid30Sum = summary ? summary.paid_30d_sum : paid30.reduce((a, r) => a + r.gross, 0);

  /* Ø Zahlungsdauer: gestellt → bezahlt, über alle bezahlten Rechnungen.
     Steigt sie, mahnt die Liste es von selbst — der Bucket über 90 Tage zeigt,
     wo es klemmt. */
  const paidBoth = all.filter(
    (r) => r.paid && r.paid_at && r.invoiced_at);
  const avgPayDays = paidBoth.length
    ? paidBoth.reduce(
        (a, r) =>
          a + (new Date(r.paid_at!).getTime() - new Date(r.invoiced_at!).getTime()) / DAY,
        0) / paidBoth.length
    : null;

  const aging = AGING.map((b) => {
    const rs = openRows.filter(b.test);
    return { ...b, count: rs.length, sum: rs.reduce((a, r) => a + r.gross, 0) };
  });

  /* Der Weg zur Finanzbuchhaltung: die gefilterte Liste als CSV — Semikolon
     und Dezimalkomma, wie Excel ohne Importdialog öffnet, mit BOM, damit die
     Umlaute bleiben. Was der Filter zeigt, geht raus; nichts kommt still dazu. */
  const exportCsv = () => {
    const eur = (v: number) =>
      v.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const day = (s: string | null | undefined) =>
      s ? new Date(s).toLocaleDateString("de-DE") : "";
    const head = ["Auftrag", "Rechnung", "Kunde", "Empfänger", "Netto", "USt", "USt %", "Brutto", "E-Rechnung XML",
                  "Gestellt", "Fällig", "Bezahlt am", "Zustand", "Tage überfällig",
                  "Verwendungszweck"];
    const body = shown.map((r) => [
      r.order_no, r.copy_number || r.invoice_no, r.customer || "", r.email,
      eur(r.net), eur(r.vat), eur(r.tax_rate * 100), eur(r.gross), r.has_einvoice ? "archiviert" : "fehlt", day(r.invoiced_at), day(r.due_at), day(r.paid_at),
      r.paid ? "bezahlt" : r.days_overdue > 0 ? `${plural(r.days_overdue, "Tag", "Tage")} überfällig` : "offen",
      String(r.days_overdue), r.verwendungszweck,
    ]);
    const csv = "\uFEFF" + [head, ...body]
      .map((cells) => cells.map((c) => `"${String(c).replace(/^[=+@\-\t\r]/, "'$&").replace(/"/g, '""')}"`).join(";"))
      .join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `Buchhaltung-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };

  const filterLabel = FILTERS.find(([value]) => value === filter)?.[1] ?? filter;

  return (
    <PageFrame
      title="Buchhaltung"
      sub={`Rechnungen und Zahlungseingänge${cfg?.seller ? ` · ${cfg.seller}` : ""}`}
      help={[
        cfg?.test_mode && { title: "Stripe im Testmodus", text: <p>Stripe nimmt den Versand an und meldet Erfolg, stellt aber im Testmodus grundsätzlich nichts zu. Das ist kein Fehler dieser Seite und lässt sich hier auch nicht beheben: dafür muss das Stripe-Konto freigeschaltet und auf Live-Schlüssel umgestellt werden. <b>Bis dahin ist der Weg: PDF herunterladen und selbst versenden</b> — oder den Link zur Zahlseite weitergeben.</p> },
        { title: "Rechnungen", text: <>
            <p><b>PDF</b> holt die Rechnung durch das Portal — beim ersten Mal von Stripe, danach aus der eigenen Ablage, also auch dann, wenn Stripe nicht erreichbar ist. <b>Zahlseite</b> gibt den Link zum Weiterleiten. Geld, das neben Stripe ankommt, wird über <b>bezahlt</b> gebucht.</p>
            {cfg && cfg.payment_methods.length > 0 && (
              <p>Jede Rechnung bietet <b>{paymentWays(cfg.payment_methods)}</b> an — dieselben Wege wie die Kasse des Bestellportals
                {cfg.transfer_country
                  ? <>; das Überweisungskonto weist Stripe je Rechnung aus ({cfg.transfer_country}).</>
                  : "."}
                {" "}Der <b>Verwendungszweck</b> ist Stripes Referenzcode zur Rechnung, nicht die Auftragsnummer: daran ordnet Stripe den Eingang zu. Die Auftragsnummer steht als eigenes Feld daneben.
              </p>
            )}
          </> },
        { title: "E-Rechnung (EN 16931)", text: <>
            {cfg && <p>{cfg.seller ? `Rechnungssteller: ${cfg.seller}.` : "Noch keine Verkäuferdaten hinterlegt — Rechnungen brauchen sie."}</p>}
            <p>Neue Inlandsrechnungen erhalten zusätzlich zum PDF eine archivierte XML-Datei im EN-16931-Kernformat (UBL 2.1). Pflichtangaben und Steuerbeträge werden vor Ausstellung geprüft. XRechnung, Peppol-Zustellung und Auslandsfälle gesondert abstimmen.</p>
            <p>Deutsches B2B: Empfang seit 2025; Ausstellung mit Übergangsfrist bis Ende 2026, bei Vorjahresumsatz bis 800.000 € bis Ende 2027. Ausnahmen, etwa Kleinbetragsrechnungen bis 250 €, bleiben zu prüfen.{" "}
              <a href="https://www.bundesfinanzministerium.de/Content/DE/FAQ/e-rechnung.html" target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>BMF: E-Rechnungspflicht</a>
            </p>
          </> },
      ]}
      actions={<>
        {open.length > 0 && (
          <HTMLSelect value="" aria-label="Rechnung zu einem offenen Auftrag stellen" onChange={(e) => {
            const o = open.find((x) => x.no === e.currentTarget.value);
            if (o) setDraft({ order: o, email: o.customer_email ?? "", due: 14, deliveryDate: "" });
          }}>
            <option value="">Rechnung stellen für…</option>
            {open.map((o) => (
              <option key={o.no} value={o.no}>{o.no} · {fmtEur(o.gross)} · {o.customer_name || o.customer_email}</option>
            ))}
          </HTMLSelect>
        )}
      </>}
    >
      {adminWork && <HintDetails title="Verkäuferdaten"><SellerPanel /></HintDetails>}

      {/* Eine Zahlenleiste wie überall; in „Einfach" die vier, die den Tag bestimmen. */}
      <KpiStrip label="Buchhaltung in Zahlen" items={[
        { id: "offen", label: "Offen", value: fmtEur(openSum), sub: plural(openRows.length, "Rechnung", "Rechnungen"), primary: true },
        { id: "ueberfaellig", label: "Überfällig", value: fmtEur(overdueSum), sub: plural(overdue.length, "Rechnung", "Rechnungen"),
          tone: overdue.length > 0 ? "danger" : "none", primary: true },
        { id: "ohne", label: "Ohne Rechnung", value: open.length, sub: plural(open.length, "Auftrag", "Aufträge"), primary: true },
        { id: "bezahlt30", label: "Bezahlt (30 Tage)", value: fmtEur(paid30Sum), sub: `${paid30.length} Zahlungseingänge`, primary: true },
        { id: "rechnungen", label: "Rechnungen", value: all.length, sub: `${all.filter((r) => r.paid).length} bezahlt` },
        // Ohne bezahlte Rechnung gibt es keine Dauer: unbekannt, nicht 0.
        { id: "dauer", label: "Ø Zahlungsdauer", value: avgPayDays === null ? null : avgPayDays.toFixed(1).replace(".", ","),
          unit: "Tage", sub: "gestellt → bezahlt" },
      ]} />

      {openRows.length > 0 && (
        <>
          <div className="aging-title">
            Forderungen nach Fälligkeit — {fmtEur(openSum)} offen · Filter im Filterknopf
          </div>
          <div className="aging-row">
            {aging.map((b) => (
              <div key={b.key} className={"aging is-static" + (filter === b.key ? " on" : "") + (b.key === "a5" ? " hot" : "")}>
                <span className="aging-sum">{fmtEur(b.sum)}</span>
                <span className="aging-label">{b.label}</span>
                <span className="aging-count">{b.count} {b.count === 1 ? "Rechnung" : "Rechnungen"}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <Toolbar
        meta={`${shown.length} von ${all.length}`}
        end={<>
          <ViewMenu columns={INVOICE_COLUMNS} hidden={hidden} onToggle={toggle} onReset={reset} />
          <KeyPopover placement="bottom-end" content={
            <Menu>
              <MenuItem icon="refresh" text="Bei Stripe abgleichen" disabled={busy} onClick={syncOpen} />
              <MenuItem icon="export" text="CSV exportieren" disabled={shown.length === 0} onClick={exportCsv} />
            </Menu>
          }>
            <Button icon="more" rightIcon="caret-down" text="Weitere" />
          </KeyPopover>
        </>}
      >
        <InputGroup leftIcon="search" placeholder="Auftrag, Kunde, Empfänger …"
                    value={query} style={{ width: 250 }}
                    onChange={(e) => setQuery(e.target.value)} />
        <FilterPopover active={filter !== "alle" ? 1 : 0} onClear={() => setFilter("alle")}>
          <FilterGroup label="Zahlungsstand">
            <HTMLSelect value={filter} aria-label="Rechnungen filtern" onChange={(e) => setFilter(e.currentTarget.value)}>
              {FILTERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </HTMLSelect>
          </FilterGroup>
        </FilterPopover>
        <SortControl state={sort} fields={INVOICE_SORT_FIELDS} onChange={setSort} />
        {filter !== "alle" && <FilterTag label={filterLabel} onRemove={() => setFilter("alle")} />}
      </Toolbar>

      {!rows ? <Spinner size={30} /> : shown.length === 0 ? (
        <NonIdealState icon="euro"
                       title={all.length ? "Nichts im Filter" : "Keine Rechnungen"}
                       description={all.length
                         ? "Kein Treffer für Zustand und Suche — anders stellen oder zurücksetzen."
                         : "Über „Rechnung stellen für …“ entsteht die erste."}
                       action={all.length ? (
                         <Button icon="eraser" text="Filter und Suche zurücksetzen"
                                 onClick={() => { setFilter("alle"); setQuery(""); }} />
                       ) : undefined} />
      ) : (
        <div className="table-scroll">
        <HTMLTable className="data-table" striped compact>
          <thead>
            <tr>
              <th>Auftrag</th><th>Kunde</th><th className="num">Brutto</th><th>Fällig</th><th>Zustand</th><th>Rechnung</th>
              {showColumn("verwendungszweck") && <th>Verwendungszweck</th>}
              {showColumn("email") && <th>Empfänger</th>}
              {showColumn("net") && <th className="num">Netto</th>}
              {showColumn("vat") && <th className="num">USt</th>}
              {showColumn("invoiced") && <th>Gestellt</th>}
              <th><span className="sr-only">Aktion</span></th>
            </tr>
          </thead>
          <tbody>
            {shown.map((i) => (
              <tr key={i.order_no} className={i.days_overdue > 0 ? "row-dirty" : undefined}>
                <td className="mono"><b><RefLink kind="order" no={i.order_no} /></b></td>
                <td>{i.customer || "—"}</td>
                <td className="num mono">{fmtEur(i.gross)}</td>
                <td className="sub">{fmtDate(i.due_at)}</td>
                <td>
                  <StatusChip
                    primary={i.paid
                      ? { label: `bezahlt ${fmtDate(i.paid_at)}`, tone: "success", title: fmtDate(i.paid_at) }
                      : i.days_overdue > 0
                        ? { label: `${plural(i.days_overdue, "Tag", "Tage")} überfällig`, tone: "danger" }
                        : { label: "offen" }}
                    extras={[
                      { label: i.has_einvoice ? "XML archiviert" : "XML fehlt", tone: i.has_einvoice ? "success" : "warning" },
                      { label: i.has_copy ? "Kopie im Haus" : "nur bei Stripe", icon: i.has_copy ? "folder-close" : "cloud" },
                    ]}
                  />
                </td>
                <td className="mono sub">{i.copy_number || i.invoice_no}</td>
                {showColumn("verwendungszweck") && <td className="mono">{i.verwendungszweck || i.order_no}</td>}
                {showColumn("email") && <td className="sub">{i.email}</td>}
                {showColumn("net") && <td className="num mono sub">{fmtEur(i.net)}</td>}
                {showColumn("vat") && <td className="num mono sub">{fmtEur(i.vat)}<div>{(i.tax_rate * 100).toLocaleString("de-DE")} %</div></td>}
                {showColumn("invoiced") && <td className="sub">{fmtDate(i.invoiced_at)}</td>}
                <td style={{ whiteSpace: "nowrap" }}>
                  <KeyPopover placement="bottom-end" content={
                    <Menu>
                      <MenuItem icon="document" text="PDF herunterladen" onClick={() => pdf(i)} />
                      <MenuItem icon="refresh" text="PDF neu von Stripe holen" onClick={() => pdf(i, true)} />
                      <MenuItem icon="export" text="E-Rechnung (XML)"
                        disabled={!i.has_einvoice}
                        onClick={() => apiDownload(`/api/invoicing/orders/${encodeURIComponent(i.order_no)}/invoice.xml`, `E-Rechnung-${i.order_no}.xml`).catch(e => toastError(e.message))} />
                      <MenuItem icon="duplicate" text="Verwendungszweck kopieren"
                        onClick={() => copyZweck(i.verwendungszweck || i.order_no)} />
                      {!i.paid && <>
                        <MenuDivider />
                        <MenuItem icon="envelope" text="Versand wiederholen" onClick={() => resend(i)} />
                        <MenuItem icon="tick" intent="success" text="Zahlung von Hand buchen" onClick={() => markPaid(i)} />
                        <MenuItem icon="cross" intent="danger" text="Rechnung stornieren" onClick={() => voidInvoice(i)} />
                      </>}
                    </Menu>
                  }>
                    <Button small minimal icon="more" aria-label={`Aktionen für ${i.order_no}`} title="Aktionen" />
                  </KeyPopover>
                </td>
              </tr>
            ))}
          </tbody>
        </HTMLTable>
        </div>
      )}

      <PaginationBar
        offset={invOffset}
        limit={invLimit}
        total={invTotal}
        count={rows?.length ?? 0}
        loading={invLoading}
        noun="Rechnungen"
        onChange={(nextOff, nextLim) => {
          setInvOffset(nextOff);
          if (nextLim !== undefined) setInvLimit(nextLim);
        }}
      />

      {/* Rechnung stellen — mit ausdrücklicher Wahl des Empfängers. */}
      <Dialog isOpen={!!draft} onClose={() => setDraft(null)} style={{ width: 520 }}
              title={`Rechnung stellen — ${draft?.order.no ?? ""}`}>
        <DialogBody>
          {draft && (
            <>
              {check ? <Callout intent={check.ready && (!check.local || !!draft.deliveryDate) ? "success" : "warning"} title={check.ready && (!check.local || !!draft.deliveryDate) ? "Rechnungsdaten geprüft" : "Vor Ausstellung korrigieren"} style={{ marginBottom: 14 }}>
                {!check.ready
                  ? check.errors.join(" · ")
                  : check.local && !draft.deliveryDate
                    ? "Lieferdatum fehlt (§ 14 UStG) — bitte unten angeben oder den Auftrag zuerst versenden."
                    : `${fmtEur(check.net)} netto + ${fmtEur(check.vat)} USt = ${fmtEur(check.gross)} brutto · ${check.format}`}
              </Callout> : checkError ? <Callout intent="danger">{checkError}</Callout> : <Spinner size={20} />}
              <div className="side-kv" style={{ marginBottom: 14 }}>
                <span>Auftrag</span><b className="mono">{draft.order.no}</b>
                <span>Kunde</span><b>{draft.order.customer_name || "—"}</b>
                <span>Betrag</span><b className="mono">{fmtEur(draft.order.gross)}</b>
              </div>
              <div className="form-grid">
                <label style={{ gridColumn: "1 / -1" }}>Empfänger
                  <InputGroup type="email" value={draft.email}
                              placeholder="leer = die vorrangige Adresse des Auftrags"
                              onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
                </label>
                <label>Zahlungsziel (Tage)
                  <NumericInput fill min={0} max={365} value={draft.due}
                                onValueChange={(v) => Number.isFinite(v) && setDraft({ ...draft, due: v })} />
                </label>
                {check?.local && (
                  <label>Lieferdatum (§ 14 UStG)
                    <InputGroup type="date" value={draft.deliveryDate}
                                onChange={(e) => setDraft({ ...draft, deliveryDate: e.target.value })} />
                  </label>
                )}
              </div>
              {check?.local ? (
                <Callout intent="primary" icon="document" style={{ marginTop: 12 }}
                         title="Lokale Rechnungsstellung">
                  <div className="side-kv">
                    <span>Auftrag</span>
                    <b className="mono">{draft.order.no}</b>
                    <span>Zahlweg</span>
                    <b>Überweisung / Rechnung</b>
                    <span>Format</span>
                    <b>{check.format}</b>
                  </div>
                </Callout>
              ) : (
                <Callout intent="primary" icon="euro" style={{ marginTop: 12 }}
                         title="Was auf der Rechnung stehen wird">
                  <div className="side-kv">
                    <span>Auftrag</span>
                    <b className="mono">{draft.order.no}</b>
                    <span>Verwendungszweck</span>
                    <b>steht nach dem Stellen fest</b>
                    <span>Zahlwege</span>
                    <b>{paymentWays(cfg?.payment_methods) || "Karte"}</b>
                  </div>
                  <p style={{ marginBottom: 0, marginTop: 6 }}>
                    Den Verwendungszweck vergibt Stripe, nicht wir: der Zahlungseingang wird gegen
                    Stripes Referenzcode gematcht, und den gibt es erst mit der finalisierten
                    Rechnung. Er steht danach hier, in der Liste und auf dem Beleg — die
                    Auftragsnummer bekommt ein eigenes Feld.
                  </p>
                </Callout>
              )}

              <Callout intent="warning" icon="warning-sign" style={{ marginTop: 12 }}>
                Bestell-E-Mail und Adresse am Kundenkonto laufen oft auseinander — bestellt der
                Einkauf, will die Buchhaltung die Rechnung. Nach dem Stellen steht hier, welche
                genommen wurde und welche abweicht.
              </Callout>
            </>
          )}
        </DialogBody>
        <DialogFooter actions={
          <>
            <Button text="Abbrechen" onClick={() => setDraft(null)} />
            <Button intent="primary" icon={check?.local ? "document" : "envelope"}
                    text={check?.local ? "Rechnung stellen" : "Rechnung stellen und PDF senden"}
                    loading={busy} disabled={!check?.ready || (!!check.local && !draft?.deliveryDate)} onClick={createInvoice} />
          </>} />
      </Dialog>

      {/* Was daraus geworden ist — samt Zahllink und abweichenden Adressen. */}
      <Dialog isOpen={!!result} onClose={() => setResult(null)} style={{ width: 560 }}
              title={`Rechnung ${result?.order_no ?? ""}`}>
        <DialogBody>
          {result && (
            <>
              <Callout intent="primary" title="E-Rechnung zustellen" style={{ marginBottom: 12 }}>
                Stripe versendet das PDF. Die strukturierte XML-Datei ist archiviert und muss zusätzlich über den vereinbarten Kanal zugestellt werden.
                <Button small text="XML herunterladen" icon="download" style={{ marginTop: 8 }}
                  onClick={() => apiDownload(`/api/invoicing/orders/${encodeURIComponent(result.order_no)}/invoice.xml`, `E-Rechnung-${result.order_no}.xml`).catch(e => toastError(e.message))} />
              </Callout>
              <Callout intent={result.sent ? "success" : "warning"}
                       icon={result.sent ? "tick-circle" : "warning-sign"}
                       title={result.sent
                         ? `Verschickt an ${result.customer_email}`
                         : "Stripe hat den Versand abgelehnt — die Rechnung steht trotzdem"}>
                {!result.sent && <p>{result.send_error}</p>}
                <p style={{ marginBottom: 0 }}>
                  Empfänger aus: <b>{result.email_source}</b> · Summe{" "}
                  <b>{fmtEur(result.total_cents / 100)}</b>
                </p>
                <p style={{ marginBottom: 0, marginTop: 6 }}>
                  Verwendungszweck <b className="mono">{result.verwendungszweck}</b>{" "}
                  <Button minimal small icon="duplicate" title="Verwendungszweck kopieren"
                          onClick={() => copyZweck(result.verwendungszweck)} />
                  {result.payment_methods.length > 0 && <> · zahlbar per <b>{paymentWays(result.payment_methods)}</b></>}
                </p>
                {result.sent && cfg?.test_mode && (
                  <p style={{ marginBottom: 0, marginTop: 6 }}>
                    <b>Aber:</b> im Testmodus stellt Stripe nichts zu. PDF herunterladen
                    und selbst senden.
                  </p>
                )}
              </Callout>

              {result.email_alternatives.length > 0 && (
                <Callout intent="warning" icon="warning-sign" style={{ marginTop: 12 }}
                         title="Am Auftrag stehen abweichende Adressen">
                  <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                    {result.email_alternatives.map((a) => (
                      <li key={a.email}><b>{a.source}:</b> <span className="mono">{a.email}</span></li>
                    ))}
                  </ul>
                  <p style={{ marginBottom: 0, marginTop: 6 }}>
                    Ging sie an die falsche Stelle: stornieren und neu stellen — der Knopf steht
                    in der Zeile.
                  </p>
                </Callout>
              )}

              <div style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Button icon="document" intent="primary" text="PDF herunterladen"
                        onClick={() => apiDownload(
                          `/api/invoicing/orders/${result.order_no}/invoice.pdf`,
                          `Rechnung-${result.order_no}.pdf`).catch((e) => toastError(e.message))} />
                {result.hosted_url && (
                  <Button icon="link" text="Zahlseite öffnen"
                          onClick={() => window.open(result.hosted_url, "_blank", "noreferrer")} />
                )}
              </div>
            </>
          )}
        </DialogBody>
        <DialogFooter actions={<Button text="Schließen" onClick={() => setResult(null)} />} />
      </Dialog>
    </PageFrame>
  );
}

