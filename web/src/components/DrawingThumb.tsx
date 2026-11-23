import "../free-nesting.css";
import { Pt, thumbPath } from "../freeNesting";

/* Vorschau einer Kontur. Dekoration: der Name steht immer daneben. */
export default function DrawingThumb({ preview, width, height, size = 48 }: {
  preview?: { outer: Pt[]; holes: Pt[][] }; width: number; height: number; size?: number;
}) {
  const w = Math.max(width, 1), h = Math.max(height, 1), pad = Math.max(w, h) * 0.04;
  return (
    <svg className="fn-thumb" width={size} height={size} viewBox={`${-pad} ${-pad} ${w + 2 * pad} ${h + 2 * pad}`}
         preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">
      {preview && <path d={thumbPath(preview, h)} fillRule="evenodd" />}
    </svg>
  );
}
