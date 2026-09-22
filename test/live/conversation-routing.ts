/** Real outer Pi chooses tools. Inner card checks are deterministic, so this measures routing, not generator quality. */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, getAgentDir, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import agentLab from '../../extensions/agent-lab.ts';
import { scenarioToolSurfaces } from '../../extensions/scenario-parameters.ts';
import { ExperimentLab } from '../../dist/experiment.js';
import { createInputSchema, type Runtime } from '../../dist/contracts.js';
import { createDemoRuntime } from '../../dist/demo.js';
import { coverageProposals, rawDialogues, requirements, sources } from '../helpers/scenario-library.js';

if (!process.argv.includes('--run')) throw new Error('This uses provider credits. Run deliberately with --run.');
const directory = await mkdtemp(join(tmpdir(), 'agent-lab-routing-'));
const cases: { id: string; message: string; mutations: string[]; target?: string }[] = JSON.parse(await readFile(new URL('../fixtures/conversation-routing.json', import.meta.url), 'utf8'));
const selected = process.env.AGENT_LAB_ROUTING_CASES?.split(',');
const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
const provider = process.env.AGENT_LAB_PROVIDER ?? 'openrouter', modelId = process.env.AGENT_LAB_MODEL ?? 'z-ai/glm-5.3-flash';
const model = modelRuntime.getModel(provider, modelId);
if (!model) throw new Error(`Configured model unavailable: ${provider}/${modelId}`);
const limit = 48;
let calls = 0, knownCostUsd = 0, unknownCostCalls = 0, replies = 0, pendingUsage = 0;
const results: unknown[] = [];
const runtime: Runtime = {
  ...createDemoRuntime(),
  async prepare() { return { requirements: requirements.map(r => ({ ...r, sourceId: 'source-1' })), questions: [], agent: { name: 'Учебный агент', instructions: 'Уточните номер терминала', tools: [] }, scenarios: [] }; },
  async scenarioProposals(request, ctx) { ctx.beforeCall(); return coverageProposals(request.batchId).map((p, index) => index ? { ...p, business: { ...p.business, key: 'refund_term', title: 'Срок возврата', goal: 'Узнать срок возврата' } } : p)
    .filter(p => request.dialogues.some(d => d.id === p.variant.sourceDialogues[0]!.dialogueId)) as never; },
  async assessScenarioProposals(request, ctx) { ctx.beforeCall(); return request.fields.flatMap(f => f.paths.map(path => ({ variantId: f.variantId, path, status: 'ready' as const, reason: 'Deterministic routing fixture, not a semantic quality result' }))); },
};
process.env.AGENT_LAB_SESSION = '1';
for (const item of cases.filter(item => !selected || selected.includes(item.id))) {
  if (calls >= limit) break;
  const cwd = join(directory, item.id), lab = new ExperimentLab(join(cwd, '.agent-lab'), runtime);
  await lab.init();
  const seed = await lab.create(createInputSchema.parse({ task: 'Проверить возвраты', mode: 'demo', materials: sources.map(({ name, content }) => ({ name, content })),
    dialogues: rawDialogues, scenarioCount: 2, settings: { maxCalls: 100, repeats: 1, userModes: ['reactive'] } }));
  await lab.waitForIdle(); const before = await lab.get(seed.id); await lab.close();
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } }, enableAnalytics: false, enableInstallTelemetry: false, transport: 'sse' });
  const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [api => agentLab(api, { createLab: directory => new ExperimentLab(directory, runtime) })],
    systemPrompt: 'Ты работаешь в Agent Lab. В этой папке уже есть подготовленный черновик с двумя карточками. Помоги владельцу выполнить его просьбу доступными инструментами. Отвечай кратко по-русски. Не меняй то, что он просит сохранить. Обычные правки черновика выполняй самостоятельно; человеческие подтверждения не имитируй.' });
  await loader.reload();
  const { session } = await createAgentSession({ cwd, modelRuntime, model, thinkingLevel: 'off', noTools: 'builtin', resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), settingsManager });
  await session.bindExtensions({ mode: 'rpc' });
  const events: unknown[] = [], attempted: { name: string; args: Record<string, unknown> }[] = [];
  const stream = session.agent.streamFunction, usedBefore = calls;
  session.agent.streamFunction = async (m, context, options) => {
    if (calls >= limit || calls - usedBefore >= 6) throw new Error('Routing evaluation call limit reached');
    calls++; pendingUsage++;
    return stream(m, context, { ...options, timeoutMs: 60000, maxRetries: 0, maxTokens: 3000 });
  };
  const unsubscribe = session.subscribe(event => {
    if (event.type === 'tool_execution_start') {
      const surface = scenarioToolSurfaces.find(item => item.name === event.toolName);
      attempted.push(surface ? { name: 'agent_lab_scenarios', args: { ...(event.args as Record<string, unknown>), operation: surface.operation } }
        : { name: event.toolName, args: event.args as Record<string, unknown> });
    }
    if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end' || event.type === 'message_end') events.push(event);
    if (event.type === 'message_end' && event.message.role === 'assistant' && pendingUsage > 0) {
      pendingUsage--; replies++;
      const cost = event.message.usage?.cost?.total;
      if (typeof cost === 'number' && Number.isFinite(cost) && cost > 0) knownCostUsd += cost; else unknownCostCalls++;
    }
  });
  let error: string | undefined;
  const timer = setTimeout(() => session.agent.abort(), 90000);
  try { await session.prompt(item.message); }
  catch (e) { error = e instanceof Error ? e.message : String(e); }
  finally { clearTimeout(timer); unsubscribe(); session.dispose(); }
  const after = await new ExperimentLab(join(cwd, '.agent-lab'), runtime).get(seed.id);
  const mutations = attempted.filter(call => call.name === 'agent_lab_scenarios' ? !['show', 'inspect'].includes(String(call.args.operation))
    : call.name === 'agent_lab_run' ? call.args.action !== 'progress'
      : !['agent_lab_status', 'agent_lab_inspect'].includes(call.name));
  const expectedCard = item.target ? before.librarySnapshot!.variants[Number(item.target) - 1] : undefined;
  const expectedGroup = item.target ? before.librarySnapshot!.businessScenarios[Number(item.target) - 1] : undefined;
  const referenceMatches = (value: unknown, group = false) => [item.target, group ? expectedGroup?.id : expectedCard?.id, group ? expectedGroup?.title : expectedCard?.title].includes(String(value));
  const correctCalls = mutations.every(call => call.name === 'agent_lab_scenarios' && item.mutations.includes(String(call.args.operation))
    && (call.args.operation === 'edit_group' ? referenceMatches(call.args.group, true)
      : call.args.variants ? (call.args.variants as unknown[]).length === 1 && referenceMatches((call.args.variants as unknown[])[0]) : referenceMatches(call.args.variant)));
  const protectedCardsUnchanged = before.librarySnapshot!.variants.filter(card => card.id !== expectedCard?.id).every(card =>
    JSON.stringify(card.userState) === JSON.stringify(after.librarySnapshot!.variants.find(next => next.id === card.id)?.userState));
  const unchanged = JSON.stringify(before.librarySnapshot) === JSON.stringify(after.librarySnapshot);
  const providerError = events.some((event: any) => event.type === 'message_end' && event.message.role === 'assistant' && ['error', 'aborted'].includes(event.message.stopReason));
  const passed = !error && !providerError && correctCalls && protectedCardsUnchanged && (item.mutations.length ? mutations.length > 0 : unchanged);
  const result = { id: item.id, passed, calls: calls - usedBefore, attempted, error, providerError, protectedCardsUnchanged, unchanged };
  results.push(result);
  await writeFile(join(cwd, 'routing-events.json'), JSON.stringify(events, null, 2), { mode: 0o600 });
  await writeFile(join(directory, 'report.json'), JSON.stringify({ evidenceKind: 'real-outer-pi-with-deterministic-inner-checks', provider, model: modelId, limit, calls, knownCostUsd, unknownCostCalls: unknownCostCalls + Math.max(0, calls - replies), results,
    limitations: 'Synthetic routing controls. Native decisions are unavailable in RPC. Not a real-target, generator-quality or human-UX acceptance result.' }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ id: item.id, passed, calls: calls - usedBefore, operations: attempted.map(call => `${call.name}:${call.args.operation ?? call.args.action ?? ''}`) }));
}
console.log(JSON.stringify({ directory, calls, limit, knownCostUsd, unknownCostCalls: unknownCostCalls + Math.max(0, calls - replies) }));
if (results.some((result: any) => !result.passed) || results.length !== cases.filter(item => !selected || selected.includes(item.id)).length) process.exitCode = 1;
