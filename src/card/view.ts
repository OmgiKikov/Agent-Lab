import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { describeCheck, isCardExecution, type Experiment, type Scenario } from '../contracts.js';
import { countText } from '../plural.js';
import { MAX_WIDTH, type Reader } from '../result-text.js';
import type { ImportBatch, LibraryV1, ScenarioVariant } from '../scenario-contracts.js';
import { oneLine } from '../text.js';
import { contains, quotable, type CardEvidence } from './checks.js';
import { compilePolicy, expectationLetter } from './compile.js';
import { behaviorLines, convertible, libraryV1Of, orderedVariants, ownerQuestions, ownerRemarks, plainIssue } from './legacy-v1.js';
import type { Card, LibraryV2 } from './schema.js';
import { cardStatuses, type CardStatus, type CardStatusKind, type QuestionChoice } from './status.js';

/*
 * A situation as the owner reads it (docs/design/ui-spec.md §3), one projection for every stored format, drawn the same
 * way in the chat, on the board, in the CLI and in the customer report:
 *
 *   card      (the card format)            ──┐
 *   variant   (the first library format)   ──┼──► SituationView ──► list rows (three lines) · brief rows · «d» rows
 *   scenario  (a record made before both)  ──┘                  └──► the Brief of the customer report
 *
 * The brief has three parts: the title and where the situation came from; the customer — what they want,
 * what they write first, what they know and when they say it, when they leave, their late turn; what the
 * agent must do, each duty with the owner's rule. Next to it: the status, the one open question and why a
 * situation cannot be a test. Everything technical waits behind «d». Pure: nothing here reads the store
 * or calls a model; each surface paints the rows by role and escapes at its own boundary.
 */

/**
 * When the customer says a fact: at once, when asked, never, or «?» — nobody has confirmed it yet. A plausible fact
 * is never shown as the log's: «? правдоподобно» until the owner decides its label, «правдоподобно, если спросят» after.
 */
export type Said = 'сразу' | 'если спросят' | 'не знает' | '?' | '? правдоподобно' | 'правдоподобно, если спросят';

export interface Brief {
  title: string;
  /** «из диалога №17», «из разговора в логах», «похожая на №3», «по вашим правилам», «добавлена вами». */
  source: string;
  wants: string;
  writes: string;
  knows: { what: string; when: Said }[];
  leaves: string | null;
  /** The customer's late move: «после «…»: «…»»; null when the situation has none. */
  turn: string | null;
  must: { text: string; rule: string | null }[];
  /** The values Lab wrote over the log's masking marks, when it did: «подставлено вместо обезличенного». */
  filled?: string[];
  /** The customer never says clearly what they want («невнятный запрос»): the result counts such situations apart. */
  vague?: true;
}

export interface SituationView {
  /** What is stored: a card, a variant of the first library format, a scenario of a record made before libraries. */
  format: 'card' | 'variant' | 'scenario';
  id: string;
  /** «№3»: a card's own number, never given twice; the place in the list for the older formats. */
  number: number;
  brief: Brief;
  /** The ids a command names, parallel to `brief.knows` and `brief.must` (f1, e2); null where there is none to name. */
  refs: { knows: (string | null)[]; must: (string | null)[] };
  /**
   * A card's terms the brief does not print but a change can move, parallel to `refs`: every rule of a duty, when it
   * applies and how it is observed; the agent's question a fact answers (its label unless the card names another); what
   * the customer's late turn does. «Было → стало» compares them, so a change the owner confirms is never shown as none.
   */
  terms?: { must: DutyTerms[]; knows: { askedAs: string }[]; turn: string | null };
  status: CardStatusKind;
  /** The one open question. A card's answers carry their ready-made commands; an older format's question has no answers here. */
  question?: { id: string | null; text: string; choices: QuestionChoice[] };
  /** Why it cannot be a test (✗), in the owner's words. */
  problems: string[];
  /** The situation's own version, named from 2 on («версия 2»). */
  version?: number;
  topic?: string;
  /** «d — как это проверяется»: key and value lines for whoever wants to see how the brief is run and judged. */
  details: { label: string; text: string }[];
}

/** A duty's terms: every rule it rests on (id and quote), the condition it applies under (null: always), how it is observed. */
export interface DutyTerms { rules: { id: string; quote: string }[]; when: string | null; observed: string }

/** Where each logged dialogue stands in its import: «из диалога №17». */
export type DialogueNumbers = (batchId: string, dialogueId: string) => number | undefined;

export function dialogueNumbers(batches: readonly Pick<ImportBatch, 'id' | 'dialogues'>[]): DialogueNumbers {
  const numbers = new Map(batches.flatMap(batch => batch.dialogues.map((dialogue, index) => [`${batch.id}/${dialogue.id}`, index + 1] as const)));
  return (batchId, dialogueId) => numbers.get(`${batchId}/${dialogueId}`);
}

const SAID = { initial: 'сразу', on_request: 'если спросят', unknown: 'не знает' } as const satisfies Record<Card['client']['knows'][number]['disclosure'], Said>;
const turnText = (after: string, says: string): string => `после «${oneLine(after)}»: «${oneLine(says)}»`;
const firstQuote = (ids: readonly string[], quotes: ReadonlyMap<string, string>): string | null => {
  const quote = ids.map(id => quotes.get(id)).find(item => item !== undefined);
  return quote === undefined ? null : oneLine(quote) || null;
};

/* ───────────────────────────── the card format ───────────────────────────── */

type Fact = Card['client']['knows'][number];
/** A fact in the brief: its label and value, a yes/no in words; a value the customer does not know is not theirs to state. */
function factText(fact: Fact): string {
  if (fact.value === undefined || fact.disclosure === 'unknown') return oneLine(fact.label);
  return oneLine(`${fact.label}: ${quotable(fact.value) ? fact.value : fact.value ? 'да' : 'нет'}`);
}

/** A situation the owner made, as the owner reads its source and as a page for others says it about the owner. */
const OWNER_MADE: Record<Reader, { added: string; rules: string }> = {
  owner: { added: 'добавлена вами', rules: 'по вашим правилам' },
  others: { added: 'добавлена владельцем агента', rules: 'по правилам владельца агента' },
};

function cardSource(library: LibraryV2, card: Card, numbers?: DialogueNumbers, reader: Reader = 'owner'): string {
  const { origin } = card;
  switch (origin.kind) {
    case 'dialogue': {
      const number = numbers?.(origin.batchId, origin.dialogueId);
      return number === undefined ? 'из разговора в логах' : `из диалога №${number}`;
    }
    case 'similar': {
      const parent = library.cards.find(item => item.id === origin.parentId);
      return parent ? `похожая на №${parent.number}` : 'похожая на другую ситуацию';
    }
    case 'owner': return OWNER_MADE[reader].added;
    case 'rules': return OWNER_MADE[reader].rules;
  }
}

/** When the brief says the customer names a fact, and who vouches for it being theirs. */
function saidOf(fact: Fact): Said {
  const { source } = fact;
  if (source.kind === 'unconfirmed') return '?';
  if (source.kind === 'plausible') return source.receiptId === undefined ? '? правдоподобно' : 'правдоподобно, если спросят';
  return SAID[fact.disclosure];
}

/** A card read as it stands: its brief is the card itself. A fact no message vouches for is «?» until the owner says. */
export function cardBrief(library: LibraryV2, card: Card, numbers?: DialogueNumbers, reader: Reader = 'owner'): Brief {
  const quotes = new Map(library.requirements.map(item => [item.id, item.quote]));
  const { wants, writes, knows, leaves, turn } = card.client;
  return {
    title: oneLine(card.title), source: cardSource(library, card, numbers, reader), wants: oneLine(wants), writes: oneLine(writes),
    knows: knows.map(fact => ({ what: factText(fact), when: saidOf(fact) })),
    leaves: oneLine(leaves), turn: turn ? turnText(turn.after, turn.says) : null,
    must: card.agentMust.map(expectation => ({ text: oneLine(expectation.text), rule: firstQuote(expectation.requirementIds, quotes) })),
    ...(card.filled ? { filled: card.filled.map(item => oneLine(item.value)) } : {}),
    ...(card.clarity === 'vague' ? { vague: true } : {}),
  };
}

/** The customer's request as the brief and a change name it: the mark of a vague one, and the word for a clear one. */
const VAGUE_REQUEST = 'невнятный: клиент не говорит прямо, чего хочет';
const CLEAR_REQUEST = 'внятный';

const OBSERVED = { reply: 'по ответу агента', tool: 'по вызовам инструментов', state: 'по состоянию системы' } as const;
/** How a duty is observed; a duty on the tools names the tool whose call proves it, when it names one. */
const observedText = (expectation: Card['agentMust'][number]): string =>
  expectation.observation === 'tool' && expectation.tool !== undefined ? `по вызову инструмента «${oneLine(expectation.tool)}»` : OBSERVED[expectation.observation];
const ACCOUNTED = { fact: 'факт', turn: 'поворот', stop: 'здесь клиент уходит', ignored: 'не влияет на проверку', changed: 'изменено' } as const;
const TURN_KIND = { change_intent: 'меняет намерение', report: 'сообщает, что видит' } as const;

/** The terms of a card a change can move while its brief reads the same (SituationView.terms). */
function cardTerms(library: LibraryV2, card: Card): NonNullable<SituationView['terms']> {
  const quotes = new Map(library.requirements.map(item => [item.id, oneLine(item.quote)]));
  return {
    must: card.agentMust.map(expectation => ({ rules: expectation.requirementIds.map(id => ({ id, quote: quotes.get(id) ?? '' })),
      when: expectation.appliesWhen === undefined ? null : oneLine(expectation.appliesWhen), observed: observedText(expectation) })),
    knows: card.client.knows.map(fact => ({ askedAs: oneLine(fact.askedAs ?? fact.label) })),
    turn: card.client.turn ? TURN_KIND[card.client.turn.kind] : null,
  };
}

/** How a card is run and judged: the customer's program, where each fact comes from, the account of later messages, the duties. */
function cardDetails(library: LibraryV2, card: Card, maxTurns: number | undefined): SituationView['details'] {
  const message = (index: number) => `реплика №${index + 1}`;
  const { knows, writesSource, turn, leaves } = card.client;
  const vouched = (source: Fact['source']) => source.kind === 'dialogue' ? `${message(source.event.eventIndex)} диалога` : source.kind === 'owner' ? 'вы подтвердили'
    : source.kind === 'plausible' ? source.receiptId === undefined ? 'в логах нет, Lab предполагает — ждёт вашего решения' : 'в логах нет, Lab предположил — вы подтвердили' : 'не подтверждено';
  const { policy, facts } = compilePolicy(card, maxTurns);
  const told = new Map(facts.map(fact => [fact.id, fact.statement]));
  const program = policy.actions.map(action => action.kind === 'answer'
    ? action.id === 'tell_all' ? 'если попросят сразу несколько данных — называет всё, что знает' : `если спросят «${action.ifAsked}» — называет «${told.get(action.factIds[0] ?? '') ?? ''}»`
    : action.kind === 'missing' ? `${action.id === 'dunno_other' ? 'на любой другой вопрос' : `если спросят «${action.ifAsked}»`} — отвечает «${action.payload}»`
    : action.kind === 'finish' ? `уходит, когда ${oneLine(leaves)}`
    : `после того как ${oneLine(turn?.after ?? '')} — ${action.kind === 'change_intent' ? 'меняет намерение (обязательно до ухода)' : 'сообщает, что видит'}: «${action.payload}»`);
  const rules = [...new Set(card.agentMust.flatMap(expectation => expectation.requirementIds))].flatMap(id => {
    const requirement = library.requirements.find(item => item.id === id);
    const source = requirement && library.sources.find(item => item.id === requirement.sourceId);
    return requirement ? [{ label: 'Правило', text: `«${oneLine(requirement.quote)}»${source ? ` — ${oneLine(source.name)}` : ''}` }] : [];
  });
  return [
    ...program.map(text => ({ label: 'Клиент в прогоне', text })),
    { label: 'Клиент в прогоне', text: `не больше ${countText(policy.maxFollowUps, ['реплики', 'реплик', 'реплик'])} после первой; один вопрос повторяет не больше ${policy.repetitionLimit} раз` },
    { label: 'Первая реплика', text: writesSource.kind === 'dialogue' ? `${message(writesSource.event.eventIndex)} диалога` : writesSource.kind === 'owner' ? 'ваши слова' : 'написана Lab по вашим правилам' },
    ...knows.map(fact => ({ label: 'Откуда факт', text: `${factText(fact)} — ${vouched(fact.source)}` })),
    ...(card.filled ?? []).map(item => ({ label: 'Подставлено', text: `«${oneLine(item.value)}» вместо «${oneLine(item.mark)}» — ${message(item.event.eventIndex)} диалога, значение придумал Lab` })),
    ...card.coverage.map(entry => ({ label: 'Поздние реплики', text: `${message(entry.event.eventIndex)} — ${ACCOUNTED[entry.as]}${entry.reason ? `: ${oneLine(entry.reason)}` : ''}` })),
    ...card.agentMust.map(expectation => ({ label: 'Ожидание', text: `${expectationLetter(expectation.id)} — ${oneLine(expectation.text)}; ${observedText(expectation)}${expectation.appliesWhen ? `, если ${oneLine(expectation.appliesWhen)}` : ''}` })),
    ...rules,
    { label: 'Запись', text: `ситуация ${card.id} · версия ${card.revision} · набор ${library.id}, ревизия ${library.revision}` },
  ];
}

/** One card as a situation; `status` is the card's status now, when the imports it cites are at hand; `maxTurns` the run's limit the customer's program is shown within. */
export function cardSituation(library: LibraryV2, card: Card, status?: CardStatus, numbers?: DialogueNumbers, maxTurns?: number): SituationView {
  return {
    format: 'card', id: card.id, number: card.number, brief: cardBrief(library, card, numbers),
    refs: { knows: card.client.knows.map(fact => fact.id), must: card.agentMust.map(expectation => expectation.id) }, terms: cardTerms(library, card),
    // Without the imports at hand the status is not known; a card is read then as it was accepted: ready.
    status: status?.status ?? 'ready',
    ...(status?.question ? { question: { id: status.question.id, text: status.question.text, choices: status.question.choices } } : {}),
    problems: status?.problems ?? [], ...(card.revision > 1 ? { version: card.revision } : {}), topic: card.topic, details: cardDetails(library, card, maxTurns),
  };
}

/* ───────────────────────────── the first library format ───────────────────────────── */

/** Where a first-format variant came from. A variant made from another is named by that one's title: its number differs between lists. */
function variantSource(library: LibraryV1, variant: ScenarioVariant, reader: Reader = 'owner'): string {
  const origin = variant.sourceDialogues[0];
  const number = origin && dialogueNumbers(library.imports)(origin.batchId, origin.dialogueId);
  if (number !== undefined) return `из диалога №${number}`;
  const parent = variant.parentVariantId && library.variants.find(item => item.id === variant.parentVariantId);
  return parent ? `похожая на «${oneLine(parent.title)}»` : variant.provenance === 'production' ? 'из разговора в логах' : OWNER_MADE[reader].rules;
}

/**
 * The brief of a first-format variant (docs/design/card-v2-spec.md §6). A fact known before the conversation is said at once when
 * the opening already holds it, otherwise when asked; a doubtful one is «?»; one the customer learned only in
 * the old conversation was never theirs at the start of a run, so it is not listed. The duties are the
 * required checkpoints — of the compiled definition when the variant ran.
 */
function variantBrief(library: LibraryV1, variant: ScenarioVariant, scenario?: Scenario, reader: Reader = 'owner'): Brief {
  const { userState, behaviorPolicy, evaluationSpec } = variant;
  const terminal = new Set(behaviorPolicy.terminalStates);
  const leaves = [...new Set(behaviorPolicy.transitions.filter(item => terminal.has(item.to)).map(item => oneLine(item.when)))];
  const turnAction = behaviorPolicy.actions.find(action => (action.kind === 'change_intent' || action.kind === 'observe') && action.payload);
  const turnWhen = turnAction && behaviorPolicy.transitions.find(item => item.actionId === turnAction.id);
  const execution = scenario?.execution && !isCardExecution(scenario.execution) ? scenario.execution : undefined;
  const must = (execution?.evaluatorView.checkpoints ?? evaluationSpec.checkpoints).filter(checkpoint => checkpoint.role === 'required')
    .map(checkpoint => ({ text: oneLine(checkpoint.rule), rule: oneLine(checkpoint.quote) || null }));
  return {
    // A run names the situation by its accepted definition, like every other section of the result.
    title: oneLine(scenario?.title ?? variant.title), source: variantSource(library, variant, reader), wants: oneLine(userState.goal), writes: oneLine(userState.opening),
    knows: [
      ...userState.facts.filter(fact => fact.availability !== 'learned_in_source').map(fact => {
        const shown = fact.value === undefined || contains(fact.statement, String(fact.value)) ? fact.statement : `${fact.statement}: ${fact.value}`;
        const when: Said = fact.availability === 'uncertain' ? '?' : contains(userState.opening, String(fact.value ?? fact.statement)) ? 'сразу' : 'если спросят';
        return { what: oneLine(shown), when };
      }),
      ...[...userState.cannotKnow, ...userState.missing].map(item => ({ what: oneLine(item), when: 'не знает' as const })),
    ],
    leaves: leaves.length ? leaves.join('; ') : null,
    turn: turnAction?.payload && turnWhen ? turnText(turnWhen.when, turnAction.payload) : null,
    must: must.length ? must : [{ text: oneLine(evaluationSpec.successCriteria), rule: null }],
  };
}

const QUALITY: Record<ScenarioVariant['quality'], CardStatusKind> = { ready: 'ready', needs_review: 'needs_owner', blocked: 'unusable' };
const COVERED = { conditional_action: 'ответ по условию', initial_fact: 'личный факт', omitted: 'не влияет на проверку' } as const;

/**
 * A first-format variant through the brief (docs/design/card-v2-spec.md §6), read-only: its stored quality is the status, its
 * checker's first open question is the question — with no answers here, since the first format is only read.
 */
export function projectV1Variant(library: LibraryV1, variant: ScenarioVariant, number: number): SituationView {
  const question = ownerQuestions(variant)[0];
  const knows = variant.userState.facts.filter(fact => fact.availability !== 'learned_in_source');
  const origin = (fact: ScenarioVariant['userState']['facts'][number]) => fact.origin.kind === 'dialogue' ? `реплика №${fact.origin.eventIndex + 1} диалога: «${oneLine(fact.origin.quote)}»`
    : fact.origin.kind === 'owner' ? (variant.history.some(item => item.factEdit?.factId === fact.id) ? 'вы подтвердили' : 'не подтверждено') : `допущение: ${oneLine(fact.origin.reason)}`;
  return {
    format: 'variant', id: variant.id, number, brief: variantBrief(library, variant),
    refs: { knows: [...knows.map(fact => fact.id), ...[...variant.userState.cannotKnow, ...variant.userState.missing].map(() => null)],
      must: variant.evaluationSpec.checkpoints.filter(checkpoint => checkpoint.role === 'required').map(checkpoint => checkpoint.id) },
    status: QUALITY[variant.quality],
    ...(question ? { question: { id: null, text: plainIssue(library, variant, question), choices: [] } } : {}),
    problems: variant.quality === 'blocked' ? ownerRemarks(variant.issues).filter(issue => issue.severity === 'blocked').map(issue => plainIssue(library, variant, issue)) : [],
    ...(variant.revision > 1 ? { version: variant.revision } : {}),
    topic: library.businessScenarios.find(group => group.id === variant.businessScenarioId)?.title,
    details: [
      ...behaviorLines(variant).map(text => ({ label: 'Клиент в прогоне', text: oneLine(text) })),
      ...variant.userState.facts.map(fact => ({ label: 'Откуда факт', text: `${oneLine(fact.statement)} — ${origin(fact)}` })),
      ...(variant.sourceCoverage ?? []).map(item => ({ label: 'Поздние реплики', text: `реплика №${item.eventIndex + 1} — ${COVERED[item.disposition]}: ${oneLine(item.reason)}` })),
      ...variant.issues.map(issue => ({ label: 'Замечание', text: plainIssue(library, variant, issue) })),
      { label: 'Запись', text: `вариант ${variant.id} · версия ${variant.revision} · набор ${library.id}, ревизия ${library.revision} (старый формат)` },
    ],
  };
}

/* ───────────────────────────── records made before libraries ───────────────────────────── */

const scenarioSource = (provenance: Scenario['provenance'], reader: Reader): string =>
  provenance === 'production' ? 'из разговора в логах' : provenance === 'curated' ? OWNER_MADE[reader].added : OWNER_MADE[reader].rules;

function scenarioBrief(record: Pick<Experiment, 'requirements'>, scenario: Scenario, reader: Reader = 'owner'): Brief {
  const rule = scenario.requirementIds.map(id => record.requirements.find(item => item.id === id)).find(item => !!item);
  return {
    title: oneLine(scenario.title), source: scenarioSource(scenario.provenance, reader),
    wants: oneLine(scenario.user.goal), writes: oneLine(scenario.user.opening),
    knows: [
      ...(scenario.user.knows ?? []).map(item => ({ what: oneLine(item), when: 'сразу' as const })),
      ...(scenario.user.answers ?? []).map(item => ({ what: oneLine(item.reply), when: 'если спросят' as const })),
      ...(scenario.user.cannotKnow ?? []).map(item => ({ what: oneLine(item), when: 'не знает' as const })),
    ],
    leaves: null, turn: null,
    must: [{ text: oneLine(scenario.successCriteria ?? '') || 'справиться с запросом клиента', rule: rule ? oneLine(rule.quote) : null }],
  };
}

/** A scenario of a record made before libraries (the validate path): what it runs is its own definition, ready as it is. */
export function scenarioView(record: Pick<Experiment, 'requirements'>, scenario: Scenario, number: number): SituationView {
  return {
    format: 'scenario', id: scenario.id, number, brief: scenarioBrief(record, scenario),
    refs: { knows: [...scenario.user.knows ?? [], ...scenario.user.answers ?? [], ...scenario.user.cannotKnow ?? []].map(() => null), must: [null] },
    status: 'ready', problems: [],
    details: [
      { label: 'Клиент в прогоне', text: oneLine(scenario.user.behavior) },
      { label: 'Что знает клиент', text: oneLine(scenario.user.facts) },
      ...scenario.checks.map(check => ({ label: 'Точная проверка', text: oneLine(describeCheck(check)) })),
      ...(scenario.metrics ?? []).map(metric => ({ label: 'Судья оценивает', text: oneLine(metric.name) })),
      { label: 'Запись', text: `ситуация ${scenario.id} (формат до наборов ситуаций)` },
    ],
  };
}

/* ───────────────────────────── one projection for every surface ───────────────────────────── */

export interface ViewContext {
  /** What a card library's cards cite. Without it their status is not known, and a card reads as it was accepted. */
  evidence?: CardEvidence;
  /** Where a card's logged dialogue stands in its import. */
  numbers?: DialogueNumbers;
  maxTurns: number;
}

/** Every situation of a record in the order the owner reads them, each with its status now. */
export function situationViews(record: Experiment, context: ViewContext): SituationView[] {
  const library = record.librarySnapshot;
  if (library?.formatVersion === 2) {
    const statuses = context.evidence ? cardStatuses({ library, evidence: context.evidence, maxTurns: context.maxTurns }) : undefined;
    return [...library.cards].sort((a, b) => a.number - b.number).map(card => cardSituation(library, card, statuses?.get(card.id), context.numbers, context.maxTurns));
  }
  if (library?.formatVersion === 1) return orderedVariants(library).map((variant, index) => projectV1Variant(library, variant, index + 1));
  return record.scenarios.map((scenario, index) => scenarioView(record, scenario, index + 1));
}

/**
 * The brief of one situation of a run, whatever format it was accepted in: the customer report reads the same
 * projection, `reader` 'others' saying where a situation the owner made came from about the owner.
 */
export function situationBrief(record: Experiment, scenario: Scenario, numbers?: DialogueNumbers, reader: Reader = 'owner'): Brief {
  const library = record.librarySnapshot;
  if (library?.formatVersion === 2) {
    const card = library.cards.find(item => item.id === scenario.id);
    if (card) return cardBrief(library, card, numbers, reader);
  }
  const first = libraryV1Of(record);
  const variant = first?.variants.find(item => item.id === scenario.id);
  return first && variant ? variantBrief(first, variant, scenario, reader) : scenarioBrief(record, scenario, reader);
}

/** The number a situation of a run is known by: a card's own number; its place in the run for older formats. */
export function situationNumber(record: Experiment, scenarioId: string, position: number): number {
  const library = record.librarySnapshot;
  return library?.formatVersion === 2 ? library.cards.find(card => card.id === scenarioId)?.number ?? position : position;
}

/** A draft in the first library format is only read now; the surfaces say so above its list, with the way on. */
export function formatNote(record: Pick<Experiment, 'librarySnapshot' | 'phase' | 'trials'>): string | undefined {
  return convertible(record) ? 'Старый формат: эти ситуации можно посмотреть, но не изменить — их можно продолжить в новом формате.' : undefined;
}

/** The open question with its numbered answers, the way the owner sees it. */
const questionData = (view: SituationView) => view.question
  ? { question: { text: view.question.text, answers: view.question.choices.map((choice, index) => ({ number: index + 1, label: choice.label, ...(choice.needsText ? { needsText: true } : {}) })) } } : {};

/** A situation for a machine reader (the chat's model, `--json`): the brief with the ids a command names, the status and the question with numbered answers. */
export function situationData(view: SituationView) {
  return {
    number: view.number, title: view.brief.title, status: view.status, source: view.brief.source, wants: view.brief.wants,
    ...(view.brief.vague ? { clarity: 'vague' as const } : {}), writes: view.brief.writes,
    knows: view.brief.knows.map((fact, index) => ({ ...(view.refs.knows[index] ? { id: view.refs.knows[index] } : {}), ...fact })),
    leaves: view.brief.leaves, turn: view.brief.turn, ...(view.brief.filled ? { filledOverMasks: view.brief.filled } : {}),
    must: view.brief.must.map((duty, index) => ({ ...(view.refs.must[index] ? { id: view.refs.must[index] } : {}), ...duty })),
    ...questionData(view), ...(view.problems.length ? { problems: view.problems } : {}),
  };
}

/**
 * A situation in a list the chat's model reads: enough to name it and to put its question to the owner. A draft
 * holds up to 200 situations, and whole briefs of all of them would flood the model's context; the brief with
 * the ids a command names is read by number.
 */
export function situationEntry(view: SituationView) {
  return { number: view.number, title: view.brief.title, status: view.status, ...questionData(view), ...(view.problems.length ? { problems: view.problems.slice(0, 1) } : {}) };
}

/** «12 ситуаций: 9 готовы · 2 ждут вашего ответа · 1 не подходит для теста». */
export function countsText(views: readonly SituationView[]): string {
  const count = (status: CardStatusKind) => views.filter(view => view.status === status).length;
  const parts = [
    countText(count('ready'), ['готова', 'готовы', 'готовы']),
    ...(count('needs_owner') ? [countText(count('needs_owner'), ['ждёт вашего ответа', 'ждут вашего ответа', 'ждут вашего ответа'])] : []),
    ...(count('unusable') ? [countText(count('unusable'), ['не подходит для теста', 'не подходят для теста', 'не подходят для теста'])] : []),
    ...(count('checking') ? [countText(count('checking'), ['ещё не проверена', 'ещё не проверены', 'ещё не проверены'])] : []),
  ];
  return `${countText(views.length, ['ситуация', 'ситуации', 'ситуаций'])}: ${parts.join(' · ')}`;
}

/* ───────────────────────────── rows ───────────────────────────── */

export type SituationRole = 'title' | 'selected' | 'line' | 'source' | 'heading' | 'field' | 'rule' | 'question' | 'choice' | 'problem'
  | 'actions' | 'detail' | 'change' | 'blank' | 'chip:ready' | 'chip:ask' | 'chip:unusable' | 'chip:checking';
export interface SituationRow {
  role: SituationRole; indent: number; text: string;
  /** Aligned to the right edge and never cut: the status chip. */
  right?: { role: SituationRole; text: string };
  /** One line, cut with «…», never wrapped: the lines of a list. */
  clip?: true;
  /** Wrapped lines continue under this column: the value column of the brief. */
  hang?: number;
}
const blank: SituationRow = { role: 'blank', indent: 0, text: '' };

const CHIP: Record<CardStatusKind, { role: SituationRole; text: string; short: string }> = {
  ready: { role: 'chip:ready', text: '✓ готова', short: '✓ готова' },
  needs_owner: { role: 'chip:ask', text: '? нужен ваш ответ', short: '? ответ' },
  unusable: { role: 'chip:unusable', text: '✗ не подходит для теста', short: '✗ не подходит' },
  checking: { role: 'chip:checking', text: '… ждёт проверки', short: '… проверка' },
};
/** The status chip; «проверяю» only while a check is running, so a check that is not going is never claimed. */
export function chip(view: SituationView, running = false, narrow = false): { role: SituationRole; text: string } {
  const { role, text, short } = CHIP[view.status];
  const word = view.status === 'checking' && running ? '⠋ проверяю' : narrow ? short : text;
  return { role, text: view.version && view.status === 'ready' && !narrow ? `${word} · версия ${view.version}` : word };
}

/** A long quote keeps its beginning and its end verbatim; the middle gives way to «…». */
function quoteText(quote: string, max = 180): string {
  if (quote.length <= max) return quote;
  const head = Math.ceil(max * 0.6), tail = max - head - 1;
  return `${quote.slice(0, head).trimEnd()}…${quote.slice(-tail).trimStart()}`;
}

export interface RowOptions {
  /** A check is running now: an unchecked situation says «проверяю». */
  running?: boolean;
  /** Narrow screens (below 70 columns) shorten the chip to its sign and first word. */
  narrow?: boolean;
}

/** One situation in a list (docs/design/ui-spec.md §3.2): the number, the title and the chip; what the customer writes; the first duty or why it cannot be a test. */
export function listRows(view: SituationView, options: RowOptions & { selected?: boolean } = {}): SituationRow[] {
  const mark = options.selected ? '›' : ' ';
  const third = view.status === 'unusable' ? { role: 'problem' as const, text: view.problems[0] ?? 'Не подходит для теста.' }
    : { role: 'line' as const, text: `Агент должен: ${view.brief.must[0]?.text ?? '—'}` };
  return [
    { role: options.selected ? 'selected' : 'title', indent: 0, text: `${mark} ${String(view.number).padEnd(2)} ${view.brief.title}`,
      right: chip(view, !!options.running, options.narrow), clip: true },
    { role: 'line', indent: 5, text: `Клиент: «${view.brief.writes}»`, clip: true },
    { ...third, indent: 5, clip: true },
  ];
}

/**
 * The customer's part of a brief as label and text, the way every surface lists it — the open situation and the
 * customer report alike: an empty label continues the line above; the values Lab wrote over masking marks follow
 * what the customer writes, so a filled value never reads as the customer's own.
 */
export function briefFields(brief: Brief): [label: string, text: string][] {
  const same = (a: string, b: string) => a.toLocaleLowerCase('ru') === b.toLocaleLowerCase('ru');
  return [
    ...(same(brief.wants, brief.title) ? [] : [['Хочет', brief.wants] as [string, string]]),
    ...(brief.vague ? [['Запрос', VAGUE_REQUEST] as [string, string]] : []),
    ['Пишет', `«${brief.writes}»`],
    ...(brief.filled ? [['', `подставлено вместо обезличенного: ${brief.filled.map(value => `«${value}»`).join(', ')}`] as [string, string]] : []),
    ...brief.knows.map((fact, index): [string, string] => [index ? '' : 'Знает', `${fact.what} — ${fact.when}`]),
    ...(brief.leaves ? [['Уходит', brief.leaves] as [string, string]] : []),
    ...(brief.turn ? [['Поворот', brief.turn] as [string, string]] : []),
  ];
}

/**
 * One open situation (docs/design/ui-spec.md §4.3–4.5): the title with its chip and source; the customer, labels in one column;
 * what the agent must do, each duty with its rule (a rule shared with the duty above is not repeated); then why
 * it cannot be a test, and the one open question with its numbered answers.
 */
export function briefRows(view: SituationView, options: RowOptions = {}): SituationRow[] {
  const { brief } = view;
  const fields = briefFields(brief);
  const column = Math.max(...fields.map(([label]) => label.length)) + 3;
  const must = brief.must.flatMap((duty, index): SituationRow[] => [
    { role: 'field', indent: 3, text: `${String(index + 1).padEnd(3)}${duty.text}`, hang: 3 },
    ...(duty.rule && duty.rule !== brief.must[index - 1]?.rule ? [{ role: 'rule' as const, indent: 6, text: `правило: «${quoteText(duty.rule)}»`, hang: 10 }] : []),
  ]);
  return [
    { role: 'title', indent: 0, text: `${String(view.number).padEnd(2)} ${brief.title}`, right: chip(view, !!options.running, options.narrow), clip: true },
    { role: 'source', indent: 3, text: brief.source },
    blank,
    { role: 'heading', indent: 0, text: 'Клиент' },
    ...fields.map(([label, value]): SituationRow => ({ role: 'field', indent: 3, text: `${label.padEnd(column)}${value}`, hang: column })),
    blank,
    { role: 'heading', indent: 0, text: 'Агент должен' },
    ...must,
    ...(view.problems.length ? [blank, { role: 'heading' as const, indent: 0, text: 'Почему не подходит' },
      ...view.problems.map(text => ({ role: 'problem' as const, indent: 3, text }))] : []),
    ...questionRows(view),
  ];
}

/** The open question (docs/design/ui-spec.md §3.4): one sentence and 2–3 numbered answers; an older format's question is only shown. */
export function questionRows(view: SituationView): SituationRow[] {
  const { question } = view;
  if (!question) return [];
  return [blank, { role: 'question', indent: 0, text: `? ${question.text}`, hang: 2 },
    ...(question.choices.length ? [blank, ...question.choices.map((choice, index): SituationRow => ({ role: 'choice', indent: 2, text: `${index + 1}  ${choice.label}` }))]
      : [{ role: 'detail' as const, indent: 2, text: 'Старый формат: здесь вопрос только показан.' }])];
}

/** «d — как это проверяется». */
export function detailRows(view: SituationView): SituationRow[] {
  const column = Math.max(...view.details.map(item => item.label.length)) + 3;
  return [{ role: 'heading', indent: 0, text: 'Как это проверяется' },
    ...view.details.map((item, index): SituationRow => ({ role: 'detail', indent: 3,
      text: `${(item.label === view.details[index - 1]?.label ? '' : item.label).padEnd(column)}${item.text}`, hang: column }))];
}

/** What an owner can do with a card from its screen (docs/design/ui-spec.md §4.3–4.5, §8.4): its question's answers first, then its own actions. */
export type SituationAction =
  | { kind: 'answer'; choice: QuestionChoice }
  | { kind: 'edit' | 'similar' | 'remove' | 'rule'; label: string };
export function situationActions(view: SituationView): SituationAction[] {
  if (view.format !== 'card') return [];
  if (view.status === 'needs_owner' && view.question?.choices.length) return view.question.choices.map(choice => ({ kind: 'answer', choice }));
  if (view.status === 'ready') return [{ kind: 'edit', label: 'Изменить' }, { kind: 'similar', label: 'Добавить похожую' }, { kind: 'remove', label: 'Не проверять' }];
  if (view.status === 'unusable') return [{ kind: 'rule', label: 'Добавить правило' }, { kind: 'remove', label: 'Исключить из запуска' }];
  return [];
}
const actionLabel = (action: SituationAction): string => action.kind === 'answer' ? action.choice.label : action.label;
/** The one row of numbered actions under an open situation. */
export const actionRow = (actions: readonly SituationAction[]): SituationRow =>
  ({ role: 'actions', indent: 0, text: actions.map((action, index) => `${index + 1} ${actionLabel(action)}`).join('  ·  ') });

/* ───────────────────────────── «было → стало» ───────────────────────────── */

export interface BriefChange { field: string; before: string | null; after: string | null }

/**
 * What changed between two states of one situation, line by line of the brief: a fact and a duty are matched
 * by their id, so a changed disclosure reads «было «?», стало «если спросят»» on the same fact. A card's terms the
 * brief does not print — a duty's rules, its condition and how it is observed, the agent's question a fact answers,
 * what the late turn does — get lines of their own: whatever the owner confirms is shown.
 */
export function briefChanges(before: SituationView | undefined, after: SituationView | undefined): BriefChange[] {
  if (!before || !after) return [{ field: 'Ситуация', before: before ? `№${before.number} ${before.brief.title}` : null, after: after ? `№${after.number} ${after.brief.title}` : null }];
  const changes: BriefChange[] = [];
  const text = (field: string, a: string | null, b: string | null) => { if (a !== b) changes.push({ field, before: a, after: b }); };
  text('Название', before.brief.title, after.brief.title);
  text('Хочет', before.brief.wants, after.brief.wants);
  text('Запрос', requestLine(before), requestLine(after));
  text('Пишет', `«${before.brief.writes}»`, `«${after.brief.writes}»`);
  const byId = <T>(items: readonly T[], ids: readonly (string | null)[]) => new Map(items.flatMap((item, index) => ids[index] ? [[ids[index]!, item] as const] : []));
  const paired = <T>(field: string, a: T[], b: T[], idsA: (string | null)[], idsB: (string | null)[], show: (item: T) => string) => {
    const was = byId(a, idsA), now = byId(b, idsB);
    for (const [id, item] of was) text(field, show(item), now.has(id) ? show(now.get(id)!) : null);
    for (const [id, item] of now) if (!was.has(id)) text(field, null, show(item));
  };
  paired('Знает', before.brief.knows, after.brief.knows, before.refs.knows, after.refs.knows, fact => `${fact.what} — ${fact.when}`);
  if (before.terms && after.terms) {
    const was = byId(before.terms.knows, before.refs.knows);
    for (const [index, id] of after.refs.knows.entries()) {
      const a = id ? was.get(id) : undefined, b = after.terms.knows[index];
      if (a && b) text(`Знает: ${after.brief.knows[index]!.what} — если спросят`, a.askedAs, b.askedAs);
    }
  }
  text('Уходит', before.brief.leaves, after.brief.leaves);
  text('Поворот', turnLine(before), turnLine(after));
  paired('Агент должен', before.brief.must, after.brief.must, before.refs.must, after.refs.must, duty => duty.text);
  if (before.terms && after.terms) {
    const was = byId(before.terms.must, before.refs.must);
    for (const [index, id] of after.refs.must.entries()) {
      const a = id ? was.get(id) : undefined, b = after.terms.must[index];
      if (!a || !b) continue;
      const duty = `Агент должен: ${after.brief.must[index]!.text}`;
      if (a.rules.map(rule => rule.id).join(' ') !== b.rules.map(rule => rule.id).join(' ')) changes.push({ field: `${duty} — правило`, before: rulesText(a), after: rulesText(b) });
      text(`${duty} — когда`, a.when ?? 'всегда', b.when ?? 'всегда');
      text(`${duty} — проверяется`, a.observed, b.observed);
    }
  }
  return changes;
}

/** Whether a card's customer can say what they want, as a change shows it; the older formats have no such mark. */
const requestLine = (view: SituationView): string | null => view.format !== 'card' ? null : view.brief.vague ? VAGUE_REQUEST : CLEAR_REQUEST;
/** The late turn as a change shows it: what the customer does, after what and with which words — «меняет намерение после «…»: «…»». */
const turnLine = (view: SituationView): string | null => view.brief.turn === null ? null : view.terms?.turn ? `${view.terms.turn} ${view.brief.turn}` : view.brief.turn;
/** A duty's rules in one line, each quote kept to its beginning and end. */
const rulesText = (terms: DutyTerms): string => terms.rules.map(rule => quoteText(rule.quote, 120)).join(' · ') || 'нет правила';

/** A change in one line: «Знает: номер терминала: 5678 — было «?», стало «если спросят»». */
export function changeText(change: BriefChange): string {
  const { field, before, after } = change;
  if (before === null) return `${field}: добавлено «${after}»`;
  if (after === null) return `${field}: убрано «${before}»`;
  const cut = before.lastIndexOf(' — ');
  if (cut > 0 && after.startsWith(before.slice(0, cut + 3))) return `${field}: ${before.slice(0, cut)} — было «${before.slice(cut + 3)}», стало «${after.slice(cut + 3)}»`;
  return `${field}: было «${before}», стало «${after}»`;
}

/* ───────────────────────────── layout ───────────────────────────── */

/** A row of any surface that is laid out like a situation's: a role, an indent, a right part, cut or wrapped. */
export type LayoutRow<Role extends string> = Omit<SituationRow, 'role' | 'right'> & { role: Role; right?: { role: Role; text: string } };
export interface LaidOut<Role extends string> { role: Role; text: string; right?: { role: Role; text: string } }
export type SituationLine = LaidOut<SituationRole>;

const wrap = (text: string, width: number): string[] => wrapTextWithAnsi(text, Math.max(1, width));
// truncateToWidth closes its ellipsis with style resets for a live terminal; these lines are plain text, painted later by role.
const clipTo = (text: string, width: number) => stripTerminalSequences(truncateToWidth(text, Math.max(1, width), '…'));

/**
 * The rows as lines of at most `width` columns (capped at MAX_WIDTH, like the result screen): a chip aligned
 * to the right edge and never cut, a list line cut with «…», everything else wrapped under its hanging column.
 * `margin` is the left margin before every indent: one column in a terminal of its own, none inside a host
 * that already frames the rows.
 */
export function layoutRows<Role extends string = SituationRole>(rows: readonly LayoutRow<Role>[], width: number, margin = 1): LaidOut<Role>[] {
  const edge = Math.max(20, Math.min(width, MAX_WIDTH));
  return rows.flatMap((row): LaidOut<Role>[] => {
    const pad = ' '.repeat(row.indent + margin);
    const room = edge - pad.length;
    if (row.right || row.clip) {
      const reserve = row.right ? visibleWidth(row.right.text) + 2 : 0;
      const text = clipTo(row.text, room - reserve);
      if (!row.right) return [{ role: row.role, text: pad + text }];
      return [{ role: row.role, text: pad + text + ' '.repeat(Math.max(2, room - visibleWidth(text) - visibleWidth(row.right.text))), right: row.right }];
    }
    if (!row.text) return [{ role: row.role, text: '' }];
    const hang = row.hang ?? 0;
    const [first = '', ...rest] = wrap(row.text, room);
    const tail = rest.join(' ');
    return [{ role: row.role, text: pad + first }, ...(tail ? wrap(tail, room - hang).map(piece => ({ role: row.role, text: pad + ' '.repeat(hang) + piece })) : [])];
  });
}

/** The rows as plain text: what the CLI prints. */
export const plainSituationText = (rows: readonly SituationRow[], width: number): string =>
  layoutRows(rows, width).map(line => (line.text + (line.right?.text ?? '')).trimEnd()).join('\n');
