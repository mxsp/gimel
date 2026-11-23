import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Callout, Card, Dialog, DialogBody, HTMLTable, InputGroup, Spinner, Tag, Tooltip } from "@blueprintjs/core";
import NonIdealState from "../components/NonIdealState";
import { api, isWorker } from "../api";
import { navigate } from "../router";
import { toastError, toastSuccess } from "../toast";
import WorkQueue from "../components/WorkQueue";
import {
  ALL_KINDS, KIND_ICON, KIND_LABEL, KIND_STATION_TYPE, Placement, PoolRow,
  StationOption, TaskKind, TYPE_LABEL, WorklistData, WorkSlot,
  clockIn, fmtMin, priorityIntent,
} from "../factory";
import { days, plural } from "../plural";
import {
  FilterGroup, FilterPopover, FilterTag, HintDetails, InfoHint,
  PageFrame, StatusChip, Toolbar, useDetail,
} from "../ui";
import StationControlBar from "../components/StationControlBar";
import { publishStations } from "../stationStore";

/* Arbeitsvorrat — was die Halle zu tun hat, und wer es tut.

   Diese Seite beantwortet die Frage, die bis hierher keine Ansicht beantwortet
   hat: *nicht* „wo schneidet welcher Innenauftrag" (das zeigt die Station)
   und *nicht* „was liegt noch im Regal" (das tut Bereitstellen), sondern
   **was ist an jedem Arbeitsplatz als Nächstes dran, und warum genau das.**

   Vier Arbeitsarten, vier Stationstypen, eine Regel: die Reihenfolge ergibt
   sich aus Zusage, Eil, Liegezeit und dem, was gerade aufgespannt ist — und
   jede Zeile trägt ihre Begründung mit. Der Vorrat unten ist das, was noch
   keiner Station gehört; er ist die Liste, an der ein Meister zieht.

   Verteilt wird nichts von selbst, solange der Hauptschalter aus ist. Das ist
   dieselbe Vorsicht wie bei der Maschinenzuordnung: eine Halle, die beim
   ersten Start anfängt, Aufträge zu schieben, verliert das Vertrauen, bevor
   sie es verdient hat. */

export default function Worklist() {
  const { simple } = useDetail();
  // Werker arbeiten ihre Aufgaben ab; verteilen und umsortieren plant das Büro.
  const office = !isWorker();
  const [data, setData] = useState<WorklistData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [kind, setKind] = useState<TaskKind | "">("");
  const [auto, setAuto] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [plan, setPlan] = useState<Placement[] | null>(null);
  const [planBusy, setPlanBusy] = useState(false);
  const [moveFor, setMoveFor] = useState<PoolRow | null>(null);
  const [search, setSearch] = useState("");
  const [onlyBusy, setOnlyBusy] = useState(true);
  const [areaFilter, setAreaFilter] = useState<"all" | "production" | "logistics" | "office">("all");
  const [focusedStation, setFocusedStation] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());

  const toggleStation = (id: number) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const q = kind ? `?kind=${kind}` : "";
      const next = await api<WorklistData>(`/api/factory/worklist${q}`);
      setData(next);
      if (next.stations?.length) {
        publishStations(next.stations.map((s) => ({
          id: s.id,
          label: s.label,
          type: s.type,
          active: true,
          queue_jobs: s.schedule?.slots?.length ?? 0,
          queue_min: s.schedule?.total_min ?? 0,
        })));
      }
      setUpdatedAt(new Date());
      setError("");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!silent) { setError(msg); toastError(msg); }
    } finally { setLoading(false); }
  }, [kind]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(() => { if (!document.hidden) load(true); }, 30_000);
    return () => clearInterval(t);
  }, [auto, load]);

  // ---------------------------------------------------------------- Aktionen
  const setState = async (slot: WorkSlot, state: string) => {
    if (slot.task_id == null) return;
    setBusy(`${slot.kind}:${slot.ref}`);
    try {
      await api(`/api/factory/tasks/${slot.task_id}/state`, {
        method: "POST", body: JSON.stringify({ state }),
      });
      toastSuccess(`${slot.ref}: ${state === "done" ? "fertig gemeldet" : state === "running" ? "angefangen" : "zurückgenommen"}.`);
      await load(true);
    } catch (e: unknown) {
      toastError(e instanceof Error ? e.message : String(e));
      await load(true);
    } finally { setBusy(null); }
  };

  const assign = async (row: PoolRow | WorkSlot, stationId: number | null) => {
    const key = `${row.kind}:${row.ref}`;
    setBusy(key);
    try {
      const id = row.task_id;
      if (id == null) throw new Error("Diese Aufgabe hat keine Zeile — bitte aktualisieren.");
      await api(`/api/factory/tasks/${id}/assign`, {
        method: "POST", body: JSON.stringify({ station_id: stationId }),
      });
      toastSuccess(stationId == null ? `${row.ref} ist wieder frei.` : `${row.ref} zugeordnet.`);
      setMoveFor(null);
      await load(true);
    } catch (e: unknown) {
      toastError(e instanceof Error ? e.message : String(e));
      await load(true);
    } finally { setBusy(null); }
  };

  const move = async (stationId: number, slots: WorkSlot[], slot: WorkSlot, dir: -1 | 1) => {
    const order = slots.map((s) => `${s.kind}:${s.ref}`);
    const i = order.indexOf(`${slot.kind}:${slot.ref}`);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    setBusy(`${slot.kind}:${slot.ref}`);
    try {
      await api(`/api/factory/stations/${stationId}/worklist/order`, {
        method: "POST", body: JSON.stringify({ keys: order }),
      });
      await load(true);
    } catch (e: unknown) { toastError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };

  const freeOrder = async (stationId: number) => {
    try {
      await api(`/api/factory/stations/${stationId}/worklist/order`, { method: "DELETE" });
      toastSuccess("Handreihenfolge gelöst — es gilt wieder die gerechnete Ordnung.");
      await load(true);
    } catch (e: unknown) { toastError(e instanceof Error ? e.message : String(e)); }
  };

  const showPlan = async () => {
    setPlanBusy(true);
    try {
      const q = kind ? `?kind=${kind}` : "";
      const r = await api<{ placements: Placement[] }>(`/api/factory/worklist/plan${q}`);
      setPlan(r.placements);
    } catch (e: unknown) { toastError(e instanceof Error ? e.message : String(e)); }
    finally { setPlanBusy(false); }
  };

  const applyPlan = async (refs: string[] = []) => {
    setPlanBusy(true);
    try {
      const r = await api<{ count: number }>("/api/factory/worklist/apply", {
        method: "POST",
        body: JSON.stringify({ include_suggested: true, kind: kind || "", refs }),
      });
      toastSuccess(r.count
        ? `${plural(r.count, "Aufgabe", "Aufgaben")} verteilt.`
        : "Nichts zu verteilen — alles liegt schon irgendwo.");
      setPlan(null);
      await load(true);
    } catch (e: unknown) { toastError(e instanceof Error ? e.message : String(e)); }
    finally { setPlanBusy(false); }
  };

  // ---------------------------------------------------------------- Ableitungen
  const stations = data?.stations ?? [];
  const pool = data?.pool ?? [];
  const busyStations = useMemo(
    () => stations.filter((s) => s.schedule.slots.length > 0), [stations]);
  const idleStations = useMemo(
    () => stations.filter((s) => s.schedule.slots.length === 0), [stations]);

  const totals = useMemo(() => {
    let open = 0, unassigned = 0, running = 0;
    for (const k of Object.values(data?.kinds ?? {})) {
      open += k.open; unassigned += k.unassigned; running += k.running;
    }
    const saved = stations.reduce((a, s) => a + (s.schedule.changeover_min_saved || 0), 0);
    const late = stations.reduce((a, s) => a + (s.schedule.late?.length || 0), 0);
    return { open, unassigned, running, saved, late };
  }, [data, stations]);

  const maxQueueMin = useMemo(
    () => Math.max(60, ...stations.map((s) => s.schedule.total_min || 0)),
    [stations],
  );

  const stationArea = (type: string): "production" | "logistics" | "office" =>
    type === "production" ? "production" : type === "accounting" ? "office" : "logistics";

  const areaCounts = useMemo(() => {
    const base = onlyBusy ? busyStations : stations;
    let production = 0, logistics = 0, officeCount = 0;
    for (const s of base) {
      const a = stationArea(s.type);
      if (a === "production") production++;
      else if (a === "office") officeCount++;
      else logistics++;
    }
    return { all: base.length, production, logistics, office: officeCount };
  }, [onlyBusy, busyStations, stations]);

  const stripStations = useMemo(() => stations.filter((st) => {
    if (onlyBusy && st.schedule.slots.length === 0 && focusedStation !== st.id) return false;
    if (areaFilter !== "all" && stationArea(st.type) !== areaFilter) return false;
    return true;
  }), [stations, onlyBusy, areaFilter, focusedStation]);

  const visibleStations = useMemo(() => {
    const q = search.trim().toLowerCase();
    return stripStations.filter((st) => {
      if (focusedStation != null && st.id !== focusedStation) return false;
      if (!q) return true;
      if (st.label.toLowerCase().includes(q) || TYPE_LABEL[st.type].toLowerCase().includes(q)) return true;
      return st.schedule.slots.some((s) =>
        `${s.ref} ${s.label} ${s.mat ?? ""} ${s.mat_name ?? ""} ${(s.orders ?? []).join(" ")}`.toLowerCase().includes(q)
      );
    });
  }, [stripStations, focusedStation, search]);

  const filteredPool = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return pool;
    return pool.filter((r) =>
      `${r.ref} ${r.label} ${r.mat ?? ""} ${r.mat_name ?? ""} ${r.suggest_label ?? ""} ${(r.orders ?? []).join(" ")}`.toLowerCase().includes(q)
    );
  }, [pool, search]);

  const planDeltaByStation = useMemo(() => {
    const map = new Map<number, number>();
    if (!plan) return map;
    for (const p of plan) {
      if (p.station_id != null && p.mode !== "none") {
        map.set(p.station_id, (map.get(p.station_id) ?? 0) + 1);
      }
    }
    return map;
  }, [plan]);

  if (loading && !data) return <div className="twin-center"><Spinner size={36} /></div>;
  if (error && !data) return <div className="twin-center twin-error">{error}</div>;
  if (!data) return null;

  const allCollapsed = visibleStations.length > 0 && visibleStations.every((s) => collapsed.has(s.id));

  return (
    <PageFrame
      title="Arbeitsvorrat"
      sub="Jede Station eine Abarbeitungsliste — Reihenfolge nach Zusage, Eil und Liegezeit."
      actions={<>
        <Button small minimal active={auto} icon="automatic-updates"
                aria-pressed={auto}
                aria-label={auto ? "Auto-Refresh (30 s) aktiv" : "Auto-Refresh pausiert"}
                title={auto ? "Auto-Refresh alle 30 s aktiv — klicken zum Pausieren" : "Auto-Refresh pausiert — klicken zum Aktivieren"}
                onClick={() => setAuto((v) => !v)} />
        <Button small minimal icon="refresh" aria-label="Aktualisieren" title="Aktualisieren"
                loading={loading} onClick={() => load()} />
        {office && <>
          <Button small minimal icon="calculator" text="Vorrechnen"
                  loading={planBusy} onClick={showPlan} />
          <Tooltip content="Jede noch freie Aufgabe an die Station geben, an der sie die Halle am wenigsten kostet.">
            <Button small intent="primary" icon="layout-hierarchy" text="Verteilen"
                    loading={planBusy} disabled={!totals.unassigned}
                    onClick={() => applyPlan()} />
          </Tooltip>
        </>}
      </>}
    >
      <StationControlBar active="arbeitsvorrat" />
      <div className="ui-facts ls-facts" role="group" aria-label="Arbeitsvorrat in Zahlen">
        <div className="ui-fact is-accent">
          <span className="ui-fact-label">Offene Aufgaben</span>
          <span className="ui-fact-value">{totals.open}</span>
          <span className="sub">{totals.running} {totals.running === 1 ? "läuft" : "laufen"} · {totals.unassigned} ohne Station</span>
        </div>
        <div className="ui-fact is-info">
          <span className="ui-fact-label">Stationen mit Arbeit</span>
          <span className="ui-fact-value">{busyStations.length} / {stations.length}</span>
          <span className="sub">{idleStations.length ? `${idleStations.length} ohne Aufträge` : "alle ausgelastet"}</span>
        </div>
        <div className="ui-fact is-success">
          <span className="ui-fact-label">Rüstzeit gespart</span>
          <span className="ui-fact-value">{fmtMin(totals.saved)}</span>
          <span className="sub">gegen die reine Terminreihenfolge</span>
        </div>
        <div className={`ui-fact ${totals.late > 0 ? "is-danger" : "is-success"}`}>
          <span className="ui-fact-label">Zusagen in Gefahr</span>
          <span className="ui-fact-value">{totals.late}</span>
          <span className="sub">{totals.late ? "in der aktuellen Reihenfolge" : "alle Termine halten"}</span>
        </div>
      </div>

      {/* Live Stations-Schnellleiste: nur in Ansicht „Alles“ und als einzeilige Leiste der aktiven Auswahl */}
      {!simple && stripStations.length > 1 && (
        <div className="ls-station-strip" role="group" aria-label="Stationsübersicht">
          {stripStations.map((st) => {
            const count = st.schedule.slots.length;
            const runningHere = st.schedule.slots.some((s) => s.state === "running");
            const lateHere = (st.schedule.late?.length || 0) > 0;
            const totalMin = st.schedule.total_min || 0;
            const pct = count === 0 ? 0 : Math.min(100, Math.round((totalMin / maxQueueMin) * 100));
            const isFocused = focusedStation === st.id;
            const simAdd = planDeltaByStation.get(st.id) ?? 0;
            return (
              <button
                key={st.id}
                type="button"
                className={`ls-station-tile${isFocused ? " is-focused" : ""}${count === 0 ? " is-idle" : ""}`}
                style={{ borderLeftColor: st.colour || "var(--gimel-accent)" }}
                title={isFocused ? "Filter aufheben" : `Nur ${st.label} anzeigen${simAdd > 0 ? ` (+${simAdd} vorgerechnet)` : ""}`}
                onClick={() => setFocusedStation((cur) => (cur === st.id ? null : st.id))}
              >
                <div className="ls-tile-head">
                  <span className="ls-tile-name">
                    {runningHere && <span className="ls-live-pulse" title="Läuft gerade" />}
                    {st.label}
                  </span>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                    {simAdd > 0 && (
                      <Tag minimal round intent="success" title={`+${simAdd} aus Vorrechnung`}>+{simAdd}</Tag>
                    )}
                    <Tag minimal round intent={lateHere ? "danger" : runningHere ? "success" : count > 0 ? "primary" : "none"}>
                      {count}
                    </Tag>
                  </span>
                </div>
                <div className="ls-tile-meta">
                  <span>{TYPE_LABEL[st.type]}</span>
                  <span className="mono">{totalMin > 0 ? fmtMin(totalMin) : "frei"}</span>
                </div>
                <div className="ls-tile-bar" aria-hidden="true">
                  <div className={`ls-tile-bar-fill${lateHere ? " is-danger" : pct >= 80 ? " is-warn" : ""}`}
                       style={{ width: `${pct}%` }} />
                </div>
              </button>
            );
          })}
        </div>
      )}

      <Toolbar
        meta={updatedAt ? `aktualisiert ${updatedAt.toLocaleTimeString("de-DE")}` : undefined}
        end={!data.auto_routing ? (
          <span className="ui-inline-actions" role="status">
            <span className="sub">Automatische Verteilung aus — nur Vorschläge.</span>
            <Button small minimal text="Admin → Betrieb" onClick={() => navigate("admin")} />
          </span>
        ) : undefined}
      >
        <InputGroup small leftIcon="search" placeholder="Auftrag, Werkstoff, Station …"
                    aria-label="Arbeitsvorrat durchsuchen" style={{ width: 210 }}
                    value={search} onChange={(e) => setSearch(e.target.value)}
                    rightElement={search ? <Button minimal icon="cross" aria-label="Suche leeren" onClick={() => setSearch("")} /> : undefined} />
        <FilterPopover active={kind ? 1 : 0} onClear={() => setKind("")} label="Arbeitsart">
          <FilterGroup label="Arbeitsart">
            <div className="ui-filter-chips">
              <button type="button" className={"filter-chip" + (kind === "" ? " filter-chip-on" : "")}
                      onClick={() => setKind("")}>Alle Arbeiten</button>
              {ALL_KINDS.map((k) => {
                const c = data.kinds[k];
                return (
                  <button type="button" key={k} className={"filter-chip" + (kind === k ? " filter-chip-on" : "")}
                          onClick={() => setKind(k)}>
                    <span className={"bp5-icon-standard bp5-icon-" + KIND_ICON[k]} />
                    {" "}{KIND_LABEL[k]}
                    {c && <span className="filter-count">{c.open}</span>}
                  </button>
                );
              })}
            </div>
          </FilterGroup>
        </FilterPopover>
        <div className="ui-filter-chips" role="group" aria-label="Bereich filtern">
          {([
            ["all", "Alle", areaCounts.all],
            ["production", "Maschinen", areaCounts.production],
            ["logistics", "Lager & Versand", areaCounts.logistics],
            ["office", "Büro", areaCounts.office],
          ] as Array<["all" | "production" | "logistics" | "office", string, number]>).map(([id, label, cnt]) => (
            <button
              key={id}
              type="button"
              className={"filter-chip" + (areaFilter === id ? " filter-chip-on" : "")}
              onClick={() => { setAreaFilter(id); setFocusedStation(null); }}
            >
              {label} <span className="filter-count">{cnt}</span>
            </button>
          ))}
        </div>
        <button type="button" className={"filter-chip" + (!onlyBusy ? " filter-chip-on" : "")}
                title={onlyBusy ? `${idleStations.length} leere Stationen einblenden` : "Leere Stationen ausblenden"}
                onClick={() => setOnlyBusy((v) => !v)}>
          {onlyBusy ? `Leere zeigen (${idleStations.length})` : "Leere ausblenden"}
        </button>
        {visibleStations.length > 1 && (
          <Button small minimal icon={allCollapsed ? "expand-all" : "collapse-all"}
                  text={allCollapsed ? "Alle ausklappen" : "Alle einklappen"}
                  onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(visibleStations.map((s) => s.id)))} />
        )}
        {kind && <FilterTag label={KIND_LABEL[kind]} onRemove={() => setKind("")} />}
        {focusedStation != null && (
          <FilterTag
            label={`Station: ${stations.find((s) => s.id === focusedStation)?.label ?? focusedStation}`}
            onRemove={() => setFocusedStation(null)}
          />
        )}
        <InfoHint
          label="Zusagefenster"
          title="Zusagefenster"
          text={`Zusagefenster ${days(data.policy.window_h / 24)} · Puffer ${data.policy.safety_min} min.`}
        />
      </Toolbar>

      {/* ---------------- Stationen mit ihrer Liste ---------------- */}
      {visibleStations.map((st) => {
        const isClosed = collapsed.has(st.id);
        return (
        <Card key={st.id} className="queue-card ls-queue-card" style={{ borderLeftColor: st.colour || "var(--gimel-accent)" }}>
          <div className="card-title-row">
            <h2 className="card-title">
              <Button small minimal icon={isClosed ? "chevron-right" : "chevron-down"}
                      aria-label={isClosed ? `${st.label} ausklappen` : `${st.label} einklappen`}
                      onClick={() => toggleStation(st.id)} />
              <span className="station-dot" style={{ background: st.colour }} />
              {st.label}
              <span className="sub"> · {TYPE_LABEL[st.type]}{st.subtype ? ` · ${st.subtype}` : ""}</span>
            </h2>
            <div className="row-actions">
              <span className="ls-queue-head-meta">
                <span>{plural(st.schedule.slots.length, "Aufgabe", "Aufgaben")}</span>
                {st.schedule.total_min > 0 && <span>· {fmtMin(st.schedule.total_min)}</span>}
              </span>
              <StatusChip
                primary={!st.active ? { label: "inaktiv", tone: "danger" }
                  : { label: st.routing === "pull" ? "Pull"
                    : st.routing === "smart_auto" ? "Automatik" : "Vorschlag" }}
                extras={[st.schedule.slots.some((s) => s.pinned) && { label: "Handreihenfolge", icon: "pin" }]}
              />
              {office && st.schedule.slots.some((s) => s.pinned) && (
                <Button small minimal icon="pin" text="Handreihenfolge lösen"
                        onClick={() => freeOrder(st.id)} />
              )}
              <Button small minimal icon="arrow-right" text="Station"
                      onClick={() => navigate(`station/${st.id}`)} />
            </div>
          </div>
          {!isClosed && (
          <WorkQueue
            schedule={st.schedule}
            stationType={st.type}
            showKind={!kind}
            compact={simple}
            emptyText={`${st.label} ist frei — nichts zugeordnet.`}
            actions={{
              busyRef: busy,
              onStart: (s) => setState(s, "running"),
              onDone: (s) => setState(s, "done"),
              onReset: (s) => setState(s, "ready"),
              onRelease: office ? (s) => assign(s, null) : undefined,
              onMove: office ? (s, d) => move(st.id, st.schedule.slots, s, d) : undefined,
            }}
          />
          )}
        </Card>
        );
      })}

      {!visibleStations.length && (
        <NonIdealState icon="layout" title={stations.length ? "Keine Station passt zum Filter" : "Keine Station dieses Typs"}
          description={stations.length
            ? "Filter zurücksetzen, um alle Stationen wieder anzuzeigen."
            : "Stationen werden im Grundriss angelegt — dort bekommt jede ihren Typ, ihre Werkstoffe und ihre Zeiten."}
          action={stations.length
            ? <Button icon="reset" text="Filter zurücksetzen" onClick={() => { setSearch(""); setOnlyBusy(false); setAreaFilter("all"); setFocusedStation(null); }} />
            : <Button icon="edit" text="Grundriss bearbeiten" onClick={() => navigate("grundriss/admin")} />} />
      )}

      {/* ---------------- Der freie Vorrat ---------------- */}
      {pool.length === 0 ? (
        <p className="sub ls-pool-clear" role="status">
          Alles verteilt — kein Vorgang ohne Arbeitsplatz.
        </p>
      ) : (
      <section className="ui-section">
        <div className="ui-section-head">
          <h2 className="ui-section-title">Ohne Station</h2>
          <span className="ui-inline-actions">
            <span className="ui-section-count">{filteredPool.length}</span>
            <InfoHint label="Was ist der freie Vorrat?"
                      text="Was noch niemandem gehört. Der Vorschlag steht daneben; verteilt wird nur ausdrücklich." />
          </span>
        </div>
        {!filteredPool.length ? (
          <Callout compact icon="tick-circle" intent="success">
            Kein freier Vorgang passt zur Suche.
          </Callout>
        ) : (
          <div className="table-scroll">
          <HTMLTable compact striped className="data-table">
          <thead>
            <tr>
              <th>Aufgabe</th><th>Werkstoff</th><th className="num">Priorität</th>
              <th>Vorschlag</th><th>Aktion</th>
            </tr>
          </thead>
          <tbody>
            {filteredPool.map((r) => (
              <tr key={`${r.kind}:${r.ref}`}>
                <td>
                  <span className="mono">{r.ref}</span>{" "}
                  <StatusChip
                    primary={{ label: KIND_LABEL[r.kind], icon: KIND_ICON[r.kind] }}
                    extras={[
                      r.rush && { label: "Eil", tone: "danger", icon: "flash" },
                      r.priority.overdue && { label: "überfällig", tone: "danger", icon: "time" },
                    ]}
                  />
                  <div className="sub">{r.label}</div>
                  {(r.note || r.orders.length > 0) && (
                    <HintDetails title={r.note ? "Notiz & Aufträge" : "Aufträge"}>
                      {r.note && <p style={{ margin: "0 0 4px" }}>{r.note}</p>}
                      {r.orders.length > 0 && <div className="sub mono">{r.orders.join(", ")}</div>}
                    </HintDetails>
                  )}
                </td>
                <td>
                  {r.mat ? <>{r.mat_name || r.mat}{r.thk ? ` · ${r.thk} mm` : ""}</> : <span className="sub">—</span>}
                  <div className="sub">{r.kind === "cut" || r.kind === "pick" ? plural(r.units, "Platte", "Platten") : plural(r.units, "Position", "Positionen")}</div>
                </td>
                <td className="num">
                  <Tag minimal intent={priorityIntent(r.priority)} title={r.priority.summary}>{r.priority.score.toFixed(0)}</Tag>
                  <div className="sub">{r.priority.summary}</div>
                </td>
                <td>
                  {r.suggest_station_id != null ? (
                    <>
                      <b>{r.suggest_label}</b>
                      {r.suggest_reason && (
                        <HintDetails title="Begründung">
                          <p style={{ margin: 0 }}>{r.suggest_reason}</p>
                        </HintDetails>
                      )}
                    </>
                  ) : (
                    <span className="sub">{r.suggest_reason || "keine Station"}</span>
                  )}
                </td>
                <td>
                  {office ? <div className="row-actions">
                    <Button small icon="tick" text="Übernehmen"
                            disabled={r.suggest_station_id == null}
                            loading={busy === `${r.kind}:${r.ref}`}
                            onClick={() => assign(r, r.suggest_station_id)} />
                    <Button small minimal icon="exchange" aria-label="Andere Station wählen"
                            title="Andere Station wählen" onClick={() => setMoveFor(r)} />
                  </div> : <span className="sub">verteilt das Büro</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </HTMLTable>
        </div>
      )}
      </section>
      )}

      {/* ---------------- Vorrechnung ---------------- */}
      <Dialog isOpen={plan != null} onClose={() => setPlan(null)} icon="calculator"
              title="Verteilung — was passieren würde" style={{ width: 720 }}>
        <DialogBody>
          <p className="sub">
            Gerechnet, nicht getan. „Automatik" heißt: die Station hat sich dafür
            angemeldet. „Vorschlag" heißt: hier drückt ein Mensch.
          </p>
          {!plan?.length && <Callout compact icon="info-sign">Nichts zu verteilen.</Callout>}
          {plan?.map((p) => (
            <div key={`${p.kind}:${p.ref}`} className="plan-row">
              <div className="plan-head">
                <Tag minimal icon={KIND_ICON[p.kind]}>{KIND_LABEL[p.kind]}</Tag>
                <span className="mono">{p.ref}</span>
                <span className="bp5-icon-standard bp5-icon-arrow-right" />
                <b>{p.station_label || "— keine Station"}</b>
                <Tag minimal intent={p.mode === "auto" ? "success" : p.mode === "suggest" ? "primary" : "danger"}>
                  {p.mode === "auto" ? "Automatik" : p.mode === "suggest" ? "Vorschlag" : "keine"}
                </Tag>
              </div>
              <div className="rank-reason">{p.reason}</div>
              <OptionTable options={p.options} chosen={p.station_id} />
            </div>
          ))}
          {!!plan?.length && (
            <Button intent="primary" icon="tick" text="Alles übernehmen" fill
                    loading={planBusy} onClick={() => applyPlan()} />
          )}
        </DialogBody>
      </Dialog>

      {/* ---------------- Von Hand woandershin ---------------- */}
      <Dialog isOpen={moveFor != null} onClose={() => setMoveFor(null)} icon="exchange"
              title={moveFor ? `${moveFor.ref} zuordnen` : ""} style={{ width: 640 }}>
        <DialogBody>
          <p className="sub">
            Jede {TYPE_LABEL[KIND_STATION_TYPE[moveFor?.kind ?? "cut"]]}station mit ihren
            Zahlen — auch die ungeeigneten, mit ihrem Grund. Eine Station, die
            wortlos aus der Liste verschwindet, ist ein Rätsel.
          </p>
          <OptionTable options={moveFor?.options ?? []} chosen={moveFor?.suggest_station_id ?? null}
                       onPick={(id) => moveFor && assign(moveFor, id)} />
        </DialogBody>
      </Dialog>
    </PageFrame>
  );
}

function OptionTable({ options, chosen, onPick }: {
  options: StationOption[]; chosen: number | null; onPick?: (id: number) => void;
}) {
  if (!options.length) return null;
  return (
    <div className="table-scroll">
    <HTMLTable compact className="data-table option-table">
      <thead>
        <tr>
          <th>Station</th><th className="num">Schlange</th><th className="num">Arbeit</th>
          <th className="num">Weg</th><th className="num">fertig</th><th>Grund</th>
          {onPick && <th><span className="sr-only">Aktion</span></th>}
        </tr>
      </thead>
      <tbody>
        {options.map((o) => (
          <tr key={o.station_id} className={o.eligible ? (o.station_id === chosen ? "row-active" : "") : "row-muted"}>
            <td>
              <b>{o.label}</b>
              {o.station_id === chosen && <Tag minimal intent="primary">Vorschlag</Tag>}
              {!o.changeover && <Tag minimal intent="success">kein Rüsten</Tag>}
            </td>
            <td className="num">{fmtMin(o.queue_min)}</td>
            <td className="num">{o.minutes != null ? fmtMin(o.minutes) : "—"}</td>
            <td className="num">
              {o.route_m > 0 ? `${o.route_m.toLocaleString("de-DE", { maximumFractionDigits: 0 })} m` : "—"}
              {o.route_m > 0 && !o.route_exact && <span className="sub"> Luftlinie</span>}
            </td>
            <td className="num">{o.finish_min != null ? clockIn(o.finish_min) : "—"}</td>
            <td className="sub">{o.eligible ? o.reason : o.blockers.join(" · ")}</td>
            {onPick && (
              <td>
                <Button small disabled={!o.eligible} text="Hierhin"
                        onClick={() => onPick(o.station_id)} />
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </HTMLTable>
    </div>
  );
}
