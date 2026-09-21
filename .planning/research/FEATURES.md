# Feature Research

**Domain:** AI agent evaluation. A real conversational agent is run on real dialogues with a reactive user simulator and an LLM judge. The product is delivered only inside the Pi terminal, plus a single-file HTML report and a text summary.
**Researched:** 2026-09-16
**Confidence:** MEDIUM. Specific product behaviour comes from official docs fetched today (HIGH where a docs URL is cited). Vendor marketing pages are MEDIUM. Recommendations for Agent Lab are my own inference from those sources and PROJECT.md.

> Scope note: we study these products only for their UX. PROJECT.md rules out adopting any of them as a dependency, and nothing below recommends that.
> Market note: Humanloop shut down on 2025-09-08 (team acqui-hired by Anthropic). The OpenAI Evals platform becomes read-only on 2026-10-31 and shuts down on 2026-11-30. Neither is a live reference point any more.

---

## How the leading products handle each target feature

### 1. Result / verdict screen

| Product | What it shows | Source |
|---|---|---|
| OpenAI Evals (being retired) | Separate counts for **total / errors / failed / passed**, then a pass/fail split for each criterion. Errors are never folded into failures. | [developers.openai.com/api/docs/guides/evals](https://developers.openai.com/api/docs/guides/evals) (HIGH) |
| promptfoo | **Pass rate** = share of tests where *all* assertions passed. Also a score histogram and filters: All / Failures / Passes / Errors / Different / Highlights. | [promptfoo.dev/docs/usage/web-ui](https://www.promptfoo.dev/docs/usage/web-ui/) (HIGH) |
| Cekura | Each test ends as **Pass / Review Required / Failed**, so an unsure verdict gets its own state and is not averaged away. Issue locations carry timestamps. | [cekura.ai/blogs/ai-agent-evals](https://www.cekura.ai/blogs/ai-agent-evals) (MEDIUM, vendor blog) |
| Braintrust | Summary table: average for each scorer, tokens, duration, and improvement/regression against a baseline. | [braintrust.dev/docs/evaluate/compare-experiments](https://www.braintrust.dev/docs/evaluate/compare-experiments) (HIGH) |
| LangWatch Scenario | Binary `success` for each scenario. The judge ends the run once the criteria are met or clearly failed. | [langwatch.ai/scenario/basics/concepts](https://langwatch.ai/scenario/basics/concepts/) (HIGH) |
| Anthropic research | Report a point estimate **with a confidence interval and the sample size**. Clustered questions can widen standard errors by more than 3x. | [arxiv.org/abs/2411.00640](https://arxiv.org/abs/2411.00640) (HIGH) |

**What this means for us.** Every serious tool keeps "could not measure" apart from "failed". Our `unknown / invalid / not reached` model already matches the best practice; the gap is presentation. None of the dashboard tools shows a one-line plain-language verdict, because they are built for engineers. For our manager persona that plain line is a real gap we can fill. With n ≤ 15, an honest range matters: 9/15 has a 95% Wilson interval of roughly 36–80%. The headline should say this in words ("small sample: range ±…") rather than show a formula.

### 2. Failure explanation format

| Product | Format | Source |
|---|---|---|
| Arize Phoenix | Each annotation holds `label` + `score` + `explanation`, and `annotator_kind` = HUMAN or LLM. | [arize.com/docs/phoenix/…/annotations](https://arize.com/docs/phoenix/sdk-api-reference/typescript/packages/phoenix-client/annotations) (HIGH) |
| LangSmith | Hovering over an LLM score shows the judge's reasoning. | [docs.langchain.com/langsmith/improve-judge-evaluator-feedback](https://docs.langchain.com/langsmith/improve-judge-evaluator-feedback) (HIGH) |
| Cekura | Timestamped points where the agent broke from the expected outcome. | vendor blog (MEDIUM) |
| Patronus Percival | Groups errors into 20+ failure modes (TRAIL taxonomy) and **suggests prompt fixes**. | [docs.patronus.ai/docs/percival/percival](https://docs.patronus.ai/docs/percival/percival) (MEDIUM) |
| Hamel Husain (practice) | Binary pass/fail **plus a written critique** of why ("critique shadowing"). Binary labels are more consistent than Likert scales. | [hamel.dev/blog/posts/llm-judge](https://hamel.dev/blog/posts/llm-judge/), [evals-faq](https://hamel.dev/blog/posts/evals-faq/) (MEDIUM, expert practice) |

**What this means for us.** The market standard is "verdict + free-text reasoning". Nobody consistently uses the structured triple **"should have done X → said Y → rule N (quote)"** with a link to the exact dialogue turn. That triple is a differentiator for us, and it is also what makes one-key agreement possible, because a person can check it in about 5 seconds.

### 3. Human agreement with the LLM judge

| Product | Collection | Display | Source |
|---|---|---|---|
| LangSmith Align Evals | Annotation queue with binary 0/1 labels → "Add to Reference Dataset". Recommends starting with at least 20 examples, balanced between 0 and 1. | **Alignment score = % of examples where the evaluator matches the human.** Misaligned cases can be sorted to the top, and a baseline score is kept across prompt versions. | [docs.langchain.com/…/improve-judge-evaluator-feedback](https://docs.langchain.com/langsmith/improve-judge-evaluator-feedback), [blog](https://www.langchain.com/blog/introducing-align-evals) (HIGH) |
| Langfuse | Annotation queues driven fully by keyboard (←/→ items, ↑/↓ fields, 1–9 options, Cmd+Enter = complete + next). | Score Analytics compares two score sources: **matched count, confusion matrix, Cohen's kappa with bands (0.81+ almost perfect, 0.61–0.80 substantial…), F1, overall agreement %**. | [annotation-queues](https://langfuse.com/docs/evaluation/evaluation-methods/annotation-queues), [score-analytics](https://langfuse.com/docs/evaluation/evaluation-methods/score-analytics) (HIGH) |
| Braintrust | "+ Human review score" in the trace view. Kanban review queue (backlog / pending / complete) with assignees. | Human scores are compared with automated scores to calibrate scorers. There is no dedicated agreement widget in the docs. | [braintrust.dev/docs/annotate/human-review](https://www.braintrust.dev/docs/annotate/human-review) (MEDIUM) |
| Confident AI | Domain experts annotate. | Metric scores compared with human annotations, showing false positives and false negatives. | [confident-ai.com/frameworks/deepeval](https://www.confident-ai.com/frameworks/deepeval) (MEDIUM, vendor) |
| Coval | "Smart sampling" puts failures, edge cases and low-confidence calls first. Analysts **confirm / override / annotate the AI verdict inline**. | The human feedback retrains the judge. | [coval.ai/products](https://www.coval.ai/products) (MEDIUM, marketing) |
| Galileo CLHF | Natural-language feedback on as few as 2–5 records auto-tunes the metric. | Claims up to +30% metric accuracy. | [galileo.ai blog](https://galileo.ai/blog/introducing-continuous-learning-with-human-feedback) (LOW–MEDIUM, vendor claim) |
| Hamel (practice) | One principal domain expert, binary labels. A custom annotation tool is "the single most impactful investment". Keep some random traces in every batch. | Measure **TPR and TNR separately** instead of raw agreement, because classes are imbalanced. | [evals-faq](https://hamel.dev/blog/posts/evals-faq/) (MEDIUM) |
| Anthropic | Read transcripts. Calibrate LLM rubrics against expert judgment often. A good task is one where two experts reach the same verdict on their own. | — | [anthropic.com/engineering/demystifying-evals-for-ai-agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) (HIGH) |

**What this means for us.**
- The cheapest collection pattern is Coval's "confirm/override inline on the failure you are already looking at" together with Langfuse-style single keys. That matches our "no labeling session" decision exactly.
- **Warning about our metric.** Agreement collected *only on failures* measures how precise the judge's "fail" verdicts are. It tells us nothing about false passes. Hamel's TPR/TNR advice and Coval/Hamel's "keep some random items" both point the same way: also offer 2–3 random *passed* dialogues for a quick check. Otherwise ≥90% agreement can coexist with a judge that quietly passes bad answers.
- Show **agreement % with its denominator** ("согласен в 9 из 10 проверенных"), following LangSmith. Kappa and confusion matrices are for engineers and are unstable at n < 20. Leave them out of the manager view; at most put them in the owner's detail tab.
- Every serious tool treats disagreements as a list to review. None hides them.

### 4. Run comparison and production vs test

| Product | Behaviour | Source |
|---|---|---|
| Braintrust | Pick a **baseline**. Test cases line up, each row gets a score delta (green = improved, red = regressed), rows sort by regressions, and diff mode shows each case's output across runs. The summary table can be exported **as a PDF for people without Braintrust access**. | [compare-experiments](https://www.braintrust.dev/docs/evaluate/compare-experiments) (HIGH) |
| Anthropic research | Compare at the question level with paired differences. It costs nothing and shrinks the standard error. | [arxiv 2411.00640](https://arxiv.org/abs/2411.00640) (HIGH) |
| LangSmith | `num_repetitions` shows the average plus the per-run scores and the standard deviation. | [docs.langchain.com/langsmith/repetition](https://docs.langchain.com/langsmith/repetition) (HIGH) |
| Anthropic | pass@k vs pass^k. Customer-facing agents need pass^k (success every time). | [demystifying-evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) (HIGH) |
| Braintrust / Coval / Cekura / Hamming | **The same scorers run offline (tests) and online (production logs)**. Production failures become regression tests (Hamming: "one click"). | [braintrust score-online](https://www.braintrust.dev/docs/evaluate/score-online) (HIGH); Coval/Cekura/Hamming pages (MEDIUM) |
| LangSmith Insights | Clusters production traces by usage pattern or by "poor interactions" and their root causes. | [docs.langchain.com/langsmith/insights](https://docs.langchain.com/langsmith/insights) (MEDIUM) |

**What this means for us.** "Same judge, same criteria, prod next to test" is table stakes in agent-testing tools. Everyone does it as streaming monitoring. For us it is a **batch score of recorded prod dialogues** (the existing `score` path) shown next to the test run. The comparison is only honest if the judge protocol version and the criteria set are identical, and if the view says in plain words that the two groups of dialogues differ (prod is the real distribution; test is the sampled validation set). Compare by scenario/goal type as well as the headline number.

### 5. Onboarding

| Product | Pattern | Source |
|---|---|---|
| promptfoo | `npx promptfoo@latest init --example getting-started` creates a ready-made example; `eval` then `view`. | [promptfoo.dev/docs/getting-started](https://www.promptfoo.dev/docs/getting-started/) (HIGH) |
| Langfuse | A public **example project** with real data you can explore before any setup. In-product onboarding screens appear for features you have not used yet. | [langfuse.com/docs/demo](https://langfuse.com/docs/demo), [changelog 2025-02-26](https://langfuse.com/changelog/2025-02-26-in-product-onboarding-screens) (HIGH) |
| Hamming | Claims testing is running in under 10 minutes, with scenarios generated automatically from the prompt. | [hamming.ai](https://hamming.ai/) (MEDIUM, marketing) |
| Coval | "Built so your AI coding assistant can run, inspect and iterate on evals for you." | [coval.ai](https://www.coval.ai/) (MEDIUM) |
| Live progress with cost | Tools generally show progress and token usage per run. I found no documented example of a live "$ spent / time remaining" counter during a run in these products. | LOW (not verified) |

**What this means for us.** The standard pattern is a demo you can run with zero config, plus a guided first run. Coval's "the AI assistant runs the evals" framing confirms our Pi-chat-as-wizard direction. A live cost and ETA counter looks *uncommon*, which makes it a small differentiator; our budget model already has the data.

### 6. Shareable reports for non-technical stakeholders

| Product | Pattern | Source |
|---|---|---|
| Braintrust | PDF export of the summary table "for people without Braintrust access". | [compare-experiments](https://www.braintrust.dev/docs/evaluate/compare-experiments) (HIGH) |
| promptfoo | Shareable URL (cloud or self-hosted). The GitHub Action posts a PR comment with pass/fail counts and a link. | [web-ui](https://www.promptfoo.dev/docs/usage/web-ui/), [ci-cd](https://www.promptfoo.dev/docs/integrations/ci-cd/) (HIGH) |
| Hamming | "PDF reports for QA signoff." | [hamming.ai/resources/hamming-vs-coval](https://hamming.ai/resources/hamming-vs-coval) (MEDIUM) |
| Confident AI | Pitches a shared dashboard "instead of pasting results into Slack". | vendor (MEDIUM) |

**What this means for us.** Stakeholder artifacts are the summary *table* (numbers) plus a link or a PDF. None of these products writes a plain-language verdict for a manager. A single self-contained HTML file together with a short text for a messenger fits our constraints (bank data must stay local, so no hosted links) and goes beyond what these tools offer for the manager persona.

---

## Feature Landscape

Grouped by milestone category. The persona key is **O** = agent owner (Pi), **M** = customer manager (no terminal), **N** = newcomer.

### Table Stakes (users leave or distrust without these)

#### A. Trust in the number

| Feature | Persona | Why Expected | Complexity | Notes |
|---|---|---|---|---|
| One headline metric with **one** denominator | O, M | Every tool leads with one pass rate (promptfoo, OpenAI Evals). Several denominators read as broken. | LOW | "Цель достигнута в 5 из 9 измеренных диалогов". Other counts move to a secondary line. |
| "Not measured" kept separate and named in plain words, with the main reason | O, M | OpenAI Evals: errors ≠ failures. Cekura: "Review Required" is its own state. | LOW | Already true in the data. The main exclusion reason must not hide behind "прочее". |
| Honest uncertainty for small n | O, M | Anthropic error-bars paper: always give the sample size and an interval. | LOW | Plain words: "мало данных: реальная доля где-то 36–80%". Wilson interval, no new dependency. |
| A re-run of an old run stays comparable (the `goalObservation` default defect) | O | Braintrust and LangSmith baselines only work if cases line up. | MEDIUM | Required before any diff or prod-vs-test view can be trusted. |
| Stability across repeats: flag cards whose verdict flips | O | LangSmith repetitions show the standard deviation; Anthropic pass^k. | MEDIUM | Mark flipping cards as "нестабильно" and don't count them silently. Costs extra calls, so it needs a budget line. |
| Pre-run expectations screen with one-action confirmation | O | LangWatch criteria are visible in code. In a no-code flow the owner has to see them before paying. | MEDIUM | Rule numbers shown here must be the **same IDs** that failure explanations cite later. |
| Budget honesty: CLI `score` scales the budget like Pi does | O | Cost predictability is basic trust. | LOW | Known defect. |

#### B. Judge quality and human agreement

| Feature | Persona | Why Expected | Complexity | Notes |
|---|---|---|---|---|
| Each failure has a reason plus evidence citations | O, M | Phoenix, LangSmith: every judge verdict comes with an explanation. | MEDIUM | Already partly there (judge quotes events). The gap is the *format*. |
| Human can override a verdict, and the override wins | O | Coval "confirm/override inline"; Langfuse and Braintrust human scores. | LOW | Already exists. It needs a single key on the board. |
| Agreement shown as a % with its denominator | O, M | LangSmith alignment score = % match. | LOW | "Согласие с судьёй: 9 из 10 проверенных". Hide the % or add a warning below about 5 checks. |
| Disagreements listed so they can be reviewed | O | LangSmith sorts misaligned cases first; Confident AI shows false positives and false negatives. | LOW | A filter on the Провалы tab. |
| Binary verdicts (pass / fail / unknown), no Likert | O, M | Hamel: binary labels are more consistent. Cekura uses three states. | LOW | Already true. Keep it. |

#### C. Result screen in Pi

| Feature | Persona | Why Expected | Complexity | Notes |
|---|---|---|---|---|
| Filters for failures only / unmeasured only | O | promptfoo filter modes; Braintrust sort by regressions. | LOW | Tabs on the board. |
| Go from a failure to the dialogue with the offending turn highlighted | O | Cekura timestamped issue locations; Braintrust diff mode; Anthropic: "read the transcripts". | MEDIUM | pi-tui scrolling and highlighting. Needs a turn index in the evidence. |
| Top failure causes grouped with counts | O, M | LangSmith Insights and Percival cluster failures. | LOW | Clusters already exist. Show the top 3, never cut mid-word. |
| Clear next step | O, N | Onboarding screens (Langfuse) always point to the next action. | LOW | One line: "проверьте 3 провала (клавиша a/d)", "повторите после исправления". |
| Keyboard-first navigation | O | Langfuse queue shortcuts; promptfoo shortcuts. | LOW | ←/→, a = agree, d = disagree, Enter = open dialogue. |
| Line wrapping without truncation | O | Basic quality. The current summary cuts reasons mid-word. | LOW | Shared wrap utility for the block, board and progress view. |

#### D. Customer-facing summary and report

| Feature | Persona | Why Expected | Complexity | Notes |
|---|---|---|---|---|
| An artifact that works without the tool | M | Braintrust PDF "for people without access"; Hamming PDF signoff; promptfoo share. | MEDIUM | A single self-contained HTML file (inline CSS, no JS dependencies, no external fonts). |
| Copyable short text summary | M, O | promptfoo PR-comment summary; people paste results into Slack (Confident AI pitch). | LOW | 5–8 lines: verdict, number with range, top 3 reasons, what was not measured, human agreement. |
| Date, agent version, dataset size and judge on the report | M | Braintrust experiment metadata. | LOW | Needed so the report can be forwarded and traced. |

#### E. Onboarding and progress

| Feature | Persona | Why Expected | Complexity | Notes |
|---|---|---|---|---|
| Built-in demo with a full result, no setup | N | promptfoo `init --example`; Langfuse example project. | MEDIUM | The sandbox target already exists. Precompute or ship a recorded demo run so it takes about 1 minute and costs about $0. |
| Step checklist visible on screen | N | Langfuse in-product onboarding. | MEDIUM | агент → требования → логи → связь → бюджет → запуск, with the current step highlighted. |
| Connection check before spending money | N, O | Braintrust and promptfoo fail fast on provider config. | LOW | `agent_lab_connection` / doctor probe already exists. |
| Live progress: dialogues done / left | O, N | Any long-running eval CLI shows progress. | LOW–MEDIUM | Runs take 6–17 minutes, so silence feels broken. |

#### F. Production vs test

| Feature | Persona | Why Expected | Complexity | Notes |
|---|---|---|---|---|
| Score recorded production dialogues with the same judge and criteria | O, M | Braintrust online scoring, Coval Observe, Cekura: "same metric suite" for prod and tests. | MEDIUM | Reuses `score`. The judge protocol version and criteria set must be pinned and recorded. |
| Prod and test side by side with the same metric definition | M, O | Customer request. Braintrust summary-table columns. | MEDIUM | Two columns, the same headline formula, "not measured" shown for each column. |
| Plain caveat that the two populations differ | M | The Anthropic paper on clustering and sample differences. | LOW | "Тест — 15 отобранных сценариев, прод — N реальных диалогов за период". |

### Differentiators (where Agent Lab competes)

| Feature | Category | Value Proposition | Complexity | Notes |
|---|---|---|---|---|
| **Plain-language verdict line for managers** ("Агент хорошо справляется с X, ошибается в Y") | C, D | No dashboard tool writes this. Directly serves the Core Value ("понимают за 10 секунд"). | MEDIUM | Build it from structured fields in a template, not free LLM prose, so the wording stays the same across runs. |
| **Structured failure triple: "должен был X → сказал Y → правило N (цитата)" + turn link** | B | The market standard is free-text reasoning. The triple can be checked in seconds, which is what makes the ≥90% agreement target possible. | MEDIUM–HIGH | Needs stable rule IDs from the expectations screen and a quote validator (the quote must exist verbatim in the requirements and the dialogue). |
| **Agreement collected where people already look (one key on the failure)** | B | Coval does this in a SaaS UI. Nobody does it in a terminal. It removes the labeling chore that Align Evals and Langfuse queues require. | LOW–MEDIUM | Store as a human verdict (already supported). Keep the evidence visible on the same screen as the key. |
| **Random "passed" spot-check (2–3 dialogues) inside the same flow** | B | Covers the false-pass blind spot that failure-only agreement leaves open (Hamel TPR/TNR). Few products push this. | LOW | Label the tab "проверить успехи". Report the agreement split: on failures / on successes. |
| **Expectations confirmed before paying** | A | Most tools define criteria in code. A one-screen "what the agent must do, by which rule" that a manager could read is rare. | MEDIUM | Also makes failure explanations traceable. |
| **Flip-flop / stability marker per card** | A | LangSmith shows a standard deviation. A plain "нестабильно: 2 из 3 повторов" marker is clearer. | MEDIUM | Optional repeat mode with an explicit budget. |
| **Live cost + ETA during the run** | E | Not found as a documented feature in the surveyed tools. It matters when a run costs about $2 and 6–17 minutes. | LOW–MEDIUM | Budget data already exists. |
| **One-sentence setup** ("проверь агента в этой папке, логи тут") with auto-discovery of prompt and entry point | E | Hamming claims "<10 min"; Coval pitches "your coding assistant runs evals". Pi as the wizard can go further. | HIGH | The riskiest item: adapter generation varies a lot per repo. Keep a manual fallback on the checklist. |
| **Self-contained HTML that a manager understands without Pi** | D | Braintrust exports a table. We export a *verdict*. No hosted link needed, which suits bank data. | MEDIUM | Verdict → number with range → reasons with one example each → what was not measured → agreement → prod vs test. |
| **Prod-vs-test in one view with a plain caveat** | F | Competitors show it as separate dashboards. A single comparison with the caveat answers the customer's actual question. | MEDIUM | Depends on pinned judge protocol and criteria. |

### Anti-Features (deliberately NOT build)

| Feature | Why Requested | Why Problematic | Alternative |
|---|---|---|---|
| Annotation queues with assignment, kanban, reviewer roles (Braintrust, Langfuse) | Looks "enterprise" | Brings back the labeling chore PROJECT.md excludes. Our users are a solo owner plus one manager. | One-key agree/disagree on the board while browsing failures. |
| Likert 1–5 or composite 0–100 quality scores (Percival scores 1–5) | Feels more nuanced | Hamel: less consistent than binary. Averages hide failures, and a manager can't read "3.7". | Binary pass / fail / unknown and one accuracy number. |
| Cohen's kappa, F1 or confusion matrix in the manager view (Langfuse) | Looks rigorous | Unstable at n < 20, and managers can't read it. | "согласен в 9 из 10". Kappa at most in the owner detail tab, and only when n ≥ 20. |
| Automatic judge re-tuning from human feedback (Galileo CLHF, Coval "retrains the judge") | "The judge gets smarter" | With 10–20 labels it overfits, silently changes the protocol, and breaks comparisons with earlier runs (the F-01 lesson). | Record disagreements. Change the judge only through an explicit, versioned protocol bump plus `reassess`. |
| Suggested prompt fixes or auto-fixing the agent (Percival, Cekura "suggests fixes") | Obvious next step | Explicitly out of scope. It also mixes the measuring tool with the change being measured. | The next-step line points to the failed rule. The owner fixes the agent. |
| Hosted share links or a web dashboard (promptfoo.app, Confident AI) | Easy forwarding | Web app is out of scope, and bank data must stay local. | Single-file HTML plus copyable text. |
| Real-time production monitoring with alerts (Coval Observe, Cekura, Braintrust online) | "Same as competitors" | Turns the product into an observability platform, which the 2026-09-09 correction rules out. | Batch `score` of an exported prod log, compared with a test run. |
| Generating thousands of synthetic scenarios (Coval, Hamming) | Coverage | Contradicts "real dialogues", inflates cost, and synthetic items hide their share. | Real-dialogue validation set (≤15). If synthetic items are ever used, their share is always shown. |
| Dozens of built-in metrics (Hamming "50+") | Checklist marketing | Several metrics dilute the headline. Managers lose the answer. | One goal-accuracy headline. Strict compliance and RAG diagnostics are secondary. |
| CI / GitHub Action as the centre of the product (promptfoo) | DevOps teams want it | Explicitly not the product centre. | CLI `evaluate --yes` exists for anyone who wants it. No product surface for it. |
| Red-teaming or security scanning | Common in the space (promptfoo, LangWatch) | Different product. | Not planned. |
| LLM-written free-prose executive summary | Sounds friendly | Wording drifts between runs, can hallucinate, and can't be checked. | Template-built verdict from structured fields. An LLM may only fill one slot, with quotes validated. |

---

## Feature Dependencies

```
[Comparable re-runs (goalObservation default fix)]
    └──required by──> [Run diff / Сравнение tab]
    └──required by──> [Prod vs test view]

[Pinned judge protocol + criteria set recorded in run]
    └──required by──> [Prod vs test view]
    └──required by──> [Agreement % over time]

[Expectations screen with stable rule IDs]
    └──required by──> [Failure triple "X → Y → rule N (quote)"]
                          └──required by──> [One-key agree/disagree at a glance]
                                                └──required by──> [Agreement % (≥90% target)]
                                                                      └──feeds──> [Verdict block, HTML, text summary]

[Turn index in evidence]
    └──required by──> [Failure → dialogue with highlighted turn]
                          └──enhances──> [One-key agree/disagree]

[Headline formula: one denominator + not-measured + small-n range]
    └──required by──> [Verdict block in chat]
    └──required by──> [Text summary]
    └──required by──> [HTML report]
    └──required by──> [Prod vs test columns]

[Shared visual language (colors, bars, wrap utility)]
    └──required by──> [Verdict block] [Board tabs] [Live progress]

[Budget scaling in CLI score] ──required by──> [Prod scoring of N dialogues] ──required by──> [Prod vs test]
[Budget model] ──required by──> [Live cost + ETA]

[Built-in demo run] ──enhances──> [Onboarding checklist]
[Connection probe] ──required by──> [Onboarding checklist "связь" step]
[One-sentence setup / adapter discovery] ──enhances──> [Onboarding checklist] (the checklist must also work without it)

[Stability repeats] ──conflicts (budget)──> [Live demo cost ~$0] — keep repeats opt-in, and off in the demo
[Auto judge re-tuning] ──conflicts──> [Comparable re-runs]   (anti-feature)
```

### Dependency Notes

- **The headline formula comes before every surface.** The block, board, text and HTML must share one function. Otherwise the four surfaces will show four different numbers, which is the exact problem with the current summary.
- **Failure triple before agreement.** People only agree "at a glance" when the evidence is structured. With free-text reasoning, agreement will be lower and slower, and the ≥90% target becomes a measure of the explanation format as much as of the judge.
- **Comparability and a pinned protocol before diff and prod-vs-test.** Without them a delta may just reflect a changed default or judge version (F-01).
- **Agreement on failures alone is biased.** Add a random spot-check of passed dialogues in the same phase, or state in the UI that agreement only covers failures.

---

## MVP Definition (for the 2026-09-21 demo)

### Launch With (v1), ordered by what the customer sees

- [ ] Headline formula: one denominator, not-measured with its main reason, small-n range. *Every surface depends on it.*
- [ ] Verdict block in chat: headline, top 3 reasons (no truncation), not-measured, next step, no jargon. *The Core Value.*
- [ ] Failure triple with quotes (rule N from the requirements, turn from the dialogue). *Trust, and the basis for agreement.*
- [ ] Board: Итог / Провалы / Диалоги tabs, jump to the highlighted turn, keys a/d for agree/disagree, agreement "N из M". *The ≥90% evidence.*
- [ ] Prod scored by the same judge, shown next to test with a caveat. *What the customer explicitly asked for.*
- [ ] Single-file HTML plus copyable text summary. *The manager never opens Pi.*
- [ ] Comparability fix plus pinned judge protocol in the run record. *Otherwise the prod-vs-test numbers are not trustworthy.*
- [ ] Live progress (done/left) with cost. *A 6–17 minute run must not look frozen.*

### Add After Validation (v1.x)

- [ ] Random passed-dialogue spot-check — once the first agreement numbers exist (to show the false-pass rate).
- [ ] Сравнение tab (run diff with per-card green/red, sorted by regression) — when the owner starts iterating on the agent.
- [ ] Stability repeats with a flip marker — when variance between repeats is observed on the real agent.
- [ ] Expectations confirmation screen polish — if owners dispute rules after runs.
- [ ] Built-in demo plus onboarding checklist — before the first newcomer who is not us.

### Future Consideration (v2+)

- [ ] One-sentence setup with automatic adapter generation — high variance per repo. Needs a second real agent to validate against.
- [ ] Kappa and TPR/TNR in the owner detail tab — only once ≥20 human labels exist per run.
- [ ] Clustering prod dialogues by usage pattern (LangSmith Insights style) — only if the customer asks "what do real users ask".

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---|---|---|---|
| Headline formula (one denominator, not-measured, range) | HIGH | LOW | P1 |
| Verdict block in chat | HIGH | MEDIUM | P1 |
| Failure triple with quotes and turn link | HIGH | MEDIUM–HIGH | P1 |
| One-key agree/disagree + agreement % | HIGH | LOW–MEDIUM | P1 |
| Comparability fix + pinned judge protocol | HIGH (hidden) | MEDIUM | P1 |
| Prod scoring + side-by-side view | HIGH | MEDIUM | P1 |
| Single-file HTML report | HIGH | MEDIUM | P1 |
| Copyable text summary | HIGH | LOW | P1 |
| Live progress with cost / ETA | MEDIUM | LOW–MEDIUM | P1 |
| Shared visual language / wrap utility | MEDIUM | LOW | P1 |
| Board tabs + highlighted-turn navigation | HIGH | MEDIUM | P1 |
| Random passed spot-check | MEDIUM | LOW | P2 |
| Сравнение tab (run diff) | MEDIUM | MEDIUM | P2 |
| Expectations confirmation screen | MEDIUM | MEDIUM | P2 |
| Stability repeats / flip marker | MEDIUM | MEDIUM | P2 |
| Built-in demo (~1 min) | MEDIUM (N) | MEDIUM | P2 |
| Onboarding checklist | MEDIUM (N) | MEDIUM | P2 |
| One-sentence setup / adapter discovery | HIGH (N) | HIGH | P3 |
| Kappa / TPR-TNR detail | LOW | LOW | P3 |

## Competitor Feature Analysis

| Feature | Braintrust | LangSmith | Langfuse | promptfoo | Coval / Cekura / Hamming | Our approach |
|---|---|---|---|---|---|---|
| Headline | Average for each scorer plus delta | Average feedback per key | Score tables | Pass rate plus histogram | Pass / Review / Fail (Cekura) | One goal-accuracy number, one denominator, range, plain verdict line |
| Unmeasured | — | — | — | Errors filter | "Review Required" | Named "не измерено" with the main reason |
| Failure explanation | Scorer rationale | Reasoning on hover | Score comment | Assertion reason | Timestamped issue | "должен был X → сказал Y → правило N" + quotes + turn |
| Human agreement | Human review scores, kanban queue | Align Evals: % alignment, ≥20 labels | Queues + kappa / F1 / confusion | Thumbs up/down | Confirm/override inline; retrains judge | One key on the failure being viewed, "N из M", plus a random passed spot-check. No auto-retraining. |
| Run comparison | Baseline, green/red deltas, sort by regression, diff mode | Repetitions with stddev | Dataset run compare | Side-by-side columns | Scheduled regression runs | Paired per-card diff; pinned protocol |
| Prod vs test | Same scorers online and offline | Online evaluators; Insights clustering | LLM-as-judge on traces | — | Same metrics in Observe and Simulate | Batch `score` of exported prod log, side by side, with caveat |
| Stakeholder artifact | PDF of summary table | — | — | Share URL, PR comment | PDF QA signoff (Hamming) | Single-file HTML verdict + messenger text |
| Onboarding | Quickstart | Quickstart | Public example project, in-product screens | `init --example` | "<10 min", AI assistant runs evals | Pi chat as wizard, checklist, ~1 min built-in demo, live cost/ETA |

## Sources

- Braintrust — compare experiments: https://www.braintrust.dev/docs/evaluate/compare-experiments (HIGH)
- Braintrust — score production traces: https://www.braintrust.dev/docs/evaluate/score-online (HIGH)
- Braintrust — human review: https://www.braintrust.dev/docs/annotate/human-review (MEDIUM)
- LangSmith — improve LLM-as-judge with human feedback: https://docs.langchain.com/langsmith/improve-judge-evaluator-feedback (HIGH)
- LangSmith — Align Evals announcement: https://www.langchain.com/blog/introducing-align-evals (HIGH)
- LangSmith — repetitions: https://docs.langchain.com/langsmith/repetition (HIGH)
- LangSmith — Insights: https://docs.langchain.com/langsmith/insights (MEDIUM)
- Langfuse — annotation queues: https://langfuse.com/docs/evaluation/evaluation-methods/annotation-queues (HIGH)
- Langfuse — score analytics: https://langfuse.com/docs/evaluation/evaluation-methods/score-analytics (HIGH)
- Langfuse — example project: https://langfuse.com/docs/demo ; onboarding screens: https://langfuse.com/changelog/2025-02-26-in-product-onboarding-screens (HIGH)
- promptfoo — web viewer: https://www.promptfoo.dev/docs/usage/web-ui/ ; getting started: https://www.promptfoo.dev/docs/getting-started/ ; CI/CD: https://www.promptfoo.dev/docs/integrations/ci-cd/ (HIGH)
- Arize Phoenix — annotations: https://arize.com/docs/phoenix/sdk-api-reference/typescript/packages/phoenix-client/annotations (HIGH)
- OpenAI — working with evals (includes deprecation notice): https://developers.openai.com/api/docs/guides/evals (HIGH)
- LangWatch Scenario — concepts: https://langwatch.ai/scenario/basics/concepts/ (HIGH)
- Patronus Percival: https://docs.patronus.ai/docs/percival/percival (MEDIUM)
- Galileo CLHF: https://galileo.ai/blog/introducing-continuous-learning-with-human-feedback (LOW–MEDIUM, vendor claim)
- Confident AI / DeepEval: https://www.confident-ai.com/frameworks/deepeval (MEDIUM)
- Coval products: https://www.coval.ai/products (MEDIUM, marketing)
- Cekura — agent evals: https://www.cekura.ai/blogs/ai-agent-evals (MEDIUM, vendor blog)
- Hamming: https://hamming.ai/ , https://hamming.ai/resources/hamming-vs-coval (MEDIUM, marketing)
- Humanloop sunset: https://news.ycombinator.com/item?id=44592216 (MEDIUM)
- Anthropic — Demystifying evals for AI agents: https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents (HIGH)
- Anthropic — Adding Error Bars to Evals: https://arxiv.org/abs/2411.00640 (HIGH)
- Hamel Husain — LLM judge guide: https://hamel.dev/blog/posts/llm-judge/ ; Evals FAQ: https://hamel.dev/blog/posts/evals-faq/ (MEDIUM, expert practice)
- Project context: .planning/PROJECT.md, .planning/codebase/ARCHITECTURE.md, README.md

---
*Feature research for: AI agent evaluation (Pi-native Agent Lab)*
*Researched: 2026-09-16*
