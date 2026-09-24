import { chmod, copyFile, mkdtemp, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { experimentSchema, fingerprint, settingsSchema, type Experiment, type RunnableTarget, type Settings, type Target } from '../../src/contracts.js';
import type { MetricAssessment, Rubric } from '../../src/assessment.js';
import type { CallContext, Runtime } from '../../src/runtime.js';
import { hostGrant } from '../../src/card/commands.js';
import { situationViews } from '../../src/card/view.js';
import { demoInput } from '../../src/demo.js';
import { ExperimentLab } from '../../src/experiment.js';
import { libraryHash } from '../../src/scenario-library.js';
import { evaluatorVersion } from '../../src/pi.js';
import { targetFingerprint } from '../../src/target-version.js';

/*
 * Records of the retired built-in demo (an appointment assistant, a free LLM user simulator, cards
 * without an `execution` block), written by the code that could still make them:
 *   legacy-demo-run.json (+ .trace.jsonl)  a finished two-card run against the retired sandbox
 *   legacy-demo-draft.json                 a ten-card draft of the same demo, not yet run
 * Old records must keep opening, reassessing and running on a new agent version; these fixtures
 * are how the tests hold the product to that.
 */
const fixture = async (name: string) => JSON.parse(await readFile(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));

/** The same checks the retired demo judged with; a deterministic stand-in, never a model. */
export const legacyDemoMetrics: Rubric[] = [
  { id: 'demo_task_state', name: 'Task outcome (scripted estimate)', subject: 'agent',
    description: 'A deterministic demo estimate from the objective checks, not a semantic model judgment.',
    passCriteria: 'Every approved objective check passes in the completed dialogue.', failCriteria: 'At least one approved objective check fails.' },
  { id: 'demo_follow_ups', name: 'Interaction budget (scripted estimate)', subject: 'simulator',
    description: 'A narrow count and delivery check, not an assessment of human realism or full role fidelity.',
    passCriteria: 'The assigned follow-up budget is respected, and every nonempty terminal simulator message is delivered to the agent.',
    failCriteria: 'The assigned follow-up budget is exceeded or a nonempty terminal simulator message is discarded.' },
];

function call(ctx: CallContext) {
  ctx.signal.throwIfAborted();
  ctx.beforeCall();
  ctx.addUsage({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
}

/** The free user simulator and the judge of the retired demo, ported verbatim: what old records were run and judged with. */
export function legacyDemoRuntime(): Runtime {
  return {
    async assess({ scenario, trial }, ctx) {
      call(ctx);
      return (scenario.metrics ?? []).map((metric): MetricAssessment => {
        const supported = legacyDemoMetrics.find(sample => fingerprint(sample) === fingerprint(metric));
        if (!supported) return { metricId: metric.id, result: 'unknown', rationale: 'The scripted demo cannot assess custom or edited rubrics. Use live mode or human review.', evidence: [] };
        if (metric.id === 'demo_task_state') {
          const evidence = trial.events.filter(event => event.type === 'tool_result' || event.type === 'assistant').slice(-30).map(event => event.seq);
          return { metricId: metric.id, result: !trial.checks.length || !evidence.length ? 'unknown' : trial.checks.every(check => check.passed) ? 'pass' : 'fail',
            rationale: 'Scripted estimate from the recorded objective checks. It does not independently assess meaning, truthfulness, or user satisfaction.', evidence };
        }
        const decisions = trial.events.filter(event => event.type === 'simulator');
        if (!decisions.length) return { metricId: metric.id, result: 'unknown', rationale: 'No simulator follow-up was requested; dynamic delivery was not exercised.', evidence: [] };
        const followUps = trial.events.filter(event => event.type === 'user').slice(1);
        const dropped = decisions.some(event => {
          const decision = event.result as { done: boolean; message: string };
          return decision.done && decision.message.trim() && !followUps.some(reply => reply.seq > event.seq && reply.text === decision.message);
        });
        const exceeded = scenario.user.maxFollowUps !== undefined && followUps.length > scenario.user.maxFollowUps;
        return { metricId: metric.id, result: dropped || exceeded ? 'fail' : 'pass',
          rationale: `Scripted delivery check: ${followUps.length} follow-up(s), ${dropped ? 'a discarded terminal message' : 'no discarded terminal message'}. This does not establish realistic user behavior.`,
          evidence: [...decisions, ...followUps].map(event => event.seq).sort((a, b) => a - b).slice(-30) };
      });
    },
    async userTurn({ user, messages, turn }, ctx) {
      call(ctx);
      const answer = messages.at(-1)?.content ?? '';
      const reply = (topic: RegExp, fallback: string) => user.answers?.find(a => topic.test(a.ifAsked))?.reply ?? fallback;
      if (/what is your appointment id/i.test(answer)) return { message: reply(/appointment id/i, `My appointment ID is ${user.facts.match(/\bA\d{3}\b/)?.[0] ?? 'unknown'}.`), done: false };
      if (/what is your desired time/i.test(answer)) return { message: reply(/desired time/i, `My desired time is ${user.facts.match(/\b(?:[01]\d|2[0-3]):[0-5]\d\b/)?.[0] ?? 'unknown'}.`), done: false };
      if (turn === 0 && /change preference once/i.test(user.behavior)) {
        return { message: `Actually, please move it to ${user.behavior.match(/\b(?:[01]\d|2[0-3]):[0-5]\d\b/)?.[0]} instead.`, done: false };
      }
      return { message: '', done: true };
    },
  };
}

/** The retired demo's appointment assistant as an external module agent; `createSession` still lacks the update tool, `createRepairedSession` has it. */
export function appointmentAgent(exportName: 'createSession' | 'createRepairedSession' = 'createSession'): RunnableTarget {
  return { kind: 'module', path: fileURLToPath(new URL('../fixtures/appointment-agent.mjs', import.meta.url)), exportName };
}

/** A finished run of the retired demo. The caller owns cleanup. */
export async function demoEvaluateRecord(prefix = 'agent-lab-demo-record-') {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const lab = new ExperimentLab(join(directory, 'runs'), legacyDemoRuntime());
  await lab.init();
  const record = experimentSchema.parse(await fixture('legacy-demo-run.json'));
  await lab.store.save(record);
  const trace = join(lab.store.directory, `${record.id}.trace.jsonl`);
  await copyFile(new URL('../fixtures/legacy-demo-run.trace.jsonl', import.meta.url), trace);
  await chmod(trace, 0o600);
  return { lab, directory, record: await lab.get(record.id) };
}

/**
 * A draft of old-format cards (no `execution` block) ready to start against an external agent:
 * the first `count` cards of the retired demo, in its order. It runs through the free user simulator.
 */
export async function legacyDraft(lab: ExperimentLab, options: { count?: number; settings?: Partial<Settings>; target?: Target } = {}): Promise<Experiment> {
  const record = experimentSchema.parse(await fixture('legacy-demo-draft.json'));
  const now = new Date().toISOString();
  record.id = randomUUID(); record.createdAt = now; record.updatedAt = now;
  record.scenarios = record.scenarios.slice(0, options.count ?? 3);
  record.settings = settingsSchema.parse({ ...record.settings, ...options.settings });
  record.target = options.target ?? appointmentAgent();
  record.targetFingerprint = await targetFingerprint(record.target);
  record.evaluatorVersion = evaluatorVersion(record.settings);
  record.limitations = record.limitations.filter(note => !note.startsWith('Tools operate on isolated test records'));
  await lab.store.save(record);
  return lab.get(record.id);
}

/** The built-in example's situations with their status now. */
async function demoSituations(lab: ExperimentLab, id: string) {
  const context = await lab.cardContext(id);
  return { library: context.library, views: situationViews(context.experiment, { evidence: context.evidence, maxTurns: context.experiment.settings.maxTurns }) };
}

/**
 * The built-in example up to an accepted draft, as the owner takes it: two situations prepared from its two dialogues,
 * its one question answered («клиент знал номер»), every ready situation accepted. The lab needs the demo runtime
 * (injected `createDemoRuntime()`, or none for a demo-mode record).
 */
export async function acceptedDemoDraft(lab: ExperimentLab, input = demoInput()): Promise<Experiment> {
  const draft = await lab.create(input); await lab.waitForIdle();
  for (const view of (await demoSituations(lab, draft.id)).views) if (view.question?.id) {
    const answer = await lab.prepareCardCommand(draft.id, { kind: 'answer_question', cardId: view.id, questionId: view.question.id, choice: 'a' }, { via: 'cli-yes' });
    await lab.applyCardCommand(draft.id, answer, hostGrant(answer, 'confirmed'));
  }
  const answered = await demoSituations(lab, draft.id);
  const ready = answered.views.filter(view => view.status === 'ready').map(view => view.id);
  return (await lab.acceptCards(draft.id, libraryHash(answered.library), ready)).experiment;
}

/** The example's situation made from one of its dialogues: `known` names the number at once, `late` only when asked. */
export function demoCard(record: Experiment, dialogue: 'known' | 'late'): string {
  const library = record.librarySnapshot;
  const card = library?.formatVersion === 2 ? library.cards.find(item => item.origin.kind === 'dialogue' && item.origin.dialogueId === dialogue) : undefined;
  if (!card) throw new Error(`В записи нет ситуации учебного примера из диалога «${dialogue}».`);
  return card.id;
}
