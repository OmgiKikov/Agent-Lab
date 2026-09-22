// Test fixture for the module target: the appointment assistant of the retired built-in demo, now an external agent.
// It reports its tool events and the records it holds, so exact state and tool checks of old cards are measured.
export function createSession(input) { return session(input, false); }
/** The same agent with the update tool it was missing. */
export function createRepairedSession(input) { return session(input, true); }

function session({ initialState }, canUpdate) {
  const records = structuredClone(initialState.records);
  let transient = initialState.transientFailures ?? 0;
  let recordId, time;
  return { async respond(message) {
    const events = [];
    const answer = reply => ({ reply, events, records: structuredClone(records), resetConfirmed: true, eventsComplete: true });
    recordId = message.match(/\bA\d{3}\b/)?.[0] ?? recordId;
    time = message.match(/\b(?:[01]\d|2[0-3]):[0-5]\d\b/g)?.at(-1) ?? time;
    if (!recordId) return answer('What is your appointment ID?');
    events.push({ tool: 'search_materials', args: { query: 'appointment policy' }, result: { ok: true } });
    const record = Object.hasOwn(records, recordId) ? records[recordId] : undefined;
    events.push({ tool: 'lookup_record', args: { recordId }, result: record ? { ok: true, recordId, record: structuredClone(record) } : { ok: false, error: 'Record not found', retryable: false } });
    if (!record) return answer('I could not find your appointment.');
    if (/do not change|current time|what time/i.test(message)) return answer(`Appointment ${recordId} is at ${String(record.time)}. I have not changed it.`);
    if (!time) return answer('What is your desired time?');
    if (!canUpdate) return answer('I cannot update this appointment because the update tool is unavailable.');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const args = { recordId, changes: { time } };
      if (transient > 0) {
        transient -= 1;
        events.push({ tool: 'update_record', args, result: { ok: false, error: 'Temporary update failure; retry is safe', retryable: true } });
        continue;
      }
      record.time = time;
      events.push({ tool: 'update_record', args, result: { ok: true, recordId, record: structuredClone(record) } });
      return answer(`Appointment ${recordId} has been moved to ${time}.`);
    }
    return answer('The appointment update is temporarily unavailable; I cannot confirm a change.');
  } };
}
