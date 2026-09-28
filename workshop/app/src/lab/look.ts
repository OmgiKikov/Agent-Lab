import { CircleHelp, Keyboard, MessageSquareQuote, User, Zap, type LucideIcon } from "lucide-react";
import type { Persona, Status } from "./types";

/** The two lines under the logo: what is being tested. */
export const AGENT_TITLE = "Агент эквайринга";
export const AGENT_SUBTITLE = "СберБизнес · чат поддержки";

export type Hue = "accent" | "ok" | "bad" | "warn" | "mute" | "p1" | "p2" | "p3" | "p4";

/** Full class names on purpose: Tailwind only keeps what it can read. */
export const HUE: Record<Hue, { text: string; bg: string; bgStrong: string; border: string; solid: string; stroke: string }> = {
  accent: { text: "text-lab-accent", bg: "bg-lab-accent/10", bgStrong: "bg-lab-accent/20", border: "border-lab-accent/30", solid: "bg-lab-accent", stroke: "stroke-lab-accent" },
  ok: { text: "text-lab-ok", bg: "bg-lab-ok/10", bgStrong: "bg-lab-ok/20", border: "border-lab-ok/25", solid: "bg-lab-ok", stroke: "stroke-lab-ok" },
  bad: { text: "text-lab-bad", bg: "bg-lab-bad/10", bgStrong: "bg-lab-bad/20", border: "border-lab-bad/25", solid: "bg-lab-bad", stroke: "stroke-lab-bad" },
  warn: { text: "text-lab-warn", bg: "bg-lab-warn/10", bgStrong: "bg-lab-warn/20", border: "border-lab-warn/25", solid: "bg-lab-warn", stroke: "stroke-lab-warn" },
  mute: { text: "text-lab-mute", bg: "bg-white/[0.06]", bgStrong: "bg-white/[0.10]", border: "border-white/10", solid: "bg-lab-mute", stroke: "stroke-lab-mute" },
  p1: { text: "text-lab-p1", bg: "bg-lab-p1/15", bgStrong: "bg-lab-p1/25", border: "border-lab-p1/35", solid: "bg-lab-p1", stroke: "stroke-lab-p1" },
  p2: { text: "text-lab-p2", bg: "bg-lab-p2/15", bgStrong: "bg-lab-p2/25", border: "border-lab-p2/35", solid: "bg-lab-p2", stroke: "stroke-lab-p2" },
  p3: { text: "text-lab-p3", bg: "bg-lab-p3/15", bgStrong: "bg-lab-p3/25", border: "border-lab-p3/35", solid: "bg-lab-p3", stroke: "stroke-lab-p3" },
  p4: { text: "text-lab-p4", bg: "bg-lab-p4/15", bgStrong: "bg-lab-p4/25", border: "border-lab-p4/35", solid: "bg-lab-p4", stroke: "stroke-lab-p4" },
};

export const STATUS_HUE: Record<Status, Hue> = { PASS: "ok", FAIL: "bad", RUNNING: "accent", UNMEASURED: "warn", UNKNOWN: "warn", NOT_APPLICABLE: "mute" };
export const STATUS_TEXT: Record<Status, string> = { PASS: "пройден", FAIL: "провален", UNMEASURED: "не измерен", UNKNOWN: "нет данных", NOT_APPLICABLE: "не применим", RUNNING: "идёт" };
export const RULE_TEXT: Record<string, string> = { PASS: "выполнено", FAIL: "нарушено", UNKNOWN: "нет данных", NOT_APPLICABLE: "не применимо" };
export const LOG_TEXT: Record<string, string> = { PASS: "без нарушений", FAIL: "нарушение", UNMEASURED: "нет данных" };
export const statusHue = (status: Status | string): Hue => STATUS_HUE[status as Status] ?? "warn";

export const DEFAULT_PERSONA = "default";

/**
 * A glyph and a hue per customer type. Hue is only the second channel: the glyph and the name always ride along.
 * Slots 1-4 of the validated dark categorical palette, in their fixed order, never recycled.
 */
export const PERSONA_LOOK: Record<string, { icon: LucideIcon; hue: Hue }> = {
  [DEFAULT_PERSONA]: { icon: User, hue: "mute" },
  impatient: { icon: Zap, hue: "p1" },
  confused: { icon: CircleHelp, hue: "p2" },
  typos: { icon: Keyboard, hue: "p3" },
  no_terms: { icon: MessageSquareQuote, hue: "p4" },
};
export const personaLook = (id?: string) => PERSONA_LOOK[id ?? DEFAULT_PERSONA] ?? { icon: User, hue: "mute" as Hue };
export const personaName = (personas: Persona[], id?: string) => personas.find(p => p.id === (id ?? DEFAULT_PERSONA))?.name ?? id ?? "";
