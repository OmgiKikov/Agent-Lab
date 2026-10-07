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
  if (same + different === 0)
    return <p className="text-small text-fg-2">{used}. Совпадение с продом не проверялось.</p>;
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
