import { isCardExecution, simulatorWasUsed, type Scenario, type SimulatorCheck, type Trial } from './contracts.js';
import { valueTokens } from './verbatim.js';
import { CARD_CUSTOMER_PROTOCOLS } from './card-customer.js';

/*
 * Heuristic checks over the simulated user's own replies. They answer three questions the judge
 * can miss: did the user say a value only the backend knows (leak), did it
 * say a value that exists nowhere in its card or the conversation (fabrication, a heuristic),
 * did it repeat itself (loop). Results describe the simulator, never the agent, and are never
 * shown to the judge so that they cannot bias its verdict. They apply to free simulators, including free card
 * customers. Fixed controller messages are harness text and remain outside these heuristic checks.
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
  const known = knownText(scenario.user).toLowerCase();
  const values = [...leaves(scenario.initialState.records), ...leaves(scenario.initialState.external)].map(v => v.toLowerCase());
  return [...new Set(values.filter(v => !mentions(known, v)))];
}
const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export function simulatorChecks(scenario: Scenario, trial: Trial): SimulatorCheck[] {
  // Fixed controller messages are harness text. Free card customers need the same retrospective
  // checks as other reactive actors, in addition to the semantic fidelity rubric.
  const freeCard = trial.events.some(event => event.type === 'simulator' && event.result !== null
    && typeof event.result === 'object' && 'protocol' in event.result && typeof event.result.protocol === 'string'
    && (CARD_CUSTOMER_PROTOCOLS as readonly string[]).includes(event.result.protocol));
  if (!simulatorWasUsed(trial) || isCardExecution(scenario.execution) && !freeCard) return [];
  const users = trial.events.filter(e => e.type === 'user');
  const simulated = users.slice(1);
  if (!simulated.length) return [];
  // An agent's turn is its text and the buttons it offered: a pressed button's value was said by the agent.
  const turnText = (e: Trial['events'][number]) => {
    const buttons = e.type === 'assistant' && e.result && typeof e.result === 'object' && Array.isArray((e.result as { buttons?: unknown }).buttons)
      ? (e.result as { buttons: { text?: unknown }[] }).buttons.map(button => String(button.text ?? '')) : [];
    return [e.text ?? '', ...buttons].join('\n');
  };
  const textBefore = (seq: number, types: string[]) => trial.events.filter(e => types.includes(e.type) && e.seq < seq).map(turnText).join('\n');
  const checks: SimulatorCheck[] = [];

  const hidden = hiddenLiterals(scenario);
  if (hidden.length) {
    let leak: { seq: number; value: string } | undefined;
    for (const message of simulated) {
      const said = (message.text ?? '').toLowerCase();
      const revealed = textBefore(message.seq, ['assistant']).toLowerCase();
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
