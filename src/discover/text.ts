import { countText, pluralForm } from '../plural.js';
import { clip } from '../text.js';
import type { ImportBatch } from '../scenario-contracts.js';
import type { PlanIssue } from './schema.js';
import type { AnalysisView, Example, FindingUndecided, ProblemView } from './view.js';
import type { ProblemCheck } from './check.js';

/*
 * The words of a log analysis (DISCOVER), in one place: the chat, the board and the command line lay out these lines and
 * never word the result on their own. The answer comes first — what was analysed and what is broken — and the limits of
 * the answer after it, each said once.
 */

const CONVERSATIONS: [string, string, string] = ['разговор', 'разговора', 'разговоров'];
const OF_CONVERSATIONS: [string, string, string] = ['разговора', 'разговоров', 'разговоров'];
const IN_CONVERSATIONS: [string, string, string] = ['разговоре', 'разговорах', 'разговорах'];

const UNDECIDED: Readonly<Record<FindingUndecided, string>> = {
  no_agent_reply: 'агент в разговоре не ответил',
  channel_unobserved: 'действия агента в этом разговоре записаны не полностью',
  call_unconfirmed: 'вызова нужного инструмента в логе нет, а что лог записывает каждый такой вызов, не подтверждено — сделано ли действие, не видно',
  not_exercised_in_log: 'разговор не дошёл до правила',
  judge_failed: 'судья не дал ответа',
  judge_split: 'два голоса судьи разошлись',
  no_evidence: 'судья не нашёл доказательства в разговоре',
  judge_unclear: 'судья не смог решить',
};
const GAP: Readonly<Record<AnalysisView['gaps'][number]['reason'], string>> = {
  unusable: 'работа Lab над правилами темы не завершилась',
  interrupted: 'разбор остановился, пока Lab искал правила темы',
  not_reached: 'разбор остановился раньше',
};
/** Why Lab's own work on a topic's plan did not finish: never the owner's rules. */
const ISSUE: Readonly<Record<PlanIssue, string>> = {
  answer_schema: 'ответы модели не прошли проверку формата',
  quote_not_verbatim: 'модель цитировала правила не дословно, и Lab не принял ни одного ответа',
  answer_check: 'ответы модели не прошли проверку Lab (вид правила, варианты или инструмент не сходятся)',
  context_window: 'разговоры темы вместе с материалами не поместились в окно модели',
  source_selection: 'Lab не смог выбрать статьи под эту тему',
  planner_unavailable: 'в этой среде нет модели, которая находит правила',
};

/** A topic with no plan, in the owner's words: whose it is — Lab's work, Lab's unconfirmed reading, or the owner's confirmed gap. */
export function gapLine(gap: AnalysisView['gaps'][number]): string {
  const size = countText(gap.conversations, CONVERSATIONS);
  if (gap.rulesGap?.confirmed) return `Тема «${gap.title}» (${size}): правила нет — ${gap.rulesGap.asks}. Проверяющий подтвердил, что в прочитанных материалах об этом не сказано.`;
  if (gap.rulesGap) return `Тема «${gap.title}» (${size}) не оценена: Lab не нашёл правила для запроса «${gap.rulesGap.asks}», но проверяющий не подтвердил, что его нет${gap.rulesGap.reason ? ` (${gap.rulesGap.reason})` : ''}. Это не пробел в ваших правилах.`;
  const why = gap.reason === 'unusable' ? gap.issue ? ISSUE[gap.issue] : GAP.unusable : GAP[gap.reason];
  return `Тема «${gap.title}» (${size}) не оценена: ${why}. Это работа Lab, а не ваши правила.`;
}
const UNFINISHED: Readonly<Record<NonNullable<AnalysisView['unfinished']>, string>> = {
  budget: 'кончился согласованный лимит вызовов модели',
  stopped: 'вы его остановили',
  time: 'кончилось отведённое время',
  closing: 'Pi закрылся',
  failed: 'произошла ошибка',
};

/** The violation in the owner's words: the rule's own description of it, or the duty that was not kept. */
export function problemTitle(problem: Pick<ProblemView, 'duty'>): string {
  const { duty } = problem;
  if (duty.violation) {
    const words = duty.violation.endsWith('.') ? duty.violation.slice(0, -1) : duty.violation;
    return words.charAt(0).toLocaleUpperCase('ru') + words.slice(1);
  }
  return duty.mustNot ? `Агент делает то, чего нельзя: ${duty.text}` : `Агент не выполняет: ${duty.text}`;
}

/** «5 из 12 разговоров, где правило проверено» — how often, among the conversations it was decided on. */
export function problemSize(problem: Pick<ProblemView, 'violations' | 'checked' | 'unknown'>): string {
  return `${problem.violations} из ${countText(problem.checked, OF_CONVERSATIONS)}, где правило проверено${problem.unknown ? `; ещё в ${countText(problem.unknown, IN_CONVERSATIONS)} не удалось оценить` : ''}`;
}

const ROLE: Readonly<Record<Example['quotes'][number]['role'], string>> = { customer: 'клиент', agent: 'агент', other: 'в разговоре' };
/** A logged conversation's lines at most on one screen; a longer one says how many more there are. */
const CONVERSATION_LINES = 80;

/**
 * A logged conversation whole, as the log holds it: every message and every recorded tool or state event, numbered by its
 * place in the log, the events the judge cited marked «→». What the owner opens from an example: the evidence's
 * surroundings, never a summary instead of them.
 */
export function conversationLines(dialogue: Pick<ImportBatch['dialogues'][number], 'events' | 'observation'>, cited: readonly number[] = []): string[] {
  const who = (event: ImportBatch['dialogues'][number]['events'][number]): string => {
    if (event.type === 'message') return event.role === 'user' ? 'клиент' : event.role === 'assistant' ? 'агент' : event.role === 'system' ? 'система' : 'инструмент';
    const tool = event.type === 'tool' ? (event.data as { tool?: unknown } | null)?.tool : undefined;
    return event.type === 'tool' ? `инструмент${typeof tool === 'string' ? ` ${tool}` : ''}` : event.type === 'state' ? 'состояние' : 'поиск';
  };
  const lines = dialogue.events.map(event => `${cited.includes(event.index) ? '→' : ' '} ${event.index}. ${who(event)}: ${clip(event.content ?? JSON.stringify(event.data), 400)}`);
  const shown = lines.slice(0, CONVERSATION_LINES);
  return [...shown, ...(lines.length > shown.length ? [`…и ещё ${lines.length - shown.length} — весь разговор в файле логов.`] : []),
    ...(dialogue.observation !== 'complete' ? ['Лог не помечает этот разговор полным: вызовы инструментов в нём могут быть записаны не все.'] : [])];
}
/** The owner's own word on an example, as the example says it. */
export const reviewWord = (review: Example['review']): string => review === 'confirmed' ? 'вы подтвердили' : review === 'disputed' ? 'вы оспорили' : review === 'unsure' ? 'вы не уверены' : '';

/** One example: the conversation and what was said in it, verbatim. */
export function exampleLine(example: Example): string {
  const said = example.quotes.slice(0, 3).map(quote => `${ROLE[quote.role]}: «${clip(quote.quote, 200)}»`).join(' → ');
  const absent = example.absent ? ` · в полном журнале нет вызова ${example.absent}: действие не выполнено` : '';
  const review = example.review ? ` · ${reviewWord(example.review)}` : '';
  return `Разговор ${example.dialogueId}${said ? `: ${said}` : ''}${absent}${review}`;
}

/**
 * The first line: how many of the selected conversations were processed, of how many in the log, and what it came to —
 * never «разобрано» for conversations the work did not reach.
 */
export function headline(view: AnalysisView): string {
  const { coverage } = view;
  if (view.status === 'running') return `Разбор идёт: ${view.message}`;
  const scope = coverage.processed === coverage.picked
    ? `Разобрано ${countText(coverage.processed, CONVERSATIONS)} из ${coverage.logged} в «${view.file}»`
    : `Разобрано ${coverage.processed} из ${countText(coverage.picked, OF_CONVERSATIONS)}, выбранных в «${view.file}» (в логе — ${coverage.logged})`;
  const found = view.problems.length ? `нарушений правил — ${view.problems.length}` : coverage.decided ? 'нарушений правил не найдено' : 'ни одно правило не удалось оценить';
  return `${scope}: ${found}.`;
}

/**
 * How the analysed conversations were chosen, as miner/sample.ts allocate chooses them: seats by each topic's share of
 * the read conversations, at most so many of one topic, the seats rounding leaves first to topics that got none —
 * or, with no topic map, the first ones of the log.
 */
export function pickedHow(coverage: Pick<AnalysisView['coverage'], 'method' | 'perTopic' | 'beyond'>): string {
  if (coverage.method === 'order') return 'темы не размечены, поэтому разобраны первые по порядку в логе';
  return coverage.beyond === 'shared' ? 'места делятся между темами по их доле среди прочитанных разговоров; места, оставшиеся после округления, получают сначала темы без единого места'
    : `места делятся между темами по их доле среди прочитанных разговоров, не больше ${coverage.perTopic} из одной темы; места, оставшиеся после округления, получают сначала темы без единого места`;
}

/** What was not analysed or not decided, and why — each part once. */
export function coverageLines(view: AnalysisView): string[] {
  const { coverage } = view;
  const unread = coverage.logged - coverage.readable;
  const rest = coverage.judgeable - coverage.picked;
  return [
    `Выбрано ${countText(coverage.picked, CONVERSATIONS)}; разобрано ${coverage.processed}; правила оценены в ${coverage.decided}${coverage.undecided ? `; в ${coverage.undecided} — ни одно не удалось оценить` : ''}${coverage.notReached ? `; до ${coverage.notReached} разбор не дошёл` : ''}.`,
    ...(coverage.sharedOnly ? [`В ${countText(coverage.sharedOnly, IN_CONVERSATIONS)} сверх ${coverage.perTopic} примеров, по которым Lab нашёл правила темы, проверены только общие правила темы — правила отдельных вариантов к ним не прикладывались.`] : []),
    ...(view.continues ? [`Это продолжение разбора ${view.continues.analysisId}: там было выбрано ${view.continues.picked}; ${countText(view.continues.reused, ['оценка перенесена', 'оценки перенесены', 'оценок перенесено'])} без вызова модели.`] : []),
    ...(view.undecided.length ? [`Не удалось оценить: ${view.undecided.map(item => `${UNDECIDED[item.reason]} — ${item.count}`).join(', ')}.`] : []),
    ...(rest > 0 ? [`Не разбирались ${countText(rest, CONVERSATIONS)}: ${pickedHow(coverage)}. Их можно разобрать продолжением — сделанное не оплачивается повторно.`] : []),
    ...(coverage.unjudgeable.length ? [`Нечего оценивать в ${countText(coverage.unjudgeable.reduce((sum, item) => sum + item.count, 0), IN_CONVERSATIONS)}: ${coverage.unjudgeable.map(item => `${item.reason === 'no_customer' ? 'нет реплики клиента' : 'нет ответа агента'} — ${item.count}`).join(', ')}.`] : []),
    ...(unread > 0 ? [`Не прочитаны ${countText(unread, CONVERSATIONS)} лога.`] : []),
  ];
}

/** Where the customers come with: every read conversation, apart from the violations. */
export function trafficLine(view: AnalysisView): string | undefined {
  if (!view.traffic?.length) return undefined;
  const topics = [...view.traffic].sort((a, b) => b.share - a.share).slice(0, 6).map(topic => `${topic.title} ${Math.round(topic.share * 100)}%`);
  return `С чем приходят клиенты (все ${view.coverage.readable}): ${topics.join(' · ')}${view.traffic.length > 6 ? ` · ещё ${view.traffic.length - 6}` : ''}.`;
}

/** What the answer does not say. */
export function limitLines(view: AnalysisView): string[] {
  return [
    'Частота — среди разобранных разговоров, где правило проверено; это не доля всего трафика и не доля клиентов.',
    'Оценено по правилам, которые вы дали сейчас; действовали ли они в дни этих разговоров, Lab не знает.',
    'Нет нарушения — значит, проверенные правила соблюдены; остальное в разговоре не проверялось.',
    'Слова агента о сделанном не доказывают действие: оно видно только в записанных событиях инструментов.',
    view.recorded?.length ? `Что вызова нет, Lab считает нарушением только для ${view.recorded.join(', ')} — вы подтвердили, что лог записывает каждый их вызов.`
      : 'Что лог записывает каждый вызов инструментов, не подтверждено: отсутствие вызова нигде не засчитано нарушением.',
    ...(view.mode === 'demo' ? ['Учебный пример: темы, правила и оценки — заготовки без модели; это не оценка модели.'] : []),
  ];
}

/** The whole answer as lines: the answer, the problems with their evidence, what held, the gaps, the limits, the next step. */
export function analysisLines(view: AnalysisView, options: { examples?: number; problems?: number } = {}): string[] {
  const examples = options.examples ?? 1;
  const shown = view.problems.slice(0, options.problems ?? 8);
  const lines = [headline(view)];
  if (view.status !== 'done' && view.status !== 'running') {
    lines.push(`Разбор не закончен: ${view.unfinished ? UNFINISHED[view.unfinished] : 'процесс Lab завершился раньше'}. Найденное ниже сохранено.`);
  }
  const traffic = trafficLine(view);
  if (traffic) lines.push(traffic);
  if (shown.length) {
    lines.push('', 'Нарушения правил:');
    shown.forEach((problem, index) => {
      lines.push(`${index + 1}. ${problemTitle(problem)} — ${problemSize(problem)}.`);
      for (const rule of problem.rules.slice(0, 2)) lines.push(`   Правило: «${clip(rule.quote, 240)}» — ${rule.source}.`);
      for (const example of problem.examples.slice(0, examples)) lines.push(`   ${exampleLine(example)}`);
      if (problem.disputed) lines.push(`   Вы оспорили — ${problem.disputed}; они не считаются.`);
    });
    if (view.problems.length > shown.length) lines.push(`…и ещё ${view.problems.length - shown.length}.`);
  }
  if (view.clean.length) lines.push('', `Без нарушений: ${view.clean.slice(0, 5).map(item => `«${clip(item.text, 120)}» — ${countText(item.checked, CONVERSATIONS)}${item.disputed ? ` (вы оспорили ${item.disputed} ${item.disputed === 1 ? 'вывод' : 'вывода'} судьи)` : ''}`).join('; ')}${view.clean.length > 5 ? `; ещё ${view.clean.length - 5}` : ''}.`);
  if (view.gaps.length) lines.push('', ...view.gaps.map(gapLine));
  lines.push('', ...coverageLines(view), ...limitLines(view));
  return lines;
}

/** The one useful next step, by what the analysis found. */
export function nextStep(view: AnalysisView): string {
  if (view.status === 'running') return 'Дождитесь конца разбора — итог придёт сам.';
  if (view.problems.length) return 'Дальше: откройте пример нарушения и скажите, прав ли судья, — или сделайте из него проверку для новой версии агента.';
  // Only a gap the reviewer confirmed is the owner's to fill; Lab's own unfinished work is repeated by a continuation.
  if (view.gaps.some(gap => gap.rulesGap?.confirmed)) return 'Дальше: допишите правило для темы, где проверяющий подтвердил, что правила нет.';
  if (view.gaps.length) return 'Дальше: продолжите разбор — Lab попробует снова темы, где его работа не завершилась; ваши правила менять не нужно.';
  return 'Дальше: продолжите разбор следующими разговорами или разберите другую выгрузку.';
}

/** A version as the owner reads it. */
const versionWord = (version: string | null): string => version ? `версии ${version}` : 'версии, которую агент не назвал';
const SITUATIONS_WITH: [string, string, string] = ['ситуации', 'ситуаций', 'ситуаций'];
const IN_SITUATIONS: [string, string, string] = ['ситуации', 'ситуациях', 'ситуациях'];
const IN_EXPECTATIONS: [string, string, string] = ['ожидании', 'ожиданиях', 'ожиданиях'];

const EXPECTATIONS: [string, string, string] = ['ожидание', 'ожидания', 'ожиданий'];
/** A run as the owner recognises it: when it was made and which version it tested. */
const runWord = (before: { createdAt: string; version: string | null }): string =>
  `прогона ${new Date(before.createdAt).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })} (${versionWord(before.version)})`;
/** An expectation of the rest by its situation: «№2 «…»: спросить номер терминала». */
const restItem = (item: { number: number; title: string; text: string }): string => `№${item.number} «${clip(item.title, 60)}»: ${clip(item.text, 100)}`;

/**
 * The problem's answer of a check made from a problem of the logs, in the owner's words: found in the logs, reproduced
 * (or not) on this version, fixed (or not, or broken beside it) against the run it repeats — each read off the one
 * expectation that is the problem's criterion. «Исправлено» only when the problem reproduced before in every chosen case,
 * the two runs compare and the agent answered otherwise; nothing at all when no situation carries the criterion.
 */
export function problemCheckLines(check: ProblemCheck): string[] {
  if (check.unbound) {
    return [`«${check.title}» — проверка не привязана к правилу проблемы: ${check.unbound === 'no_criterion' ? 'черновик собран до того, как Lab стал переносить правило проблемы в ситуации'
      : 'ни одна ситуация проверки не проверяет это правило в точности — его ожидание изменено или не попало в ситуацию'}. Найдена ли, воспроизведена ли и исправлена ли проблема, этот прогон не говорит. Соберите проверку из разбора заново.`];
  }
  const failed = check.broken.filter(item => item.outcome === 'fail').length;
  const { missing, changed } = check.unchecked;
  const reproduced = check.reproduced === 'yes'
    ? `Воспроизведена на ${versionWord(check.version)}: агент снова нарушил это правило в ${failed} из ${countText(check.broken.length, SITUATIONS_WITH)} с нарушением.`
    : check.reproduced === 'no'
      ? `На ${versionWord(check.version)} не воспроизведена: ${check.broken.length === 1 ? 'в единственной проверенной ситуации' : `во всех ${countText(check.broken.length, SITUATIONS_WITH)}`} с нарушением агент это правило выполнил.${check.before ? '' : ' Это ещё не «исправлено»: так можно сказать только против версии, где проблема воспроизводилась.'}`
      : `На ${versionWord(check.version)} измерить не удалось: ${check.broken.length ? 'правило в ситуациях с нарушением не оценено' : 'ситуаций из разговоров с нарушением в проверке нет'}.`;
  const beside = check.controls.filter(item => item.outcome === 'fail');
  const unmeasured = check.controls.filter(item => item.outcome === 'unknown');
  const lines = [`«${check.title}» — найдена в логах в ${countText(check.found, IN_CONVERSATIONS)}.`, reproduced,
    // Chosen cases the run checks nothing on: what passed is never read as every chosen case.
    ...(missing + changed ? [`Проверено ${check.found - missing - changed} из ${countText(check.found, OF_CONVERSATIONS)} с нарушением: ${[...missing ? [`для ${missing} ситуации в проверке нет`] : [], ...changed ? [`в ${changed} правило проблемы изменено или не попало в ситуацию`] : []].join(', ')} — про них проверка ничего не говорит, и успех остальных не означает успеха всех выбранных.`] : []),
    check.controls.length ? beside.length ? `Рядом не справился: ${beside.map(item => `№${item.number} «${clip(item.title, 80)}»`).join(', ')} — ситуации из разговоров, где агент в логах это правило соблюдал.`
      : `Ситуации из разговоров, где агент в логах это правило соблюдал: правило выполнено в ${check.controls.filter(item => item.outcome === 'pass').length} из ${check.controls.length}${unmeasured.length ? `, не измерено в ${unmeasured.length} — что там ничего не сломалось, не подтверждено` : ''}.`
    : check.controlConversations ? 'Ситуаций из разговоров, где это правило соблюдалось, в проверке нет: сломалось ли оно рядом, она не показывает.'
    : 'Разговоров, где это правило проверено и соблюдено, в разборе не было: сломалось ли оно рядом, эта проверка не показывает.'];
  const before = check.before;
  if (!before) return lines;
  const against = `против ${runWord(before)}`;
  lines.push(before.verdict === 'fixed' ? `Исправлено ${against}: там проблема воспроизводилась, здесь — нет, условия проверки те же${check.controls.length && !before.besideUnknown.length ? ', и в ситуациях, где это правило соблюдалось, оно не сломалось' : ''}.`
    : before.verdict === 'regressed' ? `Сломалось ${against}: ${before.regressed.map(title => `«${clip(title, 80)}»`).join(', ')} — там агент это правило выполнял. Исправление не принимается, пока это не починено.`
    : before.verdict === 'not_fixed' ? `Не исправлено ${against}: проблема воспроизводится по-прежнему.`
    : before.why === 'incomparable' ? `Сравнить ${against} нельзя: условия проверки изменились — ситуации, судья или клиент. Ни «исправлено», ни «сломалось» не доказано.`
    : before.why === 'not_reproduced_before' ? `«Исправлено» не доказано: ${against} проблема не воспроизводилась — сравните с версией, где она была.`
    : before.why === 'judge_only' ? `«Исправлено» не доказано ${against}: в ${countText(before.judgeOnly.length, IN_SITUATIONS)} агент ответил так же, как там, а судья решил иначе — разница в судье, не в агенте.`
    : before.why === 'partial' ? `«Исправлено» не доказано ${against} для всех выбранных: в проверенных проблема не воспроизводится, но не все выбранные проверены.`
    : `«Исправлено» не доказано ${against}: правило проблемы измерено не во всех ситуациях.`);
  if (before.besideUnknown.length && before.verdict === 'fixed') lines.push(`Что рядом ничего не сломалось, не подтверждено: в ${countText(before.besideUnknown.length, IN_SITUATIONS)}, где это правило соблюдалось, оно не измерено.`);
  return lines;
}

/**
 * The rest's answer of the same check: every other expectation of its situations — the other duties of the chosen ones
 * and the neighbours' —, apart from the problem. Against the run it repeats, only what passed there is a regression test,
 * what broke is named even when the problem is fixed, and what was not measured is said as not confirmed.
 */
export function restCheckLines(check: ProblemCheck): string[] {
  const { rest } = check;
  if (!rest.total) return ['Других обязательных ожиданий в проверке нет: что исправление не сломало остальное, она не показывает.'];
  const lines: string[] = [];
  const against = rest.against;
  if (!against) {
    lines.push(`${countText(rest.total, EXPECTATIONS)} других правил: выполнено ${rest.passed}, нарушено ${rest.failed}, не измерено ${rest.unknown}. Проверкой на регрессии для следующей версии станут только выполненные здесь — ${rest.passed}.`);
  } else if (!against.comparable) {
    lines.push(`${countText(rest.total, EXPECTATIONS)} других правил не сравнить с прогоном, который повторяет этот: условия проверки изменились. Поломки других правил не доказаны и не исключены.`);
  } else {
    lines.push(`Выполнялись там — ${countText(against.tests, EXPECTATIONS)} других правил, это проверка на регрессии: здесь выполнено ${against.held.length}, сломалось ${against.broken.length}, не измерено ${against.unknown.length}.`);
    if (against.broken.length) lines.push(`Сломалось: ${against.broken.slice(0, 4).map(restItem).join('; ')}${against.broken.length > 4 ? `; ещё ${against.broken.length - 4}` : ''}.`);
    if (against.unknown.length) lines.push(`Не подтверждено, что не сломалось: ${against.unknown.slice(0, 4).map(restItem).join('; ')}${against.unknown.length > 4 ? `; ещё ${against.unknown.length - 4}` : ''} — не измерено.`);
    if (against.judgeOnly.length) lines.push(`В ${countText(against.judgeOnly.length, IN_EXPECTATIONS)} ответы агента те же, а судья решил иначе — это не поломка агента.`);
    if (against.unconfirmed) lines.push(`Ещё ${countText(against.unconfirmed, EXPECTATIONS)} там ${pluralForm(against.unconfirmed, ['не выполнялось или не измерено', 'не выполнялись или не измерены', 'не выполнялись или не измерены'])} — в проверку на регрессии не ${pluralForm(against.unconfirmed, ['входит', 'входят', 'входят'])}.`);
    if (against.changed) lines.push(`${countText(against.changed, EXPECTATIONS)} ${pluralForm(against.changed, ['изменилось', 'изменились', 'изменились'])} с тех пор — не сравниваются.`);
  }
  if (rest.sameCriterion) lines.push(`${countText(rest.sameCriterion, EXPECTATIONS)} с правилом проблемы — в ситуациях не из выбранных для неё разговоров: контролем проблемы не считаются и в остальное не входят.`);
  return lines;
}

/** The one line that puts the two answers together: a local fix never hides what broke beside it. */
export function checkVerdictLine(check: ProblemCheck): string | undefined {
  const before = check.before;
  const against = check.rest.against;
  if (check.unbound || !before || !against) return undefined;
  if (!before.comparable || !against.comparable) return 'Итог: прогоны несравнимы — ни исправление, ни поломка не доказаны.';
  if (before.verdict === 'fixed' && against.broken.length) return `Итог: проблема исправлена локально, но сломалось другое обязательное — ${countText(against.broken.length, EXPECTATIONS)}. Такую версию принимать нельзя.`;
  if (before.verdict === 'fixed' && (against.unknown.length || before.besideUnknown.length)) return 'Итог: проблема исправлена; что ничего проверенного не сломалось, не подтверждено — часть не измерена.';
  if (before.verdict === 'fixed' && !against.tests) return 'Итог: проблема исправлена; других правил, выполнявшихся на прежней версии, в проверке нет — что ничего не сломалось, она не показывает.';
  if (before.verdict === 'fixed') return 'Итог: проблема исправлена, и ничего проверенного не сломалось.';
  if (against.broken.length) return `Итог: проблема не исправлена${before.verdict === 'regressed' ? ', и её правило сломалось там, где выполнялось' : ''}; сломалось и другое обязательное — ${countText(against.broken.length, EXPECTATIONS)}.`;
  return undefined;
}
