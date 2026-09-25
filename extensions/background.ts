import type { ExtensionAPI, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { Loader } from '@earendil-works/pi-tui';
import type { Experiment } from '../src/contracts.js';
import type { ExperimentLab } from '../src/experiment.js';
import { countsText, situationViews } from '../src/card/view.js';
import { countText } from '../src/plural.js';
import { plannedTrials } from '../src/run.js';
import { safeText } from '../src/text.js';
import { progressText, row, runStamp, stoppedLines } from './conversation.ts';
import { ActionBlock, ActionBody, ActionHead, expandHint, feedFor, feedTone, isFeedDetails, lineBody, rememberFeed, type Feed } from './render/feed.ts';
import { isVerdictDetails, renderAgentLabResult } from './render/verdict-block.ts';
import type { Tone } from './render/theme.ts';
import { inputError, legacyResult, recordErrorText, stoppedByOwner } from './lab-ui.ts';
import type { LabLease, Presentation, SessionOperation, SessionOperations } from './operations.ts';
import { situationItem, situationOutput, situationsOutput } from './model-output.ts';
import { situationFeed, situationsFeed } from './situation-tools.ts';

/*
 * Long work never holds the conversation (quality bar 5): a run, a preparation and a check of changed situations
 * belong to the Pi session, not to the row or the workspace that started them. While they go, one row above the
 * input says how far they got — Pi's spinner and a line from the record, redrawn at each change the work reports —
 * and the status bar says the same; their result arrives as a message drawn like any action: «● Прогон завершён»
 * and its summary. When Pi replaces the session (/new, /resume, /fork, /reload), the work goes on and the next
 * session takes it over (operations.ts): its row and its result move there.
 */

export const RUN_MESSAGE = 'agent-lab-run';
export const CHECK_MESSAGE = 'agent-lab-check';
export const BUILD_MESSAGE = 'agent-lab-build';
/** The head of each message when its feed does not name one. */
const MESSAGE_TITLE: Record<string, string> = { [RUN_MESSAGE]: 'Прогон завершён', [CHECK_MESSAGE]: 'Проверка ситуаций', [BUILD_MESSAGE]: 'Ситуации готовы' };
/** How to stop long work: in words, since Esc interrupts only the current action. */
export const STOP_HINT = 'остановить — напишите «стоп»';
const CONVERSATIONS_OF: [string, string, string] = ['разговора', 'разговоров', 'разговоров'];

/** What a finished preparation answers with: the model's JSON and the situations found. */
export type Prepared = { output: Record<string, unknown>; feed?: Feed; note?: string };

/**
 * The one row of long work above the input (docs/design/ui-spec.md §4.6): Pi's `Loader` with a line from the running record and
 * how to stop it; the status bar carries the same line without the hint.
 */
export class ProgressRow {
  private loader?: Loader;
  private text = '';
  constructor(private readonly ctx: Pick<ExtensionContext, 'ui'>, private readonly key: string, private readonly hint?: string) {}
  private line(): string { return safeText(this.hint ? `${this.text} · ${this.hint}` : this.text); }
  show(text: string): void {
    if (text === this.text && this.loader) return;
    this.text = text;
    this.ctx.ui.setStatus?.('agent-lab-progress', safeText(text));
    if (this.loader) { this.loader.setMessage(this.line()); return; }
    this.ctx.ui.setWidget?.(this.key, (tui, theme) => {
      const loader = new Loader(tui, spin => theme.fg('accent', spin), message => theme.fg('muted', message), this.line());
      this.loader = loader;
      return Object.assign(loader, { dispose: () => { loader.stop(); if (this.loader === loader) this.loader = undefined; } });
    });
  }
  clear(): void {
    this.ctx.ui.setStatus?.('agent-lab-progress', undefined);
    this.ctx.ui.setWidget?.(this.key, undefined);
    this.loader?.stop();
    this.loader = undefined;
  }
}

/** A result that arrived as a message, drawn like the row of an action: its head and its summary. */
export function messageBlock(kind: string, message: { content: unknown; details?: unknown }, expanded: boolean, theme: Theme): ActionBlock {
  const details: unknown = message.details;
  const feed = isFeedDetails(details) ? feedFor(details) : null;
  let tone: Tone = feed ? feedTone(feed) : 'success';
  const content = typeof message.content === 'string' ? message.content : '';
  // A reopened session keeps only the note of the message: its row says so instead of guessing how the work ended.
  const forgotten = !feed && isFeedDetails(details);
  const body = feed ? new ActionBody(feed, expanded, theme, expandHint)
    : forgotten ? (tone = 'muted', lineBody('Сессия открыта заново — попросите показать это ещё раз.', 'muted', theme))
      : renderAgentLabResult({ content: [{ type: 'text', text: content }], details }, { expanded, isPartial: false }, theme, legacyResult, own => { tone = own; });
  const title = feed?.title ?? (forgotten && isFeedDetails(details) ? safeText(details.note) : isVerdictDetails(details) ? MESSAGE_TITLE[RUN_MESSAGE]! : MESSAGE_TITLE[kind] ?? 'Agent Lab');
  return new ActionBlock(new ActionHead(title, theme, () => tone), body);
}

export function registerMessageRenderers(pi: ExtensionAPI): void {
  for (const kind of [RUN_MESSAGE, CHECK_MESSAGE, BUILD_MESSAGE]) pi.registerMessageRenderer?.(kind, (message, options, theme) => messageBlock(kind, message, options.expanded, theme));
}

/** The situations of a card record with their status now: the draft's cards read against its imports. */
async function viewsOf(lab: ExperimentLab, record: Experiment) {
  const context = await lab.cardContext(record.id);
  return { context, views: situationViews(context.experiment, { evidence: context.evidence, numbers: context.numbers, maxTurns: context.experiment.settings.maxTurns }) };
}

/**
 * The answer of a preparation that has ended, in the row of its call or as the message of one that outlived it:
 * the situations found — how many are ready, the first question, the coverage of the logs' topics — and that the
 * agent did not run; every situation on expand.
 */
export async function preparedAnswer(lab: ExperimentLab, record: Experiment, interrupted: boolean): Promise<Prepared> {
  const note = `Ситуации · ${runStamp(record)}`;
  if (record.librarySnapshot?.formatVersion !== 2 || record.phase !== 'review') {
    // Named as what it was — a preparation, not a run —, why it stopped and the way on; nothing is ready to run.
    const reason = recordErrorText(record.error);
    const rows = [row(reason ? `Подготовка ситуаций не завершена: ${reason}` : 'Подготовка ситуаций не завершена: причина не записана.', 'warning', true),
      row(record.phase === 'cancelled' ? 'Ситуаций нет. Скажите «подготовь ситуации», когда захотите начать заново.'
        : 'Ситуаций нет, агент не запускался. Когда причина устранена, скажите «подготовь ситуации» ещё раз.', 'muted')];
    return { output: { run: record.id, prepared: false, situations: 0, error: reason ?? null,
      instruction: 'The preparation ended without situations: nothing can run yet. Tell the owner in one or two sentences why, as error says, and what fixes it; then offer to prepare again.' },
    feed: { title: 'Подготовка не завершена', tone: 'warning', rows }, note };
  }
  const { context, views } = await viewsOf(lab, record);
  const ready = views.filter(view => view.status === 'ready').length;
  const unconnected = context.experiment.target.kind === 'unconnected';
  // The first number should not wait for every question: what is ready can run now.
  const next = interrupted ? 'Подготовка прервана; собранное сохранено — её можно продолжить.'
    : !ready ? 'Готовых пока нет: ответ на вопрос ситуации делает её готовой.'
      : unconnected ? 'Готовые можно запускать — перед запуском Lab спросит, как подключить агента.' : 'Готовые можно запустить сразу — скажите «запусти»; вопросы подождут.';
  const feed = situationsFeed(context.experiment, views, false, { library: context.library, evidence: context.evidence }, next);
  feed.title = interrupted ? 'Подготовка остановлена' : 'Ситуации готовы';
  if (interrupted) feed.tone = 'warning';
  return { output: situationsOutput(context.experiment, views, { ...(unconnected ? { agentConnected: false } : {}), ...(interrupted ? { interrupted: true } : {}) }), feed, note };
}

/** The result of a finished run for the chat: the model's content and the details its block is drawn from. */
export type VerdictOutput = (record: Experiment, lab: ExperimentLab) => Promise<{ output: unknown; details: unknown }>;

/**
 * The answer of a run that has ended — one for the row of its call and for the message of a run that outlived it. A
 * run that reached its result answers with it. One that did not never reads as «no data»: the owner is told what
 * stopped it — their stop, the time or the call limit, the judge, the release hook — what was saved, and the way on,
 * and the model is told no accuracy was shown.
 */
export async function runAnswer(record: Experiment, lab: ExperimentLab, verdictOutput: VerdictOutput): Promise<{ output: unknown; details: unknown }> {
  if (record.phase === 'results_review' || record.phase === 'complete') return verdictOutput(record, lab);
  const reason = recordErrorText(record.error);
  // Stopped by the owner or by closing Pi: what was saved and that it runs again from the start. Anything else cut it short.
  const stopped = record.phase === 'cancelled';
  const lines = stopped ? [...stoppedLines(record), ...(reason && !stoppedByOwner(record.error) ? [reason] : [])]
    : [`Прогон прервался до результата: ${reason ?? 'причина не записана.'}`,
      `Записано ${record.trials.length} из ${countText(plannedTrials(record), CONVERSATIONS_OF)}; точность не посчитана.`,
      'Когда причина устранена, «повтори прогон» запустит его заново.'];
  return {
    output: { run: record.id, result: null, [stopped ? 'stopped' : 'failed']: true, reason: reason ?? null, saved: record.trials.length, planned: plannedTrials(record),
      instruction: 'The run ended without a result: no accuracy was shown. Tell the owner in one or two sentences what stopped it and what was saved, and offer to run it again once the cause is fixed.' },
    details: rememberFeed(`run:${record.id}:${record.updatedAt}`, { title: stopped ? 'Прогон остановлен' : 'Прогон прервался', tone: 'warning',
      rows: lines.map((line, index) => row(line, index ? 'muted' : 'warning', !index)) }, `Прогон · ${runStamp(record)}`),
  };
}

export interface BackgroundHost {
  operations: SessionOperations;
  /** The result of a finished run: the model's JSON and the details its block is drawn from. */
  verdictOutput: VerdictOutput;
  /** Hands the model the tools of the step the records of `directory` are at now: long work that ends may move the project to the next step. */
  refresh(directory: string): Promise<void>;
}

/** The words for work that went on in another session of this Pi, when this session takes it over. */
const CONTINUES: Record<SessionOperation['kind'], string> = {
  run: 'Прогон продолжается — итог придёт сюда сообщением.',
  preparation: 'Подготовка ситуаций продолжается — ситуации придут сюда сообщением.',
  assessment: 'Проверка ситуаций продолжается — итог придёт сюда сообщением.',
};

/** The session's hand-overs of long work: a run or a preparation that outlives its row, a check of changed situations. */
export class Background {
  constructor(private readonly pi: ExtensionAPI, private readonly host: BackgroundHost) {}

  /**
   * A started run or preparation belongs to the Pi session: the conversation stays free, the row above the input
   * follows the running record, and the result arrives as a message. Quitting Pi still ends the work it owns.
   */
  detach(ctx: ExtensionContext, owned: LabLease, id: string, origin: SessionOperation['origin'], prepared?: (finished: Experiment) => Promise<Prepared>): SessionOperation {
    return this.host.operations.present(owned, this.workPresentation(ctx, owned, id, origin, prepared));
  }

  /** A preparation continued in the background: its situations arrive as a message. */
  preparation(ctx: ExtensionContext, owned: LabLease, id: string): void {
    this.detach(ctx, owned, id, 'chat', finished => preparedAnswer(owned.lab, finished, !!finished.error));
  }

  /**
   * A check of changed situations too long for the row of its command. The conversation goes on; the outcome
   * arrives as a message — quietly when the situation is ready, with a turn when the owner has something to decide.
   */
  check(ctx: ExtensionContext, owned: LabLease, id: string, card: number | undefined): void {
    this.host.operations.present(owned, this.checkPresentation(ctx, owned, id, card));
  }

  /**
   * Work a replaced session of this Pi left going (/new, /resume, /fork, /reload): this session takes it over — its row
   * is drawn here and its result arrives here. The owner is told it goes on.
   */
  adopt(ctx: ExtensionContext): void {
    const job = this.host.operations.adopt((parked, lease) => parked.kind === 'assessment' ? this.checkPresentation(ctx, lease, parked.id, undefined)
      : this.workPresentation(ctx, lease, parked.id, parked.origin, parked.kind === 'preparation' ? finished => preparedAnswer(lease.lab, finished, !!finished.error) : undefined));
    if (job) ctx.ui?.notify?.(CONTINUES[job.kind], 'info');
  }

  private workPresentation(ctx: ExtensionContext, owned: LabLease, id: string, origin: SessionOperation['origin'], prepared?: (finished: Experiment) => Promise<Prepared>): Presentation {
    const progress = new ProgressRow(ctx, prepared ? BUILD_MESSAGE : RUN_MESSAGE, STOP_HINT);
    return { kind: prepared ? 'preparation' : 'run', id, origin,
      progress: record => progress.show(progressText(record)),
      complete: async job => {
        const finished = await owned.lab.get(id);
        if (prepared) {
          // A stop the owner asked for is answered in its own row; every other ending reports back.
          if (job.quiet) return;
          const answer = await prepared(finished);
          await this.host.refresh(owned.directory);
          this.pi.sendMessage({ customType: BUILD_MESSAGE, display: true, content: JSON.stringify(answer.output),
            details: rememberFeed(`build:${id}:${finished.updatedAt}`, answer.feed ?? { rows: [row('Подготовка завершена.')] }, answer.note ?? 'Подготовка ситуаций') },
          { deliverAs: 'followUp', triggerTurn: true });
          return;
        }
        const complete = finished.phase === 'results_review' || finished.phase === 'complete';
        if (origin === 'board') {
          ctx.ui.notify?.(complete ? 'Прогон завершён: результат — в /agent-lab.' : finished.phase === 'cancelled' ? 'Прогон остановлен. Записанные разговоры сохранены.'
            : `Прогон прервался до результата: ${recordErrorText(finished.error) ?? 'причина не записана.'} Записанные разговоры сохранены.`, complete || finished.phase === 'cancelled' ? 'info' : 'warning');
          return;
        }
        await this.host.refresh(owned.directory);
        if (job.quiet) return;
        const { output, details } = await runAnswer(finished, owned.lab, this.host.verdictOutput);
        this.pi.sendMessage({ customType: RUN_MESSAGE, display: true, content: JSON.stringify(output), details }, { deliverAs: 'followUp', triggerTurn: true });
      },
      error: error => ctx.ui.notify?.(`Не удалось завершить ${prepared ? 'подготовку' : 'прогон'}: ${inputError(error)}`, 'error'),
      clear: () => progress.clear(),
    };
  }

  private checkPresentation(ctx: ExtensionContext, owned: LabLease, id: string, card: number | undefined): Presentation {
    const progress = new ProgressRow(ctx, CHECK_MESSAGE);
    let usedBefore: number | undefined;
    return { kind: 'assessment', id, origin: 'chat',
      progress: record => {
        usedBefore ??= record.usage.calls;
        progress.show(`Проверяю изменённые ситуации · вызовов модели: ${record.usage.calls - usedBefore}`);
      },
      complete: async check => {
        if (check.quiet) return;
        const record = await owned.lab.get(id);
        const failed = record.phase !== 'review' || !!record.error;
        const { views } = failed ? { views: [] } : await viewsOf(owned.lab, record);
        const view = card === undefined ? undefined : views.find(item => item.number === card);
        const reason = recordErrorText(record.error ?? record.message) ?? 'причина не записана.';
        const feed: Feed = failed ? { title: 'Проверка не завершилась', tone: 'warning', rows: [row(`Проверка не завершилась: ${reason}`, 'warning')] }
          : view ? { ...situationFeed(view), title: `Ситуация ${view.number} проверена` } : { ...situationsFeed(record, views), title: 'Ситуации проверены' };
        this.pi.sendMessage({ customType: CHECK_MESSAGE, display: true,
          content: JSON.stringify({ status: failed ? 'check_failed' : 'check_finished', ...(failed ? { reason } : {}),
            ...(view ? situationOutput(record, view) : { run: id, counts: countsText(views), waiting: views.filter(item => item.status === 'needs_owner').map(situationItem) }),
            instruction: 'The background check of changed situations finished. Mention it only if the owner has something to decide.' }),
          details: rememberFeed(`check:${id}:${record.updatedAt}`, feed, `Проверка ситуаций · ${runStamp(record)}`),
        }, { deliverAs: 'followUp', triggerTurn: failed || (view ? view.status !== 'ready' : views.some(item => item.status === 'needs_owner')) });
      },
      error: error => ctx.ui.notify?.(`Проверка не завершилась: ${inputError(error)}`, 'error'),
      clear: () => progress.clear(),
    };
  }
}
