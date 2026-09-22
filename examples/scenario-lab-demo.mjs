import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExperimentLab, draftHash } from '../dist/experiment.js';
import { createInputSchema, fingerprint } from '../dist/contracts.js';
import { createDemoRuntime } from '../dist/demo.js';
import { libraryHash } from '../dist/scenario-library.js';
import { buildResultView } from '../dist/result-view.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const policy = 'Если номер терминала уже указан, не запрашивайте его повторно; объясните возврат. Если номера нет, уточните номер терминала.';
export const dialogues = [
  { id: 'known', messages: [{ role: 'user', content: 'Номер терминала: 1234. Помогите с возвратом.' }, { role: 'assistant', content: 'Уточните номер терминала.' }] },
  { id: 'late', messages: [{ role: 'user', content: 'Помогите с возвратом.' }, { role: 'assistant', content: 'Уточните номер терминала.' }, { role: 'user', content: 'Номер терминала: 5678' }] },
];
const target = (fixed = false) => ({ kind: 'module', path: join(root, 'examples/scenario-lab-target.mjs'), exportName: fixed ? 'createFixedSession' : 'createSession', diagnosticCapabilities: { protocol: 'paired-intervention-v1', toolResponse: false, ragFragment: true } });
function proposal(batchId, dialogue) {
  const known = dialogue.id === 'known', number = known ? '1234' : '5678';
  return {
    business: { key: 'refund', title: 'Возврат оплаты', goal: 'Получить инструкцию по возврату оплаты', conditions: [], requirementIds: ['refund_rule'], grouping: { status: 'confirmed', reason: 'Одинаковая цель и правило; номер отличается по способу раскрытия' } },
    variant: { id: known ? 'known_number' : 'late_number', title: known ? 'Номер уже в первой реплике' : 'Номер раскрывается по просьбе', purpose: 'Проверить уместность запроса номера и получение инструкции по возврату', provenance: 'production', sourceDialogues: [{ batchId, dialogueId: dialogue.id }],
      ...(known ? {} : { sourceCoverage: [{ batchId, dialogueId: dialogue.id, eventIndex: 2, disposition: 'initial_fact', actionIds: [], factIds: ['terminal'], reason: 'Личный номер раскрыт по просьбе; его исходная доступность в этом учебном примере требует подтверждения владельца.' }] }),
      userState: { goal: 'Получить инструкцию по возврату', opening: dialogue.messages[0].content, facts: [{ id: 'terminal', statement: `Номер терминала: ${number}`, value: number, availability: known ? 'initial' : 'uncertain', reason: known ? 'Личные данные в первой реплике' : 'Учебный спорный факт: подтвердите, что личный номер был известен до разговора', origin: { kind: 'dialogue', batchId, dialogueId: dialogue.id, eventIndex: known ? 0 : 2, quote: `Номер терминала: ${number}` } }], cannotKnow: [], missing: [] },
      behaviorPolicy: { version: 1, initialState: 'waiting', states: known ? ['waiting', 'done'] : ['waiting', 'disclosed', 'done'], terminalStates: ['done'], maxFollowUps: 1, repetitionLimit: 1,
        actions: [...(known ? [] : [{ id: 'disclose', kind: 'answer', factIds: ['terminal'], ifAsked: 'Агент просит номер терминала' }]), { id: 'finish', kind: 'finish', factIds: [] }],
        transitions: known
          ? [{ from: 'waiting', to: 'done', actionId: 'finish', when: 'После первого ответа: если есть инструкция, цель достигнута; если агент повторно просит уже указанный номер или не помогает, пользователь прекращает попытку без достижения цели' }]
          : [{ from: 'waiting', to: 'disclosed', actionId: 'disclose', when: 'Агент просит номер терминала, ещё не сообщённый в этом разговоре' },
            { from: 'waiting', to: 'done', actionId: 'finish', when: 'Агент не просит номер: дал инструкцию либо ответил иначе; пользователь завершает попытку' },
            { from: 'disclosed', to: 'done', actionId: 'finish', when: 'После ответа на сообщённый номер: есть инструкция либо пользователь прекращает неудачную попытку; повторять номер не будет' }] },
      environmentFixture: { mode: 'prompt', initialState: { records: {}, writableFields: [] } },
      evaluationSpec: { goalObservation: 'reply', successCriteria: 'Номер запрошен только до его раскрытия; после получения номера агент объяснил, как оформить возврат', checkpoints: [
        { id: 'ask_once', requirementId: 'refund_rule', quote: policy, applicability: 'Вариант обращения за возвратом с номером в первой реплике или раскрываемым по просьбе', observation: 'reply', role: 'required', rule: 'Если номер уже сообщён, не запрашивать его повторно независимо от формулировки вопроса. Если в первой реплике номера нет, запросить его до инструкции.' },
        { id: 'refund_explanation', requirementId: 'refund_rule', quote: policy, applicability: 'Пользователь обратился за возвратом и сообщил номер терминала', observation: 'reply', role: 'required', rule: 'Объяснить пользователю, как оформить возврат. Один запрос номера, подтверждение получения номера или обещание помочь без инструкции не выполняют требование.' },
      ] },
    },
  };
}
const asksNumber = text => /(?:уточните|сообщите|назовите|укажите|какой|номер.*\?).*номер|номер.*терминал.*\?/i.test(text);
/** Explicit deterministic teaching adapter. It is never evidence of model quality. */
export function demoScenarioRuntime() {
  return { ...createDemoRuntime(),
    async prepare(input) { return { requirements: [{ id: 'refund_rule', sourceId: input.sources[0].id, text: policy, quote: policy, critical: true }], questions: [], agent: { name: 'Учебный агент возвратов', instructions: policy, tools: [] }, scenarios: [] }; },
    async scenarioProposals(input) { return input.dialogues.map(d => proposal(input.batchId, dialogues.find(source => source.id === d.id))); },
    async assessScenarioProposals(input) { return input.fields.flatMap(f => f.paths.map(path => {
      const variant = input.library.variants.find(v => v.id === f.variantId);
      const uncertain = path.startsWith('userState') && variant.userState.facts.some(fact => fact.availability === 'uncertain');
      const noDisclosure = path === 'behaviorPolicy' && variant.id === 'late_number' && !variant.behaviorPolicy.actions.some(a => a.kind === 'answer' && a.factIds.includes('terminal'));
      const noExplanation = path.startsWith('evaluationSpec') && !variant.evaluationSpec.checkpoints.some(c => c.id === 'refund_explanation');
      return { variantId: f.variantId, path, status: uncertain || noDisclosure || noExplanation ? 'needs_review' : 'ready',
        reason: uncertain ? 'Нужно явное уточнение исходного знания личного номера' : noDisclosure ? 'Нет действия раскрытия номера по просьбе' : noExplanation ? 'Нет проверки инструкции по возврату' : 'Проверка заранее заданного учебного примера; не модельная оценка' };
    })); },
    async selectUserAction(input) {
      const reply = input.messages.filter(m => m.role === 'assistant').at(-1)?.content ?? '';
      const disclose = input.actions.find(a => a.id === 'disclose');
      return disclose && asksNumber(reply) ? { actionId: disclose.id, factIds: disclose.factIds } : { actionId: 'finish', factIds: [] };
    },
    async assessCheckpoints(input) { return input.checkpoints.map(c => {
      let hasNumber = false, repeated = false, asked = false;
      for (const event of c.dialogue) {
        if (event.type === 'user' && /терминала:\s*\d+/i.test(event.text ?? '')) hasNumber = true;
        if (event.type === 'assistant' && asksNumber(event.text ?? '')) { repeated ||= hasNumber; asked = true; }
      }
      const openingHasNumber = /терминала:\s*\d+/i.test(c.dialogue.find(e => e.type === 'user')?.text ?? '');
      const explained = c.evidence.some(e => /Подайте заявление в поддержку/i.test(e.text ?? ''));
      const pass = c.checkpoint.id === 'ask_once' ? !repeated && (openingHasNumber || asked) : c.checkpoint.id === 'refund_explanation' ? hasNumber && explained : undefined;
      return { checkpointId: c.checkpoint.id, result: pass === undefined ? 'unknown' : pass ? 'pass' : 'fail', evidence: c.allowedEvidence,
        rationale: c.checkpoint.id === 'ask_once' ? `Учебная проверка: номер запрошен=${asked}, повтор после раскрытия=${repeated}` : 'Учебная проверка наличия конкретной инструкции; не оценка произвольных модельных формулировок' };
    }); },
    async assess({ scenario, trial }) { return (scenario.metrics ?? []).map(metric => ({ metricId: metric.id, result: trial.checkpoints?.filter(c => c.role === 'required').every(c => c.result === 'pass') ? 'pass' : 'fail', evidence: trial.events.filter(e => e.type === 'assistant').map(e => e.seq), rationale: 'Детерминированная учебная оценка по обязательным контрольным точкам' })); },
  };
}
export async function seedScenarioLab(directory, options = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await readdir(directory)).includes('.agent-lab')) throw new Error('Выберите новую папку: существующая .agent-lab не изменяется.');
  const lab = new ExperimentLab(join(directory, '.agent-lab'), demoScenarioRuntime());
  try {
    await lab.init();
    const seed = await lab.create(createInputSchema.parse({ task: 'Учебная проверка возвратов: два вымышленных диалога', mode: options.live ? 'live' : 'demo', target: target(), materials: [{ name: 'Учебное правило владельца', content: policy }], dialogues,
      scenarioCount: 0, settings: { repeats: 2, maxCalls: 60, maxTurns: 3, maxDurationMs: 300000, timeoutMs: 60000, userModes: ['reactive'], ...(options.provider ? { provider: options.provider } : {}), ...(options.model ? { model: options.model } : {}) } }));
    await lab.waitForIdle(); const draft = await lab.get(seed.id); assert.equal(draft.phase, 'review', draft.error ?? '');
    return { directory, runId: draft.id, evidenceKind: 'developer-authored-synthetic-fixture', next: `В Pi: /agent-lab ${draft.id}`, ready: draft.librarySnapshot.variants.filter(v => v.quality === 'ready').length, needsReview: draft.librarySnapshot.variants.filter(v => v.quality === 'needs_review').length, blocked: draft.librarySnapshot.variants.filter(v => v.quality === 'blocked').length };
  } finally { await lab.close(); }
}
export async function verifyScenarioLab(directory) {
  const seeded = await seedScenarioLab(directory), lab = new ExperimentLab(join(directory, '.agent-lab'), demoScenarioRuntime());
  try {
    await lab.init(); const draft = await lab.readLibrary(seeded.runId);
    const adapterBytes = await readFile(target().path, 'utf8');
    const imported = await readFile(join(lab.store.directory, 'imports', `${draft.experiment.originalImport.id}.json`), 'utf8');
    const changed = await lab.editLibrary(seeded.runId, libraryHash(draft.library), { kind: 'edit_fact', variantId: 'late_number', factId: 'terminal', statement: 'Номер терминала: 5678', value: '5678', availability: 'initial', editId: 'demo_owner_confirmed', reason: 'Учебная явная правка: личный номер был известен до разговора' });
    await lab.assessLibrary(seeded.runId, libraryHash(changed.library)); await lab.waitForIdle();
    const reviewed = await lab.readLibrary(seeded.runId), accepted = await lab.acceptLibrary(seeded.runId, libraryHash(reviewed.library), ['known_number', 'late_number']);
    const acceptedHash = libraryHash(accepted.library);
    await lab.start(seeded.runId, { approved: true, expectedHash: draftHash(accepted.experiment) }); await lab.waitForIdle();
    const source = await lab.get(seeded.runId), sourceBytes = await readFile(join(lab.store.directory, `${source.id}.json`), 'utf8');
    // The same accepted set against a fixed version of the agent: a new draft; the finished run stays byte-identical.
    const repeat = await lab.repeat(source.id);
    const fixedDraft = await lab.updateDraft(repeat.id, draftHash(repeat), { target: target(true), targetVersion: 'demo-fixed-v1' });
    await lab.start(fixedDraft.id, { approved: true, expectedHash: draftHash(fixedDraft) }); await lab.waitForIdle();
    const fixed = await lab.get(fixedDraft.id);
    assert.equal(fixed.phase, 'results_review', fixed.error ?? '');
    assert.equal(await readFile(join(lab.store.directory, `${source.id}.json`), 'utf8'), sourceBytes);
    assert.equal(await readFile(join(lab.store.directory, 'imports', `${source.originalImport.id}.json`), 'utf8'), imported);
    assert.equal(libraryHash(await lab.store.readLibrary(accepted.library.id, acceptedHash)), acceptedHash);
    assert.equal(await readFile(target().path, 'utf8'), adapterBytes);
    const passed = record => { const { headline } = buildResultView(record); return { passed: headline.passed, decided: headline.decided }; };
    return { evidenceKind: 'deterministic-integration', directory, runId: source.id, repeatRunId: fixed.id,
      library: { dialogues: draft.library.imports[0].dialogues.length, groups: draft.library.businessScenarios.length, variants: draft.library.variants.length },
      ownerReceipt: changed.library.variants[1].history.some(h => h.factEdit?.editId === 'demo_owner_confirmed'), sourceUnchanged: true,
      baseline: passed(source), fixed: passed(fixed), persistedLinksResolve: true };
  } finally { await lab.close(); }
}
if (process.argv[1] && await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url))) {
  const verify = process.argv.includes('--verify');
  const directory = await mkdtemp(join(tmpdir(), verify ? 'scenario-lab-proof-' : 'scenario-lab-demo-'));
  const report = verify ? await verifyScenarioLab(directory) : await seedScenarioLab(directory, { live: true, provider: process.env.AGENT_LAB_PROVIDER, model: process.env.AGENT_LAB_MODEL });
  await writeFile(join(directory, 'demo-report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  if (!verify) {
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    console.log(`cd ${quote(directory)}\n${quote(join(root, 'node_modules/.bin/pi'))} --no-extensions -e ${quote(join(root, 'extensions/agent-lab.ts'))} --no-skills --skill ${quote(join(root, 'skills/agent-builder/SKILL.md'))} --no-context-files --no-session`);
    console.log('Это вымышленный учебный черновик. Подготовка не вызывала модель; g и запуск в Pi используют настроенную модель и сохранённый бюджет.');
  }
}
