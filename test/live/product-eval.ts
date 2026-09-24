/**
 * The product eval against a real model (quality bar 8). Run only deliberately — it spends the configured provider's
 * credits:  npx tsx test/live/product-eval.ts --run [--model provider/model] [--case id]
 * Each owner phrase is said in a fresh project (product-eval-cases.ts); the verdict is the tool the model reached and
 * the state it left. Prints one line per phrase, then the whole result as JSON.
 */
import { parseArgs } from 'node:util';
import { ModelRuntime, resolveCliModel } from '@earendil-works/pi-coding-agent';
import { CASES } from './product-eval-cases.ts';
import { playCase } from './product-eval-session.ts';

const { values } = parseArgs({ options: { run: { type: 'boolean' }, model: { type: 'string' }, case: { type: 'string', multiple: true } } });
if (!values.run) throw new Error('Модельная проверка тратит кредиты провайдера: укажите --run явно.');

const runtime = await ModelRuntime.create({ allowModelNetwork: false });
const slash = values.model?.indexOf('/') ?? -1;
const chosen = values.model ? resolveCliModel({ cliProvider: values.model.slice(0, slash), cliModel: values.model.slice(slash + 1), modelRuntime: runtime }) : undefined;
if (chosen?.error) throw new Error(chosen.error);

const results: { id: string; passed: boolean; calls: string[]; dialogs: string[]; notes: string[] }[] = [];
for (const item of CASES.filter(candidate => !values.case?.length || values.case.includes(candidate.id))) {
  const played = await playCase(item, { runtime, ...(chosen?.model ? { model: chosen.model } : {}) });
  results.push({ id: item.id, passed: played.passed, calls: played.calls.map(call => call.name), dialogs: played.dialogs, notes: played.notes });
  console.log(`${played.passed ? '✓' : '✗'} ${item.id}: ${played.calls.map(call => call.name).join(' → ') || 'no Lab tool'}${played.notes.length ? ` — ${played.notes.join('; ')}` : ''}`);
}
const passed = results.filter(result => result.passed).length;
console.log(`\n${passed} of ${results.length} phrases reached the right tool and state (model: ${chosen?.model ? `${chosen.model.provider}/${chosen.model.id}` : 'Pi default'}).`);
console.log(JSON.stringify({ model: values.model ?? null, results }, null, 2));
process.exitCode = passed === results.length ? 0 : 1;
