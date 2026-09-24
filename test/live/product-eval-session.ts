import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, SettingsManager, type ExtensionUIContext, type ModelRuntime } from '@earendil-works/pi-coding-agent';
import { buildFixture, score, type Call, type EvalCase } from './product-eval-cases.ts';

/*
 * One eval phrase in a real Pi session: a fresh project, the extension loaded the way `agent-lab chat` loads it, the
 * owner's phrase, a scripted owner answering the native dialogs, and the verdict from the tools the model called and
 * the state the project was left in. The model is whatever `model` names on `runtime`: a real one in the runner,
 * a scripted offline one in CI.
 */

const EXTENSION = fileURLToPath(new URL('../../extensions/agent-lab.ts', import.meta.url));
const SETTINGS = { packages: [], enableAnalytics: false, enableInstallTelemetry: false };

/** The owner at the terminal: native choices answered by the case, everything else of the interface quietly absent. */
function scriptedOwner(item: EvalCase, dialogs: string[]): ExtensionUIContext {
  const answers: Partial<ExtensionUIContext> = {
    select: async (title, options) => { dialogs.push(title.split('\n')[0] ?? ''); return (item.pick ?? ((_: string, all: string[]) => all[0]))(title, options); },
    confirm: async () => false, input: async () => undefined, editor: async () => undefined,
  };
  // Not a promise: `then` stays absent, so nothing mistakes the interface for one.
  return new Proxy(answers, { get: (target, name) => name === 'then' ? undefined : (target as Record<string | symbol, unknown>)[name] ?? (() => undefined) }) as ExtensionUIContext;
}

export interface Played { calls: Call[]; dialogs: string[]; passed: boolean; notes: string[] }

/** Says `item.phrase` to the model in a fresh project built for it, and scores what happened. */
export async function playCase(item: EvalCase, options: { runtime: ModelRuntime; model?: NonNullable<ReturnType<ModelRuntime['getModel']>>; agentDir?: string }): Promise<Played> {
  const cwd = await buildFixture(item.fixture);
  const calls: Call[] = [], dialogs: string[] = [];
  const previous = process.env.AGENT_LAB_SESSION;
  process.env.AGENT_LAB_SESSION = '1';
  try {
    const loader = new DefaultResourceLoader({ cwd, agentDir: options.agentDir ?? getAgentDir(), settingsManager: SettingsManager.inMemory(SETTINGS),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [EXTENSION] });
    await loader.reload();
    const { session } = await createAgentSession({ cwd, modelRuntime: options.runtime, ...(options.model ? { model: options.model } : {}), resourceLoader: loader,
      sessionManager: SessionManager.inMemory(), settingsManager: SettingsManager.inMemory(SETTINGS) });
    try {
      session.subscribe(event => { if (event.type === 'tool_execution_start' && event.toolName.startsWith('agent_lab_')) calls.push({ name: event.toolName, args: event.args ?? {} }); });
      await session.bindExtensions({ uiContext: scriptedOwner(item, dialogs), mode: 'tui' });
      await session.prompt(item.phrase);
      await session.waitForIdle();
    } finally { session.dispose(); }
    return { calls, dialogs, ...await score(item, calls, cwd) };
  } catch (error) {
    return { calls, dialogs, passed: false, notes: [error instanceof Error ? error.message : String(error)] };
  } finally {
    if (previous === undefined) delete process.env.AGENT_LAB_SESSION; else process.env.AGENT_LAB_SESSION = previous;
    await rm(cwd, { recursive: true, force: true });
  }
}
