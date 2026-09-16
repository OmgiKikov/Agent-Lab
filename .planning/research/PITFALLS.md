# Pitfalls Research

**Domain:** Evaluating a real banking RAG agent with an LLM judge, shown in a terminal (Pi package) plus a report to forward. Goal: a number people trust, understand at a glance, and find good-looking.
**Researched:** 2026-09-16
**Confidence:** MEDIUM overall.
- HIGH for claims checked in this repo's code at `628ff25` and for statistics we calculated ourselves.
- MEDIUM for claims from the literature. Each comes from a primary paper, and web search found the same claim more than once.
- LOW where marked.

Confidence tags used below:
- **[code]**: checked in the source.
- **[math]**: calculated here.
- **[lit]**: from a paper or documentation.
- **[LOW]**: opinion or a single secondary source.

Phase names follow the milestone themes: **Trust in the number**, **Judge quality & agreement**, **Result screen in Pi**, **Customer summary/report**, **Onboarding & progress**, **Production vs test**.

---

## Critical Pitfalls

### Pitfall 1: "Human agreement %" collected only on failures is presented as judge accuracy

**What goes wrong:**
The board shows something like "согласие 92%". Everyone reads it as "the judge is right 92% of the time". It measures much less than that:
- **It covers only the "fail" verdicts a person opened.** Agreement on reviewed failures estimates the judge's **precision on "fail"**. It says nothing about:
  - **False passes.** The judge's recall of real failures is never checked.
  - **Unknowns.** The judge refused to decide, and nobody looked.
  - **Failures the person skipped.** A reviewer opens the easy, obvious ones first, and agreement on those is high.
- **The pilot has no passes to check.** At 0 of 9 there are no passes at all, so for this demo the percentage is the only judge-quality signal. It is structurally blind to the most dangerous error, calling a broken answer good. That error is unseen today only because nothing passed.
- **n is tiny.** 9 agreements out of 10 has a 95% Wilson interval of **60–98%**, 10/10 gives **72–100%**, and 18/20 gives **70–97%** [math]. A "≥90%" target cannot be shown statistically with fewer than about 50 reviewed items (45/50 gives 79–96%) [math].

**Why it happens:**
The product decision is to collect agreement while a person browses failures, with no separate labeling session (PROJECT.md, Key Decisions). That keeps it cheap, but the sample is chosen by what the reviewer clicks. People also treat raw agreement as a general accuracy figure.

**How to avoid:**
- **Name the metric honestly and show n every time.** Write "Владелец согласен с 9 из 10 проверенных провалов" and put the interval or the phrase "мало проверок" next to it. Never show a bare "90%".
- **Store what the person agreed with.** Save the `trialId`, the metric id, and the **judge result, protocol hash and input hash at review time**. The current key (`${trial.id}|metric:${metric.id}`, `src/quality.ts:398`) has none of these, so a review made under protocol 10 would silently "agree" with a verdict produced under protocol 11 [code].
- **Keep three buckets:** agree, disagree, and "не могу решить". Do not force a binary answer.
- **Hold the judge back from ≥90% claims until n ≥ 30.** Show the fraction, and state "цель ≥90%" as a target, not as a result.
- **After the demo, add passes and unknowns.** A small random sample of both (for example 3 of each per run) turns the metric into real judge accuracy. On the screen, say that passes are not checked yet.
- **Do not use Cohen's kappa here.** With one class (all reviewed items are "fail"), kappa is undefined or meaningless. Even with two classes, kappa falls apart when prevalence is skewed above about 60% (the "high agreement, low kappa" paradox) [lit]. Use raw agreement plus n plus a Wilson interval. If a chance-corrected figure is needed later, with both classes sampled, use Gwet's AC1 [lit].

**Warning signs:**
- The agreement % changes a lot after one keypress.
- The agreement % is shown without its denominator.
- Nobody has ever reviewed a "pass".
- Agreement stays at 100% across judge protocol changes, which means the reviews are not tied to a verdict version.

**Phase to address:** Judge quality & agreement. Wording on the screen belongs to Result screen in Pi.

---

### Pitfall 2: One-key agree while looking at the judge's verdict inflates agreement (automation bias)

**What goes wrong:**
The reviewer sees the judge's red "провал", its quote and its rule, and then presses "согласен". People shown an AI label seldom fix it when fixing takes effort, and novices are more affected than experts [lit: Springer AI & Society 2025 review of automation bias; a randomized annotation study of 2,784 participants].

There is also a conflict of interest. The reviewer is usually the agent owner or us, and we are motivated to reach "≥90%" before the demo.

**Why it happens:**
The one-key flow is built for speed. The verdict is the first thing on the screen, so the reviewer anchors on it.

**How to avoid:**
- **Show the evidence before the verdict.** Show the highlighted agent reply and the owner's rule first, and the judge's conclusion after them (or collapsed). Only then allow agree or disagree.
- **Ask for a short reason on disagreement.** One line of free text. It improves the judge, and it makes disagreeing a deliberate act.
- **Record reviewer identity and time-to-decision.** Flag very fast agreements, for example under 3 seconds.
- **Present the result honestly on the demo:** "согласие владельца агента, не независимая разметка". Better still, have the customer's own person review 5 failures live, which is also a strong demo moment.

**Warning signs:**
- Median review time is a few seconds.
- Disagreements have no reasons.
- Every review comes from the same person who tuned the judge prompt.

**Phase to address:** Judge quality & agreement, together with the Result screen in Pi (board flow order).

---

### Pitfall 3: Tuning the judge on the same failures used to measure agreement (Goodhart + criteria drift)

**What goes wrong:**
The loop goes like this: a reviewer disagrees, the judge prompt is edited, the same 9 failures are judged again, and agreement rises. The result is overfitting to 9 dialogues.

Every edit also changes `JUDGE_PROTOCOL` (`src/judge.ts:22`). That breaks comparability with every earlier run: `hasCompleteJudgment` returns false (`src/judge.ts:115-121`) and pairs are marked incomparable [code].

Criteria drift adds to this. Grading outputs changes what people think the criteria are, so the "rules" move while being measured [lit: Shankar et al., "Who Validates the Validators?", arXiv 2404.12272].

**Why it happens:**
There is a 4-day deadline, the only real data is one agent's 9–15 cards, and ≥90% is a success metric.

**How to avoid:**
- **Freeze the judge protocol at a fixed time before the demo.** Recommended: end of Friday 2026-09-18. Re-judge the stored transcripts once under the frozen protocol, then collect the agreement shown on the demo **after** the freeze.
- **Keep a log of disagreements that led to prompt changes.** Report agreement only on reviews made after the last change.
- **Prefer small, general rule fixes.** One example is the earlier fix to the "always return JSON" rule. Avoid edits written around a single dialogue.

**Warning signs:**
- Several `JUDGE_PROTOCOL` version bumps in the demo week.
- Agreement measured on reviews older than the current protocol.
- The judge prompt contains words taken from one specific acquiring dialogue.

**Phase to address:** Judge quality & agreement. The freeze date belongs in Trust in the number.

---

### Pitfall 4: "Fewer unknowns" is achieved by hiding judge instability

**What goes wrong:**
Today each metric gets two fresh votes, and any disagreement becomes `unknown` (`src/judge.ts:199-203`) [code]. The default judge is a reasoning model, so it runs at the provider's default temperature, not 0 (`src/judge.ts:22`) [code].

Reasoning models and even temperature-0 APIs change their answers between runs [lit: arXiv 2407.10457; Thinking Machines, "Defeating Nondeterminism in LLM Inference"; arXiv 2603.28304 on temperature and judge stability]. Some of the 4 current "без решения" results are probably the judge disagreeing with itself, not missing evidence.

If "the judge decides more often" is built by dropping unanimity, adding "decide when in doubt", or taking the majority of an even number of votes, the number looks more decisive and becomes less reproducible. Borderline cases also tend to turn into false "fail" verdicts.

**Why it happens:**
"Без решения 4" looks bad on the screen, and the quickest fix is to force a decision.

**How to avoid:**
- **Split unknown into two named reasons and count them separately:**
  - "нет доказательства в диалоге": a data or card problem. Fix it in the card or the simulator.
  - "судья сам себе противоречит": instability. Fix it with a clearer rubric, or with 3 votes and a majority, which is a protocol change that needs a version bump.
- **Only reduce the first kind by prompt work.** Report the second kind as instability. It feeds Pitfall 6.
- **If the vote count changes, go from 2 to 3 votes with a majority** (an odd count). Record it in the protocol, and budget the roughly 1.5x judge cost.

**Warning signs:**
- The unknown count drops while the repeat-flip rate rises.
- The rationale "Судья разошёлся на неизменном входе" is common.
- Judge parse errors rise after prompt edits (the no-repair policy turns one bad vote into a whole-dialogue failure, `src/judge.ts:193-195`).

**Phase to address:** Judge quality & agreement.

---

### Pitfall 5: Headline arithmetic with tiny n and a moving denominator

**What goes wrong:**
- **"0 из 9 (0%)" sounds final, but it is not.** With n=9 the 95% interval for the true success rate is **0–30%** [math], and 3/9 is 12–65%.
- **One card moves the headline by 11 percentage points.**
- **Removing unknowns shrinks the denominator.** "0 из 5" when 4 are undecided is a different claim from "0 из 9".
- **The set is not the whole population.** 27 dialogues were excluded, and "прочее" hides the main reason (PROJECT.md). The headline describes testable scenarios, not "the agent in production".
- **Intervals from the normal approximation are wrong at this n.** Wald or CLT intervals are badly miscalibrated below a few hundred items and near 0 or 1 [lit: arXiv 2503.01747; Wilson interval literature].

**Why it happens:**
The requirement is "one headline number and one denominator". Simplifying pushes toward a bare percentage.

**How to avoid:**
- **Lead with counts.** Write "Цель достигнута в 0 из 9 проверенных сценариев". Show a percentage only when n ≥ 20, or always put "мало данных" next to it.
- **If an uncertainty range is shown, use Wilson** (Clopper–Pearson if n < 5), in plain words. Example: "при 9 сценариях настоящая доля — вероятно, не выше 30%".
- **Keep a single denominator = decided cards.** Put undecided, invalid and not-reached cards on one "не измерено: N" line with the **named** top reason, never "прочее".
- **State the population in one clause:** "из 36 записанных диалогов проверяемы 9; остальные — маскированные или требуют данных клиента".
- **Keep the three card counts in one tested helper,** so the chat block, the board, the HTML and the text summary cannot disagree. `qualitySummary` already exists; make every surface use it [code].

**Warning signs:**
- Different surfaces show different numbers.
- A percentage appears without "из N".
- "прочее" is the largest exclusion bucket.

**Phase to address:** Trust in the number, then Result screen in Pi and Customer summary/report.

---

### Pitfall 6: A stability check that is too small to mean anything, and a card aggregation that depends on the repeat count

**What goes wrong:**
- **Too few runs.** With 9 cards and a 10% chance that any single card changes between two runs, the chance the headline is identical is only 0.9^9 ≈ **39%** (63% at 5%, 23% at 15%) [math]. "Same number on rerun" will fail by chance even for a healthy system. Two runs can **detect** a flip but cannot **estimate** stability.
- **Card outcome depends on how many repeats ran.** A card's outcome is `fail` if **any** repeat failed (`goalCardOutcome`, `src/quality.ts:419-420`) [code]. More repeats push cards toward "fail", so a 1-repeat run and a 3-repeat run are not comparable.
- **Three sources of noise get mixed up:**
  - the agent (gigachat, non-deterministic);
  - the reactive simulator;
  - the judge.
- **The cost is real.** Each full rerun costs about $2 and 6–17 minutes (PROJECT.md).

**Why it happens:**
"Stability" is asked as a single yes/no, and the cheapest way to answer it, re-judging a stored transcript, is not separated from re-running the agent.

**How to avoid:**
- **Two stability levels, shown separately:**
  1. **Judge stability.** Re-judge the **same stored transcripts** (no agent calls, cheap, fast). If the number changes here, the judge is the problem.
  2. **Run stability.** Re-run the agent and simulator. Only this says whether the agent is consistent.
- **Mark a card "нестабильна" when its outcomes differ across repeats.** Show it as its own count, and keep the headline rule explicit ("карточка засчитана как провал, если провалилась хотя бы в одном повторе").
- **Refuse to compare runs with different repeat counts,** or compare per repeat index. Record the aggregation rule in the measurement hash.
- **Do not promise "the number doesn't change" on the demo.** Promise "we show which cards change".

**Warning signs:**
- The headline differs between two back-to-back runs.
- The team starts "fixing" this by changing the aggregation rule.
- The repeat count is not shown next to the headline.

**Phase to address:** Trust in the number.

---

### Pitfall 7: Comparison screen says "Прогоны несравнимы" on the demo

**What goes wrong:**
A fingerprint change over the whole object marks every pair incomparable (`src/comparison.ts:542-566`) [code]. The known trigger is the `goalObservation` default (CONCERNS.md). Any judge prompt edit, settings change or evaluator version change does the same.

A demo whose "Сравнение" tab says "несравнимы" is worse than having no tab.

**Why it happens:**
Normalisation defaults are applied in several places, and the fingerprint is taken before normalisation (CONCERNS.md, "Run comparability depends on whole-object fingerprints").

**How to avoid:**
- **Fix F-01 first:** normalise before fingerprinting, and add a test for each default.
- **Freeze the judge protocol** (Pitfall 3).
- **When runs are incomparable, give the reason in words** ("изменился судья 18.09 — пересчитайте старый прогон") and a one-key re-assess action. Never show a bare verdict.
- **Rehearse the exact comparison pair** that will be shown, on the frozen code.

**Warning signs:**
- Any record in the demo set was created before the latest protocol bump.
- `compareRuns` notes are non-empty.

**Phase to address:** Trust in the number (first phase; blocks the comparison and prod-vs-test screens).

---

### Pitfall 8: Comparing production and test as if they were the same population

**What goes wrong:**
"Test 0% vs prod 55%" is read as "the test is broken" or "the agent got worse". The two sets differ in several ways:
- **Selection.**
  - Test cards are the 9–15 **testable** scenarios, with masked or customer-data cases removed.
  - Prod scoring would see all dialogues, including handoffs to an operator and masked turns.
- **Who plays the user.**
  - Test uses a reactive simulator, which may be more cooperative or more literal than real bank clients.
  - Prod has real users.
- **Agent version.** Prod transcripts may come from a different agent build than baseline `27d56d6`.
- **Criteria.** "The same criteria" is not automatic.
  - Prod goals are extracted per dialogue by a model (`src/pi.ts:619-648`) [code].
  - A prod dialogue's criteria differ from a test card's unless both map to the same scenario template.
- **Masking.** Masked personal data in prod transcripts leads to judge `unknown`, or to false "fail" when the agent correctly asks for data that has been masked.

**Why it happens:**
The customer asked for "тот же судья на проде рядом с тестом" (PROJECT.md). Showing two numbers side by side looks like a controlled comparison.

**How to avoid:**
- **Show the two sides, but no delta,** unless the rows are matched by scenario. Pair by scenario or intent: "Тариф эквайринга: тест — провал, прод — 3 из 5 диалогов".
- **Show each side's population in one line:** how many dialogues, how many excluded and why, the agent version, and the period.
- **Mark prod cards as "оценены по записи, агент не запускался".** Report the unknown share separately; on prod it will be higher.
- **Use the same judge protocol hash on both sides and show it.** If it differs, show "несравнимо" with the reason.
- **Say explicitly on screen:** "это не A/B-сравнение; различие может объясняться отбором".

**Warning signs:**
- A single "разница: +55 п.п." number.
- Prod n far larger than test n with no matching.
- A high prod unknown rate.

**Phase to address:** Production vs test.

---

### Pitfall 9: Private bank data leaks through the shared report, the text summary, or the judge provider

**What goes wrong:**
1. **The HTML report embeds full dialogue turns, events and the full task text** (`src/report.ts`: `.turn`, `.event`, `.full-task` blocks) [code]. A manager forwards it by email or messenger, and real client phrasing, merchant names, partly masked card numbers, INN, phone numbers and internal KB fragments (retrievals) leave the bank's perimeter.
2. **The agent's system prompt and internal rule quotes are the bank's intellectual property.** "Правило N: «…»" quotes in the summary expose them.
3. **The text summary is pasted into a messenger** (Telegram or WhatsApp servers). Anything in it has left the perimeter.
4. **Scoring prod dialogues sends them to OpenRouter, and from there to OpenAI** (default judge `openai/gpt-5.6-sol`, PROJECT.md). For a bank this is a data-processing decision the customer must approve. It is not a technical detail. Local storage with `0600` permissions does not help once the text is in a judge request.
5. **Internal system names** appear in agent replies and in judge rationales (compare the earlier AIGW validator incident in project memory).
6. **The file could leak through external requests.** If the HTML ever loads a web font, image or script from a CDN, opening it contacts a third party. Today it is inline (`src/report.ts:164-193`) [code]; keep it that way.

**Why it happens:**
Evidence-first design puts quotes everywhere, and "one file, easy to forward" works against "never leaves the machine".

**How to avoid:**
- **Two report profiles.**
  - **"для заказчика":** no raw turns; at most one short quote per failure; the rule is paraphrased or referenced by id; the file is scrubbed.
  - **"полный, локальный":** today's content, with a red banner "содержит фрагменты диалогов, не пересылать".
- **A deterministic scrubber** before any export or summary. It masks:
  - card numbers, with a Luhn check;
  - 20-digit account numbers;
  - INN (10 or 12 digits);
  - phone numbers and emails;
  - known internal hostnames and system names from a configurable list.

  Test it with synthetic fixtures only.
- **The text summary contains numbers and short causes only,** never dialogue text.
- **Before `score` on prod, show a one-screen confirmation:** "N диалогов будут отправлены провайдеру <provider/model>". Get written approval from the customer **before** the demo, or run prod scoring only on dialogues already cleared for the pilot.
- **A CI or unit check that the HTML has no `http(s)://` resource loads.**
- **Never put dialogue content into web searches, issues or commits** (workspace rule).

**Warning signs:**
- The report file is larger than a few hundred KB (it probably contains transcripts).
- The summary contains «кавычки» with client speech.
- Nobody on the customer side has approved sending prod transcripts to the judge provider.

**Phase to address:** Customer summary/report (scrubber, profiles) and Production vs test (provider approval gate).

---

### Pitfall 10: Failure explanations "должен был X → сказал Y → правило N" that are invented or mis-numbered

**What goes wrong:**
- **Rule numbers are not the owner's numbers.** The judge sees prompt rules re-numbered **after** filtering out machine-format rules (`observableSources`, `(r, i) => \`${i + 1}. …\``, `src/judge.ts:34`) [code]. So "правило 3" in the judge's output is not rule 3 in the owner's prompt. If the screen prints "правило N" from judge text, the owner opens the prompt and finds a different rule, and trust is lost instantly.
- **"X" may be invented.** It may not come from the card's success criteria or the owner's sources.
- **"Y" may be paraphrased** instead of quoted from the reply.
- **Rationales can be after-the-fact justifications** that do not reflect why the verdict was reached [lit: arXiv 2605.23970 "Faithful or Fabricated?", arXiv 2601.14691 "Gaming the Judge", arXiv 2503.08679].
- **The agent's own wording can sway the judge.** Plausible agent prose can bias the judge toward success [lit: arXiv 2601.14691]. This is already partly mitigated: agent words alone do not prove an action [code].

**Why it happens:**
The template tempts filling all three slots from free-text judge output.

**How to avoid:**
- **Build the explanation from structured, checked parts, not from rationale prose:**
  - **X** = the card's `successCriteria` or requirement text, by id.
  - **Y** = a verbatim substring of the cited assistant event (`evidence` seq). Check that the substring exists.
  - **Rule** = the requirement's stable id or original position and its verbatim quote, taken from the owner's source. Check that the quote is a substring of the source.
- **If any part fails verification, show "объяснение не подтверждено цитатой"** instead of a made-up line.
- **Truncate on word or sentence boundaries by display width, not with `.slice()`.** Today `cards.ts` uses `.slice(0, 240)` and `.slice(0, 300)` (lines 129, 224) [code], which is exactly the "обрезано на полуслове" complaint.

**Warning signs:**
- A rule quote not found in the prompt file.
- The same "правило N" pointing to different text in two runs.
- Rationale text that contradicts the verdict.

**Phase to address:** Judge quality & agreement (structured explanation). Rendering belongs to Result screen in Pi.

---

### Pitfall 11: A judge that has never said "pass" looks broken, and the tool gets blamed for 0/9

**What goes wrong:**
The demo headline is "0 из 9". The earlier validator defect already produced false failures on clean answers (project memory), and the earlier "always return JSON" judge rule did the same (PROJECT.md). A customer who sees only failures cannot tell a bad agent from a bad judge.

**Why it happens:**
There is no positive control in the live run.

**How to avoid:**
- **Include a known-good control.** One or two cards where a reference answer is certainly correct: a sandbox card, or a hand-written perfect reply scored via `score`. Show "контроль: судья засчитал верный ответ". This is the cheapest credibility boost.
- **Confirm by human review, before the demo, that the 9 failures are real** (Pitfall 1). Present them as "владелец подтвердил N из 9".
- **Pick the verbs deliberately:** "агент не выполнил цель", not "тест упал".

**Warning signs:**
- Zero passes across every run of the week.
- The failure clusters are dominated by format or JSON-style causes.

**Phase to address:** Trust in the number, together with Judge quality & agreement.

---

### Pitfall 12: Terminal rendering breaks on Cyrillic, narrow widths, light themes, and copy-paste

**What goes wrong:**
- **Width.**
  - Cyrillic is East Asian **Ambiguous** width in Unicode UAX #11. It is narrow by default, but terminals in CJK locales or with "ambiguous = wide" settings draw it double-width [lit: UAX #11; microsoft/terminal#14702].
  - `padStart` / `padEnd` / `.length` count UTF-16 code units, not columns. Examples are `quality.ts:562` `percent(...).padStart(4)` and `shorten()` using `text.length` [code].
  - Emoji and combining marks break alignment.
- **Wrapping.**
  - Cutting strings at a fixed width cuts words in half.
  - ANSI codes inside a cut string leak color into following lines.
  - `pi-tui` exposes `visibleWidth`, `truncateToWidth` and `wrapTextWithAnsi`, and `cards.ts` already imports them [code]. The chat block and summary paths must use them too.
- **Colors.**
  - Hard-coded bright yellow or green is unreadable on light themes.
  - Red/green alone fails for color-blind viewers, and projectors wash out low-contrast greys.
  - Detecting light or dark via OSC 11 is unreliable across terminals and multiplexers [lit: tabby#10121, opencode#21870, herdr#714].
- **Copy-paste.**
  - Box-drawing characters (`│ ─ ┌`), block bars (`█▌`) and ANSI codes pasted into email or a messenger become ragged garbage in proportional fonts.
  - Wide tables wrap in the chat.
- **Projector.** A large font on a demo projector often means about 80–100 columns. Layouts designed at 160 columns collapse.

**Why it happens:**
The UI is developed on one wide dark terminal. English-centric width assumptions carry over.

**How to avoid:**
- **Measure and cut in one place.** A single render helper does all measuring and truncation with `visibleWidth`, `truncateToWidth` and `wrapTextWithAnsi`, and there is a lint-like test that no user-facing string is cut with `.slice()` or padded with `padStart`.
- **Use only Pi theme tokens** (`theme.fg('warning' | 'accent' | 'muted' …)`), never raw RGB. Every status carries a symbol or word as well as color ("✓ прошла / ✗ провал / ? не измерено"). Respect `NO_COLOR` [LOW: convention at no-color.org, not checked here].
- **The text summary is a separate plain-text renderer.** It has no box-drawing characters, no ANSI and no alignment by spaces, and uses short lines and "—" bullets. Test it by pasting into a proportional-font view.
- **Snapshot tests at 60, 80, 100 and 160 columns** with long Cyrillic reasons. Rehearse in both a light and a dark Pi theme, at projector font size.

**Warning signs:**
- A "…" in the middle of a word.
- Misaligned bars.
- Colored text bleeding onto the next line.
- A summary that looks fine in the terminal but not in Telegram.

**Phase to address:** Result screen in Pi (visual language, render helper) and Customer summary/report (plain-text renderer).

---

### Pitfall 13: The live demo depends on a 6–17 minute, ~$2 run over flaky networks

**What goes wrong:**
- **Failure points during the run:**
  - OpenRouter throttling, with up to 16 × 8 = 128 concurrent judge requests and no shared limiter (CONCERNS.md) [code];
  - a slow or failing local gigachat mock;
  - weak network at the customer's office;
  - a background release hook that hangs until timeout (CONCERNS.md).

  Any of them turns the demo into a spinner.
- **One bad vote spoils the whole dialogue.** The judge's all-or-nothing policy rejects the entire dialogue on one malformed vote (`src/judge.ts:193-195`) [code].
- **Shared-worktree hazards:**
  - Running `npm test` or `npm run build` in the shared worktree deletes `dist/`, which the live Pi extension imports (PROJECT.md).
  - Another session editing `aigw-local` git during the run corrupts the result.
- **Stored evidence can disappear.** `.agent-lab` evidence was lost once with a deleted workspace (project memory).

**Why it happens:**
"Show it live" feels more convincing, and the demo is scheduled right after the last code changes.

**How to avoid:**
- **Present from stored records.** Make the demo path a **stored, frozen run** re-rendered with no model calls (board, block, HTML all read JSON). Record it by Friday on frozen code, and copy the records out of the workspace (outside `lyon/`, keeping `0600` permissions).
- **Keep any live part tiny and optional:**
  - the built-in example (about a minute, per Onboarding goals), or
  - a 1–2 card run with a pre-confirmed budget, and
  - a fallback: "вот тот же прогон, записанный в пятницу".
- **Show live progress** (done / remaining / time / money) so a slow run looks intentional rather than frozen.
- **Add a shared per-provider limiter with backoff** before any live run. At minimum, cap `parallel` for the demo.
- **Freeze code after the final rehearsal.** No `npm test` in the live worktree (use a `git archive` snapshot), and nobody touches `aigw-local` git.
- **Checklist for the day before:**
  - OpenRouter balance and key;
  - mock server up;
  - Pi version pinned (0.85.1);
  - terminal font and theme;
  - HTML opens offline.

**Warning signs:**
- A rehearsal takes over 10 minutes.
- Any 429 or connection retry in the logs.
- Rehearsal done on a different machine or network than the demo.

**Phase to address:** Onboarding & progress (live progress, built-in example). The frozen-run rehearsal belongs in the final phase or demo prep.

---

### Pitfall 14: Four days, six themes: the customer-visible core is left half-done

**What goes wrong:**
There are 20+ active requirements across 6 themes and 3–4 working days. Every judge or protocol change triggers at least one about $2, 6–17 minute real-agent verification (Evidence constraint), so realistically only a handful of full live iterations fit per day.

The most expensive items rarely make the demo land:
- **One-phrase onboarding with auto-detection** of the prompt and entry point: open-ended heuristics.
- **Prod-vs-test:** new matching logic plus data approval.

Yet they eat the time the verdict block and failure explanations need.

**Why it happens:**
"Show the whole product on the demo" (Key Decisions), and polishing visuals is fun and has no natural end.

**How to avoid:**
- **Build strictly in customer-visible order:**
  1. **Trust fixes:** F-01 comparability, duplicate goal ids, `score` budget, audit size.
  2. **Verdict block and structured failure explanations.**
  3. **Agreement on the board.**
  4. **Scrubbed HTML and text summary.**
  5. **Live progress.**
  6. **Prod-vs-test, pairs only.**
  7. **Onboarding.**
- **Pre-agree what gets cut.**
  - One-phrase auto-detect becomes a checklist the owner fills in.
  - Prod-vs-test becomes "prod scored alone, shown next to test without a delta".
  - A full-screen tab stays unbuilt if the chat block is solid.
- **Set a daily go/no-go gate.** The day's slice must end with an observed result on the real acquiring agent (Evidence constraint), otherwise the next slice does not start.
- **Code freeze Saturday.** Sunday is rehearsal only.

**Warning signs:**
- By Thursday evening, the verdict block still shows several denominators or truncated reasons.
- Visual polish PRs before explanation correctness is done.
- Any new runtime dependency (Tech stack constraint).

**Phase to address:** Roadmap ordering (all phases). Explicitly, Onboarding and Production vs test go last and can be cut.

---

## Moderate Pitfalls

### Judge biases specific to this setup
- **Verbosity bias.** Judges favour longer answers [lit: Zheng et al., arXiv 2306.05685]. A long, polite RAG answer that misses the rule may pass. Prevention: pass/fail conditions tied to specific requirement quotes (already the design), and a check that the cited evidence contains the required fact.
- **Self-preference bias** [lit: arXiv 2410.21819]. It is low risk here because the agent is gigachat and the judge is an OpenAI model. It returns if the judge and the simulator share a model family: a simulator the judge "likes" may be judged as a good conversation partner. Keep judge and simulator identities visible in the report.
- **Position bias** mainly affects pairwise comparison [lit]. It matters if "run A vs run B" is ever judged by the LLM directly. Don't do that; compare per-card verdicts instead.
- **Russian-language judging quality** has not been checked for this domain [LOW]. The human agreement sample is the only calibration, which is another reason to show n.

### Agreement metric choice
- Raw agreement is the right number for the owner. Kappa is misleading here (Pitfall 1).
- If two humans ever review the same items, report their mutual agreement as the upper bound for the judge. The MT-Bench study found strong judges agree with humans at about the level humans agree with each other, around 80% [lit: arXiv 2306.05685]. A ≥90% target is therefore ambitious and needs clear, rule-based criteria.

### Money and time estimates shown wrong
- **The cost shown is off.** Reasoning-token pricing and OpenRouter markup make the $ figure differ from the invoice [LOW]. Label it "оценка" and reconcile once against the OpenRouter dashboard before the demo.
- **The time estimate is off.** An ETA from the first dialogues is skewed by warm-up and parallelism. Show a range, or "осталось ≈", after at least 2 dialogues are done.

### Unknown-heavy prod scoring
- Masked turns and missing customer data make prod unknowns balloon. Show that as the "не измерено" reason on the prod side, not as the judge's weakness.

### Record size and history
- Judge audits copied into each trial can push a record past the 50 MB read limit (CONCERNS.md) [code]. Agreement data and repeats make records grow faster. Store audits only in the journal before adding stability repeats.

---

## Minor Pitfalls

- **Russian plural forms.** Use `plural()` (`src/quality.ts:370`) everywhere; strings like "1 диалогов" look careless on the demo.
- **Internal jargon leaking into customer text:** "карточки", "пометки симулятора", "goal_attainment", "unknown", "протокол судьи". Keep a glossary map and a test that customer-facing renderers contain no metric ids.
- **Timestamps and time zones.** Show local time (MSK) in the report; UTC confuses the manager.
- **The HTML depends on system fonts.** `system-ui` renders differently on the manager's Windows machine. Check Cyrillic in Segoe UI.
- **Colors carry meaning without legends.** Add one legend line in the HTML and the board.
- **Stray adapter stdout breaks the protocol** (CONCERNS.md). A demo-day `print()` in the Python adapter fails every reply.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Human review keyed only by trial and metric, with no judge verdict or protocol hash | Simple storage | Old agreements silently apply to new verdicts; the agreement % is unverifiable | Never. Add the verdict and hash now; old reviews stay readable |
| "Any repeat fails → card fails" with no repeat count in the fingerprint | Conservative headline | Runs with different repeat counts look comparable but are not | Only if the repeat count is shown and compared |
| Truncating with `.slice(n)` | One-liner | Cut words, broken ANSI, the "стыдно показывать" screen | Never for user-facing text |
| One HTML report for both local and customer use | One code path | Transcript leakage when forwarded | Only if the file carries a "do not forward" banner |
| Forcing the judge to decide in order to cut unknowns | Nicer headline | Hidden instability, false fails | Never without an instability count |
| Editing the judge prompt right up to the demo | Higher agreement | Every run incomparable; agreement overfit | Until the freeze (Friday), then never |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| OpenRouter → OpenAI judge | Treating it as a local tool and sending prod bank transcripts without approval | Customer approval first; a confirm screen naming the provider and dialogue count |
| OpenRouter rate limits | 16 parallel dialogues × 8 judge workers with no shared limiter | One limiter per provider with backoff; lower `parallel` for demos |
| Reasoning judge model | Assuming "temperature 0" gives determinism | Measure flip rate by re-judging stored transcripts; odd vote count if changed |
| aigw-local command adapter | Debug prints on stdout | Log to stderr; test with a noisy fixture |
| Pi SDK 0.85.1 | Upgrading the SDK in demo week | Pin it; one live smoke test after any bump |
| Messenger or email | Pasting the terminal output with box characters and ANSI | A dedicated plain-text renderer |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Full re-run to check stability | $2 and 17 minutes per check | Re-judge stored transcripts for judge stability | Every rehearsal |
| Prod scoring budget not scaled in the CLI | `score` stops at the default ceiling | Shared budget helper (CONCERNS.md) | More than a few prod dialogues |
| Audits inside the record | Record unreadable over 50 MB | Keep audits in the journal only | Large prod sets or many repeats |
| 3-vote judge | About 1.5x judge cost and time | Budget it before switching | Any live demo run |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Transcripts in a forwarded HTML | Client data leaves the bank | Customer profile without turns; scrubber; banner |
| Agent prompt rules quoted verbatim in the summary | Bank IP disclosed | Rule id plus a short paraphrase in the customer profile |
| Prod dialogues sent to a third-party judge | Regulatory or contract breach | Written approval; confirm gate; provider shown in the report |
| External resources in the HTML | Opening the file contacts a third party | Test that no `http(s)://` loads appear |
| Evidence copied to shared or cloud folders during a workspace cleanup | Uncontrolled copies | Copy to a local folder with `0600` permissions only; never into the repo |
| Dialogue text used in web searches or bug reports | Leak | Workspace rule; use synthetic reproductions |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Several denominators in the headline | The manager cannot say how good the agent is | One denominator; everything else on one "не измерено" line with a named reason |
| Bare percentages at n=9 | False precision | Counts first; "мало данных" or a Wilson range in words |
| Agreement % without n | False confidence in the judge | "N из M проверенных провалов" |
| Verdict shown before the evidence in review | Automation bias | Evidence first, verdict after |
| Showing "несравнимы" with no action | Dead end on the demo | Reason in words plus a re-assess key |
| Only failures on screen | "The tool is broken" | A positive control card |
| Prod and test with a delta number | Wrong causal conclusion | Pairs by scenario, population lines, no delta |

## "Looks Done But Isn't" Checklist

- [ ] **Verdict block:** verify the same numbers as the board, HTML and text summary (one helper); no "прочее"; no text cut mid-word at 80 columns.
- [ ] **Failure explanation:** verify each X, Y and rule quote is a verified substring of the card, the dialogue or the owner's source. Rule numbering must match the owner's prompt, not the judge's filtered list.
- [ ] **Agreement %:** verify n is shown, the reviews store the judge verdict and protocol hash, and reviews older than the current protocol are excluded or marked.
- [ ] **Stability:** verify judge re-scoring and agent re-running are reported separately, and the repeat count is shown and part of comparability.
- [ ] **Comparison:** verify the exact demo pair is comparable on the frozen code (F-01 fixed).
- [ ] **HTML for the customer:** verify there are no raw turns, the scrubber ran, there are no external URLs, and it opens offline on Windows with correct Cyrillic.
- [ ] **Text summary:** verify there are no box characters, ANSI or client quotes, and it pastes cleanly into a messenger.
- [ ] **Prod vs test:** verify the population line on each side, the same judge hash, no delta without pairing, and the customer's approval to send prod data to the provider.
- [ ] **Live progress:** verify the ETA and $ are labelled as estimates, and progress keeps updating during 429 retries.
- [ ] **Demo:** verify the stored frozen run renders with zero model calls, and evidence is copied outside the workspace.
- [ ] **Positive control:** verify at least one card the judge correctly passes.

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Runs incomparable before the demo | MEDIUM | Re-assess the stored runs under the frozen protocol (judge calls only); re-render |
| Agreement collected under an old protocol | LOW | Mark those reviews stale; re-review about 10 failures after the freeze (about 15 minutes) |
| Leaked report forwarded | HIGH | Notify the customer contact; regenerate with the customer profile; review scrubber patterns |
| Live run hangs on the demo | LOW if prepared | Switch to the stored Friday run; show the built-in example |
| Headline changes on rerun | LOW | Show the unstable-cards list; explain the aggregation rule; re-judge to isolate the judge from the agent |
| Explanations cite wrong rule numbers | MEDIUM | Switch to requirement ids and verbatim quotes; hide the numbering until fixed |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| 5. Headline arithmetic / denominator | Trust in the number | One helper feeds all surfaces; snapshot test with 0/9 plus 4 unknown |
| 6. Stability with tiny n, repeat-dependent aggregation | Trust in the number | Re-judge the same transcripts twice; repeat count in the fingerprint; unstable-card list shown |
| 7. "Несравнимы" on the demo | Trust in the number | `compareRuns` on the demo pair returns no notes |
| 11. No positive control | Trust in the number | A control card passes in the stored demo run |
| 1. Agreement on failures only, tiny n | Judge quality & agreement | Screen shows "N из M"; reviews store the verdict and protocol hash |
| 2. Automation bias in one-key review | Judge quality & agreement plus Result screen | Evidence rendered before the verdict; disagreement reason captured |
| 3. Tuning on the measured set | Judge quality & agreement | Protocol frozen Friday; agreement counted only after the freeze |
| 4. Hidden instability behind fewer unknowns | Judge quality & agreement | Unknown split into "нет доказательства" and "судья разошёлся" |
| 10. Invented or mis-numbered explanations | Judge quality & agreement | Substring verification test; rule ids match the owner's source |
| 12. Terminal rendering | Result screen in Pi | Snapshots at 60/80/100/160 columns with Cyrillic; light and dark theme rehearsal; no `.slice()` on user text |
| 9. Data leakage | Customer summary/report | Scrubber tests on synthetic PAN, INN and phone data; no external URLs; customer profile without turns |
| 13. Live demo fragility | Onboarding & progress plus demo prep | Frozen stored run renders offline; rate limiter; rehearsal under 10 minutes |
| 8. Prod vs test population mismatch | Production vs test | Pairs by scenario; population lines; no delta; provider approval recorded |
| 14. Scope overrun | Roadmap ordering | Daily go/no-go on the real agent; Onboarding and Prod-vs-test last and cuttable |

## Sources

LLM-as-judge biases and reliability:
- Zheng et al., "Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena" (NeurIPS 2023): https://arxiv.org/abs/2306.05685 (MEDIUM)
- Wataoka et al., "Self-Preference Bias in LLM-as-a-Judge": https://arxiv.org/pdf/2410.21819 (MEDIUM)
- "Judging the Judges: bias mitigation strategies in LLM-as-a-Judge pipelines": https://arxiv.org/pdf/2604.23178 (LOW, not read in full)
- "The Coin Flip Judge? Reliability and Bias in LLM-as-a-Judge Evaluation": https://arxiv.org/pdf/2606.13685 (LOW, not read in full)
- "The Necessity of Setting Temperature in LLM-as-a-Judge": https://arxiv.org/html/2603.28304v1 (MEDIUM)
- Song et al., "The Good, The Bad, and The Greedy: Evaluation of LLMs Should Not Ignore Non-Determinism": https://arxiv.org/pdf/2407.10457 (MEDIUM)
- Thinking Machines Lab, "Defeating Nondeterminism in LLM Inference": https://thinkingmachines.ai/blog/defeating-nondeterminism-in-llm-inference/ (MEDIUM)
- "Gaming the Judge: Unfaithful Chain-of-Thought Can Undermine Agent Evaluation": https://arxiv.org/html/2601.14691v1 (MEDIUM)
- "Faithful or Fabricated? A Causal Framework for Rationalization Bias in LLM Judges": https://arxiv.org/html/2605.23970 (MEDIUM)
- "Chain-of-Thought Reasoning In The Wild Is Not Always Faithful": https://arxiv.org/pdf/2503.08679 (MEDIUM)
- Shankar et al., "Who Validates the Validators?" (UIST 2024), criteria drift: https://arxiv.org/abs/2404.12272 (MEDIUM)

Statistics:
- "Position: Don't Use the CLT in LLM Evals With Fewer Than a Few Hundred Datapoints": https://arxiv.org/pdf/2503.01747 (MEDIUM)
- Wilson score interval properties: https://arxiv.org/pdf/2109.12464 (MEDIUM). Numbers in this file were calculated with the standard Wilson formula (HIGH).
- "High Agreement and High Prevalence: The Paradox of Cohen's Kappa": https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5712640/ (MEDIUM)
- Feinstein & Cicchetti, "High agreement but low kappa: I.": https://www.sciencedirect.com/science/article/abs/pii/089543569090158L (MEDIUM)

Human review bias:
- "Exploring automation bias in human–AI collaboration" (AI & Society 2025): https://link.springer.com/article/10.1007/s00146-025-02422-7 (MEDIUM)

Terminal rendering:
- Unicode UAX #11, East Asian Width: https://www.unicode.org/reports/tr11/tr11-40.html (HIGH, standard)
- microsoft/terminal#14702, ambiguous-width rendering: https://github.com/microsoft/terminal/issues/14702 (MEDIUM)
- OSC 11 background detection issues: https://github.com/Eugeny/tabby/issues/10121, https://github.com/anomalyco/opencode/issues/21870 (MEDIUM)

Repository (HIGH, checked at HEAD `628ff25`):
- `src/judge.ts`, `src/quality.ts`, `src/comparison.ts`, `src/report.ts`, `extensions/cards.ts`
- `.planning/codebase/CONCERNS.md`
- `.planning/PROJECT.md`

---
*Pitfalls research for: LLM-judged AI-agent evaluation in a terminal (Agent Lab, Pi package)*
*Researched: 2026-09-16*
