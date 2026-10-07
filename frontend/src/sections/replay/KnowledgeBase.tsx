import { type ReactNode, useId, useState } from "react";
import { count, pct } from "../../lab/format";
import { MATCH_ID } from "../../lab/replay";
import type {
  FamilyScore,
  KnowledgeBaseCriterion,
  KnowledgeBaseSummary,
  ReplayResult,
  ReplayStep,
  StepRef,
} from "../../lab/types";
import { LINK } from "./link";
import { StepView } from "./StepView";

const BLOCK = "space-y-3 rounded-control border border-line p-4";
const HEADING = "text-lead font-semibold text-fg";

/**
 * «База знаний» of a replay (spec 2026-10-07-replay-knowledge-base-breakdown-design.md): the share of steps without
 * errors, how many steps used the knowledge base and matched production, and each of the five criteria with the steps
 * that failed it, one list open at a time.
 */
export function KnowledgeBase({ result }: { result: ReplayResult }) {
  const [openedRule, setOpenedRule] = useState<string | null>(null);
  const listId = useId();
  const summary = result.knowledgeBase;
  const toggle = (ruleId: string) => setOpenedRule(openedRule === ruleId ? null : ruleId);
  if (!summary.called)
    return (
      <section className={BLOCK}>
        <h2 className={HEADING}>База знаний</h2>
        <p className="text-body text-fg-3">На шагах этого повтора агент не обращался к базе знаний.</p>
      </section>
    );
  return (
    <section className={BLOCK}>
      <Headline score={result.metric.rag} />
      <MatchLine summary={summary} open={openedRule === MATCH_ID} listId={listId} onToggle={() => toggle(MATCH_ID)} />
      <ul className="divide-y divide-line">
        {summary.criteria.map((criterion) => (
          <CriterionRow
            key={criterion.id}
            criterion={criterion}
            open={openedRule === criterion.id}
            listId={listId}
            onToggle={() => toggle(criterion.id)}
          />
        ))}
      </ul>
      {openedRule && (
        <StepList
          key={openedRule}
          id={listId}
          result={result}
          ruleId={openedRule}
          refs={failedSteps(summary, openedRule)}
        />
      )}
    </section>
  );
}

function failedSteps(summary: KnowledgeBaseSummary, ruleId: string): StepRef[] {
  if (ruleId === MATCH_ID) return summary.match.differentSteps;
  return summary.criteria.find((criterion) => criterion.id === ruleId)?.failed ?? [];
}

function Headline({ score }: { score: FamilyScore }) {
  const total = score.pass + score.fail;
  return (
    <h2 className={HEADING}>
      {total
        ? `База знаний — ${pct(score.pass, total)}%, без найденных ошибок ${score.pass} из ${count(total, "шага", "шагов", "шагов")}`
        : "База знаний — не удалось проверить"}
    </h2>
  );
}

function MatchLine({
  summary,
  open,
  listId,
  onToggle,
}: {
  summary: KnowledgeBaseSummary;
  open: boolean;
  listId: string;
  onToggle: () => void;
}) {
  const { same, different, unknown } = summary.match;
  const used = `С обращением к базе знаний — ${count(summary.called, "шаг", "шага", "шагов")} из ${summary.steps}`;
  const differ = count(different, "отличается", "отличаются", "отличаются");
  if (same + different === 0)
    return (
      <p className="text-small text-fg-2">
        {used}. {unknown ? `Сравнить с продом не удалось: ${unknown}.` : "Совпадение с продом не проверялось."}
      </p>
    );
  return (
    <p className="text-small text-fg-2">
      {used}, из них с продом совпали {same}
      {different > 0 && (
        <>
          {" · "}
          <Toggle open={open} listId={listId} label={`${differ} от прода — показать шаги`} onClick={onToggle}>
            {differ}
          </Toggle>
        </>
      )}
      {unknown > 0 && ` · не удалось сравнить: ${unknown}`}
    </p>
  );
}

function CriterionRow({
  criterion,
  open,
  listId,
  onToggle,
}: {
  criterion: KnowledgeBaseCriterion;
  open: boolean;
  listId: string;
  onToggle: () => void;
}) {
  const total = criterion.pass + criterion.fail;
  const failed = count(criterion.fail, "с ошибкой", "с ошибкой", "с ошибкой");
  return (
    <li className="grid grid-cols-1 items-baseline gap-x-3 gap-y-1 py-2 text-small sm:grid-cols-[minmax(0,1fr)_10rem_13rem]">
      <span className="text-fg">{criterion.name}</span>
      <span className="tabular-nums text-fg-2 sm:text-right">{tally(criterion, total)}</span>
      {(criterion.fail > 0 || (total > 0 && criterion.unknown > 0)) && (
        <span className="flex flex-wrap items-baseline gap-x-3">
          {criterion.fail > 0 && (
            <Toggle
              open={open}
              listId={listId}
              label={`${criterion.name}: ${failed} — показать шаги`}
              onClick={onToggle}
            >
              {failed}
            </Toggle>
          )}
          {total > 0 && criterion.unknown > 0 && (
            <span className="text-fg-3">не удалось проверить: {criterion.unknown}</span>
          )}
        </span>
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

function Toggle({
  open,
  listId,
  label,
  onClick,
  children,
}: {
  open: boolean;
  listId: string;
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={open ? listId : undefined}
      aria-label={label}
      onClick={onClick}
      className={LINK}
    >
      <span aria-hidden="true">{open ? "▾" : "▸"}</span> {children}
    </button>
  );
}

function stepAt(result: ReplayResult, ref: StepRef): ReplayStep | undefined {
  return result.dialogues
    .find((dialogue) => dialogue.dialogueId === ref.dialogueId)
    ?.steps.find((candidate) => candidate.index === ref.step);
}

/** The steps behind a number: the customer's message, the model's reason and quote; a click opens the whole step. */
function StepList({ id, result, ruleId, refs }: { id: string; result: ReplayResult; ruleId: string; refs: StepRef[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <ul id={id} className="border-t border-line">
      {refs.map((ref) => {
        const step = stepAt(result, ref);
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
