import { api } from "./api";
import { DrawingItem, baseName, importKind } from "./freeNesting";

export interface ImportResult { created: DrawingItem[]; skipped: string[]; notes: string[] }

export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Die Datei geht als roher Körper hinaus; der Server liest Geometrie und behält die Datei nicht. */
export async function importFile(file: File): Promise<ImportResult> {
  const kind = importKind(file.name);
  if (!kind) throw new Error(`${file.name}: nur .dxf und .svg werden gelesen.`);
  if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name}: größer als 2 MiB.`);
  return api<ImportResult>(`/api/drawings/import/${kind}`, {
    method: "POST", body: await file.arrayBuffer(),
    headers: { "Content-Type": "application/octet-stream", "X-Name": encodeURIComponent(baseName(file.name)) },
  });
}

export function createFromText(name: string, note: string, text: string): Promise<ImportResult> {
  return api<ImportResult>("/api/drawings", { method: "POST", body: JSON.stringify({ name, note, text }) });
}

export function listDrawings(q: string, limit = 500): Promise<{ total: number; items: DrawingItem[] }> {
  return api(`/api/drawings?limit=${limit}&q=${encodeURIComponent(q)}`);
}
