import { useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/** A list of short values (EPK) as chips: Enter, comma, space or paste adds, Backspace removes the last. */
export function TagInput({ value, onChange, placeholder, label }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; label: string }) {
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const add = (raw: string) => {
    const parts = raw.split(/[\s,;]+/).filter(Boolean);
    if (parts.length) onChange([...new Set([...value, ...parts])]);
    setDraft("");
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "," || e.key === " ") { e.preventDefault(); add(draft); }
    else if (e.key === "Backspace" && !draft && value.length) onChange(value.slice(0, -1));
  };
  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text");
    if (/[\s,;]/.test(text.trim())) { e.preventDefault(); add(text); }
  };
  return (
    <div
      onClick={() => input.current?.focus()}
      className={cn(
        "flex min-h-8 w-full cursor-text flex-wrap items-center gap-1.5 rounded-md border border-lab-line bg-white/[0.04] px-1.5 py-1 transition-colors duration-100",
        "hover:border-lab-edge focus-within:border-lab-accent/60 focus-within:ring-2 focus-within:ring-lab-accent/20",
      )}
    >
      {value.map(tag => (
        <span key={tag} className="inline-flex h-6 items-center gap-1 rounded bg-white/[0.08] pl-2 pr-1 font-mono text-caption text-lab-ink">
          {tag}
          <button
            type="button" aria-label={`Убрать ${tag}`} onClick={e => { e.stopPropagation(); onChange(value.filter(t => t !== tag)); }}
            className="lab-focus rounded-sm p-0.5 text-lab-mute transition-colors duration-100 hover:bg-lab-raised hover:text-lab-ink"
          ><X className="size-3" /></button>
        </span>
      ))}
      <input
        ref={input} value={draft} aria-label={label} onChange={e => setDraft(e.target.value)} onKeyDown={onKey} onPaste={onPaste} onBlur={() => add(draft)}
        placeholder={value.length ? "" : placeholder}
        className="h-6 min-w-[120px] flex-1 bg-transparent px-1 font-mono text-caption text-lab-ink outline-none placeholder:font-sans placeholder:text-body placeholder:text-lab-faint"
      />
    </div>
  );
}
