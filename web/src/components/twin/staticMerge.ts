import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";

/* Unbewegte Teile einer Halle verschmelzen (task 41 B).

   Die Halle bestand am 2026-11-07 aus 711 einzelnen Körpern mit 412
   Materialien: jede Wandscheibe, jede Stufe, jede Pfette, jeder Gangpfeil ein
   eigener Zeichenaufruf. Dieser Durchgang fasst Körper und Linien zusammen, die
   - kein Kennzeichen tragen (leeres ``userData`` am Teil und an allen
     Vorfahren bis zum Behälter: Stationen, Bewegung, Roboter, Belebung,
     Auswahl und Ziehen bleiben unberührt),
   - keinen Namen haben (nach Namen gesuchte Teile bleiben einzeln),
   - sichtbar sind und kein LOD, keine Instanz, keine breite Linie (Line2) sind,
   - dasselbe Aussehen haben (Materialeigenschaften, nicht -identität).
   Flache Farben ohne Textur (MeshBasic, LineBasic) dürfen sich in der Farbe
   unterscheiden: die Farbe wandert dann in die Eckpunkte (``vertexColors``).

   Verschmolzen wird **innerhalb des nächsten benannten Behälters**
   (``hall-shell``, ``vertical-stair``, …) oder der Wurzel: ein Schalter, der
   einen benannten Teil ausblendet, trifft weiter alles darin. Die Originale
   werden entfernt und ihre eigenen Geometrien freigegeben; geteilte
   (``userData.shared``) nie, Materialien nur, wenn sie nirgends mehr hängen. */

export interface MergeStats { before: number; after: number; }

export interface MergeOptions {
  /** Reine Anschauung (andere Ebenen, Nachbarhallen): Kennzeichen und Namen
      zählen nicht, alles verschmilzt in die Wurzel. Nur für Teile, die kein
      Klickziel sind und bei jeder Änderung neu gebaut werden. */
  loose?: boolean;
  minGroup?: number;
}

/** Kennzeichen, die nur beschreiben und nie einzelne Kinder ansprechen. */
const DESCRIPTIVE = new Set(["vertical", "ownMaterials"]);

const isPlain = (o: THREE.Object3D) => !o.userData || Object.keys(o.userData).length === 0;

/** Darf die Farbe in die Eckpunkte wandern? Nur flache Farbe ohne Textur. */
function colourless(m: THREE.Material): boolean {
  const a = m as any;
  return (a.isMeshBasicMaterial || (a.isLineBasicMaterial && !a.isLineDashedMaterial)) && !a.map && !a.alphaMap && !a.vertexColors;
}

/** Durchscheinend ohne Textur: auch die Deckkraft darf in die Eckpunkte
    (RGBA), dann verschmelzen Lastbalken, Spur und Füllung trotz anderer
    Deckkraft. Nur für Flächen, die sich nicht gegenseitig verdecken. */
function alphaless(m: THREE.Material): boolean {
  return colourless(m) && m.transparent && !!(m as any).isMeshBasicMaterial;
}

function matKey(m: THREE.Material, vc: boolean, va = false): string | null {
  const a = m as any;
  if (a.isShaderMaterial || a.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile) return null;
  const c = (v: any) => (v && v.isColor ? v.getHexString() : "");
  return [
    m.type, vc ? (va ? "vca" : "vc") : c(a.color), c(a.emissive), a.emissiveIntensity ?? "", a.roughness ?? "", a.metalness ?? "",
    va ? "-" : m.opacity, m.transparent, m.side, m.depthWrite, m.depthTest, m.blending, m.alphaTest,
    m.polygonOffset ? `${m.polygonOffsetFactor}/${m.polygonOffsetUnits}` : "", m.colorWrite,
    a.map?.uuid ?? "", a.alphaMap?.uuid ?? "", a.vertexColors ?? "", a.wireframe ?? "",
    a.flatShading ?? "", m.toneMapped, a.fog ?? "", m.visible, a.linewidth ?? "",
    a.dashSize ?? "", a.gapSize ?? "", a.scale ?? "",
  ].join("|");
}

function geoKey(g: THREE.BufferGeometry, line: boolean): string | null {
  // Gruppen (BoxGeometry: sechs Seiten) zählen bei einem einzigen Material
  // nicht — der Renderer zeichnet dann die ganze Geometrie.
  if (Object.keys(g.morphAttributes).length) return null;
  const attrs: string[] = [];
  for (const k of Object.keys(g.attributes).sort()) {
    const at = g.attributes[k] as THREE.BufferAttribute;
    if ((at as any).isInterleavedBufferAttribute) return null;
    attrs.push(`${k}:${at.itemSize}:${at.normalized}`);
  }
  // Linien werden ohnehin zu Strecken ohne Index aufgelöst.
  return `${line ? "L" : g.index ? "i" : "n"}|${attrs.join(",")}`;
}

/** Linienzug oder -schleife → Strecken (Paare), ohne Index. */
function toSegments(o: THREE.Line, g: THREE.BufferGeometry): THREE.BufferGeometry {
  const src = g.index ? g.toNonIndexed() : g;
  const anyO = o as any;
  if (anyO.isLineSegments) return src === g ? g.clone() : src;
  const loop = !!anyO.isLineLoop;
  const n = src.attributes.position.count;
  const order: number[] = [];
  for (let i = 0; i + 1 < n; i++) order.push(i, i + 1);
  if (loop && n > 2) order.push(n - 1, 0);
  const out = new THREE.BufferGeometry();
  for (const [k, at] of Object.entries(src.attributes)) {
    const a = at as THREE.BufferAttribute;
    const arr = new Float32Array(order.length * a.itemSize);
    order.forEach((idx, j) => { for (let c = 0; c < a.itemSize; c++) arr[j * a.itemSize + c] = a.array[idx * a.itemSize + c] as number; });
    out.setAttribute(k, new THREE.BufferAttribute(arr, a.itemSize, a.normalized));
  }
  if (src !== g) src.dispose();
  return out;
}

/** Breite Linie (Line2/LineSegments2): Aussehen ohne Identität. */
function fatKey(m: THREE.Material, g: THREE.BufferGeometry): string | null {
  const a = m as any;
  if (!a.isLineMaterial || !g.attributes.instanceStart) return null;
  return ["fat", a.color?.getHexString?.(), a.linewidth, m.opacity, m.transparent, a.dashed, a.dashSize, a.gapSize,
    a.dashScale, a.worldUnits, m.depthWrite, m.depthTest, a.alphaToCoverage, a.vertexColors, !!g.attributes.instanceColorStart,
    m.blending, m.side, m.toneMapped].join("|");
}

/** Strecken einer breiten Linie in Behälterachsen (je Strecke 6 Werte). */
function fatSegments(g: THREE.BufferGeometry, rel: THREE.Matrix4, out: number[], colours: number[] | null): void {
  const s = g.attributes.instanceStart as any, e = g.attributes.instanceEnd as any;
  const cs = g.attributes.instanceColorStart as any, ce = g.attributes.instanceColorEnd as any;
  const v = new THREE.Vector3();
  for (let i = 0; i < s.count; i++) {
    v.set(s.getX(i), s.getY(i), s.getZ(i)).applyMatrix4(rel); out.push(v.x, v.y, v.z);
    v.set(e.getX(i), e.getY(i), e.getZ(i)).applyMatrix4(rel); out.push(v.x, v.y, v.z);
    if (colours && cs && ce) colours.push(cs.getX(i), cs.getY(i), cs.getZ(i), ce.getX(i), ce.getY(i), ce.getZ(i));
  }
}

export function mergeStatic(root: THREE.Object3D, opts: MergeOptions = {}): MergeStats {
  const loose = !!opts.loose;
  const minGroup = opts.minGroup ?? 2;
  root.updateMatrixWorld(true);
  type Item = THREE.Mesh | THREE.Line;
  type Bucket = { container: THREE.Object3D; mat: THREE.Material; items: Item[]; line: boolean; vc: boolean; va?: boolean; fat?: boolean };
  const buckets = new Map<string, Bucket>();
  let before = 0;
  const containerIds = new Map<THREE.Object3D, number>();

  const consider = (c: Item, container: THREE.Object3D, plain: boolean, line: boolean) => {
    before++;
    if (!plain || (c.name && !loose) || Array.isArray(c.material) || c.children.length) return;
    if (c.matrixWorld.determinant() <= 0) return;
    const mat = c.material as THREE.Material;
    const vc = colourless(mat) && !c.geometry.attributes.color;
    const va = vc && !line && alphaless(mat);
    const mk = matKey(mat, vc, va);
    const gk = geoKey(c.geometry, line);
    if (!mk || !gk) return;
    if (!containerIds.has(container)) containerIds.set(container, containerIds.size);
    const key = `${containerIds.get(container)}#${mk}#${gk}#${c.renderOrder}#${c.castShadow}${c.receiveShadow}${c.frustumCulled}`;
    let b = buckets.get(key);
    if (!b) { b = { container, mat, items: [], line, vc, va }; buckets.set(key, b); }
    b.items.push(c);
  };

  const visit = (o: THREE.Object3D, container: THREE.Object3D, clean: boolean) => {
    for (const c of o.children) {
      if (!c.visible) continue;
      const anyC = c as any;
      if (anyC.isLOD || anyC.isCSS2DObject || anyC.isInstancedMesh || anyC.isSkinnedMesh || anyC.isPoints || anyC.isSprite) continue;
      const plain = loose || (clean && isPlain(c));
      if (anyC.isLineSegments2 || anyC.isLine2) {
        before++;
        const ln = c as THREE.Mesh;
        if (!plain || (ln.name && !loose) || Array.isArray(ln.material) || ln.children.length) continue;
        const fk = fatKey(ln.material as THREE.Material, ln.geometry);
        if (!fk) continue;
        if (!containerIds.has(container)) containerIds.set(container, containerIds.size);
        const key = `${containerIds.get(container)}#${fk}#${ln.renderOrder}#${ln.frustumCulled}`;
        let b = buckets.get(key);
        if (!b) { b = { container, mat: ln.material as THREE.Material, items: [], line: false, vc: false, fat: true }; buckets.set(key, b); }
        b.items.push(ln);
        continue;
      }
      if (anyC.isMesh) { consider(c as THREE.Mesh, container, plain, false); continue; }
      if (anyC.isLine) { consider(c as THREE.Line, container, plain, true); continue; }
      // Ein Teilbaum mit Kennzeichen bleibt ganz, wie er ist — außer einer
      // benannten Gruppe, die nur beschreibt (Treppe/Aufzug): in sie hinein
      // darf verschmolzen werden, ihr Kennzeichen bleibt an ihr.
      if (!plain) {
        const keys = Object.keys(c.userData ?? {});
        if (clean && c.name && keys.every((k) => DESCRIPTIVE.has(k))) visit(c, c, true);
        continue;
      }
      visit(c, !loose && (c === root || !!c.name) ? c : container, true);
    }
  };
  visit(root, root, true);

  let removed = 0, added = 0;
  const dropped = new Set<THREE.Material>();
  const inv = new THREE.Matrix4();
  const rel = new THREE.Matrix4();
  for (const b of buckets.values()) {
    if (b.items.length < minGroup) continue;
    inv.copy(b.container.matrixWorld).invert();
    if (b.fat) {
      const pos: number[] = [];
      const col: number[] | null = b.items[0].geometry.attributes.instanceColorStart ? [] : null;
      for (const m of b.items) { rel.multiplyMatrices(inv, m.matrixWorld); fatSegments(m.geometry, rel, pos, col); }
      const geo = new LineSegmentsGeometry().setPositions(pos);
      if (col) geo.setColors(col);
      const out = new LineSegments2(geo, b.mat as any);
      if ((b.mat as any).dashed) out.computeLineDistances();
      out.renderOrder = b.items[0].renderOrder;
      out.frustumCulled = b.items[0].frustumCulled;
      b.container.add(out);
      added++;
      for (const m of b.items) {
        m.removeFromParent();
        removed++;
        m.geometry.dispose();
        if (m.material !== b.mat) dropped.add(m.material as THREE.Material);
      }
      continue;
    }
    const geos: THREE.BufferGeometry[] = [];
    for (const m of b.items) {
      rel.multiplyMatrices(inv, m.matrixWorld);
      let g = b.line ? toSegments(m as THREE.Line, m.geometry) : m.geometry.clone();
      g.clearGroups();
      g.applyMatrix4(rel);
      if (b.vc) {
        const col = (m.material as any).color as THREE.Color;
        const n = g.attributes.position.count;
        const k = b.va ? 4 : 3;
        const op = (m.material as THREE.Material).opacity;
        const arr = new Float32Array(n * k);
        for (let i = 0; i < n; i++) {
          arr[i * k] = col.r; arr[i * k + 1] = col.g; arr[i * k + 2] = col.b;
          if (b.va) arr[i * k + 3] = op;
        }
        g.setAttribute("color", new THREE.BufferAttribute(arr, k));
      }
      // Gemischt indiziert/unindiziert kann mergeGeometries nicht.
      if (!b.line && g.index && b.items.some((x) => !x.geometry.index)) g = g.toNonIndexed();
      geos.push(g);
    }
    const merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (!merged) continue;
    merged.computeBoundingSphere();
    merged.computeBoundingBox();
    let mat = b.mat;
    if (b.vc) {
      mat = b.mat.clone();
      (mat as any).color = new THREE.Color(0xffffff);
      (mat as any).vertexColors = true;
      if (b.va) mat.opacity = 1;
      mat.userData = {};
      if (!b.mat.userData?.shared) dropped.add(b.mat);
    }
    const first = b.items[0];
    const out = b.line ? new THREE.LineSegments(merged, mat) : new THREE.Mesh(merged, mat);
    out.renderOrder = first.renderOrder;
    out.castShadow = first.castShadow;
    out.receiveShadow = first.receiveShadow;
    out.frustumCulled = first.frustumCulled;
    b.container.add(out);
    added++;
    for (const m of b.items) {
      m.removeFromParent();
      removed++;
      if (!m.geometry.userData?.shared) m.geometry.dispose();
      const mm = m.material as THREE.Material;
      if (mm !== mat && !mm.userData?.shared) dropped.add(mm);
    }
  }
  // Materialien der Originale nur freigeben, wenn sie nirgends mehr hängen.
  if (dropped.size) {
    root.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (m) for (const x of Array.isArray(m) ? m : [m]) dropped.delete(x);
    });
    for (const mat of dropped) mat.dispose();
  }
  // Leer gewordene, unbenannte Gruppen ohne Kennzeichen aufräumen.
  const prune = (o: THREE.Object3D) => {
    for (const c of [...o.children]) {
      prune(c);
      if ((c as any).type === "Group" && !c.name && !c.children.length && isPlain(c)) c.removeFromParent();
    }
  };
  prune(root);
  return { before, after: before - removed + added };
}
