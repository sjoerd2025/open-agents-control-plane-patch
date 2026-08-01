import { useState } from "react";
import { Copy, Check } from "@phosphor-icons/react";
import { Button } from "@cloudflare/kumo/components/button";
import { copyToClipboard } from "../utils";
import { useToasts } from "../toasts";

// Small button that copies a payload to the clipboard. Supports two render
// modes:
//   - default Kumo button (used in section action bars)
//   - `compact` icon-only (used inline next to event rows)
//
// Stops click propagation so it can sit inside parent rows that have their
// own onClick (e.g. event rows that toggle expansion).
export function CopyButton({
  text,
  label = "Copy",
  copiedLabel = "Copied",
  compact = false,
  title,
}: {
  text: string | (() => string);
  label?: string;
  copiedLabel?: string;
  compact?: boolean;
  title?: string;
}) {
  const { push } = useToasts();
  const [copied, setCopied] = useState(false);

  const onClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const value = typeof text === "function" ? text() : text;
      await copyToClipboard(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      push((err as Error).message || "copy failed", "error");
    }
  };

  if (compact) {
    return (
      <button
        type="button"
        className="copy-icon-btn"
        onClick={onClick}
        aria-label={title ?? label}
        title={title ?? (copied ? copiedLabel : label)}
      >
        {copied ? <Check size={13} weight="bold" /> : <Copy size={13} />}
      </button>
    );
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      icon={copied ? Check : Copy}
      onClick={onClick}
      title={title}
    >
      {copied ? copiedLabel : label}
    </Button>
  );
}
