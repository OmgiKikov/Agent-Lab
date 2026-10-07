import { KnowledgeEvidence } from "../../product/KnowledgeEvidence";
import { useState } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import { ArrowRight, RotateCcw, Square } from "lucide-react";
import { Header } from "../../app/Header";
import { historyLink, launchLink, runLink, stageRoot } from "../../app/links";
import { api } from "../../lab/api";
import { CHECK_NAME } from "../../lab/checks";
import { MODE_NAME, useLaunch, useQuestions, type Mode, type Pair } from "../../lab/launches";
import { when } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { Conversation } from "../../product/Conversation";
import { Button, buttonClass } from "../../ui/Button";
import { LoadFailed } from "../../ui/LoadFailed";
import { Skeleton } from "../../ui/EmptyState";
import { Sheet } from "../../ui/Sheet";
import { LaunchStatus } from "./LaunchStatus";
import { StageResult } from "../../product/StageResult";
import { CheckHeader } from "../checks/CheckHeader";

function pairLabel(item: Pair): string {
  if (item.comparable && item.baseline?.status === "FAIL" && item.status === "PASS") return "Исправлено";
  if (item.comparable && item.baseline?.status === "PASS" && item.status === "FAIL") return "Стало хуже";
  return (
    ({ PASS: "Без ошибок", FAIL: "С ошибками", RUNNING: "Выполняется" } as Record<string, string>)[item.status] ??
    "Не оценён"
  );
}

function Pairs({ id }: { id: string }) {
  const q = useQuestions(id);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const chosen = q.data?.items.find((item) => item.dialogueId === chosenId);
  if (q.isError) return <LoadFailed title="Ответы не загрузились" error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Skeleton className="h-40" />;
  return (
    <section className="mt-8">
      <h2 className="text-title font-semibold text-fg">Исходные вопросы · новые ответы</h2>
      <p className="mt-2 text-body text-fg-3">
        Версия на стенде: {q.data.version}. Вопросы клиента повторены из датасета без синтетического клиента.
      </p>
      <ul className="mt-5 divide-y divide-line rounded-block border border-line">
        {q.data.items.map((item) => (
          <li key={item.dialogueId}>
            <button
              className="flex w-full flex-wrap items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-run/60"
              onClick={() => setChosenId(item.dialogueId)}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body font-medium text-fg">{item.name}</span>
                <span className="mt-1 block text-small text-fg-3">Диалог {item.dialogueId}</span>
              </span>
              <span
                className={`text-small ${item.status === "FAIL" ? "text-bad" : item.status === "PASS" ? "text-ok" : "text-fg-3"}`}
              >
                {pairLabel(item)}
              </span>
              <ArrowRight className="size-3.5 text-fg-3" />
            </button>
          </li>
        ))}
      </ul>
      {chosen && (
        <Sheet
          open
          width="lg"
          onClose={() => setChosenId(null)}
          title={chosen.name}
          sub={`Диалог ${chosen.dialogueId}`}
        >
          <div className="p-5">
            <div className="grid gap-7 md:grid-cols-2">
              <section>
                <h3 className="mb-5 text-read font-semibold text-fg">В датасете</h3>
                {chosen.baseline && (
                  <p className="mb-3 text-small text-fg-3">
                    Автооценка:{" "}
                    {chosen.baseline.status === "FAIL"
                      ? "с ошибками"
                      : chosen.baseline.status === "PASS"
                        ? "без ошибок"
                        : "нет оценки"}
                  </p>
                )}
                <Conversation
                  turns={chosen.original.map((m) => ({
                    role: m.role === "user" ? "customer" : "agent",
                    text: m.content,
                  }))}
                />
              </section>
              <section>
                <h3 className="mb-5 text-read font-semibold text-fg">Агент на стенде</h3>
                <Conversation turns={chosen.conversation} />
                <KnowledgeEvidence articles={chosen.knowledge} error={chosen.contextError} />
                {chosen.error && (
                  <p role="alert" className="mt-4 text-body text-bad">
                    {chosen.error}
                  </p>
                )}
              </section>
            </div>
            <section className="mt-8 border-t border-line pt-5">
              <h3 className="text-read font-semibold text-fg">Оценка новых ответов</h3>
              {chosen.baseline && (
                <p className="mt-2 text-small text-fg-3">
                  {chosen.comparable
                    ? "Исходный и новый ответы оценены тем же судьёй по тем же критериям."
                    : "Условия оценки различаются. Показываем ответы без вывода об улучшении."}
                </p>
              )}
              {chosen.rules.map((rule) => (
                <div key={rule.ruleId} className="mt-4 text-body">
                  <p className="font-medium text-fg">
                    {rule.rule} ·{" "}
                    {rule.status === "FAIL" ? "Нарушено" : rule.status === "PASS" ? "Выполнено" : "Нет оценки"}
                  </p>
                  <p className="mt-1 text-fg-3">{rule.reason}</p>
                  {rule.agentQuote && (
                    <blockquote className="mt-2 border-l-2 border-mark pl-3 text-fg-2">{rule.agentQuote}</blockquote>
                  )}
                </div>
              ))}
            </section>
          </div>
        </Sheet>
      )}
    </section>
  );
}
export function LaunchReport() {
  const { id } = useParams();
  const { pathname } = useLocation();
  const q = useLaunch(id);
  const { state, refresh } = useLabState();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const record = q.data;
  const retry = async () => {
    if (!id || !record || busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await api<{ id: string }>(`/api/launches/${id}/retry`, {});
      await refresh();
      navigate(launchLink(record.check, next.id));
      await q.refetch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    setBusy(true);
    try {
      await api("/api/job/stop", {});
      await refresh();
      await q.refetch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  if (q.isError)
    return (
      <>
        <Header title="Запуск" />
        <LoadFailed page title="Запуск не загрузился" error={q.error} onRetry={() => q.refetch()} />
      </>
    );
  if (!record)
    return (
      <>
        <Header title="Запуск" />
        <Skeleton className="m-6 h-60" />
      </>
    );
  if (pathname !== launchLink(record.check, record.id))
    return <Navigate to={launchLink(record.check, record.id)} replace />;
  const questions = record.modes.questions?.questionsId;
  return (
    <div>
      <CheckHeader
        check={record.check}
        actions={
          record.status === "running" ? (
            <Button
              icon={Square}
              loading={busy}
              disabled={state?.job.kind !== "launch" || state.job.progress.launch !== record.id}
              onClick={stop}
            >
              Остановить
            </Button>
          ) : (
            <Button icon={RotateCcw} loading={busy} disabled={!!state?.job.running} onClick={retry}>
              {record.status === "done" ? (
                <>
                  Повторить<span className="hidden sm:inline"> запуск</span>
                </>
              ) : (
                "Продолжить"
              )}
            </Button>
          )
        }
      />
      <div className="max-w-[1180px] px-4 pb-16 pt-8 lg:px-10">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-page font-semibold text-fg">{record.agentVersion || CHECK_NAME[record.check]}</h2>
            <p className="mt-2 text-read text-fg-3">
              {record.dataset?.name || record.dataset?.file} · {when(record.startedAt)}
            </p>
            <p className="mt-1 text-small text-fg-3">
              {record.judge ? `${record.judge.name} · v${record.judge.version}` : "Критерии из кода агента"}
            </p>
          </div>
          <span role="status">
            <LaunchStatus status={record.status} />
          </span>
        </div>
        {(error || record.error) && (
          <p role="alert" className="mt-4 text-bad">
            {error || record.error}
          </p>
        )}
        <div className="mt-7 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Object.entries(record.modes).map(([mode, result]) => {
            const m = result.metric;
            const href = result.checkId
              ? state?.checks[record.check]?.checkId === result.checkId
                ? stageRoot(record.check)
                : historyLink(record.check, result.checkId)
              : result.runId
                ? runLink(result.runId)
                : null;
            return (
              <section key={mode} className="flex flex-col rounded-block border border-line p-5">
                <h3 className="text-read font-semibold text-fg">{MODE_NAME[mode as Mode]}</h3>
                <div className="mt-2">
                  <LaunchStatus status={result.status} />
                </div>
                {m ? (
                  <StageResult
                    size="display"
                    className="mt-5"
                    failed={m.failed}
                    checked={m.measured}
                    unchecked={m.unmeasured}
                  />
                ) : (
                  <p className="mt-5 text-body text-fg-3">
                    {result.status === "pending"
                      ? "Начнётся после предыдущего режима."
                      : result.status === "running"
                        ? "Собираем диалоги и оценки…"
                        : "Результат ещё не получен."}
                  </p>
                )}
                {result.error && (
                  <p role="alert" className="mt-4 text-small text-bad">
                    {result.error}
                  </p>
                )}
                {href && (
                  <Link to={href} className={`mt-5 self-start ${buttonClass({ variant: "outline" })}`}>
                    Разобрать результат
                    <ArrowRight className="size-3.5" />
                  </Link>
                )}
              </section>
            );
          })}
        </div>
        <p className="mt-4 text-small text-fg-3">Для каждого режима сохранены свои диалоги и оценки.</p>
        {questions && <Pairs id={questions} />}
        <Link to={historyLink(record.check)} className="mt-8 inline-flex items-center gap-2 text-body text-run">
          История этой проверки
          <ArrowRight className="size-3.5" />
        </Link>
      </div>
    </div>
  );
}
