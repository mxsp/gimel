import {
  Button, Checkbox, Dialog, DialogBody, DialogFooter, FormGroup, InputGroup, Spinner, TextArea,
} from "@blueprintjs/core";
import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  ApiError, BuiltinPrompt, createPrompt, deletePrompt, listPrompts, SavedPrompt,
} from "./api";

type Item =
  | { kind: "builtin"; key: string; title: string; text: string }
  | { kind: "saved"; key: string; title: string; text: string; prompt: SavedPrompt };

export type PromptMenuHandle = {
  /** true = die Taste gehörte dem Menü. */
  handleKey: (event: ReactKeyboardEvent) => boolean;
  openSave: (text: string) => void;
};

export function slashQuery(input: string): string | null {
  // Nur ein Schrägstrich am Anfang einer sonst einzeiligen Eingabe öffnet das Menü.
  const match = /^\/([^\n]{0,60})$/.exec(input);
  return match ? match[1].trim().toLowerCase() : null;
}

/** Hilfsfunktion für die leere Ansicht: Schnellstarts ohne das Menü zu öffnen. */
export function useBuiltinPrompts(): BuiltinPrompt[] {
  const [items, setItems] = useState<BuiltinPrompt[]>([]);
  useEffect(() => {
    let cancelled = false;
    listPrompts().then((data) => { if (!cancelled) setItems(data.builtin); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return items;
}

const PromptMenu = forwardRef<PromptMenuHandle, {
  open: boolean;
  query: string;
  draft: string;
  onPick: (text: string) => void;
  onClose: () => void;
  /** Kennung der aktiven Option für ``aria-activedescendant`` am Eingabefeld. */
  onActiveChange?: (id: string | null) => void;
}>(function PromptMenu({ open, query, draft, onPick, onClose, onActiveChange }, ref) {
  const [saved, setSaved] = useState<SavedPrompt[]>([]);
  const [builtin, setBuiltin] = useState<BuiltinPrompt[]>([]);
  const [canShare, setCanShare] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [active, setActive] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [shared, setShared] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listPrompts();
      setSaved(data.prompts);
      setBuiltin(data.builtin);
      setCanShare(data.can_share);
      setLoaded(true);
      setError("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (open && !loaded) reload(); }, [open, loaded, reload]);
  useEffect(() => { setActive(0); }, [query, open]);

  const items: Item[] = useMemo(() => {
    const all: Item[] = [
      ...saved.map((p): Item => ({ kind: "saved", key: `s${p.id}`, title: p.title, text: p.text, prompt: p })),
      ...builtin.map((p): Item => ({ kind: "builtin", key: `b${p.key}`, title: p.title, text: p.text })),
    ];
    if (!query) return all;
    return all.filter((item) => `${item.title} ${item.text}`.toLowerCase().includes(query));
  }, [saved, builtin, query]);

  const optionId = (index: number) => `prompt-opt-${index}`;

  useEffect(() => {
    if (!open || !items.length) {
      onActiveChange?.(null);
      return;
    }
    const index = Math.min(active, items.length - 1);
    onActiveChange?.(optionId(index));
    document.getElementById(optionId(index))?.scrollIntoView({ block: "nearest" });
  }, [open, active, items, onActiveChange]);

  const pick = (item: Item | undefined) => {
    if (!item) return;
    onPick(item.text);
  };

  const openSave = (value: string) => {
    setText(value.trim());
    setTitle(value.trim().split("\n")[0].slice(0, 60));
    setShared(false);
    setError("");
    setSaveOpen(true);
    if (!loaded) reload();
  };

  useImperativeHandle(ref, () => ({
    handleKey: (event) => {
      if (!open) return false;
      if (event.key === "ArrowDown") {
        setActive((i) => Math.min(items.length - 1, i + 1));
        return true;
      }
      if (event.key === "ArrowUp") {
        setActive((i) => Math.max(0, i - 1));
        return true;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        if (!items.length) return false;
        pick(items[Math.min(active, items.length - 1)]);
        return true;
      }
      if (event.key === "Delete" && event.shiftKey) {
        const item = items[Math.min(active, items.length - 1)];
        if (item?.kind === "saved" && item.prompt.editable) {
          remove(item.prompt);
          return true;
        }
        return false;
      }
      if (event.key === "Escape") {
        onClose();
        return true;
      }
      return false;
    },
    openSave,
  }));

  const save = async () => {
    if (!title.trim() || !text.trim()) return;
    setSaving(true);
    try {
      await createPrompt({ title: title.trim(), text: text.trim(), shared });
      setSaveOpen(false);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (prompt: SavedPrompt) => {
    if (!window.confirm(`Vorlage „${prompt.title}“ löschen?`)) return;
    try {
      await deletePrompt(prompt.id);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  return (
    <>
      {open && (
        <div className="prompt-menu" onMouseDown={(e) => e.preventDefault()}>
          <div className="prompt-menu-head">
            <span>Vorlagen{query ? ` · „${query}“` : ""}</span>
            <span className="prompt-menu-keys">↑↓ wählen · Enter einsetzen · Umschalt+Entf löscht eigene · Esc schließen</span>
          </div>
          {loading && !loaded && <div className="prompt-menu-empty"><Spinner size={16} /></div>}
          {loaded && items.length === 0 && (
            <div className="prompt-menu-empty" role="status">Keine passende Vorlage.</div>
          )}
          <div id="prompt-menu-list" role="listbox" aria-label="Vorlagen">
            {items.map((item, index) => (
              <div key={item.key} role="presentation"
                className={`prompt-item ${index === active ? "is-active" : ""}`}
                onMouseEnter={() => setActive(index)}>
                <div id={optionId(index)} role="option" aria-selected={index === active}
                  className="prompt-item-main" onClick={() => pick(item)}>
                  <strong>{item.title}</strong>
                  <span>{item.text}</span>
                </div>
                <span className="prompt-item-kind">
                  {item.kind === "builtin" ? "Schnellstart" : item.prompt.shared ? "geteilt" : "eigene"}
                </span>
                {item.kind === "saved" && item.prompt.editable && (
                  <button type="button" className="prompt-item-remove" tabIndex={-1}
                    aria-label={`Vorlage ${item.title} löschen`}
                    onClick={(e) => { e.stopPropagation(); remove(item.prompt); }}>×</button>
                )}
              </div>
            ))}
          </div>
          <div className="prompt-menu-foot">
            <Button small minimal icon="floppy-disk" text="Aktuelle Nachricht als Vorlage speichern"
              disabled={!draft.trim() || draft.trim().startsWith("/")}
              onClick={() => openSave(draft)} />
          </div>
          {error && <div className="prompt-menu-error" role="alert">{error}</div>}
        </div>
      )}

      <Dialog isOpen={saveOpen} onClose={() => setSaveOpen(false)} title="Als Vorlage speichern"
        style={{ width: 520, maxWidth: "calc(100vw - 24px)" }}>
        <DialogBody>
          <FormGroup label="Titel" labelFor="prompt-title">
            <InputGroup id="prompt-title" value={title} maxLength={120} autoFocus
              onChange={(e) => setTitle(e.target.value)} />
          </FormGroup>
          <FormGroup label="Text" labelFor="prompt-text"
            helperText="Platzhalter wie {Auftragsnummer} vor dem Senden ersetzen.">
            <TextArea id="prompt-text" fill rows={5} value={text} maxLength={4000}
              onChange={(e) => setText(e.target.value)} />
          </FormGroup>
          {canShare && (
            <Checkbox checked={shared} label="Für das ganze Team freigeben"
              onChange={(e) => setShared(e.currentTarget.checked)} />
          )}
          {error && <div className="login-error" role="alert">{error}</div>}
        </DialogBody>
        <DialogFooter actions={
          <>
            <Button text="Abbrechen" onClick={() => setSaveOpen(false)} />
            <Button intent="primary" icon="floppy-disk" text="Speichern" loading={saving}
              disabled={!title.trim() || !text.trim()} onClick={save} />
          </>
        } />
      </Dialog>
    </>
  );
});

export default PromptMenu;
