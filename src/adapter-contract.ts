import { AGENT_TIMEOUT_MS, EXAM_EXPECTATIONS, runnableTargetSchema } from './target-schema.js';
import { externalReplySchema, REPLY_BYTES, type TurnOutcome } from './targets.js';

/*
 * The adapter contract as the chat's model needs it to help an owner write an adapter: short, exact, and read off the
 * code that enforces it — the reply's fields from the schema that parses every reply, the defaults from the target
 * schemas, the limits from the constants the executor applies. It reaches the model in a tool result (agent_lab_status,
 * while Lab has no sure way to start the agent), never from a separate document that could drift from the code.
 * Model-facing, so English; pure: no I/O.
 */

/** The object form of a reply, as targets.ts parses it: the only fields a reply may have. */
const replyObject = externalReplySchema.options.find(option => 'shape' in option);
const REPLY_FIELDS = Object.keys(replyObject && 'shape' in replyObject ? replyObject.shape : {});
const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;
/** A target kind's wait for one reply when the connection names none, as its schema fills it in. */
function defaultTimeout(kind: 'command' | 'http'): number {
  const target = runnableTargetSchema.parse(kind === 'command' ? { kind, command: 'agent' } : { kind, url: 'http://localhost/' });
  return target.kind === 'module' ? 0 : target.timeoutMs;
}
const defaults = { command: defaultTimeout('command'), http: defaultTimeout('http'), module: AGENT_TIMEOUT_MS };

/** Every outcome a turn may have (targets.ts TURN_OUTCOMES): the type makes a new one unwritable without its words here. */
const OUTCOMES: Record<TurnOutcome, string> = {
  reply: 'the customer got a reply (the default).',
  handoff: 'the agent passed the conversation to a person: it ends there and is judged as it went.',
  no_reply: 'the customer got nothing this turn — a service status, a failed generation (diagnostics go in reply, the status in status): '
    + 'the conversation ends unmeasured and leaves the percent; the owner sees it under «Работоспособность», and many such mark the result '
    + '«✗ Числу пока не верить». Never use it for a reply the customer did receive: that hides the agent\'s failure and tunes the number.',
};

export interface AdapterContract {
  ways: { command: string; module: string; http: string; curl: string };
  request: string;
  reply: string;
  outcome: Record<TurnOutcome, string>;
  exam: string;
  rules: string[];
}

/** How an agent must speak to Lab, for the model to help write or fix an adapter. */
export function adapterContract(): AdapterContract {
  return {
    ways: {
      command: 'target {kind: "command", command, args, cwd}: Lab starts it once per conversation with Pi\'s environment. stdin gets one JSON line per request — '
        + '{"type": "respond", sessionId, scenarioId, initialState, messages, message, choice?, prompt?, promptHash?} — and at the end {"type": "close", sessionId}, '
        + 'then stdin closes and the process has 2 s to exit. stdout carries exactly one JSON line per request, flushed: the reply. Logs and progress go to stderr: '
        + 'a stdout line that is not JSON is kept as diagnostics; a JSON line when no request is waiting, or a second one for the same request, breaks the protocol and the conversation '
        + `is not measured (the connection's fault, not the agent's). No reply within timeoutMs (default ${seconds(defaults.command)}) ends the process group.`,
      module: 'target {kind: "module", path, exportName (default "createSession")}: Lab runs the Node module in a process of its own per conversation; '
        + 'createSession({sessionId, scenarioId, initialState, prompt, promptHash}) returns (or resolves to) {respond(message, messages, choice), close?()}, and respond returns the reply. '
        + 'Lab talks to the module over a channel of its own, so whatever it prints is kept as diagnostics and never taken for a reply. '
        + `A reply must come within timeoutMs (default ${seconds(defaults.module)}).`,
      http: 'target {kind: "http", url, headersEnv, timeoutMs}: POST url with the request as its JSON body (without "type"), headers content-type and accept application/json '
        + 'plus headersEnv {"Header": "ENV_NAME"}, read from the environment at request time and never stored. The reply is the JSON body with status 2xx, '
        + `within timeoutMs (default ${seconds(defaults.http)}). Tell conversations apart by sessionId: a new conversation is a new sessionId.`,
      curl: 'An HTTP agent with its own request format needs no adapter: the owner pastes a working curl, passed whole to agent_lab_connect. Its request template may also '
        + 'say where the reply\'s buttons are (buttons: {list, text, value?} as JSON pointers), which values of a status field mean a handoff or no reply '
        + '(outcome: {status, handoff, noReply}), and send a pressed button with {{choice}}; without them such an agent shows Lab its text only.',
    },
    request: 'initialState {records, writableFields, transientFailures, external?} — apply it before the first reply. messages — the whole conversation so far, the current '
      + 'message last: [{role: "user" | "assistant", content}]. message — the customer\'s words (a pressed button\'s text). choice — only for a press of a button of the '
      + 'previous reply: {index, text, value?}, value being the one the adapter gave it. prompt, promptHash — only when the connection names a promptFile.',
    reply: `A string — the text the customer saw — or an object with these fields only: ${REPLY_FIELDS.join(', ')}. reply is required; the whole reply is at most `
      + `${REPLY_BYTES / 1_000_000} MB, and a field not listed here makes Lab refuse it. sessionId, when given, is the request's; turn counts from 1; version stays the same `
      + 'through a conversation and a run; with a promptFile every reply returns the promptHash it was sent. An empty reply without a handoff is not measured.',
    outcome: OUTCOMES,
    exam: `target.exam: paths {name, steps, initialState?}; a step is say (the customer's words) or press (a button of the previous reply), expect ${EXAM_EXPECTATIONS.join(' | ')}, `
      + 'and contains — a value the reply must hold. The exam counts only when it shows memory and isolation. Memory: a path where the customer gives a value (a number, a name, '
      + 'a choice) and a later step asks about it without repeating it and checks with contains that the reply holds it; Lab also asks that later question alone in a fresh '
      + 'conversation, where the reply must not hold the value. Isolation: two such memory paths, open at the same time, with different values (neither contains the '
      + 'other, neither appears in the other path\'s own messages); Lab sends the paths\' messages in turn, step by step, path after path, so write them so that each path asks '
      + 'for its value after the other path told its own. Each answer must hold its own value and not the other\'s; a fresh conversation after all paths must hold none of '
      + 'them. A second path that only checks some word of its own (a greeting) proves nothing about isolation. '
      + 'Values fit the agent\'s purpose (a terminal number it knows, not a token to memorise). Without both the result shows no percent. Lab runs it before every run, without '
      + 'a model; a failed exam stops the run. From the chat, the paths '
      + 'go to agent_lab_run as exam when the owner asks for them: Lab shows them to the owner and writes them into connection.json only at their word.',
    rules: [
      'eventsComplete, retrievalsComplete and resetConfirmed only when the adapter\'s code proves them.',
      'A fresh, isolated session per conversation: nothing of one leaks into the next.',
      'Buttons in buttons, never inside the reply text.',
      'No secrets or personal data in records, events or retrievals: they are stored and reported.',
    ],
  };
}
