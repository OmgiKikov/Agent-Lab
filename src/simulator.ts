import { metricApplies, simulatorWasUsed, valueTokens, SIMULATOR_CHECK_IDS, type Experiment, type Scenario, type SimulatorCheck, type SimulatorCheckId, type Trial, type UserMode } from './contracts.js';
import { automaticTrialResult, latestHumanReviews, measured, observedRecord } from './outcomes.js';

/*
 * Code checks over the simulated user's own replies. They answer three questions the judge is
 * bad at and code is good at: did the user say a value only the backend knows (leak), did it
 * say a value that exists nowhere in its card or the conversation (fabrication, a heuristic),
 * did it repeat itself (loop). Results describe the simulator, never the agent, and are never
 * shown to the judge so that they cannot bias its verdict.
 */
function knownText(user: Scenario['user']): string {
  return [user.opening, user.facts, user.goal, user.behavior, user.persona ?? '', ...(user.characteristics ?? []), ...(user.script ?? []),
    ...(user.knows ?? []), ...(user.answers ?? []).flatMap(a => [a.ifAsked, a.reply])].join('\n');
}
function leaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string' || typeof value === 'number') { const s = String(value).trim(); if (s.length >= 3) out.push(s); }
  else if (Array.isArray(value)) for (const item of value) leaves(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) leaves(item, out);
  return out;
}
/** Scalar leaves of the initial world the card did not disclose to the user, lower-cased. */
export function hiddenLiterals(scenario: Scenario): string[] {
  const known = knownText(scenario.user).toLocaleLowerCase();
  const values = [...leaves(scenario.initialState.records), ...leaves(scenario.initialState.external)].map(v => v.toLocaleLowerCase());
  return [...new Set(values.filter(v => !known.includes(v)))];
}
const normalize = (text: string) => text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export function simulatorChecks(scenario: Scenario, trial: Trial): SimulatorCheck[] {
  if (!simulatorWasUsed(trial)) return [];
  const users = trial.events.filter(e => e.type === 'user');
  const simulated = users.slice(1);
  if (!simulated.length) return [];
  const textBefore = (seq: number, types: string[]) => trial.events.filter(e => types.includes(e.type) && e.seq < seq).map(e => e.text ?? '').join('\n');
  const checks: SimulatorCheck[] = [];

  const hidden = hiddenLiterals(scenario);
  if (hidden.length) {
    let leak: { seq: number; value: string } | undefined;
    for (const message of simulated) {
      const said = (message.text ?? '').toLocaleLowerCase();
      const revealed = textBefore(message.seq, ['assistant']).toLocaleLowerCase();
      const value = hidden.find(h => said.includes(h) && !revealed.includes(h));
      if (value) { leak = { seq: message.seq, value }; break; }
    }
    checks.push({ id: 'simulator_leak', heuristic: false, passed: !leak, ...(leak ? { seq: leak.seq } : {}),
      description: 'Пользователь не называет скрытые значения тестового мира раньше агента',
      evidence: leak ? `Реплика #${leak.seq} содержит скрытое значение «${leak.value}», которого агент ещё не называл.` : `Скрытых значений: ${hidden.length}; ни одно не прозвучало раньше агента.` });
  }

  const known = valueTokens(knownText(scenario.user));
  let fabricated: { seq: number; token: string } | undefined;
  for (const message of simulated) {
    const allowed = new Set([...known, ...valueTokens(textBefore(message.seq, ['assistant', 'user']))]);
    const token = [...valueTokens(message.text ?? '')].find(t => !allowed.has(t));
    if (token) { fabricated = { seq: message.seq, token }; break; }
  }
  checks.push({ id: 'simulator_fabrication', heuristic: true, passed: !fabricated, ...(fabricated ? { seq: fabricated.seq } : {}),
    description: 'Пользователь не называет значения, которых нет ни в карточке, ни в предыдущих репликах (эвристика по токенам)',
    evidence: fabricated ? `Подозрение: реплика #${fabricated.seq} содержит значение «${fabricated.token}», которого нет в известных пользователю фактах и предыдущих репликах.` : 'Все значения в репликах пользователя прослеживаются к карточке или предыдущим репликам.' });

  const seen = new Map<string, number>();
  let loop: { seq: number; earlier: number } | undefined;
  for (const message of users) {
    const key = normalize(message.text ?? '');
    if (key.length < 3) continue;
    const earlier = seen.get(key);
    if (earlier !== undefined && message.seq !== users[0]!.seq) { loop = { seq: message.seq, earlier }; break; }
    seen.set(key, message.seq);
  }
  checks.push({ id: 'simulator_loop', heuristic: false, passed: !loop, ...(loop ? { seq: loop.seq } : {}),
    description: 'Пользователь не повторяет одну и ту же реплику',
    evidence: loop ? `Реплика #${loop.seq} повторяет реплику #${loop.earlier}.` : 'Повторов реплик нет.' });
  return checks;
}

export interface SimulatorSummary {
  reactiveDialogues: number;
  checks: { id: SimulatorCheckId; dialogues: number; flagged: number; heuristic: boolean; examples: { trialId: string; seq?: number; evidence: string }[] }[];
  judge: { applicable: number; pass: number; fail: number; unknown: number; missing: number };
  human: { reviewed: number; confirmed: number; rejected: number };
  clarifications: { dialogues: number; answered: number };
  disengaged: number; notes: string[];
}
/** Everything the run recorded about the simulated user: code checks, judge fidelity, human verdicts, and how often the agent's question got an answer. */
export function simulatorSummary(record: Experiment): SimulatorSummary {
  record = observedRecord(record);
  const reviews = latestHumanReviews(record);
  const reactive = record.trials.filter(t => simulatorWasUsed(t) && measured(t));
  const scenarioOf = (t: Trial) => record.scenarios.find(s => s.id === t.scenarioId);
  const checks = SIMULATOR_CHECK_IDS.map(id => {
    const withCheck = reactive.filter(t => t.simulatorChecks?.some(c => c.id === id));
    const flagged = withCheck.filter(t => t.simulatorChecks!.some(c => c.id === id && !c.passed));
    return { id, dialogues: withCheck.length, flagged: flagged.length, heuristic: id === 'simulator_fabrication',
      examples: flagged.slice(0, 3).map(t => { const c = t.simulatorChecks!.find(c => c.id === id && !c.passed)!; return { trialId: t.id, ...(c.seq !== undefined ? { seq: c.seq } : {}), evidence: c.evidence }; }) };
  });
  const judge = { applicable: 0, pass: 0, fail: 0, unknown: 0, missing: 0 };
  for (const t of reactive) {
    const metric = scenarioOf(t)?.metrics?.find(m => m.subject === 'simulator' && metricApplies(m, t));
    if (!metric) continue;
    judge.applicable++;
    const result = t.assessments?.find(a => a.metricId === metric.id)?.result;
    if (!result) judge.missing++; else judge[result]++;
  }
  const human = { reviewed: 0, confirmed: 0, rejected: 0 };
  for (const t of reactive) for (const review of reviews.values()) {
    if (review.trialId !== t.id || !(review.verdict === 'pass' || review.verdict === 'fail')) continue;
    const onSimulatorMetric = !!review.metricId && !!scenarioOf(t)?.metrics?.some(m => m.id === review.metricId && m.subject === 'simulator');
    const onSimulatorCheck = !!review.checkId && (SIMULATOR_CHECK_IDS as readonly string[]).includes(review.checkId);
    if (!onSimulatorMetric && !onSimulatorCheck) continue;
    human.reviewed++;
    if (review.verdict === 'fail') human.confirmed++; else human.rejected++;
  }
  const asked = (t: Trial) => !!t.events.find(e => e.type === 'assistant')?.text?.includes('?');
  const clarifications = { dialogues: reactive.filter(asked).length, answered: reactive.filter(t => asked(t) && t.events.filter(e => e.type === 'user').length > 1).length };
  const disengaged = reactive.filter(t => {
    const last = t.events.filter(e => e.type === 'simulator').at(-1)?.result as { done?: boolean; message?: string } | undefined;
    return !!last?.done && !(last.message ?? '').trim() && automaticTrialResult(scenarioOf(t), t) !== 'pass';
  }).length;
  const notes: string[] = [];
  if (!reactive.length) notes.push('Реактивных диалогов нет: симулятор не участвовал.');
  else if (!judge.applicable) notes.push('Рубрика верности симулятора не применялась.');
  if (checks.some(c => c.flagged && c.heuristic)) notes.push('Подозрение на выдуманное значение — эвристика по токенам; опровергается ручным вердиктом по этой проверке.');
  return { reactiveDialogues: reactive.length, checks, judge, human, clarifications, disengaged, notes };
}

export interface ModeValue {
  cards: { scenarioId: string; title: string; familyId: string; outcomes: Partial<Record<UserMode, 'pass' | 'fail' | 'unknown' | 'missing'>>; clarification: boolean }[];
  reactiveOnlyCompleted: string[]; reactiveOnlyFailed: string[];
  humanConfirmed: { completed: number; failed: number }; measuredModes: UserMode[]; notes: string[];
}
/** Per card: what each user side achieved. The value of the reactive user is the cards only it completed or only it failed. */
export function modeValue(record: Experiment): ModeValue {
  record = observedRecord(record);
  const reviews = latestHumanReviews(record);
  const measuredModes = [...record.settings.userModes];
  const cards = record.scenarios.map(scenario => {
    const outcomes: ModeValue['cards'][number]['outcomes'] = {};
    for (const mode of measuredModes) {
      if (mode === 'scripted' && scenario.user.script === undefined) continue;
      const trials = record.trials.filter(t => t.scenarioId === scenario.id && t.userMode === mode);
      if (!trials.length) { outcomes[mode] = 'missing'; continue; }
      const results = trials.map(t => automaticTrialResult(scenario, t));
      outcomes[mode] = results.includes('fail') ? 'fail' : results.includes('unknown') ? 'unknown' : 'pass';
    }
    const clarification = record.trials.some(t => t.scenarioId === scenario.id && t.userMode === 'reactive' && t.events.filter(e => e.type === 'user').length > 1);
    return { scenarioId: scenario.id, title: scenario.title, familyId: scenario.familyId, outcomes, clarification };
  });
  const others = (card: ModeValue['cards'][number]) => Object.entries(card.outcomes).filter(([mode]) => mode !== 'reactive').map(([, outcome]) => outcome);
  const reactiveOnlyCompleted = cards.filter(c => c.outcomes.reactive === 'pass' && others(c).length > 0 && others(c).every(o => o === 'fail')).map(c => c.scenarioId);
  const reactiveOnlyFailed = cards.filter(c => c.outcomes.reactive === 'fail' && others(c).length > 0 && others(c).every(o => o === 'pass')).map(c => c.scenarioId);
  const confirmed = (ids: string[], verdict: 'pass' | 'fail') => ids.filter(id => record.trials.some(t => t.scenarioId === id && t.userMode === 'reactive' && reviews.get(`${t.id}|dialogue`)?.verdict === verdict)).length;
  const notes: string[] = [];
  if (measuredModes.length < 2) notes.push('Измерен один режим пользователя: ценность симулятора сравнивать не с чем.');
  if (cards.some(c => Object.values(c.outcomes).includes('unknown'))) notes.push('Карточки с неопределённым исходом не входят в списки «только реактивный».');
  return { cards, reactiveOnlyCompleted, reactiveOnlyFailed, humanConfirmed: { completed: confirmed(reactiveOnlyCompleted, 'pass'), failed: confirmed(reactiveOnlyFailed, 'fail') }, measuredModes, notes };
}
