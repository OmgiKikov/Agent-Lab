import type { Analysis } from './schema';

/** A saved batch intent is not yet its receipt; keep the card/run references fresh through dispatch. */
export function analysisNeedsRefresh(job: Analysis): boolean {
  if (['planning','judging'].includes(job.status)) return true;
  if (job.status !== 'done' || !job.agentId || job.workflowError) return false;
  const batch=job.batches?.at(-1);
  return !batch || ['preparing','dispatching'].includes(batch.status);
}
