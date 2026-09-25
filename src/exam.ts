import { evaluateTrial } from './evaluation.js';
import { fingerprint, settingsSchema, worldSchema, type ExamResult, type ExamTurn, type RunnableTarget, type Scenario, type TraceEvent, type Trial } from './contracts.js';
import type { Exam } from './target-schema.js';
import { contains } from './card/checks.js';
import { countText } from './plural.js';
import { clip } from './text.js';

/*
 * The connection exam: before anything is measured through a connection, a few short multi-turn paths written for this
 * agent prove the channel itself — the agent keeps the conversation, offers and takes buttons, answers the customer
 * instead of a service status, hands over to a person when it should. Each path is a fresh conversation through the
 * same executor a run uses (evaluation.ts), with a scripted customer and no model: nothing is judged here, only which
 * turn the agent gave.
 *
 *   path ──scripted customer──► evaluateTrial ──events──► step by step: the turn the agent gave ─► what the path expects?
 *                                                                                                  └─ contains the word?
 *   every step of every path as expected ─► passed            a connection without an exam ─► absent
 *
 * A run starts only on a passed exam (lab/run.ts); without one it is measured and its percent is not shown
 * (result-view.ts): the number stands on a connection nobody has shown to work.
 */

type Step = Exam[number]['steps'][number];

/**
 * Whether an exam can vouch for a percent: at least one path of two or more steps where a later step checks the reply
 * with `contains` — the conversation's memory, shown through the connection. An exam without one is too weak to count.
 */
export const examShowsMemory = (exam: Exam | undefined): boolean =>
  !!exam?.some(path => path.steps.length >= 2 && path.steps.slice(1).some(step => step.contains !== undefined));

/** The agent's turn after one customer message, as the events recorded it. */
function turnAfter(events: readonly TraceEvent[], from: number): { got: ExamTurn; text?: string; status?: string } {
  for (const event of events.slice(from + 1)) {
    if (event.type === 'user') break;
    const facts = event.result && typeof event.result === 'object' ? event.result as { outcome?: unknown; status?: unknown; buttons?: unknown } : undefined;
    const status = typeof facts?.status === 'string' ? facts.status : undefined;
    if (event.type === 'error' && facts?.outcome === 'no_reply') return { got: 'no_reply', ...(status ? { status } : {}) };
    if (event.type !== 'assistant') continue;
    const text = event.text ?? '';
    const got: ExamTurn = facts?.outcome === 'handoff' ? 'handoff' : Array.isArray(facts?.buttons) && facts.buttons.length ? 'buttons' : text.trim() ? 'reply' : 'empty';
    return { got, text, ...(status ? { status } : {}) };
  }
  return { got: 'missing' };
}

const EXPECTED: Record<Step['expect'], string> = { reply: 'ответ клиенту', buttons: 'ответ с кнопками', handoff: 'передача человеку' };
const GOT: Record<ExamTurn, string> = {
  reply: 'ответ клиенту', buttons: 'ответ с кнопками', handoff: 'передача человеку', no_reply: 'агент не дал ответа клиенту',
  empty: 'пустой ответ', service: 'вместо агента ответил стенд', missing: 'ответа не было',
};

/** Whether the turn is what the step expects: a reply with buttons is still a reply to the customer. */
function meets(expect: Step['expect'], got: ExamTurn): boolean {
  return expect === 'reply' ? got === 'reply' || got === 'buttons' : got === expect;
}

async function examPath(target: RunnableTarget, path: Exam[number], signal: AbortSignal): Promise<ExamResult['paths'][number]> {
  const messages = path.steps.map(step => step.say ?? step.press!);
  const settings = settingsSchema.parse({ repeats: 1, maxTurns: path.steps.length + 1, maxCalls: 5, userModes: ['scripted'], maxDurationMs: 180000 });
  const spec = { name: 'Connection exam', instructions: 'Use the external connection.', tools: [] };
  const revision = { id: fingerprint(spec), spec, parentId: null, hypothesis: 'Connection exam', createdAt: new Date().toISOString() };
  const scenario: Scenario = { id: 'connection-exam', familyId: 'exam', split: 'dev', title: path.name, tier: 'smoke', provenance: 'curated', requirementIds: [],
    user: { goal: 'Проверить подключение', facts: 'Заданы путём экзамена', behavior: 'Следовать пути', opening: messages[0]!, script: messages.slice(1), maxFollowUps: messages.length - 1 },
    initialState: path.initialState === undefined ? { records: {}, writableFields: [], transientFailures: 0 } : worldSchema.parse(path.initialState), checks: [] };
  const trial: Trial = await evaluateTrial({ runtime: {}, revision, scenario, sources: [], requirements: [], repeat: 0, manifestHash: fingerprint(path), settings,
    userMode: 'scripted', target, ctx: { signal, timeoutMs: 60000, beforeCall() { signal.throwIfAborted(); }, addUsage() {} } });
  const said = trial.events.flatMap((event, index) => event.type === 'user' ? [{ event, index }] : []);
  let broken = false;
  const steps = path.steps.map((step, i): ExamResult['paths'][number]['steps'][number] => {
    const user = said[i];
    const pressed = !!(user?.event.result && typeof user.event.result === 'object' && 'choice' in user.event.result);
    const base = { said: clip(user?.event.text ?? messages[i]!, 3000), pressed, expect: step.expect };
    if (broken || !user) return { ...base, got: 'missing', passed: false, problem: broken ? 'не дошли: путь оборвался раньше' : clip(trial.reason || 'разговор оборвался раньше', 1000) };
    const turn = turnAfter(trial.events, user.index);
    // A service text the connection names ends the conversation right after the agent's turn: it is that turn.
    const got: ExamTurn = trial.invalidCause === 'service_reply' && !said[i + 1] && (turn.got === 'reply' || turn.got === 'buttons') ? 'service' : turn.got;
    // Where the agent's side broke without a turn (a timeout, a crash), the executor's reason says how.
    const why = got === 'missing' && trial.outcome === 'invalid' && trial.reason ? ` (${clip(trial.reason, 300)})` : '';
    const problems = [
      ...(step.press !== undefined && !pressed ? [`кнопки «${clip(step.press, 120)}» в прошлом ответе не было`] : []),
      ...(!meets(step.expect, got) ? [`ждали: ${EXPECTED[step.expect]}; было: ${GOT[got]}${why}`] : []),
      ...(step.contains !== undefined && meets(step.expect, got) && !contains(turn.text ?? '', step.contains) ? [`в ответе нет «${clip(step.contains, 120)}»`] : []),
    ];
    if (got === 'missing' || got === 'no_reply' || got === 'empty' || got === 'service' || got === 'handoff' && i < path.steps.length - 1) broken = true;
    return { ...base, got, passed: !problems.length, ...(problems.length ? { problem: problems.join('; ') } : {}), ...(turn.status ? { status: clip(turn.status, 200) } : {}) };
  });
  return { name: path.name, passed: steps.every(step => step.passed), steps };
}

/** Runs the exam of a connection; `onPath` hears each path's name as it starts. A connection without one is `absent`. */
export async function examConnection(target: RunnableTarget, signal: AbortSignal, onPath?: (name: string, index: number, of: number) => void): Promise<ExamResult> {
  const checkedAt = new Date().toISOString();
  if (!target.exam) return { checkedAt, status: 'absent', paths: [] };
  const paths: ExamResult['paths'] = [];
  for (const [index, path] of target.exam.entries()) {
    signal.throwIfAborted();
    onPath?.(path.name, index, target.exam.length);
    paths.push(await examPath(target, path, signal));
  }
  return { checkedAt, status: paths.every(path => path.passed) ? 'passed' : 'failed', paths };
}

/** The exam in the owner's words, one line a path and one a failed step: what was sent, what the agent gave, why it is not what the path expects. */
export function examLines(result: ExamResult): string[] {
  if (result.status === 'absent') return ['Экзамена подключения нет: процент качества не считается, пока подключение не проверено. Добавьте в подключение раздел exam.'];
  const failed = result.paths.filter(path => !path.passed).length;
  return [
    failed ? `Экзамен подключения не пройден: ${countText(failed, ['путь', 'пути', 'путей'])} из ${result.paths.length} с ошибкой.` : `Экзамен подключения пройден: ${countText(result.paths.length, ['путь', 'пути', 'путей'])}.`,
    ...result.paths.flatMap(path => [`${path.passed ? '✓' : '✗'} ${path.name}`,
      ...path.steps.flatMap((step, i) => step.passed ? [] : [`    шаг ${i + 1} «${clip(step.said, 80)}»${step.pressed ? ' (кнопка)' : ''}: ${step.problem ?? ''}${step.status ? ` · статус агента ${step.status}` : ''}`])]),
  ];
}

/** Why a run did not start: the exam's own lines and the next step. */
export function examRefusal(result: ExamResult): string {
  return `${examLines(result).join('\n')}\nПрогон не запущен: через это подключение Lab не может честно измерить агента. Исправьте адаптер или стенд и запустите снова.`;
}
