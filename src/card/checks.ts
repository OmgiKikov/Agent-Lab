import type { Requirement, Source } from '../contracts.js';
import { countText } from '../plural.js';
import { maskedSpans, withValues, type MaskedSpan } from '../masking.js';
import type { ImportBatch } from '../scenario-contracts.js';
import { clip } from '../text.js';
import { requiredUserTurns } from '../user-controller.js';
import { compilePolicy } from './compile.js';
import type { Card, EventRef, Filled } from './schema.js';

/*
 * The deterministic checks of a card (docs/design/card-v2-spec.md §2.4): references and exact text, never meaning. A value is in a
 * message when the message contains it as whole words after one normalisation — NFKC, Russian lower case, every run
 * of spaces as one — with no tokenizer, no fuzzy quote search and no regular expression over what people or models
 * wrote. Whether a fact is really the customer's or a rule really applies is the reviewer's claim (review.ts); these
 * rules only hold a reference or a value to what it promises.
 */

/** A message of an imported dialogue as a card may cite it: the customer's or the agent's, by its import index. */
export interface LoggedMessage { index: number; role: 'user' | 'assistant'; content: string }

/** The customer's and the agent's messages of one imported dialogue. Tool, retrieval and system events are never a card's evidence. */
export function loggedMessages(dialogue: ImportBatch['dialogues'][number]): LoggedMessage[] {
  return dialogue.events.flatMap(event => event.type === 'message' && (event.role === 'user' || event.role === 'assistant') && event.content !== undefined
    ? [{ index: event.index, role: event.role, content: event.content }] : []);
}

/** Where a card's references are read: the immutable import batches in the store. */
export interface CardEvidence { messages(batchId: string, dialogueId: string): readonly LoggedMessage[] | undefined }

export function importEvidence(batches: readonly ImportBatch[]): CardEvidence {
  const dialogues = new Map(batches.flatMap(batch => batch.dialogues.map(dialogue => [`${batch.id}/${dialogue.id}`, loggedMessages(dialogue)] as const)));
  return { messages: (batchId, dialogueId) => dialogues.get(`${batchId}/${dialogueId}`) };
}

/** The text of the message a reference points at; undefined when the import holds no such message. */
export const messageAt = (evidence: CardEvidence, event: EventRef): string | undefined =>
  evidence.messages(event.batchId, event.dialogueId)?.find(message => message.index === event.eventIndex)?.content;

export const sameEvent = (a: EventRef, b: EventRef): boolean => a.batchId === b.batchId && a.dialogueId === b.dialogueId && a.eventIndex === b.eventIndex;

/**
 * The mark a value Lab wrote in stands over: the `span`-th (from 0) of its message as the table of marks the fill counted
 * by reads it (masking.ts) — version 1 for a fill that names none, as every fill written before the table. A table reads
 * a message's marks anew, so a fill is read by its own: its value stays where it was written.
 */
export const filledSpan = (content: string, fill: Pick<Filled, 'span' | 'maskVersion'>): MaskedSpan | undefined =>
  maskedSpans(content, fill.maskVersion ?? 1)[fill.span];

/** A logged message as the card reads it: the values Lab wrote over its masking marks (card/unmask.ts), each over its own mark. */
export function filledMessage(content: string, filled: Card['filled'], event: EventRef): string {
  const values = (filled ?? []).filter(item => sameEvent(item.event, event)).flatMap(item => {
    const span = filledSpan(content, item);
    return span ? [{ ...span, value: item.value }] : [];
  });
  return values.length ? withValues(content, values) : content;
}

/** The message a card's reference points at, as the card reads it; undefined when the import holds no such message. */
export function cardMessage(card: Pick<Card, 'filled'>, evidence: CardEvidence, event: EventRef): string | undefined {
  const content = messageAt(evidence, event);
  return content === undefined ? undefined : filledMessage(content, card.filled, event);
}

/** The one form two texts are compared in. */
export function normalizeText(value: string): string {
  const words: string[] = [];
  let word = '';
  for (const char of value.normalize('NFKC').toLocaleLowerCase('ru')) {
    // trim() knows every Unicode space and line break: a character it empties is whitespace.
    if (char.trim()) word += char;
    else if (word) { words.push(word); word = ''; }
  }
  if (word) words.push(word);
  return words.join(' ');
}

/** A character of a word: a letter of a cased script or a digit (the normalisation has folded full-width digits already). */
const wordChar = (char: string | undefined): boolean => char !== undefined && (char.toLocaleLowerCase('ru') !== char.toLocaleUpperCase('ru') || (char >= '0' && char <= '9'));

/**
 * Whether `text` holds `value` as whole words, up to NFKC, case and spacing: «5678» is in «Номер  5678.», not in «15678»;
 * «3» is not in «Терминал 34567», and «56 78» is not in «5678». A value that is a piece of a longer word or number is
 * another value: a fact is never found in a message only because its characters happen to be part of something else
 * there. An empty value is in no text.
 */
export function contains(text: string, value: string | number): boolean {
  const said = normalizeText(text), words = normalizeText(String(value));
  if (!words) return false;
  for (let at = said.indexOf(words); at >= 0; at = said.indexOf(words, at + 1)) {
    const cutBefore = wordChar(said[at - 1]) && wordChar(words[0]);
    const cutAfter = wordChar(said[at + words.length]) && wordChar(words.at(-1));
    if (!cutBefore && !cutAfter) return true;
  }
  return false;
}

type Fact = Card['client']['knows'][number];
/** A value that can stand in a message: text or a number. A yes/no fact is qualitative — its label says it all. */
export const quotable = (value: Fact['value']): value is string | number => typeof value === 'string' || typeof value === 'number';

/** The longest value a plausible fact may carry: a word or a short phrase from a small closed set («POS-терминал», «заявка подана»). */
export const PLAUSIBLE_VALUE_WORDS = 4;

/**
 * Whether a plausible fact's value has the shape of a quality rather than a record: yes/no, or a short phrase with no
 * digit in it. A number, a code, an amount or a date is a value the agent looks up, and no log vouches for it, so a
 * customer who «knows» one would be invented data. The rule reads the value's shape (its characters and its words
 * after the one normalisation), never its meaning.
 */
export function plausibleShape(value: Fact['value']): boolean {
  if (value === undefined || typeof value === 'boolean') return true;
  if (typeof value === 'number') return false;
  const normal = normalizeText(value);
  return normal.length > 0 && normal.split(' ').length <= PLAUSIBLE_VALUE_WORDS && ![...normal].some(char => char >= '0' && char <= '9');
}

/** Why a card's account of the later customer messages does not add up. */
export type CoverageProblem = 'no_fact' | 'no_turn' | 'turn_uncovered' | 'second_stop' | 'ignored_source' | 'before_opening';

export type CheckFinding =
  /** A fact's value is not in the message it cites. */
  | { check: 'fact-from-event'; factId: string }
  /** A fact named at once is not in the opening. */
  | { check: 'initial-in-opening'; factId: string }
  /** A fact named on request, or not known, is already in the opening. */
  | { check: 'hidden-not-in-opening'; factId: string }
  /** A value the customer does not know is in their later words. */
  | { check: 'unknown-never-said'; factId: string; where: 'turn' | 'leaves' }
  /** A plausible fact carries a number, a code or a long text: a value only a record could vouch for. */
  | { check: 'plausible-value'; factId: string }
  | { check: 'coverage-refs'; eventIndex: number; problem: CoverageProblem }
  /** An expectation cites a rule that is not in the materials word for word. */
  | { check: 'requirements-grounded'; requirementId: string }
  /** The customer's policy does not build (`needed` null) or needs more messages than a run allows. */
  | { check: 'controller-compiles'; needed: number | null }
  /**
   * A masking mark of the log is still where the customer wrote a value — in the opening, the turn or a fact's value:
   * the agent would read words no customer wrote. Lab writes plausible values in (card/unmask.ts); this is what is left
   * when it could not.
   */
  | { check: 'masked-opening' }
  | { check: 'masked-turn' }
  | { check: 'masked-fact'; factId: string };

export interface CheckContext {
  evidence: CardEvidence;
  /** A run's limit on the customer's messages, the opening included. */
  maxTurns: number;
  /** The rules and materials expectations cite; absent while a proposal is repaired, whose quotes are found verbatim before it binds. */
  materials?: { requirements: readonly Pick<Requirement, 'id' | 'sourceId' | 'quote'>[]; sources: readonly Pick<Source, 'id' | 'content'>[] };
}

function factFindings(card: Card, evidence: CardEvidence): CheckFinding[] {
  const { writes, writesSource, turn, leaves } = card.client;
  return card.client.knows.flatMap(fact => {
    const found: CheckFinding[] = [];
    const value = quotable(fact.value) ? fact.value : undefined;
    const source = fact.source;
    if (value !== undefined && source.kind === 'dialogue') {
      const message = cardMessage(card, evidence, source.event);
      if (message === undefined || !contains(message, value)) found.push({ check: 'fact-from-event', factId: fact.id });
    }
    if (fact.disclosure === 'initial') {
      // Said at once: in the opening message itself, or — for the owner's words or an opening that is not a logged message — in its text.
      const said = source.kind === 'unconfirmed' ? false
        : source.kind === 'dialogue' && writesSource.kind === 'dialogue' ? sameEvent(source.event, writesSource.event)
        : value === undefined || contains(writes, value);
      if (!said) found.push({ check: 'initial-in-opening', factId: fact.id });
    } else if (value !== undefined && contains(writes, value)) found.push({ check: 'hidden-not-in-opening', factId: fact.id });
    if (source.kind === 'plausible' && !plausibleShape(fact.value)) found.push({ check: 'plausible-value', factId: fact.id });
    if (typeof fact.value === 'string' && maskedSpans(fact.value).length) found.push({ check: 'masked-fact', factId: fact.id });
    if (fact.disclosure === 'unknown' && value !== undefined) {
      if (turn && contains(turn.says, value)) found.push({ check: 'unknown-never-said', factId: fact.id, where: 'turn' });
      if (contains(leaves, value)) found.push({ check: 'unknown-never-said', factId: fact.id, where: 'leaves' });
    }
    return found;
  });
}

/**
 * Every later customer message is accounted for exactly once: a message a fact or the turn comes from is never
 * ignored, a «fact» or «turn» points at a real one, the customer stops once, and what came before the opening
 * (a greeting, say) is ignored or only lends a fact. A message replaced by a similar card's change is skipped.
 */
function coverageFindings(card: Card): CheckFinding[] {
  type Sourced = Card['client']['writesSource'] | Fact['source'] | NonNullable<Card['client']['turn']>['source'];
  const eventIndex = (source: Sourced) => source.kind === 'dialogue' ? source.event.eventIndex : undefined;
  const opening = eventIndex(card.client.writesSource);
  const facts = new Set(card.client.knows.flatMap(fact => eventIndex(fact.source) ?? []));
  const turn = card.client.turn && eventIndex(card.client.turn.source);
  const found: CheckFinding[] = [];
  let stops = 0;
  for (const { event, as } of card.coverage) {
    const add = (problem: CoverageProblem) => found.push({ check: 'coverage-refs', eventIndex: event.eventIndex, problem });
    if (as === 'changed') continue;
    if (opening !== undefined && event.eventIndex < opening && as !== 'ignored' && as !== 'fact') add('before_opening');
    else if (as === 'fact' && !facts.has(event.eventIndex)) add('no_fact');
    else if (as === 'turn' && turn !== event.eventIndex) add('no_turn');
    else if (as === 'stop' && ++stops > 1) add('second_stop');
    else if (as === 'ignored' && (facts.has(event.eventIndex) || turn === event.eventIndex)) add('ignored_source');
  }
  if (turn !== undefined && !card.coverage.some(entry => entry.event.eventIndex === turn && entry.as === 'turn')) {
    found.push({ check: 'coverage-refs', eventIndex: turn, problem: 'turn_uncovered' });
  }
  return found;
}

function requirementFindings(card: Card, materials: NonNullable<CheckContext['materials']>): CheckFinding[] {
  const cited = [...new Set(card.agentMust.flatMap(expectation => expectation.requirementIds))];
  return cited.flatMap((requirementId): CheckFinding[] => {
    const requirement = materials.requirements.find(item => item.id === requirementId);
    const source = requirement && materials.sources.find(item => item.id === requirement.sourceId);
    return source && requirement && source.content.includes(requirement.quote) ? [] : [{ check: 'requirements-grounded', requirementId }];
  });
}

/** The compiled policy must build and leave the customer a finite way to the end within the run's messages. */
function controllerFindings(card: Card, maxTurns: number): CheckFinding[] {
  let needed: number;
  try {
    const { policy, facts } = compilePolicy(card, maxTurns);
    needed = requiredUserTurns(policy, facts);
  } catch { return [{ check: 'controller-compiles', needed: null }]; } // the controller names what is wrong with a policy only by throwing
  return needed > maxTurns ? [{ check: 'controller-compiles', needed }] : [];
}

/** The masking marks left in what the customer says. */
function maskFindings(card: Card): CheckFinding[] {
  const { writes, turn } = card.client;
  return [...(maskedSpans(writes).length ? [{ check: 'masked-opening' } as const] : []), ...(turn && maskedSpans(turn.says).length ? [{ check: 'masked-turn' } as const] : [])];
}

/** Every deterministic finding on a card, in the order of the brief: what the customer says, facts, coverage, rules, the customer's policy. */
export function cardFindings(card: Card, context: CheckContext): CheckFinding[] {
  return [...maskFindings(card), ...factFindings(card, context.evidence), ...coverageFindings(card),
    ...(context.materials ? requirementFindings(card, context.materials) : []), ...controllerFindings(card, context.maxTurns)];
}

/**
 * The findings that make a stored card unusable for a test. A coverage slip is only ever repaired while the model
 * writes the card; after that the owner's commands keep the account and the reviewer judges its meaning.
 */
export const unusableFindings = (card: Card, context: CheckContext): CheckFinding[] =>
  cardFindings(card, context).filter(finding => finding.check !== 'coverage-refs');

/** The fix of a masking mark left in a card: Lab's plausible values, or the owner's own. */
const UNMASK_HINT = 'Lab подставит правдоподобные значения, если вы скажете, — или впишите свои.';

/** What a finding means for the owner, in their words. */
export function problemText(finding: CheckFinding, card: Card, requirements: readonly Pick<Requirement, 'id' | 'quote'>[] = []): string {
  const fact = 'factId' in finding ? card.client.knows.find(item => item.id === finding.factId) : undefined;
  const label = clip(fact?.label ?? '', 80);
  switch (finding.check) {
    case 'fact-from-event': return `«${fact && quotable(fact.value) ? clip(`${fact.label}: ${fact.value}`, 120) : label}» нет в реплике клиента, откуда взят этот факт.`;
    case 'initial-in-opening': return `«${label}» клиент называет сразу, но в первой реплике этого нет.`;
    case 'hidden-not-in-opening': return fact?.disclosure === 'unknown' ? `Клиент не знает «${label}», но это уже есть в первой реплике.`
      : `«${label}» клиент называет, только если спросят, но это уже есть в первой реплике.`;
    case 'unknown-never-said': return `Клиент не знает «${label}», но это звучит в его словах.`;
    case 'plausible-value': return `«${label}» — правдоподобный факт, но в нём число или длинный текст: такое клиент знает только из записей, а их нет.`;
    case 'masked-opening': return `В первой реплике клиента вместо значений знаки обезличивания: агент получил бы слова, которых не писал ни один клиент. ${UNMASK_HINT}`;
    case 'masked-turn': return `В поздней реплике клиента вместо значений знаки обезличивания. ${UNMASK_HINT}`;
    case 'masked-fact': return `«${label}» — вместо значения знаки обезличивания. ${UNMASK_HINT}`;
    case 'coverage-refs': return 'Поздние реплики клиента учтены с ошибкой.';
    case 'requirements-grounded': {
      const quote = requirements.find(item => item.id === finding.requirementId)?.quote;
      return quote ? `Правила «${clip(quote, 80)}» нет в ваших материалах.` : 'Ожидание ссылается на правило, которого нет в наборе.';
    }
    case 'controller-compiles': return finding.needed === null ? 'Поведение клиента в этой ситуации не складывается в разговор.'
      : `Клиенту нужно ${countText(finding.needed, ['реплика', 'реплики', 'реплик'])}, чтобы пройти ситуацию, а в прогоне их меньше.`;
  }
}
