import type { Run } from "../utils/types";
import type { Decision, Example, Scope } from "./problems";
import type { LabRun, LabState, Rule, Status } from "./types";

/** One row of the dialogues list: a logged conversation, a simulated one, or any other Workshop trace. */
export type Source = "log" | "sim" | "trace";
export type DialogRow = {
  key: string; source: Source; title: string; topic: string; status: Status | null;
  fails: string[]; disputed: boolean; when: string | null; traceId: string | null;
  dialogueId?: string; runId?: string; index?: number; persona?: string; attempt?: number; name?: string;
  rules: Rule[]; second?: { model?: string; status: string; rules?: Rule[] } | null; review?: Decision | null;
};

export const logKey = (dialogueId: string) => `log~${dialogueId}`;
export const simKey = (runId: string, index: number) => `sim~${runId}~${index}`;

/** The dialogue an example of a problem or a rule comes from. */
export const dialogOf = (e: Pick<Example, "source" | "dialogueId" | "runId" | "index">) =>
  e.source === "log"
    ? `/dialogs?d=${encodeURIComponent(logKey(e.dialogueId ?? ""))}`
    : `/dialogs?src=sim&run=${encodeURIComponent(e.runId ?? "")}&d=${encodeURIComponent(simKey(e.runId ?? "", e.index ?? 0))}`;

/** The dialogue behind a row key, at its block: a logged one in «Логи», a simulated one in «Результаты» of its run. */
export function dialogLink(key: string): string {
  const [kind, a, b] = key.split("~");
  if (kind === "sim") return dialogOf({ source: "sim", runId: a, index: Number(b) });
  if (kind === "log") return dialogOf({ source: "log", dialogueId: a });
  return `/dialogs?src=traces&d=${encodeURIComponent(key)}`;
}

const failTitles = (rules: Rule[]) => [...new Set(rules.filter(r => r.status === "FAIL").map(r => r.title || r.rule))];
const disputedOf = (status: Status, second?: DialogRow["second"]) =>
  !!second && ["PASS", "FAIL", "UNMEASURED"].includes(second.status) && second.status !== status;

export function logRows(state: LabState): DialogRow[] {
  const d = state.discover;
  if (!d) return [];
  const topics = new Map(d.topics.map(t => [t.id, t.title]));
  return d.results.map(r => ({
    key: logKey(String(r.dialogueId)), source: "log" as const, title: r.opening, topic: topics.get(r.topicId) ?? "", status: r.status,
    fails: failTitles(r.rules), disputed: disputedOf(r.status, r.second), when: null, traceId: r.runId ?? null,
    dialogueId: String(r.dialogueId), rules: r.rules, second: r.second ?? null,
  }));
}

export function simRows(run: LabRun | null | undefined): DialogRow[] {
  if (!run?.items) return [];
  return run.items.map((item, index) => ({
    key: simKey(run.id, index), source: "sim" as const, title: item.conversation[0]?.text ?? item.name, topic: item.topic, status: item.status,
    fails: failTitles(item.rules), disputed: disputedOf(item.status, item.second), when: run.startedAt, traceId: item.runId ?? null,
    runId: run.id, index, persona: item.persona, attempt: item.attempt, name: item.name, rules: item.rules,
    second: item.second ?? null, review: item.review ?? null,
  }));
}

/** Traces that are not the product's own dialogues: any agent the Workshop recorded. */
export function traceRows(runs: Run[]): DialogRow[] {
  return runs.filter(r => r.event_name !== "agent-lab").map(r => ({
    key: `trace~${r.id}`, source: "trace" as const, title: r.display_name || r.name || r.id, topic: r.user_id ?? "", status: null,
    fails: [], disputed: false, when: new Date(r.started_at).toISOString(), traceId: r.id, rules: [],
  }));
}

function secondFor(row: DialogRow, rule: Rule): [Decision | null, Scope | null] {
  const second = row.second;
  if (!second || !["PASS", "FAIL", "UNMEASURED"].includes(second.status)) return [null, null];
  if (second.rules?.length) {
    const own = second.rules.find(r => r.ruleId === rule.ruleId);
    if (!own || (own.status !== "PASS" && own.status !== "FAIL")) return [null, null];
    return [own.status === rule.status ? "agree" : "disagree", "rule"];
  }
  return [second.status === row.status ? "agree" : "disagree", "dialogue"];
}

/** A rule's verdict in this dialogue, in the shape the review and the judge's note take. */
export function exampleFor(row: DialogRow, rule: Rule): Example {
  const [second, secondScope] = secondFor(row, rule);
  const review = rule.review ?? (row.source === "sim" ? row.review ?? null : null);
  return {
    source: row.source === "sim" ? "sim" : "log", dialogueId: row.dialogueId, runId: row.runId, index: row.index, ruleId: rule.ruleId,
    status: rule.status === "FAIL" || rule.status === "PASS" ? rule.status : "UNKNOWN", traceId: row.traceId, opening: row.title,
    topic: row.topic, name: row.name, persona: row.persona, attempt: row.attempt, agentQuote: rule.agentQuote, reason: rule.reason,
    second, secondScope, review, reviewScope: rule.review ? "rule" : review ? "dialogue" : null,
  };
}

/** The dialogue as text for a ticket: who said what, then the judge's verdicts. */
export function transcript(row: DialogRow, turns: { role: string; text: string }[]): string {
  const lines = [`# ${row.title}`, "", `${row.source === "log" ? "Лог" : "Симуляция"} · ${row.topic}`, ""];
  for (const t of turns) lines.push(`${t.role === "customer" ? "Клиент" : "Агент"}: ${t.text}`, "");
  const judged = row.rules.filter(r => r.status === "FAIL" || r.status === "PASS");
  if (judged.length) {
    lines.push("## Вердикты судьи", "");
    for (const r of judged) lines.push(`- ${r.status === "FAIL" ? "✗ нарушено" : "✓ выполнено"}: ${r.rule}`, `  ${r.reason}${r.agentQuote ? ` «${r.agentQuote}»` : ""}`);
  }
  return lines.join("\n");
}
