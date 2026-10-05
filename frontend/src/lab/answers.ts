import { count, plural } from "./format";
import { shareText } from "./history";
import { MISSES_FROM } from "./verdicts";
import type { Answers, ResultBrief } from "./types";

export type { Answers };

/** Every answered verdict of a result: on the errors it found and on the cases «без ошибки». */
const answeredOf = (a: Answers) => a.confirmed + a.removed + a.clean;

/**
 * A check's result with people's answers taken in: counted by the service from the result's own rows (/api/state,
 * the brief's `answers`), the one count the line under the number, «Обзор» and the summary share.
 */
export const answersOf = (result: ResultBrief | null | undefined): Answers | null => result?.answers ?? null;

/**
 * «С учётом ваших ответов — 21 из 53 (40%). Вы проверили 11 оценок, сняли 1 ошибку и нашли 0 пропущенных.» In three
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
        (a.clean >= MISSES_FROM ? ` в\u00a0${count(a.clean, "случае", "случаях", "случаях")} «без ошибки»` : ""),
    );
  const checked = `${who === "you" ? "Вы" : "Люди"} проверили ${count(answered, "оценку", "оценки", "оценок")}`;
  return {
    head: who === "you" ? "С учётом ваших ответов" : "С учётом ответов людей",
    share: shareText({ failed: a.counted, measured: a.measured }),
    rest: `. ${checked}, ${parts.join(" и ")}.`,
  };
}

/** The same sentence as one line of text, for a letter. */
export const answersText = (a: Answers, who: "you" | "people" = "you") => {
  const s = answersSentence(a, who);
  return s ? `${s.head} — ${s.share}${s.rest}` : null;
};

/** «9 — ошибка, 1 — нет»: a person's answers on the errors one criterion has, as the problem's row and page say them. */
export const yesNoText = (yes: number, no: number) => `${yes}\u00a0—\u00a0ошибка, ${no}\u00a0—\u00a0нет`;
