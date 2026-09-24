# Карточка v2 — технический дизайн

> Технический дизайн ситуаций нового формата, реализованный в чанках K1–K5 (коммиты C0–C16 ниже); комментарии кода ссылаются на его разделы. Ссылки `файл:функция` описывают дерево на 23.09.2026 — часть названных файлов с тех пор удалена или разделена.

Статус: проект для реализации. Основание: концепция карточки, одобренная владельцем; ревью C1 (F1–F12); текущий код рабочего дерева на 23.09. Stage 2b параллельно удаляет legacy-путь, поэтому ссылки даны как `файл:функция`, а не как номера строк.

## 0. Принципы

1. **Структурой владеет harness.** Он присваивает id, номера, происхождение, цитаты, хеши, квитанции. Модель возвращает минимальное предложение, а её ссылки ограничены enum, собранными под конкретный вызов: индексы событий, id требований, id фактов, id действий. Проверки вида «неизвестный id» и «ровно одна запись на X» перестают существовать как класс.
2. **Карточку компилируют один раз — при принятии.** Хеш определения скомпилированной карточки попадает в квитанцию. Прогон, повтор и переоценка проверяют сохранённые хеши и никогда не пересобирают карточку текущим кодом и текущими промптами (F1).
3. **Каждое ожидание судится один раз**, существующим протоколом с двумя голосами (`judge.ts:assessRepeated`). `JUDGE_PROMPT` и `JUDGE_PROTOCOL` не меняются. Ожидание — обычная рубрика, данные карточки. Отдельный судья чекпоинтов и рубрика `library_required` исчезают.
4. **Никакого NLU на регэкспах.** Все детерминированные проверки — это сверка ссылок и точное вхождение типизированного значения в текст события (`includes` после NFKC), без токенизаторов и нечёткого поиска цитат.
5. **Только новые черновики.** Старые библиотеки, варианты и прогоны читаются как есть: миграции файлов нет.

Новый код: каталог `src/card/` с файлами `schema.ts`, `proposal.ts`, `compile.ts`, `checks.ts`, `review.ts`, `commands.ts`, `view.ts`, `legacy-v1.ts`, плюс листовой модуль `src/domain/ids.ts` (`idSchema`, `hashSchema`, `text`, `normalizeText`).

---

## 1. Схемы zod

```ts
// src/card/schema.ts
import { z } from 'zod';
import { idSchema as id, hashSchema as hash, text } from '../domain/ids.js';

/** Ссылка на реплику в неизменном импорте. Текст реплики читается из импорта, в карточку не копируется. */
export const eventRefSchema = z.strictObject({ batchId: id, dialogueId: id, eventIndex: z.number().int().nonnegative() });

export const disclosureSchema = z.enum(['initial', 'on_request', 'unknown']);
//  initial    — клиент пишет это в первой реплике (источник факта = событие «Пишет»)
//  on_request — знает, называет, только если агент спросит
//  unknown    — не знает; на вопрос отвечает «не знаю»

/** Кто ручается за факт. Модель может только указать индекс события; остальное проставляет harness. */
export const factSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('dialogue'), event: eventRefSchema }),
  z.strictObject({ kind: z.literal('owner'), receiptId: id }),
  z.strictObject({ kind: z.literal('unconfirmed') }),
]);

export const factSchema = z.strictObject({
  id,                                                     // 'f1'…, присваивает harness, в карточке не переиспользуется
  label: text(120),                                       // «Номер терминала» | «Платил картой»
  value: z.union([text(120), z.number().finite(), z.boolean()]).optional(), // «5678»; нет у качественных фактов
  disclosure: disclosureSchema,
  askedAs: text(200).optional(),                          // как узнать вопрос агента; по умолчанию label
  source: factSourceSchema,
});

export const turnSchema = z.strictObject({
  kind: z.enum(['change_intent', 'report']),              // новое желание | сообщает, что видит после шага агента
  after: text(300),                                       // какое действие агента его вызывает, простыми словами
  says: text(1000),                                       // слова клиента: дословно из события или от владельца
  source: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('dialogue'), event: eventRefSchema }),
    z.strictObject({ kind: z.literal('owner'), receiptId: id }),
  ]),
});

export const expectationSchema = z.strictObject({
  id,                                                     // 'e1'…'e3', harness
  text: text(300),                                        // инфинитивом: «объяснить, где найти номер терминала»
  requirementIds: z.array(id).min(1).max(3),              // цитата = requirement.quote, её рисует harness
  appliesWhen: text(300).optional(),                      // только для обязанностей, зависящих от пути агента
  observation: z.enum(['reply', 'tool', 'state']),        // tool/state — только если подключение это подтвердило
});

export const similarChangeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('disclosure'), factId: id, disclosure: disclosureSchema, writes: text(3000).optional() }),
  z.strictObject({ kind: z.literal('opening'), writes: text(3000) }),
  z.strictObject({ kind: z.literal('turn'), turn: turnSchema.omit({ source: true }).nullable() }), // null — убрать поворот
]);

export const cardOriginSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('dialogue'), batchId: id, dialogueId: id }),                   // «из диалога №17»
  z.strictObject({ kind: z.literal('owner'), receiptId: id }),                                     // «добавлена вами»
  z.strictObject({ kind: z.literal('similar'), parentId: id, change: similarChangeSchema }),       // «похожая на №3»
  z.strictObject({ kind: z.literal('rules'), requirementIds: z.array(id).min(1).max(10) }),         // «по вашим правилам» (логов нет)
]);

/** Учёт каждой более поздней реплики клиента в исходном диалоге. Для диалоговых карточек обязателен. */
export const coverageEntrySchema = z.strictObject({
  event: eventRefSchema,
  as: z.enum(['fact', 'turn', 'stop', 'ignored', 'changed']),  // changed — вытеснено изменением похожей карточки
  reason: text(300).optional(),                                  // обязательно для ignored и changed
});

export const cardSchema = z.strictObject({
  id,                                  // 'card_<digest>'
  number: z.number().int().positive(), // «№3»; присваивается один раз, повторно не используется
  title: text(160),
  topic: text(120),                    // простая метка; групп нет
  origin: cardOriginSchema,
  client: z.strictObject({
    wants: text(300),                  // Хочет
    writes: text(3000),                // Пишет — точная первая реплика
    writesSource: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('dialogue'), event: eventRefSchema }),
      z.strictObject({ kind: z.literal('owner'), receiptId: id }),
      z.strictObject({ kind: z.literal('model') }),               // только при origin.kind === 'rules'
    ]),
    knows: z.array(factSchema).max(8), // Знает
    leaves: text(300),                 // Уходит
    turn: turnSchema.optional(),
  }),
  agentMust: z.array(expectationSchema).min(1).max(3), // АГЕНТ ДОЛЖЕН
  coverage: z.array(coverageEntrySchema).max(60),
  revision: z.number().int().positive(),
});

/** Результат одного смыслового утверждения, адресуемый по содержимому. Ключ = digest(kind, subject, basisHash). */
export const claimReceiptSchema = z.strictObject({
  key: hash, kind: z.enum(['goal', 'fact', 'expectation', 'coverage', 'leak']), subject: z.string().max(20),
  basisHash: hash, status: z.enum(['ready', 'needs_owner', 'blocked']), reason: text(240),
  reviewer: z.strictObject({ protocol: z.literal('card-review-v1'), model: text(200) }),
});

/** Решение или правка владельца: точная команда, которую он подтвердил. Только дописывается. */
export const ownerReceiptSchema = z.strictObject({
  id, at: z.iso.datetime(), via: z.enum(['pi-confirm', 'board', 'cli-yes']),
  command: z.lazy(() => cardCommandSchema),     // §5
  basisHash: hash.optional(),                   // для ответов и урегулирований: основание вопроса
  ownerWords: text(1000).optional(),            // дословный текст владельца, если формулировка его
});

export const libraryV2Schema = z.strictObject({
  formatVersion: z.literal(2), id, revision: z.number().int().positive(), createdAt: z.iso.datetime(),
  imports: z.array(z.strictObject({ id, contentHash: hash })).max(30),     // ссылки; сами пакеты лежат в store/imports
  sources: librarySourcesSchema, requirements: libraryRequirementsSchema,   // формы v1 без изменений
  readingManifest: z.array(z.strictObject({ dialogueId: id, batchId: id.optional(), sourceIds: z.array(id), cardIds: z.array(id) })).max(300),
  cards: z.array(cardSchema).max(200),
  nextNumber: z.number().int().positive(),
  claims: z.array(claimReceiptSchema).max(5000),  // уровень библиотеки: похожие карточки переиспользуют квитанции с тем же ключом
  receipts: z.array(ownerReceiptSchema).max(2000),
  acceptance: z.strictObject({
    revision: z.number().int().positive(), libraryHash: hash, cardIds: z.array(id).min(1).max(200), snapshotHash: hash,
    definitions: z.array(z.strictObject({ cardId: id, definitionHash: hash })).min(1).max(200), // зафиксированы при принятии
  }).optional(),
});

// Разбор старых данных без миграции: v1 остаётся read-only веткой того же объединения.
export const scenarioLibrarySchema = z.discriminatedUnion('formatVersion', [libraryV1Schema, libraryV2Schema]);
```

Статус и вопрос **вычисляются**: их не хранят, их выводят из карточки, квитанций утверждений и квитанций владельца.

```ts
export const cardStatusSchema = z.enum(['checking', 'ready', 'needs_owner', 'unusable']);
// checking — переходное состояние отображения: проверка утверждений ещё не прошла. С ним владелец ничего не делает.

export const questionSchema = z.strictObject({
  id: hash,                                   // digest(checkKind, subject, basisHash): ответ устаревает, если основание изменилось
  text: text(300),                            // простой русский текст по шаблону harness (§2.6)
  choices: z.array(z.strictObject({
    id: z.enum(['a', 'b', 'c']), label: text(80),
    command: z.lazy(() => cardCommandSchema), // заранее собранная типизированная команда
    needsText: z.literal(true).optional(),    // владелец должен дать формулировку (нативный ввод)
  })).min(2).max(3),
  basisHash: hash,
});
```

**Правило для хранимых схем** (обязательно для проверки по хешу): у новых полей в хранимых схемах — только `.optional()`, никаких `.default()`. Разбор должен быть тождественным на сохранённых данных, то есть `fingerprint(parse(raw)) === fingerprint(raw)`. Это закрепляется golden-тестом на фикстурах (§8, C0/C3).

---

## 2. Предложение модели и связывание с доказательствами

### 2.1 Вход одного вызова (на один исходный диалог)

`{ task, dialogue: {events: [{index, role, content}]}, requirements: [{id, text, quote}] (сфокусированные на этом диалоге), articles (из reading manifest), topics: string[] (уже есть в библиотеке), target: {observations} }`. Из входа harness собирает контекст вызова:

```ts
type ProposalCall = {
  customerEvents: number[];     // индексы реплик клиента; [] в режиме rules
  laterEvents: number[];        // реплики клиента после той, что выбрана как «Пишет» (ключи coverage)
  requirementIds: [string, ...string[]];
  observations: ['reply', ...('tool' | 'state')[]];
};
```

### 2.2 Что возвращает модель

```ts
// src/card/proposal.ts
export function cardProposalSchema(call: ProposalCall) {
  const event = z.literal(call.customerEvents);          // zod 4: объединение числовых литералов → JSON Schema enum
  const requirement = z.enum(call.requirementIds);
  const observation = z.enum(call.observations);
  const coverageAnswer = z.strictObject({ as: z.enum(['fact', 'turn', 'stop', 'ignored']), reason: text(200).nullable() });
  return z.strictObject({
    title: text(160),
    topic: text(120),                                    // точная строка из topics, если тема та же
    wants: text(300),
    writesEvent: event,                                  // «Пишет» = дословное содержимое этой реплики
    knows: z.array(z.strictObject({
      label: text(120), value: z.union([text(120), z.number(), z.boolean()]).nullable(),
      disclosure: disclosureSchema, from: event.nullable(), askedAs: text(200).nullable(),
    })).max(8),
    leaves: text(300),
    turn: z.strictObject({ kind: turnSchema.shape.kind, after: text(300), from: z.literal(call.laterEvents) }).nullable(),
    agentMust: z.array(z.strictObject({
      text: text(300), requirementIds: z.array(requirement).min(1).max(3),
      appliesWhen: text(300).nullable(), observation,
    })).min(1).max(3),
    // По одному ключу на каждую более позднюю реплику клиента: точный охват обеспечивает схема, а не проверка после ответа.
    coverage: z.strictObject(Object.fromEntries(call.laterEvents.map(i => [String(i), coverageAnswer]))),
  });
}
```

Отсутствующие значения заданы через `nullable`, а не `optional`: так схема подходит для строгого native structured output (json_schema у OpenAI-совместимых провайдеров). Если провайдер строгий режим не поддерживает, остаётся запасной вариант — JSON-объект с локальной проверкой через zod. Режим rules (диалогов нет): вместо `writesEvent` — `writes: text(3000)`, `knows: max(0)`, нет `turn` и `coverage`.

В предложении нет id, цитат, объектов происхождения, хешей, `sourceCoverageBasis`, ревизий, качества.

### 2.3 Связывание: `bindProposal(p, call, library) → Card`

| Поле | Как harness его строит |
|---|---|
| `id`, `number` | `card_<digest(batchId, dialogueId, p)>`; `number = library.nextNumber++` |
| `origin` | `{kind:'dialogue', batchId, dialogueId}` |
| `client.writes` | `event(p.writesEvent).content` дословно; `writesSource = {dialogue, event}` |
| `knows[i].id` | `f1…fn` |
| `knows[i].source` | `from` задан → `{dialogue, event}`; иначе `{unconfirmed}` |
| `turn` | `says = event(turn.from).content` дословно; `source = {dialogue, event}` |
| `agentMust[i].id` | `e1…e3` |
| `coverage` | `laterEvents.map(i => ({event: ref(i), as, reason}))` |
| `readingManifest` | строка для этого диалога: `sourceIds` выбранных статей плюс `cardIds: [id]` |

Детерминированные проблемы связывания возвращаются как `review(value) → string` исполнителя структурированной задачи. Это ограниченный repair в той же сессии, с общим бюджетом на источник (`SOURCE_GENERATION_ATTEMPTS`).

### 2.4 Детерминированные проверки (`src/card/checks.ts`, чистые функции, без регэкспов)

| Проверка | Правило | Нарушение |
|---|---|---|
| `fact-from-event` | `value !== undefined && from` ⇒ `contains(event(from).content, value)` | repair; после связывания — unusable |
| `initial-in-opening` | `disclosure === 'initial'` ⇒ `from === writesEvent` (или `contains(writes, value)`, если источник — владелец) | repair / unusable |
| `hidden-not-in-opening` | `on_request \| unknown` с value ⇒ `!contains(writes, value)` | repair / unusable |
| `unknown-never-said` | значения фактов `unknown` отсутствуют в `writes`, `turn.says`, `leaves` | unusable |
| `coverage-refs` | `fact` ⇒ ∃ факт с `from === i`; `turn` ⇒ `turn.from === i`; не больше одного `stop`; у `ignored` есть reason | repair |
| `requirements-grounded` | у каждого id в `agentMust` цитата `requirement.quote` входит в источник (существующая проверка `invalid_requirement`) | unusable |
| `controller-compiles` | `createUserState(compile(card))` проходит и `requiredUserTurns ≤ settings.maxTurns` | unusable |
| `duplicate` | `fingerprint(compiledDefinition)` совпадает с другой карточкой | вопрос (§2.6) |

`contains(text, value) = normalizeText(text).includes(normalizeText(String(value)))`, где `normalizeText = NFKC + toLocaleLowerCase('ru') + схлопывание пробелов через split/join`.

### 2.5 Смысловые утверждения (`src/card/review.ts`)

Каждое утверждение — ровно один вопрос проверяющему, у каждого своё основание:

| kind | subject | basis (hash) |
|---|---|---|
| `goal` | — | `wants`, `writes`, хеш диалога |
| `fact` | `fN` | факт плюс содержимое его события плюс `writes` |
| `expectation` | `eN` | ожидание, его требования (текст и цитата), хеши статей из reading manifest и цитируемых источников, `wants`/`writes`/`knows` |
| `coverage` | — | `coverage`, `turn`, содержимое поздних событий |
| `leak` | — | `writes`, `leaves`, `turn.says`, тексты ожиданий, значения фактов `unknown` |

`key = digest({kind, subject, basisHash})`. Квитанции хранятся в `library.claims` и ищутся по ключу, поэтому похожая карточка с тем же фактом переиспользует квитанцию родителя. Проверяются только утверждения, у которых нет квитанции с текущим ключом. Правка одного факта инвалидирует ровно его утверждение `fact` и утверждения, чьё основание включает бриф (`expectation`, `leak`), остальные не трогает.

Схема ответа на вызов — объект с ключами-алиасами:

```ts
export function cardReviewSchema(aliases: string[]) {  // ['goal', 'fact_f1', 'expectation_e2', 'coverage', 'leak']
  const verdict = z.strictObject({ status: z.enum(['ready', 'needs_owner', 'blocked']), reason: text(240) });
  return z.strictObject({ claims: z.strictObject(Object.fromEntries(aliases.map(a => [a, verdict]))) });
}
```

Вход проверяющего: бриф без квитанций, полная хронология исходного диалога, требования и статьи из reading manifest (независимые от того, на что сослалась карточка — закрывает п. 3 архитектурного аудита), проверенные harness квитанции владельца для фактов владельца. Одна карточка — один вызов; при превышении 64 KB утверждения делятся на два вызова по kind. Реляционных O(n²) заданий нет: «похожесть» — это ссылка происхождения плюс точная проверка `duplicate`.

### 2.6 Статус и один вопрос: `cardStatus(card, library) → { status, question?, problems[] }`

1. Не прошла детерминированная проверка из класса unusable → `unusable` с перечнем проблем.
2. Нет квитанции утверждения для текущего ключа → `checking`.
3. Хоть одно утверждение `blocked` → `unusable`. Владелец такое не снимает; снимает правка, которая меняет основание.
4. Открытые вопросы в порядке приоритета: непроверенный факт → утверждение `needs_owner`, не урегулированное квитанцией владельца с тем же `basisHash` (goal → expectation → fact → coverage → leak) → `duplicate`. Показывается **первый** — `needs_owner`.
5. Иначе `ready`.

Каталог вопросов — шаблоны harness; модель не пишет ни вопрос, ни варианты:

| Причина | Вопрос | Варианты → команда |
|---|---|---|
| факт `unconfirmed` | «Клиент знает „{label}: {value}“?» | a «Да, скажет, если спросят» → `set_fact_disclosure(on_request)`; b «Нет, не знает» → `set_fact_disclosure(unknown)`; c «Убрать» → `remove_fact` |
| `expectation` needs_owner | «Агент должен „{text}“? Проверяющий сомневается: {reason}» | a «Да, это правило» → `settle_claim`; b «Убрать» → `remove_expectation` (если ожиданий больше одного); c «Сказать иначе» → `edit_expectation` (needsText) |
| `fact` needs_owner | «Клиент знал „{label}“ до разговора? {reason}» | a «Да» → `settle_claim`; b «Не знал» → `set_fact_disclosure(unknown)`; c «Убрать» → `remove_fact` |
| `goal` needs_owner | «Клиент хочет именно „{wants}“? {reason}» | a «Да» → `settle_claim`; b «Сказать иначе» → `edit_client(wants)` (needsText) |
| `coverage` needs_owner | «В диалоге клиент ещё писал: „{event}“. Это важно для проверки?» | a «Нет» → `settle_claim`; b «Да, это поворот» → `set_turn(event)` |
| `duplicate` | «Совпадает с №{n}. Оставить обе?» | a «Оставить» → `settle_claim`; b «Убрать эту» → `remove_card` |

---

## 3. Компилятор: бриф → политика контроллера

`src/card/compile.ts`. Цель — существующий `behaviorPolicySchema` (v1) и неизменный `user-controller.ts`: граф, лимиты, точный payload, обязательный поворот. Именно контроллер не даёт симулятору выдумывать.

```ts
const S = 'talk', T = 'turned', D = 'done';
const say = (f: Fact) => f.value === undefined ? f.label : `${f.label}: ${f.value}`;

export function compilePolicy(card: Card): { policy: BehaviorPolicy; facts: UserView['facts']; missing: string[] } {
  const known = card.client.knows.filter(f => f.disclosure !== 'unknown');
  const unknown = card.client.knows.filter(f => f.disclosure === 'unknown');
  const onRequest = known.filter(f => f.disclosure === 'on_request');
  const ask = (f: Fact) => f.askedAs ?? f.label;
  const actions: Action[] = [
    ...known.map(f => ({ id: `tell_${f.id}`, kind: 'answer' as const, factIds: [f.id], ifAsked: ask(f) })),     // payload нет: controller говорит statement
    ...(onRequest.length >= 2 ? [{ id: 'tell_all', kind: 'answer' as const, factIds: onRequest.map(f => f.id), ifAsked: 'агент просит сразу несколько данных' }] : []),
    ...unknown.map(f => ({ id: `dunno_${f.id}`, kind: 'missing' as const, factIds: [], ifAsked: ask(f), payload: `${f.label} — не знаю.` })),
    { id: 'dunno_other', kind: 'missing', factIds: [], ifAsked: 'вопрос, на который в карточке нет ответа', payload: 'Этого я не знаю.' },
    ...(card.client.turn ? [{ id: 'turn', kind: card.client.turn.kind === 'change_intent' ? 'change_intent' as const : 'observe' as const, factIds: [], payload: card.client.turn.says }] : []),
    { id: 'leave', kind: 'finish', factIds: [] },
  ];
  const talk = card.client.turn ? [S, T] : [S];
  const replies = actions.filter(a => a.kind === 'answer' || a.kind === 'missing');
  const transitions = [
    ...talk.flatMap(state => replies.map(a => ({ from: state, to: state, actionId: a.id, when: `агент спрашивает: ${a.ifAsked}` }))),
    ...(card.client.turn ? [{ from: S, to: T, actionId: 'turn', when: card.client.turn.after }] : []),
    ...talk.map(state => ({ from: state, to: D, actionId: 'leave', when: card.client.leaves })),
  ];
  return {
    policy: { version: 1, initialState: S, states: [...talk, D], terminalStates: [D], repetitionLimit: 2,
      maxFollowUps: Math.min(15, card.client.knows.length + (card.client.turn ? 1 : 0) + 2), actions, transitions },
    facts: known.map(f => ({ id: f.id, statement: say(f), ...(f.value !== undefined ? { value: f.value } : {}) })),
    missing: unknown.map(f => f.label),
  };
}
```

| Случай | Что компилируется | Поведение при исполнении |
|---|---|---|
| `initial` | факт в `userView.facts` плюс `tell_fN` | уже сказан в «Пишет»; если агент переспросит — повторит ровно `statement` |
| `on_request` | факт в `userView.facts` плюс `tell_fN`; при двух и больше — `tell_all` | называет только в ответ на вопрос; текст рендерит harness |
| `unknown` | нет в `facts`; `dunno_fN` с шаблонным payload; label в `missing` | «{label} — не знаю.» Значение нигде не появляется: его нет ни в одном payload |
| прочий вопрос | `dunno_other` (не больше 2 раз) | «Этого я не знаю.» Ответ выдумать нельзя |
| turn `change_intent` | действие `change_intent`, переход S→T | обязателен до ухода: `complete()` требует его, `leave` из S отфильтровывается конечным поиском контроллера |
| turn `report` | действие `observe`, переход S→T | необязателен: если агент решил задачу иначе, можно уйти из S |
| «Уходит» | `leave` (finish) из каждого talk-состояния в D | пустое сообщение, диалог заканчивается |

**Решение контроллера по enum вызова.** `userDecisionSchema` превращается в `z.strictObject({ actionId: z.enum(allowedIds) })`. `factIds` harness берёт из действия. Нынешнее «повторите factIds» и ремонт в цикле `evaluation.ts:evaluateTrial` (`attempt < 2`, ошибки `advanceUser`) исчезают, остаются только повторы исполнителя при сбое транспорта или синтаксиса. `USER_CONTROLLER_ROLE` переходит в `evaluatorVersion` (`pi.ts`), а не в определение карточки.

**Скомпилированный `Scenario`** (`compileCard`), выполняется **только при принятии**:

```ts
{ id: card.id, familyId: card.id, title: card.title, provenance: origin === 'dialogue' ? 'production' : origin === 'similar' ? 'synthetic' : 'curated',
  requirementIds: union(agentMust.requirementIds), tier: 'regression',
  user: { goal: wants, opening: writes, facts: facts.map(f => f.statement).join('\n') || 'Исходные факты не заданы.', knows: facts.map(f => f.statement),
          cannotKnow: missing, behavior: renderBehaviorSummary(card) /* только для показа */, maxFollowUps: policy.maxFollowUps },
  initialState: { records: {}, writableFields: [], transientFailures: 0 }, checks: [], goalObservation: 'reply',
  execution: { protocol: 'controlled-user-v1', evaluation: 'expectations-v1',
    userView: { goal: wants, opening: writes, facts, policy, missing },
    environmentView: { mode: target.managed ? 'managed' : 'prompt', ...contract },
    evaluatorView: { expectations: agentMust, requirements: cited } },
  metrics: agentMust.map(e => expectationRubric(e, card)) }   // §4.1; без successCriteria — чтобы одно ожидание не влияло на другое
```

`executionSchema` становится `z.union([executionV1Schema, executionV2Schema])`; strict-объекты взаимоисключающие, `evaluation` есть только у v2. `definitionHash = fingerprint(scenario)` записывается в `acceptedTests` и в `library.acceptance.definitions`.

---

## 4. Судейство и точность

### 4.1 Ожидание → рубрика (рендерится при компиляции и замораживается в определении)

```ts
export function expectationRubric(e: Expectation, card: Card): Rubric {
  const letter = 'АБВ'[Number(e.id.slice(1)) - 1];
  return { id: e.id, subject: 'agent', name: clip(e.text, 120),
    description: `Ожидание ${letter} карточки №${card.number}. Основание — требования ${e.requirementIds.join(', ')} (см. requirements).`,
    passCriteria: e.appliesWhen ? `Если ${e.appliesWhen}: выполнено — ${e.text}. Если этого в диалоге не было, ожидание не нарушено.` : `Выполнено: ${e.text}.`,
    failCriteria: e.appliesWhen ? `${e.appliesWhen}, но не выполнено: ${e.text}.` : `Не выполнено: ${e.text}.` };
}
```

### 4.2 Суд

- `evaluation.ts:assessTrial`: у v2-карточки `assessmentRubrics(scenario, trial)` = `scenario.metrics` (ожидания) плюс диагностические RAG-рубрики при событиях retrieval, как сейчас. Дальше без изменений вызывается `runtime.assess` → `assessRepeated`: **2 изолированных голоса на ожидание**, единогласие, при расхождении — `unknown`, один пересуд на искажённый голос, сайдкар аудита и квитанция.
- `judge.ts:judgeInput`: для v2 блок `execution` — это `{ evaluation: 'expectations-v1', expectation: <судимое>, requirements: <его требования> }`. Фильтр по метрике работает, потому что `assessRepeated` зовёт `judgeInput` с `metrics: [metric]`. **Для v1 вывод побайтно прежний** (golden-тест на `hasCompleteJudgment` старых аудитов), поэтому `JUDGE_PROMPT` и `JUDGE_PROTOCOL` не меняются.
- Стоимость: `2 × (1–3)` вызовов судьи на попытку. Сейчас у библиотечной карточки 1 вызов чекпоинтов плюс 2 голоса `library_required` = 3. План запуска уже пишет «по 2 вызова на рубрику».

### 4.3 Результат ожидания в попытке — канал проверяется при подсчёте, не внутри судьи

```ts
export function expectationResult(trial: Trial, e: Expectation, reviews: HumanReview[]): 'pass' | 'fail' | 'unknown' | undefined {
  const human = latestHumanReviews({ trials: [trial], humanReviews: reviews }).get(`${trial.id}|metric:${e.id}`);
  if (human && !(human.source === 'quick' && human.verdict === 'unknown')) return human.verdict === 'invalid' ? undefined : human.verdict;
  const a = trial.assessments?.find(x => x.metricId === e.id);
  if (!a || a.result === 'unknown') return a?.result;
  const cited = a.evidence.flatMap(seq => trial.events.filter(ev => ev.seq === seq));
  const channel = e.observation === 'reply' ? cited.some(ev => ev.type === 'assistant')
    : e.observation === 'tool' ? trial.observation?.tools === 'complete' && cited.some(ev => ev.type === 'tool_result')
    : stateObserved(trial) && cited.some(ev => ev.state !== undefined);
  return channel ? a.result : 'unknown';   // причина: 'no_evidence'
}
```

Сырой ответ судьи хранится без изменений, интерпретация отделена. Это обобщает нынешний особый случай `GOAL_UNSUPPORTED_RATIONALE` для `goal_attainment` в `parseJudgment`, но для v2 без сопоставления текста rationale.

### 4.4 Карточка и заголовок

```ts
export type HeadlineRule =
  | { kind: 'expectations'; ids: string[]; labels: Record<string, string> }  // v2 и v1-библиотека, переоценённая по v2
  | { kind: 'goal_rules'; ids: string[] }                                    // старые сгенерированные карточки
  | { kind: 'strict' };                                                       // v1-библиотека, судимая чекпоинтами; прочий legacy
export function headlineRule(scenario: Scenario, trials: Trial[]): HeadlineRule;
```

Типизированная модель заменяет нынешнюю неявную договорённость «`headlineMetricIds(...)` пуст → legacy».

- Карточка v2 **засчитана**, только если **каждое ожидание pass в каждой попытке**. Любой fail в любой попытке — fail, иначе unknown (не измерено). Гейты попыток и пригодности не меняются: `attemptsMatch`, `measurementUsable`.
- `comparison.ts:headlineCardOutcome` возвращает `{ outcome, parts: { id, label, outcome }[] }` вместо фиксированных `goal/rules`. Legacy goal/rules отображаются в parts «Цель» и «Правила промпта».
- `result-view.ts:buildResultView`: `headline.passed/decided/accuracy/range` — формула прежняя, «справился в X из Y», контрольные карточки не входят. `cards[].parts` показывает А/Б/В; `failures[]` перечисляет проваленные ожидания текстом.
- Причины «не измерено» (`trialReasons`) для ожиданий: прежние коды плюс `no_evidence` от канала. Для v2 причина берётся из типа, а не из префикса rationale.
- Правило подсчёта задаётся на карточку: `countingRuleOf(scenario)` возвращает `'all-expectations-v1' | 'goal-and-rules-v2' | 'library-v1'`. Быстрые отметки владельца штампуются правилом своей карточки (`markTargets` ставит их на проваленные или все пройденные ожидания).
- `simulator.ts:simulatorChecks` (эвристика на регэкспах) для v2 не запускается: весь текст клиента порождён harness, утечки исключены проверками из §2.4.

### 4.5 Старые прогоны

- **Открыть:** попытки с `trial.checkpoints` считаются замороженным правилом `library-v1`: `requiredCheckpointResult` и AND с `library_required`, то есть нынешний `automaticTrialResult`. Код переезжает в `src/card/legacy-v1.ts`, его не правят.
- **Переоценить и повторить:** судятся через проекцию — каждый required-чекпоинт v1 становится рубрикой-ожиданием (`text = rule`, `appliesWhen = applicability`, `observation = cp.observation`) по тому же рендереру. `library_required` отбрасывается. Если у чекпоинта есть точная `check`, она остаётся прямой проверкой в `trial.checks` и входит в AND. Сохранённый сценарий не меняется, поэтому хеш определения совпадает.
- **Последствие:** повтор старого прогона сравним со старым прогоном, **переоценённым** по v2 (агент не запускается, платятся только вызовы судьи), и несравним с сырым старым прогоном. Сравнение само скажет «протокол судьи отличается» — это честный ответ.

---

## 5. Команды владельца

`src/card/commands.ts` — общий для Pi, доски и CLI. Адаптеры только собирают ввод и показывают результат (п. 1 архитектурного аудита).

```ts
export const cardCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('set_fact_disclosure'), cardId: id, factId: id, disclosure: disclosureSchema }),
  z.strictObject({ kind: z.literal('edit_expectation'), cardId: id, expectationId: id, text: text(300).optional(),
    requirementIds: z.array(id).min(1).max(3).optional(), appliesWhen: text(300).nullable().optional() }),
  z.strictObject({ kind: z.literal('answer_question'), cardId: id, questionId: hash, choice: z.enum(['a', 'b', 'c']), text: text(1000).optional() }),
  z.strictObject({ kind: z.literal('add_similar'), parentId: id, change: similarChangeSchema, title: text(160).optional() }),
  z.strictObject({ kind: z.literal('remove_card'), cardId: id }),
  // родственные команды по тому же шаблону: set_fact, remove_fact, remove_expectation, edit_client{wants|writes|leaves}, set_turn, settle_claim (только из вариантов вопроса)
]);

export function prepareCommand(library: LibraryV2, command: CardCommand): Prepared;            // чистая функция
// Prepared = { previewHash, libraryHash, diff: FieldDiff[], scope: cardIds, authority: 'owner-confirm' | 'owner-words' | 'none', recheck: claimKey[] }
export function applyCommand(library: LibraryV2, prepared: Prepared, grant: HostGrant): LibraryV2; // CAS по libraryHash → StaleRevisionError
```

**Полномочия** — одна функция `requiredAuthority(command)`, одинаковая во всех адаптерах:
- утверждения о знаниях клиента (`set_fact*`, disclosure) и урегулирования (`settle_claim`) требуют `owner-confirm` — нативного подтверждения в Pi, клавиши на доске или `--yes` в CLI;
- формулировки (`edit_expectation.text`, `edit_client`) требуют `owner-words` — текст дословно из сообщения владельца или из нативного ввода.

`HostGrant` создаёт только хост; аргумент модели полномочием не является. Каждое применение дописывает квитанцию `OwnerReceipt { command, via, basisHash?, ownerWords? }`. Устаревание — типизированная `StaleRevisionError`, а не регэксп `/хеш устарел|библиотека изменилась/` по сообщению (`scenario-tool.ts`).

| Команда | Проверка | Что делает | Что перепроверяется |
|---|---|---|---|
| `set_fact_disclosure` | факт существует. `→initial`: значение уже есть в `writes`, иначе ошибка «сначала измените первую реплику». `initial→*`: значения не должно быть в `writes`, иначе нужна правка `writes` | меняет disclosure; `source = {owner, receiptId}`; для исходного события факта coverage становится `changed` | утверждения `fact:fN`, `leak`, `expectation:*` (основание — бриф); детерминированные проверки сразу |
| `edit_expectation` | id требований существуют; хотя бы одно поле задано | меняет текст, требования или appliesWhen | `expectation:eN` |
| `answer_question` | `questionId` совпадает с текущим вопросом карточки (иначе Stale); `needsText` ⇒ `text` из нативного ввода | выполняет `choice.command` с тем же полномочием; квитанция хранит `basisHash` вопроса | зависит от команды; у `settle_claim` — ничего: утверждение урегулировано своим ключом |
| `add_similar` | родитель существует; изменение согласовано (disclosure, из которого пропадает значение, требует `writes`; новый `writes` сохраняет значения фактов `initial`) | новая карточка: `origin: similar`, новые `id`/`number`, факты и ожидания скопированы с одним изменением; затронутая coverage → `changed` | только утверждения с новыми ключами; совпадающие с родителем переиспользуются из `library.claims` |
| `remove_card` | карточка есть в черновике | удаляется из черновика; импорт и прошлые прогоны не тронуты | ничего; `duplicate` пересчитывается детерминированно |

После применения неурегулированные утверждения запускаются автоматически в пределах бюджета или откладываются (`verify: 'later'`). Решение — существующий `scenario-draft.ts:recheckDecision`, где `pendingJobs` — число вызовов проверки.

**Поверхности Pi:** пять узких инструментов с маленькими схемами (`agent_lab_card_fact`, `agent_lab_card_expectation`, `agent_lab_card_answer`, `agent_lab_card_similar`, `agent_lab_card_remove`) плюс `show` и `accept`. Ссылки: номер карточки, id `fN`/`eN` из показанного брифа. Неизвестный id даёт типизированную ошибку со списком допустимых. Для v1-библиотек инструменты правки не регистрируются; через `getActiveTools/setActiveTools` активен только нужный набор.

---

## 6. Совместимость: чтение v1

**Разбор.** `scenarioLibrarySchema` — объединение по `formatVersion`; v1-схемы переезжают в `src/card/legacy-v1.ts` как read-only. `Experiment.librarySnapshot` — то же объединение. Файлы не переписываются.

**Проекция** `projectV1Variant(library: LibraryV1, variant) → CardView` — единая модель отображения для чата, доски и CLI:

| CardView | Источник в v1 |
|---|---|
| `number` | позиция в `orderedVariants` (только для показа) |
| `sourceLine` | production → «из диалога №k» (k — позиция `sourceDialogues[0]` в импорте); curated → «по вашим правилам»; synthetic → «похожая на №n(parentVariantId)» |
| `topic` | `businessScenarios[].title` |
| Хочет / Пишет | `userState.goal` / `userState.opening` |
| Знает | факты `initial`/`uncertain`: `label = statement` целиком, value скрыт, если уже входит в statement; disclosure = `initial`, если value (или statement) входит в opening, иначе `on_request`; `uncertain` → источник «не подтверждено». `userState.missing[]` → факты `unknown`. `learned_in_source` не показываются в «Знает», только в «d» |
| Источник факта | dialogue → «реплика №i»; owner → «вы подтвердили», если сохранился хеш правки в `history`, иначе «не подтверждено» |
| Уходит | `when` переходов finish, без повторов, через «; » |
| Поворот | первое действие `change_intent` или `observe`: `says = payload`, `after = when` |
| АГЕНТ ДОЛЖЕН | required-чекпоинты: `text = rule`, `appliesWhen = applicability`, цитата `cp.quote`; для совместимости их может быть больше трёх |
| Статус | сохранённое `quality`: ready → ready, needs_review → needs_owner, blocked → unusable |
| Вопрос | текст первого `ownerQuestions` через существующий `plainIssue`, **без вариантов** (read-only) |
| d | сохранённые `issues` через `plainIssue`, сводка coverage, граф поведения (`behaviorLines`) |

**Прогоны v1:** открыть — правило `library-v1`; переоценить и повторить — проекция (§4.5). **Проверка без пересборки** (F1) заменяет `scenario-preparation.ts:assertLibraryRun`:

```ts
export function verifyAcceptedRun(record: Experiment): void {
  const library = record.librarySnapshot; if (!library) return;
  const a = library.acceptance; if (!a) throw new Error('Набор не принят.');
  if (a.libraryHash !== libraryHash(library) || a.snapshotHash !== snapshotDigest(library, a)) throw new Error('Принятый набор повреждён.');
  const accepted = new Map((record.acceptedTests ?? []).map(t => [t.scenarioId, t.definitionHash]));
  const allowed = new Set(library.formatVersion === 2 ? a.cardIds : a.variantIds);
  for (const s of record.scenarios) if (!allowed.has(s.id) || accepted.get(s.id) !== fingerprint(s)) throw new Error('Карточка отличается от принятой.');
}
```

`librarySnapshot()` и `ScenarioFiles.retainLibrary` проверяют только целостность и больше не запускают `libraryQuality` на принятых снимках.

**Черновики v1 — решение за владельцем:**
- **A (рекомендую).** Read-only плюс действие «Продолжить в новом формате»: детерминированная проекция в новый v2-черновик. v1-файл остаётся нетронутым, утверждения v2 проверяются заново, вызовы платные. Правка и смысловая переоценка v1-черновиков прекращаются.
- **B.** Оставить правку и оценку v1. Тогда сохраняются `editLibrary`, `libraryQuality`, `scenario-work` и `SCENARIO_SEMANTIC_ROLE` — около 70 KB.

---

## 7. Что исчезает

Размеры измерены по текущему дереву; «≈» — оценка замены.

| Файл | Удаляется | Размер | Замена |
|---|---|---|---|
| `src/scenario-library.ts` (68 KB) | `libraryQuality` | 23.9 KB, 203 стр. | `card/checks.ts` ≈ 4 KB |
| | `editLibrary` | 12.2 KB, 137 стр. | `card/commands.ts` ≈ 8 KB |
| | `compileVariant`, `compileLibrary` | 4.5 KB | `card/compile.ts` ≈ 3 KB |
| | `policyIdentity`, `executionFingerprint`, `actionIdentity`, `factIdentity`, `referencedActionIdentity` | 4.1 KB | `fingerprint(definition)` |
| | `createLibrary`, `appendScenarioProposals`, `businessIdentity`, `unifyFamilies` | 4.9 KB | `createLibraryV2` ≈ 1 KB; групп нет |
| | `addGeneratedVariant`, `acceptLibrary` (v1) | 3.3 KB | `add_similar`, `acceptLibraryV2` |
| | `resolutionHash`, `resolutionBusinessHash`, `resolutionQuestionHash`, `ownerFactReceipt`, `ownerPersonaReceipt`, `ownerFactEvidence` | 3.6 KB | ключи утверждений и квитанции владельца |
| | `semanticPaths`, `semanticContentHash`, `recordSemanticAssessment`, `reachableSourceActions`, `containsExactValue`, `exactTokens` | 3.2 KB | утверждения; coverage по ключам |
| | **итого ≈ 60 KB**; остаются `importBatch`, `canonical/digest`, `libraryHash`, проверка целостности (≈ 6 KB) | | |
| `src/scenario-variants.ts` | весь файл, включая `proposeVariant` (10.5 KB) | 17.2 KB | `add_similar` ≈ 2 KB |
| `src/scenario-work.ts` | `planSemanticWork`, `assessScenarioLibrary`, `semanticWorkStatus`, `finalAssessmentCoversPlan`, `readingEvidence`, `checkerSourceIds`, `semanticWorkHash`, `responseBound` | ≈ 13.5 KB | `card/review.ts` ≈ 4 KB |
| `src/scenario-preparation.ts` | `runPreparation` (14.5 KB), `proposalsFromLibrary` + `requireSourceCoverage` (1.4 KB), `assertLibraryRun` + `compiledLibraryScenarios` (1.75 KB) | ≈ 17.6 KB | `prepareCards` ≈ 6 KB, `verifyAcceptedRun` ≈ 0.6 KB |
| `src/checkpoints.ts` | `checkpointResponseSchema`, `evaluateCheckpoints`, `checkpointReceipt`, `directChecks` | 5.8 KB | нет; путь чтения (≈ 3 KB) заморожен в `legacy-v1.ts` |
| `src/prompts.ts` | `SCENARIO_PROPOSALS_ROLE` 10.3, `SCENARIO_SEMANTIC_ROLE` 11.6, `CHECKPOINT_ROLE` + `LEGACY_CHECKPOINT_ROLE` 2.7 | 24.6 KB | `CARD_ROLE` ≈ 2.5 + `CARD_REVIEW_ROLE` ≈ 3.5 KB (структура ушла в схемы) |
| `src/scenario-contracts.ts` | `libraryPatchSchema` (11 видов) | 2.3 KB | `cardCommandSchema`; v1-схемы → legacy, read-only |
| `src/pi.ts` | выбор модели сравнением текста промпта для ролей чекпоинтов и смысловой проверки, `semanticRepair`, дубль совместимости OpenRouter, review-замыкание `scenarioProposals`, проверка количества в `assessScenarioProposals`, `assessCheckpoints` | ≈ 5 KB | `proposeCard` / `reviewCard` со схемами под вызов ≈ 1.5 KB |
| `src/evaluation.ts` | ветка чекпоинтов в `assessTrial`, `directChecks` в `grade`, условие на `observation` чекпоинтов, двухпопыточный ремонт контроллера | ≈ 2 KB | — |
| `src/outcomes.ts`, `src/comparison.ts` | `requiredCheckpointResult` в 5 функциях на пути записи; сопоставление rationale для v2 | ≈ 1.5 KB | `headlineRule`, `expectationResult` |
| `extensions/scenario-parameters.ts` | надмножество на 14 операций | 12.7 KB | ≈ 4 KB, узкие схемы |
| `extensions/scenario-tool.ts` | ветки variant (2.6), resolve/edit_group/merge/split/behavior/remove/edit (21.8) | 24.4 KB | тонкие адаптеры команд ≈ 6 KB |
| `extensions/conversation.ts` | `deriveVariantInput` 3.6, `variantFeed` 5.1, `plainIssue`/`ownerQuestions`/`sharedOwnerQuestions`/`disputedCheckpoints` 3.2, diff 3.7, `behaviorLines`/`factOriginText` 1.1, лексическое `authorize`/`ownerBasis`/`verbatimSpan`/`ungroundedValues` 2.9 | ≈ 19.6 KB | `briefFeed` + `questionRows` ≈ 5 KB; `plainIssue` и `behaviorLines` → compat |
| `extensions/scenarios.ts` | `scenarioRows`, `factOrigin`, `actionLabel` | 6.5 KB | строки брифа ≈ 2 KB |
| `extensions/agent-lab.ts` | действия правки библиотеки на доске (editScenario, variant, merge/split, remove) | ≈ 14.5 KB | диспетчер команд ≈ 3 KB |
| тесты | `scenario-variants.test` 23.5 KB; большая часть `scenario-library.test` (46.7), `scenario-work.test` (30.4), пути записи `checkpoints.test`, v1-потоки правки в `conversation.test` | ≈ 110 KB | тесты `card/*` ≈ 40 KB |

**Итог по production-коду:** ≈ −225 KB удаляется, ≈ +55 KB добавляется. Промпты сокращаются примерно с 25 до 6 KB. Исчезают регэкспы NLU: оба токенизатора значений, поиск утечек по подстроке, `factLabel` через `indexOf(':')`, `mentions`/`fold`, распознавание устаревания по тексту ошибки.

---

## 8. Порядок внедрения

Каждый коммит маленький и оставляет полный набор тестов зелёным. Тесты гоняются в снимке дерева, `dist` рабочего дерева не пересобирается.

| # | Коммит | Тест-план |
|---|---|---|
| C0 | **Заморозить фикстуры v1.** Текущим кодом и детерминированным runtime собрать синтетическую принятую v1-библиотеку, завершённый прогон с `checkpoints` + `library_required` и сайдкаром судьи → `test/fixtures/library-v1/`. Реальных данных нет. | Golden: `parse` тождественен (fingerprint), снимок ResultView (заголовок, строки, причины), `hasCompleteJudgment === true`. Эти тесты должны проходить после каждого следующего коммита. |
| C1 | **F1.** `verifyAcceptedRun` вместо `assertLibraryRun` в `acceptDraft/repeat/saveSuite/loadSuite/reassess/updateDraft/registerCandidate`; `librarySnapshot` и `retainLibrary` проверяют только целостность. | Фикстура повторяется и переоценивается; порча `title` в снимке ловится по хешу; после C13 (удаление компилятора v1) фикстура по-прежнему проходит — это доказывает отсутствие пересборки. |
| C2 | `domain/ids.ts` (`idSchema`, `hashSchema`, `text`, `normalizeText`), один `writeJsonAtomic`. Поведение не меняется. | Существующий набор; тест, что проверки id и хеша дают прежние ошибки. |
| C3 | `card/schema.ts`; объединения библиотеки и снимка; правило хранимых схем. | Тождественный разбор v1-фикстур; round-trip v2; strict отклоняет лишние поля; `z.toJSONSchema` схем предложения проходит strict-режим. |
| C4 | `compilePolicy`/`compileCard`; решение контроллера `actionId`-enum; `USER_CONTROLLER_ROLE` в `evaluatorVersion`. | Таблица случаев initial/on_request/unknown/turn×2/stop/fallback; каждая политика проходит `createUserState`; «прогулки» с фиктивным агентом: вопрос X → `tell_X`, до поворота `change_intent` уйти нельзя, значения `unknown` нет ни в одном payload; повтор фикстуры v1 идёт по сохранённому `userView`. |
| C5 | Суд и подсчёт v2: `expectationRubric`, v2-ветка `judgeInput`, `expectationResult`, `headlineRule`, `parts` в ResultView/доске/CLI, `no_evidence`. | Матрица AND (pass/fail/unknown × 1–3 ожидания × повторы); расхождение голосов → unknown; ручной вердикт перекрывает; гейт канала; golden: `inputHash` v1-аудита не изменился, заголовок v1 и legacy не изменился. |
| C6 | Проекция v1 для (пере)суда; `assessTrial` больше не вызывает `assessCheckpoints`. | Переоценка фикстуры → 2 голоса на каждый required-чекпоинт, чекпоинтов нет; старый прогон показывается как раньше; сравнение «сырой v1 vs повтор» → «протокол судьи отличается», «переоценённый vs повтор» сравнимы. |
| C7 | `cardProposalSchema`, `bindProposal`, детерминированные проверки, `CARD_ROLE`, `runtime.proposeCard`. | Схема отвергает чужой индекс или id требования; coverage требует ровно поздние события; `bindProposal` копирует opening и turn дословно, выдаёт id и источники; таблица проверок; `pi.test` со сценарным провайдером: проблема связывания → repair → принято. |
| C8 | Утверждения: `cardReviewSchema`, `CARD_REVIEW_ROLE`, `planClaims`, `cardStatus`, каталог вопросов. | Правка факта инвалидирует только его утверждения; `blocked` → unusable; не больше одного вопроса и 2–3 варианта; урегулирование по ключу; изменённое основание открывает вопрос заново; похожая карточка переиспользует квитанции. |
| C9 | `prepareCards` (выбор → grounding → предложение → связывание → проверка), resume по единицам работы, `createLibraryV2`, `acceptLibraryV2` (компиляция один раз, `definitions`). | E2E на детерминированном runtime: импорт → карточки → проверка → принятие → прогон → ResultView; resume отказывается повторять оборванный платный вызов; бюджет на источник; режим rules. |
| C10 | `commands.ts`: пять команд плюс родственные, `requiredAuthority`, квитанции, `StaleRevisionError`. | На каждую команду: предпросмотр diff/scope/recheck, применение, квитанция, CAS; модельный аргумент `approved` не даёт полномочий. |
| C11 | Инструменты Pi, клавиши доски, CLI поверх команд; v1-библиотеки read-only. | Тесты схем инструментов (маленькие, без `Type.Any`); тесты разговора «слова владельца → инструмент → состояние» на v2; отдельный живой eval выбора инструмента (вне юнит-набора). |
| C12 | `view.ts`: `briefFeed` (три части, статус, вопрос, «d») плюс `projectV1Variant`. | Снимки строк v2 для каждого статуса и проекции вариантов из фикстуры; у v1-черновика видно «старый формат» и действие продолжения. |
| C13 | **Удаление** v1-авторинга, правки, смысловой оценки и записи чекпоинтов, промптов, поверхностей и тестов (§7). Если выбран A — плюс `convertV1Draft`. | Полный набор плюс goldens C0; поиск по удалённым символам пуст; размер `src` + `extensions` уменьшился на ожидаемые ≈ 170 KB нетто. |


## 9. Решения (приняты координатором 23.09)

1. Черновики v1 — read-only с действием «продолжить в новом формате» (вариант A). `convertV1Draft` входит в C13.
2. Повтор старых прогонов судится проекцией и сравним с переоценённым старым прогоном — принято.
3. До 6 вызовов судьи на попытку ради отдельного вердикта по каждому ожиданию — принято. **Потолок стоимости показывается в диалоге запуска** (C5/C11: `planLines` пишет «судья: до 2 × {ожиданий} вызовов на попытку, всего до N»).
4. Ожидания tool/state — только при подтверждённом контракте подключения, по умолчанию reply — принято.
5. Четвёртая строка источника «по вашим правилам» — принято.
6. Поворот один; прочие значимые поздние реплики — через утверждение `coverage` — принято.

---

## 10. Сверка синтетики с продом (sim-to-real)

**Зачем.** Тезис владельца: синтетические клиенты в ситуациях из реальных логов дают оценку точности, близкую к проду. Сверка проверяет это на тех же ситуациях. Каждое ожидание «Агент должен» у карточки из лога судится дважды:
- **(a)** на синтетическом прогоне, как сейчас;
- **(b)** на исходном записанном разговоре — реальный клиент и реальные ответы агента из импорта, без запуска агента и симулятора.

Совпадение показывается строкой доверия, расхождения — списком доказательств. Заголовок точности сверка **никогда** не меняет, как и нынешние отметки согласия с судьёй.

### 10.1 Какие карточки и ожидания сверяются

**Карточка сверяется**, только если её ситуация — это ситуация лога (детерминированно, `calibratable(card)`):
- `origin.kind === 'dialogue'`;
- `client.writesSource.kind === 'dialogue'`;
- у поворота, если он есть, `source.kind === 'dialogue'`;
- у каждого факта в `knows` `source.kind === 'dialogue'`;
- в `coverage` нет `changed`.

Правка ожиданий сверку не отменяет: критерии одинаковы с обеих сторон. Правка ситуации отменяет — «похожие», «добавленные вами», «по вашим правилам» и карточки с фактами от владельца исключаются с причиной `not_from_log` или `situation_edited`. Проекции v1 сверяются по тем же правилам: `provenance === 'production'`, нет `parentVariantId`, в `history` нет правок владельца по `userState`.

**Ожидание судимо на логе:**

| Условие | Результат (b) | Вызовы судьи |
|---|---|---|
| После реплики «Пишет» в логе нет ни одного ответа агента | «не измерено» — `no_agent_reply` | 0 |
| `observation: 'tool'` или `'state'`, а у диалога импорта нет `observation === 'complete'` или событий этого канала | «не измерено» — `channel_unobserved` | 0 |
| Лог закончился раньше, чем ожидание наступило (клиент ушёл, разговор оборвался или перешёл к оператору) | «не измерено» — `not_exercised_in_log` | 2 |
| Иначе | pass / fail / unknown по двум голосам | 2 (+ ≤ 1 переспрос на битый голос) |

**Почему «не наступило» — это «не измерено», а не fail.** Для (b) рубрика рендерится в **лог-варианте** `logRubric(e)`:
- pass: «Ожидание наступило, и выполнено: {text}»;
- fail: «Ожидание наступило, но не выполнено: {text}»;
- для `appliesWhen` «наступило» — это «{appliesWhen} возникло»; у синтетического варианта здесь стоит пункт «если не возникло — не нарушено», в лог-варианте его нет.

В scope входа (b) сказано, что «наступило» — это момент, когда агент уже должен был выполнить ожидание. Если разговор до него не дошёл, оба условия получают `not_met`. Такая пара и в текущем протоколе агрегируется в `unknown`. Её сохраняет квитанция (b) (§10.3), и по ней причина определяется как `not_exercised_in_log`, а не «судья не уверен».

### 10.2 Версия агента в логах

Сверка — **калибровка** только когда логи записаны той же версией агента, что проверяется. Иначе расхождение смешивает смену агента с дрейфом симулятора.

- **Версию логов объявляет владелец** на весь импорт командой `declare_log_version { importId, version: string | null }` (null — «неизвестно»), полномочие `owner-confirm`. Объявление хранится в журнале деклараций импорта `store/imports/<importId>.declarations.json`, только дописывается, как квитанция владельца. **В контент библиотеки оно не входит**, поэтому объявление после принятия не ломает `libraryHash` и принятие. Экспорт со смешанными версиями надо делить на отдельные импорты. Без объявления версия считается «неизвестной».
- **Версия под тестом:** `observation.version`, если адаптер сообщил одну и ту же версию во всех попытках (смена внутри диалога уже запрещена в `evaluateTrial`). Иначе `record.targetVersion`, объявленная владельцем. Иначе неизвестна.
- **Режим:** `calibration`, если обе версии известны и совпадают (точное равенство после `trim`). Иначе `comparison` с причиной: «версия логов не указана», «в логах {X}, проверяли {Y}» или «версия проверяемого агента неизвестна».
- Прогон хранит **снимок** использованной декларации (`calibration.logVersions`), поэтому показ результата не зависит от последующих объявлений.

### 10.3 Вход судьи и квитанции: (a) и (b) не пересекаются

| | (a) синтетика | (b) лог |
|---|---|---|
| Сборщик входа | `judge.ts:judgeInput` (§4.2), без изменений | новый замороженный `logJudgeInputV1` |
| Рубрика | из принятого определения (`scenario.metrics`) | `logRubric(e)` из `evaluatorView.expectations` того же определения |
| Разговор | `trial.events` синтетики: user/assistant/simulator/tool, `observation`, `initialState`/`finalState` | события диалога импорта: `seq = eventIndex`, user/assistant по роли; tool/retrieval/state — только при `observation === 'complete'`; ни событий симулятора, ни состояния стенда |
| Бриф клиента | `scenario.user` | **не передаётся**: лог сам и есть ситуация, толкование карточки не подсказывается судье |
| Scope | реактивный синтетический | «Записанный разговор реального клиента с агентом прода… Если разговор не дошёл до момента ожидания — оба условия not_met» |
| Требования и источники | `observableSources(...)` | те же |
| Промпт судьи | `JUDGE_PROMPT` | тот же `JUDGE_PROMPT`; различие только во входе |
| `protocolHash` | `fingerprint({protocol: JUDGE_PROTOCOL, configuration})` | `fingerprint({protocol: JUDGE_PROTOCOL, mode: 'logged-v1', configuration})` |
| Квитанция | `trial.judgeReceipt` плюс сайдкар `{runId}.judge/{trialId}.json` | `calibration.entries[]` плюс сайдкар `{runId}.calibration/{key}.json` |

```ts
// src/card/calibration.ts
export const logJudgmentReceiptSchema = z.strictObject({
  mode: z.literal('logged-v1'),
  key: hash,                         // digest({ definitionHash, expectationId, importContentHash, dialogueId, protocolHash })
  cardId: id, expectationId: id, definitionHash: hash,
  importId: id, importContentHash: hash, dialogueId: id,
  protocolHash: hash, inputHash: hash, auditHash: hash.optional(),
  provider: text(120), model: text(200),
  skipped: z.enum(['no_agent_reply', 'channel_unobserved']).optional(),    // вызовов не было
  votes: z.array(z.strictObject({
    pass: z.enum(['met', 'not_met', 'unclear']).optional(), fail: z.enum(['met', 'not_met', 'unclear']).optional(),
    result: z.enum(['pass', 'fail', 'unknown']).optional(), error: z.literal(true).optional(),
  })).max(4),
  result: z.enum(['pass', 'fail', 'unknown']),   // единогласие двух голосов, иначе unknown
  complete: z.boolean(),
});
export const calibrationSchema = z.strictObject({
  protocol: z.literal('sim-to-real-v1'),
  logVersions: z.array(z.strictObject({ importId: id, contentHash: hash, version: text(200).nullable(), receiptId: id })).max(30),
  testedVersion: text(200).nullable(),
  entries: z.array(logJudgmentReceiptSchema).max(600),
});
// Experiment: calibration?: Calibration — только дописывается, опционально
```

**Почему их нельзя перепутать:**
- у квитанций разные схемы (`mode: 'logged-v1'`) и разные места хранения;
- вход (b) несёт `mode` и `importContentHash`, поэтому его `inputHash` не может совпасть с синтетическим;
- у (b) свой `protocolHash`;
- `hasCompleteJudgment` видит только аудиты попыток, а проверка (b) (`logJudgmentComplete`) — только квитанции `logged-v1`;
- отметки владельца на вердикте лога имеют отдельную цель `log:{key}` в `humanReviews`.

**Переиспользование.** Ключ адресуется по содержимому: определение, ожидание, импорт, диалог, конфигурация судьи. `freshDraft` (повтор) копирует записи с совпавшим ключом и их сайдкары из исходного прогона. Пока карточка, лог и судья не менялись, повторная сверка стоит 0 вызовов.

**Проверка без пересборки** (F1): внутренняя согласованность сохранённого аудита, то есть `fingerprint(JSON.parse(audit.input)) === inputHash` и голоса снова дают `result`, плюс совпадение `definitionHash` с `acceptedTests`. `logJudgeInputV1` заморожен; изменить его — значит завести `logged-v2`.

Реализация: `assessLogged` использует `assessRepeated` с внедрённым сборщиком входа и списком событий-доказательств (цитируемые `seq` проверяются по событиям лога).

### 10.4 Сравнение и строка доверия

Для каждой сверяемой карточки c и её ожиданий:
- `s(e)` — синтетический исход по правилу заголовка (§4.3–4.4): первый fail по всем попыткам, гейт канала, ручные вердикты;
- `l(e)` — `entry.result`.

**Сравнимые ожидания** `E' = { e : s(e) ∈ {pass, fail} и l(e) ∈ {pass, fail} }`. Если `E'` пусто, карточка не сравнивается; причина берётся первой из `no_agent_reply → channel_unobserved → not_exercised_in_log → judge_split → synthetic_unmeasured`. **Ситуация совпадает**, если для всех `e ∈ E'` выполняется `s(e) === l(e)`. Это строже, чем совпадение итога карточки: провал по разным ожиданиям — не совпадение поведения.

```ts
export interface CalibrationView {
  mode: 'calibration' | 'comparison'; versionNote: string | null;
  agreed: number; compared: number; range: [number, number] | null;       // Wilson, как у заголовка
  text: string;
  excluded: { reason: 'not_from_log' | 'situation_edited' | 'no_agent_reply' | 'channel_unobserved' | 'not_exercised_in_log' | 'judge_split' | 'synthetic_unmeasured'; count: number; cardIds: string[] }[];
  disagreements: { cardId: string; number: number; title: string;
    expectations: { id: string; text: string; synthetic: 'pass' | 'fail'; log: 'pass' | 'fail' }[];
    path: { synthetic: string[]; log: string[]; same: boolean };             // шаги клиента, §10.5
    trialIds: string[]; log: { importId: string; dialogueId: string; number: number } }[];
}
```

Строка под заголовком `buildResultView` (новое поле `calibration`):
- калибровка: **«Синтетика совпадает с продом в 13 из 15 ситуаций.»** При `compared < SMALL_SAMPLE` добавляется «Мало данных: от {lo}% до {hi}%»;
- сравнение: «С записанными диалогами совпадает в 13 из 15 ситуаций. Это не калибровка: {versionNote}.»;
- исключения — одной строкой: «Не сравнивались: 4 — ситуация изменена (2), в логе не дошло до ожидания (2).»

### 10.5 Расхождения как доказательства

Каждое расхождение показывает номер и заголовок карточки, ожидание, «в синтетике: выполнил / в проде: нет» и ссылки на оба разговора рядом: синтетическую попытку и диалог №k из импорта. Детерминированная подсказка — **сравнение пути клиента**, без NLU:
- путь в синтетике — принятые действия контроллера из событий `simulator` (`tell_f2` → «назвал „Номер терминала“», `dunno_*` → «не знает …», `turn` → «повернул разговор», `leave` → «ушёл»);
- путь в логе — поздние реплики по порядку из `coverage` (`fact` → «назвал {label фактов с этим событием}», `turn`, `stop`; `ignored` пропускается).

| Путь | Подсказка |
|---|---|
| различается | «Синтетический клиент повёл себя иначе, чем реальный: {первое расхождение}» — дрейф симулятора или карточки |
| совпадает, `calibration` | «Клиент тот же — различается ответ агента: проверьте окружение стенда или шум судьи» |
| совпадает, `comparison` | «Клиент тот же — вероятно, изменился агент (версии различаются или неизвестны)» |

Оговорки печатаются в «подробностях»:
- с обеих сторон один и тот же судья, поэтому согласие не доказывает правоту судьи (её меряют отметки владельца);
- сверка покрывает только карточки из логов;
- тестовый стенд и прод-окружение могут различаться даже при одной версии.

### 10.6 Стоимость — только вызовы судьи

- **Потолок:** `Σ по сверяемым карточкам (судимые ожидания × 2)` плюс не больше одного переспроса на битый голос. Пример: 15 карточек × 2 ожидания = **60 вызовов**. Для сравнения: судья синтетики на одну попытку набора — те же 60, плюс вызовы агента и контроллера.
- **Не тратится:** агент, симулятор и стенд не вызываются. `no_agent_reply` и `channel_unobserved` — ноль вызовов.
- **Однократно** на ключ (§10.3): повторы и переоценки без смены карточек и судьи не платят.
- **Бюджет:** входит в `maxCalls` прогона и **показывается в диалоге запуска** рядом с потолком судьи (решение 3): «Сверка с продом: до 60 вызовов судьи; агент и симулятор не участвуют». Настройка `settings.calibration: 'auto' | 'off'` (новое поле с `.optional()`), по умолчанию `auto`. При нехватке бюджета сверка пропускается целиком с причиной, а синтетика не страдает.
- **Данные:** судье уходят те же записанные диалоги, что уже видит проверяющий при подготовке. Новых получателей нет, локальное хранение (`0600`) не меняется.

### 10.7 Коммиты (после C13)

| # | Коммит | Тест-план |
|---|---|---|
| C14 | `declare_log_version` и журнал деклараций импорта; `testedVersion`; `calibratable(card)` | Журнал только дописывается; таблица режимов (обе версии известны и совпадают / различаются / лог неизвестен / тест неизвестен / адаптер сообщает разные версии); объявление после принятия не меняет `libraryHash`; таблица `calibratable` на v2-карточках и проекциях v1 |
| C15 | `logRubric`, `logJudgeInputV1`, `assessLogged`, квитанции и сайдкары, предпроверки, бюджет и план, копирование по ключу при повторе | Во входе (b) нет брифа, событий симулятора и `finalState`; лог-аудит не проходит `hasCompleteJudgment`, а квитанция попытки не закрывает ключ (b); пара `not_met/not_met` → `not_exercised_in_log`; `no_agent_reply` — 0 вызовов; повтор — 0 вызовов; превышение бюджета пропускает сверку, синтетика завершена |
| C16 | `buildCalibration`, поле ResultView, строка доверия, список расхождений с путём, показ в чате, на доске и в CLI | Пример 13 из 15; порядок причин исключения; формулировки калибровки и сравнения; путь детерминирован на фикстуре; golden: заголовок и строки ResultView без сверки не изменились |
