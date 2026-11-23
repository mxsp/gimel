import { memo, type CSSProperties } from "react";
import { cloudField, type SkyCloud } from "./skyPoints";
import "./sky.css";

/* Der Himmel liegt als erstes Kind hinter dem durchsichtigen WebGL-Canvas der
   3D-Halle. Tagsüber trägt er den blauen Verlauf und — wenn gewünscht — ein
   paar leichte Wolken; Twin Studio zeigt den Tag ohne sie. Die Sterne der
   Nacht stehen dagegen in der Szene selbst (ThreeFloorPlan):
   nur dort drehen sie sich mit der Kamera und verschwinden hinter Boden und
   Halle. Die Farbflächen hier brauchen keinen Zustand: theme.ts setzt
   data-theme, die CSS-Regeln blenden Nacht und Tag über. */

const CLOUDS = cloudField();

function cloudStyle(c: SkyCloud): CSSProperties {
  return {
    left: `${c.x}%`,
    top: `${c.y}%`,
    ["--twin-cloud-scale" as string]: String(c.scale),
    animationDelay: `${c.delay}s`,
    animationDuration: `${c.duration}s`,
  } as CSSProperties;
}

interface Props {
  /** Leichte Wolken im Tageshimmel. Twin Studio schaltet sie ab. */
  clouds?: boolean;
}

function Sky({ clouds = true }: Props) {
  return (
    <div className="twin-sky" aria-hidden="true">
      <div className="twin-sky-night" />
      <div className="twin-sky-day">
        {clouds && (
          <div className="twin-sky-clouds">
            {CLOUDS.map((c, i) => (
              <span key={`c${i}`} className="twin-sky-cloud" style={cloudStyle(c)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Statisch: bei jedem Hover oder Status-Abruf der Halle nicht neu rendern. */
export default memo(Sky);
