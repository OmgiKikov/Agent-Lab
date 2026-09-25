import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caveatLines } from '../src/caveats.js';
import { DEFAULT_JUDGE, judgeFallback } from '../src/contracts.js';
import { ExperimentLab } from '../src/experiment.js';
import { draftHash } from '../src/lab/record.js';
import { endpointAnswers } from '../src/llm/reach.js';
import { evaluatorVersion } from '../src/pi.js';
import { buildResultView } from '../src/result-view.js';
import type { Runtime } from '../src/runtime.js';
import { libraryHash } from '../src/scenario-library.js';
import { cardInput, cardRuntime } from './helpers/card-prep.js';

/*
 * A key in Pi says the judge may be used, not that this network reaches it (lab/run.ts start). Before a run's first
 * paid call the judge's endpoint is asked by the network alone; the chat's default judge that cannot be reached gives
 * way to the draft's own model, and any other one refuses the run before anything is spent. Local servers only.
 */

async function listening(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
}

test('an endpoint that answers anything is reachable; a refused port is not; a stop is never read as unreachable', async () => {
  const methods: string[] = [];
  const server = createServer((request, response) => { methods.push(request.method ?? ''); response.writeHead(404).end(); });
  const url = await listening(server);
  try {
    assert.equal(await endpointAnswers(url, new AbortController().signal), true, 'a 404 is an answer: the network reaches it');
    assert.deepEqual(methods, ['HEAD'], 'one HEAD request, never a model request');
  } finally { await new Promise(resolve => server.close(resolve)); }
  assert.equal(await endpointAnswers(url, new AbortController().signal), false, 'nobody listens there any more');
  const silent = createServer(() => { /* never answers */ });
  const quiet = await listening(silent);
  try { assert.equal(await endpointAnswers(quiet, new AbortController().signal, 200), false, 'silence past the deadline'); }
  finally { silent.closeAllConnections(); await new Promise(resolve => silent.close(resolve)); }
  const stopped = new AbortController();
  stopped.abort(new Error('stop'));
  await assert.rejects(endpointAnswers(quiet, stopped.signal), /stop/);
});

test('only the chat\'s independent default judge falls back, to the draft\'s own model', () => {
  const session = { provider: 'giga', model: 'GigaChat-3-Ultra' };
  assert.deepEqual(judgeFallback({ ...session, judge: { ...DEFAULT_JUDGE } }), session);
  assert.equal(judgeFallback({ ...session, judge: { provider: 'openrouter', model: 'anthropic/claude' } }), undefined, 'a judge the owner named is never replaced');
  assert.equal(judgeFallback({ ...session, judge: { ...DEFAULT_JUDGE }, roles: { judge: { provider: 'x', model: 'y' } } }), undefined);
  assert.equal(judgeFallback({ provider: '', model: '', judge: { ...DEFAULT_JUDGE } }), undefined, 'nothing to fall back to');
});

/** The card runtime whose judge is reachable by the answers given, one per question. */
function reaching(answers: boolean[]): Runtime & { asked: number } {
  const runtime = { ...cardRuntime(), asked: 0 };
  return Object.assign(runtime, { judgeReachable: async () => answers[runtime.asked++] ?? true });
}

test('a run whose default judge this network does not reach is judged by the draft\'s own model, and says so; any other judge refuses it', async () => {
  for (const [answers, judge] of [[[false, true], { ...DEFAULT_JUDGE }], [[false], { provider: 'openrouter', model: 'anthropic/claude' }]] as const) {
    const runtime = reaching([...answers]);
    const directory = await mkdtemp(join(tmpdir(), 'agent-lab-reach-'));
    const lab = new ExperimentLab(directory, runtime);
    try {
      await lab.init();
      const draft = await lab.create(cardInput({ settings: { ...cardInput().settings, judge } }));
      await lab.waitForIdle();
      const { library } = await lab.readCards(draft.id);
      const accepted = (await lab.acceptCards(draft.id, libraryHash(library), library.cards.map(card => card.id))).experiment;
      if (judge.model !== DEFAULT_JUDGE.model) {
        await assert.rejects(lab.start(draft.id, { approved: true, expectedHash: draftHash(accepted) }),
          /^Error: Судья openrouter\/anthropic\/claude недоступен из этой сети: .* Ничего не запущено и не потрачено\.$/);
        const left = await lab.get(draft.id);
        assert.deepEqual([left.phase, left.settings.judge, left.usage.calls], ['review', judge, accepted.usage.calls], 'nothing ran and nothing changed');
        continue;
      }
      await lab.start(draft.id, { approved: true, expectedHash: draftHash(accepted) });
      await lab.waitForIdle();
      const run = await lab.get(draft.id);
      assert.equal(run.phase, 'results_review', run.error ?? '');
      assert.equal(runtime.asked, 2, 'the fallback is asked too before anything is spent');
      assert.deepEqual(run.settings.judge, { provider: 'deterministic', model: 'fixture' });
      assert.equal(run.evaluatorVersion, evaluatorVersion(run.settings), 'the run is sealed with the judge that judged it');
      assert.deepEqual(run.caveats?.find(note => note.code === 'judge_fallback'), { code: 'judge_fallback', from: 'openrouter/openai/gpt-5.6-sol', to: 'deterministic/fixture' });
      assert.ok(caveatLines(run).includes('Судья openrouter/openai/gpt-5.6-sol недоступен из этой сети: ответы оценивала модель deterministic/fixture — та же, что готовила ситуации.'));
      assert.equal(buildResultView(run).sameModelJudge, true, 'the trust line says the judge is the model that built the situations');
    } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
  }
});
