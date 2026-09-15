---
phase: "02"
slug: "ponimanie-agenta-i-gipoteza"
status: verified
verdict: SECURED
threats_open: 0
asvs_level: 1
block_on: high
register_authored_at_plan_time: true
audited_commit: "70dcb630d3d0705f420badea4b1d578a292fc1e5"
created: "2026-09-15"
---

# Phase 02 — Security

> SECURED: все 15 угроз из plan-time STRIDE register закрыты реализацией или явно приняты как low-risk; открытых угроз уровня high и выше нет.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| Local JSON/JSONL → `readData` / Zod | Владелец передаёт обезличенные записи; импорт должен завершиться до запуска агента или модели | Недоверенные локальные байты |
| Dialogue → Scenario / Trial | Записанный ответ остаётся наблюдением, а не ожидаемой истиной | Реплики, outcome, порядок событий |
| Owner materials / dialogue → Pi evaluator | Текст может содержать prompt injection, но не меняет evaluator role, schema или tool policy | Требования и диалоговый текст |
| Pi output → domain records | Выход модели допускается только после schema и referential checks | Requirements, goals, judgments, citations |
| Score / reassess → runtime ports | Offline-анализ не должен открывать target или simulator | Сохранённые сценарии и трассы |
| Native Pi / CLI consent → model provider | Явное согласие и единый бюджет предшествуют платным вызовам | Обезличенные материалы и диалоги |
| Persisted evidence → reassessment | Новая оценка использует сохранённые факты и prompt source, а не изменившийся live prompt | Sources, trials, hashes, judge audit |
| Evidence → score brief | Гипотеза публикуется только при разрешимой цепочке requirement → assessment → event | Цитаты, IDs, unknowns |
| External text → CLI / Pi terminal | Управляющие последовательности и bidi не должны подменять секции и статусы | Имена, цитаты, rationale, пути |
| ExperimentLab → local store / artifacts | Записи и экспорты должны оставаться атомарными, локальными и owner-controlled | JSON, JSONL, Markdown, HTML |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation / Evidence | Status |
|-----------|----------|-----------|----------|-------------|-----------------------|--------|
| T-02-01 | Tampering | dialogue converters / trace journal | high | mitigate | `dialogueToScenario` и `dialogueToTrial` сохраняют точные пробелы и один диалог в одну попытку; пустые реплики отклоняются, а длинный диалог более 15 продолжений остаётся полной последовательностью evidence events без ложного runnable script (`src/contracts.ts:272-275,363-395,411-417`). Границы 8k × 60 сообщений, 200 диалогов и 2M символов проверены в `test/contracts.test.ts:219-232`; события пишутся по порядку (`src/experiment.ts:225-229`). | closed |
| T-02-02 | Elevation of Privilege | `ExperimentLab.score` | high | mitigate | `score()` строит записи напрямую и не входит в `runSuite`; code-only не разрешает Runtime (`src/experiment.ts:170-235`). Чтение task/dialogue/connection и `createInputSchema` validation завершаются в guarded pre-score block до `lab.score` (`src/cli.ts:169-183`). Throwing seams подтверждают ноль `openTarget`/`userTurn` (`test/experiment.test.ts:637-724`). | closed |
| T-02-03 | Denial of Service | import / schemas / duration | medium | mitigate | Файл ограничен 4 MB, JSONL парсится построчно, batch ограничен 200 (`src/imports.ts:6-12`); сообщение ограничено 8k символами, диалог — 60 сообщениями, все диалоги — 2M символами, IDs уникальны (`src/contracts.ts:10,272-275,395-417`); `maxCalls`, call timeout и operation deadline ограничены schema (`src/contracts.ts:48-63`). | closed |
| T-02-04 | Repudiation | persisted offline evidence | medium | mitigate | Исходные события попадают в append-only trace journal, reassess хранит `assessmentOf`, `assessmentTrialIds`, `evidenceHash` и `sourceEvidence` (`src/experiment.ts:372-380`, `src/store.ts:121-137`); record writes атомарны и имеют mode 0600 (`src/store.ts:85-104`). | closed |
| T-02-05 | Information Disclosure | imported local logs | low | accept | Риск ограничен owner-selected обезличенными файлами. Code-only не создаёт model Runtime; модельный режим передаёт данные выбранному провайдеру только после `--yes` или native Pi confirmation. Новых remote connectors и форматов хранения Phase 02 не добавляет. | closed — accepted |
| T-02-06 | Elevation of Privilege | Pi evaluator session | high | mitigate | `DATA_BOUNDARY` отделяет данные от инструкций (`src/prompts.ts:13-16`); explicit ResourceLoader отключает ambient extensions/skills/prompts/AGENTS (`src/pi.ts:54-69`), evaluator создаётся с `tools: []`, built-ins disabled, compaction/retry/telemetry off (`src/pi.ts:92-118`, `308-318`). Injection request-capture regression — `test/pi.test.ts:604-645`. | closed |
| T-02-07 | Tampering | goal provenance | high | mitigate | Score передаёт по одному диалогу, только owner sources/requirements и user turns; неизвестные requirement IDs и невербальный opening отклоняются (`src/pi.ts:522-568`, `src/experiment.ts:184-217`). Assistant/outcome variance отсутствует в payload (`test/pi.test.ts:604-626`). | closed |
| T-02-08 | Spoofing | unsupported action completion | high | mitigate | Judge скрывает missing final state и отделяет reply quality (`src/judge.ts:39-55`). Post-validation требует прохождение каждого объявленного `state_equals`; scenario-linked success tools — только `tool_called` и `tool_count` с `min > 0`, поэтому zero-count/optional/forbidden tools не превращают успешный tool result в goal evidence (`src/judge.ts:70-84`). Receipt обязан совпадать с текущими prompt и configuration-bound protocol (`src/judge.ts:88-118`). Adversarial coverage: `test/judge.test.ts:82-202`. | closed |
| T-02-09 | Tampering | imported failure clustering | medium | mitigate | Для assessment/source-evidence cluster prompt берётся только из сохранённого `record.sources`; modes пересобираются, ошибка становится limitation и не удаляет assessments (`src/experiment.ts:667-692`). Changed live prompt, rebuild и failure retention проверены в `test/experiment.test.ts:637-724`. | closed |
| T-02-10 | Denial of Service | model calls / deadlines | medium | mitigate | Каждый provider request вызывает общий `beforeCall`; `maxCalls`, operation timer, per-call timer и cancellation fail closed (`src/experiment.ts:505-553`, `src/pi.ts:107-123`, `163-219`). `carryUsage` сохраняет расход score при reassess (`src/experiment.ts:352-361`), поэтому один consent не удваивает бюджет. | closed |
| T-02-11 | Spoofing | CLI / Pi terminal copy | high | mitigate | CLI и Pi удаляют ANSI/terminal sequences, C0/C1 и bidi controls перед рендерингом. Для diagnostics `safeLine` дополнительно схлопывает embedded LF; task/dialogue parsing, connection loading и `createInputSchema` validation находятся до `lab.score` в одном guarded block и возвращают фиксированную repair/retry-инструкцию с «агент не запускался» (`src/cli.ts:24-27,147,169-183,267`; `test/workflow.test.ts:326-341`). | closed |
| T-02-12 | Tampering | score brief provenance | high | mitigate | `scoreBrief` сначала разрешает ровно одно scenario requirement, существующий owner source и verbatim span, затем принимает только matching agent rubric и cited non-user/non-simulator event. Допустимы reserved `goal_attainment`/`reply_quality`; `prompt_compliance` — только для связанного `source.kind === 'prompt'` (`src/quality.ts:62-85`). Knowledge-source не может выдать себя за prompt; prompt/non-prompt regressions — `test/quality.test.ts:159-176`. | closed |
| T-02-13 | Repudiation | judge spending confirmation | medium | mitigate | Pi model score запрещён headless, импортирует zero-call seed и вызывает native confirmation до model score/reassess; cancel возвращает seed (`extensions/agent-lab.ts:197-258`). Текст показывает единый `maxCalls`; usage сохраняется в record. Headless/cancel/code-only/bounds regressions — `test/extension.test.ts:422-531`. | closed |
| T-02-14 | Elevation of Privilege | outer skill conversation | medium | mitigate | Один и тот же pre-test gate зафиксирован в injected system text и `skills/agent-builder/SKILL.md`; до подтверждения запрещены build/run/save, неизвестные эффекты остаются `НЕЯСНО`, ответ не персистит hypothesis (`extensions/agent-lab.ts:137-146`). Contract tests: `test/skill.test.ts` и `test/extension.test.ts:35-52`. | closed |
| T-02-15 | Information Disclosure | previews / local artifacts | low | accept | Preview обрезан до 240 видимых символов, полный reference остаётся локальным; artifacts создаются в локальном каталоге с mode 0600 и `wx`, частичный export очищается (`src/quality.ts:59-60`, `src/artifacts.ts:58-81`). Сетевого dashboard/export не добавлено. | closed — accepted |

*Status: open · closed · open — below high threshold (non-blocking).*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-02-01 | T-02-05 | Владелец отвечает за деидентификацию и допустимость обработки production logs. `code-only` остаётся локальным; модельный режим раскрывает данные выбранному model provider после явного consent. | Plan 02-01 threat disposition | 2026-09-15 |
| AR-02-02 | T-02-15 | Локальные preview/export доступны владельцу рабочей машины; Phase 02 ограничивает preview, права файлов и не добавляет remote export. | Plan 02-03 threat disposition | 2026-09-15 |

---

## Verification Evidence

- Audited immutable implementation at commit `70dcb630d3d0705f420badea4b1d578a292fc1e5`; unrelated working-tree planning edits were excluded.
- `npm test`: 302/302 tests passed on 2026-09-15.
- `npm run typecheck`: build and strict extension typecheck passed on 2026-09-15.
- Security-critical adversarial coverage includes prompt injection, over-context rejection, malformed/oversized imports, unknown requirement/event citations, self-attested action success, failed/unrelated tool results, stale judge receipts, headless/cancel/code-only consent, combined model-call budget, and ANSI/control/bidi terminal payloads.

---

## Security Audit Trail

| Audit Date | Commit | Threats Total | Closed | Open | Verdict | Run By |
|------------|--------|---------------|--------|------|---------|--------|
| 2026-09-15 | `5f1a4b3` | 15 | 15 | 0 | SECURED | Codex security audit |
| 2026-09-15 | `5a4873e` | 15 | 15 | 0 | SECURED | Codex security delta audit |
| 2026-09-15 | `05b1cec` | 15 | 15 | 0 | SECURED | Codex security delta audit |
| 2026-09-15 | `02f35e2` | 15 | 15 | 0 | SECURED | Codex security delta audit |
| 2026-09-15 | `70dcb63` | 15 | 15 | 0 | SECURED | Codex security delta audit |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed at block threshold `high`
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-09-15
