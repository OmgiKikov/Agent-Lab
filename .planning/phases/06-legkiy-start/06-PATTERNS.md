# Phase 6: Лёгкий старт - Pattern Map

**Mapped:** 2026-09-17
**Files analyzed:** 17 new/modified files (plus 4 verification scripts)
**Analogs found:** 19 / 21

**Read this first (anchor stability).**
- Line numbers below were read at HEAD `c753aef`.
- Phases 2–5 are planned but not executed yet. They rewrite `extensions/agent-lab.ts`, `extensions/cards.ts`, `skills/agent-builder/SKILL.md`, `src/result-view.ts` and their tests:
  - 02-05 and 02-08 change the system prompt, `agent_lab_accept` and `agent_lab_run`;
  - 03-03 and 03-04 change the board and agreement keys;
  - 04-01 … 04-08 add `extensions/render/**` and `src/progress.ts`, split `cards.ts` into tabs, rewrite `toolDisplay.renderResult`, the run loop, the skill's "after the run" part and the board header;
  - phase 5 adds `/agent-lab share` to the command handler.
- **Every anchor in `extensions/agent-lab.ts`, `extensions/cards.ts`, `SKILL.md`, `test/extension.test.ts`, `test/skill.test.ts` and `test/cards.test.ts` may shift; re-read.** Locate code with the grep anchors given in each row, never with line numbers.
- Symbols that exist only in earlier-phase plans are cited as `[plan NN-NN]`. Read the landed code before using them. If a shape differs, adapt inside the phase-6 file and name the difference in the SUMMARY.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/connection.ts` (+ `checkConnection`, `classifyConnectionError`, `connectionRows`, `consentBody`, `targetName`, `ConnectionCheck`) | service (adapter call) + pure text | request-response | same file, `doctor` :82-120; `src/targets.ts` `preflightTarget` :46, `openExternalTarget` :318 | exact |
| `src/progress.ts` (+ `preparationChecklist`, `checklistRows`, `checklistText`) | utility (pure view) | transform | `[plan 04-08]` `progressView`; `src/result-view.ts` `pluralForm`, `resultViewLines` | role-match |
| `extensions/render/theme.ts` (+ `GLYPH.todo`, `prep-*` and `conn-*` roles) | utility (terminal paint) | transform | `[plan 04-01]` `GLYPH`, `ROLE_TONE`, `renderRows` | exact (extend) |
| `extensions/render/connection.ts` (new: `ConnectionBlock`, `connectionBlockRows`, `isConnectionDetails`) | component | request-response (render) | `[plan 04-08]` `extensions/render/progress.ts` `ProgressBlock`; `[plan 04-01]` `VerdictBlock` | role-match |
| `extensions/render/checklist.ts` (new: `checklistWidget` factory) | component | event-driven (refresh) | `[plan 04-08]` `ProgressBlock`; Pi `setWidget` factory overload (`types.d.ts:97-98`) | role-match |
| `extensions/render/verdict-block.ts` (dispatch branch) | component (dispatcher) | request-response | `[plan 04-01]` `renderAgentLabResult`; `[plan 04-08]` partial-progress branch | exact (extend) |
| `extensions/agent-lab.ts` (gates, `preflight` action, widget lifecycle, wording) | controller | request-response + events | itself: `session_start` :162-168, `before_agent_start` :169-173, validate confirm :306-314, `lab.create` :434, `agent_lab_run` :542-580, `agent_lab_connection` :604-624, command :716-801 | exact |
| `extensions/cards.ts` (or the phase-4 tab file) — remove the demo hint text | component | — | itself :433, :459 | exact |
| `skills/agent-builder/SKILL.md` (start section, explicit-only section) | config/doc | — | itself (whole file, 124 lines) | exact |
| `test/connection-check.test.ts` (new) | test | — | `test/targets.test.ts:1-16` (inline targets, `context()`), `test/fixtures/stdio-agent.mjs` | exact |
| `test/progress.test.ts` (extend) | test | — | `[plan 04-08]` progress vectors; `test/cards.test.ts:13` fake theme | role-match |
| `test/start-path.test.ts` (new) | test | — | `test/skill.test.ts` + `test/extension.test.ts:20-43` (`registered()`) | role-match |
| `test/skill.test.ts` (rewrite the slice) | test | — | itself :6-21 | exact |
| `test/extension.test.ts` (harness + gate cases + prompt test) | test | — | itself :20-43, :45-67, :79-111 | exact |
| `test/theme.test.ts` (lint covers `○`) | test | — | `[plan 04-01]` lint test | exact (extend) |
| `test/cards.test.ts` (only if a case asserts the demo hint) | test | — | itself | exact |
| `.planning/phases/06-legkiy-start/down-check.mjs` (new) | script (free, real adapter) | batch | `.planning/phases/01-odno-chestnoe-chislo/verify-stored-runs.mjs:1-20` (`--dist`, `pathToFileURL` import) | exact |
| `.planning/phases/06-legkiy-start/live-start-check.sh` (new) | script (preflight, snapshot, cases) | batch | `[plan 04-09]` `pi-reopen-check.sh` safety frame; `snap-test.sh --keep` | role-match |
| `.planning/phases/06-legkiy-start/live-start-run.mjs` (new) | script (spawn Pi, watch JSON lines, kill rules) | streaming | `live-check.mjs watch` (:211-240); `src/cli.ts:54-56` launcher | role-match |
| `.planning/phases/06-legkiy-start/live-start-assert.mjs` (new) | script (assertions over JSON lines) | batch | none in repo | no analog |
| tmux widget capture inside `live-start-check.sh --case widget` | script (TUI capture) | batch | none in repo (`[plan 04-09]` uses `script`, not tmux) | no analog |

## Pattern Assignments

### `src/connection.ts` (service + pure text)

**Analog:** the same file, `doctor` (lines 82-120), and `src/targets.ts`.

**Imports** (line 1-9). Add `performance` only if not global; `randomUUID` is already imported:
```ts
import { randomUUID } from 'node:crypto';
import { checkSchema, emptyUsage, experimentSchema, fingerprint, settingsSchema, targetSchema, worldSchema, type Experiment, type Runtime, type Scenario, type Target } from './contracts.js';
import { preflightTarget } from './targets.js';
```
Add `openExternalTarget` to the `./targets.js` import.

**Static check first, then the real adapter path** (`doctor`, lines 84-90):
```ts
if (connection.target.kind === 'sandbox') throw new Error('Doctor проверяет внешнее подключение.');
await preflightTarget(connection.target);
const controller = new AbortController();
const combined = AbortSignal.any([signal, controller.signal]);
const timer = setTimeout(() => controller.abort(new Error('Connection probe exceeded 180 seconds')), 180000);
```
`checkConnection` follows the same order: `preflightTarget`, then `openExternalTarget` with a combined signal and a capped timeout, then `finally { session.close() }`.

**Session input shape** (`src/targets.ts:146-153`, `test/targets.test.ts:11-16`):
```ts
export interface ExternalTargetInput {
  target: Exclude<Target, { kind: 'sandbox' }>; sessionId: string; scenarioId: string;
  state: World; history: () => DialogueMessage[]; ctx: CallContext;
```
```ts
const ctx: CallContext = { signal, timeoutMs: 1000, beforeCall() {}, addUsage() {}, onTargetEvent: e => events.push(structuredClone(e)) };
const world = (): World => ({ records: { A101: { time: '09:00', owner: 'Sample' } }, writableFields: ['time'], transientFailures: 0 });
```
`World` requires `records`, `writableFields` and `transientFailures` (`src/contracts.ts:124-133`). The ping uses `{ records: {}, writableFields: [], transientFailures: 0 }`.

**Timeouts are per request from `target.timeoutMs`** (`src/targets.ts:184`, `:273`):
```ts
const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(target.timeoutMs)]);
const timer = setTimeout(() => { takePending()?.reject(new Error(`External agent request exceeded ${target.timeoutMs} ms`)); kill(); }, target.timeoutMs);
```
Cap the ping by copying the target with a smaller `timeoutMs`. Compute `targetKey = fingerprint(<original target>)` **before** the copy, because the copy has a different fingerprint.

**Error texts to classify** (`src/targets.ts:41-42`, `:63`, `:170`, `:193-196`, `:251`, `:273`, `:281`; reproduced in RESEARCH «What errors look like today»):
```ts
throw new Error(`${labels.missing}: ${command}. Укажите полный путь к исполняемому файлу или добавьте его папку в PATH.`);
if (code === 'ENOENT' || code === 'ENOTDIR') throw new Error(`Не найден файл агента: ${entry}. Исправьте путь в подключении.`);
throw new Error(`Ошибка измерения внешнего агента: ${measurementError}`);
```

**Remember a working connection** (lines 60-69). Atomic, 0600, keeps `probe`, sets `verifiedAt`:
```ts
export async function rememberConnection(directory: string, connection: Connection): Promise<void> {
  if (connection.target.kind === 'sandbox') return;
```
`checkConnection` itself never writes; only the extension calls `rememberConnection` after an `ok`.

**Russian error style** (CLAUDE.md): text says what is wrong and what to do; no error classes.

---

### `src/progress.ts` (pure view)

**Analog:** `[plan 04-08]` `progressView(record, now, { parallel })` → `{ …, text }`. The file is created in phase 4; phase 6 appends to it.

**Purity header** (`src/result-view.ts:5-11` style): pure, no I/O, no escaping; escaping happens in `renderRows`. `.js` import suffixes.

**Plural forms** (today `src/result-view.ts:27-31`; `[plan 02-04]` moves it to `src/plural.ts`):
```ts
import { exclusionCounts, pluralForm } from './result-view.js';   // src/quality.ts:5 today
return `${n} ${pluralForm(n, forms)}`;                            // src/quality.ts:372
```
Import `pluralForm` from wherever `grep -rn "export function pluralForm" src` finds it after phase 2.

**Exclusion count for the Логи value**: `exclusionCounts` is exported from `src/result-view.ts` today (`src/quality.ts:5`). Reuse it; do not recount `validationExclusions` by hand.

**No width code** (04-UI-SPEC lint, SCREEN-07): no `.slice(`, `.substring(`, `padStart(`, `padEnd(`, and no `.length` on display text in this file.

**Glyphs:** `src/*` compiles to `dist/` and cannot import `extensions/render/theme.ts`. `checklistRows(view, marks)` therefore takes the three marks as an argument. The extension passes `GLYPH` values, so `○` is written only in `GLYPH.todo` (UI-SPEC Width rule 6).

---

### `extensions/render/theme.ts`, `extensions/render/connection.ts`, `extensions/render/checklist.ts`

**Analog:** `[plan 04-01]` theme module contract (04-UI-SPEC «Theme Module», lines 218-236):
```
| `GLYPH`     | One const object with every glyph of the registries of phases 2–4. No literal glyph elsewhere in `extensions/render/**`. |
| `ROLE_TONE` | One map from row role … to `{ tone, bold }`. Rows without an explicit tone get it from here. |
| `renderRows(rows, theme, width)` | `safeText` → `wrapRows` → `paint`. … Never emits `…`. |
```
**Component shape** (`[plan 04-08]` `class ProgressBlock implements Component`; `[plan 04-01]` `VerdictBlock.render(width) = renderRows(…, theme, width)`). The checklist widget factory: `(tui, theme) => ({ render: width => renderRows(rows, theme, width - 4).map(l => '  ' + l), invalidate() {} })`. The 2-column frame follows UI-D-02.

**Pi factory overload** (installed typings `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:97-98`, cited by 06-UI-SPEC «Component Inventory»):
```
setWidget(key, content: string[] | undefined, options?)
setWidget(key, (tui: TUI, theme: Theme) => Component & { dispose?() }, options?)
```
A string array is cut to 10 lines (`interactive-mode.js:1697-1729`), so always use the factory.

**Dispatcher** (`[plan 04-01]` `renderAgentLabResult(result, options, theme, legacy)` plus `[plan 04-08]` `options.isPartial && details.kind === 'agent-lab/progress'`). Add `agent-lab/connection` and the partial `agent-lab/connection-progress` next to those branches. Unknown kinds still go to `legacy`.

**Session details carry no free text beyond Lab's own words** (`[plan 04-01]`, revised 2026-09-17: `details = { kind, version, runId, resultKey }`). The connection details hold only the check result (status, kind, Lab texts, record paths, `ms`, the capped stderr tail). They never hold the agent reply or dialogue text.

---

### `extensions/agent-lab.ts` (controller)

**Session hooks** (lines 162-173; grep `pi.on('session_start'` and `pi.on('before_agent_start'`):
```ts
pi.on('session_start', async (_event, ctx) => {
  if (process.env.AGENT_LAB_SESSION !== '1' || !ctx.hasUI || ctx.mode !== 'tui') return;
  ctx.ui.setTitle(`Agent Lab · ${ctx.cwd.split('/').at(-1)}`);
  ctx.ui.setHeader((_tui, theme) => new Text(theme.bold('Agent Lab') + '\nНасколько хорош ваш агент — на карточках пользователей, с причинами провалов.\n' + safeText(ctx.cwd), 1, 1));
  ctx.ui.setWidget('agent-lab-start', ['Напишите: «Проверь агента в этой папке». …', 'Можно точнее: … /agent-lab demo — учебный пример без модели.']);
});
pi.on('before_agent_start', async (event, ctx) => {
  if (process.env.AGENT_LAB_SESSION !== '1') return;
  ctx.ui?.setWidget?.('agent-lab-start', undefined);
  return { systemPrompt: event.systemPrompt + `\nYou are Agent Lab, …` };
});
```

**Where the gate goes in `agent_lab_build` validate** (lines 302-314; grep `'Собрать validation set?'`):
```ts
if (operation === 'validate') {
  parsedDialogues = selectValidationDialogues(parsedDialogues, Math.min(40, validationCount * 3));
  if (!parsedDialogues.length) throw new Error('В логах нет пригодных диалогов …');
  if (!ctx.hasUI || ctx.mode !== 'tui') throw new Error('Для сборки validation set нужен native Pi confirmation в интерактивном терминале.');
  …
  if (!await ctx.ui.confirm('Собрать validation set?', safeText([ … ]))) return { … status: 'cancelled' … };
}
```
The gate goes **after** the dialogue selection and **before** the non-TUI throw and the confirm. The target is resolved later today (line 359, grep `const connection = mode === 'demo' ? undefined`). Resolve it before the gate and reuse it below.

**Live mode** (line 434; grep `id = (await lab.create(input)).id;`): the gate runs right before it when `operation === 'live'` and the target is not the sandbox.

**Run** (lines 548-563; grep `План изменился` and `'Запустить проверку?'`):
```ts
if (draft.workflow !== 'evaluate' || draftHash(draft) !== params.expectedHash) throw new Error('План изменился. …');
if (!await ctx.ui.confirm('Запустить проверку?', runPlan(draft))) { … }
await lab.start(draft.id, { approved: true, reviewer: 'automated', expectedHash: params.expectedHash, parallel: runParallel(draft) });
```
The gate goes right after the hash check, before any dialog (including the `[plan 02-08]` expectations dialog). The widget is hidden right after `lab.start`. `runParallel` moves to `src/progress.ts` in `[plan 04-08]`.

**Board run** (lines 800-801; grep `'Запустить проверку?'` inside the command handler):
```ts
if (await ctx.ui.confirm('Запустить проверку?', runPlan(r))) {
  await lab.start(r.id, { … parallel: runParallel(r) }); section = 'results'; selected = 0;
```
On a failed check, call the local `inform(text, 'error')` (line 736) and `continue`.

**Connection tool** (lines 604-624; grep `name: 'agent_lab_connection'`):
```ts
parameters: Type.Object({ action: Type.Union([Type.Literal('inspect'), Type.Literal('check')]), file: Type.Optional(Type.String()) }, { additionalProperties: false }),
…
const connection = params.file ? await readConnection(resolve(ctx.cwd, params.file)) : await rememberedConnection(directory);
if (!connection) throw new Error('Сохранённого подключения нет. Укажите файл подключения.');
```
Add `preflight` to the union with optional `target`, `dialoguesFile` and `materialFiles`. Keep `inspect` and `check`.

**Reading logs with limits** (line 272; `src/imports.ts:23`):
```ts
dialogues = dialoguesFile ? await readData(resolve(ctx.cwd, dialoguesFile), 'dialogues', { maxItems: ['discover', 'validate'].includes(operation) ? 300 : 200 }) : rest.dialogues;
```
Then `z.array(dialogueSchema).max(300).parse(…)` (line 276), as the build does.

**Draft lookup without listing** (`src/store.ts:97` `async get(id)`; `:106` `list()` parses every record, so do not use it).

**Tool call row** (line 23): `renderCall: (_args, theme) => new Text(theme.fg('accent', 'Проверка агента'), 0, 0)`. `agent_lab_connection` gets its own `renderCall` with `Проверка связи с агентом` (C-637).

**Descriptions to reword** (grep anchors): `name: 'agent_lab_build'` description and the `withoutDialogues`, `goldenFile`, `goldenCases`, `profiles`, `notes`, `fromRunId`, `resumeRunId` and `hypothesis` parameters; `name: 'agent_lab_edit'` (`profileEdits`); `name: 'agent_lab_accept'`; `name: 'agent_lab_review'` (`use agent_lab_p…`); `name: 'agent_lab_prompt'`; `pi.registerCommand('agent-lab'` description; the `handoff = { request, context: { task:` text.

---

### `skills/agent-builder/SKILL.md`

**Analog:** itself. Side-branch places are listed in RESEARCH «START-04 Inventory». The rule that conflicts with START-03 is in «Start from the local project»:
```
- Static preflight may check paths, executability and required environment variable names. Do not send a probe request before explicit execution consent.
```
`[plan 04-03]` rewrites the «After the run, report in this order» part first. Start from the landed text.

---

### `test/connection-check.test.ts`

**Analog:** `test/targets.test.ts:1-16` (inline HTTP server helper `server()`, `context()`, `world()`), plus the fixture `test/fixtures/stdio-agent.mjs`:
```js
const mode = process.argv[2] ?? 'ok';
if (mode === 'crash') { console.error('agent crashed on purpose'); process.exit(3); }
…
if (mode === 'hang') return;
```
Use `crash` for `exited` and `hang` with a small `timeoutMs` for `timeout`. Use `process.execPath` as the command. Import from `../src/connection.js` (tests use `src`, as `test/targets.test.ts:8` does).

---

### `test/extension.test.ts` (harness and gate cases)

**Harness** (lines 20-43). It rejects any new event today:
```ts
on: (name: string, handler: () => Promise<void>) => {
  if (name === 'session_shutdown') shutdown = handler;
  else if (name === 'before_agent_start') beforeAgentStart = handler as typeof beforeAgentStart;
  else assert.equal(name, 'session_start');
},
```
Store every handler in a `Map<string, handler>` and return it (RESEARCH Pitfall 1).

**Prototype spies and stubbed dialogs** (lines 79-111):
```ts
const originalCreate = ExperimentLab.prototype.create;
ExperimentLab.prototype.create = async function(raw) { … };
confirm: async (title: string, body: string) => { confirmations.push({ title, body }); return true; },
```
Gate tests stub `create` / `start` to record calls, and assert that `confirmations` stays empty when the check fails.

**Prompt test** (lines 45-67): runs `beforeAgentStart({ systemPrompt: 'base' }, { cwd: '.', hasUI: false, mode: 'print' })` with `AGENT_LAB_SESSION=1`. Its discover and one-test assertions move to the explicit-only sentence (START-04).

---

### `test/start-path.test.ts`, `test/skill.test.ts`

**Analog:** `test/skill.test.ts:6-8`:
```ts
const skill = await readFile(fileURLToPath(new URL('../skills/agent-builder/SKILL.md', import.meta.url)), 'utf8');
const discovery = skill.slice(skill.indexOf('## Real dialogues at the start'), skill.indexOf('## Start from the local project'));
```
The slice moves to `## Only on explicit request` … end of file. The final assertion `/Пустой ответ не означает.*без (?:диалогов|них)/` runs on the whole skill and keeps passing after the move.

Only one zod `.describe()` exists in `src/contracts.ts` (line 272, script follow-ups). It has no side-branch word, so the description walk over `JSON.stringify(parameters)` needs no contracts edit.

**Jargon scan:** `[plan 03-03]` `test/helpers/copy-check.ts` `assertPlainCopy`. Extend its inputs with the 06-UI-SPEC forbidden list and allowlist.

---

### Scripts under `.planning/phases/06-legkiy-start/`

**Header and dist import** (`verify-stored-runs.mjs:1-20`):
```js
// Read-only counts over stored pilot runs through a built dist/. Prints ids and numbers only: …
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const { values } = parseArgs({ options: { dist: { type: 'string', default: resolve(repo, 'dist') }, … } });
const load = name => import(pathToFileURL(resolve(values.dist, name)).href);
```
`down-check.mjs` takes `--dist $SNAP/dist` from a kept snapshot (`snap-test.sh --keep … | sed -n 's/^SNAP=//p'`).

**Pi launcher** (`src/cli.ts:54-56`):
```ts
const child = spawn(process.execPath, [resolve(piRoot, 'dist/bundle/cli.js'), '--no-extensions', '--no-skills', '-e', resolve(root, 'extensions/agent-lab.ts'),
  '--skill', resolve(root, 'skills/agent-builder/SKILL.md'), …], { stdio: 'inherit', env: { ...process.env, AGENT_LAB_SESSION: '1' } });
```
`pi` is not on PATH, so use `$SNAP/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`. `snap-test.sh` symlinks `node_modules` into the snapshot.

**Safety frame** (`[plan 04-09]` `pi-reopen-check.sh`; `[plan 01-10]` «Build and swap»):
- refuse to start when `pgrep -fl 'dist/bundle/cli.js|pi-coding-agent|extensions/agent-lab.ts'` prints anything;
- refuse when `.agent-lab/.lock` exists;
- `mktemp -d` + `trap`;
- `timeout`;
- a final `pgrep` that must print nothing.

**Dist swap** (`[plan 01-10]` Task «Build and swap»; `[plan 04-09]` Task 3): `snap-test.sh --full --keep`; re-check pgrep and the lock; copy `$SNAP/dist` to `.gsd/dist-stage-<ts>`; move `dist` to `.gsd/dist-prev-<ts>` (kept); move the stage to `dist`; write `git rev-parse HEAD` to the evidence file.

**Spend guard:** `live-check.mjs budget` prices Lab records from a reference run's judge calls (`live-check.mjs:84-101`). The phase-6 live check spends only Pi model tokens and creates no Lab record, so that command cannot estimate it. The check is capped by a phase-06 ledger (one run per case) plus a running-cost kill inside `live-start-run.mjs`.

## Shared Patterns

- **Tests only through** `bash .planning/phases/01-odno-chestnoe-chislo/snap-test.sh <files>`. Never run `npm test` or `npm run build` in the worktree.
- **`safeText` on every displayed record value** (`extensions/cards.ts:11-14` today; `[plan 04-02]` moves it to `extensions/render/theme.ts`).
- **Native dialogs only in TUI:** `if (!ctx.hasUI || ctx.mode !== 'tui')` (repeated across `extensions/agent-lab.ts`).
- **Return, don't throw, for an expected stop:** the validate cancel path returns `{ status: 'cancelled', calls: 0, mutated: false }` (line 314). A failed check returns `connection_failed` the same way.
- **Bank data never printed:** scripts print ids, counts, kinds and costs only (`live-check.mjs:2-4`).

## No Analog Found

| File | Role | Reason |
|---|---|---|
| `live-start-assert.mjs` | assertions over Pi JSON event lines | No JSON-mode Pi run exists in the repo. Use `node_modules/@earendil-works/pi-coding-agent/docs/json.md` for the event names (`tool_execution_start`, `tool_execution_end`, `message_end`, `agent_end`). |
| tmux capture in `live-start-check.sh --case widget` | real TUI capture | No tmux script exists. tmux 3.5a is installed (RESEARCH «Environment Availability»). |

## Metadata

**Analog search scope:** `src/`, `extensions/`, `skills/`, `test/`, `.planning/phases/01-*/` scripts, phase 2–4 plans.
**Pattern extraction date:** 2026-09-17
