import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { createInputSchema } from '../src/contracts.js';

/*
 * The agents' harnesses live beside the core (harnesses/), but what they write must pass the core's contracts:
 * otherwise a mistake in them is found only on the work machine. And the core never depends on them.
 */

const root = new URL('../', import.meta.url);

test('the agent_oc skills registry is a task the current build accepts', async () => {
  const agent = await mkdtemp(join(tmpdir(), 'agent-lab-harness-'));
  const skills = join(agent, 'src/app/incass_ckr/new_agent_logic/dialogue_handler/agent/tools/read/skills');
  await mkdir(skills, { recursive: true });
  await writeFile(join(skills, 'order.md'), '# Заказ инкассации\n{{ surface }}\nКлиент заказывает выезд.\n');
  const output = join(agent, 'task-cards.json');
  await promisify(execFile)('python3', [new URL('harnesses/agent-oc/materials.py', root).pathname, '--root', agent, '--output', output]);
  const input = createInputSchema.parse(JSON.parse(await readFile(output, 'utf8')));
  assert.equal(input.target.kind, 'unconnected');
  assert.equal(input.settings.roles?.judge?.provider, 'giga');
  assert.match(input.materials[0]!.content, /## order\n# Заказ инкассации\nКлиент заказывает выезд\./);
});

/** Runs a harness script with Python; `stubs` go first on its import path (a stand-in openpyxl). */
async function python(args: string[], options: { cwd?: string; stubs?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await promisify(execFile)('python3', args, { cwd: options.cwd, env: { ...process.env, ...options.stubs ? { PYTHONPATH: options.stubs } : {} } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}
const harness = (file: string) => new URL(`harnesses/${file}`, root).pathname;
const mode = async (path: string) => (await stat(path)).mode & 0o777;

/** A stand-in openpyxl that reads a «workbook» written as JSON: {sheet: [header, ...rows]}. Invented data only. */
async function fakeOpenpyxl(folder: string): Promise<string> {
  const stubs = join(folder, 'stubs');
  await mkdir(join(stubs, 'openpyxl'), { recursive: true });
  await writeFile(join(stubs, 'openpyxl', '__init__.py'), [
    'import json',
    'class _Sheet:',
    '    def __init__(self, rows): self.rows = rows',
    '    def iter_rows(self, values_only=True): return iter(tuple(row) for row in self.rows)',
    'class _Book:',
    '    def __init__(self, sheets): self.sheets = sheets; self.sheetnames = list(sheets)',
    '    def __getitem__(self, name): return _Sheet(self.sheets[name])',
    'def load_workbook(path, read_only=True, data_only=True):',
    '    return _Book(json.loads(open(path, encoding="utf-8").read()))',
  ].join('\n'));
  return stubs;
}

test('agent_oc conversations are written for the owner only, into .agent-lab by default, and never where git would commit them', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'agent-lab-harness-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const stubs = await fakeOpenpyxl(folder);
  const input = join(folder, 'labels.xlsx');
  await writeFile(input, JSON.stringify({ GIGAASS: [['conversation_id', 'dialogue_history', 'status_code', 'epk_id'],
    ['c-1', 'client: "Здравствуйте"\nagent: "Добрый день"\nclient: "Где мой возврат?"', '200', 'EPK-TEST-0001']] }));

  const project = join(folder, 'project');
  await mkdir(project);
  const written = await python([harness('agent-oc/import-dialogues.py'), '--input', input], { cwd: project, stubs });
  assert.equal(written.code, 0, written.stderr);
  const output = join(project, '.agent-lab', 'agent-oc', 'dialogues.jsonl');
  assert.equal(JSON.parse(await readFile(output, 'utf8')).id, 'GIGAASS-c-1');
  assert.equal(JSON.parse(await readFile(`${output}.meta.json`, 'utf8'))['GIGAASS-c-1'].epk_id, 'EPK-TEST-0001');
  assert.deepEqual([await mode(output), await mode(`${output}.meta.json`), await mode(join(project, '.agent-lab')), await mode(join(project, '.agent-lab', 'agent-oc'))],
    [0o600, 0o600, 0o700, 0o700]);

  const repository = join(folder, 'repository');
  await mkdir(repository);
  await promisify(execFile)('git', ['init', '-q', repository]);
  const tracked = join(repository, 'data', 'dialogues-2026.jsonl');
  const refused = await python([harness('agent-oc/import-dialogues.py'), '--input', input, '--output', tracked], { cwd: repository, stubs });
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /Не пишу: .*внутри git-репозитория .*git этот путь не игнорирует: прод-диалоги и ЕПК ушли бы в коммит\. Уберите --output/);
  assert.deepEqual(await readdir(repository), ['.git'], 'nothing written');
  await writeFile(join(repository, '.gitignore'), 'data/\n');
  assert.equal((await python([harness('agent-oc/import-dialogues.py'), '--input', input, '--output', tracked], { cwd: repository, stubs })).code, 0, 'an ignored path is the owner\'s choice');
  for (const path of ['dialogues.jsonl', 'dialogues.jsonl.meta.json', '.agent-lab-run/report.html', 'harnesses/agent-oc/x.meta.json']) {
    const ignored = await python(['-c', 'import subprocess, sys; sys.exit(subprocess.run(["git", "check-ignore", "-q", sys.argv[1]]).returncode)', path], { cwd: new URL('.', root).pathname });
    assert.equal(ignored.code, 0, `${path} is ignored by the repository`);
  }
});

test('judge-errors reads the judge audits where Lab keeps them now — beside the run — and in the older records', async t => {
  const data = await mkdtemp(join(tmpdir(), 'agent-lab-judge-errors-'));
  t.after(() => rm(data, { recursive: true, force: true }));
  await writeFile(join(data, 'run_1.json'), JSON.stringify({ id: 'run_1', trials: [
    { id: 'trial_1', judgeReceipt: { protocolHash: 'p', inputHash: 'i', provider: 'x', model: 'y' } },
    { id: 'trial_2', judgeAudit: { attempts: [{ startedAt: 't', error: 'Quote is not verbatim', raw: '{"quote": "почти"}' }] } },
  ] }));
  await mkdir(join(data, 'run_1.judge'));
  await writeFile(join(data, 'run_1.judge', 'trial_1.json'), JSON.stringify({ attempts: [
    { startedAt: 't', error: 'Unknown event 7\nsecond line', raw: '{"evidence": [7]}' }, { startedAt: 't', raw: '{"ok": true}' }] }));
  const { code, stdout, stderr } = await python([harness('agent-oc/judge-errors.py'), 'run_1', '--data-dir', data]);
  assert.equal(code, 0, stderr);
  assert.equal(stdout.split('\n')[0], 'Попыток судьи: 3, отклонено: 2');
  for (const line of ['=== 1 × Unknown event 7', '{"evidence": [7]}', '=== 1 × Quote is not verbatim', '{"quote": "почти"}']) assert.ok(stdout.includes(line), `${line}\n${stdout}`);
});

test('the agent_oc adapter says its tool journal is incomplete when it cut it; the acquiring adapter reads the outcome by the public name first', async () => {
  const adapter = harness('agent-oc/adapter.py');
  const turn = (actions: number) => [
    'import importlib.util, json, sys',
    `spec = importlib.util.spec_from_file_location("adapter", ${JSON.stringify(adapter)})`,
    'adapter = importlib.util.module_from_spec(spec); spec.loader.exec_module(adapter)',
    'class Turn:',
    `    def reply(self, message): return {"answer": "ok", "status_code": "200", "produced_by": "x", "seconds": 1.0, "actions": [{"tool": "read", "args": {"name": f"skill_{i}"}} for i in range(${actions})]}`,
    'reply = adapter.respond(Turn(), {"message": "hi", "initialState": {"records": {}}}, 1)',
    'adapter._PROTOCOL.write(json.dumps({"events": len(reply["events"]), "complete": reply["eventsComplete"]}))',
  ].join('\n');
  assert.deepEqual(JSON.parse((await python(['-c', turn(60)])).stdout), { events: 50, complete: false });
  assert.deepEqual(JSON.parse((await python(['-c', turn(3)])).stdout), { events: 3, complete: true });

  const observer = [
    'import importlib.util, json, types',
    `spec = importlib.util.spec_from_file_location("aigw", ${JSON.stringify(harness('acquiring/aigw-observed.py'))})`,
    'aigw = importlib.util.module_from_spec(spec); spec.loader.exec_module(aigw)',
    'public, private = (lambda *a: "public"), (lambda *a: "private")',
    'names = [aigw.observer(types.SimpleNamespace(observed=public, _observed=private))(), aigw.observer(types.SimpleNamespace(_observed=private))()]',
    'try: aigw.observer(types.SimpleNamespace())',
    'except SystemExit as refusal: names.append(str(refusal))',
    'print(json.dumps(names, ensure_ascii=False))',
  ].join('\n');
  const [first, second, refusal] = JSON.parse((await python(['-c', observer])).stdout) as string[];
  assert.deepEqual([first, second], ['public', 'private']);
  assert.match(refusal!, /нет функции observed \(или _observed\)/);
});

test('the core and the Pi extension name no harness', async () => {
  for (const folder of ['src', 'extensions']) {
    const files = (await readdir(new URL(`${folder}/`, root), { recursive: true })).filter(name => name.endsWith('.ts') || name.endsWith('.mjs'));
    for (const file of files) assert.ok(!(await readFile(new URL(`${folder}/${file}`, root), 'utf8')).includes('harnesses/'), `${folder}/${file}`);
  }
  const shipped: string[] = JSON.parse(await readFile(new URL('package.json', root), 'utf8')).files;
  assert.ok(!shipped.some(entry => entry.startsWith('harnesses')), 'harnesses stay outside the npm package');
});
