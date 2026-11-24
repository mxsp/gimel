import { useEffect, useId, useRef, useState } from "react";

type Mood = "idle" | "hover" | "wink" | "beam" | "wow" | "thinking";
export type BotCharacter = "default" | "erp" | "twin" | "lab";

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
  character?: BotCharacter;
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
  character = "default",
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

  const maxX = character === "default" ? 2.7 : 2.1;
  const maxY = character === "default" ? 1.9 : 1.4;

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
      const nx = (dx / dist) * maxX * strength;
      const ny = (dy / dist) * maxY * strength;
      setGaze((prev) => (Math.abs(prev.x - nx) < 0.08 && Math.abs(prev.y - ny) < 0.08 ? prev : { x: nx, y: ny }));
    };
    gazeListeners.add(listener);
    ensurePointerListener();
    return () => {
      gazeListeners.delete(listener);
      maybeRemovePointerListener();
    };
  }, [trackMouse, maxX, maxY]);

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
  const charClass = character !== "default" ? `bot-smiley--char-${character}` : "";

  return (
    <span
      ref={rootRef}
      data-character={character}
      className={`bot-smiley bot-smiley--${variant} ${charClass} is-${mood} ${interactive ? "is-interactive" : ""} ${className}`.trim()}
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
          {character === "erp" && (
            <>
              {/* Bauleiter-Schutzhelm mit Stirnlampe */}
              <path
                d="M10.5 13.6C10.5 7.4 14.4 4.8 20 4.8C25.6 4.8 29.5 7.4 29.5 13.6Z"
                fill="#ffffff"
                fillOpacity="0.96"
              />
              <path
                d="M20 4.8L20 12.6"
                stroke="#047857"
                strokeOpacity="0.34"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
              <rect x="7.8" y="12.2" width="24.4" height="2.6" rx="1.3" fill="#ffffff" />
              <circle className="bot-erp-lamp" cx="20" cy="9.2" r="1.85" fill="#fbbf24" />
              <circle cx="20" cy="9.2" r="0.75" fill="#fef3c7" />

              {(mood === "hover" || mood === "beam" || mood === "wink") && (
                <g className="bot-smiley-cheeks" opacity="0.28">
                  <ellipse cx="10.4" cy="24.6" rx="2.3" ry="1.3" fill="#ffffff" />
                  <ellipse cx="29.6" cy="24.6" rx="2.3" ry="1.3" fill="#ffffff" />
                </g>
              )}

              {mood !== "beam" && mood !== "wow" && (
                <g opacity="0.78">
                  <path d="M11.8 15.8Q14.3 14.8 16.8 15.7" stroke="#ffffff" strokeWidth="1.5" strokeLinecap="round" />
                  <path d="M23.2 15.7Q25.7 14.8 28.2 15.8" stroke="#ffffff" strokeWidth="1.5" strokeLinecap="round" />
                </g>
              )}

              <g className="bot-smiley-eyes">
                {mood === "beam" ? (
                  <>
                    <path d="M11.6 20Q14.3 16 17 20" stroke="#ffffff" strokeWidth="2.5" strokeLinecap="round" />
                    <path d="M23 20Q25.7 16 28.4 20" stroke="#ffffff" strokeWidth="2.5" strokeLinecap="round" />
                  </>
                ) : mood === "wink" ? (
                  <>
                    <rect className="bot-eye-pill" x="12.2" y="16.8" width="4.2" height="5.2" rx="2.1" fill="#ffffff" />
                    <path d="M23 19.4Q25.7 16.4 28.4 19.4" stroke="#ffffff" strokeWidth="2.5" strokeLinecap="round" />
                  </>
                ) : mood === "wow" ? (
                  <>
                    <circle cx="14.3" cy="19.3" r="2.6" fill="#ffffff" />
                    <circle cx="25.7" cy="19.3" r="2.6" fill="#ffffff" />
                  </>
                ) : (
                  <>
                    <rect className="bot-eye-pill" x="12.2" y="16.8" width="4.2" height="5.2" rx="2.1" fill="#ffffff" />
                    <rect className="bot-eye-pill" x="23.6" y="16.8" width="4.2" height="5.2" rx="2.1" fill="#ffffff" />
                  </>
                )}
              </g>

              {mood === "beam" ? (
                <path d="M12.8 25.4Q20 31.8 27.2 25.4" stroke="#ffffff" strokeWidth="2.6" strokeLinecap="round" />
              ) : mood === "hover" ? (
                <path d="M13.2 25.6Q20 30.8 26.8 25.6" stroke="#ffffff" strokeWidth="2.5" strokeLinecap="round" />
              ) : mood === "wink" ? (
                <path d="M13.8 26Q20.5 30.2 27.2 24.8" stroke="#ffffff" strokeWidth="2.5" strokeLinecap="round" />
              ) : mood === "wow" ? (
                <circle cx="20" cy="27.4" r="2.4" stroke="#ffffff" strokeWidth="2.3" />
              ) : mood === "thinking" ? (
                <path className="bot-mouth-think" d="M14.8 27Q20 28.5 25.2 27" stroke="#ffffff" strokeWidth="2.4" strokeLinecap="round" />
              ) : (
                <path d="M13.6 25.8Q20 30.2 26.4 25.8" stroke="#ffffff" strokeWidth="2.5" strokeLinecap="round" />
              )}

              {(mood === "beam" || mood === "wink") && (
                <path
                  className="bot-sparkle"
                  d="M32.8 6.4L33.5 8.3L35.4 9L33.5 9.7L32.8 11.6L32.1 9.7L30.2 9L32.1 8.3Z"
                  fill="#ffffff"
                  opacity="0.92"
                />
              )}
            </>
          )}

          {character === "twin" && (
            <>
              {/* 3D-Würfelkrone + räumliches Visier */}
              <path d="M20 3.3L24.6 5.6L20 7.9L15.4 5.6Z" fill="#e0f2fe" />
              <path d="M15.4 5.6L20 7.9L20 11.8L15.4 9.5Z" fill="#bae6fd" fillOpacity="0.9" />
              <path d="M24.6 5.6L20 7.9L20 11.8L24.6 9.5Z" fill="#7dd3fc" fillOpacity="0.9" />

              <rect
                x="6.8"
                y="13.8"
                width="26.4"
                height="9.4"
                rx="4.7"
                fill="#0f172a"
                fillOpacity="0.62"
                stroke="#ffffff"
                strokeWidth="1.9"
              />
              <path
                className="bot-twin-glint"
                d="M10.4 15.2L13.1 15.2L10.6 21.8L8.4 21.8Z"
                fill="#bae6fd"
                opacity="0.34"
              />

              {(mood === "hover" || mood === "beam" || mood === "wink") && (
                <g className="bot-smiley-cheeks" opacity="0.26">
                  <ellipse cx="10.4" cy="25.2" rx="2.2" ry="1.2" fill="#ffffff" />
                  <ellipse cx="29.6" cy="25.2" rx="2.2" ry="1.2" fill="#ffffff" />
                </g>
              )}

              <g className="bot-smiley-eyes">
                {mood === "beam" ? (
                  <>
                    <path d="M11.8 19.6L14.4 16.8L17 19.6" stroke="#e0f2fe" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M23 19.6L25.6 16.8L28.2 19.6" stroke="#e0f2fe" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                  </>
                ) : mood === "wink" ? (
                  <>
                    <rect className="bot-eye-pill" x="12.2" y="16.1" width="4.4" height="4.8" rx="2.2" fill="#e0f2fe" />
                    <path d="M23 19.4L25.6 16.9L28.2 19.4" stroke="#e0f2fe" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                  </>
                ) : mood === "wow" ? (
                  <>
                    <circle cx="14.4" cy="18.5" r="2.3" stroke="#e0f2fe" strokeWidth="1.8" />
                    <circle cx="14.4" cy="18.5" r="0.85" fill="#ffffff" />
                    <circle cx="25.6" cy="18.5" r="2.3" stroke="#e0f2fe" strokeWidth="1.8" />
                    <circle cx="25.6" cy="18.5" r="0.85" fill="#ffffff" />
                  </>
                ) : (
                  <>
                    <rect className="bot-eye-pill" x="12.2" y="16.1" width="4.4" height="4.8" rx="2.2" fill="#e0f2fe" />
                    <rect className="bot-eye-pill" x="23.4" y="16.1" width="4.4" height="4.8" rx="2.2" fill="#e0f2fe" />
                  </>
                )}
              </g>

              {mood === "beam" ? (
                <path d="M13 26.2Q20 31.8 27 26.2" stroke="#ffffff" strokeWidth="2.5" strokeLinecap="round" />
              ) : mood === "hover" ? (
                <path d="M13.4 26.4Q20 30.8 26.6 26.4" stroke="#ffffff" strokeWidth="2.4" strokeLinecap="round" />
              ) : mood === "wink" ? (
                <path d="M14 26.6Q20.5 30.4 27 25.6" stroke="#ffffff" strokeWidth="2.4" strokeLinecap="round" />
              ) : mood === "wow" ? (
                <circle cx="20" cy="28" r="2.3" stroke="#ffffff" strokeWidth="2.2" />
              ) : mood === "thinking" ? (
                <path className="bot-mouth-think" d="M15 27.6Q20 29 25 27.6" stroke="#ffffff" strokeWidth="2.3" strokeLinecap="round" />
              ) : (
                <path d="M14 26.6Q20 30.4 26 26.6" stroke="#ffffff" strokeWidth="2.4" strokeLinecap="round" />
              )}

              {(mood === "beam" || mood === "wink") && (
                <path
                  className="bot-sparkle"
                  d="M32.6 6.2L33.4 8.2L35.4 9L33.4 9.8L32.6 11.8L31.8 9.8L29.8 9L31.8 8.2Z"
                  fill="#e0f2fe"
                  opacity="0.94"
                />
              )}
            </>
          )}

          {character === "lab" && (
            <>
              {/* KI-Antenne + runde Laborbrille */}
              <path
                d="M20 11.2C19.4 8.9 21.1 7.6 20.2 5.6"
                stroke="#ffffff"
                strokeWidth="2"
                strokeLinecap="round"
              />
              <rect x="17.2" y="10.2" width="5.6" height="2.2" rx="1.1" fill="#ffffff" fillOpacity="0.92" />
              <circle className="bot-lab-orb" cx="20.2" cy="4.6" r="2.4" fill="#fde047" />
              <circle cx="19.5" cy="4" r="0.8" fill="#ffffff" />

              <path d="M6.2 17.8L8.7 18.2M31.3 18.2L33.8 17.8" stroke="#ffffff" strokeWidth="1.7" strokeLinecap="round" />
              <path d="M18.9 18Q20 17 21.1 18" stroke="#ffffff" strokeWidth="1.8" strokeLinecap="round" />
              <circle cx="13.8" cy="18.4" r="5.1" fill="#ffffff" fillOpacity="0.16" stroke="#ffffff" strokeWidth="1.9" />
              <circle cx="26.2" cy="18.4" r="5.1" fill="#ffffff" fillOpacity="0.16" stroke="#ffffff" strokeWidth="1.9" />

              {(mood === "hover" || mood === "beam" || mood === "wink") && (
                <g className="bot-smiley-cheeks" opacity="0.28">
                  <ellipse cx="10.2" cy="25.2" rx="2.2" ry="1.2" fill="#ffffff" />
                  <ellipse cx="29.8" cy="25.2" rx="2.2" ry="1.2" fill="#ffffff" />
                </g>
              )}

              <g className="bot-smiley-eyes">
                {mood === "beam" ? (
                  <>
                    <path d="M11.4 19.3Q13.8 15.8 16.2 19.3" stroke="#ffffff" strokeWidth="2.3" strokeLinecap="round" />
                    <path d="M23.8 19.3Q26.2 15.8 28.6 19.3" stroke="#ffffff" strokeWidth="2.3" strokeLinecap="round" />
                  </>
                ) : mood === "wink" ? (
                  <>
                    <rect className="bot-eye-pill" x="12" y="15.8" width="3.6" height="5.2" rx="1.8" fill="#ffffff" />
                    <path d="M23.8 18.8Q26.2 16 28.6 18.8" stroke="#ffffff" strokeWidth="2.3" strokeLinecap="round" />
                  </>
                ) : mood === "wow" ? (
                  <>
                    <circle cx="13.8" cy="18.4" r="2.4" fill="#ffffff" />
                    <circle cx="26.2" cy="18.4" r="2.4" fill="#ffffff" />
                  </>
                ) : (
                  <>
                    <rect className="bot-eye-pill" x="12" y="15.8" width="3.6" height="5.2" rx="1.8" fill="#ffffff" />
                    <rect className="bot-eye-pill" x="24.4" y="15.8" width="3.6" height="5.2" rx="1.8" fill="#ffffff" />
                  </>
                )}
              </g>

              {mood === "beam" ? (
                <path d="M13 26.4Q20 32.2 27 26.4" stroke="#ffffff" strokeWidth="2.5" strokeLinecap="round" />
              ) : mood === "hover" ? (
                <path d="M13.4 26.6Q20 31.2 26.6 26.6" stroke="#ffffff" strokeWidth="2.4" strokeLinecap="round" />
              ) : mood === "wink" ? (
                <path d="M13.8 26.8Q20.5 30.8 27.2 25.8" stroke="#ffffff" strokeWidth="2.4" strokeLinecap="round" />
              ) : mood === "wow" ? (
                <circle cx="20" cy="28.2" r="2.3" stroke="#ffffff" strokeWidth="2.2" />
              ) : mood === "thinking" ? (
                <path className="bot-mouth-think" d="M14.8 27.8Q20 29.3 25.2 27.8" stroke="#ffffff" strokeWidth="2.3" strokeLinecap="round" />
              ) : (
                <path d="M13.8 26.6Q20 30.8 26.2 26.6" stroke="#ffffff" strokeWidth="2.4" strokeLinecap="round" />
              )}

              {(mood === "beam" || mood === "wink" || mood === "thinking") && (
                <path
                  className="bot-sparkle"
                  d="M32.6 6.8L33.3 8.8L35.3 9.5L33.3 10.2L32.6 12.2L31.9 10.2L29.9 9.5L31.9 8.8Z"
                  fill="#fde047"
                  opacity="0.95"
                />
              )}
            </>
          )}

          {character === "default" && (
            <>
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
            </>
          )}
        </g>
      </svg>
    </span>
  );
}
