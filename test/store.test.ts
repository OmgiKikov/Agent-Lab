import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import test, { type TestContext } from 'node:test';
import { ExperimentStore } from '../src/store.js';
import { LibraryMemo } from '../src/scenario-store.js';
import { ExperimentLab } from '../src/experiment.js';
import { draftHash, newRecord } from '../src/lab/record.js';
import { acceptLibraryV2 } from '../src/card/library.js';
import { libraryV2Schema } from '../src/card/schema.js';
import { fingerprint, type Experiment } from '../src/contracts.js';
import { libraryHash } from '../src/scenario-library.js';
import { demoInput } from '../src/demo.js';
import type { JudgeAudit } from '../src/assessment.js';
import { acceptedDemoDraft, legacyDemoRuntime, legacyDraft } from './helpers/demo-record.js';
import { cardDraft } from './helpers/card-library.js';
import { cardInput } from './helpers/card-prep.js';

async function directory(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-lab-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function lines(child: ChildProcessWithoutNullStreams) {
  const queued: string[] = [];
  let waiting: ((line: string) => void) | undefined;
  createInterface({ input: child.stdout }).on('line', line => { if (waiting) { const done = waiting; waiting = undefined; done(line); } else queued.push(line); });
  return () => queued.length ? Promise.resolve(queued.shift()!) : new Promise<string>(resolve => { waiting = resolve; });
}

test('readers see valid records and diagnostics while the writer owns the directory', async t => {
  const dir = await directory(t);
  const lab = new ExperimentLab(dir);
  await lab.init();
  t.after(() => lab.close());
  const draft = await lab.create(demoInput()); await lab.waitForIdle();
  const lock = await readFile(join(dir, '.lock'), 'utf8');
  await writeFile(join(dir, 'damaged.json'), '{broken');
  const reader = new ExperimentStore(dir);
  assert.equal((await reader.get(draft.id)).id, draft.id);
  assert.equal((await reader.list()).length, 1);
  assert.deepEqual(reader.diagnostics, [{ id: 'damaged', message: 'Некорректный JSON. Исходный файл сохранён.' }]);
  assert.equal(await readFile(join(dir, 'damaged.json'), 'utf8'), '{broken');
  assert.equal(await readFile(join(dir, '.lock'), 'utf8'), lock);
  await assert.rejects(reader.save(await reader.get(draft.id)), /как писатель/);
  await assert.rejects(reader.init(), /already open/);
  await reader.close();
  assert.equal(await readFile(join(dir, '.lock'), 'utf8'), lock);
  await rm(join(dir, 'damaged.json'));
  await reader.list(); assert.deepEqual(reader.diagnostics, []);
  assert.deepEqual(await new ExperimentStore(join(dir, 'missing')).list(), []);
});

test('ambiguous recovery gates and malformed owner records are preserved', async t => {
  const dir = await directory(t);
  const dead = JSON.stringify({ pid: 2147483647, token: 'dead' });
  await writeFile(join(dir, '.lock'), dead);
  await writeFile(join(dir, '.recovery'), 'previous recovery needs inspection');
  await assert.rejects(new ExperimentStore(dir).init(), /Восстановление уже занято/);
  assert.equal(await readFile(join(dir, '.lock'), 'utf8'), dead);
  await rm(join(dir, '.recovery'));
  await writeFile(join(dir, '.lock'), '{unfinished');
  await assert.rejects(new ExperimentStore(dir).init(), /Некорректный lock/);
  assert.equal(await readFile(join(dir, '.lock'), 'utf8'), '{unfinished');
});

test('simultaneous real processes recover a dead writer without stealing the winner lock', { timeout: 15000 }, async t => {
  const dir = await directory(t);
  await writeFile(join(dir, '.lock'), JSON.stringify({ pid: 2147483647, token: 'dead' }));
  const source = new URL('../src/store.ts', import.meta.url).href;
  const script = `
    import { ExperimentStore } from ${JSON.stringify(source)};
    import { createInterface } from 'node:readline';
    const store = new ExperimentStore(process.argv[1]);
    const input = createInterface({ input: process.stdin });
    let started = false;
    input.on('line', async () => {
      if (started) { await store.close(); input.close(); process.exit(0); }
      started = true;
      try { await store.init(); process.stdout.write('locked\\n'); }
      catch (error) { process.stdout.write('blocked: ' + error.message + '\\n'); input.close(); process.exit(0); }
    });
    process.stdout.write('ready\\n');
  `;
  const children = Array.from({ length: 4 }, () => spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, dir], { stdio: ['pipe', 'pipe', 'pipe'] }));
  t.after(() => { for (const child of children) child.kill(); });
  const next = children.map(lines);
  const exits = children.map(child => new Promise<number | null>(resolve => child.on('close', resolve)));
  assert.deepEqual(await Promise.all(next.map(read => read())), ['ready', 'ready', 'ready', 'ready']);
  children.forEach(child => child.stdin.write('start\n'));
  const results = await Promise.all(next.map(read => read()));
  assert.equal(results.filter(line => line === 'locked').length, 1, results.join('\n'));
  assert.equal(results.filter(line => line.startsWith('blocked:')).length, 3, results.join('\n'));
  const winner = results.indexOf('locked');
  const lock = JSON.parse(await readFile(join(dir, '.lock'), 'utf8'));
  assert.equal(lock.pid, children[winner]!.pid); assert.notEqual(lock.token, 'dead');
  await assert.rejects(new ExperimentStore(dir).init(), /already open/);
  assert.deepEqual(JSON.parse(await readFile(join(dir, '.lock'), 'utf8')), lock);
  children[winner]!.stdin.write('close\n');
  assert.deepEqual(await Promise.all(exits), [0, 0, 0, 0]);
  await assert.rejects(readFile(join(dir, '.lock')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(dir, '.recovery')), { code: 'ENOENT' });
});

test('CLI export and diff read snapshots without interrupting a live writer', { timeout: 15000 }, async t => {
  const dir = await directory(t);
  const lab = new ExperimentLab(dir); await lab.init(); t.after(() => lab.close());
  const draft = await acceptedDemoDraft(lab);
  const before = await lab.get(draft.id);
  const lock = await readFile(join(dir, '.lock'), 'utf8');
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const call = async (args: string[]) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cli, '--data-dir', dir, ...args]);
    let stdout = ''; let stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const code = await new Promise<number | null>(resolve => child.on('close', resolve));
    return { code, stdout, stderr };
  };
  const exported = await call(['export', '--id', before.id]);
  assert.equal(exported.code, 0, exported.stderr);
  assert.equal(JSON.parse(exported.stdout).experiment.id, before.id);
  const diff = await call(['diff', '--before', before.id, '--after', before.id, '--json']);
  assert.equal(diff.code, 2, diff.stderr); assert.equal(JSON.parse(diff.stdout).comparable, false);
  const textDiff = await call(['diff', '--before', before.id, '--after', before.id]);
  assert.equal(textDiff.code, 2, textDiff.stderr); assert.match(textDiff.stdout, /Несравнимо:/);
  assert.equal(await readFile(join(dir, '.lock'), 'utf8'), lock);
  assert.deepEqual(await lab.get(before.id), before);
});

const audit = (raw: string): JudgeAudit => ({ protocolHash: 'protocol', inputHash: 'input', provider: 'offline', model: 'test', prompt: 'prompt', input: '{}',
  attempts: [{ metricId: 'goal', startedAt: '2026-09-17T00:00:00.000Z', raw }], notApplicable: [] });

test('judge audit sidecar is private, atomic, replaced in place and readable without the lock', async t => {
  const dir = await directory(t);
  const writer = new ExperimentStore(dir); await writer.init();
  t.after(() => writer.close());
  writer.writeJudgeAudit('run', 'trial', audit('first'));
  writer.writeJudgeAudit('run', 'trial', audit('second'));
  const sidecar = join(dir, 'run.judge');
  assert.equal((await stat(sidecar)).mode & 0o777, 0o700);
  assert.equal((await stat(join(sidecar, 'trial.json'))).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(sidecar), ['trial.json'], 'no temporary file remains');
  assert.deepEqual(JSON.parse(await readFile(join(sidecar, 'trial.json'), 'utf8')), audit('second'));
  const reader = new ExperimentStore(dir);
  assert.deepEqual(await reader.readJudgeAudit('run', 'trial'), audit('second'));
  assert.equal(await reader.readJudgeAudit('run', 'other'), null);
  assert.throws(() => reader.writeJudgeAudit('run', 'trial', audit('third')), /как писатель/);
  assert.deepEqual(await reader.readJudgeAudit('run', 'trial'), audit('second'));
  assert.throws(() => writer.writeJudgeAudit('run', 'trial', { ...audit('bad'), attempts: 'none' } as unknown as JudgeAudit));
  assert.deepEqual(await readdir(sidecar), ['trial.json']);
});

test('judge audit sidecar rejects unsafe ids before touching the disk and oversized files before parsing', async t => {
  const dir = await directory(t);
  const writer = new ExperimentStore(dir); await writer.init();
  t.after(() => writer.close());
  const before = await readdir(dir);
  for (const [run, trial] of [['run', '../x'], ['a/b', 'trial'], ['..', 'trial']]) {
    assert.throws(() => writer.writeJudgeAudit(run!, trial!, audit('x')), /Invalid (trial|experiment) ID/);
    await assert.rejects(writer.readJudgeAudit(run!, trial!), /Invalid (trial|experiment) ID/);
  }
  assert.deepEqual(await readdir(dir), before);
  await mkdir(join(dir, 'big.judge'), { mode: 0o700 });
  await writeFile(join(dir, 'big.judge', 'trial.json'), Buffer.alloc(20_000_001, 32));
  await assert.rejects(new ExperimentStore(dir).readJudgeAudit('big', 'trial'), /Judge audit exceeds 20 MB/);
  await writeFile(join(dir, 'big.judge', 'trial.json'), JSON.stringify({ ...audit('x'), extra: true }));
  await assert.rejects(new ExperimentStore(dir).readJudgeAudit('big', 'trial'));
});

test('a quick agreement mark survives a reload with its judge verdict and judge version', async t => {
  const dir = await directory(t);
  const lab = new ExperimentLab(dir, legacyDemoRuntime());
  await lab.init();
  const created = await legacyDraft(lab, { count: 1, settings: { repeats: 1 } });
  await lab.start(created.id, { approved: true, reviewer: 'automated', expectedHash: draftHash(await lab.get(created.id)) });
  await lab.waitForIdle();
  const record = await lab.get(created.id);
  const trial = record.trials[0]!;
  const scenario = record.scenarios.find(candidate => candidate.id === trial.scenarioId)!;
  const metricId = scenario.metrics!.find(metric => metric.subject === 'agent')!.id;
  const mark = { id: 'mark-1', createdAt: '2026-09-17T00:00:00Z', trialId: trial.id, metricId,
    verdict: 'fail' as const, note: 'Согласен с судьёй.', durationMs: 1200,
    source: 'quick' as const, judgeVerdict: 'fail' as const, judge: { protocolHash: 'protocol-10', inputHash: 'input-1' } };
  record.humanReviews = [mark];
  await lab.store.save(record);
  await lab.close();

  const reopened = new ExperimentStore(dir);
  await reopened.init();
  t.after(() => reopened.close());
  assert.deepEqual((await reopened.get(record.id)).humanReviews, [mark], 'every new field reads back unchanged');
});

/* ── the writer's lock: taken only from a holder proved dead ── */

const lockOf = async (dir: string) => JSON.parse(await readFile(join(dir, '.lock'), 'utf8'));
/** This process as its own lock names it: its PID, host, boot, PID namespace and start. */
async function ownLock(t: TestContext): Promise<Record<string, unknown>> {
  const dir = await directory(t);
  const probe = new ExperimentStore(dir);
  await probe.init();
  try { return await lockOf(dir); } finally { await probe.close(); }
}
const ago = (ms: number) => new Date(Date.now() - ms);

test('a lock naming this process with a token none of its stores holds is dead: a restarted container gets the same PID again', async t => {
  const dir = await directory(t);
  const own = await ownLock(t);
  // Written by the previous Lab (PID and token only), and by this Lab on this machine.
  for (const left of [{ pid: process.pid, token: 'before-restart' }, { ...own, token: 'before-restart' }]) {
    await writeFile(join(dir, '.lock'), JSON.stringify(left));
    const store = new ExperimentStore(dir);
    await store.init();
    const lock = await lockOf(dir);
    assert.deepEqual([lock.pid, lock.token === 'before-restart'], [process.pid, false]);
    await assert.rejects(new ExperimentStore(dir).init(), /already open/, 'a store of this very process holding the lock is alive');
    await store.close();
    await assert.rejects(readFile(join(dir, '.lock')), { code: 'ENOENT' });
  }
});

test('a recovery gate its dead holder left is cleared once; a gate someone may still hold is not', async t => {
  const dir = await directory(t);
  await writeFile(join(dir, '.lock'), JSON.stringify({ pid: 2147483647, token: 'dead' }));
  await writeFile(join(dir, '.recovery'), JSON.stringify({ pid: 1, token: 'recovering', host: 'another-machine' }));
  await assert.rejects(new ExperimentStore(dir).init(), /Восстановление уже занято/, 'a recovery on another machine, its heartbeat fresh');
  await writeFile(join(dir, '.recovery'), JSON.stringify({ pid: 2147483647, token: 'dead-recovery' }));
  const store = new ExperimentStore(dir);
  await store.init();
  t.after(() => store.close());
  assert.equal((await lockOf(dir)).pid, process.pid);
  assert.deepEqual((await readdir(dir)).filter(name => name.startsWith('.recovery') || name.endsWith('.tmp')), [], 'no gate, mark or temporary file is left');
});

test('an empty lock is a writer caught between creating and writing it: taken only once it is older than a moment', async t => {
  const dir = await directory(t);
  await writeFile(join(dir, '.lock'), '');
  await assert.rejects(new ExperimentStore(dir).init(), /already open/, 'a lock being written right now is not taken');
  await utimes(join(dir, '.lock'), ago(60_000), ago(60_000));
  const store = new ExperimentStore(dir);
  await store.init();
  t.after(() => store.close());
  assert.equal((await lockOf(dir)).pid, process.pid);
});

test('a lock written on another machine or in another PID namespace is taken only once its heartbeat is stale', async t => {
  const dir = await directory(t);
  const own = await ownLock(t);
  for (const elsewhere of [{ ...own, host: 'another-machine' }, ...own.pidNamespace ? [{ ...own, pidNamespace: 'pid:[1]' }] : []]) {
    // Its PID means nothing here: neither a live process of this machine nor a dead one proves anything.
    for (const pid of [process.pid, 2147483647]) {
      await writeFile(join(dir, '.lock'), JSON.stringify({ ...elsewhere, pid, token: 'elsewhere' }));
      await assert.rejects(new ExperimentStore(dir).init(), /already open/);
    }
    await utimes(join(dir, '.lock'), ago(5 * 60_000), ago(5 * 60_000));
    const store = new ExperimentStore(dir);
    await store.init();
    assert.equal((await lockOf(dir)).token === 'elsewhere', false);
    await store.close();
  }
});

test('a PID of this machine now held by a process started at another time is not the lock\'s writer', { skip: !existsSync('/proc/self/stat') }, async t => {
  const dir = await directory(t);
  const own = await ownLock(t);
  const stat = await readFile(`/proc/${process.ppid}/stat`, 'utf8');
  const started = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
  await writeFile(join(dir, '.lock'), JSON.stringify({ ...own, pid: process.ppid, started, token: 'parent' }));
  await assert.rejects(new ExperimentStore(dir).init(), /already open/, 'the process that wrote it is alive');
  await writeFile(join(dir, '.lock'), JSON.stringify({ ...own, pid: process.ppid, started: started + 1, token: 'parent' }));
  const store = new ExperimentStore(dir);
  await store.init();
  t.after(() => store.close());
  assert.equal((await lockOf(dir)).pid, process.pid);
});

test('the writer renews its heartbeat and writes no more once the lock is not its own', async t => {
  const dir = await directory(t);
  const store = new ExperimentStore(dir);
  await store.init();
  t.after(() => store.close());
  const lockPath = join(dir, '.lock');
  const beat = () => (store as unknown as { beat(): Promise<void> }).beat();
  await utimes(lockPath, ago(5 * 60_000), ago(5 * 60_000));
  await beat();
  assert.ok(Date.now() - (await stat(lockPath)).mtimeMs < 60_000, 'the heartbeat is fresh again');
  // Another process took the folder, as it may once this writer's heartbeat went stale: this one stops writing.
  await writeFile(lockPath, JSON.stringify({ ...await lockOf(dir), token: 'another-writer' }));
  await beat();
  await assert.rejects(store.save(newRecord(cardInput())), /как писатель/);
  await store.close();
  assert.equal((await lockOf(dir)).token, 'another-writer', 'the other writer\'s lock stays');
});

/* ── saves: the record of one moment, and no work the store already did ── */

test('a save takes the record as it is at the call: what changes while it waits its turn belongs to the next save', async t => {
  const dir = await directory(t);
  const store = new ExperimentStore(dir);
  await store.init();
  t.after(() => store.close());
  const { library, batch } = cardDraft();
  await store.writeImport(batch);
  const record: Experiment = { ...newRecord(cardInput()), librarySnapshot: library };
  const publishing = store.publishLibrary(record, library);
  record.message = 'a unit took its next step while the save waited';
  await publishing;
  assert.notEqual((await store.get(record.id)).message, record.message, 'the published record is the one of the call');
  const saving = store.save(record);
  record.message = 'and another one';
  await saving;
  assert.equal((await store.get(record.id)).message, 'a unit took its next step while the save waited');
});

/** Bytes every hash of this process reads from now on (node:crypto, as the modules import it). */
function hashedBytes(t: TestContext): { bytes: number } {
  const crypto = createRequire(import.meta.url)('node:crypto') as typeof import('node:crypto');
  const original = crypto.createHash;
  const counted = { bytes: 0 };
  crypto.createHash = ((...args: Parameters<typeof original>) => {
    const hash = original(...args);
    const update = hash.update.bind(hash) as (data: string | NodeJS.ArrayBufferView, encoding?: BufferEncoding) => typeof hash;
    hash.update = ((data: string | NodeJS.ArrayBufferView, encoding?: BufferEncoding) => {
      counted.bytes += typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
      return update(data, encoding);
    }) as typeof hash.update;
    return hash;
  }) as typeof original;
  syncBuiltinESMExports();
  t.after(() => { crypto.createHash = original; syncBuiltinESMExports(); });
  return counted;
}

test('saving an unchanged library again hashes, validates and reads back nothing of it', async t => {
  const dir = await directory(t);
  const store = new ExperimentStore(dir);
  await store.init();
  t.after(() => store.close());
  const { library, batch, evidence } = cardDraft();
  const article = 'Статья базы знаний о возвратах и доставке. '.repeat(5000);
  const large = libraryV2Schema.parse({ ...library, sources: [...library.sources, { id: 'source-kb', name: 'База знаний', content: article, hash: fingerprint(article) }] });
  const accepted = acceptLibraryV2(large, libraryHash(large), large.cards.map(card => card.id), { evidence, maxTurns: 3 }).library;
  await store.writeImport(batch);
  const record: Experiment = { ...newRecord(cardInput()), sources: large.sources, librarySnapshot: accepted };
  await store.publishLibrary(record, accepted);
  const head = libraryHash(accepted);
  const hashed = hashedBytes(t);
  // A run's checkpoints save the same accepted snapshot again and again; a preparation's step may change only the record.
  await store.save(record);
  await store.save(record);
  await store.publishLibrary(record, accepted, head);
  assert.ok(hashed.bytes < Buffer.byteLength(article), `${hashed.bytes} bytes hashed for a library of ${Buffer.byteLength(article)}`);
  assert.deepEqual((await store.get(record.id)).librarySnapshot, accepted, 'what is saved is still the library');
});

test('a library is admitted once per object, and a change made in place at its top level is seen', () => {
  const memo = new LibraryMemo();
  const { library } = cardDraft();
  const first = memo.admit(library);
  assert.equal(memo.admit(library), first);
  assert.equal(memo.admit(first.library).hash, first.hash, 'its validated copy is known too');
  library.cards.pop();
  assert.notEqual(memo.admit(library).hash, first.hash);
});
