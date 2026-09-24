import type { ExtensionAPI, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { Loader } from '@earendil-works/pi-tui';
import type { Experiment } from '../src/contracts.js';
import type { ExperimentLab } from '../src/experiment.js';
import { countsText, situationData, situationEntry, situationViews } from '../src/card/view.js';
import { safeText } from '../src/text.js';
import { progressText, row, runStamp, stoppedLines } from './conversation.ts';
import { ActionBlock, ActionBody, ActionHead, expandHint, feedFor, feedTone, isFeedDetails, lineBody, rememberFeed, type Feed } from './render/feed.ts';
import { isVerdictDetails, renderAgentLabResult } from './render/verdict-block.ts';
import type { Tone } from './render/theme.ts';
import { inputError, legacyResult } from './lab-ui.ts';
import type { LabLease, SessionOperation, SessionOperations } from './operations.ts';
import { situationFeed, situationsFeed } from './card-tools.ts';
import { summary } from './summary.ts';

/*
 * Long work never holds the conversation (quality bar 5): a run, a preparation and a check of changed situations
 * belong to the Pi session, not to the row or the workspace that started them. While they go, one row above the
 * input says how far they got — Pi's spinner and a line from the stored record — and the status bar says the
 * same; their result arrives as a message drawn like any action: «● Прогон завершён» and its summary.
 */

export const RUN_MESSAGE = 'agent-lab-run';
export const CHECK_MESSAGE = 'agent-lab-check';
export const BUILD_MESSAGE = 'agent-lab-build';
/** The head of each message when its feed does not name one. */
const MESSAGE_TITLE: Record<string, string> = { [RUN_MESSAGE]: 'Прогон завершён', [CHECK_MESSAGE]: 'Проверка ситуаций', [BUILD_MESSAGE]: 'Ситуации готовы' };
/** How to stop long work: in words, since Esc interrupts only the current action. */
export const STOP_HINT = 'остановить — напишите «стоп»';

/** What a finished preparation answers with: the model's JSON and the situations found. */
export type Prepared = { output: Record<string, unknown>; feed?: Feed; note?: string };

/**
 * The one row of long work above the input (ui-spec §4.6): Pi's `Loader` with a line from the stored record and
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
  const output = summary(record, lab.store.directory);
  const note = `Ситуации · ${runStamp(record)}`;
  if (record.librarySnapshot?.formatVersion !== 2 || record.phase !== 'review') {
    const failed = [record.error ? `Подготовка не завершена: ${safeText(record.error)}` : 'Подготовка не завершена.'];
    return { output, feed: { title: 'Подготовка остановлена', tone: 'warning', rows: failed.map(line => row(line, 'warning')) }, note };
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
  return { output: { ...output, counts: countsText(views), situations: views.map(situationEntry) }, feed, note };
}

export interface BackgroundHost {
  operations: SessionOperations;
  /** The result of a finished run: the model's JSON and the details its block is drawn from. */
  verdictOutput(record: Experiment, lab: ExperimentLab): Promise<{ output: unknown; details: unknown }>;
}

/** The session's hand-overs of long work: a run or a preparation that outlives its row, a check of changed situations. */
export class Background {
  constructor(private readonly pi: ExtensionAPI, private readonly host: BackgroundHost) {}

  /**
   * A started run or preparation belongs to the Pi session: the conversation stays free, the row above the input
   * comes from the stored record, and the result arrives as a message. Closing Pi still ends the work it owns.
   */
  detach(ctx: ExtensionContext, owned: LabLease, id: string, origin: SessionOperation['origin'], prepared?: (finished: Experiment) => Promise<Prepared>): SessionOperation {
    const progress = new ProgressRow(ctx, prepared ? BUILD_MESSAGE : RUN_MESSAGE, STOP_HINT);
    return this.host.operations.present(owned, { kind: prepared ? 'preparation' : 'run', id, origin,
      progress: async job => progress.show(progressText(await job.lab.get(id))),
      complete: async job => {
        const finished = await owned.lab.get(id);
        if (prepared) {
          // A stop the owner asked for is answered in its own row; every other ending reports back.
          if (job.quiet) return;
          const answer = await prepared(finished);
          this.pi.sendMessage({ customType: BUILD_MESSAGE, display: true, content: JSON.stringify(answer.output),
            details: rememberFeed(`build:${id}:${finished.updatedAt}`, answer.feed ?? { rows: [row('Подготовка завершена.')] }, answer.note ?? 'Подготовка ситуаций') },
          { deliverAs: 'followUp', triggerTurn: true });
          return;
        }
        const complete = finished.phase === 'results_review' || finished.phase === 'complete';
        if (origin === 'board') { ctx.ui.notify?.(complete ? 'Прогон завершён: результат — в /agent-lab.' : 'Прогон остановлен. Записанные разговоры сохранены.', 'info'); return; }
        if (job.quiet) return;
        const announced = complete ? await this.host.verdictOutput(finished, owned.lab) : undefined;
        const stopped = stoppedLines(finished);
        this.pi.sendMessage({ customType: RUN_MESSAGE, display: true,
          content: JSON.stringify(announced?.output ?? { id, phase: finished.phase, error: finished.error, trialCount: finished.trials.length, message: stopped.join(' ') }),
          details: announced && isVerdictDetails(announced.details) ? announced.details
            : rememberFeed(`run:${id}:${finished.updatedAt}`, { title: 'Прогон остановлен', tone: 'warning',
              rows: [...stopped.map(line => row(line)), ...(finished.error ? [row(safeText(finished.error), 'muted')] : [])] }, `Прогон · ${runStamp(finished)}`),
        }, { deliverAs: 'followUp', triggerTurn: true });
      },
      error: error => ctx.ui.notify?.(`Не удалось завершить ${prepared ? 'подготовку' : 'прогон'}: ${inputError(error)}`, 'error'),
      clear: () => progress.clear(),
    });
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
    const progress = new ProgressRow(ctx, CHECK_MESSAGE);
    let usedBefore: number | undefined;
    this.host.operations.present(owned, { kind: 'assessment', id, origin: 'chat',
      progress: async () => {
        const record = await owned.lab.get(id);
        usedBefore ??= record.usage.calls;
        progress.show(`Проверяю изменённые ситуации · вызовов модели: ${record.usage.calls - usedBefore}`);
      },
      complete: async check => {
        if (check.quiet) return;
        const record = await owned.lab.get(id);
        const failed = record.phase !== 'review' || !!record.error;
        const { views } = failed ? { views: [] } : await viewsOf(owned.lab, record);
        const view = card === undefined ? undefined : views.find(item => item.number === card);
        const feed: Feed = failed ? { title: 'Проверка не завершилась', tone: 'warning', rows: [row(`Проверка не завершилась: ${safeText(record.error ?? record.message)}`, 'warning')] }
          : view ? { ...situationFeed(view), title: `Ситуация ${view.number} проверена` } : { ...situationsFeed(record, views), title: 'Ситуации проверены' };
        this.pi.sendMessage({ customType: CHECK_MESSAGE, display: true,
          content: JSON.stringify({ status: failed ? 'check_failed' : 'check_finished', runId: id, ...(view ? { situation: situationData(view) } : { counts: countsText(views) }),
            instruction: 'The background check of changed situations finished. Mention it only if the owner has something to decide.' }),
          details: rememberFeed(`check:${id}:${record.updatedAt}`, feed, `Проверка ситуаций · ${runStamp(record)}`),
        }, { deliverAs: 'followUp', triggerTurn: failed || (view ? view.status !== 'ready' : views.some(item => item.status === 'needs_owner')) });
      },
      error: error => ctx.ui.notify?.(`Проверка не завершилась: ${inputError(error)}`, 'error'),
      clear: () => progress.clear(),
    });
  }
}
