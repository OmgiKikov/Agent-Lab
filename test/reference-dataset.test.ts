import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  createInputSchema,
  dialogueSchema,
  dialogueToScenario,
  dialogueToTrial,
  scenarioSchema,
  verbatimSpan,
} from '../src/contracts.js';
import { judgeInput } from '../src/judge.js';

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
  const input = createInputSchema.parse({ ...task, dialogues: rawDialogues, scenarioCount: 0 });

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

  const materials = createInputSchema.parse({ ...task, dialogues: rawDialogues, scenarioCount: 0 }).materials;
  for (const [index, raw] of rawDialogues.entries()) {
    const dialogue = dialogueSchema.parse(raw);
    const entry = manifest.cases[index]!;
    const parsedScenario = scenarioSchema.safeParse(dialogueToScenario(dialogue, { goal: dialogue.goal ?? `Review ${dialogue.id}` }));
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

