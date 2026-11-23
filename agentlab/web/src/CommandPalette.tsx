import { Icon, IconName } from "@blueprintjs/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { Chat } from "./api";

export type CommandItem = {
  id: string;
  group: string;
  title: string;
  subtitle?: string;
  icon: IconName;
  shortcut?: string;
  run: () => void;
};

export default function CommandPalette({
  open,
  chats,
  commands,
  onSelectChat,
  onClose,
}: {
  open: boolean;
  chats: Chat[];
  commands: CommandItem[];
  onSelectChat: (chatId: number) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setIndex(0);
    window.setTimeout(() => inputRef.current?.focus(), 20);
  }, [open]);

  const items = useMemo<CommandItem[]>(() => {
    const q = query.trim().toLowerCase();
    const chatItems: CommandItem[] = chats.slice(0, 20).map((chat) => ({
      id: `chat-${chat.id}`,
      group: "Chats",
      title: chat.title || "Neuer Chat",
      subtitle: chat.model || chat.provider_name || undefined,
      icon: chat.kind === "orchestrator" ? "flow-branch" : "chat",
      run: () => onSelectChat(chat.id),
    }));
    const all = [...commands, ...chatItems];
    if (!q) return all.slice(0, 24);
    return all.filter((item) =>
      `${item.title} ${item.subtitle ?? ""} ${item.group}`.toLowerCase().includes(q),
    ).slice(0, 24);
  }, [chats, commands, query, onSelectChat]);

  useEffect(() => {
    setIndex((cur) => (items.length ? Math.min(cur, items.length - 1) : 0));
  }, [items.length]);

  useEffect(() => {
    if (!open) return;
    const active = listRef.current?.querySelector<HTMLElement>(".cmd-item.is-active");
    active?.scrollIntoView({ block: "nearest" });
  }, [open, index]);

  if (!open) return null;

  const execute = (item: CommandItem | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  return (
    <div className="cmd-backdrop" onClick={onClose} role="presentation">
      <div className="cmd-dialog" role="dialog" aria-modal="true" aria-label="Befehlspalette"
        onClick={(e) => e.stopPropagation()}>
        <div className="cmd-input-row">
          <Icon icon="search" size={15} className="cmd-search-icon" aria-hidden="true" />
          <input
            ref={inputRef}
            className="cmd-input"
            placeholder="Befehl, Bereich, Vorschau oder Chat suchen …"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setIndex(0); }}
            onKeyDown={(e) => {
              if (e.key === "Escape") { e.preventDefault(); onClose(); }
              else if (e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => (items.length ? (i + 1) % items.length : 0)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => (items.length ? (i - 1 + items.length) % items.length : 0)); }
              else if (e.key === "Enter") { e.preventDefault(); execute(items[index]); }
            }}
          />
          <kbd className="cmd-kbd">Esc</kbd>
        </div>

        <div ref={listRef} className="cmd-list" role="listbox">
          {items.length === 0 && (
            <div className="cmd-empty">Kein passender Befehl oder Chat gefunden.</div>
          )}
          {items.map((item, idx) => (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={idx === index}
              className={`cmd-item ${idx === index ? "is-active" : ""}`}
              onMouseEnter={() => setIndex(idx)}
              onClick={() => execute(item)}
            >
              <span className="cmd-item-icon"><Icon icon={item.icon} size={14} aria-hidden="true" /></span>
              <span className="cmd-item-main">
                <strong>{item.title}</strong>
                {item.subtitle && <span>{item.subtitle}</span>}
              </span>
              <span className="cmd-item-group">{item.group}</span>
              {item.shortcut && <kbd className="cmd-kbd">{item.shortcut}</kbd>}
            </button>
          ))}
        </div>

        <div className="cmd-foot">
          <span>↑↓ wählen</span>
          <span>↵ ausführen</span>
          <span>Esc schließen</span>
        </div>
      </div>
    </div>
  );
}
