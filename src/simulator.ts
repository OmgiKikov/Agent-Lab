import { isCardExecution, simulatorWasUsed, type Scenario, type SimulatorCheck, type Trial } from './contracts.js';
import { valueTokens } from './verbatim.js';

/*
 * Heuristic checks over the simulated user's own replies. They answer three questions the judge
 * can miss: did the user say a value only the backend knows (leak), did it
 * say a value that exists nowhere in its card or the conversation (fabrication, a heuristic),
 * did it repeat itself (loop). Results describe the simulator, never the agent, and are never
 * shown to the judge so that they cannot bias its verdict. They belong to the free simulator of first-format cards
 * (SIMULATOR_PROTOCOL, part of the evaluator version) and run again when a stored run is re-assessed, so how they
 * read text is frozen; a card's customer says only harness text and is never checked.
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
  // Every word of a compiled card's customer is harness text (card/compile.ts): there is nothing to suspect.
  if (!simulatorWasUsed(trial) || isCardExecution(scenario.execution)) return [];
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
