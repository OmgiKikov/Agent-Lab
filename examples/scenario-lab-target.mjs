/** Deliberately small developer-authored target. No provider or private data is used. */
export function createSession(input) { return session(input, false); }
export function createFixedSession(input) { return session(input, true); }
function session(input, fixed) {
  const request = input.diagnosticRequest;
  const injectedRule = request?.arm === 'intervention' && request.intervention?.kind === 'rag-fragment' ? request.intervention.content : '';
  return { async respond(message) {
    const followsRule = fixed || injectedRule.includes('не запрашивайте его повторно');
    const known = /терминала:\s*\d+/i.test(message);
    return { reply: known && followsRule ? 'Возврат возможен. Подайте заявление в поддержку.' : 'Уточните номер терминала.',
      records: input.initialState.records, resetConfirmed: true, eventsComplete: true, version: fixed ? 'demo-fixed-v1' : 'demo-baseline-v1',
      ...(request ? { diagnosticReceipt: { protocol: request.protocol, requestHash: request.requestHash, arm: request.arm, factorHash: request.factorHash, appliedCount: injectedRule ? 1 : 0 } } : {}),
    };
  } };
}
