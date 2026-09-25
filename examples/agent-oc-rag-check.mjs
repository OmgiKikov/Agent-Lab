#!/usr/bin/env node
/**
 * Живая проверка эталонов RAG на agent_oc без моделей Agent Lab.
 *
 * Карточки из examples/agent-oc-rag-cases.py (вопрос клиента + статья, размеченная асессором) проходят
 * валидацию Lab, где из эталона выводится проверка «агент нашёл статью N», затем один ход через
 * examples/agent-oc-adapter.py и точную оценку. Симулятор и судья не нужны: клиент только задаёт вопрос.
 * Модели вызывает сам agent_oc, со своим .env.
 *
 *   node examples/agent-oc-rag-check.mjs --cases .agent-lab/rag-golden.json --agent ../agent_oc [--limit 5] [--control]
 *
 * --control добавляет копию первой карточки с заведомо неверной статьёй: она обязана провалиться,
 * иначе проверке нельзя верить. Обрыв связи с моделью (timeout, handshake) повторяется до --retries раз;
 * другие ошибки измерения не повторяются и показываются как «не измерено».
 *
 * Нужна свежая сборка dist/ (npm run build).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { evaluateTrial } from '../dist/evaluation.js';
import { observabilityLevel } from '../dist/observability.js';
import { fingerprint, goldenCaseSchema, goldenToScenario, settingsSchema, validatePreparation } from '../dist/contracts.js';

const TRANSIENT = /timeout|handshake|timed out/i;
const CONTROL_DOC = 'control-no-such-article';
const lab = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { values } = parseArgs({ options: {
  cases: { type: 'string' }, agent: { type: 'string', default: resolve(lab, '../agent_oc') }, python: { type: 'string' },
  limit: { type: 'string', default: '40' }, retries: { type: 'string', default: '3' }, control: { type: 'boolean', default: false },
} });
if (!values.cases) throw new Error('Укажите --cases: файл golden-кейсов из examples/agent-oc-rag-cases.py');

const agent = resolve(values.agent);
const target = { kind: 'command', command: values.python ?? resolve(agent, '.venv/bin/python'),
  args: [resolve(lab, 'examples/agent-oc-adapter.py'), agent], cwd: agent, timeoutMs: 180000 };
const scenarios = prepareCards(readCases(values.cases, Number(values.limit), values.control));
const trials = [];
for (const scenario of scenarios) {
  const trial = await measure(scenario, Number(values.retries));
  trials.push(trial);
  printCard(scenario, trial);
}
printSummary(scenarios, trials);

function readCases(file, limit, control) {
  const cases = JSON.parse(readFileSync(file, 'utf8')).slice(0, limit).map(raw => goldenCaseSchema.parse(raw));
  if (control && cases.length) cases.push(goldenCaseSchema.parse({ ...cases[0], id: `${cases[0].id}_control`.slice(0, 80),
    references: [{ id: 'control', origin: 'owner', confirmed: true, source: { doc: CONTROL_DOC } }] }));
  return cases;
}

/** Opening only: the check is about what the agent retrieves for the client's own question. */
function prepareCards(cases) {
  const requirement = { id: 'assessor_markup', text: 'Разметка асессора', sourceId: 'markup', quote: 'Разметка асессора', critical: false };
  const source = { id: 'markup', name: 'Разметка асессора', content: 'Разметка асессора', hash: fingerprint('Разметка асессора') };
  return validatePreparation({ requirements: [requirement], questions: [], agent: { name: 'agent_oc', instructions: 'external agent', tools: [] },
    scenarios: cases.map(c => ({ ...goldenToScenario({ ...c, maxFollowUps: 0, script: [] }), metrics: [] })) }, [source], 'evaluate').scenarios;
}

async function measure(scenario, retries) {
  const unused = async () => { throw new Error('Проверка эталонов не вызывает модели Agent Lab.'); };
  const spec = { name: 'agent_oc', instructions: 'external agent', tools: [] };
  const input = { runtime: { prepare: unused, improve: unused, openTarget: unused, userTurn: unused },
    revision: { id: fingerprint(spec), spec, parentId: null, hypothesis: 'RAG reference check', createdAt: new Date().toISOString() },
    scenario, sources: [], requirements: [], repeat: 0, manifestHash: 'agent-oc-rag-check', userMode: 'scripted', target,
    settings: settingsSchema.parse({ repeats: 1, maxTurns: 2, maxCalls: 5, userModes: ['scripted'], maxDurationMs: 600000 }) };
  let trial;
  for (let attempt = 0; attempt <= retries; attempt++) {
    trial = await evaluateTrial({ ...input, ctx: { signal: new AbortController().signal, timeoutMs: 180000, beforeCall() {}, addUsage() {} } });
    if (trial.outcome !== 'invalid' || !TRANSIENT.test(trial.reason)) break;
    process.stderr.write(`${scenario.id}: обрыв связи с моделью, повтор ${attempt + 1}\n`);
  }
  return trial;
}

function retrieved(trial) {
  return [...new Set(trial.events.filter(e => e.type === 'retrieval').flatMap(e => (e.result?.chunks ?? []).map(chunk => chunk.source)))];
}

function printCard(scenario, trial) {
  const expected = scenario.references?.map(r => r.source?.doc).filter(Boolean).join(', ');
  const verdict = { pass: 'совпало', fail: 'НЕ совпало', invalid: 'не измерено' }[trial.outcome] ?? trial.outcome;
  const detail = trial.outcome === 'invalid' ? trial.reason.slice(0, 200) : `достал: ${retrieved(trial).join(', ') || 'ничего'}`;
  console.log(`${scenario.id.padEnd(32)} эталон ${expected.padEnd(6)} ${verdict.padEnd(12)} ${detail}`);
}

function printSummary(scenarios, trials) {
  const count = outcome => trials.filter((t, i) => t.outcome === outcome && !isControl(scenarios[i])).length;
  const control = trials.find((_, i) => isControl(scenarios[i]));
  const measured = trials.filter(t => t.outcome !== 'invalid');
  console.log(`\nСовпало ${count('pass')}, не совпало ${count('fail')}, не измерено ${count('invalid')}.`);
  if (control) console.log(control.outcome === 'fail' ? 'Контроль с неверной статьёй провалился, как и должен.' : `ВНИМАНИЕ: контроль с неверной статьёй дал ${control.outcome}; проверке нельзя верить.`);
  const level = observabilityLevel(measured);
  console.log(`Уровень наблюдаемости адаптера: ${level.level} (ответ ${mark(level.reply)} · инструменты ${mark(level.tools)} · статьи ${mark(level.retrievals)} · состояние ${mark(level.state)}).`);
}

function isControl(scenario) { return scenario.references?.some(r => r.source?.doc === CONTROL_DOC) ?? false; }
function mark(value) { return value ? '✓' : '✗'; }
