import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, type Component } from '@earendil-works/pi-tui';
import agentLab from '../../extensions/agent-lab.ts';
import type { CardReviewRequest, ReviewVerdict } from '../../src/card/review.js';
import type { Card, LibraryV2 } from '../../src/card/schema.js';
import type { Experiment } from '../../src/contracts.js';
import { ExperimentLab } from '../../src/experiment.js';
import type { Runtime } from '../../src/runtime.js';
import { ExperimentStore } from '../../src/store.js';
import { READY } from './card-library.js';
import { cardInput, cardRuntime, dialogues } from './card-prep.js';

/*
 * One Pi session of the extension for the chat tests of the owner's consent: the real tools behind a fake `pi` that
 * records what the session sends and hands its session events to the test, a scripted terminal, and a draft of the
 * two refund situations prepared by the deterministic card runtime. Invented data only.
 */

/** The agent under test: a module that always asks for the terminal number. */
export const chatAgent = { kind: 'module' as const, path: fileURLToPath(new URL('../fixtures/board-chat-agent.mjs', import.meta.url)), exportName: 'createSession' };

/** Holds every reply of the chat agent until released: the agent runs in its own process and watches the file the environment names. */
export async function holdReplies(): Promise<() => Promise<void>> {
  const directory = await mkdtemp(join(tmpdir(), 'chat-hold-'));
  const file = join(directory, 'hold');
  await writeFile(file, '');
  process.env.AGENT_LAB_TEST_HOLD = file;
  return async () => { delete process.env.AGENT_LAB_TEST_HOLD; await rm(directory, { recursive: true, force: true }); };
}

/** The reviewer doubts whether the customer of «номер по просьбе» knew the number, until the owner vouches for it. */
const DOUBT: ReviewVerdict = { status: 'needs_owner', reason: 'В исходном разговоре клиент назвал номер только после вопроса агента.' };
const doubted = (alias: string, request: CardReviewRequest) => alias === 'fact_f1' && request.payload.card.title.includes('по просьбе') && !request.payload.card.knows[0]?.owner;

/** The deterministic card runtime; `questions` makes the reviewer doubt one fact; `hold()` keeps a preparation before its first proposal until released. */
export function gatedRuntime(questions = false) {
  const base = cardRuntime();
  let gate: Promise<void> | undefined;
  const runtime: Runtime = { ...base,
    async proposeCard(request, ctx) { await gate; ctx.signal.throwIfAborted(); return base.proposeCard!(request, ctx); },
    async reviewCard(request, ctx) {
      ctx.beforeCall();
      return { verdicts: Object.fromEntries(request.aliases.map(alias => [alias, questions && doubted(alias, request) ? DOUBT : READY])), model: 'fixture/reviewer' };
    },
  };
  return { runtime, hold: () => { let release!: () => void; gate = new Promise<void>(resolve => { release = resolve; }); return () => { gate = undefined; release(); }; } };
}

export interface Sent { message: { customType: string; content: string; display: boolean; details: unknown }; options: { deliverAs?: string; triggerTurn?: boolean } }

/** One Pi session with the extension: its tools, the messages it sent, and its start and end as Pi signals them. */
export function chatSession(runtime: Runtime, options: { inlineRunMs?: number; inlineCheckMs?: number; inlineBuildMs?: number; createLab?: (directory: string) => ExperimentLab } = {}) {
  const tools = new Map<string, ToolDefinition>();
  const sent: Sent[] = [];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const active = { names: ['read', 'bash'] };
  agentLab({
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool), registerCommand() {}, registerMessageRenderer() {},
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, handler); },
    sendMessage: (message: Sent['message'], sendOptions: Sent['options']) => { sent.push({ message, options: sendOptions }); }, sendUserMessage() {},
    getActiveTools: () => [...active.names], setActiveTools: (names: string[]) => { active.names = [...names]; },
  } as unknown as ExtensionAPI, { createLab: options.createLab ?? (directory => new ExperimentLab(directory, runtime)), gateway: { connect: async () => ({ failure: 'not configured' }) },
    ...(options.inlineRunMs === undefined ? {} : { inlineRunMs: options.inlineRunMs }), ...(options.inlineCheckMs === undefined ? {} : { inlineCheckMs: options.inlineCheckMs }),
    ...(options.inlineBuildMs === undefined ? {} : { inlineBuildMs: options.inlineBuildMs }) });
  const call = (tool: string, id: string, params: unknown, ctx: ExtensionContext, signal?: AbortSignal) => tools.get(tool)!.execute(id, params as never, signal, undefined, ctx);
  return { tools, sent, call,
    start: async (ctx: ExtensionContext, reason = 'startup') => { await handlers.get('session_start')!({ type: 'session_start', reason }, ctx); },
    /** Pi ends this session: `quit`, or a replacement by /new, /resume, /fork, /reload. */
    end: async (reason = 'quit') => { await handlers.get('session_shutdown')!({ type: 'session_shutdown', reason }, {}); } };
}

const plainTheme = { fg: (_tone: string, text: string) => text, bold: (text: string) => text, bg: (_tone: string, text: string) => text };

/**
 * A Pi terminal whose session holds exactly what the owner said; `select` picks and editor texts are scripted and
 * recorded. A pick that is not scripted closes the dialog (undefined). Widgets are drawn once, as the owner sees them.
 */
export function terminal(cwd: string, said: string[], session: { picks?: (string | undefined | ((options: string[]) => string | undefined))[]; texts?: (string | undefined)[] } = {}) {
  const selects: { title: string; options: string[] }[] = [];
  const editors: { title: string; prefill: string }[] = [];
  const widgets: (string[] | undefined)[] = [];
  const notes: string[] = [];
  const drawWidget = (content: unknown): string[] | undefined => {
    if (typeof content !== 'function') return content as string[] | undefined;
    const component = (content as (tui: unknown, theme: unknown) => Component & { dispose?(): void })({ requestRender() {} }, plainTheme);
    try { return component.render(120).map(line => stripTerminalSequences(line).trim()).filter(Boolean); } finally { component.dispose?.(); }
  };
  const ctx = { cwd, hasUI: true, mode: 'tui',
    sessionManager: { getBranch: () => said.map((content, index) => ({ type: 'message', id: String(index), message: { role: 'user', content } })) },
    ui: { select: async (title: string, options: string[]) => {
      selects.push({ title, options });
      const pick = session.picks?.shift();
      return typeof pick === 'function' ? pick(options) : pick;
    },
    editor: async (title: string, prefill: string) => { editors.push({ title, prefill }); return session.texts?.shift(); },
    setStatus() {}, notify: (message: string) => { notes.push(message); }, setWidget: (_key: string, content: unknown) => { widgets.push(drawWidget(content)); } },
  } as unknown as ExtensionContext;
  return { ctx, selects, editors, widgets, notes };
}

/** A prepared draft of the two refund situations: №1 «late» (the number named when asked), №2 «known» (the number in the first message). */
export async function seedDraft(prefix: string, runtime: Runtime, target: NonNullable<Parameters<typeof cardInput>[0]>['target'] = chatAgent) {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  const lab = new ExperimentLab(join(cwd, '.agent-lab'), runtime);
  await lab.init();
  let id: string;
  try { id = (await lab.create(cardInput({ target }))).id; await lab.waitForIdle(); } finally { await lab.close(); }
  const store = () => new ExperimentStore(join(cwd, '.agent-lab'));
  return { cwd, id, read: async () => store().get(id), list: async () => store().list(),
    /** The logs of the same two conversations, for a preparation from the chat. */
    writeLogs: () => writeFile(join(cwd, 'logs.jsonl'), dialogues.map(dialogue => JSON.stringify(dialogue)).join('\n') + '\n'),
    cleanup: () => rm(cwd, { recursive: true, force: true }) };
}

export const libraryOf = (record: Experiment) => record.librarySnapshot as LibraryV2;
export const cardNumbered = (record: Experiment, number: number): Card => libraryOf(record).cards.find(card => card.number === number)!;
export const json = (result: Awaited<ReturnType<ToolDefinition['execute']>>) => JSON.parse(result.content.filter(part => part.type === 'text').map(part => part.text).join('\n'));
/** A tool's row as the owner sees it, read as one line: where the terminal wraps it depends on the width. */
export function shown(tool: ToolDefinition, result: unknown, expanded = false): string {
  const component = tool.renderResult!(result as never, { expanded, isPartial: false }, plainTheme as never, {} as never) as unknown as Component;
  return component.render(100).map(line => stripTerminalSequences(line).trim()).filter(Boolean).join(' ');
}
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** Waits for `ready`, polling the stored records the way the owner would look again. */
export async function until(ready: () => boolean | Promise<boolean>, limitMs = 30_000): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (!await ready()) { if (Date.now() > deadline) throw new Error('the awaited state never came'); await sleep(20); }
}
