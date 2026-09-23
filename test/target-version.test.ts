import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { fingerprint } from '../src/contracts.js';
import { sameTargetVersion, targetFingerprint } from '../src/target-version.js';

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
