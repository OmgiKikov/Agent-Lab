import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createInputSchema, dialogueSchema, emptyUsage, scenarioSchema, type Dialogue, type Scenario, type Trial } from '../src/contracts.js';
import { goalAttainment, replyQuality } from '../src/assessment.js';
import { verbatimSpan } from '../src/verbatim.js';
import { judgeInput } from '../src/judge.js';

/*
 * How the corpus becomes a judge input: a recorded dialogue is a production card (its later user turns
 * are a script only when they fit one) and an immutable trial whose events are the messages themselves.
 * The converters left the product with the retired offline scoring; the corpus keeps being checked with them.
 */
function dialogueToScenario(dialogue: Dialogue, goal: string): Omit<Scenario, 'split'> {
  const userMessages = dialogue.messages.filter(message => message.role === 'user');
  const opening = userMessages[0]!.content;
  const script = userMessages.slice(1).map(message => message.content);
  const replayable = script.length <= 15;
  return {
    id: dialogue.id, familyId: dialogue.id, title: goal.slice(0, 200), requirementIds: [], provenance: 'production', tier: 'regression',
    user: { goal, facts: 'Только факты, сообщённые пользователем в записанном диалоге.',
      behavior: replayable ? 'Воспроизводить реплики пользователя из записи в исходном порядке.' : 'Полный длинный диалог хранится как неизменяемое доказательство.',
      opening, maxFollowUps: replayable ? script.length : 0, ...(replayable ? { script } : {}) },
    initialState: { records: {}, writableFields: [], transientFailures: 0 }, checks: [], goalObservation: 'reply',
    assumptions: [`Recorded dialogue ${dialogue.id}; no target or simulator execution and no observed external state.`],
    metrics: [{ ...goalAttainment }, { ...replyQuality }],
  };
}
function dialogueToTrial(dialogue: Dialogue, scenario: Scenario, revisionId: string): Trial {
  const initialState = { records: {}, writableFields: [], transientFailures: 0 };
  return {
    id: dialogue.id, revisionId, scenarioId: scenario.id, familyId: scenario.familyId, repeat: 0, userMode: 'scripted',
    split: scenario.split, manifestHash: 'unreviewed', outcome: 'ungraded', reason: 'Записанный диалог без повторного запуска агента.',
    checks: [], events: dialogue.messages.map((message, seq) => ({ seq, type: message.role, text: message.content })),
    initialState, finalState: structuredClone(initialState), usage: emptyUsage(), elapsedMs: 0,
    observation: { state: 'missing', tools: 'partial' },
  };
}

const directory = resolve('test/fixtures/score');
const expectedComposition = {
  clean_grounded: 2,
  requirement_leakage: 2,
  self_attested_action: 2,
  multi_turn_integrity: 2,
  prompt_injection: 1,
  malformed_boundary: 1,
  over_context: 1,
  conflicting_evidence: 1,
};

type ManifestCase = {
  id: string;
  category: keyof typeof expectedComposition;
  citations: { material: string; quote: string }[];
  assertions: {
    messageCount: number;
    userTurns: number;
    assistantTurns: number;
    metricIds: string[];
    runnableScript: boolean;
    storedOutcomeIsNotLabel?: boolean;
    noObservedActionEvidence?: boolean;
    importedInstructionIsEvidenceOnly?: boolean;
    omittedRangeMarker?: string;
  };
  reviewConstraint?: string;
};

test('the Phase 2 reference corpus is versioned, exact, grounded and label-free', async () => {
  const task = JSON.parse(await readFile(resolve(directory, 'task.json'), 'utf8')) as Record<string, unknown>;
  const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8')) as {
    schemaVersion: string;
    datasetVersion: string;
    expectedComposition: typeof expectedComposition;
    ownerSemanticLabels: unknown[];
    semanticAnchorCandidates: { id: string; status: string }[];
    cases: ManifestCase[];
  };
  const rawDialogues = (await readFile(resolve(directory, 'reference.jsonl'), 'utf8'))
    .split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  // The corpus is a valid import for a new draft; the agent address is never contacted here.
  const input = createInputSchema.parse({ ...task, dialogues: rawDialogues, scenarioCount: 0, target: { kind: 'http', url: 'http://127.0.0.1:1/agent' } });

  assert.equal(manifest.schemaVersion, '1');
  assert.equal(manifest.datasetVersion, 'phase2-reference-v1');
  assert.deepEqual(manifest.expectedComposition, expectedComposition);
  assert.equal(input.dialogues.length, 12);
  assert.equal(manifest.cases.length, 12);
  assert.deepEqual(manifest.ownerSemanticLabels, [], 'owner/model verdicts are not fabricated');
  assert.deepEqual(manifest.semanticAnchorCandidates.map(anchor => anchor.status), Array(4).fill('pending_owner'));
  assert.deepEqual(manifest.semanticAnchorCandidates.map(anchor => anchor.id), [
    'clean_grounded_tariff',
    'requirement_leakage_outcome',
    'self_attested_missing_state',
    'multi_turn_clarification',
  ]);

  const ids = input.dialogues.map(dialogue => dialogue.id);
  assert.equal(new Set(ids).size, 12);
  assert.deepEqual(manifest.cases.map(entry => entry.id), ids, 'manifest and JSONL order/cardinality stay one-to-one');
  assert.deepEqual(Object.fromEntries(Object.keys(expectedComposition).map(category => [
    category,
    manifest.cases.filter(entry => entry.category === category).length,
  ])), expectedComposition);

  const materials = input.materials;
  for (const [index, raw] of rawDialogues.entries()) {
    const dialogue = dialogueSchema.parse(raw);
    const entry = manifest.cases[index]!;
    const parsedScenario = scenarioSchema.safeParse(dialogueToScenario(dialogue, dialogue.goal ?? `Review ${dialogue.id}`));
    assert.ok(parsedScenario.success, `${entry.id}: ${parsedScenario.error?.message}`);
    const scenario = { ...parsedScenario.data, split: 'dev' as const };
    const trial = dialogueToTrial(dialogue, scenario, 'reference-v1');

    assert.equal(dialogue.messages.length, entry.assertions.messageCount, entry.id);
    assert.equal(dialogue.messages.filter(message => message.role === 'user').length, entry.assertions.userTurns, entry.id);
    assert.equal(dialogue.messages.filter(message => message.role === 'assistant').length, entry.assertions.assistantTurns, entry.id);
    assert.deepEqual(scenario.metrics?.map(metric => metric.id), entry.assertions.metricIds, entry.id);
    assert.deepEqual(trial.events, dialogue.messages.map((message, seq) => ({ seq, type: message.role, text: message.content })), entry.id);
    assert.deepEqual(trial.observation, { state: 'missing', tools: 'partial' }, entry.id);
    assert.equal(trial.outcome, 'ungraded', `${entry.id}: stored outcome is evidence metadata, not a score label`);
    assert.equal(trial.assessments, undefined, `${entry.id}: semantic judgments need an owner/model run`);
    const input = judgeInput({ scenario, sources: [], trial });
    assert.equal(input.scenario.goalObservation, 'reply', `${entry.id}: recorded replies have a harness-owned evidence channel`);
    assert.match(String(input.evaluationScope), /action-dependent pass conditions remain unclear/);

    const followUps = dialogue.messages.filter(message => message.role === 'user').length - 1;
    assert.equal(scenario.user.script !== undefined || followUps === 0, entry.assertions.runnableScript, entry.id);
    if (!entry.assertions.runnableScript) {
      assert.equal(followUps, 16);
      assert.equal(scenario.user.maxFollowUps, 0);
      assert.equal(scenario.user.script, undefined);
    }
    if (entry.assertions.noObservedActionEvidence) {
      assert.equal(trial.events.some(event => event.type === 'tool_call' || event.type === 'tool_result' || event.state !== undefined), false, entry.id);
      assert.match(entry.reviewConstraint ?? '', /remains unknown/);
    }
    if (entry.assertions.importedInstructionIsEvidenceOnly) {
      assert.match(dialogue.messages[0]!.content, /SYSTEM:/);
      assert.equal(trial.events[0]!.type, 'user');
    }
    if (entry.assertions.omittedRangeMarker) {
      assert.ok(trial.events.some(event => event.text === entry.assertions.omittedRangeMarker), entry.id);
      assert.match(entry.reviewConstraint ?? '', /stays unknown/);
    }
    if (entry.assertions.storedOutcomeIsNotLabel) assert.equal(dialogue.outcome, 'success');

    for (const citation of entry.citations) {
      const material = materials.find(candidate => candidate.name === citation.material);
      assert.ok(material, `${entry.id}: missing material ${citation.material}`);
      assert.equal(verbatimSpan(material.content, citation.quote), citation.quote, `${entry.id}: citation is not verbatim`);
    }
  }
});

