import * as THREE from "three";
import type { Station } from "../../factory";
import { fitStationModel, loadStationModelFile, cssColour } from "./stationModel";
import { buildDeviceModel } from "./deviceModels";

/* Ein Modellbild für die Semi-3D-Karte.

   Die Karte projiziert Meter mit einer festen Isometrie. Damit ein Gerät dort
   hineinpasst, wird es mit genau dieser Kamera in ein transparentes Bild
   gerendert. Das gilt für hochgeladene CAD-Dateien genauso wie für die
   eingebauten Geräte aus deviceModels. Das Bild bekommt seine Lage und Größe
   in Projektionseinheiten zurück; IsoFloorPlan setzt es an den Stationspunkt.
   Der Renderer wird geteilt, die Bilder werden je Modell und Blickwinkel
   zwischengespeichert. */

const ISO_COS = Math.cos(Math.PI / 6);
const ISO_SIN = Math.sin(Math.PI / 6);
const SCALE = ISO_COS * Math.SQRT2;

export interface StationModelImage {
  url: string;
  /** Linke obere Ecke relativ zum projizierten Stationsboden. */
  x: number;
  y: number;
  /** Größe in Projektionseinheiten (nicht Pixel). */
  w: number;
  h: number;
}

interface Rig {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
}

let rig: Promise<Rig | null> | null = null;
const cache = new Map<string, Promise<StationModelImage | null>>();
const MAX_CACHE = 24;

function makeRig(): Promise<Rig | null> {
  if (rig) return rig;
  rig = (async () => {
    try {
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      renderer.setPixelRatio(1);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 0.95;
      renderer.setClearColor(0x000000, 0);
      const scene = new THREE.Scene();
      scene.background = null;

      const hemi = new THREE.HemisphereLight(0xffffff, 0x3a4450, 1.05);
      scene.add(hemi);
      const key = new THREE.DirectionalLight(0xffffff, 0.9);
      key.position.set(6, 12, 8);
      scene.add(key);
      const fill = new THREE.DirectionalLight(0xbfd4e6, 0.32);
      fill.position.set(-8, 6, -4);
      scene.add(fill);

      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1000);
      return { renderer, scene, camera };
    } catch (e) {
      console.warn("Gimel Semi-3D: Modellvorschau ohne WebGL", e);
      return null;
    }
  })();
  return rig;
}

/** Vorschauen nacheinander rendern: ein WebGL-Kontext, eine Größe zugleich. */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(job: () => Promise<T>): Promise<T> {
  const next = queue.then(job, job);
  queue = next.then(() => undefined, () => undefined);
  return next;
}

/** Projektionsachsen der Semi-3D-Karte für einen Blickwinkel. */
function isoAxes(yaw: number) {
  const c = Math.cos((yaw * Math.PI) / 180);
  const s = Math.sin((yaw * Math.PI) / 180);
  // Bildschirm x (rechts) und Bildschirm y (nach unten) in Metern.
  const rx = ISO_COS * (c - s);
  const rz = -ISO_COS * (c + s);
  const dx = ISO_SIN * (c + s);
  const dz = ISO_SIN * (c - s);
  return { rx, rz, dx, dz };
}

function cacheKey(s: Station, yaw: number): string {
  return [s.id, s.model_file, s.model_kind ?? "", s.type, s.machine_kind, s.is_storage ? 1 : 0, s.colour, s.label,
    s.model_scale, s.model_rotation, s.rotation, s.w, s.h, Math.round(yaw)].join(":");
}

function trimCache(): void {
  while (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest == null) break;
    cache.delete(oldest);
  }
}

export function stationModelImage(s: Station, yaw: number): Promise<StationModelImage | null> {
  const key = cacheKey(s, yaw);
  const hit = cache.get(key);
  if (hit) return hit;
  const job = serial(async () => {
    const builtIn = () => buildDeviceModel(s, {
      body: cssColour("--g-iso-top", "#4f5b69"),
      bodyDark: cssColour("--g-iso-side", "#343d47"),
      metal: cssColour("--g-floor-hatch", "#738091"),
      line: cssColour("--g-iso-side-line", "#14191f"),
      screen: cssColour("--g-info", "#1668ac"),
      water: cssColour("--g-info", "#1668ac"),
    });
    // Ein fehlendes oder kaputtes CAD-Modell darf die Karte nicht auf einen
    // leeren Kasten zurückwerfen: dann zeigt sie das eingebaute Gerät.
    const source = (s.model_file ? await loadStationModelFile(s) : null) ?? builtIn();
    if (!source) return null;
    const rigged = await makeRig();
    if (!rigged) return null;
    const model = fitStationModel(s, source);
    // Dieselbe Drehung wie der Stationskörper in der SVG-Karte.
    model.rotation.y = -((s.rotation + (s.model_rotation || 0)) * Math.PI) / 180;
    model.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(model);
    if (box.isEmpty()) return null;
    const axes = isoAxes(yaw);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const x of [box.min.x, box.max.x]) {
      for (const y of [box.min.y, box.max.y]) {
        for (const z of [box.min.z, box.max.z]) {
          const sx = axes.rx * x + axes.rz * z;
          const sy = axes.dx * x + axes.dz * z - y;
          minX = Math.min(minX, sx); maxX = Math.max(maxX, sx);
          minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
        }
      }
    }
    const pad = Math.max(0.16, 0.045 * Math.max(maxX - minX, maxY - minY));
    minX -= pad; maxX += pad; minY -= pad; maxY += pad;
    const w = Math.max(0.1, maxX - minX);
    const h = Math.max(0.1, maxY - minY);

    // Kamera in Kamera-Einheiten; die rohe Isometrie skaliert mit SCALE.
    const left = minX / SCALE, right = maxX / SCALE;
    const top = -minY / SCALE, bottom = -maxY / SCALE;
    const camera = rigged.camera;
    camera.left = left; camera.right = right; camera.top = top; camera.bottom = bottom;
    camera.near = 0.01; camera.far = 1000;

    const r = new THREE.Vector3(axes.rx, 0, axes.rz).normalize();
    const u = new THREE.Vector3(-axes.dx, 1, -axes.dz).normalize();
    const back = new THREE.Vector3().crossVectors(r, u).normalize();
    camera.up.copy(u);
    camera.position.copy(back).multiplyScalar(60);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();

    const density = Math.min(34, 560 / Math.max(w, h));
    const pw = Math.max(48, Math.round(w * density));
    const ph = Math.max(48, Math.round(h * density));
    const renderer = rigged.renderer;
    renderer.setSize(pw, ph, false);
    rigged.scene.add(model);
    renderer.render(rigged.scene, camera);
    const url = renderer.domElement.toDataURL("image/png");
    rigged.scene.remove(model);

    return { url, x: minX, y: minY, w, h };
  }).catch((e) => {
    console.warn("Gimel Semi-3D: Modellvorschau fehlgeschlagen", s.model_file, e);
    return null;
  });
  cache.set(key, job);
  trimCache();
  return job;
}
