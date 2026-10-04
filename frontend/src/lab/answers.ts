import { count, plural } from "./format";
import { shareText } from "./history";
import { MISSES_FROM } from "./verdicts";
import type { Discover } from "./types";

/**
 * A check's result with people's answers taken in (spec 2026-10-04-answers-and-summary-design.md, 2.1), counted from
 * the result's own rows. A conversation is «с ошибкой с учётом ответов» when it keeps an error a person did not take
 * back («Нет» on «Это действительно ошибка?»), or a person found the error the check missed there («Нет» on «Здесь
 * правда нет ошибки?»); one where every error was taken back counts «без найденных ошибок». The denominator stays the
 * check's: the conversations it could check. It never stands in for the check's own number, is never compared between
 * checks and never enters «было → стало» (DESIGN.md, «Честность чисел», 9).
 */
export type Answers = {
  /** The check's own count: the conversations it could check, and those it found an error in. */
  measured: number;
  failed: number;
  /** The same conversations with an error, people's answers taken in. */
  counted: number;
  /** The errors the check found (one criterion in one conversation), and people's «да» and «нет» on them. */
  errors: number;
  confirmed: number;
  removed: number;
  /** The verdicts «без ошибки» people answered, and in how many they found the error the check missed. */
  clean: number;
  missed: number;
};

/** Every answered verdict of a result: on the errors it found and on the cases «без ошибки». */
const answeredOf = (a: Answers) => a.confirmed + a.removed + a.clean;

/** The result's answers, from its own rows: the one count the line under the number, «Обзор» and the summary share. */
export function answersOf(result: Discover | null | undefined): Answers | null {
  if (!result) return null;
  const a: Answers = { measured: 0, failed: 0, counted: 0, errors: 0, confirmed: 0, removed: 0, clean: 0, missed: 0 };
  for (const conversation of result.results) {
    const measured = conversation.status === "FAIL" || conversation.status === "PASS";
    let error = false;
    for (const row of conversation.rules) {
      if (row.status === "FAIL") {
        a.errors++;
        if (row.review === "agree") a.confirmed++;
        if (row.review === "disagree") a.removed++;
        else error = true;
      } else if (row.status === "PASS" && row.review) {
        a.clean++;
        if (row.review === "disagree") {
          a.missed++;
          error = true;
        }
      }
    }
    // A conversation the check could not check stays out of the count, as on the screen: answers do not bring it in.
    if (!measured) continue;
    a.measured++;
    if (conversation.status === "FAIL") a.failed++;
    if (error) a.counted++;
  }
  return a;
}

/**
 * «С учётом ваших ответов — 21 из 53 (40%): вы сняли 1 ошибку и нашли 0 пропущенных; проверено 11 оценок.» In three
 * parts, so a screen can set the count apart: the head, the count with its share, the rest. Who answered: the person
 * reading («вы»), or people, for a page someone else reads. A part is said only when it has answers behind it: the
 * misses only once a case «без ошибки» was answered, and from MISSES_FROM such answers with how many there were (the
 * review queue asks as many, so the share of misses means something). Null before the first answer.
 */
export function answersSentence(
  a: Answers,
  who: "you" | "people" = "you",
): { head: string; share: string; rest: string } | null {
  const answered = answeredOf(a);
  if (!answered) return null;
  const parts: string[] = [];
  if (a.confirmed + a.removed) parts.push(`сняли ${count(a.removed, "ошибку", "ошибки", "ошибок")}`);
  if (a.clean)
    parts.push(
      `нашли ${a.missed}\u00a0${plural(a.missed, "пропущенную", "пропущенные", "пропущенных")}` +
        (a.clean >= MISSES_FROM
          ? ` в\u00a0${count(a.clean, "проверенном случае", "проверенных случаях", "проверенных случаях")} «без ошибки»`
          : ""),
    );
  return {
    head: who === "you" ? "С учётом ваших ответов" : "С учётом ответов людей",
    share: shareText({ failed: a.counted, measured: a.measured }),
    rest: `: ${who === "you" ? "вы" : "люди"} ${parts.join(" и ")}; проверено ${count(answered, "оценка", "оценки", "оценок")}.`,
  };
}

/** The same sentence as one line of text, for a letter. */
export const answersText = (a: Answers, who: "you" | "people" = "you") => {
  const s = answersSentence(a, who);
  return s ? `${s.head} — ${s.share}${s.rest}` : null;
};

/** «9 — ошибка, 1 — нет»: a person's answers on the errors one criterion has, as the problem's row and page say them. */
export const yesNoText = (yes: number, no: number) => `${yes}\u00a0—\u00a0ошибка, ${no}\u00a0—\u00a0нет`;
