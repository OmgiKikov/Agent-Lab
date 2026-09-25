// Opt-in live check: node --import tsx test/live/sandbox-tool-call.ts PROVIDER MODEL
// Does a sandbox agent on the chosen model call sandbox tools, get the results back and keep answering?
// Two cases, up to six model calls each; no business verdicts. For provider giga set AGENT_LAB_GATEWAY_URL,
// AGENT_LAB_GATEWAY_CERT_PATH and AGENT_LAB_GATEWAY_KEY_PATH (docs/REFERENCE.md). A gateway rejection shows up as a
// failed case whose trace ends at the round that was rejected.
import assert from 'node:assert/strict';
import { createPiRuntime } from '../../src/pi.js';
import { sandbox } from '../../src/sandbox.js';
import { emptyUsage, settingsSchema, type CallContext, type TargetSession, type ToolName, type TraceEvent, type World } from '../../src/contracts.js';

type TargetEvent = Omit<TraceEvent, 'seq'>;
interface LiveCase {
  name: string;
  tools: ToolName[];
  message: string;
  verify(events: TargetEvent[], world: World, reply: string): void;
}

const CALLS_PER_CASE = 6;
const [provider, model] = process.argv.slice(2);
assert(provider && model, 'Usage: node --import tsx test/live/sandbox-tool-call.ts PROVIDER MODEL');
const settings = settingsSchema.parse({ provider, model, maxCalls: CALLS_PER_CASE * 2, timeoutMs: 120000 });
const runtime = await createPiRuntime(settings);

const instructions = 'You are an order desk assistant. Records are the only source of truth: always read an order with lookup_record before answering about it or changing it, and change it only with update_record. Reply briefly with the resulting status.';
const freshWorld = (): World => ({ records: { 'A-1024': { status: 'packed', eta: '2026-09-20' } }, writableFields: ['status'], transientFailures: 0 });
const argsOf = (event: TargetEvent) => (event.args ?? {}) as Record<string, unknown>;
const calledWith = (events: TargetEvent[], tool: ToolName, matches: (args: Record<string, unknown>) => boolean) =>
  events.some(event => event.type === 'tool_call' && event.tool === tool && matches(argsOf(event)));
const succeeded = (events: TargetEvent[], tool: ToolName) =>
  events.some(event => event.type === 'tool_result' && event.tool === tool && (event.result as { ok?: unknown } | undefined)?.ok === true);

const cases: LiveCase[] = [
  {
    name: 'reads a record and answers from the tool result',
    tools: ['lookup_record'],
    message: 'What is the status of order A-1024?',
    verify(events, _world, reply) {
      assert(calledWith(events, 'lookup_record', args => args.recordId === 'A-1024'), 'lookup_record was not called for A-1024');
      assert(succeeded(events, 'lookup_record'), 'lookup_record did not return the record');
      assert.match(reply, /packed/i, 'the answer does not use the tool result');
    },
  },
  {
    // Whether the model reads before writing is model behaviour; what this checks is that the
    // write happens and the model keeps answering after the tool result travels back.
    name: 'updates a record and answers after the tool result',
    tools: ['lookup_record', 'update_record'],
    message: 'Please mark order A-1024 as delivered.',
    verify(events, world, reply) {
      assert(calledWith(events, 'update_record', args => args.recordId === 'A-1024'
        && (args.changes as Record<string, unknown> | undefined)?.status === 'delivered'), 'update_record was not called to set delivered');
      assert.equal(world.records['A-1024']?.status, 'delivered', 'the record did not change');
      assert(reply.trim(), 'the model did not answer after the tool result');
    },
  },
];

const usage = emptyUsage();
usage.costUsd = null;
let failed = 0;
for (const liveCase of cases) {
  const events: TargetEvent[] = [];
  const world = freshWorld();
  let calls = 0;
  const record = (event: TargetEvent) => { events.push(structuredClone(event)); };
  const ctx: CallContext = {
    signal: AbortSignal.timeout(300000), timeoutMs: settings.timeoutMs,
    beforeCall() { assert(calls < CALLS_PER_CASE, 'Model call budget exhausted'); calls++; usage.calls++; },
    addUsage(value) { usage.inputTokens += value.inputTokens; usage.outputTokens += value.outputTokens; },
    onTargetEvent: record,
  };
  const tools = sandbox(world, [], record, ctx).filter(tool => liveCase.tools.includes(tool.name));
  const toolSequence = () => events.filter(event => event.type === 'tool_call').map(event => event.tool);
  let session: TargetSession | undefined;
  try {
    session = await runtime.openTarget({ name: 'Order desk', instructions, tools: liveCase.tools }, [], tools, ctx);
    const reply = await session.respond(liveCase.message);
    liveCase.verify(events, world, reply);
    console.log(JSON.stringify({ case: liveCase.name, ok: true, calls, toolSequence: toolSequence(), reply }));
  } catch (error) {
    failed++;
    const trace = events.map(({ type, tool, args, result, text }) => ({ type, tool, args, result, text }));
    console.log(JSON.stringify({ case: liveCase.name, ok: false, calls, toolSequence: toolSequence(),
      error: error instanceof Error ? error.message : String(error), trace }));
  } finally {
    await session?.close();
  }
}
console.log(JSON.stringify({ provider, model, passed: cases.length - failed, failed, usage }));
process.exitCode = failed ? 1 : 0;
