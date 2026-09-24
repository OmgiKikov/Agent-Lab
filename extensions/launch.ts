import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describeCheck, type Experiment } from '../src/contracts.js';
import { situationViews, type SituationView } from '../src/card/view.js';
import { detectProject, evidenceText, targetLabel, type AgentCandidate } from '../src/detect.js';
import { draftHash, type ExperimentLab } from '../src/experiment.js';
import { countText } from '../src/plural.js';
import { expectationSheet } from '../src/quality.js';
import { libraryHash } from '../src/scenario-library.js';
import { safeText } from '../src/text.js';
import { launchLines, scenarioPlan, type LaunchPlan } from './conversation.ts';
import { NeedsOwner } from './lab-ui.ts';

/*
 * One dialog starts a run, the same from the chat and from the workspace (ui-spec §4.6, the owner's decision of
 * 23.09): a draft of cards is accepted with its ready situations in the very dialog that starts it; a repeat of an
 * accepted set just starts; a draft of a record made before libraries confirms its expectations with the run. The
 * acceptance and the start stay two facts in the record. Questions never block the ready situations.
 *
 * Situations may be prepared before the agent is connected: then the connection is asked for right before this
 * dialog — Lab proposes what it found in the project folder, the owner picks, nothing runs until the dialog.
 */

/** The two answers of every run dialog. */
export const LAUNCH = 'Запустить', NOT_NOW = 'Не сейчас';

/** A real agent is independent per dialogue, so several run at once. */
export function runParallel(record: Experiment): number {
  return Math.max(1, Math.min(8, record.scenarios.length * record.settings.userModes.length * record.settings.repeats));
}

/**
 * What an older record's draft confirms with its run, in the owner's words. A set of more than one situation
 * leads with the compact expectation sheet; a single test keeps its full definition. Confirming seals
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
      ...sheet.compactLines().map(item => safeText(item)),
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
/** How many ways to start the agent the connection question offers. */
const OFFERED = 3;
const NO_AGENT = 'Агент ещё не подключён, а в папке проекта Lab не нашёл, как его запускать.';

/** A way to start the agent as the owner picks it: how it starts, and what in the folder says so. */
function candidateLabel(candidate: AgentCandidate, root: string): string {
  return safeText(`${targetLabel(candidate.target, root)}${candidate.evidence[0] ? ` — ${evidenceText(candidate.evidence[0])}` : ''}`);
}

/**
 * The connection of a draft whose situations were prepared before the agent was connected: Lab proposes the ways to
 * start it that it found in the project folder (read-only: nothing is run or imported), the owner picks one, and the
 * draft is connected — checked and fingerprinted — before the run dialog. Undefined when the owner stepped back.
 */
export async function connectAgent(ctx: ExtensionContext, lab: ExperimentLab, draft: Experiment, cwd = ctx.cwd): Promise<Experiment | undefined> {
  const found = await detectProject(cwd).then(detection => detection.agents.slice(0, OFFERED), () => []);
  if (!found.length) throw new NeedsOwner('needs_owner_input', `${NO_AGENT} Спросите владельца, как его запускать (команда, файл модуля или адрес), подключите через agent_lab_edit (target) и снова вызовите agent_lab_run.`, [],
    `${NO_AGENT} Как его запускать — команда, файл модуля или адрес?`);
  const labels = found.map(candidate => candidateLabel(candidate, cwd));
  const picked = await ctx.ui.select(safeText(['Как запустить агента?', '', 'Ситуации готовы, а агент ещё не подключён. Lab нашёл в папке проекта — ничего не запускал и не менял:'].join('\n')),
    [...labels, NOT_NOW]);
  const chosen = found[labels.indexOf(picked ?? '')];
  if (!chosen) return undefined;
  return lab.updateDraft(draft.id, draftHash(draft), { target: chosen.target });
}

/**
 * Asks the owner and starts the run of a draft; undefined when they said «Не сейчас». A card draft is accepted in
 * the same dialog; its situations that are not ready stay out and wait for the owner. A draft without a connected
 * agent is connected first.
 */
export async function launchRun(ctx: ExtensionContext, lab: ExperimentLab, start: Experiment, cwd = ctx.cwd): Promise<Experiment | undefined> {
  const draft = start.target.kind === 'unconnected' ? await connectAgent(ctx, lab, start, cwd) : start;
  if (!draft) return undefined;
  const library = draft.librarySnapshot;
  if (library?.formatVersion === 2 && !library.acceptance) {
    const context = await lab.cardContext(draft.id);
    const views = situationViews(context.experiment, { evidence: context.evidence, numbers: context.numbers, maxTurns: context.experiment.settings.maxTurns });
    const ready = views.filter(view => view.status === 'ready');
    if (!ready.length) throw new NeedsOwner('needs_owner_input', 'Запускать нечего: ни одна ситуация не готова. Покажите владельцу вопросы по ситуациям — ответ делает ситуацию готовой.', [],
      'Запускать нечего: ни одна ситуация ещё не готова — ответьте на их вопросы.');
    const lines = launchLines(context.experiment, cardPlan(context.experiment, views), cwd);
    const picked = await ctx.ui.select(safeText([`Принять ${countText(ready.length, SITUATIONS)} и запустить?`, '', ...lines,
      'Вместе с запуском Lab утвердит эти ситуации — повтор пойдёт по ним же.'].join('\n')), [LAUNCH, NOT_NOW]);
    if (picked !== LAUNCH) return undefined;
    const { experiment } = await lab.acceptCards(draft.id, libraryHash(context.library), ready.map(view => view.id));
    return lab.start(draft.id, { approved: true, reviewer: 'expectations', expectedHash: draftHash(experiment), parallel: runParallel(experiment), requireAccepted: true });
  }
  if (library && !library.acceptance) throw new NeedsOwner('needs_owner_input', 'Это черновик старого формата: его ситуации можно посмотреть, но не утвердить. Предложите владельцу продолжить их в новом формате (agent_lab_card_convert).', [],
    'Это черновик старого формата: его ситуации нельзя утвердить. Их можно продолжить в новом формате — старый черновик останется как есть.');
  const hash = draftHash(draft);
  const confirmed = draft.acceptedDraftHash === hash;
  const picked = await ctx.ui.select(safeText([library || confirmed ? 'Запустить прогон?' : 'Подтвердить ожидания и запустить?', '', runPlan(draft, cwd)].join('\n')), [LAUNCH, NOT_NOW]);
  if (picked !== LAUNCH) return undefined;
  if (!confirmed) await lab.acceptDraft(draft.id, hash);
  return lab.start(draft.id, { approved: true, reviewer: 'expectations', expectedHash: hash, parallel: runParallel(draft), requireAccepted: true });
}
