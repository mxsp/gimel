import { useEffect, useRef, useState } from "react";
import {
  Button, Checkbox, Dialog, DialogBody, DialogFooter, FormGroup, HTMLSelect, InputGroup, NumericInput, Tag,
} from "@blueprintjs/core";
import { api } from "../api";
import { toastError, toastSuccess } from "../toast";
import type { Floor } from "../factory";
import {
  allHalls, FloorRef, HallInfo, SiteInfo, Topology,
} from "../sites";
import MapPlacer from "./MapPlacer";
import LevelDialog from "./LevelDialog";

/* Standorte, Hallen und Ebenen pflegen — und eine Halle auf die Karte legen.

   Die Karte ist eine Vorschau aus OpenStreetMap-Kacheln. Sie lädt erst, wenn
   jemand sie für eine Halle einschaltet: jede Kachel geht an einen fremden
   Server und verrät dort, welche Gegend angesehen wird. */

interface Props {
  isOpen: boolean;
  onClose: () => void;
  topo: Topology | null;
  current: FloorRef | undefined;
  floor: Floor;
  onChanged: (pickFloorId?: number) => void;
}

const M_PER_DEG_LAT = 111_320;

export default function SitesDialog({ isOpen, onClose, topo, current, floor, onChanged }: Props) {
  const [busy, setBusy] = useState(false);
  const [hall, setHall] = useState<HallInfo | null>(null);
  const [site, setSite] = useState<SiteInfo | null>(null);
  /** Umriss des Erdgeschosses je Halle, für Hallen, die gerade nicht im Editor offen sind. */
  const [groundOutline, setGroundOutline] = useState<Record<number, [number, number][]>>({});
  /** Platzierungen dieser Sitzung, zum Zurücknehmen (neueste zuletzt). */
  const [undo, setUndo] = useState<{ id: number; lat: number; lon: number; rotation: number }[]>([]);
  const [placing, setPlacing] = useState(false);
  const [levelOpen, setLevelOpen] = useState(false);
  const asked = useRef(new Set<number>());
  /** Die zuletzt gezeigte Halle — für das Speichern aus einem Timer heraus. */
  const hallRef = useRef<HallInfo | null>(null);
  hallRef.current = hall;
  const saveTimer = useRef<number | null>(null);
  /** Eine noch nicht gespeicherte Lage aus Ankerfeldern oder Pfeilen. */
  const pending = useRef<HallInfo | null>(null);
  const siteHalls = (site ? topo?.sites.find((x) => x.id === site.id)?.halls : null) ?? [];
  // Umrisse für die gewählte Halle und ihre Nachbarn am selben Standort.
  useEffect(() => {
    if (!hall || !hall.map_enabled) return;
    for (const h of [hall, ...siteHalls]) {
      if (current?.hall?.id === h.id || groundOutline[h.id] || asked.current.has(h.id)) continue;
      asked.current.add(h.id);
      const ground = h.floors.find((f) => f.level === 0) ?? h.floors[0];
      if (!ground) continue;
      api<Floor>(`/api/factory/floor?floor_id=${ground.id}`)
        .then((f) => setGroundOutline((m) => ({ ...m, [h.id]: f.outline ?? [] })))
        .catch(() => { /* ohne Umriss bleibt der Anker sichtbar */ });
    }
  }, [hall, siteHalls, current, groundOutline]);
  // Beim Öffnen: die Halle des Editors. Danach bleibt die Auswahl, wo sie ist;
  // nach jedem Speichern kommen ihre Werte frisch aus dem Baum.
  useEffect(() => {
    if (!isOpen) return;
    setHall(current?.hall ? { ...current.hall } : null);
    setSite(current?.site ? { ...current.site } : null);
    setUndo([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);
  useEffect(() => {
    if (!topo) return;
    setHall((h) => {
      if (!h) return h;
      for (const x of [...topo.sites.flatMap((s) => s.halls), ...topo.unsited_halls]) if (x.id === h.id) return { ...x };
      return null;
    });
    setSite((s) => (s ? topo.sites.find((x) => x.id === s.id) ?? null : s));
  }, [topo]);
  const outlineOf = (id: number) => (current?.hall?.id === id ? floor.outline ?? [] : groundOutline[id] ?? []);

  /** Eine Lage speichern (ein geprüfter, protokollierter PUT), mit Rücknahme.
      Die Oberfläche folgt nur, wenn die Halle noch ausgewählt ist — eine
      wartende Änderung darf nach dem Wechsel keine andere Halle überschreiben. */
  const persist = async (base: HallInfo, v: { lat: number; lon: number; rotation: number }, record: boolean) => {
    const isShown = () => hallRef.current?.id === base.id;
    const before = { id: base.id, lat: base.lat, lon: base.lon, rotation: base.rotation_deg };
    const next = { ...base, lat: v.lat, lon: v.lon, rotation_deg: v.rotation };
    if (isShown()) setHall(next);
    setPlacing(true);
    try {
      await api(`/api/factory/halls/${base.id}`, { method: "PUT", body: JSON.stringify(hallBody(next)) });
      if (record && isShown()) setUndo((u) => [...u.slice(-19), before]);
      onChanged();
    } catch (e) {
      if (isShown()) setHall(base);
      toastError(e instanceof Error ? e.message : String(e));
    } finally { setPlacing(false); }
  };
  /** Lage aus der Karte: sofort speichern; eine wartende Feldänderung verfällt,
      weil die Karte jetzt die gültige Lage vorgibt. */
  const place = (v: { lat: number; lon: number; rotation: number }, record = true) => {
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    pending.current = null;
    const h = hallRef.current;
    return h ? persist(h, v, record) : Promise.resolve();
  };
  /** Anker, Drehung und Pfeile sammeln kurz und speichern dann wie die Karte.
      Ohne das blieb eine getippte Lage bis zum Klick auf „Halle speichern" liegen. */
  const flushSave = () => {
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const h = pending.current;
    pending.current = null;
    return h ? persist(h, { lat: h.lat, lon: h.lon, rotation: h.rotation_deg }, false) : Promise.resolve();
  };
  const queueSave = (next?: Partial<HallInfo>) => {
    const h = next && hallRef.current ? { ...hallRef.current, ...next } : hallRef.current;
    if (!h) return;
    pending.current = h;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(flushSave, 400);
  };
  // Schließen nimmt eine noch wartende Lage mit — sonst ginge der letzte Klick verloren.
  const closeDialog = () => { flushSave(); onClose(); };
  const undoPlace = () => {
    const last = undo[undo.length - 1];
    if (!last || !hall || last.id !== hall.id) return;
    setUndo((u) => u.slice(0, -1));
    place({ lat: last.lat, lon: last.lon, rotation: last.rotation }, false);
  };
  const toggleMap = async (on: boolean) => {
    await flushSave();
    const h = hallRef.current;
    if (!h) return;
    const next = { ...h, map_enabled: on };
    setHall(next);
    try {
      await api(`/api/factory/halls/${h.id}`, { method: "PUT", body: JSON.stringify(hallBody(next)) });
      onChanged();
    } catch (e) {
      setHall(h);
      toastError(e instanceof Error ? e.message : String(e));
    }
  };

  const run = async (what: string, fn: () => Promise<unknown>, pick?: (r: unknown) => number | undefined) => {
    setBusy(true);
    try {
      const r = await fn();
      toastSuccess(what);
      onChanged(pick?.(r));
    } catch (e) {
      toastError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const saveSite = () => site && run("Standort gespeichert.", () => api(`/api/factory/sites/${site.id}`, {
    method: "PUT", body: JSON.stringify({
      name: site.name, code: site.code, address: site.address, lat: site.lat, lon: site.lon, note: site.note,
    }),
  }));
  const saveHall = () => hall && run("Halle gespeichert.", () => api(`/api/factory/halls/${hall.id}`, {
    method: "PUT", body: JSON.stringify(hallBody(hall)),
  }));
  const newSite = () => run("Standort angelegt — mit Halle und Erdgeschoss.", async () => {
    const s = await api<SiteInfo>("/api/factory/sites", {
      method: "POST", body: JSON.stringify({ name: `Standort ${(topo?.sites.length ?? 0) + 1}` }),
    });
    return api<HallInfo>("/api/factory/halls", { method: "POST", body: JSON.stringify({ site_id: s.id, name: "Halle 1" }) });
  }, () => undefined);
  const newHall = (siteId: number | null) => run("Halle angelegt — mit Erdgeschoss.", () => api<HallInfo>("/api/factory/halls", {
    method: "POST", body: JSON.stringify({
      site_id: siteId, name: `Halle ${allHalls(topo).length + 1}`,
      lat: site?.lat ?? 0, lon: site?.lon ?? 0,
    }),
  }));
  const newLevel = (h: HallInfo, up: boolean) => {
    const levels = h.floors.map((f) => f.level);
    const level = up ? Math.max(0, ...levels) + 1 : Math.min(0, ...levels) - 1;
    const ground = h.floors.find((f) => f.level === 0) ?? h.floors[0];
    run("Ebene angelegt.", () => api<Floor>("/api/factory/floors", {
      method: "POST", body: JSON.stringify({ hall_id: h.id, level, copy_outline_from: ground?.id ?? null }),
    }), (r) => (r as Floor).id);
  };
  const dropLevel = (id: number, name: string) => {
    if (!window.confirm(`Ebene ${name} löschen? Das geht nur, wenn dort keine Station steht.`)) return;
    run("Ebene gelöscht.", () => api(`/api/factory/floors/${id}`, { method: "DELETE" }));
  };
  const dropHall = (h: HallInfo) => {
    if (!window.confirm(`${h.name} mit allen Ebenen löschen? Das geht nur ohne Stationen.`)) return;
    run("Halle gelöscht.", () => api(`/api/factory/halls/${h.id}`, { method: "DELETE" }));
  };
  const dropSite = (s: SiteInfo) => {
    if (!window.confirm(`${s.name} löschen? Das geht nur ohne Hallen.`)) return;
    run("Standort gelöscht.", () => api(`/api/factory/sites/${s.id}`, { method: "DELETE" }));
  };

  /** Eine Halleneigenschaft setzen; Lage und Drehung speichern kurz darauf von selbst. */
  const changeHall = (patch: Partial<HallInfo>, save = false) => {
    setHall((h) => (h ? { ...h, ...patch } : h));
    if (save) queueSave(patch);
  };
  /** Anker um Meter nach Osten/Norden verschieben. */
  const nudge = (east: number, north: number) => {
    const h = hallRef.current;
    if (!h) return;
    const lat = h.lat + north / M_PER_DEG_LAT;
    const lon = h.lon + east / (M_PER_DEG_LAT * Math.cos((h.lat * Math.PI) / 180) || 1);
    changeHall({ lat: round6(lat), lon: round6(lon) }, true);
  };

  return (
    <>
    <Dialog isOpen={isOpen} onClose={closeDialog} title="Standorte, Hallen, Ebenen" icon="office" style={{ width: 920, maxWidth: "calc(100vw - 32px)" }}>
      <DialogBody className="site-admin">
        {topo?.sites.map((s) => (
          <div key={s.id} className="site-admin-card">
            <h4>{s.name} {s.code && <Tag minimal>{s.code}</Tag>} {s.id === topo.default_site_id && <Tag minimal intent="primary">erster Standort</Tag>}</h4>
            <div className="site-admin-levels">
              {s.halls.map((h) => (
                <Tag key={h.id} interactive large minimal={h.id !== hall?.id} intent={h.id === hall?.id ? "primary" : "none"}
                  onClick={() => { flushSave(); setHall({ ...h }); setSite({ ...s }); }}>
                  {h.name} · {h.floors.map((f) => f.level_name).join(", ")}
                </Tag>
              ))}
              <Button small minimal icon="add" text="Neue Halle" disabled={busy} onClick={() => newHall(s.id)} />
              {topo.sites.length > 1 && !s.halls.length && (
                <Button small minimal intent="danger" icon="trash" text="Standort" onClick={() => dropSite(s)} />
              )}
            </div>
          </div>
        ))}
        <div><Button small icon="add" text="Neuer Standort" disabled={busy} onClick={newSite} /></div>

        {site && (
          <div className="site-admin-card">
            <h4>Standort {site.name}</h4>
            <div className="site-admin-row">
              <FormGroup label="Name"><InputGroup value={site.name} onChange={(e) => setSite({ ...site, name: e.target.value })} /></FormGroup>
              <FormGroup label="Kürzel"><InputGroup value={site.code} style={{ width: 80 }} onChange={(e) => setSite({ ...site, code: e.target.value })} /></FormGroup>
              <FormGroup label="Anschrift"><InputGroup value={site.address} style={{ width: 260 }} onChange={(e) => setSite({ ...site, address: e.target.value })} /></FormGroup>
              <FormGroup label="Breite °"><NumericInput value={site.lat} minorStepSize={0.000001} stepSize={0.0001} style={{ width: 110 }} onValueChange={(v) => setSite({ ...site, lat: v || 0 })} /></FormGroup>
              <FormGroup label="Länge °"><NumericInput value={site.lon} minorStepSize={0.000001} stepSize={0.0001} style={{ width: 110 }} onValueChange={(v) => setSite({ ...site, lon: v || 0 })} /></FormGroup>
              <Button small intent="primary" icon="floppy-disk" text="Speichern" loading={busy} onClick={saveSite} />
            </div>
          </div>
        )}

        {hall && (
          <div className="site-admin-card">
            <h4>Halle {hall.name}</h4>
            <div className="site-admin-row">
              <FormGroup label="Name"><InputGroup value={hall.name} onChange={(e) => changeHall({ name: e.target.value })} /></FormGroup>
              <FormGroup label="Standort">
                <HTMLSelect value={hall.site_id ?? ""} onChange={(e) => changeHall({ site_id: Number(e.currentTarget.value) || null }, true)}
                  options={(topo?.sites ?? []).map((s) => ({ value: s.id, label: s.name }))} />
              </FormGroup>
              <FormGroup label="Ebenen">
                <div className="site-admin-levels">
                  {[...hall.floors].sort((a, b) => b.level - a.level).map((f) => (
                    <Tag key={f.id} minimal onRemove={f.default || f.stations ? undefined : () => dropLevel(f.id, f.level_name)}>
                      {f.level_name} · {f.stations}
                    </Tag>
                  ))}
                  <Button small minimal icon="arrow-up" text="OG" disabled={busy} onClick={() => newLevel(hall, true)} title="Ebene darüber, Umriss vom EG" />
                  <Button small minimal icon="arrow-down" text="UG" disabled={busy} onClick={() => newLevel(hall, false)} title="Ebene darunter, Umriss vom EG" />
                  <Button small minimal icon="add" text="Neue Ebene" disabled={busy} onClick={() => setLevelOpen(true)}
                    title="Ebene mit eigenem Namen, Höhe und Umriss anlegen" />
                </div>
              </FormGroup>
            </div>
            <div className="site-admin-row">
              <FormGroup label="Anker Breite °" helperText="Wo der Nullpunkt des Grundrisses liegt">
                <NumericInput value={hall.lat} minorStepSize={0.000001} stepSize={0.00001} style={{ width: 120 }}
                  onValueChange={(v) => changeHall({ lat: v || 0 }, true)} />
              </FormGroup>
              <FormGroup label="Anker Länge °">
                <NumericInput value={hall.lon} minorStepSize={0.000001} stepSize={0.00001} style={{ width: 120 }}
                  onValueChange={(v) => changeHall({ lon: v || 0 }, true)} />
              </FormGroup>
              <FormGroup label="Drehung °" helperText="x-Achse gegen den Uhrzeigersinn aus Osten">
                <NumericInput value={hall.rotation_deg} min={-360} max={360} stepSize={1} minorStepSize={0.1} style={{ width: 90 }}
                  onValueChange={(v) => changeHall({ rotation_deg: v || 0 }, true)} />
              </FormGroup>
              <FormGroup label="Verschieben (1 m)">
                <div className="site-admin-levels">
                  <Button small icon="arrow-left" aria-label="1 m nach Westen" onClick={() => nudge(-1, 0)} />
                  <Button small icon="arrow-up" aria-label="1 m nach Norden" onClick={() => nudge(0, 1)} />
                  <Button small icon="arrow-down" aria-label="1 m nach Süden" onClick={() => nudge(0, -1)} />
                  <Button small icon="arrow-right" aria-label="1 m nach Osten" onClick={() => nudge(1, 0)} />
                </div>
              </FormGroup>
              {site && (site.lat || site.lon) && !(hall.lat || hall.lon) ? (
                <Button small minimal text="Lage vom Standort" onClick={() => changeHall({ lat: site.lat, lon: site.lon }, true)} />
              ) : null}
            </div>
            <Checkbox checked={hall.map_enabled} label="Karte unter der Halle zeigen (Karte oder Luftbild) — im Plan, im 3D-Leitstand und hier"
              onChange={(e) => toggleMap(e.currentTarget.checked)} />
            <p className="site-map-note">
              Die Kacheln kommen von tile.openstreetmap.org (Karte) oder server.arcgisonline.com (Luftbild, Esri),
              die Adresssuche von nominatim.openstreetmap.org. Ihr Browser fragt dort direkt an; der Anbieter sieht
              dabei Ihre IP-Adresse und die angesehene Gegend bzw. den Suchtext. Aus, bis Sie es einschalten.
            </p>
            {hall.map_enabled ? (
              <MapPlacer key={hall.id} lat={hall.lat} lon={hall.lon} rotation={hall.rotation_deg}
                outline={outlineOf(hall.id)}
                others={siteHalls.filter((h) => h.id !== hall.id && (h.lat || h.lon)).map((h) => ({
                  id: h.id, name: h.name, lat: h.lat, lon: h.lon, rotation: h.rotation_deg, outline: outlineOf(h.id),
                }))}
                fallback={site && (site.lat || site.lon) ? { lat: site.lat, lon: site.lon }
                  : siteHalls.find((h) => h.lat || h.lon) ?? null}
                address={site?.address ?? ""}
                saving={placing}
                canUndo={undo.length > 0 && undo[undo.length - 1].id === hall.id}
                onUndo={undoPlace}
                onChange={(v) => place(v)} />
            ) : null}
            <div className="site-admin-row" style={{ marginTop: 8 }}>
              <Button small intent="primary" icon="floppy-disk" text="Halle speichern" loading={busy} onClick={saveHall} />
              <Button small minimal intent="danger" icon="trash" text="Halle löschen" disabled={busy} onClick={() => dropHall(hall)} />
              <span className="site-map-note">Lage und Drehung speichern kurz nach der Eingabe von selbst.</span>
            </div>
          </div>
        )}
      </DialogBody>
      <DialogFooter actions={<Button text="Schließen" onClick={closeDialog} />} />
    </Dialog>
    <LevelDialog isOpen={levelOpen} hall={hall} floors={hall?.floors ?? []}
      onClose={() => setLevelOpen(false)}
      onCreated={(id) => { setLevelOpen(false); onChanged(id); }}
      onDeleted={() => onChanged()} />
    </>
  );
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

function hallBody(h: HallInfo) {
  return {
    site_id: h.site_id, name: h.name, code: h.code, sort: h.sort, lat: h.lat, lon: h.lon,
    rotation_deg: h.rotation_deg, map_enabled: h.map_enabled, note: h.note,
  };
}
