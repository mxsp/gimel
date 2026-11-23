import { Button, Menu, MenuItem } from "@blueprintjs/core";
import KeyPopover from "./KeyPopover";
import type { IconName } from "@blueprintjs/core";
import { ReactNode } from "react";
import { useHashRoute } from "../router";
import { pageInfo } from "./pageInfo";

/** Ein weiterer Abschnitt im (i) der Seite: Regeln, die früher ein eigenes (i) daneben hatten. */
export interface PageHelp {
  title: ReactNode;
  text: ReactNode;
}

export interface PageAction {
  text: string;
  icon?: IconName;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  intent?: "primary" | "danger" | "warning" | "success";
}

/* Der Kopf jeder Seite (Aufgabe 35 C): Titel, höchstens eine Zeile Erklärung,
   rechts höchstens eine Haupt- und zwei Nebenaktionen, der Rest im „…"-Menü.
   Längere Erklärungen stehen hinter (i) „Wie funktioniert das?" — ohne eigenen
   Text der aus `pageInfo` für die aktuelle Route. */
export default function PageFrame({ title, sub, actions, more, info, help, aside, children, className }: {
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  /** Seltene Aktionen im „…"-Menü. */
  more?: PageAction[];
  /** Eigene Erklärung; `false` blendet (i) aus. */
  info?: ReactNode | false;
  /** Weitere Abschnitte im selben (i) — nie ein zweites (i) im Kopf. */
  help?: Array<PageHelp | false | null | undefined>;
  /** Kleine Angaben direkt neben dem Titel (Stand, Kennzahlen). */
  aside?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`ui-page${className ? ` ${className}` : ""}`}>
      <PageHeader title={title} sub={sub} actions={actions} more={more} info={info} help={help} aside={aside} />
      {children}
    </div>
  );
}

/** Nur der Kopf, für Seiten mit eigenem Rahmen (Grundriss, Hallen-Editor). */
export function PageHeader({ title, sub, actions, more, info, help, aside, className, compact }: {
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  more?: PageAction[];
  info?: ReactNode | false;
  help?: Array<PageHelp | false | null | undefined>;
  aside?: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  const route = useHashRoute();
  const text = info === false ? null : info ?? pageInfo(route);
  const shownMore = (more ?? []).filter(Boolean);
  const sections = (help ?? []).filter(Boolean) as PageHelp[];
  return (
    <header className={"ui-page-head" + (compact ? " ui-page-head-compact" : "") + (className ? ` ${className}` : "")}>
      <div className="ui-page-head-copy">
        <div className="ui-page-title-row">
          <h1 className="page-title">{title}</h1>
          {(text || sections.length > 0) && <PageInfo text={text} sections={sections} />}
          {aside}
        </div>
        {sub && <p className="page-sub">{sub}</p>}
      </div>
      {(actions || shownMore.length > 0) && (
        <div className="ui-page-actions">
          {actions}
          {shownMore.length > 0 && <MoreMenu items={shownMore} />}
        </div>
      )}
    </header>
  );
}

export function PageInfo({ text, sections = [] }: { text?: ReactNode; sections?: PageHelp[] }) {
  return (
    <KeyPopover minimal placement="bottom-start"
      content={<div className="ui-hint ui-page-info">
        {text && <><p className="ui-hint-title">Wie funktioniert das?</p><div className="ui-hint-body">{text}</div></>}
        {sections.map((s, i) => (
          <section key={i} className="ui-page-info-section">
            <p className="ui-hint-title">{s.title}</p>
            <div className="ui-hint-body">{s.text}</div>
          </section>
        ))}
      </div>}>
      <Button small minimal icon="info-sign" className="ui-hint-btn ui-page-info-btn"
        aria-label="Wie funktioniert das?" title="Wie funktioniert das?" />
    </KeyPopover>
  );
}

/** „…" mit den seltenen Aktionen einer Seite. */
export function MoreMenu({ items, label = "Weitere Aktionen", text }: { items: PageAction[]; label?: string; text?: string }) {
  return (
    <KeyPopover minimal placement="bottom-end" content={
      <Menu>
        {items.map((a) => (
          <MenuItem key={a.text} icon={a.icon} text={a.text} title={a.title} disabled={a.disabled}
            intent={a.intent} onClick={a.onClick} />
        ))}
      </Menu>}>
      <Button icon="more" rightIcon={text ? "caret-down" : undefined} text={text}
        aria-label={text ? undefined : label} title={label} />
    </KeyPopover>
  );
}
