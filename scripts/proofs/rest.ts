/*
 * E — the chosen problem and the rest of the mandatory set are two answers (item 2), on the teaching agent: the baseline
 * asks again for a number it has; the fixed version does not; the regressed one never asks — it fixes the problem and
 * breaks «спросить отсутствующий номер». The check of «не спрашивать уже названный номер» holds the conversation where
 * the problem was found and a neighbour where another rule held in the logs.
 */
import { join } from 'node:path';
import type { MetricAssessment } from '../../src/assessment.js';
import { isCardExecution, type Experiment } from '../../src/contracts.js';
import { createDemoAnalysisRuntime, demoAnalysisInput } from '../../src/demo.js';
import { problemCheck, type ProblemCheck } from '../../src/discover/check.js';
import { checkVerdictLine, problemCheckLines, restCheckLines } from '../../src/discover/text.js';
import { checkLink } from '../../src/discover/verify.js';
import { analysisView, criteriaHeld, type ProblemView } from '../../src/discover/view.js';
import type { LogAnalysis } from '../../src/discover/schema.js';
import { ExperimentLab } from '../../src/experiment.js';
import { buildResultView } from '../../src/result-view.js';
import type { Runtime } from '../../src/runtime.js';
import { claim, folder, preparedCheck, repeatWith, run } from './common.js';

const problemWith = (problems: readonly ProblemView[], start: string): ProblemView => {
  const problem = problems.find(item => item.duty.text.startsWith(start));
  if (!problem) throw new Error(`No problem «${start}…» in the teaching analysis`);
  return problem;
};
/** The two answers of a run of a check, against the run it repeats when given. */
const checkOf = (record: Experiment, before?: Experiment): ProblemCheck | undefined => buildResultView(record, before ? { before } : {}).problemCheck;
const outcomes = (record: Experiment) => buildResultView(record).cards;
const words = (check: ProblemCheck | undefined): string => check ? [...problemCheckLines(check), ...restCheckLines(check), checkVerdictLine(check) ?? ''].join(' ') : '';

/**
 * The teaching runtime with its judge overridden on the situations and duties `pick` names: the agent and the customer
 * are the same, so the replies are the same — only the judge's word differs.
 */
function judgedAs(pick: (duty: string, title: string) => MetricAssessment['result'] | undefined): Runtime {
  const base = createDemoAnalysisRuntime();
  return { ...base, async assess(input, ctx) {
    const assessed = await base.assess!(input, ctx);
    const execution = input.scenario.execution;
    const duties = execution && isCardExecution(execution) ? execution.evaluatorView.expectations : [];
    return assessed.map(item => {
      const duty = duties.find(entry => entry.id === item.metricId);
      const result = duty && pick(duty.text, input.scenario.title);
      return result ? { ...item, result, ...(result === 'unknown' ? { evidence: [] } : {}) } : item;
    });
  } };
}

export async function proofRest(): Promise<void> {
  const directory = join(await folder('rest'), '.agent-lab');
  let lab = new ExperimentLab(directory, createDemoAnalysisRuntime());
  await lab.init();
  let analysis: LogAnalysis;
  let baseline: Experiment, regressed: Experiment, fixed: Experiment, yBaseline: Experiment;
  try {
    const started = await lab.analyze(demoAnalysisInput(), { callCeiling: 100 });
    await lab.waitForIdle();
    analysis = await lab.getAnalysis(started.id);
    const batch = await lab.store.readImport(analysis.logs.importId);
    const view = analysisView(analysis, batch);
    const x = problemWith(view.problems, 'не спрашивать номер');
    const { link, controls, neighbours } = checkLink(analysis, x, criteriaHeld(view));
    claim('E', link.broken.join() === 'known' && !controls.length && neighbours.join() === 'late',
      `the check of X holds «known» (the problem) and neighbour «late», where another rule held in the logs; controls of X: ${JSON.stringify(controls)}`);
    const draft = await preparedCheck(lab, analysis, link, link.dialogueIds);
    baseline = await run(lab, draft.id);
    regressed = await repeatWith(lab, baseline, 'createRegressedSession');
    fixed = await repeatWith(lab, baseline, 'createFixedSession');

    // (6) The first run is the baseline: it confirms which expectations of other rules are regression tests.
    const first = checkOf(baseline);
    claim('E', first?.reproduced === 'yes' && !first.rest.against && first.rest.passed === 2 && first.rest.failed === 1,
      `(6) baseline: X reproduced; the rest — ${first?.rest.total} expectations of other rules, ${first?.rest.passed} passed here and so become regression tests, ${first?.rest.failed} failed and do not`);
    // (5) The local fix is acknowledged, and the general regression is not hidden.
    const local = checkOf(regressed, baseline);
    const brokeAsk = local?.rest.against?.broken.some(item => item.text.startsWith('спросить номер терминала'));
    claim('E', local?.before?.verdict === 'fixed' && !!brokeAsk && !!checkVerdictLine(local!)?.includes('принимать нельзя'),
      `(5) regressed candidate: X ${local?.before?.verdict} against the baseline, and apart: broke ${JSON.stringify(local?.rest.against?.broken.map(item => `№${item.number} ${item.text}`))} — «${local ? checkVerdictLine(local) : ''}»`);
    claim('E', (local?.rest.against?.unconfirmed ?? 0) >= 1 && local?.rest.against?.tests === 2,
      `(6) only what passed on the baseline is a regression test: tests ${local?.rest.against?.tests}, not tests (failed or unmeasured there) ${local?.rest.against?.unconfirmed}; «late» X-unknown in the logs is no control (${local?.controls.length} controls)`);
    const good = checkOf(fixed, baseline);
    claim('E', good?.before?.verdict === 'fixed' && good.rest.against?.broken.length === 0 && good.rest.against?.held.length === 2 && checkVerdictLine(good!) === 'Итог: проблема исправлена, и ничего проверенного не сломалось.',
      `(5) fixed candidate: X ${good?.before?.verdict}; rest held ${good?.rest.against?.held.length} of ${good?.rest.against?.tests} — «${good ? checkVerdictLine(good) : ''}»`);

    // (1) Incomparable conditions: neither a proven fix nor a proven regression.
    const other = structuredClone(regressed);
    other.id = `${regressed.id}-other-settings`; other.settings = { ...other.settings, maxTurns: other.settings.maxTurns + 1 };
    const incomparable = problemCheck(other, outcomes(other), { record: baseline, outcomes: outcomes(baseline) });
    claim('E', incomparable?.before?.verdict === 'unproven' && incomparable.before.why === 'incomparable' && !incomparable.before.regressed.length
      && incomparable.rest.against?.comparable === false && !incomparable.rest.against.broken.length && !!checkVerdictLine(incomparable)?.includes('несравнимы'),
      `(1) the regressed run under other settings: problem ${incomparable?.before?.verdict}/${incomparable?.before?.why}, rest broken ${incomparable?.rest.against?.broken.length} — «${incomparable ? checkVerdictLine(incomparable) : ''}»`);

    // (4) Chosen cases the run checks nothing on show in coverage: the rest passing is not all chosen passing.
    const wider = <T extends Experiment>(record: T): T => { const copy = structuredClone(record); copy.fromAnalysis = { ...copy.fromAnalysis!, dialogueIds: ['known', 'late', 'ghost'], broken: ['known', 'late', 'ghost'] };
      delete copy.fromAnalysis.neighbours; return copy; };
    const partial = problemCheck(wider(fixed), outcomes(fixed), { record: wider(baseline), outcomes: outcomes(baseline) });
    claim('E', partial?.unchecked.missing === 1 && partial.unchecked.changed === 1 && partial.before?.verdict === 'unproven' && partial.before.why === 'partial' && words(partial).includes('Проверено 1 из 3'),
      `(4) three chosen, one without a situation, one whose situation lost the criterion: ${JSON.stringify(partial?.unchecked)} → ${partial?.before?.verdict}/${partial?.before?.why}`);

    // A check of Y whose control holds: «late», where Y passed with evidence in the logs (the teaching log never reached Y there — made a pass here to have a control).
    const passed = structuredClone(analysis);
    const y = problemWith(view.problems, 'объяснить');
    const late = passed.findings.find(finding => finding.dialogueId === 'late' && finding.criterionHash === y.key)!;
    Object.assign(late, { result: 'pass', complete: true, evidence: [{ seq: 1, quote: 'Уточните номер терминала.' }] });
    const yLink = checkLink(passed, problemWith(analysisView(passed, batch).problems, 'объяснить')).link;
    claim('E', yLink.broken.join() === 'known' && yLink.dialogueIds.join() === 'known,late', `the check of Y: broken ${JSON.stringify(yLink.broken)}, control «late»`);
    const yDraft = await preparedCheck(lab, passed, yLink, yLink.dialogueIds);
    yBaseline = await run(lab, yDraft.id);
  } finally { await lab.close(); }

  // (2) The same replies judged otherwise are never a proven improvement: the baseline agent again, a judge that passes X.
  lab = new ExperimentLab(directory, judgedAs(duty => duty.startsWith('не спрашивать номер') ? 'pass' : undefined));
  await lab.init();
  try {
    const same = await repeatWith(lab, baseline, 'createSession');
    const check = checkOf(same, baseline);
    claim('E', check?.reproduced === 'no' && check.before?.verdict === 'unproven' && check.before.why === 'judge_only' && check.before.judgeOnly.length === 1,
      `(2) the baseline agent again, a judge that now passes X: reproduced ${check?.reproduced}, yet ${check?.before?.verdict}/${check?.before?.why} — «${check ? problemCheckLines(check).at(-1) : ''}»`);
  } finally { await lab.close(); }

  // (3) The problem passes, its control is not measured: absence of a regression is said as not confirmed.
  lab = new ExperimentLab(directory, judgedAs((duty, title) => duty.startsWith('объяснить') && title.includes('по просьбе') ? 'unknown' : undefined));
  await lab.init();
  try {
    const candidate = await repeatWith(lab, yBaseline, 'createFixedSession');
    const check = checkOf(candidate, yBaseline);
    claim('E', check?.before?.verdict === 'fixed' && check.before.besideUnknown.length === 1 && words(check).includes('не подтверждено'),
      `(3) Y fixed in «known», its control «late» unmeasured: ${check?.before?.verdict}, not measured beside ${check?.before?.besideUnknown.length} — «${check ? problemCheckLines(check).at(-1) : ''}»`);
  } finally { await lab.close(); }
}
