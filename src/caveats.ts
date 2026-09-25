import { z } from 'zod';
import type { Experiment } from './contracts.js';
import { countText } from './plural.js';

/*
 * What a record's result does not prove, particular to that record: notes the lab writes where they arise, each typed
 * by its code — never a sentence another module has to decode — at most once, in the order they arose. A fresh draft
 * of a record starts with none of them but the teaching example's: every other note is about the work done on that
 * record. Every surface reads them through caveatLines, in the owner's words; records written before notes were typed
 * keep their `limitations` strings, read there as they are.
 */

/** Why a run's failure causes could not be named: its budget ran out, it was stopped, the model did not answer, the model's answer did not hold, or something else broke. */
export const CAUSE_FAILURES = ['budget', 'stopped', 'unavailable', 'rejected', 'failed'] as const;
export type CauseFailure = typeof CAUSE_FAILURES[number];

export const caveatSchema = z.discriminatedUnion('code', [
  /** The teaching example: the customer, the judge and the preparation are deterministic stand-ins, no model. */
  z.strictObject({ code: z.literal('demo') }),
  /** The situations' expectations were accepted automatically, without a person. */
  z.strictObject({ code: z.literal('automated_review') }),
  /** The owner confirmed the expectations before the run; nobody checked the cards' definitions or the judge's verdicts. */
  z.strictObject({ code: z.literal('expectations_review') }),
  /** Situations without a script were not run in the scripted mode: how many. */
  z.strictObject({ code: z.literal('scripted_skipped'), situations: z.number().int().positive().max(200) }),
  /** The adapter never confirmed it reset the external state the situations seed: their checks of state are not measured. */
  z.strictObject({ code: z.literal('state_unconfirmed') }),
  /** The failure causes could not be named, and why. */
  z.strictObject({ code: z.literal('causes_unnamed'), cause: z.enum(CAUSE_FAILURES) }),
  /** A re-assessment of recorded conversations: the agent and the customer did not run. */
  z.strictObject({ code: z.literal('reassessment') }),
  /** Only the exact checks were recomputed: the judge assessed nothing, no cause was named. */
  z.strictObject({ code: z.literal('code_only') }),
  /** The process stopped between two saves: the calls and the spending counted may be incomplete. */
  z.strictObject({ code: z.literal('usage_incomplete') }),
  /** The draft's judge could not be reached from this network: `to`, the model that built the situations, judged instead. */
  z.strictObject({ code: z.literal('judge_fallback'), from: z.string().min(1).max(320), to: z.string().min(1).max(320) }),
]);
export type Caveat = z.infer<typeof caveatSchema>;
export const caveatsSchema = z.array(caveatSchema).max(40);

/** Adds a note to the record, once: a note of the same code is replaced by the newer one, never repeated. */
export function addCaveat(record: Pick<Experiment, 'caveats'>, caveat: Caveat): void {
  const notes = record.caveats ?? [];
  const at = notes.findIndex(note => note.code === caveat.code);
  record.caveats = at < 0 ? [...notes, caveat] : notes.map((note, index) => index === at ? caveat : note);
}

const CAUSE_TEXT: Readonly<Record<CauseFailure, string>> = {
  budget: 'не хватило лимита вызовов модели',
  stopped: 'разбор остановили',
  unavailable: 'модель не ответила',
  rejected: 'ответ модели не прошёл проверку',
  failed: 'разбор прервался из-за сбоя',
};

/** A note in the owner's words. */
export function caveatText(caveat: Caveat): string {
  switch (caveat.code) {
    case 'demo': return 'Учебный пример: клиент, судья и подготовка — заготовки без модели; это не измерение качества модели.';
    case 'automated_review': return 'Ожидания ситуаций проверены автоматически, без человека: спорные вердикты стоит посмотреть, однозначные годятся как предварительный результат.';
    case 'expectations_review': return 'Владелец подтвердил ожидания ситуаций перед запуском. Определения карточек и оценки судьи человеком не проверялись.';
    case 'scripted_skipped': return `Без сценария — ${countText(caveat.situations, ['ситуация', 'ситуации', 'ситуаций'])}: в сценарном режиме их не запускали.`;
    case 'state_unconfirmed': return 'Адаптер не подтвердил сброс внешнего состояния ситуаций: проверки состояния не измерены.';
    case 'causes_unnamed': return `Причины провалов не названы: ${CAUSE_TEXT[caveat.cause]}.`;
    case 'reassessment': return 'Переоценка записанных разговоров: агент и клиент не запускались. Смена ожиданий или судьи не доказывает, что агент стал лучше.';
    case 'code_only': return 'Пересчитаны только точные проверки: ожидания судья не оценивал, причины провалов не назывались.';
    case 'usage_incomplete': return 'Процесс останавливался между сохранениями: число вызовов модели и расход могут быть неполными.';
    case 'judge_fallback': return `Судья ${caveat.from} недоступен из этой сети: ответы оценивала модель ${caveat.to} — та же, что готовила ситуации.`;
  }
}

/** Whether a stored note was written for the owner: everything the lab says to a person is Russian, an English note is a diagnostic. */
const forOwner = (text: string): boolean => [...text].some(char => (char >= 'А' && char <= 'я') || char === 'ё' || char === 'Ё');

/**
 * Every note of a record in the owner's words, each once: its typed notes, then the notes a record written before they
 * were typed keeps — those written for the owner, as they are.
 */
export function caveatLines(record: Pick<Experiment, 'caveats' | 'limitations'>): string[] {
  return [...new Set([...(record.caveats ?? []).map(caveatText), ...record.limitations.filter(forOwner)])];
}
