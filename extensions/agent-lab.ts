import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { stripFrontmatter, type ExtensionAPI, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import type { TSchema } from 'typebox';
import { ExperimentLab } from '../src/experiment.js';
import { safeText } from '../src/text.js';
import { rememberFeed, type Feed } from './render/feed.ts';
import { row } from './conversation.ts';
import { registerBoardCommand } from './board-command.ts';
import { registerConnectTool } from './connect-tool.ts';
import { registerDecideTool } from './decide-tool.ts';
import { registerPrepareTool } from './prepare-tool.ts';
import { registerResultTools } from './result-tools.ts';
import { registerRunTool } from './run-tool.ts';
import { registerSituationTools } from './situation-tools.ts';
import { Background, registerMessageRenderers } from './background.ts';
import { SessionOperations } from './operations.ts';
import { verdictOutput } from './model-output.ts';
import { activateStep } from './steps.ts';
import type { LabHost } from './host.ts';
import { isInteractive, NeedsOwner } from './lab-ui.ts';
import { createGateway, type GatewayOptions } from './gateway.ts';

/*
 * Agent Lab inside Pi: ten tools, of which the model sees only those of the step the project is at (steps.ts), the
 * /agent-lab workspace, and the messages long work reports back with. What the model is told comes from one source,
 * the agent-builder skill (skills/agent-builder/SKILL.md): its body joins the system prompt of an Agent Lab session;
 * everything a tool itself can say is in that tool's description. The owner's personal model gateway (provider giga)
 * is registered here too and connected with `/agent-lab gateway` (gateway.ts).
 */

/** The one instruction source, read once: the skill without its frontmatter. */
const GUIDE = new URL('../skills/agent-builder/SKILL.md', import.meta.url);
let guide: Promise<string> | undefined;
const guideText = (): Promise<string> => guide ??= readFile(GUIDE, 'utf8').then(text => stripFrontmatter(text).trim());

interface AgentLabOptions {
  inlineRunMs?: number; inlineCheckMs?: number; inlineBuildMs?: number; createLab?: (directory: string) => ExperimentLab;
  /** How the workspace opens a saved report; the system's browser by default. */
  openReport?: (path: string) => Promise<void>;
  gateway?: GatewayOptions;
}
/**
 * Everything is registered synchronously; the returned promise is the gateway's startup connection, which Pi awaits
 * so that its models are in the first /model list.
 */
export default function agentLab(pi: ExtensionAPI, options: AgentLabOptions = {}): Promise<void> {
  const gateway = createGateway(pi, options.gateway);
  const operations = new SessionOperations(options.createLab);
  const reading = (directory: string): ExperimentLab => operations.reader(directory);
  /** The model gets the tools of the step the project's records are at; unreadable records leave the tools as they are. */
  const step = async (directory: string): Promise<void> => {
    try { activateStep(pi, await reading(directory).list()); } catch { /* the next request reads them again */ }
  };
  const feedResult = (callId: string, output: unknown, feed: Feed, note: string) =>
    ({ content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }], details: rememberFeed(callId, feed, note) });
  /** An owner question becomes an ordinary result: the row shows what to clarify, the model is told not to guess. */
  const askOwner = (callId: string, error: unknown) => {
    if (!(error instanceof NeedsOwner)) throw error;
    const message = safeText(error.message);
    return feedResult(callId, { status: error.code, mutated: false, message, options: error.options,
      instruction: 'Nothing was written. Put this question to the owner in plain words; do not pick an option or invent a value yourself.' },
      { tone: 'warning', rows: [row(safeText(error.ownerText ?? message))] }, 'Нужно уточнение');
  };
  const background = new Background(pi, { operations, verdictOutput, refresh: step });
  const host: LabHost = {
    inlineRunMs: options.inlineRunMs ?? 20_000,
    /** A recheck that finishes this fast is reported in the row of the change; a longer one reports back as a message. */
    inlineCheckMs: options.inlineCheckMs ?? 3_000,
    inlineBuildMs: options.inlineBuildMs ?? 5_000,
    operations, background, reading, feedResult, askOwner, verdictOutput,
    open: (cwd, pendingCheck = 'cancel') => operations.acquire(resolve(cwd, '.agent-lab'), pendingCheck),
    backgroundCheck: (ctx, owned, id, card) => background.check(ctx, owned, id, card),
  };
  /** Every Lab tool, once it has answered, hands the model the tools of the step it moved the project to. */
  const tools: Pick<ExtensionAPI, 'registerTool'> = {
    registerTool: <P extends TSchema, D, S>(tool: ToolDefinition<P, D, S>) => pi.registerTool({ ...tool,
      async execute(callId, params, signal, onUpdate, ctx) {
        try { return await tool.execute(callId, params, signal, onUpdate, ctx); } finally { await step(resolve(ctx.cwd, '.agent-lab')); }
      } }),
  };
  registerMessageRenderers(pi);
  pi.on('session_start', async (_event, ctx) => {
    await step(resolve(ctx.cwd, '.agent-lab'));
    if (process.env.AGENT_LAB_SESSION !== '1' || !isInteractive(ctx)) return;
    ctx.ui.setTitle(`Agent Lab · ${ctx.cwd.split('/').at(-1)}`);
    ctx.ui.setHeader((_tui, theme) => new Text(`${theme.bold('Agent Lab')} — насколько хорош ваш агент.\n${theme.fg('muted', safeText(ctx.cwd))}`, 1, 1));
    ctx.ui.setWidget('agent-lab-start', ['Напишите обычными словами, например: «проверь агента в этой папке, логи — logs.xlsx».',
      '/agent-lab — рабочее пространство агента · /agent-lab demo — учебный пример без модели и ключей.',
      // A refused gateway is otherwise only in stderr, which the terminal does not show, and looks like an unexplained «no api key».
      ...[gateway.note()].filter((line): line is string => !!line)]);
  });
  pi.on('before_agent_start', async (event, ctx) => {
    await step(resolve(ctx.cwd, '.agent-lab'));
    if (process.env.AGENT_LAB_SESSION !== '1') return;
    ctx.ui?.setWidget?.('agent-lab-start', undefined);
    return { systemPrompt: `${event.systemPrompt}\n\n${await guideText()}` };
  });
  registerPrepareTool(tools, host);
  registerSituationTools(tools, host);
  registerDecideTool(tools, host);
  registerRunTool(tools, host);
  registerResultTools(tools, host);
  registerConnectTool(tools, host);
  registerBoardCommand(pi, host, { gateway: gateway.command, ...(options.openReport ? { openReport: options.openReport } : {}) });
  pi.on('session_shutdown', () => operations.shutdown());
  return gateway.ready;
}
