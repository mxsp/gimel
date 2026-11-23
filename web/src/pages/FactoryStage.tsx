import { PageLoading, SectionError } from "../components/PageStates";
import { useCallback, useEffect, useState } from "react";
import { Button, Callout, Dialog, DialogBody, DialogFooter, HTMLSelect, HTMLTable, Icon,
         InputGroup, Radio, RadioGroup, Tag } from "@blueprintjs/core";
import NonIdealState from "../components/NonIdealState";
import { api, fmtDate, fmtDateTime } from "../api";
import { navigate } from "../router";
import { toastError } from "../toast";
import { undoable } from "../undo";
import { LocationChips, OffcutChips, StockLocationDialog, offcutPlace, offcutSize } from "../components/StockLocations";
import { fmtMin, MACHINE_LABEL, StagingData, OffcutRow, StockLocationRow, StagingMaterial, StagingRow, StagingStation } from "../factory";
import { plural } from "../plural";
import { FilterGroup, FilterPopover, FilterTag, PageFrame, Toolbar } from "../ui";
import { useMaterialName } from "../components/MaterialSelect";

/* Kommissionieren und bereitstellen — ein Bildschirm für einen Vorgang.

   „Kommissionierung" und „Bereitstellen" waren zwei Seiten für dieselbe
   Tatsache: die Platten liegen an der Maschine, nicht mehr im Regal. Die
   eine Seite sortierte nach Regal, die andere nach Maschine; gebucht wurde
   zweimal dasselbe. Hier steht beides zusammen:

   * **Nach Werkstoff** — so wird wirklich geholt: ein Weg je Regal, mit
     Bestand daneben. Eine Kommissionierliste ohne Bestand ist eine
     Wunschliste.
   * **Je Maschine** — die Reihenfolge, in der die Platten ankommen, mit
     Formaten, Termin und Rüstwechsel-Hinweis.

   Der Klick „Bereitstellen" ist kein Statuswechsel — er sagt, dass
   physische Arbeit passiert ist, und hält fest, wann, von wem und aus
   welchem Lagerort. Den Ort schlägt der Server vor (exakte Dicke, genug
   Platten, kürzester Weg); der Mensch kann jeden anderen wählen oder
   „unbekannt" lassen. Zurücknehmen geht, solange der Auftrag nicht läuft.

   Werkzeug drumherum: Suche über Nummer, Werkstoff und Kunde, drei
   Sortierungen für den Weg durchs Regal, ein Sammelknopf je Maschine (eine
   Rückgängig-Aktion für den ganzen Stapel) und der Bestandshinweis, bevor
   jemand für Platten losgeht, die nicht im Regal liegen. */

type SortMode = "standard" | "termin" | "platten";

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: "standard", label: "Sortierung: Eil / Termin" },
  { value: "termin", label: "Sortierung: Termin" },
  { value: "platten", label: "Sortierung: Umfang" },
];

const fmt = (f: [number, number, number]) =>
  `${f[2]}× ${f[0]}×${f[1]}`;

export default function FactoryStage() {
  const matName = useMaterialName();
  const [data, setData] = useState<StagingData | null>(null);
  const [auto, setAuto] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [busyNo, setBusyNo] = useState<string | null>(null);
  const [locEdit, setLocEdit] = useState<{ mat: string; name: string; stock: number } | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortMode>("standard");
  const [station, setStation] = useState("all");
  const [stageFor, setStageFor] = useState<StagingRow | null>(null);
  const [stagedOpen, setStagedOpen] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(["keine"]));
  const toggleGroup = (key: string) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  // Eine ausdrücklich gewählte Station immer zeigen, auch wenn sie sonst zugeklappt startet.
  useEffect(() => {
    if (station === "all") return;
    setCollapsed((prev) => {
      if (!prev.has(station)) return prev;
      const next = new Set(prev);
      next.delete(station);
      return next;
    });
  }, [station]);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const d = await api<StagingData>("/api/factory/staging");
      setData(d);
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
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(() => { if (!document.hidden) load(true); }, 30_000);
    return () => clearInterval(t);
  }, [auto, load]);

  const stage = (row: StagingRow, staged: boolean, locationId: number | null = null) => {
    if (staged && row.started) return;
    setBusyNo(row.no);
    undoable({
      run: () => api(`/api/production/work-orders/${row.no}/stage`,
                     { method: "POST",
                       body: JSON.stringify(staged
                         ? { staged, location_id: locationId }
                         : { staged }) }),
      undo: () => api(`/api/production/work-orders/${row.no}/stage`,
                      { method: "POST", body: JSON.stringify({ staged: !staged }) }),
      done: staged ? `${row.no}: Material bereitgestellt.` : `${row.no}: Bereitstellung zurückgenommen.`,
      undone: staged ? `${row.no} steht wieder in der Bereitstellungsliste.` : `${row.no} wieder als bereitgestellt gebucht.`,
      after: () => { setBusyNo(null); return load(true); },
    });
  };

  /** Alle wartenden Innenaufträge einer Station auf einmal — ein Vorgang,
   *  eine Rücknahme. Scheitert eine Einzelbuchung (etwa inzwischen gestartet),
   *  bleiben die übrigen dran; die Meldung sagt, was durch ist. */
  const stageMany = (key: string, rows: StagingRow[]) => {
    if (!rows.length) return;
    setBusyNo(key);
    let stagedNos: string[] = [];
    const doOne = (no: string, staged: boolean, locationId: number | null = null) =>
      api(`/api/production/work-orders/${no}/stage`,
          { method: "POST",
            body: JSON.stringify(staged ? { staged, location_id: locationId } : { staged }) });
    undoable({
      run: async () => {
        stagedNos = [];
        const failed: string[] = [];
        for (const r of rows) {
          // Der Sammelknopf nimmt je Auftrag den empfohlenen Ort — oder
          // keinen, wenn für den Werkstoff keiner hinterlegt ist.
          try { await doOne(r.no, true, r.recommended_location_id); stagedNos.push(r.no); }
          catch { failed.push(r.no); }
        }
        if (!stagedNos.length) {
          throw new Error(`Keine Bereitstellung gebucht (${failed.length} fehlgeschlagen).`);
        }
        return stagedNos.length;
      },
      undo: async () => {
        for (const no of stagedNos) await doOne(no, false).catch(() => undefined);
      },
      done: () => {
        const failed = rows.length - stagedNos.length;
        return `${stagedNos.length} von ${rows.length} Innenaufträgen bereitgestellt` +
               (failed ? ` — ${failed} fehlgeschlagen.` : ".");
      },
      undone: `${stagedNos.length} Bereitstellungen zurückgenommen.`,
      after: () => { setBusyNo(null); return load(true); },
    });
  };

  if (loading && !data) return <PageLoading />;
  if (error && !data) return <SectionError message={error} onRetry={() => load()} />;
  if (!data) return null;

  const materials = data.materials ?? {};
  const q = query.trim().toLowerCase();
  const keyOf = (r: StagingRow) => r.station_id != null ? `s${r.station_id}` : "keine";
  const matches = (r: StagingRow) =>
    !q ||
    r.no.toLowerCase().includes(q) ||
    (r.mat_name || "").toLowerCase().includes(q) ||
    r.mat.toLowerCase().includes(q) ||
    r.orders.some((o) => (o.customer || o.order_no).toLowerCase().includes(q));

  const allOpen = data.rows.filter((r) => !r.staged);
  const searched = allOpen.filter(matches);
  const open = searched.filter((r) => station === "all" || keyOf(r) === station);
  const byStation = new Map<string, StagingRow[]>();
  for (const r of open) {
    const key = keyOf(r);
    const list = byStation.get(key) ?? [];
    list.push(r);
    byStation.set(key, list);
  }
  for (const list of byStation.values()) {
    if (sort === "termin") {
      list.sort((a, b) => (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999"));
    } else if (sort === "platten") {
      list.sort((a, b) => b.n_plates - a.n_plates || b.n_parts - a.n_parts);
    }
    // „standard" lässt die Reihenfolge des Servers stehen: Eil, dann Termin.
  }
  const stationLabel = (key: string) => {
    if (key === "keine") return "Ohne Maschine";
    const st = data.stations.find((s) => `s${s.id}` === key);
    return st?.label || key;
  };
  const stationSub = (key: string) => {
    if (key === "keine") return "erst zuordnen — dann bereitstellen";
    const st = data.stations.find((s) => `s${s.id}` === key);
    return st ? MACHINE_LABEL[st.machine_kind] || "Maschine" : "";
  };
  const stationOf = (key: string): StagingStation | undefined =>
    key === "keine" ? undefined : data.stations.find((s) => `s${s.id}` === key);
  // Gruppen in Stationsreihenfolge, „Ohne Maschine" hinten.
  const keys = [
    ...data.stations.filter((s) => byStation.has(`s${s.id}`)).map((s) => `s${s.id}`),
    ...(byStation.has("keine") ? ["keine"] : []),
  ];
  const stationKeys = [
    ...data.stations.filter((s) => searched.some((r) => keyOf(r) === `s${s.id}`)).map((s) => `s${s.id}`),
    ...(searched.some((r) => keyOf(r) === "keine") ? ["keine"] : []),
  ];
  const stagedRows = data.rows.filter((r) => r.staged && (station === "all" || keyOf(r) === station));
  const hidden = allOpen.length - searched.length;
  const shortMats = Object.values(materials).filter((m) => m.short).length;

  // Rüstliste nach Werkstoff und Dicke — dieselbe Zusammenfassung, die vorher
  // die eigene Kommissionierseite zeigte. Sie wird aus denselben Zeilen
  // gerechnet wie die Maschinengruppen; es gibt keine zweite Wahrheit.
  const byMaterial = new Map<string, {
    key: string; mat: string; mat_name: string; thk: number;
    plates: number; staged: number; jobs: string[]; stations: string[];
    locations: StockLocationRow[]; offcuts: OffcutRow[];
  }>();
  for (const r of data.rows) {
    const key = `${r.mat}|${r.thk}`;
    let e = byMaterial.get(key);
    if (!e) {
      e = { key, mat: r.mat, mat_name: r.mat_name || r.mat, thk: r.thk,
            plates: 0, staged: 0, jobs: [], stations: [], locations: r.locations ?? [], offcuts: [] };
      byMaterial.set(key, e);
    }
    if (r.staged) e.staged += r.n_plates;
    else {
      // Volle Platten zählen gegen den Bestand, Reststücke stehen daneben.
      e.plates += fullPlates(r);
      e.offcuts.push(...(r.offcuts ?? []));
      e.jobs.push(r.no);
    }
    if (r.station_label && !e.stations.includes(r.station_label)) e.stations.push(r.station_label);
  }
  const materialRows = [...byMaterial.values()]
    .sort((a, b) => (b.plates + b.staged) - (a.plates + a.staged) || a.mat.localeCompare(b.mat));

  return (
    <PageFrame title="Kommissionierung"
               sub="Material aus dem Regal an die Maschine — nach Werkstoff und je Maschine."
               help={[{ title: "Ein Vorgang", text: "Kommissionieren und Bereitstellen sind derselbe Griff: die Platten liegen an der Maschine, nicht mehr im Regal. Der Haken hält Zeit und Namen fest und lässt sich zurücknehmen, solange nicht geschnitten wird." }]}
               actions={<>
                 <div className="grundriss-switch">
                   <Button small icon="layout" text="Grundriss" onClick={() => navigate("grundriss")} />
                   <Button small icon="flame" text="Optimierung" onClick={() => navigate("grundriss/optimierung")} />
                 </div>
               </>}>
      <Toolbar meta={updatedAt && <span>
                 aktualisiert {fmtDateTime(updatedAt.toISOString())}
                 {hidden > 0 && ` · ${hidden} durch Suche ausgeblendet`}
               </span>}
               end={<>
                 <Button small icon={auto ? "pause" : "play"} text={auto ? "Auto aus" : "Auto an"}
                   onClick={() => setAuto(!auto)} title="Aktualisierung alle 30 Sekunden" />
                 <Button small icon="refresh" text="Aktualisieren" loading={loading} onClick={() => load()} />
               </>}>
        <InputGroup small leftIcon="search" className="stage-search"
          placeholder="Nr., Werkstoff, Kunde…"
          value={query} onChange={(e) => setQuery(e.target.value)} />
        <FilterPopover active={(station !== "all" ? 1 : 0) + (sort !== "standard" ? 1 : 0)}
                       onClear={() => { setStation("all"); setSort("standard"); }}>
          <FilterGroup label="Station">
            <HTMLSelect className="stage-station" value={station} aria-label="Station filtern"
              onChange={(e) => setStation(e.currentTarget.value)}>
              <option value="all">Alle Stationen ({searched.length})</option>
              {stationKeys.map((key) => (
                <option key={key} value={key}>
                  {stationLabel(key)} ({searched.filter((r) => keyOf(r) === key).length})
                </option>
              ))}
            </HTMLSelect>
          </FilterGroup>
          <FilterGroup label="Sortierung">
            <HTMLSelect className="stage-sort" value={sort} options={SORT_OPTIONS} aria-label="Sortierung"
              onChange={(e) => setSort(e.currentTarget.value as SortMode)} />
          </FilterGroup>
        </FilterPopover>
        {station !== "all" && <FilterTag label={stationLabel(station)} onRemove={() => setStation("all")} />}
        {sort !== "standard" && (
          <FilterTag label={(SORT_OPTIONS.find((option) => option.value === sort)?.label ?? sort).replace("Sortierung: ", "")}
                     onRemove={() => setSort("standard")} />
        )}
      </Toolbar>

      <div className="ui-facts" role="group" aria-label="Kommissionierung in Zahlen">
        <div className="ui-fact">
          <span className="ui-fact-label">Innenaufträge warten</span>
          <span className="ui-fact-value">{data.counts.open}</span>
        </div>
        <div className="ui-fact">
          <span className="ui-fact-label">Platten zu holen</span>
          <span className="ui-fact-value">{data.counts.plates}</span>
        </div>
        <div className="ui-fact">
          <span className="ui-fact-label">bereitgestellt</span>
          <span className="ui-fact-value">{data.counts.staged}</span>
        </div>
        {shortMats > 0 && (
          <div className="ui-fact">
            <span className="ui-fact-label">Werkstoffe knapp</span>
            <span className="ui-fact-value stage-short-count">{shortMats}</span>
            <span className="sub">unter Bedarf</span>
          </div>
        )}
      </div>

      <details className="stage-staged stage-materials" open>
        <summary>
          <span className="stage-dot" style={{ background: "var(--g-info)" }} />
          <b>Nach Werkstoff</b>
          <span className="stage-count">{materialRows.length}</span>
          <span className="sub">so wird geholt — ein Weg je Regal, mit Bestand</span>
        </summary>
        {materialRows.length === 0 ? (
          <p className="stage-empty sub">Nichts zu holen — alle Platten stehen an ihrer Maschine.</p>
        ) : (
          <div className="table-scroll">
            <HTMLTable className="data-table stage-table" striped compact>
              <thead>
                <tr>
                  <th>Werkstoff</th><th className="num">Platten</th>
                  <th className="num">Bestand</th><th>Lagerort</th><th>Maschinen</th><th>Innenaufträge</th>
                </tr>
              </thead>
              <tbody>
                {materialRows.map((m) => {
                  const info = materials[m.mat];
                  return (
                    <tr key={m.key} className={info?.short ? "row-dirty" : undefined}>
                      <td>
                        <b>{m.mat_name}</b>
                        <span className="sub"> · {m.thk.toLocaleString("de-DE")} mm</span>
                        {/* Der Schlüssel ist für die Suche da; in „Einfach" reicht der Name. */}
                        <div className="sub mono ui-detail-only">{m.mat}</div>
                      </td>
                      <td className="num">
                        <b>{m.plates}</b>
                        {m.offcuts.length > 0 && (
                          <div className="sub offcut-ink">+{m.offcuts.length} Reststück{m.offcuts.length > 1 ? "e" : ""}</div>
                        )}
                        {m.staged > 0 && <div className="sub">+{m.staged} bereitgestellt</div>}
                      </td>
                      <td className="num">
                        {info ? info.stock : "—"}
                        {info?.short && <Tag minimal intent="danger">reicht nicht</Tag>}
                      </td>
                      <td className="stage-loc-cell">
                        {(m.plates > 0 || m.offcuts.length === 0) && <LocationChips locations={m.locations} />}
                        {m.offcuts.length > 0 && <div><OffcutChips offcuts={m.offcuts} /></div>}
                        <Button small minimal icon="edit" aria-label={`Lagerorte von ${m.mat_name} bearbeiten`}
                          title="Lagerorte bearbeiten"
                          onClick={() => setLocEdit({ mat: m.mat, name: m.mat_name, stock: info?.stock ?? 0 })} />
                        {info && m.locations.length > 0 && m.locations.reduce((a, l) => a + l.qty, 0) < m.plates && (
                          <div className="stage-short-line">Im Regal verortet weniger als Bedarf ({m.plates} Pl.)</div>
                        )}
                      </td>
                      <td className="sub">{m.stations.length ? m.stations.join(", ") : "noch keine Maschine"}</td>
                      <td className="sub mono">
                        {m.jobs.slice(0, 6).join(", ")}
                        {m.jobs.length > 6 ? ` +${m.jobs.length - 6}` : ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </HTMLTable>
          </div>
        )}
      </details>

      {keys.length === 0 ? (
        q ? (
          <NonIdealState icon="search" title="Nichts gefunden"
            description={`Kein wartender Innenauftrag passt zu „${query}“.`} />
        ) : station !== "all" ? (
          <NonIdealState icon="filter-remove" title="Nichts in dieser Station"
            description={`${stationLabel(station)} hat gerade nichts bereitzustellen.`}
            action={<Button text="Alle Stationen" onClick={() => setStation("all")} />} />
        ) : (
          <NonIdealState icon="cube" title="Nichts bereitzustellen"
            description="Jede Maschine hat ihr Material — der Sammellauf legt neue Innenaufträge an, sobald Aufträge freigegeben sind." />
        )
      ) : (
        <div className="stage-groups">
          {keys.map((key) => {
            const rows = byStation.get(key) ?? [];
            const plates = rows.reduce((a, r) => a + r.n_plates, 0);
            const minutes = rows.reduce((a, r) => a + (r.planned_min || 0), 0);
            const st = stationOf(key);
            const shortHere = rows.filter((r) => materials[r.mat]?.short).length;
            return (
              <section key={key} id={`stage-col-${key}`} tabIndex={-1} className="stage-group">
                <header className="stage-group-head">
                  <Button className="stage-group-toggle" small minimal
                    icon={collapsed.has(key) ? "chevron-right" : "chevron-down"}
                    aria-expanded={!collapsed.has(key)}
                    aria-label={`${stationLabel(key)} ${collapsed.has(key) ? "aufklappen" : "zuklappen"}`}
                    onClick={() => toggleGroup(key)} />
                  <div className="stage-group-id">
                    <span className="stage-dot" style={{ background: key === "keine" ? "var(--g-muted)" : "var(--g-info)" }} />
                    <div>
                      <h2>{stationLabel(key)}</h2>
                      <span className="sub">{stationSub(key)}</span>
                    </div>
                  </div>
                  <div className="stage-group-stats">
                    <span>{plural(rows.length, "Auftrag", "Aufträge")}</span>
                    <span><b>{plates}</b> Pl.</span>
                    <span><b>{fmtMin(minutes)}</b></span>
                    {st?.last_mat && (
                      <span className="stage-group-setup" title="Zuletzt an dieser Maschine aufgespannt">
                        zuletzt: {matName(st.last_mat)} · {st.last_thk?.toLocaleString("de-DE")} mm
                      </span>
                    )}
                    {shortHere > 0 && (
                      <Tag minimal intent="warning" icon="warning-sign"
                        title="Mindestens ein Werkstoff reicht nicht für alle offenen Platten">
                        {shortHere} knapp
                      </Tag>
                    )}
                  </div>
                  {rows.length > 1 && !collapsed.has(key) && (
                    <Button small icon="cube" text="Alle bereitstellen"
                      loading={busyNo === key}
                      title="Alle Innenaufträge dieser Station auf einmal bereitstellen — je Auftrag mit dem empfohlenen Lagerort, eine Rücknahme für den ganzen Stapel"
                      onClick={() => stageMany(key, rows)} />
                  )}
                </header>
                {!collapsed.has(key) && (
                  <div className="table-scroll">
                    <HTMLTable className="data-table stage-table" striped compact>
                      <thead>
                        <tr>
                          <th>Innenauftrag</th><th>Werkstoff</th><th>Holen aus</th><th>Formate</th>
                          <th className="num">Platten</th><th className="num">Teile</th><th className="num">Zeit</th>
                          <th>Termin</th><th>Kunden</th><th><span className="sr-only">Aktion</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r) => (
                          <StageRow key={r.no} row={r} busy={busyNo === r.no}
                            setup={st?.last_mat ? { mat: st.last_mat, thk: st.last_thk ?? 0 } : undefined}
                            matInfo={materials[r.mat]}
                            onStage={() => setStageFor(r)} />
                        ))}
                      </tbody>
                    </HTMLTable>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      <details className="stage-staged" open={stagedOpen}
        onToggle={(e) => setStagedOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary>
          <span className="stage-dot" style={{ background: "var(--g-success)" }} />
          <b>Bereitgestellt</b>
          <span className="stage-count">{stagedRows.length}</span>
          <span className="sub">Material an der Maschine — wartet auf Start</span>
        </summary>
        {stagedRows.length === 0 ? (
          <p className="stage-empty sub">
            {station === "all" ? "Noch nichts bereitgestellt." : `Für ${stationLabel(station)} noch nichts bereitgestellt.`}
          </p>
        ) : (
          <div className="table-scroll">
            <HTMLTable className="data-table stage-table" striped compact>
              <thead>
                <tr>
                  <th>Innenauftrag</th><th>Werkstoff</th><th>Holen aus</th>
                  <th className="num">Platten</th><th className="num">Teile</th><th className="num">Zeit</th>
                  <th>Bereitgestellt</th><th><span className="sr-only">Aktion</span></th>
                </tr>
              </thead>
              <tbody>
                {stagedRows.map((r) => (
                  <tr key={r.no}>
                    <td className="stage-no">
                      <b className="mono">{r.no}</b>{" "}
                      {r.rush && <Tag minimal intent="danger">Eil</Tag>}{" "}
                      {r.started && <Tag minimal intent="primary">läuft</Tag>}
                    </td>
                    <td>{r.mat_name || r.mat} · {r.thk.toLocaleString("de-DE")} mm</td>
                    <td className={r.staged_location ? "stage-from" : "stage-from sub"}>
                      {r.staged_location || "Ort unbekannt"}
                    </td>
                    <td className="num">{r.n_plates}</td>
                    <td className="num">{r.n_parts}</td>
                    <td className="num">{fmtMin(r.planned_min)}</td>
                    <td className="sub" title={r.staged_by || undefined}>
                      {r.started ? "in Arbeit" : fmtDateTime(r.staged_at ?? "")}
                      {r.staged_by && ` · ${r.staged_by}`}
                    </td>
                    <td>
                      {!r.started && (
                        <Button small minimal icon="undo" text="Zurücknehmen"
                          loading={busyNo === r.no}
                          title="Doch nicht bereitgestellt — zurück in die Liste"
                          onClick={() => stage(r, false)} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </HTMLTable>
          </div>
        )}
      </details>
      {stageFor && (
        <StageLocationDialog row={stageFor}
          onClose={() => setStageFor(null)}
          onConfirm={(locationId) => {
            const row = stageFor;
            setStageFor(null);
            stage(row, true, locationId);
          }} />
      )}
      {locEdit && (
        <StockLocationDialog mat={locEdit.mat} matName={locEdit.name} stock={locEdit.stock}
          onClose={(changed) => { setLocEdit(null); if (changed) load(true); }} />
      )}
    </PageFrame>
  );
}

/* -------------------------------------------------------------------------- */

function StageRow({ row, busy, setup, matInfo, onStage }: {
  row: StagingRow; busy: boolean; onStage: () => void;
  setup?: { mat: string; thk: number };
  matInfo?: StagingMaterial;
}) {
  const overdue = row.due_date && new Date(row.due_date).getTime() < Date.now();
  const changeover = setup != null &&
    (row.mat !== setup.mat || Math.abs(row.thk - setup.thk) > 0.005);
  const customers = row.orders.map((o) => o.customer || o.order_no);
  const formats = row.full_formats ?? row.formats;
  const shownFormats = formats.slice(0, 3);
  const offs = row.offcuts ?? [];
  return (
    <tr>
      <td className="stage-no">
        <b className="mono">{row.no}</b>{" "}
        {row.rush && <Tag minimal intent="danger">Eil</Tag>}{" "}
        {row.status === "running" && <Tag minimal intent="primary">läuft</Tag>}
        {changeover && (
          <span className="stage-mark" title={`Rüstwechsel — zuletzt: ${setup!.mat} ${setup!.thk.toLocaleString("de-DE")} mm`}>
            <Icon icon="refresh" size={12} />
          </span>
        )}
        {matInfo?.short && (
          <Tag minimal intent="warning" icon="warning-sign" className="stage-short-tag"
            title={`Im Regal: ${matInfo.stock} Pl. · Bedarf offen: ${matInfo.demand} Pl.`}>
            knapp
          </Tag>
        )}
      </td>
      <td>{row.mat_name || row.mat} · {row.thk.toLocaleString("de-DE")} mm</td>
      <td className="stage-from">
        {fullPlates(row) === 0 && offs.length > 0 ? <OffcutChips offcuts={offs} /> : (
          <>
            <LocationChips locations={row.locations} compact />
            {offs.length > 0 && <div className="stage-offcuts"><OffcutChips offcuts={offs} /></div>}
          </>
        )}
      </td>
      <td>
        <span className="stage-formats">
          {shownFormats.map((f, i) => <span key={i} className="stage-fmt">{fmt(f)}</span>)}
          {formats.length > 3 && (
            <span className="stage-fmt" title={formats.map(fmt).join(" · ")}>+{formats.length - 3}</span>
          )}
          {!formats.length && !offs.length && <span className="sub">unausgewiesen</span>}
        </span>
      </td>
      <td className="num">
        {fullPlates(row)}
        {offs.length > 0 && <div className="sub offcut-ink" title="aus Reststück — keine volle Platte">+{offs.length} Rest</div>}
      </td>
      <td className="num">{row.n_parts}</td>
      <td className="num mono">{fmtMin(row.planned_min)}</td>
      <td className={"stage-due" + (overdue ? " stage-due-over" : "")}>
        {row.due_date ? fmtDate(row.due_date) : "—"}
      </td>
      <td className="stage-cust" title={customers.join(" · ") || undefined}>
        {customers.length ? customers.join(", ") : "—"}
      </td>
      <td>
        <Button small intent="primary" icon="cube" loading={busy}
          text="Bereitstellen" onClick={onStage} />
      </td>
    </tr>
  );
}

/* -------------------------------------------------------------------------- */

/** Volle Platten, die aus dem Regal kommen — ohne die aus Reststücken. */
function fullPlates(r: StagingRow): number {
  return r.n_full_plates ?? r.n_plates;
}

const locName = (l: StockLocationRow) =>
  [l.station_label || "ohne Lager", l.bin].filter(Boolean).join(" · ");

/** Beim Bereitstellen fragen, aus welchem Regal die Platten kommen.

 *  Der Server schlägt einen Ort vor (exakte Dicke, genug Platten, kürzester
 *  Weg); der Mensch sieht alle Fächer mit Menge und kann einen anderen
 *  wählen. „Ohne Angabe" bleibt möglich, weil ein erfundener Ort schlechter
 *  ist als ein ehrliches „unbekannt". */
function StageLocationDialog({ row, onClose, onConfirm }: {
  row: StagingRow;
  onClose: () => void;
  onConfirm: (locationId: number | null) => void;
}) {
  // Nur Reststücke, keine volle Platte: dann gibt es kein Plattenfach zu wählen.
  const onlyOffcuts = (row.n_full_plates ?? row.n_plates) === 0 && (row.offcuts?.length ?? 0) > 0;
  const [picked, setPicked] = useState<number | null>(
    onlyOffcuts ? null : row.recommended_location_id ?? row.locations[0]?.id ?? null);
  const rec = onlyOffcuts ? undefined : row.locations.find((l) => l.id === row.recommended_location_id);
  const chosen = row.locations.find((l) => l.id === picked);
  const full = fullPlates(row);
  const offs = row.offcuts ?? [];
  const short = chosen != null && chosen.qty < full;

  return (
    <Dialog isOpen title={`Bereitstellen · ${row.no}`} onClose={onClose}
            className="stage-loc-dialog">
      <DialogBody>
        <p className="sub stage-rec-lead">
          {row.mat_name || row.mat} · {row.thk.toLocaleString("de-DE")} mm ·{" "}
          {full > 0 && plural(full, "volle Platte", "volle Platten")}
          {offs.length > 0 && `${full > 0 ? " + " : ""}${plural(offs.length, "Reststück", "Reststücke")}`}
          {row.station_label ? ` → ${row.station_label}` : " — noch ohne Maschine"}
        </p>

        {offs.length > 0 && (
          <Callout intent="success" icon="clean" className="stage-rec offcut-callout">
            <b>{offs.length === 1 ? "Dieses Reststück holen" : "Diese Reststücke holen"} — dafür keine volle Platte anbrechen:</b>
            <ul className="offcut-pick-list">
              {offs.map((o) => (
                <li key={o.id}>
                  <b className="mono">{o.code}</b> · {offcutSize(o)} mm · {offcutPlace(o)}
                  {typeof o.plate_idx === "number" && <span className="sub"> · Schnittplan {o.plate_idx + 1}</span>}
                </li>
              ))}
            </ul>
          </Callout>
        )}

        {rec && (
          <Callout intent="success" icon="endorsed" className="stage-rec">
            <b>Empfehlung: {locName(rec)}</b>
            {row.location_hint && <div className="sub">{row.location_hint}</div>}
          </Callout>
        )}

        {onlyOffcuts ? (
          <p className="sub">Keine volle Platte nötig — kein Plattenfach zu buchen.</p>
        ) : row.locations.length === 0 ? (
          <Callout intent="warning" icon="warning-sign">
            Für diesen Werkstoff ist kein Lagerort hinterlegt. Du kannst trotzdem
            bereitstellen — der Ort bleibt dann „unbekannt".
          </Callout>
        ) : (
          <RadioGroup
            name="stage-location"
            className="stage-loc-choices"
            selectedValue={picked == null ? "none" : String(picked)}
            onChange={(e) => {
              const value = e.currentTarget.value;
              setPicked(value === "none" ? null : Number(value));
            }}>
            {row.locations.map((l) => {
              const enough = l.qty >= full;
              const where = [l.hall_name, l.floor_name].filter(Boolean).join(" · ");
              return (
                <Radio key={l.id} value={String(l.id)} className="stage-loc-choice"
                  labelElement={
                    <span className="stage-loc-choice-label">
                      <span>
                        <b>{l.station_label || "ohne Lager"}</b>
                        {l.bin && <span> · {l.bin}</span>}
                        {l.id === row.recommended_location_id && (
                          <Tag minimal intent="success" icon="endorsed" className="stage-rec-tag">
                            Empfehlung
                          </Tag>
                        )}
                      </span>
                      <span className="sub">
                        {where ? `${where} · ` : ""}{l.qty} Pl.
                        {l.thk ? ` · ${l.thk.toLocaleString("de-DE")} mm` : " · gemischte Dicken"}
                        {l.note ? ` · ${l.note}` : ""}
                        {!enough && ` · reicht nicht für ${full}`}
                      </span>
                    </span>
                  } />
              );
            })}
            <Radio value="none" labelElement={
              <span className="stage-loc-choice-label">
                <b>Ort unbekannt / ohne Angabe</b>
                <span className="sub">
                  Keinen Lagerort buchen — die Platten sind trotzdem an der Maschine.
                </span>
              </span>
            } />
          </RadioGroup>
        )}

        {short && (
          <p className="sub">
            Dieses Fach deckt den Bedarf nicht allein — vielleicht reicht die übrige Menge
            aus einem zweiten Fach.
          </p>
        )}
      </DialogBody>
      <DialogFooter actions={<>
        <Button text="Abbrechen" onClick={onClose} />
        <Button intent="primary" icon="cube" text="Bereitgestellt"
          disabled={row.started}
          onClick={() => onConfirm(picked)} />
      </>} />
    </Dialog>
  );
}
