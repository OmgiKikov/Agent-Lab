import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { fingerprint } from '../src/contracts.js';
import { agentVersionRelation, sameTargetVersion, targetFingerprint, targetVersionRelation } from '../src/target-version.js';

const exec = promisify(execFile);
test('fingerprints explain missing paths and reuse Git diffs only while tracked files remain unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-version-'));
  const previousPath = process.env.PATH;
  try {
    const repo = join(directory, 'repo'); await mkdir(repo);
    await mkdir(join(repo, 'nested'));
    const target = { kind: 'module' as const, path: join(repo, 'nested', 'adapter.mjs'), exportName: 'createSession' };
    await assert.rejects(targetFingerprint(target), error => /Не найден файл агента/.test(String(error)) && !/ENOENT|stat '/.test(String(error)));
    await assert.rejects(targetFingerprint({ ...target, path: repo }), /Вместо файла агента указана папка/);
    await writeFile(target.path, 'export const version = 1;'); await writeFile(join(repo, 'dependency.bin'), Buffer.alloc(100000, 1));
    const realGit = (await exec('which', ['git'])).stdout.trim();
    const git = (args: string[]) => exec(realGit, ['-C', repo, ...args]);
    await git(['init', '-q']); await git(['config', 'diff.relative', 'true']); await git(['add', '.']);
    await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
    const bin = join(directory, 'bin'); await mkdir(bin); const log = join(directory, 'git-calls');
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    await writeFile(join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quote(log)}\nexec ${quote(realGit)} "$@"\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:${previousPath}`;
    const original = await targetFingerprint(target);
    assert.equal(await targetFingerprint(target), original); assert.equal(await targetFingerprint(target), original);
    const heavyCalls = async () => (await readFile(log, 'utf8')).split('\n').filter(line => line.includes('--binary')).length;
    assert.equal(await heavyCalls(), 1, 'unchanged polling must not rebuild the binary diff');
    await writeFile(join(repo, 'dependency.bin'), Buffer.alloc(100000, 2));
    const changed = await targetFingerprint(target); assert.notEqual(changed, original);
    assert.equal(await targetFingerprint(target), changed); assert.equal(await heavyCalls(), 2);
    await writeFile(join(repo, 'dependency.bin'), Buffer.alloc(100000, 3));
    assert.notEqual(await targetFingerprint(target), changed, 'another edit to the same dirty path must invalidate the cache');
    await rm(join(repo, 'dependency.bin'));
    assert.notEqual(await targetFingerprint(target), original, 'tracked deletions participate');
    await rm(target.path);
    await assert.rejects(targetFingerprint(target), /Не найден файл агента/);
  } finally { process.env.PATH = previousPath; await rm(directory, { recursive: true, force: true }); }
});

test('the version sees the module export and the command arguments, while an old fingerprint still matches unchanged code', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-launch-'));
  try {
    const path = join(directory, 'adapter.mjs');
    const content = 'export const createSession = () => ({}); export const repaired = createSession;';
    await writeFile(path, content);
    const module = { kind: 'module' as const, path, exportName: 'createSession' };
    const current = (await targetFingerprint(module))!;
    const other = (await targetFingerprint({ ...module, exportName: 'repaired' }))!;
    assert.notEqual(other, current, 'another export of the same file is another agent version');
    const command = { kind: 'command' as const, command: process.execPath, args: [path, '--mode', 'a'], timeoutMs: 1000 };
    assert.notEqual(await targetFingerprint({ ...command, args: [path, '--mode', 'b'] }), await targetFingerprint(command), 'other arguments are another agent version');
    assert.equal(sameTargetVersion(current, other), false);
    // A record written before the launch part holds what the first algorithm wrote: the code part alone.
    const legacy = fingerprint({ content });
    assert.equal(current.split(':')[0], legacy, 'the code part is the old algorithm unchanged');
    assert.equal(sameTargetVersion(legacy, current), true, 'unchanged code keeps an old record on the same version');
    assert.equal(sameTargetVersion(legacy, other), true, 'the old algorithm never saw the export, so it cannot tell');
    await writeFile(path, 'export const createSession = () => ({ changed: true });');
    assert.equal(sameTargetVersion(legacy, await targetFingerprint(module)), false, 'changed code is a new version for an old record too');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a command\'s version is the Git state of its working folder: an edit of the agent is a new version, an edit of Lab beside the adapter is not', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-harness-'));
  try {
    const lab = join(directory, 'lab'), agent = join(directory, 'agent');
    await mkdir(join(lab, 'harnesses'), { recursive: true }); await mkdir(agent);
    await writeFile(join(lab, 'harnesses', 'adapter.py'), 'print("adapter")\n');
    await writeFile(join(lab, 'README.md'), 'lab\n');
    await writeFile(join(agent, 'agent.py'), 'ANSWER = 1\n');
    for (const repo of [lab, agent]) {
      await exec('git', ['-C', repo, 'init', '-q']); await exec('git', ['-C', repo, 'add', '.']);
      await exec('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
    }
    // The harness layout: the adapter in Lab's repository, the agent's folder as the working folder.
    const target = { kind: 'command' as const, command: 'python3', args: [join(lab, 'harnesses', 'adapter.py'), '.'], cwd: agent, timeoutMs: 1000 };
    const original = (await targetFingerprint(target))!;
    assert.ok(original.endsWith(':cwd'), 'taken from another repository than the adapter\'s, and it says so');
    await writeFile(join(lab, 'README.md'), 'lab edited\n');
    assert.equal(await targetFingerprint(target), original, 'an edit of Lab is not a new agent version');
    await writeFile(join(agent, 'agent.py'), 'ANSWER = 2\n');
    const edited = (await targetFingerprint(target))!;
    assert.notEqual(edited, original, 'an edit of the agent is');
    assert.equal(sameTargetVersion(original, edited), false);
    // `python -m agent`: no entry file, and the working folder still names the version.
    const byModule = { ...target, args: ['-m', 'agent'] };
    const first = await targetFingerprint(byModule);
    assert.ok(first);
    await writeFile(join(agent, 'agent.py'), 'ANSWER = 3\n');
    assert.notEqual(await targetFingerprint(byModule), first);
    // A fingerprint the earlier algorithm took from the adapter's repository is never compared with one of the working folder.
    const legacy = fingerprint({ content: 'print("adapter")\n' });
    assert.equal(targetVersionRelation(legacy, edited), 'unknown');
    assert.equal(sameTargetVersion(legacy, edited), true, 'a run is stopped only on proof of a change');
    // Where the entry file lives in the working folder's repository, nothing changes against older records.
    const inside = { kind: 'command' as const, command: 'python3', args: ['agent.py'], cwd: agent, timeoutMs: 1000 };
    assert.ok(!(await targetFingerprint(inside))!.endsWith(':cwd'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an http agent\'s fingerprint is its address and request template, and the same address says nothing of the code redeployed behind it', async () => {
  const request = { body: { q: '{{message}}' }, headers: {}, reply: '/text' };
  const http = { kind: 'http' as const, url: 'https://agent.example.test/a', headersEnv: {}, timeoutMs: 1000, request };
  const a = (await targetFingerprint(http))!;
  assert.match(a, /^http:[0-9a-f]{64}$/);
  assert.equal(await targetFingerprint({ ...http }), a);
  const moved = await targetFingerprint({ ...http, url: 'https://agent.example.test/b' });
  const reshaped = await targetFingerprint({ ...http, request: { ...request, body: { text: '{{message}}' } } });
  assert.equal(targetVersionRelation(a, a), 'unknown');
  assert.equal(targetVersionRelation(a, moved), 'changed');
  assert.equal(targetVersionRelation(a, reshaped), 'changed');
  assert.equal(sameTargetVersion(a, a), true, 'a run on it is not stopped');
  assert.equal(sameTargetVersion(undefined, undefined), false, 'unknown is not the same');
  // The owner's name for the version, or the version the agent reports, is what tells an http agent's versions apart.
  assert.equal(agentVersionRelation({ targetFingerprint: a }, { targetFingerprint: a }), 'unknown');
  assert.equal(agentVersionRelation({}, {}), 'unknown');
  assert.equal(agentVersionRelation({ targetFingerprint: a, targetVersion: 'v1' }, { targetFingerprint: a, targetVersion: 'v1' }), 'same');
  assert.equal(agentVersionRelation({ targetFingerprint: a, targetVersion: 'v1' }, { targetFingerprint: a, targetVersion: 'v2' }), 'changed');
  assert.equal(agentVersionRelation({ targetFingerprint: a }, { targetFingerprint: a, targetVersion: 'v2' }), 'changed', 'a name on one side only is a change');
  assert.equal(agentVersionRelation({ targetFingerprint: a, targetRelease: 'r1' }, { targetFingerprint: a, targetRelease: 'r1' }), 'same');
  assert.equal(agentVersionRelation({ targetFingerprint: a, targetRelease: 'r1' }, { targetFingerprint: moved, targetRelease: 'r1' }), 'changed');
});
