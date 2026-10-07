# База знаний в «Повторе разговоров»: разбивка по критериям — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** на странице повтора вместо одной карточки «База знаний» показать блок: общая цифра, сколько шагов обращались к базе знаний и сколько из них совпали с продом, пять критериев RAG по отдельности с переходом к шагам с ошибкой.

**Architecture:** бэкенд считает сводку `rag.summary(dialogues)` из сохранённых оценок шагов и отдаёт её полем `knowledgeBase` в `GET /api/replay` (при чтении, в `replay.json` не пишется). Фронтенд рисует блок `KnowledgeBase.tsx` и по ссылкам `{dialogueId, step}` находит шаги в уже загруженном результате, разворачивая их существующим `StepView`.

**Tech Stack:** Python 3.11, FastAPI, unittest; React + TypeScript + Tailwind.

**Спека:** `docs/superpowers/specs/2026-10-07-replay-knowledge-base-breakdown-design.md`.

---

## Карта файлов

- Modify `backend/lab/rag.py` — `summary(dialogues)` и приватные помощники подсчёта.
- Modify `backend/tests/test_rag.py` — тесты сводки.
- Modify `backend/lab/api.py` — `GET /api/replay` добавляет `knowledgeBase`.
- Modify `backend/tests/test_api.py` — тест поля.
- Modify `frontend/src/lab/types.ts` — `StepRef`, `KnowledgeBaseCriterion`, `KnowledgeBaseSummary`, поле в `ReplayResult`.
- Create `frontend/src/sections/replay/KnowledgeBase.tsx` — блок «База знаний».
- Modify `frontend/src/sections/replay/ReplayPage.tsx` — две карточки (тон, точность) и блок.
- Modify `docs/superpowers/specs/2026-10-07-replay-knowledge-base-breakdown-design.md` — строка про критерий, который ни к одному шагу не относился.

Все команды — из корня `conductor-playground`. Ветка `feat/voice360-replay-traces`.

Тесты бэкенда: `uv run --locked --directory backend python -m unittest discover -s tests` (2 известные ошибки окружения в
`tests/test_code_agent.py` — заглушка агента не запускается здесь; всё остальное должно проходить).

---

### Task 1: Сводка базы знаний на бэкенде

**Files:**
- Modify: `backend/lab/rag.py`
- Test: `backend/tests/test_rag.py`

- [ ] **Step 1: Тесты**

В конец `backend/tests/test_rag.py`:
```python
def verdict(rule_id: str, status: str) -> dict:
    return {'ruleId': rule_id, 'rule': '', 'status': status, 'reason': '', 'agentQuote': '', 'title': ''}


def step(index: int, trace: dict | None, verdicts: dict[str, str]) -> dict:
    """A replayed step as replay.py saves it: its trace and the main model's verdict on each criterion."""
    return {
        'index': index,
        'customer': f'реплика {index}',
        'trace': trace,
        'rules': [verdict(rule_id, status) for rule_id, status in verdicts.items()],
    }


ASKED = {'chains': [], 'rag': [{'source': 'idp', 'query': 'q', 'passages': [], 'answer': 'a'}], 'systems': []}
CACHED = {'chains': [], 'rag': [{'source': 'cache', 'query': 'q', 'passages': [], 'answer': 'a'}], 'systems': []}
NOT_ASKED = {'chains': [], 'rag': [], 'systems': []}
MATCH = 'replay:match'


def replayed(*steps: dict) -> list[dict]:
    return [{'dialogueId': 'd-1', 'status': 'PASS', 'steps': list(steps)}]


def criterion(summary: dict, rule_id: str) -> dict:
    return next(row for row in summary['criteria'] if row['id'] == rule_id)


class SummaryTests(unittest.TestCase):
    def test_a_step_answered_from_the_cache_used_the_knowledge_base(self) -> None:
        self.assertEqual(rag.summary(replayed(step(0, CACHED, {})))['called'], 1)

    def test_a_step_without_a_call_is_left_out(self) -> None:
        summary = rag.summary(replayed(step(0, NOT_ASKED, {}), step(1, None, {})))
        self.assertEqual((summary['steps'], summary['called']), (2, 0))

    def test_a_criterion_counts_pass_fail_and_unknown_apart(self) -> None:
        summary = rag.summary(
            replayed(
                step(0, ASKED, {'rag:relevant': 'PASS'}),
                step(1, ASKED, {'rag:relevant': 'FAIL'}),
                step(2, ASKED, {'rag:relevant': 'UNKNOWN'}),
                step(3, ASKED, {'rag:relevant': 'NOT_APPLICABLE'}),
            )
        )
        found = criterion(summary, 'rag:relevant')
        self.assertEqual((found['pass'], found['fail'], found['unknown']), (1, 1, 1))

    def test_failed_points_to_the_steps_that_failed_the_criterion(self) -> None:
        summary = rag.summary(
            replayed(step(0, ASKED, {'rag:query': 'PASS'}), step(1, ASKED, {'rag:query': 'FAIL'}))
        )
        self.assertEqual(criterion(summary, 'rag:query')['failed'], [{'dialogueId': 'd-1', 'step': 1}])

    def test_every_criterion_is_listed_in_order_with_its_name(self) -> None:
        summary = rag.summary([])
        self.assertEqual(
            [(row['id'], row['name']) for row in summary['criteria']],
            [(rule['id'], rule['name']) for rule in rag.CRITERIA],
        )

    def test_the_match_with_production_is_counted_on_steps_that_used_the_knowledge_base(self) -> None:
        summary = rag.summary(
            replayed(
                step(0, ASKED, {MATCH: 'PASS'}),
                step(1, ASKED, {MATCH: 'FAIL'}),
                step(2, ASKED, {MATCH: 'UNKNOWN'}),
                step(3, NOT_ASKED, {MATCH: 'FAIL'}),
            )
        )
        self.assertEqual(
            summary['match'],
            {'same': 1, 'different': 1, 'unknown': 1, 'differentSteps': [{'dialogueId': 'd-1', 'step': 1}]},
        )

    def test_an_empty_replay_has_nothing_counted(self) -> None:
        summary = rag.summary([])
        self.assertEqual(
            (summary['steps'], summary['called'], summary['match']['same'], criterion(summary, 'rag:query')['pass']),
            (0, 0, 0, 0),
        )
```

- [ ] **Step 2: Тесты падают**

Run: `uv run --locked --directory backend python -m unittest tests.test_rag -v`
Expected: FAIL — `AttributeError: module 'lab.rag' has no attribute 'summary'`.

- [ ] **Step 3: Реализация**

В `backend/lab/rag.py` после строки докстринга модуля и перед `CHAIN_OUTPUT` добавить импорт:
```python
from . import match
```
После функции `skipped` (в конце модуля) добавить:
```python
def summary(dialogues: list[dict]) -> dict:
    """What a replay says about the knowledge base (spec 2026-10-07-replay-knowledge-base-breakdown-design.md): how
    many steps used it, how many of them matched production, and each criterion's counts with the steps that failed
    it. Only the main model's verdicts count, as in replay.metric."""
    steps = [(dialogue['dialogueId'], step) for dialogue in dialogues for step in dialogue['steps']]
    used = [(dialogue_id, step) for dialogue_id, step in steps if called(step.get('trace'))]
    production = _tally(match.CRITERION['id'], used)
    return {
        'steps': len(steps),
        'called': len(used),
        'match': {
            'same': production['pass'],
            'different': production['fail'],
            'unknown': production['unknown'],
            'differentSteps': production['failed'],
        },
        'criteria': [{'id': rule['id'], 'name': rule['name'], **_tally(rule['id'], used)} for rule in CRITERIA],
    }


def _tally(rule_id: str, used: list[tuple[str, dict]]) -> dict:
    """One criterion over the steps that used the knowledge base: PASS, FAIL and UNKNOWN apart, and where it failed."""
    verdicts = [({'dialogueId': dialogue_id, 'step': step['index']}, _status(step, rule_id)) for dialogue_id, step in used]
    return {
        'pass': sum(status == 'PASS' for _, status in verdicts),
        'fail': sum(status == 'FAIL' for _, status in verdicts),
        'unknown': sum(status == 'UNKNOWN' for _, status in verdicts),
        'failed': [ref for ref, status in verdicts if status == 'FAIL'],
    }


def _status(step: dict, rule_id: str) -> str | None:
    return next((row['status'] for row in step.get('rules') or [] if row['ruleId'] == rule_id), None)
```
Проверить, что `lab/match.py` не импортирует `rag` (иначе цикл): `grep -n "import" backend/lab/match.py` — импортов нет.

- [ ] **Step 4: Тесты проходят**

Run: `uv run --locked --directory backend python -m unittest tests.test_rag -v`
Expected: `OK`.

Run: `uv run --locked --directory backend ruff check && uv run --locked --directory backend ruff format --check`
Expected: без замечаний (при необходимости `uv run --locked --directory backend ruff format lab/rag.py tests/test_rag.py`).

- [ ] **Step 5: Commit**

```bash
git add backend/lab/rag.py backend/tests/test_rag.py
git commit -F - <<'EOF'
rag.summary counts what a replay says about the knowledge base: the steps that used it, how many matched production, and each criterion's PASS, FAIL and «не удалось проверить» with the steps that failed it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 2: Сводка в ответе `GET /api/replay`

**Files:**
- Modify: `backend/lab/api.py` (импорт `rag`, функция `replay_result`)
- Test: `backend/tests/test_api.py`

- [ ] **Step 1: Тест**

В `backend/tests/test_api.py`, класс `ApiTests`, рядом с `test_no_replay_yet_is_an_empty_result`:
```python
    async def test_the_replay_comes_with_its_knowledge_base_summary(self) -> None:
        store.save(api.replay.RESULT, {'id': 'replay-1', 'dialogues': [{'dialogueId': 'd-1', 'steps': []}]})
        summary = (await self.client.get('/api/replay')).json()['knowledgeBase']
        self.assertEqual((summary['steps'], summary['called']), (0, 0))
```
(`store` и `api` уже импортированы в этом файле; проверить шапку.)

- [ ] **Step 2: Тест падает**

Run: `uv run --locked --directory backend python -m unittest tests.test_api -v`
Expected: FAIL — `KeyError: 'knowledgeBase'`.

- [ ] **Step 3: Реализация**

В `backend/lab/api.py` в блок `from . import (` добавить `rag,` по алфавиту (после `problems,`, перед `registry,`).
Функцию `replay_result` заменить:
```python
@app.get('/api/replay')
def replay_result() -> dict:
    """The latest replay and what it says about the knowledge base, counted on every read from the saved verdicts."""
    result = store.load(replay.RESULT)
    if not result:
        return {}
    return {**result, 'knowledgeBase': rag.summary(result.get('dialogues') or [])}
```

- [ ] **Step 4: Тесты проходят**

Run: `uv run --locked --directory backend python -m unittest tests.test_api tests.test_rag -v`
Expected: `OK` (включая `test_no_replay_yet_is_an_empty_result` — без повтора по-прежнему `{}`).

Run: полный набор и ruff, как в шапке плана.
Expected: только 2 известные ошибки `test_code_agent`; ruff чистый.

- [ ] **Step 5: Commit**

```bash
git add backend/lab/api.py backend/tests/test_api.py
git commit -F - <<'EOF'
GET /api/replay carries the knowledge-base summary of the latest replay, counted on read so a saved replay has it too

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 3: Блок «База знаний» в интерфейсе

**Files:**
- Modify: `frontend/src/lab/types.ts`
- Create: `frontend/src/sections/replay/KnowledgeBase.tsx`
- Modify: `frontend/src/sections/replay/ReplayPage.tsx`
- Modify: `docs/superpowers/specs/2026-10-07-replay-knowledge-base-breakdown-design.md`

- [ ] **Step 1: Типы**

В `frontend/src/lab/types.ts` перед `export type ReplayResult`:
```ts
/** A step of a replay by where it sits: the conversation and the step's index in it. */
export type StepRef = { dialogueId: string; step: number };
export type KnowledgeBaseCriterion = {
  id: string;
  name: string;
  pass: number;
  fail: number;
  unknown: number;
  failed: StepRef[];
};
/** What a replay says about the knowledge base (backend rag.summary), counted by the service on every read. */
export type KnowledgeBaseSummary = {
  steps: number;
  called: number;
  match: { same: number; different: number; unknown: number; differentSteps: StepRef[] };
  criteria: KnowledgeBaseCriterion[];
};
```
В `ReplayResult` после `dialogues: ReplayDialogue[];`:
```ts
  /** The knowledge-base summary; an older service does not send it. */
  knowledgeBase?: KnowledgeBaseSummary;
```

- [ ] **Step 2: Компонент**

`frontend/src/sections/replay/KnowledgeBase.tsx`:
```tsx
import { type ReactNode, useState } from "react";
import { count, pct } from "../../lab/format";
import { MATCH_ID } from "../../lab/replay";
import type { FamilyScore, KnowledgeBaseCriterion, KnowledgeBaseSummary, ReplayResult, StepRef } from "../../lab/types";
import { StepView } from "./StepView";

type Opened = { key: string; ruleId: string; refs: StepRef[] };

const TOGGLE = "rounded-sm text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg-3";

/**
 * «База знаний» of a replay (spec 2026-10-07-replay-knowledge-base-breakdown-design.md): the share of steps without
 * errors, how many steps used the knowledge base and matched production, and each of the five criteria with the steps
 * that failed it, one list open at a time.
 */
export function KnowledgeBase({ result }: { result: ReplayResult }) {
  const [opened, setOpened] = useState<Opened | null>(null);
  const summary = result.knowledgeBase;
  if (!summary) return null;
  const toggle = (key: string, ruleId: string, refs: StepRef[]) =>
    setOpened(opened?.key === key ? null : { key, ruleId, refs });
  return (
    <section className="space-y-3 rounded-control border border-line p-4">
      <Headline score={result.metric.rag} />
      {summary.called ? (
        <>
          <MatchLine
            summary={summary}
            open={opened?.key === "match"}
            onToggle={() => toggle("match", MATCH_ID, summary.match.differentSteps)}
          />
          <ul className="divide-y divide-line">
            {summary.criteria.map((criterion) => (
              <CriterionRow
                key={criterion.id}
                criterion={criterion}
                open={opened?.key === criterion.id}
                onToggle={() => toggle(criterion.id, criterion.id, criterion.failed)}
              />
            ))}
          </ul>
        </>
      ) : (
        <p className="text-body text-fg-3">На шагах этого повтора агент не обращался к базе знаний.</p>
      )}
      {opened && <StepList key={opened.key} result={result} ruleId={opened.ruleId} refs={opened.refs} />}
    </section>
  );
}

function Headline({ score }: { score: FamilyScore }) {
  const total = score.pass + score.fail;
  return (
    <h2 className="text-body font-semibold text-fg">
      {total
        ? `База знаний — ${pct(score.pass, total)}%, без найденных ошибок ${score.pass} из ${count(total, "шага", "шагов", "шагов")}`
        : "База знаний — не удалось проверить"}
    </h2>
  );
}

function MatchLine({
  summary,
  open,
  onToggle,
}: {
  summary: KnowledgeBaseSummary;
  open: boolean;
  onToggle: () => void;
}) {
  const { same, different } = summary.match;
  const used = `С обращением к базе знаний — ${count(summary.called, "шаг", "шага", "шагов")} из ${summary.steps}`;
  if (same + different === 0) return <p className="text-small text-fg-2">{used}. Совпадение с продом не проверялось.</p>;
  return (
    <p className="text-small text-fg-2">
      {used}, из них с продом совпали {same}
      {different > 0 && (
        <>
          {" · "}
          <Toggle open={open} onClick={onToggle}>
            {count(different, "отличается", "отличаются", "отличаются")}
          </Toggle>
        </>
      )}
    </p>
  );
}

function CriterionRow({
  criterion,
  open,
  onToggle,
}: {
  criterion: KnowledgeBaseCriterion;
  open: boolean;
  onToggle: () => void;
}) {
  const total = criterion.pass + criterion.fail;
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-small">
      <span className="min-w-[14rem] flex-1 text-fg">{criterion.name}</span>
      <span className="tabular-nums text-fg-2">{tally(criterion, total)}</span>
      {criterion.fail > 0 && (
        <Toggle open={open} onClick={onToggle}>
          {count(criterion.fail, "с ошибкой", "с ошибкой", "с ошибкой")}
        </Toggle>
      )}
      {total > 0 && criterion.unknown > 0 && (
        <span className="text-fg-3">· не удалось проверить: {criterion.unknown}</span>
      )}
    </li>
  );
}

/** «N из M (P%)»; with nothing measured, why: the model did not answer, or the criterion applied to no step. */
function tally(criterion: KnowledgeBaseCriterion, total: number): string {
  if (total) return `${criterion.pass} из ${total} (${pct(criterion.pass, total)}%)`;
  if (criterion.unknown) return `не удалось проверить: ${criterion.unknown}`;
  return "таких шагов не было";
}

function Toggle({ open, onClick, children }: { open: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-expanded={open} onClick={onClick} className={TOGGLE}>
      {open ? "▾" : "▸"} {children}
    </button>
  );
}

/** The steps behind a number: the customer's message, the model's reason and quote; a click opens the whole step. */
function StepList({ result, ruleId, refs }: { result: ReplayResult; ruleId: string; refs: StepRef[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <ul className="border-t border-line">
      {refs.map((ref) => {
        const step = result.dialogues
          .find((dialogue) => dialogue.dialogueId === ref.dialogueId)
          ?.steps.find((candidate) => candidate.index === ref.step);
        if (!step) return null;
        const key = `${ref.dialogueId}:${ref.step}`;
        const row = step.rules?.find((rule) => rule.ruleId === ruleId);
        return (
          <li key={key} className="border-b border-line">
            <button
              type="button"
              aria-expanded={expanded === key}
              onClick={() => setExpanded(expanded === key ? null : key)}
              className="w-full py-2 text-left text-small"
            >
              <span className="block text-fg">Клиент: {step.customer}</span>
              {row?.reason && <span className="block text-fg-2">{row.reason}</span>}
              {row?.agentQuote && <span className="block text-fg-3">«{row.agentQuote}»</span>}
            </button>
            {expanded === key && <StepView step={step} />}
          </li>
        );
      })}
    </ul>
  );
}
```

- [ ] **Step 3: Страница**

В `frontend/src/sections/replay/ReplayPage.tsx`:
- импорт: `import { KnowledgeBase } from "./KnowledgeBase";`;
- рядом с `MAX_COUNT` константа (тип `Family` добавить в импорт из `../../lab/types`):
  ```tsx
  /** Tone and prompts keep one number each; the knowledge base has its own block (KnowledgeBase). */
  const SCORED: Family[] = ["tone", "code"];
  ```
- в `Result` блок карточек заменить:
  ```tsx
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {SCORED.map((family) => (
          <Score key={family} name={FAMILY_NAME[family]} score={result.metric[family]} />
        ))}
      </div>
      <KnowledgeBase result={result} />
  ```
  Если `FAMILIES` больше нигде в файле не используется — убрать его из импорта.

- [ ] **Step 4: Спека — случай «таких шагов не было»**

В `docs/superpowers/specs/2026-10-07-replay-knowledge-base-breakdown-design.md`, таблица §3, после строки «Модель не
ответила…» добавить строку:
```
| Критерий не относился ни к одному шагу (например, «Нет ответа в базе знаний», когда база всегда что-то находила) | «таких шагов не было» без чисел |
```

- [ ] **Step 5: Проверки**

Run: `npm --prefix frontend run lint && npm --prefix frontend run format:check && npm --prefix frontend run build`
Expected: без ошибок (при замечаниях prettier — `npm --prefix frontend run format` и повторить).

Run: `uv run --locked --directory backend python ../bin/copy_check.py`
Expected: «Тексты без примет нейрослопа». Если примета найдена в новых текстах — переписать по `docs/WRITING.md`, не
меняя смысла.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lab/types.ts frontend/src/sections/replay/KnowledgeBase.tsx frontend/src/sections/replay/ReplayPage.tsx docs/superpowers/specs/2026-10-07-replay-knowledge-base-breakdown-design.md
git commit -F - <<'EOF'
«Повтор разговоров» shows the knowledge base as its own block: the five criteria as «N из M» with the steps that failed each, and how many steps used the knowledge base and matched production

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 4: Проверка в браузере на подложенном результате

Выполняет контроллер (у него есть встроенный браузер и запущенный Lab на 5899).

**Files:** нет (данные — в отдельном агенте Lab `kb-demo`, созданном для проверки).

- [ ] **Step 1: Перезапустить Lab**, чтобы подхватить новый бэкенд и собранный фронтенд (сервер `agent-lab` из
  `.claude/launch.json`: остановить и запустить снова).

- [ ] **Step 2: Создать агента и подложить повтор**

```bash
curl -s -X POST http://127.0.0.1:5899/api/agents -H 'Content-Type: application/json' -d '{"name":"kb-demo"}'
```
Затем (id агента — из ответа, ниже `kb-demo`):
```bash
cd backend && uv run --locked python - <<'EOF'
from lab import judge, registry, replay, store

def verdict(rule_id, status, reason='', quote=''):
    return {'ruleId': rule_id, 'rule': rule_id, 'status': status, 'reason': reason, 'agentQuote': quote, 'title': ''}

ASKED = {'traceId': 't', 'chains': [], 'systems': [],
         'rag': [{'seq': 1, 'source': 'idp', 'status': 'ok', 'query': 'как вернуть платёж',
                  'passages': [{'article': 'a1', 'passage': 1, 'text': 'Возврат — в разделе «Операции».',
                                'retrieval': 0.7, 'reranker': 0.9}], 'answer': 'Возврат — в разделе «Операции».'}]}
CACHED = {**ASKED, 'rag': [{**ASKED['rag'][0], 'source': 'cache'}]}

def step(index, trace, rules, prod='Возврат — в разделе «Операции».'):
    return {'index': index, 'customer': f'Как вернуть платёж? ({index})', 'prodReply': prod,
            'reply': {'text': 'Откройте раздел «Операции».', 'status': '200', 'options': [], 'seconds': 1.0},
            'trace': trace, 'rules': rules, 'status': judge.step_status(rules), 'error': None}

dialogues = [
    {'dialogueId': 'd-1', 'steps': [
        step(0, ASKED, [verdict('rag:query', 'PASS'), verdict('rag:relevant', 'FAIL', 'Фрагменты про другое.', 'раздел'),
                        verdict('rag:grounded', 'PASS'), verdict('rag:answers', 'PASS'),
                        verdict('rag:nothing-found', 'NOT_APPLICABLE'), verdict('replay:match', 'PASS')]),
        step(1, CACHED, [verdict('rag:query', 'PASS'), verdict('rag:relevant', 'PASS'), verdict('rag:grounded', 'UNKNOWN'),
                         verdict('rag:answers', 'FAIL', 'Ответ не на вопрос.', 'Откройте'),
                         verdict('rag:nothing-found', 'NOT_APPLICABLE'),
                         verdict('replay:match', 'FAIL', 'В проде другое действие.', 'Откройте раздел')]),
        step(2, {**ASKED, 'rag': []}, [verdict('rag:query', 'NOT_APPLICABLE'), verdict('replay:match', 'PASS')]),
    ]},
    {'dialogueId': 'd-2', 'steps': [
        step(0, ASKED, [verdict('rag:query', 'FAIL', 'Запрос потерял сумму.', 'как вернуть'), verdict('rag:relevant', 'PASS'),
                        verdict('rag:grounded', 'PASS'), verdict('rag:answers', 'PASS'),
                        verdict('rag:nothing-found', 'NOT_APPLICABLE'), verdict('replay:match', 'UNKNOWN')]),
    ]},
]
for dialogue in dialogues:
    dialogue['status'] = replay.dialogue_status(dialogue['steps'])
with registry.using('kb-demo'):
    store.save(replay.RESULT, {'id': 'demo', 'target': 'replay-service', 'version': 'код агента',
                               'startedAt': store.now(), 'finishedAt': store.now(), 'model': 'demo',
                               'metric': replay.metric(dialogues), 'dialogues': dialogues})
    store.save(replay.REPLAY_SUMMARY, {'id': 'demo', 'finishedAt': store.now()})
print('ok')
EOF
```

- [ ] **Step 3: Проверить страницу** `http://localhost:5899/a/kb-demo/replay`:
  - заголовок «База знаний — 0%, без найденных ошибок 0 из 3 шагов» (у каждого из трёх шагов с обращением к базе
    провален какой-то критерий RAG);
  - «С обращением к базе знаний — 3 шага из 4, из них с продом совпали 1 · ▸ 1 отличается»;
  - «Запрос в базу знаний 2 из 3 (67%) ▸ 1 с ошибкой», «Найдено нужное 2 из 3 (67%) ▸ 1 с ошибкой»,
    «Ответ опирается на найденное 2 из 2 (100%) · не удалось проверить: 1», «Ответ на вопрос 2 из 3 (67%) ▸ 1 с
    ошибкой», «Нет ответа в базе знаний — таких шагов не было»;
  - «▸ 1 с ошибкой» раскрывает строку с репликой, объяснением и цитатой; клик по ней разворачивает шаг целиком;
  - «▸ 1 отличается» раскрывает шаг с объяснением по совпадению;
  - карточки «Tone of voice» и «Точность» на месте.
  - Агент `agent-ekvayringa` (повтор без ответа модели): у критериев «не удалось проверить: K».

- [ ] **Step 4: Убрать демо-агента**, если пользователь не попросит оставить: удалить его через интерфейс «Агенты»
  или оставить и сказать пользователю, как удалить.
