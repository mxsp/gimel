import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/* Baukasten für die 3D-Geräte (task 37).

   Halbrealistisch statt Blaupause: gerundete Kanten, Lack, Stahl, Gummi und
   ein paar im Browser gezeichnete Texturen (Vakuumtisch, Gitterrost, Warn-
   streifen, Lochwand, Bildschirm). Keine Dateien, keine Downloads.

   Drei Regeln halten die Halle schnell:
   1. Materialien sind geteilt (ein Material je Farbe und Oberfläche) und tragen
      `userData.shared`. Der Abbau der Szene gibt sie nicht frei; wer ein Gerät
      abdunkelt, klont sie vorher (`setDeviceOpacity`).
   2. `finalize` verschmilzt alle unbewegten Teile eines Geräts je Material zu
      einem Körper. Aus ~40 Einzelteilen werden so 6–10 Zeichenaufrufe.
   3. Eine zweite, grobe Fassung (nur große Teile) übernimmt aus der Ferne
      (`THREE.LOD`); andere Ebenen und Nachbarhallen bekommen nur sie.

   Im Node-Test gibt es kein `document`: dann bleiben die Texturen weg, die
   Formen und Maße sind dieselben. */

export interface Palette {
  paint: string;
  paintDark: string;
  steel: string;
  rubber: string;
  accent: string;
  rack: string;
  beam: string;
  safety: string;
  wood: string;
  carton: string;
  water: string;
  screen: string;
  glass: string;
  vest: string;
  work: string;
  head: string;
  forklift: string;
}

const HAS_DOM = typeof document !== "undefined" && typeof document.createElement === "function";

export type Finish = "paint" | "satin" | "metal" | "rubber" | "matte" | "plastic" | "wood" | "carton";

const FINISH: Record<Finish, [number, number]> = {
  paint: [0.48, 0.12],
  satin: [0.36, 0.3],
  metal: [0.3, 0.82],
  rubber: [0.92, 0.0],
  matte: [0.86, 0.04],
  plastic: [0.52, 0.02],
  wood: [0.84, 0.0],
  carton: [0.95, 0.0],
};

export type TexKind =
  | "vacuum" | "grate" | "hazard" | "brushed" | "perforated" | "mesh"
  | "screen" | "carton" | "wrap" | "tread" | "vents" | "brush";

function colour(value: string, fallback = "#5f6b7c"): THREE.Color {
  try { return new THREE.Color(value); } catch { return new THREE.Color(fallback); }
}

/* ---------------------------------------------------------------- Texturen */

const textures = new Map<string, THREE.Texture | null>();

function canvasTexture(kind: TexKind): THREE.CanvasTexture | null {
  if (!HAS_DOM) return null;
  const size = kind === "screen" ? 256 : 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const S = size;
  // Graustufen-Texturen färbt das Material; Weiß heißt „Grundfarbe".
  switch (kind) {
    case "vacuum": {
      ctx.fillStyle = "#d8d8d8"; ctx.fillRect(0, 0, S, S);
      ctx.fillStyle = "#6a6a6a";
      for (let y = 4; y < S; y += 8) for (let x = 4; x < S; x += 8) {
        ctx.beginPath(); ctx.arc(x, y, 1.2, 0, Math.PI * 2); ctx.fill();
      }
      ctx.strokeStyle = "#9a9a9a"; ctx.lineWidth = 1;
      for (let i = 0; i <= S; i += 32) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, S); ctx.stroke(); }
      break;
    }
    case "grate": {
      ctx.fillStyle = "#3a3a3a"; ctx.fillRect(0, 0, S, S);
      ctx.fillStyle = "#e6e6e6";
      for (let x = 0; x < S; x += 16) ctx.fillRect(x, 0, 5, S);
      ctx.fillStyle = "#bdbdbd";
      for (let y = 0; y < S; y += 32) ctx.fillRect(0, y, S, 2);
      break;
    }
    case "hazard": {
      ctx.fillStyle = "#f2c230"; ctx.fillRect(0, 0, S, S);
      ctx.fillStyle = "#1c1f23";
      for (let i = -S; i < S * 2; i += 32) {
        ctx.beginPath();
        ctx.moveTo(i, 0); ctx.lineTo(i + 16, 0); ctx.lineTo(i + 16 - S, S); ctx.lineTo(i - S, S);
        ctx.closePath(); ctx.fill();
      }
      break;
    }
    case "brushed": {
      ctx.fillStyle = "#f0f0f0"; ctx.fillRect(0, 0, S, S);
      let seed = 7;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      for (let i = 0; i < 260; i++) {
        const g = 200 + Math.floor(rnd() * 55);
        ctx.strokeStyle = `rgb(${g},${g},${g})`;
        const y = rnd() * S;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(S, y + (rnd() - 0.5) * 2); ctx.stroke();
      }
      break;
    }
    case "perforated": {
      ctx.fillStyle = "#ededed"; ctx.fillRect(0, 0, S, S);
      ctx.fillStyle = "#555555";
      for (let y = 6; y < S; y += 12) for (let x = 6; x < S; x += 12) {
        ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.fill();
      }
      break;
    }
    case "mesh": {
      // Gitterbox: Drähte deckend, Felder durchsichtig (alphaTest).
      ctx.clearRect(0, 0, S, S);
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 3;
      for (let i = 0; i <= S; i += 16) {
        ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, S); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(S, i); ctx.stroke();
      }
      break;
    }
    case "screen": {
      // Ruhender Bildschirm: Kopfleiste und Textzeilen in einem neutralen Ton.
      // Keine Balken — sie läsen sich als Last oder Fortschritt, den es nicht gibt.
      ctx.fillStyle = "#0b1a2b"; ctx.fillRect(0, 0, S, S);
      ctx.fillStyle = "#24384f"; ctx.fillRect(0, 0, S, 26);
      ctx.fillStyle = "#7d93ab";
      for (const [y, w] of [[60, 0.55], [96, 0.7], [132, 0.4]] as const) ctx.fillRect(18, y, (S - 36) * w, 6);
      break;
    }
    case "carton": {
      ctx.fillStyle = "#e9e9e9"; ctx.fillRect(0, 0, S, S);
      ctx.fillStyle = "#c8c8c8"; ctx.fillRect(S * 0.44, 0, S * 0.12, S);
      ctx.fillStyle = "#ffffff"; ctx.fillRect(S * 0.12, S * 0.62, S * 0.24, S * 0.16);
      break;
    }
    case "wrap": {
      ctx.fillStyle = "#e6e9ec"; ctx.fillRect(0, 0, S, S);
      ctx.strokeStyle = "rgba(255,255,255,0.9)"; ctx.lineWidth = 3;
      for (let i = -S; i < S * 2; i += 22) { ctx.beginPath(); ctx.moveTo(i, S); ctx.lineTo(i + S * 0.6, 0); ctx.stroke(); }
      ctx.strokeStyle = "rgba(160,170,180,0.6)"; ctx.lineWidth = 1;
      for (let y = 8; y < S; y += 14) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(S, y + 3); ctx.stroke(); }
      break;
    }
    case "tread": {
      ctx.fillStyle = "#d0d0d0"; ctx.fillRect(0, 0, S, S);
      ctx.fillStyle = "#8a8a8a";
      for (let y = 0; y < S; y += 16) for (let x = (y / 16) % 2 ? 8 : 0; x < S; x += 16) {
        ctx.fillRect(x + 4, y + 4, 8, 3);
      }
      break;
    }
    case "vents": {
      ctx.fillStyle = "#efefef"; ctx.fillRect(0, 0, S, S);
      ctx.fillStyle = "#6c6c6c";
      for (let y = 20; y < S - 16; y += 10) ctx.fillRect(18, y, S - 36, 4);
      break;
    }
    case "brush": {
      ctx.fillStyle = "#4a4a4a"; ctx.fillRect(0, 0, S, S);
      ctx.fillStyle = "#2a2a2a";
      for (let y = 2; y < S; y += 6) for (let x = 2; x < S; x += 6) ctx.fillRect(x, y, 2, 2);
      break;
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  // Aus der Nähe (Begehen) streifend gesehen: volle Filterung, THREE klemmt.
  tex.anisotropy = 16;
  tex.userData.shared = true;
  return tex;
}

export function texture(kind: TexKind, repeat: [number, number] = [1, 1]): THREE.Texture | null {
  const key = `${kind}|${repeat[0].toFixed(2)}x${repeat[1].toFixed(2)}`;
  if (textures.has(key)) return textures.get(key) ?? null;
  const base = textures.get(kind) ?? canvasTexture(kind);
  if (!textures.has(kind)) textures.set(kind, base);
  let out: THREE.Texture | null = base;
  if (base && (repeat[0] !== 1 || repeat[1] !== 1)) {
    out = base.clone();
    out.repeat.set(repeat[0], repeat[1]);
    out.needsUpdate = true;
    out.userData.shared = true;
  }
  textures.set(key, out);
  return out;
}

/* ------------------------------------------------------------- Materialien */

const materials = new Map<string, THREE.Material>();

function remember<T extends THREE.Material>(key: string, make: () => T): T {
  const hit = materials.get(key) as T | undefined;
  if (hit) return hit;
  const m = make();
  m.name = key;
  m.userData.shared = true;
  materials.set(key, m);
  return m;
}

/** Ein beleuchtetes, geteiltes Material. */
export function mat(value: string, finish: Finish = "paint", tex?: TexKind,
                    repeat: [number, number] = [1, 1]): THREE.MeshStandardMaterial {
  return remember(`s|${value}|${finish}|${tex ?? ""}|${repeat.join("x")}`, () => {
    const [roughness, metalness] = FINISH[finish];
    const m = new THREE.MeshStandardMaterial({ color: colour(value), roughness, metalness });
    const map = tex ? texture(tex, repeat) : null;
    if (map) m.map = map;
    return m;
  });
}

/** Selbstleuchtend (Bildschirm, Leuchtband). Bleibt auch in „Hoch" unbeleuchtet. */
export function glow(value: string, tex?: TexKind): THREE.MeshBasicMaterial {
  return remember(`g|${value}|${tex ?? ""}`, () => {
    const m = new THREE.MeshBasicMaterial({ color: colour(value), toneMapped: false });
    const map = tex ? texture(tex) : null;
    if (map) m.map = map;
    m.userData.glow = true;
    return m;
  });
}

/** Wie `glow`, aber je Gerät eigen: die Signalleuchte blinkt einzeln. */
export function glowOwn(value: string, opacity = 0.95): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ color: colour(value), toneMapped: false, transparent: true, opacity });
  m.userData.glow = true;
  return m;
}

/** Glas, Wasserfilm, Schutzscheiben: durchscheinend, ohne Schatten. */
export function clear(value: string, opacity = 0.28): THREE.MeshBasicMaterial {
  return remember(`c|${value}|${opacity}`, () => {
    const m = new THREE.MeshBasicMaterial({
      color: colour(value), transparent: true, opacity, depthWrite: false,
      side: THREE.DoubleSide, toneMapped: false,
    });
    m.userData.glass = true;
    return m;
  });
}

/** Drahtgitter (Gitterbox, Schutzzaun): Felder durchsichtig über alphaTest. */
export function wire(value: string, repeat: [number, number] = [1, 1]): THREE.MeshStandardMaterial {
  return remember(`w|${value}|${repeat.join("x")}`, () => {
    const map = texture("mesh", repeat);
    const m = new THREE.MeshStandardMaterial({
      color: colour(value), roughness: 0.4, metalness: 0.7, side: THREE.DoubleSide,
      transparent: !map, opacity: map ? 1 : 0.35, alphaTest: map ? 0.5 : 0,
    });
    if (map) { m.map = map; m.alphaMap = map; }
    return m;
  });
}

/* --------------------------------------------------------------- Formteile */

export function at<T extends THREE.Object3D>(parent: THREE.Object3D, obj: T, x = 0, y = 0, z = 0): T {
  obj.position.set(x, y, z);
  parent.add(obj);
  return obj;
}

export function group(parent: THREE.Object3D, x = 0, y = 0, z = 0, ry = 0): THREE.Group {
  const g = at(parent, new THREE.Group(), x, y, z);
  g.rotation.y = ry;
  return g;
}

/** Quader; mit `r` > 0 gerundet (Gehäuse, Abdeckungen). Maße in Metern, Mitte bei x/y/z. */
export function box(parent: THREE.Object3D, w: number, h: number, d: number,
                    x: number, y: number, z: number, material: THREE.Material, r = 0): THREE.Mesh {
  w = Math.max(0.005, w); h = Math.max(0.005, h); d = Math.max(0.005, d);
  const radius = Math.min(r, Math.min(w, h, d) / 2 - 0.001);
  const geometry = radius > 0.004
    // Große Teile zwei Rundungsschritte, kleine einer: genug Licht auf der Kante,
    // ohne dass ein Lager mit Hunderten Kisten Hunderttausende Ecken bekommt.
    ? new RoundedBoxGeometry(w, h, d, Math.max(w, h, d) > 0.6 ? 2 : 1, radius)
    : new THREE.BoxGeometry(w, h, d);
  return at(parent, new THREE.Mesh(geometry, material), x, y, z);
}

/** Zylinder entlang einer Achse. `rBottom` ≠ `rTop` gibt Kegel und Trichter. */
export function cyl(parent: THREE.Object3D, rTop: number, rBottom: number, h: number,
                    x: number, y: number, z: number, material: THREE.Material,
                    axis: "x" | "y" | "z" = "y", segments = 16): THREE.Mesh {
  const mesh = at(parent, new THREE.Mesh(
    new THREE.CylinderGeometry(Math.max(0.003, rTop), Math.max(0.003, rBottom), Math.max(0.005, h), segments),
    material), x, y, z);
  if (axis === "x") mesh.rotation.z = Math.PI / 2;
  else if (axis === "z") mesh.rotation.x = Math.PI / 2;
  return mesh;
}

/** Eine drehende Walze/Scheibe: die Gruppe legt die Achse fest, das Innere
 *  dreht sich um seine eigene y-Achse. So stimmt die Drehrichtung immer
 *  (bis 2026-11-07 drehten die Rollen des Packtischs um die Hochachse). */
export function spinner(parent: THREE.Object3D, r: number, h: number,
                        x: number, y: number, z: number, material: THREE.Material,
                        axis: "x" | "y" | "z", speed = 3, phase = 0, segments = 14): THREE.Group {
  const holder = group(parent, x, y, z);
  if (axis === "x") holder.rotation.z = Math.PI / 2;
  else if (axis === "z") holder.rotation.x = Math.PI / 2;
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, Math.max(0.005, h), segments), material);
  mesh.userData.motion = { kind: "spin", speed, phase };
  holder.add(mesh);
  return holder;
}

/** Schlauch oder Kabel entlang von Punkten. */
export function tube(parent: THREE.Object3D, points: [number, number, number][],
                     radius: number, material: THREE.Material): THREE.Mesh {
  const curve = new THREE.CatmullRomCurve3(points.map(([x, y, z]) => new THREE.Vector3(x, y, z)));
  return at(parent, new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(8, points.length * 6), radius, 6), material));
}

/** Eine Bewegung an ein Teil hängen; die 3D-Schleife liest sie (nur bei laufender Station). */
export function moves(obj: THREE.Object3D, kind: string, extra: Record<string, number> = {}): THREE.Object3D {
  obj.userData.motion = { kind, phase: 0, ...extra };
  return obj;
}

/* ---------------------------------------------- Verschmelzen und Fernstufe */

/** Ab dieser Kamera-Entfernung (m) zeigt ein Gerät seine grobe Fassung. */
export const FAR_DISTANCE_M = 70;
/** Teile, deren Hülle kleiner ist, fehlen in der groben Fassung. */
const FAR_MIN_RADIUS_M = 0.32;

function dynamic(o: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p && p !== root; p = p.parent) {
    if (p.userData?.motion || p.userData?.keep) return true;
  }
  return false;
}

function prepared(mesh: THREE.Mesh, rel: THREE.Matrix4): THREE.BufferGeometry {
  const src = mesh.geometry;
  const g = src.index ? src.toNonIndexed() : src.clone();
  for (const name of Object.keys(g.attributes)) {
    if (name !== "position" && name !== "normal" && name !== "uv") g.deleteAttribute(name);
  }
  if (!g.getAttribute("normal")) g.computeVertexNormals();
  if (!g.getAttribute("uv")) {
    g.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute("position").count * 2), 2));
  }
  g.clearGroups();
  g.applyMatrix4(rel);
  return g;
}

/** Gleiche Oberfläche, andere Farbe → ein Material mit Eckpunktfarben
    (task 41 B). Ein Gerät aus zwölf lackierten Teilen in sechs Farben war
    sechs Zeichenaufrufe, jetzt einer. Nur ohne Textur; das Material ist
    geteilt wie die übrigen des Baukastens. */
function vertexColourMaterial(m: THREE.Material): THREE.Material | null {
  const a = m as any;
  if (a.map || a.alphaMap || a.vertexColors || !a.color) return null;
  const surface = m instanceof THREE.MeshStandardMaterial
    ? `s|${m.roughness}|${m.metalness}|${m.emissive.getHexString()}|${m.emissiveIntensity}`
    : m instanceof THREE.MeshBasicMaterial ? "b" : null;
  if (!surface) return null;
  const key = `vc|${surface}|${m.transparent}|${m.opacity}|${m.side}|${m.depthWrite}|${m.alphaTest}|${m.toneMapped}|${m.userData?.glow ? "g" : ""}${m.userData?.glass ? "c" : ""}`;
  return remember(key, () => {
    const out = m.clone();
    (out as any).color = new THREE.Color(0xffffff);
    (out as any).vertexColors = true;
    out.userData = { glow: m.userData?.glow, glass: m.userData?.glass };
    return out;
  });
}

function paint(g: THREE.BufferGeometry, colour: THREE.Color): THREE.BufferGeometry {
  const n = g.getAttribute("position").count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = colour.r; arr[i * 3 + 1] = colour.g; arr[i * 3 + 2] = colour.b; }
  g.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  return g;
}

/** Fernstufe: Gestalt und Farbe zählen, Oberfläche und Textur nicht. Alles
    Undurchsichtige teilt ein Material (leuchtende Teile ein zweites). */
function farMaterial(m: THREE.Material): THREE.Material | null {
  const a = m as any;
  if (!a.color || (m.transparent && m.opacity < 0.95)) return vertexColourMaterial(m);
  const glowing = !!m.userData?.glow;
  return remember(glowing ? "vc|far|glow" : "vc|far", () => {
    const out = glowing
      ? new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, toneMapped: false })
      : new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.62, metalness: 0.12 });
    if (glowing) out.userData.glow = true;
    return out;
  });
}

/** Teil in den Eimer seines (Eckpunktfarben-)Materials legen. */
function bucket(map: Map<THREE.Material, THREE.BufferGeometry[]>, m: THREE.Material, g: THREE.BufferGeometry,
                far = false): void {
  const vc = far ? farMaterial(m) : vertexColourMaterial(m);
  const key = vc ?? m;
  const list = map.get(key) ?? [];
  list.push(vc ? paint(g, (m as any).color as THREE.Color) : g);
  map.set(key, list);
}

function mergedMesh(material: THREE.Material, parts: THREE.BufferGeometry[]): THREE.Mesh | null {
  const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
  if (!merged) return null;
  if (parts.length > 1) for (const p of parts) p.dispose();
  merged.computeBoundingSphere();
  const mesh = new THREE.Mesh(merged, material);
  mesh.userData.merged = true;
  if (material.userData?.glow) mesh.userData.keepBasic = true;
  if (material.userData?.glass) mesh.userData.noShadow = true;
  return mesh;
}

function bucketsToGroup(buckets: Map<THREE.Material, THREE.BufferGeometry[]>, into: THREE.Group): void {
  for (const [material, parts] of buckets) {
    const mesh = mergedMesh(material, parts);
    if (mesh) into.add(mesh);
  }
}

export interface FinalizeOptions {
  /** Nur die grobe Fassung (andere Ebenen, Nachbarhallen). */
  lowOnly?: boolean;
  farDistance?: number;
}

/**
 * Unbewegte Teile je Material verschmelzen und eine grobe Fernstufe bauen.
 * Bewegte Teile (`userData.motion`) und ausdrücklich behaltene (`keep`)
 * bleiben einzeln, damit die Schleife sie bewegen kann.
 */
/** Bewegte Gruppen (Portal, Revolver, Kopf): was sich gemeinsam bewegt, darf
    in der Gruppe zu einem Körper je Aussehen werden (task 41 B). Verschachtelte
    Bewegung und behaltene Teile bleiben einzeln. */
function mergeMovingGroups(body: THREE.Group): void {
  const groups: THREE.Object3D[] = [];
  body.traverse((o) => { if (o !== body && !(o instanceof THREE.Mesh) && o.userData?.motion) groups.push(o); });
  for (const g of groups) {
    g.updateMatrixWorld(true);
    const inv = g.matrixWorld.clone().invert();
    const parts: THREE.Mesh[] = [];
    const visit = (o: THREE.Object3D) => {
      for (const c of o.children) {
        if (c.userData?.motion || c.userData?.keep) continue;
        if (c instanceof THREE.Mesh) { if (!Array.isArray(c.material)) parts.push(c); }
        else visit(c);
      }
    };
    visit(g);
    if (parts.length < 2) continue;
    const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
    for (const m of parts) bucket(buckets, m.material as THREE.Material, prepared(m, inv.clone().multiply(m.matrixWorld)));
    for (const m of parts) { m.removeFromParent(); m.geometry.dispose(); }
    for (const [material, list] of buckets) {
      const mesh = mergedMesh(material, list);
      if (mesh) g.add(mesh);
    }
  }
}

export function finalize(body: THREE.Group, options: FinalizeOptions = {}): THREE.Object3D {
  body.updateMatrixWorld(true);
  if (!options.lowOnly) { mergeMovingGroups(body); body.updateMatrixWorld(true); }
  const inverse = body.matrixWorld.clone().invert();
  const near = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const far = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const statics: THREE.Mesh[] = [];
  const sphere = new THREE.Sphere();

  body.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || Array.isArray(o.material)) return;
    const rel = inverse.clone().multiply(o.matrixWorld);
    const isDynamic = dynamic(o, body);
    o.geometry.computeBoundingSphere();
    sphere.copy(o.geometry.boundingSphere!).applyMatrix4(rel);
    const big = sphere.radius >= FAR_MIN_RADIUS_M || o.userData?.farKeep;
    // Die Fernstufe zeigt bewegte Teile in Ruhelage: aus der Ferne zählt die Gestalt.
    if (big && !(o.material as THREE.Material).userData?.glass) bucket(far, o.material, prepared(o, rel), true);
    if (isDynamic || options.lowOnly) return;
    bucket(near, o.material, prepared(o, rel));
    statics.push(o);
  });

  const farGroup = new THREE.Group();
  farGroup.name = "device-far";
  bucketsToGroup(far, farGroup);

  const disposeAll = (root: THREE.Object3D) => root.traverse((o) => {
    if (o instanceof THREE.Mesh) o.geometry.dispose();
  });

  if (options.lowOnly) {
    disposeAll(body);
    farGroup.name = body.name;
    farGroup.userData = { ...body.userData };
    return farGroup;
  }

  for (const mesh of statics) {
    mesh.removeFromParent();
    mesh.geometry.dispose();
  }
  // Leere Gruppen ohne Bewegung entfernen: sie kosten nur Matrizen.
  const empty: THREE.Object3D[] = [];
  body.traverse((o) => {
    if (o !== body && o.children.length === 0 && !(o instanceof THREE.Mesh) && !o.userData?.motion) empty.push(o);
  });
  for (const o of empty) o.removeFromParent();
  bucketsToGroup(near, body);

  const lod = new THREE.LOD();
  lod.name = body.name;
  lod.userData = { ...body.userData };
  lod.addLevel(body, 0);
  lod.addLevel(farGroup, options.farDistance ?? FAR_DISTANCE_M);
  return lod;
}

/** Wie viele Zeichenaufrufe ein Gerät in der Nahstufe braucht (für Tests). */
export function drawCount(root: THREE.Object3D): number {
  let n = 0;
  const lod = root instanceof THREE.LOD ? root : root.getObjectByProperty("type", "LOD") as THREE.LOD | undefined;
  const near = lod ? lod.levels[0].object : root;
  near.traverse((o) => { if (o instanceof THREE.Mesh) n++; });
  return n;
}
