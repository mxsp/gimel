import { Icon } from "@blueprintjs/core";
import { useState } from "react";
import { copyToClipboard } from "./chatUtils";

export default function CopyButton({ text, label = "Kopieren" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (await copyToClipboard(text)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  };
  return (
    <button type="button" className="msg-action" onClick={copy} aria-label={label}>
      <Icon icon={copied ? "tick" : "duplicate"} size={12} aria-hidden="true" />
      {copied ? "Kopiert" : label}
    </button>
  );
}
