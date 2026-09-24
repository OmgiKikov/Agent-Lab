import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { evidenceBundle } from '../src/artifacts.js';
import { hostGrant, type Via } from '../src/card/commands.js';
import { logImports } from '../src/card/calibration-scope.js';
import { conversionText } from '../src/card/convert.js';
import { convertible } from '../src/card/legacy-v1.js';
import { pendingReviewCalls } from '../src/card/prepare.js';
import type { CardCommand } from '../src/card/schema.js';
import { situationViews, type SituationView } from '../src/card/view.js';
import { isRunning, type Experiment } from '../src/contracts.js';
import { draftHash, type ExperimentLab } from '../src/experiment.js';
import { decisions, type Decision, type DecisionAction } from '../src/inbox.js';
import { libraryHash } from '../src/scenario-library.js';
import type { ExperimentStore } from '../src/store.js';
import { clip, oneLine } from '../src/text.js';
import type { Background } from './background.ts';
import type { LabLease, SessionOperations } from './operations.ts';

/*
 * «Нужно ваше решение» (ui-spec §8.3) in both surfaces. The queue is derived from the records (src/inbox.ts); what a
 * pick does is decided here, once, for the workspace and the chat. The surface asks the owner first — a key on the
 * board, a native dialog in the chat — and then these functions do what the pick means through the same operations
 * and owner commands; nothing here asks again or decides for the owner.
 */

/** Writes under the writer's lease; long work is handed to the session (`handOver`), which releases the lease when the work ends. */
export type Writing = <T>(work: (lab: ExperimentLab, handOver: (start: (lease: LabLease) => void) => void) => Promise<T>, pendingCheck?: 'cancel' | 'wait') => Promise<T>;

/**
 * A surface's writes: the lease for one piece of work, given back at once unless long work took it over. A run that
 * has just ended is still handing over its result: a write waits for that instead of failing.
 */
export function writer(operations: SessionOperations, open: (cwd: string, pendingCheck?: 'cancel' | 'wait') => Promise<LabLease>, cwd: string, directory: string): Writing {
  return async (work, pendingCheck = 'cancel') => {
    const finishing = operations.current(directory);
    if (finishing && finishing.kind !== 'assessment' && !isRunning((await finishing.lab.get(finishing.id)).phase)) await finishing.done;
    const lease = await open(cwd, pendingCheck);
    let kept = false;
    try {
      await lease.lab.init();
      return await work(lease.lab, start => { start(lease); kept = true; });
    } finally { if (!kept) await lease.close(); }
  };
}

/** Where a decision is resolved: the context of the owner's dialogs, how the receipt names the place, the writes and the session's long work. */
export interface DecisionSurface {
  ctx: ExtensionContext;
  origin: 'board' | 'chat';
  writing: Writing;
  background: Background;
}
const viaOf = (surface: DecisionSurface): Via => surface.origin === 'board' ? 'board' : 'pi-confirm';

/** The logs a calibrated run compared with, and whether the owner has named their agent version since: what the inbox asks about. */
export async function logsOf(store: Pick<ExperimentStore, 'readLogVersions'>, record: Experiment): Promise<{ importId: string; declared: boolean }[]> {
  if (!record.calibration) return [];
  return Promise.all(logImports(record).map(async importId => ({ importId, declared: !!(await store.readLogVersions(importId))?.declarations.length })));
}

/** The situations being worked on as the inbox reads them: a card set that can change, or a first-format draft that can go on in the card format. */
export async function queueDraft(reader: ExperimentLab, record: Experiment): Promise<{ record: Experiment; views: SituationView[]; pendingCalls: number } | undefined> {
  if (record.librarySnapshot?.formatVersion !== 2) return convertible(record) ? { record, views: situationViews(record, { maxTurns: record.settings.maxTurns }), pendingCalls: 0 } : undefined;
  if (isRunning(record.phase)) return undefined;
  const context = await reader.cardContext(record.id);
  const views = situationViews(context.experiment, { evidence: context.evidence, numbers: context.numbers, maxTurns: context.experiment.settings.maxTurns });
  const pendingCalls = record.phase === 'review' && !record.trials.length ? pendingReviewCalls(context.library, context.evidence) : 0;
  return { record: context.experiment, views, pendingCalls };
}

/** What the chat's queue is read from: the newest set of situations, the newest finished run and the logs it compared with. */
export async function chatQueue(reader: ExperimentLab, now = new Date()): Promise<{ decisions: Decision[]; draft?: NonNullable<Awaited<ReturnType<typeof queueDraft>>> }> {
  const records = await reader.list();
  const set = records.find(record => !!record.librarySnapshot || record.scenarios.length > 0);
  const draft = set ? await queueDraft(reader, set) : undefined;
  const finished = records.find(record => record.trials.length > 0 && (record.phase === 'results_review' || record.phase === 'complete'));
  const run = finished ? { record: finished, view: (await evidenceBundle(finished, reader.store)).view } : undefined;
  const logs = finished ? await logsOf(reader.store, finished) : [];
  return { decisions: decisions({ ...(draft ? { draft } : {}), ...(run ? { run } : {}), logs, now }), ...(draft ? { draft } : {}) };
}

/**
 * A situation command the owner decided: applied with their grant — their words when they typed them, their pick
 * otherwise — and checked again, in the background when that takes calls. A run that happened never changes: a
 * change of its situations goes into a fresh draft of the same set.
 */
export async function applySituationCommand(surface: DecisionSurface, record: Experiment, situation: SituationView, decided: { command: CardCommand; words?: string }): Promise<string> {
  return surface.writing(async (lab, handOver) => {
    const target = await lab.editableCards(record.id);
    const copied = target.copiedFrom && target.copiedFrom !== target.id ? ' Правка — в новом черновике того же набора; прошлый прогон не меняется.' : '';
    const prepared = await lab.prepareCardCommand(target.id, decided.command, { via: viaOf(surface), ...(decided.words ? { ownerWords: decided.words } : {}) });
    await lab.applyCardCommand(target.id, prepared, hostGrant(prepared, decided.words ? 'words' : 'confirmed'));
    if (decided.command.kind === 'remove_card') return `Ситуация ${situation.number} убрана из черновика.${copied}`;
    const check = await lab.recheckCards(target.id);
    const where = surface.origin === 'board' ? 'здесь и в чате' : 'сюда отдельным сообщением';
    if (check.decision.action === 'run') { handOver(lease => surface.background.check(surface.ctx, lease, target.id, situation.number)); return `Ситуация ${situation.number}: записано. Проверяю её — итог придёт ${where}.${copied}`; }
    return check.decision.action === 'needs_budget' ? `Записано. На проверку не хватает лимита: нужно вызовов ${check.decision.pendingJobs}, осталось ${check.decision.remainingCalls}.${copied}`
      : `Ситуация ${situation.number}: записано.${copied}`;
  });
}

/**
 * What a settling choice that is not about one situation does, once the surface has the owner's pick; the notice in
 * the owner's words. `runs` are the finished runs a re-assessment may name. Undefined for a choice this layer does not
 * settle (answers and removals go through applySituationCommand; openings and hand-overs belong to the surface).
 */
export async function settle(surface: DecisionSurface, action: DecisionAction, runs: readonly Experiment[]): Promise<string | undefined> {
  const where = surface.origin === 'board' ? 'здесь и в чате' : 'сюда отдельным сообщением';
  switch (action.kind) {
    case 'raise_limit':
      return surface.writing(async (lab, handOver) => {
        const draft = await lab.get(action.runId);
        await lab.updateDraft(draft.id, draftHash(draft), { settings: { maxCalls: action.to } });
        const check = await lab.recheckCards(draft.id, { explicit: true });
        if (check.decision.action === 'run') handOver(lease => surface.background.check(surface.ctx, lease, draft.id, undefined));
        return `Решено: лимит поднят до ${action.to}. Проверяю ситуации — итог придёт ${where}.`;
      });
    case 'check_situations':
      return surface.writing(async (lab, handOver) => {
        const check = await lab.recheckCards(action.runId, { explicit: true });
        if (check.decision.action !== 'run') return 'Проверять нечего: все ситуации проверены.';
        handOver(lease => surface.background.check(surface.ctx, lease, action.runId, undefined));
        return `Проверяю ситуации — итог придёт ${where}.`;
      });
    case 'resume_preparation':
      return surface.writing(async (lab, handOver) => {
        const draft = await lab.get(action.runId);
        if (!draft.librarySnapshot) throw new Error('Нет сохранённой подготовки, которую можно продолжить.');
        await lab.resumePreparation(draft.id, libraryHash(draft.librarySnapshot));
        handOver(lease => surface.background.preparation(surface.ctx, lease, draft.id));
        return 'Продолжаю подготовку с сохранённого места — ситуации придут в чат.';
      });
    case 'convert_draft':
      return surface.writing(async lab => {
        const text = conversionText(await lab.convertV1Draft(action.runId));
        return [text.summary, ...text.left.slice(0, 1), text.check].join(' ');
      });
    case 'reassess': {
      if (!runs.some(run => run.id === action.runId)) return undefined;
      return surface.writing(async (lab, handOver) => {
        const next = await lab.reassess(action.runId, {});
        handOver(lease => surface.background.detach(surface.ctx, lease, next.id, surface.origin));
        return surface.origin === 'board' ? 'Судья оценивает разговоры заново — новый результат появится в «Прогонах».' : 'Судья оценивает разговоры заново — новый результат придёт сюда сообщением.';
      });
    }
    case 'declare_log_version':
      return surface.writing(async lab => {
        const prepared = await lab.prepareLogVersion({ kind: 'declare_log_version', importId: action.importId, version: action.version }, { via: viaOf(surface) });
        // The pick in the owner's dialog is the confirmation this declaration needs; its words, when typed, are the version itself.
        await lab.applyLogVersion(prepared, hostGrant(prepared, 'confirmed'));
        return action.version === null ? 'Записано: версия агента в логах неизвестна — совпадение с продом останется сравнением.'
          : `Записано: логи записал агент версии «${clip(oneLine(action.version), 60)}». Это учтёт следующая сверка с продом — в новом прогоне или при переоценке этого.`;
      });
    case 'answer': case 'remove': case 'add_rule': case 'check_connection': case 'name_log_version':
    case 'open_situation': case 'open_situations': case 'open_conversation': return undefined;
  }
}
