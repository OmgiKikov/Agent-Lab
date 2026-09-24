import type { Requirement, Scenario, Source } from '../contracts.js';
import { countText, pluralForm } from '../plural.js';
import type { RequirementKind } from '../scenario-contracts.js';
import { clip } from '../text.js';
import type { Card, LibraryV2, Rulebook } from './schema.js';

/*
 * «Свод правил» — which of the owner's rules bind the bot (card/schema.ts rulebookSchema). The proposal types every
 * sentence it cites (behaviour, knowledge, an operator procedure); the rulebook says which kinds, and which single rules of
 * another kind, may back what the agent must do. A rule outside it stays in the library, visible and counted, but a
 * proposal citing it is repaired, and a card that cites it waits for the owner (status.ts). A requirement
 * grounded before kinds existed has none and binds exactly as it always did: a kind is never guessed for stored data.
 * Pure: no I/O, no model.
 */

/** What binds the bot when the owner has not said otherwise: its behaviour and the correctness of what it tells. */
export const DEFAULT_RULEBOOK: Rulebook = { kinds: ['behavior', 'knowledge'], included: [] };
const KIND_ORDER: readonly RequirementKind[] = ['behavior', 'knowledge', 'operator_procedure'];

/** The rulebook of a library: the owner's, else the default. */
export const rulebookOf = (library: Pick<LibraryV2, 'rulebook'>): Rulebook => library.rulebook ?? DEFAULT_RULEBOOK;

/** Whether a rule may back an expectation: untyped rules always, typed ones by their kind or the owner's single inclusion. */
export function bindsBot(rulebook: Rulebook, requirement: Pick<Requirement, 'id' | 'kind'>): boolean {
  return requirement.kind === undefined || rulebook.kinds.includes(requirement.kind) || rulebook.included.includes(requirement.id);
}

/** The owner's words for a kind of rule: one of them, and a count of them. */
export const KIND_WORDS: Record<RequirementKind, { one: string; forms: [string, string, string] }> = {
  behavior: { one: 'правило поведения бота', forms: ['правило поведения бота', 'правила поведения бота', 'правил поведения бота'] },
  knowledge: { one: 'сведения из базы знаний', forms: ['сведение из базы знаний', 'сведения из базы знаний', 'сведений из базы знаний'] },
  operator_procedure: { one: 'инструкция для операторов', forms: ['инструкция для операторов', 'инструкции для операторов', 'инструкций для операторов'] },
};
const RULES: [string, string, string] = ['правило', 'правила', 'правил'];

/** The first expectation of a card that rests on a rule the rulebook leaves out, with that rule. */
export function unboundCitation(card: Card, library: Pick<LibraryV2, 'requirements' | 'rulebook'>): { expectation: Card['agentMust'][number]; requirement: Requirement } | undefined {
  const rulebook = rulebookOf(library);
  for (const expectation of card.agentMust) for (const id of expectation.requirementIds) {
    const requirement = library.requirements.find(item => item.id === id);
    if (requirement && !bindsBot(rulebook, requirement)) return { expectation, requirement };
  }
  return undefined;
}

/** The rulebook with one kind bound as a whole, or not. Its single inclusions of that kind stay: they are the owner's own word. */
export function withKind(rulebook: Rulebook, kind: RequirementKind, binds: boolean): Rulebook {
  const kinds = KIND_ORDER.filter(item => item === kind ? binds : rulebook.kinds.includes(item));
  return { kinds, included: [...rulebook.included] };
}

/** The rulebook with single rules included or taken back. */
export function withRules(rulebook: Rulebook, change: { include?: readonly string[]; exclude?: readonly string[] }): Rulebook {
  const out = new Set(change.exclude ?? []);
  return { kinds: [...rulebook.kinds], included: [...new Set([...rulebook.included, ...change.include ?? []])].filter(id => !out.has(id)) };
}

/** What the owner reads of the rulebook: each kind with its count and whether it binds, the sources, the rules without a kind. */
export interface RulebookView {
  kinds: { kind: RequirementKind; count: number; binds: boolean; included: number }[];
  /** Typed and untyped rules by where their quote comes from: the agent's prompt, or the knowledge base. */
  sources: { prompt: number; knowledge: number };
  /** Rules grounded before kinds existed: they bind as they always did. */
  untyped: number;
  /** Rules that may back an expectation now, of all the library holds. */
  binding: number; total: number;
}

export function rulebookView(library: Pick<LibraryV2, 'requirements' | 'sources' | 'rulebook'>): RulebookView {
  const rulebook = rulebookOf(library);
  const fromPrompt = (requirement: Requirement) => library.sources.find(source => source.id === requirement.sourceId)?.kind === 'prompt';
  const prompt = library.requirements.filter(fromPrompt).length;
  return {
    kinds: KIND_ORDER.map(kind => {
      const own = library.requirements.filter(requirement => requirement.kind === kind);
      return { kind, count: own.length, binds: rulebook.kinds.includes(kind), included: own.filter(requirement => rulebook.included.includes(requirement.id)).length };
    }),
    sources: { prompt, knowledge: library.requirements.length - prompt },
    untyped: library.requirements.filter(requirement => requirement.kind === undefined).length,
    binding: library.requirements.filter(requirement => bindsBot(rulebook, requirement)).length, total: library.requirements.length,
  };
}

/** Whether the library's rules were typed at all: a library grounded before kinds has no rulebook to show. */
export const rulebookApplies = (view: RulebookView): boolean => view.total > view.untyped;

/** The rulebook the surfaces show: nothing for a library grounded before rules had kinds, where every rule binds as before. */
export function shownRulebook(library: Pick<LibraryV2, 'requirements' | 'sources' | 'rulebook'>): RulebookView | undefined {
  const view = rulebookView(library);
  return rulebookApplies(view) ? view : undefined;
}

/** «Свод правил» in lines: what binds the bot, each kind with its count, the sources. */
export function rulebookLines(view: RulebookView): string[] {
  if (!rulebookApplies(view)) return [`Свод правил: у ${countText(view.total, RULES)} тип не определён — по ним судят бота все.`];
  return [
    `Свод правил: бота судят по ${view.binding} из ${view.total} ${pluralForm(view.total, ['правила', 'правил', 'правил'])}`,
    ...view.kinds.filter(item => item.count || item.binds).map(item => `  ${item.binds ? '✓' : '·'} ${KIND_WORDS[item.kind].forms[1]}: ${item.count}${item.binds ? ' — входят'
      : item.included ? ` — не входят, кроме отмеченных вами (${item.included})` : ' — не входят'}`),
    ...(view.untyped ? [`  ✓ тип не определён: ${view.untyped} — входят`] : []),
    `Источники: промпт агента — ${countText(view.sources.prompt, RULES)}, база знаний — ${countText(view.sources.knowledge, RULES)}`,
  ];
}

/** «Было → стало» of a rulebook change, and the situations it sends back to the owner. */
export function rulebookChangeLines(before: Rulebook, after: Rulebook, requirements: readonly Requirement[], flagged: readonly number[]): string[] {
  const lines = KIND_ORDER.flatMap(kind => before.kinds.includes(kind) === after.kinds.includes(kind) ? []
    : [`${KIND_WORDS[kind].forms[1].charAt(0).toLocaleUpperCase('ru')}${KIND_WORDS[kind].forms[1].slice(1)}: ${after.kinds.includes(kind) ? 'не входили → входят' : 'входили → не входят'}`]);
  const quote = (id: string) => `«${clip(requirements.find(item => item.id === id)?.quote ?? id, 80)}»`;
  lines.push(...after.included.filter(id => !before.included.includes(id)).map(id => `Бот обязан так делать: ${quote(id)}`));
  lines.push(...before.included.filter(id => !after.included.includes(id)).map(id => `Больше не обязателен для бота: ${quote(id)}`));
  if (flagged.length) lines.push(`Вернутся к вам: ${flagged.length === 1 ? 'ситуация' : 'ситуации'} ${flagged.join(', ')} — их ожидания опираются на правила вне свода.`);
  return lines;
}

/**
 * The bar a run was judged by, read from its accepted situations: the rules their expectations cite, by where the quote
 * comes from, and whether operator instructions bind. Null when none of those rules was typed — a run prepared before
 * kinds, whose bar Lab cannot name honestly.
 */
export interface RuleBar { prompt: number; knowledge: number; operators: 'excluded' | 'included' | 'chosen'; chosen: number }

export function ruleBar(scenarios: readonly Scenario[], sources: readonly Pick<Source, 'id' | 'kind'>[], rulebook: Rulebook | undefined): RuleBar | null {
  const cited = new Map<string, Requirement>();
  for (const scenario of scenarios) {
    const execution = scenario.execution;
    if (!execution || !('expectations' in execution.evaluatorView)) continue;
    for (const requirement of execution.evaluatorView.requirements) cited.set(requirement.id, requirement);
  }
  const rules = [...cited.values()];
  if (!rules.some(requirement => requirement.kind !== undefined)) return null;
  const book = rulebook ?? DEFAULT_RULEBOOK;
  const prompt = rules.filter(requirement => sources.find(source => source.id === requirement.sourceId)?.kind === 'prompt').length;
  const chosen = book.included.length;
  return { prompt, knowledge: rules.length - prompt, operators: book.kinds.includes('operator_procedure') ? 'included' : chosen ? 'chosen' : 'excluded', chosen };
}

/** «Оценка по правилам: 3 из промпта агента, 12 из базы знаний (инструкции для операторов не входят)». */
export function ruleBarText(bar: RuleBar): string {
  const operators = bar.operators === 'included' ? 'инструкции для операторов входят' : bar.operators === 'chosen'
    ? `из инструкций для операторов — только отмеченные вами (${bar.chosen})` : 'инструкции для операторов не входят';
  return `Оценка по правилам: ${bar.prompt} из промпта агента, ${bar.knowledge} из базы знаний (${operators})`;
}
