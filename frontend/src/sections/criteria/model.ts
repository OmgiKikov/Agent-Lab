import type { Criterion } from "../../lab/criteria";
import type { RuleEntry } from "../../lab/problems";
import type { Source } from "../../lab/types";
import { splitQuote } from "../../lab/quote";

export type SideKey = "log" | "sim";
/** A criterion on one side: broken somewhere, kept with no breach found, never decided, or not met in these dialogues. */
export type Tone = "bad" | "ok" | "unknown" | "none";

export function toneOf(r: RuleEntry, side: SideKey): Tone {
  const s = r[side];
  if (s.failed > 0) return "bad";
  if (s.passed > 0) return "ok";
  if (s.unknown > 0) return "unknown";
  return "none";
}

const RANK: Record<Tone, number> = { bad: 3, unknown: 2, ok: 1, none: 0 };
export const worst = (tones: Tone[]): Tone | null =>
  tones.length ? tones.reduce((a, b) => (RANK[b] > RANK[a] ? b : a)) : null;

/** Where each criterion's quote stands in its source's text; the ones whose words are no longer there are told apart. */
export type Span = { c: Criterion; start: number; end: number };
export function spansOf(content: string, items: Criterion[]): { spans: Span[]; missing: Criterion[] } {
  const spans: Span[] = [];
  const missing: Criterion[] = [];
  for (const c of items) {
    const parts = splitQuote(content, c.r.rule.quote);
    if (!parts) {
      missing.push(c);
      continue;
    }
    spans.push({ c, start: parts[0].length, end: parts[0].length + parts[1].length });
  }
  spans.sort((a, b) => a.start - b.start);
  return { spans, missing };
}

/** «main_idp.py:212» — the line the prompt starts at in the agent's code, when the origin tells it. */
export function firstLine(s: Pick<Source, "origin">) {
  const m = /:(\d+)\s*$/.exec(s.origin);
  return m ? Number(m[1]) : 1;
}

/** «src/aigw_service/chain/main_idp.py:212» → «main_idp.py» and «chain». */
export function nameOf(s: Pick<Source, "origin" | "kind">) {
  if (s.kind === "tools") return { file: "Инструменты агента", dir: s.origin };
  const path = s.origin.split(":")[0];
  const parts = path.split("/");
  return { file: parts[parts.length - 1], dir: parts.slice(-3, -1).join("/") };
}
