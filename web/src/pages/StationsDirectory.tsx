import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Icon, IconName, InputGroup, Spinner, Tag } from "@blueprintjs/core";
import NonIdealState from "../components/NonIdealState";
import StationControlBar from "../components/StationControlBar";
import { MatName } from "../components/MaterialSelect";
import { api } from "../api";
import {
  MACHINE_LABEL, StationType, TYPE_LABEL, WorklistData, WorklistStation, fmtMin,
} from "../factory";
import { plural } from "../plural";
import { navigate } from "../router";
import { publishStations } from "../stationStore";
import { toastError } from "../toast";
import { PageFrame, Toolbar } from "../ui";

/* Arbeitsplätze — strukturierte Übersicht aller Stationen nach Bereich.
   Statt einer langen Seitenleisten-Liste sind Maschinen, Lager, Versand und
   Büro hier klar getrennt, durchsuchbar und direkt in ihr Cockpit zu öffnen. */

interface AreaGroupDef {
  type: StationType;
  title: string;
  shortLabel: string;
  icon: IconName;
  desc: string;
}

const GROUPS: AreaGroupDef[] = [
  {
    type: "production",
    title: "Maschinen & Fertigung",
    shortLabel: "Maschinen",
    icon: "cut",
    desc: "Schneidplotter, Wasserstrahl, Stanze und manuelle Nacharbeit.",
  },
  {
    type: "warehouse",
    title: "Lager & Kommissionierung",
    shortLabel: "Lager",
    icon: "box",
    desc: "Plattenregale, Hochregale, Kleinteilelager und Bereitstellung.",
  },
  {
    type: "shipping",
    title: "Versand & Packen",
    shortLabel: "Versand",
    icon: "truck",
    desc: "Packtische, Warenausgang und Versandplätze.",
  },
  {
    type: "accounting",
    title: "Büro & Steuerung",
    shortLabel: "Büro",
    icon: "briefcase",
    desc: "Arbeitsvorbereitung, Auftrags- und Versandbüro.",
  },
];

function stationRank(st: WorklistStation): number {
  if (!st.active) return 3;
  const running = st.schedule.slots.some((s) => s.state === "running" || s.started);
  if (running) return 0;
  if (st.schedule.slots.length > 0) return 1;
  return 2;
}

export default function StationsDirectory() {
  const [data, setData] = useState<WorklistData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [search, setSearch] = useState("");
  const [area, setArea] = useState<StationType | "all">("all");
  const [onlyBusy, setOnlyBusy] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const next = await api<WorklistData>("/api/factory/worklist");
      setData(next);
      if (next.stations?.length) {
        publishStations(next.stations.map((s) => ({
          id: s.id,
          label: s.label,
          type: s.type,
          active: s.active !== false,
          queue_jobs: s.schedule?.slots?.length ?? 0,
          queue_min: s.schedule?.total_min ?? 0,
        })));
      }
      setUpdatedAt(new Date());
      setError("");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!silent) { setError(msg); toastError(msg); }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const stations = data?.stations ?? [];

  const countsByType = useMemo(() => {
    const out: Record<StationType, { total: number; busy: number; running: number }> = {
      production: { total: 0, busy: 0, running: 0 },
      warehouse: { total: 0, busy: 0, running: 0 },
      shipping: { total: 0, busy: 0, running: 0 },
      accounting: { total: 0, busy: 0, running: 0 },
    };
    for (const s of stations) {
      const b = out[s.type];
      if (!b) continue;
      b.total++;
      if (s.schedule.slots.length > 0) b.busy++;
      if (s.schedule.slots.some((sl) => sl.state === "running" || sl.started)) b.running++;
    }
    return out;
  }, [stations]);

  const totalBusy = useMemo(
    () => stations.filter((s) => s.schedule.slots.length > 0).length,
    [stations],
  );

  const maxQueueMin = useMemo(
    () => Math.max(60, ...stations.map((s) => s.schedule.total_min || 0)),
    [stations],
  );

  const sections = useMemo(() => {
    const q = search.trim().toLowerCase();
    return GROUPS
      .filter((g) => area === "all" || g.type === area)
      .map((g) => {
        const items = stations
          .filter((st) => st.type === g.type)
          .filter((st) => !onlyBusy || st.schedule.slots.length > 0)
          .filter((st) => {
            if (!q) return true;
            if (st.label.toLowerCase().includes(q)) return true;
            if ((st.subtype || "").toLowerCase().includes(q)) return true;
            if (TYPE_LABEL[st.type].toLowerCase().includes(q)) return true;
            if ((st.last_mat || "").toLowerCase().includes(q)) return true;
            return st.schedule.slots.some((sl) =>
              `${sl.ref} ${sl.label} ${sl.mat ?? ""} ${sl.mat_name ?? ""} ${(sl.orders ?? []).join(" ")}`.toLowerCase().includes(q),
            );
          })
          .sort((a, b) =>
            stationRank(a) - stationRank(b)
            || b.schedule.slots.length - a.schedule.slots.length
            || a.label.localeCompare(b.label, "de"),
          );
        const busyCount = items.filter((s) => s.schedule.slots.length > 0).length;
        return { ...g, items, busyCount };
      })
      .filter((sec) => sec.items.length > 0);
  }, [stations, area, onlyBusy, search]);

  if (loading && !data) return <div className="twin-center"><Spinner size={36} /></div>;
  if (error && !data) return <div className="twin-center twin-error">{error}</div>;
  if (!data) return null;

  return (
    <PageFrame
      title="Arbeitsplätze"
      sub="Alle Stationen nach Bereich — ein Klick öffnet das jeweilige Stations-Cockpit."
      actions={<>
        <Button small minimal icon="refresh" text="Aktualisieren" loading={loading} onClick={() => load()} />
        <a className="bp5-button bp5-small bp5-minimal" href="/twin/" target="_blank" rel="noopener noreferrer">
          <Icon icon="layout" size={14} aria-hidden="true" />
          <span className="bp5-button-text">Grundriss</span>
        </a>
      </>}
    >
      <StationControlBar active="arbeitsplaetze" />

      <div className="wp-summary-grid" role="group" aria-label="Bereiche in Zahlen">
        {GROUPS.map((g) => {
          const c = countsByType[g.type];
          const active = area === g.type;
          return (
            <button
              key={g.type}
              type="button"
              className={`wp-summary-card${active ? " is-active" : ""}`}
              aria-pressed={active}
              onClick={() => setArea((cur) => (cur === g.type ? "all" : g.type))}
            >
              <div className="wp-summary-head">
                <Icon icon={g.icon} size={14} aria-hidden="true" />
                <span>{g.shortLabel}</span>
              </div>
              <div className="wp-summary-nums">
                <strong>{c.busy}</strong>
                <span>/ {c.total} aktiv</span>
              </div>
              <div className="sub">
                {c.running > 0 ? `${c.running} läuft gerade` : c.busy > 0 ? "Aufträge bereit" : "derzeit frei"}
              </div>
            </button>
          );
        })}
      </div>

      <Toolbar meta={updatedAt ? `aktualisiert ${updatedAt.toLocaleTimeString("de-DE")}` : undefined}>
        <InputGroup
          small
          leftIcon="search"
          placeholder="Station, Maschine, Werkstoff, Auftrag …"
          aria-label="Arbeitsplätze durchsuchen"
          style={{ width: 250, maxWidth: "100%" }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          rightElement={search ? <Button minimal icon="cross" aria-label="Suche leeren" onClick={() => setSearch("")} /> : undefined}
        />
        <div className="ui-filter-chips" role="group" aria-label="Bereich wählen">
          <button
            type="button"
            className={"filter-chip" + (area === "all" ? " filter-chip-on" : "")}
            onClick={() => setArea("all")}
          >
            Alle <span className="filter-count">{stations.length}</span>
          </button>
          {GROUPS.map((g) => (
            <button
              key={g.type}
              type="button"
              className={"filter-chip" + (area === g.type ? " filter-chip-on" : "")}
              onClick={() => setArea(g.type)}
            >
              {g.shortLabel} <span className="filter-count">{countsByType[g.type].total}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className={"filter-chip" + (onlyBusy ? " filter-chip-on" : "")}
          onClick={() => setOnlyBusy((v) => !v)}
        >
          Nur mit Arbeit <span className="filter-count">{totalBusy}</span>
        </button>
      </Toolbar>

      {sections.length === 0 ? (
        <NonIdealState
          icon="search"
          title="Kein Arbeitsplatz passt zum Filter"
          description="Suche oder Bereichsfilter zurücksetzen, um alle Arbeitsplätze zu sehen."
          action={
            <Button
              icon="reset"
              text="Filter zurücksetzen"
              onClick={() => { setSearch(""); setArea("all"); setOnlyBusy(false); }}
            />
          }
        />
      ) : (
        <div className="wp-sections">
          {sections.map((sec) => (
            <section key={sec.type} className="wp-section" aria-labelledby={`wp-sec-${sec.type}`}>
              <div className="wp-section-head">
                <div>
                  <h2 id={`wp-sec-${sec.type}`} className="wp-section-title">
                    <Icon icon={sec.icon} size={15} aria-hidden="true" />
                    <span>{sec.title}</span>
                    <span className="wp-section-count">
                      {sec.busyCount}/{sec.items.length} aktiv
                    </span>
                  </h2>
                  <p className="sub wp-section-desc">{sec.desc}</p>
                </div>
              </div>
              <div className="wp-grid">
                {sec.items.map((st) => (
                  <StationCard key={st.id} station={st} maxQueueMin={maxQueueMin} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </PageFrame>
  );
}

function StationCard({ station: st, maxQueueMin }: { station: WorklistStation; maxQueueMin: number }) {
  const slots = st.schedule.slots;
  const count = slots.length;
  const first = slots[0];
  const running = slots.some((s) => s.state === "running" || s.started);
  const lateCount = st.schedule.late?.length ?? 0;
  const totalMin = st.schedule.total_min || 0;
  const denom = st.capacity_min_per_day > 0 ? st.capacity_min_per_day : maxQueueMin;
  const loadPct = count === 0 ? 0 : Math.min(100, Math.round((totalMin / Math.max(30, denom)) * 100));

  const subtitle = st.type === "production" && st.machine_kind
    ? MACHINE_LABEL[st.machine_kind]
    : st.subtype || TYPE_LABEL[st.type];

  const statusTag = !st.active
    ? { label: "Inaktiv", intent: "danger" as const }
    : running
      ? { label: "Läuft", intent: "success" as const }
      : count > 0
        ? { label: "Bereit", intent: "primary" as const }
        : { label: "Frei", intent: "none" as const };

  return (
    <button
      type="button"
      className={`wp-card${count === 0 ? " is-idle" : ""}${!st.active ? " is-inactive" : ""}`}
      style={{ borderLeftColor: st.colour || "var(--gimel-accent)" }}
      onClick={() => navigate(`station/${st.id}`)}
    >
      <div className="wp-card-top">
        <div className="wp-card-title">
          <span className="wp-card-name">
            {running && <span className="ls-live-pulse" aria-hidden="true" />}
            <strong>{st.label}</strong>
          </span>
          <span className="sub">{subtitle}</span>
        </div>
        <Tag minimal intent={statusTag.intent}>{statusTag.label}</Tag>
      </div>

      <div className="wp-card-body">
        {first ? (
          <>
            <div className="wp-card-next">
              <span className="mono">{first.ref}</span>
              <span className="wp-card-next-what">
                {first.mat_name || first.mat
                  ? `${first.mat_name || first.mat}${first.thk ? ` · ${first.thk.toLocaleString("de-DE")} mm` : ""}`
                  : first.label}
              </span>
            </div>
            <div className="wp-card-metrics">
              <span>{plural(count, "Aufgabe", "Aufgaben")}</span>
              {totalMin > 0 && <span className="mono">· {fmtMin(totalMin)}</span>}
              {lateCount > 0 && (
                <Tag minimal intent="danger" style={{ marginLeft: "auto" }}>
                  {lateCount}× Zusage reißt
                </Tag>
              )}
            </div>
            <div className="ls-tile-bar" aria-hidden="true">
              <div
                className={`ls-tile-bar-fill${lateCount > 0 ? " is-danger" : loadPct >= 80 ? " is-warn" : ""}`}
                style={{ width: `${Math.max(8, loadPct)}%` }}
              />
            </div>
          </>
        ) : (
          <div className="wp-card-empty">
            <span>Keine offenen Aufgaben</span>
            {st.last_mat && (
              <span className="sub">
                Rüststand: <MatName id={st.last_mat} />{st.last_thk ? ` · ${st.last_thk.toLocaleString("de-DE")} mm` : ""}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="wp-card-foot">
        <span className="sub">
          {st.routing === "smart_auto" ? "Automatik" : st.routing === "pull" ? "Pull" : "Vorschlag"}
        </span>
        <span className="wp-card-open">
          Cockpit öffnen <Icon icon="chevron-right" size={12} aria-hidden="true" />
        </span>
      </div>
    </button>
  );
}
