import { resolve } from 'node:path';
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { wordsOf } from '../src/card/commands.js';
import type { CardCommand } from '../src/card/schema.js';
import type { Decision, DecisionChoice } from '../src/inbox.js';
import { decisionsLine } from '../src/inbox.js';
import type { ExperimentLab } from '../src/experiment.js';
import { safeLine, safeText } from '../src/text.js';
import type { Background } from './background.ts';
import { row } from './conversation.ts';
import { applySituationCommand, busyFor, chatQueue, settle, writer, type DecisionSurface } from './decisions.ts';
import { displayFor, NeedsOwner, requireInteractive } from './lab-ui.ts';
import { decisionsOutput } from './model-output.ts';
import type { LabLease, SessionOperations } from './operations.ts';
import type { Feed } from './render/feed.ts';
import { TOOL } from './steps.ts';

/*
 * «Что ждёт моего решения?» in the chat (docs/design/ui-spec.md §8.7): the same queue as the workspace's, derived from the records.
 * The model names a decision by its key and may say which answer the owner gave in words; the owner always picks in
 * a native dialog of the decision itself, and only that pick is recorded. Nothing here decides for the owner.
 */

export interface DecideHost {
  operations: SessionOperations;
  open: (cwd: string, pendingCheck?: 'cancel' | 'wait') => Promise<LabLease>;
  reading: (directory: string) => ExperimentLab;
  background: Background;
  feedResult: (callId: string, output: unknown, feed: Feed, note: string) => AgentToolResult<unknown>;
  askOwner: (callId: string, error: unknown) => AgentToolResult<unknown>;
}

const closed = { additionalProperties: false } as const;

/** The queue as the chat shows it: how many wait and that they never block the ready situations; each with its answers on expand. */
function queueFeed(decisions: readonly Decision[]): Feed {
  if (!decisions.length) return { rows: [row('Решений не ждёт ничего.', 'text', true)] };
  const first = decisions[0]!;
  return { tone: 'warning',
    rows: [row(`Нужно ваше решение: ${decisions.length} — запуску готовых ситуаций они не мешают`, 'text', true), row(`${first.subject} — ${first.text}`, 'muted')],
    more: decisions.flatMap(decision => [row(decision.subject, 'text', true), row(decision.text, 'muted', false, 2),
      row(decision.choices.filter(choice => choice.settles).map((choice, index) => `${index + 1} ${choice.label}`).join('  ·  '), 'accent', false, 2), row('')]),
    expand: `все ${decisions.length} с вариантами ответа` };
}

export function registerDecideTool(pi: Pick<ExtensionAPI, 'registerTool'>, host: DecideHost): void {
  pi.registerTool({
    ...displayFor(TOOL.decide), name: TOOL.decide, label: 'The owner\'s decisions',
    description: 'What Lab cannot decide without the owner: a situation\'s question, a situation that cannot be a test, checking situations or raising the limit for that, a stopped preparation, a draft of the older format, which agent version wrote the logs, a judge that failed. Without decision: the list, each with its key and numbered answers. With decision (its key) the owner picks the answer in a native dialog; choice is the answer the owner already named in the conversation (it is shown to them), text their words for an answer that needs words. You never answer for the owner; resolved decisions disappear from the list.',
    parameters: Type.Object({
      decision: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: 'The key of a decision from this tool or agent_lab_cards.' })),
      choice: Type.Optional(Type.Integer({ minimum: 1, maximum: 3, description: 'The answer the owner named, by its number.' })),
      text: Type.Optional(Type.String({ minLength: 1, maxLength: 1000, description: 'The owner\'s words for an answer that needs words (they can correct them in the native editor).' })),
    }, closed),
    executionMode: 'sequential',
    async execute(callId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const directory = resolve(ctx.cwd, '.agent-lab');
      try {
        const queue = await chatQueue(host.reading(directory));
        if (!params.decision) return host.feedResult(callId, { decisions: decisionsOutput(queue.decisions), note: decisionsLine(queue.decisions.length) }, queueFeed(queue.decisions), 'Решения');
        // Work going on in this session holds the writer's lease: said first, so the owner is never asked a question
        // whose answer could not be written, and the work that hides a draft's decisions is named as what is going on.
        const busy = await busyFor(host.operations, directory);
        if (busy) throw new Error(busy);
        const decision = queue.decisions.find(item => item.key === params.decision);
        if (!decision) throw new NeedsOwner('unknown_reference', `Решения «${params.decision}» уже нет: его приняли или оно изменилось. Сейчас ждут: ${queue.decisions.map(item => item.key).join(', ') || 'ничего'}.`,
          queue.decisions.map(item => item.key), 'Этого решения уже нет: его приняли или оно изменилось.');
        const settling = decision.choices.filter(choice => choice.settles);
        if (!settling.length) return host.feedResult(callId, { decided: false, instruction: 'This decision only opens what it is about: show the situation with agent_lab_cards or the conversation with agent_lab_explain.' },
          { tone: 'warning', rows: [row(`${decision.subject} — ${decision.text}`)] }, 'Решение');
        requireInteractive(ctx, 'Решение принимает владелец в интерактивном терминале Pi.');
        // The owner picks in a dialog of the decision itself; the answer the model heard is shown as what they said.
        const named = params.choice === undefined ? undefined : settling[params.choice - 1];
        // An answer's words come from the records: each crosses the terminal boundary, and the pick is matched as shown.
        const labels = settling.map((choice, index) => safeLine(`${index + 1}  ${choice.label}`));
        const picked = await ctx.ui.select(safeText([decision.subject, '', decision.text, ...(named ? ['', `В разговоре вы ответили: «${named.label}»`] : [])].join('\n')), [...labels, 'Не сейчас']);
        const choice = settling[labels.indexOf(picked ?? '')];
        if (!choice) return host.feedResult(callId, { decided: false, declined: true, instruction: 'The owner did not decide now. Nothing was written; do not ask again unless they do.' },
          { tone: 'warning', rows: [row('Не решено: вы не выбрали ответ.')] }, 'Решение');
        const surface: DecisionSurface = { ctx, origin: 'chat', writing: writer(host.operations, host.open, ctx.cwd, directory), background: host.background };
        const notice = await resolveChoice(surface, choice, queue.draft, params.text, await host.reading(directory).list());
        if (notice === undefined) return host.feedResult(callId, { decided: false, declined: true, instruction: 'The owner stepped back in the editor. Nothing was written.' },
          { tone: 'warning', rows: [row('Не решено: ответ без слов не записан.')] }, 'Решение');
        const left = (await chatQueue(host.reading(directory))).decisions;
        return host.feedResult(callId, { decided: true, notice, left: decisionsOutput(left) },
          { rows: [row(safeText(notice), 'text', true), row(decisionsLine(left.length), 'muted')] }, 'Решение');
      } catch (error) { return host.askOwner(callId, error); }
    },
  });
}

/**
 * What the owner's pick does. An answer to a situation's question is its ready-made command, with the owner's words
 * when it needs them (typed in the native editor, prefilled with what they said); a version of the logs named in words
 * the same. Undefined when the owner closed the editor.
 */
async function resolveChoice(surface: DecisionSurface, choice: DecisionChoice, draft: Awaited<ReturnType<typeof chatQueue>>['draft'], said: string | undefined,
  records: Parameters<typeof settle>[2]): Promise<string | undefined> {
  const { action } = choice;
  const ctx: ExtensionContext = surface.ctx;
  if (action.kind === 'answer' || action.kind === 'remove') {
    const view = draft?.views.find(item => item.id === action.cardId);
    if (!draft || !view) throw new Error('Ситуации этого решения уже нет в черновике.');
    if (action.kind === 'remove') return applySituationCommand(surface, draft.record, view, { command: { kind: 'remove_card', cardId: view.id } });
    const question = view.question;
    if (!question?.id) throw new Error(`У ситуации ${view.number} уже нет открытого вопроса.`);
    let words: string | undefined;
    if (action.choice.needsText) {
      words = (await ctx.ui.editor(`${action.choice.label} — своими словами`, said ?? wordsOf(action.choice.command)[0] ?? ''))?.trim();
      if (!words) return undefined;
    }
    const command: CardCommand = { kind: 'answer_question', cardId: view.id, questionId: question.id, choice: action.choice.id, ...(words ? { text: words } : {}) };
    return applySituationCommand(surface, draft.record, view, { command, ...(words ? { words } : {}) });
  }
  if (action.kind === 'name_log_version') {
    const version = (await ctx.ui.editor('Какая версия агента записала логи · как вы её называете', said ?? ''))?.trim();
    if (!version) return undefined;
    return settle(surface, { kind: 'declare_log_version', importId: action.importId, version }, records);
  }
  const notice = await settle(surface, action, records);
  if (notice === undefined) throw new Error('Это решение нельзя принять из разговора: откройте /agent-lab.');
  return notice;
}
