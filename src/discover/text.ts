import type { LogUndecided } from '../card/log-judge.js';
import { countText } from '../plural.js';
import { clip } from '../text.js';
import type { AnalysisView, Example, ProblemView } from './view.js';
import type { ProblemCheck } from './check.js';

/*
 * The words of a log analysis (DISCOVER), in one place: the chat, the board and the command line lay out these lines and
 * never word the result on their own. The answer comes first — what was analysed and what is broken — and the limits of
 * the answer after it, each said once.
 */

const CONVERSATIONS: [string, string, string] = ['разговор', 'разговора', 'разговоров'];
const OF_CONVERSATIONS: [string, string, string] = ['разговора', 'разговоров', 'разговоров'];
const IN_CONVERSATIONS: [string, string, string] = ['разговоре', 'разговорах', 'разговорах'];

const UNDECIDED: Readonly<Record<LogUndecided, string>> = {
  no_agent_reply: 'агент в разговоре не ответил',
  channel_unobserved: 'действия агента в логе не записаны',
  not_exercised_in_log: 'разговор не дошёл до правила',
  judge_failed: 'судья не дал ответа',
  judge_split: 'два голоса судьи разошлись',
  no_evidence: 'судья не нашёл доказательства в разговоре',
  judge_unclear: 'судья не смог решить',
};
const GAP: Readonly<Record<AnalysisView['gaps'][number]['reason'], string>> = {
  unusable: 'Lab не нашёл в ваших правилах, что должен агент в этой теме',
  interrupted: 'разбор остановился, пока Lab искал правила темы',
  not_reached: 'разбор остановился раньше',
};
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
/** One example: the conversation and what was said in it, verbatim. */
export function exampleLine(example: Example): string {
  const said = example.quotes.slice(0, 3).map(quote => `${ROLE[quote.role]}: «${clip(quote.quote, 200)}»`).join(' → ');
  const review = example.review === 'confirmed' ? ' · вы подтвердили' : example.review === 'disputed' ? ' · вы оспорили' : example.review === 'unsure' ? ' · вы не уверены' : '';
  return `Разговор ${example.dialogueId}${said ? `: ${said}` : ''}${review}`;
}

/** The first line: what was analysed and what it came to. */
export function headline(view: AnalysisView): string {
  const { coverage } = view;
  if (view.status === 'running') return `Разбор идёт: ${view.message}`;
  const scope = `Разобрано ${countText(coverage.picked, CONVERSATIONS)} из ${coverage.logged} в «${view.file}»`;
  const found = view.problems.length ? `нарушений правил — ${view.problems.length}` : coverage.decided ? 'нарушений правил не найдено' : 'ни одно правило не удалось оценить';
  return `${scope}: ${found}.`;
}

/**
 * How the analysed conversations were chosen, as miner/sample.ts allocate chooses them: seats by each topic's share of
 * the read conversations, at most so many of one topic, the seats rounding leaves first to topics that got none —
 * or, with no topic map, the first ones of the log.
 */
export function pickedHow(coverage: Pick<AnalysisView['coverage'], 'method' | 'perTopic'>): string {
  return coverage.method === 'order' ? 'темы не размечены, поэтому разобраны первые по порядку в логе'
    : `места делятся между темами по их доле среди прочитанных разговоров, не больше ${coverage.perTopic} из одной темы; места, оставшиеся после округления, получают сначала темы без единого места`;
}

/** What was not analysed or not decided, and why — each part once. */
export function coverageLines(view: AnalysisView): string[] {
  const { coverage } = view;
  const unread = coverage.logged - coverage.readable;
  const rest = coverage.judgeable - coverage.picked;
  return [
    `Правила оценены в ${countText(coverage.decided, IN_CONVERSATIONS)} из ${coverage.picked}${coverage.undecided ? `; в ${coverage.undecided} — ни одно не удалось оценить` : ''}${coverage.notReached ? `; до ${coverage.notReached} разбор не дошёл` : ''}.`,
    ...(view.undecided.length ? [`Не удалось оценить: ${view.undecided.map(item => `${UNDECIDED[item.reason]} — ${item.count}`).join(', ')}.`] : []),
    ...(rest > 0 ? [`Не разбирались ${countText(rest, CONVERSATIONS)}: ${pickedHow(coverage)}.`] : []),
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
    'Частота — среди разобранных разговоров, где правило проверено; это не доля всего трафика.',
    'Оценено по правилам, которые вы дали сейчас; действовали ли они в дни этих разговоров, Lab не знает.',
    'Нет нарушения — значит, проверенные правила соблюдены; остальное в разговоре не проверялось.',
    'Слова агента о сделанном не доказывают действие: оно видно только в записанных событиях инструментов.',
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
  if (view.gaps.length) lines.push('', ...view.gaps.map(gap => `Тема «${gap.title}» не оценена: ${GAP[gap.reason]} (${countText(gap.conversations, CONVERSATIONS)}).`));
  lines.push('', ...coverageLines(view), ...limitLines(view));
  return lines;
}

/** The one useful next step, by what the analysis found. */
export function nextStep(view: AnalysisView): string {
  if (view.status === 'running') return 'Дождитесь конца разбора — итог придёт сам.';
  if (view.problems.length) return 'Дальше: откройте пример нарушения и скажите, прав ли судья, — или сделайте из него проверку для новой версии агента.';
  if (view.gaps.some(gap => gap.reason === 'unusable')) return 'Дальше: допишите правила для тем, которые Lab не смог оценить.';
  return 'Дальше: разберите больше разговоров или другую выгрузку.';
}

/** A version as the owner reads it. */
const versionWord = (version: string | null): string => version ? `версии ${version}` : 'версии, которую агент не назвал';
const SITUATIONS_WITH: [string, string, string] = ['ситуации', 'ситуаций', 'ситуаций'];

/**
 * The three facts of a check made from a problem of the logs, in the owner's words: found in the logs, reproduced (or
 * not) on this version, fixed (or not, or broken beside it) against the run it repeats — each read off the one
 * expectation that is the problem's criterion. «Исправлено» only when the problem reproduced before and the two runs
 * compare; nothing at all when no situation carries the criterion.
 */
export function problemCheckLines(check: ProblemCheck): string[] {
  if (check.unbound) {
    return [`«${check.title}» — проверка не привязана к правилу проблемы: ${check.unbound === 'no_criterion' ? 'черновик собран до того, как Lab стал переносить правило проблемы в ситуации'
      : 'ни одна ситуация проверки не проверяет это правило в точности — его ожидание изменено или не попало в ситуацию'}. Найдена ли, воспроизведена ли и исправлена ли проблема, этот прогон не говорит. Соберите проверку из разбора заново.`];
  }
  const failed = check.broken.filter(item => item.outcome === 'fail').length;
  const reproduced = check.reproduced === 'yes'
    ? `Воспроизведена на ${versionWord(check.version)}: агент снова нарушил это правило в ${failed} из ${countText(check.broken.length, SITUATIONS_WITH)} с нарушением.`
    : check.reproduced === 'no'
      ? `На ${versionWord(check.version)} не воспроизведена: ${check.broken.length === 1 ? 'в единственной ситуации' : `во всех ${countText(check.broken.length, SITUATIONS_WITH)}`} с нарушением агент это правило выполнил.${check.before ? '' : ' Это ещё не «исправлено»: так можно сказать только против версии, где проблема воспроизводилась.'}`
      : `На ${versionWord(check.version)} измерить не удалось: ${check.broken.length ? 'правило в ситуациях с нарушением не оценено' : 'ситуаций из разговоров с нарушением в проверке нет'}.`;
  const beside = check.controls.filter(item => item.outcome === 'fail');
  const lines = [`«${check.title}» — найдена в логах в ${countText(check.found, IN_CONVERSATIONS)}.`, reproduced,
    check.controls.length ? beside.length ? `Рядом не справился: ${beside.map(item => `№${item.number} «${clip(item.title, 80)}»`).join(', ')} — ситуации из разговоров, где агент в логах это правило соблюдал.`
      : `Ситуации из разговоров, где агент в логах это правило соблюдал: правило выполнено в ${check.controls.filter(item => item.outcome === 'pass').length} из ${check.controls.length}.`
    : check.controlConversations ? 'Ситуаций из разговоров, где правило соблюдалось, в проверке нет: сломалось ли что-то рядом, она не показывает.'
    : 'Разговоров, где это правило проверено и соблюдено, в разборе не было: сломалось ли что-то рядом, эта проверка не показывает.',
    ...(check.uncarried ? [`${countText(check.uncarried, ['ситуация', 'ситуации', 'ситуаций'])} этой проверки не ${check.uncarried === 1 ? 'проверяет' : 'проверяют'} правило проблемы в точности — ${check.uncarried === 1 ? 'она не считается' : 'они не считаются'}.`] : [])];
  const before = check.before;
  if (!before) return lines;
  const against = `против прогона ${new Date(before.createdAt).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })} (${versionWord(before.version)})`;
  lines.push(before.verdict === 'fixed' ? `Исправлено ${against}: там проблема воспроизводилась, здесь — нет, условия проверки те же${check.controls.length ? ', и рядом ничего не сломалось' : ''}.`
    : before.verdict === 'regressed' ? `Сломалось ${against}: ${before.regressed.map(title => `«${clip(title, 80)}»`).join(', ')} — там агент это правило выполнял. Исправление не принимается, пока это не починено.`
    : before.verdict === 'not_fixed' ? `Не исправлено ${against}: проблема воспроизводится по-прежнему.`
    : before.why === 'incomparable' ? `Сравнить ${against} нельзя: условия проверки изменились — ситуации, судья или клиент. «Исправлено» не доказано.`
    : before.why === 'not_reproduced_before' ? `«Исправлено» не доказано: ${against} проблема не воспроизводилась — сравните с версией, где она была.`
    : `«Исправлено» не доказано ${against}: правило проблемы измерено не во всех ситуациях.`);
  return lines;
}
