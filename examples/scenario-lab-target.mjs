/** Deliberately small developer-authored target. No provider or private data is used. */
export function createSession(input) { return session(input, false); }
export function createFixedSession(input) { return session(input, true); }
/** The baseline asks again for a terminal number it was already given; the fixed version explains the refund at once. */
function session(input, fixed) {
  let askedNumber = false;
  return { async respond(message) {
    const known = /терминала:\s*\d+/i.test(message);
    const reply = known && (fixed || askedNumber) ? 'Возврат возможен. Подайте заявление в поддержку.' : 'Уточните номер терминала.';
    askedNumber ||= !known;
    return { reply, records: input.initialState.records, resetConfirmed: true, eventsComplete: true, version: fixed ? 'demo-fixed-v1' : 'demo-baseline-v1' };
  } };
}
