import { ChevronRight, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Change, Compared } from "../findings";
import { plural } from "../format";
import { personaName } from "../look";
import type { Persona } from "../types";
import { Badge } from "../ui";

export const CHANGE_TEXT: Record<Change, string> = { new: "новая", remains: "осталась", fixed: "исправлена" };

/** «чаще у нетерпеливых (5 из 9)», «у всех типов клиентов», or nothing when there is one type. */
export function whoText(byPersona: Record<string, number>, count: number, personas: Persona[], played: number) {
  const ids = Object.keys(byPersona);
  if (played < 2 || !ids.length) return "";
  if (ids.length >= played && played > 1) return "у всех типов клиентов";
  const top = ids.sort((a, b) => byPersona[b] - byPersona[a])[0];
  return byPersona[top] * 2 > count ? `чаще у типа «${personaName(personas, top)}» (${byPersona[top]} из ${count})` : `у ${ids.length} ${plural(ids.length, "типа", "типов", "типов")} клиентов`;
}

/** One finding as a row of a list: how many conversations, what it is, since when. */
export function FindingRow({ item, personas, played, previousVersion, onOpen }: {
  item: Compared; personas: Persona[]; played: number; previousVersion?: string; onOpen: () => void;
}) {
  const { finding: f, change, before } = item;
  const fixed = change === "fixed";
  const who = whoText(f.byPersona, f.count, personas, played);
  return (
    <button
      onClick={onOpen}
      className={cn("flex w-full items-center gap-4 border-t border-white/[0.06] px-5 py-3.5 text-left transition-colors first:border-t-0 hover:bg-white/[0.025] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-white/50", fixed && "opacity-70")}
    >
      <span className={cn("w-9 flex-shrink-0 text-right text-[22px] font-medium leading-none", fixed ? "text-lab-ok" : change === "remains" ? "text-lab-mute" : "text-lab-bad")} style={{ fontFamily: '"AlphaLyrae", sans-serif' }}>
        {fixed ? <Check className="ml-auto size-5" strokeWidth={2.5} /> : f.count}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-medium text-lab-ink">{f.title}</span>
        <span className="mt-0.5 block text-[11px] text-lab-dim">
          {fixed ? `было ${before} ${plural(before, "разговор", "разговора", "разговоров")} в ${previousVersion ?? "прошлой версии"}, теперь ни одного` : `${f.count} из ${f.measured} ${plural(f.measured, "разговора", "разговоров", "разговоров")}${who ? ` · ${who}` : ""}`}
        </span>
      </span>
      {change && <Badge hue={change === "new" ? "bad" : change === "fixed" ? "ok" : "mute"}>{CHANGE_TEXT[change]}</Badge>}
      {!fixed && <ChevronRight className="size-4 flex-shrink-0 text-lab-faint" />}
    </button>
  );
}
