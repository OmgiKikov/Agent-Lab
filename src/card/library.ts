import { fingerprint, validatePreparation, type CardExecution, type Requirement, type Scenario, type Source } from '../contracts.js';
import { LibraryConflict } from '../errors.js';
import type { Traffic } from '../miner/schema.js';
import { libraryHash, snapshotDigest, verifiedAcceptance } from '../scenario-library.js';
import { compileCard } from './compile.js';
import { cardSchema, libraryV2Schema, type Card, type ClaimReceipt, type LibraryV2, type ScenarioLibrary } from './schema.js';
import { cardStatuses, type StatusContext } from './status.js';
import type { CustomerProfile } from '../target-schema.js';

/*
 * The card library as data: a draft grows one card at a time with the reviewer's receipts beside it, and an
 * acceptance compiles the chosen cards exactly once and seals each definition's hash. Every function returns
 * a new, parsed library; nothing here reads the store or calls a model.
 */

/** For an operation of the card format: a first-format library is only read. */
export function requireLibraryV2(library: ScenarioLibrary): LibraryV2 {
  if (library.formatVersion !== 2) throw new Error('Этот набор ситуаций в старом формате: его можно открыть и прогнать, но не дополнить ситуациями нового формата.');
  return library;
}

/** An empty draft; `traffic` is the topic traffic of the logs its cards will be sampled from. */
export function createLibraryV2(input: { id: string; imports: { id: string; contentHash: string }[]; sources: Source[]; requirements: Requirement[]; createdAt?: string; traffic?: Traffic[] }): LibraryV2 {
  return libraryV2Schema.parse({ formatVersion: 2, id: input.id, revision: 1, createdAt: input.createdAt ?? new Date().toISOString(), imports: input.imports,
    sources: input.sources, requirements: input.requirements, readingManifest: [], cards: [], nextNumber: 1, claims: [], receipts: [],
    ...(input.traffic?.length ? { traffic: input.traffic } : {}) });
}

const draftOnly = (library: LibraryV2): void => {
  if (library.acceptance) throw new Error('Утверждённые ситуации не меняются: подготовьте новый черновик.');
};

/** The rules the draft's cards are read against, kept equal to the record's as each card adds the sentences it cites. */
export function withRequirements(library: LibraryV2, requirements: readonly Requirement[]): LibraryV2 {
  if (fingerprint(library.requirements) === fingerprint(requirements)) return library;
  draftOnly(library);
  return libraryV2Schema.parse({ ...library, revision: library.revision + 1, requirements: structuredClone(requirements) });
}

/**
 * A draft with one more card. The card carries the library's next number, which is then never given again;
 * the reading row of its dialogue — the articles read before the card was written — names it.
 */
export function addCard(library: LibraryV2, card: Card, reading?: { dialogueId: string; batchId: string; sourceIds: string[] }): LibraryV2 {
  draftOnly(library);
  if (card.number !== library.nextNumber) throw new Error('Номер ситуации уже выдан.');
  if (library.cards.some(item => item.id === card.id)) throw new Error('Такая ситуация уже есть в наборе.');
  const row = reading && library.readingManifest.find(item => item.dialogueId === reading.dialogueId && item.batchId === reading.batchId);
  const readingManifest = !reading ? library.readingManifest
    : row ? library.readingManifest.map(item => item === row ? { ...item, cardIds: [...item.cardIds, card.id] } : item)
    : [...library.readingManifest, { ...reading, cardIds: [card.id] }];
  return libraryV2Schema.parse({ ...library, revision: library.revision + 1, cards: [...library.cards, card], nextNumber: card.number + 1, readingManifest });
}

/**
 * A draft whose card is replaced by its revision: the revision keeps the card's number and place, takes its reading row,
 * and counts one revision more. The receipts of the replaced card stay: they answer their content wherever it recurs.
 */
export function replaceCard(library: LibraryV2, previousId: string, card: Card): LibraryV2 {
  draftOnly(library);
  const previous = library.cards.find(item => item.id === previousId);
  if (!previous) throw new Error('Ситуации, которую переделывают, уже нет в наборе.');
  if (card.number !== previous.number) throw new Error('Переделанная ситуация сохраняет свой номер.');
  if (card.id !== previousId && library.cards.some(item => item.id === card.id)) throw new Error('Такая ситуация уже есть в наборе.');
  const replaced = cardSchema.parse({ ...card, revision: previous.revision + 1 });
  const readingManifest = library.readingManifest.map(row => row.cardIds.includes(previousId)
    ? { ...row, cardIds: row.cardIds.map(id => id === previousId ? replaced.id : id) } : row);
  return libraryV2Schema.parse({ ...library, revision: library.revision + 1, readingManifest,
    cards: library.cards.map(item => item.id === previousId ? replaced : item) });
}

/** The reviewer's receipts, once per key: an answered key keeps its answer, so a similar card reuses it. */
export function recordClaims(library: LibraryV2, receipts: readonly ClaimReceipt[]): LibraryV2 {
  const known = new Set(library.claims.map(claim => claim.key));
  const fresh: ClaimReceipt[] = [];
  for (const receipt of receipts) if (!known.has(receipt.key)) { known.add(receipt.key); fresh.push(receipt); }
  if (!fresh.length) return library;
  draftOnly(library);
  return libraryV2Schema.parse({ ...library, revision: library.revision + 1, claims: [...library.claims, ...fresh] });
}

/**
 * Accepts ready cards for a run: each is compiled here, once, and the hash of its definition is sealed in the
 * receipt with the library body, so a run, repeat or reassessment later proves by hashes alone that it runs what
 * was accepted (verifyAcceptedRun) and nothing is ever compiled again. The same selection with the same
 * definitions keeps its receipt; another one is a new revision.
 */
export function acceptLibraryV2(library: LibraryV2, expectedHash: string, cardIds: string[],
  context: Omit<StatusContext, 'library'> & { environment?: CardExecution['environmentView']; profile?: CustomerProfile }): { library: LibraryV2; scenarios: Scenario[] } {
  if (libraryHash(library) !== expectedHash) throw new LibraryConflict('Библиотека изменилась: хеш устарел.');
  if (!cardIds.length || cardIds.length > 200 || new Set(cardIds).size !== cardIds.length) throw new Error('Выберите ситуации без повторов.');
  const statuses = cardStatuses({ ...context, library });
  const cards = cardIds.map(id => {
    const card = library.cards.find(item => item.id === id);
    if (!card) throw new Error('Такой ситуации нет в наборе.');
    if (statuses.get(id)?.status !== 'ready') throw new Error(`Ситуация №${card.number} ещё не готова к прогону.`);
    return card;
  });
  const compiled = cards.map(card => {
    const { split: _split, ...scenario } = compileCard(card, { requirements: library.requirements, maxTurns: context.maxTurns,
      ...(context.environment ? { environment: context.environment } : {}), ...(context.profile?.length ? { profile: context.profile } : {}) });
    return scenario;
  });
  const scenarios = validatePreparation({ requirements: library.requirements, questions: [], scenarios: compiled }, library.sources).scenarios;
  const definitions = scenarios.map(scenario => ({ cardId: scenario.id, definitionHash: fingerprint(scenario) }));
  const next = libraryV2Schema.parse(library);
  if (next.acceptance) {
    verifiedAcceptance(next);
    if (fingerprint(next.acceptance.definitions) === fingerprint(definitions)) return { library: next, scenarios };
  }
  // Acceptance changes no card, so the accepted library is a revision of its own: the draft it came from stays stored as it was.
  next.revision++;
  const seal = { libraryHash: libraryHash(next), cardIds: [...cardIds], definitions };
  next.acceptance = { revision: next.revision, ...seal, snapshotHash: snapshotDigest(next, seal) };
  return { library: next, scenarios };
}
