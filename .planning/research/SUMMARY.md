# Project Research Summary

**Project:** Agent Lab (Pi package): trust in the number and result UX, for the customer demo on 2026-09-21
**Domain:** Evaluating a real banking RAG agent with a reactive user simulator and an LLM judge. Results appear in the Pi terminal, and a single-file HTML report plus a copyable text summary go to the customer's manager.
**Researched:** 2026-09-16
**Confidence:** MEDIUM-HIGH. Code and Pi API facts are HIGH (checked at `628ff25` and in the installed 0.85.1 typings). Product behaviour of other tools and the statistics literature are MEDIUM. Size budgets, key choices and phase cuts are design judgement.

## Executive Summary

Agent Lab already produces the right *data*: binary verdicts, "not measured" kept apart from failures, cited evidence, and human overrides. What it lacks is one trustworthy, readable *presentation* of that data. All four research streams agree on the same diagnosis. Each surface builds its own numbers: the chat block (`agent-lab.ts:20-38`), the board (`cards.ts:186-255`), the CLI and `report.ts`. That is why the first screen shows several denominators, cuts reasons mid-word and uses jargon. Serious eval tools (Braintrust, LangSmith, Langfuse, promptfoo, Cekura) lead with one pass rate, keep errors apart from failures, and track judge-vs-human alignment as "% with a denominator". None of them writes a plain-language verdict for a manager, and none gives the structured "должен был X → сказал Y → правило N" explanation. Those two gaps are where Agent Lab can stand out.

**Recommended approach:**
1. Build one pure `ResultView` view-model on top of the existing analysis (`qualitySummary`, `verdictSummary`, `outcomes.ts`). It must use one denominator, give the main "не измерено" reason by name, and describe small samples in words.
2. Render it four ways with no new runtime dependency:
   - the Pi tool `renderResult` or a custom entry;
   - the existing `ctx.ui.custom` board, with tabs;
   - a plain-text summary;
   - a no-JS single-file HTML report under 200 KB.
3. Build the failure explanation from data the record already holds: `successCriteria`, verbatim assistant citations, and requirement ids with their quotes. This leaves the judge protocol unchanged, so earlier runs stay comparable.
4. Before any visible feature, land the invisible trust fixes:
   - `goalObservation` normalization at comparison time, not at parse time;
   - harness-assigned goal ids;
   - a shared `scoreSettings`;
   - judge audits moved out of the run record into a sidecar.

**Key risks:**
- **The agreement number can mislead.** "≥90% agreement" measured only on failures, at n≈10, with the judge's verdict shown first, measures precision on "fail" and invites automation bias. Show "N из M проверенных провалов", show the evidence before the verdict, and store the judge verdict and protocol hash with each review.
- **Judge-prompt churn.** Every edit makes all earlier runs incomparable and overfits the 9 pilot failures. Freeze the protocol by the end of Friday 2026-09-18, then re-assess once.
- **Bank data can leave the perimeter.** It can leak through a forwarded HTML file, a messenger summary, or production transcripts sent to OpenRouter. Use a customer report profile with no raw turns, a deterministic scrubber, and written customer approval before scoring production data.
- **A live demo can fail.** Present from a frozen, stored run that re-renders with zero model calls.
- **Four days are short.** Build in customer-visible order and agree in advance what gets cut.

## Key Findings

### Recommended Stack

No new dependency. Everything needed ships in the pinned `@earendil-works/pi-coding-agent@0.85.1` and `pi-tui@0.85.1`, plus Node built-ins and template strings. Details: STACK.md.

**Core technologies:**
- **`ToolDefinition.renderResult` reading `result.details.view`:** the verdict block and live progress (`isPartial`) for LLM-started runs. `details` is saved in the session, so the block renders again when the session is reopened. Stop parsing JSON back out of `content`.
- **`pi.appendEntry` + `pi.registerEntryRenderer`:** the same block for runs started from `/agent-lab` or the board. The entry is saved and rendered, but not sent to the LLM.
- **`ctx.ui.custom` overlay (100%):** the full-screen board, which already exists. Split `cards.ts` (529 lines) into a frame and per-tab pure line producers before adding tabs.
- **`ctx.ui.setWidget` with a component factory:** the onboarding checklist. A `string[]` widget is silently cut to 10 lines.
- **`ctx.ui.setStatus` + `setWorkingMessage`:** a one-line footer progress indicator that stays visible after the tool row scrolls away.
- **`Theme.fg/bg/bold` with semantic tokens only:** one visual language that adapts to light and dark themes. No chalk and no raw ANSI codes.
- **`visibleWidth` / `truncateToWidth` / `wrapTextWithAnsi`:** every width calculation and cut goes through these. No `.slice()` or `padStart` on user-facing text.
- **`copyToClipboard`:** exported but undocumented. Wrap it in try/catch and fall back to `ctx.ui.editor`.
- **Template strings + the existing `escape()` for HTML:**
  - inline CSS and server-computed inline SVG bars;
  - `<details>` for drill-down;
  - a strict CSP and no JavaScript;
  - `prefers-color-scheme` and `@media print`.

**Do not adopt before the demo:**
- `ScrollView` / `HStack`, which depend on a layout protocol;
- Ink, blessed, chart libraries or template engines;
- anything from promptfoo, GEPA or LangWatch.

### Expected Features

Details: FEATURES.md. Humanloop has shut down, and the OpenAI Evals platform shuts down on 2026-11-30, so neither is a reference point any more.

**Must have (table stakes):**
- One headline with one denominator. "Не измерено" is shown separately, with its main reason named (never "прочее"), and small samples are described honestly in words.
- Re-runs stay comparable (the `goalObservation` defect), and CLI `score` uses an honest budget.
- Every failure has a reason plus citations. Verdicts stay binary (pass / fail / unknown).
- A human override wins, takes one key, and agreement is shown as "N из M" with a list of disagreements.
- Board filters for failures and for unmeasured items. A failure opens the dialogue with the offending turn highlighted. Top-3 causes are wrapped, never truncated. A clear next-step line. Keyboard-first navigation.
- An artifact that works without Pi (single HTML file), a copyable short summary, and the date, agent version, sample size and judge on the report.
- Live progress (done / left) for 6–17 minute runs, and a connection check before any money is spent.
- Production dialogues scored by the same judge and criteria, shown next to the test with a plain caveat that the two populations differ.

**Should have (differentiators):**
- A plain-language verdict line for managers, built from a template and never written freely by an LLM.
- The structured failure triple X → Y → rule N with verified quotes and a link to the turn.
- Agreement collected with one key on the failure the person is already reading. No labeling session.
- A random spot-check of 2–3 passed dialogues, which covers the false-pass blind spot.
- An expectations sheet the owner confirms before paying.
- A live cost and ETA counter. None of the surveyed tools documents one.
- An HTML *verdict* for managers, where competitors export a table or a hosted link.

**Defer (v2+) and anti-features:**
- **Defer:**
  - one-sentence setup with automatic adapter generation (high variance per repo);
  - kappa and TPR/TNR, until there are 20 or more labels;
  - clustering of production traces.
- **Never build:**
  - annotation queues or kanban;
  - Likert or 0–100 scores;
  - kappa in the manager view;
  - automatic judge re-tuning from feedback (it breaks comparability);
  - suggested prompt fixes;
  - hosted links or a web dashboard;
  - real-time production monitoring;
  - mass synthetic scenarios;
  - dozens of metrics;
  - CI as the product centre;
  - LLM-written executive prose.

### Architecture Approach

Data flows one way: storage → async assembly (`evidenceBundle`, the only code that reads the store) → pure analysis (the only place numbers are made) → pure view-model (`buildResultView`) → pure renderers. Surfaces never call `qualitySummary` or `verdictSummary` directly. Details, file:line anchors and a wave plan: ARCHITECTURE.md.

**Major components (new unless marked):**
1. **`src/normalize.ts`:** the only home for the `goalObservation` default (replacing five scattered copies), harness goal ids, and `scoreSettings` shared by CLI and Pi. It is applied where identity is computed, **never at schema parse**, because that would break legacy `hasCompleteJudgment` input hashes.
2. **Judge receipt + audit sidecar** (`store.ts`, `evaluation.ts:297`, `judge.ts`, `contracts.ts`):
   - The full audit moves to `{id}.judge/{trialId}.json`, and the trial keeps a small hash-linked receipt.
   - The legacy path stays intact.
   - The journal gets one audit per finished vote, not a copy on every `save()`.
   - This change blocks production scoring, where the 50 MB read limit would otherwise be hit.
3. **`src/explain.ts`:** `failureExplanation(record, trial)`, which builds X → Y → N from stored provenance with no model calls. It replaces the regex-based `firstReason`.
4. **`judgeAgreement()` in `outcomes.ts`:** compares metric-level human verdicts with the **original** `trial.assessments[].result`, never with `agentMetricResult`, which already applies the override and would always give 100%.
5. **`src/result-view.ts`:** a `ResultView` with these parts:
   - `headline`, `notMeasured[]`, `topCauses` (at most 3), `failures[]` with `highlightSeqs`, `dialogues`;
   - `agreement`, `stability?`, `comparison?`, `production?`, `progress?`;
   - `nextStep`, `scope`, `countingRules`.

   It imports analysis modules only, never `experiment.ts`.
6. **`src/progress.ts`:** `progressView` (done/planned, ETA from mean `elapsedMs`, judge and simulator cost only) and a derived `preparationChecklist`.
7. **Renderers:**
   - `extensions/render/theme.ts` (shared bars, colors, wrapping);
   - `verdict-block.ts` and `board-*.ts`;
   - `src/render/text.ts` and `src/render/html.ts`.
8. **`compareWithProduction(test, prod)`:** an unpaired comparison with its own comparability guard (same judge identity, requirements and sources). `compareRuns` always returns "несравнимы" for this pair.
9. **`score(input, { referenceRunId })`:** reuses the test run's requirements, sources and judge settings, applies the same exclusions, and adds a bounded worker pool. Today scoring is sequential, which would take over an hour for 200 dialogues.

**Protocol rule:** any change to `JUDGE_PROMPT`, `JUDGE_RESPONSE_FORMAT`, the vote count or aggregation changes `JUDGE_PROTOCOL` and therefore `evaluatorVersion`. After that, every earlier run is incomparable and earlier drafts are refused by `start`. Batch such changes into one isolated step before the freeze.

### Critical Pitfalls

Full list (14 critical items plus moderate ones): PITFALLS.md.

1. **Agreement collected only on failures is presented as judge accuracy** (and n is tiny: 9/10 gives a Wilson interval of 60–98%).
   - Show "владелец согласен с N из M проверенных провалов" with the phrase "мало проверок".
   - Store the judge verdict, protocol hash and input hash with each review.
   - Offer three buttons: agree / disagree / can't tell.
   - Say on screen that passes are not checked yet.
   - Never show kappa.
2. **Automation bias and a conflict of interest in one-key review.**
   - Show the highlighted reply and the owner's rule before the judge's conclusion.
   - Require a one-line reason on disagreement, and record time-to-decision.
   - On the demo, call it "согласие владельца". Ideally, a customer-side person reviews 5 failures live.
3. **Tuning the judge on the measured set.** Freeze the protocol by the end of 2026-09-18, re-judge stored transcripts once, and report agreement only from reviews made after the freeze.
4. **"Fewer unknowns" achieved by hiding instability.**
   - Split unknown into two named reasons: "нет доказательства" and "судья разошёлся сам с собой".
   - Reduce only the first kind through prompt work.
   - If the vote count changes, move to 3 votes with a majority, as a versioned protocol change with about 1.5x the judge cost.
   - Measure which source dominates on `fae4ee59` first.
5. **Headline arithmetic at tiny n.**
   - Lead with counts ("0 из 9 проверенных сценариев").
   - Show a percentage only when n ≥ 20, or add "мало данных"; describe any range in words using Wilson.
   - State the population in one clause ("из 36 записанных проверяемы 9…").
   - One helper feeds every surface.
6. **Wrong rule numbers in explanations.** The judge sees rules renumbered after filtering (`judge.ts:34`), so "правило 3" is not the owner's rule 3.
   - Use the owner's requirement ids and verbatim quotes, and check that each is a substring of its source.
   - If a check fails, show "объяснение не подтверждено цитатой".
7. **Data leakage.**
   - The HTML embeds full turns, and summaries go to messengers.
   - Production scoring sends transcripts to OpenRouter and then to OpenAI.
   - Countermeasures:
     - a "для заказчика" report profile with no raw turns;
     - a deterministic scrubber (card numbers with a Luhn check, 20-digit accounts, INN, phone numbers, emails, internal hostnames);
     - a test that the HTML makes no `http(s)://` resource loads;
     - a confirm screen naming the provider and the dialogue count;
     - **written customer approval**.
8. **Demo fragility and scope overrun.**
   - Present from a frozen, stored run. Copy the evidence outside the workspace.
   - Cap `parallel` or add a per-provider limiter.
   - No `npm test` in the live worktree.
   - Code freeze Saturday; Sunday is rehearsal only.
   - Hold a daily go/no-go gate on the real agent.
9. **No positive control.** A judge that never says "pass" looks broken. Include one or two known-good control cards in the stored demo run.

## Implications for Roadmap

The six milestone themes map onto phases, with one deliberate change: **live progress moves into the Result-screen phase**. It shares the theme and renderer, is cheap, and prevents a run from looking frozen. That leaves Onboarding as the cuttable tail. The phases are ordered by what the customer sees. The only exception is Phase 1, which is invisible but is a hard prerequisite for everything visible.

**Calendar anchors:**
- Wednesday 09-16 and Thursday 09-17: Phases 1–2.
- **End of Friday 09-18:** judge protocol freeze, then a single re-assess.
- Friday and Saturday: Phases 3–5.
- **Saturday 09-19:** code freeze.
- Sunday 09-20: rehearsal only.
- Monday 09-21: demo.

### Phase 1: Trust in the number (foundation)
**Rationale:** ARCHITECTURE shows that the audit sidecar and a single `ResultView` block every visible feature. PITFALLS 5 and 7 show that any surface built on today's counting will repeat the "several denominators" and "несравнимы" failures.
**Delivers:**
- A1 comparison-time normalization and removal of the five scattered defaults.
- A2 harness goal ids.
- A3 shared `scoreSettings` (CLI = Pi).
- A4 audit sidecar + receipt, with a live re-read of the pilot records.
- The headline formula: one denominator, named "не измерено", counts first, Wilson range in words.
- The `ResultView` skeleton with `countingRules` and `scope`.
- Stability, measured cheaply:
  - re-judge the stored transcripts to check the judge;
  - run `compareRuns` on an unchanged repeat to list unstable cards;
  - **no within-run repeats in the demo** (they change comparability and push cards toward fail);
  - never promise "the same number".
- A positive-control card.
**Addresses:** the Trust table stakes and the PROJECT.md "Числу можно верить" items, except the expectations sheet, which moves to Phase 2.
**Avoids:** Pitfalls 5, 6, 7, 11, and the 50 MB record limit.
**Watch:**
- `trialSchema` is strict. Rebuild `dist/` (from a snapshot, not in the live worktree) and restart Pi before writing new records.
- Tests need a `test/comparison.test.ts` case for the default.

### Phase 2: Judge quality & human agreement
**Rationale:** The failure triple is what makes one-key agreement fast and meaningful (FEATURES dependency chain). The protocol freeze must fall inside this phase, before any demo evidence is collected (Pitfall 3).
**Delivers:**
- `explain.ts`: X → Y → rule N, derived and verified, using the owner's rule ids and not the judge's numbering.
- `judgeAgreement()` against original judge results.
- Metric-level quick verdicts. A whole-dialogue verdict does not move accuracy, so one-key agree/disagree must write to the failing primary metric, storing the judge verdict and protocol/input hash plus `source: 'quick'`.
- The unknown split into two named reasons.
- The `expectationSheet` with N-card `acceptDraft` and an opt-in `requireAccepted` (cuttable).
- **Optional F1** protocol bump (named rule, 3 votes), done once, then a re-assess of the baseline and production runs before the freeze.
**Uses:** existing `requirementIds`, `citations[].quote`, `humanReviewInputSchema`.
**Avoids:** Pitfalls 1, 3, 4, 10. The screen side of Pitfall 2 comes in Phase 3.

### Phase 3: Result screen in Pi (verdict block, board, live progress)
**Rationale:** This is the Core Value ("понимают за 10 секунд") and the most visible demo surface. It needs Phase 1 (`ResultView`) and Phase 2 (explanations, agreement).
**Delivers:**
- `extensions/render/theme.ts`, the shared visual language.
- The verdict block:
  - tool path: `renderResult(details.view)`;
  - command path: `appendEntry` + `registerEntryRenderer`;
  - collapsed and expanded variants;
  - no truncation mid-word;
  - `keyHint` for the expand key.
- The board, with `cards.ts` split first:
  - tabs Итог / Провалы / Диалоги / Сравнение; the Сравнение tab shows the unstable-card list now and gets its production content in Phase 5;
  - Enter on a failure opens the dialogue scrolled to a turn highlighted with `selectedBg`;
  - one-key agree/disagree with **evidence shown before the verdict**, a disagreement reason via `ctx.ui.editor`, and "Согласие N из M" in the header;
  - a `ctx.mode === 'tui'` guard.
- Live progress: `progressView` in the tool `onUpdate`, the footer `setStatus` and the board header, labelled "оценка" with "стоимость судьи и симулятора".
**Avoids:** Pitfalls 2, 12, Anti-Pattern 1 (renderers counting on their own), and a demo run that looks frozen.
**Watch:**
- Golden-string tests at 40/60/80/100/160 columns with long Cyrillic text, using a fake theme.
- A light and dark theme rehearsal at projector font size.
- `agent-lab.ts` (844 lines) is touched by several items, so serialize those edits or split the tool registrations out first.

### Phase 4: Customer summary & HTML report
**Rationale:** The manager never opens Pi, so this is the second customer-facing artifact. It is a pure renderer of `ResultView`, so it can run in parallel with Phase 3 once Phase 2 is done.
**Delivers:**
- `shareText()`:
  - at most about 900 characters and 15 lines;
  - no ANSI, box characters or emoji;
  - counts, top 3 causes, "не измерено" and agreement;
  - no client quotes.
- Delivery: clipboard, falling back to the editor, and always a `.summary.txt` file (mode `0600`).
- `managerReport()`:
  - under 150 KB (hard test limit 200 KB for 15 cards / 60 dialogues);
  - no JavaScript, inline SVG, `<details>`, strict CSP, print and dark styles;
  - lists what was not measured, the agreement, and a slot for the production-vs-test section.
- The deterministic scrubber and two profiles ("для заказчика" by default; "полный, локальный" with a do-not-forward banner). The existing `htmlReport` stays as the auditor export.
**Avoids:** Pitfall 9 and the 3 MB report (embedded `judgeAudit` and full traces).
**Watch:**
- A test that the report makes no external URL loads.
- Cyrillic rendering in Segoe UI on Windows.
- A test for jargon and metric ids in customer text.
- MSK timestamps.

### Phase 5: Production next to test
**Rationale:** The customer explicitly asked for this, but it has the most unknowns (data approval, matching, masking, throughput) and depends on A3 and A4. It sits late, with a cut already agreed: **production scored alone, shown next to the test with no delta.**
**Delivers:**
- `score({referenceRunId})`, reusing the test run's requirements, sources and judge, with the same exclusions and `requireApplicable`.
- A bounded worker pool, or a production sample capped at about 50 for the demo.
- `compareWithProduction`:
  - unpaired;
  - per-rule accuracy keyed by requirement id;
  - a comparability guard;
  - a population line for each side;
  - **no delta unless rows are paired by scenario**.
- The Сравнение tab content, plus the matching HTML and text sections.
- A provider confirm screen before production scoring.
**Avoids:** Pitfall 8, and Anti-Pattern 4 (using `compareRuns` for this pair).
**Blocked externally by:** written customer approval to send production transcripts to OpenRouter/OpenAI. Without it, score only dialogues already cleared for the pilot.

### Phase 6: Onboarding (cuttable tail)
**Rationale:** It serves the newcomer, not the customer watching the demo, and has the highest variance (Pitfall 14).
**Delivers, in this order:**
1. A one-minute demo fixture: a stored, clearly synthetic pair of a validation run and a production score, rendered with the four renderers. Today `/agent-lab demo` shows the old sandbox tool-repair flow.
2. The `preparationChecklist` widget (component factory, derived state, refreshed on `tool_execution_end`).
3. Skill and prompt work for one-sentence start.

Auto-detecting the adapter is **deferred**; the checklist must work without it.
**Avoids:** scope overrun.

### Phase 7: Demo freeze & rehearsal (fixed-date gate, not cuttable)
**Rationale:** Pitfall 13. A live run of 6–17 minutes and about $2 over a customer network is the largest demo risk.
**Delivers:**
- A frozen, stored demo run recorded on frozen code, re-rendered with zero model calls and copied outside the workspace (`0600`).
- A rehearsal of the exact comparison pair.
- A pre-day checklist: OpenRouter balance, mock server, Pi 0.85.1, fonts and theme, the HTML opening offline.
- The "Looks Done But Isn't" checklist from PITFALLS.md.

### Phase Ordering Rationale

- **Dependencies:**
  - Normalize, audit sidecar and headline → `ResultView` → every renderer.
  - Explanation triple → one-key agreement → agreement % → block, board, HTML and text.
  - `scoreSettings` + audit sidecar + comparability → production vs test.
- **Grouping follows the architecture layers.** Phase 1 covers storage and analysis. Phase 2 covers analysis on the judge side. Phases 3–4 are pure renderers and can run in parallel. Phase 5 is orchestration plus a new analysis function.
- **Customer-visible order** follows Pitfall 14: trust fixes → verdict and explanations → agreement → report → progress → production → onboarding. Cuts are agreed in advance:
  - onboarding auto-detection becomes a checklist;
  - production vs test becomes "scored alone, no delta";
  - if the chat block is solid, the Сравнение tab can stay minimal.
- **Every phase ends with an observed result on the real acquiring agent** (the Evidence constraint), except the pure-render parts of Phases 3–4. Those are verified on stored real runs, which costs no money.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 2:** decide on F1 (protocol bump) only after measuring which of the four unknown sources dominates on `fae4ee59`. Specifying `hasCompleteJudgment` for a changed vote count also needs care.
- **Phase 3:** a short live spike on how custom entries and tool `renderResult` render in the Pi 0.85.1 chat. ARCHITECTURE rates rendering behaviour MEDIUM because it has not been exercised. Also settle the key map.
- **Phase 5:** matching production dialogues to test scenarios, the effect of masking on unknowns, the worker pool and rate limits, and the data-approval path. This phase has the most open questions.
- **Phase 6 (if one-sentence setup is attempted):** adapter discovery varies a lot between repositories. Defer it.

Phases with standard patterns (skip research-phase):
- **Phase 1:** every fix has exact file:line anchors and a prescribed shape in ARCHITECTURE.md.
- **Phase 4:** a static HTML and text renderer following OWASP escaping and the existing `report.ts` pattern.
- **Phase 7:** an operational checklist.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Every API was checked in the installed 0.85.1 `.d.ts` and runtime JS. The size budget and summary length are MEDIUM (design choices). `copyToClipboard` is undocumented. |
| Features | MEDIUM | Official docs (HIGH) for Braintrust, LangSmith, Langfuse and promptfoo. Vendor marketing (MEDIUM/LOW) for Coval, Cekura, Hamming and Galileo. The mapping to Agent Lab is inference. |
| Architecture | HIGH / MEDIUM | Integration points were read at `628ff25` (HIGH). New component shapes are recommendations (MEDIUM). Chat rendering of message and entry renderers has not been exercised. |
| Pitfalls | MEDIUM-HIGH | Code claims and Wilson figures are HIGH. The literature on judge bias, nondeterminism and kappa is MEDIUM. Russian-language judge quality is LOW (not checked). |

**Overall confidence:** MEDIUM-HIGH

### Gaps to Address

- **Contradictions between the research files, resolved here:**
  - **Verdict block host.** ARCHITECTURE suggests `sendMessage({display:true})` + `registerMessageRenderer`. STACK recommends `appendEntry` + `registerEntryRenderer`, which keeps the block out of LLM context. **Use STACK's approach**, plus a hidden `sendMessage` for LLM context when needed.
  - **Checklist widget.** ARCHITECTURE shows `setWidget(key, lines)`. Use a **component factory**, because string arrays are cut to 10 lines.
  - **HTML script.** ARCHITECTURE says to keep the hashed-script CSP. For the manager report, **use no JavaScript at all**; the full auditor report can keep its script.
  - **Agree/disagree keys.** FEATURES proposes `a`/`d`, but `d` (along with `p`/`n`/`v`/`x`) is already taken on the board. Pick a non-clashing pair during Phase 3 planning (STACK suggests `y`/`n` with remapping).
  - **Agreement sample.** FEATURES puts the random passed-dialogue spot-check in v1.x, and PITFALLS says "after the demo". Keep it out of the demo scope, but **say on screen** that passes are not checked, and include a positive-control card.
- **Customer approval to send production transcripts to OpenRouter/OpenAI:** an external blocker for Phase 5. Raise it with the customer contact now, not on Friday.
- **Which unknown source dominates on `fae4ee59`:** measure it before deciding on F1 or a vote-count change.
- **The ≥90% target cannot be shown statistically at n≈10.** It needs about 50 or more reviews, and the MT-Bench result suggests human–human agreement is about 80%. Present it as a target with n, never as a proven accuracy.
- **Russian-language judging quality in the acquiring domain:** unverified. Human agreement at small n is the only calibration.
- **Cost figures** exclude the external agent's own cost and may differ from the OpenRouter invoice. Reconcile once against the dashboard and label the figure "оценка".
- **Forward compatibility:** new records written under a strict schema are unreadable by a Pi session still running the old `dist/`. Coordinate rebuilds and restarts with other sessions in the worktree.
- **Record listing:** `store.list()` parses every record in full. That is acceptable after A4; an index file is a post-demo item.

## Sources

### Primary (HIGH confidence)
- `node_modules/@earendil-works/pi-coding-agent@0.85.1` `dist/core/extensions/types.d.ts`, `theme.d.ts`, `tool-execution.js`, `interactive-mode.js` (10-line widget cap; live entry rendering), `custom-entry.js`, `utils/clipboard.js`, `docs/extensions.md`, `docs/tui.md`: Pi rendering and UI APIs.
- `node_modules/@earendil-works/pi-tui@0.85.1` `index.d.ts`, `utils.d.ts` (`applyBackgroundToLine` is not exported), `tui.d.ts`, `keys.d.ts`, `terminal-image.d.ts`.
- Repository at `628ff25`: `src/experiment.ts`, `quality.ts`, `outcomes.ts`, `comparison.ts`, `judge.ts`, `evaluation.ts`, `report.ts`, `artifacts.ts`, `store.ts`, `contracts.ts`, `pi.ts`, `cli.ts`, `extensions/agent-lab.ts`, `extensions/cards.ts`; `.planning/codebase/CONCERNS.md`; `.planning/PROJECT.md`.
- Braintrust (compare experiments, online scoring); LangSmith (Align Evals, repetitions); Langfuse (annotation queues, score analytics, demo project); promptfoo (web UI, getting started, CI); Arize Phoenix annotations; OpenAI Evals guide (deprecation notice); LangWatch Scenario concepts.
- Anthropic, "Demystifying evals for AI agents"; "Adding Error Bars to Evals" (arXiv 2411.00640); Unicode UAX #11; the OWASP XSS Prevention Cheat Sheet; Wilson intervals computed in PITFALLS.md.

### Secondary (MEDIUM confidence)
- Hamel Husain, LLM-judge guide and evals FAQ (binary labels, TPR/TNR, critique shadowing).
- Zheng et al. MT-Bench (arXiv 2306.05685); self-preference bias (2410.21819); temperature and judge stability (2603.28304); nondeterminism (2407.10457, Thinking Machines); unfaithful rationales (2601.14691, 2605.23970, 2503.08679); criteria drift (Shankar et al. 2404.12272); no CLT at small n (2503.01747); the kappa prevalence paradox (PMC5712640).
- Automation bias review (AI & Society 2025); microsoft/terminal#14702; OSC 11 issues.
- Vendor pages: Cekura, Coval, Hamming, Confident AI, Patronus Percival.

### Tertiary (LOW confidence)
- Galileo CLHF accuracy claims; the absence of a live cost/ETA counter in competitors (not exhaustively verified); `NO_COLOR` convention; Russian-language judge quality; OpenRouter pricing versus the displayed cost.

---
*Research completed: 2026-09-16*
*Ready for roadmap: yes*
