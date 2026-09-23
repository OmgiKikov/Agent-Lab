import { CHECKPOINT_PROTOCOL, checkSchema, fingerprint, isCardExecution, type Scenario, type Trial, type TraceEvent, type VariantExecution } from './contracts.js';
import { judgedByCheckpoints } from './card/legacy-v1.js';
import type { Checkpoint } from './scenario-contracts.js';

/*
 * The frozen read path of first-format runs judged by the checkpoint judge. Nothing writes checkpoint
 * verdicts any more: a first-format card is judged through the projection (card/legacy-v1.ts). The
 * stored verdicts keep their rule — every required checkpoint, then the `library_required` rubric — and
 * their receipts keep verifying against the input rebuilt here, byte for byte as it was hashed.
 */

type VariantScenario = Scenario & { execution: VariantExecution };
/** A first-format card whose attempt carries a checkpoint verdict. */
const checkpointJudged = (scenario: Scenario | undefined, trial: Trial): scenario is VariantScenario =>
  !!scenario?.execution && !isCardExecution(scenario.execution) && judgedByCheckpoints(trial);

const channelEvents = (cp: Checkpoint, trial: Trial): TraceEvent[] => trial.events.filter(e => cp.observation === 'reply' ? e.type === 'assistant'
  : cp.observation === 'tool' ? e.type === 'tool_call' || e.type === 'tool_result' || e.type === 'observation' : e.state !== undefined || e.type === 'tool_result');
const toolContext = (scenario:VariantScenario, cp:Checkpoint, trial:Trial) => scenario.execution.checkpointContext==='observed-tools-v1' && cp.observation==='reply' ? trial.events.filter(e=>e.type==='tool_call'||e.type==='tool_result') : [];
function missingObservation(cp: Checkpoint, trial: Trial): string | undefined {
  if (cp.observation === 'tool' && (!trial.observation || trial.observation.tools === 'partial')) return 'Полнота событий инструментов не подтверждена';
  if (cp.observation === 'state' && (!trial.observation || trial.observation.state === 'missing')) return 'Итоговое состояние не наблюдалось';
  if (cp.observation === 'state' && trial.observation?.state !== 'sandbox' && trial.observation?.resetConfirmed !== true) return 'Сброс состояния не подтверждён';
}
/** The checkpoint judge's input as its receipts hashed it: no prior verdicts, simulator decisions or hidden state outside the declared channel. */
function checkpointInput(scenario: VariantScenario, trial: Trial) {
  const view = scenario.execution.evaluatorView;
  return {
    protocol: CHECKPOINT_PROTOCOL,
    checkpoints: view.checkpoints.map(checkpoint => ({ checkpoint, requirement: view.requirements.find(r => r.id === checkpoint.requirementId),
      dialogue: trial.events.filter(e => e.type === 'user' || e.type === 'assistant').map(({ seq, type, text }) => ({ seq, type, text })),
      evidence: channelEvents(checkpoint, trial).map(({ seq, type, text, tool, args, result, state }) => ({ seq, type, text, tool, args, result, ...(checkpoint.observation === 'state' && state ? { state } : {}) })),
      allowedEvidence: channelEvents(checkpoint, trial).map(e => e.seq),
      ...(scenario.execution.checkpointContext==='observed-tools-v1' && checkpoint.observation==='reply'?{context:toolContext(scenario,checkpoint,trial).map(({seq,type,text,tool,args,result})=>({seq,type,...(text===undefined?{}:{text}),...(tool===undefined?{}:{tool}),...(args===undefined?{}:{args}),...(result===undefined?{}:{result})}))}:{}),
      applicabilityEvidence: trial.events.filter(e => ['user', 'assistant'].includes(e.type)||toolContext(scenario,checkpoint,trial).some(c=>c.seq===e.seq)).map(e => e.seq),
      observation: trial.observation ?? { state: 'missing', tools: 'partial' },
      ...(checkpoint.observation === 'state' && !missingObservation(checkpoint, trial) ? { state: trial.finalState } : {}),
    })),
  };
}

/** The frozen checkpoint half of a first-format verdict; undefined for an attempt that carries no checkpoint verdict. */
export function requiredCheckpointResult(scenario: Scenario | undefined, trial: Trial): 'pass' | 'fail' | 'unknown' | undefined {
  if (!checkpointJudged(scenario, trial)) return undefined;
  if (trial.checkpointReceipt && !checkpointReceiptValid(scenario, trial)) return 'unknown';
  const required = scenario.execution.evaluatorView.checkpoints.filter(c => c.role === 'required');
  const results = required.map(c => trial.checkpoints?.find(r => r.checkpointId === c.id && r.requirementId === c.requirementId)?.result ?? 'unknown');
  return results.includes('fail') ? 'fail' : results.every(r => r === 'pass' || r === 'not_applicable') ? 'pass' : 'unknown';
}

/**
 * The checks an attempt was graded with directly. The checkpoint judge applied a checkpoint's exact check
 * only where the checkpoint applied, so its attempts were graded without them; every other attempt —
 * a card's, a first-format card's through the projection — is graded with all of them.
 */
export function directChecks(scenario: Scenario, trial: Trial) {
  if (!checkpointJudged(scenario, trial)) return scenario.checks;
  const ids = scenario.execution.evaluatorView.checkpoints.flatMap(cp => { const check = checkSchema.safeParse(cp.check); return check.success ? [check.data.id] : []; });
  return scenario.checks.filter(check => !ids.includes(check.id));
}
/** A stored checkpoint verdict is trusted only with its receipt rebuilt from the record; an attempt without one needs none. */
export function checkpointReceiptValid(scenario: Scenario, trial: Trial): boolean {
  if (!checkpointJudged(scenario, trial)) return true;
  const receipt = trial.checkpointReceipt;
  return !!receipt && !!trial.checkpoints && receipt.protocolHash === scenario.execution.checkpointHash
    && receipt.inputHash === fingerprint(checkpointInput(scenario, trial))
    && receipt.resultHash === fingerprint(trial.checkpoints) && receipt.decisionHash === fingerprint(receipt.decisions);
}
