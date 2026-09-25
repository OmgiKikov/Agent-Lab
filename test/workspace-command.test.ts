import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { REVIEW_DONE } from '../extensions/judge-review.ts';
import { judgeAgreement } from '../src/agreement.js';
import type { LibraryV2 } from '../src/card/schema.js';
import type { Experiment } from '../src/contracts.js';
import { goalAttainment, promptCompliance } from '../src/assessment.js';
import { createDemoRuntime, demoInput } from '../src/demo.js';
import { ExperimentLab } from '../src/experiment.js';
import { resultHash } from '../src/lab/record.js';
import { COUNTING_RULES } from '../src/outcomes.js';
import { hostGrant } from '../src/card/commands.js';
import { situationViews } from '../src/card/view.js';
import { ExperimentStore } from '../src/store.js';
import { assertPlainCopy } from './helpers/copy-check.js';
import { boardFixture, CLOSE, escaped, judgedSituations, KEY, legacyDraftIn, noticeOf, output, registered, workspaceSession } from './helpers/pi-session.js';

/*
 * `/agent-lab` as the owner drives it: the workspace opens on what needs them, a run started there outlives it, the
 * owner's answers about the judge are written only from their keys and dialogs, and the old records run through the
 * same one dialog. Every write goes through the same ExperimentLab operations the chat uses.
 */

test('history remains readable while another instance owns the data directory', async () => {
  const fixture = await boardFixture('agent-lab-read-only-history-');
  const owner = new ExperimentStore(join(fixture.cwd, '.agent-lab'));
  await owner.init();
  const running = { ...fixture.record, phase: 'evaluating' as const };
  await owner.save(running);
  const before = await readFile(join(owner.directory, `${running.id}.json`), 'utf8');
  const lock = await readFile(join(owner.directory, '.lock'), 'utf8');
  const { command, shutdown, tools } = registered();
  const session = workspaceSession(fixture.cwd);
  try {
    session.state.steps = [CLOSE];
    await command(running.id.slice(0, 8), session.ctx);
    const read = output(await tools.get('agent_lab_cards')!.execute('read', { run: running.id }, undefined, undefined, { cwd: fixture.cwd, hasUI: false, mode: 'print' } as ExtensionContext));
    assert.equal(read.run, running.id, 'the chat reads the run another instance is writing');
    // The run opens on its own screen, the work going on above what it has recorded so far.
    assert.match(session.screens[0]!, /Прогон: \d+ из \d+ разговор/);
    assert.equal(session.selectCalls.length, 0, 'leaving a reader asks nothing');
    assert.equal(await readFile(join(owner.directory, `${running.id}.json`), 'utf8'), before);
    assert.equal(await readFile(join(owner.directory, '.lock'), 'utf8'), lock, 'reader never releases another instance lock');
  } finally { await shutdown(); await owner.close(); await rm(fixture.cwd, { recursive: true, force: true }); }
});

test('a run started in the workspace outlives it and releases ownership after completion', { timeout: 20000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-lab-board-background-'));
  const script = join(cwd, 'target.cjs');
  await writeFile(script, `process.stdin.once('data', () => setTimeout(() => process.stdout.write(JSON.stringify({reply:'Проверка завершена.', resetConfirmed:true})+'\\n'), 500));`);
  const draft = await legacyDraftIn(cwd, { count: 1, target: { kind: 'command', command: process.execPath, args: [script], timeoutMs: 5000 },
    settings: { userModes: ['static'], maxTurns: 2 } });
  const { command, shutdown } = registered();
  const session = workspaceSession(cwd);
  const store = new ExperimentStore(join(cwd, '.agent-lab'));
  try {
    // Before the first result the workspace walks the steps: → the plan, Enter runs it through the one dialog.
    session.state.steps = [[KEY.right, KEY.enter], CLOSE];
    await command(draft.id, session.ctx);
    assert.equal((await store.get(draft.id)).phase, 'evaluating', 'closing the workspace must not cancel the run');
    assert.equal(session.selectCalls.length, 1, 'only the launch asks the owner');
    assert.match(session.selectCalls[0]!.title, /^Подтвердить ожидания и запустить\?\n/);
    assert.match(session.screens[1]!, /Прогон идёт/);
    assert.ok(noticeOf(session.screens[1]!).startsWith('Прогон идёт: результат появится здесь и в чате.'), session.screens[1]);
    session.state.steps = [CLOSE];
    await command('', session.ctx);
    assert.match(session.screens.at(-1)!, /Прогон: 0 из 1 разговора/, 'the run is visible while this session works on it');
    const deadline = Date.now() + 10000;
    while ((await store.get(draft.id)).phase === 'evaluating' || existsSync(join(store.directory, '.lock'))) {
      assert.ok(Date.now() < deadline, 'background run did not finish and release its lock');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal((await store.get(draft.id)).phase, 'results_review');
    assert.equal((await store.get(draft.id)).trials.length, 1);
  } finally { await shutdown(); await rm(cwd, { recursive: true, force: true }); }
});

test('в разговоре судьи 1–3 сохраняют согласие, несогласие с причиной и сомнение', { timeout: 120000 }, async () => {
  const fixture = await boardFixture('agent-lab-board-agree-');
  const { shutdown, command } = registered();
  const session = workspaceSession(fixture.cwd);
  const inspect = async () => new ExperimentStore(join(fixture.cwd, '.agent-lab')).get(fixture.record.id);
  const titleOf = (trialId: string) => fixture.record.scenarios.find(card => card.id === fixture.record.trials.find(trial => trial.id === trialId)!.scenarioId)!.title;
  try {
    // The run opens on its result; Enter opens the first cause's conversation; «2» — «нет, судья ошибся» — always asks why.
    session.state.reason = 'Проверка: судья не учёл уточнение клиента.';
    session.state.steps = [[KEY.enter, '2'], CLOSE];
    await command(fixture.record.id, session.ctx);
    assert.match(session.frames[1]!, /Судья решил: не справился\. Вы согласны\? +1 да · 2 нет · 3 не знаю/);
    assert.match(session.frames[1]!, /1–3 ответить · a спросить Lab · ↑↓ листать · Esc назад/);
    const disagreed = await inspect();
    assert.equal(disagreed.humanReviews.length, 1, JSON.stringify(disagreed.humanReviews));
    const mark = disagreed.humanReviews[0]!;
    assert.equal(mark.source, 'quick');
    assert.equal(mark.note, 'Проверка: судья не учёл уточнение клиента.');
    assert.equal(mark.judgeVerdict, 'fail');
    assert.equal(mark.verdict, 'pass', 'несогласие пишет противоположный вердикт');
    assert.equal(session.editorCalls.at(-1)!.title, 'Судья решил: не справился. Почему вы не согласны? Коротко, своими словами.');
    assert.equal(session.editorCalls.at(-1)!.initial, '');
    // A legacy card has one judgment to answer, so no «с чем именно» question; its other failed checks keep it failed, and the notice says so.
    assert.equal(session.selectCalls.length, 0, 'one failed metric is answered without a question');
    assert.match(noticeOf(session.screens.at(-1)!), new RegExp(`^Отмечено: не согласен · «${escaped(titleOf(mark.trialId))}»\\. Ситуация остаётся «не справился»: .+\\.$`));
    // The conversation stays open with the owner's answer on it.
    assert.match(session.screens.at(-1)!, /Ваш ответ: нет, судья ошибся\. Изменить: 1 да · 2 нет · 3 не знаю/);

    // «3» — «не знаю»: a doubt; the judge's verdict stays and the situation waits.
    session.state.steps = [[KEY.enter, '3'], CLOSE];
    await command(fixture.record.id, session.ctx);
    const unsure = await inspect();
    assert.equal(unsure.humanReviews.length, 2);
    const doubt = unsure.humanReviews.at(-1)!;
    assert.equal(doubt.source, 'quick'); assert.equal(doubt.verdict, 'unknown');
    assert.equal(doubt.note, 'Быстрая отметка: не могу сказать.');
    assert.equal(noticeOf(session.screens.at(-1)!), `Отмечено: не знаю · «${titleOf(doubt.trialId)}».`);

    // A closed editor writes nothing and says nothing.
    session.state.reason = undefined;
    session.state.steps = [[KEY.enter, '2'], CLOSE];
    await command(fixture.record.id, session.ctx);
    assert.equal((await inspect()).humanReviews.length, 2);
    assert.equal(noticeOf(session.screens.at(-1)!), '');

    // An empty reason is no disagreement, and the workspace says what is missing.
    session.state.reason = '   \n  ';
    session.state.steps = [[KEY.enter, '2'], CLOSE];
    await command(fixture.record.id, session.ctx);
    assert.equal((await inspect()).humanReviews.length, 2);
    assert.equal(noticeOf(session.screens.at(-1)!), 'Несогласие не сохранено: напишите причину.');
  } finally {
    await shutdown();
    await fixture.cleanup();
  }
});

/** The action the workspace emits for an answer about one conversation, with the judge's decision the owner was shown. */
const markAction = (record: Experiment, trialId: string, answer: string, over: Record<string, unknown> = {}) => ({ action: { type: 'mark', runId: record.id, trialId, answer,
  readingMs: 0, seen: judgedSituations(record).find(item => item.trial.id === trialId)!.judgeVerdict, ...over } });

test('повтор ответа, длинная причина и сменившаяся оценка судьи ничего не пишут и названы словами', { timeout: 120000 }, async () => {
  const fixture = await boardFixture('agent-lab-board-edges-');
  const { shutdown, command } = registered();
  const session = workspaceSession(fixture.cwd);
  const notices: string[] = [];
  const inspect = async () => new ExperimentStore(join(fixture.cwd, '.agent-lab')).get(fixture.record.id);
  const target = judgedSituations(fixture.record).find(item => item.judgeVerdict === 'fail');
  assert.ok(target, 'у демо-прогона есть провал, с которым можно не согласиться');
  /** One opening that answers the same conversation, so an answer can be given twice. */
  const answer = async (answer: string, over: Record<string, unknown> = {}) => {
    session.state.steps = [markAction(fixture.record, target.trial.id, answer, over), CLOSE];
    await command(fixture.record.id, session.ctx);
    const notice = noticeOf(session.screens.at(-1)!);
    if (notice) notices.push(notice);
    return { notice, reviews: (await inspect()).humanReviews as { verdict: string; note: string; durationMs?: number }[] };
  };
  try {
    // The time the conversation was read reaches the stored answer.
    const agreed = await answer('agree', { readingMs: 900 });
    assert.equal(agreed.reviews.length, 1);
    assert.ok(agreed.reviews[0]!.durationMs! >= 900, JSON.stringify(agreed.reviews[0]));
    assert.equal(agreed.notice, `Отмечено: согласен с судьёй · «${target.scenario.title}».`);

    // The same answer again writes nothing.
    const again = await answer('agree');
    assert.equal(again.notice, 'Отметка уже стоит: согласен с судьёй.');
    assert.equal(again.reviews.length, 1);

    const doubt = await answer('unsure');
    assert.equal(doubt.reviews.length, 2);
    const doubtAgain = await answer('unsure');
    assert.equal(doubtAgain.notice, 'Отметка уже стоит: не знаю.');
    assert.equal(doubtAgain.reviews.length, 2);

    // «Нет» always opens the editor — the reason already written is edited there.
    session.state.reason = 'Клиент назвал время сам, судья это пропустил.';
    const disagreed = await answer('disagree');
    assert.equal(disagreed.reviews.length, 3);
    assert.equal(disagreed.reviews.at(-1)!.note, 'Клиент назвал время сам, судья это пропустил.');
    assert.match(disagreed.notice, new RegExp(`^Отмечено: не согласен · «${escaped(target.scenario.title)}»\\. Ситуация остаётся «не справился»: .+\\.$`));

    session.state.reason = '  Клиент назвал время сам, судья это пропустил.  ';
    const same = await answer('disagree');
    assert.equal(session.editorCalls.at(-1)!.initial, 'Клиент назвал время сам, судья это пропустил.');
    assert.equal(same.notice, 'Отметка уже стоит: не согласен.');
    assert.equal(same.reviews.length, 3);

    session.state.reason = 'я'.repeat(3001);
    const long = await answer('disagree');
    assert.equal(long.notice, 'Причина длиннее 3000 знаков — сократите и ответьте снова.');
    assert.equal(long.reviews.length, 3);

    session.state.reason = 'Другая причина: судья не прочитал запись до конца.';
    const rewritten = await answer('disagree');
    assert.equal(rewritten.reviews.length, 4);
    assert.equal(rewritten.reviews.at(-1)!.note, 'Другая причина: судья не прочитал запись до конца.');

    // The last answer wins: the situation keeps one current mark.
    const back = await answer('agree');
    assert.equal(back.reviews.length, 5);
    const stored = await new ExperimentStore(join(fixture.cwd, '.agent-lab')).get(fixture.record.id);
    const current = judgeAgreement(stored).marks.filter(mark => mark.trialId === target.trial.id && !mark.stale);
    assert.equal(current.length, 1);
    assert.equal(current[0]!.answer, 'agree');

    // The workspace showed another decision of the judge: the lab refuses, and the refusal is named.
    // The answer is a new one here: «отметка уже стоит» comes first and would otherwise answer instead.
    const moved = await answer('unsure', { seen: target.judgeVerdict === 'fail' ? 'pass' : 'fail' });
    assert.equal(moved.notice, 'Оценка судьи изменилась, пока вы смотрели. Проверьте ситуацию ещё раз.');
    assert.equal(moved.reviews.length, 5);

    for (const notice of notices) assertPlainCopy(notice.replace(/«[^»]*»/gu, ''), 'уведомление');
  } finally {
    await shutdown();
    await fixture.cleanup();
  }
});

/**
 * Every demo card becomes a goal card with prompt rules (CTX-01): the agent metrics are the goal and
 * the rules, the card's simulator metrics stay, and the judge is recorded as failing both on every
 * trial, citing an agent reply — a double failure on every situation.
 */
function goalAndRules(record: Experiment) {
  for (const card of record.scenarios) {
    card.metrics = [structuredClone(goalAttainment), structuredClone(promptCompliance), ...(card.metrics ?? []).filter(m => m.subject === 'simulator')];
  }
  for (const trial of record.trials) {
    const said = trial.events.find(event => event.type === 'assistant')!;
    trial.assessments = [
      { metricId: 'goal_attainment', result: 'fail', rationale: 'Агент не перенёс запись и отправил клиента в поддержку.', evidence: [said.seq], citations: [{ seq: said.seq, quote: said.text ?? '' }] },
      { metricId: 'prompt_compliance', result: 'fail', rationale: 'Агент направил клиента в поддержку.', evidence: [said.seq], citations: [{ seq: said.seq, quote: said.text ?? '' }] },
      ...(trial.assessments ?? []).filter(a => card(record, trial)?.metrics?.some(m => m.id === a.metricId && m.subject === 'simulator')),
    ];
  }
}
const card = (record: Experiment, trial: Experiment['trials'][number]) => record.scenarios.find(item => item.id === trial.scenarioId);
const GOAL_AND_RULES_OPTIONS = ['Запрос выполнен — судья ошибся', 'Правила промпта соблюдены — судья ошибся', 'С обоими: запрос выполнен и правила соблюдены'];

test('на двойном провале «нет» спрашивает, с чем именно, и пишет ответ на каждую оценку', { timeout: 180000 }, async () => {
  const fixture = await boardFixture('agent-lab-board-both-', goalAndRules);
  // Attempts of another plan decide nothing, not even a fail (run.ts attemptsBelong): the verdict stays «не измерено» whatever the owner says.
  const unchanged = await boardFixture('agent-lab-board-both-still-', record => { goalAndRules(record); for (const trial of record.trials) trial.manifestHash = 'other'; });
  const { shutdown, command } = registered();
  const session = workspaceSession(fixture.cwd);
  const notices: string[] = [];
  type Review = { trialId: string; metricId: string; verdict: string; note: string; countingRules?: string; durationMs?: number };
  const inspect = async (of = fixture) => (await new ExperimentStore(join(of.cwd, '.agent-lab')).get(of.record.id)).humanReviews as Review[];
  const titleOf = (trialId: string) => fixture.record.scenarios.find(item => item.id === fixture.record.trials.find(trial => trial.id === trialId)!.scenarioId)!.title;
  const situations = judgedSituations(fixture.record);
  assert.equal(situations.length, 2);
  for (const item of situations) assert.deepEqual([item.judgeVerdict, item.metricIds], ['fail', ['goal_attainment', 'prompt_compliance']]);
  const store = new ExperimentStore(join(fixture.cwd, '.agent-lab'));
  try {
    // «Нет» on a double failure asks which half; the rules alone → a disagreement on the rules and an agreement on the goal, both stamped by the lab.
    session.state.choice = GOAL_AND_RULES_OPTIONS[1];
    session.state.reason = 'Проверка: агент не отправлял клиента в поддержку.';
    session.state.steps = [[KEY.enter, '2'], CLOSE];
    await command(fixture.record.id, session.ctx);
    assert.deepEqual(session.selectCalls, [{ title: 'С чем вы не согласны?', options: GOAL_AND_RULES_OPTIONS }]);
    assertPlainCopy('С чем вы не согласны?', 'вопрос');
    for (const option of GOAL_AND_RULES_OPTIONS) assertPlainCopy(option, 'вариант');
    assert.equal(session.editorCalls.at(-1)!.title, 'Судья решил: не справился. Почему вы не согласны? Коротко, своими словами.');
    const first = await inspect();
    assert.equal(first.length, 2, JSON.stringify(first));
    const [goalMark, rulesMark] = first;
    assert.equal(goalMark!.trialId, rulesMark!.trialId);
    assert.deepEqual([goalMark!.metricId, goalMark!.verdict, goalMark!.note], ['goal_attainment', 'fail', 'Быстрая отметка: согласен с судьёй.']);
    assert.deepEqual([rulesMark!.metricId, rulesMark!.verdict, rulesMark!.note], ['prompt_compliance', 'pass', 'Проверка: агент не отправлял клиента в поддержку.']);
    assert.deepEqual(first.map(mark => mark.countingRules), [COUNTING_RULES, COUNTING_RULES]);
    assert.equal(typeof goalMark!.durationMs, 'number');
    const firstTrial = goalMark!.trialId;
    const otherTrial = situations.find(item => item.trial.id !== firstTrial)!.trial.id;
    notices.push(noticeOf(session.screens.at(-1)!));
    assert.equal(notices.at(-1), `Отмечено: не согласен · «${titleOf(firstTrial)}». Ситуация остаётся «не справился»: запрос не выполнен.`);
    const checked = judgeAgreement(await store.get(fixture.record.id));
    assert.equal(checked.checked, 1);
    assert.deepEqual(checked.disagreements.map(item => [item.trialId, item.overturned]), [[firstTrial, ['prompt_compliance']]]);

    // Esc in the question: nothing is written, the editor never opens, the workspace says nothing.
    const editors = session.editorCalls.length;
    session.state.choice = () => undefined;
    session.state.steps = [[KEY.enter, '2'], CLOSE];
    await command(fixture.record.id, session.ctx);
    assert.equal((await inspect()).length, 2);
    assert.equal(session.editorCalls.length, editors, 'a cancelled question opens no editor');
    assert.equal(noticeOf(session.screens.at(-1)!), '');

    // «С обоими» on the other double failure: two overturned halves, and the situation's verdict moved.
    session.state.choice = GOAL_AND_RULES_OPTIONS[2];
    session.state.reason = 'Клиент получил перенос, правила соблюдены.';
    session.state.steps = [markAction(fixture.record, otherTrial, 'disagree'), CLOSE];
    await command(fixture.record.id, session.ctx);
    const both = (await inspect()).slice(2);
    assert.deepEqual(both.map(mark => [mark.trialId, mark.metricId, mark.verdict, mark.note, mark.countingRules]),
      [[otherTrial, 'goal_attainment', 'pass', 'Клиент получил перенос, правила соблюдены.', COUNTING_RULES], [otherTrial, 'prompt_compliance', 'pass', 'Клиент получил перенос, правила соблюдены.', COUNTING_RULES]]);
    notices.push(noticeOf(session.screens.at(-1)!));
    // Both conversations of the queue are answered now, so the check of the judge ends by itself.
    assert.equal(notices.at(-1), `Отмечено: не согласен · «${titleOf(otherTrial)}». Итог пересчитан с учётом вашего ответа. ${REVIEW_DONE}`);
    assert.equal((await store.get(fixture.record.id)).phase, 'complete');

    // «Да» writes the same answer on both judgments without a question; the new answer opens the review, which ends again at once.
    session.state.steps = [markAction(fixture.record, firstTrial, 'agree'), CLOSE];
    await command(fixture.record.id, session.ctx);
    const agreed = (await inspect()).slice(4);
    assert.deepEqual(agreed.map(mark => [mark.trialId, mark.metricId, mark.verdict, mark.note]),
      [[firstTrial, 'goal_attainment', 'fail', 'Быстрая отметка: согласен с судьёй.'], [firstTrial, 'prompt_compliance', 'fail', 'Быстрая отметка: согласен с судьёй.']]);
    assert.equal(session.selectCalls.length, 3, '«да» asks nothing');
    notices.push(noticeOf(session.screens.at(-1)!));
    assert.equal(notices.at(-1), `Отмечено: согласен с судьёй · «${titleOf(firstTrial)}». ${REVIEW_DONE}`);
    assert.equal((await store.get(fixture.record.id)).phase, 'complete');

    // The same answer again writes nothing.
    session.state.steps = [markAction(fixture.record, firstTrial, 'agree'), CLOSE];
    await command(fixture.record.id, session.ctx);
    assert.equal((await inspect()).length, 6);
    notices.push(noticeOf(session.screens.at(-1)!));
    assert.equal(notices.at(-1), 'Отметка уже стоит: согласен с судьёй.');

    // «Не знаю» — a doubt on both judgments: the judge's verdict stays, and the finished review opens again.
    session.state.steps = [markAction(fixture.record, firstTrial, 'unsure'), CLOSE];
    await command(fixture.record.id, session.ctx);
    const unsure = (await inspect()).slice(6);
    assert.deepEqual(unsure.map(mark => [mark.metricId, mark.verdict, mark.note]),
      [['goal_attainment', 'unknown', 'Быстрая отметка: не могу сказать.'], ['prompt_compliance', 'unknown', 'Быстрая отметка: не могу сказать.']]);
    notices.push(noticeOf(session.screens.at(-1)!));
    assert.equal(notices.at(-1), `Отмечено: не знаю · «${titleOf(firstTrial)}».`);
    assert.equal(session.selectCalls.length, 3, '«не знаю» asks nothing');
    assert.equal((await store.get(fixture.record.id)).phase, 'results_review');

    // A situation whose verdict cannot move (its attempt is of another plan) hears that the number did not change.
    // A missing planned attempt no longer does it: a usable fail of the card's own plan decides the card (OD-2).
    const still = workspaceSession(unchanged.cwd);
    still.state.choice = GOAL_AND_RULES_OPTIONS[2];
    still.state.reason = 'Клиент получил перенос.';
    still.state.steps = [[KEY.enter, '2'], CLOSE];
    await command(unchanged.record.id, still.ctx);
    const stillMarks = await inspect(unchanged);
    assert.equal(stillMarks.length, 2);
    notices.push(noticeOf(still.screens.at(-1)!));
    assert.equal(notices.at(-1), `Отмечено: не согласен · «${unchanged.record.scenarios.find(item => item.id === unchanged.record.trials.find(trial => trial.id === stillMarks[0]!.trialId)!.scenarioId)!.title}». Итог не изменился.`);

    for (const notice of notices) assertPlainCopy(notice.replace(/«[^»]*»/gu, ''), 'уведомление');
  } finally {
    await store.close();
    await shutdown();
    await fixture.cleanup();
    await unchanged.cleanup();
  }
});

test('проверка судьи завершается сама, когда даны все ответы; «не знаю» держит её открытой, новый ответ открывает снова', { timeout: 120000 }, async () => {
  const fixture = await boardFixture('agent-lab-board-finalize-');
  const { shutdown, command } = registered();
  const session = workspaceSession(fixture.cwd);
  const queue = judgeAgreement(fixture.record).unmarked;
  assert.ok(queue.length > 1, 'the demo run waits for several answers');
  const phase = async () => (await new ExperimentStore(join(fixture.cwd, '.agent-lab')).get(fixture.record.id)).phase;
  try {
    // A doubt on the first, agreement on the rest: the review stays open.
    session.state.steps = [markAction(fixture.record, queue[0]!, 'unsure'), ...queue.slice(1).map(id => markAction(fixture.record, id, 'agree')), CLOSE];
    await command(fixture.record.id, session.ctx);
    assert.equal(await phase(), 'results_review');
    assert.ok(!noticeOf(session.screens.at(-1)!).includes(REVIEW_DONE));

    // The doubt answered: every answer is given — the review ends by itself, bound to the results as they are.
    session.state.steps = [markAction(fixture.record, queue[0]!, 'agree'), CLOSE];
    await command(fixture.record.id, session.ctx);
    assert.ok(noticeOf(session.screens.at(-1)!).endsWith(REVIEW_DONE), session.screens.at(-1));
    const stored = await new ExperimentStore(join(fixture.cwd, '.agent-lab')).get(fixture.record.id);
    assert.equal(stored.phase, 'complete');
    assert.equal(stored.resultsReviewHash, resultHash(stored));

    // A new answer on a finished review opens it again; once every answer stands again, it ends again.
    session.state.reason = 'Клиент сам назвал время.';
    session.state.steps = [markAction(fixture.record, queue[1]!, 'disagree'), CLOSE];
    await command(fixture.record.id, session.ctx);
    assert.equal(await phase(), 'complete', 'the queue is still fully answered, so the review ends at once');
    assert.ok(noticeOf(session.screens.at(-1)!).endsWith(REVIEW_DONE));
    session.state.steps = [markAction(fixture.record, queue[1]!, 'unsure'), CLOSE];
    await command(fixture.record.id, session.ctx);
    assert.equal(await phase(), 'results_review', 'a doubt opens the review again');
  } finally {
    await shutdown();
    await fixture.cleanup();
  }
});

test('в рабочем пространстве запуск старого черновика подтверждает ожидания тем же диалогом, а отказ запуска назван', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-board-run-'));
  const other = await mkdtemp(join(tmpdir(), 'agent-lab-board-run-refused-'));
  const { tools, shutdown, command } = registered();
  const originalStart = ExperimentLab.prototype.start;
  const startCalls: Parameters<ExperimentLab['start']>[1][] = [];
  let refuse = false;
  ExperimentLab.prototype.start = async function(id, options) {
    startCalls.push(options);
    if (refuse) throw new Error('Сначала подтвердите ожидания ситуаций: они изменились или ещё не подтверждены.');
    return originalStart.call(this, id, options);
  };
  t.after(async () => { ExperimentLab.prototype.start = originalStart; await shutdown(); await rm(directory, { recursive: true, force: true }); await rm(other, { recursive: true, force: true }); });
  // Two old-format cards, as a repeat of an old run leaves them: their expectations are confirmed with the run.
  const first = await legacyDraftIn(directory, { count: 2 });
  const session = workspaceSession(directory);
  // The first dialog is declined, the second accepted.
  let launches = 0;
  session.state.choice = (_title, options) => ++launches === 1 ? 'Не сейчас' : options[0];
  session.state.steps = [[KEY.right, KEY.enter], [KEY.enter], CLOSE];
  await command(first.id, session.ctx);
  assert.match(session.frames[1]!, /^ Готово к запуску$/m);
  assert.match(session.frames[1]!, /^ 2 ситуации · 2 разговора: клиента играет Lab, ответы агента оценивает судья\.$/m);
  assert.match(session.frames[1]!, /Enter запустить · ← ситуации · Esc закрыть/);
  // One description of the plan: the lines the board showed are the lines of the dialog Enter opened, word for word.
  const board = session.frames[1]!.split('\n');
  const shown = board.slice(board.indexOf(' Готово к запуску') + 1, board.indexOf('', board.indexOf(' Готово к запуску'))).map(line => line.trim());
  assert.ok(shown.length >= 3, board.join('\n'));
  for (const line of shown) assert.ok(session.selectCalls[0]!.title.split('\n').includes(line), `«${line}» is not in the dialog:\n${session.selectCalls[0]!.title}`);

  // Closing the workspace does not cancel its run: wait for it before reading the final record.
  const completedStore = new ExperimentStore(join(directory, '.agent-lab'));
  const deadline = Date.now() + 10000;
  while ((await completedStore.get(first.id)).phase === 'evaluating' || existsSync(join(directory, '.agent-lab', '.lock'))) {
    assert.ok(Date.now() < deadline, 'background fixture did not finish');
    await new Promise(resolve => setTimeout(resolve, 20));
  }

  const plans = session.selectCalls.map(call => call.title);
  assert.equal(plans.length, 2);
  for (const plan of plans) {
    assert.match(plan, /^Подтвердить ожидания и запустить\?\n/);
    assert.match(plan, /Что агент должен сделать: 2 ситуации\. Номер правила — порядок в ваших материалах\./);
    assert.equal(plan.match(/Ситуация:/g)?.length, 2);
    assert.doesNotMatch(plan, /\/agent-lab|Версия ожиданий|[a-f0-9]{12}/, 'the owner reads the expectations, never a pointer or a hash');
    assert.ok(plan.endsWith('Запуск подтверждает ожидания ситуаций выше. Оценки судьи вы не проверяли.'));
  }
  // The confirmation seals every card's definition, so a set not made from production logs also shows the opening and the exact checks.
  const cards = (await new ExperimentStore(join(directory, '.agent-lab')).get(first.id)).scenarios;
  assert.ok(cards.length > 1 && cards.every(s => s.provenance !== 'production'), 'демо-набор не из логов');
  assert.match(plans[1]!, /Что вы подтверждаете дословно:/);
  for (const scenario of cards) assert.ok(plans[1]!.includes(`Запрос: ${scenario.user.opening}`), scenario.title);
  assert.equal(plans[1]!.match(/ {2}Проверка: /g)?.length ?? 0, cards.reduce((n, s) => n + s.checks.length, 0));
  assert.equal(startCalls.length, 1, 'отказ ничего не запускает');
  assert.equal(startCalls[0]!.requireAccepted, true);
  assert.equal(startCalls[0]!.reviewer, 'expectations', 'подтверждены ожидания, а не результаты');
  const ran = await new ExperimentStore(join(directory, '.agent-lab')).get(first.id);
  assert.ok(ran.acceptedDraftHash, 'подтверждение записано перед запуском');
  assert.ok(ran.trials.length > 0);

  // Expectations confirmed in the chat are not asked again; a refused start is said in the workspace.
  const second = await legacyDraftIn(other, { count: 2 });
  const chat = { cwd: other, mode: 'tui', hasUI: true, ui: { select: async (_title: string, options: string[]) => options[0] } } as unknown as ExtensionContext;
  assert.equal(output(await tools.get('agent_lab_run')!.execute('accept', { action: 'accept', run: second.id }, undefined, undefined, chat)).accepted, true);
  refuse = true;
  const later = workspaceSession(other);
  later.state.steps = [[KEY.right, KEY.enter], CLOSE];
  await command(second.id, later.ctx);
  assert.match(later.selectCalls[0]!.title, /^Запустить прогон\?\n/, 'confirmed expectations are not asked again');
  assert.equal(startCalls.at(-1)!.requireAccepted, true);
  assert.equal(noticeOf(later.screens.at(-1)!), 'Сначала подтвердите ожидания ситуаций: они изменились или ещё не подтверждены.');
});

test('in the workspace a digit answers a situation\'s question: the owner\'s decision is stored with a receipt from the workspace', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-lab-board-answer-'));
  const seed = new ExperimentLab(join(cwd, '.agent-lab'), createDemoRuntime());
  await seed.init();
  let id: string;
  try { id = (await seed.create(demoInput())).id; await seed.waitForIdle(); } finally { await seed.close(); }
  const { command, shutdown } = registered(), session = workspaceSession(cwd);
  // Before the first result the workspace opens on the situations; the first — selected — waits for an answer, «1» is its first answer, «Да».
  session.state.steps = [['1'], CLOSE];
  try {
    await command(id, session.ctx);
    assert.match(session.screens[0]!, /Ситуации 1\/2 {2}› {2}Прогон {2}› {2}Результат/);
    assert.match(session.screens[0]!, /› 1 {2}Возврат оплаты — номер только по просьбе +\? нужен ваш ответ/);
    assert.match(session.screens[0]!, /\? .+\n +1 Да {2}· {2}2 /, 'the question of the selected situation stands above its answers');
    const library = (await new ExperimentStore(join(cwd, '.agent-lab')).get(id)).librarySnapshot as LibraryV2;
    assert.deepEqual([library.receipts.at(-1)!.via, library.receipts.at(-1)!.command.kind], ['board', 'settle_claim']);
    assert.match(noticeOf(session.screens[1]!), /^Ситуация 1: записано\./);
    assert.match(session.screens[1]!, /1 {2}Возврат оплаты — номер только по просьбе +✓ готова/);
    assert.deepEqual([session.selectCalls.length, session.editorCalls.length], [0, 0], 'the key pressed on the shown answer is the decision');
  } finally { await shutdown(); await rm(cwd, { recursive: true, force: true }); }
});

test('the workspace offers a record\'s words in its native dialogs escaped: a duty that carries an escape sequence is shown and matched without it', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-lab-board-escape-'));
  const seed = new ExperimentLab(join(cwd, '.agent-lab'), createDemoRuntime());
  await seed.init();
  let id: string;
  try {
    id = (await seed.create(demoInput())).id; await seed.waitForIdle();
    // The owner once wrote a duty with an escape sequence in it (a paste from a terminal): the record keeps it as written.
    const context = await seed.cardContext(id);
    const ready = situationViews(context.experiment, { evidence: context.evidence, maxTurns: 3 }).find(view => view.status === 'ready')!;
    const words = 'объяснить\u001b[2J, как оформить возврат';
    const prepared = await seed.prepareCardCommand(id, { kind: 'edit_expectation', cardId: ready.id, expectationId: ready.refs.must[1]!, text: words }, { via: 'cli-yes', ownerWords: words });
    await seed.applyCardCommand(id, prepared, hostGrant(prepared, 'words'));
    await seed.recheckCards(id); await seed.waitForIdle();
  } finally { await seed.close(); }
  const { command, shutdown } = registered(), session = workspaceSession(cwd);
  // «Изменить» on the ready situation, then «Что агент должен»: the duties are offered to pick from; the owner steps back.
  session.state.choice = (title, options) => title.startsWith('Что изменить') ? options[3] : undefined;
  session.state.steps = [[KEY.down, KEY.enter, '1'], CLOSE];
  try {
    await command(id, session.ctx);
    const duties = session.selectCalls.find(call => call.title === 'Какое ожидание изменить?');
    assert.ok(duties, JSON.stringify(session.selectCalls.map(call => call.title)));
    assert.ok(duties.options.every(option => !option.includes('\u001b')), JSON.stringify(duties.options));
    assert.ok(duties.options.includes('2  объяснить, как оформить возврат'), JSON.stringify(duties.options));
  } finally { await shutdown(); await rm(cwd, { recursive: true, force: true }); }
});
