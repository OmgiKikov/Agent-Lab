import { copyFile, chmod, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { workspaceView } from '../../extensions/board-command.ts';
import { LabWorkspace, newState, type WorkspaceAction, type WorkspaceState } from '../../extensions/workspace.ts';
import type { CardProposal } from '../../src/card/proposal.js';
import { cardStatuses } from '../../src/card/status.js';
import { createInputSchema, experimentSchema } from '../../src/contracts.js';
import type { MetricAssessment } from '../../src/assessment.js';
import type { Runtime } from '../../src/runtime.js';
import { demoInput, demoTarget } from '../../src/demo.js';
import { ExperimentLab } from '../../src/experiment.js';
import { draftHash } from '../../src/lab/record.js';
import { importDialogues } from '../../src/imports.js';
import { buildTopicMap, OTHER } from '../../src/miner/topic-map.js';
import { libraryHash } from '../../src/scenario-library.js';
import { BUILDER, scriptedRunner, type Logged } from './miner.js';

/*
 * Synthetic folders for the agent's workspace — never the owner's data: a card set prepared from logs of five topics
 * and run twice (questions and an unusable situation left in it), the built-in example before its first run, and
 * the stored first-format runs. `openWorkspace` draws the real component on what the command would load.
 */

const RULES = [
  'Если номер терминала уже указан, не запрашивайте его повторно; объясните, как оформить возврат.',
  'Называйте статус заявки и срок ответа; не обещайте перезвонить, если можете ответить сразу.',
  'Предлагайте тариф дешевле и называйте разницу в цене.',
].join('\n');
const SAYS: Record<string, string[]> = {
  'Возврат оплаты': ['Номер терминала: 1234. Помогите с возвратом.', 'Помогите с возвратом.', 'Хочу вернуть деньги, а номер терминала не помню.', 'Верните деньги за вчерашнюю покупку.', 'Как оформить возврат на карту?'],
  'Статус заявки': ['Подскажите, что с моей заявкой 88213?', 'Когда ответят по заявке?', 'Заявку приняли, а ответа нет.'],
  'Смена тарифа': ['Есть тариф подешевле моего?', 'Хочу перейти на другой тариф.'],
  'Подключение терминала': ['Не могу подключить терминал.', 'Терминал не видит сеть.'],
  [OTHER]: ['Где ближайшее отделение?'],
};
const TITLES: Record<string, string[]> = {
  'Возврат оплаты': ['номер назван сразу', 'номер только по просьбе', 'клиент не помнит номер', 'покупка вчера', 'возврат на карту'],
  'Статус заявки': ['где моя заявка', 'нет ответа по заявке', 'заявку приняли'],
  'Смена тарифа': ['хочет тариф дешевле', 'хочет другой тариф'],
  'Подключение терминала': ['не подключается', 'нет сети'],
};
const PREFIX: Record<string, string> = { 'Возврат оплаты': 'r', 'Статус заявки': 's', 'Смена тарифа': 't', 'Подключение терминала': 'c', [OTHER]: 'o' };
/** The reply every logged conversation got, and the one the agent under test keeps giving. */
export const ASKS_AGAIN = 'Уточните номер терминала.';

const logs = (): Logged[] => Object.entries(SAYS).flatMap(([topic, openings]) => openings.map((says, index) => ({ id: `${PREFIX[topic]}${index + 1}`, customer: [says], topic })));

/**
 * A deterministic runtime: topics by the answer key, three rules, one situation per conversation, the reviewer
 * doubting what one customer wants and finding no rule for another, a customer who leaves at once, a judge that fails
 * the status situations and one refund, and two named causes.
 */
function richRuntime(logged: Logged[]): Runtime {
  const topics = scriptedRunner(logged);
  const topicOf = new Map(logged.map(item => [item.id, item.topic]));
  return {
    topicMap: { builder: BUILDER, build: (plan, ctx, onProgress) => buildTopicMap(plan, { builder: BUILDER, ctx, onProgress, run: topics.run }) },
    async proposeCard(request, ctx): Promise<CardProposal> {
      ctx.beforeCall();
      const { source } = request.call;
      if (source.kind !== 'dialogue') throw new Error('dialogues only');
      const topic = topicOf.get(source.dialogueId) ?? 'Возврат оплаты';
      const index = Number(source.dialogueId.slice(1)) - 1;
      const title = topic === OTHER ? 'Другое — где ближайшее отделение' : `${topic} — ${TITLES[topic]?.[index] ?? source.dialogueId}`;
      // Each duty cites its line of the rules, the folder's one material.
      const [refund, status, tariff] = RULES.split('\n');
      const duty = (text: string, quote: string, rule: string) => ({ text, basis: [{ sourceId: request.call.sources[0].id, quote, rule, kind: 'behavior' as const }],
        appliesWhen: null, observation: 'reply' as const });
      const refunds = 'Номер не спрашивается повторно; возврат объясняется.';
      const must = topic === 'Статус заявки' ? [duty('назвать статус заявки и срок ответа', status!, 'Статус и срок называются сразу.')]
        : topic === 'Смена тарифа' ? [duty('предложить тариф дешевле и назвать разницу в цене', tariff!, 'Предлагается тариф дешевле с разницей в цене.')]
          : [duty('не спрашивать номер терминала ещё раз, если клиент его уже назвал', refund!, refunds), duty('объяснить, как оформить возврат', refund!, refunds)];
      return { title, topic: topic === OTHER ? 'Другое' : topic, wants: `Получить помощь: ${topic.toLocaleLowerCase('ru')}`, writesEvent: request.call.customerEvents[0]!, knows: [], plausibleKnows: [],
        leaves: 'получил ответ или понял, что агент не поможет', turn: null, agentMust: must, coverage: {} };
    },
    async reviewCard(request, ctx) {
      ctx.beforeCall();
      const title = request.payload.card.title;
      const verdict = (alias: string) => title.includes('нет сети') && alias.startsWith('expectation') ? { status: 'blocked' as const, reason: 'В ваших материалах нет правила о подключении терминала — судье не с чем сравнить ответ.' }
        : title.includes('покупка вчера') && alias.startsWith('goal') ? { status: 'needs_owner' as const, reason: 'В исходном разговоре клиент просил не возврат, а отмену покупки.' }
          : { status: 'ready' as const, reason: 'Подтверждено разговором и правилом.' };
      return { verdicts: Object.fromEntries(request.aliases.map(alias => [alias, verdict(alias)])), model: 'fixture/reviewer' };
    },
    async selectUserAction() { return { actionId: 'leave' }; },
    async assess({ scenario, trial }) {
      const fails = scenario.title.startsWith('Статус заявки') || scenario.title.includes('номер назван сразу');
      const reply = trial.events.filter(event => event.type === 'assistant').at(-1)!;
      return (scenario.metrics ?? []).map((metric): MetricAssessment => ({ metricId: metric.id, result: fails && metric.id === 'e1' ? 'fail' : 'pass', evidence: [reply.seq],
        rationale: fails && metric.id === 'e1' ? 'Агент снова спросил номер вместо ответа.' : 'Выполнено.' }));
    },
    async failureModes({ failures }, ctx) {
      ctx.beforeCall();
      const status = failures.filter(item => item.card.startsWith('Статус заявки')).map(item => item.trialId);
      const refund = failures.filter(item => !item.card.startsWith('Статус заявки')).map(item => item.trialId);
      return [
        ...(status.length ? [{ id: 'asks_number', name: 'Переспрашивает номер вместо ответа по заявке', description: 'Агент просит номер терминала там, где нужен статус заявки.', trialIds: status }] : []),
        ...(refund.length ? [{ id: 'repeats_number', name: 'Переспрашивает номер, который клиент уже назвал', description: 'Номер был в первой реплике клиента.', trialIds: refund }] : []),
      ];
    },
  };
}

/** The folder of a card set of thirteen situations sampled from five topics of the logs, run twice. */
export async function richFolder(): Promise<{ cwd: string; directory: string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-lab-workspace-rich-'));
  const directory = join(cwd, '.agent-lab');
  const logged = logs();
  const masked = { id: 'masked1', messages: [{ role: 'user', content: 'Здравствуйте!' }, { role: 'assistant', content: 'Слушаю вас.' }, { role: 'user', content: '*** ***' }] };
  const batch = importDialogues([...logged.map(item => ({ id: item.id, messages: item.customer.flatMap(content => [{ role: 'user', content }, { role: 'assistant', content: ASKS_AGAIN }]) })), masked]).originalImport;
  const lab = new ExperimentLab(directory, richRuntime(logged));
  await lab.init();
  try {
    const input = createInputSchema.parse({ task: 'Проверить агента поддержки', mode: 'live', target: demoTarget(), targetVersion: 'baseline-v1', scenarioCount: 0,
      existingAgent: { name: 'агент поддержки', instructions: 'Агент поддержки эквайринга.', tools: [] },
      materials: [{ name: 'Правила поддержки.docx', content: RULES }], originalImport: batch,
      settings: { provider: BUILDER.provider, model: BUILDER.id, repeats: 1, maxTurns: 3, maxCalls: 200, userModes: ['reactive'] } });
    const draft = await lab.create(input, { situations: 13 });
    await lab.waitForIdle();
    const context = await lab.cardContext(draft.id);
    const statuses = cardStatuses({ library: context.library, evidence: context.evidence, maxTurns: 3 });
    const ready = context.library.cards.filter(card => statuses.get(card.id)?.status === 'ready').map(card => card.id);
    const accepted = await lab.acceptCards(draft.id, libraryHash(context.library), ready);
    await lab.start(draft.id, { approved: true, reviewer: 'expectations', expectedHash: draftHash(accepted.experiment), requireAccepted: true, parallel: 4 });
    await lab.waitForIdle();
    const repeat = await lab.repeat(draft.id);
    await lab.start(repeat.id, { approved: true, reviewer: 'expectations', expectedHash: draftHash(repeat), parallel: 4 });
    await lab.waitForIdle();
  } finally { await lab.close(); }
  return { cwd, directory };
}

/** The built-in example's folder before its first run. */
export async function demoFolder(): Promise<{ cwd: string; directory: string; id: string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-lab-workspace-demo-'));
  const directory = join(cwd, '.agent-lab');
  const lab = new ExperimentLab(directory);
  await lab.init();
  try {
    const draft = await lab.create(demoInput());
    await lab.waitForIdle();
    return { cwd, directory, id: draft.id };
  } finally { await lab.close(); }
}

/** A folder holding one stored first-format record (with its trace when there is one): the validate path's run, the retired demo's run. */
export async function storedFolder(fixture: 'recorded-run' | 'legacy-demo-run'): Promise<{ cwd: string; directory: string; id: string }> {
  const cwd = await mkdtemp(join(tmpdir(), `agent-lab-workspace-${fixture}-`));
  const directory = join(cwd, '.agent-lab');
  const lab = new ExperimentLab(directory);
  await lab.init();
  try {
    const record = experimentSchema.parse(JSON.parse(await readFile(new URL(`../fixtures/${fixture}.json`, import.meta.url), 'utf8')));
    await lab.store.save(record);
    if (fixture === 'legacy-demo-run') {
      const trace = join(directory, `${record.id}.trace.jsonl`);
      await copyFile(new URL('../fixtures/legacy-demo-run.trace.jsonl', import.meta.url), trace);
      await chmod(trace, 0o600);
    }
    return { cwd, directory, id: record.id };
  } finally { await lab.close(); }
}

const KEYS = { right: '\x1b[C', left: '\x1b[D', down: '\x1b[B', up: '\x1b[A', enter: '\r', escape: '\x1b' } as const;
export { KEYS };

/** The workspace of `directory` as `/agent-lab` would open it, drawn plain: `screen(width)` is what the owner sees, `actions` what it asked the command to do. */
export async function openWorkspace(directory: string, setup: (state: WorkspaceState) => void = () => {}, rows = 44) {
  const state = newState();
  setup(state);
  const view = await workspaceView(new ExperimentLab(directory), state, undefined);
  const actions: WorkspaceAction[] = [];
  const plain = { fg: (_tone: string, text: string) => text, bold: (text: string) => text };
  const board = new LabWorkspace(view, state, plain as never, action => actions.push(action), () => {}, () => rows);
  const screen = (width = 100) => board.render(width).map(line => stripTerminalSequences(line)).join('\n');
  // Keys act on what the owner saw: a screen is drawn before each one.
  const press = (...keys: string[]) => { for (const key of keys) { board.render(100); board.handleInput(key); } return screen(); };
  return { board, view, state, actions, screen, press };
}
