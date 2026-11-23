import { HTMLSelect, Icon } from "@blueprintjs/core";
import { useEffect } from "react";
import { isWorker } from "../api";
import { navigate } from "../router";
import { loadStationsOnce, useKnownStations } from "../stationStore";

export type StationViewTab = "grundriss" | "arbeitsvorrat" | "arbeitsplaetze" | "optimierung" | "station";

/** Schlanke Stations-Leiste ohne doppelte Seitenleisten-Elemente:
 *  - Auf Arbeitsvorrat / Arbeitsplätze / Optimierung: ruhige Reiterleiste.
 *  - Auf einer einzelnen Station: Rücksprung zu Arbeitsplätze + ein Stations-Wechsler. */
export default function StationControlBar({
  active,
  stationId,
  stationLabel,
}: {
  active: StationViewTab;
  stationId?: string;
  stationLabel?: string;
}) {
  const office = !isWorker();
  const { stations, loaded } = useKnownStations();
  const activeStations = stations.filter((s) => s.active);

  useEffect(() => {
    if (active === "station" && !loaded) loadStationsOnce();
  }, [active, loaded]);

  if (active === "station") {
    return (
      <div className="subnav-bar subnav-bar-compact" role="navigation" aria-label="Stationswechsel">
        <a className="subnav-back" href="#/arbeitsplaetze">
          <Icon icon="arrow-left" size={13} aria-hidden="true" />
          <span>Arbeitsplätze</span>
        </a>
        <span className="subnav-sep" aria-hidden="true">/</span>
        <HTMLSelect
          minimal
          className="subnav-station-select"
          aria-label="Station wechseln"
          value={stationId ? String(stationId) : ""}
          onFocus={() => { if (!loaded) loadStationsOnce(); }}
          onClick={() => { if (!loaded) loadStationsOnce(); }}
          onChange={(e) => {
            const val = e.currentTarget.value;
            if (val) navigate(`station/${val}`);
          }}
        >
          {!loaded && stationId && (
            <option value={String(stationId)}>{stationLabel || `Station ${stationId}`}</option>
          )}
          {activeStations.map((s) => (
            <option key={s.id} value={String(s.id)}>
              {s.label}{s.queue_jobs > 0 ? ` (${s.queue_jobs})` : ""}
            </option>
          ))}
        </HTMLSelect>
      </div>
    );
  }

  return (
    <div className="subnav-bar" role="navigation" aria-label="Arbeitsvorrat-Ansichten">
      <div className="subnav-tabs">
        <a
          href="#/arbeitsvorrat"
          className="subnav-tab"
          aria-current={active === "arbeitsvorrat" ? "page" : undefined}
        >
          <Icon icon="sort-numerical" size={13} aria-hidden="true" />
          <span>Warteschlangen</span>
        </a>
        <a
          href="#/arbeitsplaetze"
          className="subnav-tab"
          aria-current={active === "arbeitsplaetze" ? "page" : undefined}
        >
          <Icon icon="desktop" size={13} aria-hidden="true" />
          <span>Arbeitsplätze</span>
        </a>
        {office && (
          <a
            href="#/optimierung"
            className="subnav-tab"
            aria-current={active === "optimierung" ? "page" : undefined}
          >
            <Icon icon="flame" size={13} aria-hidden="true" />
            <span>Optimierung</span>
          </a>
        )}
      </div>
    </div>
  );
}
