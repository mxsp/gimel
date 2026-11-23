import { Station, TYPE_LABEL } from "../../factory";
import { Certainty, StationMark, StatusKind } from "./marks";

/* Eine Station im Leitstand: Zustand als Form, Zeichen und Wort, nie als Farbe
   allein. Die Fläche bleibt ruhig; was auffällt, ist Muster und Zeichen.
   Alles Beschriftete steht in Bildschirmpixeln (`fs`), der Plan rechnet in Metern. */

/** Kleinstes Klickziel in Pixeln, um Form und Beschriftung. */
const HIT_MIN_PX = 28;
/** Ab diesem Maßstab (Pixel je Meter) steht der Name, ab dem nächsten auch der Zustand. */
const NAME_MIN_PPM = 3.5;
const WORD_MIN_PPM = 8;

export const DASH: Record<Certainty, string | undefined> = { firm: undefined, estimated: "7 4", unknown: "2 4" };

const HOLLOW: StatusKind[] = ["frei", "unbekannt", "inaktiv"];

/** Zeichen im 16-Pixel-Raster um den Nullpunkt, in `currentColor`. */
export function StatusGlyph({ kind }: { kind: StatusKind }) {
  const line = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (kind) {
    case "laeuft": return <path d="M-3.5,-5.5 L5.5,0 L-3.5,5.5 Z" fill="currentColor" />;
    case "wartet": return <g {...line}><circle r={6} /><path d="M0,-3.2 V0 L2.6,1.6" /></g>;
    case "frei": return <circle r={5.5} {...line} />;
    case "voll": return <g {...line}><path d="M0,-6 L6.4,5.2 H-6.4 Z" /><path d="M0,-1.6 V1.4" /><path d="M0,3.4 v0.01" /></g>;
    case "ueber": return <g {...line} strokeWidth={2.6}><path d="M0,-6 V1.6" /><path d="M0,5.6 v0.01" /></g>;
    case "unbekannt": return <text y={5.2} textAnchor="middle" fontSize={15} fontWeight={700} fill="currentColor">?</text>;
    case "inaktiv": return <g {...line}><circle r={6} /><path d="M-4.2,4.2 L4.2,-4.2" /></g>;
  }
}

export function StatusDefs({ fs }: { fs: (px: number) => number }) {
  const step = fs(8);
  return (
    <defs>
      <pattern id="twin-hatch" width={step} height={step} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <line x1={0} y1={0} x2={0} y2={step} stroke="var(--g-floor-on-station)" strokeWidth={fs(3)} />
      </pattern>
      <pattern id="twin-cross" width={step} height={step} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <path d={`M0 0 V${step} M0 0 H${step}`} stroke="var(--g-floor-off-line)" strokeWidth={fs(1.2)} fill="none" />
      </pattern>
    </defs>
  );
}

export default function StationShape({ s, mark, fs, ppm, selected, highlighted, labels = true }: {
  s: Station; mark: StationMark; fs: (px: number) => number; ppm: number; selected: boolean; highlighted: boolean;
  labels?: boolean;
}) {
  const hollow = HOLLOW.includes(mark.kind);
  const halfW = s.w / 2, halfH = s.h / 2;
  const turn = (s.rotation * Math.PI) / 180;
  const boxW = Math.abs(halfW * Math.cos(turn)) + Math.abs(halfH * Math.sin(turn));
  const boxH = Math.abs(halfW * Math.sin(turn)) + Math.abs(halfH * Math.cos(turn));

  const showName = ppm >= NAME_MIN_PPM;
  const showWord = ppm >= WORD_MIN_PPM;
  const glyphPx = 16;
  const inset = fs(7);
  // Passt das Zeichen nicht in die Form (Telefon), bekommt es eine eigene Scheibe und ragt hinaus.
  const glyphFits = Math.min(s.w, s.h) * ppm >= glyphPx + 4;
  const textPx = Math.max(s.label.length * 6.6, showWord ? mark.line.length * 6 : 0);
  // Passt die Schrift nicht in den Block, hängt sie darunter auf dem Hallenboden.
  const inside = boxW * 2 * ppm >= textPx + glyphPx + 24 && boxH * 2 * ppm >= (showWord ? 44 : 30);
  const nameY = inside ? -boxH + fs(17) : boxH + fs(14);
  const wordY = nameY + fs(14);
  const textX = inside ? -boxW + inset + fs(glyphPx + 6) : 0;
  const anchor = inside ? "start" : "middle";
  const cls = inside && !hollow ? "twin-text-on" : "twin-text-off";
  const halo = { strokeWidth: fs(3) };
  // Klickfläche: die Form, die darunter hängende Schrift und mindestens 28 Pixel.
  const labelW = inside || !showName ? 0 : textPx;
  const hitW = Math.max(s.w, fs(labelW + 8), fs(HIT_MIN_PX));
  const below = !inside && showName ? fs(showWord ? 36 : 22) : 0;
  const hitTop = -Math.max(halfH, fs(HIT_MIN_PX / 2));
  const hitBottom = Math.max(halfH + below, fs(HIT_MIN_PX / 2));

  return (
    <>
      <rect className="twin-hit" x={-hitW / 2} y={hitTop} width={hitW} height={hitBottom - hitTop} fill="transparent" />
      <rect x={-halfW} y={-halfH} width={s.w} height={s.h} rx={fs(2)} data-station-id={s.id}
        className={"twin-body" + (hollow ? " twin-body-hollow" : "")}
        strokeDasharray={DASH[mark.certainty]} vectorEffect="non-scaling-stroke" />
      {mark.kind === "ueber" && (
        <rect className="twin-hatch" x={-halfW} y={-halfH} width={s.w} height={s.h} rx={fs(2)} fill="url(#twin-hatch)" pointerEvents="none" />
      )}
      {mark.kind === "inaktiv" && (
        <rect className="twin-cross" x={-halfW} y={-halfH} width={s.w} height={s.h} rx={fs(2)} fill="url(#twin-cross)" pointerEvents="none" />
      )}
      {mark.running && (
        <rect className="twin-edge" x={-halfW} y={-halfH} width={fs(6)} height={s.h} pointerEvents="none" />
      )}
      {mark.ratio != null && mark.ratio > 0 && (
        <g className="twin-load" pointerEvents="none">
          <rect x={-halfW} y={halfH - fs(6)} width={s.w} height={fs(6)} className="twin-load-track" />
          <rect x={-halfW} y={halfH - fs(6)} width={s.w * Math.min(1, mark.ratio)} height={fs(6)} className="twin-load-fill" />
        </g>
      )}
      <g transform={`rotate(${-s.rotation})`} pointerEvents="none">
        <g className={"twin-glyph " + (hollow ? "twin-glyph-off" : "twin-glyph-on")}
           transform={`translate(${inside ? -boxW + inset + fs(glyphPx / 2) : 0} ${inside ? -boxH + fs(14) : mark.ratio ? -fs(2) : 0}) scale(${fs(1)})`}>
          {(mark.kind === "ueber" || !glyphFits) && <circle r={10} className="twin-glyph-disc" />}
          <StatusGlyph kind={mark.kind} />
        </g>
        {labels && showName && (
          <text className={`twin-name ${cls}`} x={textX} y={nameY} textAnchor={anchor} fontSize={fs(12)} style={halo}>{s.label}</text>
        )}
        {labels && showWord && (
          <text className={`twin-word ${cls}`} x={textX} y={wordY} textAnchor={anchor} fontSize={fs(11)} style={halo}>{mark.line}</text>
        )}
      </g>
      {highlighted && (
        <rect className="twin-ring twin-ring-find" x={-halfW - fs(6)} y={-halfH - fs(6)} width={s.w + fs(12)} height={s.h + fs(12)}
          rx={fs(4)} strokeDasharray="10 5" vectorEffect="non-scaling-stroke" pointerEvents="none" />
      )}
      {selected && (
        <rect className="twin-ring" x={-halfW - fs(3)} y={-halfH - fs(3)} width={s.w + fs(6)} height={s.h + fs(6)}
          rx={fs(3)} vectorEffect="non-scaling-stroke" pointerEvents="none" />
      )}
    </>
  );
}

export const stationTitle = (s: Station) => `${TYPE_LABEL[s.type]}${s.subtype ? ` · ${s.subtype}` : ""}`;
