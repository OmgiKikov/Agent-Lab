import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, type Component } from '@earendil-works/pi-tui';
import agentLab from '../../extensions/agent-lab.ts';
import type { Experiment } from '../../src/contracts.js';
import { ExperimentLab } from '../../src/experiment.js';
import { markTargets, measurementUsable } from '../../src/outcomes.js';
import { ExperimentStore } from '../../src/store.js';
import { demoEvaluateRecord, legacyDemoRuntime, legacyDraft } from './demo-record.js';

/*
 * The Pi session of the extension tests: a fake `pi` that registers the real extension, the fake terminal of a scripted
 * owner in the workspace (`/agent-lab`), and the stored fixtures both the chat and the workspace tests start from.
 */

export function registered(onUserMessage?: (message: unknown) => void, options: Parameters<typeof agentLab>[1] = {}) {
  const tools = new Map<string, ToolDefinition>();
  const contexts: { content: string; display: boolean }[] = [];
  const userMessages: unknown[] = [];
  /** The tools the model sees, as Pi keeps them: its own four first, then whatever the extension activates. */
  const active = { names: ['read', 'bash', 'edit', 'write'] };
  let shutdown!: () => Promise<void>;
  let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  let beforeAgentStart!: (event: { systemPrompt: string }, ctx: ExtensionContext) => Promise<{ systemPrompt: string } | undefined>;
  let sessionStart!: (event: unknown, ctx: ExtensionContext) => Promise<void>;
  agentLab({
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: (name: string, options: { handler: typeof command }) => { assert.equal(name, 'agent-lab'); command = options.handler; },
    on: (name: string, handler: () => Promise<void>) => {
      if (name === 'session_shutdown') shutdown = handler;
      else if (name === 'before_agent_start') beforeAgentStart = handler as typeof beforeAgentStart;
      else { assert.equal(name, 'session_start'); sessionStart = handler as typeof sessionStart; }
    },
    sendMessage: (message: { content: string; display: boolean }, options: { deliverAs: string }) => { assert.equal(options.deliverAs, 'followUp'); contexts.push(message); },
    sendUserMessage: (message: unknown, options: { deliverAs: string; expandPromptTemplates: boolean }) => { assert.equal(options.deliverAs, 'followUp'); assert.equal(options.expandPromptTemplates, false); userMessages.push(message); onUserMessage?.(message); },
    getActiveTools: () => [...active.names],
    setActiveTools: (names: string[]) => { active.names = [...names]; },
  } as unknown as ExtensionAPI, options);
  assert.ok(shutdown); assert.ok(command); assert.ok(beforeAgentStart); assert.ok(sessionStart);
  return { tools, shutdown, command, beforeAgentStart, sessionStart, contexts, userMessages, active };
}
export function output(result: Awaited<ReturnType<ToolDefinition['execute']>>) {
  return JSON.parse(result.content.filter(c => c.type === 'text').map(c => c.text).join('\n'));
}
export type RenderContext = Parameters<NonNullable<ToolDefinition['renderResult']>>[3];
/** What Pi hands a tool's renderer for one row: the state its call and result share, and where the row stands. */
export function renderContext(overrides: Partial<RenderContext> = {}): RenderContext {
  return { args: {}, toolCallId: 'row', invalidate() {}, lastComponent: undefined, state: {}, cwd: '/', executionStarted: true, argsComplete: true,
    isPartial: false, expanded: false, showImages: false, isError: false, ...overrides };
}
/** A draft of old-format cards in `cwd/.agent-lab`, as a repeat of an old run leaves it; `mutate` shapes its cards before it is saved. */
export async function legacyDraftIn(cwd: string, options: Parameters<typeof legacyDraft>[1] = {}, mutate?: (record: Experiment) => void): Promise<Experiment> {
  const lab = new ExperimentLab(join(cwd, '.agent-lab'), legacyDemoRuntime());
  await lab.init();
  try {
    const draft = await legacyDraft(lab, options);
    if (!mutate) return draft;
    mutate(draft); await lab.store.save(draft);
    return await lab.get(draft.id);
  } finally { await lab.close(); }
}

/** A finished demo evaluation copied into a fresh Pi working directory, ready for `/agent-lab`. */
export async function boardFixture(prefix: string, mutate?: (record: Experiment) => void) {
  const demo = await demoEvaluateRecord(prefix);
  const cwd = await mkdtemp(join(tmpdir(), `${prefix}cwd-`));
  await demo.lab.close();
  const record = structuredClone(demo.record);
  mutate?.(record);
  const store = new ExperimentStore(join(cwd, '.agent-lab'));
  await store.init();
  try { await store.save(record); } finally { await store.close(); }
  return { cwd, record,
    cleanup: async () => { await rm(cwd, { recursive: true, force: true }); await rm(demo.directory, { recursive: true, force: true }); } };
}

/** Situations the judge decided: exactly what a one-key answer can land on (UI-SPEC F10, 03.1 markTargets). */
export function judgedSituations(record: Experiment) {
  const controls = new Set(record.positiveControlScenarioIds ?? []);
  return record.trials.flatMap(trial => {
    const scenario = record.scenarios.find(card => card.id === trial.scenarioId);
    if (!scenario || controls.has(scenario.id) || !measurementUsable(scenario, trial, record.humanReviews)) return [];
    const targets = markTargets(scenario, trial);
    if (!targets) return [];
    return [{ trial, scenario, metricIds: targets.metricIds, judgeVerdict: targets.verdict }];
  });
}

/** Keys as the terminal sends them. */
export const KEY = { right: '\x1b[C', left: '\x1b[D', down: '\x1b[B', up: '\x1b[A', enter: '\r', escape: '\x1b' } as const;
/** Esc closes the innermost open object, then the workspace: four close it from anywhere. */
export const CLOSE = [KEY.escape, KEY.escape, KEY.escape, KEY.escape];

/**
 * One opening of the workspace: the keys pressed; the keys pressed once the screen shows `until` (and `ready` holds);
 * or the exact action the workspace would emit.
 */
export type WorkspaceStep = string[] | { until: string; ready?: () => boolean; keys: string[] } | { action: Record<string, unknown> };

/**
 * A scripted owner in the workspace (`/agent-lab`): `steps` holds one entry per opening; `reason` is what the native
 * editor returns, `words` what the one-line input returns, `choice` what a native select returns (its first answer
 * when unset). `screens` keeps what each opening showed first — where the notice of the previous action is read —,
 * `frames` every screen after every key.
 */
export function workspaceSession(cwd: string) {
  const screens: string[] = [];
  const frames: string[] = [];
  const editorCalls: { title: string; initial: string }[] = [];
  const selectCalls: { title: string; options: string[] }[] = [];
  const inputCalls: string[] = [];
  const state = { steps: [] as WorkspaceStep[], reason: undefined as string | undefined, words: undefined as string | undefined,
    choice: undefined as string | ((title: string, options: string[]) => string | undefined) | undefined };
  const ctx = { cwd, hasUI: true, mode: 'tui', model: undefined, ui: {
    editor: async (title: string, initial: string) => { editorCalls.push({ title, initial }); return state.reason; },
    input: async (title: string) => { inputCalls.push(title); return state.words; },
    select: async (title: string, options: string[]) => {
      selectCalls.push({ title, options });
      return typeof state.choice === 'function' ? state.choice(title, options) : state.choice ?? options[0];
    },
    notify: () => {},
    custom: (factory: (tui: unknown, theme: unknown, keys: unknown, done: (value: unknown) => void) => Component & { dispose?(): void }) => new Promise((resolve, reject) => {
      const component = factory({ terminal: { rows: 40 }, requestRender() {} }, { fg: (_: string, text: string) => text, bold: (text: string) => text }, {},
        value => { component.dispose?.(); resolve(value); });
      const shot = () => stripTerminalSequences(component.render(120).join('\n'));
      void (async () => {
        const step = state.steps.shift(); assert.ok(step, 'unexpected workspace');
        screens.push(shot()); frames.push(screens.at(-1)!);
        if (!Array.isArray(step) && 'action' in step) { component.dispose?.(); resolve(step.action); return; }
        if (!Array.isArray(step)) {
          const deadline = Date.now() + 15000;
          while (!shot().includes(step.until) || step.ready && !step.ready()) {
            if (Date.now() > deadline) throw new Error(`the workspace never showed «${step.until}»:\n${shot()}`);
            await new Promise(r => setTimeout(r, 50));
          }
          frames.push(shot());
        }
        for (const key of Array.isArray(step) ? step : step.keys) { component.handleInput!(key); frames.push(shot()); }
      })().catch(error => { component.dispose?.(); reject(error); });
    }),
  } } as unknown as ExtensionCommandContext;
  return { ctx, screens, frames, editorCalls, selectCalls, inputCalls, state };
}

/** The notice under the header of a workspace screen — what the last action did —, its wrapped lines joined. */
export function noticeOf(screen: string): string {
  const lines = screen.split('\n');
  // The frame, the agent and its areas (or steps) come first; the notice runs to the blank line before the body.
  const end = lines.indexOf('', 3);
  return lines.slice(3, end < 0 ? 3 : end).map(line => line.trim()).join(' ');
}
export const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
