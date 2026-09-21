import assert from 'node:assert/strict';

/*
 * The copywriting contract of phase 3 as an assertion: what we write for a person is plain
 * Russian. Everything the contract allows is removed first — the board keys, the product name and
 * the `/agent-lab <id8>` command — and whatever Latin or machine word is left is the failure.
 *
 * Record text is not our copy: a situation title and the owner's own reason come from the record,
 * so the fixtures that feed this scan fill them with Russian text.
 */

/** Removed before the scan, in this order: the command first, so its own letters are not eaten. */
const ALLOWED: RegExp[] = [
  /\/agent-lab [0-9a-f]{8}/g,
  /\bPi\b/g,
  /\b[afnorsvxy]\b/g,
];

/** Machine words that read as Russian but say nothing to a person (UI-SPEC «Forbidden»). */
const FORBIDDEN: RegExp[] = [/каппа/i, /метрик/i, /протокол/i, /хеш/i, /рубрик/i, /кластер/i];

/** Fails on the first offending word alone, so the message names what to rewrite. */
export function assertPlainCopy(text: string, label = 'строка'): void {
  let rest = text;
  for (const allowed of ALLOWED) rest = rest.replace(allowed, '');
  const latin = rest.match(/[A-Za-z]+/);
  assert.equal(latin?.[0], undefined, `${label}: латинское слово «${latin?.[0]}» в «${text}»`);
  for (const forbidden of FORBIDDEN) {
    const machine = rest.match(forbidden);
    assert.equal(machine?.[0], undefined, `${label}: машинное слово «${machine?.[0]}» в «${text}»`);
  }
}
