import { useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Check } from "../../app/links";
import { nameFromText, quoteKey, type Criterion } from "../../lab/criteria";
import { count } from "../../lab/format";
import { loadSaved, type CodeSnapshot, type SavedCheck, type ToneSnapshot } from "../../lab/history";
import type { Example, LogDialogue, RuleEntry, Side } from "../../lab/problems";
import type { Discover, LogResult, Rule } from "../../lab/types";
import type { Measured } from "./ResultView";

export type SavedCriterion = {
  id: string;
  name: string;
  text: string;
  quote: string;
  condition?: string;
  acceptable?: string;
  clarifications?: string[];
};

/**
 * A saved check as its page shows it (checks/RunPage), whichever check it is: its conversations and verdicts, its numbered criteria,
 * and what the criteria were collected from — the person's document for tone of voice, the agent's code for accuracy.
 */
export type Saved = {
  check: SavedCheck;
  result: Discover;
  dialogues: LogDialogue[];
  criteria: SavedCriterion[];
  /** The number of the criterion a verdict is about (its rule id), from 1; 0 when the saved set lacks it. */
  numberOf: (ruleId: string) => number;
  basis: string;
  source: { title: string; body: ReactNode };
  note: string;
};

export function toneSaved(data: ToneSnapshot): Saved {
  const numbers = new Map(data.criteria.map((criterion, index) => [criterion.id, index + 1]));
  return {
    ...data,
    numberOf: (ruleId) => numbers.get(ruleId) ?? 0,
    basis: "Основание в правилах",
    source: {
      title: `Правила общения · ${data.policy.name || "Tone of voice"}`,
      body: <p className="mt-4 whitespace-pre-wrap break-words text-body text-fg-2">{data.policy.content}</p>,
    },
    note: "Разговоры, критерии и оценки модели сохранены такими, какими были в конце проверки. Ваши ответы хранятся отдельно, здесь показаны последние.",
  };
}

/**
 * A saved check of accuracy: its criteria are the rules of its topics; one quote restated in several topics is one
 * criterion, as everywhere in the product (problems.rule_key).
 */
export function codeSaved(data: CodeSnapshot): Saved {
  const criteria: SavedCriterion[] = [];
  const byQuote = new Map<string, number>();
  const numbers = new Map<string, number>();
  for (const rule of data.result.topics.flatMap((topic) => topic.rules)) {
    const key = quoteKey(rule.quote || rule.text);
    if (!byQuote.has(key)) {
      criteria.push({
        id: rule.id,
        name: rule.name?.trim() || nameFromText(rule.text),
        text: rule.text,
        quote: rule.quote,
        condition: rule.condition,
        acceptable: rule.acceptable,
      });
      byQuote.set(key, criteria.length);
    }
    numbers.set(rule.id, byQuote.get(key)!);
  }
  const sources = data.result.sources ?? [];
  const custom = sources.some((source) => source.id === "accuracy-judge");
  return {
    ...data,
    criteria,
    numberOf: (ruleId) => numbers.get(ruleId) ?? 0,
    basis: custom ? "Основание в правилах судьи" : "Основание в коде агента",
    source: {
      title: `${custom ? "Правила судьи" : "Код агента"} · ${count(sources.length, "источник", "источника", "источников")}`,
      body: (
        <ul className="mt-4 space-y-2 text-body text-fg-3">
          {sources.map((source) => (
            <li key={source.id} className="break-words">
              <span className="font-mono text-small text-fg-2">{source.origin}</span> ·{" "}
              {count(source.rules, "критерий", "критерия", "критериев")}
            </li>
          ))}
        </ul>
      ),
    },
    // The service lays the latest answers given on this check over the saved ones (api.with_reviews), as for tone.
    note: "Разговоры, критерии и оценки модели сохранены такими, какими были в конце проверки. Ваши ответы хранятся отдельно, здесь показаны последние.",
  };
}

/** A saved check with its evidence, as its page reads it; the answers people gave on it laid over (api.with_reviews). */
export function useSaved(check: Check, id: string | null) {
  const query = useQuery({
    queryKey: ["history-snapshot", check, id],
    queryFn: () => loadSaved(check, id!),
    enabled: !!id,
    staleTime: 0,
  });
  const saved = useMemo(
    () => (query.data ? ("policy" in query.data ? toneSaved(query.data) : codeSaved(query.data)) : null),
    [query.data],
  );
  return { ...query, saved };
}

const empty = (): Side => ({ failed: 0, passed: 0, unknown: 0, notApplicable: 0, examples: [], ruleIds: [] });
/**
 * How a verdict ranks: an error, then «без ошибки», then not decided — the one that stands for a conversation when
 * several rules of one criterion judged it, and the order a criterion's examples are listed in. A criterion that did
 * not apply in a conversation has no verdict there.
 */
const RANK: Record<string, number> = { FAIL: 0, PASS: 1, UNKNOWN: 2 };
/** A conversation the check counts as checked: an error found, or every criterion that applied decided. */
const counted = (result: LogResult) => result.status === "PASS" || result.status === "FAIL";
/**
 * How well an error is backed, as the service orders a criterion's errors (backend domain/problems, reliability):
 * confirmed by a person, both models agree, nobody answered, the models split, refuted by a person.
 */
const backing = (e: Example) =>
  e.review === "disagree" ? 4 : e.review === "agree" ? 0 : e.second === "agree" ? 1 : e.second === "disagree" ? 3 : 2;

/**
 * The customer's words a quoted reply answered, for an error saved without them: the customer's message right before
 * the agent's message that holds the quote, its words matched as criteria's quotes are (quoteKey); empty when the
 * quote is not found.
 */
function askedIn(dialogue: LogDialogue | undefined, quote: string): string {
  const words = quoteKey(quote);
  const messages = dialogue?.messages ?? [];
  const at = words ? messages.findIndex((m) => m.role === "assistant" && quoteKey(m.content).includes(words)) : -1;
  return (
    messages
      .slice(0, Math.max(0, at))
      .reverse()
      .find((m) => m.role === "user")?.content ?? ""
  );
}

/**
 * The criteria of a saved check as the product shows any check's (lab/criteria, Criterion): numbered as it saved them,
 * each with its verdicts in the conversations — the worst one per conversation — and its counts of the conversations
 * the check counts as checked, as «Итог» counts them: `failed + passed` where it applies, `unknown` where it could not
 * be decided, `notApplicable` the rest. Its verdicts in the conversations the check could not check stay its examples.
 * A problem is named by its criterion; its most frequent error is its `title`. Nothing is serious here: a decision of
 * today is not laid on a check of the past.
 */
function savedCriteria(saved: Saved, check: Check): Criterion[] {
  const sides = saved.criteria.map(empty);
  const titles = saved.criteria.map(() => new Map<string, number>());
  const dialogues = new Map(saved.dialogues.map((d) => [d.id, d]));
  const checked = saved.result.results.filter(counted).length;
  for (const result of saved.result.results) {
    const standing = new Map<number, Rule>();
    for (const rule of result.rules) {
      const n = saved.numberOf(rule.ruleId);
      if (!n) continue;
      if (!sides[n - 1].ruleIds.includes(rule.ruleId)) sides[n - 1].ruleIds.push(rule.ruleId);
      if (!(rule.status in RANK)) continue;
      const was = standing.get(n);
      if (!was || RANK[rule.status] < RANK[was.status]) standing.set(n, rule);
    }
    for (const [n, rule] of standing) {
      const side = sides[n - 1];
      if (counted(result)) {
        if (rule.status === "FAIL") side.failed++;
        else if (rule.status === "PASS") side.passed++;
        else side.unknown++;
      }
      if (rule.status === "FAIL" && rule.title) titles[n - 1].set(rule.title, (titles[n - 1].get(rule.title) ?? 0) + 1);
      const example: Example = {
        source: "log",
        check,
        dialogueId: String(result.dialogueId),
        ruleId: rule.ruleId,
        status: rule.status === "FAIL" || rule.status === "PASS" ? rule.status : "UNKNOWN",
        opening: result.opening,
        // The customer's words beside an error: kept with the verdict, else found in the conversation it judged.
        asked:
          rule.asked ??
          (rule.status === "FAIL" ? askedIn(dialogues.get(String(result.dialogueId)), rule.agentQuote) : undefined),
        topic: "",
        agentQuote: rule.agentQuote,
        reason: rule.reason,
        title: rule.title,
        second: null,
        secondScope: null,
        review: rule.review ?? null,
        reviewScope: rule.review ? "rule" : null,
        counted: counted(result),
      };
      side.examples.push(example);
    }
  }
  return saved.criteria.map((criterion, i) => {
    const side = { ...sides[i], notApplicable: checked - sides[i].failed - sides[i].passed - sides[i].unknown };
    const title = [...titles[i]].sort((a, b) => b[1] - a[1])[0]?.[0];
    // In the service's order (domain/problems, verdicts and finish): first the errors the problem's most frequent title
    // names and nobody refuted, then the errors by how well they are backed, then «без ошибки», then not decided.
    const leads = (e: Example) => e.status === "FAIL" && e.title === title && e.review !== "disagree";
    side.examples.sort(
      (a, b) =>
        Number(leads(b)) - Number(leads(a)) ||
        RANK[a.status] - RANK[b.status] ||
        (a.status === "FAIL" ? backing(a) - backing(b) : 0),
    );
    const answered = side.examples.filter((e) => e.review);
    const r = {
      id: criterion.id,
      title: title ?? criterion.name,
      serious: false,
      severity: { by: null, proposed: null },
      rule: {
        name: criterion.name,
        text: criterion.text,
        quote: criterion.quote,
        sourceId: null,
        origin: "",
        kind: check === "tone" ? "tone-of-voice" : "accuracy",
        condition: criterion.condition ?? "",
        acceptable: criterion.acceptable ?? "",
      },
      topics: [],
      log: side,
      sim: empty(),
      secondJudge: { checked: 0, agree: 0, byDialogue: 0 },
      human: {
        agree: answered.filter((e) => e.review === "agree").length,
        disagree: answered.filter((e) => e.review === "disagree").length,
      },
      scenarioIds: [],
      // The kinds of its errors, when the check grouped them (lab/criteria, kindsOf).
      kinds: side.ruleIds.map((id) => saved.result.kinds?.[id]).find(Boolean),
    } satisfies RuleEntry;
    return { r, n: i + 1, name: criterion.name, every: false, topics: [] };
  });
}

/**
 * A saved check as the service's record of a check's problems (lab/problems, Problems) and its numbered criteria, so
 * it reads as a current result does (checks/ResultView): its line of counts is the history's.
 */
export function savedRecord(saved: Saved, check: Check): { data: Measured; list: Criterion[] } {
  const list = savedCriteria(saved, check);
  const { finishedAt, sampled, summary } = saved.check;
  return {
    list,
    data: {
      check,
      log: {
        sampled,
        assessed: summary.measured,
        withViolations: summary.failed,
        unassessed: summary.unmeasured,
        finishedAt,
        rulesSince: null,
      },
      sim: null,
      rules: list.map((c) => c.r),
      problems: list.filter((c) => c.r.log.failed > 0).map((c) => c.r.id),
      severity: { criteria: list.length, proposed: 0, decided: 0, error: null },
    },
  };
}
