#!/usr/bin/env node
/**
 * Reference level-2 command adapter for Agent Lab (see docs/adapter-contract.md).
 *
 * The agent here is a toy RAG over two articles; replace `ask` with a call into your agent and keep
 * the reply shape. Everything the agent retrieved goes to `retrievals`, the search itself to `events`,
 * and both completeness flags are true only because this loop sees the whole turn.
 *
 *   stdin  → {"type": "respond", "sessionId", "scenarioId", "initialState", "messages", "message"}
 *   stdout ← {"reply", "events", "eventsComplete", "eventScope", "retrievals", "retrievalsComplete", ...}
 *   stdin  → {"type": "close"}
 */
import { createInterface } from 'node:readline';

const KNOWLEDGE_BASE = [
  { source: 'KB-1', chunkId: 'KB-1#1', content: 'Возврат по эквайрингу занимает до 5 рабочих дней.' },
  { source: 'KB-2', chunkId: 'KB-2#1', content: 'Комиссия за эквайринг 1.5% от суммы операции.' },
];

const words = text => new Set(text.toLocaleLowerCase().match(/[\p{L}\d]{4,}/gu) ?? []);

function search(query) {
  const asked = words(query);
  return KNOWLEDGE_BASE
    .map(chunk => ({ ...chunk, score: [...words(chunk.content)].filter(word => asked.has(word)).length }))
    .filter(chunk => chunk.score > 0)
    .sort((a, b) => b.score - a.score);
}

function ask(message) {
  const found = search(message);
  return {
    reply: found[0]?.content ?? 'В базе знаний нет ответа на этот вопрос.',
    events: [{ tool: 'search_kb', args: { query: message }, result: { docIds: found.map(chunk => chunk.source) } }],
    retrievals: found,
  };
}

let turn = 0;
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const request = JSON.parse(line);
  if (request.type === 'close') break;
  turn++;
  const answer = ask(request.message);
  process.stdout.write(JSON.stringify({
    ...answer, eventsComplete: true, eventScope: ['search_kb'], retrievalsComplete: true,
    resetConfirmed: request.initialState?.external === undefined, version: 'reference-mjs-1', turn,
  }) + '\n');
}
