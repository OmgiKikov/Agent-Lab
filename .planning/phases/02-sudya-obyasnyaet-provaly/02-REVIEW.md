---
phase: 02-sudya-obyasnyaet-provaly
reviewed: 2026-09-17T00:00:00Z
depth: standard
files_reviewed: 18
files_reviewed_list:
  - src/explain.ts
  - src/plural.ts
  - src/quality.ts
  - src/result-view.ts
  - src/comparison.ts
  - src/experiment.ts
  - src/contracts.ts
  - src/cli.ts
  - src/judge.ts
  - src/evaluation.ts
  - extensions/agent-lab.ts
  - extensions/cards.ts
  - test/explain.test.ts
  - test/result-view.test.ts
  - test/cards.test.ts
  - test/extension.test.ts
  - test/experiment.test.ts
  - test/quality.test.ts
findings:
  critical: 3
  warning: 7
  info: 3
  total: 13
status: issues_found
---

# Phase 2: Code Review Report

**Reviewed:** 2026-09-17
**Depth:** standard
**Files Reviewed:** 18
**Status:** issues_found

## Summary

Reviewed `git diff 8f83c91..HEAD` for the listed files, focused on the phase-2 surface: failure
explanations (`src/explain.ts`), the expectation sheet (`src/quality.ts`), the result block and
failure sections (`src/result-view.ts`), `setExpectation` / `acceptDraft` / `requireAccepted`
(`src/experiment.ts`), and the board/Pi wiring (`extensions/cards.ts`, `extensions/agent-lab.ts`).

Clean on the two things that were called out as most dangerous:

- **v11 rollback is complete.** `grep -rn "judgedCut|judgedBeforeSeq|cutBefore|goal-v2|goalV2|v11" src/ extensions/ test/` returns nothing, `JUDGE_PROTOCOL_V10` is gone, and `git log -L` on the
  `JUDGE_PROTOCOL` line shows commit `c8b9e27` restored the v10 fingerprint object byte-for-byte
  (same key order, same values) as it stood before `6fa77f0`. No dead `FIDELITY_ID`, no prefix
  fields left in the hashed object.
- **Old-record hash stability holds.** `fingerprint` (`src/contracts.ts:984`) normalizes through
  `JSON.stringify`, which drops `undefined` values, so adding `positiveControlScenarioIds` and
  `ownerExpectationScenarioIds` to `draftHash` (`src/experiment.ts:35-42`) does not move the hash of
  any record written before they existed.

The serious problems are elsewhere, and they are honesty problems, which is exactly what this phase
is about. The Pi run path now stamps `reviewMode: 'human'` on the record while the very dialog that
produces that stamp still tells the owner the opposite, and the same dialog was simultaneously made
to show *less* of each card than it did before. A third defect prints the phase's own
«не подтверждено» sentinel inside quotation marks in the exported HTML and Markdown report, so the
report states that the agent said it.

## Critical Issues

### CR-01: The run dialog says «this is not a manual check», and the record then claims it was

**File:** `extensions/agent-lab.ts:628`, `extensions/agent-lab.ts:869`, `extensions/agent-lab.ts:85`

Both Pi run paths were changed from `reviewer: 'automated'` to `reviewer: 'human'`:

```ts
// extensions/agent-lab.ts:628 (agent_lab_run) and :869 (board `r`)
if (!confirmed) await lab.acceptDraft(draft.id, params.expectedHash);
await lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: params.expectedHash, parallel: runParallel(draft), requireAccepted: true });
```

The body of that same confirmation dialog is `runPlan(record)`, whose last line is still
(`extensions/agent-lab.ts:85`):

```
'Запуск не означает, что вы вручную проверили все ожидания или оценки.'
```

So the owner is told, in the confirmation itself, that pressing «Да» does **not** mean they checked
the expectations — and pressing «Да» is now precisely what writes `reviewMode: 'human'`. That stamp
is not cosmetic:

- `src/experiment.ts:998-999` — `reviewMode === 'human'` **suppresses** the limitation
  `'Generated scenario expectations were checked automatically, without human validation. Spot-check disputes; …'`.
  The limitation silently disappears from every record produced through Pi.
- `src/report.ts:256` — the exported report prints «Проверка карточек: **человеком**».
- `extensions/cards.ts:600` — the board prints «Карточки: **подтверждены человеком**».
- `src/experiment.ts:1275-1278` — in the compare workflow, `reviewMode !== 'human'` is what downgrades
  an `improved` verdict to `insufficient` and adds
  `'Scenario expectations have not been validated by a human; this comparison is provisional.'`

`test/extension.test.ts:311` pins `result.reviewMode === 'human'` and `test/extension.test.ts:323`
pins that the plan still matches `/Запуск не означает/`, so the contradiction is currently frozen
into the test suite rather than caught by it.

This violates the project's Truth constraint directly: the record asserts an observation
(«человек проверил карточки») that the UI explicitly disclaimed at the moment it was made.

**Fix:** pick one story and make the code and the text agree.

```ts
// Option A (recommended, smallest): the confirmation now really is an expectation confirmation,
// so replace the disclaimer with what actually happened, and narrow the claim.
// extensions/agent-lab.ts, runPlan():
'Подтверждая, вы подтверждаете ожидания ситуаций выше. Оценки судьи вы не проверяли.',

// and record what was confirmed rather than reusing the card-review flag:
await lab.start(draft.id, { approved: true, reviewer: 'expectations', /* new mode */ ... });
// src/experiment.ts: treat 'expectations' as NOT 'human' for the compare downgrade at :1275 and
// for report.ts:256 / cards.ts:600, and push a narrower limitation instead of dropping it:
record.limitations.push('Владелец подтвердил ожидания ситуаций; определения карточек и оценки судьи вручную не проверялись.');
```

If the deviation is meant to stay as-is, then `runPlan`'s last line must be deleted and
`report.ts:256` / `cards.ts:600` must say what was actually confirmed («ожидания подтверждены
владельцем»), not «карточки проверены человеком».

### CR-02: The run-plan confirmation for a multi-situation suite no longer shows the opening request or the exact checks

**File:** `extensions/agent-lab.ts:61-72`

`runScope` was rewritten so that **any** evaluate draft in `review` with more than one situation now
renders the compact expectation sheet:

```ts
const sheet = record.workflow === 'evaluate' && record.phase === 'review' && record.scenarios.length > 1
  ? expectationSheet(record) : undefined;
if (sheet) { /* goal + «Должен: …» + at most 2 rules, per situation */ }
return record.scenarios.map(s => [safeText(s.title), `  Запрос: ${safeText(s.user.opening)}`, …,
  `  Ожидается: …`, ...s.checks.map(c => `  Проверка: ${safeText(describeCheck(c))}`)].join('\n'));
```

Before this change the compact branch fired only when `record.scenarios.every(s => s.provenance === 'production')`;
every other multi-card set (a saved regression suite, a golden set, a mixed set) fell through to the
detailed branch and showed `Запрос: {opening}`, the scripted follow-ups, and every
`Проверка: {describeCheck(c)}`. Those three lines are now gone for all of them.

Combined with CR-01, the confirmation dialog shows **strictly less** of each card than it used to
while the resulting record claims **more** human validation than it used to. The owner cannot see
the exact checks they are about to freeze (`acceptDraft` writes `definitionHash = fingerprint(scenario)`
for every card, i.e. it seals the checks, the initial state and the simulator facts too).

**Fix:** keep the sheet as the lead, but restore the parts of the card that acceptance actually
seals, at least for cards that carry deterministic checks:

```ts
if (sheet) {
  const withChecks = record.scenarios.filter(s => s.checks.length);
  return [...(fromLog ? [...] : []),
    ...sheet.compactLines(record.id).map(safeText),
    ...(withChecks.length ? ['', 'Точные проверки:',
      ...withChecks.flatMap(s => [safeText(s.title),
        ...s.checks.map(c => `  Проверка: ${safeText(describeCheck(c))}`)])] : [])];
}
```

### CR-03: The report quotes the «не подтверждено» sentinel as if the agent had said it

**File:** `src/quality.ts:536`, `src/report.ts:159`, `src/report.ts:250`

`causeExample` returns the sentinel string as the cause `quote` when the reply could not be verified:

```ts
// src/quality.ts:536
return { quote: explanation.said?.quote ?? UNVERIFIED, ...(explanation.said ? { seq: explanation.said.seq } : {}), explanation };
```

`UNVERIFIED` is `'объяснение не подтверждено цитатой'` (`src/explain.ts:16`). Both exporters wrap
`example.quote` in guillemets without distinguishing it from a real quote:

```ts
// src/report.ts:159 (HTML)
`${escape(c.example.card)}: «${escape(c.example.quote)}»`
// src/report.ts:250 (Markdown)
` Пример — ${md(c.example.card)}: «${md(c.example.quote)}»`
```

The HTML the owner forwards to the customer therefore reads:

> **Возврат покупки** · 3 диалога
> Карточка X: «объяснение не подтверждено цитатой»

which states that the agent uttered that sentence. Inside the terminal the same string is carried by
an explicit `role: 'unverified'` row and is coloured as a warning; the export loses that role and
turns an honest gap into a fabricated quotation. This is the exact failure mode the phase set out to
prevent.

**Fix:** carry the verification state across the boundary instead of overloading `quote`.

```ts
// src/quality.ts — make the gap explicit on the cause
export interface QualityCause { …; example?: { trialId; card; quote; seq?; verified: boolean; explanation? } }
// causeExample:
return explanation.said
  ? { quote: explanation.said.quote, seq: explanation.said.seq, verified: true, explanation }
  : { quote: UNVERIFIED, verified: false, explanation };

// src/report.ts:159 / :250 — never quote an unverified example
c.example.verified ? `: «${escape(c.example.quote)}»` : `: ${escape(UNVERIFIED)}`
```

## Warnings

### WR-01: `violatedRule` can name the wrong owner rule from a 12-character coincidence

**File:** `src/explain.ts:129-143`

```ts
const QUOTED_SPAN = /«([^«»]{12,})»/g;               // src/explain.ts:49
…
if (spans.some(span => quote.includes(span) || span.includes(quote))) found.set(rule.number, rule);
return found.size === 1 ? [...found.values()][0] : undefined;
```

A single registered prompt rule that shares any ≥12-character substring with any `«…»` span of the
judge's rationale is promoted to *the* violated rule, and the row asserts it flatly:

```
Должен был: соблюдать правило 7 · Промпт, строка 14: «…»
```

Twelve characters is short for Russian rule text (`«оплата картой»` is 13; `«в течение дня»` is 13),
and `span.includes(quote)` additionally matches whenever a *short* rule quote sits anywhere inside a
long judge span. `found.size === 1` does not protect against this: a single wrong match is exactly
the case that gets named. The «не подтверждено» fallback only fires on zero or ≥2 matches, so a false
positive is reported with the same confidence as a true one.

**Fix:** require a stronger match before naming a rule — e.g. only accept a span that is at least a
fixed fraction of the rule quote, and prefer the longest match rather than requiring uniqueness:

```ts
const MIN_SPAN_RATIO = 0.6;
if (spans.some(span => (quote.includes(span) && span.length >= Math.ceil(quote.length * MIN_SPAN_RATIO))
  || (span.includes(quote) && quote.length >= 24))) found.set(rule.number, rule);
```

### WR-02: A rule's line number points at the first occurrence of the text, not at the requirement's own

**File:** `src/explain.ts:69-70`, `src/explain.ts:79`

```ts
const span = source ? verbatimSpan(source.content, requirement.quote) : undefined;
const offset = source.content.indexOf(span);
…
line: numbered ? row.source.content.slice(0, row.offset).split('\n').length : null,
```

`verbatimSpan` locates a match but returns only the matched *text*; `indexOf` then re-finds the
first occurrence of that text in the source. When the same sentence appears more than once (common
in prompts with repeated boilerplate, or in an FAQ source), `Правило N · Источник, строка L` names
the wrong line, and — because `offset` also feeds the register's sort key — two requirements sharing
a quote get an arbitrary relative order. The row is presented as verified evidence, so a wrong line
number is a small but real honesty defect.

**Fix:** have `verbatimSpan` (or a sibling) return the offset it actually matched and thread it
through, instead of re-searching:

```ts
// src/contracts.ts
export function verbatimSpanAt(content: string, quote: string): { span: string; offset: number } | undefined { … }
// src/explain.ts
const found = source ? verbatimSpanAt(source.content, requirement.quote) : undefined;
if (!source || !found) return [];
return [{ requirement, index, sourceIndex, source, span: found.span, offset: found.offset }];
```

### WR-03: The control warning steals the `lead` role, so the trust warning renders as plain text and the headline is muted

**File:** `src/result-view.ts:211-216`, `extensions/cards.ts:74-77`

```ts
// src/result-view.ts
const add = (role: ResultRowRole, text: string, indent = 0) => { rows.push({ role: rows.length ? role : 'lead', indent, text }); };
if (control.warning) add('line', control.warning);
add('line', headline.text);
```

`add` rewrites the role of whichever row happens to be first into `lead`. When a control warning
exists it is emitted first, so:

- the warning («Контроль не пройден — числу пока не верить: проверьте судью и связь с агентом.»)
  gets `lead` → `{ color: 'text', bold: true }` (`extensions/cards.ts:74-77`), i.e. it loses all
  warning colouring;
- the headline falls to `line` → `{ color: 'muted' }`, so the one number the whole product exists to
  show is rendered dimmed exactly in the situation where the reader most needs to notice both rows.

**Fix:** give the warning its own role and keep `lead` on the headline.

```ts
// src/result-view.ts
export type ResultRowRole = 'lead' | 'line' | 'situation' | 'detail' | 'alarm';
const rows: ResultRow[] = [];
if (control.warning) rows.push({ role: 'alarm', indent: 0, text: control.warning });
rows.push({ role: 'lead', indent: 0, text: headline.text });
// then `add` no longer needs to rewrite the first role at all
// extensions/cards.ts: VIEW_ROLE.alarm = { color: 'error', bold: true }
```

### WR-04: «Ожидание изменено после подтверждения» is shown for any draft change, not only an expectation change

**File:** `extensions/cards.ts:394-397`

```ts
if (record.acceptedDraftHash === sheet.draftHash) return { text: 'Ожидания подтверждены. r — запуск.', color: 'success' };
if (record.acceptedDraftHash) return { text: 'Ожидание изменено после подтверждения. y — подтвердить снова.', color: 'warning' };
```

`draftHash` (`src/experiment.ts:35-42`) covers `task`, `sources`, `settings`, `target`,
`requirements`, `questions`, `dialogues`, `profiles`, `notes`, the agent spec, `targetVersion`,
`targetFingerprint` and `evaluatorVersion` — not just the expectations. Changing the judge model
through `agent_lab_edit`, or a re-preflight that moves `targetFingerprint`, therefore tells the
owner that an *expectation* changed when none did. The same overstatement reaches the tool result
via `draftFooter` and the `y` hint.

**Fix:** say what actually changed, or compare the expectations themselves:

```ts
const expectationsHash = fingerprint(record.scenarios.map(s => [s.id, s.successCriteria,
  s.metrics?.find(m => m.id === 'goal_attainment' && m.subject === 'agent')?.passCriteria]));
// keep acceptedDraftHash for the run gate, and word the header from the narrower comparison:
if (record.acceptedDraftHash) return { text: 'Черновик изменился после подтверждения. y — подтвердить снова.', color: 'warning' };
```

### WR-05: The cause example quote is now unbounded

**File:** `src/explain.ts:113-121`, `src/quality.ts:530-538`

The replaced `firstReason` clamped its quote with `shorten(assessment.rationale…)` (220 characters).
`causeExample` now takes `explanation.said.quote`, which comes from `saidRow`:

```ts
const evidence = cited && !cited.citations ? cited.evidence.map(reply).find(Boolean) : undefined;
if (evidence) return shown(evidence.seq, collapse(evidence.text ?? ''), true);
const last = replies.at(-1);
if (last) return shown(last.seq, collapse(last.text ?? ''), false);
```

Both fallbacks emit the *entire* agent reply. In the terminal that is fine (the board wraps and
`shorten` is no longer wanted there), but the same value is what `report.ts:159`/`:250` inline into
the «Почему не справился» list of the HTML and Markdown report, where a multi-thousand-character
reply inside a `<li>` destroys the cause list the customer reads first.

**Fix:** keep the full quote on the explanation rows (terminal) and clamp only the flattened
`example.quote` that the exporters inline:

```ts
// src/quality.ts causeExample:
return { quote: shorten(explanation.said?.quote ?? UNVERIFIED), … };
```

### WR-06: The control warning and the control line disagree for a control with no recorded reason

**File:** `src/result-view.ts:159-163`, `src/result-view.ts:205-213`

```ts
const controlUnmeasured = controlCards.some(card => card.outcome === 'unknown' && card.reason !== 'in_progress');
const controlWarning = controlFailed || controlUnmeasured ? `Контроль … не измерен — числу пока не верить: …` : null;
…
: notStarted || only.reason === 'in_progress' || !only.reason ? 'Контроль: ещё не проверен.'
```

A started run whose single control card is `unknown` with **no** `reason` satisfies
`controlUnmeasured` (so the alarm «Контроль не измерен — числу пока не верить» fires) while
`controlLine` takes the `!only.reason` branch and says the calm «Контроль: ещё не проверен.». The two
rows shown one under the other contradict each other.

**Fix:** use one predicate for both:

```ts
const unmeasuredControl = (card: { outcome: CardOutcome; reason?: NotMeasuredCode }) =>
  card.outcome === 'unknown' && !!card.reason && card.reason !== 'in_progress';
const controlUnmeasured = controlCards.some(unmeasuredControl);
```

### WR-07: `measurementHash` ignores `positiveControlScenarioIds` and `ownerExpectationScenarioIds`

**File:** `src/experiment.ts:46-50`

```ts
export function measurementHash(record: Experiment): string {
  return fingerprint({ version: VERSION, workflow, task, baseline, mode, sources, requirements, scenarios, settings,
    target, goldenCases, dialogues, profiles, notes, targetVersion, targetFingerprint, evaluatorVersion });
}
```

Neither new field is part of the manifest, yet `positiveControlScenarioIds` changes what the headline
counts (`buildResultView` excludes controls from `counted`, `src/result-view.ts:198-208`). Most of
the time the omission is masked because `oneTurnControls` rewrites `user.maxFollowUps`/`user.script`
and thus moves `scenarios`; but when the marked cards are *already* one-turn (`maxFollowUps: 0`, no
`script` — exactly the shape a discovery-built or reactive-disabled card has), `oneTurnControls` is a
no-op and two runs with different control sets carry an identical `manifestHash` while reporting
accuracy over different denominators. `manifestHash` equality is the record's own claim that the two
runs measured the same thing.

`ownerExpectationScenarioIds` is protected today only indirectly (a `setExpectation` also rewrites
`successCriteria`), so it is a latent version of the same gap.

**Fix:** put both fields in the manifest, using the same `undefined`-drops-out property that keeps old
records stable:

```ts
export function measurementHash(record: Experiment): string {
  return fingerprint({ …,
    positiveControlScenarioIds: record.positiveControlScenarioIds,
    ownerExpectationScenarioIds: record.ownerExpectationScenarioIds });
}
```

## Info

### IN-01: `explain.ts`'s header comment lists an import it does not have

**File:** `src/explain.ts:12-13`
**Issue:** The module comment says «Imports only contracts.js, outcomes.js, comparison.js, judge.js and
plural.js», but the file imports `contracts.js`, `outcomes.js`, `judge.js` and `plural.js` — never
`comparison.js`. Since the comment exists to pin the allowed dependency set, a stale entry invites a
future import that the comment appears to bless.
**Fix:** drop `comparison.js` from the list.

### IN-02: `text.causes` is computed and discarded in the CLI summary

**File:** `src/cli.ts:104-113`
**Issue:** `const text = qualityLines(q);` still builds `causes`, but the «Почему:» block was replaced
by `causeLines`/`failureLines`, so only `text.metrics`, `text.rag`, `text.queue`, `text.scope` and
`text.limits` are used. The clustering work behind `causes` is done and thrown away on this path.
**Fix:** either destructure only what is used, or (better) confirm `causeSection` is meant to fully
replace it and note that in the comment above the write.

### IN-03: `cli.ts accept` calls `expectationSheet` without the workflow/phase guard used at every other call site

**File:** `src/cli.ts:280-281`
**Issue:** Every other caller (`extensions/agent-lab.ts:62`, `:102`, `extensions/cards.ts:400`) guards
`workflow === 'evaluate' && phase === 'review'` before calling `expectationSheet`; here the only
condition is `record.scenarios.length > 1`. Running `agent-lab accept --id RUN` against a finished run
surfaces the sheet's internal message («Показать ожидания можно только для незапущенного черновика.»)
instead of the accept-path message, and the one-scenario branch below produces a different wording for
the same situation.
**Fix:** guard the branch the way the other call sites do, and let `acceptDraft`'s own errors speak:

```ts
if (record.workflow === 'evaluate' && record.phase === 'review' && record.scenarios.length > 1) { … }
```

---

_Reviewed: 2026-09-17_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
