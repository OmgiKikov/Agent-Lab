import { simulatorWasUsed, valueTokens, type Scenario, type SimulatorCheck, type Trial } from './contracts.js';

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
