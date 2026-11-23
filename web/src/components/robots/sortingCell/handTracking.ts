/* Google MediaPipe im Browser: Hand (21 Punkte) und Körper (33 Punkte) je Bild.

   Die Kamera und die Rechnung bleiben lokal: die Modelle laufen als WASM aus
   dem eigenen Verzeichnis (`web/public/mediapipe/`, heruntergeladen mit
   `npm run mediapipe:models`), es geht kein Bild und kein Punkt über das Netz.
   `@mediapipe/tasks-vision` wird erst geladen, wenn die Handführung wirklich
   startet — das Portal bleibt ohne Kamera unverändert schnell.

   Diese Datei kennt kein React: sie startet den Kamerastrom, hält die zwei
   Landmarker, ruft je Bild `onFrame` und gibt eine Stopp-Funktion zurück.
   Rechnen (Abbildung auf den Roboter) macht `teach.ts`. */

import type { Landmark, TrackingFrame } from "./teach";

export interface TrackingOptions {
  /** Verzeichnis mit vision_wasm_internal.{js,wasm} (unter dem Portal-Basispfad). */
  wasmDir: string;
  handModel: string;
  poseModel: string;
  /** Sekundenschnitt: höchstens so viele Erkennungen je Sekunde. */
  maxFps?: number;
}

export interface TrackingStats {
  hands: number;
  pose: boolean;
  fps: number;
}

interface Vision {
  FilesetResolver: { forVisionTasks(path: string): Promise<unknown> };
  HandLandmarker: {
    createFromOptions(fileset: unknown, opts: Record<string, unknown>): Promise<{
      detectForVideo(video: HTMLVideoElement, ts: number): {
        landmarks: Landmark[][]; worldLandmarks: Landmark[][];
      };
      close(): void;
    }>;
  };
  PoseLandmarker: {
    createFromOptions(fileset: unknown, opts: Record<string, unknown>): Promise<{
      detectForVideo(video: HTMLVideoElement, ts: number): {
        landmarks: Landmark[][]; worldLandmarks: Landmark[][];
      };
      close(): void;
    }>;
  };
}

/** Sind die Modelldateien da? Ein Range-GET, weil das Portal nur GET beantwortet
 *  und die 14 MB nicht für eine Prüfung durch die Leitung sollen. */
const pickModel = async (url: string, what: string) => {
  let res: Response;
  try {
    res = await fetch(url, { headers: { Range: "bytes=0-1023" }, cache: "no-store" });
  } catch {
    throw new Error(`${what} fehlt (${url}). Auf diesem Rechner: cd web && npm run mediapipe:models`);
  }
  void res.body?.cancel();
  if (!res.ok) throw new Error(`${what} fehlt (${url}). Auf diesem Rechner: cd web && npm run mediapipe:models`);
};

/**
 * Kamera starten und je Bild Hand + Körper verfolgen.
 * `onStats` meldet höchstens einmal je Sekunde, wie viel erkannt wurde.
 */
export async function startHandTracking(
  video: HTMLVideoElement,
  opts: TrackingOptions,
  onFrame: (frame: TrackingFrame) => void,
  onStats: (stats: TrackingStats) => void,
): Promise<() => void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Dieser Browser gibt keine Kamera frei (getUserMedia fehlt).");
  }
  await pickModel(opts.handModel, "Handmodell");
  await pickModel(opts.poseModel, "Körpermodell");

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 960 }, height: { ideal: 720 }, facingMode: "user" },
      audio: false,
    });
  } catch (e) {
    const name = e instanceof DOMException ? e.name : "Error";
    if (name === "NotAllowedError") throw new Error("Die Kamera ist nicht erlaubt — im Browser für diese Seite freigeben.");
    if (name === "NotFoundError") throw new Error("Keine Kamera gefunden.");
    throw new Error(`Kamera nicht verfügbar: ${e instanceof Error ? e.message : String(e)}`);
  }

  const vision = (await import("@mediapipe/tasks-vision")) as unknown as Vision;
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play().catch(() => undefined);

  let stopped = false;
  const stopCamera = () => {
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  };

  let fileset: unknown;
  let handLandmarker: Awaited<ReturnType<Vision["HandLandmarker"]["createFromOptions"]>> | null = null;
  let poseLandmarker: Awaited<ReturnType<Vision["PoseLandmarker"]["createFromOptions"]>> | null = null;
  try {
    fileset = await vision.FilesetResolver.forVisionTasks(opts.wasmDir);
    const base = (delegate: "GPU" | "CPU") => ({
      baseOptions: { modelAssetPath: opts.handModel, delegate },
      runningMode: "VIDEO" as const,
    });
    // GPU zuerst; ohne GPU (oder ohne WebGL2) rechnet MediaPipe auf der CPU.
    for (const delegate of ["GPU", "CPU"] as const) {
      try {
        handLandmarker = await vision.HandLandmarker.createFromOptions(fileset, {
          ...base(delegate), numHands: 2,
          minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
        });
        break;
      } catch (e) {
        if (delegate === "CPU") throw e;
      }
    }
    for (const delegate of ["GPU", "CPU"] as const) {
      try {
        poseLandmarker = await vision.PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: opts.poseModel, delegate },
          runningMode: "VIDEO",
          numPoses: 1,
          minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
        });
        break;
      } catch (e) {
        if (delegate === "CPU") throw e;
      }
    }
  } catch (e) {
    stopCamera();
    throw new Error(`MediaPipe startet nicht: ${e instanceof Error ? e.message : String(e)}`);
  }

  const minGap = 1000 / (opts.maxFps ?? 30);
  let last = 0;
  let lastStamp = 0;
  let frames = 0;
  let lastStats = performance.now();
  let stats: TrackingStats = { hands: 0, pose: false, fps: 0 };

  const loop = (now: number) => {
    if (stopped) return;
    if (now - last >= minGap && video.readyState >= 2) {
      last = now;
      // detectForVideo verlangt streng steigende Zeitstempel.
      const stamp = Math.max(lastStamp + 1, Math.round(now));
      lastStamp = stamp;
      try {
        const hands = handLandmarker?.detectForVideo(video, stamp);
        const pose = poseLandmarker?.detectForVideo(video, stamp);
        const frame: TrackingFrame = {
          hand: hands?.landmarks?.[0] ?? null,
          handWorld: hands?.worldLandmarks?.[0] ?? null,
          pose: pose?.landmarks?.[0] ?? null,
          poseWorld: pose?.worldLandmarks?.[0] ?? null,
          at: stamp,
        };
        onFrame(frame);
        frames++;
        stats = { hands: hands?.landmarks?.length ?? 0, pose: !!frame.pose, fps: stats.fps };
      } catch {
        // Ein einzelnes Bild darf die Spur nicht beenden.
      }
    }
    if (now - lastStats >= 1000) {
      stats = { ...stats, fps: Math.round((frames * 1000) / (now - lastStats)) };
      frames = 0;
      lastStats = now;
      onStats(stats);
    }
    if (!stopped) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  return () => {
    stopped = true;
    handLandmarker?.close();
    poseLandmarker?.close();
    stopCamera();
  };
}
