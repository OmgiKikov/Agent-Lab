/*
 * Whether a model's endpoint can be reached from this network, asked before a run's first paid call: one HEAD request
 * with a short deadline, through the same fetch the providers' requests take. Any HTTP answer — even 401 or 404 —
 * means the network reaches it; a refused connection, an unknown host, a certificate this process does not trust, or
 * silence means it does not. No model request is made, so nothing is billed.
 */

/** How long an endpoint is given to answer. */
export const REACH_MS = 5_000;

/** Whether `url` answers at all within `deadlineMs`; a stop of `signal` is thrown, never read as unreachable. */
export async function endpointAnswers(url: string, signal: AbortSignal, deadlineMs = REACH_MS): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(deadlineMs)]) });
    await response.body?.cancel();
    return true;
  } catch {
    signal.throwIfAborted();
    return false;
  }
}
