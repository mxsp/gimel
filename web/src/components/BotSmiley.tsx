import { useEffect, useId, useRef, useState } from "react";

type Mood = "idle" | "hover" | "wink" | "beam" | "wow" | "thinking";

type GazeListener = (x: number, y: number) => void;
const gazeListeners = new Set<GazeListener>();
let rafId: number | null = null;
let lastPointer = { x: 0, y: 0 };

function ensurePointerListener() {
  if (typeof window === "undefined") return;
  if (gazeListeners.size === 1) {
    window.addEventListener("pointermove", onPointerMove, { passive: true });
  }
}

function maybeRemovePointerListener() {
  if (typeof window === "undefined") return;
  if (gazeListeners.size === 0) {
    window.removeEventListener("pointermove", onPointerMove);
    if (rafId != null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }
}

function onPointerMove(e: PointerEvent) {
  lastPointer.x = e.clientX;
  lastPointer.y = e.clientY;
  if (rafId != null) return;
  rafId = requestAnimationFrame(() => {
    rafId = null;
    for (const fn of gazeListeners) fn(lastPointer.x, lastPointer.y);
  });
}

const BOOP_MOODS: Array<"wink" | "beam" | "wow"> = ["wink", "beam", "wow"];

export interface BotSmileyProps {
  size?: number;
  variant?: "brand" | "assistant" | "hero";
  color?: string;
  thinking?: boolean;
  trackMouse?: boolean;
  interactive?: boolean;
  className?: string;
  title?: string;
}

export default function BotSmiley({
  size = 30,
  variant = "brand",
  color,
  thinking = false,
  trackMouse = false,
  interactive = true,
  className = "",
  title,
}: BotSmileyProps) {
  const uid = useId().replace(/:/g, "");
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const [hovered, setHovered] = useState(false);
  const [boopMood, setBoopMood] = useState<"wink" | "beam" | "wow" | null>(null);
  const boopIndexRef = useRef(0);
  const boopTimerRef = useRef<number | null>(null);
  const [gaze, setGaze] = useState({ x: 0, y: 0 });

  useEffect(() => {
    if (!trackMouse) return;
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    const listener: GazeListener = (px, py) => {
      const el = rootRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = px - cx;
      const dy = py - cy;
      const dist = Math.hypot(dx, dy) || 1;
      const strength = Math.min(1, dist / 220);
      const nx = (dx / dist) * 2.7 * strength;
      const ny = (dy / dist) * 1.9 * strength;
      setGaze((prev) => (Math.abs(prev.x - nx) < 0.08 && Math.abs(prev.y - ny) < 0.08 ? prev : { x: nx, y: ny }));
    };
    gazeListeners.add(listener);
    ensurePointerListener();
    return () => {
      gazeListeners.delete(listener);
      maybeRemovePointerListener();
    };
  }, [trackMouse]);

  useEffect(() => () => {
    if (boopTimerRef.current != null) window.clearTimeout(boopTimerRef.current);
  }, []);

  const triggerBoop = () => {
    if (!interactive) return;
    const next = BOOP_MOODS[boopIndexRef.current % BOOP_MOODS.length];
    boopIndexRef.current += 1;
    setBoopMood(next);
    if (boopTimerRef.current != null) window.clearTimeout(boopTimerRef.current);
    boopTimerRef.current = window.setTimeout(() => {
      setBoopMood(null);
      boopTimerRef.current = null;
    }, 1050);
  };

  const mood: Mood = boopMood ?? (thinking ? "thinking" : hovered ? "hover" : "idle");
  const faceOffset = thinking ? { x: 0, y: 0 } : gaze;
  const rx = size <= 24 ? 7 : size >= 44 ? 14 : 10;

  return (
    <span
      ref={rootRef}
      className={`bot-smiley bot-smiley--${variant} is-${mood} ${interactive ? "is-interactive" : ""} ${className}`.trim()}
      style={{
        width: size,
        height: size,
        borderRadius: rx,
        ...(color ? ({ ["--bot-custom-bg" as string]: color } as React.CSSProperties) : {}),
      }}
      title={title}
      aria-hidden="true"
      onMouseEnter={interactive ? () => setHovered(true) : undefined}
      onMouseLeave={interactive ? () => setHovered(false) : undefined}
      onClick={interactive ? triggerBoop : undefined}
    >
      <svg
        className="bot-smiley-svg"
        width={size}
        height={size}
        viewBox="0 0 40 40"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <radialGradient id={`bs-glow-${uid}`} cx="28%" cy="22%" r="78%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.28" />
            <stop offset="55%" stopColor="#ffffff" stopOpacity="0.04" />
            <stop offset="100%" stopColor="#000000" stopOpacity="0.16" />
          </radialGradient>
        </defs>

        <rect x="0.5" y="0.5" width="39" height="39" rx="11.5" fill={`url(#bs-glow-${uid})`} />

        <g
          className="bot-smiley-face"
          style={{
            transform: `translate(${faceOffset.x.toFixed(2)}px, ${faceOffset.y.toFixed(2)}px)`,
          }}
        >
          {(mood === "hover" || mood === "beam" || mood === "wink") && (
            <g className="bot-smiley-cheeks" opacity="0.28">
              <ellipse cx="10.2" cy="23.2" rx="2.4" ry="1.4" fill="#ffffff" />
              <ellipse cx="29.8" cy="23.2" rx="2.4" ry="1.4" fill="#ffffff" />
            </g>
          )}

          <g className="bot-smiley-eyes">
            {mood === "beam" ? (
              <>
                <path d="M11.2 18.2Q14.3 13.6 17.4 18.2" stroke="#ffffff" strokeWidth="2.7" strokeLinecap="round" />
                <path d="M22.6 18.2Q25.7 13.6 28.8 18.2" stroke="#ffffff" strokeWidth="2.7" strokeLinecap="round" />
              </>
            ) : mood === "wink" ? (
              <>
                <rect className="bot-eye-pill" x="12" y="13.4" width="4.6" height="6.8" rx="2.3" fill="#ffffff" />
                <path d="M22.6 17.5Q25.7 14.1 28.8 17.5" stroke="#ffffff" strokeWidth="2.7" strokeLinecap="round" />
              </>
            ) : mood === "wow" ? (
              <>
                <circle cx="14.3" cy="16.8" r="3.1" fill="#ffffff" />
                <circle cx="25.7" cy="16.8" r="3.1" fill="#ffffff" />
              </>
            ) : (
              <>
                <rect className="bot-eye-pill" x="12" y="13.4" width="4.6" height="6.8" rx="2.3" fill="#ffffff" />
                <rect className="bot-eye-pill" x="23.4" y="13.4" width="4.6" height="6.8" rx="2.3" fill="#ffffff" />
              </>
            )}
          </g>

          {mood === "beam" ? (
            <path d="M12.2 23.8Q20 31.6 27.8 23.8" stroke="#ffffff" strokeWidth="2.7" strokeLinecap="round" />
          ) : mood === "hover" ? (
            <path d="M12.6 24Q20 30.2 27.4 24" stroke="#ffffff" strokeWidth="2.6" strokeLinecap="round" />
          ) : mood === "wink" ? (
            <path d="M13.5 24.4Q20.5 29.4 27.5 23.2" stroke="#ffffff" strokeWidth="2.6" strokeLinecap="round" />
          ) : mood === "wow" ? (
            <circle cx="20" cy="26.2" r="2.7" stroke="#ffffff" strokeWidth="2.4" />
          ) : mood === "thinking" ? (
            <path className="bot-mouth-think" d="M14.4 25.8Q20 27.6 25.6 25.8" stroke="#ffffff" strokeWidth="2.5" strokeLinecap="round" />
          ) : (
            <path d="M13.4 24.4Q20 29 26.6 24.4" stroke="#ffffff" strokeWidth="2.5" strokeLinecap="round" />
          )}

          {(mood === "beam" || mood === "wink") && (
            <path
              className="bot-sparkle"
              d="M32.5 6.8L33.3 9L35.5 9.8L33.3 10.6L32.5 12.8L31.7 10.6L29.5 9.8L31.7 9Z"
              fill="#ffffff"
              opacity="0.92"
            />
          )}
        </g>
      </svg>
    </span>
  );
}
