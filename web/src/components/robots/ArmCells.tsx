import { Button, Card, Icon, Tag } from "@blueprintjs/core";
import { useEffect, useState } from "react";
import type { Robot } from "../../factory";
import { capLabel, kindLabel, stateOf } from "./robotMeta";

/* Arme & Zellen: stationäre Roboter der Halle.

   Stammdaten wie auf der Fahrzeugseite. Die Sortierzelle (Simulation und
   Teileerkennung) ist in der Benutzeroberfläche zurzeit pausiert. */

interface Props {
  arms: Robot[];
  floorName: (id: number | null) => string;
  admin: boolean;
  onEdit: (r: Robot) => void;
  onNew: () => void;
  onShowOnPlan: (floorId: number | null) => void;
}

export default function ArmCells({ arms, floorName, admin, onEdit, onNew, onShowOnPlan }: Props) {
  const [selectedId, setSelectedId] = useState<number | null>(arms[0]?.id ?? null);
  useEffect(() => {
    if (selectedId == null || !arms.some((a) => a.id === selectedId)) setSelectedId(arms[0]?.id ?? null);
  }, [arms, selectedId]);
  const arm = arms.find((a) => a.id === selectedId) ?? null;

  return (
    <div className="arm-cells">
      <div className="arm-head">
        <div className="arm-strip" role="tablist" aria-label="Arme">
          {arms.map((a) => {
            const st = stateOf(a);
            return (
              <button key={a.id} type="button" role="tab" aria-selected={a.id === selectedId}
                      className={`arm-chip${a.id === selectedId ? " is-active" : ""}`} onClick={() => setSelectedId(a.id)}>
                <span className="arm-chip-name">{a.name}</span>
                <span className="sub">{kindLabel(a.kind)} · {floorName(a.floor_id)}</span>
                <Tag minimal intent={st.intent}>{st.label}</Tag>
              </button>
            );
          })}
          {!arms.length && (
            <Card className="arm-empty">
              <b>Noch kein Arm in der Flotte.</b>
              <span className="sub">Die Sortierzelle ist in der Benutzeroberfläche zurzeit pausiert.{admin ? " Einen Arm anlegen verknüpft ihn mit der Flotte." : ""}</span>
              {admin && <Button small intent="primary" icon="add" text="Neuer Arm" onClick={onNew} />}
            </Card>
          )}
        </div>

        {arm && (
          <div className="arm-facts">
            <span><span className="sub">Quelle</span> {arm.simulated ? <Tag minimal intent="primary">Simulation</Tag> : arm.gateway_id}</span>
            {arm.payload_kg > 0 && <span><span className="sub">Traglast</span> <span className="mono">{arm.payload_kg} kg</span></span>}
            <span className="arm-caps">
              {arm.capabilities.map((c) => <Tag key={c} minimal>{capLabel(c)}</Tag>)}
            </span>
            <span className="arm-facts-gap" />
            {admin && <Button small minimal icon="edit" text="Bearbeiten" onClick={() => onEdit(arm)} />}
            <Button small minimal icon="map" text="Grundriss" onClick={() => onShowOnPlan(arm.floor_id)}
                    title="Die Halle des Arms im Digitalen Grundriss" />
            <Button small minimal icon="cube" text="Studio" onClick={() => window.open("/studio/", "_blank", "noopener")}
                    title="Twin Studio: der Arm in der Halle" />
          </div>
        )}
      </div>

      <div className="arm-cell-placeholder" role="region" aria-label="Sortierzelle">
        <Card className="arm-empty">
          <Icon icon="cube" size={24} className="muted" />
          <div style={{ marginTop: 8 }}>
            <b>Sortierzelle vorübergehend deaktiviert</b>
            <p className="sub" style={{ margin: "4px 0 0" }}>
              Die 3D-Simulation und Teileerkennung der Sortierzelle sind in der Benutzeroberfläche zurzeit pausiert.
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}
