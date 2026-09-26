import { evaluateTrial } from './evaluation.js';
import { fingerprint, settingsSchema, worldSchema, type ExamResult, type ExamTurn, type RunnableTarget, type Scenario, type TraceEvent, type Trial } from './contracts.js';
import type { Exam } from './target-schema.js';
import { contains } from './card/checks.js';
import { countText } from './plural.js';
import { clip } from './text.js';

/*
 * The connection exam: before anything is measured through a connection, a few short multi-turn paths written for this
 * agent prove the channel itself — the agent keeps the conversation, keeps conversations apart, offers and takes buttons,
 * answers the customer instead of a service status, hands over to a person when it should. Each path is a fresh
 * conversation through the same executor a run uses (evaluation.ts), with a scripted customer and no model: nothing is
 * judged here, only which turn the agent gave and which values its words hold.
 *
 *   1. before: each memory question alone, in a fresh conversation ── the value must NOT come without the earlier turn
 *   2. the paths, all open at once, one message at a time, round after round (relay) ─► evaluateTrial ─► step by step:
 *        the turn the agent gave ─► what the path expects? └─ contains the word?
 *        a reply of one conversation ─► holds a value another conversation told the agent? ─► not kept apart
 *   3. after: each memory question again, in a fresh conversation ── no value any path told may reach it
 *
 *   three properties, each marked on its own:  replies reach the customer (transport) · memory · isolation
 *   all three shown ─► passed      a path or a property broke ─► failed      proven only in part ─► simple
 *   a connection without an exam ─► absent
 *
 * Memory is shown by a probe: a later step that checks with `contains` a value the customer gave earlier in the same
 * path and does not repeat in that step — «мой номер 783194» … «какой у меня номер?» → 783194. A step that checks a word
 * the agent says anyway («Здравствуйте») proves nothing, so the probe's question is also asked alone before the paths:
 * a reply that holds the value without the earlier turn does not show memory. Isolation is shown only by two memory
 * probes of two paths (isolationPairs) — two customers open at once, each with a value of its own — whose values differ
 * (neither holds the other), neither of which is in the other path's own words, and which the relay's order interleaves:
 * each path asks for its value after the other path told the agent its own. Each answer must hold its own value and not
 * the other's, and a fresh conversation after all paths must hold none of them. A step of another path that checks some
 * word of its own («Здравствуйте») proves nothing about isolation: an agent that keeps one memory for everyone passes it.
 * The paths start only once every conversation is open, so the order of messages is always the same.
 * A run starts only on an exam that did not fail (lab/run.ts); without a passed one it is measured and its percent is
 * not shown (result-view.ts): the number stands on a connection nobody has shown to work. An exam stored before these
 * controls existed has no `properties`: its «passed» is the old protocol's, and the result says so (caveats.ts).
 */

type Step = Exam[number]['steps'][number];
type Path = Exam[number];
type PathResult = ExamResult['paths'][number];
type Control = NonNullable<ExamResult['controls']>[number];

const customerText = (step: Step): string => step.say ?? step.press ?? '';

/** Where a path shows memory: a later step that asks for `value`, which the customer gave at step `given` of the same path. */
export interface MemoryProbe { path: number; step: number; value: string; given: number }

/**
 * Each path's first memory probe: a later `say` step whose `contains` value the customer gave earlier in the same path —
 * in words or by a button — and does not repeat in that step. A step checking a value nobody gave proves nothing about memory.
 */
export function memoryProbes(exam: Exam): MemoryProbe[] {
  return exam.flatMap((path, index) => {
    for (let i = 1; i < path.steps.length; i++) {
      const step = path.steps[i]!;
      const value = step.contains;
      if (step.say === undefined || value === undefined || contains(step.say, value)) continue;
      const given = path.steps.slice(0, i).findIndex(earlier => contains(customerText(earlier), value));
      if (given >= 0) return [{ path: index, step: i, value, given }];
    }
    return [];
  });
}

/** Everything a path itself tells the agent: its customer's messages and its start state. */
const pathMaterial = (path: Path): string =>
  [...path.steps.map(customerText), path.initialState === undefined ? '' : JSON.stringify(path.initialState)].join('\n');

/** A step's place in the relay's order: round after round, the paths in order, each message answered before the next (relay). */
const relayPlace = (exam: Exam, path: number, step: number): number => step * exam.length + path;

/**
 * Two memory probes that can show conversations are kept apart: of two paths held open together, with values that
 * differ — neither holds the other —, neither value in the other path's own words, and interleaved by the relay so that
 * each path asks for its value after the other path told the agent its own. One keeps its customer's value and not the
 * other's only if the agent keeps the two conversations apart.
 */
export interface IsolationPair { a: MemoryProbe; b: MemoryProbe }

/** Every pair of memory probes of the exam that meets the isolation contract (IsolationPair), in path order. */
export function isolationPairs(exam: Exam): IsolationPair[] {
  const probes = memoryProbes(exam);
  const place = (probe: MemoryProbe, step: number) => relayPlace(exam, probe.path, step);
  return probes.flatMap((a, i) => probes.slice(i + 1).flatMap((b): IsolationPair[] => {
    if (a.path === b.path || contains(a.value, b.value) || contains(b.value, a.value)) return [];
    if (contains(pathMaterial(exam[b.path]!), a.value) || contains(pathMaterial(exam[a.path]!), b.value)) return [];
    return place(a, a.step) > place(b, b.given) && place(b, b.step) > place(a, a.given) ? [{ a, b }] : [];
  }));
}

/**
 * Whether an exam can vouch for a percent: it holds a memory probe and a pair of them that can show conversations are
 * kept apart (isolationPairs). An exam without them is too weak to count — a one-question exam is passed by an agent that
 * forgets everything, and an exam whose second path checks a word of its own by an agent that mixes its customers up.
 */
export const examCanVouch = (exam: Exam | undefined): boolean => !!exam && memoryProbes(exam).length > 0 && isolationPairs(exam).length > 0;

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

/**
 * An exam in the owner's words before it is written: every path, and at each of its steps exactly what the customer
 * writes or presses and what the agent's turn must be — nothing of it goes to the agent unseen.
 */
export function examPlanLines(exam: Exam): string[] {
  return exam.flatMap((path, index) => [`Путь ${index + 1}. ${path.name}${path.initialState === undefined ? '' : ' — со своим исходным состоянием'}`,
    ...path.steps.map(step => `  ${step.press !== undefined ? `клиент нажимает «${step.press}»` : `клиент пишет «${step.say ?? ''}»`} → ${EXPECTED[step.expect]}${step.contains !== undefined ? `, в нём «${step.contains}»` : ''}`)]);
}

/** Whether the turn is what the step expects: a reply with buttons is still a reply to the customer. */
function meets(expect: Step['expect'], got: ExamTurn): boolean {
  return expect === 'reply' ? got === 'reply' || got === 'buttons' : got === expect;
}

/**
 * Turns among conversations held open together: one message at a time, in path order, round after round. A conversation
 * asks for its turn before each message — which also says its previous message was answered — and leaves when it ends.
 * The first message waits until every conversation is open, so an agent that clears or shares its state when a
 * conversation opens meets the same order of messages every time.
 */
function relay(count: number): { turn(path: number): Promise<void>; leave(path: number): void } {
  const open = new Set(Array.from({ length: count }, (_, i) => i));
  const waiting = new Map<number, () => void>();
  let holder: number | undefined;
  let next = 0;
  let started = false;
  const pass = () => {
    if (holder !== undefined) return;
    if (!started) {
      if ([...open].some(path => !waiting.has(path))) return;
      started = true;
    }
    for (let step = 0; step < count; step++) {
      const candidate = (next + step) % count;
      if (!open.has(candidate)) continue;
      // The next in order has not asked yet (its previous reply is still coming): the turn waits for it.
      const wake = waiting.get(candidate);
      if (!wake) return;
      waiting.delete(candidate); holder = candidate; next = (candidate + 1) % count;
      wake();
      return;
    }
  };
  return {
    turn(path) {
      if (holder === path) holder = undefined;
      const ready = new Promise<void>(resolve => waiting.set(path, resolve));
      pass();
      return ready;
    },
    leave(path) { open.delete(path); waiting.delete(path); if (holder === path) holder = undefined; pass(); },
  };
}

/** A path as it ran: its steps as stored, and the text of the agent's turn after each step (undefined where none came). */
interface Ran { result: PathResult; replies: (string | undefined)[] }

async function examPath(target: RunnableTarget, path: Path, signal: AbortSignal, beforeTurn?: (turn: number) => Promise<void>): Promise<Ran> {
  const messages = path.steps.map(step => step.say ?? step.press!);
  const settings = settingsSchema.parse({ repeats: 1, maxTurns: path.steps.length + 1, maxCalls: 5, userModes: ['scripted'], maxDurationMs: 180000 });
  const spec = { name: 'Connection exam', instructions: 'Use the external connection.', tools: [] };
  const revision = { id: fingerprint(spec), spec, parentId: null, hypothesis: 'Connection exam', createdAt: new Date().toISOString() };
  const scenario: Scenario = { id: 'connection-exam', familyId: 'exam', split: 'dev', title: path.name, tier: 'smoke', provenance: 'curated', requirementIds: [],
    user: { goal: 'Проверить подключение', facts: 'Заданы путём экзамена', behavior: 'Следовать пути', opening: messages[0]!, script: messages.slice(1), maxFollowUps: messages.length - 1 },
    initialState: path.initialState === undefined ? { records: {}, writableFields: [], transientFailures: 0 } : worldSchema.parse(path.initialState), checks: [] };
  const trial: Trial = await evaluateTrial({ runtime: {}, revision, scenario, sources: [], requirements: [], repeat: 0, manifestHash: fingerprint(path), settings,
    userMode: 'scripted', target, ctx: { signal, timeoutMs: 60000, beforeCall() { signal.throwIfAborted(); }, addUsage() {} }, ...(beforeTurn ? { beforeTurn } : {}) });
  const said = trial.events.flatMap((event, index) => event.type === 'user' ? [{ event, index }] : []);
  const replies: (string | undefined)[] = [];
  let broken = false;
  const steps = path.steps.map((step, i): PathResult['steps'][number] => {
    const user = said[i];
    const pressed = !!(user?.event.result && typeof user.event.result === 'object' && 'choice' in user.event.result);
    const base = { said: clip(user?.event.text ?? messages[i]!, 3000), pressed, expect: step.expect };
    if (broken || !user) return { ...base, got: 'missing', passed: false, problem: broken ? 'не дошли: путь оборвался раньше' : clip(trial.reason || 'разговор оборвался раньше', 1000) };
    const turn = turnAfter(trial.events, user.index);
    // A service text the connection names ends the conversation right after the agent's turn: it is that turn.
    const got: ExamTurn = trial.invalidCause === 'service_reply' && !said[i + 1] && (turn.got === 'reply' || turn.got === 'buttons') ? 'service' : turn.got;
    if (got === 'reply' || got === 'buttons' || got === 'handoff') replies[i] = turn.text ?? '';
    // Where the agent's side broke without a turn (a timeout, a crash), the executor's reason says how.
    const why = got === 'missing' && trial.outcome === 'invalid' && trial.reason ? ` (${clip(trial.reason, 300)})` : '';
    // The conversation broke right on this turn (the adapter could not measure it, a line outside the protocol): the step
    // does not stand, even when it is the path's last.
    const brokeHere = got !== 'missing' && got !== 'service' && got !== 'no_reply' && got !== 'empty' && trial.outcome === 'invalid' && !said[i + 1] && trial.invalidCause !== 'service_reply';
    const problems = [
      ...(step.press !== undefined && !pressed ? [`кнопки «${clip(step.press, 120)}» в прошлом ответе не было`] : []),
      ...(!meets(step.expect, got) ? [`ждали: ${EXPECTED[step.expect]}; было: ${GOT[got]}${why}`] : []),
      ...(step.contains !== undefined && meets(step.expect, got) && !contains(turn.text ?? '', step.contains) ? [`в ответе нет «${clip(step.contains, 120)}»`] : []),
      ...(brokeHere ? [`разговор оборвался на этом ходе (${clip(trial.reason, 300)})`] : []),
    ];
    if (got === 'missing' || got === 'no_reply' || got === 'empty' || got === 'service' || got === 'handoff' && i < path.steps.length - 1) broken = true;
    return { ...base, got, passed: !problems.length, ...(problems.length ? { problem: problems.join('; ') } : {}), ...(turn.status ? { status: clip(turn.status, 200) } : {}) };
  });
  return { result: { name: path.name, passed: steps.every(step => step.passed), steps }, replies };
}

/**
 * A control: a probe's question alone, as the first message of a fresh conversation from the probe path's start state.
 * `dependency` runs before any path spoke — the reply must not hold the probe's own value, else the value comes without
 * the earlier turn and the probe shows no memory; `fresh` runs after every path — the reply must hold no value any path
 * told the agent (`values`), else a new conversation knows what another customer said. A control without a reply to the
 * customer proves neither.
 */
async function control(target: RunnableTarget, exam: Exam, probe: MemoryProbe, kind: Control['kind'], values: readonly { value: string; path: number }[], signal: AbortSignal): Promise<{ control: Control; leaked: boolean }> {
  const source = exam[probe.path]!;
  const step = source.steps[probe.step]!;
  const question: Path = { name: source.name, ...(source.initialState === undefined ? {} : { initialState: source.initialState }), steps: [{ say: step.say!, expect: step.expect }] };
  const ran = await examPath(target, question, signal);
  const turn = ran.result.steps[0]!;
  const reply = ran.replies[0];
  const base = { kind, path: clip(source.name, 200), said: turn.said, got: turn.got };
  if (reply === undefined) return { control: { ...base, passed: false, problem: `контроль не получил ответа клиенту: ${turn.problem ?? GOT[turn.got]}` }, leaked: false };
  const leaked = values.filter(item => !contains(step.say!, item.value) && contains(reply, item.value));
  if (!leaked.length) return { control: { ...base, passed: true }, leaked: false };
  const words = leaked.map(item => item.path === probe.path && kind === 'dependency' ? `«${clip(item.value, 120)}»` : `«${clip(item.value, 120)}» из разговора «${clip(exam[item.path]!.name, 120)}»`).join(', ');
  return { leaked: true, control: { ...base, passed: false, problem: kind === 'dependency'
    ? `ответ содержит ${words} и без предыдущих реплик — этот путь не доказывает память`
    : `новый разговор знает ${words} — разговоры не отделены друг от друга` } };
}

/** Marks a step failed with one more problem. */
function fail(step: PathResult['steps'][number], problem: string): void {
  step.passed = false;
  step.problem = step.problem ? `${step.problem}; ${problem}` : problem;
}

/**
 * Runs the exam of a connection: the dependency controls, then its paths held open together and taking turns (relay),
 * then the fresh-conversation controls; `onPath` hears each path's name as it starts. A connection without one is
 * `absent`; an exam whose paths passed but did not show memory and isolation is `simple`, counted as no exam.
 */
export async function examConnection(target: RunnableTarget, signal: AbortSignal, onPath?: (name: string, index: number, of: number) => void): Promise<ExamResult> {
  const checkedAt = new Date().toISOString();
  const exam = target.exam;
  if (!exam) return { checkedAt, status: 'absent', paths: [] };
  signal.throwIfAborted();
  const probes = memoryProbes(exam);
  const controls: Control[] = [];
  // A path has one probe at most (memoryProbes), so its place names the probe's controls.
  const dependency = new Map<number, Control>();
  for (const probe of probes) {
    const { control: result } = await control(target, exam, probe, 'dependency', [{ value: probe.value, path: probe.path }], signal);
    dependency.set(probe.path, result); controls.push(result);
  }
  const turns = relay(exam.length);
  const ran = await Promise.all(exam.map(async (path, index) => {
    onPath?.(path.name, index, exam.length);
    try { return await examPath(target, path, signal, () => turns.turn(index)); }
    finally { turns.leave(index); }
  }));
  signal.throwIfAborted();
  const paths = ran.map(item => item.result);

  // Isolation across the open conversations, pair by pair: a reply of one path, after the other path told its value,
  // that holds that value is a leak; a pair whose two answers each hold their own value and no leak shows the paths apart.
  const pairs = isolationPairs(exam);
  let isolationBroken = false;
  const apart: IsolationPair[] = [];
  for (const pair of pairs) {
    let leaked = false;
    for (const [own, other] of [[pair.a, pair.b], [pair.b, pair.a]] as const) {
      ran[own.path]!.replies.forEach((reply, index) => {
        if (reply === undefined || relayPlace(exam, own.path, index) < relayPlace(exam, other.path, other.given) || !contains(reply, other.value)) return;
        const step = paths[own.path]!.steps[index]!;
        const problem = `в ответе «${clip(other.value, 120)}» из разговора «${clip(exam[other.path]!.name, 120)}» — разговоры не отделены друг от друга`;
        if (!step.problem?.includes(problem)) fail(step, problem);
        leaked = true;
      });
    }
    const holds = (probe: MemoryProbe) => { const reply = ran[probe.path]!.replies[probe.step]; return reply !== undefined && contains(reply, probe.value); };
    if (leaked) isolationBroken = true;
    else if (holds(pair.a) && holds(pair.b)) apart.push(pair);
  }
  for (const path of paths) path.passed = path.steps.every(step => step.passed);

  // Memory: a probe whose later step held the value, and whose question alone did not.
  const values = probes.map(probe => ({ value: probe.value, path: probe.path }));
  const heldProbes = probes.filter(probe => ran[probe.path]!.replies[probe.step] !== undefined && contains(ran[probe.path]!.replies[probe.step]!, probe.value));
  const forgotten = probes.some(probe => {
    const reply = ran[probe.path]!.replies[probe.step];
    return reply !== undefined && !contains(reply, probe.value) && !values.some(item => item.path !== probe.path && contains(reply, item.value));
  });
  const memoryShown = heldProbes.some(probe => dependency.get(probe.path)?.passed);

  // A fresh conversation after every path: it knows none of the values the paths told.
  const fresh: Control[] = [];
  const freshOf = new Map<number, Control>();
  if (paths.every(path => path.passed)) {
    for (const probe of probes.filter(item => dependency.get(item.path)?.passed)) {
      const { control: result, leaked } = await control(target, exam, probe, 'fresh', values, signal);
      fresh.push(result); controls.push(result); freshOf.set(probe.path, result);
      if (leaked) isolationBroken = true;
    }
  }
  signal.throwIfAborted();

  // A pair proves isolation once both its probes show memory (their questions alone did not bring the values) and the
  // fresh conversation after the paths knew none of the values (every fresh control ran and passed).
  const proven = (probe: MemoryProbe) => dependency.get(probe.path)?.passed === true && freshOf.get(probe.path)?.passed === true;
  const properties: NonNullable<ExamResult['properties']> = {
    transport: paths.every(path => path.steps.every(step => meets(step.expect, step.got))) ? 'passed' : 'failed',
    memory: forgotten ? 'failed' : memoryShown ? 'shown' : 'not_shown',
    isolation: isolationBroken ? 'failed' : fresh.length > 0 && fresh.every(item => item.passed) && apart.some(pair => proven(pair.a) && proven(pair.b)) ? 'shown' : 'not_shown',
  };
  const failed = !paths.every(path => path.passed) || properties.isolation === 'failed';
  const status = failed ? 'failed' : properties.transport === 'passed' && properties.memory === 'shown' && properties.isolation === 'shown' ? 'passed' : 'simple';
  return { checkedAt, status, paths, properties, ...(controls.length ? { controls } : {}) };
}

const MEMORY_HOW = 'нужен путь, где клиент называет значение (номер, имя, выбор), а следующий шаг спрашивает о нём и через contains проверяет, что агент его помнит; в самом вопросе значение не повторяется';
const ISOLATION_HOW = 'нужны два пути, у каждого своё значение (например, разные номера терминала, и ни один не входит в другой): каждый клиент называет своё, а поздний шаг спрашивает о нём и проверяет через contains; вопрос каждого пути должен идти после того, как другой путь назвал своё значение, — пути идут по очереди, шаг за шагом';
const PROPERTY_WORDS = { passed: 'да', failed: 'нет', shown: 'доказана', not_shown: 'не показана' } as const;

/** Why an exam whose paths passed does not count, in the owner's words: what it did not show and how to show it. */
function simpleLines(result: ExamResult): string[] {
  const properties = result.properties;
  // An exam stored before the controls existed: its «simple» meant no path checked memory.
  if (!properties) return [`Экзамен подключения слишком простой: нет проверки памяти разговора — ${MEMORY_HOW}. Пока процент качества не считается.`];
  return [`Пути экзамена пройдены, но для процента этого мало: ${[
    ...(properties.memory !== 'shown' ? [`память разговора не показана — ${MEMORY_HOW}`] : []),
    ...(properties.isolation !== 'shown' ? [`не показано, что разговоры не смешиваются — ${ISOLATION_HOW}`] : []),
  ].join('; ')}.`];
}

/** The exam in the owner's words, one line a path and one a failed step: what was sent, what the agent gave, why it is not what the path expects. */
export function examLines(result: ExamResult): string[] {
  if (result.status === 'absent') return ['Экзамена подключения нет: процент качества не считается, пока подключение не проверено. Добавьте в подключение раздел exam.'];
  const failed = result.paths.filter(path => !path.passed).length;
  const properties = result.properties;
  return [
    failed ? `Экзамен подключения не пройден: ${countText(failed, ['путь', 'пути', 'путей'])} из ${result.paths.length} с ошибкой.`
      : result.status === 'failed' ? 'Экзамен подключения не пройден: разговоры не отделены друг от друга.'
      : result.status === 'simple' ? simpleLines(result)[0]! : `Экзамен подключения пройден: ${countText(result.paths.length, ['путь', 'пути', 'путей'])}.`,
    ...(properties ? [`Ответы доходят: ${PROPERTY_WORDS[properties.transport]} · память разговора: ${PROPERTY_WORDS[properties.memory]} · разговоры не смешиваются: ${properties.isolation === 'shown' ? 'доказано' : properties.isolation === 'failed' ? 'нет' : 'не показано'}.`]
      : result.status === 'passed' ? ['Экзамен прежнего протокола: зависимость ответа от прошлых реплик и изоляция разговоров контрольными разговорами не проверялись.'] : []),
    ...result.paths.flatMap(path => [`${path.passed ? '✓' : '✗'} ${path.name}`,
      ...path.steps.flatMap((step, i) => step.passed ? [] : [`    шаг ${i + 1} «${clip(step.said, 80)}»${step.pressed ? ' (кнопка)' : ''}: ${step.problem ?? ''}${step.status ? ` · статус агента ${step.status}` : ''}`])]),
    ...(result.controls ?? []).flatMap(item => item.passed ? [] : [`✗ Контроль «${clip(item.said, 80)}» в новом разговоре ${item.kind === 'dependency' ? 'до путей' : 'после путей'} (${item.path}): ${item.problem ?? ''}`]),
  ];
}

/** Why a run did not start: the exam's own lines and the next step. */
export function examRefusal(result: ExamResult): string {
  return `${examLines(result).join('\n')}\nПрогон не запущен: через это подключение Lab не может честно измерить агента. Исправьте адаптер или стенд и запустите снова.`;
}
