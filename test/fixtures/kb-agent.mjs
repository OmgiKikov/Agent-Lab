// Test fixture for the tool channel: a refund agent that searches its knowledge base before every answer and says so
// in its tool journal. `createSession` declares the journal complete and names its tool; `createPartialSession` does not.
export function createSession() { return session(true); }
export function createPartialSession() { return session(false); }

function session(complete) {
  let askedNumber = false;
  return { async respond(message) {
    const known = /терминала:\s*\d+/i.test(message);
    const reply = known && askedNumber ? 'Возврат возможен. Подайте заявление в поддержку.' : 'Уточните номер терминала.';
    askedNumber ||= !known;
    const events = [{ tool: 'kb_search', args: { query: 'возврат оплаты' }, result: { found: ['Правила возвратов'] } }];
    return complete ? { reply, events, eventsComplete: true, eventScope: ['kb_search'] } : { reply, events };
  } };
}
