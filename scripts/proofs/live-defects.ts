/*
 * I — what the first live analysis of a real agent's logs showed (2026-09-26: a bank's acquiring support bot, 866 logged
 * conversations, the default judge), each case fixed and held here on constructed logs:
 *   (1) a conversation was judged by a duty of a situation its customer was never in, and «the agent did not say X» became
 *       a violation — the judge is now told the situation, and a customer who was not in it did not exercise the duty;
 *   (2)–(4) one dropped connection ended the whole analysis after 36 paid calls — now one step of one topic does not finish
 *       (its plan, the reviewer's check, the fit), is said as Lab's work, and a continuation does it;
 *   (5) the screen said «произошла ошибка» and told the owner to add a rule — now the kind of failure and the next step;
 *   (6) the owner could not tell why 24 were selected and 18 judged of 866 — now one line of the way and why each was not;
 *   (7) the export wrote the chat's buttons into the agent's replies («` ` ` transition-code … ` ` `»), and the judge read
 *       them as internal systems named to the customer — now the owner is asked what they are, and their yes reads them so;
 *   (8) four topics were lost because the planner quoted the agent's Markdown prompt without its `**` and backticks, and
 *       the repair said only «not verbatim» five times — now emphasis is layout, and a rejection shows the source's words.
 * Contract checks with stand-ins: what a real judge makes of the situation is report B.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { judgeLogged, logProtocolHash } from '../../src/card/log-judge.js';
import { INTERFACE_ELEMENT } from '../../src/interface-markup.js';
import { confirmTableImport, proposeTableImport, readConfirmedTable, readingConfirmed } from '../../src/spreadsheet/import.js';
import { questionText } from '../../src/spreadsheet/lines.js';
import { ExperimentLab } from '../../src/experiment.js';
import { planSlips, type PlanCall, type PlanProposal } from '../../src/card/plan.js';
import { settingsSchema } from '../../src/contracts.js';
import { continuationConsentText } from '../../src/discover/consent.js';
import { analysisLines, funnelLines, gapLine, nextStep } from '../../src/discover/text.js';
import type { AnalyzeInput } from '../../src/lab/discover.js';
import { ProviderFailure } from '../../src/llm/model-call.js';
import { buildTopicMap, type TopicTaskRunner } from '../../src/miner/topic-map.js';
import type { Runtime } from '../../src/runtime.js';
import { importBatch } from '../../src/scenario-library.js';
import { claim, folder } from './common.js';
import { analysed, EXPLAIN, fitter, goodPlan, passingJudge, RULES, topicMap, withLab } from './discover-work.js';

type Row = { id: string; messages: { role: string; content: string }[] };
const row = (id: string, customer: string, agent: string): Row => ({ id, messages: [{ role: 'user', content: customer }, { role: 'assistant', content: agent }] });
const input = (rows: Row[], requested?: number): AnalyzeInput => ({ task: 'Бот помогает с возвратом оплаты', mode: 'live', file: 'логи', materials: [{ name: 'Правила', content: RULES }],
  logs: importBatch(rows), settings: settingsSchema.parse({ timeoutMs: 60000 }), ...(requested ? { requested } : {}) });
const dropped = () => new ProviderFailure('connection failure', 'Pi provider response incomplete: connection failure');

/**
 * A stand-in judge that reads the situation as the `logged-v3` scope tells a judge to: a customer who never asked for a
 * refund was not in the situation — both conditions not met; one who did is judged on the reply. `seen` keeps what it was told.
 */
function situatedJudge(seen: { mode?: string; situation?: { question: string; circumstances?: string } }[]): Runtime['logJudge'] {
  return { provider: 'stub', model: 'stub-judge', protocolHash: logProtocolHash(), assess: (request, ctx) => judgeLogged(request, { provider: 'stub', id: 'stub-judge' }, ctx, async (_prompt, raw) => {
    const data = JSON.parse(raw) as { mode: string; situation?: { question: string; circumstances?: string }; scenario: { metrics: { id: string }[] }; dialogue: { events: { seq: number; type: string; content: string }[] } };
    seen.push({ mode: data.mode, ...(data.situation ? { situation: data.situation } : {}) });
    const reply = data.dialogue.events.find(event => event.type === 'assistant')!;
    const inSituation = data.dialogue.events.some(event => event.type === 'user' && event.content.includes('оплат'));
    const [pass, fail] = !inSituation ? ['not_met', 'not_met'] : reply.content.includes('Подайте заявление') ? ['met', 'not_met'] : ['not_met', 'met'];
    return JSON.stringify({ assessments: [{ metricId: data.scenario.metrics[0]!.id, rationale: inSituation ? 'Клиент просил вернуть оплату.' : 'Клиент не просил вернуть оплату: ожидание не наступило.',
      evidence: inSituation ? [reply.seq] : [], citations: inSituation ? [{ seq: reply.seq, quote: reply.content }] : [], passCondition: pass, failCondition: fail }] });
  }) };
}

/** `work` with a lab opened on `directory` as its writer, as the command line confirms a table. */
async function asWriter<T>(directory: string, work: (lab: ExperimentLab) => Promise<T>): Promise<T> {
  const lab = new ExperimentLab(directory);
  await lab.init();
  try { return await work(lab); } finally { await lab.close(); }
}

/** Two topics by the conversation's first letter: «c» — a refund, «d» — a delivery. */
const twoTopics: TopicTaskRunner = async (task, raw) => {
  const items = task.id === 'topic-classification' ? (raw as { conversations: { dialogueId: string }[] }).conversations : [];
  const value = task.output.parse(task.id === 'topic-proposal'
    ? { topics: [{ title: 'Возврат оплаты', description: 'Клиент просит вернуть оплату.' }, { title: 'Доставка', description: 'Клиент спрашивает о доставке.' }] }
    : { assignments: items.map(({ dialogueId }) => ({ dialogueId, topicId: dialogueId.startsWith('d') ? 't2' : 't1' })) });
  const problem = task.check?.(value);
  if (problem) throw new Error(typeof problem === 'string' ? problem : problem.reason);
  return value;
};
const BUILDER = { provider: 'stub', id: 'stub-builder' };
const byTopic: Runtime['topicMap'] = { builder: BUILDER, build: (plan, ctx, onProgress) => buildTopicMap(plan, { builder: BUILDER, run: twoTopics, ctx, onProgress }) };
const refunds = ['c1', 'c2', 'c3'].map(id => row(id, `Верните оплату за заказ ${id}.`, 'Подайте заявление в поддержку.'));
const deliveries = ['d1', 'd2', 'd3'].map(id => row(id, `Где моя доставка ${id}?`, 'Подайте заявление в поддержку.'));

export async function proofLiveDefects(): Promise<void> {
  // (1) One plan over a topic; its second conversation's customer never asked for a refund.
  const seen: Parameters<typeof situatedJudge>[0] = [];
  const onePlan: Runtime['proposeScenario'] = async ({ call }) => ({ question: 'Клиент просит вернуть оплату', variations: [{ title: 'Номер заказа назван', examples: call.examples.map(example => example.dialogueId) }],
    expectations: [{ text: 'объяснить, как оформить возврат', strength: 'must', acceptable: null, violation: 'Агент не объясняет, как оформить возврат', basis: [{ sourceId: 'source-1', quote: EXPLAIN, kind: 'behavior' }], variations: null, observation: 'reply', tool: null }],
    uncovered: null } as unknown as PlanProposal);
  const situated = await withLab('i-situation', { proposeScenario: onePlan, logJudge: situatedJudge(seen) },
    lab => analysed(lab, input([row('k1', 'Верните оплату за заказ 5.', 'Не знаю.'), row('k2', 'Терминал не включается.', 'Не знаю.')])));
  const finding = (id: string) => situated.analysis.findings.find(item => item.dialogueId === id);
  claim('I', seen.length === 4 && seen.every(item => item.mode === 'logged-v3' && item.situation?.question === 'Клиент просит вернуть оплату' && item.situation.circumstances === 'Номер заказа назван'),
    `(1) the judge is told the situation the duty is for: ${JSON.stringify(seen[0]?.situation)} (mode ${seen[0]?.mode})`);
  claim('I', finding('k1')?.result === 'fail' && finding('k2')?.result === 'unknown' && JSON.stringify(situated.view.problems[0]?.dialogueIds) === '["k1"]'
    && analysisLines(situated.view).some(line => line.includes('разговор не дошёл до правила')),
    `(1) «Не знаю.» to a refund request is a violation (k1 ${finding('k1')?.result}); to «Терминал не включается» it is no violation of the refund duty (k2 ${finding('k2')?.result}, not exercised)`);

  // (2) A dropped connection on one topic's plan: that topic is Lab's unfinished work, the other is analysed, a continuation plans it.
  let drop = true;
  const planner: Runtime['proposeScenario'] = async ({ call }) => { if (drop && call.topic.title === 'Доставка') throw dropped(); return goodPlan(call); };
  await withLab('i-plan', { topicMap: byTopic, proposeScenario: planner, logJudge: passingJudge({ count: 0 }) }, async lab => {
    const first = await analysed(lab, input([...refunds, ...deliveries], 6));
    const gap = first.view.gaps.find(item => item.title === 'Доставка');
    claim('I', first.analysis.status === 'done' && gap?.issue === 'provider_failed' && first.analysis.findings.some(item => item.dialogueId === 'c1') && !first.analysis.findings.some(item => item.dialogueId === 'd1')
      && gapLine(gap).includes('связь оборвалась') && gapLine(gap).includes('Это работа Lab') && nextStep(first.view).includes('продолжите разбор'),
      `(2) a dropped connection on one topic's plan: the analysis ${first.analysis.status}, «${gap ? gapLine(gap) : ''}»; next: «${nextStep(first.view)}»`);
    drop = false;
    const consent = await lab.continuationConsent({ analysisId: first.analysis.id, more: 1 });
    const started = await lab.continueAnalysis({ analysisId: first.analysis.id, more: 1 }, { callCeiling: consent.callCeiling });
    await lab.waitForIdle();
    const next = await lab.getAnalysis(started.id);
    claim('I', consent.replanned === 1 && next.findings.some(item => item.dialogueId === 'd1') && next.continues?.reused === first.analysis.findings.length,
      `(2) the continuation plans it again and judges its conversations; the rest carried with no call (${next.continues?.reused}): «${continuationConsentText(consent).lines.find(line => line.includes('найти снова')) ?? ''}»`);
  });

  // (3) A dropped connection at the reviewer of a gap: never the owner's gap, the analysis goes on.
  const silentDelivery: Runtime['proposeScenario'] = async ({ call }) => call.topic.title === 'Доставка' ? { ...goodPlan(call), expectations: [], uncovered: 'где доставка заказа' } as PlanProposal : goodPlan(call);
  const reviewer: Runtime['reviewCard'] = async () => { throw dropped(); };
  const reviewed = await withLab('i-review', { topicMap: byTopic, proposeScenario: silentDelivery, reviewCard: reviewer, logJudge: passingJudge({ count: 0 }) },
    lab => analysed(lab, input([...refunds, ...deliveries], 6)));
  const unreviewed = reviewed.view.gaps.find(item => item.title === 'Доставка');
  claim('I', reviewed.analysis.status === 'done' && unreviewed?.rulesGap?.confirmed === false && gapLine(unreviewed).includes('связь с моделью проверяющего оборвалась')
    && gapLine(unreviewed).includes('не пробел в ваших правилах'),
    `(3) a dropped connection at the reviewer: «${unreviewed ? gapLine(unreviewed) : ''}»`);

  // (4) A dropped connection at the fit: the extra conversations are never judged by a plan no one fitted them to.
  let fitDrops = true;
  const fit: Runtime['fitConversations'] = async (request, ctx) => { if (fitDrops) throw dropped(); return fitter!(request, ctx); };
  const twelve = Array.from({ length: 12 }, (_, index) => row(`c${String(index + 1).padStart(2, '0')}`, `Верните оплату, пожалуйста (${index + 1}).`, 'Подайте заявление в поддержку.'));
  await withLab('i-fit', { topicMap, proposeScenario: async ({ call }) => goodPlan(call), fitConversations: fit, logJudge: passingJudge({ count: 0 }) }, async lab => {
    const first = await analysed(lab, input(twelve, 12));
    const group = first.analysis.topics[0]!;
    const extra = group.extra ?? [];
    const funnel = funnelLines(first.view);
    claim('I', first.analysis.status === 'done' && group.fitIssue === 'provider_failed' && extra.length === 4 && !first.analysis.findings.some(item => extra.includes(item.dialogueId))
      && funnel.some(line => line.includes('Не оценены 4: 4 — работа Lab над их темой не закончилась')),
      `(4) a dropped connection at the fit: ${extra.length} extra conversations not judged by the plan — «${funnel.join(' ')}»`);
    fitDrops = false;
    const consent = await lab.continuationConsent({ analysisId: first.analysis.id, more: 1 });
    const started = await lab.continueAnalysis({ analysisId: first.analysis.id, more: 1 }, { callCeiling: consent.callCeiling });
    await lab.waitForIdle();
    const next = await lab.getAnalysis(started.id);
    const refit = extra.filter(id => next.assignments.some(item => item.dialogueId === id) || next.topics.some(item => item.others && item.dialogueIds.includes(id)));
    claim('I', consent.refitted === 4 && refit.length === 4 && extra.every(id => next.findings.some(item => item.dialogueId === id) || next.topics.some(item => item.unfit?.includes(id))),
      `(4) the continuation fits them (${refit.length}) and judges them: «${continuationConsentText(consent).lines.find(line => line.includes('сверит')) ?? ''}»`);
  });

  // (5) The whole analysis ended: the screen names what failed and the next step — never «произошла ошибка» with a rule to add.
  for (const [what, error, expected] of [
    ['a dropped connection', dropped(), 'связь с провайдером модели оборвалась'],
    ['no access', new ProviderFailure('access denied', 'Pi provider response incomplete: access denied'), 'провайдер модели отказал'],
  ] as const) {
    const failing: Runtime['topicMap'] = { builder: BUILDER, build: async () => { throw error; } };
    const ended = await withLab('i-failed', { topicMap: failing, proposeScenario: async ({ call }) => goodPlan(call), logJudge: passingJudge({ count: 0 }) },
      lab => analysed(lab, input([...refunds, ...deliveries], 6)));
    const line = analysisLines(ended.view).find(item => item.startsWith('Разбор не закончен')) ?? '';
    claim('I', ended.analysis.status === 'failed' && line.includes(expected) && !line.includes('произошла ошибка') && !nextStep(ended.view).includes('правило')
      && nextStep(ended.view).includes('продолжите разбор'),
      `(5) ${what}: failure ${ended.analysis.failure} — «${line}»; next: «${nextStep(ended.view)}»`);
  }

  // (6) The way from the log to what was judged, in one line, and why the rest was not.
  const funnel = funnelLines(reviewed.view);
  claim('I', funnel[0] === `Из 6 разговоров лога Lab прочитал все, выбрал для разбора 6, правила оценены в ${reviewed.view.coverage.decided}.`
    && funnel.some(line => line.startsWith('Не оценены 3: 3 — работа Lab над их темой не закончилась')),
    `(6) «${funnel.join(' ')}»`);

  // (7) Buttons in the agent's replies, as the export wrote them: asked about, and read as interface elements only on the owner's yes.
  const dir = await folder('i-markup');
  const table = join(dir, 'логи.csv');
  await writeFile(table, ['Id диалога;Текст',
    '1;CLIENT Покажи реквизиты счёта AGENT Посмотрите реквизиты по кнопке ниже ` ` ` transition-code ACCOUNT_REQUISITES ` ` `',
    '2;CLIENT Как создать отчёт? AGENT Создайте отчёт в разделе «Эквайринг» ` ` ` transition-code ACQUIRING_AGENT-REPORT_CREATE ` ` `',
    '3;CLIENT Где выписка? AGENT Выписка в разделе «Счета».'].join('\n'));
  const asked = await proposeTableImport(table);
  const question = asked.status === 'question' && asked.question.kind === 'markup' ? asked.question : undefined;
  const yes = await proposeTableImport(table, { interfaceMarkup: true });
  const reply = (batch: Awaited<ReturnType<typeof readConfirmedTable>>) => batch.dialogues.find(dialogue => dialogue.id === '1')?.events.find(event => event.type === 'message' && event.role === 'assistant')?.content ?? '';
  const confirmed = yes.status === 'ready' ? await asWriter(join(dir, '.agent-lab'), lab => confirmTableImport(lab.store, table, yes)) : undefined;
  claim('I', !!question && question.messages === 2 && question.dialogues === 2 && !!confirmed && reply(confirmed.batch).includes(INTERFACE_ELEMENT) && !reply(confirmed.batch).includes('transition-code'),
    `(7) «${question ? questionText(question, question.of) : ''}» → yes: «${confirmed ? reply(confirmed.batch) : ''}»`);
  // A reading confirmed before the question is asked it before the table is read again; «text» keeps the words.
  const before = join(dir, 'до вопроса');
  const old = await proposeTableImport(table, { interfaceMarkup: false });
  if (old.status === 'ready') await asWriter(join(before, '.agent-lab'), lab => confirmTableImport(lab.store, table, { ...old, mapping: (({ interfaceMarkup: _markup, ...rest }) => rest)(old.mapping) }));
  const refused = await readConfirmedTable(table, join(before, '.agent-lab')).then(() => '', (error: Error) => error.message);
  claim('I', !await readingConfirmed(table, join(before, '.agent-lab')) && refused.includes('--interface-markup') && await readingConfirmed(table, join(dir, '.agent-lab')),
    `(7) a reading confirmed before the question is asked it again: «${refused}»`);

  // (8) The agent's prompt is Markdown; the planner quotes it without the marks, or with a slip of one letter.
  const prompt = '### СТРОГИЕ ЗАПРЕТЫ\n**Абсолютное табу** на:\n- Любые упоминания внутренних систем: ЕРМ, ППРБ, банковские статусы.\n- Удали из ответа любые упоминания: «ЦКР» (включая `#ЦКР`), «SberHelp».';
  const call: PlanCall = { topic: { title: 'Ответы клиенту' }, examples: [{ dialogueId: 'k1', customer: ['Что такое ЦКР?'] }],
    sources: [{ id: 'source-1', name: 'main_idp_generation_prompt', content: prompt, kind: 'prompt' }], binds: { kinds: ['behavior'], rules: [] } };
  const quoting = (quote: string) => ({ question: 'Клиент спрашивает о службах банка', variations: [{ title: 'Вопрос о службе', examples: ['k1'] }],
    expectations: [{ text: 'не называть внутренние системы', strength: 'must_not', acceptable: null, violation: null, basis: [{ sourceId: 'source-1', quote, kind: 'behavior' }], variations: null }] } as unknown as PlanProposal);
  const unmarked = planSlips(quoting('Абсолютное табу на:\n- Любые упоминания внутренних систем: ЕРМ, ППРБ, банковские статусы.'), call);
  const backticks = planSlips(quoting('Удали из ответа любые упоминания: «ЦКР» (включая #ЦКР), «SberHelp».'), call);
  const typo = planSlips(quoting('Удели из ответа любые упоминания: «ЦКР» (включая `#ЦКР`), «SberHelp».'), call);
  claim('I', !unmarked.length && !backticks.length && typo.length === 1 && typo[0]!.kind === 'quote' && typo[0]!.text.includes('«Удали из ответа любые упоминания: «ЦКР» (включая `#ЦКР`), «SberHelp».»'),
    `(8) a quote without the prompt's ** or backticks binds (${unmarked.length + backticks.length} slips); one with a slipped letter is refused with the source's own words: «${typo[0]?.text ?? ''}»`);
}
