import { OverlayToaster } from "@blueprintjs/core";

// Eine Melde-Instanz für das ganze Portal — ohne React-Kontext zu brauchen.
// Unten rechts statt oben mittig, damit Meldungen nie Kopfzeile oder Werkzeugleisten verdecken.
export const toaster = OverlayToaster.create({ position: "bottom-right", maxToasts: 4 });

export const toastSuccess = (msg: string) =>
  toaster.show({ message: msg, intent: "success", icon: "tick-circle", timeout: 5000 });

export const toastError = (msg: string) =>
  toaster.show({ message: msg, intent: "danger", icon: "error", timeout: 8000 });

export const toastInfo = (msg: string) =>
  toaster.show({ message: msg, intent: "primary", timeout: 4000 });
