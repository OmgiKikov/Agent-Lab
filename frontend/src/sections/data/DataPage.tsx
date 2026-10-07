import { Link } from "react-router-dom";
import { ArrowRight, Check, Database, FileText, MessageSquareQuote, Target } from "lucide-react";
import { Header } from "../../app/Header";
import { SectionJob } from "../../app/SectionJob";
import { SECTIONS, stageRoot, toneCheckLink, type Check as CheckKind } from "../../app/links";
import { CHECK_NAME, resultOf } from "../../lab/checks";
import { count, when } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { codeSources, TONE_ID } from "../../lab/tone";
import type { LabState } from "../../lab/types";
import { ExportFormat } from "../../product/ExportFormat";
import { UploadButton } from "../../product/UploadLogs";
import { buttonClass } from "../../ui/Button";
import { ServiceDown, Skeleton } from "../../ui/EmptyState";
import { ExportConversations } from "./ExportConversations";

function CheckRoute({ check, state }: { check: CheckKind; state: LabState }) {
  const result = resultOf(state, check);
  const running = state.job.running && state.job.kind === (check === "tone" ? "tone-check" : "discover");
  const hasRules = check === "tone" ? state.sources.some((s) => s.id === TONE_ID) : codeSources(state).length > 0;
  const to =
    result || running
      ? stageRoot(check)
      : check === "tone"
        ? toneCheckLink()
        : hasRules
          ? SECTIONS.accuracy
          : SECTIONS.agent;
  const Icon = check === "tone" ? MessageSquareQuote : Target;
  return (
    <Link
      to={to}
      className="group flex min-w-0 items-start gap-3 rounded-block border border-line p-5 transition-colors hover:bg-hover"
    >
      <Icon aria-hidden className="mt-0.5 size-5 shrink-0 text-fg-3" />
      <div className="min-w-0 flex-1">
        <h3 className="text-read font-semibold text-fg">{CHECK_NAME[check]}</h3>
        <p className="mt-1 text-small text-fg-3">
          {running
            ? "Проверка выполняется"
            : result
              ? `Оценено ${result.summary.measured} из ${state.logs.total} разговоров`
              : hasRules
                ? "Данные и правила готовы к проверке"
                : check === "tone"
                  ? "Добавьте правила общения"
                  : "Прочитайте код агента"}
        </p>
        <span className="mt-3 inline-flex items-center gap-1.5 text-body font-medium text-fg">
          {running
            ? "Открыть проверку"
            : result
              ? "Посмотреть результат"
              : hasRules
                ? "Настроить проверку"
                : "Подготовить"}
          <ArrowRight aria-hidden className="size-3.5 transition-transform group-hover:translate-x-0.5" />
        </span>
      </div>
    </Link>
  );
}

/** One shared export belongs to the agent; its two independent checks keep their own results and histories. */
export function DataPage() {
  const { state, offline } = useLabState();
  const loaded = !!state?.logs.total;
  const header = (
    <Header
      title="Выгрузка диалогов"
      actions={loaded && <UploadButton variant="outline" label="Заменить выгрузку" compact />}
      below={<SectionJob kinds={["logs"]} />}
    />
  );
  if (!state)
    return (
      <div>
        {header}
        {offline ? <ServiceDown /> : <Skeleton className="m-8 h-80" />}
      </div>
    );
  return (
    <div>
      {header}
      <div className="max-w-[1180px] px-4 pb-16 pt-8 lg:px-10">
        <h2 className="text-page font-semibold text-fg">
          {loaded ? "Разговоры для проверки" : "Начните с настоящих разговоров"}
        </h2>
        <p className="mt-3 max-w-[65ch] text-read text-fg-3">
          Загрузите диалоги один раз. Tone of voice и точность проверят их по своим критериям.
        </p>
        {!loaded ? (
          <div className="mt-7 grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(260px,2fr)]">
            <div className="flex flex-col items-center rounded-block border border-dashed border-line-strong bg-inset/40 px-6 py-12 text-center">
              <span className="mb-5 flex size-12 items-center justify-center rounded-block bg-hover text-fg-3">
                <Database aria-hidden className="size-6" />
              </span>
              <h3 className="text-read font-semibold text-fg">Добавьте выгрузку чата</h3>
              <p className="mb-6 mt-2 text-body text-fg-3">Excel или JSONL · до 50 МБ</p>
              <UploadButton />
              <p className="mt-4 text-small text-fg-3">Подключение к агенту не требуется.</p>
            </div>
            <ExportFormat />
          </div>
        ) : (
          <>
            <div className="mt-7 flex flex-wrap items-center gap-4 rounded-block border border-line p-5">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-control bg-inset text-fg-3">
                <FileText aria-hidden className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="break-all text-read font-semibold text-fg">{state.logs.file || "Текущая выгрузка"}</p>
                <p className="mt-1 text-small text-fg-3">
                  {count(state.logs.total, "разговор", "разговора", "разговоров")}
                  {state.logs.updatedAt ? ` · загружено ${when(state.logs.updatedAt)}` : ""}
                </p>
              </div>
              <span className="inline-flex w-full items-center gap-1.5 pl-[60px] text-small font-medium text-ok sm:w-auto sm:pl-0">
                <Check aria-hidden className="size-4" />
                Файл прочитан
              </span>
            </div>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <CheckRoute check="tone" state={state} />
              <CheckRoute check="code" state={state} />
            </div>
            <ExportConversations key={state.logs.updatedAt ?? state.logs.total} stamp={state.logs.updatedAt} />
          </>
        )}
        {!loaded && (
          <Link to={SECTIONS.overview} className={`mt-7 ${buttonClass({ variant: "ghost" })}`}>
            К обзору
            <ArrowRight aria-hidden className="size-3.5" />
          </Link>
        )}
      </div>
    </div>
  );
}
