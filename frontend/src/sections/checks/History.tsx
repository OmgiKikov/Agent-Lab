import { useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ChevronDown, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Check } from "../../app/links";
import { resultOf } from "../../lab/checks";
import { duty, nameFromText, quoteKey } from "../../lab/criteria";
import { count, longDay, time } from "../../lab/format";
import {
  comparisonText,
  errorShare,
  loadHistory,
  loadSaved,
  type CodeSnapshot,
  type SavedCheck,
  type ToneSnapshot,
} from "../../lab/history";
import { useLabState } from "../../lab/LabProvider";
import type { LogDialogue } from "../../lab/problems";
import type { Discover, Rule, Status } from "../../lab/types";
import { Conversation } from "../../product/Conversation";
import { StageResult } from "../../product/StageResult";
import { Button } from "../../ui/Button";
import { ServiceDown, Skeleton } from "../../ui/EmptyState";
import { Sheet } from "../../ui/Sheet";
import { CheckHeader } from "./CheckHeader";

const statusText = (status: Status) =>
  status === "FAIL" ? "С ошибкой" : status === "PASS" ? "Без найденных ошибок" : "Не удалось проверить";

/** «3 октября, 14:05»: when a check finished, to the minute, so two checks of one day are told apart. */
const finished = (iso: string) => `${longDay(iso)}, ${time(iso)}`;
const selectClass =
  "mt-2 w-full rounded-control border border-line bg-canvas px-3 py-2 text-body text-fg outline-none focus-visible:ring-2 focus-visible:ring-run";

/** What each history keeps, said above its list. */
const KEEPS: Record<Check, string> = {
  tone: "Каждая завершённая проверка сохраняется со своими разговорами, критериями и правилами общения. Ваши ответы остаются и после новой выгрузки.",
  code: "Каждая завершённая проверка сохраняется со своими разговорами, критериями из кода агента и итогом. Новая выгрузка её не стирает.",
};

type SavedCriterion = {
  id: string;
  name: string;
  text: string;
  quote: string;
  condition?: string;
  acceptable?: string;
  clarifications?: string[];
};

/**
 * A saved check as the sheet shows it, whichever check it is: its conversations and verdicts, its numbered criteria,
 * and what the criteria were collected from — the person's document for tone of voice, the agent's code for accuracy.
 */
type Saved = {
  check: SavedCheck;
  result: Discover;
  dialogues: LogDialogue[];
  criteria: SavedCriterion[];
  /** The number of the criterion a verdict is about (its rule id), from 1; 0 when the saved set lacks it. */
  numberOf: (ruleId: string) => number;
  basis: string;
  source: { title: string; body: ReactNode };
  note: string;
};

function toneSaved(data: ToneSnapshot): Saved {
  const numbers = new Map(data.criteria.map((criterion, index) => [criterion.id, index + 1]));
  return {
    ...data,
    numberOf: (ruleId) => numbers.get(ruleId) ?? 0,
    basis: "Основание в правилах",
    source: {
      title: `Правила общения · ${data.policy.name || "Tone of voice"}`,
      body: <p className="mt-4 whitespace-pre-wrap break-words text-body text-fg-2">{data.policy.content}</p>,
    },
    note: "Разговоры, критерии и оценки модели сохранены такими, какими были в конце проверки. Ваши ответы хранятся отдельно, здесь показаны последние.",
  };
}

/**
 * A saved check of accuracy: its criteria are the rules of its topics; one quote restated in several topics is one
 * criterion, as everywhere in the product (problems.rule_key).
 */
function codeSaved(data: CodeSnapshot): Saved {
  const criteria: SavedCriterion[] = [];
  const byQuote = new Map<string, number>();
  const numbers = new Map<string, number>();
  for (const rule of data.result.topics.flatMap((topic) => topic.rules)) {
    const key = quoteKey(rule.quote || rule.text);
    if (!byQuote.has(key)) {
      criteria.push({
        id: rule.id,
        name: rule.name?.trim() || nameFromText(rule.text),
        text: rule.text,
        quote: rule.quote,
        condition: rule.condition,
        acceptable: rule.acceptable,
      });
      byQuote.set(key, criteria.length);
    }
    numbers.set(rule.id, byQuote.get(key)!);
  }
  const sources = data.result.sources ?? [];
  return {
    ...data,
    criteria,
    numberOf: (ruleId) => numbers.get(ruleId) ?? 0,
    basis: "Основание в коде агента",
    source: {
      title: `Код агента · ${count(sources.length, "источник", "источника", "источников")}`,
      body: (
        <ul className="mt-4 space-y-2 text-body text-fg-3">
          {sources.map((source) => (
            <li key={source.id} className="break-words">
              <span className="font-mono text-small text-fg-2">{source.origin}</span> ·{" "}
              {count(source.rules, "критерий", "критерия", "критериев")}
            </li>
          ))}
        </ul>
      ),
    },
    note: "Разговоры, критерии, оценки модели и ваши ответы сохранены такими, какими были в конце проверки.",
  };
}

function SavedRule({ rule, second, saved }: { rule: Rule; second?: Rule; saved: Saved }) {
  const n = saved.numberOf(rule.ruleId);
  const criterion = saved.criteria[n - 1];
  return (
    <details className="group border-t border-line py-4">
      <summary className="flex cursor-pointer list-none items-start gap-3 rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run [&::-webkit-details-marker]:hidden">
        <ChevronDown aria-hidden className="mt-1 size-4 shrink-0 transition-transform group-open:rotate-180" />
        <div className="min-w-0">
          <span className="text-read font-medium text-fg">{criterion ? `${n}. ${criterion.name}` : rule.rule}</span>
          <span className={`mt-1 block text-small ${rule.status === "FAIL" ? "text-bad" : "text-fg-3"}`}>
            {statusText(rule.status)}
            {rule.review === "agree"
              ? " · вы согласились с оценкой"
              : rule.review === "disagree"
                ? " · вы не согласились с оценкой"
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
        <p>{rule.reason || "Объяснение не сохранилось."}</p>
        {second && (
          <p className="text-fg-3">
            Вторая проверка: {statusText(second.status).toLowerCase()}. {second.reason}
          </p>
        )}
        {criterion && (
          <div className="space-y-3">
            <p>
              <span className="font-medium text-fg">Агент должен: </span>
              {duty(criterion.text)}
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
              <summary className="cursor-pointer text-fg">{saved.basis}</summary>
              <blockquote className="mt-2 whitespace-pre-wrap border-l-2 border-line-strong pl-3">
                {criterion.quote || "Цитата не сохранилась."}
              </blockquote>
            </details>
          </div>
        )}
        {!criterion && <p className="text-fg-3">Этого критерия нет среди сохранённых.</p>}
      </div>
    </details>
  );
}

function SnapshotBody({ saved, previous }: { saved: Saved; previous?: SavedCheck }) {
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState<string | null>(null);
  const { check, result } = saved;
  const filtered = result.results.filter(
    (item) =>
      filter === "all" || (filter === "none" ? !["PASS", "FAIL"].includes(item.status) : item.status === filter),
  );
  const current =
    filtered.find((item) => item.dialogueId === selected) ??
    filtered.find((item) => item.status === "FAIL") ??
    filtered[0];
  const dialogue = saved.dialogues.find((item) => item.id === current?.dialogueId);
  const outcomes = [
    { id: "all", label: "В выборке", value: check.sampled },
    { id: "FAIL", label: "С ошибкой агента", value: check.summary.failed },
    { id: "PASS", label: "Без найденных ошибок", value: check.summary.passed },
    { id: "none", label: "Не удалось проверить", value: check.summary.unmeasured },
  ];
  return (
    <div className="space-y-8 p-5 sm:p-7">
      <div>
        <StageResult
          size="display"
          failed={check.summary.failed}
          checked={check.summary.measured}
          unchecked={check.summary.unmeasured}
        />
        <p className="mt-4 break-words text-body text-fg-3">
          {check.file || "Загруженные разговоры"} · выборка {check.sampled} из {check.total} ·{" "}
          {count(saved.criteria.length, "критерий", "критерия", "критериев")}
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
              Разговор · {filtered.length} в группе
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
                    .map((rule) => ({ quote: rule.agentQuote, n: saved.numberOf(rule.ruleId) }))
                    .filter((mark) => mark.n > 0)}
                />
              ) : (
                <p className="text-body text-fg-3">Текст разговора не сохранился.</p>
              )}
            </div>
            {current.error && <p className="mt-3 text-body text-fg-3">Почему не удалось проверить: {current.error}</p>}
            <div className="mt-5">
              {current.rules.map((rule) => (
                <SavedRule
                  key={rule.ruleId}
                  rule={rule}
                  second={current.second?.rules?.find((item) => item.ruleId === rule.ruleId)}
                  saved={saved}
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
          Критерии этой проверки · {saved.criteria.length}
        </summary>
        <div className="mt-4 divide-y divide-line">
          {saved.criteria.map((criterion, index) => (
            <details key={criterion.id} className="py-3">
              <summary className="cursor-pointer text-body font-medium text-fg">
                {index + 1}. {criterion.name}
              </summary>
              <div className="mt-3 space-y-3 whitespace-pre-wrap break-words text-body text-fg-2">
                <p>{duty(criterion.text)}</p>
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
        <summary className="cursor-pointer text-read font-medium text-fg">{saved.source.title}</summary>
        {saved.source.body}
      </details>
      <p className="border-t border-line pt-5 text-small text-fg-3">{saved.note}</p>
    </div>
  );
}

/**
 * One saved check as a sheet (?id=). A check the history does not list (`listed` — the list came) is said to be not
 * there, with the way back to the list: asking again would not bring it.
 */
function Snapshot({
  check,
  id,
  checks,
  listed,
  onClose,
}: {
  check: Check;
  id: string | null;
  checks: SavedCheck[];
  listed: boolean;
  onClose: () => void;
}) {
  const gone = listed && !!id && !checks.some((item) => item.id === id);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["history-snapshot", check, id],
    queryFn: () => loadSaved(check, id!),
    enabled: !!id && !gone,
    staleTime: 0,
  });
  const saved = useMemo(() => (data ? ("policy" in data ? toneSaved(data) : codeSaved(data)) : null), [data]);
  const line = saved?.check ?? checks.find((item) => item.id === id);
  const previous = checks.find((item) => item.id === line?.comparison.previousId);
  return (
    <Sheet
      open={!!id}
      onClose={onClose}
      width="lg"
      title="Сохранённая проверка"
      sub={line ? finished(line.finishedAt) : undefined}
    >
      {gone ? (
        <div className="p-5">
          <p role="alert" className="text-body text-fg-2">
            Проверки из ссылки в истории нет.
          </p>
          <Button className="mt-4" onClick={onClose}>
            К истории проверок
          </Button>
        </div>
      ) : (
        <>
          {isLoading && (
            <div className="space-y-4 p-5" aria-label="Загружаем сохранённую проверку">
              <Skeleton className="h-20" />
              <Skeleton className="h-64" />
            </div>
          )}
          {error && (
            <div className="p-5">
              <p role="alert" className="text-body text-fg-2">
                Не удалось открыть проверку.
              </p>
              <Button className="mt-4" icon={RotateCcw} onClick={() => void refetch()}>
                Повторить
              </Button>
            </div>
          )}
          {saved && <SnapshotBody key={saved.check.id} saved={saved} previous={previous} />}
        </>
      )}
    </Sheet>
  );
}

/** One saved check in the list: its number first, as on every screen, then when, which export, how it stands. */
function CheckRow({
  check,
  previous,
  current,
  onOpen,
}: {
  check: SavedCheck;
  previous?: SavedCheck;
  current: boolean;
  onOpen: () => void;
}) {
  const { failed, measured, unmeasured } = check.summary;
  const share = errorShare(check);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-start gap-3 rounded-control px-1 py-4 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run"
    >
      <div className="min-w-0 flex-1">
        <p className="text-read text-fg-2">
          {measured ? (
            <>
              <span className={cn("font-semibold tabular-nums", failed ? "text-bad" : "text-fg")}>{failed}</span> из{" "}
              {count(measured, "проверенного разговора", "проверенных разговоров", "проверенных разговоров")} — с
              ошибкой агента
              <span className="text-fg-3"> · {share}%</span>
            </>
          ) : (
            "Ни один разговор не удалось проверить"
          )}
          {current && <span className="ml-2 text-small text-fg-3">текущий итог</span>}
        </p>
        <p className="mt-1 break-words text-small text-fg-3">
          {finished(check.finishedAt)} · {check.file || "Загруженные разговоры"}
          {unmeasured ? ` · не удалось проверить ${unmeasured} из ${check.sampled}` : ""}
        </p>
        <p className="mt-2 text-small text-fg-3">{comparisonText(check, previous)}</p>
      </div>
      <ArrowRight aria-hidden className="mt-1 size-4 shrink-0 text-fg-3" />
    </button>
  );
}

/**
 * «История» of a check: every saved check, newest first, each with its own conversations and criteria (tone of voice
 * also with its document). One opens as a sheet (?id=), even after the export, the rules or the code were replaced.
 * Checks are compared only when the service says they can be: the same criteria and models.
 */
export function HistoryPage({ check }: { check: Check }) {
  const { state, offline } = useLabState();
  const [params, setParams] = useSearchParams();
  const selected = params.get("id");
  const result = resultOf(state, check);
  const select = (id: string | null) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (id) next.set("id", id);
        else next.delete("id");
        return next;
      },
      { replace: !id },
    );
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["history", check, result?.finishedAt ?? null, String(state?.job.running)],
    queryFn: () => loadHistory(check),
    enabled: !!state,
    staleTime: Infinity,
  });
  const checks = data?.checks ?? [];
  return (
    <div className="flex h-full flex-col">
      <CheckHeader check={check} />
      <div className="min-h-0 flex-1 overflow-auto">
        {offline && !state ? (
          <ServiceDown />
        ) : (
          <div className="max-w-[880px] px-4 pb-24 pt-8 lg:px-10 lg:pt-10">
            <h2 className="text-title font-semibold text-fg">История проверок</h2>
            <p className="mt-1 max-w-[64ch] text-read text-fg-3">{KEEPS[check]}</p>
            <div className="mt-6">
              {(isLoading || !state) && <Skeleton className="h-40" />}
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
                  {result && !result.checkId
                    ? "Текущий итог появился раньше истории. История начнётся со следующей проверки."
                    : "Здесь появятся завершённые проверки с их разговорами и критериями."}
                </p>
              )}
              <div className="divide-y divide-line">
                {checks.map((saved) => (
                  <CheckRow
                    key={saved.id}
                    check={saved}
                    previous={checks.find((item) => item.id === saved.comparison.previousId)}
                    current={saved.id === result?.checkId}
                    onOpen={() => select(saved.id)}
                  />
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
      <Snapshot check={check} id={selected} checks={checks} listed={!!data} onClose={() => select(null)} />
    </div>
  );
}
