import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { getToken } from "../../api";
import type { Station } from "../../factory";

/* Hochgeladene Maschinenmodelle — einmal geladen, von beiden Ansichten benutzt.

   Die Semi-3D-Karte zeichnet keine echte Szene. Sie bekommt deshalb aus diesem
   Modul ein Bild des Modells, das mit derselben isometrischen Kamera gerendert
   wurde wie die Karte selbst. So steht in beiden Ansichten dieselbe Maschine an
   derselben Stelle, ohne dass die Karte ihre SVG-Ruhe verliert. */

const rawCache = new Map<string, Promise<THREE.Group | null>>();

/** OBJ bringt oft keine Normalen mit; ohne sie bleibt das Modell flach. */
function prepareModel(root: THREE.Object3D): void {
  root.traverse((o) => {
    if (o instanceof THREE.Mesh && !o.geometry.getAttribute("normal")) {
      o.geometry.computeVertexNormals();
    }
  });
}

/** Eine CSS-Farbe auflösen — auch wenn sie aus einem anderen Token besteht. */
export function cssColour(name: string, fallback: string): string {
  try {
    const probe = document.createElement("span");
    probe.style.cssText = "position:fixed;left:-9999px;top:-9999px;pointer-events:none";
    document.body.appendChild(probe);
    probe.style.color = `var(${name})`;
    const v = getComputedStyle(probe).color;
    probe.remove();
    return v && v !== "rgba(0, 0, 0, 0)" ? v : fallback;
  } catch { return fallback; }
}

async function fetchModel(s: Station): Promise<THREE.Group | null> {
  try {
    const token = getToken();
    const url = `/api/factory/stations/${s.id}/model?v=${encodeURIComponent(s.model_file)}`;
    const resp = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!resp.ok) return null;
    const buf = await resp.arrayBuffer();
    const format = (s.model_file.split(".").pop() || "").toLowerCase();

    if (format === "obj") {
      const root = new OBJLoader().parse(new TextDecoder().decode(buf));
      prepareModel(root);
      return root;
    }
    if (format === "stl") {
      const geometry = new STLLoader().parse(buf);
      if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
      const group = new THREE.Group();
      group.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
        color: new THREE.Color(cssColour("--g-iso-top", "#4f5b69")),
        roughness: 0.72,
        metalness: 0.08,
      })));
      return group;
    }

    const loader = new GLTFLoader();
    const gltf = await new Promise<any>((resolve, reject) => {
      loader.parse(buf, "", resolve, reject);
    });
    const root = gltf.scene ?? gltf.scenes?.[0];
    return root ? (root as THREE.Group) : null;
  } catch (e) {
    console.warn("Gimel 3D: Modell konnte nicht gelesen werden", s.model_file, e);
    return null;
  }
}

/** Das rohe Modell je Datei, nicht je Ansicht. Aufrufer klonen es. */
export function loadStationModelFile(s: Station): Promise<THREE.Group | null> {
  const key = `${s.id}:${s.model_file}`;
  const cached = rawCache.get(key);
  if (cached) return cached;
  const job = fetchModel(s);
  rawCache.set(key, job);
  return job;
}

/** Modell auf das Stationsmaß bringen: Mitte auf den Ursprung, Sohle auf y = 0.
    Die Drehung bleibt beim Aufrufer, damit 3D und Semi-3D dieselbe Basis haben. */
export function fitStationModel(s: Station, source: THREE.Group): THREE.Group {
  const copy = source.clone(true);
  copy.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.castShadow = false;
      o.receiveShadow = false;
      o.frustumCulled = false;
    }
  });
  const box3 = new THREE.Box3().setFromObject(copy);
  const size = box3.getSize(new THREE.Vector3());
  const fit = Math.min(s.w / Math.max(size.x, 0.01), s.h / Math.max(size.z, 0.01)) * (s.model_scale || 1);
  const scale = Math.min(fit, size.y > 0 ? 6 / size.y : fit);
  copy.scale.setScalar(scale);
  copy.updateMatrixWorld(true);
  const after = new THREE.Box3().setFromObject(copy);
  copy.position.x -= (after.min.x + after.max.x) / 2;
  copy.position.z -= (after.min.z + after.max.z) / 2;
  copy.position.y -= after.min.y;
  copy.updateMatrixWorld(true);
  const group = new THREE.Group();
  group.add(copy);
  return group;
}
