import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ChevronDown, History as HistoryIcon, RotateCcw } from "lucide-react";
import { when } from "../../lab/format";
import {
  comparisonText,
  loadToneHistory,
  loadToneSnapshot,
  toneShare,
  type ToneCheck,
  type ToneSnapshot,
} from "../../lab/toneHistory";
import type { Rule, Status } from "../../lab/types";
import { Conversation } from "../../product/Conversation";
import { Button } from "../../ui/Button";
import { Skeleton } from "../../ui/EmptyState";
import { Sheet } from "../../ui/Sheet";

const statusText = (status: Status) =>
  status === "FAIL" ? "С ошибкой" : status === "PASS" ? "Без найденных ошибок" : "Не удалось оценить";
const selectClass =
  "mt-2 w-full rounded-control border border-line bg-canvas px-3 py-2 text-body text-fg outline-none focus-visible:ring-2 focus-visible:ring-run";

function SavedRule({ rule, second, snapshot }: { rule: Rule; second?: Rule; snapshot: ToneSnapshot }) {
  const criterionIndex = snapshot.criteria.findIndex((item) => item.id === rule.ruleId);
  const criterion = snapshot.criteria[criterionIndex];
  return (
    <details className="group border-t border-line py-4">
      <summary className="flex cursor-pointer list-none items-start gap-3 rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run [&::-webkit-details-marker]:hidden">
        <ChevronDown aria-hidden className="mt-1 size-4 shrink-0 transition-transform group-open:rotate-180" />
        <div className="min-w-0">
          <span className="text-read font-medium text-fg">
            {criterion ? `${criterionIndex + 1}. ${criterion.name}` : rule.rule}
          </span>
          <span className={`mt-1 block text-small ${rule.status === "FAIL" ? "text-bad" : "text-fg-3"}`}>
            {statusText(rule.status)}
            {rule.review === "agree"
              ? " · Человек согласился с оценкой"
              : rule.review === "disagree"
                ? " · Человек оспорил оценку"
                : ""}
          </span>
        </div>
      </summary>
      <div className="ml-7 mt-3 space-y-3 break-words text-body text-fg-2">
        {rule.agentQuote && (
          <blockquote className="border-l-2 border-line-strong pl-3 whitespace-pre-wrap">
            «{rule.agentQuote}»
          </blockquote>
        )}
        <p>{rule.reason || "Объяснение оценки не сохранено."}</p>
        {second && (
          <p className="text-fg-3">
            Вторая проверка: {statusText(second.status).toLowerCase()}. {second.reason}
          </p>
        )}
        {criterion && (
          <div className="space-y-3">
            <p>
              <span className="font-medium text-fg">Требование: </span>
              {criterion.text}
            </p>
            {criterion.condition && (
              <p>
                <span className="font-medium text-fg">Когда применяется: </span>
                {criterion.condition}
              </p>
            )}
            {criterion.acceptable && (
              <details>
                <summary className="cursor-pointer text-fg">Исключения и допустимое</summary>
                <p className="mt-2 whitespace-pre-wrap">{criterion.acceptable}</p>
              </details>
            )}
            {!!criterion.clarifications?.length && (
              <div>
                <p className="font-medium text-fg">Уточнения команды</p>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {criterion.clarifications.map((text, index) => (
                    <li key={index}>{text}</li>
                  ))}
                </ul>
              </div>
            )}
            <details>
              <summary className="cursor-pointer text-fg">Основание в документе</summary>
              <blockquote className="mt-2 whitespace-pre-wrap border-l-2 border-line-strong pl-3">
                {criterion.quote || "Цитата не сохранена."}
              </blockquote>
            </details>
          </div>
        )}
        {!criterion && <p className="text-fg-3">Критерий не найден в сохранённом наборе.</p>}
      </div>
    </details>
  );
}

function SnapshotBody({ snapshot, previous }: { snapshot: ToneSnapshot; previous?: ToneCheck }) {
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState<string | null>(null);
  const { check, result } = snapshot;
  const filtered = result.results.filter(
    (item) =>
      filter === "all" || (filter === "none" ? !["PASS", "FAIL"].includes(item.status) : item.status === filter),
  );
  const current =
    filtered.find((item) => item.dialogueId === selected) ??
    filtered.find((item) => item.status === "FAIL") ??
    filtered[0];
  const dialogue = snapshot.dialogues.find((item) => item.id === current?.dialogueId);
  const share = toneShare(check);
  const outcomes = [
    { id: "all", label: "В выборке", value: check.sampled },
    { id: "PASS", label: "Без найденных ошибок", value: check.summary.passed },
    { id: "FAIL", label: "С ошибкой", value: check.summary.failed },
    { id: "none", label: "Не удалось оценить", value: check.summary.unmeasured },
  ];
  return (
    <div className="space-y-8 p-5 sm:p-7">
      <div>
        <p className="text-display font-semibold tabular-nums text-fg">{share === null ? "—" : `${share}%`}</p>
        <p className="mt-1 text-read text-fg-2">
          {check.summary.passed} из {check.summary.measured} оценённых разговоров — без найденных ошибок.
        </p>
        <p className="mt-2 break-words text-body text-fg-3">
          {check.file || "Загруженные разговоры"} · выборка {check.sampled} из {check.total} · критериев{" "}
          {snapshot.criteria.length}.
        </p>
        <p className="mt-4 text-body text-fg-3">{comparisonText(check, previous)}</p>
      </div>
      <section aria-label="Сохранённые разговоры">
        <h3 className="text-lead font-semibold text-fg">Разговоры этой проверки</h3>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {outcomes.map((outcome) => (
            <button
              key={outcome.id}
              type="button"
              aria-pressed={filter === outcome.id}
              onClick={() => {
                setFilter(outcome.id);
                setSelected(null);
              }}
              className={`rounded-control px-3 py-3 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run ${filter === outcome.id ? "bg-selected" : "bg-inset"}`}
            >
              <span
                className={`block text-count font-semibold tabular-nums ${outcome.id === "FAIL" ? "text-bad" : "text-fg"}`}
              >
                {outcome.value}
              </span>
              <span className="mt-1 block text-small text-fg-3">{outcome.label}</span>
            </button>
          ))}
        </div>
        {current ? (
          <>
            <label className="mt-5 block text-small text-fg-3">
              Разговор · {filtered.length} в выбранной группе
              <select
                value={current.dialogueId}
                onChange={(event) => setSelected(event.target.value)}
                className={selectClass}
              >
                {filtered.map((item, index) => (
                  <option key={item.dialogueId} value={item.dialogueId}>
                    {index + 1}. {item.opening || "Без первой реплики"} · {statusText(item.status)}
                  </option>
                ))}
              </select>
            </label>
            <div className="mt-4 rounded-block bg-inset p-4">
              {dialogue ? (
                <Conversation
                  key={dialogue.id}
                  turns={dialogue.messages.map((message) => ({
                    role: message.role === "user" ? "customer" : "agent",
                    text: message.content,
                  }))}
                  marks={current.rules
                    .filter((rule) => rule.status === "FAIL" && rule.agentQuote)
                    .map((rule) => ({
                      quote: rule.agentQuote,
                      n: snapshot.criteria.findIndex((criterion) => criterion.id === rule.ruleId) + 1,
                    }))
                    .filter((mark) => mark.n > 0)}
                />
              ) : (
                <p className="text-body text-fg-3">Текст разговора не сохранился.</p>
              )}
            </div>
            {current.error && <p className="mt-3 text-body text-fg-3">Причина отсутствия оценки: {current.error}</p>}
            <div className="mt-5">
              {current.rules.map((rule) => (
                <SavedRule
                  key={rule.ruleId}
                  rule={rule}
                  second={current.second?.rules?.find((item) => item.ruleId === rule.ruleId)}
                  snapshot={snapshot}
                />
              ))}
            </div>
          </>
        ) : (
          <p className="py-6 text-body text-fg-3">В этой группе нет разговоров.</p>
        )}
      </section>
      <details className="border-t border-line pt-5">
        <summary className="cursor-pointer text-read font-medium text-fg">
          Критерии этой проверки · {snapshot.criteria.length}
        </summary>
        <div className="mt-4 divide-y divide-line">
          {snapshot.criteria.map((criterion, index) => (
            <details key={criterion.id} className="py-3">
              <summary className="cursor-pointer text-body font-medium text-fg">
                {index + 1}. {criterion.name}
              </summary>
              <div className="mt-3 space-y-3 whitespace-pre-wrap break-words text-body text-fg-2">
                <p>{criterion.text}</p>
                {criterion.condition && <p>Когда применяется: {criterion.condition}</p>}
                {criterion.acceptable && <p>Исключения и допустимое: {criterion.acceptable}</p>}
                {!!criterion.clarifications?.length && <p>Уточнения команды: {criterion.clarifications.join("\n")}</p>}
                <blockquote className="border-l-2 border-line-strong pl-3">{criterion.quote}</blockquote>
              </div>
            </details>
          ))}
        </div>
      </details>
      <details className="border-t border-line pt-5">
        <summary className="cursor-pointer text-read font-medium text-fg">
          Документ проверки · {snapshot.policy.name || "Tone of voice"}
        </summary>
        <p className="mt-4 whitespace-pre-wrap break-words text-body text-fg-2">{snapshot.policy.content}</p>
      </details>
      <p className="border-t border-line pt-5 text-small text-fg-3">
        Разговоры, критерии и автоматические оценки сохранены на момент завершения проверки. Ответы человека сохраняются
        отдельно; здесь показаны последние сохранённые ответы.
      </p>
    </div>
  );
}

function Snapshot({ id, checks, onClose }: { id: string | null; checks: ToneCheck[]; onClose: () => void }) {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["tone-history-snapshot", id],
    queryFn: () => loadToneSnapshot(id!),
    enabled: !!id,
    staleTime: 0,
  });
  const check = data?.check ?? checks.find((item) => item.id === id);
  const previous = checks.find((item) => item.id === check?.comparison.previousId);
  return (
    <Sheet
      open={!!id}
      onClose={onClose}
      width="lg"
      title="Сохранённая проверка"
      sub={check ? when(check.finishedAt) : undefined}
    >
      {isLoading && (
        <div className="space-y-4 p-5" aria-label="Загружаем сохранённую проверку">
          <Skeleton className="h-20" />
          <Skeleton className="h-64" />
        </div>
      )}
      {error && (
        <div className="p-5">
          <p role="alert" className="text-body text-fg-2">
            Не удалось открыть проверку. Попробуйте ещё раз.
          </p>
          <Button className="mt-4" icon={RotateCcw} onClick={() => void refetch()}>
            Повторить
          </Button>
        </div>
      )}
      {data && <SnapshotBody key={data.check.id} snapshot={data} previous={previous} />}
    </Sheet>
  );
}

/** Saved checks stay separate from the current workspace and open their own evidence. */
export function History({ finishedAt, refreshStamp }: { finishedAt?: string; refreshStamp?: string }) {
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState(false);
  const selected = params.get("history");
  const expanded = open || !!selected;
  const select = (id: string | null) => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (id) next.set("history", id);
        else next.delete("history");
        return next;
      },
      { replace: !id },
    );
    setOpen(true);
  };
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["tone-history", finishedAt, refreshStamp],
    queryFn: loadToneHistory,
    enabled: expanded,
    staleTime: Infinity,
  });
  const checks = data?.checks ?? [];
  return (
    <section className="mt-12 border-t border-line pt-6" aria-label="История проверок">
      <button
        type="button"
        onClick={() => setOpen(!expanded)}
        aria-expanded={expanded}
        aria-controls="tone-history-list"
        className="flex min-h-11 w-full items-center gap-3 rounded-control text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run"
      >
        <HistoryIcon aria-hidden className="size-5 text-fg-3" />
        <span className="flex-1 text-lead font-semibold text-fg">
          История проверок{data ? ` · ${checks.length}` : ""}
        </span>
        <ChevronDown aria-hidden className={`size-4 text-fg-3 transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>
      {expanded && (
        <div id="tone-history-list" className="mt-4">
          {isLoading && <Skeleton className="h-20" />}
          {error && (
            <div className="py-3">
              <p role="alert" className="text-body text-fg-3">
                Не удалось загрузить историю.
              </p>
              <Button className="mt-3" icon={RotateCcw} onClick={() => void refetch()}>
                Повторить
              </Button>
            </div>
          )}
          {data && !checks.length && (
            <p className="py-3 text-body text-fg-3">
              {data.hasLegacyResult
                ? "Текущий результат создан до появления истории. Она начнётся со следующей проверки."
                : "Здесь появятся завершённые проверки с их разговорами и критериями."}
            </p>
          )}
          <div className="divide-y divide-line">
            {checks.map((check) => (
              <button
                key={check.id}
                type="button"
                onClick={() => select(check.id)}
                className="flex w-full items-start gap-3 rounded-control px-1 py-4 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-read font-medium text-fg">
                    {when(check.finishedAt)}
                    {check.finishedAt === finishedAt && (
                      <span className="ml-2 text-small font-normal text-fg-3">Текущий результат</span>
                    )}
                  </p>
                  <p className="mt-1 break-words text-small text-fg-3">{check.file || "Загруженные разговоры"}</p>
                  <p className="mt-2 text-body text-fg-2">
                    {check.summary.passed} из {check.summary.measured} — без найденных ошибок
                    {toneShare(check) !== null ? ` (${toneShare(check)}%)` : ""}
                  </p>
                  <p className="mt-1 text-small text-fg-3">
                    Не удалось оценить: {check.summary.unmeasured} из {check.sampled}.
                  </p>
                  <p className="mt-2 text-small text-fg-3">
                    {comparisonText(
                      check,
                      checks.find((item) => item.id === check.comparison.previousId),
                    )}
                  </p>
                </div>
                <ArrowRight aria-hidden className="mt-1 size-4 shrink-0 text-fg-3" />
              </button>
            ))}
          </div>
        </div>
      )}
      <Snapshot id={selected} checks={checks} onClose={() => select(null)} />
    </section>
  );
}
