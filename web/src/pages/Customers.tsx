import { Button, Checkbox, Classes, Dialog, Drawer, FormGroup, HTMLSelect, HTMLTable, InputGroup, ProgressBar, Spinner, Tag, TextArea, Alert, Switch } from "@blueprintjs/core";
import NonIdealState from "../components/NonIdealState";
import Callout from "../components/Callout";
import { COUNTRIES, PAYMENT_TERMS, PRICE_GROUPS, priceGroupLabel, withCurrent } from "../constants";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, apiWithCount, fmtDate, fmtEur } from "../api";
import { navigate, useHashRoute } from "../router";
import { toastError, toastSuccess } from "../toast";
import {
  FilterGroup, FilterPopover, FilterTag, KV, PageFrame, PaginationBar, SortControl, StatusChip, Toolbar,
  ViewMenu, readStore, sortRows, useHiddenColumns, useSortPref, writeStore,
} from "../ui";
import type { SortField, ViewColumn } from "../ui";

interface Customer {
  id: number;
  email: string;
  name: string;
  company: string;
  active: boolean;
  price_group: string;
  discount_pct: number;
  payment_terms: string;
  customer_no: string;
  credit_limit: number;
  vat_id: string;
  created_at: string;
  n_orders: number;
  total_net: number;
  open_net: number;
  // Stand des Kunden (Aufgabe 45); ältere Server liefern diese Felder nicht.
  open_gross?: number;
  n_open?: number;
  n_cancelled?: number;
  last_order_at?: string | null;
  credit_used?: number;
  credit_free?: number | null;
  credit_pct?: number | null;
  order_block?: boolean;
  order_block_reason?: string;
  office_note?: string;
}

interface Duplicate {
  id: number; customer_no: string; company: string; name: string; email: string; why: string[];
}
const DUPLICATE_WHY: Record<string, string> = {
  email: "gleiche E-Mail", vat_id: "gleiche USt-IdNr.", company: "gleicher Firmenname",
  domain: "gleiche Mail-Domain",
};

interface Address {
  id: number;
  label: string;
  company: string;
  dept: string;
  contact: string;
  street: string;
  zip: string;
  city: string;
  country: string;
  vat_id: string;
  is_billing: boolean;
  is_delivery: boolean;
}

interface CustomerOrder {
  no: string;
  created_at: string;
  gross: number;
  paid: boolean;
  held_at?: string | null;
  cancelled_at?: string | null;
}

const emptyForm = {
  email: "", name: "", company: "", price_group: "standard",
  discount_pct: 0, payment_terms: "30 Tage netto", customer_no: "",
  credit_limit: 0, vat_id: "",
};

interface AddressDraft {
  label: string; company: string; dept: string; contact: string;
  street: string; zip: string; city: string; country: string;
  vat_id: string; is_billing: boolean; is_delivery: boolean;
}

const emptyAddress = (is_billing = false, is_delivery = false): AddressDraft => ({
  label: "", company: "", dept: "", contact: "",
  street: "", zip: "", city: "", country: "DE", vat_id: "", is_billing, is_delivery,
});

const addressUsable = (a: AddressDraft) =>
  !!(a.street.trim() && a.zip.trim() && a.city.trim());
const addressStarted = (a: AddressDraft) =>
  !!(a.street.trim() || a.zip.trim() || a.city.trim() || a.company.trim() ||
     a.contact.trim() || a.label.trim());

const CUSTOMER_COLUMNS_KEY = "gimel-customers-columns";
const CUSTOMER_COLUMNS: ViewColumn[] = [
  { id: "email", label: "E-Mail" },
  { id: "customer_no", label: "Kunden-Nr." },
  { id: "price_group", label: "Preisgruppe" },
  { id: "discount", label: "Rabatt" },
  { id: "payment_terms", label: "Zahlungsziel" },
  { id: "orders", label: "Aufträge" },
  { id: "revenue", label: "Umsatz netto" },
];
const CUSTOMER_COLUMNS_HIDDEN = CUSTOMER_COLUMNS.map((column) => column.id);
const CUSTOMER_SORT_FIELDS: SortField[] = [
  { id: "company", label: "Firma" },
  { id: "name", label: "Name" },
  { id: "customer_no", label: "Kunden-Nr." },
  { id: "created_at", label: "Angelegt" },
  { id: "n_orders", label: "Aufträge" },
  { id: "total_net", label: "Umsatz netto" },
  { id: "open_net", label: "Offen" },
];
const CUSTOMER_AGE_FILTERS: Array<[string, string]> = [
  ["alle", "alle"],
  ["30", "angelegt in 30 Tagen"],
  ["90", "angelegt in 90 Tagen"],
  ["jahr", "angelegt in diesem Jahr"],
];
const DAY_MS = 86_400_000;

/* Die Zusatzspalten beginnen zugeklappt; der Merker hält auch eine bewusst
   leere Auswahl (alle Spalten an) über das Neuladen hinweg fest. */
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

export default function Customers() {
  const [rows, setRows] = useState<Customer[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [pageSize, setPageSize] = useState(100);
  const [loadingPage, setLoadingPage] = useState(false);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("alle");
  const [ageFilter, setAgeFilter] = useState("alle");
  const { sort, setSort } = useSortPref("gimel-customers-sort", CUSTOMER_SORT_FIELDS);
  const [showNew, setShowNew] = useState(false);
  const [detail, setDetail] = useState<Customer | null>(null);
  const [detailOrders, setDetailOrders] = useState<CustomerOrder[]>([]);
  const [detailAddresses, setDetailAddresses] = useState<Address[]>([]);
  const { hidden, toggle, reset, ready } = useDefaultHidden(CUSTOMER_COLUMNS_KEY, CUSTOMER_COLUMNS_HIDDEN);
  const showColumn = (id: string) => ready && !hidden.includes(id);

  const load = useCallback(async (q = query, nextOffset = offset, nextLimit = pageSize) => {
    setLoadingPage(true);
    try {
      const params = new URLSearchParams({
        q,
        limit: String(nextLimit),
        offset: String(nextOffset),
      });
      const { data, total: hdrTotal } = await apiWithCount<Customer[]>(`/api/customers?${params.toString()}`);
      setRows(data);
      setTotal(hdrTotal ?? data.length);
    } catch (e: any) {
      toastError(e.message);
    } finally {
      setLoadingPage(false);
    }
  }, [query, offset, pageSize]);

  useEffect(() => { load(query, offset, pageSize); }, [offset, pageSize]); // eslint-disable-line react-hooks/exhaustive-deps

  const openDetail = async (c: Customer) => {
    setDetail(c);
    try {
      setDetailOrders(await api<CustomerOrder[]>(`/api/customers/${c.id}/orders`));
      setDetailAddresses(await api<Address[]>(`/api/customers/${c.id}/addresses`));
    } catch (e: any) {
      toastError(e.message);
    }
  };

  /* Tiefensprung #/kunden/{id} (aus „Suchen & springen"): der Kunde geht direkt auf,
     auch wenn er nicht in der gefilterten Liste steht. Schließen führt auf #/kunden zurück. */
  const route = useHashRoute();
  const linkedId = Number(route.split("/")[1] ?? "") || 0;
  useEffect(() => {
    if (!linkedId) return;
    let alive = true;
    api<Customer>(`/api/customers/${linkedId}`)
      .then((c) => { if (alive) openDetail(c); })
      // Unbekannte Nummer: Meldung und zurück auf die Liste, keine tote Adresse.
      .catch((e: any) => { toastError(e.message); if (alive) navigate("kunden"); });
    return () => { alive = false; };
  }, [linkedId]); // eslint-disable-line react-hooks/exhaustive-deps
  const closeDetail = () => { setDetail(null); if (linkedId) navigate("kunden"); };

  const shown = sortRows((rows ?? []).filter((c) => {
    const byStatus = statusFilter === "alle" ? true
      : statusFilter === "gesperrt" ? !!c.order_block
      : statusFilter === "aktiv" ? c.active : !c.active;
    if (!byStatus) return false;
    if (ageFilter === "alle") return true;
    const created = new Date(c.created_at).getTime();
    if (!Number.isFinite(created)) return false;
    if (ageFilter === "jahr") return new Date(created).getFullYear() === new Date().getFullYear();
    return Date.now() - created <= Number(ageFilter) * DAY_MS;
  }), sort, (c, field) => (c as unknown as Record<string, unknown>)[field]);
  const statusLabel = statusFilter === "aktiv" ? "aktiv" : statusFilter === "inaktiv" ? "inaktiv"
    : statusFilter === "gesperrt" ? "Auftragssperre" : "";
  const ageLabel = CUSTOMER_AGE_FILTERS.find(([value]) => value === ageFilter)?.[1] ?? ageFilter;
  const filtersActive = (statusFilter !== "alle" ? 1 : 0) + (ageFilter !== "alle" ? 1 : 0);

  return (
    <PageFrame
      title="Kunden"
      sub="Kundenstamm und Konditionen"
      help={[{
        title: "Konditionen",
        text: <p>Eine Zeile öffnet den Kunden rechts. Änderungen an den Konditionen gelten ab dem nächsten Auftrag.</p>,
      }]}
      actions={
        <Button intent="primary" icon="new-person" onClick={() => setShowNew(true)}>
          Neuer Kunde
        </Button>
      }
    >
      <Toolbar
        meta={total > pageSize
          ? `${(offset + 1).toLocaleString("de-DE")}–${(offset + shown.length).toLocaleString("de-DE")} von ${total.toLocaleString("de-DE")}`
          : `${shown.length.toLocaleString("de-DE")} von ${Math.max(total, rows?.length ?? 0).toLocaleString("de-DE")}`}
        end={<ViewMenu columns={CUSTOMER_COLUMNS} hidden={hidden} onToggle={toggle} onReset={reset} />}
      >
        <InputGroup leftIcon="search" placeholder="Firma, Name, E-Mail, Kundennummer …"
                    value={query} style={{ width: 340 }}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyUp={(e) => { if (e.key === "Enter") { setOffset(0); load(query, 0, pageSize); } }} />
        <FilterPopover active={filtersActive} onClear={() => { setStatusFilter("alle"); setAgeFilter("alle"); }}>
          <FilterGroup label="Status">
            <HTMLSelect value={statusFilter} aria-label="Kunden filtern" onChange={(e) => setStatusFilter(e.currentTarget.value)}>
              <option value="alle">alle</option>
              <option value="aktiv">aktiv</option>
              <option value="inaktiv">inaktiv</option>
              <option value="gesperrt">mit Auftragssperre</option>
            </HTMLSelect>
          </FilterGroup>
          <FilterGroup label="Angelegt">
            <HTMLSelect value={ageFilter} aria-label="Kunden nach Anlagedatum filtern" onChange={(e) => setAgeFilter(e.currentTarget.value)}>
              {CUSTOMER_AGE_FILTERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </HTMLSelect>
          </FilterGroup>
        </FilterPopover>
        <SortControl state={sort} fields={CUSTOMER_SORT_FIELDS} onChange={setSort} />
        {statusFilter !== "alle" && <FilterTag label={statusLabel} onRemove={() => setStatusFilter("alle")} />}
        {ageFilter !== "alle" && <FilterTag label={ageLabel} onRemove={() => setAgeFilter("alle")} />}
      </Toolbar>

      {!rows ? <Spinner size={30} /> : shown.length === 0 ? (
        <NonIdealState icon="people" title="Keine Kunden gefunden" />
      ) : (
        <div className="table-scroll">
          <HTMLTable className="data-table" striped compact interactive>
            <thead>
              <tr>
                <th>Kunde</th><th>Ort/Kontakt</th><th>Konditionen</th>
                <th className="num">Offen</th><th>Status</th>
                {showColumn("email") && <th>E-Mail</th>}
                {showColumn("customer_no") && <th>Kunden-Nr.</th>}
                {showColumn("price_group") && <th>Preisgruppe</th>}
                {showColumn("discount") && <th className="num">Rabatt</th>}
                {showColumn("payment_terms") && <th>Zahlungsziel</th>}
                {showColumn("orders") && <th className="num">Aufträge</th>}
                {showColumn("revenue") && <th className="num">Umsatz netto</th>}
                <th><span className="sr-only">Aktion</span></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => (
                <tr key={c.id} onClick={() => openDetail(c)} className={detail?.id === c.id ? "row-active" : undefined}>
                  <td><b>{c.company || c.name || "—"}</b>
                    {!c.active && <Tag minimal intent="danger" style={{ marginLeft: 6 }}>inaktiv</Tag>}
                    {c.order_block && <Tag minimal intent="warning" icon="disable" style={{ marginLeft: 6 }}
                                           title={c.order_block_reason || undefined}>Auftragssperre</Tag>}
                  </td>
                  <td>
                    <div>{c.name || "—"}</div>
                    {c.email && <div className="sub">{c.email}</div>}
                  </td>
                  <td>
                    <div>{priceGroupLabel(c.price_group)}</div>
                    <div className="sub">{c.payment_terms}{c.discount_pct ? ` · ${c.discount_pct} % Rabatt` : ""}</div>
                  </td>
                  <td className="num">{c.open_net
                    ? <Tag minimal intent="warning">{fmtEur(c.open_net)}</Tag> : "—"}</td>
                  <td><StatusChip primary={c.active
                    ? { label: "Aktiv", tone: "success" }
                    : { label: "Inaktiv", tone: "danger" }} /></td>
                  {showColumn("email") && <td>{c.email}</td>}
                  {showColumn("customer_no") && <td className="mono">{c.customer_no || "—"}</td>}
                  {showColumn("price_group") && <td>{c.price_group}</td>}
                  {showColumn("discount") && <td className="num">{c.discount_pct ? `${c.discount_pct} %` : "—"}</td>}
                  {showColumn("payment_terms") && <td>{c.payment_terms}</td>}
                  {showColumn("orders") && <td className="num">{c.n_orders}</td>}
                  {showColumn("revenue") && <td className="num">{fmtEur(c.total_net)}</td>}
                  <td onClick={(e) => e.stopPropagation()}>
                    <Button small minimal icon="edit" aria-label="Kunde bearbeiten"
                            title="Bearbeiten" onClick={() => openDetail(c)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </HTMLTable>
        </div>
      )}

      <PaginationBar
        offset={offset}
        limit={pageSize}
        total={total}
        count={rows?.length ?? 0}
        loading={loadingPage}
        noun="Kunden"
        onChange={(nextOff, nextLim) => {
          setOffset(nextOff);
          if (nextLim !== undefined) setPageSize(nextLim);
        }}
      />

      <NewCustomerDialog isOpen={showNew} onClose={() => setShowNew(false)} onCreated={() => {
        setShowNew(false);
        load(query);
        toastSuccess("Kunde angelegt.");
      }} />

      <CustomerDrawer detail={detail} orders={detailOrders} addresses={detailAddresses}
        onClose={closeDetail}
        onRefresh={async () => {
          if (!detail) return;
          try {
            const fresh = await api<Customer>(`/api/customers/${detail.id}`);
            setDetail(fresh);
            setDetailAddresses(await api<Address[]>(`/api/customers/${detail.id}/addresses`));
            load(query);
          } catch (e: any) { toastError(e.message); }
        }}
        onAddressesChange={setDetailAddresses}
      />
    </PageFrame>
  );
}

function CustomerDrawer({ detail, orders, addresses, onClose, onRefresh, onAddressesChange }:
  { detail: Customer | null; orders: CustomerOrder[]; addresses: Address[]; onClose: () => void; onRefresh: () => void; onAddressesChange: (a: Address[]) => void }) {
  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [addrDraft, setAddrDraft] = useState<AddressDraft>(emptyAddress());
  const [showAddressForm, setShowAddressForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editAddrDraft, setEditAddrDraft] = useState<AddressDraft>(emptyAddress());
  const [blockOpen, setBlockOpen] = useState(false);
  const [blockReason, setBlockReason] = useState("");
  const [blockBusy, setBlockBusy] = useState(false);
  const blockBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (detail) {
      setDraft({ name: detail.name, company: detail.company, price_group: detail.price_group,
                 discount_pct: detail.discount_pct, payment_terms: detail.payment_terms,
                 customer_no: detail.customer_no, credit_limit: detail.credit_limit,
                 vat_id: detail.vat_id, active: detail.active,
                 office_note: detail.office_note ?? "" });
      setBlockOpen(false);
      setBlockReason("");
      setEditMode(false);
      setEditingId(null);
      setShowAddressForm(false);
      setAddrDraft(emptyAddress(addresses.length === 0, addresses.length === 0));
    }
  }, [detail?.id]);

  if (!detail) return null;

  const set = (k: string, v: any) => setDraft((d: any) => ({ ...d, [k]: v }));

  const saveCustomer = async () => {
    setSaving(true);
    try {
      await api(`/api/customers/${detail.id}`, { method: "PATCH", body: JSON.stringify(draft) });
      toastSuccess("Kunde aktualisiert.");
      setEditMode(false);
      onRefresh();
    } catch (e: any) { toastError(e.message); } finally { setSaving(false); }
  };

  /* Auftragssperre (Aufgabe 45): setzen nur mit Grund, aufheben ohne Rückfrage. */
  const setBlock = async (on: boolean) => {
    setBlockBusy(true);
    try {
      await api(`/api/customers/${detail.id}`, {
        method: "PATCH",
        body: JSON.stringify(on ? { order_block: true, order_block_reason: blockReason.trim() } : { order_block: false }),
      });
      toastSuccess(on ? "Auftragssperre gesetzt." : "Auftragssperre aufgehoben.");
      setBlockOpen(false);
      setBlockReason("");
      onRefresh();
      // Fokus zurück auf den Sperr-Knopf (er wechselt dabei seine Beschriftung).
      requestAnimationFrame(() => blockBtn.current?.focus());
    } catch (e: any) { toastError(e.message); } finally { setBlockBusy(false); }
  };

  const openGross = detail.open_gross ?? 0;
  const creditPct = detail.credit_pct ?? null;
  const overLimit = creditPct !== null && creditPct > 100;

  const deleteCustomer = async () => {
    try {
      await api(`/api/customers/${detail.id}`, { method: "DELETE" });
      toastSuccess("Kunde deaktiviert.");
      setDeleteConfirm(false);
      onClose();
      // parent will reload via onRefresh caller; we trigger a global reload by closing
      window.location.reload();
    } catch (e: any) { toastError(e.message); }
  };

  const addAddress = async () => {
    if (!addressUsable(addrDraft)) { toastError("Straße, PLZ und Ort sind Pflicht."); return; }
    try {
      const created = await api<Address>(`/api/customers/${detail.id}/addresses`, { method: "POST", body: JSON.stringify(addrDraft) });
      onAddressesChange([...addresses, created]);
      setAddrDraft(emptyAddress());
      setShowAddressForm(false);
      toastSuccess("Anschrift hinzugefügt.");
    } catch (e: any) { toastError(e.message); }
  };

  const startEditAddress = (a: Address) => {
    setEditingId(a.id);
    setEditAddrDraft({ label: a.label, company: a.company, dept: a.dept, contact: a.contact,
                       street: a.street, zip: a.zip, city: a.city, country: a.country,
                       vat_id: a.vat_id, is_billing: a.is_billing, is_delivery: a.is_delivery });
  };

  const saveEditAddress = async () => {
    if (editingId == null) return;
    if (!addressUsable(editAddrDraft)) { toastError("Straße, PLZ und Ort sind Pflicht."); return; }
    try {
      const updated = await api<Address>(`/api/customers/${detail.id}/addresses/${editingId}`, { method: "PUT", body: JSON.stringify(editAddrDraft) });
      onAddressesChange(addresses.map(x => x.id === editingId ? updated : x));
      setEditingId(null);
      toastSuccess("Anschrift aktualisiert.");
    } catch (e: any) { toastError(e.message); }
  };

  const removeAddress = async (id: number) => {
    if (!confirm("Anschrift wirklich entfernen?")) return;
    try {
      await api(`/api/customers/${detail.id}/addresses/${id}`, { method: "DELETE" });
      onAddressesChange(addresses.filter(x => x.id !== id));
      toastSuccess("Anschrift entfernt.");
    } catch (e: any) { toastError(e.message); }
  };

  return (
    <>
    <Drawer isOpen={detail !== null} onClose={onClose} size={560} className="customer-drawer"
            title={detail ? (detail.company || detail.name || detail.email) : ""}>
      {detail && (
        <div className="customer-drawer-body">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
            {!editMode ? <Button small className="nw" icon="edit" text="Bearbeiten" onClick={() => setEditMode(true)} />
                       : <><Button small className="nw" intent="primary" icon="tick" text="Speichern" loading={saving} onClick={saveCustomer} />
                           <Button small className="nw" text="Abbrechen" onClick={() => setEditMode(false)} /></>}
            {detail.order_block
              ? <Button small className="nw" icon="unlock" text="Sperre aufheben" loading={blockBusy} ref={blockBtn} onClick={() => setBlock(false)} />
              : <Button small className="nw" icon="disable" text="Aufträge sperren …" ref={blockBtn} onClick={() => setBlockOpen(true)} />}
            <span style={{ flex: 1 }} />
            <Button small minimal className="nw" intent="danger" icon="trash" text="Deaktivieren" onClick={() => setDeleteConfirm(true)} />
          </div>

          {detail.order_block && (
            <Callout intent="warning" icon="disable" title="Auftragssperre">
              <b>Grund: {detail.order_block_reason || "nicht angegeben"}.</b> Neue Aufträge nimmt das Auftragsbüro nicht an;
              ein Auftrag aus dem Kundenportal kommt angehalten an. Laufende Aufträge bleiben unberührt.
              Ist ein solcher Auftrag schon bezahlt: binnen zwei Werktagen fortsetzen oder ablehnen und erstatten.
            </Callout>
          )}

          <div className="customer-standing" role="group" aria-label="Stand des Kunden">
            <div>
              <div className="sub">Offen (brutto)</div>
              <div className="mono customer-standing-value">{fmtEur(openGross)}</div>
              <div className="sub">{detail.n_open ?? 0} unbezahlt</div>
            </div>
            <div>
              <div className="sub">Kreditrahmen</div>
              {creditPct === null
                ? <div className="customer-standing-value">unbegrenzt</div>
                : <>
                    <div className="mono customer-standing-value">{fmtEur(detail.credit_limit)}</div>
                    <ProgressBar value={Math.min(1, creditPct / 100)} stripes={false} animate={false}
                                 intent={overLimit ? "danger" : creditPct >= 80 ? "warning" : "primary"}
                                 aria-label={`Kreditrahmen zu ${creditPct} % ausgeschöpft`} />
                    <div className="sub">
                      {overLimit
                        ? `überschritten um ${fmtEur(-(detail.credit_free ?? 0))}`
                        : `${creditPct} % belegt · frei ${fmtEur(detail.credit_free ?? 0)}`}
                    </div>
                  </>}
            </div>
            <div>
              <div className="sub">Aufträge</div>
              <div className="mono customer-standing-value">{detail.n_orders}</div>
              <div className="sub">
                {detail.last_order_at ? `zuletzt ${fmtDate(detail.last_order_at)}` : "noch keiner"}
                {detail.n_cancelled ? ` · ${detail.n_cancelled} storniert` : ""}
              </div>
            </div>
          </div>

          {!editMode ? (
            <KV rows={[
              ...(detail.office_note ? [{ label: "Büronotiz", value: <span className="customer-note">{detail.office_note}</span> }] : []),
              { label: "E-Mail", value: detail.email },
              { label: "Firma", value: detail.company || "—" },
              { label: "Ansprechpartner", value: detail.name || "—" },
              { label: "Kunden-Nr.", value: <span className="mono">{detail.customer_no || "—"}</span> },
              { label: "Preisgruppe", value: detail.price_group },
              { label: "Rabatt", value: `${detail.discount_pct} %` },
              { label: "Zahlungsziel", value: detail.payment_terms },
              { label: "Kreditrahmen", value: detail.credit_limit ? fmtEur(detail.credit_limit) : "unbegrenzt" },
              { label: "USt-IdNr.", value: detail.vat_id || "—" },
              { label: "Status", value: detail.active ? "aktiv" : "inaktiv" },
              { label: "Kunde seit", value: fmtDate(detail.created_at) },
            ]} />
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <FormGroup label="Firma"><InputGroup aria-label="Firma" value={draft.company} onChange={e => set("company", e.target.value)} /></FormGroup>
              <FormGroup label="Ansprechpartner"><InputGroup aria-label="Ansprechpartner" value={draft.name} onChange={e => set("name", e.target.value)} /></FormGroup>
              <FormGroup label="Kunden-Nr."><InputGroup aria-label="Kunden-Nr." value={draft.customer_no} onChange={e => set("customer_no", e.target.value)} /></FormGroup>
              <FormGroup label="Preisgruppe">
                <HTMLSelect aria-label="Preisgruppe" fill value={draft.price_group} onChange={e => set("price_group", e.target.value)}>
                  {withCurrent(PRICE_GROUPS, draft.price_group).map(([v,l]) => <option key={v} value={v}>{l}</option>)}
                </HTMLSelect>
              </FormGroup>
              <FormGroup label="Rabatt %"><InputGroup aria-label="Rabatt %" type="number" value={String(draft.discount_pct)} onChange={e => set("discount_pct", Number(e.target.value))} /></FormGroup>
              <FormGroup label="Zahlungsziel">
                <HTMLSelect aria-label="Zahlungsziel" fill value={draft.payment_terms} onChange={e => set("payment_terms", e.target.value)}>
                  {withCurrent(PAYMENT_TERMS, draft.payment_terms).map(([v,l]) => <option key={v} value={v}>{l}</option>)}
                </HTMLSelect>
              </FormGroup>
              <FormGroup label="Kreditrahmen €"><InputGroup aria-label="Kreditrahmen €" type="number" value={String(draft.credit_limit)} onChange={e => set("credit_limit", Number(e.target.value))} /></FormGroup>
              <FormGroup label="USt-IdNr."><InputGroup aria-label="USt-IdNr." value={draft.vat_id} onChange={e => set("vat_id", e.target.value)} /></FormGroup>
              <FormGroup label="Aktiv"><Switch checked={draft.active} onChange={e => set("active", (e.target as HTMLInputElement).checked)} label={draft.active ? "aktiv" : "inaktiv"} /></FormGroup>
              <FormGroup label="Büronotiz" labelFor="customer-note" style={{ gridColumn: "1 / -1" }}
                         helperText="Nur intern, steht auf keinem Beleg. Sachlich bleiben: keine Angaben zu Gesundheit oder Privatem, keine Wertungen. Der Kunde kann Auskunft über diese Notiz verlangen (Art. 15 DSGVO). Absprachen zu Preis oder Termin gehören in den Auftrag.">
                <TextArea id="customer-note" fill rows={3} maxLength={2000} value={draft.office_note}
                          onChange={e => set("office_note", e.target.value)} />
              </FormGroup>
            </div>
          )}

          <div className="ui-section">
            <div className="ui-section-head">
              <h2 className="ui-section-title">Anschriften <span className="ui-section-count">{addresses.length}</span></h2>
              <Button small minimal icon={showAddressForm ? "cross" : "add"}
                      text={showAddressForm ? "Formular schließen" : "Anschrift hinzufügen"}
                      aria-expanded={showAddressForm}
                      onClick={() => setShowAddressForm((open) => !open)} />
            </div>

            {addresses.map((a) => (
              <div key={a.id} className="addr-card" style={{ border: "1px solid var(--g-rule-soft)", borderRadius: 6, padding: 10, marginBottom: 8 }}>
                {editingId === a.id ? (
                  <>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                      <FormGroup label="Bezeichnung"><InputGroup aria-label="Bezeichnung" value={editAddrDraft.label} onChange={e => setEditAddrDraft(s => ({ ...s, label: e.target.value }))} /></FormGroup>
                      <FormGroup label="Firmenzusatz"><InputGroup aria-label="Firmenzusatz" value={editAddrDraft.company} onChange={e => setEditAddrDraft(s => ({ ...s, company: e.target.value }))} /></FormGroup>
                      <FormGroup label="Abteilung"><InputGroup aria-label="Abteilung" value={editAddrDraft.dept} onChange={e => setEditAddrDraft(s => ({ ...s, dept: e.target.value }))} /></FormGroup>
                      <FormGroup label="Ansprechpartner"><InputGroup aria-label="Ansprechpartner" value={editAddrDraft.contact} onChange={e => setEditAddrDraft(s => ({ ...s, contact: e.target.value }))} /></FormGroup>
                      <FormGroup label="Straße *"><InputGroup aria-label="Straße *" value={editAddrDraft.street} onChange={e => setEditAddrDraft(s => ({ ...s, street: e.target.value }))} /></FormGroup>
                      <FormGroup label="PLZ *"><InputGroup aria-label="PLZ *" value={editAddrDraft.zip} onChange={e => setEditAddrDraft(s => ({ ...s, zip: e.target.value }))} /></FormGroup>
                      <FormGroup label="Ort *"><InputGroup aria-label="Ort *" value={editAddrDraft.city} onChange={e => setEditAddrDraft(s => ({ ...s, city: e.target.value }))} /></FormGroup>
                      <FormGroup label="Land">
                        <HTMLSelect aria-label="Land" fill value={editAddrDraft.country} onChange={e => setEditAddrDraft(s => ({ ...s, country: e.target.value }))}>
                          {COUNTRIES.map(([c,l]) => <option key={c} value={c}>{l}</option>)}
                        </HTMLSelect>
                      </FormGroup>
                      <FormGroup label="USt-IdNr."><InputGroup aria-label="USt-IdNr." value={editAddrDraft.vat_id} onChange={e => setEditAddrDraft(s => ({ ...s, vat_id: e.target.value }))} /></FormGroup>
                      <Checkbox checked={editAddrDraft.is_billing} label="Rechnungsanschrift" onChange={e => setEditAddrDraft(s => ({ ...s, is_billing: (e.target as HTMLInputElement).checked }))} />
                      <Checkbox checked={editAddrDraft.is_delivery} label="Standard-Lieferadresse" onChange={e => setEditAddrDraft(s => ({ ...s, is_delivery: (e.target as HTMLInputElement).checked }))} />
                    </div>
                    <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                      <Button small intent="primary" text="Speichern" onClick={saveEditAddress} />
                      <Button small text="Abbrechen" onClick={() => setEditingId(null)} />
                    </div>
                  </>
                ) : (
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <div>
                      {a.label && <><b>{a.label}</b> </>}
                      {a.is_billing && <Tag minimal intent="primary">Rechnung</Tag>}{" "}
                      {a.is_delivery && <Tag minimal intent="success">Lieferung</Tag>}<br />
                      {a.company && <>{a.company}<br /></>}
                      {a.dept && <>{a.dept}<br /></>}
                      {a.contact && <>{a.contact}<br /></>}
                      {a.street}<br />{a.zip} {a.city}, {a.country}
                      {a.vat_id && <><br />USt: {a.vat_id}</>}
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <Button aria-label="Adresse bearbeiten" small minimal icon="edit" onClick={() => startEditAddress(a)} />
                      <Button aria-label="Adresse löschen" small minimal intent="danger" icon="trash" onClick={() => removeAddress(a.id)} />
                    </div>
                  </div>
                )}
              </div>
            ))}

            {showAddressForm && (
              <div className="addr-card addr-card-billing" style={{ border: "1px dashed var(--g-rule-strong)", borderRadius: 6, padding: 10, marginTop: 12 }}>
                <b>Neue Anschrift hinzufügen</b>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 8 }}>
                  <FormGroup label="Bezeichnung"><InputGroup aria-label="Bezeichnung" value={addrDraft.label} placeholder="z. B. Werk 2"
                            onChange={e => setAddrDraft(s => ({ ...s, label: e.target.value }))} /></FormGroup>
                  <FormGroup label="Firma"><InputGroup aria-label="Firma" value={addrDraft.company} onChange={e => setAddrDraft(s => ({ ...s, company: e.target.value }))} /></FormGroup>
                  <FormGroup label="Abteilung"><InputGroup aria-label="Abteilung" value={addrDraft.dept} onChange={e => setAddrDraft(s => ({ ...s, dept: e.target.value }))} /></FormGroup>
                  <FormGroup label="Ansprechpartner"><InputGroup aria-label="Ansprechpartner" value={addrDraft.contact} onChange={e => setAddrDraft(s => ({ ...s, contact: e.target.value }))} /></FormGroup>
                  <FormGroup label="Straße *"><InputGroup aria-label="Straße *" value={addrDraft.street} onChange={e => setAddrDraft(s => ({ ...s, street: e.target.value }))} /></FormGroup>
                  <FormGroup label="PLZ *"><InputGroup aria-label="PLZ *" value={addrDraft.zip} onChange={e => setAddrDraft(s => ({ ...s, zip: e.target.value }))} /></FormGroup>
                  <FormGroup label="Ort *"><InputGroup aria-label="Ort *" value={addrDraft.city} onChange={e => setAddrDraft(s => ({ ...s, city: e.target.value }))} /></FormGroup>
                  <FormGroup label="Land">
                    <HTMLSelect aria-label="Land" fill value={addrDraft.country} onChange={e => setAddrDraft(s => ({ ...s, country: e.target.value }))}>
                      {COUNTRIES.map(([c,l]) => <option key={c} value={c}>{l}</option>)}
                    </HTMLSelect>
                  </FormGroup>
                </div>
                <Checkbox checked={addrDraft.is_billing} label="Als Rechnungsanschrift" onChange={e => setAddrDraft(s => ({ ...s, is_billing: (e.target as HTMLInputElement).checked }))} />
                <Checkbox checked={addrDraft.is_delivery} label="Als Standard-Lieferadresse" onChange={e => setAddrDraft(s => ({ ...s, is_delivery: (e.target as HTMLInputElement).checked }))} />
                <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                  <Button small intent="primary" icon="add" text="Hinzufügen" onClick={addAddress} />
                  <Button small text="Abbrechen" onClick={() => setShowAddressForm(false)} />
                </div>
              </div>
            )}
          </div>

          <div className="ui-section">
            <div className="ui-section-head">
              <h2 className="ui-section-title">Aufträge <span className="ui-section-count">{orders.length}</span></h2>
            </div>
            <div className="table-scroll">
              <HTMLTable compact striped className="data-table">
                <thead><tr><th>Nr.</th><th>Datum</th><th className="num">Brutto</th><th>Zahlung</th></tr></thead>
                <tbody>
                  {orders.map((o) => (
                    <tr key={o.no}>
                      <td className="mono">
                        <button type="button" className="row-toggle" aria-label={`Auftrag ${o.no} öffnen`}
                                onClick={() => { onClose(); navigate(`auftraege/${encodeURIComponent(o.no)}`); }}>
                          {o.no}
                        </button>
                      </td>
                      <td>{fmtDate(o.created_at)}</td>
                      <td className="num">{fmtEur(o.gross)}</td>
                      <td>{o.cancelled_at ? <Tag minimal icon="cross-circle">storniert</Tag>
                        : o.paid ? <Tag intent="success" minimal icon="tick">bezahlt</Tag>
                        : <Tag minimal intent="warning">offen</Tag>}
                        {o.held_at && !o.cancelled_at && <Tag minimal intent="warning" icon="stop" style={{ marginLeft: 4 }}>angehalten</Tag>}</td>
                    </tr>
                  ))}
                </tbody>
              </HTMLTable>
            </div>
          </div>
        </div>
      )}
    </Drawer>
    <Dialog isOpen={blockOpen} onClose={() => { setBlockOpen(false); requestAnimationFrame(() => blockBtn.current?.focus()); }}
            shouldReturnFocusOnClose={false} title="Aufträge sperren">
      <form onSubmit={(e) => { e.preventDefault(); if (blockReason.trim().length >= 3) setBlock(true); }}>
        <div className={Classes.DIALOG_BODY}>
          <p>
            Für <b>{detail.company || detail.name || detail.email}</b> nimmt das Auftragsbüro keine neuen Aufträge an,
            bis die Sperre aufgehoben ist. Ein Auftrag aus dem Kundenportal kommt angehalten an.
            Laufende Aufträge und das Kundenkonto bleiben unberührt.
            Ist ein solcher Auftrag schon bezahlt: binnen zwei Werktagen fortsetzen oder ablehnen und erstatten.
          </p>
          <FormGroup label="Grund" labelFor="block-reason" labelInfo="(Pflicht)"
                     helperText="Steht in der Kundenkarte und im Protokoll. Nur Tatsachen (z. B. offene Rechnungen); der Kunde kann Auskunft darüber verlangen.">
            <InputGroup id="block-reason" autoFocus maxLength={200} value={blockReason}
                        placeholder="z. B. zwei Rechnungen überfällig"
                        onChange={(e) => setBlockReason(e.target.value)} />
          </FormGroup>
        </div>
        <div className={Classes.DIALOG_FOOTER}><div className={Classes.DIALOG_FOOTER_ACTIONS}>
          <Button onClick={() => setBlockOpen(false)}>Abbrechen</Button>
          <Button type="submit" intent="warning" icon="disable" loading={blockBusy}
                  disabled={blockReason.trim().length < 3}>Sperren</Button>
        </div></div>
      </form>
    </Dialog>
    <Alert isOpen={deleteConfirm} onClose={() => setDeleteConfirm(false)} onConfirm={deleteCustomer}
           intent="danger" icon="trash" confirmButtonText="Deaktivieren" cancelButtonText="Abbrechen">
      <p>Kunde <b>{detail?.email}</b> deaktivieren? Der Zugang wird gesperrt, E-Mail anonymisiert, Aufträge bleiben erhalten.</p>
    </Alert>
    </>
  );
}

function NewCustomerDialog({ isOpen, onClose, onCreated }:
                           { isOpen: boolean; onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState(emptyForm);
  const [addresses, setAddresses] = useState<AddressDraft[]>([emptyAddress(true, true)]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [nextNo, setNextNo] = useState("");
  const [dupes, setDupes] = useState<Duplicate[]>([]);

  // Dublettenhinweis: ein Hinweis, keine Sperre — zwei Niederlassungen einer
  // Firma sind zwei Kunden. Gefragt wird erst, wenn das Tippen kurz ruht.
  useEffect(() => {
    if (!isOpen) { setDupes([]); return; }
    const email = form.email.trim(), company = form.company.trim(), vat = form.vat_id.trim();
    if (!(email.includes("@") || company.length >= 3 || vat.length >= 8)) { setDupes([]); return; }
    let stale = false;
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams();
      if (email.includes("@")) params.set("email", email);
      if (company.length >= 3) params.set("company", company);
      if (vat.length >= 8) params.set("vat_id", vat);
      api<Duplicate[]>(`/api/customers/duplicates?${params.toString()}`)
        .then((r) => { if (!stale) setDupes(r); })
        .catch(() => { if (!stale) setDupes([]); });
    }, 400);
    return () => { stale = true; window.clearTimeout(timer); };
  }, [isOpen, form.email, form.company, form.vat_id]);

  const setAddr = (i: number, k: keyof AddressDraft, v: string | boolean) =>
    setAddresses((list) => list.map((a, j) => (j === i ? { ...a, [k]: v } : a)));

  // Rechnungs- und Lieferstandard sind Sprecher je Rolle: genau eine Anschrift
  // trägt jedes Kennzeichen — im Dialog per Funkwahl, der Server arbitriert
  // ohnehin noch einmal.
  const setBilling = (i: number) =>
    setAddresses((list) => list.map((a, j) => ({ ...a, is_billing: j === i })));

  const setDelivery = (i: number) =>
    setAddresses((list) => list.map((a, j) => ({ ...a, is_delivery: j === i })));

  const addAddress = () => setAddresses((l) => [...l, emptyAddress(l.length === 0, l.length === 0)]);
  const dropAddress = (i: number) =>
    setAddresses((l) => {
      const rest = l.filter((_, j) => j !== i);
      if (rest.length && !rest.some((a) => a.is_billing)) rest[0] = { ...rest[0], is_billing: true };
      if (rest.length && !rest.some((a) => a.is_delivery)) rest[0] = { ...rest[0], is_delivery: true };
      return rest;
    });

  useEffect(() => {
    setError("");
    if (!isOpen) return;
    api<{ customer_no: string }>("/api/customers/next-number")
      .then((r) => setNextNo(r.customer_no))
      .catch(() => setNextNo(""));
  }, [isOpen]);

  const set = (k: keyof typeof emptyForm, v: string | number) =>
    setForm((f) => ({ ...f, [k]: v }));

  const halfFilled = addresses.filter((a) => addressStarted(a) && !addressUsable(a));

  const submit = async () => {
    if (halfFilled.length) {
      const msg = "Eine angefangene Anschrift braucht Straße, PLZ und Ort — oder die Zeile wieder entfernen.";
      setError(msg);
      toastError(msg);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const payload = { ...form, addresses: addresses.filter(addressUsable) };
      await api("/api/customers", { method: "POST", body: JSON.stringify(payload) });
      setForm(emptyForm);
      setAddresses([emptyAddress(true, true)]);
      onCreated();
    } catch (e: any) {
      setError(e.message);
      toastError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog isOpen={isOpen} onClose={onClose} title="Neuer Kunde" style={{ width: 720 }}>
      <div className={Classes.DIALOG_BODY}>
        {error && <Callout intent="danger" role="alert" style={{ marginBottom: 12 }}>{error}</Callout>}
        <FormGroup label="E-Mail (Pflicht)">
          <InputGroup aria-label="E-Mail (Pflicht)" type="email" value={form.email} required
                      onChange={(e) => set("email", e.target.value)} />
        </FormGroup>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <FormGroup label="Firma">
            <InputGroup aria-label="Firma" value={form.company} onChange={(e) => set("company", e.target.value)} />
          </FormGroup>
          <FormGroup label="Ansprechpartner">
            <InputGroup aria-label="Ansprechpartner" value={form.name} onChange={(e) => set("name", e.target.value)} />
          </FormGroup>
          <FormGroup label="Kunden-Nr." helperText={form.customer_no ? "von Hand vergeben" : "wird automatisch vergeben"}>
            <InputGroup aria-label="Kunden-Nr." value={form.customer_no} placeholder={nextNo || "wird vergeben…"}
                        onChange={(e) => set("customer_no", e.target.value)} />
          </FormGroup>
          <FormGroup label="Preisgruppe">
            <HTMLSelect aria-label="Preisgruppe" fill value={form.price_group} onChange={(e) => set("price_group", e.currentTarget.value)}>
              {withCurrent(PRICE_GROUPS, form.price_group).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </HTMLSelect>
          </FormGroup>
          <FormGroup label="Rabatt %">
            <InputGroup aria-label="Rabatt %" type="number" value={String(form.discount_pct)}
                        onChange={(e) => set("discount_pct", Number(e.target.value))} />
          </FormGroup>
          <FormGroup label="Zahlungsziel">
            <HTMLSelect aria-label="Zahlungsziel" fill value={form.payment_terms} onChange={(e) => set("payment_terms", e.currentTarget.value)}>
              {withCurrent(PAYMENT_TERMS, form.payment_terms).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </HTMLSelect>
          </FormGroup>
          <FormGroup label="Kreditrahmen € (0 = unbegrenzt)">
            <InputGroup aria-label="Kreditrahmen € (0 = unbegrenzt)" type="number" value={String(form.credit_limit)}
                        onChange={(e) => set("credit_limit", Number(e.target.value))} />
          </FormGroup>
          <FormGroup label="USt-IdNr.">
            <InputGroup aria-label="USt-IdNr." value={form.vat_id} onChange={(e) => set("vat_id", e.target.value)} />
          </FormGroup>
        </div>
        <div aria-live="polite">{dupes.length > 0 && (
          <Callout intent="warning" icon="people" title="Diesen Kunden gibt es vielleicht schon">
            <ul className="lifecycle-blockers">
              {dupes.map((d) => (
                <li key={d.id}>
                  <b>{d.company || d.name || d.email}</b>
                  {d.customer_no ? <> · <span className="mono">{d.customer_no}</span></> : null} · {d.email}
                  {" — "}{d.why.map((w) => DUPLICATE_WHY[w] ?? w).join(", ")}
                </li>
              ))}
            </ul>
            <p className="sub">Nur ein Hinweis: Anlegen bleibt möglich.</p>
          </Callout>
        )}</div>
        <h2 className="addr-head">
          Anschriften
          <span className="sub">
            {addresses.filter(addressUsable).length} vollständig — beliebig viele möglich
          </span>
          <Button small minimal icon="add" text="Anschrift hinzufügen" onClick={addAddress} />
        </h2>

        {addresses.length === 0 && (
          <p className="sub">Keine Anschrift — der Kunde kann erst bestellen, wenn eine vorliegt.</p>
        )}

        {addresses.map((a, i) => (
          <div key={i} className={`addr-card${a.is_billing ? " addr-card-billing" : ""}`}>
            <div className="addr-bar">
              <InputGroup small placeholder={`Bezeichnung, z. B. „Werk 2"`} value={a.label}
                          onChange={(e) => setAddr(i, "label", e.target.value)} style={{ width: 220 }} />
              <Checkbox inline checked={a.is_billing} label="Rechnungsanschrift"
                        style={{ margin: 0 }} onChange={() => setBilling(i)} />
              <Checkbox inline checked={a.is_delivery} label="Lieferadresse"
                        style={{ margin: 0 }} onChange={() => setDelivery(i)} />
              <span style={{ flex: 1 }} />
              {addressStarted(a) && !addressUsable(a) && (
                <Tag minimal intent="warning">Straße, PLZ und Ort fehlen</Tag>
              )}
              <Button small minimal icon="cross" title="Anschrift entfernen"
                      onClick={() => dropAddress(i)} />
            </div>
            <div className="addr-grid">
              <FormGroup label="Firma">
                <InputGroup aria-label="Firma" value={a.company} placeholder={form.company || undefined}
                            onChange={(e) => setAddr(i, "company", e.target.value)} />
              </FormGroup>
              <FormGroup label="Abteilung">
                <InputGroup aria-label="Abteilung" value={a.dept} onChange={(e) => setAddr(i, "dept", e.target.value)} />
              </FormGroup>
              <FormGroup label="Ansprechpartner">
                <InputGroup aria-label="Ansprechpartner" value={a.contact} placeholder={form.name || undefined}
                            onChange={(e) => setAddr(i, "contact", e.target.value)} />
              </FormGroup>
              <FormGroup label="Straße und Hausnummer">
                <InputGroup aria-label="Straße und Hausnummer" value={a.street} onChange={(e) => setAddr(i, "street", e.target.value)} />
              </FormGroup>
              <FormGroup label="PLZ">
                <InputGroup aria-label="PLZ" value={a.zip} onChange={(e) => setAddr(i, "zip", e.target.value)} />
              </FormGroup>
              <FormGroup label="Ort">
                <InputGroup aria-label="Ort" value={a.city} onChange={(e) => setAddr(i, "city", e.target.value)} />
              </FormGroup>
              <FormGroup label="Land">
                <HTMLSelect aria-label="Land" fill value={a.country}
                            onChange={(e) => setAddr(i, "country", e.currentTarget.value)}>
                  {COUNTRIES.map(([c, l]) => <option key={c} value={c}>{l}</option>)}
                </HTMLSelect>
              </FormGroup>
              <FormGroup label="USt-IdNr. (abweichend)">
                <InputGroup aria-label="USt-IdNr. (abweichend)" value={a.vat_id} placeholder={form.vat_id || undefined}
                            onChange={(e) => setAddr(i, "vat_id", e.target.value)} />
              </FormGroup>
            </div>
          </div>
        ))}

        {error && <div className="addr-error">{error}</div>}
      </div>
      <div className={Classes.DIALOG_FOOTER}>
        <div className={Classes.DIALOG_FOOTER_ACTIONS}>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button intent="primary" loading={busy} disabled={!form.email}
                  onClick={submit}>Anlegen</Button>
        </div>
      </div>
    </Dialog>
  );
}
