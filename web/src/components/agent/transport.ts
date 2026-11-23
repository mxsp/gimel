/* Der Assistent-Chat kommt aus agentlab/web/src (ein Code für /lab, Portal und Studio).
   Hier meldet er sich mit dem Zugang des Portals an: gleicher Token, gleiche stille
   Erneuerung, gleiches Abmelden bei Ablauf. Fehler des Portals werden in die
   Fehlerklasse des Chats übersetzt, damit dessen Prüfungen weiter greifen. */

import { api, apiBlob, getToken } from "../../api";
import { ApiError, setAgentTransport } from "@agentlab/api";

let installed = false;

export function installAgentTransport(): void {
  if (installed) return;
  installed = true;
  setAgentTransport({
    token: getToken,
    async request<T>(path: string, options: RequestInit): Promise<T> {
      try {
        return await api<T>(path, options);
      } catch (err) {
        const status = (err as { status?: number })?.status;
        if (typeof status === "number") {
          throw new ApiError(status, err instanceof Error ? err.message : String(err));
        }
        throw err;
      }
    },
    async blob(path: string, options: RequestInit = {}): Promise<Blob> {
      try {
        return await apiBlob(path, options);
      } catch (err) {
        const status = (err as { status?: number })?.status;
        if (typeof status === "number") {
          throw new ApiError(status, err instanceof Error ? err.message : String(err));
        }
        throw err;
      }
    },
  });
}
