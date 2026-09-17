---
phase: "5"
slug: "vyzhimka-i-html-otchet-dlya-menedzhera"
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-09-17"
---

# Phase 5 — Validation Strategy

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `node:test` via `tsx --test` (tsx ^4.20), TypeScript 5.9.3; `npm run typecheck` for the extension (inside the snapshot only) |
| **Config file** | none (`package.json` scripts); runner `.planning/phases/01-odno-chestnoe-chislo/snap-test.sh` |
| **Quick run command** | `TZ=UTC bash .planning/phases/01-odno-chestnoe-chislo/snap-test.sh test/redact.test.ts test/share.test.ts test/manager-report.test.ts test/artifacts.test.ts` |
| **Full suite command** | `bash .planning/phases/01-odno-chestnoe-chislo/snap-test.sh --full` |
| **Stored-run check** | `snap-test.sh --keep …` → `SNAP=`; from `$SNAP`: `npx tsx .planning/phases/05-vyzhimka-i-html-otchet-dlya-menedzhera/verify-share.mjs --data <repo>/.agent-lab --out <mktemp dir> --browser <headless shell> --id fae4ee59-d6da-4cbf-83b5-574e34405877 --id a92fd6ae-8eaa-42ea-8ba0-d804096ce1d4 --id 61521e0d-b5a9-45e6-b13a-3e04349a6482 --id c1b9f043-532d-4fad-99c3-b437061be3a7 --marks a92fd6ae-8eaa-42ea-8ba0-d804096ce1d4` (prints ids and counts only; outputs never in the repo) |
| **Estimated runtime** | ~40 s for the quick command; ~90 s for the stored-run check with the browser |

Never run `npm test` or `npm run build` in the worktree. Every test that prints a date runs under `TZ=UTC` (this machine is already Europe/Moscow, so a missing `timeZone` would otherwise pass unnoticed). No paid model calls anywhere in this phase.

## Sampling Rate

- **After every task commit:** the task's own `<automated>` command (touched test files under `TZ=UTC`, or the whole working tree when the extension changed).
- **After every plan wave:** `snap-test.sh` with no arguments (whole working tree plus the extension typecheck).
- **Before `/gsd-verify-work`:** `snap-test.sh --full`, `verify-share.mjs` clean on the stored runs, the marks copy and (when present) RE11/A11/NEW11, `verify-stored-runs.mjs` and `pi-surface-check.mts` unchanged, the headless print produced.
- **Max feedback latency:** 60 seconds.

## Per-Task Verification Map

| Req | Plan / Task | Behavior | Test Type | Automated Command | File Exists | Status |
|-----|-------------|----------|-----------|-------------------|-------------|--------|
| SHARE-01/03 | 05-01 T1 (tracer) | `agent-lab share --id RUN` prints the guarded summary and writes `<id>.summary.txt` (0600, atomic); no client window in stdout | integration (CLI spawn) | `TZ=UTC snap-test.sh test/share.test.ts` | ❌ W0 (created here) | ⬜ |
| SHARE-03 | 05-01 T2 | Luhn card, non-Luhn 16 digits, 20-digit account, generated INN 10/12, phones, e-mail, internal hosts/URLs/IPs masked; dates, times, short numbers, UUIDs, hex hashes, public URLs kept; guard cuts client windows (trials, `sourceEvidence`, dialogues), exempts owner text, falls back to `Ситуация N` | unit | `snap-test.sh test/redact.test.ts test/share.test.ts` | ❌ W0 (created here) | ⬜ |
| SHARE-01 | 05-02 T1 | Variants A–F exact; ≤ 15 lines and ≤ 900 characters on the 99/99, 494-character, 120-character-name vector; drop order L12 → L4 → L9 → L8; no ANSI, box drawing, Markdown or emoji other than ✓ ✗; leak and jargon helper clean | unit | `TZ=UTC snap-test.sh test/share.test.ts test/redact.test.ts` | ✅ extend + ❌ W0 helper | ⬜ |
| SHARE-01 | 05-02 T2 | `resolveId` (full id, unique 8+ prefix, N5a, N5b); `shareRefusal` (N6, N7) inside `exportCustomer`; CLI prefix and refusals | unit + CLI spawn | `TZ=UTC snap-test.sh test/share.test.ts test/artifacts.test.ts` | ✅ extend | ⬜ |
| SHARE-02/03 | 05-03 T1 | Manager document rules (head order, exact CSP, one style, MANAGER_CSS rules), forbidden constructs absent, header facts C-157…C-161 under `TZ=UTC`, first screen S1, «Как считали», note; escaping vectors; guard on titles; warnings sentence; leak and jargon clean; ids only from counters | unit | `TZ=UTC snap-test.sh test/manager-report.test.ts test/share.test.ts test/artifacts.test.ts test/cards.test.ts` | ❌ W0 (created here) | ⬜ |
| SHARE-02 | 05-03 T2 | `export --format manager` (path line, 0600, atomic, `--output` over a 0644 file); unknown-format text; `share` writes both files and prints both lines; `summaryOnly` | CLI spawn | `TZ=UTC snap-test.sh test/share.test.ts test/manager-report.test.ts test/artifacts.test.ts` | ✅ extend | ⬜ |
| SHARE-02/03 | 05-04 T1 | S2 every failure with F1 variants, reply only in closed `<details>` and masked; S3 disagreements with masked notes | unit | `TZ=UTC snap-test.sh test/manager-report.test.ts test/explain.test.ts test/agreement.test.ts` | ✅ extend | ⬜ |
| SHARE-02/03 | 05-04 T2 | S4 comparison with the R5 date variant and classes; 15/60 worst-case fixture < 200 000 bytes with leak, jargon and attribute scans clean | unit | `TZ=UTC snap-test.sh test/manager-report.test.ts test/result-view.test.ts test/comparison.test.ts` | ✅ extend | ⬜ |
| SHARE-04 | 05-05 T1 | Audit HTML banner (first child of `<main>`), title prefix, MSK header, hashed script kept; Markdown banner line; JSON `doNotForward` | unit | `TZ=UTC snap-test.sh test/artifacts.test.ts test/cards.test.ts test/product-flow.test.ts` | ✅ extend | ⬜ |
| SHARE-04 | 05-05 T2 | Stable `.audit.*` / `.snapshot.json` names; `exportArtifacts` keeps its keys and adds `managerReport`/`summary` only for shareable runs; `export --format html` path line | unit + CLI + Pi payload | `TZ=UTC snap-test.sh` (whole working tree) | ✅ extend | ⬜ |
| SHARE-01/02 | 05-06 T1 | `/agent-lab share <id8>`: files, injected copy, editor fallback (N3), no-UI silence, N5/N5a/N5b/N6/N7/N8 | integration (fake Pi) | `TZ=UTC snap-test.sh` (whole working tree) | ✅ extend | ⬜ |
| SHARE-01/02/04 | 05-06 T2 | Board `x` select (3 options, dismiss), refusals on options 1–2, audit option N4 warning; `o` opens only the manager file, re-renders stale files, N9; footer prefix and help row C-180 | integration (fake Pi) + unit (cards) | `TZ=UTC snap-test.sh` (whole working tree) | ✅ extend | ⬜ |
| All | 05-07 T1 (tracer) | Stored runs + marks copy: size, script, resources, tags, CSP/print/dark/lang, MSK, V1 and headline equal to the CLI, failures count, 0 overlaps, 0 PII, 0 jargon, originals unchanged; headless PDF and screenshots with 0 CSP lines | e2e (free, read-only) | `verify-share.mjs` from a `--keep` snapshot (the 05-07 T1 verify command) | ❌ W0 (created here) | ⬜ |
| All | 05-07 T2 | dist swap; stored-run counts and surfaces unchanged; real CLI commands on a copy print the M5 lines and write 0600 stable names; customer files handed to the owner | e2e (free) | evidence greps in `~/agent-lab-evidence/phase-05/` (the 05-07 T2 verify command) | — | ⬜ |

## Wave 0 Requirements

- [ ] `test/share.test.ts` — created by 05-01 Task 1 (its own verify command runs it)
- [ ] `test/redact.test.ts` — created by 05-01 Task 2
- [ ] `test/helpers/customer-leaks.ts` (`visibleText`, `clientWindowsOf`, `customerLeaks`, `CUSTOMER_JARGON`, `jargonHits`) — created by 05-02 Task 1, used by 05-03, 05-04 and `verify-share.mjs`
- [ ] `test/manager-report.test.ts` — created by 05-03 Task 1
- [ ] `.planning/phases/05-vyzhimka-i-html-otchet-dlya-menedzhera/verify-share.mjs` — created by 05-07 Task 1
- [ ] Worst-case fixtures (15 situations / 60 dialogues / 494-character expectations / 819-character replies; 99/99 summary vector) — built inside `test/manager-report.test.ts` (05-04 T2) and `test/share.test.ts` (05-02 T1) from builders copied out of `test/explain.test.ts`, `test/agreement.test.ts` and `test/result-view.test.ts` (phase 2–4 plans)

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Cyrillic reads correctly in Segoe UI | SHARE-02 | macOS has no Segoe UI; the user is asleep during this run | Open `~/agent-lab-evidence/phase-05/customer/<id8>.manager.html` on a Windows machine (Edge or Chrome); check headings, the bar, `•••• 1234` and the «Как считали» paragraph |
| A4 paper print without cut-off | SHARE-02 | Needs a printer or the system print preview | Print the same file on A4; the first page holds the first screen and the start of the failure list; closed replies print (Chromium) |
| Firefox and Safari print closed `<details>` | SHARE-02 | `details::details-content` is verified only in Chromium 151 (RESEARCH A1) | Print preview in Firefox.app and Safari.app; if replies are hidden, note it — the first screen does not depend on them |
| Dark scheme look | SHARE-02 | The headless dark flag is assumed; it may have no effect | Open the file with the system dark theme; check contrast of the verdict, bar and labels |
| Summary pasted into a messenger | SHARE-01 | Needs the owner's Telegram/WhatsApp and the real terminal clipboard | In Pi run `/agent-lab share <id8>` on the demo run, paste into Telegram: ✓/✗ show, no Markdown restyling, no line longer than the message width breaks the meaning |
| The clipboard notice matches reality | SHARE-01 | OSC 52 reports success even when the terminal ignores it | After the paste above, confirm the hedged notice was accurate; if the paste was empty, use the file path from the notice |
| The owner opens the customer file from the board | SHARE-02/04 | Needs a live Pi session after the dist swap | Restart Pi in the worktree, `/agent-lab <id8>`, press `x` (first option), then `o`; the browser shows the customer report, never the audit report |

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60 s (per task)
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
