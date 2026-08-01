import { useState, type KeyboardEvent } from "react";
import { Input } from "@cloudflare/kumo/components/input";
import { X } from "@phosphor-icons/react";

// A pill-list input. Press Enter or "," to commit the typed token; backspace on
// an empty input removes the trailing pill. Used for hostname allow/deny lists
// and multi-value matchers (`is one of`).
export interface MultiPillInputProps {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  label?: string;
  description?: string;
  ariaLabel?: string;
}

export function MultiPillInput({
  values,
  onChange,
  placeholder,
  label,
  description,
  ariaLabel,
}: MultiPillInputProps) {
  const [draft, setDraft] = useState("");

  const commit = (raw: string) => {
    const next = raw.trim();
    if (!next) return;
    if (values.includes(next)) {
      setDraft("");
      return;
    }
    onChange([...values, next]);
    setDraft("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit(draft);
    } else if (e.key === "Backspace" && draft.length === 0 && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  };

  // Layout matches Kumo's Field primitive (label → control → description) so a
  // MultiPillInput drops cleanly into a .rule-grid alongside Kumo Inputs/Selects.
  return (
    <div className="multi-pill">
      {label && <label className="multi-pill-label">{label}</label>}
      <div className="multi-pill-box">
        {values.map((v, i) => (
          <span key={`${v}-${i}`} className="multi-pill-chip">
            {v}
            <button
              type="button"
              className="multi-pill-remove"
              aria-label={`Remove ${v}`}
              onClick={() => onChange(values.filter((_, j) => j !== i))}
            >
              <X size={10} />
            </button>
          </span>
        ))}
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => commit(draft)}
          placeholder={values.length === 0 ? placeholder : ""}
          aria-label={ariaLabel || label || "Add value"}
          className="multi-pill-input"
        />
      </div>
      {description && <p className="multi-pill-description">{description}</p>}
    </div>
  );
}
