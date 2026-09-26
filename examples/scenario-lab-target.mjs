/** Deliberately small developer-authored target. No provider or private data is used. */
export function createSession(input) { return session(input, false); }
export function createFixedSession(input) { return session(input, true); }
/** A candidate that fixes the repeated question and breaks its neighbour: it explains the refund without asking for a number it was never given. */
export function createRegressedSession(input) { return session(input, 'regressed'); }
/**
 * The baseline asks again for a terminal number it was already given; the fixed version explains the refund at once.
 * Both remember the number the customer named in this conversation and say it when asked — what the connection exam
 * checks memory and isolation by (src/demo.ts).
 */
function session(input, fixed) {
  let askedNumber = false;
  let terminal;
  return { async respond(message) {
    const named = /терминала:\s*(\d+)/i.exec(message);
    if (named) terminal = named[1];
    if (/какой у меня терминал/i.test(message)) {
      return { reply: terminal ? `Ваш терминал: ${terminal}.` : 'Уточните номер терминала.', records: input.initialState.records, resetConfirmed: true, eventsComplete: true, version: fixed === 'regressed' ? 'demo-regressed-v1' : fixed ? 'demo-fixed-v1' : 'demo-baseline-v1' };
    }
    const known = !!named;
    const reply = fixed === 'regressed' || known && (fixed || askedNumber) ? 'Возврат возможен. Подайте заявление в поддержку.' : 'Уточните номер терминала.';
    askedNumber ||= !known;
    return { reply, records: input.initialState.records, resetConfirmed: true, eventsComplete: true, version: fixed === 'regressed' ? 'demo-regressed-v1' : fixed ? 'demo-fixed-v1' : 'demo-baseline-v1' };
  } };
}
