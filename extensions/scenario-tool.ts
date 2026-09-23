import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { scenarioParameters, scenarioToolSurfaces } from './scenario-parameters.ts';
import { ExperimentLab, draftHash } from '../src/experiment.js';
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ResultView } from '../src/result-view.js';
import type { FeedRef } from './render/feed.ts';
import type { LabLease } from './operations.ts';
import type { Experiment } from '../src/contracts.js';
import { libraryHash, resolutionHash } from '../src/scenario-library.js';
import { chooseEditableDraft, draftIsBusy } from '../src/scenario-draft.js';
import { semanticWorkStatus } from '../src/scenario-work.js';
import { pluralForm } from '../src/plural.js';
import { LibraryConflict } from '../src/errors.js';
import { safeText, shortId } from '../src/text.js';
import { scenarioLibrarySummary } from './scenarios.ts';
import { ACCEPTANCE_PAGE, acceptanceLines, authorize, changeRows, checkRow, deriveVariantInput, disputedCheckpoints, ownerRemarks, ownerQuestions, sharedOwnerQuestions, plainIssue, libraryFeed, orderedVariants, ownerBasis, ownerMessages,
  planLines, referenceProblem, referenceQuestion, resolveFact, resolveGroup, resolveVariant, semanticDebt, stateRows, variantDiff, variantFeed, variantNumber,
  row, type CheckOutcome, type Feed } from './conversation.ts';
import type { LibraryPatch, ScenarioLibrary, ScenarioVariant } from '../src/scenario-contracts.js';
import type { VariantOperation } from '../src/scenario-variants.js';
import type { SessionOperations } from './operations.ts';
import { DIFF_FIELD, displayFor, inputError, NeedsOwner, returnToBoard, isInteractive, requireInteractive } from './lab-ui.ts';

interface ScenarioHost {
  inlineCheckMs: number;
  open: (cwd: string, pendingCheck?: 'cancel' | 'wait') => Promise<LabLease>;
  reading: (directory: string) => ExperimentLab;
  feedResult: (callId: string, output: unknown, feed: Feed, note: string, ref?: FeedRef) => AgentToolResult<unknown>;
  summary: (record: Experiment, directory: string, view?: ResultView) => object;
  askOwner: (callId: string, error: unknown) => AgentToolResult<unknown>;
  findRun: (directory: string, ref?: string, ctx?: { sessionManager?: { getEntries?: () => unknown[] } }) => Promise<Experiment>;
  focus: Map<string, string>;
  seenLibrary: Map<string, string>;
  seenTick: Map<string, number>;
  markSeen: (key: string, hash: string) => void;
  checkMoves: Map<string, string>;
  backgroundCheck: (ctx: ExtensionContext, directory: string, id: string, owned: LabLease, usedBefore: number, startHash: string, variantId?: string, asked?: boolean) => void;
  operations: SessionOperations;
  backgroundPreparation: (ctx: ExtensionContext, owned: LabLease, id: string) => void;
}

export function registerScenarioTool(pi: ExtensionAPI, host: ScenarioHost): void {
  const { inlineCheckMs, open, reading, feedResult, askOwner, findRun, focus, seenLibrary, seenTick, markSeen, checkMoves, backgroundCheck, summary } = host;
const register = (definition: ToolDefinition<typeof scenarioParameters>) => {
  // Surface schemas are checked by Pi; all aliases use the same domain dispatcher and renderers.
  const shared = definition as unknown as ToolDefinition;
  for (const surface of scenarioToolSurfaces) {
    pi.registerTool({ ...shared, prepareArguments: undefined, name: surface.name, label: surface.name, description: surface.description, parameters: surface.parameters,
      renderCall: shared.renderCall ? (args, theme, context) => shared.renderCall!({ ...args, operation: surface.operation }, theme, context) : undefined,
      execute: (callId, args, signal, onUpdate, ctx) => definition.execute(callId,
        { ...args, operation: surface.name === 'agent_lab_scenarios' && 'operation' in args ? args.operation : surface.operation } as Parameters<typeof definition.execute>[1], signal, onUpdate, ctx),
    });
  }
};
register({
  ...displayFor('agent_lab_scenarios'),
  name: 'agent_lab_scenarios', label: 'Show and revise scenarios',
  description: 'The scenario library of one run, through the same versioned API as the board and the CLI. show: the draft, one card (variant) or its source dialogue (source:true). edit: change one card via change. resolve: the owner settles a checker\'s question in their own name; variants:[titles or numbers] settles one identical rule question in up to eight explicitly selected cards with one native scope confirmation. A blocking remark cannot be settled. variant: add a targeted synthetic card from a parent via kind; the tool derives the fact, the opening and the conditions from the parent. edit_group: change an existing business group by group plus title/goal/conditions. merge/split/remove, assess (semantic jobs), resume (pending source preparation), accept (native confirmation; never runs the agent), budget. A raw patch or request is refused. Cards, groups and facts are named by title, list number or id. New facts and what the client knew beforehand always stop for the owner\'s confirmation of the exact diff. Meaning is rechecked after a change within the agreed call limit.',
  parameters: scenarioParameters,
  executionMode: 'sequential',
  async execute(callId, params, toolSignal, onUpdate, ctx) {
    const signal = AbortSignal.any([toolSignal, ctx.signal].filter((s): s is AbortSignal => !!s));
    signal.throwIfAborted();
    const rawCommand = params as typeof params & { patch?: unknown; request?: unknown };
    if (rawCommand.patch !== undefined || rawCommand.request !== undefined) throw new Error('Готовый patch или request не принимается. Команда задаётся своими полями: change, group, kind, variants, resolve. Ничего не записано.');
    const directory = resolve(ctx.cwd, '.agent-lab');
    const operation = params.operation === 'inspect' ? 'show' : params.operation;
    const output = (record: Experiment, library: ScenarioLibrary, shown?: ScenarioVariant) => {
      const semantic = semanticWorkStatus(library);
      const offset = shown ? 0 : params.cursor ?? 0;
      const limit = shown ? 1 : params.limit ?? 20;
      const page = shown ? [shown] : orderedVariants(library).slice(offset, offset + limit);
      const detail = shown ? page.map(variant => ({
        id: variant.id, title: variant.title, quality: variant.quality, ownerDecision: variant.ownerDecision, provenance: variant.provenance,
        businessScenarioId: variant.businessScenarioId, parentVariantId: variant.parentVariantId, mutationReason: variant.mutationReason,
        opening: variant.userState.opening, goal: variant.userState.goal, successCriteria: variant.evaluationSpec.successCriteria,
        facts: variant.userState.facts.map(fact => ({ id: fact.id, statement: fact.statement, value: fact.value, availability: fact.availability, reason: fact.reason, origin: fact.origin })),
        missing: variant.userState.missing, cannotKnow: variant.userState.cannotKnow, issues: variant.issues,
        issuesInPlainWords: variant.issues.map(item => plainIssue(library, variant, item)), disputedChecks: disputedCheckpoints(variant).map(item => ({ id: item.id, rule: item.rule })),
        openQuestions: ownerQuestions(variant).map((item, index) => ({ number: index + 1, question: plainIssue(library, variant, item) })),
        sourceDialogues: variant.sourceDialogues, behaviorPolicy: variant.behaviorPolicy, sourceCoverage: variant.sourceCoverage, sourceCoverageBasis: variant.sourceCoverageBasis,
        behavior: variant.behaviorPolicy.transitions.map(transition => { const action = variant.behaviorPolicy.actions.find(item => item.id === transition.actionId);
          return { condition: transition.when, actionId: transition.actionId, action: action?.kind ?? 'invalid', payload: action?.payload, ifAsked: action?.ifAsked }; }),
        checkpoints: variant.evaluationSpec.checkpoints.map(item => ({ id: item.id, rule: item.rule, quote: item.quote, observation: item.observation, role: item.role })),
        environment: { mode: variant.environmentFixture.mode, contract: variant.environmentFixture.contract },
        ...(params.source ? { sourceEvents: variant.sourceDialogues.map(ref => ({ ...ref, events: (library.imports.find(batch => batch.id === ref.batchId)?.dialogues.find(item => item.id === ref.dialogueId)?.events ?? [])
          .map(event => ({ index: event.index, role: event.role ?? event.type, content: event.content })) })) } : {}),
      })) : undefined;
      return {
        ...scenarioLibrarySummary(record, library.acceptance?.variantIds ?? []),
        runId: record.id, progress: record.preparationProgress,
        budget: { usedCalls: record.usage.calls, maxCalls: record.settings.maxCalls, remainingCalls: Math.max(0, record.settings.maxCalls - record.usage.calls),
          semanticTotalJobs: semantic.totalJobs, semanticCompletedJobs: semantic.completedJobs, semanticPendingJobs: semantic.pendingJobs, skipped: semantic.skipped },
        groups: library.businessScenarios.map((group, index) => ({ number: index + 1, id: group.id, title: group.title, goal: group.goal, conditions: group.conditions, grouping: group.grouping,
          variantCount: library.variants.filter(variant => variant.businessScenarioId === group.id).length })),
        variants: page.map(variant => ({ number: variantNumber(library, variant), id: variant.id, businessScenarioId: variant.businessScenarioId, title: variant.title, quality: variant.quality,
          provenance: variant.provenance, parentVariantId: variant.parentVariantId, issueCount: variant.issues.length, sourceCount: variant.sourceDialogues.length })),
        page: { offset, limit, total: library.variants.length, nextCursor: offset + page.length < library.variants.length ? offset + page.length : null },
        ...(detail ? { detail } : {}),
        agentRun: false,
      };
    };
    const titled = (library: ScenarioLibrary, items: ScenarioVariant[]) => items.map(item => `${variantNumber(library, item)}. ${safeText(item.title)}`);
    const splitSummary = (cards: ScenarioVariant[], title: string, goal: string, conditions: string[]): string =>
      `Выделить в группу «${title}»: ${cards.map(item => item.title).join('; ')}\nЦель группы: ${goal}\nУсловия группы: ${conditions.length ? conditions.join('; ') : 'нет'}\nОстальные карточки и их группа не меняются.`;
    const pickVariant = (library: ScenarioLibrary, ref: string | undefined): ScenarioVariant => {
      if (!ref) throw new NeedsOwner('unknown_reference', 'Не сказано, о какой карточке речь. Спросите владельца.', titled(library, orderedVariants(library)).slice(0, 12));
      const resolved = resolveVariant(library, ref);
      if (resolved.kind === 'one') return resolved.item;
      const candidates = titled(library, resolved.kind === 'many' ? resolved.items : orderedVariants(library));
      throw new NeedsOwner(resolved.kind === 'many' ? 'ambiguous_reference' : 'unknown_reference', referenceProblem('Карточка', ref, resolved, candidates), candidates.slice(0, 12), referenceQuestion(ref, resolved));
    };
    const pickGroup = (library: ScenarioLibrary, ref: string) => {
      const resolved = resolveGroup(library, ref);
      if (resolved.kind === 'one') return resolved.item;
      const candidates = (resolved.kind === 'many' ? resolved.items : library.businessScenarios).map(group => safeText(group.title));
      throw new NeedsOwner(resolved.kind === 'many' ? 'ambiguous_reference' : 'unknown_reference', referenceProblem('Группа', ref, resolved, candidates), candidates.slice(0, 12), referenceQuestion(ref, resolved));
    };
    try {
      const found = await findRun(directory, params.id, ctx);
      focus.set(directory, found.id);
      const seenKey = `${directory}|${found.id}`;
      if (!found.librarySnapshot) {
        if (operation !== 'show') throw new Error('У этого прогона прежние карточки без библиотеки сценариев. Ожидания правятся через agent_lab_accept, настройки — через agent_lab_edit.');
        returnToBoard(ctx, found.id);
        return feedResult(callId, summary(found, directory), libraryFeed(found), `Сценарии прогона ${shortId(found.id)}`);
      }
      if (operation === 'show') {
        const { experiment, library } = await reading(directory).readLibrary(found.id);
        const ref = params.variant ?? params.variantId;
        const shown = ref ? pickVariant(library, ref) : undefined;
        markSeen(seenKey, libraryHash(library));
        returnToBoard(ctx, experiment.id);
        return feedResult(callId, output(experiment, library, shown), shown ? variantFeed(experiment, shown, { source: params.source }) : libraryFeed(experiment),
          `Сценарии прогона ${shortId(experiment.id)} · ревизия ${library.revision}`,
          { view: shown ? 'card' : 'library', directory, runId: experiment.id, libraryId: library.id, hash: libraryHash(library), ...(shown ? { variantId: shown.id } : {}) });
      }
      const messages = ownerMessages(ctx);
      let author: 'owner' | 'assistant' = 'assistant';
      /** Conversation authority first, the native dialog second, a question to the owner when a value was never said. */
      const decide = async (request: Omit<Parameters<typeof authorize>[0], 'messages' | 'quote'>): Promise<string> => {
        const authority = authorize({ ...request, messages, quote: params.ownerQuote });
        if (authority.kind === 'ask') throw new NeedsOwner('needs_owner_input', authority.message, [], authority.ownerMessage);
        if (authority.kind === 'confirm') {
          requireInteractive(ctx, 'Эта правка не подтверждена словами владельца в разговоре, а native-подтверждение недоступно без интерактивного терминала. В CLI: scenarios --operation edit --input patch.json.');
          if (!await ctx.ui.confirm('Записать это от вашего имени?', safeText(authority.question))) throw new NeedsOwner('declined', 'Владелец не подтвердил правку. Ничего не записано.');
          author = 'owner';
        }
        return authority.reason;
      };
      // An acceptance waits for a recheck that is still going; any other change cancels and restarts it.
      const owned = await open(ctx.cwd, operation === 'accept' ? 'wait' : 'cancel');
      const { lab, close } = owned;
      let handedOver = false;
      let draftId = found.id;
      let newerRevision = false;
      const cancel = () => { void lab.cancel(draftId).catch(() => {}); };
      try {
        await lab.init();
        // A run that has dialogues never changes. An edit asked for after it goes into a fresh draft of the same set, and says so.
        let movedFrom: Experiment | undefined;
        // Read again under the lock: a recheck of this session may have been going when the run was looked up.
        const settled = await lab.get(found.id);
        if (operation === 'resume') {
          const expected = params.expectedLibraryHash ?? seenLibrary.get(seenKey);
          if (!expected) throw new Error('Сначала прочитайте текущие сценарии (operation:"show").');
          await lab.resumePreparation(settled.id, expected);
          if (isInteractive(ctx)) {
            host.backgroundPreparation(ctx, owned, settled.id); handedOver = true;
            return feedResult(callId, { id: settled.id, background: true, operationKind: 'preparation', mutated: true,
              instruction: 'Pending sources continue within the cumulative budget. The outcome arrives as a message; do not poll.' },
              { rows: [row('Продолжаю подготовку по сохранённым источникам. Итог появится в чате.', 'success', true)] }, 'Подготовка продолжена');
          }
          signal.addEventListener('abort', cancel, { once: true });
          try { if (signal.aborted) cancel(); await lab.waitForIdle(); } finally { signal.removeEventListener('abort', cancel); }
          const fresh = await lab.readLibrary(settled.id); markSeen(seenKey, libraryHash(fresh.library));
          return feedResult(callId, output(fresh.experiment, fresh.library), libraryFeed(fresh.experiment), 'Подготовка продолжена');
        }

        // A library has one line of revisions. The record to edit is the draft that holds its newest revision;
        // when only finished runs hold it, the newest of them is copied into a fresh draft.
        const headHash = await lab.store.readLibrary(settled.librarySnapshot!.id).then(libraryHash, () => libraryHash(settled.librarySnapshot!));
        const choice = chooseEditableDraft({ settled, holders: await lab.list(), headHash, busy: draftIsBusy });
        if (choice.action === 'busy') throw new Error(`Прогон ${shortId(found.id)} сейчас выполняется. Сценарии можно смотреть; правки — после его завершения или остановки.`);
        if (choice.action === 'use' || choice.action === 'copy') {
          draftId = choice.action === 'use' ? choice.id : (await lab.repeat(choice.sourceId)).id;
          movedFrom = settled;
          newerRevision = choice.newer;
          focus.set(directory, draftId);
        }
        const draftKey = `${directory}|${draftId}`;
        const current = await lab.readLibrary(draftId);
        let library = current.library;
        // The state the model saw, plus nothing but this session's own semantic bookkeeping on top of it.
        // Redirected to another record of the same library, the edit applies to the view the model saw last: after looking at an older run
        // its card numbers may differ, so that edit is refused once and the newest revision is shown.
        const latestView = (seenTick.get(seenKey) ?? 0) > (seenTick.get(draftKey) ?? 0) ? seenKey : draftKey;
        let expected = params.expectedLibraryHash ?? seenLibrary.get(latestView) ?? seenLibrary.get(seenKey);
        if (!expected) throw new Error('Сначала прочитайте сценарии этого прогона (operation:"show"): правка применяется к состоянию, которое вы видели.');
        for (let hop = 0; hop < 16 && checkMoves.has(`${draftKey}|${expected}`); hop++) expected = checkMoves.get(`${draftKey}|${expected}`)!;
        /**
         * The semantic recheck a change needs, within the agreed call limit: in this row when it is fast, as a later message when it is not.
         * `askedHash` marks the owner's explicit assess: it checks the state the model saw, is never postponed, and with fewer calls left
         * than jobs owed it still runs — a bounded partial assessment — instead of asking for budget.
         */
        const verify = async (variantId?: string, wait = false, askedHash?: string): Promise<CheckOutcome> => {
          const fresh = await lab.readLibrary(draftId);
          let debt: ReturnType<typeof semanticDebt>;
          try { debt = semanticDebt(fresh.experiment, fresh.library); } catch (error) { return { status: 'failed', message: inputError(error) }; }
          let result: Awaited<ReturnType<ExperimentLab['recheckLibrary']>>;
          try { result = await lab.recheckLibrary(draftId, { defer: params.verify === 'later' && !wait, expectedHash: askedHash, explicit: !!askedHash }); }
          catch (error) { if (askedHash) throw error; return { status: 'failed', message: inputError(error) }; }
          const { decision } = result;
          if (decision.action !== 'run') return decision.action === 'not_needed' ? { status: 'not_needed' } : { status: decision.action, pendingJobs: decision.pendingJobs, remainingCalls: decision.remainingCalls };
          const startHash = decision.startHash;
          onUpdate?.({ content: [{ type: 'text', text: `Перепроверяю смысл изменённых карточек · до ${Math.min(debt.pendingJobs, debt.remainingCalls)} вызовов модели…` }], details: { id: draftId, phase: 'preparing' } });
          // Without a terminal an abort still cancels an explicit assess; one that fired before the work was registered is caught up here.
          if (askedHash && wait && signal.aborted) cancel();
          const inline = wait ? (await lab.waitForIdle(), true) : await new Promise<boolean>(settle => {
            const timer = setTimeout(() => settle(false), inlineCheckMs);
            const onAbort = () => settle(false);
            signal.addEventListener('abort', onAbort, { once: true });
            void lab.waitForIdle().then(() => settle(true), () => settle(true)).finally(() => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); });
          });
          if (!inline) {
            handedOver = true;
            backgroundCheck(ctx, directory, draftId, owned, fresh.experiment.usage.calls, startHash, variantId, !!askedHash);
            return { status: 'running', ...debt };
          }
          const after = await lab.get(draftId);
          checkMoves.set(`${draftKey}|${startHash}`, libraryHash((await lab.readLibrary(draftId)).library));
          return after.phase === 'review' && !after.error ? { status: 'done', calls: Math.max(0, after.usage.calls - fresh.experiment.usage.calls) }
            : { status: 'failed', message: safeText(after.error ?? after.message) };
        };
        /** Every change answers the same way: what happened, «было → стало», the recheck, and which state the draft is in now. */
        let changedHash: string | undefined;
        const changed = async (headline: string, extra: Feed['rows'], variantId: string | undefined, payload: Record<string, unknown>, note: string) => {
          changedHash = libraryHash((await lab.readLibrary(draftId)).library);
          const check = await verify(variantId);
          const fresh = await lab.readLibrary(draftId);
          markSeen(draftKey, libraryHash(fresh.library));
          const variant = variantId ? fresh.library.variants.find(item => item.id === variantId) : undefined;
          const card = variant ? variantFeed(fresh.experiment, variant) : undefined;
          const moved = movedFrom ? [row(movedFrom.phase === 'review' ? 'Правка сделана в черновике последней ревизии этого набора.'
            : `Прогон ${shortId(movedFrom.id)} уже выполнен и не меняется: правка сделана в черновике того же набора.`, 'accent', false, 1)] : [];
          const disputed = variant && check.status !== 'running' ? disputedCheckpoints(variant) : [];
          const feed: Feed = { rows: [row(headline, 'success', true), ...moved, ...extra, checkRow(check, variant),
            ...(variant && check.status === 'done' ? ownerRemarks(variant.issues).slice(0, 3).map(item => row(`• ${safeText(plainIssue(fresh.library, variant, item))}`, 'warning', false, 1)) : []),
            ...(disputed.length ? [row(`Под вопросом проверки: ${disputed.map(item => `«${safeText(item.rule)}»`).join('; ')}. Их можно переписать или убрать — скажите как.`, 'accent', false, 1)] : []),
            ...stateRows(fresh.experiment)],
            ...(card ? { more: [...card.rows, row(''), ...(card.more ?? [])] } : {}) };
          returnToBoard(ctx, fresh.experiment.id);
          return feedResult(callId, { ...output(fresh.experiment, fresh.library, variant), ...payload, check, mutated: true,
            ...(movedFrom ? { draftRunId: draftId, unchangedRunId: movedFrom.id, instruction: 'The finished run is immutable, so the change went into a fresh draft of the same set. Tell the owner in one phrase and keep working on draftRunId.' } : {}),
            ...(check.status === 'running' ? { checkNote: 'The semantic recheck continues in the background and will report back as a message. Do not wait for it and do not poll; further edits are fine.' } : {}) }, feed, note,
            variant ? { view: 'change', directory, runId: draftId, libraryId: fresh.library.id, hash: changedHash ?? libraryHash(fresh.library), beforeHash: expected, variantId: variant.id } : undefined);
        };
        const knownTexts = (variant: ScenarioVariant): string[] => [variant.userState.opening, variant.userState.goal, variant.evaluationSpec.successCriteria,
          ...variant.userState.facts.flatMap(fact => [fact.statement, String(fact.value ?? '')]), ...variant.userState.missing,
          ...variant.evaluationSpec.checkpoints.flatMap(item => [item.rule, item.quote]), ...library.requirements.flatMap(item => [item.text, item.quote]),
          ...variant.sourceDialogues.flatMap(ref => library.imports.find(batch => batch.id === ref.batchId)?.dialogues.find(item => item.id === ref.dialogueId)?.events.map(event => event.content ?? '') ?? [])];
        /** Where a fact value may come from besides the owner's words: the card's own facts and what the client said in the source dialogue — never the old agent's replies, expectations or requirements. */
        const factSources = (variant: ScenarioVariant): string[] => [...variant.userState.facts.flatMap(fact => [fact.statement, String(fact.value ?? '')]),
          ...variant.sourceDialogues.flatMap(ref => library.imports.find(batch => batch.id === ref.batchId)?.dialogues.find(item => item.id === ref.dialogueId)?.events.filter(event => event.role === 'user').map(event => event.content ?? '') ?? [])];
        const editId = `owner_${Date.now().toString(36)}`;

        if (operation === 'variant') {
          const parent = pickVariant(library, params.variant);
          const kind = params.kind as VariantOperation | undefined;
          if (!kind) throw new Error('Укажите kind: чем вариант отличается от исходной карточки.');
          const derived = deriveVariantInput(parent, kind, { fact: params.fact, opening: params.opening, ifAsked: params.ifAsked, reply: params.reply,
            missingDescription: params.missingDescription, intent: params.intent, afterAction: params.afterAction, failures: params.failures });
          if (derived.kind === 'ask') throw new NeedsOwner('needs_owner_input', derived.message);
          const { input } = derived;
          // The simulated client may only say values the owner or the parent card already hold.
          // Internal references (factId, afterActionId) select existing objects; their digits are not customer data.
          const spoken = ['opening', 'ifAsked', 'reply', 'missingDescription', 'intent'].map(field => input[field])
            .filter((value): value is string => typeof value === 'string');
          await decide({ simulated: [...spoken, ...[params.opening, params.reply, params.intent].filter((text): text is string => !!text)], known: knownTexts(parent),
            summary: `Добавить к карточке «${parent.title}» синтетический вариант: ${kind}` });
          const reason = ownerBasis(messages, params.ownerQuote)?.reason ?? 'Целевой вариант по запросу в разговоре';
          const proposed = await lab.proposeVariant(draftId, expected, { parentId: parent.id, operation: kind, reason, input });
          return await changed(`Добавлен синтетический вариант «${safeText(proposed.variant.title)}»`,
            [...changeRows(proposed.diff), row(`Исходная карточка «${safeText(parent.title)}» не изменена.`, 'muted', false, 1)], proposed.variant.id,
            { variant: proposed.variant, diff: proposed.diff, parentUnchanged: true }, `Добавлен вариант · прогон ${shortId(draftId)}`);
        }
        if (operation === 'assess') {
          const debt = semanticDebt(current.experiment, library);
          if (!debt.remainingCalls && debt.pendingJobs) throw new Error(`Осталось ${debt.pendingJobs} смысловых вызовов, модельный бюджет исчерпан. Увеличьте лимит (operation:"budget") с согласия владельца; использованный бюджет не сбрасывается.`);
          // In the terminal a long assessment goes on behind the conversation and reports back as a message; Esc hands it over, too.
          // Without a terminal there is nowhere to report to, so the call waits, and an abort still cancels the work.
          const interactive = isInteractive(ctx) && !!ctx.ui;
          let check: CheckOutcome = { status: 'not_needed' };
          if (debt.pendingJobs || debt.needsFinalization) {
            if (!interactive) signal.addEventListener('abort', cancel, { once: true });
            try { check = await verify(undefined, !interactive, expected); } finally { signal.removeEventListener('abort', cancel); }
          }
          const fresh = await lab.readLibrary(draftId);
          returnToBoard(ctx, fresh.experiment.id);
          if (check.status === 'running') return feedResult(callId, { ...output(fresh.experiment, fresh.library), check, mutated: true,
            checkNote: 'The semantic assessment continues in the background and will report back as a message. Do not wait for it and do not poll; reads and further edits are fine.' },
            { rows: [row(`Смысловая проверка идёт в фоне · до ${Math.min(debt.pendingJobs, debt.remainingCalls)} вызовов модели.`, 'success', true),
              row('Разговор свободен. Итог появится здесь отдельным сообщением; новая правка перезапустит проверку, уже проверенное не пропадёт.', 'muted', false, 1)] }, `Смысловая проверка · прогон ${shortId(draftId)}`);
          markSeen(draftKey, libraryHash(fresh.library));
          const feed = libraryFeed(fresh.experiment);
          feed.rows.unshift(row(debt.pendingJobs || debt.needsFinalization ? `Смысловая проверка завершена · вызовов модели: ${Math.max(0, fresh.experiment.usage.calls - current.experiment.usage.calls)}` : 'Смысловая проверка не нужна: непроверенных изменений нет.', 'success', true));
          return feedResult(callId, { ...output(fresh.experiment, fresh.library), mutated: debt.pendingJobs > 0 || debt.needsFinalization }, feed, `Смысловая проверка · прогон ${shortId(draftId)}`);
        }
        if (operation === 'accept') {
          // «Готовые» means checked: a recheck still owed by earlier edits runs first when the agreed limit covers it.
          const owed = await verify(undefined, true);
          if (owed.status === 'done') { library = (await lab.readLibrary(draftId)).library; expected = libraryHash(library); }
          const ids = params.variantIds ?? (params.variants ? params.variants.map(ref => pickVariant(library, ref).id)
            : params.select === 'ready' ? orderedVariants(library).filter(item => item.quality === 'ready').map(item => item.id) : []);
          if (!ids.length) throw new NeedsOwner('needs_owner_input', params.select === 'ready' ? 'Готовых карточек нет: каждая ждёт решения или заблокирована. Покажите владельцу замечания.' : 'Не сказано, какие карточки принять. Спросите владельца.');
          requireInteractive(ctx, 'Принятие библиотеки требует native Pi confirmation; в CLI используйте scenarios --operation accept --yes.');
          const chosen = orderedVariants(library).filter(item => ids.includes(item.id));
          const left = orderedVariants(library).filter(item => !ids.includes(item.id));
          const tail = [...(left.length ? ['', `Не входят (${left.length}): ${left.slice(0, 6).map(item => `${safeText(item.title)} — ${item.quality === 'ready' ? 'не выбрана' : item.quality === 'blocked' ? 'заблокирована' : 'ждёт решения'}`).join('; ')}${left.length > 6 ? '…' : ''}`] : []),
            '', 'Агент не запускается. Запуск подтверждается отдельно.'];
          const cards = pluralForm(ids.length, ['карточку', 'карточки', 'карточек']);
          const question = `Принять ${ids.length} ${cards} как набор для проверки?`;
          let agreed = false;
          if (chosen.length <= ACCEPTANCE_PAGE) agreed = await ctx.ui.confirm(question, safeText([...acceptanceLines(library, chosen), ...tail].join('\n')));
          else {
            // A large set is paged inside the native dialog: every definition can be read there, accepting is possible on any page,
            // and the dialog itself counts what was not opened — it never claims that something was shown elsewhere.
            const accept = `Принять все ${ids.length} ${cards}`, next = 'Показать следующие определения', refuse = 'Не принимать';
            const opened = new Set<string>();
            for (let from = 0; ;) {
              signal.throwIfAborted();
              const page = chosen.slice(from, from + ACCEPTANCE_PAGE);
              for (const item of page) opened.add(item.id);
              const unseen = chosen.length - opened.size;
              const picked = await ctx.ui.select(safeText([question, `Определения карточек ${from + 1}–${from + page.length} из ${chosen.length} · ${unseen ? `ещё не открыто: ${unseen}` : 'открыты все'}`,
                '', ...acceptanceLines(library, page), ...tail].join('\n')), [accept, from + ACCEPTANCE_PAGE < chosen.length ? next : 'Показать определения с начала', refuse]);
              if (picked === accept) { agreed = true; break; }
              if (picked === undefined || picked === refuse) break;
              from = from + ACCEPTANCE_PAGE < chosen.length ? from + ACCEPTANCE_PAGE : 0;
            }
          }
          if (!agreed) {
            return feedResult(callId, { cancelled: true, mutated: false, message: 'Принятие отменено. Агент не запускался.' }, { rows: [row('Принятие отменено. Набор не изменился, агент не запускался.', 'warning')] }, 'Принятие отменено');
          }
          const accepted = await lab.acceptLibrary(draftId, expected, ids);
          markSeen(draftKey, libraryHash(accepted.library));
          returnToBoard(ctx, accepted.experiment.id);
          const feed: Feed = { rows: [row(`Принят набор: ревизия ${accepted.library.revision}, ${ids.length} из ${library.variants.length} карточек. Агент не запускался.`, 'success', true),
            ...(left.length ? [row(`Остались вне набора: ${left.length}.`, 'muted', false, 1)] : []), row('План запуска (подтверждается отдельно):', 'accent', false, 1),
            ...planLines(accepted.experiment, ctx.cwd).map(line => row(safeText(line), undefined, false, 3))], more: titled(accepted.library, chosen).map(line => row(line, undefined, false, 1)) };
          return feedResult(callId, { ...output(accepted.experiment, accepted.library), accepted: true, draftHash: draftHash(accepted.experiment), plan: planLines(accepted.experiment, ctx.cwd), mutated: true }, feed,
            `Принят набор · прогон ${shortId(draftId)} · ревизия ${accepted.library.revision}`);
        }
        if (operation === 'budget') {
          if (!params.maxCalls) throw new Error('Укажите maxCalls: новый общий лимит вызовов модели.');
          requireInteractive(ctx, 'Изменение лимита расходов требует native Pi confirmation.');
          const record = current.experiment;
          if (params.maxCalls <= record.usage.calls) throw new Error(`Лимит должен быть больше уже использованных ${record.usage.calls} вызовов.`);
          if (!await ctx.ui.confirm('Изменить лимит вызовов модели?', safeText(`Было: ${record.settings.maxCalls}. Станет: ${params.maxCalls}. Уже использовано ${record.usage.calls}; использованные вызовы не сбрасываются.`))) {
            return feedResult(callId, { cancelled: true, mutated: false }, { rows: [row('Лимит не изменён.', 'warning')] }, 'Лимит не изменён');
          }
          await lab.updateDraft(draftId, draftHash(record), { settings: { maxCalls: params.maxCalls } });
          return await changed(`Лимит вызовов модели: ${record.settings.maxCalls} → ${params.maxCalls}`, [], undefined, { maxCalls: params.maxCalls }, `Лимит вызовов · прогон ${shortId(draftId)}`);
        }

        if (operation === 'resolve') {
          if (libraryHash(library) !== expected) throw new LibraryConflict('Библиотека изменилась: хеш устарел');
          if (params.variants && (params.variant || params.variantId || params.variantIds)) throw new NeedsOwner('ambiguous_reference', 'Выберите один список карточек для общего решения. Ничего не записано.');
          const cards = params.variants ? params.variants.map(ref => pickVariant(library, ref)) : [pickVariant(library, params.variant ?? params.variantId)];
          if (cards.length > ACCEPTANCE_PAGE || new Set(cards.map(card => card.id)).size !== cards.length) throw new NeedsOwner('ambiguous_reference', `Для одного решения выберите не больше ${ACCEPTANCE_PAGE} разных карточек. Ничего не записано.`);
          const basis = ownerBasis(messages, params.ownerQuote);
          const card = cards[0]!;
          const open = ownerQuestions(card);
          const chosen = params.issue ? open.slice(params.issue - 1, params.issue) : open;
          const common = cards.length > 1 ? sharedOwnerQuestions(library, cards).filter(question => !params.issue || question.questionNumber === params.issue) : [];
          if (cards.length > 1 && common.length !== 1) throw new NeedsOwner('needs_owner_input', common.length > 1
            ? 'У выбранных карточек несколько общих вопросов. Уточните номер вопроса в первой карточке; ничего не записано.'
            : 'Во всех выбранных карточках нет одного одинакового открытого вопроса по тому же правилу и условиям. Проверьте область решения; блокирующие замечания требуют исправления. Ничего не записано.');
          const members = cards.length > 1 ? common[0]!.members : chosen.map(issue => {
            const path = issue.path.replace(`variants.${card.id}.`, '');
            return { card, issue, path, findingHash: resolutionHash(library, card, path, issue.message) };
          });
          if (!members.length) throw new NeedsOwner('needs_owner_input', card.issues.some(item => item.severity === 'blocked')
            ? 'У этой карточки блокирующее замечание: его снимает исправление карточки, а не решение владельца.' : 'У этой карточки нет открытых вопросов, которые владелец может закрыть своим решением.');
          requireInteractive(ctx, 'Закрыть вопрос проверяющего может только владелец в интерактивном терминале.');
          const plain = members.map(member => plainIssue(library, member.card, member.issue));
          const checkpoint = cards.length > 1 ? card.evaluationSpec.checkpoints.find(item => members[0]!.path === `evaluationSpec.checkpoints.${item.id}`) : undefined;
          const requirement = checkpoint && library.requirements.find(item => item.id === checkpoint.requirementId);
          const source = requirement && library.sources.find(item => item.id === requirement.sourceId);
          const business = library.businessScenarios.find(item => item.id === card.businessScenarioId);
          const scope = { libraryHash: expected, revision: library.revision, variantIds: cards.map(item => item.id),
            findings: members.map(member => ({ variantId: member.card.id, path: member.path, findingHash: member.findingHash })) };
          const preview = cards.length > 1 ? [`Одно решение для ${cards.length} карточек · ревизия ${library.revision}:`, ...titled(library, cards),
            `Правило: ${checkpoint!.rule}`, `Когда применимо: ${checkpoint!.applicability}`, `Основание: «${requirement!.quote}»`,
            `Цель группы: ${business?.goal ?? ''}`, `Условия группы: ${business?.conditions.join('; ') || 'нет'}`,
            `Источник: ${source!.name} · версия ${source!.hash.slice(0, 12)}`, `Открытый вопрос: ${members[0]!.issue.message}`]
            : [`Карточка «${card.title}». Проверяющий сомневается:`, ...plain.map(text => `• ${text}`)];
          if (!await ctx.ui.confirm(cards.length > 1 ? 'Применить одно решение к выбранным карточкам?' : 'Закрыть вопрос своим решением?', safeText([...preview, '',
            'Да — перечисленные части карточек считаются верными по вашему решению. Оно относится только к показанным карточкам, правилу и текущим основаниям. Другие вопросы, новые варианты и изменённые основания это решение не закрывает.'].join('\n')))) {
            throw new NeedsOwner('declined', 'Владелец не закрыл вопрос. Ничего не записано.');
          }
          const reason = basis?.reason ?? 'Решение владельца в диалоге Pi.';
          await lab.editLibrary(draftId, expected, { kind: 'resolve_findings', findings: scope.findings, editId: `owner_${randomUUID()}`, reason }, 'owner');
          return await changed(cards.length > 1 ? `Общий вопрос закрыт вашим решением в ${cards.length} карточках` : `Вопрос по карточке «${safeText(card.title)}» закрыт вашим решением`,
            members.map(member => row(`${cards.length > 1 ? `«${safeText(member.card.title)}»: ` : ''}было под вопросом: ${safeText(plainIssue(library, member.card, member.issue))}`, 'muted', false, 1)), cards.length === 1 ? card.id : undefined,
            { resolved: plain, recordedReason: reason, decisionScope: scope }, `Решение владельца · прогон ${shortId(draftId)}`);
        }
        let patch: LibraryPatch;
        let target: ScenarioVariant | undefined;
        let headline: string;
        let groupScope: { groupId: string; variantIds: string[]; preview: string } | undefined;
        if (operation === 'edit_group') {
          if (libraryHash(library) !== expected) throw new LibraryConflict('Библиотека изменилась: хеш устарел');
          if (!params.group) throw new NeedsOwner('needs_owner_input', 'Укажите группу, цель или условия которой нужно изменить.', library.businessScenarios.map(group => group.title));
          const group = pickGroup(library, params.group);
          const changes = { ...(params.title !== undefined ? { title: params.title } : {}), ...(params.goal !== undefined ? { goal: params.goal } : {}), ...(params.conditions !== undefined ? { conditions: params.conditions } : {}) };
          if (changes.title === undefined && changes.goal === undefined && changes.conditions === undefined) throw new NeedsOwner('needs_owner_input', 'Укажите новое название, цель или условия группы.');
          const cards = library.variants.filter(card => card.businessScenarioId === group.id);
          const preview = [`Группа «${group.title}» · ${cards.length} карточек:`, ...titled(library, cards),
            ...(changes.title !== undefined ? [`Название: ${group.title} → ${changes.title}`] : []),
            ...(changes.goal !== undefined ? [`Цель группы: ${group.goal} → ${changes.goal}`] : []),
            ...(changes.conditions !== undefined ? [`Условия группы: ${group.conditions.join('; ') || 'нет'} → ${changes.conditions.join('; ') || 'нет'}`] : []),
            'Карточки остаются на месте; смысл всех карточек этой группы перепроверяется. Другие группы не меняются.'].join('\n');
          const reason = await decide({ attributed: [...(changes.title !== undefined ? [changes.title] : []), ...(changes.goal !== undefined ? [changes.goal] : []), ...(changes.conditions ?? [])],
            known: [group.title, group.goal, ...group.conditions], provenance: changes.conditions !== undefined && !changes.conditions.length && !!group.conditions.length, summary: preview });
          patch = { kind: 'edit_business', businessScenarioId: group.id, ...(changes.title !== undefined ? { title: changes.title } : {}),
            ...(changes.goal !== undefined ? { goal: changes.goal } : {}), ...(changes.conditions !== undefined ? { conditions: changes.conditions } : {}), reason };
          groupScope = { groupId: group.id, variantIds: cards.map(card => card.id), preview };
          headline = `Группа «${safeText(changes.title ?? group.title)}» изменена · ${cards.length} карточек`;
        } else if (operation === 'merge') {
          if (!params.groups) throw new NeedsOwner('needs_owner_input', 'Не сказано, какие группы объединить. Спросите владельца.', library.businessScenarios.map(group => safeText(group.title)));
          const [into, ...sources] = params.groups.map(ref => pickGroup(library, ref));
          if (!into || !sources.length || sources.some(group => group.id === into.id)) throw new NeedsOwner('needs_owner_input', 'Для объединения нужны две разные группы. Уточните у владельца.', library.businessScenarios.map(group => safeText(group.title)));
          const summaryText = `Объединить группы: «${into.title}» + ${sources.map(group => `«${group.title}»`).join(' + ')}`;
          patch = { kind: 'merge_business', targetId: into.id, sourceIds: sources.map(group => group.id), reason: await decide({ summary: summaryText }) };
          headline = `Группы объединены: «${safeText(into.title)}» + ${sources.map(group => `«${safeText(group.title)}»`).join(' + ')} → «${safeText(into.title)}»`;
        } else if (operation === 'split') {
          const moving = (params.variants ?? (params.variant ? [params.variant] : [])).map(ref => pickVariant(library, ref));
          const source = library.businessScenarios.find(group => group.id === moving[0]?.businessScenarioId);
          if (!moving.length || !source) throw new NeedsOwner('needs_owner_input', 'Не сказано, какие карточки выделить в отдельную группу. Спросите владельца.');
          if (!params.title) throw new NeedsOwner('needs_owner_input', 'Спросите владельца, как назвать новую группу.');
          const goal = params.goal ?? source.goal;
          const conditions = params.conditions ?? source.conditions;
          const reason = await decide({ attributed: [...(params.goal !== undefined ? [goal] : []), ...(params.conditions ?? [])], known: [source.goal, ...source.conditions],
            provenance: params.conditions !== undefined && !conditions.length && !!source.conditions.length,
            summary: splitSummary(moving, params.title, goal, conditions) });
          patch = { kind: 'split_business', businessScenarioId: source.id, variantIds: moving.map(item => item.id), reason,
            newBusiness: { key: `split_${Date.now().toString(36)}`, title: params.title, goal, conditions, requirementIds: source.requirementIds, grouping: { status: 'confirmed', reason } } };
          headline = `Новая группа «${safeText(params.title)}»: ${moving.map(item => `«${safeText(item.title)}»`).join(', ')}`;
        } else if (operation === 'behavior') {
          target = pickVariant(library, params.variant);
          if (params.behaviorPolicy === undefined && params.sourceCoverage === undefined) throw new Error('Укажите behaviorPolicy и/или sourceCoverage: полное новое поведение или учёт исходных реплик.');
          const reason = await decide({ simulated: params.behaviorPolicy?.actions.flatMap(action => action.payload ? [action.payload] : []) ?? [], known: knownTexts(target),
            summary: `Исправить поведение виртуального клиента или учёт исходных реплик в карточке «${target.title}». Факты клиента и исходные материалы сохранены.` });
          patch = { kind: 'edit_behavior', variantId: target.id, reason,
            ...(params.behaviorPolicy !== undefined ? { behaviorPolicy: params.behaviorPolicy } : {}),
            ...(params.sourceCoverage !== undefined ? { sourceCoverage: params.sourceCoverage } : {}) };
          headline = `Поведение клиента в карточке «${safeText(target.title)}» изменено`;
        } else if (operation === 'remove') {
          target = pickVariant(library, params.variant ?? params.variantId);
          patch = { kind: 'remove_variant', variantId: target.id, reason: await decide({ summary: `Убрать карточку «${target.title}» из новой ревизии` }) };
          headline = `Карточка «${safeText(target.title)}» убрана из черновика. Исходный импорт и прошлые прогоны сохранены.`;
        } else {
          const change = params.change;
          if (!change) throw new Error('Для edit укажите change: какое поле карточки изменить.');
          target = pickVariant(library, params.variant ?? params.variantId);
          const card = target;
          if (change.field === 'fact') {
            const named = change.fact ? resolveFact(card, change.fact) : undefined;
            if (named && named.kind !== 'one') throw new NeedsOwner(named.kind === 'many' ? 'ambiguous_reference' : 'unknown_reference',
              referenceProblem('Факт', change.fact!, named, card.userState.facts.map(fact => safeText(fact.statement))), card.userState.facts.map(fact => safeText(fact.statement)));
            const existing = named?.kind === 'one' ? named.item : undefined;
            const statement = change.statement ?? existing?.statement;
            if (!statement) throw new NeedsOwner('needs_owner_input', 'Спросите владельца, как сформулировать новый факт о клиенте.');
            const value = change.value !== undefined && change.value !== String(existing?.value ?? '') ? change.value : existing?.value;
            const availability = (change.availability ?? existing?.availability ?? 'initial') as 'initial' | 'learned_in_source' | 'uncertain';
            // Confirming a fact as it stands is still an owner decision: it turns a model reading of the log into the owner's word.
            if (existing && statement === existing.statement && value === existing.value && availability === existing.availability && existing.origin.kind === 'owner') throw new Error('Факт уже такой и уже подтверждён владельцем: менять нечего.');
            const attributed = [...(statement !== existing?.statement ? [statement] : []), ...(value !== existing?.value && value !== undefined ? [String(value)] : [])];
            const knew = { initial: 'клиент знал это до разговора', learned_in_source: 'клиент узнал это только в старом разговоре', uncertain: 'неясно, знал ли клиент заранее' }[availability];
            const reason = await decide({ provenance: true, attributed, known: factSources(card),
              summary: `${existing ? 'Записать от вашего имени' : 'Добавить от вашего имени'} факт клиента в карточке «${card.title}»:\n«${statement}»${value !== undefined ? ` (значение: ${value})` : ''}\n${knew}.` });
            patch = { kind: existing ? 'edit_fact' : 'add_fact', variantId: card.id, factId: existing?.id ?? `fact_${Date.now().toString(36)}`, statement, ...(value !== undefined ? { value } : {}), availability, editId, reason };
          } else {
            const field = change.field === 'expectation' ? 'successCriteria' as const : change.field === 'rule' ? 'checkpointRule' as const : change.field as 'opening' | 'goal';
            const checkpoints = card.evaluationSpec.checkpoints;
            const wantedRule = change.rule?.trim().toLocaleLowerCase('ru');
            const named = field !== 'checkpointRule' ? [] : wantedRule === 'disputed' ? disputedCheckpoints(card) : checkpoints.length === 1 && !wantedRule ? checkpoints
              : checkpoints.filter(item => !!wantedRule && (item.id === change.rule || item.rule.toLocaleLowerCase('ru').includes(wantedRule)));
            if (field === 'checkpointRule' && (!named.length || (named.length > 1 && !change.remove))) throw new NeedsOwner('ambiguous_reference', 'Уточните у владельца, о каком правиле проверки речь.', checkpoints.map(item => safeText(item.rule)));
            if (change.remove) {
              if (field !== 'checkpointRule') throw new Error('Убрать можно только правило проверки (field:"rule").');
              const kept = checkpoints.filter(item => !named.includes(item));
              if (!kept.length) throw new NeedsOwner('needs_owner_input', 'Без единой проверки карточку нечем измерять. Спросите владельца, чем заменить правило, и перепишите его (value), а не убирайте.');
              const reason = await decide({ summary: `Убрать из карточки «${card.title}» проверки: ${named.map(item => `«${item.rule}»`).join('; ')}` });
              patch = { kind: 'upsert_variant', reason, variant: { ...structuredClone(card), semanticReviewRequired: true, evaluationSpec: { ...card.evaluationSpec, checkpoints: kept } } };
            } else {
              if (!change.value?.trim()) throw new NeedsOwner('needs_owner_input', 'Нет нового текста. Спросите владельца, как должно быть.');
              const checkpoint = named[0];
              const owned = field === 'successCriteria' || field === 'checkpointRule';
              const texts = [change.value, ...(change.applicability ? [change.applicability] : [])];
              const reason = await decide({ ...(owned ? { attributed: texts } : { simulated: texts }), known: knownTexts(card),
                summary: `Карточка «${card.title}» · ${DIFF_FIELD[change.field] ?? change.field}: «${change.value}»${change.applicability ? ` · когда применимо: «${change.applicability}»` : ''}` });
              // A rule that also changes when it applies is a new state of the whole check, so the card is replaced as one owner edit.
              patch = checkpoint && change.applicability
                ? { kind: 'upsert_variant', reason, variant: { ...structuredClone(card), semanticReviewRequired: true, evaluationSpec: { ...card.evaluationSpec,
                    checkpoints: checkpoints.map(item => item.id === checkpoint.id ? { ...item, rule: change.value!.trim(), applicability: change.applicability!.trim() } : item) } } }
                : { kind: 'edit_variant_text', variantId: card.id, field, ...(checkpoint ? { checkpointId: checkpoint.id } : {}), value: change.value.trim(), editId, reason };
            }
          }
          headline = `Карточка «${safeText(card.title)}» изменена`;
        }
        const edited = await lab.editLibrary(draftId, expected, patch, author);
        const after = target ? edited.library.variants.find(item => item.id === target!.id) : undefined;
        const diff = target && after ? variantDiff(target, after) : [];
        const scopeRows = groupScope ? groupScope.preview.split('\n').map(line => row(safeText(line), 'dim', false, 1))
          : patch.kind === 'split_business' ? [row(`Цель группы: ${safeText(patch.newBusiness.goal)}`, 'dim', false, 1),
            row(`Условия группы: ${patch.newBusiness.conditions.length ? patch.newBusiness.conditions.map(safeText).join('; ') : 'нет'}`, 'dim', false, 1)] : [];
        return await changed(headline, [...changeRows(diff), ...scopeRows], after?.id, { recordedReason: patch.reason, diff, ...(groupScope ? { groupScope } : {}) }, `Правка сценариев · прогон ${shortId(draftId)} · ревизия ${edited.library.revision}`);
      } catch (error) {
        if (error instanceof LibraryConflict) {
          const fresh = await reading(directory).readLibrary(draftId);
          markSeen(`${directory}|${draftId}`, libraryHash(fresh.library));
          markSeen(seenKey, libraryHash(fresh.library));
          const feed = libraryFeed(fresh.experiment);
          feed.rows.unshift(row(newerRevision ? `У этого набора есть ревизия новее, чем в прогоне ${shortId(found.id)}: правки идут в неё. Ничего не записано; ниже она — решите по ней.`
            : 'Сценарии изменились с тех пор, как я их читал (доска или другая сессия). Ничего не записано; ниже свежее состояние.', 'warning', true));
          return feedResult(callId, { status: 'stale_library', mutated: false, ...output(fresh.experiment, fresh.library),
            instruction: 'The library changed since you last saw it. Decide again on this fresh state and repeat the operation if it still applies.' }, feed, `Сценарии изменились · прогон ${shortId(draftId)}`);
        }
        throw error;
      } finally { if (!handedOver) await close(); }
    } catch (error) { return askOwner(callId, error); }
  },
});
}
