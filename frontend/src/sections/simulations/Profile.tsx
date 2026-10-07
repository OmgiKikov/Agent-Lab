import type { ReactNode } from "react";
import type { Card, DeckChecks, Knowledge, Observation } from "../../lab/types";
import { Label } from "../../ui/Label";

/** What the agent did, as the card's reactions name it (backend/lab/domain/cards.py, TRIGGERS). */
const TRIGGER: Record<string, string> = {
  unclear_question: "непонятный вопрос",
  repeated_clarification: "переспросил",
  wrong_object: "не тот объект",
  inapplicable_instruction: "неприменимая инструкция",
  no_progress: "нет продвижения",
  identifier_request: "спросил номер или реквизиты",
  choice_offer: "предложил выбрать",
  instruction: "инструкция",
  handoff_offer: "предложил оператора",
  resolved: "ответил на вопрос",
};
/** What the customer did in reply (backend/lab/domain/cards.py, ACTIONS). */
export const ACTION: Record<string, string> = {
  answer: "ответил",
  give_detail: "уточнил подробность",
  dont_know: "сказал, что не знает",
  ask_how: "спросил, как именно",
  ask_meaning: "переспросил",
  correct_object: "поправил агента",
  report_obstacle: "сказал, что мешает",
  report_result: "сообщил результат",
  choose_option: "выбрал вариант",
  decline_handoff: "остался в чате",
  ask_human: "попросил специалиста",
  restate: "повторил задачу",
  accept: "принял ответ",
};

/** Where an item stands in the log: a hover shows the customer's words it rests on. */
const cited = (x: { n: number; quote: string }) => `Реплика ${x.n}: «${x.quote}»`;

function Block({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mt-4">
      <Label>{label}</Label>
      <ul className="mt-1.5 space-y-1 text-read text-fg">{children}</ul>
    </div>
  );
}

function Items({ label, items }: { label: string; items: (Knowledge | Observation)[] }) {
  if (!items.length) return null;
  return (
    <Block label={label}>
      {items.map((x) => (
        <li key={`${x.n}-${"text" in x ? x.text : x.action}`} title={cited(x)}>
          {"text" in x ? x.text : `уже пробовал: ${x.action} — ${x.result}`}
          {"access" in x && x.access === "believes" && <span className="text-fg-3"> · так считает</span>}
        </li>
      ))}
    </Block>
  );
}

/**
 * The customer of a scenario as its profile: the task, what they say when, what they do not know, what trying gives,
 * how they reacted, and what the code found in the text the simulator reads. Each item shows the log's words on hover.
 */
export function Profile({ card }: { card: Card }) {
  const known = (card.knowledge ?? []).filter((k) => k.access !== "does_not_know");
  const before = (card.observations ?? []).filter((o) => o.when === "before");
  const told = (d: Knowledge["disclose"]) => [
    ...known.filter((k) => k.disclose === d),
    ...before.filter((o) =>
      d === "opening" ? o.disclose === "opening" : d === "when_relevant" && o.disclose !== "opening",
    ),
  ];
  const audit = card.checks?.audit;
  const warnings = [
    ...(audit?.agentWords ?? []).map((w) => `В тексте для клиента фраза агента: «${w}»`),
    ...(audit?.criteriaWords ?? []).map((w) => `В тексте для клиента слова критерия: «${w}»`),
    ...(audit?.goalAhead ?? []).map((w) => `В задаче уже есть то, что клиент сказал позже: ${w}`),
  ];
  return (
    <div className="max-w-[66ch]">
      <p className="mt-2 text-read text-fg">
        {card.goal?.task}
        {card.goal?.object ? <span className="text-fg-3"> · {card.goal.object}</span> : null}
      </p>
      {warnings.map((w) => (
        <p key={w} className="mt-1 text-small text-warn">
          {w}
        </p>
      ))}
      <Items label="В первом сообщении" items={told("opening")} />
      <Items label="Расскажет сам, когда к месту" items={told("when_relevant")} />
      <Items label="Скажет, если спросят" items={told("on_request")} />
      <Items label="Не знает" items={(card.knowledge ?? []).filter((k) => k.access === "does_not_know")} />
      {!!card.notEstablished?.length && (
        <Block label="Лог не устанавливает">
          {card.notEstablished.map((x) => (
            <li key={x} className="text-fg-2">
              {x}
            </li>
          ))}
        </Block>
      )}
      {(card.observations ?? []).some((o) => o.when === "during") && (
        <Block label="Если попробует">
          {(card.observations ?? [])
            .filter((o) => o.when === "during")
            .map((o) => (
              <li key={`${o.n}-${o.action}`} title={cited(o)}>
                {o.action} → {o.result}
              </li>
            ))}
        </Block>
      )}
      {!!card.reactions?.length && (
        <Block label="Как реагировал на агента">
          {card.reactions.map((r) => (
            <li key={`${r.n}-${r.trigger}`} title={`Агент: «${r.agentQuote}» · ${cited(r)}`}>
              <span className="text-fg-3">{TRIGGER[r.trigger] ?? r.trigger} →</span>{" "}
              {r.actions.map((a) => ACTION[a] ?? a).join(", ")}
            </li>
          ))}
        </Block>
      )}
    </div>
  );
}

/**
 * The deck's checks in a line or two: how many texts for the customer copy the agent's words or the criteria, or put in
 * the goal what the customer said later; and how customers answered when the agent asked for an identifier.
 */
export function DeckCheckLine({ checks }: { checks: DeckChecks }) {
  const found = [
    checks.agentWords && `фразы агента — ${checks.agentWords}`,
    checks.criteriaWords && `слова критериев — ${checks.criteriaWords}`,
    checks.goalAhead && `задача забегает вперёд — ${checks.goalAhead}`,
  ].filter(Boolean);
  const answers = Object.entries(checks.identifierAnswers).map(([a, n]) => `${ACTION[a] ?? a} — ${n}`);
  return (
    <div className="text-small">
      <p className={found.length ? "text-warn" : "text-fg-3"}>
        {found.length
          ? `Тексты для клиента: ${found.join(", ")}`
          : "Тексты для клиента без фраз агента и слов критериев"}
      </p>
      {answers.length > 0 && <p className="text-fg-3">Когда агент спрашивал номер: {answers.join(", ")}</p>}
    </div>
  );
}
