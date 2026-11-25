import { lazy } from "react";
import { registerFeature } from "./featureRegistry";

const MailCenterPage = lazy(() =>
  import("../components/MailAndNotesPanel").then((m) => ({ default: m.MailCenterPage })),
);
const TeamNotesPage = lazy(() =>
  import("../components/MailAndNotesPanel").then((m) => ({ default: m.TeamNotesPage })),
);

let initialized = false;

export function registerCoreFeatures(): void {
  if (initialized) return;
  initialized = true;

  registerFeature({
    id: "postfach",
    label: "Postfach",
    icon: "envelope",
    area: "buero",
    group: "Auftragsweg",
    placement: "subview",
    key: "m",
    keywords: "email mail posteingang entwurf lieferant anfrage rfq copilot",
    info: "Posteingang, Entwürfe und gesendete Nachrichten an Lieferanten und Kunden an einem Ort. Das Copilot Lab kann Nachrichten entwerfen und zur Freigabe vorlegen.",
    render: ({ admin }) => <MailCenterPage admin={admin} />,
  });

  registerFeature({
    id: "notizen",
    label: "Notizen",
    icon: "annotation",
    area: "beide",
    group: "Assistenz",
    placement: "subview",
    key: "n",
    workerAllowed: true,
    keywords: "kollegen übergabe schicht nachricht team erwähnung laufkarte",
    info: "Interne Nachrichten und Schichtübergaben zwischen Büro, Leitstand und Werkstatt. Jede Notiz lässt sich direkt mit einem Auftrag oder einer Laufkarte verknüpfen.",
    render: () => <TeamNotesPage />,
  });
}
