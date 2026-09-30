import { useMemo } from "react";
import { useLabState } from "../shell/LabProvider";
import { useSource } from "./problems";
import type { Source } from "./types";
import type { Criterion } from "./criteria";

export type Tool = { name: string; env: string; where: string[] };
/** A part of the agent read from its code: a prompt or one of the bank systems it calls; `ns` are its criteria. */
export type Part = { id: string; kind: "prompt" | "tool"; source?: Source; tool?: Tool; ns: number[] };

/** «src/…/main_idp_result_chain.py:95» → the file and the line. */
export function fileOf(s: Pick<Source, "origin">) {
  const last = s.origin.split("/").pop() ?? s.origin;
  const [file, line = ""] = last.split(":");
  return { file, line };
}

/** «getLkkTariff (SBE_TOOL_NAME_LKK_TARIFF) — вызывается в: a.py, b/c.py» → the tool, its setting and the files. */
export function parseTools(text: string): Tool[] {
  return text.split("\n").flatMap(l => {
    const m = /^(\w+) \((\w+)\)(?:\s*—\s*вызывается в:\s*(.*))?/.exec(l.trim());
    return m ? [{ name: m[1], env: m[2], where: (m[3] ?? "").split(",").map(w => w.trim().split("/").pop() ?? "").filter(Boolean) }] : [];
  });
}

/** The prompt's first real sentence, as a person would describe it: no headings, no markdown. */
export function firstSentence(content: string) {
  const line = content.replace(/\*\*/g, "").split("\n").map(l => l.trim()).find(l => l && !/^#{1,}\s/.test(l) && /[А-Яа-яA-Za-z]{3}/.test(l)) ?? "";
  const cut = line.search(/[.!?](\s|$)/);
  return cut > 20 ? line.slice(0, cut + 1) : line;
}

/** The prompts (the ones with most criteria first) and the bank systems, each with the numbers of its criteria. */
export function useAgentParts(criteria: Criterion[]) {
  const { state } = useLabState();
  const toolsSource = state?.sources.find(s => s.kind === "tools");
  const toolsText = useSource(toolsSource?.id).data?.content ?? "";
  return useMemo(() => {
    const prompts = [...(state?.sources ?? [])].filter(s => s.kind === "prompt").sort((a, b) => b.rules - a.rules || b.chars - a.chars);
    const tools = parseTools(toolsText);
    const parts: Part[] = [
      ...prompts.map(s => ({ id: s.id, kind: "prompt" as const, source: s, ns: criteria.filter(c => c.r.rule.sourceId === s.id).map(c => c.n) })),
      ...tools.map(t => ({ id: `tool:${t.name}`, kind: "tool" as const, tool: t, ns: criteria.filter(c => `${c.r.rule.text} ${c.r.rule.acceptable}`.includes(t.name)).map(c => c.n) })),
    ];
    return { prompts, tools, toolsSource, parts };
  }, [state?.sources, toolsText, toolsSource, criteria]);
}
