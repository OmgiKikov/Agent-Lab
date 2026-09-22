import type { Experiment, Trial } from '../dist/contracts.js';
import { valueTokens } from '../dist/contracts.js';
import { plannedTrials, type RunComparison } from '../dist/comparison.js';
import type { ScenarioLibrary, ScenarioVariant } from '../dist/scenario-contracts.js';
import { resolutionBusinessHash, resolutionHash, resolutionQuestionHash } from '../dist/scenario-library.js';
import type { VariantFieldDiff, VariantOperation } from '../dist/scenario-variants.js';
import { semanticWorkStatus } from '../dist/scenario-work.js';
import { shortId, type ResultView } from '../dist/result-view.js';
import { GLYPH, type Row } from './render/theme.ts';

/*
 * The conversational surface of Agent Lab: everything a chat request needs before it reaches the
 * same ExperimentLab operations the board and the CLI use. Three jobs live here, all pure:
 *
 *   owner words ──► authority for a draft edit (never model text)
 *   human reference («вторая карточка», a title, an id prefix) ──► one stored object, or candidates
 *   stored record ──► short rows for the chat feed, details on expand
 *
 * Nothing in this file writes state or keeps its own copy of it.
 */

const SPACED = new Set('«»"\'`.,;:!?()[]{}<>—–-'.split(''));
const fold = (value: string): string => {
  let out = '';
  for (const ch of value.toLocaleLowerCase('ru').replaceAll('ё', 'е')) out += SPACED.has(ch) || /\s/u.test(ch) ? ' ' : ch;
  return out.trim().split(' ').filter(Boolean).join(' ');
};
const oneLine = (value: unknown): string => String(value ?? '').replace(/\s+/g, ' ').trim();
const clip = (value: unknown, limit: number): string => { const text = oneLine(value); return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`; };

/* ───────────────────────────── owner words ───────────────────────────── */

type BranchReader = { sessionManager?: { getBranch?: () => unknown[] } };

/**
 * The owner's own messages of the current session branch, oldest first. Only user-role session
 * entries count: a tool result, a model reply or a custom message can never appear here, so the
 * model cannot supply the words an edit is attributed to.
 */
export function ownerMessages(ctx: BranchReader): string[] {
  let entries: unknown[];
  try { entries = ctx.sessionManager?.getBranch?.() ?? []; } catch { return []; }
  return entries.flatMap(entry => {
    const item = entry as { type?: string; message?: { role?: string; content?: unknown } };
    if (item.type !== 'message' || item.message?.role !== 'user') return [];
    const content = item.message.content;
    const text = typeof content === 'string' ? content : Array.isArray(content)
      ? content.flatMap(part => part && typeof part === 'object' && (part as { type?: string }).type === 'text' ? [String((part as { text?: unknown }).text ?? '')] : []).join('\n') : '';
    return text.trim() ? [text.trim()] : [];
  });
}

/** Value-like tokens (numbers, codes, dates) of `text` that occur in none of the `allowed` texts. */
export function ungroundedValues(text: string, allowed: string[]): string[] {
  const known = valueTokens(allowed.join('\n'));
  return [...valueTokens(text)].filter(token => !known.has(token));
}

/**
 * True when `text` is a contiguous phrase inside one source, after the same folding as quotes.
 * This locates text, never proves intent or authorizes an owner receipt.
 */
export function verbatimSpan(text: string, sources: string[]): boolean {
  const folded = fold(text);
  if (!folded) return true;
  return sources.some(source => {
    const normalized = fold(source);
    const index = normalized.indexOf(folded);
    return index >= 0 && (index === 0 || normalized[index - 1] === ' ')
      && (index + folded.length === normalized.length || normalized[index + folded.length] === ' ')
      && !normalized.slice(0, index).trimEnd().endsWith('не');
  });
}

export interface OwnerBasis {
  /** The reason stored with the edit: the owner's message, verbatim. */
  reason: string;
  /** `quote`: the model pointed at a message fragment and it was found; `latest`: the message that started this turn. */
  source: 'quote' | 'latest';
  /** The message itself and its place in the conversation, for the intent check. */
  message: string;
  index: number;
}

/**
 * The owner message an edit is recorded under. A `quote` is used only when it is found in a real
 * owner message; otherwise the latest owner message stands, because it is the instruction the
 * current turn answers. Null when the owner has said nothing in this session.
 */
export function ownerBasis(messages: string[], quote?: string): OwnerBasis | null {
  if (!messages.length) return null;
  const wanted = quote ? fold(quote) : '';
  if (wanted.length >= 6) {
    const index = messages.findLastIndex(message => fold(message).includes(wanted));
    if (index >= 0) return { reason: reasonText(messages[index]!), source: 'quote', message: messages[index]!, index };
  }
  return { reason: reasonText(messages.at(-1)!), source: 'latest', message: messages.at(-1)!, index: messages.length - 1 };
}
const reasonText = (message: string): string => `Владелец в разговоре: «${clip(message, 940)}»`;

/** The tool the model called. The harness does not decide this by reading the sentence. */
export type Intent = 'edit' | 'variant' | 'remove' | 'merge' | 'split' | 'stop';
export type Authority =
  | { kind: 'conversation'; reason: string }
  | { kind: 'confirm'; reason: string; question: string }
  | { kind: 'ask'; message: string; ownerMessage: string };

/**
 * The model already chose the tool. This only checks that a value was said and that owner-attributed
 * wording is a verbatim span. Simulated wording is a draft proposal, not an owner receipt.
 * Intent and reference selection belong to the model; this function does not certify them.
 */
export function authorize(input: { messages: string[]; quote?: string; intent: Intent; attributed?: string[]; simulated?: string[]; known?: string[]; summary: string; provenance?: boolean; objects?: InstructionObjects }): Authority {
  const basis = ownerBasis(input.messages, input.quote);
  if (!basis) return { kind: 'confirm', reason: 'Подтверждено владельцем в диалоге Pi.', question: input.summary };
  const allowed = [...input.messages, ...(input.known ?? [])];
  const spoken = [...(input.attributed ?? []), ...(input.simulated ?? [])];
  const invented = [...new Set(spoken.flatMap(text => ungroundedValues(text, allowed)))];
  if (invented.length) return { kind: 'ask', message: `Владелец не называл: ${invented.join(', ')}. Спросите у него точное значение; ничего не записано.`,
    ownerMessage: `Значение ${invented.join(', ')} вы не называли, а от себя я значения не записываю. Назовите точное — и я внесу. Ничего не изменено.` };
  if (input.provenance) return { kind: 'confirm', reason: basis.reason, question: input.summary };
  const foreign = (input.attributed ?? []).some(text => !verbatimSpan(text, [basis.message]));
  if (foreign) return { kind: 'confirm', reason: basis.reason, question: input.summary };
  return { kind: 'conversation', reason: basis.reason };
}

export interface InstructionTarget {
  number?: number;
  title: string;
  otherTitles: string[];
  lastTouched?: boolean;
}
export interface InstructionObjects { kind: 'card' | 'group'; targets: InstructionTarget[]; exhaustive?: boolean }

/* ───────────────────────────── references ───────────────────────────── */

export type Resolved<T> = { kind: 'one'; item: T } | { kind: 'none' } | { kind: 'many'; items: T[] };
const pick = <T>(items: T[]): Resolved<T> => items.length === 1 ? { kind: 'one', item: items[0]! } : items.length ? { kind: 'many', items } : { kind: 'none' };

/** Match by exact id, id prefix, 1-based position, exact name, then a name fragment. */
function resolveBy<T>(items: T[], ref: string, id: (item: T) => string, name: (item: T) => string): Resolved<T> {
  const raw = ref.trim();
  if (!raw) return { kind: 'none' };
  const exact = items.filter(item => id(item) === raw);
  if (exact.length) return pick(exact);
  const position = /^#?(\d{1,3})$/.exec(raw);
  if (position) { const item = items[Number(position[1]) - 1]; return item ? { kind: 'one', item } : { kind: 'none' }; }
  if (/^[A-Za-z0-9_-]{6,80}$/.test(raw)) { const prefixed = items.filter(item => id(item).startsWith(raw)); if (prefixed.length) return pick(prefixed); }
  const wanted = fold(raw);
  const same = items.filter(item => fold(name(item)) === wanted);
  if (same.length) return pick(same);
  const part = items.filter(item => fold(name(item)).includes(wanted));
  return pick(part);
}

/** Variants in the order every list shows them: group by group, so «третья карточка» means the third row on screen. */
export function orderedVariants(library: ScenarioLibrary): ScenarioVariant[] {
  const grouped = library.businessScenarios.flatMap(group => library.variants.filter(variant => variant.businessScenarioId === group.id));
  return [...grouped, ...library.variants.filter(variant => !grouped.includes(variant))];
}
/** The number a card has in every list, found by id so a detached copy of the library gives the same answer. */
export const variantNumber = (library: ScenarioLibrary, variant: Pick<ScenarioVariant, 'id'>): number => orderedVariants(library).findIndex(item => item.id === variant.id) + 1;
const groupTitle = (library: ScenarioLibrary, variant: ScenarioVariant): string => library.businessScenarios.find(group => group.id === variant.businessScenarioId)?.title ?? '';
export const resolveVariant = (library: ScenarioLibrary, ref: string): Resolved<ScenarioVariant> => {
  const byTitle = resolveBy(orderedVariants(library), ref, variant => variant.id, variant => variant.title);
  return byTitle.kind !== 'none' ? byTitle : resolveBy(orderedVariants(library), ref, variant => variant.id, variant => `${groupTitle(library, variant)} ${variant.title}`);
};
/** A group is named by its title first; its goal only helps when no title matches. */
export const resolveGroup = (library: ScenarioLibrary, ref: string) => {
  const byTitle = resolveBy(library.businessScenarios, ref, group => group.id, group => group.title);
  return byTitle.kind !== 'none' ? byTitle : resolveBy(library.businessScenarios, ref, group => group.id, group => `${group.title} ${group.goal}`);
};
export const resolveFact = (variant: ScenarioVariant, ref: string) => resolveBy(variant.userState.facts, ref, fact => fact.id, fact => `${fact.statement} ${fact.value ?? ''}`);
export const resolveRun = (records: Experiment[], ref: string) => resolveBy(records, ref, record => record.id, record => record.task);

/** What to tell the model when a reference does not name exactly one object. */
export function referenceProblem(what: string, ref: string, resolved: { kind: 'none' } | { kind: 'many'; items: unknown[] }, names: string[]): string {
  return resolved.kind === 'none'
    ? `${what} «${clip(ref, 80)}» не найдено. Есть: ${names.slice(0, 12).join('; ') || 'ничего'}. Уточните у владельца, что он имеет в виду.`
    : `${what} «${clip(ref, 80)}» подходит к нескольким: ${names.slice(0, 12).join('; ')}. Спросите владельца, какой из них нужен; не выбирайте сами.`;
}
/** The same problem as the owner reads it in the feed; the candidates follow as a list. */
export function referenceQuestion(ref: string, resolved: { kind: 'none' } | { kind: 'many'; items: unknown[] }): string {
  return resolved.kind === 'none' ? `«${clip(ref, 80)}» — такого здесь нет. Вот что есть:` : `«${clip(ref, 80)}» подходит к нескольким — какая нужна?`;
}

/* ───────────────────────────── one-sentence variants ───────────────────────────── */

const factLabel = (statement: string): string => { const at = statement.indexOf(':'); return (at > 0 ? statement.slice(0, at) : statement).trim(); };

const splitMarks = (text: string, marks: string): string[] => {
  const parts: string[] = [];
  let buf = '';
  for (const ch of text) {
    buf += ch;
    if (marks.includes(ch)) { parts.push(buf); buf = ''; }
  }
  if (buf) parts.push(buf);
  return parts;
};

/** The opening without the piece that reveals `value`. */
export function openingWithout(opening: string, value: string): string {
  if (!value || !fold(opening).includes(fold(value))) return opening;
  const mentions = (part: string): boolean => fold(part).includes(fold(value));
  const kept = splitMarks(opening, '.!?\n').filter(sentence => !mentions(sentence)).join('').trim();
  if (kept) return kept;
  const rest = splitMarks(opening, ',;').filter(part => !mentions(part)).map(part => part.replace(/[,;\s]+$/, '').trim()).filter(Boolean);
  return rest.join(', ');
}

export interface VariantHints { fact?: string; opening?: string; ifAsked?: string; reply?: string; missingDescription?: string; intent?: string; afterAction?: string; failures?: number }
export type DerivedVariant = { kind: 'ready'; input: Record<string, unknown> } | { kind: 'ask'; message: string };

/**
 * The `input` of a targeted variant, taken from the parent card wherever the card already answers:
 * which fact, the opening without its value, how the agent's request is recognised and what the
 * missing data is called. The owner is asked only for what neither the request nor the card holds.
 */
export function deriveVariantInput(parent: ScenarioVariant, operation: VariantOperation, hints: VariantHints): DerivedVariant {
  if (operation === 'reveal_on_request' || operation === 'missing_fact') {
    const initial = parent.userState.facts.filter(fact => fact.availability === 'initial');
    if (!initial.length) return { kind: 'ask', message: 'В этой карточке нет фактов, известных клиенту до разговора. Спросите владельца, какие данные клиент знает.' };
    const chosen = hints.fact ? resolveBy(initial, hints.fact, fact => fact.id, fact => `${fact.statement} ${fact.value ?? ''}`) : pick(initial);
    if (chosen.kind !== 'one') return { kind: 'ask', message: `Уточните у владельца, о каком факте речь: ${initial.map(fact => `«${fact.statement}»`).join('; ')}.` };
    const fact = chosen.item;
    const label = factLabel(fact.statement);
    const value = fact.value === undefined ? '' : String(fact.value);
    const missingDescription = (hints.missingDescription ?? (value ? openingWithout(label, value) || label : label)).replace(/[.\s]+$/, '');
    return { kind: 'ready', input: {
      factId: fact.id, opening: hints.opening ?? openingWithout(parent.userState.opening, value),
      ifAsked: hints.ifAsked ?? `Агент запросил: ${label}`,
      ...(hints.reply ? { reply: hints.reply } : {}),
      ...(operation === 'missing_fact' ? { missingDescription } : {}),
    } };
  }
  if (operation === 'ambiguous_opening') return hints.opening
    ? { kind: 'ready', input: { opening: hints.opening } }
    : { kind: 'ask', message: 'Нужна новая первая реплика клиента. Предложите её владельцу или спросите его формулировку.' };
  if (operation === 'changed_intent') {
    if (!hints.intent) return { kind: 'ask', message: 'Спросите владельца, на что клиент меняет намерение.' };
    const transitions = parent.behaviorPolicy.transitions;
    const wanted = hints.afterAction ? transitions.filter(item => item.actionId === hints.afterAction) : transitions.length === 1 ? transitions
      : transitions.filter(item => parent.behaviorPolicy.actions.find(action => action.id === item.actionId)?.kind === 'finish');
    if (wanted.length !== 1) return { kind: 'ask', message: `Уточните у владельца, после какого шага клиент меняет намерение: ${transitions.map(item => `«${item.when}»`).join('; ')}.` };
    return { kind: 'ready', input: { intent: hints.intent, afterActionId: wanted[0]!.actionId } };
  }
  return { kind: 'ready', input: { operation: 'update_record', failures: hints.failures ?? 1 } };
}

/* ───────────────────────────── feed rows ───────────────────────────── */

const row = (text: string, tone?: Row['tone'], bold = false, indent = 0): Row => ({ text, ...(tone ? { tone } : {}), ...(bold ? { bold } : {}), ...(indent ? { indent } : {}) });
const blank = (): Row => row('');
const plural = (n: number, forms: [string, string, string]): string => {
  const tail = n % 100, last = n % 10;
  return forms[tail >= 11 && tail <= 14 ? 2 : last === 1 ? 0 : last >= 2 && last <= 4 ? 1 : 2];
};
const count = (n: number, forms: [string, string, string]): string => `${n} ${plural(n, forms)}`;
const VARIANTS: [string, string, string] = ['вариант', 'варианта', 'вариантов'];
const DIALOGUES: [string, string, string] = ['диалог', 'диалога', 'диалогов'];
const qualityWord = { ready: 'готов', needs_review: 'нужно решение', blocked: 'заблокирован' } as const;
const qualityMark = { ready: GLYPH.pass, needs_review: GLYPH.unmeasured, blocked: GLYPH.fail } as const;
const qualityTone = { ready: 'success', needs_review: 'warning', blocked: 'error' } as const;
const provenanceWord = { production: 'из диалогов', curated: 'по требованиям', synthetic: 'синтетический' } as const;
const phaseWord: Record<string, string> = {
  preparing: 'готовится', review: 'черновик', evaluating: 'идёт прогон', results_review: 'есть результат', complete: 'разбор завершён',
  cancelled: 'остановлен', error: 'ошибка', interrupted: 'прерван', baseline: 'идёт прогон', improving: 'идёт прогон', control: 'идёт прогон',
};

const CHECKER_WORDS: [string, string][] = [
  ['ownerFactEvidence отсутствует', 'владелец этого не подтверждал'], ['ownerFactEvidence', 'подтверждение владельца'],
  ['checkpoints', 'проверки'], ['checkpoint', 'проверка'], ['learned_in_source', 'узнал только в старом разговоре'], ['initial', 'знал заранее'],
  ['uncertain', 'неясно'], ['ответом missing', 'ответом «данных нет»'], ['missing', '«данных нет»'],
];

/** A checker remark as the owner can act on it. The stored remark is not changed. */
export function plainIssue(library: ScenarioLibrary, variant: ScenarioVariant, issue: { path: string; message: string }): string {
  let text = issue.message;
  for (const other of library.variants) if (other.id.length >= 6) text = text.split(other.id).join(`«${other.title}»`);
  for (const fact of variant.userState.facts) if (fact.id.length >= 6) text = text.split(fact.id).join(`«${fact.statement}»`);
  for (const [from, word] of CHECKER_WORDS) text = text.split(from).join(word);
  const checkpointId = issue.path.split('.checkpoints.')[1]?.split('.')[0];
  const checkpoint = checkpointId ? variant.evaluationSpec.checkpoints.find(item => item.id === checkpointId) : undefined;
  const factId = issue.path.split('.facts.')[1]?.split('.')[0];
  const fact = factId ? variant.userState.facts.find(item => item.id === factId) : undefined;
  const about = checkpoint ? `Проверка «${checkpoint.rule}»` : fact ? `Факт «${fact.statement}»` : issue.path.endsWith('.duplicates') ? 'Похоже на дубль'
    : issue.path.includes('behaviorPolicy') ? 'Поведение клиента' : issue.path.includes('successCriteria') ? 'Ожидаемый результат' : issue.path.includes('opening') ? 'Первая реплика' : '';
  return about ? `${about}: ${text}` : text;
}

/** Remarks the owner can act on: «the recheck has not run yet» is the tool's own bookkeeping and is said once, by the recheck row. */
export const ownerRemarks = <T extends { code: string }>(issues: T[]): T[] => issues.filter(issue => issue.code !== 'semantic_pending' && issue.code !== 'semantic_variant_pending');

export const ownerQuestions = (variant: ScenarioVariant) => ownerRemarks(variant.issues).filter(issue => issue.code === 'semantic_finding' && issue.severity === 'needs_review');

/** Only an identical checkpoint uncertainty across every explicitly selected card is offered as one owner decision. */
export function sharedOwnerQuestions(library: ScenarioLibrary, cards: ScenarioVariant[]) {
  return (cards[0] ? ownerQuestions(cards[0]) : []).flatMap((anchor, index) => {
    const path = anchor.path.replace(`variants.${cards[0]!.id}.`, '');
    const scope = resolutionQuestionHash(library, cards[0]!, path, anchor.message);
    if (!scope) return [];
    const members = cards.flatMap(card => {
      const matching = ownerQuestions(card).filter(issue => resolutionQuestionHash(library, card, issue.path.replace(`variants.${card.id}.`, ''), issue.message) === scope);
      if (matching.length !== 1) return [];
      const issue = matching[0]!, memberPath = issue.path.replace(`variants.${card.id}.`, '');
      return [{ card, issue, path: memberPath, findingHash: resolutionHash(library, card, memberPath, issue.message) }];
    });
    return members.length === cards.length ? [{ questionNumber: index + 1, members }] : [];
  });
}

/** The checks of a card the scenario checker calls inapplicable or undefined, by their ids in the remark paths. */
export function disputedCheckpoints(variant: ScenarioVariant): ScenarioVariant['evaluationSpec']['checkpoints'] {
  const ids = new Set(variant.issues.flatMap(issue => /\.checkpoints\.([A-Za-z0-9_-]+)/.exec(issue.path)?.[1] ?? []));
  return variant.evaluationSpec.checkpoints.filter(item => ids.has(item.id));
}

export interface Feed { rows: Row[]; more?: Row[] }

/** Draft, accepted set and running snapshot are three different things; every library view names all three. */
export function stateRows(record: Experiment): Row[] {
  const library = record.librarySnapshot;
  const running = ['evaluating', 'baseline', 'improving', 'control'].includes(record.phase);
  const measured = ['results_review', 'complete', 'cancelled', 'interrupted'].includes(record.phase) && record.trials.length > 0;
  const acceptance = library?.acceptance;
  const accepted = acceptance ? `принят набор: ревизия ${acceptance.revision}, ${count(acceptance.variantIds.length, VARIANTS)}`
    : library ? 'принятого набора нет' : record.acceptedDraftHash ? 'ожидания подтверждены' : 'ожидания не подтверждены';
  return [row(running ? `Сейчас выполняется снимок этого набора: ${accepted}. Правки черновика на него не влияют.`
    : measured ? `Прогон выполнен на снимке: ${accepted}. Результат уже не изменится от правок.`
    : `Черновик · ${accepted}${acceptance || !library ? '' : '. Запуск возможен только после принятия'}.`, running ? 'accent' : 'muted')];
}

const budgetRow = (record: Experiment): Row => {
  const left = Math.max(0, record.settings.maxCalls - record.usage.calls);
  return row(`Вызовы модели: использовано ${record.usage.calls} из ${record.settings.maxCalls}, осталось ${left}.`, left ? 'muted' : 'warning');
};

/** Groups and variants of a draft: one row each in the feed, openings and expectations on expand. */
export function libraryFeed(record: Experiment): Feed {
  const library = record.librarySnapshot;
  if (!library) {
    const rows = [row(`${count(record.scenarios.length, ['ситуация', 'ситуации', 'ситуаций'])} в наборе`, 'text', true),
      ...record.scenarios.map((scenario, index) => row(`${index + 1}. ${clip(scenario.title, 120)}`, undefined, false, 1)), ...stateRows(record)];
    return { rows, more: record.scenarios.flatMap((scenario, index) => [row(`${index + 1}. ${scenario.title}`, 'accent', true), row(`Клиент пишет: «${scenario.user.opening}»`, undefined, false, 3), row(`Ожидается: ${scenario.successCriteria ?? 'не задано'}`, undefined, false, 3)]) };
  }
  const ordered = orderedVariants(library);
  const tally = (quality: ScenarioVariant['quality']) => ordered.filter(variant => variant.quality === quality).length;
  const head = [`${count(ordered.length, VARIANTS)}`, count(tally('ready'), ['готов', 'готовы', 'готовы']), ...(tally('needs_review') ? [count(tally('needs_review'), ['ждёт решения', 'ждут решения', 'ждут решения'])] : []),
    ...(tally('blocked') ? [count(tally('blocked'), ['заблокирован', 'заблокированы', 'заблокированы'])] : [])].join(' · ');
  const rows: Row[] = [row(`Сценарии · ревизия ${library.revision} · ${head}`, 'text', true)];
  const more: Row[] = [];
  for (const group of library.businessScenarios) {
    const members = ordered.filter(variant => variant.businessScenarioId === group.id);
    if (!members.length) continue;
    const uncertain = group.grouping.status === 'uncertain';
    rows.push(row(`${clip(group.title, 100)} · ${count(group.sourceDialogues.length, DIALOGUES)}${uncertain ? ' · группировка под вопросом' : ''}`, uncertain ? 'warning' : 'accent', false, 1));
    more.push(row(group.title, 'accent', true), row(group.goal, 'muted', false, 1), ...(uncertain ? [row(`Нужно решение: ${group.grouping.reason}`, 'warning', false, 1)] : []));
    for (const variant of members) {
      const label = `${variantNumber(library, variant)}. ${qualityMark[variant.quality]} ${clip(variant.title, 100)} — ${qualityWord[variant.quality]} · ${provenanceWord[variant.provenance]}`;
      const remarks = ownerRemarks(variant.issues);
      const issue = remarks[0] ? plainIssue(library, variant, remarks[0]) : variant.issues.length ? 'Изменена: ждёт смысловой перепроверки.' : undefined;
      const rest = remarks.length > 1 ? ` (и ещё ${remarks.length - 1})` : '';
      rows.push(row(label, qualityTone[variant.quality], false, 3), ...(issue ? [row(`${clip(issue, 220)}${rest}`, 'muted', false, 6)] : []));
      more.push(row(label, qualityTone[variant.quality], false, 1), row(`Клиент пишет: «${variant.userState.opening}»`, undefined, false, 4),
        row(`Ожидается: ${variant.evaluationSpec.successCriteria}`, undefined, false, 4), ...ownerRemarks(variant.issues).map(item => row(`• ${plainIssue(library, variant, item)}`, 'warning', false, 4)));
    }
  }
  const progress = record.preparationProgress;
  if (progress && (progress.pending.length || progress.excluded.length)) rows.push(row(`Логи: обработано ${progress.processed.length}, ожидают ${progress.pending.length}, исключено ${progress.excluded.length}.`, progress.pending.length ? 'warning' : 'muted'));
  if (progress?.excluded.length) more.push(blank(), row('Исключённые диалоги', 'accent', true), ...progress.excluded.map(item => row(`• ${item.dialogueId}: ${item.reason}`, 'muted', false, 1)));
  rows.push(...stateRows(record), budgetRow(record));
  return { rows, more };
}

const availabilityWord = { initial: 'Знает', learned_in_source: 'Узнал только в старом разговоре (в стартовые знания не входит)', uncertain: 'Неясно, знал ли заранее' } as const;
const originWord = { dialogue: 'прочитано из диалога', owner: 'подтверждено владельцем', synthetic: 'синтетическое допущение' } as const;
const actionWord = { answer: 'отвечает', missing: 'говорит, что данных нет', clarify: 'уточняет', correct: 'исправляет ответ', change_intent: 'меняет намерение', finish: 'завершает разговор', observe: 'сообщает, что видит' } as const;

function factOriginText(library: ScenarioLibrary, fact: ScenarioVariant['userState']['facts'][number]): string {
  if (fact.origin.kind === 'owner') return `слова владельца: «${fact.origin.text}»`;
  if (fact.origin.kind === 'synthetic') return `синтетическое допущение: ${fact.origin.reason}`;
  return `диалог ${fact.origin.dialogueId}, реплика ${fact.origin.eventIndex}: «${fact.origin.quote}»`;
}

/** Transitions of a behaviour policy as sentences, used by the card and by «было → стало». */
export function behaviorLines(variant: Pick<ScenarioVariant, 'behaviorPolicy'>): string[] {
  return variant.behaviorPolicy.transitions.flatMap(transition => {
    const action = variant.behaviorPolicy.actions.find(item => item.id === transition.actionId);
    return action ? [`${transition.when} ${GLYPH.arrow} клиент ${actionWord[action.kind]}${action.payload ? `: «${action.payload}»` : ''}`] : [];
  });
}

/** One card: who the client is and what is expected first; origins, behaviour, rules and the source dialogue on expand. */
export function variantFeed(record: Experiment, variant: ScenarioVariant, options: { source?: boolean } = {}): Feed {
  const library = record.librarySnapshot!;
  const position = variantNumber(library, variant);
  const rows: Row[] = [
    row(`${position}. ${variant.title} — ${qualityWord[variant.quality]} · ${provenanceWord[variant.provenance]}`, qualityTone[variant.quality], true),
    ...(variant.parentVariantId ? [row(`Вариант карточки «${library.variants.find(item => item.id === variant.parentVariantId)?.title ?? variant.parentVariantId}»: ${variant.mutationReason ?? ''}`, 'muted', false, 1)] : []),
    row(`Клиент пишет: «${variant.userState.opening}»`, undefined, false, 1),
    ...variant.userState.facts.map(fact => row(`${availabilityWord[fact.availability]}: ${fact.statement}`, fact.availability === 'initial' ? undefined : 'warning', false, 1)),
    ...(variant.userState.missing.length ? [row(`Нет данных: ${variant.userState.missing.join('; ')}`, 'warning', false, 1)] : []),
    row(`Ожидается: ${variant.evaluationSpec.successCriteria}`, 'text', true, 1),
    ...ownerRemarks(variant.issues).slice(0, 3).map(item => row(`• ${plainIssue(library, variant, item)}`, item.severity === 'blocked' ? 'error' : 'warning', false, 1)),
  ];
  const more: Row[] = [
    row('Откуда факты', 'accent', true),
    ...(variant.userState.facts.length ? variant.userState.facts.map(fact => row(`${fact.statement} — ${factOriginText(library, fact)}`, 'muted', false, 1)) : [row('Фактов нет.', 'muted', false, 1)]),
    ...(variant.userState.cannotKnow.length ? [row(`Клиент не может знать: ${variant.userState.cannotKnow.join('; ')}`, 'muted', false, 1)] : []),
    blank(), row('Как клиент ведёт себя', 'accent', true), row(`Цель: ${variant.userState.goal}`, undefined, false, 1),
    ...behaviorLines(variant).map(text => row(text, 'muted', false, 1)),
    row(`До ${variant.behaviorPolicy.maxFollowUps} продолжений, повторяет вопрос не больше ${variant.behaviorPolicy.repetitionLimit} раз.`, 'muted', false, 1),
    blank(), row('Что проверяется', 'accent', true),
    ...variant.evaluationSpec.checkpoints.flatMap(item => [row(`${item.role === 'required' ? 'Обязательно' : 'Диагностика'}: ${item.rule}`, undefined, false, 1), row(`Требование владельца: «${item.quote}»`, 'muted', false, 3)]),
    ...(variant.issues.length > 3 ? [blank(), row('Все замечания', 'accent', true), ...variant.issues.map(item => row(`• ${plainIssue(library, variant, item)}`, 'warning', false, 1))] : []),
    ...(library.ownerResolutions?.some(item => item.variantId === variant.id) ? [blank(), row('Решения владельца', 'accent', true),
      ...library.ownerResolutions.filter(item => item.variantId === variant.id).map(item => {
        const finding = library.semanticAssessment?.findings.find(finding => finding.variantId === variant.id && finding.path === item.path);
        const current = finding && item.findingHash === resolutionHash(library, variant, item.path, finding.reason)
          && (!item.businessHash || item.businessHash === resolutionBusinessHash(library, variant));
        const scopeCount = new Set(library.ownerResolutions!.filter(receipt => receipt.editId === item.editId).map(receipt => receipt.variantId)).size;
        return row(`${item.reason}${scopeCount > 1 ? ` · общее решение для ${scopeCount} карточек` : ''}${current ? '' : ' · относится к прежнему содержимому'}`, 'muted', false, 1);
      })] : []),
  ];
  if (options.source) {
    for (const ref of variant.sourceDialogues) {
      const dialogue = library.imports.find(batch => batch.id === ref.batchId)?.dialogues.find(item => item.id === ref.dialogueId);
      more.push(blank(), row(`Исходный диалог ${ref.dialogueId}${dialogue ? '' : ' — в импорте не найден'}`, 'accent', true));
      for (const event of dialogue?.events ?? []) if (event.content) more.push(row(`#${event.index} ${event.role === 'user' ? 'Клиент' : event.role === 'assistant' ? 'Агент' : event.type}: ${event.content}`, event.role === 'user' ? undefined : 'muted', false, 1));
    }
    if (!variant.sourceDialogues.length) more.push(blank(), row('У карточки нет исходного диалога: она построена по требованиям владельца.', 'muted'));
    const cited = variant.userState.facts.filter(fact => fact.origin.kind === 'dialogue');
    rows.push(...(cited.length ? cited.map(fact => row(`Источник: ${factOriginText(library, fact)}`, 'muted', false, 1))
      : [row(variant.sourceDialogues.length ? `Источник: ${variant.sourceDialogues.map(item => item.dialogueId).join(', ')}` : 'Источника нет: карточка по требованиям владельца.', 'muted', false, 1)]));
  }
  return { rows, more };
}

const DIFF_LABEL: Record<string, string> = {
  'userState.opening': 'Первая реплика', 'userState.goal': 'Цель клиента', 'userState.facts': 'Что клиент знает', 'userState.missing': 'Каких данных нет',
  'userState.persona': 'Портрет клиента', behaviorPolicy: 'Поведение клиента', sourceCoverage: 'Учёт исходных реплик', environmentFixture: 'Среда', 'evaluationSpec.successCriteria': 'Ожидаемый результат',
};
function diffValue(path: string, value: unknown): string[] {
  if (value === undefined || value === null) return ['—'];
  if (path === 'userState.facts' && Array.isArray(value)) return value.length ? value.map(fact => String((fact as { statement?: unknown }).statement ?? '')) : ['фактов нет'];
  if (path === 'sourceCoverage' && Array.isArray(value)) return (value as NonNullable<ScenarioVariant['sourceCoverage']>).map(item => `${item.dialogueId}, реплика ${item.eventIndex + 1}: ${item.disposition === 'conditional_action' ? 'ответ по условию' : item.disposition === 'initial_fact' ? 'личный факт' : 'исключена'}; действия: ${item.actionIds.join(', ') || '—'}; факты: ${item.factIds.join(', ') || '—'}; ${item.reason}`);
  if (path === 'behaviorPolicy') return behaviorLines({ behaviorPolicy: value as ScenarioVariant['behaviorPolicy'] });
  if (path === 'environmentFixture') { const failures = (value as { initialState?: { transientFailures?: unknown } }).initialState?.transientFailures; return [failures ? `первые ${failures} записи завершатся временной ошибкой` : 'без сбоев']; }
  if (Array.isArray(value)) return value.length ? value.map(item => String(item)) : ['пусто'];
  return [typeof value === 'object' ? String((value as { text?: unknown }).text ?? JSON.stringify(value)) : String(value)];
}

/** «Было → стало» for every changed field; lists keep only the lines that differ. */
export function changeRows(diff: VariantFieldDiff[]): Row[] {
  // Several steps on one field read as one change: the first «было» and the last «стало».
  const merged = new Map<string, VariantFieldDiff>();
  for (const item of diff) merged.set(item.path, { path: item.path, before: merged.has(item.path) ? merged.get(item.path)!.before : item.before, after: item.after });
  return [...merged.values()].flatMap(item => {
    const before = diffValue(item.path, item.before), after = diffValue(item.path, item.after);
    const removed = before.filter(text => !after.includes(text)), added = after.filter(text => !before.includes(text));
    if (!removed.length && !added.length) return [];
    return [row(DIFF_LABEL[item.path] ?? item.path, 'accent', false, 1),
      ...removed.filter(text => !['пусто', '—'].includes(text)).map(text => row(`было: ${text}`, 'muted', false, 3)), ...added.map(text => row(`стало: ${text}`, 'text', false, 3))];
  });
}

/** Field-level difference between two states of the same card, for owner edits that carry no diff of their own. */
export function variantDiff(before: ScenarioVariant, after: ScenarioVariant): VariantFieldDiff[] {
  const fields: [string, (variant: ScenarioVariant) => unknown][] = [
    ['userState.opening', v => v.userState.opening], ['userState.goal', v => v.userState.goal],
    ['userState.facts', v => v.userState.facts.map(fact => ({ statement: `${fact.statement} (${availabilityWord[fact.availability].toLocaleLowerCase('ru')}; ${originWord[fact.origin.kind]})` }))],
    ['userState.missing', v => v.userState.missing], ['behaviorPolicy', v => v.behaviorPolicy], ['sourceCoverage', v => v.sourceCoverage],
    ['evaluationSpec.successCriteria', v => v.evaluationSpec.successCriteria],
    ['Правила проверки', v => v.evaluationSpec.checkpoints.map(item => item.rule)],
  ];
  return fields.flatMap(([path, read]) => JSON.stringify(read(before)) === JSON.stringify(read(after)) ? [] : [{ path, before: read(before), after: read(after) }]);
}

/** What follows a draft change: the semantic check that ran, or why it needs a new permission. */
export interface CheckOutcome { status: 'done' | 'running' | 'not_needed' | 'needs_budget' | 'skipped' | 'failed'; calls?: number; pendingJobs?: number; remainingCalls?: number; message?: string }
export function checkRow(outcome: CheckOutcome, variant?: ScenarioVariant): Row {
  if (outcome.status === 'done') return row(`Смысл перепроверен (${outcome.calls ?? 0} вызовов модели)${variant ? `: карточка — ${qualityWord[variant.quality]}` : ''}.`, variant && variant.quality !== 'ready' ? 'warning' : 'success', false, 1);
  if (outcome.status === 'running') return row(`Правка сохранена. Смысл перепроверяю в фоне (до ${outcome.pendingJobs ?? 0} вызовов модели) и сообщу итог; можно продолжать.`, 'muted', false, 1);
  if (outcome.status === 'needs_budget') return row(`Смысловая проверка не запущена: нужно ${outcome.pendingJobs} вызовов, в согласованном лимите осталось ${outcome.remainingCalls}. Нужно ваше разрешение увеличить лимит.`, 'warning', false, 1);
  if (outcome.status === 'failed') return row(`Смысловая проверка не завершилась: ${outcome.message ?? 'ошибка'}. Правка сохранена.`, 'warning', false, 1);
  if (outcome.status === 'skipped') return row('Смысловая проверка отложена до конца серии правок.', 'muted', false, 1);
  return row('Дополнительная смысловая проверка не нужна.', 'muted', false, 1);
}

export const targetText = (record: Experiment): string => record.target.kind === 'sandbox' ? 'учебная песочница' : record.target.kind === 'http' ? record.target.url
  : record.target.kind === 'module' ? record.target.path : [record.target.command, ...record.target.args].join(' ');

/** A path inside the project reads relative to it; anything else stays as written. */
const projectPath = (text: string, cwd?: string): string => cwd && text.includes(`${cwd}/`) ? text.replaceAll(`${cwd}/`, '') : text;

/** The plan a run confirmation refers to: agent and version, the set, attempts, models and spending limits. */
export function planLines(record: Experiment, cwd?: string): string[] {
  const library = record.librarySnapshot;
  const acceptance = library?.acceptance;
  // A repeat of chosen cards runs a part of the accepted revision; the plan counts what will actually run.
  const chosen = record.selectedScenarioIds;
  const variants = acceptance ? acceptance.variantIds.filter(id => !chosen || chosen.includes(id)).map(id => library!.variants.find(variant => variant.id === id)).filter((variant): variant is ScenarioVariant => !!variant) : [];
  const part = acceptance && variants.length !== acceptance.variantIds.length ? ` из ${acceptance.variantIds.length}` : '';
  const origin = (['production', 'curated', 'synthetic'] as const).map(kind => ({ kind, n: acceptance ? variants.filter(variant => variant.provenance === kind).length : record.scenarios.filter(scenario => scenario.provenance === kind).length }))
    .filter(item => item.n).map(item => `${item.n} ${provenanceWord[item.kind]}`).join(', ');
  // The same precedence the runtime applies (pi.ts role choice, normalize.ts judge): a role override, then the judge setting, then the common model.
  const common = { provider: record.settings.provider, model: record.settings.model };
  const simulator = record.settings.roles?.simulator ?? common;
  const judge = record.settings.roles?.judge ?? record.settings.judge ?? common;
  return [
    `Агент: ${projectPath(targetText(record), cwd)}${record.targetVersion ? ` · версия ${record.targetVersion}` : ''}`,
    acceptance ? `Набор: принятая ревизия ${acceptance.revision}, ${count(variants.length, VARIANTS)}${part}${origin ? ` (${origin})` : ''}`
      : `Набор: ${count(record.scenarios.length, ['ситуация', 'ситуации', 'ситуаций'])}${origin ? ` (${origin})` : ''}`,
    `Попыток: ${plannedTrials(record)} (повторов ${record.settings.repeats}, режим клиента: ${record.settings.userModes.join(', ')})`,
    record.mode === 'demo' ? 'Учебный пример: без модели и оплаты.'
      : `Модели: клиента играет ${simulator.provider}/${simulator.model}; судья — ${judge.provider}/${judge.model}`,
    `Лимиты: использовано ${record.usage.calls} из ${record.settings.maxCalls} вызовов, до ${Math.round(record.settings.maxDurationMs / 60_000)} мин, до ${record.settings.maxTurns} ходов в диалоге. Стоимость заранее неизвестна.`,
  ];
}

/** How many definitions one native dialog holds; a larger set is paged, never cut down to titles. */
export const ACCEPTANCE_PAGE = 8;
/**
 * What the owner accepts: for every given card the client's first message and the expected result, not a list of titles.
 * It says nothing about cards it was not given: what else was or was not shown is known only to the dialog that pages them.
 */
export function acceptanceLines(library: ScenarioLibrary, cards: ScenarioVariant[]): string[] {
  return cards.flatMap(variant => [`${variantNumber(library, variant)}. ${variant.title}`,
    `   Клиент пишет: «${clip(variant.userState.opening, 200)}»`,
    ...(variant.userState.missing.length ? [`   Клиент не знает: ${clip(variant.userState.missing.join('; '), 160)}`] : []),
    `   Ожидается: ${clip(variant.evaluationSpec.successCriteria, 260)}`]);
}

/** Progress from the stored record only: finished, planned, unusable attempts and spending. Nothing is estimated. */
export function progressLines(record: Experiment): string[] {
  const planned = plannedTrials(record), done = record.trials.length;
  const unusable = record.trials.filter(trial => trial.outcome === 'invalid' || trial.outcome === 'cancelled').length;
  const cost = record.mode === 'demo' ? 'без оплаты' : record.usage.costUsd === null ? 'стоимость неизвестна' : `$${record.usage.costUsd.toFixed(3)} (оценка)`;
  if (record.phase === 'preparing') return [`Подготовка ${shortId(record.id)} · вызовов модели ${record.usage.calls} из ${record.settings.maxCalls}`, clip(record.message, 160)];
  return [`Прогон ${shortId(record.id)} · ${done} из ${planned} диалогов завершено${unusable ? ` · непригодных ${unusable}` : ''} · вызовов ${record.usage.calls} из ${record.settings.maxCalls} · ${cost}`,
    ...(record.message ? [clip(record.message, 160)] : [])];
}

/** After a stop or an interruption: what is kept and what has to be run again. */
export function stoppedLines(record: Experiment): string[] {
  const planned = plannedTrials(record), done = record.trials.length;
  return [`Прогон ${shortId(record.id)} остановлен: сохранено ${done} из ${planned} диалогов. Сохранённые диалоги и оценки можно смотреть.`,
    'Продолжить этот прогон с места остановки нельзя. «Повтори набор» создаст новый черновик тех же карточек; в нём все попытки выполняются заново.'];
}

/** The run list of `agent_lab_status`: newest first, one row per run. */
export function statusFeed(records: Experiment[], active?: { id: string }): Feed {
  if (!records.length) return { rows: [row('Прогонов пока нет. Скажите, какого агента проверить и где лежат логи.', 'muted')] };
  const sorted = [...records].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const line = (record: Experiment): Row => {
    const library = record.librarySnapshot;
    const size = library ? count(library.variants.length, VARIANTS) : count(record.scenarios.length, ['ситуация', 'ситуации', 'ситуаций']);
    const tail = record.trials.length ? ` · ${record.trials.length} из ${plannedTrials(record)} диалогов` : library?.acceptance ? ' · набор принят' : '';
    // A repeat is named by the run it repeats, so a chain of reruns of one set does not print the same task five times.
    const about = record.parentRunId ? `повтор ${shortId(record.parentRunId)}${record.targetVersion ? ` · версия ${clip(record.targetVersion, 30)}` : ''}` : clip(record.task, 70);
    return row(`${shortId(record.id)} · ${phaseWord[record.phase] ?? record.phase}${record.id === active?.id ? ' (в этой сессии)' : ''} · ${size}${tail} · ${about}`,
      record.id === active?.id ? 'accent' : record.phase === 'error' ? 'error' : undefined, false, 1);
  };
  return { rows: [row(`Прогонов: ${records.length}`, 'text', true), ...sorted.slice(0, 5).map(line), ...(sorted.length > 5 ? [row(`…и ещё ${sorted.length - 5}`, 'muted', false, 1)] : [])], more: sorted.slice(5, 40).map(line) };
}

const ROLE_WORD: Record<string, string> = { user: 'Клиент', assistant: 'Агент', simulator: 'Симулятор', observation: 'Наблюдение', retrieval: 'Контекст RAG', tool_call: 'Вызов', tool_result: 'Результат', error: 'Ошибка' };
const OUTCOME_WORD: Record<string, string> = { pass: 'справился', fail: 'не справился', unknown: 'неясно', invalid: 'тест непригоден', cancelled: 'остановлен', ungraded: 'без итоговой оценки' };

/** One failed situation: what was expected, what the agent said, which owner rule — then the dialogue; full trace on expand. */
export function failureFeed(record: Experiment, view: ResultView, index: number): Feed | null {
  const failure = view.failures[index];
  if (!failure) return null;
  const trial = record.trials.find(item => item.id === failure.trialId);
  const rows: Row[] = [row(`Провал ${index + 1} из ${view.failures.length}: ${failure.title}`, 'error', true),
    ...failure.rows.filter(item => item.role !== 'title').map(item => row(item.text, item.role === 'unverified' ? 'warning' : item.role === 'rule' || item.role === 'more' || item.role === 'violated' ? 'muted' : undefined, false, 1 + item.indent))];
  if (!trial) return { rows };
  const dialogue = dialogueFeed(record, trial);
  return { rows: [...rows, blank(), ...dialogue.rows.slice(1)], more: dialogue.more };
}

/** A recorded dialogue: client and agent turns in the feed; tool calls, checks and the judge's reasons on expand. */
export function dialogueFeed(record: Experiment, trial: Trial): Feed {
  const scenario = record.scenarios.find(item => item.id === trial.scenarioId);
  const rows: Row[] = [row(`${scenario?.title ?? trial.scenarioId} — ${OUTCOME_WORD[trial.outcome] ?? trial.outcome} · попытка ${trial.repeat + 1}`, trial.outcome === 'pass' ? 'success' : trial.outcome === 'fail' ? 'error' : 'warning', true)];
  for (const event of trial.events) if (['user', 'assistant', 'error'].includes(event.type) && event.text !== undefined) {
    rows.push(row(`#${event.seq} ${ROLE_WORD[event.type]}: ${event.text}`, event.type === 'user' ? 'accent' : event.type === 'error' ? 'error' : undefined, false, 1));
  }
  if (trial.outcome === 'invalid' || trial.outcome === 'cancelled') rows.push(row(`Почему не измерено: ${trial.reason}`, 'warning', false, 1));
  const more: Row[] = [row('Решение судьи', 'accent', true)];
  for (const metric of scenario?.metrics ?? []) {
    const assessment = trial.assessments?.find(item => item.metricId === metric.id);
    more.push(row(`${metric.name}: ${assessment ? OUTCOME_WORD[assessment.result] ?? assessment.result : 'оценки нет'}`, assessment?.result === 'fail' ? 'error' : assessment?.result === 'pass' ? 'success' : 'warning', false, 1),
      ...(assessment ? [row(`${assessment.rationale}${assessment.evidence.length ? ` (реплики ${assessment.evidence.map(seq => `#${seq}`).join(', ')})` : ''}`, 'muted', false, 3)] : []));
  }
  for (const check of trial.checks) more.push(row(`${check.passed ? GLYPH.pass : GLYPH.fail} ${check.description}`, check.passed ? 'success' : 'error', false, 1), row(check.evidence, 'muted', false, 3));
  const hidden = trial.events.filter(event => !['user', 'assistant', 'error'].includes(event.type));
  if (hidden.length) more.push(blank(), row('Инструменты и наблюдения', 'accent', true), ...hidden.map(event =>
    row(`#${event.seq} ${ROLE_WORD[event.type] ?? event.type}${event.tool ? ` ${event.tool}` : ''}: ${clip(event.text ?? JSON.stringify(event.args ?? event.result ?? event.state ?? ''), 400)}`, 'muted', false, 1)));
  const human = (record.humanReviews ?? []).filter(item => item.trialId === trial.id);
  if (human.length) more.push(blank(), row('Отметки человека', 'accent', true), ...human.map(item => row(`${OUTCOME_WORD[item.verdict] ?? item.verdict}: ${item.note}`, undefined, false, 1)));
  return { rows, more };
}

/** Before/after of a repeat: what was fixed, what broke, and how much of the set could be compared at all. */
export function comparisonFeed(comparison: RunComparison, beforeId: string): Feed {
  const coverage = comparison.coverage;
  const rows: Row[] = [row(`Сравнение с прогоном ${shortId(beforeId)}: ${comparison.headline}`, comparison.comparable ? 'text' : 'warning', true),
    row(`Сопоставлено пар: ${coverage.validPairs} из ${coverage.plannedPairs}${coverage.excludedPairs ? ` · исключено ${coverage.excludedPairs}` : ''}`, 'muted', false, 1),
    ...comparison.fixed.map(item => row(`+ исправлено: ${item.title}`, 'success', false, 1)),
    ...comparison.regressed.map(item => row(`- сломалось: ${item.title}`, 'error', false, 1)),
    row(`Без изменений: проходят ${comparison.unchanged.passing}, не проходят ${comparison.unchanged.failing}`, 'muted', false, 1)];
  const more = [...comparison.incomparable.map(item => row(`/ несравнимо: ${item.title} — ${item.reason}`, 'warning', false, 1)), ...comparison.notes.map(note => row(note, 'muted', false, 1))];
  return { rows, ...(more.length ? { more } : {}) };
}

/** Semantic work still owed by a library and whether the agreed budget covers it. */
export function semanticDebt(record: Experiment, library: ScenarioLibrary): { pendingJobs: number; remainingCalls: number; needsFinalization: boolean } {
  const { pendingJobs, needsFinalization } = semanticWorkStatus(library);
  return { pendingJobs, needsFinalization, remainingCalls: Math.max(0, record.settings.maxCalls - record.usage.calls) };
}
