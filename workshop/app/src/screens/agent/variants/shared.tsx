import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../../../lab/api";
import { day } from "../../../lab/format";
import { useProblems, useSource, type RuleEntry } from "../../../lab/problems";
import type { Source } from "../../../lab/types";
import { useLabState } from "../../../shell/LabProvider";
import { useToast } from "../../../ui/toast";
import { splitQuote } from "../../../ui/highlight";
import { useConnectionMemory, wayOf, WAY_NAME } from "../Connection";
import { groupRules } from "../Criteria";

const READ_AT = "lab.agent.sourcesReadAt";
const readAt = () => { try { return localStorage.getItem(READ_AT); } catch { return null; } };

/** «src/…/main_idp_result_chain.py:95» → the file and the line; the tools list has no file of its own. */
export function fileOf(s: Pick<Source, "kind" | "origin">) {
  if (s.kind === "tools") return { file: "Инструменты систем банка", line: "" };
  const last = s.origin.split("/").pop() ?? s.origin;
  const [file, line = ""] = last.split(":");
  return { file, line };
}

/** Everything the Agent page shows, from the service: where the agent runs, what was read from its code, its criteria. */
export function useAgent() {
  const { state, offline, refresh } = useLabState();
  const { data } = useProblems(null);
  const memory = useConnectionMemory();
  const toast = useToast();
  const [reading, setReading] = useState(false);
  const toolsSource = state?.sources.find(s => s.kind === "tools");
  const toolsText = useSource(toolsSource?.id).data?.content ?? "";
  return useMemo(() => {
    const sources = [...(state?.sources ?? [])].sort((a, b) => b.rules - a.rules || b.chars - a.chars);
    const prompts = sources.filter(s => s.kind === "prompt");
    const tools = toolsText.split("\n").map(l => /^(\w+) \((\w+)\)/.exec(l.trim())).flatMap(m => (m ? [{ name: m[1], env: m[2] }] : []));
    const rules = data?.rules ?? [];
    const bySource = new Map<string, RuleEntry[]>();
    for (const r of rules) if (r.rule.sourceId) bySource.set(r.rule.sourceId, [...(bySource.get(r.rule.sourceId) ?? []), r]);
    const way = state ? wayOf(state, memory.last?.target ?? memory.way) : null;
    const read = () => {
      setReading(true);
      api("/api/sources", {}).then(() => { try { localStorage.setItem(READ_AT, new Date().toISOString()); } catch { /* a nicety */ } return refresh(); }).catch(toast.error).finally(() => setReading(false));
    };
    return {
      state, offline, sources, prompts, toolsSource, tools, rules, bySource,
      groups: groupRules(rules),
      way: way ? WAY_NAME[way] : null,
      address: state?.settings.prodUrl ?? "",
      repo: state?.settings.repo ?? "",
      readDate: day(readAt()),
      busy: !!state?.job.running || reading,
      reading, read,
    };
  }, [state, offline, data, toolsText, memory.last, memory.way, reading, refresh, toast]);
}

/** One query parameter as the page's state: the tab, the selected row. */
export function useParam(name: string): [string | null, (v: string | null) => void] {
  const [params, setParams] = useSearchParams();
  const set = (v: string | null) => setParams(prev => { const n = new URLSearchParams(prev); if (v) n.set(name, v); else n.delete(name); return n; }, { replace: true });
  return [params.get(name), set];
}

/** The prompt's words around the criterion's quote: a little before, the quote, a little after. */
export function useQuoteContext(r: RuleEntry | undefined, around = 200) {
  const { data, isLoading } = useSource(r?.rule.sourceId);
  if (!r || !data) return { loading: isLoading, parts: null as null | [string, string, string] };
  const parts = splitQuote(data.content, r.rule.quote);
  if (!parts) return { loading: false, parts: null };
  const [before, quote, after] = parts;
  const head = before.length > around ? `…${before.slice(-around).replace(/^\S*\s/, "")}` : before;
  const tail = after.length > around ? `${after.slice(0, around).replace(/\s\S*$/, "")}…` : after;
  const plain = (t: string) => t.replace(/\*\*/g, "").replace(/^#{2,}\s*/gm, "");
  return { loading: false, parts: [plain(head.trimStart()), plain(quote), plain(tail.trimEnd())] as [string, string, string] };
}
