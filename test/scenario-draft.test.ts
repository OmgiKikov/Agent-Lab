import assert from 'node:assert/strict';
import { test } from 'node:test';
import { libraryHash } from '../src/scenario-library.js';
import { chooseEditableDraft, draftIsBusy, recheckDecision, type DraftRecord } from '../src/scenario-draft.js';
import { libraryFixture } from './helpers/scenario-library.js';

const record = (id: string, library: ReturnType<typeof libraryFixture>, phase: DraftRecord['phase'], extra: Partial<DraftRecord> = {}): DraftRecord => ({
  id, phase, updatedAt: '2026-09-22T00:00:00.000Z', reviewedAt: null, trials: [], librarySnapshot: library, ...extra,
});

test('a finished run is not the editable draft, and a recheck is skipped only when the owner defers it', () => {
  const library = libraryFixture();
  const head = libraryHash(library);
  const finished = record('done', library, 'results_review', { reviewedAt: '2026-09-22T00:00:00.000Z', trials: [{}] });
  assert.deepEqual(chooseEditableDraft({ settled: finished, holders: [finished], headHash: head, busy: draftIsBusy }), { action: 'copy', sourceId: 'done', newer: false });
  const draft = record('draft', library, 'review', { updatedAt: '2026-09-22T01:00:00.000Z' });
  assert.deepEqual(chooseEditableDraft({ settled: finished, holders: [finished, draft], headHash: head, busy: draftIsBusy }), { action: 'use', id: 'draft', newer: false });
  assert.deepEqual(chooseEditableDraft({ settled: draft, holders: [draft], headHash: head, busy: draftIsBusy }), { action: 'edit' });
  assert.equal(chooseEditableDraft({ settled: record('run', library, 'evaluating'), holders: [], headHash: head, busy: draftIsBusy }).action, 'busy');
  assert.equal(recheckDecision({ pendingJobs: 0, remainingCalls: 3, defer: false, libraryHash: head }).action, 'not_needed');
  assert.equal(recheckDecision({ pendingJobs: 2, remainingCalls: 3, defer: true, libraryHash: head }).action, 'skipped');
  assert.equal(recheckDecision({ pendingJobs: 4, remainingCalls: 1, defer: false, libraryHash: head }).action, 'needs_budget');
  assert.deepEqual(recheckDecision({ pendingJobs: 4, remainingCalls: 1, defer: false, askedHash: head, libraryHash: 'other' }), { action: 'run', startHash: head, pendingJobs: 4, remainingCalls: 1 });
});
