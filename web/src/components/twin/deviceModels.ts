import * as THREE from "three";
import type { Station } from "../../factory";
import { box as kitBox, finalize, mat as kitMat, type Palette } from "./models/kit";
import { STATUS_LAMP, genericMachine, plotter, punch, waterjet, workbench, type MachineOptions } from "./models/machines";
import { packing, office } from "./models/logistics";
import { storage, storageKind } from "./models/storage";

/* Gebaute Geräte für die 3D-Halle.

   Die Demo hat keine hochgeladenen CAD-Dateien. Jede Geräteart bekommt ein
   eigenes, wiedererkennbares Modell. Seit task 37 (2026-11-07) halbrealistisch
   aus dem Baukasten `models/` statt aus flachen Kästen:
   - Fertigung: Flachbett-Plotter mit Portal, Kopf und Energiekette;
     Wasserstrahl mit Becken, Rost, Pumpe und Sandtrichter; Revolverstanze mit
     C-Gestell und Bürstentisch; Handarbeitsplatz; sonst eine Maschinenkabine.
   - Lager je Kurzzeichen oder Name: Plattenregal, Palettenregal (Hochregal),
     Kommissionierung, Wareneingang, Leergut, Archiv, Kleinteile, Langzeitlager.
   - Versand: Packplatz mit Rollenbahn. Büro: Schreibtischinsel.
   Jedes Gerät trägt eine Signalsäule in der Statusfarbe. Laufende Stationen
   bewegen Portal, Kopf, Stempel, Revolver und Rollen (`userData.motion`);
   die 3D-Schleife tut das nur ohne `prefers-reduced-motion`. Unbewegte Teile
   sind je Material verschmolzen, aus der Ferne gilt eine grobe Fassung
   (`THREE.LOD`). Hochgeladene Modelle haben weiter Vorrang. */

export interface DeviceStyle {
  body: string;
  bodyDark: string;
  metal: string;
  line: string;
  accent: string;
  screen: string;
  water: string;
  wood: string;
  cardboard: string;
  // Seit task 37: Farben des Baukastens. Fehlen sie, gelten die Vorgaben.
  paint?: string;
  paintDark?: string;
  steel?: string;
  rubber?: string;
  rack?: string;
  beam?: string;
  safety?: string;
  glass?: string;
  vest?: string;
  work?: string;
  head?: string;
  forklift?: string;
}

/** Zustand der Station — Signalsäule, Bewegung, Bildschirm, Detailstufe. */
export interface DeviceOptions {
  status?: string;
  running?: boolean;
  /** Material für den Bildschirm am Bedienpult, z. B. mit der laufenden Auftragsnummer. */
  screen?: THREE.Material;
  /** "low": nur die grobe Fassung (andere Ebenen, Nachbarhallen). */
  detail?: "auto" | "low";
}

export const DEVICE_STYLE: DeviceStyle = {
  body: "#566575",
  bodyDark: "#343f4b",
  metal: "#9aa8b6",
  line: "#141b22",
  accent: "#0a5b9c",
  screen: "#1d6fb8",
  water: "#3d8fb3",
  wood: "#b98c5a",
  cardboard: "#c49a6c",
  paint: "#d9dde2",
  paintDark: "#3b434c",
  steel: "#a9b3bd",
  rubber: "#24292f",
  rack: "#2f6fb0",
  beam: "#e07a1f",
  safety: "#f2c230",
  glass: "#b9d4e8",
  vest: "#e8d82c",
  work: "#2c4a6e",
  head: "#c9ced4",
  forklift: "#e39a1c",
};

/** Die Baukastenfarben aus den Tokens (`--g-dev-*`), hell und dunkel. */
export function deviceStyleFromTokens(read: (name: string, fallback: string) => string): Partial<DeviceStyle> {
  return {
    paint: read("--g-dev-paint", DEVICE_STYLE.paint!),
    paintDark: read("--g-dev-paint-dark", DEVICE_STYLE.paintDark!),
    steel: read("--g-dev-steel", DEVICE_STYLE.steel!),
    rubber: read("--g-dev-rubber", DEVICE_STYLE.rubber!),
    rack: read("--g-dev-rack", DEVICE_STYLE.rack!),
    beam: read("--g-dev-beam", DEVICE_STYLE.beam!),
    safety: read("--g-dev-safety", DEVICE_STYLE.safety!),
    wood: read("--g-dev-wood", DEVICE_STYLE.wood),
    cardboard: read("--g-dev-carton", DEVICE_STYLE.cardboard),
    water: read("--g-dev-water", DEVICE_STYLE.water),
    screen: read("--g-dev-screen", DEVICE_STYLE.screen),
    glass: read("--g-dev-glass", DEVICE_STYLE.glass!),
    vest: read("--g-dev-vest", DEVICE_STYLE.vest!),
    work: read("--g-dev-work", DEVICE_STYLE.work!),
    head: read("--g-dev-head", DEVICE_STYLE.head!),
    forklift: read("--g-dev-forklift", DEVICE_STYLE.forklift!),
  };
}

export function paletteOf(style: DeviceStyle): Palette {
  const d = DEVICE_STYLE;
  return {
    paint: style.paint ?? d.paint!,
    paintDark: style.paintDark ?? d.paintDark!,
    steel: style.steel ?? d.steel!,
    rubber: style.rubber ?? d.rubber!,
    accent: style.accent,
    rack: style.rack ?? d.rack!,
    beam: style.beam ?? d.beam!,
    safety: style.safety ?? d.safety!,
    wood: style.wood,
    carton: style.cardboard,
    water: style.water,
    screen: style.screen,
    glass: style.glass ?? d.glass!,
    vest: style.vest ?? d.vest!,
    work: style.work ?? d.work!,
    head: style.head ?? d.head!,
    forklift: style.forklift ?? d.forklift!,
  };
}

export { STATUS_LAMP, storageKind };

/** Jedes gebaute Gerät bleibt strikt in der Stationsfläche. Der Kollisions-
    körper der Station ist genau dieses Rechteck (`stationCorners`); ein Modell,
    das darüber hinausragt, würde sichtbar mit Nachbarn oder Wegen
    zusammenstoßen, obwohl die Logik die Fläche für frei hält. Der Aufrufer
    setzt die Position der äußeren Gruppe — die Passung sitzt eine Ebene tiefer
    und kann dadurch nicht überschrieben werden. */
export const FOOTPRINT_MARGIN_M = 0.08;

export function fitDeviceToFootprint(body: THREE.Object3D, w: number, d: number): THREE.Group {
  const box = new THREE.Box3().setFromObject(body);
  const size = box.getSize(new THREE.Vector3());
  const usableW = Math.max(0.2, w - 2 * FOOTPRINT_MARGIN_M);
  const usableD = Math.max(0.2, d - 2 * FOOTPRINT_MARGIN_M);
  const scale = Math.max(0.2, Math.min(1,
    usableW / Math.max(0.01, size.x), usableD / Math.max(0.01, size.z)));
  body.scale.setScalar(scale);
  body.updateMatrixWorld(true);
  const after = new THREE.Box3().setFromObject(body);
  body.position.x -= (after.min.x + after.max.x) / 2;
  body.position.z -= (after.min.z + after.max.z) / 2;
  body.position.y -= after.min.y;
  const group = new THREE.Group();
  group.name = body.name;
  group.userData.device = true;
  group.add(body);
  return group;
}

/**
 * Das Gerät einer Station. Der Ursprung liegt in der Stationsmitte auf dem
 * Boden, y = 0; der Aufrufer setzt Position und Drehung. Maße in Metern aus
 * ``FactoryStation.w/h``.
 */
/** „Nur ein Quader“: ein schlichter Platzhalter in der Stationsfarbe, bis ein Modell gewählt oder hochgeladen ist. */
function plainBox(p: Palette, w: number, d: number): THREE.Group {
  const g = new THREE.Group();
  const h = Math.min(1.4, Math.max(0.8, Math.min(w, d) * 0.5));
  kitBox(g, w * 0.96, 0.08, d * 0.96, 0, 0.04, 0, kitMat(p.paintDark, "satin"), 0.01);
  kitBox(g, w * 0.94, h, d * 0.94, 0, 0.08 + h / 2, 0, kitMat(p.accent, "paint"), 0.02);
  return g;
}

export function buildDeviceModel(s: Station, overrides: Partial<DeviceStyle> = {}, options: DeviceOptions = {}): THREE.Group {
  const style: DeviceStyle = { ...DEVICE_STYLE, accent: s.colour || DEVICE_STYLE.accent, ...overrides };
  // Die Stationsfarbe bleibt Akzent (Portal, Zierleiste): aus der Ferne ist
  // erkennbar, ob dort Fertigung, Lager, Versand oder Büro steht.
  if (s.colour) style.accent = s.colour;
  const p = paletteOf(style);
  const w = Math.max(0.5, Number(s.w) || 0.5);
  const d = Math.max(0.4, Number(s.h) || 0.4);
  const o: MachineOptions = { status: options.status, running: options.running, screen: options.screen };
  let body: THREE.Group;
  // Gewählte Modellart (Station anlegen / bearbeiten) geht vor der Wahl nach Typ und Maschinenart.
  const forced = s.model_kind || "";
  if (forced === "box") body = plainBox(p, w, d);
  else if (forced === "plotter") body = plotter(p, w, d, o);
  else if (forced === "waterjet") body = waterjet(p, w, d, o);
  else if (forced === "punch") body = punch(p, w, d, o);
  else if (forced === "manual") body = workbench(p, w, d, o);
  else if (forced === "generic") body = genericMachine(p, w, d, o);
  else if (forced === "storage") body = storage({ ...s, is_storage: true }, p, w, d, o);
  else if (forced === "packing") body = packing(p, w, d, o);
  else if (forced === "office") body = office(p, w, d, o);
  else if (s.type === "warehouse" || (s.is_storage && s.type !== "production")) body = storage(s, p, w, d, o);
  else if (s.type === "shipping") body = packing(p, w, d, o);
  else if (s.type === "accounting") body = office(p, w, d, o);
  else {
    switch (s.machine_kind) {
      case "plotter": body = plotter(p, w, d, o); break;
      case "waterjet": body = waterjet(p, w, d, o); break;
      case "punch": body = punch(p, w, d, o); break;
      case "manual": body = workbench(p, w, d, o); break;
      default: body = genericMachine(p, w, d, o); break;
    }
  }
  body.name = `device-${s.type}-${s.machine_kind || "default"}`;
  body.userData.device = true;
  body.userData.running = !!options.running;
  const finished = finalize(body, { lowOnly: options.detail === "low" });
  finished.userData.running = !!options.running;
  const fitted = fitDeviceToFootprint(finished, w, d);
  fitted.userData.running = !!options.running;
  return fitted;
}
