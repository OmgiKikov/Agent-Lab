import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describeCheck, type Experiment } from '../src/contracts.js';
import { situationViews, type SituationView } from '../src/card/view.js';
import { draftHash, type ExperimentLab } from '../src/experiment.js';
import { countText } from '../src/plural.js';
import { expectationSheet } from '../src/quality.js';
import { libraryHash } from '../src/scenario-library.js';
import { safeText } from '../src/text.js';
import { launchLines, scenarioPlan, type LaunchPlan } from './conversation.ts';
import { NeedsOwner } from './lab-ui.ts';

/*
 * One dialog starts a run, the same from the chat and from the board (ui-spec §4.6, the owner's decision of
 * 23.09): a draft of cards is accepted with its ready situations in the very dialog that starts it; a repeat
 * of an accepted set just starts; a draft of a record made before libraries confirms its expectations with the
 * run. The acceptance and the start stay two facts in the record. Questions never block the ready situations.
 */

/** The two answers of every run dialog. */
export const LAUNCH = 'Запустить', NOT_NOW = 'Не сейчас';

/** A real agent is independent per dialogue, so several run at once. */
export function runParallel(record: Experiment): number {
  return Math.max(1, Math.min(8, record.scenarios.length * record.settings.userModes.length * record.settings.repeats));
}

/**
 * What an older record's draft confirms with its run, in the owner's words. A set of more than one situation
 * leads with the compact expectation sheet (UI-D-04); a single test keeps its full definition. Confirming seals
 * `fingerprint(scenario)` for every card, so a set not built from logs also lists the opening request and the
 * exact checks: in a validation set those come from the logged dialogue itself.
 */
function runScope(record: Experiment): string[] {
  const sheet = record.workflow === 'evaluate' && record.phase === 'review' && record.scenarios.length > 1 ? expectationSheet(record) : undefined;
  if (sheet) {
    const fromLog = record.scenarios.every(scenario => scenario.provenance === 'production');
    const sealed = fromLog ? [] : record.scenarios.flatMap(s => [safeText(s.title), `  Запрос: ${safeText(s.user.opening)}`,
      ...s.checks.map(c => `  Проверка: ${safeText(describeCheck(c))}`)]);
    return [...(fromLog ? ['Клиента играет Lab: на уточнения агента он отвечает только фактами из лога.', ''] : []),
      ...sheet.compactLines(record.id).map(item => safeText(item)),
      ...(sealed.length ? ['', 'Что вы подтверждаете дословно:', ...sealed] : [])];
  }
  return record.scenarios.map(s => [safeText(s.title), `  Запрос: ${safeText(s.user.opening)}`,
    ...(record.settings.userModes.includes('scripted') ? (s.user.script ?? []).map((message, i) => `  Продолжение ${i + 1}: ${safeText(message)}`) : []),
    `  Ожидается: ${safeText(s.successCriteria)}`, ...s.checks.map(c => `  Проверка: ${safeText(describeCheck(c))}`)].join('\n'));
}

/** The plan of a run of the situations a record already holds: a repeat of an accepted set, or an older record's draft with its expectations first. */
export function runPlan(record: Experiment, cwd?: string): string {
  const scope = record.librarySnapshot ? [] : runScope(record);
  const confirmed = !!record.librarySnapshot || record.acceptedDraftHash === draftHash(record);
  return [...scope, ...(scope.length ? [''] : []), ...launchLines(record, scenarioPlan(record), cwd).map(line => safeText(line)),
    ...(confirmed ? [] : ['Запуск подтверждает ожидания ситуаций выше. Оценки судьи вы не проверяли.'])].join('\n');
}

/** The plan of a card draft's run: its ready situations; the ones waiting for the owner, unusable or unchecked stay out. */
export function cardPlan(record: Experiment, views: readonly SituationView[]): LaunchPlan {
  const ready = views.filter(view => view.status === 'ready');
  const attempts = record.settings.repeats * record.settings.userModes.filter(mode => mode !== 'scripted').length;
  const count = (status: SituationView['status']) => views.filter(view => view.status === status).length;
  const outside = [
    ...(count('needs_owner') ? [countText(count('needs_owner'), ['ждёт вашего ответа', 'ждут вашего ответа', 'ждут вашего ответа'])] : []),
    ...(count('unusable') ? [`${count('unusable')} не подходит для теста`] : []),
    ...(count('checking') ? [countText(count('checking'), ['ещё не проверена', 'ещё не проверены', 'ещё не проверены'])] : []),
  ].join(' · ');
  return { situations: ready.length, conversations: ready.length * attempts, judgePerAttempt: 2 * Math.max(0, ...ready.map(view => view.brief.must.length)),
    judgeCalls: 2 * attempts * ready.reduce((sum, view) => sum + view.brief.must.length, 0), outside: outside || null };
}

const SITUATIONS: [string, string, string] = ['ситуацию', 'ситуации', 'ситуаций'];

/**
 * Asks the owner and starts the run of a draft; undefined when they said «Не сейчас». A card draft is accepted in
 * the same dialog; its situations that are not ready stay out and wait for the owner.
 */
export async function launchRun(ctx: ExtensionContext, lab: ExperimentLab, draft: Experiment, cwd = ctx.cwd): Promise<Experiment | undefined> {
  const library = draft.librarySnapshot;
  if (library?.formatVersion === 2 && !library.acceptance) {
    const context = await lab.cardContext(draft.id);
    const views = situationViews(context.experiment, { evidence: context.evidence, numbers: context.numbers, maxTurns: context.experiment.settings.maxTurns });
    const ready = views.filter(view => view.status === 'ready');
    if (!ready.length) throw new NeedsOwner('needs_owner_input', 'Запускать нечего: ни одна ситуация не готова. Покажите владельцу вопросы по ситуациям — ответ делает ситуацию готовой.');
    const lines = launchLines(context.experiment, cardPlan(context.experiment, views), cwd);
    const picked = await ctx.ui.select(safeText([`Принять ${countText(ready.length, SITUATIONS)} и запустить?`, '', ...lines, '',
      'Вместе с запуском Lab утвердит эти ситуации — повтор пойдёт по ним же.'].join('\n')), [LAUNCH, NOT_NOW]);
    if (picked !== LAUNCH) return undefined;
    const { experiment } = await lab.acceptCards(draft.id, libraryHash(context.library), ready.map(view => view.id));
    return lab.start(draft.id, { approved: true, reviewer: 'expectations', expectedHash: draftHash(experiment), parallel: runParallel(experiment), requireAccepted: true });
  }
  if (library && !library.acceptance) throw new NeedsOwner('needs_owner_input', 'Это черновик старого формата: его ситуации можно посмотреть, но не утвердить. Подготовьте ситуации заново.');
  const hash = draftHash(draft);
  const confirmed = draft.acceptedDraftHash === hash;
  const picked = await ctx.ui.select(safeText([library || confirmed ? 'Запустить прогон?' : 'Подтвердить ожидания и запустить?', '', runPlan(draft, cwd)].join('\n')), [LAUNCH, NOT_NOW]);
  if (picked !== LAUNCH) return undefined;
  if (!confirmed) await lab.acceptDraft(draft.id, hash);
  return lab.start(draft.id, { approved: true, reviewer: 'expectations', expectedHash: hash, parallel: runParallel(draft), requireAccepted: true });
}
