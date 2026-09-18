import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInputSchema } from '../../src/contracts.js';
import { createDemoRuntime, demoEvaluationInput } from '../../src/demo.js';
import { draftHash, ExperimentLab } from '../../src/experiment.js';

/** A finished built-in demo evaluation. The caller owns cleanup. */
export async function demoEvaluateRecord(prefix = 'agent-lab-demo-record-') {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const lab = new ExperimentLab(join(directory, 'runs'), createDemoRuntime());
  await lab.init();
  const base = demoEvaluationInput();
  const input = createInputSchema.parse({ ...base, scenarioCount: 2,
    settings: { ...base.settings, maxCalls: 20, maxDurationMs: 180000 } });
  const draft = await lab.create(input); await lab.waitForIdle();
  await lab.start(draft.id, { approved: true, reviewer: 'automated', expectedHash: draftHash(await lab.get(draft.id)) }); await lab.waitForIdle();
  return { lab, directory, record: await lab.get(draft.id) };
}
