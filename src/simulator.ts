import { metricApplies, simulatorWasUsed, valueTokens, SIMULATOR_CHECK_IDS, type Experiment, type Scenario, type SimulatorCheck, type SimulatorCheckId, type Trial, type UserMode } from './contracts.js';
import { automaticTrialResult, latestHumanReviews, measured, observedRecord } from './outcomes.js';

/*
 * Heuristic checks over the simulated user's own replies. They answer three questions the judge is
 * can miss: did the user say a value only the backend knows (leak), did it
 * say a value that exists nowhere in its card or the conversation (fabrication, a heuristic),
 * did it repeat itself (loop). Results describe the simulator, never the agent, and are never
 * shown to the judge so that they cannot bias its verdict.
 */
// ponytail: literal boundaries detect suspicious mentions, not their meaning; human review resolves context.
function mentions(text: string, value: string): boolean {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'iu').test(text);
}
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
  return [...new Set(values.filter(v => !mentions(known, v)))];
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
      const value = hidden.find(h => mentions(said, h) && !mentions(revealed, h));
      if (value) { leak = { seq: message.seq, value }; break; }
    }
    checks.push({ id: 'simulator_leak', heuristic: true, passed: !leak, ...(leak ? { seq: leak.seq } : {}),
      description: 'Упоминание скрытого значения до его раскрытия (эвристика)',
      evidence: leak ? `Подозрение: реплика #${leak.seq} содержит скрытое значение «${leak.value}», которого агент ещё не называл.` : `Скрытых значений: ${hidden.length}; ни одно не прозвучало раньше агента.` });
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
    const text = normalize(message.text ?? '');
    const prompt = trial.events.findLast(e => e.type === 'assistant' && e.seq < message.seq)?.text;
    if (text.length < 3 || !prompt) continue;
    const key = `${normalize(prompt)}|${text}`;
    const earlier = seen.get(key);
    if (earlier !== undefined && message.seq !== users[0]!.seq) { loop = { seq: message.seq, earlier }; break; }
    seen.set(key, message.seq);
  }
  checks.push({ id: 'simulator_loop', heuristic: true, passed: !loop, ...(loop ? { seq: loop.seq } : {}),
    description: 'Повтор пары ответ агента → реплика пользователя (эвристика)',
    evidence: loop ? `Подозрение: реплика #${loop.seq} повторяет реплику #${loop.earlier} после такого же ответа агента.` : 'Повторов реплик нет.' });
  return checks;
}

export interface SimulatorSummary {
  reactiveDialogues: number;
  execution: { planned: number; started: number; completed: number; invalid: number; cancelled: number };
  checks: { id: SimulatorCheckId; dialogues: number; flagged: number; heuristic: boolean; examples: { trialId: string; seq?: number; evidence: string }[] }[];
  judge: { applicable: number; pass: number; fail: number; unknown: number; missing: number };
  human: { reviewed: number; confirmed: number; rejected: number; newFindings: number };
  continuations: number;
  stoppedWithoutSuccess: number; notes: string[];
}
/** Everything the run recorded about the simulated user: code checks, judge fidelity, human verdicts, and observed continuations (not semantic answers to questions). */
export function simulatorSummary(record: Experiment): SimulatorSummary {
  record = observedRecord(record);
  const reviews = latestHumanReviews(record);
  const reactive = record.trials.filter(t => t.userMode === 'reactive');
  const execution = { planned: record.settings.userModes.includes('reactive') ? (record.assessmentTrialIds ? reactive.length : record.scenarios.length * record.settings.repeats) : 0,
    started: reactive.length, completed: reactive.filter(measured).length, invalid: reactive.filter(t => t.outcome === 'invalid').length, cancelled: reactive.filter(t => t.outcome === 'cancelled').length };
  const scenarioOf = (t: Trial) => record.scenarios.find(s => s.id === t.scenarioId);
  const checks = SIMULATOR_CHECK_IDS.map(id => {
    const withCheck = reactive.filter(t => t.simulatorChecks?.some(c => c.id === id));
    const flagged = withCheck.filter(t => t.simulatorChecks!.some(c => c.id === id && !c.passed));
    return { id, dialogues: withCheck.length, flagged: flagged.length, heuristic: true,
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
  const human = { reviewed: 0, confirmed: 0, rejected: 0, newFindings: 0 };
  for (const t of reactive) for (const review of reviews.values()) {
    if (review.trialId !== t.id || !(review.verdict === 'pass' || review.verdict === 'fail')) continue;
    const onSimulatorMetric = !!review.metricId && !!scenarioOf(t)?.metrics?.some(m => m.id === review.metricId && m.subject === 'simulator');
    const onSimulatorCheck = !!review.checkId && (SIMULATOR_CHECK_IDS as readonly string[]).includes(review.checkId);
    if (!onSimulatorMetric && !onSimulatorCheck) continue;
    human.reviewed++;
    const flagged = review.checkId ? t.simulatorChecks?.some(c => c.id === review.checkId && !c.passed)
      : t.assessments?.some(a => a.metricId === review.metricId && a.result === 'fail');
    if (flagged) { if (review.verdict === 'fail') human.confirmed++; else human.rejected++; }
    else if (review.verdict === 'fail') human.newFindings++;
  }
  const continuations = reactive.filter(t => t.events.filter(e => e.type === 'user').length > 1).length;
  const stoppedWithoutSuccess = reactive.filter(t => {
    const last = t.events.filter(e => e.type === 'simulator').at(-1)?.result as { done?: boolean; message?: string } | undefined;
    return !!last?.done && !(last.message ?? '').trim() && automaticTrialResult(scenarioOf(t), t, record.humanReviews) !== 'pass';
  }).length;
  const notes: string[] = [];
  if (!reactive.length) notes.push('Реактивных диалогов нет: симулятор не участвовал.');
  else if (!judge.applicable) notes.push('Рубрика верности симулятора не применялась.');
  if (checks.some(c => c.flagged && c.heuristic)) notes.push('Кодовые пометки — подозрения, а не доказанные ошибки; подтвердите или опровергните их по трассе.');
  return { reactiveDialogues: reactive.filter(simulatorWasUsed).length, execution, checks, judge, human, continuations, stoppedWithoutSuccess, notes };
}

export interface ModeValue {
  cards: { scenarioId: string; title: string; familyId: string; outcomes: Partial<Record<UserMode, 'pass' | 'fail' | 'unknown' | 'missing'>>; continued: boolean }[];
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
      const expected = record.assessmentTrialIds ? trials.map(t => t.repeat) : Array.from({ length: record.settings.repeats }, (_, i) => i);
      const complete = trials.length === expected.length && expected.every(repeat => trials.filter(t => t.repeat === repeat).length === 1);
      const results = trials.map(t => automaticTrialResult(scenario, t, record.humanReviews));
      if (!complete) results.push('unknown');
      outcomes[mode] = results.includes('unknown') ? 'unknown' : results.includes('fail') ? 'fail' : 'pass';
    }
    const continued = record.trials.some(t => t.scenarioId === scenario.id && t.userMode === 'reactive' && t.events.filter(e => e.type === 'user').length > 1);
    return { scenarioId: scenario.id, title: scenario.title, familyId: scenario.familyId, outcomes, continued };
  });
  const others = (card: ModeValue['cards'][number]) => Object.entries(card.outcomes).filter(([mode]) => mode !== 'reactive').map(([, outcome]) => outcome);
  const reactiveOnlyCompleted = cards.filter(c => c.outcomes.reactive === 'pass' && others(c).length > 0 && others(c).every(o => o === 'fail')).map(c => c.scenarioId);
  const reactiveOnlyFailed = cards.filter(c => c.outcomes.reactive === 'fail' && others(c).length > 0 && others(c).every(o => o === 'pass')).map(c => c.scenarioId);
  const confirmed = (ids: string[], verdict: 'pass' | 'fail') => ids.filter(id => {
    const trials = record.trials.filter(t => t.scenarioId === id && t.userMode === 'reactive');
    return verdict === 'pass' ? trials.every(t => reviews.get(`${t.id}|dialogue`)?.verdict === 'pass')
      : trials.some(t => automaticTrialResult(record.scenarios.find(s => s.id === id), t, record.humanReviews) === 'fail' && reviews.get(`${t.id}|dialogue`)?.verdict === 'fail');
  }).length;
  const notes: string[] = [];
  if (measuredModes.length < 2) notes.push('Измерен один режим пользователя: ценность симулятора сравнивать не с чем.');
  if (cards.some(c => Object.values(c.outcomes).includes('unknown'))) notes.push('Карточки с неопределённым исходом не входят в списки «только реактивный».');
  return { cards, reactiveOnlyCompleted, reactiveOnlyFailed, humanConfirmed: { completed: confirmed(reactiveOnlyCompleted, 'pass'), failed: confirmed(reactiveOnlyFailed, 'fail') }, measuredModes, notes };
}

/** Shared plain text; each surface escapes at its own output boundary. */
export function simulatorSummaryLines(s: SimulatorSummary): string[] {
  return [`Реактивных диалогов: начато ${s.execution.started}/${s.execution.planned}, завершено ${s.execution.completed}, невалидных ${s.execution.invalid}, остановлено ${s.execution.cancelled}; симулятор участвовал в ${s.reactiveDialogues}.`,
    ...s.checks.flatMap(c => [`${c.id} (эвристика): пометок ${c.flagged}/${c.dialogues}.`, ...c.examples.map(e => `${e.trialId}${e.seq === undefined ? '' : ` #${e.seq}`}: ${e.evidence}`)]),
    `Судья · верность: pass ${s.judge.pass}, fail ${s.judge.fail}, unknown ${s.judge.unknown}, нет оценки ${s.judge.missing}; применима ${s.judge.applicable}.`,
    `Человек: решений ${s.human.reviewed}, пометок подтверждено ${s.human.confirmed}, опровергнуто ${s.human.rejected}, новых замечаний ${s.human.newFindings}.`,
    `Продолжили диалог: ${s.continuations}; остановились без подтверждённого успеха: ${s.stoppedWithoutSuccess}. Продолжение само по себе не доказывает ответ на уточнение.`, ...s.notes];
}
export function modeValueLines(value: ModeValue): string[] {
  return [`Только реактивный завершил: ${value.reactiveOnlyCompleted.join(', ') || 'нет'}; человек подтвердил ${value.humanConfirmed.completed}.`,
    `Только реактивный провалил: ${value.reactiveOnlyFailed.join(', ') || 'нет'}; человек подтвердил ${value.humanConfirmed.failed}.`,
    ...value.cards.map(c => `${c.title} [${c.scenarioId}]: ${Object.entries(c.outcomes).map(([m, o]) => `${m}=${o}`).join(' · ')}; продолжение: ${c.continued ? 'да' : 'нет'}.`),
    'Сравнение описательное: карточки одинаковые, бюджеты режимов не уравнены. Расходы показаны по режимам.', ...value.notes];
}
