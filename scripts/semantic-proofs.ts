/*
 * Report A — deterministic contract checks of the semantic contract between DISCOVER and VERIFY and of the connection
 * exam: no model, no key, no network beyond a local HTTP fake — the teaching runtime, scripted judges in the judge's own
 * answer format, stub planners and fake agents. Each claim prints PASS or FAIL; the process exits 1 when any fails. It
 * says the contract holds on these constructed cases, never that a judge is good on real conversations: that is report
 * B, a protocol on labelled real dialogues (scripts/practical-protocol.ts).
 *
 *   A  a criterion DISCOVER found in a logged conversation is the one the check's card carries (same criterion hash),
 *      and the check reads that expectation: the baseline reproduces, the fixed teaching version is «fixed» against it
 *   B  a conversation where the criterion was not decided (UNKNOWN) is no control of it
 *   C  what a rule requires is kept apart from what the logs observe: a tool criterion never passes on words, a missing
 *      call fails only under the owner's contract of the log, and is «not observable» otherwise (item 1)
 *   D  an adapter that shares one memory between conversations cannot pass the isolation exam
 *   E  the chosen problem and the rest of the mandatory set are two answers: incomparable runs, the judge's own
 *      difference, an unmeasured control, unchecked chosen cases, a local fix beside a regression (item 2)
 *   F  Lab's own failure is never told as the owner's missing rule; a rules gap only on the reviewer's word (item 3)
 *   G  DISCOVER beyond 8 conversations a topic: bounded first sample, stop, continuation without paying twice (item 4)
 *   H  DISCOVER on its own in /agent-lab: analysis, evidence, whole conversation, the owner's mark, links (item 5)
 *   I  what the first live analysis of a real agent's logs showed, fixed: the judge told the situation a duty is for,
 *      one dropped connection never ends the whole analysis, the failure and the next step named, the way from the log
 *      to what was judged in one line
 *
 * Run from the repository: npx tsx scripts/semantic-proofs.ts
 */
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { criterionHash, expectationCriterionHash } from '../src/criterion.js';
import { createDemoAnalysisRuntime, demoAnalysisInput } from '../src/demo.js';
import { problemCheck } from '../src/discover/check.js';
import { checkLink, problemConversations } from '../src/discover/verify.js';
import { analysisView, type ProblemView } from '../src/discover/view.js';
import type { Experiment } from '../src/contracts.js';
import { examCanVouch, examConnection } from '../src/exam.js';
import { ExperimentLab } from '../src/experiment.js';
import { buildResultView } from '../src/result-view.js';
import type { Runtime } from '../src/runtime.js';
import { runnableTargetSchema } from '../src/target-schema.js';
import { proofBoard } from './proofs/board.js';
import { proofChannels } from './proofs/channels.js';
import { claim, cleanUp, failures, folder, preparedCheck, repeatWith, run } from './proofs/common.js';
import { proofBeyondEight, proofLabFailures } from './proofs/discover-work.js';
import { proofLiveDefects } from './proofs/live-defects.js';
import { proofRest } from './proofs/rest.js';

const problemWith = (view: ReturnType<typeof analysisView>, start: string): ProblemView => {
  const problem = view.problems.find(item => item.duty.text.startsWith(start));
  if (!problem) throw new Error(`No problem «${start}…» in the teaching analysis`);
  return problem;
};

// ─── A and B: the teaching logs, analysed, and checks of their problems ─────────────────────────────────────────────
async function proofsAB(): Promise<void> {
  const lab = new ExperimentLab(join(await folder('ab'), '.agent-lab'), createDemoAnalysisRuntime());
  await lab.init();
  try {
    const started = await lab.analyze(demoAnalysisInput(), { callCeiling: 100 });
    await lab.waitForIdle();
    const analysis = await lab.getAnalysis(started.id);
    const batch = await lab.store.readImport(analysis.logs.importId);
    const view = analysisView(analysis, batch);

    // A. Criterion X: «не спрашивать номер терминала ещё раз, если клиент его уже назвал», broken in «known».
    const x = problemWith(view, 'не спрашивать номер');
    const found = analysis.findings.filter(finding => finding.dialogueId === 'known' && finding.result === 'fail' && finding.criterionHash === x.key);
    claim('A', x.dialogueIds.includes('known') && found.length === 1 && x.key === criterionHash(x.criterion),
      `DISCOVER found X in «known»: finding criterionHash ${x.key.slice(0, 12)} = criterionHash(X)`);
    const { link, controls } = checkLink(analysis, x);
    claim('A', link.criterionHash === x.key && link.dialogueIds.join() === 'known' && controls.length === 0,
      `fromAnalysis link freezes X (hash ${link.criterionHash?.slice(0, 12)}); conversations ${JSON.stringify(link.dialogueIds)}, controls ${JSON.stringify(controls)}`);
    const draft = await preparedCheck(lab, analysis, link, link.dialogueIds);
    const library = draft.librarySnapshot?.formatVersion === 2 ? draft.librarySnapshot : undefined;
    const card = library?.cards.find(item => item.origin.kind === 'dialogue' && item.origin.dialogueId === 'known');
    const carried = card?.agentMust.find(duty => !duty.appliesWhen && expectationCriterionHash(duty, library!.requirements) === x.key);
    claim('A', !!carried, `VERIFY card №${card?.number} «${card?.title}» has expectation ${carried?.id} with exactly X's criterionHash`);
    const compiled = draft.scenarios.find(scenario => scenario.id === card?.id);
    claim('A', !!compiled && draft.phase !== 'error', `the card is accepted and compiled into the run's sealed definition (${draft.scenarios.length} situation)`);

    const baseline = await run(lab, draft.id);
    const first = buildResultView(baseline).problemCheck;
    claim('A', first?.reproduced === 'yes' && first.broken[0]?.expectationId === carried?.id && first.broken[0]?.outcome === 'fail',
      `baseline (${first?.version}): problemCheck reads expectation ${first?.broken[0]?.expectationId} → ${first?.broken[0]?.outcome}; reproduced = ${first?.reproduced}`);
    const fixed = await repeatWith(lab, baseline, 'createFixedSession');
    const second = buildResultView(fixed, { before: baseline }).problemCheck;
    claim('A', second?.reproduced === 'no' && second.before?.verdict === 'fixed' && second.before.comparable,
      `fixed teaching version (${second?.version}) against the baseline: reproduced = ${second?.reproduced}, verdict = ${second?.before?.verdict}`);
    // A check none of whose situations carries the criterion states nothing.
    const other = structuredClone(baseline);
    other.fromAnalysis = { ...other.fromAnalysis!, criterion: { ...other.fromAnalysis!.criterion!, text: 'назвать сумму возврата' } };
    other.fromAnalysis.criterionHash = criterionHash(other.fromAnalysis.criterion!);
    const refused = problemCheck(other, buildResultView(baseline).cards);
    claim('A', refused?.unbound === 'not_carried' && refused.reproduced === 'unknown' && !refused.broken.length,
      `a link whose criterion no card carries is refused: unbound = ${refused?.unbound}, no found/reproduced/fixed stated`);

    await injected(link, x.key);

    // B. Criterion Y: «объяснить, как оформить возврат», broken in «known»; on «late» the judge found it not exercised.
    const y = problemWith(view, 'объяснить');
    const onLate = analysis.findings.filter(finding => finding.dialogueId === 'late' && finding.criterionHash === y.key);
    claim('B', onLate.length === 1 && onLate[0]!.result === 'unknown', `Y on «late» (same topic): finding ${onLate[0]?.result}, the log never reached the rule`);
    const yCheck = problemConversations(y);
    claim('B', !y.held.includes('late') && !yCheck.controls.includes('late') && yCheck.dialogueIds.join() === 'known',
      `«late» is no control: held ${JSON.stringify(y.held)}, check conversations ${JSON.stringify(yCheck.dialogueIds)}`);
    // The same rule both ways: a pass with evidence makes a control; the owner's «нарушение есть», or a pass without evidence, does not.
    const passed = structuredClone(analysis);
    const late = passed.findings.find(finding => finding.key === onLate[0]!.key)!;
    Object.assign(late, { result: 'pass', complete: true, evidence: [{ seq: 1, quote: 'Уточните номер терминала.' }] });
    claim('B', problemConversations(problemWith(analysisView(passed, batch), 'объяснить')).controls.join() === 'late', 'counter-check: the same finding as a pass with evidence does become a control');
    const doubted = structuredClone(passed);
    doubted.reviews.push({ id: 'review-1', createdAt: new Date().toISOString(), key: late.key, verdict: 'confirmed', note: 'нарушение есть', judgeVerdict: 'pass', via: 'cli-yes' });
    const bare = structuredClone(passed);
    bare.findings.find(finding => finding.key === late.key)!.evidence = [];
    claim('B', !problemWith(analysisView(doubted, batch), 'объяснить').held.length && !problemWith(analysisView(bare, batch), 'объяснить').held.length,
      'a pass the owner overrode, or a pass without evidence, is no control');
    // No regression read off it: a check whose import also holds «late» (as the old bridge made it) against a candidate that fails «late».
    const withLate = await preparedCheck(lab, analysis, checkLink(analysis, y).link, ['known', 'late']);
    const yBaseline = await run(lab, withLate.id);
    const regressed = await repeatWith(lab, yBaseline, 'createRegressedSession');
    const result = buildResultView(regressed, { before: yBaseline });
    const lateFails = result.failures.some(failure => failure.title.includes('по просьбе'));
    claim('B', lateFails && result.problemCheck?.before?.verdict === 'fixed' && !result.problemCheck.before.regressed.length && !result.problemCheck.controls.length,
      `candidate fails the «late» situation (${lateFails}); Y's own answer reads no regression off it: controls ${result.problemCheck?.controls.length}, verdict ${result.problemCheck?.before?.verdict}, regressed ${JSON.stringify(result.problemCheck?.before?.regressed)}`);
    const rest = result.problemCheck?.rest.against;
    claim('B', !!rest?.broken.some(item => item.title.includes('по просьбе')),
      `…and the rest of the check, confirmed on the baseline, does not hide it: broke ${JSON.stringify(rest?.broken.map(item => `№${item.number} ${item.text}`))}`);
  } finally { await lab.close(); }
}

/**
 * A builder that leaves the criterion out of the card: the harness puts it in (discover/verify.ts withCriterion), with its
 * rules in the library — the card carries it all the same.
 */
async function injected(link: NonNullable<Experiment['fromAnalysis']>, hash: string): Promise<void> {
  const base = createDemoAnalysisRuntime();
  const forgetful: Runtime = { ...base, async proposeCard(input, ctx) {
    const proposal = await base.proposeCard!(input, ctx) as { agentMust: { text: string }[] };
    return { ...proposal, agentMust: proposal.agentMust.filter(duty => !duty.text.startsWith('не спрашивать номер')) } as never;
  } };
  const lab = new ExperimentLab(join(await folder('inject'), '.agent-lab'), forgetful);
  await lab.init();
  try {
    const started = await lab.analyze(demoAnalysisInput(), { callCeiling: 100 });
    await lab.waitForIdle();
    const analysis = await lab.getAnalysis(started.id);
    const draft = await preparedCheck(lab, analysis, { ...link, analysisId: analysis.id }, link.dialogueIds);
    const library = draft.librarySnapshot?.formatVersion === 2 ? draft.librarySnapshot : undefined;
    const card = library?.cards.find(item => item.origin.kind === 'dialogue' && item.origin.dialogueId === 'known');
    const carried = card?.agentMust.find(duty => !duty.appliesWhen && expectationCriterionHash(duty, library!.requirements) === hash);
    claim('A', !!carried && card!.agentMust.length === 2, `a builder that leaves X out: the harness puts it into card №${card?.number} as ${carried?.id} (duties: ${card?.agentMust.map(duty => duty.id).join(', ')})`);
  } finally { await lab.close(); }
}

// ─── D: the isolation exam against fake HTTP agents ──────────────────────────────────────────────────────────────
type Agent = (sessionId: string, message: string) => string;
const numberIn = (text: string) => /\b\d{6}\b/.exec(text)?.[0];
const reply = (known: string | undefined, message: string): string => numberIn(message) ? 'Спасибо, записал. Чем помочь?'
  : message.toLowerCase().includes('какой у меня номер') ? known ? `Ваш номер терминала ${known}.` : 'Вы ещё не называли номер терминала.' : 'Здравствуйте! Чем могу помочь?';
const agents: Record<string, () => Agent> = {
  /** One number per conversation. */
  'per-session': () => { const state = new Map<string, string>(); return (id, message) => { const answer = reply(state.get(id), message); const told = numberIn(message); if (told) state.set(id, told); return answer; }; },
  /**
   * One memory for every conversation, emptied once it is recalled: it passes every path and every control of an exam
   * whose second path only checks «Здравствуйте» — what the earlier rule took for isolation.
   */
  'shared-once': () => { let value: string | undefined; return (_id, message) => {
    const answer = reply(value, message); if (numberIn(message)) value = numberIn(message); else if (message.toLowerCase().includes('какой у меня номер')) value = undefined; return answer; }; },
  /** One variable for every conversation, cleared when a new conversation opens. */
  'shared-session': () => { let value: string | undefined; const seen = new Set<string>(); return (id, message) => {
    if (!seen.has(id)) { seen.add(id); value = undefined; } const answer = reply(value, message); value = numberIn(message) ?? value; return answer; }; },
};
const memoryPath = (name: string, value: string) => ({ name, steps: [{ say: `Мой номер терминала ${value}`, expect: 'reply' }, { say: 'Какой у меня номер терминала?', expect: 'reply', contains: value }] });
const exams = {
  'two memory probes, interleaved': [memoryPath('Клиент А', '783194'), memoryPath('Клиент Б', '892305')],
  'second path checks «Здравствуйте»': [memoryPath('Клиент А', '783194'), { name: 'Клиент Б', steps: [{ say: 'Здравствуйте', expect: 'reply', contains: 'Здравствуйте' }] }],
  'two probes, not interleaved': [memoryPath('Клиент А', '783194'),
    { name: 'Клиент Б', steps: [{ say: 'Здравствуйте', expect: 'reply' }, { say: 'Мой номер терминала 892305', expect: 'reply' }, { say: 'Какой у меня номер терминала?', expect: 'reply', contains: '892305' }] }],
};
const body = (request: IncomingMessage) => new Promise<string>(resolve => { let data = ''; request.on('data', chunk => { data += chunk; }); request.on('end', () => resolve(data)); });
async function examOf(make: () => Agent, exam: unknown) {
  const agent = make();
  const server = createServer(async (request, response) => {
    const json = JSON.parse(await body(request)) as { sessionId: string; message: string };
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ reply: agent(json.sessionId, json.message) }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const target = runnableTargetSchema.parse({ kind: 'http', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, timeoutMs: 5000, exam });
    return { vouches: examCanVouch(target.exam), result: await examConnection(target, new AbortController().signal) };
  } finally { server.close(); }
}
async function proofD(): Promise<void> {
  for (const [examName, exam] of Object.entries(exams)) {
    for (const [agentName, make] of Object.entries(agents)) {
      const { vouches, result } = await examOf(make, exam);
      const shouldPass = agentName === 'per-session' && examName === 'two memory probes, interleaved';
      const clean = result.paths.every(path => path.passed) && (result.controls ?? []).every(control => control.passed);
      claim('D', (result.status === 'passed') === shouldPass && (examName === 'two memory probes, interleaved') === vouches,
        `${agentName.padEnd(14)} × ${examName.padEnd(34)} → ${result.status} · isolation ${result.properties?.isolation} · exam can vouch: ${vouches}${clean && !shouldPass ? ' · every path and control passed, still not a proof' : ''}`);
    }
  }
}

try {
  await proofsAB();
  await proofChannels();
  await proofD();
  await proofRest();
  await proofLabFailures();
  await proofBeyondEight();
  await proofBoard();
  await proofLiveDefects();
} finally {
  await cleanUp();
}
const failed = failures();
console.log(failed ? `\n${failed} claim(s) FAILED` : '\nReport A: all claims PASS — A B C D E F G H I. Contract checks on constructed cases; judge quality on real dialogues is report B.');
process.exit(failed ? 1 : 0);
