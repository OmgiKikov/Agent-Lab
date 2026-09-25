import { SERVICE_REPLY_REASON } from './run.js';
import { judgedScenario } from './card/legacy-v1.js';
import { directChecks } from './checkpoints.js';
import { createUserState, allowedUserActions, advanceUser, requiredUserTurns, userDecisionSchema } from './user-controller.js';
import { CARD_CUSTOMER_PROTOCOL, customerBrief, customerReplyIssue, customerReplySchema, deliveredMessage, pressedButton, type CustomerBrief } from './card-customer.js';
import { randomUUID } from 'node:crypto';
import { addUsage, emptyUsage, isCardExecution, runnableTarget, scriptIssue, type CheckResult, type InvalidCause, type Requirement, type Revision, type Scenario, type Settings, type Source, type Target, type TraceEvent, type Trial, type UserMode } from './contracts.js';
import { assessmentRubrics, judgeAuditSchema, metricApplies, RAG_METRIC_IDS, ragEvidenceComplete, validateAssessments, type JudgeAudit, type MetricAssessment } from './assessment.js';
import { userTurnSchema, type ButtonChoice, type CallContext, type DialogueMessage, type Runtime, type TargetSession } from './runtime.js';
import { valueTokens } from './verbatim.js';
import { agentEventsBeforeBreak, countedBeforeBreak, cutOffEvidenceEvents, hasCompleteCutOffJudgment, hasCompleteJudgment, judgmentEvidenceEvents, judgmentFailure, observableSources, sealJudgeReceipt, type CutOff } from './judge.js';
import { ProviderFailure, type ProviderFailureKind } from './llm/model-call.js';
import { StructuredTaskError } from './llm/structured.js';
import { AgentFailure, AgentRequestFailed, ConnectionFailure, MeasurementFailure, Stopped } from './errors.js';
import { openExternalTarget, type AgentButton, type TurnOutcome } from './targets.js';
import { simulatorChecks } from './simulator.js';
import { clip } from './text.js';

/*
 * One trial = one fresh world, one target session, one user side.
 *
 *   opening ──► target.respond ──► [static? budget? done?] ──► next user message ──► target.respond ──► ...
 *      │                                   │ compiled card (execution): runtime.selectUserAction   │
 *      │                                   │ older card, reactive: runtime.userTurn (free LLM user) │
 *      │                                   │ scripted: user.script[turn]                            │
 *      └────────── every message, tool call/result and user decision → trial.events ◄──────────────┘
 *   end ──► grade(checks) over finalState + events ──► outcome ──► rubric assessment (a card: one per expectation)
 *
 * Target: an external agent (http/module/command) whose reported events/records feed the grading.
 * Invalid = the harness could not measure the agent. Fail = the agent was measured and fell short.
 * The run's limit on the customer's messages ends a conversation like the customer leaving does: the controlled
 * customer never plans past it, and a talk that runs into it is judged as it went (`trial.turnLimit`).
 */
function freshReadEvidence(events: TraceEvent[]): { passed: boolean; evidence: string } {
  const fresh = new Set<string>();
  const violations: string[] = [];
  let updates = 0;
  let pending: { tool?: string; recordId?: string; seq: number } | undefined;
  for (const event of events) {
    if (event.type === 'tool_call') {
      if (pending) violations.push(`Call at event ${pending.seq} has no paired result before event ${event.seq}`);
      const recordId = event.args && typeof event.args === 'object' && 'recordId' in event.args && typeof event.args.recordId === 'string' ? event.args.recordId : undefined;
      pending = { tool: event.tool, recordId, seq: event.seq };
      if (event.tool === 'update_record') {
        updates += 1;
        if (!recordId || !fresh.has(recordId)) violations.push(`Update at event ${event.seq} (${recordId ?? 'missing record ID'}) has no successful fresh lookup of that record`);
      }
    } else if (event.type === 'tool_result') {
      if (!pending || pending.tool !== event.tool) {
        violations.push(`Result at event ${event.seq} has no matching sequential call`);
      } else if (event.result && typeof event.result === 'object' && 'ok' in event.result && event.result.ok === true
        && (event.tool === 'lookup_record' || event.tool === 'update_record')) {
        if (!pending.recordId || !('recordId' in event.result) || event.result.recordId !== pending.recordId) {
          violations.push(`Successful result at event ${event.seq} does not identify the called record`);
        } else if (event.tool === 'lookup_record') fresh.add(pending.recordId);
        else fresh.delete(pending.recordId);
      }
      pending = undefined;
    }
  }
  if (pending) violations.push(`Call at event ${pending.seq} has no paired result`);
  return {
    passed: violations.length === 0,
    evidence: violations.length ? violations.join('; ') : updates
      ? `${updates} update attempt(s) each followed a successful lookup of the same record since its last successful update. Failed retries retained the read.`
      : 'No update attempts; the read-before-update constraint was not exercised.',
  };
}

/** What the adapter said a turn gave the customer beside its text; an adapter that says nothing gave a plain reply. */
interface TurnFacts { outcome: TurnOutcome; status?: string; buttons: AgentButton[] }
const PLAIN_REPLY: TurnFacts = { outcome: 'reply', buttons: [] };

/** The button the customer pressed: a message that is one offered button's text, up to case and spacing. */
function pressOf(offered: readonly AgentButton[], message: string): ButtonChoice | undefined {
  const press = pressedButton(offered, message);
  return press ? { index: press.index, text: press.button.text, ...(press.button.value !== undefined ? { value: press.button.value } : {}) } : undefined;
}

/** A turn that gave the customer nothing; the agent's status is named as the adapter wrote it. */
const noReplyBreak = (status: string | undefined) => `Агент не дал ответа клиенту${status ? ` (статус ${clip(status, 200)})` : ''}: ход не дошёл до клиента.`;
/** What became of a conversation the agent's side broke: not measured, or — once the agent had spoken — judged up to the break. */
const UNMEASURED = ' Разговор не измерен.';
const JUDGED_TO_BREAK = ' Разговор оценён до обрыва: засчитывается только нарушение, которое видно в словах агента до обрыва.';

/** Who broke a conversation, in the owner's words, by its cause — never by the step it was at. */
const BROKEN_BY: Record<InvalidCause, string> = {
  turn_limit: 'Лимит реплик прогона', simulator: 'Клиент, которого играет Lab', agent: 'Агент не дал ответа клиенту', service_reply: 'Вместо агента ответил стенд',
  measurement: 'Измерение не удалось', no_reply: 'Агент не дал ответа клиенту', connection: 'Сбой подключения к агенту',
  provider: 'Провайдер модели не ответил клиенту, которого играет Lab',
};

/** Why the model provider left the customer Lab plays without an answer, and what the owner does about it. */
const PROVIDER_WHY: Record<ProviderFailureKind, string> = {
  'rate limit': 'провайдер ограничил частоту запросов — повторите прогон позже', overloaded: 'провайдер перегружен — повторите прогон позже',
  'connection failure': 'нет связи с провайдером — проверьте сеть и повторите прогон', timeout: 'модель не ответила вовремя — повторите прогон позже',
  deadline: 'модель не ответила за отведённое время — повторите прогон позже', 'insufficient credit': 'у провайдера закончились средства — пополните счёт',
  'access denied': 'провайдер отказал в доступе — проверьте ключ и права на модель', unavailable: 'модель недоступна — проверьте ключ и модель',
  'context limit': 'запрос не поместился в окно модели', incomplete: 'модель оборвала ответ — повторите прогон', empty: 'модель вернула пустой ответ — повторите прогон',
  length: 'ответ модели упёрся в предел длины',
};

/** The errors an error carries, itself first: a structured task wraps what it could not finish (llm/structured.ts). */
function* causes(error: unknown): Generator<unknown> {
  for (let cause = error, depth = 0; cause !== undefined && depth < 8; cause = cause instanceof Error ? cause.cause : undefined, depth++) yield cause;
}
function carried<T>(error: unknown, type: abstract new (...args: never[]) => T): T | undefined {
  for (const cause of causes(error)) if (cause instanceof type) return cause;
  return undefined;
}

/**
 * Why a conversation broke, by the type of what broke it, never by its words or the step it was at: the adapter could
 * not measure the turn; the model provider refused Lab's customer; Lab could not start the adapter or read its reply
 * (the connection, and whatever else no type names on the agent's side — Lab's own failure is never the agent's); the
 * agent's side gave the turn nothing; otherwise, while the customer spoke, the customer Lab plays. `refusal`: the
 * cause of Lab's own refusal before the agent was contacted.
 */
function breakOf(error: unknown, speaking: 'agent' | 'customer'): { cause: InvalidCause; detail: string } {
  const text = (value: unknown) => value instanceof Error ? value.message : 'неизвестный сбой';
  const measurement = carried(error, MeasurementFailure);
  if (measurement) return { cause: 'measurement', detail: measurement.message };
  const provider = carried(error, ProviderFailure);
  if (provider) return { cause: 'provider', detail: PROVIDER_WHY[provider.kind] };
  const connection = carried(error, ConnectionFailure);
  if (connection) return { cause: 'connection', detail: connection.message };
  const request = carried(error, AgentRequestFailed);
  if (request) return { cause: request.kind === 'tls' ? 'connection' : 'agent', detail: request.message };
  const failure = carried(error, AgentFailure);
  if (failure) return { cause: 'agent', detail: failure.message };
  if (speaking === 'agent') return { cause: 'connection', detail: text(error) };
  return { cause: 'simulator', detail: carried(error, StructuredTaskError) ? 'ответы модели клиента раз за разом не проходили проверку Lab' : text(error) };
}

export function grade(scenario: Scenario, trial: Trial): CheckResult[] {
  if (scenario.execution) {
    if (scenario.execution.environmentView.mode === 'managed' && trial.observation?.state !== 'sandbox' && trial.observation?.resetConfirmed !== true) throw new Error('Сброс управляемого окружения не подтверждён адаптером.');
    scenario = { ...scenario, checks: directChecks(scenario, trial) };
  }
  if (scenario.initialState.external && trial.observation?.resetConfirmed !== true) {
    throw new Error('Внешнее состояние карточки не подтверждено адаптером (resetConfirmed). Измерение недействительно.');
  }
  if (scenario.checks.some(c => c.kind === 'state_equals') && trial.observation?.state === 'missing') {
    throw new Error('Внешний агент не сообщил итоговое состояние. Проверки состояния не измерены.');
  }
  if (scenario.checks.some(c => c.kind.startsWith('tool_') || c.kind === 'fresh_read_before_update') && trial.observation?.tools === 'partial') {
    throw new Error('Адаптер не подтвердил полноту событий инструментов (eventsComplete). Проверки действий не измерены.');
  }
  for (const check of scenario.checks) if (check.kind === 'state_equals') {
    const observed = trial.finalState.records[check.recordId];
    if (!observed || !Object.hasOwn(observed, check.field)) throw new Error(`Не наблюдалось поле ${check.recordId}.${check.field}. Проверка не измерена.`);
    if (trial.observation && trial.observation.state !== 'sandbox' && trial.observation.resetConfirmed !== true) throw new Error('Адаптер не подтвердил сброс исходного состояния (resetConfirmed).');
  }
  const scope = trial.observation?.toolScope;
  if (scope) for (const check of scenario.checks) {
    const tools = check.kind === 'fresh_read_before_update' ? ['lookup_record', 'update_record'] : 'tool' in check ? [check.tool] : [];
    if (tools.some(tool => !scope.some(pattern => pattern.endsWith('*') ? tool.startsWith(pattern.slice(0, -1)) : tool === pattern))) {
      throw new Error('Проверяемый инструмент не входит в заявленную полную область событий адаптера.');
    }
  }
  const retrieved = retrievedChunks(trial.events);
  // Case is folded without the host's locale: under tr_TR «ID» would fold to «ıd» and miss «id».
  const answers = trial.events.filter(e => e.type === 'assistant').map(e => e.text ?? '').join('\n').toLowerCase();
  return scenario.checks.map(check => {
    let passed: boolean;
    let evidence: string;
    if (check.kind === 'state_equals') {
      const actual = trial.finalState.records[check.recordId]?.[check.field];
      passed = Object.is(actual, check.value);
      evidence = `${check.recordId}.${check.field}: expected ${JSON.stringify(check.value)}, observed ${JSON.stringify(actual)}`;
    } else if (check.kind === 'answer_equals') {
      const last = trial.events.findLast(event => event.type === 'assistant');
      passed = last?.text === check.value;
      evidence = `Последний ответ${last ? ` #${last.seq}` : ' отсутствует'}: ожидается ${JSON.stringify(check.value)}, получено ${JSON.stringify(last?.text)}. Регистр, пробелы и переносы строк значимы.`;
    } else if (check.kind === 'answer_contains' || check.kind === 'answer_omits') {
      const present = answers.includes(check.value.toLowerCase());
      passed = check.kind === 'answer_contains' ? present : !present;
      evidence = `Assistant transcript ${present ? 'contains' : 'does not contain'} ${JSON.stringify(check.value)}. This is an exact text check, not a semantic judgment.`;
    } else if (check.kind === 'source_retrieved') {
      const found = retrieved.some(chunk => chunk.source === check.doc && (check.chunk === undefined || chunk.chunkId === check.chunk));
      if (!found && !ragEvidenceComplete(trial, 'retrieval')) throw new Error('Адаптер не подтвердил полноту найденных фрагментов (retrievalsComplete). Проверка статьи не измерена.');
      passed = found;
      evidence = `${check.doc}${check.chunk ? `#${check.chunk}` : ''} ${found ? 'есть' : 'нет'} среди найденных фрагментов: ${[...new Set(retrieved.map(c => c.source))].join(', ') || 'ничего не найдено'}.`;
    } else if (check.kind === 'answer_reference_tokens') {
      const said = valueTokens(answers);
      const missing = [...valueTokens(check.value)].filter(token => !said.has(token));
      passed = !missing.length;
      evidence = missing.length ? `В ответах нет значений эталона: ${missing.join(', ')}.` : 'Все значения эталона есть в ответах.';
    } else if (check.kind === 'fresh_read_before_update') {
      ({ passed, evidence } = freshReadEvidence(trial.events));
    } else {
      const count = trial.events.filter(e => e.type === 'tool_call' && e.tool === check.tool).length;
      passed = check.kind === 'tool_count' ? count >= check.min && count <= check.max : check.kind === 'tool_called' ? count > 0 : count === 0;
      evidence = `${check.tool} was attempted ${count} time(s)${check.kind === 'tool_count' ? `; permitted range is ${check.min}–${check.max}, including failed/rejected attempts` : ''}`;
    }
    return { id: check.id, description: check.description, passed, evidence };
  });
}

/**
 * One dialogue of one card. A positive control (`control`) is the opening and the agent's first reply
 * whatever follow-ups its card allows: it checks the judge and the connection, not the simulator, and
 * its card stays the accepted one.
 */
export async function evaluateTrial(input: {
  runtime: Runtime; revision: Revision; scenario: Scenario; repeat: number; manifestHash: string;
  sources: Source[]; judgeSources?: Source[]; requirements: Requirement[]; settings: Settings; ctx: CallContext; userMode: UserMode; target: Target;
  control?: boolean;
  onStage?(stage: 'target' | 'user' | 'assessment'): void;
  /** Awaited before each message goes to the agent: the connection exam takes turns among conversations held open together (exam.ts). */
  beforeTurn?(turn: number): Promise<void>;
}): Promise<Trial> {
  const { runtime, revision, scenario, repeat, manifestHash, sources, requirements, settings, ctx, userMode, control, onStage } = input;
  const target = runnableTarget(input.target);
  const started = performance.now();
  const state = structuredClone(scenario.initialState);
  const trial: Trial = {
    id: randomUUID(), revisionId: revision.id, scenarioId: scenario.id, familyId: scenario.familyId, userMode,
    repeat, split: scenario.split, manifestHash, outcome: 'invalid', reason: '', checks: [], events: [],
    initialState: structuredClone(state), finalState: structuredClone(state), usage: emptyUsage(), elapsedMs: 0,
    observation: { state: 'missing', tools: 'complete' },
  };
  const localCtx: CallContext = {
    ...ctx,
    beforeCall() { ctx.signal.throwIfAborted(); ctx.beforeCall(); trial.usage.calls += 1; },
    addUsage(usage) { ctx.addUsage(usage); addUsage(trial.usage, usage); },
  };
  const messages: DialogueMessage[] = [];
  // The conversation as the customer Lab plays sees it: the agent's buttons shown under its text, so the customer can
  // press one and the check of its words finds a button's values in what was said. The agent's history stays plain.
  const shown: DialogueMessage[] = [];
  let persistenceError: unknown;
  let persistenceFailed = false;
  const emit = (event: Omit<Trial['events'][number], 'seq'>) => {
    const snapshot = { ...structuredClone(event), seq: trial.events.length };
    trial.events.push(snapshot);
    try { ctx.onTrace?.(trial.id, structuredClone(snapshot)); }
    catch (error) { persistenceFailed = true; persistenceError = error; throw error; }
  };
  localCtx.onTargetEvent = emit;
  const userCtx = { ...localCtx, onTargetEvent: undefined };
  // `facts`: what the adapter said of the turn beside its text — a handoff, the agent's status, the buttons offered or pressed.
  const append = (role: 'user' | 'assistant', content: string, facts?: Record<string, unknown>) => {
    messages.push({ role, content });
    const buttons = role === 'assistant' && Array.isArray(facts?.buttons) ? facts.buttons as AgentButton[] : [];
    shown.push({ role, content: buttons.length ? `${content}\n[Кнопки: ${buttons.map(button => `«${button.text}»`).join(' · ')}]` : content });
    emit({ type: role, text: content, ...(facts && Object.keys(facts).length ? { result: facts } : {}) });
  };
  let session: TargetSession | undefined;
  // Who speaks now: Lab before the agent is contacted (its refusal names its cause), the agent, the customer Lab plays,
  // or Lab grading what was observed. It decides nothing about a typed failure (breakOf).
  let stage: 'lab' | 'agent' | 'customer' | 'grading' = 'lab';
  // The Lab's own refusal before the agent is contacted: its cause is set right before the throw, never read from the text.
  let refusal: InvalidCause | undefined;
  let stopped = false;
  let handedOff = false;
  // How the agent's side broke the conversation, without the verdict on it (UNMEASURED or JUDGED_TO_BREAK).
  let broke: string | undefined;
  let finalUserReply = false;
  let reportedState = false;
  let controlled: ReturnType<typeof createUserState> | undefined;
  // What the adapter said the latest turn gave the customer (onReply sees it before the text comes back), and the buttons
  // the agent's last reply offered: a customer message that is one of them goes to the agent as that button's press.
  let latest: TurnFacts = PLAIN_REPLY;
  let offered: AgentButton[] = [];
  // A card's customer in their own words (card-customer.ts), when the runtime can play one; otherwise the move controller.
  let free: { brief: CustomerBrief; turned: boolean; said: number } | undefined;
  // A card judged on tools or state needs the observed state recorded after every agent reply.
  const execution = scenario.execution;
  const observesBeyondReply = !!execution && (isCardExecution(execution) ? execution.evaluatorView.expectations : execution.evaluatorView.checkpoints)
    .some(item => item.observation !== 'reply');
  try {
    ctx.signal.throwIfAborted();
    if (scenario.execution) {
      refusal = 'simulator';
      if (userMode !== 'reactive') throw new Error('Управляемая политика требует реактивного режима; статический и сценарный режимы её не исполняют.');
      if (isCardExecution(scenario.execution) && runtime.speakAsCustomer) free = { brief: customerBrief(scenario.execution.userView), turned: false, said: 0 };
      else if (!runtime.selectUserAction) throw new Error('Среда не поддерживает контроллер пользователя.');
      const { policy, facts } = scenario.execution.userView;
      refusal = 'turn_limit';
      if (!control && requiredUserTurns(policy, facts) > settings.maxTurns) throw new Error('Обязательный путь пользователя не помещается в лимит реплик.');
      refusal = 'simulator';
      if (!free) controlled = createUserState(policy, facts, settings.maxTurns);
      refusal = undefined;
    }
    if (userMode === 'scripted' && !control) {
      const issue = scriptIssue(scenario.user, settings.maxTurns);
      if (issue) { refusal = 'turn_limit'; throw new Error(issue); }
    }
    // From here on a failure is typed by what broke: the session is opened under the agent's stage, not the controller's.
    stage = 'agent';
    onStage?.('target');
    let responseCount = 0;
    let usageComplete = true;
    session = await openExternalTarget({ target, sessionId: trial.id, scenarioId: scenario.id, state, history: () => structuredClone(messages), ctx: localCtx,
      onRecords: () => { reportedState = true; },
      onReply(reply) {
        responseCount++;
        latest = typeof reply === 'string' ? PLAIN_REPLY
          : { outcome: reply.outcome ?? 'reply', ...(reply.status ? { status: reply.status } : {}), buttons: reply.buttons ?? [] };
        const observation = trial.observation!;
        observation.state = typeof reply !== 'string' && reply.records !== undefined ? 'reported' : 'missing';
        if (typeof reply === 'string' || reply.eventsComplete !== true) observation.tools = 'partial';
        if (typeof reply === 'string' || !reply.usage) {
          usageComplete = false;
          if (trial.externalUsage) trial.externalUsage.costUsd = null;
        }
        if (typeof reply === 'string') return;
        if (reply.eventScope) observation.toolScope = observation.toolScope ? observation.toolScope.filter(tool => reply.eventScope!.includes(tool)) : [...reply.eventScope];
        if (reply.sessionId !== undefined && reply.sessionId !== trial.id || reply.turn !== undefined && reply.turn !== responseCount) throw new ConnectionFailure('contract', 'Адаптер вернул неверный идентификатор сессии или номер хода.');
        if (responseCount === 1) observation.resetConfirmed = reply.resetConfirmed;
        if (reply.version) {
          if (observation.version && observation.version !== reply.version) throw new MeasurementFailure('Версия внешнего агента изменилась внутри диалога.');
          observation.version = reply.version;
        }
        if (reply.usage) {
          const usage = trial.externalUsage ??= emptyUsage();
          addUsage(usage, reply.usage);
          if (!usageComplete) usage.costUsd = null;
        }
      } });
    let userMessage = scenario.user.opening;
    let turn = 0;
    for (; turn < settings.maxTurns; turn += 1) {
      await input.beforeTurn?.(turn);
      ctx.signal.throwIfAborted();
      // A press goes to the agent as the button's own text, whatever case or spacing the customer wrote it in.
      const choice = pressOf(offered, userMessage);
      if (choice) userMessage = choice.text;
      append('user', userMessage, choice ? { choice } : undefined);
      stage = 'agent';
      onStage?.('target');
      latest = PLAIN_REPLY;
      const response = await session.respond(userMessage, choice ? { choice } : undefined);
      const facts = latest;
      if (persistenceFailed) throw persistenceError;
      ctx.signal.throwIfAborted();
      if (typeof response !== 'string') throw new ConnectionFailure('contract', 'Адаптер вернул ответ, который не является текстом.');
      if (observesBeyondReply) {
        emit({ type: 'observation', result: structuredClone(trial.observation), ...(trial.observation?.state !== 'missing' ? { state: structuredClone(state) } : {}) });
      }
      if (facts.outcome === 'no_reply') {
        // The customer got nothing: what the adapter wrote is its diagnostic, never a message of the agent, and the customer
        // Lab plays never sees it. The agent's operability, counted apart — neither the Lab's error nor a failed duty.
        broke = noReplyBreak(facts.status);
        trial.reason = broke + UNMEASURED;
        trial.invalidCause = 'no_reply';
        emit({ type: 'error', text: trial.reason, result: { outcome: 'no_reply', ...(facts.status ? { status: facts.status } : {}), ...(response.trim() ? { detail: clip(response, 2000) } : {}) } });
        break;
      }
      append('assistant', response, { ...(facts.outcome === 'handoff' ? { outcome: facts.outcome } : {}), ...(facts.status ? { status: facts.status } : {}),
        ...(facts.buttons.length ? { buttons: facts.buttons } : {}) });
      offered = facts.buttons;
      if (!response.trim() && facts.outcome !== 'handoff') { broke = 'Агент вернул пустой ответ.'; trial.reason = broke + UNMEASURED; trial.invalidCause = 'agent'; break; }
      const serviceMarker = target.serviceReplies?.find(marker => response.includes(marker));
      if (serviceMarker !== undefined) { broke = `${SERVICE_REPLY_REASON} «${serviceMarker}»: это не ответ агента.`; trial.reason = broke + UNMEASURED; trial.invalidCause = 'service_reply'; break; }
      // The agent passed the conversation to a person: it ends here, and it is judged as it went.
      if (facts.outcome === 'handoff') { stopped = true; handedOff = true; break; }
      if (control || controlled && (finalUserReply || controlled.policy.terminalStates.includes(controlled.position))) { stopped = true; break; }
      if (!controlled && !free && (userMode === 'static' || finalUserReply || (scenario.user.maxFollowUps !== undefined && turn >= scenario.user.maxFollowUps))) { stopped = true; break; }
      if (userMode === 'scripted') {
        const next = scenario.user.script?.[turn];
        if (next === undefined) { stopped = true; break; }
        emit({ type: 'simulator', result: { message: next, done: false, scripted: true } });
        userMessage = next;
        continue;
      }
      stage = 'customer';
      onStage?.('user');
      if (free) {
        if (turn + 1 >= settings.maxTurns) { stopped = true; trial.turnLimit = true; break; }
        // The customer leaves on their own words' budget: past the card's follow-ups they have nothing more to say.
        if (free.said >= free.brief.maxFollowUps && !(free.brief.turn?.required && !free.turned)) { stopped = true; break; }
        ctx.signal.throwIfAborted();
        const reply = customerReplySchema.parse(await runtime.speakAsCustomer!({ brief: structuredClone(free.brief), messages: structuredClone(shown), turn, turned: free.turned,
          buttons: structuredClone(offered) }, userCtx));
        ctx.signal.throwIfAborted();
        const problem = customerReplyIssue(reply, free.brief, shown, free.turned, offered);
        if (problem) throw new Error(`Клиент, которого играет Lab, отошёл от своей ситуации: ${problem.owner}.`);
        emit({ type: 'simulator', result: { protocol: CARD_CUSTOMER_PROTOCOL, move: reply.move, message: reply.message, ...(reply.conditions ? { conditions: reply.conditions } : {}) } });
        if (reply.move === 'leave') { stopped = true; break; }
        if (reply.move === 'turn') free.turned = true;
        free.said++;
        userMessage = deliveredMessage(reply, free.brief);
        continue;
      }
      if (controlled) {
        // The answer must be one of the moves allowed now (an enum); the message comes from the move itself.
        const actions = allowedUserActions(controlled, response);
        const choice = userDecisionSchema(actions);
        ctx.signal.throwIfAborted();
        const answer = choice.safeParse(await runtime.selectUserAction!({ user: structuredClone(scenario.execution!.userView), state: controlled.position,
          actions, messages: structuredClone(shown), turn }, userCtx));
        ctx.signal.throwIfAborted();
        if (!answer.success) throw new Error('Симулятор выбрал действие, которого нет среди допустимых сейчас.');
        const decision = answer.data;
        // The customer has written every message the run allows: leaving is its only move, so the talk ends at the limit
        // and is judged as it went.
        const limited = controlled.followUps >= settings.maxTurns - 1;
        const accepted = advanceUser(controlled, decision);
        emit({ type: 'simulator', result: { protocol: scenario.execution!.protocol, decision, accepted: true, from: controlled.position, to: accepted.state.position } });
        controlled = accepted.state;
        if (accepted.done && !accepted.message) { stopped = true; if (limited) trial.turnLimit = true; break; }
        userMessage = accepted.message; finalUserReply = accepted.done;
        continue;
      }
      if (!runtime.userTurn) throw new Error('Среда не поддерживает свободного симулятора пользователя для карточек без управляемой политики.');
      const decision = await runtime.userTurn({ user: structuredClone(scenario.user), messages: structuredClone(shown), turn }, userCtx);
      emit({ type: 'simulator', result: decision });
      const user = userTurnSchema.parse(decision);
      ctx.signal.throwIfAborted();
      if (user.done && !user.message.trim()) { stopped = true; break; }
      userMessage = user.message;
      finalUserReply = user.done;
    }
    // The agent answered the last message the run allows the customer while the talk was still going: the conversation
    // ends here as it stands. It is an observation about the agent's conversation, never a failed measurement.
    if (turn === settings.maxTurns) { stopped = true; trial.turnLimit = true; }
    // The card's turn never came up: the agent handed the conversation to a person first, or never gave the customer its
    // opening before the run's messages ran out. That is the agent's conversation, judged as it went; a customer who had
    // the opening and let it pass is what the judge of its fidelity, which reads the turn in its brief, catches.
    const turnMissed = !control && !!free?.brief.turn?.required && !free.turned && stopped;
    trial.finalState = structuredClone(state);
    // Simulator checks describe the user side only; they are computed before grading and never touch the outcome.
    trial.simulatorChecks = simulatorChecks(scenario, trial);
    stage = 'grading';
    // What the checks need and the connection did not show leaves the conversation unmeasured: the measurement's, never the agent's.
    try { trial.checks = grade(scenario, trial); }
    catch (error) { throw new MeasurementFailure(error instanceof Error ? error.message : 'Проверки не измерены.', { cause: error }); }
    const allPassed = trial.checks.length > 0 && trial.checks.every(check => check.passed);
    // Only an empty reply, a service reply or a turn that gave the customer nothing leaves the loop unstopped, and each
    // has already named its cause.
    trial.outcome = !stopped ? 'invalid' : trial.checks.length === 0 ? 'ungraded' : allPassed ? 'pass' : 'fail';
    trial.reason ||= trial.checks.length === 0
      ? 'Диалог дошёл до конца, но объективных проверок в карточке нет: оценки по рубрикам считаются отдельно.'
      : allPassed ? 'Все объективные проверки пройдены.' : 'Часть объективных проверок провалена.';
    if (turnMissed) trial.reason += handedOff ? ' Поворот ситуации не состоялся: агент передал разговор человеку раньше.'
      : ' Поворот ситуации не состоялся: за отведённые реплики агент не дал клиенту к нему повода.';
    if (trial.turnLimit) trial.reason += ' Клиенту не хватило реплик: разговор оценён таким, каким успел сложиться.';
    trial.reason += reportedState
      ? ' Состояние сообщил сам агент, доверенный код его не наблюдал.'
      : ' Состояние внешний агент не сообщил.';
  } catch (error) {
    if (persistenceFailed) throw persistenceError;
    // A dialogue that already broke on the agent's side (an empty or a service reply, no reply at all) keeps its own reason and cause
    // when grading then refuses its facts: the agent's silence is what happened (OD-1), not the missing observation.
    // A stop — the run's, or Lab itself ending the agent's process as it closes — cancels the conversation.
    const halted = ctx.signal.aborted || !!carried(error, Stopped);
    const brokeFirst = !halted && stage === 'grading' && trial.invalidCause !== undefined;
    trial.outcome = halted ? 'cancelled' : 'invalid';
    if (trial.outcome !== 'invalid') { delete trial.invalidCause; trial.reason = 'Диалог остановлен.'; }
    else if (!brokeFirst) {
      // The cause by what broke the conversation (breakOf), and the reason says the same side: Lab's own refusal before the
      // agent was contacted, the measurement, the model provider, the connection, the agent's side, the customer Lab plays.
      const broken = refusal ? { cause: refusal, detail: error instanceof Error ? error.message : 'неизвестный сбой' } : breakOf(error, stage === 'agent' || stage === 'grading' ? 'agent' : 'customer');
      trial.invalidCause = broken.cause;
      trial.reason = broke = `${BROKEN_BY[broken.cause]}: ${broken.detail}`;
    }
    emit({ type: 'error', text: trial.reason });
  } finally {
    try { await session?.close(); }
    catch (error) {
      // What the session found only as it closed (a line the adapter sent after its last answer) still unmeasures the conversation.
      if (trial.outcome !== 'cancelled') {
        const broken = breakOf(error, 'agent');
        trial.outcome = 'invalid'; trial.invalidCause = broken.cause; trial.reason = broke = `${BROKEN_BY[broken.cause]}: ${broken.detail}`;
      }
      emit({ type: 'error', text: trial.reason });
    }
    if (ctx.signal.aborted) { trial.outcome = 'cancelled'; trial.reason = 'Диалог остановлен.'; delete trial.invalidCause; }
    trial.finalState = structuredClone(state);
    trial.elapsedMs = Math.round(performance.now() - started);
    if (persistenceFailed) throw persistenceError;
  }
  // The agent's side broke the conversation after the agent had spoken: what it said up to the break is its conversation,
  // judged in the cut-off mode — only a failure its own events before the break show counts, the rest stays unmeasured
  // for the break's cause. Its judgment comes out of the run's limit like any conversation's: the plan counts one each.
  if (!ctx.signal.aborted && breakPoint(scenario, trial, true)) {
    trial.outcome = 'ungraded';
    trial.cutOff = true;
    trial.simulatorChecks = simulatorChecks(scenario, trial);
    trial.reason = (broke ?? trial.reason) + JUDGED_TO_BREAK;
  }
  if ((stopped || trial.cutOff) && ['pass', 'fail', 'ungraded'].includes(trial.outcome) && assessmentRubrics(judgedScenario(scenario, trial), trial).length) {
    try {
      ctx.signal.throwIfAborted();
      onStage?.('assessment');
      trial.assessments = await assessTrial(runtime, scenario, input.judgeSources ?? sources, trial, { ...localCtx, onJudgment: (id, audit, final) => {
        try { ctx.onJudgment?.(id, audit, final); }
        catch (error) { persistenceFailed = true; persistenceError = error; throw error; }
      } }, requirements);
    } catch (error) {
      if (persistenceFailed) throw persistenceError;
      trial.assessmentError = (ctx.signal.aborted ? 'Metric assessment cancelled' : error instanceof Error ? error.message : 'Metric assessment failed').slice(0, 4000);
      trial.assessmentFailure = judgmentFailure(error, ctx.signal);
    }
    trial.elapsedMs = Math.round(performance.now() - started);
  } else if (trial.outcome === 'invalid' && trial.invalidCause !== undefined && AGENT_SIDE.has(trial.invalidCause)) {
    // The agent's side broke the conversation, so it measures nothing of the agent; whether the customer Lab plays kept
    // its situation up to there is still known, and counted apart (simulator-evidence.ts). Only the customer's rubric is
    // judged. A judge that fails here leaves the customer unchecked and the conversation keeps its own cause.
    const customer = (scenario.metrics ?? []).filter(metric => metric.subject === 'simulator' && metricApplies(metric, trial));
    if (customer.length && !ctx.signal.aborted) try {
      onStage?.('assessment');
      trial.assessments = await assessTrial(runtime, { ...scenario, metrics: customer }, input.judgeSources ?? sources, trial, { ...localCtx, onJudgment: (id, audit, final) => {
        try { ctx.onJudgment?.(id, audit, final); }
        catch (error) { persistenceFailed = true; persistenceError = error; throw error; }
      } }, requirements);
      trial.elapsedMs = Math.round(performance.now() - started);
    } catch (error) {
      if (persistenceFailed) throw persistenceError;
    }
  }
  return trial;
}

/** Where a conversation broke on the agent's side — not on the customer's, the Lab's own refusal or the limit. */
const AGENT_SIDE: ReadonlySet<InvalidCause> = new Set(['agent', 'no_reply', 'service_reply', 'measurement']);

/**
 * Where the agent's side cut a conversation off after the agent had spoken, so it is judged up to the break; undefined
 * for any other conversation. `fresh`: the conversation just broke and is still `invalid`; otherwise one already
 * recorded as cut off (`trial.cutOff`), judged again. Exact checks read a whole conversation — its last reply, its final
 * state —, so a card with them keeps a broken conversation unmeasured.
 */
function breakPoint(scenario: Scenario, trial: Trial, fresh = false): CutOff | undefined {
  const cause = trial.invalidCause;
  if (fresh ? trial.outcome !== 'invalid' : !trial.cutOff) return undefined;
  if (cause !== 'agent' && cause !== 'no_reply' && cause !== 'service_reply') return undefined;
  if (directChecks(scenario, trial).length || !assessmentRubrics(judgedScenario(scenario, trial), trial).length) return undefined;
  const spoken = agentEventsBeforeBreak(trial.events, cause);
  const last = spoken.at(-1);
  return last && spoken.some(event => event.type === 'assistant') ? { cause, afterSeq: last.seq } : undefined;
}

/**
 * Shared by live evaluation and reassessment of immutable recorded evidence. The judge sees the agent prompt
 * only as its observable rules. A new judgment never carries a checkpoint verdict: a first-format card is
 * judged through its projection, one expectation per required checkpoint (card/legacy-v1.ts).
 */
export async function assessTrial(runtime: Runtime, stored: Scenario, sources: Source[], trial: Trial, ctx: CallContext, requirements: Requirement[]) {
  delete trial.checkpoints; delete trial.checkpointReceipt;
  const scenario = judgedScenario(stored, trial);
  const metrics = assessmentRubrics(scenario, trial);
  if (!metrics.length) return [];
  if (!runtime.assess) throw new ProviderFailure('unavailable', 'Metric assessment is unavailable for this runtime');
  let latest: JudgeAudit | undefined;
  let mapped: MetricAssessment[] | undefined;
  // A conversation cut off on the agent's side is judged up to its break, and of it only what countedBeforeBreak keeps counts.
  const cutOff = breakPoint(stored, trial);
  try {
    const response = await runtime.assess({
      scenario: structuredClone({ ...scenario, metrics }), sources: structuredClone(observableSources(sources, requirements)), trial: structuredClone(trial),
      ...(cutOff ? { cutOff } : {}),
    }, { ...ctx, onTargetEvent: undefined, onTrace: undefined, onJudgment: (id, audit, final) => {
      // The full audit lives in the store's sidecar; the trial keeps only a sealed receipt. The receipt
      // hashes exactly what the store keeps: the schema-normalized audit (trimmed texts). An audit the
      // schema rejects is passed on unchanged, so the store still reports the persistence failure.
      let persisted: JudgeAudit = audit;
      try { persisted = judgeAuditSchema.parse(audit); } catch { /* the store rejects it with the original error */ }
      latest = structuredClone(persisted);
      ctx.onJudgment?.(id, persisted, final);
    } });
    const assessments = validateAssessments(metrics, cutOff ? cutOffEvidenceEvents(trial.events) : judgmentEvidenceEvents(trial.events, latest), response);
    ctx.signal.throwIfAborted();
    mapped = assessments.map(assessment => !metricApplies(metrics.find(m => m.id === assessment.metricId)!, trial)
      ? { metricId: assessment.metricId, result: 'unknown' as const, evidence: [], rationale: RAG_METRIC_IDS.has(assessment.metricId)
        ? 'Полный RAG-контекст каждого ответа не подтверждён адаптером; причина не установлена.' : 'Реактивный симулятор не участвовал в этом диалоге; его качество не измерено.' }
      : assessment);
    if (cutOff) mapped = countedBeforeBreak(mapped, metrics, trial.events, cutOff.cause);
    return mapped;
  } finally {
    // A failed judgment keeps its receipt too, sealed incomplete, so reports still point to its sidecar.
    if (latest) {
      const judged = { scenario, sources: observableSources(sources, requirements) };
      const complete = !!mapped && (cutOff
        ? hasCompleteCutOffJudgment({ ...judged, trial: { ...trial, judgeReceipt: sealJudgeReceipt(latest, true), assessments: mapped } }, cutOff)
        : hasCompleteJudgment({ ...judged, trial: { ...trial, judgeAudit: latest, assessments: mapped } }));
      trial.judgeReceipt = sealJudgeReceipt(latest, complete);
    }
  }
}

function retrievedChunks(events: TraceEvent[]): { source: string; chunkId?: string }[] {
  return events.flatMap(event => {
    const chunks = event.type === 'retrieval' ? (event.result as { chunks?: unknown } | undefined)?.chunks : undefined;
    return Array.isArray(chunks) ? chunks.filter((c): c is { source: string; chunkId?: string } => typeof c?.source === 'string') : [];
  });
}
