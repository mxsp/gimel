import { Button, ButtonGroup, HTMLSelect, Menu, MenuDivider, MenuItem } from "@blueprintjs/core";
import KeyPopover from "../ui/KeyPopover";
import { allHalls, FloorRef, Topology } from "../sites";
import { neighborLevels } from "./twin/twinScope";

/* Standort, Halle, Ebene — in dieser Reihenfolge, und nur, was es mehrfach gibt.
   Ein Betrieb mit einer Halle und einem Geschoss sieht nichts davon. */

interface Props {
  topo: Topology | null;
  current: FloorRef | undefined;
  onPick: (floorId: number) => void;
  /** Mehrere Ebenen und Hallen gleichzeitig einblenden (3D). */
  multi?: boolean;
  /** Zusätzliche Ebenen, die neben der aktiven gezeigt werden. */
  extra?: number[];
  onToggleExtra?: (floorId: number) => void;
  onExtras?: (floorIds: number[]) => void;
  /** Andere Hallen desselben Standorts, die neben der aktiven gezeigt werden. */
  halls?: number[];
  onToggleHall?: (hallId: number) => void;
  onHalls?: (hallIds: number[]) => void;
  /** Auch bei nur einer Halle zeigen (Editor). */
  always?: boolean;
  /** Neue Ebene anlegen (nur Admin); leer = kein Knopf. */
  onAddLevel?: () => void;
}

export default function FloorSwitcher({
  topo, current, onPick, multi, extra = [], onToggleExtra, onExtras, halls = [], onToggleHall, onHalls,
  always, onAddLevel,
}: Props) {
  if (!topo || !current) return null;
  const hallList = allHalls(topo);
  const sites = topo.sites;
  const floors = current.hall?.floors ?? [current.floor];
  if (!always && hallList.length <= 1 && floors.length <= 1) return null;
  const otherFloors = floors.filter((f) => f.id !== current.floor.id);
  const otherHalls = (current.site?.halls ?? [])
    .filter((h) => h.id !== current.hall?.id && h.floors.length > 0);
  const chosen = extra.length + halls.length;
  const allFloorsOn = otherFloors.length > 0 && otherFloors.every((f) => extra.includes(f.id));
  const allHallsOn = otherHalls.length > 0 && otherHalls.every((h) => halls.includes(h.id));
  const everythingOn = (otherFloors.length === 0 || allFloorsOn) && (otherHalls.length === 0 || allHallsOn);
  const showPicker = multi && (otherFloors.length > 0 || otherHalls.length > 0)
    && (onToggleExtra || onToggleHall);

  const pickHall = (id: number) => {
    const h = hallList.find((x) => x.hall.id === id)?.hall;
    const ground = h?.floors.find((f) => f.level === 0) ?? h?.floors[0];
    if (ground) onPick(ground.id);
  };
  const pickSite = (id: number) => {
    const s = sites.find((x) => x.id === id);
    const h = s?.halls[0];
    if (h) pickHall(h.id);
  };
  const toggleFloor = (id: number) => onToggleExtra?.(id);
  const toggleHall = (id: number) => onToggleHall?.(id);
  const showEverything = () => {
    onExtras?.(otherFloors.map((f) => f.id));
    onHalls?.(otherHalls.map((h) => h.id));
  };
  const clearAll = () => {
    onExtras?.([]);
    onHalls?.([]);
  };

  return (
    <div className="floor-switcher" role="group" aria-label="Standort, Halle und Ebene">
      {sites.length > 1 && (
        <HTMLSelect minimal value={current.site?.id ?? ""} aria-label="Standort"
          onChange={(e) => pickSite(Number(e.currentTarget.value))}
          options={sites.map((s) => ({ value: s.id, label: s.name }))} />
      )}
      {(hallList.length > 1 || always) && (
        <HTMLSelect minimal value={current.hall?.id ?? ""} aria-label="Halle"
          onChange={(e) => pickHall(Number(e.currentTarget.value))}
          options={hallList
            .filter((h) => sites.length <= 1 || h.site?.id === current.site?.id)
            .map((h) => ({ value: h.hall.id, label: h.hall.name }))} />
      )}
      {(floors.length > 1 || onAddLevel || showPicker) && (
        <ButtonGroup>
          {[...floors].sort((a, b) => b.level - a.level).map((f) => (
            <Button key={f.id} small text={f.level_name || `E${f.level}`}
              active={f.id === current.floor.id}
              aria-pressed={f.id === current.floor.id}
              title={`${f.level_name} · ${f.stations} Station${f.stations === 1 ? "" : "en"}`}
              onClick={() => onPick(f.id)} />
          ))}
          {onAddLevel && (
            <Button small minimal icon="layers" text="Ebenen" title="Ebenen anlegen und löschen"
              aria-label="Ebenen verwalten" onClick={onAddLevel} />
          )}
          {showPicker && (
            <KeyPopover placement="bottom-start" content={
              <Menu>
                {otherFloors.length > 0 && (
                  <>
                    <MenuDivider title={current.hall ? `Weitere Ebenen · ${current.hall.name}` : "Weitere Ebenen"} />
                    {[...otherFloors].sort((a, b) => b.level - a.level).map((f) => (
                      <MenuItem key={f.id} shouldDismissPopover={false}
                        icon={extra.includes(f.id) ? "tick" : "blank"}
                        text={`${f.level_name || `E${f.level}`} · ${f.stations} Station${f.stations === 1 ? "" : "en"}`}
                        onClick={() => toggleFloor(f.id)} />
                    ))}
                  </>
                )}
                {otherHalls.length > 0 && (
                  <>
                    <MenuDivider title="Andere Hallen" />
                    {otherHalls.map((h) => {
                      // Dieselben Stufen wie hier (aktive + gewählte Ebenen), wie die 3D-Ansicht sie zeigt.
                      const stages = [current.floor.level || 0,
                        ...otherFloors.filter((f) => extra.includes(f.id)).map((f) => f.level || 0)];
                      const names = neighborLevels(h, stages).map((f) => f.level_name || `Ebene ${f.level}`).join(", ");
                      return (
                        <MenuItem key={h.id} shouldDismissPopover={false}
                          icon={halls.includes(h.id) ? "tick" : "blank"}
                          text={`${h.name} · ${names}`}
                          title={`${h.name}: ${names} dieser Halle zeigen`}
                          onClick={() => toggleHall(h.id)} />
                      );
                    })}
                  </>
                )}
                <MenuDivider />
                <MenuItem icon="eye-open" text="Alles anzeigen"
                  disabled={everythingOn} shouldDismissPopover={false}
                  title="Alle anderen Ebenen und Hallen vollständig zeigen"
                  onClick={showEverything} />
                <MenuItem icon="eye-off" text="Auswahl aufheben" disabled={chosen === 0}
                  shouldDismissPopover={false} onClick={clearAll} />
              </Menu>
            }>
              <Button small icon="layers" active={chosen > 0}
                text={chosen ? `Ebenen & Hallen +${chosen}` : "Ebenen & Hallen"}
                aria-label="Weitere Ebenen und Hallen auswählen"
                title="Einzelne, mehrere oder alle anderen Ebenen und Hallen vollständig zeigen" />
            </KeyPopover>
          )}
        </ButtonGroup>
      )}
    </div>
  );
}
