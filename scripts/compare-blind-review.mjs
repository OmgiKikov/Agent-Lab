#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fingerprint } from '../dist/contracts.js';
const { values } = parseArgs({ options: { packet: { type: 'string' }, labels: { type: 'string' }, output: { type: 'string' } } });
if (!values.packet || !values.labels || !values.output) throw new Error('Usage: node scripts/compare-blind-review.mjs --packet DIRECTORY --labels JSON --output NEW_JSON');
const directory = resolve(values.packet);
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const [packet, key, labels] = await Promise.all([json(join(directory, 'packet.json')), json(join(directory, 'private-key.json')), json(values.labels)]);
if (fingerprint(packet) !== key.packetHash || labels.protocol !== packet.protocol || labels.runId !== packet.runId || labels.sourceHash !== packet.sourceHash) throw new Error('Labels do not belong to this exact review packet');
if (!Array.isArray(labels.reviews) || labels.reviews.length !== packet.cases.length || new Set(labels.reviews.map(r => r.id)).size !== packet.cases.length) throw new Error('Every case needs exactly one human verdict');
const comparisons = packet.cases.map(item => {
  const review = labels.reviews.find(r => r.id === item.id);
  const target = key.targets.find(t => t.id === item.id);
  if (!target || target.inputHash !== item.inputHash || review?.inputHash !== item.inputHash || !['pass', 'fail', 'unknown', 'invalid'].includes(review.verdict) || typeof review.note !== 'string' || !review.note.trim()) throw new Error(`Incomplete or incompatible review for ${item.id}`);
  if (item.brief && !['plausible', 'implausible', 'unknown'].includes(review.realism)) throw new Error(`Missing independent realism judgment for ${item.id}`);
  return { ...(item.brief ? { realism: review.realism } : {}), id: item.id, title: item.title, ...target.target, human: review.verdict, model: target.modelResult, note: review.note,
    matches: review.verdict === target.modelResult, inputHash: item.inputHash };
});
const decisive = comparisons.filter(c => ['pass', 'fail'].includes(c.human));
const result = { protocol: 'independent-comparison-1', packetHash: key.packetHash, labelsHash: fingerprint(labels), sourceHash: packet.sourceHash,
  at: new Date().toISOString(), sample: 'Targeted diagnostic sample; not a population estimate of judge accuracy.',
  total: comparisons.length, humanDecisive: decisive.length, modelMatchesHuman: decisive.filter(c => c.matches).length,
  falsePass: decisive.filter(c => c.human === 'fail' && c.model === 'pass').length,
  falseFail: decisive.filter(c => c.human === 'pass' && c.model === 'fail').length,
  modelAbstained: decisive.filter(c => c.model === 'unknown').length,
  humanUnknown: comparisons.filter(c => c.human === 'unknown').length, invalidCards: comparisons.filter(c => c.human === 'invalid').length,
  comparisons };
await writeFile(values.output, JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ total: result.total, humanDecisive: result.humanDecisive, modelMatchesHuman: result.modelMatchesHuman, falsePass: result.falsePass, falseFail: result.falseFail, humanUnknown: result.humanUnknown, invalidCards: result.invalidCards }));
