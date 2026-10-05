import { conversationsLink } from "../app/links";
import { CHECK_NAME } from "./checks";
import { inlineText, quoteText } from "./problemReport";
import type { Decision, Example } from "./problems";
import type { Check, Criterion, LabRun, LabState, Rule, Status } from "./types";

/** One row of a stage's conversations: a logged conversation or a simulated one. */
export type Source = "log" | "sim";
export type DialogRow = {
  key: string;
  source: Source;
  /** The check whose result judged it; of a simulated one, the check of its run. */
  check?: Check;
  title: string;
  topic: string;
  status: Status | null;
  fails: string[];
  disputed: boolean;
  when: string | null;
  dialogueId?: string;
  runId?: string;
  index?: number;
  persona?: string;
  attempt?: number;
  name?: string;
  rules: Rule[];
  second?: { model?: string; status: string; rules?: Rule[] } | null;
  review?: Decision | null;
  /** The criteria frozen in a simulated conversation when it was played. */
  frozen?: Criterion[];
};

export const logKey = (dialogueId: string) => `log~${dialogueId}`;
export const simKey = (runId: string, index: number) => `sim~${runId}~${index}`;

/** The dialogue an example of a problem or a rule comes from: in its check's section, or in its run. */
export const dialogOf = (e: Pick<Example, "source" | "dialogueId" | "runId" | "index" | "check">) =>
  e.source === "log"
    ? conversationsLink(e.check ?? "tone", { d: logKey(e.dialogueId ?? "") })
    : conversationsLink("sim", { run: e.runId, d: simKey(e.runId ?? "", e.index ?? 0) });

/** The conversation behind a row key: a real one in the section of the check given, a simulated one in its run. */
export function dialogLink(key: string, check: Check): string {
  const [kind, a, b] = key.split("~");
  if (kind === "sim") return dialogOf({ source: "sim", runId: a, index: Number(b) });
  if (kind === "log") return dialogOf({ source: "log", dialogueId: a, check });
  return "/overview";
}

const failTitles = (rules: Rule[]) => [
  ...new Set(rules.filter((r) => r.status === "FAIL").map((r) => r.title || r.rule)),
];
/** Only two decided verdicts agree or disagree; a check that decided nothing is no second opinion. */
const decided = (status: string | null | undefined): status is "PASS" | "FAIL" =>
  status === "PASS" || status === "FAIL";

/** The two checks on a whole conversation: agree, disagree, or nothing to compare. */
export const twoChecks = (status: Status | null, second?: DialogRow["second"]): Decision | null =>
  decided(status) && decided(second?.status) ? (second.status === status ? "agree" : "disagree") : null;

const disputedOf = (status: Status, second?: DialogRow["second"]) => twoChecks(status, second) === "disagree";

/** The conversations of the export as one check's result judged them. */
export function logRows(state: LabState, check: Check): DialogRow[] {
  const d = state.checks[check];
  if (!d) return [];
  const topics = new Map(d.topics.map((t) => [t.id, t.title]));
  return d.results.map((r) => ({
    key: logKey(String(r.dialogueId)),
    source: "log" as const,
    check,
    title: r.opening,
    topic: topics.get(r.topicId) ?? "",
    status: r.status,
    fails: failTitles(r.rules),
    disputed: disputedOf(r.status, r.second),
    when: null,
    dialogueId: String(r.dialogueId),
    rules: r.rules,
    second: r.second ?? null,
  }));
}

export function simRows(run: LabRun | null | undefined): DialogRow[] {
  if (!run?.items) return [];
  return run.items.map((item, index) => ({
    key: simKey(run.id, index),
    source: "sim" as const,
    check: run.check,
    title: item.conversation[0]?.text ?? item.name,
    topic: item.topic,
    status: item.status,
    fails: failTitles(item.rules),
    disputed: disputedOf(item.status, item.second),
    when: run.startedAt,
    runId: run.id,
    index,
    persona: item.persona,
    attempt: item.attempt,
    name: item.name,
    rules: item.rules,
    second: item.second ?? null,
    review: item.review ?? null,
    frozen: item.criteria,
  }));
}

/** The second check on one verdict, as backend/lab/problems.py second_of: per rule, or on the whole conversation. */
function secondFor(row: DialogRow, rule: Rule): Pick<Example, "second" | "secondScope" | "secondStatus"> {
  const none = { second: null, secondScope: null, secondStatus: null };
  const second = row.second;
  if (!second || !["PASS", "FAIL", "UNMEASURED"].includes(second.status)) return none;
  if (second.rules?.length) {
    const own = second.rules.find((r) => r.ruleId === rule.ruleId);
    if (!own || !decided(own.status)) return none;
    return { second: own.status === rule.status ? "agree" : "disagree", secondScope: "rule", secondStatus: own.status };
  }
  const decision = twoChecks(row.status, second);
  return decision
    ? { second: decision, secondScope: "dialogue", secondStatus: second.status as "PASS" | "FAIL" }
    : none;
}

/** A rule's verdict in this dialogue, in the shape the review and the judge's note take. */
export function exampleFor(row: DialogRow, rule: Rule): Example {
  const review = rule.review ?? (row.source === "sim" ? (row.review ?? null) : null);
  return {
    source: row.source === "sim" ? "sim" : "log",
    check: row.check,
    dialogueId: row.dialogueId,
    runId: row.runId,
    index: row.index,
    ruleId: rule.ruleId,
    status: rule.status === "FAIL" || rule.status === "PASS" ? rule.status : "UNKNOWN",
    opening: row.title,
    topic: row.topic,
    name: row.name,
    persona: row.persona,
    attempt: row.attempt,
    agentQuote: rule.agentQuote,
    reason: rule.reason,
    ...secondFor(row, rule),
    review,
    reviewScope: rule.review ? "rule" : review ? "dialogue" : null,
  };
}

/** The dialogue as text for a ticket: who said what, then the judge's verdicts. */
export function transcript(row: DialogRow, turns: { role: string; text: string }[]): string {
  const where = row.source === "log" ? ["Диалоги", row.check && CHECK_NAME[row.check]] : ["Симуляция"];
  // The customer's and the agent's words stay words (inlineText, quoteText): never a heading, a list or a link.
  const lines = [`# ${inlineText(row.title)}`, "", inlineText([...where, row.topic].filter(Boolean).join(" · ")), ""];
  for (const t of turns) lines.push(`${t.role === "customer" ? "Клиент" : "Агент"}:`, quoteText(t.text), "");
  const judged = row.rules.filter((r) => r.status === "FAIL" || r.status === "PASS");
  if (judged.length) {
    lines.push("## Проверка по критериям", "");
    for (const r of judged)
      lines.push(
        `- ${r.status === "FAIL" ? "✗ ошибка" : "✓ без ошибки"}: ${inlineText(r.rule)}`,
        `  ${inlineText(r.reason)}${r.agentQuote ? ` «${inlineText(r.agentQuote)}»` : ""}`,
      );
  }
  return lines.join("\n");
}
