import { Button } from "@blueprintjs/core";
import { ReactNode, useEffect, useId, useRef } from "react";

/* Die Detailansicht liegt rechts über der Tabelle, nicht darunter in der Seite.
   Ein Klick öffnet sie, Escape schließt sie, der Fokus geht hinein und danach
   zurück auf das Element, das sie geöffnet hat. */
export default function Drawer({ open, onClose, title, sub, actions, children, footer, width }: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const before = useRef<Element | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open) return;
    before.current = document.activeElement;
    const t = window.setTimeout(() => panel.current?.querySelector<HTMLElement>(
      "button, input, select, textarea, [tabindex]:not([tabindex='-1'])")?.focus(), 30);
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.body.classList.contains("bp5-overlay-open")) close.current();
    };
    window.addEventListener("keydown", key);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", key);
      if (before.current instanceof HTMLElement) before.current.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="ui-drawer-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={panel} className="ui-drawer" role="dialog" aria-modal="true" aria-labelledby={titleId} style={width ? { width } : undefined}>
        <div className="ui-drawer-head">
          <div className="ui-drawer-head-copy">
            <h2 id={titleId} className="ui-drawer-title">{title}</h2>
            {sub && <p className="ui-drawer-sub">{sub}</p>}
          </div>
          <div className="ui-drawer-head-actions">
            {actions}
            <Button minimal icon="cross" aria-label="Schließen" title="Schließen (Esc)" onClick={onClose} />
          </div>
        </div>
        <div className="ui-drawer-body">{children}</div>
        {footer && <div className="ui-drawer-foot">{footer}</div>}
      </div>
    </div>
  );
}
